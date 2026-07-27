import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { BUNDLED_AGENTS_DIR, USER_AGENTS_DIR } from "./constants";
import type { AgentConfig, ResolvedModel } from "./types";

export function loadAgentsFromDir(dir: string, source: "bundled" | "user"): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			thinking: frontmatter.thinking,
			systemPrompt: body.trim(),
			source,
			filePath,
		});
	}

	return agents;
}

/** Bundled defaults + ~/.pi/agent/agents/*.md (user overrides by name). */
export function discoverAgents(): AgentConfig[] {
	const map = new Map<string, AgentConfig>();
	for (const a of loadAgentsFromDir(BUNDLED_AGENTS_DIR, "bundled")) map.set(a.name, a);
	for (const a of loadAgentsFromDir(USER_AGENTS_DIR, "user")) map.set(a.name, a);
	return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function formatModelLabel(resolved: ResolvedModel): string {
	const bits: string[] = [];
	bits.push(resolved.model ?? "inherit");
	if (resolved.thinking) bits.push(`thinking:${resolved.thinking}`);
	// Only tag [invoke]/[frontmatter] when model itself was set (not pure thinking defaults).
	if (resolved.model && resolved.source !== "inherit") {
		return `${bits.join(" ")} [${resolved.source}]`;
	}
	return bits.join(" ");
}

export function formatAgentCatalog(
	agents: AgentConfig[],
	resolveModel?: (agent: AgentConfig) => ResolvedModel,
	opts?: { compact?: boolean },
): string {
	if (agents.length === 0) {
		return `No subagents found. Add markdown agents to ${USER_AGENTS_DIR}`;
	}
	const compact = opts?.compact !== false;
	return agents
		.map((a) => {
			const modelBit = resolveModel
				? formatModelLabel(resolveModel(a))
				: a.model
					? `${a.model}${a.thinking ? ` thinking:${a.thinking}` : ""}`
					: "inherit";
			if (compact) {
				const d = a.description.replace(/\s+/g, " ").trim();
				const short = d.length <= 60 ? d : `${d.slice(0, 57).replace(/\s+\S*$/, "")}…`;
				const src = a.source === "user" ? " · user" : "";
				return `- ${a.name}${src}: ${short} · ${modelBit}`;
			}
			return `- ${a.name} (${a.source}): ${a.description} · model: ${modelBit}`;
		})
		.join("\n");
}

/**
 * Resolve model/thinking for a subagent run.
 * Priority: tool invoke > agent frontmatter > parent inherit (omit --model).
 * Thinking may come from frontmatter while model still inherits the parent chat.
 */
export function resolveAgentModel(
	agent: AgentConfig,
	opts?: { invokeModel?: string; invokeThinking?: string },
): ResolvedModel {
	const invokeModel = trimOrUndef(opts?.invokeModel);
	const invokeThinking = trimOrUndef(opts?.invokeThinking);

	const model = invokeModel ?? agent.model;
	const thinking = invokeThinking ?? agent.thinking;

	let source: ResolvedModel["source"];
	if (invokeModel || invokeThinking) source = "invoke";
	else if (agent.model || agent.thinking) source = "frontmatter";
	else source = "inherit";

	// No model string => runner omits --model and the child inherits the parent session model.
	return { model, thinking, source };
}

function trimOrUndef(v?: string): string | undefined {
	const t = v?.trim();
	return t ? t : undefined;
}
