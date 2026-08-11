/**
 * subagents — minimal subagent delegation for pi
 *
 * One tool. Isolated pi subprocesses. Parent turn blocks until children finish.
 *
 * Catalog + routing live on the tool description (Claude Code Agent-tool style).
 * System prompt stays free of a ## Subagents block.
 *
 * Modes:
 *   single:   { agent, task, model?, thinking? }
 *   parallel: { tasks: [{ agent, task, model?, thinking? }, ...] }  (max 4)
 *
 * Agents: bundled + ~/.pi/agent/agents (user) + <cwd>/.pi/agents (project; highest precedence)
 * Models: tool param > agent frontmatter model > parent chat inherit
 * Thinking: tool param > agent frontmatter (defaults per role) > parent
 *
 * Child: --system-prompt (agent role), --no-skills, --no-prompt-templates.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSubagentsTool } from "./tool";

export default function (pi: ExtensionAPI) {
	// Children set PI_SUBAGENT=1 — no tool registration (avoid recursion).
	if (process.env.PI_SUBAGENT === "1") return;

	pi.registerTool(createSubagentsTool());
}
