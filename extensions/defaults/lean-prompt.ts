/**
 * Lean the always-on parent system prompt.
 * Kill switch: PI_LEAN_PROMPT=0. Skipped for PI_SUBAGENT children and custom --system-prompt.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getDocsPath, getExamplesPath, getReadmePath } from "@earendil-works/pi-coding-agent";

function shrinkPiDocs(prompt: string): string {
	const docsPath = getDocsPath();
	const readmePath = getReadmePath();
	const examplesPath = getExamplesPath();
	const oneLiner =
		`Pi product docs (only when the user asks about pi itself): ${readmePath}; docs ${docsPath}; examples ${examplesPath}.`;

	const re =
		/\nPi documentation \(read only when the user asks about pi itself[\s\S]*?(?=\n\n<project_context>|\nCurrent working directory:|\n\n## |\n*$)/;
	if (re.test(prompt)) {
		return prompt.replace(re, `\n\n${oneLiner}\n`);
	}
	return prompt;
}

function dropFiller(prompt: string): string {
	return prompt
		.replace(
			/\nIn addition to the tools above, you may have access to other custom tools depending on the project\.\n/g,
			"\n",
		)
		.replace(/\n{3,}/g, "\n\n");
}

function slimGuidelines(prompt: string): string {
	// Defense only: search/scrape/subagents policy lives on tool descriptions,
	// not always-on Guidelines. Keep stripping if something re-injects them.
	const dropPrefixes = [
		"Use search ",
		"Use scrape",
		"Use subagents",
		"Call subagents",
		"Prefer a single subagents",
		"Prefer search first",
		"Write queries as specific",
		"For framework or product docs",
		"Answer from search excerpts",
		"When search offers both HTML",
	];
	const shouldDrop = (body: string) => dropPrefixes.some((p) => body.startsWith(p));

	const lines = prompt.split("\n");
	const out: string[] = [];
	let inGuidelines = false;
	for (const line of lines) {
		if (line === "Guidelines:") {
			inGuidelines = true;
			out.push(line);
			continue;
		}
		if (inGuidelines) {
			if (line.startsWith("- ")) {
				const body = line.slice(2).trim();
				if (shouldDrop(body)) continue;
				out.push(line);
				continue;
			}
			if (line.trim() === "" || !line.startsWith(" ")) {
				inGuidelines = false;
			}
		}
		out.push(line);
	}
	return out.join("\n");
}

function tightenIntro(prompt: string): string {
	const fat =
		"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
	const lean =
		"You are a coding agent in pi. Read, run commands, and edit code. Match the surrounding code's style, naming, and comment density.";
	return prompt.includes(fat) ? prompt.replace(fat, lean) : prompt;
}

export function registerLeanPrompt(pi: ExtensionAPI): void {
	if (process.env.PI_SUBAGENT === "1") return;
	if (process.env.PI_LEAN_PROMPT === "0") return;

	pi.on("before_agent_start", async (event) => {
		if (event.systemPromptOptions?.customPrompt) {
			return;
		}

		let next = event.systemPrompt;
		next = tightenIntro(next);
		next = shrinkPiDocs(next);
		next = dropFiller(next);
		next = slimGuidelines(next);
		next = next.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

		if (next === event.systemPrompt) return;
		return { systemPrompt: next };
	});
}
