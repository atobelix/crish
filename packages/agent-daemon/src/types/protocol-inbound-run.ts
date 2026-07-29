import type { JsonObject, RunControlLevel } from "@crish/shared-types";
import type {
  ScopedContextRuntimeConfig,
} from "./entities.js";

/** cancel-run / run-control 终止模式（对齐 desktop L2/L3） */
export type CancelRunMode = "cooperative" | "force";

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
  /**
   * UI 用户消息 clientMessageId。若提供则用作 daemon user message id，
   * 与桌面乐观消息同 id upsert / hydrate 合并。
   */
  clientMessageId?: string;
  /**
   * UI 助手 placeholder clientMessageId。写入 run metadata，
   * 由 runtime enrich 到 assistant message-end，供 hydrate rekey。
   */
  assistantClientMessageId?: string;
}

export interface ApproveToolMessage {
  type: "approve-tool";
  toolCallId: string;
  scope?: "project" | "always";
}

export interface DenyToolMessage {
  type: "deny-tool";
  toolCallId: string;
  reason?: string;
}

export interface CancelRunMessage {
  type: "cancel-run";
  runId: string;
  /**
   * 取消模式：
   * - cooperative = L2 协作停（优先 ControlBus，不立刻 hard abort）
   * - force = L3 硬取消（默认，兼容旧客户端）
   * 旧端省略 mode 时等价 force。
   */
  mode?: CancelRunMode;
  reason?: string;
}

/**
 * Desktop run-control 一等消息（L0–L3）。
 * L2/L3 与 cancel-run.mode 对接；
 * L1 soft_inject：payload.kind=follow_up → pending after-current-run；
 *   kind=steer|soft_inject → steerRun（不 abort）。
 * @see apps/crish-desktop/src/api/runControlClient.ts
 */
export interface RunControlMessage {
  type: "run-control";
  level: RunControlLevel;
  runId?: string;
  sessionId?: string;
  reason?: string;
  payload?: JsonObject;
}

export interface StreamPauseMessage {
  type: "stream-pause";
  runId: string;
}

export interface StreamResumeMessage {
  type: "stream-resume";
  runId: string;
}
