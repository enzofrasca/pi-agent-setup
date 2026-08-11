import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { BUNDLED_AGENTS_DIR, PROJECT_AGENTS_REL, USER_AGENTS_DIR } from "./constants";
import type { AgentConfig, ResolvedModel } from "./types";

export type AgentSource = AgentConfig["source"];

export function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
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

/**
 * Discover agents for a session.
 * Precedence (later wins by name): bundled < user (~/.pi/agent/agents) < project (<cwd>/.pi/agents).
 * Pass cwd so project-local factory agents load only in that repo.
 */
export function discoverAgents(cwd?: string): AgentConfig[] {
	const map = new Map<string, AgentConfig>();
	for (const a of loadAgentsFromDir(BUNDLED_AGENTS_DIR, "bundled")) map.set(a.name, a);
	for (const a of loadAgentsFromDir(USER_AGENTS_DIR, "user")) map.set(a.name, a);
	if (cwd) {
		const projectDir = path.resolve(cwd, PROJECT_AGENTS_REL);
		for (const a of loadAgentsFromDir(projectDir, "project")) map.set(a.name, a);
	}
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

/** Tools field for catalog lines — Claude Code AgentTool style. */
export function getToolsDescription(agent: AgentConfig): string {
	if (!agent.tools || agent.tools.length === 0) return "all";
	return agent.tools.join(", ");
}

/**
 * One catalog line (CC formatAgentLine):
 * `- name: whenToUse (Tools: …)`
 */
export function formatAgentLine(agent: AgentConfig): string {
	const when = agent.description.replace(/\s+/g, " ").trim();
	const tools = getToolsDescription(agent);
	const tag =
		agent.source === "user" ? " [user]" : agent.source === "project" ? " [project]" : "";
	return `- ${agent.name}${tag}: ${when} (Tools: ${tools})`;
}

export function formatAgentCatalog(
	agents: AgentConfig[],
	_resolveModel?: (agent: AgentConfig) => ResolvedModel,
	_opts?: { compact?: boolean },
): string {
	if (agents.length === 0) {
		return `No subagents found. Add markdown agents to ${USER_AGENTS_DIR} or .pi/agents/ in the project.`;
	}
	// Always CC-style lines (compact flag kept for call-site compatibility).
	return agents.map(formatAgentLine).join("\n");
}

/** Tool description body: static policy + live agent registry (CC Agent tool). */
export function buildSubagentsToolDescription(agents: AgentConfig[]): string {
	const catalog =
		agents.length > 0
			? agents.map(formatAgentLine).join("\n")
			: `(none — add agents under ${USER_AGENTS_DIR} or <project>/.pi/agents/)`;

	return [
		"Delegate a task to a specialized subagent with an isolated context window.",
		"Use when parent context is heavy, work is independent/parallel, or you need a read-only specialist.",
		"Prefer parent tools for small single-file work (one path, one symbol, 2–3 known files).",
		"",
		"Available agent types and the tools they have access to:",
		catalog,
		"",
		"Prefer one tasks[] call for independent work (max 4); do not parallelize dependent steps.",
		"Single: { agent, task }. Parallel: { tasks: [{ agent, task }, ...] }.",
		"Optional model/thinking per call or task. Model inherits parent chat unless overridden.",
		"Only the final text returns — not tool calls or intermediate steps. Parent waits until done.",
		"Tasks: goal, constraints, paths, expected output.",
		`Custom agents: ${USER_AGENTS_DIR} (global) or .pi/agents/ (project-local, preferred for factory).`,
	].join("\n");
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
