/**
 * 未知 flavour 占位呈现模型（W3-H · A-BLK-11 占位 View 方向）。
 *
 * 对齐：
 * - A-BLK-11：未知 flavour → 占位块可恢复，**不丢数据**
 * - `flavourToCollabKind` → `{ unknown: { flavour } }`（wire 半已在 contract / chrome.a_blk）
 * - `plans/05` §5：占位块可展示；写仍走 Op；永久「只能装饰内置」否决
 *
 * ## 本波交付
 * - 纯 TS 占位模型：保留 blockId + 原始 flavour + 文本 + wire kind
 * - **可展示**快照字段（title / badge / recoverable）
 * - **≠** 占位 UI e2e；**≠** registerFlavour 全表；**≠** EL-01
 *
 * 文件域：`leaves/**` 新文件，不碰 chrome slash。
 */

import type { BlockId } from '@crish/block-paper-contract';
import {
  flavourToCollabKind,
  type CollabBlockKindWire,
} from '@crish/block-paper-contract';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 未知 flavour 的 collab kind 形状（收窄） */
export type UnknownCollabKind = { unknown: { flavour: string } };

/**
 * 占位块只读快照（呈现层；**不是**文档权威）。
 * 权威仍在 RS 树；本模型仅供 PaperList / chrome 行渲染未知 kind。
 */
export type UnknownFlavourPlaceholderSnapshot = {
  blockId: BlockId;
  /** 原始 flavour 字符串（恢复 / 调试 / 未来 registerFlavour 命中后可升级） */
  flavour: string;
  /** 保留文本（不丢数据） */
  text: string;
  /** collab kind wire：`{ unknown: { flavour } }` */
  kindWire: UnknownCollabKind;
  /** 展示用短标签 */
  displayTitle: string;
  /** 徽章文案（如「未知块」） */
  badge: string;
  /** 是否可后续用 registerFlavour 升级（恒 true 方向） */
  recoverable: true;
  /** 可选 props 透传（插件 attrs 原样保留，不解析） */
  preservedProps: Record<string, unknown>;
};

export type CreateUnknownFlavourPlaceholderInput = {
  blockId: BlockId;
  /** 原始 / 未识别 flavour */
  flavour: string;
  /** 块文本；缺省空串 */
  text?: string;
  /** 额外 props（原样保留） */
  props?: Record<string, unknown>;
  /** 覆盖默认徽章 */
  badge?: string;
};

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

/** 是否为 `{ unknown: { flavour } }` wire */
export function isUnknownCollabKind(
  kind: CollabBlockKindWire
): kind is UnknownCollabKind {
  return (
    kind != null &&
    typeof kind === 'object' &&
    'unknown' in kind &&
    typeof (kind as UnknownCollabKind).unknown?.flavour === 'string'
  );
}

/**
 * 纸面 flavour 是否映射为 Unknown。
 * 委托 `flavourToCollabKind`（与 A-BLK-11 wire 半同一源）。
 */
export function isUnknownFlavour(flavour: string): boolean {
  return isUnknownCollabKind(flavourToCollabKind(flavour ?? ''));
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

/**
 * 构造未知 flavour 占位快照。
 *
 * - 若 flavour 实际是内置已知 kind → **仍可**构造（宿主误用时），
 *   但 `kindWire` 会是真实 kind；此时 `recoverable` 仍 true，
 *   `badge` 默认改为「已知」提示——见 `forceUnknown`。
 * - `forceUnknown=true`：强制包装为 Unknown（投影已标 unknown 时用）
 *
 * @throws blockId 空
 */
export function createUnknownFlavourPlaceholder(
  input: CreateUnknownFlavourPlaceholderInput & { forceUnknown?: boolean }
): UnknownFlavourPlaceholderSnapshot {
  if (!input.blockId) {
    throw new Error('createUnknownFlavourPlaceholder：blockId 不可为空');
  }
  const flavour = (input.flavour ?? '').trim() || 'unknown';
  const text = input.text ?? '';
  const preservedProps = { ...(input.props ?? {}) };

  const mapped = flavourToCollabKind(flavour);
  let kindWire: UnknownCollabKind;
  let badge: string;

  if (input.forceUnknown || isUnknownCollabKind(mapped)) {
    kindWire = isUnknownCollabKind(mapped) ? mapped : { unknown: { flavour } };
    badge = input.badge ?? '未知块';
  } else {
    // 宿主对已知 flavour 调用占位：仍保留可恢复语义，但不伪造 unknown wire
    kindWire = { unknown: { flavour } };
    badge = input.badge ?? '占位';
  }

  return {
    blockId: input.blockId,
    flavour,
    text,
    kindWire,
    displayTitle: flavour,
    badge,
    recoverable: true,
    preservedProps,
  };
}

/**
 * 从投影行（MemoryBlock / SilentBlock 子集）安全构建占位。
 * - flavour 已知 → 返回 `null`（应由正常 leaf 渲染）
 * - flavour 未知 → 占位快照
 */
export function tryCreateUnknownFlavourPlaceholder(input: {
  blockId: BlockId;
  flavour: string;
  text?: string;
  props?: Record<string, unknown>;
}): UnknownFlavourPlaceholderSnapshot | null {
  if (!isUnknownFlavour(input.flavour)) return null;
  return createUnknownFlavourPlaceholder(input);
}

/**
 * 占位块本地文本替换（**仅**更新快照文本；写权威仍须 TextEditIntent → apply）。
 * 返回新快照（不可变）。
 */
export function placeholderWithText(
  snap: UnknownFlavourPlaceholderSnapshot,
  text: string
): UnknownFlavourPlaceholderSnapshot {
  return {
    ...snap,
    text: text ?? '',
    preservedProps: { ...snap.preservedProps },
    kindWire: { unknown: { flavour: snap.kindWire.unknown.flavour } },
  };
}
