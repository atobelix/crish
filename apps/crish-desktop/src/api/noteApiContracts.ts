/**
 * 前端笔记 API 契约（Round6–8 · dual-engine-surface §5 / §8 B-05…B-09）
 *
 * noteApi 拆分后子模块 ①：命令名常量 + 线格式类型 + NoteTransport 契约。
 * 本文件无运行时依赖，可被 wire / memory 子模块与主 barrel（noteApi.ts）共享。
 * snake_case 投影 / 响应解析见 `noteApiWire.ts`；Memory 通路见 `noteApiMemory.ts`。
 */

// ---------------------------------------------------------------------------
// 命令名常量（前端 IPC / 可与 agent-tools 工具名对照）
// ---------------------------------------------------------------------------

/** Tauri / 前端 IPC：事务化 apply MD 片段 */
export const NOTE_CMD_DOCUMENT_APPLY_MD = 'note_document_apply_md' as const;
/** Tauri / 前端 IPC：组合查询块摘要 */
export const NOTE_CMD_QUERY_BLOCKS = 'note_query_blocks' as const;
/** Tauri / 前端 IPC：显式 send_to_note Intent 写路径 */
export const NOTE_CMD_SEND_TO_NOTE = 'note_send_to_note' as const;
/**
 * Tauri / 前端 IPC：文档 hydrate 投影（open/load 形状）。
 * 契约实现见 `noteHydrateIpc.ts`；产品 Strict 默认经
 * `createProductStrictHydrateTransport`：可检测 Tauri → 本命令；无 Tauri → fixture。
 * **≠ 打开完成**；**≠ EL**；**DocSession 全链若未满须诚实**。
 */
export const NOTE_CMD_DOCUMENT_HYDRATE = 'note_document_hydrate' as const;
/**
 * Tauri：detect 镜像漂移（A-INV-02 / W2-E · CONN-E）。
 * 契约实现见 `noteMirrorIpc.ts`；**≠ EL-03**；**≠ inotify 满关**。
 */
export const NOTE_CMD_DETECT_MIRROR_DRIFT = 'note_detect_mirror_drift' as const;
/**
 * Tauri：import 镜像提案（不 apply；X-05 禁静默盖 unpushed）。
 * 契约实现见 `noteMirrorIpc.ts`。
 */
export const NOTE_CMD_IMPORT_MIRROR_PROPOSAL =
  'note_import_mirror_proposal' as const;
/**
 * Tauri：collab wire JSON → DocSession::apply（CONN-B3 产品写锥）。
 * 契约实现见 `noteApplyOpsIpc.ts`；产品默认经 `resolveProductStrictApplyOps`。
 * **≠ EL-01**；无 Tauri → 不装配（只读）。
 */
export const NOTE_CMD_APPLY_OPS = 'note_apply_ops' as const;

/** agent-tools 工具名（对照，非 IPC 命令） */
export const NOTE_TOOL_DOCUMENT_APPLY_MD = 'document_apply_md' as const;
export const NOTE_TOOL_QUERY_BLOCKS = 'query_blocks' as const;
export const NOTE_TOOL_SEND_TO_NOTE = 'send_to_note' as const;

export const NOTE_COMMANDS = {
  documentApplyMd: NOTE_CMD_DOCUMENT_APPLY_MD,
  queryBlocks: NOTE_CMD_QUERY_BLOCKS,
  sendToNote: NOTE_CMD_SEND_TO_NOTE,
  documentHydrate: NOTE_CMD_DOCUMENT_HYDRATE,
  detectMirrorDrift: NOTE_CMD_DETECT_MIRROR_DRIFT,
  importMirrorProposal: NOTE_CMD_IMPORT_MIRROR_PROPOSAL,
  applyOps: NOTE_CMD_APPLY_OPS,
} as const;

// ---------------------------------------------------------------------------
// 线格式类型（前端 camelCase；invoke 时再 snake_case 投影）
// ---------------------------------------------------------------------------

export type NoteApplyMode =
  'apply_md_fragment' | 'insert_blocks' | 'append_to_block';

export type NoteAttrValue = string | number | boolean | null;

/** apply_md / document_apply_md 请求 */
export type NoteApplyMdRequest = {
  docId: string;
  markdown: string;
  parentId?: string;
  afterBlockId?: string;
  mode?: NoteApplyMode;
  /** 幂等键（send_to_note 的 intentId；document_apply_md 可选） */
  intentId?: string;
  batchId?: string;
  messageId?: string;
  origin?: 'user' | 'agent';
};

/** apply 成功结果 */
export type NoteApplyMdResult = {
  ok: true;
  blockIds: string[];
  /** 本次实际新插入块数（幂等 hit 时为 0） */
  inserted: number;
  /** 是否命中幂等缓存 */
  idempotent: boolean;
};

/** apply / send 失败 */
export type NoteApplyMdFailure = {
  ok: false;
  code: string;
  reason: string;
};

export type NoteApplyMdOutcome = NoteApplyMdResult | NoteApplyMdFailure;

/** query_blocks 入参 */
export type NoteQueryBlocksParams = {
  docId: string;
  kindIn?: string[];
  attrsEq?: Record<string, NoteAttrValue>;
  textMatch?: string;
  refTo?: string;
  refFrom?: string;
  /** 默认 50，硬上限 200 */
  limit?: number;
};

/** 单条命中块摘要 */
export type NoteQueryBlockHit = {
  id: string;
  kind: string;
  /** 检索摘要片段，非权威全文 */
  snippet: string;
  attrs: Record<string, NoteAttrValue>;
};

/** query_blocks 出参 */
export type NoteQueryBlocksResult = {
  ok: true;
  blocks: NoteQueryBlockHit[];
  truncated: boolean;
};

export type NoteQueryBlocksFailure = {
  ok: false;
  code: string;
  reason: string;
};

export type NoteQueryBlocksOutcome =
  NoteQueryBlocksResult | NoteQueryBlocksFailure;

/** send_to_note 请求（对齐 Intent 字段，camelCase） */
export type NoteSendToNoteRequest = {
  intentId: string;
  markdown: string;
  docId: string;
  messageId?: string;
  parentId?: string;
  afterBlockId?: string;
  mode?: NoteApplyMode;
  origin?: 'user' | 'agent';
  batchId?: string;
};

// ---------------------------------------------------------------------------
// Transport 契约
// ---------------------------------------------------------------------------

/**
 * 笔记读写通路。产品可注入 Tauri / Memory / 自定义 mock。
 * 失败返回 Result（ok:false），不抛半写态。
 */
export type NoteTransport = {
  applyMd(req: NoteApplyMdRequest): Promise<NoteApplyMdOutcome>;
  queryBlocks(params: NoteQueryBlocksParams): Promise<NoteQueryBlocksOutcome>;
  sendToNote(req: NoteSendToNoteRequest): Promise<NoteApplyMdOutcome>;
};
