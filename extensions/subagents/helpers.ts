import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { Message } from "@earendil-works/pi-ai";
import { MAX_OUTPUT_CHARS, MAX_STDERR_CHARS, QUIET_HINT_MS } from "./constants";
import type { RunResult, UsageStats } from "./types";

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function nowMs(): number {
	return Date.now();
}

export function formatElapsed(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) ms = 0;
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	const mins = Math.floor(totalSec / 60);
	const secs = totalSec % 60;
	if (mins < 60) return `${mins}m${secs.toString().padStart(2, "0")}s`;
	const hours = Math.floor(mins / 60);
	const remMins = mins % 60;
	return `${hours}h${remMins.toString().padStart(2, "0")}m`;
}

export function runDurationMs(r: RunResult, now = nowMs()): number {
	const end = r.endedAt ?? now;
	return Math.max(0, end - r.startedAt);
}

export function quietFor(r: RunResult, now = nowMs()): boolean {
	if (r.exitCode !== -1) return false;
	return now - r.lastEventAt >= QUIET_HINT_MS;
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "text" && part.text.trim()) return part.text;
		}
	}
	return "";
}

export function isFailed(result: RunResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function getResultText(result: RunResult): string {
	if (isFailed(result)) {
		return result.errorMessage || result.stderr.trim() || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

export function truncate(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n…[truncated ${text.length - MAX_OUTPUT_CHARS} chars]`;
}

export function formatUsage(u: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns === 1 ? "" : "s"}`);
	if (u.input) parts.push(`↑${u.input}`);
	if (u.output) parts.push(`↓${u.output}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export function sumUsage(results: RunResult[]): UsageStats {
	const u = emptyUsage();
	for (const r of results) {
		u.input += r.usage.input;
		u.output += r.usage.output;
		u.cacheRead += r.usage.cacheRead;
		u.cacheWrite += r.usage.cacheWrite;
		u.cost += r.usage.cost;
		u.turns += r.usage.turns;
		u.contextTokens = Math.max(u.contextTokens, r.usage.contextTokens);
	}
	return u;
}

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function clip(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Human-readable one-liner for a tool call (progress / live UI). */
export function formatToolCallPreview(
	toolName: string,
	args: Record<string, unknown> | undefined,
): string {
	const a = args ?? {};
	switch (toolName) {
		case "bash": {
			const command = typeof a.command === "string" ? a.command : "…";
			return `$ ${clip(command, 70)}`;
		}
		case "read": {
			const raw = (a.path ?? a.file_path ?? "…") as string;
			const filePath = shortenPath(String(raw));
			const offset = typeof a.offset === "number" ? a.offset : undefined;
			const limit = typeof a.limit === "number" ? a.limit : undefined;
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				const end = limit !== undefined ? start + limit - 1 : "";
				return `read ${filePath}:${start}${end !== "" ? `-${end}` : ""}`;
			}
			return `read ${filePath}`;
		}
		case "write": {
			const raw = (a.path ?? a.file_path ?? "…") as string;
			return `write ${shortenPath(String(raw))}`;
		}
		case "edit": {
			const raw = (a.path ?? a.file_path ?? "…") as string;
			return `edit ${shortenPath(String(raw))}`;
		}
		case "ls": {
			const raw = typeof a.path === "string" ? a.path : ".";
			return `ls ${shortenPath(raw)}`;
		}
		case "find": {
			const pattern = typeof a.pattern === "string" ? a.pattern : "*";
			const raw = typeof a.path === "string" ? a.path : ".";
			return `find ${clip(pattern, 40)} in ${shortenPath(raw)}`;
		}
		case "grep": {
			const pattern = typeof a.pattern === "string" ? a.pattern : "";
			const raw = typeof a.path === "string" ? a.path : ".";
			return `grep /${clip(pattern, 40)}/ in ${shortenPath(raw)}`;
		}
		case "search": {
			const q = typeof a.query === "string" ? a.query : "…";
			return `search ${clip(q, 60)}`;
		}
		case "scrape": {
			const url = typeof a.url === "string" ? a.url : "…";
			return `scrape ${clip(url, 70)}`;
		}
		default: {
			const argsStr = JSON.stringify(a);
			return `${toolName} ${clip(argsStr, 50)}`;
		}
	}
}

export function lastToolPreview(messages: Message[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (let j = msg.content.length - 1; j >= 0; j--) {
			const part = msg.content[j];
			if (part.type === "toolCall") {
				return formatToolCallPreview(
					part.name,
					(part.arguments ?? {}) as Record<string, unknown>,
				);
			}
		}
	}
	return undefined;
}

export function progressLine(r: RunResult, now = nowMs()): string {
	const elapsed = formatElapsed(runDurationMs(r, now));
	if (r.exitCode === -1) {
		const preview = lastToolPreview(r.messages) || "starting…";
		const quiet = quietFor(r, now) ? " · quiet" : "";
		return `${r.agent} ${elapsed}${quiet} · ${preview}`;
	}
	if (isFailed(r)) {
		const why = r.stopReason === "aborted" ? "aborted" : "failed";
		return `${r.agent} ${elapsed} · ${why}`;
	}
	return `${r.agent} ${elapsed} · done`;
}

export function formatParallelProgress(results: RunResult[], now = nowMs()): string {
	const done = results.filter((r) => r.exitCode !== -1).length;
	const running = results.length - done;
	const lines = results.map((r) => `  ${progressLine(r, now)}`);
	return `Parallel ${done}/${results.length} done · ${running} running\n${lines.join("\n")}`;
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

export async function writeTempFile(
	agentName: string,
	basename: string,
	content: string,
): Promise<{ dir: string; file: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagents-"));
	const safe = agentName.replace(/[^\w.-]+/g, "_");
	const file = path.join(dir, `${safe}-${basename}`);
	await fs.promises.writeFile(file, content, { encoding: "utf-8", mode: 0o600 });
	return { dir, file };
}

export function appendStderr(current: RunResult, chunk: string): void {
	current.stderr += chunk;
	if (current.stderr.length > MAX_STDERR_CHARS) {
		current.stderr = current.stderr.slice(-MAX_STDERR_CHARS);
	}
}

export function killProcessTree(proc: ReturnType<typeof spawn>, signalName: NodeJS.Signals): void {
	const pid = proc.pid;
	if (pid && process.platform !== "win32") {
		try {
			process.kill(-pid, signalName);
			return;
		} catch {
			/* fall through */
		}
	}
	try {
		proc.kill(signalName);
	} catch {
		/* already dead */
	}
}

export async function mapPool<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			results[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return results;
}
