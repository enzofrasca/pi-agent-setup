/**
 * defaults — local harness preferences (not features)
 *
 * - FFF override mode (official npm:@ff-labs/pi-fff)
 * - MCP gate (hide proxy when project has no servers)
 * - Lean system prompt
 *
 * User extensions load before packages, so PI_FFF_MODE is set before pi-fff reads it.
 */

// Must run at module load — before package factories (incl. pi-fff).
if (!process.env.PI_FFF_MODE) {
	process.env.PI_FFF_MODE = "override";
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMcpGate } from "./mcp-gate.ts";
import { registerLeanPrompt } from "./lean-prompt.ts";

export default function (pi: ExtensionAPI): void {
	// Re-assert in case something cleared it between load and factory.
	if (!process.env.PI_FFF_MODE) {
		process.env.PI_FFF_MODE = "override";
	}

	registerMcpGate(pi);
	registerLeanPrompt(pi);
}
