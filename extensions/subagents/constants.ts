import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const MAX_PARALLEL = 4;
export const MAX_OUTPUT_CHARS = 40_000;
export const MAX_STDERR_CHARS = 20_000;
export const LARGE_TASK_CHARS = 8_000;
export const QUIET_HINT_MS = 15_000;

export const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
export const BUNDLED_AGENTS_DIR = path.join(EXTENSION_DIR, "agents");
export const USER_AGENTS_DIR = path.join(getAgentDir(), "agents");
