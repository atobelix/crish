import type { JsonObject } from "@crish/shared-types";
import type {
  ScopedContextRuntimeConfig,
} from "./entities.js";

export type RunTaskContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string; detail?: string };
      name?: string;
      mime?: string;
    }
  | JsonObject;

export interface RunTaskMessage {
  type: "run-task";
  runId: string;
  sessionId?: string;
  prompt: string;
  mode?: string;
  workspaceMode?: "project" | "none";
  cwd?: string;
  visibleGoal?: string;
  budgetDifficulty?: string;
  runTokenBudget?: number;
  maxRounds?: number;
  maxStalledRounds?: number;
  backgroundDrainTimeoutMs?: number;
  permissionMode?: "ask" | "auto" | "full-access" | "plan" | "unattended";
  workspaceRoot?: string;
  projectRoot?: string;
  projectMarkers?: string[];
  projectFiles?: string[];
  projectTags?: string[];
  packageNames?: string[];
  mcpDisabledTools?: Record<string, string[]>;
  scopedContextConfig?: ScopedContextRuntimeConfig;
  content?: RunTaskContentPart[];
  hasImages?: boolean;
  attachments?: Array<
    { name?: string; mime?: string; kind?: string } & JsonObject
  >;
  systemPrompt?: string;
}

export interface ApproveToolMessage {
  type: "approve-tool";
  toolCallId: string;
  scope?: "project" | "always";
}

export interface DenyToolMessage {
  type: "deny-tool";
  toolCallId: string;
}

export interface CancelRunMessage {
  type: "cancel-run";
  runId: string;
}

export interface StreamPauseMessage {
  type: "stream-pause";
  runId: string;
}

export interface StreamResumeMessage {
  type: "stream-resume";
  runId: string;
}
