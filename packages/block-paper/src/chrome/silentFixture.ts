/**
 * 静默假数据生成器：产出符合 ProjectionDiff / MemoryBlock 形状的 N 块投影。
 *
 * 对齐：
 * - W0 ProjectionDiff（`@crish/block-paper-contract`）
 * - editor-kit `MemoryBlock` / `applyProjectionDiff`
 * - A-SIL 子集：假数据加载不抛；不接真实 DocSession / RS
 *
 * **禁止** 把本模块输出当作文档权威；写路径必须走 Intent → RS apply。
 */

import type {
  BlockId,
  DocId,
  ProjectionDiff,
  ProjectionUpsert,
} from '@crish/block-paper-contract';
import {
  applyProjectionDiff,
  createDiffApplyState,
  type DiffApplyState,
  type MemoryBlock,
} from '@crish/editor-kit';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 假数据块 props（投影形状子集；flavour 仅作呈现提示） */
export type SilentBlockProps = {
  /** flavour / kind 提示（paragraph / heading / list 等） */
  flavour: string;
  /** 叶子展示文本（mock；非权威） */
  text: string;
  /** 标题级别；仅 heading 有意义 */
  level?: number;
  /** 是否折叠（容器块） */
  collapsed?: boolean;
};

/** 生成选项 */
export type SilentFixtureOptions = {
  /** 文档 id；默认 `silent-doc` */
  docId?: DocId;
  /** 起始 rev；默认 1 */
  rev?: number;
  /** id 前缀；默认 `b` → b-0001 … */
  idPrefix?: string;
  /** 可选：自定义每块 props；缺省循环内置样例 */
  propsForIndex?: (index: number, id: BlockId) => SilentBlockProps;
};

/** 假文档投影快照 */
export type SilentFixture = {
  docId: DocId;
  rev: number;
  /** 有序块 id（扁平展开序） */
  order: BlockId[];
  /** id → MemoryBlock */
  blocks: Map<BlockId, MemoryBlock>;
  /** 等价 DiffApplyState（可继续 apply 增量） */
  state: DiffApplyState;
  /** 用于构造该快照的 ProjectionDiff（fullRebuild 省略 = 默认增量） */
  initialDiff: ProjectionDiff;
};

// ---------------------------------------------------------------------------
// 内置样例 flavour 轮转（静默纸面：正文为主，少量标题/列表）
// ---------------------------------------------------------------------------

const SAMPLE_FLAVOURS: Array<{ flavour: string; level?: number }> = [
  { flavour: 'heading', level: 1 },
  { flavour: 'paragraph' },
  { flavour: 'paragraph' },
  { flavour: 'heading', level: 2 },
  { flavour: 'list' },
  { flavour: 'paragraph' },
  { flavour: 'code' },
  { flavour: 'paragraph' },
];

function defaultPropsForIndex(index: number, id: BlockId): SilentBlockProps {
  const sample = SAMPLE_FLAVOURS[index % SAMPLE_FLAVOURS.length]!;
  const props: SilentBlockProps = {
    flavour: sample.flavour,
    text: `静默块 ${index + 1}（${id}）`,
  };
  if (sample.level !== undefined) {
    props.level = sample.level;
  }
  return props;
}

function padId(prefix: string, index: number): BlockId {
  // 1-based 四位零填充，便于排序可读
  const n = String(index + 1).padStart(4, '0');
  return `${prefix}-${n}`;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * 生成 N 块假文档投影（MemoryBlock 内存态 + 对应 ProjectionDiff）。
 *
 * - 不抛：n ≤ 0 时返回空文档（rev 仍写入）
 * - 默认路径 `fullRebuild` 省略（A-IME-07：fullRemountCount 保持 0）
 * - 未知块不推断：仅 upserts 写入
 *
 * @param n 块数量
 * @param options 文档 id / rev / props 工厂
 */
export function createSilentFixture(
  n: number,
  options: SilentFixtureOptions = {}
): SilentFixture {
  const docId = options.docId ?? 'silent-doc';
  const rev = options.rev ?? 1;
  const idPrefix = options.idPrefix ?? 'b';
  const propsForIndex = options.propsForIndex ?? defaultPropsForIndex;

  const count = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  const upserts: ProjectionUpsert[] = [];
  const order: BlockId[] = [];

  for (let i = 0; i < count; i++) {
    const id = padId(idPrefix, i);
    const props = propsForIndex(i, id);
    upserts.push({
      id,
      props,
      children: [],
    });
    order.push(id);
  }

  const initialDiff: ProjectionDiff = {
    docId,
    rev,
    upserts,
    removes: [],
    textTouches: [],
    // fullRebuild 省略 = 默认增量路径
  };

  const state = createDiffApplyState(docId, 0);
  applyProjectionDiff(state, initialDiff);

  return {
    docId,
    rev: state.rev,
    order: [...state.order],
    blocks: state.blocks,
    state,
    initialDiff,
  };
}

/**
 * 仅构造 ProjectionDiff（不落内存 state）。
 * 供调用方自行 apply 或序列化 mock 事件。
 */
export function createSilentProjectionDiff(
  n: number,
  options: SilentFixtureOptions = {}
): ProjectionDiff {
  return createSilentFixture(n, options).initialDiff;
}

/**
 * 从已有 fixture 读取有序 MemoryBlock 列表（拷贝引用，不克隆 props）。
 */
export function listSilentBlocks(fixture: SilentFixture): MemoryBlock[] {
  const out: MemoryBlock[] = [];
  for (const id of fixture.order) {
    const b = fixture.blocks.get(id);
    if (b) out.push(b);
  }
  return out;
}
