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
 * - `createFixtureHydrateTransport` = 可测 Strict 方向子集；`source: 'fixture'`
 * - `adaptNoteTransportAsHydrate` = 把已有 `note_query_blocks` 形状映射为投影
 *   （Tauri / Memory 皆可注入）；**不等于** DocSession::hydrate 产品全链路完成
 *
 * ## 禁止
 * - import 行级 EditorStore / lines[] 权威
 * - 用静默假段落冒充 hydrate 投影
 */

import type { NoteQueryBlockHit, NoteTransport } from '../../api/noteApi';

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
   * - `fixture`：测试 / 演示注入的 hydrate 形状
   * - `note-transport`：经 NoteTransport.queryBlocks 映射
   * - `tauri-ipc`：预留给未来专用 hydrate 命令（当前适配层不默认声称）
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
// 产品空态 Strict 演示 fixture（≠ DocSession IPC 默认挂载完成）
// ---------------------------------------------------------------------------

/**
 * 工作区空态打开 Strict 面板时的默认 hydrate 通路（source=`fixture`）。
 *
 * 诚实边界（钉死）：
 * - **可演示 ≠ EL-01 / EL-08**；挂载冒充交付 = S5
 * - **≠ 打开完成**：本 fixture **不是** `DocSession::hydrate` 产品 IPC 默认路径
 * - 产品侧可注入真 transport / `adaptNoteTransportAsHydrate` 替换本工厂
 * - DOM / 投影 `source` 必须为 `fixture`，禁止伪装 `tauri-ipc`
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
          text: '可演示 ≠ EL-01/EL-08 · ≠ 打开完成 · fixture ≠ DocSession IPC',
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
