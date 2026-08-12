/**
 * W5-B-S Skeleton · 静默假数据接线（SD-25）
 *
 * 未传 `transport` 时：`createSilentFixture` / `listSilentBlocks` → `DisplayBlock`。
 * **禁止** 在此隐式拉真后端 / 把 fixture 标成 hydrate / 打开完成。
 *
 * **≠ W5-B Strict**；**≠ 任何 EL**；禁止 EditorStore。
 */

import {
  createSilentFixture,
  listSilentBlocks,
  type SilentFixture,
} from '@crish/block-paper';
import type { NoteQueryBlockHit } from '../../api/noteApi';

// ---------------------------------------------------------------------------
// 投影视图（预览壳只读；≠ 文档权威）
// ---------------------------------------------------------------------------

export type BlockPropsView = {
  flavour?: string;
  text?: string;
  level?: number;
};

export type DisplayBlock = {
  id: string;
  flavour: string;
  text: string;
  level?: number;
};

/**
 * 解析 Skeleton fixture：注入优先，否则按 blockCount 造静默假数据。
 * 不创建 lines[] / 不走 hydrate。
 */
export function resolveSkeletonFixture(
  fixtureProp: SilentFixture | undefined,
  blockCount: number,
  docId: string
): SilentFixture {
  return (
    fixtureProp ??
    createSilentFixture(blockCount, { docId, rev: 1, idPrefix: 'b' })
  );
}

/** 静默 fixture → 预览壳 DisplayBlock 列表 */
export function mapSilentBlocksToDisplay(
  fixture: SilentFixture
): DisplayBlock[] {
  return listSilentBlocks(fixture).map((block) => {
    const props = (block.props ?? {}) as BlockPropsView;
    return {
      id: block.id,
      flavour: props.flavour ?? 'block',
      text: props.text ?? '',
      level: props.level,
    };
  });
}

/** 半 transport queryHits → 预览壳 DisplayBlock（kind/snippet 形状） */
export function mapTransportHitsToDisplay(
  blocks: readonly NoteQueryBlockHit[]
): DisplayBlock[] {
  return blocks.map((b) => ({
    id: b.id,
    flavour: b.kind,
    text: b.snippet,
  }));
}

/**
 * 标题级别：显式 `level` 优先；否则 h1–h6 flavour；heading/Heading → 2。
 */
export function resolveSkeletonHeadingLevel(
  block: DisplayBlock
): number | undefined {
  if (block.level !== undefined) return block.level;
  const flavour = block.flavour;
  if (flavour?.toLowerCase().startsWith('h') && /^h[1-6]$/i.test(flavour)) {
    return Number(flavour.slice(1));
  }
  if (flavour === 'heading' || flavour === 'Heading') return 2;
  return undefined;
}
