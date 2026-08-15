/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LayerStackService } from './LayerStackService';

describe('LayerStackService (WO-20, WO-22, WO-25, WO-27)', () => {
  let service: LayerStackService;

  beforeEach(() => {
    service = LayerStackService.getInstance();
  });

  afterEach(() => {
    service.dispose();
  });

  describe('基础注册与注销', () => {
    it('应正确注册浮层并在栈中维护 LIFO 顺序', () => {
      const dismiss1 = vi.fn();
      const dismiss2 = vi.fn();

      const unreg1 = service.register({
        id: 'layer-1',
        type: 'modal-dialog',
        dismissible: true,
        onDismiss: dismiss1,
      });

      const unreg2 = service.register({
        id: 'layer-2',
        type: 'dropdown-menu',
        dismissible: true,
        onDismiss: dismiss2,
      });

      expect(service.getLayers().length).toBe(2);
      expect(service.getTopLayer()?.id).toBe('layer-2');

      unreg2();
      expect(service.getLayers().length).toBe(1);
      expect(service.getTopLayer()?.id).toBe('layer-1');

      unreg1();
      expect(service.getLayers().length).toBe(0);
      expect(service.getTopLayer()).toBeUndefined();
    });

    it('重复 ID 注册应自动覆盖旧项', () => {
      service.register({
        id: 'unique-layer',
        type: 'modal-dialog',
        dismissible: true,
        onDismiss: vi.fn(),
      });

      service.register({
        id: 'unique-layer',
        type: 'confirm-dialog',
        dismissible: false,
        onDismiss: vi.fn(),
      });

      expect(service.getLayers().length).toBe(1);
      expect(service.getTopLayer()?.type).toBe('confirm-dialog');
    });

    it('父节点注销时应安全解除孤儿节点的 parentId 悬空指针', () => {
      service.register({
        id: 'parent',
        type: 'modal-dialog',
        dismissible: true,
        onDismiss: vi.fn(),
      });

      service.register({
        id: 'child',
        type: 'dropdown-menu',
        parentId: 'parent',
        dismissible: true,
        onDismiss: vi.fn(),
      });

      expect(service.getLayers().find((l) => l.id === 'child')?.parentId).toBe(
        'parent'
      );

      service.unregister('parent');

      expect(service.getLayers().length).toBe(1);
      expect(
        service.getLayers().find((l) => l.id === 'child')?.parentId
      ).toBeUndefined();
    });
  });

  describe('自顶向下退栈与 Esc 分发 (LIFO 单点消费与 First Responder 搜索)', () => {
    it('在 3 层浮层同时注册时，按 Esc 严格按 L3 -> L2 -> L1 逐级单次关闭', () => {
      const dismissL1 = vi.fn();
      const dismissL2 = vi.fn();
      const dismissL3 = vi.fn();

      service.register({
        id: 'L1-dialog',
        type: 'modal-dialog',
        dismissible: true,
        onDismiss: dismissL1,
      });

      service.register({
        id: 'L2-menu',
        type: 'dropdown-menu',
        parentId: 'L1-dialog',
        dismissible: true,
        onDismiss: dismissL2,
      });

      service.register({
        id: 'L3-tooltip',
        type: 'tooltip',
        parentId: 'L2-menu',
        dismissible: true,
        onDismiss: dismissL3,
      });

      // 1st Esc -> closes L3
      const evt1 = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(evt1);

      expect(dismissL3).toHaveBeenCalledWith('escape');
      expect(dismissL2).not.toHaveBeenCalled();
      expect(dismissL1).not.toHaveBeenCalled();
      expect(evt1.defaultPrevented).toBe(true);

      // 2nd Esc -> closes L2
      const evt2 = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(evt2);

      expect(dismissL2).toHaveBeenCalledWith('escape');
      expect(dismissL1).not.toHaveBeenCalled();
      expect(evt2.defaultPrevented).toBe(true);

      // 3rd Esc -> closes L1
      const evt3 = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(evt3);

      expect(dismissL1).toHaveBeenCalledWith('escape');
      expect(evt3.defaultPrevented).toBe(true);
      expect(service.getLayers().length).toBe(0);
    });

    it('栈顶为 dismissible: false 的非模态层时，应向下穿透寻找首个可关闭层', () => {
      const dismissModal = vi.fn();
      const dismissToast = vi.fn();

      service.register({
        id: 'modal',
        type: 'modal-dialog',
        dismissible: true,
        onDismiss: dismissModal,
      });

      service.register({
        id: 'toast',
        type: 'toast',
        dismissible: false,
        modal: false,
        onDismiss: dismissToast,
      });

      const evt = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(evt);

      expect(dismissToast).not.toHaveBeenCalled();
      expect(dismissModal).toHaveBeenCalledWith('escape');
      expect(evt.defaultPrevented).toBe(true);
    });

    it('栈顶为 dismissible: false 的强制模态层（modal: true）时，应直接消费并阻断，不向下击穿', () => {
      const dismissUnderlying = vi.fn();
      const dismissForcedWizard = vi.fn();

      service.register({
        id: 'underlying-dialog',
        type: 'modal-dialog',
        dismissible: true,
        onDismiss: dismissUnderlying,
      });

      service.register({
        id: 'forced-wizard',
        type: 'modal-dialog',
        modal: true,
        dismissible: false,
        onDismiss: dismissForcedWizard,
      });

      const evt = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(evt);

      expect(dismissForcedWizard).not.toHaveBeenCalled();
      expect(dismissUnderlying).not.toHaveBeenCalled();
      expect(evt.defaultPrevented).toBe(true);
    });

    it('自定义 onEscapeKeyDown 返回 true 时消费事件，不触发默认 onDismiss', () => {
      const dismiss = vi.fn();
      const onEscape = vi.fn().mockReturnValue(true);

      service.register({
        id: 'custom-escape-layer',
        type: 'modal-dialog',
        dismissible: true,
        onDismiss: dismiss,
        onEscapeKeyDown: onEscape,
      });

      const evt = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(evt);

      expect(onEscape).toHaveBeenCalled();
      expect(dismiss).not.toHaveBeenCalled();
      expect(evt.defaultPrevented).toBe(true);
    });
  });

  describe('快捷键录制态 (Virtual Interceptor) 最高优先级直通', () => {
    it('registerVirtual 注册的虚拟拦截器置于栈顶优先响应', () => {
      const dismissDialog = vi.fn();
      const onRecordEscape = vi.fn().mockReturnValue(true);

      service.register({
        id: 'settings-dialog',
        type: 'modal-dialog',
        dismissible: true,
        onDismiss: dismissDialog,
      });

      const unregisterVirtual = service.registerVirtual(
        'shortcut-recorder',
        onRecordEscape
      );

      const evt = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(evt);

      expect(onRecordEscape).toHaveBeenCalled();
      expect(dismissDialog).not.toHaveBeenCalled();
      expect(evt.defaultPrevented).toBe(true);

      unregisterVirtual();

      const evt2 = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(evt2);

      expect(dismissDialog).toHaveBeenCalledWith('escape');
    });
  });

  describe('CJK IME 输入法合成态保护 (WO-25)', () => {
    it('isComposing 为 true 时绝对放行按键，不拦截不 preventDefault', () => {
      const dismiss = vi.fn();
      service.register({
        id: 'test-layer',
        type: 'dropdown-menu',
        dismissible: true,
        onDismiss: dismiss,
      });

      const evt = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(evt, 'isComposing', { value: true });

      document.dispatchEvent(evt);

      expect(dismiss).not.toHaveBeenCalled();
      expect(evt.defaultPrevented).toBe(false);
    });

    it('keyCode 为 229 时绝对放行按键', () => {
      const dismiss = vi.fn();
      service.register({
        id: 'test-layer',
        type: 'dropdown-menu',
        dismissible: true,
        onDismiss: dismiss,
      });

      const evt = new KeyboardEvent('keydown', {
        key: 'Escape',
        keyCode: 229,
        bubbles: true,
        cancelable: true,
      });

      document.dispatchEvent(evt);

      expect(dismiss).not.toHaveBeenCalled();
      expect(evt.defaultPrevented).toBe(false);
    });

    it('key 为 Process 时绝对放行按键', () => {
      const dismiss = vi.fn();
      service.register({
        id: 'test-layer',
        type: 'dropdown-menu',
        dismissible: true,
        onDismiss: dismiss,
      });

      const evt = new KeyboardEvent('keydown', {
        key: 'Process',
        bubbles: true,
        cancelable: true,
      });

      document.dispatchEvent(evt);

      expect(dismiss).not.toHaveBeenCalled();
      expect(evt.defaultPrevented).toBe(false);
    });
  });

  describe('PointerDown Branch-Aware 外点判定', () => {
    it('点击在顶层浮层内部时不触发外点关闭', () => {
      const dismiss = vi.fn();
      const container = document.createElement('div');
      const innerButton = document.createElement('button');
      container.appendChild(innerButton);
      document.body.appendChild(container);

      service.register({
        id: 'menu-layer',
        type: 'dropdown-menu',
        elementRef: container,
        dismissible: true,
        onDismiss: dismiss,
      });

      const evt = new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
      });
      innerButton.dispatchEvent(evt);

      expect(dismiss).not.toHaveBeenCalled();
      document.body.removeChild(container);
    });

    it('点击在子孙 Branch 浮层内部时不误关父级浮层', () => {
      const dismissParent = vi.fn();
      const dismissChild = vi.fn();

      const parentContainer = document.createElement('div');
      const childContainer = document.createElement('div');
      const childButton = document.createElement('button');
      childContainer.appendChild(childButton);
      document.body.appendChild(parentContainer);
      document.body.appendChild(childContainer);

      service.register({
        id: 'parent-menu',
        type: 'dropdown-menu',
        elementRef: parentContainer,
        dismissible: true,
        onDismiss: dismissParent,
      });

      service.register({
        id: 'child-tooltip',
        type: 'tooltip',
        parentId: 'parent-menu',
        elementRef: childContainer,
        dismissible: true,
        onDismiss: dismissChild,
      });

      const evt = new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
      });
      childButton.dispatchEvent(evt);

      expect(dismissParent).not.toHaveBeenCalled();
      expect(dismissChild).not.toHaveBeenCalled();

      document.body.removeChild(parentContainer);
      document.body.removeChild(childContainer);
    });

    it('点击在外部区域时仅关闭顶层 Layer', () => {
      const dismiss1 = vi.fn();
      const dismiss2 = vi.fn();

      const container1 = document.createElement('div');
      const container2 = document.createElement('div');
      const outsideEl = document.createElement('div');
      document.body.appendChild(container1);
      document.body.appendChild(container2);
      document.body.appendChild(outsideEl);

      service.register({
        id: 'layer-1',
        type: 'modal-dialog',
        elementRef: container1,
        dismissible: true,
        onDismiss: dismiss1,
      });

      service.register({
        id: 'layer-2',
        type: 'dropdown-menu',
        elementRef: container2,
        dismissible: true,
        onDismiss: dismiss2,
      });

      const evt = new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
      });
      outsideEl.dispatchEvent(evt);

      expect(dismiss2).toHaveBeenCalledWith('outside-pointer');
      expect(dismiss1).not.toHaveBeenCalled();

      document.body.removeChild(container1);
      document.body.removeChild(container2);
      document.body.removeChild(outsideEl);
    });
  });

  describe('级联关闭与生命周期 Trace 审计', () => {
    it('关闭父浮层时自动级联关闭其所有子孙浮层', () => {
      const dismissParent = vi.fn();
      const dismissChild1 = vi.fn();
      const dismissChild2 = vi.fn();

      service.register({
        id: 'parent',
        type: 'modal-dialog',
        dismissible: true,
        onDismiss: dismissParent,
      });

      service.register({
        id: 'child-1',
        type: 'dropdown-menu',
        parentId: 'parent',
        dismissible: true,
        onDismiss: dismissChild1,
      });

      service.register({
        id: 'child-2',
        type: 'cascade-submenu',
        parentId: 'child-1',
        dismissible: true,
        onDismiss: dismissChild2,
      });

      service.dismissLayer('parent', 'escape');

      expect(dismissChild2).toHaveBeenCalledWith('parent-dismissed');
      expect(dismissChild1).toHaveBeenCalledWith('parent-dismissed');
      expect(dismissParent).toHaveBeenCalledWith('escape');
      expect(service.getLayers().length).toBe(0);
    });

    it('正确记录生命周期 Trace 审计日志', () => {
      service.clearTraceHistory();

      service.register({
        id: 'dialog-1',
        type: 'modal-dialog',
        dismissible: true,
        onDismiss: vi.fn(),
      });

      service.register({
        id: 'menu-1',
        type: 'dropdown-menu',
        parentId: 'dialog-1',
        dismissible: true,
        onDismiss: vi.fn(),
      });

      service.dismissLayer('dialog-1', 'escape');

      const traces = service.getTraceHistory();
      expect(traces.length).toBe(2);

      const menuTrace = traces.find((t) => t.id === 'menu-1');
      expect(menuTrace).toBeDefined();
      expect(menuTrace?.type).toBe('dropdown-menu');
      expect(menuTrace?.parentId).toBe('dialog-1');
      expect(menuTrace?.dismissReason).toBe('parent-dismissed');
      expect(typeof menuTrace?.mountedAt).toBe('number');
      expect(typeof menuTrace?.dismissedAt).toBe('number');

      const dialogTrace = traces.find((t) => t.id === 'dialog-1');
      expect(dialogTrace).toBeDefined();
      expect(dialogTrace?.dismissReason).toBe('escape');
    });

    it('hasActiveModal 正确识别活跃模态弹窗', () => {
      expect(service.hasActiveModal()).toBe(false);

      const unreg1 = service.register({
        id: 'tooltip',
        type: 'tooltip',
        dismissible: true,
        onDismiss: vi.fn(),
      });
      expect(service.hasActiveModal()).toBe(false);

      const unreg2 = service.register({
        id: 'dialog',
        type: 'modal-dialog',
        dismissible: true,
        onDismiss: vi.fn(),
      });
      expect(service.hasActiveModal()).toBe(true);

      unreg2();
      expect(service.hasActiveModal()).toBe(false);
      unreg1();
    });
  });
});
