/**
 * 临时运行时类型 shim
 *
 * TODO: Round 5 由 Agent 3-E 接线时将这些类型下沉到 @crish/shared-types，
 * 届时删除此文件，被迁移文件的 import 改为从 @crish/shared-types 直接导入。
 *
 * 依据 02-FILE-MAPPING.md §2.2，SessionEntry / SessionHeader / SessionPersistenceStore
 * 等纯类型应下沉到 shared-types 以避免跨层引用。Round 3 阶段因类型下沉未完整覆盖
 * 这些 session 持久化类型，此文件作为过渡 shim 保持类型安全。
 *
 * 同理，ContextCompressionRuntimeOptions / ContextStateReader / ContextSummaryRequest
 * 等上下文域运行时类型也在此声明，避免 @ts-ignore 导致级联 any。
 *
 * 约束（ANTI_OVERENGINEERING_GUARDRAILS.md 禁令 23-26）：
 * - 此文件仅声明纯类型，不含运行时实现。
 * - 此文件不得被 agent-context 包外部引用（不通过 index.ts 导出）。
 * - Round 5 类型下沉完成后立即删除。
 */

import type {
  AgentMessage,
  AgentEvent,
  ContextCompressionRecord,
  ContextCompressionPolicyMetadata,
  ContextCompressionReason,
  ContextCompressionTrigger,
  JsonObject,
  RuntimeCheckpointRecord,
  ToolOutputBudgetRuntimeOptions,
} from '@crish/shared-types';

export interface SessionPersistenceStore {
  open(session: SessionHeader): Promise<void>;
  append(entry: SessionEntry): Promise<void>;
  readAll?(): Promise<SessionEntry[]>;
  /** 释放底层资源（如持久化文件句柄）。实现可选。运行结束时调用以确保资源不泄漏。 */
  close?(): Promise<void>;
}

export interface SessionMessageStoreOptions {
  maxShardMessages?: number;
  enableBranching?: boolean;
}

export interface SessionHeader {
  type: 'session';
  id: string;
  cwd: string;
  createdAt: string;
  version: 1;
}

export type SessionEntry =
  | {
      type: 'message';
      id: string;
      parentId: string | null;
      timestamp: string;
      message: AgentMessage;
    }
  | {
      type: 'event';
      id: string;
      parentId: string | null;
      timestamp: string;
      event: AgentEvent;
    }
  | {
      type: 'checkpoint';
      id: string;
      parentId: string | null;
      timestamp: string;
      label: string;
      metadata?: JsonObject;
    }
  | {
      type: 'compaction';
      id: string;
      parentId: string | null;
      timestamp: string;
      record: ContextCompressionRecord;
    }
  | {
      type: 'leaf-pointer';
      id: string;
      parentId: string | null;
      timestamp: string;
      targetLeafId: string | null;
      reason?: string;
      metadata?: JsonObject;
    };

// ─── 上下文压缩域运行时类型（迁移自 agent-runtime/src/types.ts） ───

export interface ContextCompressionRuntimeOptions {
  enabled?: boolean;
  contextWindowTokens: number;
  thresholdRatio?: number;
  thresholdTokens?: number;
  targetRecentRatio?: number;
  targetRecentTokens?: number;
  minRecentMessages?: number;
  maxSummaryTokens?: number;
  minMessagesToCompress?: number;
  summarizer: ContextSummarizer;
  contextState?: ContextStateReader;
  toolOutputBudget?: ToolOutputBudgetRuntimeOptions;
  includeThought?: boolean | undefined;
}

export interface ContextSummarizer {
  summarize(request: ContextSummaryRequest): Promise<string>;
}

export interface ContextSummaryRequest {
  trigger: ContextCompressionTrigger;
  reason: ContextCompressionReason;
  policy: ContextCompressionPolicyMetadata;
  handoffIntent: boolean;
  serializedConversation: string;
  previousSummary?: string;
  recentSuccessfulCommands: string[];
  recentFailedDiagnostics: string[];
  completedTaskSummaries: string[];
  pendingTasks: string[];
  sessionEvents: string[];
  fileSnapshotHints: string[];
  maxSummaryTokens: number;
}

export interface ContextStateSnapshot {
  completedTaskSummaries: string[];
  pendingTasks: string[];
  sessionEvents: string[];
  fileSnapshotHints: string[];
  previousCompressionSummary?: string | undefined;
}

export interface ContextStateReader {
  snapshotForCompression():
    Promise<ContextStateSnapshot> | ContextStateSnapshot;
  recordCompression?(record: ContextCompressionRecord): Promise<void> | void;
  recordCheckpoint?(checkpoint: RuntimeCheckpointRecord): Promise<void> | void;
}
