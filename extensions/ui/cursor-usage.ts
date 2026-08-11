/**
 * Cursor plan usage for the footer.
 *
 * Cursor meters two separate buckets against the included pool, with different
 * overflow rules, so the dashboard shows them as two bars and there is no
 * combined number:
 *   - "Cursor models" (Composer, Cursor Grok) → planUsage.autoPercentUsed
 *   - "Other models"  (Claude, GPT, Gemini…)  → planUsage.apiPercentUsed
 *
 * Data comes from the undocumented dashboard endpoints the web app itself uses,
 * authenticated with the WorkOS session cookie rebuilt from the cursor-proxy
 * OAuth token (`<sub>::<jwt>`). Reads only — refresh is left to cursor-proxy so
 * we never rotate the refresh token behind its back.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { formatDurationLeft } from "./format";

const AUTH_PATH = join(homedir(), ".pi/agent/auth.json");
const PERIOD_USAGE_URL = "https://cursor.com/api/dashboard/get-current-period-usage";
const USAGE_SUMMARY_URL = "https://cursor.com/api/usage-summary";
const USAGE_TTL_MS = 5 * 60_000;
const USAGE_ERROR_TTL_MS = 60_000;
const CYCLE_END_VISIBLE_MS = 3 * 24 * 60 * 60_000;

export type CursorUsage = {
	/** Percent of the included pool burned by Cursor models. */
	autoPercentUsed: number;
	/** Percent of the included pool burned by every other model. */
	apiPercentUsed: number;
	/** Cursor's own list of model ids that bill to the Cursor-models bucket. */
	autoBucketModels: string[];
	cycleEndIso?: string;
	/** On-demand spend past the included pool, in cents. */
	onDemandUsedCents?: number;
	fetchedAt: number;
	error?: string;
};

export type UsageSegment = {
	text: string;
	color: "success" | "warning" | "error" | "dim" | "muted";
};

let cachedUsage: CursorUsage | null = null;
let inflight: Promise<void> | null = null;

export function isCursorModel(
	model: { provider?: string; id?: string } | undefined | null,
): boolean {
	if (!model?.provider) return false;
	const provider = model.provider.toLowerCase();
	return provider === "cursor-proxy" || provider === "cursor" || provider.includes("cursor");
}

const EFFORT_SUFFIXES = new Set(["low", "medium", "high", "xhigh", "max", "none"]);

/** Strips the -fast / -thinking / effort suffixes so ids compare across variants. */
function baseModelId(id: string): string {
	let remaining = id.toLowerCase().split("/").pop() || "";
	if (remaining.endsWith("-fast")) remaining = remaining.slice(0, -5);
	if (remaining.endsWith("-thinking")) remaining = remaining.slice(0, -9);
	if (remaining.endsWith("-fast")) remaining = remaining.slice(0, -5);
	const lastDash = remaining.lastIndexOf("-");
	if (lastDash >= 0 && EFFORT_SUFFIXES.has(remaining.slice(lastDash + 1))) {
		remaining = remaining.slice(0, lastDash);
	}
	return remaining;
}

/**
 * Whether a model bills to the Cursor-models bucket. Prefers Cursor's own
 * `autoBucketModels` list; falls back to the model families that list has
 * always contained, so the footer is right before the first fetch lands.
 */
export function billsToAutoBucket(modelId: string, autoBucketModels: string[] = []): boolean {
	const base = baseModelId(modelId);
	if (!base) return false;
	if (autoBucketModels.some((m) => baseModelId(m) === base)) return true;
	if (autoBucketModels.length > 0) return false;
	return /^(composer|vega|default$|cursor-grok|grok-4\.5)/.test(base);
}

/** Rebuilds the dashboard session cookie from the cursor-proxy OAuth token. */
function readCursorSessionCookie(): string | undefined {
	try {
		const auth = JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Record<
			string,
			{ access?: string } | undefined
		>;
		const access = auth["cursor-proxy"]?.access;
		if (!access) return undefined;
		const payload = access.split(".")[1];
		if (!payload) return undefined;
		const claims = JSON.parse(
			Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
		) as { sub?: string };
		if (!claims.sub) return undefined;
		return `WorkosCursorSessionToken=${encodeURIComponent(claims.sub)}%3A%3A${access}`;
	} catch {
		return undefined;
	}
}

function num(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

async function fetchCursorUsage(cookie: string, signal?: AbortSignal): Promise<CursorUsage> {
	const fetchedAt = Date.now();
	const headers = {
		Cookie: cookie,
		Origin: "https://cursor.com",
		Referer: "https://cursor.com/dashboard/usage",
		Accept: "application/json",
		"Content-Type": "application/json",
	};

	const res = await fetch(PERIOD_USAGE_URL, {
		method: "POST",
		headers,
		body: "{}",
		signal,
	});
	if (res.status === 401 || res.status === 403) throw new Error("no-auth");
	if (!res.ok) throw new Error(`usage HTTP ${res.status}`);

	const data = (await res.json()) as {
		planUsage?: Record<string, unknown>;
		billingCycleEnd?: unknown;
		autoBucketModels?: unknown;
	};
	const plan = data.planUsage ?? {};
	const cycleEndMs = num(data.billingCycleEnd);

	const usage: CursorUsage = {
		autoPercentUsed: num(plan.autoPercentUsed) ?? 0,
		apiPercentUsed: num(plan.apiPercentUsed) ?? 0,
		autoBucketModels: Array.isArray(data.autoBucketModels)
			? data.autoBucketModels.filter((m): m is string => typeof m === "string")
			: [],
		cycleEndIso: cycleEndMs ? new Date(cycleEndMs).toISOString() : undefined,
		fetchedAt,
	};

	// On-demand spend lives on the summary endpoint only — best effort.
	try {
		const summaryRes = await fetch(USAGE_SUMMARY_URL, { headers, signal });
		if (summaryRes.ok) {
			const summary = (await summaryRes.json()) as {
				individualUsage?: { onDemand?: { enabled?: boolean; used?: unknown } };
			};
			const onDemand = summary.individualUsage?.onDemand;
			if (onDemand?.enabled) usage.onDemandUsedCents = num(onDemand.used) ?? 0;
			if (!usage.cycleEndIso) {
				const iso = (summary as { billingCycleEnd?: unknown }).billingCycleEnd;
				if (typeof iso === "string") usage.cycleEndIso = iso;
			}
		}
	} catch {
		// ignore — the plan meters are what the footer needs
	}

	return usage;
}

export function cursorUsageFresh(): boolean {
	if (!cachedUsage) return false;
	const ttl = cachedUsage.error ? USAGE_ERROR_TTL_MS : USAGE_TTL_MS;
	return Date.now() - cachedUsage.fetchedAt < ttl;
}

export function cursorUsage(): CursorUsage | null {
	return cachedUsage;
}

export function markCursorUsageStale(): void {
	if (cachedUsage) cachedUsage = { ...cachedUsage, fetchedAt: 0 };
}

export function ensureCursorUsage(onUpdate: () => void, signal?: AbortSignal): void {
	if (cursorUsageFresh() || inflight) return;

	const fail = (error: string) => {
		cachedUsage = {
			autoPercentUsed: 0,
			apiPercentUsed: 0,
			autoBucketModels: cachedUsage?.autoBucketModels ?? [],
			fetchedAt: Date.now(),
			error,
		};
		onUpdate();
	};

	inflight = (async () => {
		const cookie = readCursorSessionCookie();
		if (signal?.aborted) return;
		if (!cookie) {
			fail("no-auth");
			return;
		}
		try {
			const usage = await fetchCursorUsage(cookie, signal);
			if (signal?.aborted) return;
			cachedUsage = usage;
			onUpdate();
		} catch (err) {
			if (signal?.aborted) return;
			fail(err instanceof Error ? err.message : "error");
		}
	})().finally(() => {
		inflight = null;
	});
}

function fmtPercent(n: number): string {
	if (!Number.isFinite(n) || n < 0.05) return "0%";
	if (n < 10) return `${n.toFixed(1)}%`;
	return `${Math.round(n)}%`;
}

function percentColor(used: number): UsageSegment["color"] {
	if (used >= 90) return "error";
	if (used >= 75) return "warning";
	return "success";
}

/**
 * Both plan meters, with the bucket the active model bills to highlighted and
 * the other dimmed. Percentages are of the included pool, already consumed.
 * Returns a single placeholder segment while the first fetch is in flight.
 */
export function formatCursorUsage(usage: CursorUsage | null, modelId: string): UsageSegment[] {
	if (!usage) return [{ text: "…", color: "dim" }];
	if (usage.error === "no-auth") return [{ text: "login", color: "dim" }];
	if (usage.error) return [{ text: "n/a", color: "dim" }];

	const auto = billsToAutoBucket(modelId, usage.autoBucketModels);
	const segments: UsageSegment[] = [
		{
			text: `cur ${fmtPercent(usage.autoPercentUsed)}`,
			color: auto ? percentColor(usage.autoPercentUsed) : "dim",
		},
		{
			text: `api ${fmtPercent(usage.apiPercentUsed)}`,
			color: auto ? "dim" : percentColor(usage.apiPercentUsed),
		},
	];

	if (usage.onDemandUsedCents && usage.onDemandUsedCents > 0) {
		segments.push({
			text: `+$${(usage.onDemandUsedCents / 100).toFixed(2)}`,
			color: "warning",
		});
	}
	// The billing cycle is monthly; only worth the footer width once it's close.
	if (usage.cycleEndIso) {
		const msLeft = new Date(usage.cycleEndIso).getTime() - Date.now();
		if (Number.isFinite(msLeft) && msLeft < CYCLE_END_VISIBLE_MS) {
			segments.push({ text: formatDurationLeft(usage.cycleEndIso), color: "dim" });
		}
	}
	return segments;
}
