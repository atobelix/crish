/**
 * Fixture hydrate transport（SD-24 切开 · fixture）
 *
 * `createFixtureHydrateTransport` 成功体必须 `source: 'fixture'`。
 * **禁止** fixture 写 `source:'tauri-ipc'`。fixture ≠ 生产权威。
 * **≠** 打开完成；**≠ EL-01/04/08**。
 */

import type {
  FixtureHydrateDoc,
  HydratedBlockProjection,
  NoteHydrateTransport,
} from './hydrateProjection.types';

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
