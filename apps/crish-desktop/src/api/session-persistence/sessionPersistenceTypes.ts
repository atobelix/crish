/**
 * 会话持久化类型与常量契约
 */

export const SESSION_INDEX_KEY = 'crish_session_index_v1';
export const SESSION_BODY_PREFIX = 'crish_session_body_v1:';
export const SESSION_AGENTS_PREFIX = 'crish_session_agents_v1:';
export const SESSION_ACTIVE_KEY = 'crish_active_session_v1';
export const SESSION_FOLDER_KEY = 'crish_folder_order_v1';

/** 缺省文件夹（与 createSession / disk mirror 对齐） */
export const DEFAULT_SESSION_FOLDER = '常规会话';

/**
 * 协作 agent 落盘软上限（P18 修复后语义重定义）。
 * - 该值不再对 SQLite 主路径生效：save_session_agents 全量保存（Rust 侧无数量
 *   上限），第 41 个起的子代理不再静默丢失；
 * - 该值仍是 localStorage 配额保护线（localStorage 体积物理受限，镜像仍
 *   slice；截断标志已随 sessionAgentsTruncation 删除，Wave C D-F03）与
 *   「软提示」阈值（超过后写 session_meta 记录 agents_over_cap:<id>）。
 */
export const SESSION_AGENTS_SAVE_CAP = 40;

/** session_meta 中「会话子代理超过软上限」留痕 key 前缀（P18 数据面） */
export const SESSION_AGENTS_OVER_CAP_META_PREFIX = 'agents_over_cap:';

/**
 * 子代理超软上限事实记录（P18 留痕，供数据面提示与审计）。
 * session_meta（agents_over_cap:<id>）：SQLite 主路径全量落盘但超过软上限
 * 时的提示性记录（saved = total，无丢失）。
 * Wave C（D-F03）后不再用于 LS 截断标志（crish_agents_truncated_* 已绝迹）。
 */
export type AgentsTruncationRecord = {
  /** 当时生效的软上限 */
  cap: number;
  /** 会话内子代理总数（内存态） */
  total: number;
  /** 实际落盘条数（SQLite 主路径 = total） */
  saved: number;
  /** 留痕时间戳（epoch ms） */
  at: number;
};

/** 索引侧外部导入溯源（与 SessionState.importMeta 对齐，可选） */
export type SessionIndexImportMeta = {
  source: 'claude-code' | 'codex';
  sourceSessionId: string;
  sourcePath?: string;
  importedAt?: string;
};

export type SessionIndexEntry = {
  id: string;
  title: string;
  folder: string;
  isPinned: boolean;
  isArchived: boolean;
  branchParentId?: string;
  timestamp: string;
  updatedAt: number;
  messageCount: number;
  /** 固定消息 id 列表 */
  pinnedMessageIds?: string[];
  /** H2/H3：引擎游标与 run 关联 */
  engineCursor?: number;
  engineLastRunId?: string;
  hydratedFromEngine?: boolean;
  /** 外部导入溯源（软去重）；可选，避免 schema 膨胀 */
  importMeta?: SessionIndexImportMeta;
};
