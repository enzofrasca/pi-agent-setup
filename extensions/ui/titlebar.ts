/**
 * Simple braille spinner in the terminal tab title while the agent works.
 * Works in Zed's terminal panel (OSC title). Keeps the TUI default spinner.
 */
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function baseTitle(pi: ExtensionAPI): string {
	const cwd = path.basename(process.cwd());
	const session = pi.getSessionName?.();
	return session ? `π · ${session} · ${cwd}` : `π · ${cwd}`;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let i = 0;

	function stop(ctx: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		i = 0;
		ctx.ui.setTitle(baseTitle(pi));
	}

	function start(ctx: ExtensionContext) {
		stop(ctx);
		timer = setInterval(() => {
			const frame = FRAMES[i++ % FRAMES.length];
			ctx.ui.setTitle(`${frame} π · Working...`);
		}, 80);
	}

	pi.on("agent_start", async (_e, ctx) => start(ctx));
	pi.on("agent_end", async (_e, ctx) => stop(ctx));
	pi.on("session_shutdown", async (_e, ctx) => stop(ctx));
}
