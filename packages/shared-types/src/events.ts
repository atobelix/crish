import type { AgentMessage, AgentMessageBlock } from './message';
import type {
  ToolBatchCall,
  ToolBatchResult,
  ToolProgressUpdate,
  ProviderDiagnostic,
  ContextCompressionRecord,
  RuntimeCheckpointRecord,
  RuntimeCheckpointRestoreRecord,
} from './tool';
import type { PermissionRequest } from './permissions';
// F8-09/F8-10：手写类型收敛到生成 schema（杜绝双源漂移）——
// AgentEndReason 含 stopped（Rust AgentEndReason::Stopped 已存在）、
// ApprovalDecision 三值（approved/denied/expired）
import type { AgentEndReason, ApprovalDecision } from './generated/engine/types';

export type AgentDomainEvent =
  | { type: 'agent-start'; sessionId: string; timestamp: string }
  | {
      type: 'agent-end';
      sessionId: string;
      timestamp: string;
      reason: AgentEndReason;
      error?: string;
    };

export type TurnDomainEvent =
  | {
      type: 'turn-start';
      sessionId: string;
      turnIndex: number;
      timestamp: string;
    }
  | {
      type: 'turn-end';
      sessionId: string;
      turnIndex: number;
      timestamp: string;
      toolCallCount: number;
    };

export type MessageDomainEvent =
  | { type: 'message-start'; sessionId: string; message: AgentMessage }
  | {
      type: 'message-delta';
      sessionId: string;
      timestamp: string;
      messageId: string;
      block: AgentMessageBlock;
    }
  | { type: 'message-end'; sessionId: string; message: AgentMessage };

export type ToolDomainEvent =
  | {
      type: 'tool-start';
      sessionId: string;
      batchId: string;
      call: ToolBatchCall;
      timestamp: string;
    }
  | {
      type: 'tool-update';
      sessionId: string;
      batchId: string;
      toolCallId: string;
      update: ToolProgressUpdate;
      timestamp: string;
    }
  | {
      type: 'tool-end';
      sessionId: string;
      batchId: string;
      result: ToolBatchResult;
      timestamp: string;
    }
  | {
      type: 'tool-batch-start';
      sessionId: string;
      batchId: string;
      timestamp: string;
      summary: string;
      calls: ToolBatchCall[];
    }
  | {
      type: 'tool-batch-end';
      sessionId: string;
      batchId: string;
      timestamp: string;
      calls: ToolBatchResult[];
    }
  | {
      type: 'tool-input-repaired';
      sessionId: string;
      timestamp: string;
      toolCallId: string;
      toolName: string;
      notes: string[];
    };

export type CompressionDomainEvent =
  | {
      type: 'context-compression-start';
      sessionId: string;
      timestamp: string;
      reason: string;
      tokensBefore: number;
    }
  | {
      type: 'context-compression-end';
      sessionId: string;
      timestamp: string;
      result?: ContextCompressionRecord;
      aborted: boolean;
      error?: string;
    };

export type DiagnosticDomainEvent =
  | {
      type: 'provider-diagnostic';
      sessionId: string;
      timestamp: string;
      diagnostic: ProviderDiagnostic;
    }
  | {
      type: 'runtime-error';
      sessionId: string;
      timestamp: string;
      error: string;
      retryable?: boolean;
    }
  | {
      type: 'runtime-steering';
      sessionId: string;
      timestamp: string;
      reason: string;
      message: AgentMessage;
    }
  | {
      type: 'runtime-intervention-required';
      sessionId: string;
      timestamp: string;
      reason: string;
      choices: string[];
      message: string;
    }
  | {
      type: 'approval-requested';
      sessionId: string;
      request: PermissionRequest;
      timestamp: string;
    }
  | {
      type: 'approval-resolved';
      sessionId: string;
      // F8-10：wire 契约以生成 schema 为准——toolCallId 必填（审批键控），
      // requestId 可选（历史帧别名）；decision 为字符串三值而非对象形态
      toolCallId: string;
      requestId?: string;
      decision: ApprovalDecision;
      timestamp: string;
    }
  | {
      type: 'checkpoint-created';
      sessionId: string;
      timestamp: string;
      checkpoint: RuntimeCheckpointRecord;
    }
  | {
      type: 'checkpoint-restored';
      sessionId: string;
      timestamp: string;
      restore: RuntimeCheckpointRestoreRecord;
    }
  | {
      type: 'run-terminal';
      sessionId: string;
      runId: string;
      timestamp: string;
      terminal: 'completed' | 'cancelled' | 'failed';
      error?: string;
    };

// ── 缓存测量域（P5 S3 §3.1.3 新增；仅测量展示，不干预循环）──

/** 缓存 miss 归因分类（8 类，wire kebab-case；对齐 Rust `MissAttribution`） */
export type MissAttribution =
  | 'model-switch'
  | 'compaction'
  | 'prefix-changed'
  | 'idle-ttl-expired'
  | 'cold'
  | 'zero-read'
  | 'low-read'
  | 'unknown';

/**
 * run 级缓存统计（对齐 Rust `RunCacheStats`，字段 camelCase）。
 * 计数类字段缺失视为 0（聚合无贡献）；比例/时间类字段
 * `undefined`/`null` = 未上报（区别于 0，前端隐藏而非显示 0%，
 * 与 P6 R4 口径一致）。
 */
export interface RunCacheStats {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheMissTokens?: number;
  sampleCount?: number;
  /** 命中率 = cacheRead / inputTotal；null = 未上报（隐藏） */
  hitRatio?: number;
  /** 写入占比 = cacheWrite / inputTotal；null = 未上报 */
  writeRatio?: number;
  /** 本 run 审计出的浪费量（detectMiss 累计） */
  missedTokens?: number;
  /** 缓存温暖截止（now + TTL）；null = 无 TTL 数据（跳过冷缓存提示） */
  warmUntilMs?: number;
}

/** run 收口时发出的会话级缓存统计快照（runId 由信封注入，wire 扁平化后与信封值一致） */
export interface CacheStatsUpdated {
  type: 'cache-stats-updated';
  sessionId: string;
  /** 信封注入值（Rust 事件体不占此字段；老帧可缺失） */
  runId?: string;
  timestamp: string;
  stats: RunCacheStats;
}

/** 缓存浪费审计命中（阈值：missedTokens ≥ 20000 或 missedCostUsd ≥ $0.1 才发射） */
export interface CacheWasteAlert {
  type: 'cache-waste-alert';
  sessionId: string;
  runId?: string;
  timestamp: string;
  /** 归因分类（8 类 kebab-case；未知值宽容兜底 unknown） */
  attribution: MissAttribution;
  missedTokens?: number;
  idleMs?: number;
  modelChanged?: boolean;
  /** 预估浪费金额（USD）；null = 无价格数据未上报 */
  missedCostUsd?: number;
}

/** 冷缓存预警（Rust 只在 run 启动、cold_cache_check 命中时发一次；空闲提示由前端 tick 驱动） */
export interface ColdCacheWarning {
  type: 'cold-cache-warning';
  sessionId: string;
  runId?: string;
  timestamp: string;
  ttlSeconds?: number;
  idleMs?: number;
  /** 预估重发 token = 上次请求 input_total */
  resendEstimateTokens?: number;
}

export type CacheDomainEvent =
  CacheStatsUpdated | CacheWasteAlert | ColdCacheWarning;

export type AgentEvent =
  | AgentDomainEvent
  | TurnDomainEvent
  | MessageDomainEvent
  | ToolDomainEvent
  | CompressionDomainEvent
  | DiagnosticDomainEvent
  | CacheDomainEvent;
