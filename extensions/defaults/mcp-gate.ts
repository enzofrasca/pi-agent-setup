/**
 * Only expose the `mcp` proxy tool when the project has an enabled MCP server.
 *
 * Project-scoped:
 *   - <cwd>/.mcp.json
 *   - <cwd>/.pi/mcp.json
 *
 * Global MCP alone does not keep the tool visible.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MCP_TOOL = "mcp";

type ToolHost = {
	getActiveTools?: () => string[];
	setActiveTools?: (tools: string[]) => void;
	getAllTools?: () => Array<{ name: string }>;
	unregisterTool?: (name: string) => boolean;
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

function hostFrom(pi: ExtensionAPI, ctx?: ExtensionContext): ToolHost {
	const c = (ctx ?? {}) as ToolHost;
	const p = pi as unknown as ToolHost;
	return {
		getActiveTools: c.getActiveTools?.bind(c) ?? p.getActiveTools?.bind(p),
		setActiveTools: c.setActiveTools?.bind(c) ?? p.setActiveTools?.bind(p),
		getAllTools: p.getAllTools?.bind(p),
		unregisterTool: p.unregisterTool?.bind(p),
	};
}

function syncMcpVisibility(pi: ExtensionAPI, ctx?: ExtensionContext): void {
	const cwd = ctx?.cwd ?? process.cwd();
	const active = projectHasActiveMcp(cwd);
	const host = hostFrom(pi, ctx);
	const tools = host.getActiveTools?.();
	if (!tools || !host.setActiveTools) return;

	const hasMcp = tools.includes(MCP_TOOL);
	const registered = host.getAllTools?.().some((t) => t.name === MCP_TOOL) ?? hasMcp;

	if (!active && hasMcp) {
		if (host.unregisterTool?.(MCP_TOOL)) return;
		host.setActiveTools(tools.filter((name) => name !== MCP_TOOL));
		return;
	}

	if (active && !hasMcp && registered) {
		host.setActiveTools([...tools, MCP_TOOL]);
	}
}

export function registerMcpGate(pi: ExtensionAPI): void {
	setImmediate(() => {
		try {
			syncMcpVisibility(pi);
		} catch {
			/* ignore */
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		setTimeout(() => {
			try {
				syncMcpVisibility(pi, ctx);
			} catch {
				/* ignore */
			}
		}, 0);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			syncMcpVisibility(pi, ctx);
		} catch {
			/* ignore */
		}
	});
}
