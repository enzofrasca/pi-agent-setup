import type { Message } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
	source: "bundled" | "user";
	filePath: string;
}

export interface ResolvedModel {
	model?: string;
	thinking?: string;
	source: "invoke" | "frontmatter" | "inherit";
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface RunResult {
	agent: string;
	source: AgentConfig["source"] | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	thinking?: string;
	modelSource?: ResolvedModel["source"];
	stopReason?: string;
	errorMessage?: string;
	startedAt: number;
	lastEventAt: number;
	endedAt?: number;
}

export interface ToolDetails {
	mode: "single" | "parallel";
	results: RunResult[];
	batchStartedAt: number;
}

export type OnUpdate = (partial: AgentToolResult<ToolDetails>) => void;
