/**
 * DocSession hydrate 后投影形状 + 可注入 hydrate transport（W5-B Strict · B-09）
 *
 * ## 形状纪律
 * - 本文件定义的是 **hydrate 成功后的只读投影**（对齐 BlockProjection 子集：
 *   id / flavour / parentId / index / props / text），**不是** `createSilentFixture`
 *   静默假段落。
 * - 投影 ≠ 文档权威；写路径仍须经 Intent / NoteTransport.apply*（本模块只读）。
 *
 * ## 诚实边界（强制）
 * - **可演示 ≠ EL-01 / EL-08**；**≠ W5-C 隔离全关**；挂载冒充交付 = S5
 * - 产品 IPC 默认「打开文档完成」叙事依赖 W1-H；本 adapter **不**宣称 W1-H 已关
 * - `createFixtureHydrateTransport` = 可测 / 演示 Strict 方向子集；`source: 'fixture'`
 *   —— **fixture ≠ 生产权威**；禁止 fixture 伪装 `tauri-ipc`
 * - `adaptNoteTransportAsHydrate` = 把已有 `note_query_blocks` 形状映射为投影
 *   （Tauri / Memory 皆可注入）；**不等于** DocSession::hydrate 产品全链路完成
 * - `adaptNoteHydrateIpcAsTransport` = 专用 `note_document_hydrate` IPC →
 *   source=`tauri-ipc`
 * - **产品 Strict 默认**（`createProductStrictHydrateTransport`）：
 *   可检测 Tauri → `tauri-ipc`；无 Tauri → 仍 `fixture`
 *   —— **≠ 打开完成**；**≠ EL**；后端经 query 投影派生，**DocSession 全链未满**
 *
 * ## 禁止
 * - import 行级 EditorStore / lines[] 权威
 * - 用静默假段落冒充 hydrate 投影
 * - fixture 响应写 `source:'tauri-ipc'` 骗测
 */

import {
  createTauriNoteHydrateIpc,
  type NoteHydrateIpc,
  type NoteHydrateIpcSuccess,
} from '../../api/noteHydrateIpc';
import {
  isNoteTauriRuntime,
  type NoteQueryBlockHit,
  type NoteTransport,
} from '../../api/noteApi';

// ---------------------------------------------------------------------------
// 投影形状（hydrate 后 · 只读）
// ---------------------------------------------------------------------------

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
   * - `tauri-ipc`：专用 `note_document_hydrate`（可检测 Tauri 时产品默认）；
   *     **≠** DocSession::hydrate 全链 / 打开完成 / EL
   */
  source: 'fixture' | 'note-transport' | 'tauri-ipc';
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

// ---------------------------------------------------------------------------
// Fixture transport（Strict 可测子集 · source=fixture）
// ---------------------------------------------------------------------------

export type FixtureHydrateDoc = {
  rev?: number;
  blocks: HydratedBlockProjection[];
};

/**
 * 可注入的 hydrate fixture transport。
 * 形状必须是「hydrate 后投影」，禁止调用方塞静默假段落却标 source=tauri-ipc。
 */
export function createFixtureHydrateTransport(
  docs: Record<string, FixtureHydrateDoc> = {}
): NoteHydrateTransport & {
  seed(docId: string, doc: FixtureHydrateDoc): void;
  clear(): void;
  /** 下次 hydrate 强制失败（测错误态） */
  setNextError(err: { code: string; reason: string } | null): void;
  /** 延迟 ms（测加载态）；0 = 同步 resolve */
  setDelayMs(ms: number): void;
} {
  const store = new Map<string, FixtureHydrateDoc>();
  for (const [id, doc] of Object.entries(docs)) {
    store.set(id, doc);
  }
  let nextError: { code: string; reason: string } | null = null;
  let delayMs = 0;

  const wait = (): Promise<void> =>
    delayMs > 0
      ? new Promise((r) => {
          setTimeout(r, delayMs);
        })
      : Promise.resolve();

  return {
    seed(docId, doc) {
      store.set(docId, doc);
    },
    clear() {
      store.clear();
      nextError = null;
      delayMs = 0;
    },
    setNextError(err) {
      nextError = err;
    },
    setDelayMs(ms) {
      delayMs = Math.max(0, ms);
    },
    async hydrate(docId) {
      await wait();
      if (nextError) {
        const err = nextError;
        nextError = null;
        return { ok: false, code: err.code, reason: err.reason };
      }
      const doc = store.get(docId);
      if (!doc) {
        // 空文档也是合法 hydrate 成功（空投影），与「文档不存在」区分：
        // fixture 未 seed → 当作空成功投影（可测 empty）；若需 missing 用 setNextError
        return {
          ok: true,
          projection: {
            docId,
            rev: 0,
            blocks: [],
            source: 'fixture',
          },
        };
      }
      return {
        ok: true,
        projection: {
          docId,
          rev: doc.rev ?? 1,
          blocks: doc.blocks.map((b, i) => ({
            ...b,
            index: b.index ?? i,
          })),
          source: 'fixture',
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// NoteTransport → hydrate 投影适配（已有 note_* / Memory）
// ---------------------------------------------------------------------------

/**
 * 将 `NoteQueryBlockHit` 映射为 hydrate 后块投影。
 * query 摘要 ≠ 全文权威；仅作 Strict 读路径演示形状。
 */
export function mapQueryHitToProjection(
  hit: NoteQueryBlockHit,
  index: number
): HydratedBlockProjection {
  const level =
    typeof hit.attrs.level === 'number' ? hit.attrs.level : undefined;
  return {
    id: hit.id,
    flavour: hit.kind || 'paragraph',
    index,
    props: {
      ...hit.attrs,
      ...(level !== undefined ? { level } : {}),
    },
    text: hit.snippet,
  };
}

/**
 * 适配已有 NoteTransport.queryBlocks → NoteHydrateTransport。
 *
 * 诚实边界：
 * - 这是 **query 投影适配**，不是 `DocSession::hydrate` 产品命令本身
 * - source 固定 `note-transport`（即使底层是 Tauri note_query_blocks）
 * - **不**宣称「打开文档完成」/ W1-H 关闭
 */
export function adaptNoteTransportAsHydrate(
  transport: NoteTransport,
  options: { rev?: number } = {}
): NoteHydrateTransport {
  const baseRev = options.rev ?? 1;
  return {
    async hydrate(docId) {
      const res = await transport.queryBlocks({ docId, limit: 200 });
      if (!res.ok) {
        return {
          ok: false,
          code: res.code,
          reason: res.reason,
        };
      }
      return {
        ok: true,
        projection: {
          docId,
          rev: baseRev,
          blocks: res.blocks.map((b, i) => mapQueryHitToProjection(b, i)),
          source: 'note-transport',
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// NoteHydrateIpc → hydrate 投影（专用 note_document_hydrate · source=tauri-ipc）
// ---------------------------------------------------------------------------

/**
 * 适配专用 hydrate IPC → NoteHydrateTransport。
 *
 * 诚实边界：
 * - 成功投影 source 固定 `tauri-ipc`（与 query 适配的 `note-transport` 分轨）
 * - 产品默认经 `createProductStrictHydrateTransport` 在 Tauri 环境选用本 adapter
 * - **不**宣称「打开文档完成」/ W1-H / EL 关闭
 * - 后端 `note_document_hydrate` 现为 query 投影派生，**≠ DocSession 全链**
 */
export function adaptNoteHydrateIpcAsTransport(
  ipc: NoteHydrateIpc
): NoteHydrateTransport {
  return {
    async hydrate(docId) {
      const out = await ipc.hydrateDocument({ docId });
      if (!out.ok) {
        return { ok: false, code: out.code, reason: out.reason };
      }
      return {
        ok: true,
        projection: mapHydrateIpcSuccessToProjection(out),
      };
    },
  };
}

/** IPC 成功载荷 → DocHydrateProjection（source 钉死 tauri-ipc） */
export function mapHydrateIpcSuccessToProjection(
  ok: NoteHydrateIpcSuccess
): DocHydrateProjection {
  return {
    docId: ok.docId,
    rev: ok.rev,
    blocks: ok.blocks.map((b, i) => ({
      id: b.id,
      flavour: b.flavour || 'paragraph',
      parentId: b.parentId,
      index: typeof b.index === 'number' ? b.index : i,
      props: b.props,
      text: b.text,
    })),
    source: 'tauri-ipc',
  };
}

/**
 * 构造一条合法的 hydrate 投影块（测试夹具辅助）。
 * 保证带 index / flavour，避免静默假段落形状漂移。
 */
export function makeHydratedBlock(
  partial: Omit<HydratedBlockProjection, 'index'> & { index?: number }
): HydratedBlockProjection {
  return {
    id: partial.id,
    flavour: partial.flavour,
    parentId: partial.parentId,
    index: partial.index ?? 0,
    props: partial.props,
    text: partial.text,
  };
}

// ---------------------------------------------------------------------------
// 产品空态 Strict 演示 fixture（无 Tauri 回退 · ≠ 生产权威）
// ---------------------------------------------------------------------------

/**
 * 无 Tauri / 显式演示用 fixture hydrate 通路（source=`fixture`）。
 *
 * 诚实边界（钉死）：
 * - **fixture ≠ 生产权威**；DOM / 投影 `source` 必须为 `fixture`，禁止伪装 `tauri-ipc`
 * - **可演示 ≠ EL-01 / EL-08**；挂载冒充交付 = S5
 * - **≠ 打开完成**；**≠** `DocSession::hydrate` 全链
 * - 产品默认见 `createProductStrictHydrateTransport`（Tauri → tauri-ipc）
 */
export function createEmptyStateStrictDemoTransport(
  docId: string
): NoteHydrateTransport {
  return createFixtureHydrateTransport({
    [docId]: {
      rev: 1,
      blocks: [
        makeHydratedBlock({
          id: 'empty-strict-h1',
          flavour: 'heading',
          text: '笔记纸面 Strict 演示',
          index: 0,
          props: { level: 1 },
        }),
        makeHydratedBlock({
          id: 'empty-strict-p1',
          flavour: 'paragraph',
          text: '可演示 ≠ EL-01/EL-08 · ≠ 打开完成 · fixture ≠ 生产权威',
          index: 1,
        }),
        makeHydratedBlock({
          id: 'empty-strict-p2',
          flavour: 'paragraph',
          text: '与 W5-B-S Skeleton 预览壳分轨并存；本投影为 hydrate 形状。',
          index: 2,
        }),
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// 产品 Strict 默认 hydrate 通路（可检测 Tauri → tauri-ipc · 否则 fixture）
// ---------------------------------------------------------------------------

/**
 * 产品 Strict 空态选用的 hydrate 来源。
 * - `tauri-ipc`：可检测 Tauri 运行时，走 `note_document_hydrate`
 * - `fixture`：无 Tauri（单测 / 纯浏览器），保留演示轨
 */
export type ProductStrictHydrateSource = 'tauri-ipc' | 'fixture';

export type ResolveProductStrictHydrateSourceOptions = {
  /**
   * 覆盖运行时探测（单测注入）。
   * 未传时使用 `isNoteTauriRuntime()`（`__TAURI__` / `__TAURI_INTERNALS__` / `isTauri`）。
   */
  isTauriRuntime?: boolean;
};

/**
 * 解析产品 Strict 默认 hydrate 来源（纯选择逻辑，可单测）。
 *
 * 纪律：
 * - **禁止** 无 Tauri 时返回 tauri-ipc（否则 fixture 伪装）
 * - **禁止** 用 fixture 响应字符串冒充 ipc source
 * - 选择 tauri-ipc **≠** 打开完成 / **≠** EL / **≠** DocSession 全链已满
 */
export function resolveProductStrictHydrateSource(
  options: ResolveProductStrictHydrateSourceOptions = {}
): ProductStrictHydrateSource {
  const tauri =
    options.isTauriRuntime !== undefined
      ? options.isTauriRuntime
      : isNoteTauriRuntime();
  return tauri ? 'tauri-ipc' : 'fixture';
}

export type CreateProductStrictHydrateTransportOptions =
  ResolveProductStrictHydrateSourceOptions & {
    /**
     * 注入 hydrate IPC（测 mock / 自定义后端）。
     * 仅当解析结果为 `tauri-ipc` 时使用；未传则 `createTauriNoteHydrateIpc()`。
     */
    hydrateIpc?: NoteHydrateIpc;
  };

/**
 * 工作区空态打开 Strict 面板时的 **产品默认** hydrate 通路。
 *
 * | 环境 | 默认 source | transport |
 * |------|-------------|---------|
 * | 可检测 Tauri | `tauri-ipc` | `adaptNoteHydrateIpcAsTransport(createTauriNoteHydrateIpc())` |
 * | 无 Tauri | `fixture` | `createEmptyStateStrictDemoTransport(docId)` |
 *
 * 诚实边界（钉死 · R10）：
 * - **fixture ≠ 生产权威**；无 Tauri 回退 fixture **不是** 伪装 ipc
 * - 有 Tauri 时失败/空/成功走真 IPC 三态，**不**静默回退 fixture
 * - **≠ 打开完成**；**≠ EL-01/EL-08**；后端 hydrate 命令现为 query 投影派生，
 *   **DocSession::hydrate 全链若未满须诚实，本工厂不宣称已关**
 * - 调用方可经 `WorkspaceEmptyState.strictHydrateTransport` 覆盖
 */
export function createProductStrictHydrateTransport(
  docId: string,
  options: CreateProductStrictHydrateTransportOptions = {}
): NoteHydrateTransport {
  const source = resolveProductStrictHydrateSource(options);
  if (source === 'tauri-ipc') {
    const ipc = options.hydrateIpc ?? createTauriNoteHydrateIpc();
    return adaptNoteHydrateIpcAsTransport(ipc);
  }
  return createEmptyStateStrictDemoTransport(docId);
}
