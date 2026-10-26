import { describe, expect, it, vi } from 'vitest';
import {
  ComposerImeDragGuard,
  computeMinimalTextDiff,
  restoreSelectionSafely,
  type ComposerSelectionSnapshot,
} from './composerImeDragGuard';

describe('composerImeDragGuard (Stage 05 §4 & §5)', () => {
  it('IME composing 期间拦截外部受控更新，compositionend 解锁后原子消费最新延迟值', () => {
    const guard = new ComposerImeDragGuard();

    guard.beginComposition({
      selectionStart: 3,
      selectionEnd: 3,
      blockId: 'p-1',
      capturedAtMs: 1000,
    });
    expect(guard.isComposing()).toBe(true);
    expect(guard.isLocked()).toBe(true);

    // 合成期间到达两次外部同步，均被延迟且仅保留最新值
    const res1 = guard.tryApplyExternalSync('draft-v1', 'local-v0');
    const res2 = guard.tryApplyExternalSync('draft-v2', 'local-v0');
    expect(res1).toEqual({ applyNow: false, valueToApply: null });
    expect(res2).toEqual({ applyNow: false, valueToApply: null });
    expect(guard.getDiagnostics()).toMatchObject({
      composing: true,
      dragging: false,
      isLocked: true,
      hasPendingExternalValue: true,
      deferredSyncCount: 2,
      flushedSyncCount: 0,
    });

    // compositionend 触发解锁并原子返回最新延迟值
    const flushed = guard.endComposition();
    expect(flushed).toBe('draft-v2');
    expect(guard.isLocked()).toBe(false);
    expect(guard.getDiagnostics()).toMatchObject({
      composing: false,
      hasPendingExternalValue: false,
      flushedSyncCount: 1,
    });
    // 重复结束事件不得再次消费或复活已经清理的更新。
    expect(guard.endComposition()).toBeNull();
    expect(guard.getDiagnostics()).toMatchObject({
      composing: false,
      hasPendingExternalValue: false,
      flushedSyncCount: 1,
    });
  });

  it('composing 与 dragging 双锁叠加时：仅当两者全部解除后才释放延迟更新与选区恢复', () => {
    const guard = new ComposerImeDragGuard();
    const snapshot: ComposerSelectionSnapshot = {
      selectionStart: 5,
      selectionEnd: 12,
      blockId: 'block-2',
      capturedAtMs: 2000,
    };

    // 1. 先进入拖拽态，拍摄选区快照
    guard.beginDrag(snapshot);
    expect(guard.isDragging()).toBe(true);
    expect(guard.isLocked()).toBe(true);

    // 2. 拖拽途中用户开始 IME 拼音组合输入
    guard.beginComposition();
    expect(guard.isComposing()).toBe(true);

    // 3. 此时外部同步到达 -> 必须被拦截
    expect(guard.tryApplyExternalSync('external-sync', 'local')).toEqual({
      applyNow: false,
      valueToApply: null,
    });

    // 4. 拖拽先结束（但 IME 仍在合成中） -> 仍处于锁定态，不得提前刷入外部值或破坏 IME 选区
    const dragEndWhileComposing = guard.endDrag();
    expect(dragEndWhileComposing).toEqual({
      deferredValue: null,
      restoredSelection: null,
    });
    expect(guard.isLocked()).toBe(true);

    // 5. IME 合成结束 -> 双锁全部解除，立即释放延迟值
    const flushedAfterIme = guard.endComposition();
    expect(flushedAfterIme).toBe('external-sync');
    expect(guard.isLocked()).toBe(false);
  });

  it('组合期间失焦：保留组合文本由宿主负责，清除双锁并消费最新外部值', () => {
    const guard = new ComposerImeDragGuard();
    guard.beginComposition({
      selectionStart: 2,
      selectionEnd: 4,
      blockId: 'draft',
      capturedAtMs: 10,
    });
    guard.beginDrag({
      selectionStart: 2,
      selectionEnd: 4,
      blockId: 'draft',
      capturedAtMs: 11,
    });
    guard.tryApplyExternalSync('latest-draft', 'local-composition-draft');

    expect(guard.settleCompositionOnBlur()).toBe('latest-draft');
    expect(guard.getDiagnostics()).toMatchObject({
      composing: false,
      dragging: false,
      isLocked: false,
      hasPendingExternalValue: false,
      flushedSyncCount: 1,
    });
    expect(guard.getSelectionSnapshot()).toBeNull();
    expect(guard.endComposition()).toBeNull();
  });

  it('纯拖拽态结束时：原子返回延迟外部值并精确恢复原选区快照（零选区丢失）', () => {
    const guard = new ComposerImeDragGuard();
    const snapshot: ComposerSelectionSnapshot = {
      selectionStart: 4,
      selectionEnd: 9,
      blockId: 'block-1',
      capturedAtMs: 3000,
    };

    guard.beginDrag(snapshot);
    guard.tryApplyExternalSync('updated-from-other-pane', 'old-text');

    const { deferredValue, restoredSelection } = guard.endDrag();
    expect(deferredValue).toBe('updated-from-other-pane');
    expect(restoredSelection).toEqual(snapshot);
    expect(guard.getDiagnostics().selectionRestorations).toBe(1);
    expect(guard.getSelectionSnapshot()).toBeNull();
  });

  it('未锁定态下：相同值幂等跳过，不同值立即放行', () => {
    const guard = new ComposerImeDragGuard();

    expect(guard.tryApplyExternalSync('same', 'same')).toEqual({
      applyNow: false,
      valueToApply: null,
    });
    expect(guard.tryApplyExternalSync('next', 'prev')).toEqual({
      applyNow: true,
      valueToApply: 'next',
    });
  });

  it('拖拽期间按键白名单：放行 IME Process、方向键、编辑键、单字符与 Ctrl+Z/Y/A/C/V/X，拦截非白名单功能键', () => {
    const guard = new ComposerImeDragGuard();
    guard.beginDrag({
      selectionStart: 0,
      selectionEnd: 0,
      blockId: null,
      capturedAtMs: 1,
    });

    expect(
      guard.isKeyWhitelistedDuringDrag({ key: 'Process', isComposing: true })
    ).toBe(true);
    expect(guard.isKeyWhitelistedDuringDrag({ key: 'ArrowLeft' })).toBe(true);
    expect(guard.isKeyWhitelistedDuringDrag({ key: 'Backspace' })).toBe(true);
    expect(guard.isKeyWhitelistedDuringDrag({ key: 'a' })).toBe(true);
    expect(guard.isKeyWhitelistedDuringDrag({ key: 'z', ctrlKey: true })).toBe(
      true
    );
    expect(guard.isKeyWhitelistedDuringDrag({ key: 'v', metaKey: true })).toBe(
      true
    );

    // 非白名单组合键或功能键在拖拽期间被拦截
    expect(guard.isKeyWhitelistedDuringDrag({ key: 'F5' })).toBe(false);
    expect(guard.isKeyWhitelistedDuringDrag({ key: 'p', ctrlKey: true })).toBe(
      false
    );
  });

  it('restoreSelectionSafely：当文档长度缩短时自动钳制 [from, to] 到合法边界，不抛越界异常', () => {
    const setTextSelection = vi.fn(() => true);
    const mockEditor = {
      isDestroyed: false,
      state: {
        doc: {
          content: {
            size: 10,
          },
        },
      },
      commands: {
        setTextSelection,
      },
    };

    const ok = restoreSelectionSafely(mockEditor, {
      selectionStart: 6,
      selectionEnd: 25,
      blockId: 'b-0',
      capturedAtMs: 100,
    });

    expect(ok).toBe(true);
    expect(setTextSelection).toHaveBeenCalledWith({ from: 6, to: 10 });
  });

  it('computeMinimalTextDiff：O(N) 精准定位前缀与后缀之间的最小编辑区间', () => {
    expect(computeMinimalTextDiff('hello world', 'hello world')).toBeNull();
    expect(
      computeMinimalTextDiff('hello world', 'hello brave new world')
    ).toEqual({
      from: 6,
      to: 6,
      insert: 'brave new ',
    });
    expect(computeMinimalTextDiff('abcdef', 'abXYef')).toEqual({
      from: 2,
      to: 4,
      insert: 'XY',
    });
  });
});
