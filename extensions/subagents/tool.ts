import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { MAX_PARALLEL, USER_AGENTS_DIR } from "./constants";
import { discoverAgents, formatAgentCatalog, resolveAgentModel } from "./discovery";
import {
	formatElapsed,
	formatParallelProgress,
	formatUsage,
	getResultText,
	isFailed,
	lastToolPreview,
	mapPool,
	nowMs,
	progressLine,
	runDurationMs,
	sumUsage,
	truncate,
} from "./helpers";
import { runAgent } from "./runner";
import type { RunResult, ToolDetails } from "./types";

const TaskItem = Type.Object({
	agent: Type.String({ description: "Agent name" }),
	task: Type.String({ description: "Self-contained task for the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory override" })),
	model: Type.Optional(
		Type.String({ description: "Override model for this task (provider/id)" }),
	),
	thinking: Type.Optional(Type.String({ description: "Override thinking level for this task" })),
});

const Params = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task text (single mode)" })),
	tasks: Type.Optional(
		Type.Array(TaskItem, { description: `Parallel tasks (max ${MAX_PARALLEL})` }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory (single mode)" })),
	model: Type.Optional(Type.String({ description: "Override model for this call (provider/id)" })),
	thinking: Type.Optional(Type.String({ description: "Override thinking level for this call" })),
});

function emptyRun(agent: string, source: RunResult["source"], task: string, startedAt: number): RunResult {
	return {
		agent,
		source,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		startedAt,
		lastEventAt: startedAt,
	};
}

export function createSubagentsTool() {
	return {
		name: "subagents",
		label: "Subagents",
		description: [
			"Delegate a task to a specialized subagent with an isolated context window.",
			"Single: { agent, task }. Parallel: { tasks: [{ agent, task }, ...] } (max 4).",
			"Optional model/thinking per call or task.",
			"Only the final text returns — not tool calls or intermediate steps.",
			"Parent turn waits until all subagents finish.",
			"Agents: scout, planner, oracle, reviewer, worker.",
			`Custom agents: ${USER_AGENTS_DIR}`,
		].join(" "),
		promptSnippet:
			"Delegate focused work to isolated subagents (scout, planner, oracle, reviewer, worker).",
		parameters: Params,

		async execute(
			_id: string,
			params: {
				agent?: string;
				task?: string;
				tasks?: Array<{
					agent: string;
					task: string;
					cwd?: string;
					model?: string;
					thinking?: string;
				}>;
				cwd?: string;
				model?: string;
				thinking?: string;
			},
			signal: AbortSignal | undefined,
			onUpdate: ((partial: any) => void) | undefined,
			ctx: ExtensionContext,
		) {
			const agents = discoverAgents();
			const byName = new Map(agents.map((a) => [a.name, a]));
			const batchStartedAt = nowMs();
			const catalog = () =>
				formatAgentCatalog(agents, (a) => resolveAgentModel(a), { compact: false });

			const hasSingle = Boolean(params.agent && params.task);
			const hasParallel = (params.tasks?.length ?? 0) > 0;
			if (Number(hasSingle) + Number(hasParallel) !== 1) {
				return {
					content: [
						{
							type: "text",
							text: `Provide exactly one mode: { agent, task } or { tasks: [...] }.\n\nAvailable agents:\n${catalog()}`,
						},
					],
					details: { mode: "single", results: [], batchStartedAt } satisfies ToolDetails,
					isError: true,
				};
			}

			const makeDetails =
				(mode: "single" | "parallel") =>
				(results: RunResult[]): ToolDetails => ({ mode, results, batchStartedAt });

			if (hasParallel && params.tasks) {
				if (params.tasks.length > MAX_PARALLEL) {
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL}.`,
							},
						],
						details: makeDetails("parallel")([]),
						isError: true,
					};
				}

				const unknown = params.tasks.filter((t) => !byName.has(t.agent)).map((t) => t.agent);
				if (unknown.length > 0) {
					return {
						content: [
							{
								type: "text",
								text: `Unknown agent(s): ${[...new Set(unknown)].join(", ")}\n\nAvailable:\n${catalog()}`,
							},
						],
						details: makeDetails("parallel")([]),
						isError: true,
					};
				}

				const all: RunResult[] = params.tasks.map((t) =>
					emptyRun(t.agent, byName.get(t.agent)?.source ?? "unknown", t.task, batchStartedAt),
				);

				const emitParallel = () => {
					onUpdate?.({
						content: [{ type: "text", text: formatParallelProgress(all) }],
						details: makeDetails("parallel")(all.map((r) => ({ ...r }))),
					});
				};
				emitParallel();

				const results = await mapPool(params.tasks, MAX_PARALLEL, async (t, i) => {
					const agent = byName.get(t.agent)!;
					if (signal?.aborted) {
						const failed: RunResult = {
							...emptyRun(t.agent, agent.source, t.task, all[i].startedAt),
							exitCode: 1,
							stopReason: "aborted",
							errorMessage: "Subagent aborted before start",
							endedAt: nowMs(),
							lastEventAt: nowMs(),
						};
						all[i] = failed;
						emitParallel();
						return failed;
					}

					const result = await runAgent({
						cwd: t.cwd ?? ctx.cwd,
						agent,
						task: t.task,
						signal,
						seed: { startedAt: all[i].startedAt },
						invokeModel: t.model ?? params.model,
						invokeThinking: t.thinking ?? params.thinking,
						onUpdate: (partial) => {
							if (partial.details?.results[0]) {
								all[i] = partial.details.results[0];
								emitParallel();
							}
						},
						makeDetails: makeDetails("parallel"),
					});
					all[i] = result;
					emitParallel();
					return result;
				});

				const ok = results.filter((r) => !isFailed(r)).length;
				const failed = results.length - ok;
				const aborted = results.filter((r) => r.stopReason === "aborted").length;
				const wall = formatElapsed(nowMs() - batchStartedAt);
				const totals = formatUsage(sumUsage(results));

				const body = results
					.map((r) => {
						const dur = formatElapsed(runDurationMs(r));
						const status = isFailed(r)
							? `failed${r.stopReason ? ` (${r.stopReason})` : ""} · ${dur}`
							: `completed · ${dur}`;
						const usage = formatUsage(r.usage, r.model);
						return `### [${r.agent}] ${status}${usage ? ` · ${usage}` : ""}\n\n${truncate(getResultText(r))}`;
					})
					.join("\n\n---\n\n");

				const summary =
					aborted > 0
						? `Parallel: ${ok}/${results.length} succeeded, ${aborted} aborted · ${wall}`
						: failed > 0
							? `Parallel: ${ok}/${results.length} succeeded, ${failed} failed · ${wall}`
							: `Parallel: ${ok}/${results.length} succeeded · ${wall}`;

				return {
					content: [
						{
							type: "text",
							text: `${summary}${totals ? `\n${totals}` : ""}\n\n${body}`,
						},
					],
					details: makeDetails("parallel")(results),
					isError: ok < results.length,
				};
			}

			const agent = byName.get(params.agent!);
			if (!agent) {
				return {
					content: [
						{
							type: "text",
							text: `Unknown agent: "${params.agent}".\n\nAvailable:\n${catalog()}`,
						},
					],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			const result = await runAgent({
				cwd: params.cwd ?? ctx.cwd,
				agent,
				task: params.task!,
				signal,
				invokeModel: params.model,
				invokeThinking: params.thinking,
				onUpdate: (partial) => {
					const r = partial.details?.results[0];
					if (!r) {
						onUpdate?.(partial);
						return;
					}
					onUpdate?.({
						content: [{ type: "text", text: progressLine(r) }],
						details: partial.details,
					});
				},
				makeDetails: makeDetails("single"),
			});

			const failed = isFailed(result);
			const dur = formatElapsed(runDurationMs(result));
			const usage = formatUsage(result.usage, result.model);
			const meta = [dur, usage].filter(Boolean).join(" · ");
			const body = truncate(getResultText(result));

			return {
				content: [{ type: "text", text: meta ? `${body}\n\n— ${meta}` : body }],
				details: makeDetails("single")([result]),
				isError: failed,
			};
		},

		renderCall(args: any, theme: any) {
			if (args.tasks?.length) {
				let text =
					theme.fg("toolTitle", theme.bold("subagents ")) +
					theme.fg("accent", `parallel ×${args.tasks.length}`);
				for (const t of args.tasks.slice(0, 4)) {
					const preview = t.task.length > 50 ? `${t.task.slice(0, 50)}…` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)} ${theme.fg("dim", preview)}`;
				}
				if (args.tasks.length > 4) {
					text += `\n  ${theme.fg("muted", `… +${args.tasks.length - 4} more`)}`;
				}
				return new Text(text, 0, 0);
			}
			const name = args.agent || "…";
			const preview = args.task
				? args.task.length > 70
					? `${args.task.slice(0, 70)}…`
					: args.task
				: "…";
			return new Text(
				theme.fg("toolTitle", theme.bold("subagents ")) +
					theme.fg("accent", name) +
					`\n  ${theme.fg("dim", preview)}`,
				0,
				0,
			);
		},

		renderResult(result: any, { isPartial }: any, theme: any) {
			const details = result.details as ToolDetails | undefined;
			if (!details?.results?.length) {
				const c = result.content?.[0];
				return new Text(c?.type === "text" ? c.text : "(no output)", 0, 0);
			}

			const now = nowMs();

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const running = r.exitCode === -1 || isPartial;
				const failed = !running && isFailed(r);
				const icon = running
					? theme.fg("warning", "…")
					: failed
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");
				const elapsed = formatElapsed(runDurationMs(r, now));
				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))} ${theme.fg("dim", elapsed)}`;
				if (running) {
					text += `\n${theme.fg("dim", lastToolPreview(r.messages) || "running…")}`;
				} else {
					const out = getResultText(r);
					const lines = out.split("\n");
					text += `\n${theme.fg("toolOutput", lines.slice(0, 6).join("\n"))}`;
					if (lines.length > 6) text += `\n${theme.fg("muted", `(+${lines.length - 6} lines)`)}`;
					const usage = formatUsage(r.usage, r.model);
					if (usage) text += `\n${theme.fg("dim", usage)}`;
				}
				return new Text(text, 0, 0);
			}

			// parallel — compact list
			const running = details.results.filter((r) => r.exitCode === -1).length;
			const ok = details.results.filter((r) => r.exitCode !== -1 && !isFailed(r)).length;
			const wall = formatElapsed(
				now - (details.batchStartedAt || details.results[0]?.startedAt || now),
			);
			let text =
				theme.fg("toolTitle", theme.bold("parallel")) +
				theme.fg("accent", ` ${ok}/${details.results.length} · ${running} running · ${wall}`);
			for (const r of details.results) {
				const rRunning = r.exitCode === -1;
				const icon = rRunning
					? theme.fg("warning", "…")
					: isFailed(r)
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");
				text += `\n${icon} ${theme.fg("accent", r.agent)} ${theme.fg("dim", formatElapsed(runDurationMs(r, now)))}`;
				if (rRunning) {
					text += ` ${theme.fg("dim", lastToolPreview(r.messages) || "…")}`;
				}
			}
			return new Text(text, 0, 0);
		},
	};
}
