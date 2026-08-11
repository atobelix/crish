/**
 * pin 集合：焦点块 + composing 块必须驻留 DOM。
 *
 * 对齐：
 * - W0 MountSpec.pinned 不变量（`00-W0接口冻结.md` §3）
 * - A-IME：composing 中禁 unmount 焦点
 *
 * 不变量：
 * 1. composing 块必须 pinned
 * 2. 卸载焦点块 = 违规
 */

import type { BlockId } from '@crish/block-paper-contract';

/** pin 违规错误码 */
export type PinViolationCode =
  'composing_not_pinned' | 'unmount_focus' | 'unmount_composing';

/** pin 违规错误 */
export class PinViolationError extends Error {
  readonly code: PinViolationCode;
  readonly blockId: BlockId;

  constructor(code: PinViolationCode, blockId: BlockId, message?: string) {
    super(message ?? defaultMessage(code, blockId));
    this.name = 'PinViolationError';
    this.code = code;
    this.blockId = blockId;
  }
}

function defaultMessage(code: PinViolationCode, blockId: BlockId): string {
  switch (code) {
    case 'composing_not_pinned':
      return `pin 不变量违规：composing 块必须 pinned（blockId=${blockId}）`;
    case 'unmount_focus':
      return `pin 不变量违规：禁止卸载焦点块（blockId=${blockId}）`;
    case 'unmount_composing':
      return `pin 不变量违规：禁止卸载 composing 块（blockId=${blockId}）`;
  }
}

/** Result 风格（不抛） */
export type PinResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; code: PinViolationCode; blockId: BlockId; message: string };

/** 构建 pin 输入 */
export type PinInput = {
  /** 当前焦点块；null/undefined = 无焦点 */
  focusId?: BlockId | null;
  /** IME composition 中的块（可多块，通常 1） */
  composingIds?: Iterable<BlockId>;
  /** 额外 pin（选区锚点、拖选等） */
  extraPinned?: Iterable<BlockId>;
};

/**
 * 由焦点 + composing + 额外项构建 pin 集合。
 * composing 与 focus **自动并入**，满足「composing 必须 pinned」。
 */
export function buildPinSet(input: PinInput = {}): Set<BlockId> {
  const pinned = new Set<BlockId>();
  if (input.focusId != null && input.focusId !== '') {
    pinned.add(input.focusId);
  }
  if (input.composingIds) {
    for (const id of input.composingIds) {
      if (id) pinned.add(id);
    }
  }
  if (input.extraPinned) {
    for (const id of input.extraPinned) {
      if (id) pinned.add(id);
    }
  }
  return pinned;
}

/**
 * 校验：每个 composing 块都在 pinned 中。
 *
 * 正常路径应使用 `buildPinSet`（自动并入）；本函数用于外部传入的 pin 快照审计。
 */
export function ensureComposingPinned(
  pinned: ReadonlySet<BlockId>,
  composingIds: Iterable<BlockId>
): PinResult {
  for (const id of composingIds) {
    if (!id) continue;
    if (!pinned.has(id)) {
      const message = defaultMessage('composing_not_pinned', id);
      return { ok: false, code: 'composing_not_pinned', blockId: id, message };
    }
  }
  return { ok: true, value: undefined };
}

/**
 * 断言 composing 均已 pin；失败抛 `PinViolationError`。
 */
export function assertComposingPinned(
  pinned: ReadonlySet<BlockId>,
  composingIds: Iterable<BlockId>
): void {
  const r = ensureComposingPinned(pinned, composingIds);
  if (!r.ok) {
    throw new PinViolationError(r.code, r.blockId, r.message);
  }
}

/**
 * 校验是否允许卸载某块（Result）。
 *
 * - 焦点块 → unmount_focus
 * - composing 块 → unmount_composing
 * - 其余 pinned 默认也拒绝卸载（驻留 DOM 契约）
 */
export function checkUnmountAllowed(
  blockId: BlockId,
  ctx: {
    focusId?: BlockId | null;
    composingIds?: ReadonlySet<BlockId> | Iterable<BlockId>;
    pinned: ReadonlySet<BlockId>;
  }
): PinResult {
  if (ctx.focusId != null && ctx.focusId === blockId) {
    const message = defaultMessage('unmount_focus', blockId);
    return { ok: false, code: 'unmount_focus', blockId, message };
  }
  const composing =
    ctx.composingIds instanceof Set
      ? ctx.composingIds
      : new Set(ctx.composingIds ?? []);
  if (composing.has(blockId)) {
    const message = defaultMessage('unmount_composing', blockId);
    return { ok: false, code: 'unmount_composing', blockId, message };
  }
  if (ctx.pinned.has(blockId)) {
    // pinned 但非 focus/composing：仍禁止卸载（选区锚等）
    const message = `pin 不变量违规：禁止卸载 pinned 块（blockId=${blockId}）`;
    return { ok: false, code: 'unmount_focus', blockId, message };
  }
  return { ok: true, value: undefined };
}

/**
 * 断言允许卸载；失败抛 `PinViolationError`。
 * 卸载焦点块 = 违规。
 */
export function assertUnmountAllowed(
  blockId: BlockId,
  ctx: {
    focusId?: BlockId | null;
    composingIds?: ReadonlySet<BlockId> | Iterable<BlockId>;
    pinned: ReadonlySet<BlockId>;
  }
): void {
  const r = checkUnmountAllowed(blockId, ctx);
  if (!r.ok) {
    throw new PinViolationError(r.code, r.blockId, r.message);
  }
}

/**
 * 从候选卸载集中过滤：仅返回允许卸载的 id；违规项可选择 throw 或收集。
 *
 * @param mode `'throw'` 遇违规即抛；`'filter'` 静默丢弃违规项
 */
export function filterUnmountCandidates(
  candidates: Iterable<BlockId>,
  ctx: {
    focusId?: BlockId | null;
    composingIds?: ReadonlySet<BlockId> | Iterable<BlockId>;
    pinned: ReadonlySet<BlockId>;
  },
  mode: 'throw' | 'filter' = 'throw'
): BlockId[] {
  const allowed: BlockId[] = [];
  for (const id of candidates) {
    const r = checkUnmountAllowed(id, ctx);
    if (r.ok) {
      allowed.push(id);
    } else if (mode === 'throw') {
      throw new PinViolationError(r.code, r.blockId, r.message);
    }
  }
  return allowed;
}

/**
 * 完整校验 pin 输入快照：用 buildPinSet 构建后，再审计外部 pinned 是否覆盖 composing。
 * 供挂载层单测与 A-IME 门禁使用。
 */
export function validatePinSnapshot(input: {
  pinned: ReadonlySet<BlockId> | Iterable<BlockId>;
  focusId?: BlockId | null;
  composingIds?: Iterable<BlockId>;
}): PinResult<BlockId[]> {
  const pinned =
    input.pinned instanceof Set ? input.pinned : new Set(input.pinned);
  const composing = [...(input.composingIds ?? [])].filter(Boolean);
  const ensure = ensureComposingPinned(pinned, composing);
  if (!ensure.ok) return ensure;

  // 焦点在 pin 中（有焦点时）
  if (
    input.focusId != null &&
    input.focusId !== '' &&
    !pinned.has(input.focusId)
  ) {
    const message = defaultMessage('unmount_focus', input.focusId);
    return {
      ok: false,
      code: 'unmount_focus',
      blockId: input.focusId,
      message,
    };
  }

  return { ok: true, value: [...pinned] };
}
