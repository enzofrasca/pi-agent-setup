/**
 * subagents — minimal subagent delegation for pi
 *
 * One tool. Isolated pi subprocesses. Parent turn blocks until children finish.
 *
 * Modes:
 *   single:   { agent, task, model?, thinking? }
 *   parallel: { tasks: [{ agent, task, model?, thinking? }, ...] }  (max 4)
 *
 * Agents: bundled agents/*.md + ~/.pi/agent/agents/*.md (user overrides by name)
 * Models: tool param > agent frontmatter model > parent chat inherit
 * Thinking: tool param > agent frontmatter (defaults per role) > parent
 *
 * Child: --system-prompt (agent role), --no-skills, --no-prompt-templates.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents, formatAgentCatalog, resolveAgentModel } from "./discovery";
import { createSubagentsTool } from "./tool";

export default function (pi: ExtensionAPI) {
	// Children set PI_SUBAGENT=1 — no catalog, no tool.
	if (process.env.PI_SUBAGENT === "1") return;

	pi.on("before_agent_start", async (event) => {
		const agents = discoverAgents();
		if (agents.length === 0) return;

		const block = [
			"",
			"## Subagents",
			"Isolated agents via `subagents`. Tasks: goal, constraints, paths, expected output. Parallel max 4.",
			formatAgentCatalog(agents, (a) => resolveAgentModel(a), { compact: true }),
			"oracle: architecture/tradeoffs/hard bugs only — not recon or routine edits.",
			"Models: inherit parent chat unless frontmatter/tool sets model; thinking levels from agent frontmatter or tool params.",
		].join("\n");

		return { systemPrompt: `${event.systemPrompt}${block}` };
	});

	pi.registerTool(createSubagentsTool());
}
