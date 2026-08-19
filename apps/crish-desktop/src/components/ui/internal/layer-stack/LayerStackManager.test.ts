// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { LayerStackManager, layerStackManager } from './LayerStackManager';

describe('LayerStackManager 单核调度中枢与 50ms 冷却防重入锁', () => {
  beforeEach(() => {
    layerStackManager.dispose();
  });

  afterEach(() => {
    layerStackManager.dispose();
  });

  it('单例实例一致性验证', () => {
    const instance1 = LayerStackManager.getInstance();
    const instance2 = LayerStackManager.getInstance();
    expect(instance1).toBe(instance2);
    expect(instance1).toBe(layerStackManager);
  });

  it('50ms 冷却防重入锁状态机判定', () => {
    expect(layerStackManager.isWithinCooldown()).toBe(false);

    layerStackManager.markCloseTimestamp();
    expect(layerStackManager.isWithinCooldown(50)).toBe(true);
  });

  it('Tooltip 全局静默互斥协议 (data-floating-active)', () => {
    expect(
      document.documentElement.getAttribute('data-floating-active')
    ).toBeNull();
    expect(layerStackManager.isTooltipSilenced()).toBe(false);

    // 注册一个 dropdown-menu 浮层
    const unregister = layerStackManager.register({
      id: 'menu-1',
      type: 'dropdown-menu',
      dismissible: true,
      onDismiss: vi.fn(),
    });

    expect(document.documentElement.getAttribute('data-floating-active')).toBe(
      'true'
    );
    expect(layerStackManager.isTooltipSilenced()).toBe(true);

    // 注销浮层
    unregister();
    expect(
      document.documentElement.getAttribute('data-floating-active')
    ).toBeNull();
    // 刚注销时处于 150ms 静默冷却窗口
    expect(layerStackManager.isTooltipSilenced()).toBe(true);
  });

  it('LIFO 倒序退栈响应 Esc 键并阻止事件冒泡', () => {
    const onDismissModal = vi.fn();
    const onDismissMenu = vi.fn();

    layerStackManager.register({
      id: 'modal-1',
      type: 'modal-dialog',
      dismissible: true,
      onDismiss: onDismissModal,
    });

    layerStackManager.register({
      id: 'menu-1',
      type: 'dropdown-menu',
      dismissible: true,
      onDismiss: onDismissMenu,
    });

    // 按下 Esc 键
    const escEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    const stopPropagationSpy = vi.spyOn(escEvent, 'stopPropagation');

    window.dispatchEvent(escEvent);

    // 栈顶的 menu-1 应被退栈关闭，modal-1 保持打开
    expect(onDismissMenu).toHaveBeenCalledWith('escape');
    expect(onDismissModal).not.toHaveBeenCalled();
    expect(stopPropagationSpy).toHaveBeenCalled();
  });

  it('CJK IME 中文输入法 229 / Process / isComposing 绝对放行门闩', () => {
    const onDismissMenu = vi.fn();
    layerStackManager.register({
      id: 'menu-1',
      type: 'dropdown-menu',
      dismissible: true,
      onDismiss: onDismissMenu,
    });

    // IME 合成过程中的 Esc (keyCode 229)
    const imeEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      keyCode: 229,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(imeEvent);
    expect(onDismissMenu).not.toHaveBeenCalled();

    // isComposing = true
    const composingEvent = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(composingEvent, 'isComposing', { value: true });
    window.dispatchEvent(composingEvent);
    expect(onDismissMenu).not.toHaveBeenCalled();
  });

  it('登记 dropdown 时驱逐同级，不只入栈', () => {
    const onDismissA = vi.fn();
    const onDismissB = vi.fn();
    layerStackManager.register({
      id: 'menu-a',
      type: 'dropdown-menu',
      dismissible: true,
      onDismiss: onDismissA,
    });
    layerStackManager.register({
      id: 'menu-b',
      type: 'dropdown-menu',
      dismissible: true,
      onDismiss: onDismissB,
    });
    expect(onDismissA).toHaveBeenCalledWith('programmatic');
    expect(onDismissB).not.toHaveBeenCalled();
    expect(layerStackManager.getLayers().map((l) => l.id)).toEqual(['menu-b']);
  });

  it('子菜单锚点在已开层内时不驱逐父层', () => {
    const parentEl = document.createElement('div');
    const childAnchor = document.createElement('button');
    parentEl.appendChild(childAnchor);
    document.body.appendChild(parentEl);

    const onDismissParent = vi.fn();
    layerStackManager.register({
      id: 'parent',
      type: 'dropdown-menu',
      dismissible: true,
      onDismiss: onDismissParent,
      elementRef: { current: parentEl },
    });
    layerStackManager.register({
      id: 'child',
      type: 'dropdown-menu',
      dismissible: true,
      onDismiss: vi.fn(),
      anchorRef: { current: childAnchor },
    });
    expect(onDismissParent).not.toHaveBeenCalled();
    expect(layerStackManager.getLayers().map((l) => l.id)).toEqual([
      'parent',
      'child',
    ]);
    parentEl.remove();
  });

  it('外点关掉无锚层后，同一 pointer 落到原 target 不得再开', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    const content = document.createElement('div');
    document.body.appendChild(content);
    const onDismiss = vi.fn();
    layerStackManager.register({
      id: 'orphan-menu',
      type: 'dropdown-menu',
      dismissible: true,
      onDismiss,
      elementRef: { current: content },
      anchorRef: { current: null },
    });
    btn.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    );
    expect(onDismiss).toHaveBeenCalledWith('outside-pointer');
    expect(layerStackManager.wasLayerDismissedThisGesture('orphan-menu')).toBe(
      true
    );
    expect(layerStackManager.wasTriggerClickAfterDismiss(btn)).toBe(true);
    btn.remove();
    content.remove();
  });

  it('外点关 A 时点在 B 的 trigger 上，不抑制 B', () => {
    const btnA = document.createElement('button');
    const btnB = document.createElement('button');
    const contentA = document.createElement('div');
    document.body.append(contentA, btnA, btnB);
    const onDismissA = vi.fn();
    layerStackManager.register({
      id: 'menu-a',
      type: 'dropdown-menu',
      dismissible: true,
      onDismiss: onDismissA,
      elementRef: { current: contentA },
      anchorRef: { current: btnA },
    });
    btnB.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    );
    expect(onDismissA).toHaveBeenCalledWith('outside-pointer');
    expect(layerStackManager.wasTriggerClickAfterDismiss(btnA)).toBe(true);
    expect(layerStackManager.wasTriggerClickAfterDismiss(btnB)).toBe(false);
    contentA.remove();
    btnA.remove();
    btnB.remove();
  });

  it('Trace 审计历史记录正常工作', () => {
    const onDismiss = vi.fn();
    const unregister = layerStackManager.register({
      id: 'trace-test-1',
      type: 'popover',
      dismissible: true,
      onDismiss,
    });

    unregister();

    const trace = layerStackManager.getTraceHistory();
    expect(trace.length).toBe(1);
    expect(trace[0]?.id).toBe('trace-test-1');
    expect(trace[0]?.dismissReason).toBe('programmatic');
  });
});
