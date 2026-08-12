/**
 * W3-G · PaperList DOM reconcile（SD-20 切开 · reconcile）
 *
 * 仅 `plan.mountIds` 进 DOM；窗外 **remove**（非 hidden / display:none）。
 *
 * - **≠ EL-01**；**≠ W3-P**；**≠ C2 默开**
 * - 禁止 CSS 假虚拟化
 */

import type { BlockId } from '@crish/block-paper-contract';
import type { MountPlan, PaperBlockProjection } from './buildMountPlan';
import { BP_PAPER_BLOCK, BP_PAPER_BLOCK_ID } from './paperListConstants';
import { applyPaperListSpacers } from './paperListSpacer';

export type PaperListReconcileContext = {
  root: HTMLElement;
  blockHost: HTMLElement;
  spacerBefore: HTMLElement;
  spacerAfter: HTMLElement;
  nodes: Map<BlockId, HTMLElement>;
  projections: Map<BlockId, PaperBlockProjection>;
};

export function normalizeProjections(
  projections:
    | ReadonlyMap<BlockId, PaperBlockProjection>
    | readonly PaperBlockProjection[]
    | undefined
): Map<BlockId, PaperBlockProjection> {
  const map = new Map<BlockId, PaperBlockProjection>();
  if (!projections) return map;
  // Map 与数组分流（exactOptional + for-of 联合类型需显式分支）
  if (isProjectionMap(projections)) {
    projections.forEach((p, id) => {
      map.set(id, p);
    });
    return map;
  }
  for (const p of projections) {
    map.set(p.id, p);
  }
  return map;
}

function isProjectionMap(
  v:
    ReadonlyMap<BlockId, PaperBlockProjection> | readonly PaperBlockProjection[]
): v is ReadonlyMap<BlockId, PaperBlockProjection> {
  return (
    typeof (v as ReadonlyMap<BlockId, PaperBlockProjection>).forEach ===
      'function' && !Array.isArray(v)
  );
}

export function paintPaperBlock(
  el: HTMLElement,
  id: BlockId,
  projections: Map<BlockId, PaperBlockProjection>
): void {
  el.setAttribute(BP_PAPER_BLOCK_ID, id);
  const proj = projections.get(id);
  if (proj?.flavour) {
    el.setAttribute('data-flavour', proj.flavour);
  } else {
    el.removeAttribute('data-flavour');
  }
  // 正文仅呈现；**非**权威
  const text = proj?.text ?? '';
  if (el.textContent !== text) {
    el.textContent = text;
  }
}

export function createPaperBlockElement(
  doc: Document,
  id: BlockId,
  projections: Map<BlockId, PaperBlockProjection>
): HTMLElement {
  const el = doc.createElement('div');
  el.className = 'bp-paper-block';
  el.setAttribute(BP_PAPER_BLOCK, '1');
  el.setAttribute(BP_PAPER_BLOCK_ID, id);
  paintPaperBlock(el, id, projections);
  return el;
}

/**
 * 按 MountPlan reconcile 块宿主。
 * 窗外节点 **remove**；禁止 hidden 假虚拟化。
 */
export function applyPaperListPlan(
  ctx: PaperListReconcileContext,
  plan: MountPlan
): void {
  const doc = ctx.root.ownerDocument;
  const want = new Set(plan.mountIds);

  // 1) 卸载窗外（真 remove，禁止 hidden 假虚拟化）
  for (const [id, el] of ctx.nodes) {
    if (!want.has(id)) {
      el.remove();
      ctx.nodes.delete(id);
    }
  }

  // 2) 按 mountIds 序挂载 / 重排
  let anchor: Node | null = ctx.blockHost.firstChild;
  for (const id of plan.mountIds) {
    let el = ctx.nodes.get(id);
    if (!el) {
      el = createPaperBlockElement(doc, id, ctx.projections);
      ctx.nodes.set(id, el);
    } else {
      paintPaperBlock(el, id, ctx.projections);
    }
    // 保持 order：若当前 anchor 不是 el，则 insertBefore
    if (anchor !== el) {
      ctx.blockHost.insertBefore(el, anchor);
    } else {
      anchor = el.nextSibling;
      continue;
    }
    // insertBefore 后，下一个应对齐到刚插入节点之后
    anchor = el.nextSibling;
  }

  // 3) spacer + 根属性
  applyPaperListSpacers(ctx, plan);
}
