// 覆盖层注册表裁决（批 D）：栈序、Back 分发、dismissible=false
// 阻断、钻取优先、无栈不消费——逐项钉死（纯逻辑面）。
import {
  handleOverlayBack,
  handleOverlayBackFor,
  overlayStackDepth,
  pushOverlay,
  removeOverlay,
  topOverlay,
  type OverlayEntry,
} from './overlayStack';

function entry(partial: Partial<OverlayEntry> & { id: string }): OverlayEntry {
  return {
    dismissible: true,
    onRequestClose: () => undefined,
    ...partial,
  };
}

afterEach(() => {
  // 模块级单例栈：逐例清空，避免用例间串扰
  while (topOverlay()) removeOverlay(topOverlay()!.id);
});

describe('overlayStack 栈序', () => {
  it('按开启顺序成栈，栈顶 = 最后登记者', () => {
    pushOverlay(entry({ id: 'a' }));
    pushOverlay(entry({ id: 'b' }));
    pushOverlay(entry({ id: 'c' }));
    expect(overlayStackDepth()).toBe(3);
    expect(topOverlay()?.id).toBe('c');
  });

  it('同 id 重复登记原位更新，不改栈序不增深度', () => {
    const closeA = jest.fn();
    pushOverlay(entry({ id: 'a', onRequestClose: closeA }));
    pushOverlay(entry({ id: 'b' }));
    pushOverlay(entry({ id: 'a', dismissible: false }));
    expect(overlayStackDepth()).toBe(2);
    expect(topOverlay()?.id).toBe('b');
    removeOverlay('b');
    expect(topOverlay()?.id).toBe('a');
    expect(topOverlay()?.dismissible).toBe(false);
  });

  it('注销中间层不扰动其余栈序；注销不存在的 id 无操作', () => {
    pushOverlay(entry({ id: 'a' }));
    pushOverlay(entry({ id: 'b' }));
    pushOverlay(entry({ id: 'c' }));
    removeOverlay('b');
    removeOverlay('missing');
    expect(overlayStackDepth()).toBe(2);
    expect(topOverlay()?.id).toBe('c');
  });
});

describe('overlayStack Back 分发', () => {
  it('栈空 → 不消费（false）', () => {
    expect(handleOverlayBack()).toBe(false);
    expect(handleOverlayBackFor('anything')).toBe(false);
  });

  it('只关栈顶，下层不受影响', () => {
    const closeA = jest.fn();
    const closeB = jest.fn();
    pushOverlay(entry({ id: 'a', onRequestClose: closeA }));
    pushOverlay(entry({ id: 'b', onRequestClose: closeB }));
    expect(handleOverlayBack()).toBe(true);
    expect(closeB).toHaveBeenCalledTimes(1);
    expect(closeA).not.toHaveBeenCalled();
  });

  it('dismissible=false 的栈顶挡下返回：消费但谁都不关', () => {
    const closeA = jest.fn();
    const closeGuard = jest.fn();
    pushOverlay(entry({ id: 'a', onRequestClose: closeA }));
    pushOverlay(
      entry({ id: 'guard', dismissible: false, onRequestClose: closeGuard })
    );
    expect(handleOverlayBack()).toBe(true);
    expect(closeGuard).not.toHaveBeenCalled();
    expect(closeA).not.toHaveBeenCalled();
  });

  it('钻取在场：Back 先退钻取、不关本层；钻取退尽后下一次 Back 才关层', () => {
    const close = jest.fn();
    let drillDepth = 1;
    pushOverlay(
      entry({
        id: 'sheet',
        onRequestClose: close,
        onBack: () => {
          if (drillDepth === 0) return false;
          drillDepth -= 1;
          return true;
        },
      })
    );
    expect(handleOverlayBack()).toBe(true);
    expect(drillDepth).toBe(0);
    expect(close).not.toHaveBeenCalled();
    expect(handleOverlayBack()).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('handleOverlayBackFor：信号送达下层时裁决仍归栈顶', () => {
    const closeSheet = jest.fn();
    const closeDialog = jest.fn();
    pushOverlay(entry({ id: 'sheet', onRequestClose: closeSheet }));
    pushOverlay(entry({ id: 'dialog', onRequestClose: closeDialog }));
    expect(handleOverlayBackFor('sheet')).toBe(true);
    expect(closeDialog).toHaveBeenCalledTimes(1);
    expect(closeSheet).not.toHaveBeenCalled();
  });

  it('handleOverlayBackFor：栈顶不可关时下层的返回信号同样被挡', () => {
    const closeSheet = jest.fn();
    pushOverlay(entry({ id: 'sheet', onRequestClose: closeSheet }));
    pushOverlay(entry({ id: 'guard', dismissible: false }));
    expect(handleOverlayBackFor('sheet')).toBe(true);
    expect(closeSheet).not.toHaveBeenCalled();
  });
});
