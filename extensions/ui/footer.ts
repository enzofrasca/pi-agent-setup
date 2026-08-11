import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { clampPercent, formatDurationLeft } from "./format";
import {
	cursorUsage,
	cursorUsageFresh,
	ensureCursorUsage,
	formatCursorUsage,
	isCursorModel,
	markCursorUsageStale,
} from "./cursor-usage";

// ── Helpers ──────────────────────────────────────────────────────────────────

function shortenModelName(name: string): string {
	if (!name) return "?";
	const parts = name.split("/");
	return parts[parts.length - 1]!;
}

function fmtWindow(w: number): string {
	if (w >= 1_000_000) return `${(w / 1_000_000).toFixed(0)}M`;
	if (w >= 1_000) return `${(w / 1_000).toFixed(0)}K`;
	return `${w}`;
}

function thinkingThemeToken(level: string): string {
	return `thinking${level.charAt(0).toUpperCase() + level.slice(1)}`;
}

function isXaiGrokModel(model: { provider?: string; id?: string } | undefined | null): boolean {
	if (!model?.provider || !model.id) return false;
	const provider = model.provider.toLowerCase();
	// Built-in xAI provider, custom proxy extension, or any *xai* provider id
	const isXai =
		provider === "xai" ||
		provider === "grok-proxy" ||
		provider.includes("xai");
	if (!isXai) return false;
	const id = model.id.toLowerCase();
	// Weekly subscription meter applies to Grok models (4.5, 4.3, build, aliases)
	return id === "grok-4.5" || id.startsWith("grok-4.5") || id.startsWith("grok-");
}

// ── Grok weekly usage (subscription OAuth) ───────────────────────────────────

const AUTH_PATH = join(homedir(), ".pi/agent/auth.json");
const GROK_AUTH_PATH = join(homedir(), ".grok", "auth.json");
const GROK_CREDITS_URL = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
const USAGE_TTL_MS = 5 * 60_000;
const USAGE_ERROR_TTL_MS = 60_000;

// Same OAuth client / issuer as grok-proxy (Grok Build CLI)
const XAI_OAUTH_ISSUER = "https://auth.x.ai";
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_REFRESH_SKEW_MS = 2 * 60_000;
const XAI_GROK_CLI_AUTH_SCOPE_KEY = `${XAI_OAUTH_ISSUER}::${XAI_OAUTH_CLIENT_ID}`;
const XAI_GROK_CLI_LEGACY_AUTH_SCOPE_KEY = "https://accounts.x.ai/sign-in";
const TOKEN_SOFT_GRACE_MS = 60_000;

type GrokUsage = {
	/** Percent of weekly pool already used (0–100+). */
	weeklyUsedPercent: number;
	/** ISO reset time for the weekly window, if known. */
	weeklyResetIso?: string;
	/** Optional monthly used/limit from cli-chat-proxy billing. */
	monthlyUsed?: number;
	monthlyLimit?: number;
	monthlyResetIso?: string;
	fetchedAt: number;
	error?: string;
};

type XaiTokenCreds = {
	access: string;
	refresh?: string;
	expires?: number;
	tokenEndpoint?: string;
	source: "grok-cli" | "grok-proxy" | "xai";
};

let cachedUsage: GrokUsage | null = null;
let inflight: Promise<void> | null = null;

function parseExpiry(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return numeric;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function isAccessUsable(creds: XaiTokenCreds, now = Date.now()): boolean {
	if (!creds.access) return false;
	if (typeof creds.expires !== "number") return true;
	// Allow a short grace window — JWT may still work past stored expires
	return creds.expires + TOKEN_SOFT_GRACE_MS > now;
}

function needsRefresh(creds: XaiTokenCreds, now = Date.now()): boolean {
	if (typeof creds.expires !== "number") return false;
	return creds.expires <= now;
}

function readGrokCliCredentials(): XaiTokenCreds | undefined {
	if (!existsSync(GROK_AUTH_PATH)) return undefined;
	try {
		const data = JSON.parse(readFileSync(GROK_AUTH_PATH, "utf8")) as Record<string, unknown>;

		const oidc = data[XAI_GROK_CLI_AUTH_SCOPE_KEY];
		if (oidc && typeof oidc === "object") {
			const entry = oidc as Record<string, unknown>;
			const access = String(entry.key || entry.access_token || entry.token || "");
			if (access) {
				const expiresAt = parseExpiry(entry.expires_at);
				return {
					access,
					refresh: String(entry.refresh_token || entry.refresh || "") || undefined,
					expires: expiresAt !== undefined ? expiresAt - XAI_OAUTH_REFRESH_SKEW_MS : undefined,
					tokenEndpoint: `${XAI_OAUTH_ISSUER}/oauth2/token`,
					source: "grok-cli",
				};
			}
		}

		// Older Grok builds stored a bearer at the sign-in URL scope.
		const legacy = data[XAI_GROK_CLI_LEGACY_AUTH_SCOPE_KEY];
		if (legacy && typeof legacy === "object") {
			const entry = legacy as Record<string, unknown>;
			const access = String(entry.key || entry.access_token || entry.token || "");
			if (access) {
				return {
					access,
					source: "grok-cli",
					expires: Date.now() + 30 * 24 * 60 * 60 * 1000,
				};
			}
		}

		const topLevelAccess = data.access_token || data.token;
		if (topLevelAccess) {
			return {
				access: String(topLevelAccess),
				refresh: String(data.refresh_token || data.refresh || "") || undefined,
				expires: parseExpiry(data.expires_at || data.expires),
				tokenEndpoint: `${XAI_OAUTH_ISSUER}/oauth2/token`,
				source: "grok-cli",
			};
		}
	} catch {
		// ignore corrupt grok auth
	}
	return undefined;
}

function persistGrokCliAccess(creds: XaiTokenCreds): void {
	if (!creds.access || creds.source !== "grok-cli") return;
	try {
		let data: Record<string, any> = {};
		if (existsSync(GROK_AUTH_PATH)) {
			try {
				data = JSON.parse(readFileSync(GROK_AUTH_PATH, "utf8"));
			} catch {
				data = {};
			}
		}
		const previous =
			data[XAI_GROK_CLI_AUTH_SCOPE_KEY] && typeof data[XAI_GROK_CLI_AUTH_SCOPE_KEY] === "object"
				? data[XAI_GROK_CLI_AUTH_SCOPE_KEY]
				: {};
		const expiresAtMs =
			(creds.expires || Date.now() + 6 * 60 * 60 * 1000) + XAI_OAUTH_REFRESH_SKEW_MS;
		data[XAI_GROK_CLI_AUTH_SCOPE_KEY] = {
			...previous,
			key: creds.access,
			refresh_token: creds.refresh || previous.refresh_token || "",
			expires_at: new Date(expiresAtMs).toISOString(),
			auth_mode: previous.auth_mode || "oidc",
			oidc_issuer: previous.oidc_issuer || XAI_OAUTH_ISSUER,
			oidc_client_id: previous.oidc_client_id || XAI_OAUTH_CLIENT_ID,
		};
		writeFileSync(GROK_AUTH_PATH, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
	} catch {
		// best-effort only
	}
}

function readPiAuthCredentials(provider: "grok-proxy" | "xai"): XaiTokenCreds | undefined {
	try {
		const raw = readFileSync(AUTH_PATH, "utf8");
		const auth = JSON.parse(raw) as Record<
			string,
			{
				type?: string;
				access?: string;
				refresh?: string;
				expires?: number;
				tokenEndpoint?: string;
			}
		>;
		const entry = auth[provider];
		if (!entry?.access) return undefined;
		return {
			access: entry.access,
			refresh: entry.refresh,
			expires: typeof entry.expires === "number" ? entry.expires : undefined,
			tokenEndpoint: entry.tokenEndpoint || `${XAI_OAUTH_ISSUER}/oauth2/token`,
			source: provider,
		};
	} catch {
		return undefined;
	}
}

function validateXaiEndpoint(url: string): string {
	const parsed = new URL(url);
	const host = parsed.hostname.toLowerCase();
	if (parsed.protocol !== "https:" || (host !== "x.ai" && !host.endsWith(".x.ai"))) {
		throw new Error(`unexpected xAI token endpoint: ${url}`);
	}
	return url;
}

async function resolveXaiTokenEndpoint(preferred?: string): Promise<string> {
	if (preferred) {
		try {
			return validateXaiEndpoint(preferred);
		} catch {
			// fall through to discovery
		}
	}
	const response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
		headers: { Accept: "application/json" },
	});
	if (!response.ok) {
		throw new Error(`xAI OAuth discovery failed: ${response.status}`);
	}
	const data = (await response.json()) as { token_endpoint?: string };
	if (!data.token_endpoint) throw new Error("xAI OAuth discovery missing token_endpoint");
	return validateXaiEndpoint(data.token_endpoint);
}

async function refreshXaiAccessToken(
	creds: XaiTokenCreds,
	signal?: AbortSignal,
): Promise<XaiTokenCreds | undefined> {
	if (!creds.refresh) return undefined;
	try {
		const tokenEndpoint = await resolveXaiTokenEndpoint(creds.tokenEndpoint);
		const body = new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: creds.refresh,
			client_id: XAI_OAUTH_CLIENT_ID,
		});
		const response = await fetch(tokenEndpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body,
			signal,
		});
		if (!response.ok) return undefined;
		const data = (await response.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
		};
		if (!data.access_token) return undefined;
		const refreshed: XaiTokenCreds = {
			access: data.access_token,
			refresh: data.refresh_token || creds.refresh,
			expires:
				typeof data.expires_in === "number"
					? Date.now() + data.expires_in * 1000 - XAI_OAUTH_REFRESH_SKEW_MS
					: Date.now() + 6 * 60 * 60 * 1000 - XAI_OAUTH_REFRESH_SKEW_MS,
			tokenEndpoint,
			source: creds.source,
		};
		if (refreshed.source === "grok-cli") persistGrokCliAccess(refreshed);
		return refreshed;
	} catch {
		return undefined;
	}
}

/**
 * Resolve an xAI/Grok access token the same way chat does:
 * 1) ~/.grok/auth.json (what grok-proxy keeps fresh)
 * 2) ~/.pi/agent/auth.json grok-proxy
 * 3) ~/.pi/agent/auth.json xai
 *
 * Refreshes via OAuth when the chosen creds are expired and have a refresh token.
 * Does not spawn the Grok CLI (too heavy for footer refresh).
 */
async function resolveXaiAccessToken(signal?: AbortSignal): Promise<string | undefined> {
	const candidates: XaiTokenCreds[] = [];
	const grokCli = readGrokCliCredentials();
	if (grokCli) candidates.push(grokCli);
	const proxy = readPiAuthCredentials("grok-proxy");
	if (proxy) candidates.push(proxy);
	const xai = readPiAuthCredentials("xai");
	if (xai) candidates.push(xai);

	if (candidates.length === 0) return undefined;

	// Prefer first usable source in priority order; refresh if needed.
	for (const creds of candidates) {
		if (signal?.aborted) return undefined;

		if (needsRefresh(creds)) {
			const refreshed = await refreshXaiAccessToken(creds, signal);
			if (refreshed?.access) return refreshed.access;
			// Expired refresh failed — try next source
			continue;
		}

		if (isAccessUsable(creds)) return creds.access;
	}

	// Last resort: return the highest-priority access token even if past grace
	// (request may still succeed; otherwise fetch fails cleanly).
	return candidates[0]?.access;
}

// Minimal protobuf helpers for GetGrokCreditsConfigResponse
function readVarint(data: Uint8Array, pos: number): [number, number] {
	let value = 0;
	let shift = 0;
	while (pos < data.length) {
		const b = data[pos++]!;
		value |= (b & 0x7f) << shift;
		if ((b & 0x80) === 0) return [value, pos];
		shift += 7;
		if (shift > 70) throw new Error("varint too long");
	}
	throw new Error("truncated varint");
}

function* iterFields(data: Uint8Array): Generator<[number, number, number | Uint8Array]> {
	let pos = 0;
	while (pos < data.length) {
		const [key, next] = readVarint(data, pos);
		pos = next;
		const number = key >>> 3;
		const wire = key & 0x07;
		if (wire === 0) {
			const [v, p] = readVarint(data, pos);
			pos = p;
			yield [number, wire, v];
		} else if (wire === 1) {
			yield [number, wire, data.subarray(pos, pos + 8)];
			pos += 8;
		} else if (wire === 2) {
			const [len, p] = readVarint(data, pos);
			pos = p;
			yield [number, wire, data.subarray(pos, pos + len)];
			pos += len;
		} else if (wire === 5) {
			yield [number, wire, data.subarray(pos, pos + 4)];
			pos += 4;
		} else {
			throw new Error(`unsupported wire type ${wire}`);
		}
	}
}

function firstMessage(data: Uint8Array, fieldNo: number): Uint8Array | undefined {
	for (const [n, w, v] of iterFields(data)) {
		if (n === fieldNo && w === 2 && v instanceof Uint8Array) return v;
	}
	return undefined;
}

function parseFloat32LE(bytes: Uint8Array): number {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(0, true);
}

function parseTimestampIso(message: Uint8Array | undefined): string | undefined {
	if (!message) return undefined;
	let seconds = 0;
	let nanos = 0;
	for (const [n, w, v] of iterFields(message)) {
		if (n === 1 && w === 0 && typeof v === "number") seconds = v;
		if (n === 2 && w === 0 && typeof v === "number") nanos = v;
	}
	if (!seconds) return undefined;
	return new Date(seconds * 1000 + nanos / 1e6).toISOString();
}

function decodeGrpcWebMessage(body: Uint8Array): Uint8Array {
	const messages: Uint8Array[] = [];
	let i = 0;
	while (i + 5 <= body.length) {
		const flags = body[i]!;
		const length = new DataView(body.buffer, body.byteOffset + i + 1, 4).getUint32(0, false);
		i += 5;
		const payload = body.subarray(i, i + length);
		if (payload.length !== length) throw new Error("truncated grpc frame");
		i += length;
		if ((flags & 0x80) === 0) messages.push(payload);
	}
	if (!messages.length) throw new Error("empty grpc message");
	if (messages.length === 1) return messages[0]!;
	const out = new Uint8Array(messages.reduce((n, m) => n + m.length, 0));
	let o = 0;
	for (const m of messages) {
		out.set(m, o);
		o += m.length;
	}
	return out;
}

function parseWeeklyFromCredits(payload: Uint8Array): { usedPercent: number; resetIso?: string } {
	const msg = decodeGrpcWebMessage(payload);
	const config = firstMessage(msg, 1);
	if (!config) throw new Error("missing credits config");

	let usedPercent = 0;
	let resetIso: string | undefined;
	for (const [n, w, v] of iterFields(config)) {
		if (n === 1 && w === 5 && v instanceof Uint8Array && v.length >= 4) {
			usedPercent = parseFloat32LE(v);
		} else if (n === 5 && w === 2 && v instanceof Uint8Array) {
			resetIso = parseTimestampIso(v);
		}
	}
	return { usedPercent, resetIso };
}

function moneyishVal(v: unknown): number | undefined {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (v && typeof v === "object" && typeof (v as { val?: unknown }).val === "number") {
		return (v as { val: number }).val;
	}
	return undefined;
}

async function fetchGrokUsage(token: string, signal?: AbortSignal): Promise<GrokUsage> {
	const fetchedAt = Date.now();
	let weeklyUsedPercent = 0;
	let weeklyResetIso: string | undefined;
	let monthlyUsed: number | undefined;
	let monthlyLimit: number | undefined;
	let monthlyResetIso: string | undefined;
	let weeklyOk = false;

	// Weekly pool (Settings → Usage style meter)
	try {
		const res = await fetch(GROK_CREDITS_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/grpc-web+proto",
				Accept: "application/grpc-web+proto",
				"X-Grpc-Web": "1",
				Origin: "https://grok.com",
				Referer: "https://grok.com/",
				"User-Agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
			},
			// google.protobuf.Empty in a grpc-web data frame
			body: new Uint8Array([0, 0, 0, 0, 0]),
			signal,
		});
		if (!res.ok) throw new Error(`credits HTTP ${res.status}`);
		const buf = new Uint8Array(await res.arrayBuffer());
		const weekly = parseWeeklyFromCredits(buf);
		weeklyUsedPercent = weekly.usedPercent;
		weeklyResetIso = weekly.resetIso;
		weeklyOk = true;
	} catch {
		// fall through — try monthly only
	}

	// Monthly allowance from cli-chat-proxy (bonus context)
	try {
		const res = await fetch(GROK_BILLING_URL, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
				"x-xai-token-auth": "xai-grok-cli",
				"x-grok-client-version": "0.2.101",
				"x-grok-client-mode": "interactive",
			},
			signal,
		});
		if (res.ok) {
			const payload = (await res.json()) as { config?: Record<string, unknown> };
			const c = payload.config ?? {};
			monthlyLimit = moneyishVal(c.monthlyLimit);
			monthlyUsed = moneyishVal(c.used);
			if (typeof c.billingPeriodEnd === "string") monthlyResetIso = c.billingPeriodEnd;

			// Some accounts expose weekly on this payload too
			const currentPeriod = c.currentPeriod as { type?: string; end?: string } | undefined;
			if (
				!weeklyOk &&
				typeof c.creditUsagePercent === "number" &&
				currentPeriod?.type === "USAGE_PERIOD_TYPE_WEEKLY"
			) {
				weeklyUsedPercent = c.creditUsagePercent;
				weeklyResetIso = typeof currentPeriod.end === "string" ? currentPeriod.end : monthlyResetIso;
				weeklyOk = true;
			}
		}
	} catch {
		// ignore
	}

	if (!weeklyOk && monthlyUsed == null) {
		return { weeklyUsedPercent: 0, fetchedAt, error: "unavailable" };
	}

	return {
		weeklyUsedPercent,
		weeklyResetIso,
		monthlyUsed,
		monthlyLimit,
		monthlyResetIso,
		fetchedAt,
	};
}

function usageStillFresh(usage: GrokUsage | null): boolean {
	if (!usage) return false;
	const ttl = usage.error ? USAGE_ERROR_TTL_MS : USAGE_TTL_MS;
	return Date.now() - usage.fetchedAt < ttl;
}

function ensureGrokUsage(onUpdate: () => void, signal?: AbortSignal): void {
	if (usageStillFresh(cachedUsage)) return;
	if (inflight) return;

	inflight = (async () => {
		const token = await resolveXaiAccessToken(signal);
		if (signal?.aborted) return;
		if (!token) {
			cachedUsage = { weeklyUsedPercent: 0, fetchedAt: Date.now(), error: "no-auth" };
			onUpdate();
			return;
		}

		try {
			const u = await fetchGrokUsage(token, signal);
			if (signal?.aborted) return;
			cachedUsage = u;
			onUpdate();
		} catch (err) {
			if (signal?.aborted) return;
			cachedUsage = {
				weeklyUsedPercent: 0,
				fetchedAt: Date.now(),
				error: err instanceof Error ? err.message : "error",
			};
			onUpdate();
		}
	})().finally(() => {
		inflight = null;
	});
}

function formatGrokUsagePart(usage: GrokUsage | null, loading: boolean): string {
	if (loading && !usage) return "…";
	if (!usage) return "…";
	if (usage.error === "no-auth") return "login";
	if (usage.error && usage.monthlyUsed == null) return "n/a";

	const left = clampPercent(100 - usage.weeklyUsedPercent);
	const reset = usage.weeklyResetIso ? formatDurationLeft(usage.weeklyResetIso) : undefined;
	// e.g. "90% · 6d" (percent of weekly pool remaining)
	return reset ? `${left}% · ${reset}` : `${left}%`;
}

// ── Extension Entrypoint ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let tuiRef: { requestRender(): void } | null = null;
	let abort: AbortController | null = null;

	const bump = () => tuiRef?.requestRender();

	const maybeRefreshUsage = (ctx: ExtensionContext) => {
		const model = ctx.model as { provider?: string; id?: string } | undefined;
		if (isXaiGrokModel(model)) ensureGrokUsage(bump, abort?.signal);
		if (isCursorModel(model)) ensureCursorUsage(bump, abort?.signal);
	};

	pi.on("session_start", async (_event, ctx) => {
		abort?.abort();
		abort = new AbortController();
		maybeRefreshUsage(ctx);

		ctx.ui.setFooter((tui, theme, footerData) => {
			tuiRef = tui;
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: () => {
					unsub();
					tuiRef = null;
				},
				invalidate() {},
				render(width: number): string[] {
					const usageCtx =
						typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;

					const model = ctx.model as { provider?: string; id?: string } | undefined;
					const modelId = model?.id || "";
					const modelName = shortenModelName(modelId);

					const thinkingLevel =
						typeof (pi as any).getThinkingLevel === "function"
							? String((pi as any).getThinkingLevel())
							: "off";

					const displayCwd = ctx.cwd.split(/[/\\]/).filter(Boolean).pop() || ctx.cwd;

					let contextStr = "?/?";
					if (
						usageCtx &&
						typeof usageCtx === "object" &&
						"contextWindow" in usageCtx &&
						"percent" in usageCtx
					) {
						const pctVal = (usageCtx as { percent: unknown }).percent;
						const pct = typeof pctVal === "number" ? pctVal.toFixed(1) : "?";
						const winVal = (usageCtx as { contextWindow: unknown }).contextWindow;
						const win = typeof winVal === "number" ? fmtWindow(winVal) : "?";
						contextStr = `${pct}%/${win}`;
					}

					const thinkingToken = thinkingThemeToken(thinkingLevel);
					const sep = theme.fg("dim", "  ");

					// Weekly Grok subscription meter — xai / grok-proxy + grok-*
					// Keep this early so narrow terminals don't truncate it away.
					let grokPart: string | null = null;
					if (isXaiGrokModel(model)) {
						// Kick a background refresh if stale (render stays sync)
						if (!usageStillFresh(cachedUsage)) ensureGrokUsage(bump, abort?.signal);
						const loading = !!inflight && !cachedUsage;
						const grokStr = formatGrokUsagePart(cachedUsage, loading);
						const left = cachedUsage ? clampPercent(100 - cachedUsage.weeklyUsedPercent) : 100;
						const color =
							cachedUsage?.error
								? "dim"
								: left <= 10
									? "error"
									: left <= 25
										? "warning"
										: "success";
						grokPart = theme.fg(color, `󰓅 ${grokStr}`);
					}

					// Cursor plan meters — two buckets with separate limits, so both
					// are shown and the one the active model bills to is highlighted.
					let cursorPart: string | null = null;
					if (isCursorModel(model)) {
						if (!cursorUsageFresh()) ensureCursorUsage(bump, abort?.signal);
						const segments = formatCursorUsage(cursorUsage(), modelId);
						cursorPart = segments
							.map((s, i) => theme.fg(s.color, i === 0 ? `󰓅 ${s.text}` : s.text))
							.join(theme.fg("dim", " · "));
					}

					const parts = [
						theme.fg("success", "π"),
						theme.fg("accent", `󰚩 ${modelName}`),
						...(grokPart ? [grokPart] : []),
						...(cursorPart ? [cursorPart] : []),
						theme.fg(thinkingToken, `󱜙 ${thinkingLevel}`),
						theme.fg("muted", `󰉋 ${displayCwd}`),
						theme.fg("dim", `󰍛 ${contextStr}`),
					];

					const line = parts.join(sep);
					return [truncateToWidth(line, width)];
				},
			};
		});
	});

	pi.on("session_shutdown", async () => {
		abort?.abort();
		abort = null;
		tuiRef = null;
	});

	// Re-render + refresh usage on relevant events
	pi.on("message_end", (_e, ctx) => {
		maybeRefreshUsage(ctx);
		bump();
	});
	pi.on("turn_end", (_e, ctx) => {
		// Force a fresh pull after each turn while on a metered provider (usage moves)
		const model = ctx.model as { provider?: string; id?: string } | undefined;
		if (isXaiGrokModel(model)) {
			cachedUsage = cachedUsage
				? { ...cachedUsage, fetchedAt: 0 }
				: null;
		}
		if (isCursorModel(model)) markCursorUsageStale();
		maybeRefreshUsage(ctx);
		bump();
	});
	pi.on("model_select", (_e, ctx) => {
		// Invalidate so switching onto a metered provider always refreshes
		const model = ctx.model as { provider?: string; id?: string } | undefined;
		if (isXaiGrokModel(model) && cachedUsage) {
			cachedUsage = { ...cachedUsage, fetchedAt: 0 };
		}
		if (isCursorModel(model)) markCursorUsageStale();
		maybeRefreshUsage(ctx);
		bump();
	});
	pi.on("thinking_level_select", () => bump());
}
