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

/** 协作 agent 落盘上限 */
export const SESSION_AGENTS_SAVE_CAP = 40;

/** 使用 Worker 序列化的阈值（消息条数） */
const WORKER_BATCH_THRESHOLD = 200;

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
