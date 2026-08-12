/**
 * hydrate 投影 / transport 类型（SD-24 切开 · types）
 *
 * 只读投影形状；**≠** 打开完成；**≠ EL-01/04/08**。
 * `source` 与 `hydratePath` 分轨：fixture 不得写 `source:'tauri-ipc'`。
 */

/**
 * 单块投影（对齐 round-D / BlockProjection 子集）。
 * 呈现层只读；不得当写权威。
 */
export type HydratedBlockProjection = {
  id: string;
  flavour: string;
  parentId?: string;
  /** 兄弟序（0-based） */
  index: number;
  props?: Record<string, unknown>;
  /** 文本切片摘要（非 yrs 句柄） */
  text?: string;
};

/**
 * 文档级 hydrate 投影（成功态）。
 * `source` 标明数据来源，禁止 fixture 静默伪装成 tauri-ipc。
 */
export type DocHydrateProjection = {
  docId: string;
  /** 单调 rev（投影版本；非必须等于 RS rev 产品语义） */
  rev: number;
  blocks: HydratedBlockProjection[];
  /**
   * 来源：
   * - `fixture`：测试 / 无 Tauri 演示注入（**≠ 生产权威**）
   * - `note-transport`：经 NoteTransport.queryBlocks 映射
   * - `tauri-ipc`：专用 `note_document_hydrate`（可检测 Tauri 时产品默认 IPC 通道）；
   *     数据面见后端 `hydrate_path`（`doc-session` | `query-blocks`）
   *     **≠** 产品「打开完成」（G-HYD 全条件）；**≠ EL-04/01**
   */
  source: 'fixture' | 'note-transport' | 'tauri-ipc';
  /**
   * 后端数据面分轨（仅 tauri-ipc 成功时可能有）：
   * - `doc-session`：真 DocSession::hydrate + CDCS 树
   * - `query-blocks`：query 派生索引（对照轨）
   * 缺省 / 非 IPC：undefined
   */
  hydratePath?: 'doc-session' | 'query-blocks';
};

export type NoteHydrateSuccess = {
  ok: true;
  projection: DocHydrateProjection;
};

export type NoteHydrateFailure = {
  ok: false;
  code: string;
  reason: string;
};

export type NoteHydrateOutcome = NoteHydrateSuccess | NoteHydrateFailure;

/**
 * Strict 轨 hydrate 通路（可注入）。
 * 产品 IPC 未就绪时：注入 fixture / adapt(NoteTransport) 即可测三态。
 */
export type NoteHydrateTransport = {
  /**
   * 加载 doc 的 hydrate 后投影。
   * 失败返回 ok:false（不抛半态）；成功返回完整投影。
   */
  hydrate(docId: string): Promise<NoteHydrateOutcome>;
};

export type FixtureHydrateDoc = {
  rev?: number;
  blocks: HydratedBlockProjection[];
};
