/**
 * W3-F DOM 余量 · 拖拽预览 / 落点反馈可测契约（jsdom）。
 *
 * ## 轨声明（诚实）
 *
 * | 可宣称 | 禁止宣称 |
 * | ------ | -------- |
 * | 拖拽预览 ghost DOM 显隐 / data-drag-source | **EL-01** / A-BLK-04 产品 e2e 全关 |
 * | 指针形状 mock → 落点线 side/target | Notion 拖拽全链路 / 桌面 React 挂载 |
 * | endDrag 清预览+落点 | 自动 wire Move Intent |
 *
 * **DOM 交付 ≠ EL-01**。A-BLK-04 产品 e2e 仍开。
 * Strict collab 写路径见 `chrome.w3f_apply.test.ts`；本文件 **不**用 mock.calls 关 Strict。
 */
// @vitest-environment jsdom

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { BlockChromeModel } from './BlockChrome';
import {
  BlockChromeDomHost,
  BP_DRAG_PREVIEW,
  BP_DRAG_SOURCE,
  BP_DRAGGING,
  BP_DROP_SIDE,
  BP_DROP_TARGET,
} from './BlockChromeDomHost';
import {
  createCollabApplySink,
  submitIntent,
  type ApplyOpsAdapter,
} from '../leaves/intentBridge';
import { buildMoveBlocksIntent } from './structureIntents';
import { resetIntentIdSeqForTests } from '../leaves/TextLeafModel';

const ID_A = 'block-drag-a';
const ID_B = 'block-drag-b';
const ID_C = 'block-drag-c';

function requireDocument(): Document {
  if (typeof document === 'undefined' || !document.createElement) {
    throw new Error('jsdom document 不可用');
  }
  return document;
}

describe('W3-F DOM · 拖拽预览', () => {
  let mount: HTMLElement;
  let chrome: BlockChromeModel;
  let host: BlockChromeDomHost;

  beforeEach(() => {
    resetIntentIdSeqForTests();
    const doc = requireDocument();
    mount = doc.createElement('div');
    doc.body.appendChild(mount);
    chrome = new BlockChromeModel();
    host = new BlockChromeDomHost(mount, {
      blocks: [{ blockId: ID_A }, { blockId: ID_B }, { blockId: ID_C }],
      chrome,
    });
  });

  afterEach(() => {
    host.destroy();
    mount.remove();
  });

  it('w3f_drag_preview_start: startDragPreview → ghost 可见 + data-drag-source + 源行 dragging', () => {
    expect(host.isDragging()).toBe(false);
    expect(host.isDragPreviewVisible()).toBe(false);
    expect(
      host.getRootElement().querySelector(`[${BP_DRAG_PREVIEW}]`)
    ).toBeTruthy();

    const ok = host.startDragPreview(ID_A, 'preview-a');
    expect(ok).toBe(true);
    expect(host.isDragging()).toBe(true);
    expect(host.isDragPreviewVisible()).toBe(true);
    expect(host.getDragPreviewState()).toEqual({
      sourceBlockId: ID_A,
      label: 'preview-a',
    });

    const ghost = host.getDragPreviewElement();
    expect(ghost.getAttribute(BP_DRAG_PREVIEW)).toBe('1');
    expect(ghost.getAttribute(BP_DRAG_SOURCE)).toBe(ID_A);
    expect(ghost.hidden).toBe(false);
    expect(ghost.textContent).toBe('preview-a');

    expect(host.getRowElement(ID_A)?.getAttribute(BP_DRAGGING)).toBe('1');
    expect(host.getRowElement(ID_B)?.getAttribute(BP_DRAGGING)).toBe('0');
  });

  it('w3f_drag_preview_unknown_source: 未知源块 → 不进入 dragging', () => {
    expect(host.startDragPreview('not-in-list')).toBe(false);
    expect(host.isDragging()).toBe(false);
    expect(host.isDragPreviewVisible()).toBe(false);
  });

  it('w3f_drag_pointer_shape_drop_line: 指针形状 mock → 预览 + 落点线 side/target', () => {
    host.applyDragPointerShape({
      phase: 'down',
      sourceBlockId: ID_A,
      label: 'A',
    });
    expect(host.isDragPreviewVisible()).toBe(true);
    expect(host.isDropLineVisible()).toBe(false);

    host.applyDragPointerShape({
      phase: 'move',
      overBlockId: ID_C,
      side: 'before',
    });
    expect(host.isDragging()).toBe(true);
    expect(host.isDragPreviewVisible()).toBe(true);
    expect(host.isDropLineVisible()).toBe(true);
    expect(host.getDropTarget()).toEqual({ blockId: ID_C, side: 'before' });

    const line = host.getDropLineElement();
    expect(line.getAttribute(BP_DROP_SIDE)).toBe('before');
    expect(line.getAttribute(BP_DROP_TARGET)).toBe(ID_C);
    // 落点线 DOM 序：在 ID_C 之前
    expect(line.nextSibling).toBe(host.getRowElement(ID_C));

    host.applyDragPointerShape({
      phase: 'move',
      overBlockId: ID_B,
      side: 'after',
    });
    expect(line.getAttribute(BP_DROP_SIDE)).toBe('after');
    expect(line.getAttribute(BP_DROP_TARGET)).toBe(ID_B);
  });

  it('w3f_drag_pointer_self_hover_hides_drop: 悬停自身不显示落点', () => {
    host.applyDragPointerShape({ phase: 'down', sourceBlockId: ID_B });
    host.applyDragPointerShape({
      phase: 'move',
      overBlockId: ID_B,
      side: 'before',
    });
    expect(host.isDropLineVisible()).toBe(false);
    expect(host.getDropTarget()).toBeNull();
  });

  it('w3f_drag_end_clears_preview_and_drop: up/cancel 清预览与落点', () => {
    host.applyDragPointerShape({ phase: 'down', sourceBlockId: ID_A });
    host.applyDragPointerShape({
      phase: 'move',
      overBlockId: ID_C,
      side: 'after',
    });
    expect(host.isDragPreviewVisible()).toBe(true);
    expect(host.isDropLineVisible()).toBe(true);

    host.applyDragPointerShape({ phase: 'up' });
    expect(host.isDragging()).toBe(false);
    expect(host.isDragPreviewVisible()).toBe(false);
    expect(host.isDropLineVisible()).toBe(false);
    expect(host.getDragPreviewState()).toBeNull();
    expect(host.getDropTarget()).toBeNull();
    expect(host.getRowElement(ID_A)?.getAttribute(BP_DRAGGING)).toBe('0');
    expect(host.getDragPreviewElement().getAttribute(BP_DRAG_SOURCE)).toBe('');
  });

  it('w3f_drag_move_intent_still_collab: 预览结束可仍走 createCollabApplySink（非 mock.calls）', async () => {
    // 呈现层：模拟拖拽 A → C before
    host.applyDragPointerShape({ phase: 'down', sourceBlockId: ID_A });
    host.applyDragPointerShape({
      phase: 'move',
      overBlockId: ID_C,
      side: 'before',
    });
    const drop = host.getDropTarget();
    expect(drop).toEqual({ blockId: ID_C, side: 'before' });

    // 写路径独立：调用方用落点构造 Move Intent → collab sink
    const applied: string[] = [];
    const applyOps: ApplyOpsAdapter = async (opsJson) => {
      applied.push(opsJson);
      return { ok: true };
    };
    const collab = createCollabApplySink({ applyOps });
    const intent = buildMoveBlocksIntent({
      blockIds: [ID_A],
      parentId: null,
      index: 1,
      origin: 'drag',
      createIntentId: () => 'w3f-drag-move-collab',
    });
    const submitted = await submitIntent(intent, collab.sink);
    expect(submitted.ok).toBe(true);
    expect(collab.wireCalls).toHaveLength(1);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toContain('"op":"move"');
    expect(applied[0]).toContain(ID_A);
    expect('calls' in collab).toBe(false);

    host.applyDragPointerShape({ phase: 'up' });
    expect(host.isDragging()).toBe(false);
  });
});
