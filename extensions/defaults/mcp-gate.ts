/**
 * Only expose MCP surfaces when the project has an enabled MCP server.
 *
 * Hides:
 *   - `mcp` / `mcpScript` tools (setActiveTools)
 *   - `mcp-scripting` skill (package skills disabled in settings; re-added via
 *     resources_discover only when the project has MCP)
 *
 * Project-scoped detection:
 *   - <cwd>/.mcp.json
 *   - <cwd>/.pi/mcp.json
 *
 * Global MCP alone does not keep them visible.
 *
 * Docs:
 *   - packages.md / settings.md: package filter `"skills": []`
 *   - extensions.md: resources_discover can contribute skillPaths
 *   - pi-mcp-adapter README: hide skill with object package entry
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MCP_TOOLS = ["mcp", "mcpScript"] as const;

type ToolHost = {
	getActiveTools?: () => string[];
	setActiveTools?: (tools: string[]) => void;
	getAllTools?: () => Array<{ name: string }>;
};

function readJson(filePath: string): unknown | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		const raw = fs.readFileSync(filePath, "utf-8");
		const stripped = raw
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
		return JSON.parse(stripped);
	} catch {
		return null;
	}
}

function extractServers(value: unknown): Record<string, { disabled?: boolean } | undefined> {
	if (!value || typeof value !== "object") return {};
	const obj = value as Record<string, unknown>;
	const servers = obj.mcpServers ?? obj["mcp-servers"] ?? obj.mcp_servers;
	if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {};
	return servers as Record<string, { disabled?: boolean } | undefined>;
}

function isDisabled(entry: { disabled?: boolean } | undefined): boolean {
	return entry?.disabled === true;
}

export function projectHasActiveMcp(cwd: string): boolean {
	const candidates = [path.join(cwd, ".mcp.json"), path.join(cwd, ".pi", "mcp.json")];
	for (const file of candidates) {
		const servers = extractServers(readJson(file));
		for (const entry of Object.values(servers)) {
			if (!isDisabled(entry)) return true;
		}
	}
	return false;
}

/** Resolve pi-mcp-adapter's mcp-scripting skill dir (package install under agent npm). */
export function resolveMcpScriptingSkillPath(): string | null {
	const candidates = [
		// Usual pi package install location
		path.join(
			process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? "", ".pi", "agent"),
			"npm",
			"node_modules",
			"pi-mcp-adapter",
			"skills",
			"mcp-scripting",
		),
		// Fallback: resolve from a known package file if present in module graph
	];

	for (const dir of candidates) {
		if (fs.existsSync(path.join(dir, "SKILL.md"))) return dir;
	}

	// Last resort: walk from this extension file toward agent npm
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const guess = path.resolve(
			here,
			"..",
			"..",
			"npm",
			"node_modules",
			"pi-mcp-adapter",
			"skills",
			"mcp-scripting",
		);
		if (fs.existsSync(path.join(guess, "SKILL.md"))) return guess;
	} catch {
		/* ignore */
	}

	return null;
}

function hostFrom(pi: ExtensionAPI, ctx?: ExtensionContext): ToolHost {
	const c = (ctx ?? {}) as ToolHost;
	const p = pi as unknown as ToolHost;
	return {
		getActiveTools: c.getActiveTools?.bind(c) ?? p.getActiveTools?.bind(p),
		setActiveTools: c.setActiveTools?.bind(c) ?? p.setActiveTools?.bind(p),
		getAllTools: p.getAllTools?.bind(p),
	};
}

/** Deactivate/reactivate MCP tools via setActiveTools (rebuilds base prompt). */
function syncMcpToolVisibility(pi: ExtensionAPI, ctx?: ExtensionContext): void {
	const cwd = ctx?.cwd ?? process.cwd();
	const active = projectHasActiveMcp(cwd);
	const host = hostFrom(pi, ctx);
	const tools = host.getActiveTools?.();
	if (!tools || !host.setActiveTools) return;

	const registered = new Set((host.getAllTools?.() ?? []).map((t) => t.name));
	const activeSet = new Set(tools);
	let next = tools.slice();
	let changed = false;

	for (const name of MCP_TOOLS) {
		const isActive = activeSet.has(name);
		const isRegistered = registered.has(name);

		if (!active && isActive) {
			next = next.filter((n) => n !== name);
			activeSet.delete(name);
			changed = true;
			continue;
		}

		if (active && !isActive && isRegistered) {
			next = [...next, name];
			activeSet.add(name);
			changed = true;
		}
	}

	if (changed) host.setActiveTools(next);
}

export function registerMcpGate(pi: ExtensionAPI): void {
	const sync = (ctx?: ExtensionContext) => {
		try {
			syncMcpToolVisibility(pi, ctx);
		} catch {
			/* ignore */
		}
	};

	// Packages register tools after user extensions; re-sync after load + session.
	setImmediate(() => sync());
	pi.on("session_start", async (_event, ctx) => {
		setTimeout(() => sync(ctx), 0);
		setTimeout(() => sync(ctx), 50);
	});

	// Skill is NOT loaded from the package (settings skills: []).
	// Re-introduce only when the project has an enabled MCP server.
	// Fired after session_start; Pi rebuilds the system prompt if paths are returned.
	pi.on("resources_discover", async (event) => {
		if (!projectHasActiveMcp(event.cwd)) return;
		const skillPath = resolveMcpScriptingSkillPath();
		if (!skillPath) return;
		return { skillPaths: [skillPath] };
	});

	// Tools again at turn start (cwd may change; adapter may re-activate tools).
	pi.on("before_agent_start", async (_event, ctx) => {
		sync(ctx);
	});
}
