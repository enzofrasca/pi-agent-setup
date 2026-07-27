import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import { LARGE_TASK_CHARS } from "./constants";
import {
	appendStderr,
	emptyUsage,
	getFinalOutput,
	getPiInvocation,
	isFailed,
	killProcessTree,
	lastToolPreview,
	nowMs,
	writeTempFile,
} from "./helpers";
import type { AgentConfig, OnUpdate, ResolvedModel, RunResult, ToolDetails } from "./types";
import { resolveAgentModel } from "./discovery";

export async function runAgent(opts: {
	cwd: string;
	agent: AgentConfig;
	task: string;
	signal?: AbortSignal;
	onUpdate?: OnUpdate;
	makeDetails: (results: RunResult[]) => ToolDetails;
	seed?: Partial<RunResult>;
	invokeModel?: string;
	invokeThinking?: string;
}): Promise<RunResult> {
	const { cwd, agent, task, signal, onUpdate, makeDetails } = opts;
	const startedAt = opts.seed?.startedAt ?? nowMs();
	const resolved: ResolvedModel = resolveAgentModel(agent, {
		invokeModel: opts.invokeModel,
		invokeThinking: opts.invokeThinking,
	});

	const args: string[] = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-skills",
		"--no-prompt-templates",
	];
	if (resolved.model) args.push("--model", resolved.model);
	if (resolved.thinking) args.push("--thinking", resolved.thinking);

	const childTools = agent.tools
		? agent.tools.filter((t) => t !== "subagents" && t !== "subagent")
		: undefined;
	if (childTools) {
		if (childTools.length === 0) args.push("--no-tools");
		else args.push("--tools", childTools.join(","));
	}

	const current: RunResult = {
		agent: agent.name,
		source: agent.source,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: resolved.model,
		thinking: resolved.thinking,
		modelSource: resolved.source,
		startedAt,
		lastEventAt: startedAt,
	};

	const emit = () => {
		const preview =
			lastToolPreview(current.messages) || getFinalOutput(current.messages) || "running…";
		onUpdate?.({
			content: [{ type: "text", text: preview }],
			details: makeDetails([{ ...current }]),
		});
	};

	const tmpDirs: string[] = [];
	let wasAborted = false;

	try {
		const role = agent.systemPrompt.trim();
		if (role) {
			const toolsLine = childTools
				? `Available tools for this run: ${childTools.join(", ")}. Prefer these over inventing other workflows.`
				: "You have the default tools enabled for this process (full coding capabilities).";
			const tmp = await writeTempFile(agent.name, "system.md", `${role}\n\n${toolsLine}`);
			tmpDirs.push(tmp.dir);
			args.push("--system-prompt", tmp.file);
		}

		const taskText = `Task: ${task}`;
		if (taskText.length >= LARGE_TASK_CHARS) {
			const tmp = await writeTempFile(agent.name, "task.md", taskText);
			tmpDirs.push(tmp.dir);
			args.push(`@${tmp.file}`);
		} else {
			args.push(taskText);
		}

		if (signal?.aborted) {
			wasAborted = true;
			current.exitCode = 1;
			current.stopReason = "aborted";
			current.errorMessage = "Subagent aborted before start";
			current.endedAt = nowMs();
			current.lastEventAt = current.endedAt;
			return current;
		}

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
				env: {
					...process.env,
					PI_SUBAGENT: "1",
					PI_OFFLINE: process.env.PI_OFFLINE ?? "1",
				},
			});

			let buffer = "";
			let settled = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			let killEscalated = false;

			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				if (killTimer) clearTimeout(killTimer);
				if (signal) signal.removeEventListener("abort", onAbort);
				resolve(code);
			};

			const onAbort = () => {
				if (settled) return;
				wasAborted = true;
				current.stopReason = "aborted";
				current.errorMessage = "Subagent aborted";
				current.lastEventAt = nowMs();
				emit();
				killProcessTree(proc, "SIGTERM");
				if (!killEscalated) {
					killEscalated = true;
					killTimer = setTimeout(() => {
						if (!settled) killProcessTree(proc, "SIGKILL");
					}, 3000);
					killTimer.unref?.();
				}
			};

			const handleLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				current.lastEventAt = nowMs();

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					current.messages.push(msg);
					if (msg.role === "assistant") {
						current.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							current.usage.input += usage.input || 0;
							current.usage.output += usage.output || 0;
							current.usage.cacheRead += usage.cacheRead || 0;
							current.usage.cacheWrite += usage.cacheWrite || 0;
							current.usage.cost += usage.cost?.total || 0;
							current.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!current.model && msg.model) current.model = msg.model;
						if (msg.stopReason) current.stopReason = msg.stopReason;
						if (msg.errorMessage) current.errorMessage = msg.errorMessage;
					}
					emit();
				}

				if (event.type === "tool_result_end" && event.message) {
					current.messages.push(event.message as Message);
					emit();
				}
			};

			proc.stdout?.on("data", (chunk) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) handleLine(line);
			});

			proc.stderr?.on("data", (chunk) => {
				appendStderr(current, chunk.toString());
				current.lastEventAt = nowMs();
			});

			proc.on("close", (code, exitSignal) => {
				if (buffer.trim()) handleLine(buffer);
				if (code === null) {
					if (!wasAborted && exitSignal) {
						current.errorMessage = current.errorMessage || `Process killed by ${exitSignal}`;
					}
					finish(1);
					return;
				}
				finish(code);
			});

			proc.on("error", (err) => {
				appendStderr(current, err.message);
				current.errorMessage = err.message;
				finish(1);
			});

			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}

			emit();
		});

		current.exitCode = exitCode;
		current.endedAt = nowMs();
		current.lastEventAt = current.endedAt;
		if (wasAborted) {
			current.stopReason = "aborted";
			current.errorMessage = current.errorMessage || "Subagent aborted";
		} else if (exitCode !== 0 && !current.stopReason) {
			current.stopReason = "error";
		}
		return current;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		current.exitCode = 1;
		current.stopReason = wasAborted ? "aborted" : "error";
		current.errorMessage = message;
		current.endedAt = nowMs();
		current.lastEventAt = current.endedAt;
		return current;
	} finally {
		for (const dir of tmpDirs) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}
}
