/**
 * defaults — local harness preferences (not features)
 *
 * - PI_FFF_MODE=override early (before extensions/fff package factory)
 * - Lean system prompt
 * - MCP gate (hide mcp tools unless project has MCP)
 *
 * User extensions load before packages, so env is set before FFF reads it.
 * FFF itself defaults to override; this is belt-and-suspenders.
 */

// Must run at module load — before package factories (incl. extensions/fff).
if (!process.env.PI_FFF_MODE) {
	process.env.PI_FFF_MODE = "override";
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMcpGate } from "./mcp-gate.ts";
import { registerLeanPrompt } from "./lean-prompt.ts";

export default function (pi: ExtensionAPI): void {
	if (!process.env.PI_FFF_MODE) {
		process.env.PI_FFF_MODE = "override";
	}

	registerLeanPrompt(pi);
	registerMcpGate(pi);
}
