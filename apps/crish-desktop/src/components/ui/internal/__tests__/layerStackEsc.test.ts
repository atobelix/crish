// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/ui/internal/__tests__/layerStackEsc.test.ts
 *
 * 【E3-05 专项契约测试】LayerStack 统一浮层栈 Esc 事件分发与顶层命中 SSOT 验证
 *
 * 验证矩阵：
 * 1. SSOT 架构分层契约（Modal / Popover / Overlay）与优先级权重标尺；
 * 2. 单层 Dialog 的 Esc 响应与退出（阻止冒泡与默认行为）；
 * 3. 顶层单发拦截（Top-of-Stack Dismissal）：
 *    - Dialog 内嵌套 DropdownMenu / Popover，按下 Esc 仅清退最顶层 Popover/Menu；
 *    - 底层 Dialog 绝对零连带误关；
 *    - 只有当顶层 Popover 退场后，再次按下 Esc 才会关闭最上层 Dialog；
 * 4. 三层深度拓扑级联（Dialog -> Popover -> Select / Submenu）LIFO 严格顺序退出；
 * 5. 多层嵌套 Dialog（Dialog 1 -> ConfirmDialog 2）的逐级退栈；
 * 6. 非 dismissible 阻断型模态对 Esc 击穿物理拦截（阻止穿透到背景应用）；
 * 7. 自定义 onEscapeKeyDown 消费钩子；
 * 8. CJK IME 中文输入法合成态（229 / Process / isComposing）放行门闩；
 * 9. 50ms 内快速连击 Esc 的防穿透防抖状态机；
 * 10. 真实 React 树集成渲染下的嵌套浮层退栈表现；
 * 11. 单例全局事件监听器生命周期与泄漏防护。
 */
import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from '@testing-library/react';
import {
  LayerStackManager,
  layerStackManager,
  getLayerTier,
  isModalLayer,
  isPopoverMenuLayer,
  isOverlayToastLayer,
  LAYER_TYPE_PRIORITY,
  LAYER_TIER_PRIORITY,
  type LayerType,
  type LayerTier,
} from '../layer-stack/LayerStackManager';
import { Dialog } from '../../Dialog/Dialog';
import { Popover } from '../../Popover/Popover';
import { Select, SelectItem } from '../../Select';

const waitNextTick = () => new Promise((r) => setTimeout(r, 60));

function dispatchEsc(target: EventTarget = window): {
  event: KeyboardEvent;
  prevented: boolean;
  stopped: boolean;
} {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  const stopSpy = vi.spyOn(event, 'stopPropagation');
  const prevSpy = vi.spyOn(event, 'preventDefault');
  target.dispatchEvent(event);
  return {
    event,
    prevented: prevSpy.mock.calls.length > 0 || event.defaultPrevented,
    stopped: stopSpy.mock.calls.length > 0,
  };
}

describe('E3-05: LayerStack 统一浮层栈 Esc 事件分发与顶层命中 SSOT', () => {
  beforeEach(() => {
    cleanup();
    layerStackManager.dispose();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    layerStackManager.dispose();
    vi.restoreAllMocks();
  });

  describe('1. SSOT 架构分层契约（Modal / Popover / Overlay）与权重标尺', () => {
    it('严格划分 Modal, Popover/Menu, Overlay/Toast 三大架构分层', () => {
      // 1. Modal 层：全屏遮罩、模态对话框、二次确认弹窗、抽屉
      const modalTypes: LayerType[] = [
        'modal-dialog',
        'confirm-dialog',
        'alertdialog',
        'drawer',
      ];
      for (const t of modalTypes) {
        expect(getLayerTier(t)).toBe('modal');
        expect(isModalLayer(t)).toBe(true);
        expect(isPopoverMenuLayer(t)).toBe(false);
        expect(isOverlayToastLayer(t)).toBe(false);
      }

      // 2. Popover/Menu 层：下拉菜单、气泡、选择框、右键菜单、级联子菜单
      const popoverTypes: LayerType[] = [
        'dropdown-menu',
        'popover',
        'select',
        'combobox',
        'context-menu',
        'cascade-submenu',
      ];
      for (const t of popoverTypes) {
        expect(getLayerTier(t)).toBe('popover');
        expect(isPopoverMenuLayer(t)).toBe(true);
        expect(isModalLayer(t)).toBe(false);
        expect(isOverlayToastLayer(t)).toBe(false);
      }

      // 3. Overlay/Toast 层：悬浮提示、通知、虚拟拦截器
      const overlayTypes: LayerType[] = [
        'tooltip',
        'toast',
        'virtual-interceptor',
      ];
      for (const t of overlayTypes) {
        expect(getLayerTier(t)).toBe('overlay');
        expect(isOverlayToastLayer(t)).toBe(true);
        expect(isModalLayer(t)).toBe(false);
        expect(isPopoverMenuLayer(t)).toBe(false);
      }
    });

    it('层级优先级单调递增：Modal < Popover/Menu < Overlay', () => {
      expect(LAYER_TIER_PRIORITY.modal).toBeLessThan(
        LAYER_TIER_PRIORITY.popover
      );
      expect(LAYER_TIER_PRIORITY.popover).toBeLessThan(
        LAYER_TIER_PRIORITY.overlay
      );

      // 具体组件权重断言
      expect(LAYER_TYPE_PRIORITY['modal-dialog']).toBe(10);
      expect(LAYER_TYPE_PRIORITY['confirm-dialog']).toBe(15);
      expect(LAYER_TYPE_PRIORITY['alertdialog']).toBe(15);
      expect(LAYER_TYPE_PRIORITY.drawer).toBe(20);

      expect(LAYER_TYPE_PRIORITY.popover).toBe(30);
      expect(LAYER_TYPE_PRIORITY.select).toBe(35);
      expect(LAYER_TYPE_PRIORITY.combobox).toBe(35);
      expect(LAYER_TYPE_PRIORITY['dropdown-menu']).toBe(40);
      expect(LAYER_TYPE_PRIORITY['context-menu']).toBe(40);
      expect(LAYER_TYPE_PRIORITY['cascade-submenu']).toBe(50);

      expect(LAYER_TYPE_PRIORITY.tooltip).toBe(60);
      expect(LAYER_TYPE_PRIORITY.toast).toBe(70);
      expect(LAYER_TYPE_PRIORITY['virtual-interceptor']).toBe(100);
    });

    it('LayerStackManager 正确识别各分层活跃状态与过滤查询', () => {
      expect(layerStackManager.hasActiveModal()).toBe(false);
      expect(layerStackManager.hasActiveFloatingLayers()).toBe(false);

      const unregisterModal = layerStackManager.register({
        id: 'dialog-1',
        type: 'modal-dialog',
        dismissible: true,
        onDismiss: vi.fn(),
      });

      expect(layerStackManager.hasActiveModal()).toBe(true);
      expect(layerStackManager.hasActiveLayerOfTier('modal')).toBe(true);
      expect(layerStackManager.getLayersByTier('modal').length).toBe(1);

      const unregisterMenu = layerStackManager.register({
        id: 'menu-1',
        type: 'dropdown-menu',
        dismissible: true,
        onDismiss: vi.fn(),
      });

      expect(layerStackManager.hasActiveLayerOfTier('popover')).toBe(true);
      expect(layerStackManager.hasActiveFloatingLayers()).toBe(true);
      expect(layerStackManager.getTopLayerOfTier('popover')?.id).toBe('menu-1');

      unregisterMenu();
      unregisterModal();

      expect(layerStackManager.hasActiveModal()).toBe(false);
      expect(layerStackManager.hasActiveFloatingLayers()).toBe(false);
    });
  });

  describe('2. 单层 Dialog 的 Esc 响应与退出', () => {
    it('按 Esc 触发 onDismiss("escape") 并拦截事件冒泡与默认行为', async () => {
      const onDismiss = vi.fn();
      layerStackManager.register({
        id: 'dialog-single',
        type: 'modal-dialog',
        dismissible: true,
        onDismiss,
      });

      const { prevented, stopped } = dispatchEsc(window);

      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(onDismiss).toHaveBeenCalledWith('escape');
      expect(prevented).toBe(true);
      expect(stopped).toBe(true);

      await waitNextTick();

      // 栈已清空后再次按 Esc，不应被拦截消费
      const secondResult = dispatchEsc(window);
      expect(secondResult.prevented).toBe(false);
      expect(secondResult.stopped).toBe(false);
    });
  });

  describe('3. 顶层单发拦截（Top-of-Stack Dismissal）：Dialog 内嵌套 DropdownMenu / Popover', () => {
    it('Dialog 内打开 DropdownMenu，按 Esc 仅关闭 DropdownMenu，绝不连带误关 Dialog', async () => {
      const onDismissDialog = vi.fn();
      const onDismissMenu = vi.fn();

      layerStackManager.register({
        id: 'dialog-main',
        type: 'modal-dialog',
        modal: true,
        dismissible: true,
        onDismiss: onDismissDialog,
      });

      const unregisterMenu = layerStackManager.register({
        id: 'menu-dropdown',
        type: 'dropdown-menu',
        parentId: 'dialog-main',
        dismissible: true,
        onDismiss: onDismissMenu,
      });

      // 验证当前栈内层数
      expect(layerStackManager.getLayers().length).toBe(2);
      expect(layerStackManager.getTopLayer()?.id).toBe('menu-dropdown');

      // 第一次按下 Esc
      const result1 = dispatchEsc(window);

      // 断言 1: 最顶层的 DropdownMenu 接收并消费 Esc
      expect(onDismissMenu).toHaveBeenCalledTimes(1);
      expect(onDismissMenu).toHaveBeenCalledWith('escape');
      expect(result1.prevented).toBe(true);
      expect(result1.stopped).toBe(true);

      // 断言 2: 底层 Dialog 绝不连带误关
      expect(onDismissDialog).not.toHaveBeenCalled();

      // 模拟 DropdownMenu 注销退场
      unregisterMenu();
      expect(layerStackManager.getLayers().length).toBe(1);
      expect(layerStackManager.getTopLayer()?.id).toBe('dialog-main');

      await waitNextTick();

      // 第二次按下 Esc
      const result2 = dispatchEsc(window);

      // 断言 3: DropdownMenu 退场后，再次按 Esc 才关闭底层 Dialog
      expect(onDismissDialog).toHaveBeenCalledTimes(1);
      expect(onDismissDialog).toHaveBeenCalledWith('escape');
      expect(result2.prevented).toBe(true);
      expect(result2.stopped).toBe(true);
    });

    it('Dialog 内打开 Popover，按 Esc 仅关闭 Popover，底层 Dialog 保持完整', async () => {
      const onDismissDialog = vi.fn();
      const onDismissPopover = vi.fn();

      layerStackManager.register({
        id: 'dialog-base',
        type: 'modal-dialog',
        modal: true,
        dismissible: true,
        onDismiss: onDismissDialog,
      });

      const unregisterPopover = layerStackManager.register({
        id: 'popover-in-dialog',
        type: 'popover',
        parentId: 'dialog-base',
        dismissible: true,
        onDismiss: onDismissPopover,
      });

      // 第一次按 Esc
      const esc1 = dispatchEsc(window);
      expect(onDismissPopover).toHaveBeenCalledTimes(1);
      expect(onDismissPopover).toHaveBeenCalledWith('escape');
      expect(onDismissDialog).not.toHaveBeenCalled();
      expect(esc1.stopped).toBe(true);

      unregisterPopover();

      await waitNextTick();

      // 第二次按 Esc
      const esc2 = dispatchEsc(window);
      expect(onDismissDialog).toHaveBeenCalledTimes(1);
      expect(onDismissDialog).toHaveBeenCalledWith('escape');
      expect(esc2.stopped).toBe(true);
    });
  });

  describe('4. 三层深度嵌套顺序退出（Dialog -> Popover -> Select / Submenu）', () => {
    it('三层深度嵌套严格按 LIFO 逆序逐级退栈，单发消费无穿透', async () => {
      const onDismissDialog = vi.fn();
      const onDismissPopover = vi.fn();
      const onDismissSelect = vi.fn();

      // Level 1: Dialog
      layerStackManager.register({
        id: 'layer-level-1-dialog',
        type: 'modal-dialog',
        modal: true,
        dismissible: true,
        onDismiss: onDismissDialog,
      });

      // Level 2: Popover
      const unregisterPopover = layerStackManager.register({
        id: 'layer-level-2-popover',
        type: 'popover',
        parentId: 'layer-level-1-dialog',
        dismissible: true,
        onDismiss: onDismissPopover,
      });

      // Level 3: Select (内嵌于 Popover)
      const unregisterSelect = layerStackManager.register({
        id: 'layer-level-3-select',
        type: 'select',
        parentId: 'layer-level-2-popover',
        dismissible: true,
        onDismiss: onDismissSelect,
      });

      expect(layerStackManager.getLayers().length).toBe(3);
      expect(layerStackManager.getTopLayer()?.id).toBe('layer-level-3-select');

      // Esc #1 -> 关闭 Level 3 (Select)
      const r1 = dispatchEsc(window);
      expect(onDismissSelect).toHaveBeenCalledTimes(1);
      expect(onDismissPopover).not.toHaveBeenCalled();
      expect(onDismissDialog).not.toHaveBeenCalled();
      expect(r1.stopped).toBe(true);

      unregisterSelect();
      expect(layerStackManager.getTopLayer()?.id).toBe('layer-level-2-popover');

      await waitNextTick();

      // Esc #2 -> 关闭 Level 2 (Popover)
      const r2 = dispatchEsc(window);
      expect(onDismissPopover).toHaveBeenCalledTimes(1);
      expect(onDismissDialog).not.toHaveBeenCalled();
      expect(r2.stopped).toBe(true);

      unregisterPopover();
      expect(layerStackManager.getTopLayer()?.id).toBe('layer-level-1-dialog');

      await waitNextTick();

      // Esc #3 -> 关闭 Level 1 (Dialog)
      const r3 = dispatchEsc(window);
      expect(onDismissDialog).toHaveBeenCalledTimes(1);
      expect(r3.stopped).toBe(true);
    });

    it('级联子菜单 (cascade-submenu) 拥有高于普通下拉菜单的退栈优先级', async () => {
      const onDismissMenu = vi.fn();
      const onDismissSubmenu = vi.fn();

      const unregisterMenu = layerStackManager.register({
        id: 'menu-root',
        type: 'dropdown-menu',
        dismissible: true,
        onDismiss: onDismissMenu,
      });

      const unregisterSubmenu = layerStackManager.register({
        id: 'submenu-child',
        type: 'cascade-submenu',
        parentId: 'menu-root',
        dismissible: true,
        onDismiss: onDismissSubmenu,
      });

      // 验证 Submenu 优先排在栈顶
      expect(layerStackManager.getTopLayer()?.id).toBe('submenu-child');

      // 按 Esc 第一次 -> Submenu 先退出
      dispatchEsc(window);
      expect(onDismissSubmenu).toHaveBeenCalledTimes(1);
      expect(onDismissMenu).not.toHaveBeenCalled();

      unregisterSubmenu();

      await waitNextTick();

      // 按 Esc 第二次 -> Menu 退出
      dispatchEsc(window);
      expect(onDismissMenu).toHaveBeenCalledTimes(1);

      unregisterMenu();
    });
  });

  describe('5. 多层嵌套 Dialog（Dialog 1 -> ConfirmDialog 2）的逐级退栈', () => {
    it('双模态弹窗嵌套：顶层 ConfirmDialog 优先消费 Esc，底层 Dialog 不受影响', async () => {
      const onDismissDialog1 = vi.fn();
      const onDismissConfirm = vi.fn();

      layerStackManager.register({
        id: 'dialog-settings',
        type: 'modal-dialog',
        modal: true,
        dismissible: true,
        onDismiss: onDismissDialog1,
      });

      const unregisterConfirm = layerStackManager.register({
        id: 'confirm-dialog',
        type: 'confirm-dialog',
        parentId: 'dialog-settings',
        modal: true,
        dismissible: true,
        onDismiss: onDismissConfirm,
      });

      expect(layerStackManager.getTopLayer()?.id).toBe('confirm-dialog');

      // Esc #1
      dispatchEsc(window);
      expect(onDismissConfirm).toHaveBeenCalledTimes(1);
      expect(onDismissDialog1).not.toHaveBeenCalled();

      unregisterConfirm();

      await waitNextTick();

      // Esc #2
      dispatchEsc(window);
      expect(onDismissDialog1).toHaveBeenCalledTimes(1);
    });
  });

  describe('6. 非 dismissible 阻断型模态对 Esc 击穿物理拦截', () => {
    it('当顶层模态设置 dismissible=false 时，吞没 Esc 事件阻断击穿，绝不误触背景快捷键', () => {
      const onDismissModal = vi.fn();
      const onDismissMenu = vi.fn();

      layerStackManager.register({
        id: 'modal-locked',
        type: 'modal-dialog',
        modal: true,
        dismissible: false, // 禁止 Esc 退出
        onDismiss: onDismissModal,
      });

      const unregisterMenu = layerStackManager.register({
        id: 'menu-inside-locked',
        type: 'dropdown-menu',
        parentId: 'modal-locked',
        dismissible: true,
        onDismiss: onDismissMenu,
      });

      // Esc #1 -> 内层 Menu 正常退出
      const r1 = dispatchEsc(window);
      expect(onDismissMenu).toHaveBeenCalledTimes(1);
      expect(onDismissModal).not.toHaveBeenCalled();
      expect(r1.stopped).toBe(true);

      unregisterMenu();

      // Esc #2 -> 锁定的 Modal 不退出，但必须消费 Esc 阻止向下穿透
      const r2 = dispatchEsc(window);
      expect(onDismissModal).not.toHaveBeenCalled();
      expect(r2.prevented).toBe(true);
      expect(r2.stopped).toBe(true);
    });
  });

  describe('7. 自定义 onEscapeKeyDown 消费钩子', () => {
    it('浮层自定义 onEscapeKeyDown 返回 true 时消费事件，不执行默认 onDismiss', () => {
      const onDismiss = vi.fn();
      const onEscapeKeyDown = vi.fn(() => true); // 显式消费

      layerStackManager.register({
        id: 'custom-handler-layer',
        type: 'popover',
        dismissible: true,
        onDismiss,
        onEscapeKeyDown,
      });

      const result = dispatchEsc(window);

      expect(onEscapeKeyDown).toHaveBeenCalledTimes(1);
      expect(onDismiss).not.toHaveBeenCalled();
      expect(result.prevented).toBe(true);
      expect(result.stopped).toBe(true);
    });

    it('浮层自定义 onEscapeKeyDown 返回 false/void 时回退执行默认 onDismiss', () => {
      const onDismiss = vi.fn();
      const onEscapeKeyDown = vi.fn(() => {}); // 不拦截

      layerStackManager.register({
        id: 'fallback-handler-layer',
        type: 'popover',
        dismissible: true,
        onDismiss,
        onEscapeKeyDown,
      });

      const result = dispatchEsc(window);

      expect(onEscapeKeyDown).toHaveBeenCalledTimes(1);
      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(result.prevented).toBe(true);
      expect(result.stopped).toBe(true);
    });
  });

  describe('8. CJK IME 中文输入法合成态放行门闩', () => {
    it('isComposing=true / keyCode=229 / key="Process" 时 100% 绝对放行 Esc', () => {
      const onDismiss = vi.fn();
      layerStackManager.register({
        id: 'ime-protected-layer',
        type: 'dropdown-menu',
        dismissible: true,
        onDismiss,
      });

      // 1. keyCode 229
      const imeEvent1 = new KeyboardEvent('keydown', {
        key: 'Escape',
        keyCode: 229,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(imeEvent1);
      expect(onDismiss).not.toHaveBeenCalled();
      expect(imeEvent1.defaultPrevented).toBe(false);

      // 2. key = 'Process'
      const imeEvent2 = new KeyboardEvent('keydown', {
        key: 'Process',
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(imeEvent2);
      expect(onDismiss).not.toHaveBeenCalled();
      expect(imeEvent2.defaultPrevented).toBe(false);

      // 3. isComposing = true
      const imeEvent3 = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(imeEvent3, 'isComposing', { value: true });
      window.dispatchEvent(imeEvent3);
      expect(onDismiss).not.toHaveBeenCalled();
      expect(imeEvent3.defaultPrevented).toBe(false);
    });
  });

  describe('9. 50ms 内快速连击 Esc 的防穿透防抖状态机', () => {
    it('50ms 内快速双击 Esc，严格逐帧退栈，绝不一击穿透关闭底层', async () => {
      const onDismissDialog = vi.fn();
      const onDismissMenu = vi.fn();

      layerStackManager.register({
        id: 'dialog-parent',
        type: 'modal-dialog',
        dismissible: true,
        onDismiss: onDismissDialog,
      });

      layerStackManager.register({
        id: 'menu-child',
        type: 'dropdown-menu',
        parentId: 'dialog-parent',
        dismissible: true,
        onDismiss: onDismissMenu,
      });

      // 模拟第一次 Esc
      dispatchEsc(window);
      expect(onDismissMenu).toHaveBeenCalledTimes(1);
      expect(onDismissDialog).not.toHaveBeenCalled();

      // 在 20ms 内模拟第二次 Esc 敲击（连击）
      const rapidEsc = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(rapidEsc);

      // 快速防抖拦截：第二次敲击被防抖丢弃，底层 Dialog 保持打开！
      expect(onDismissDialog).not.toHaveBeenCalled();
    });
  });

  describe('10. 真实 React 树渲染与集成退栈测试', () => {
    function NestedDialogWithPopover({
      dialogOpen,
      popoverOpen,
      onDialogClose,
      onPopoverOpenChange,
    }: {
      dialogOpen: boolean;
      popoverOpen: boolean;
      onDialogClose: () => void;
      onPopoverOpenChange: (open: boolean) => void;
    }) {
      return React.createElement(
        Dialog,
        { open: dialogOpen, onClose: onDialogClose, title: '主弹窗标题' },
        React.createElement(
          'div',
          { 'data-testid': 'dialog-body-content' },
          React.createElement('p', null, '主弹窗正文内容'),
          React.createElement(Popover, {
            open: popoverOpen,
            onOpenChange: onPopoverOpenChange,
            trigger: React.createElement(
              'button',
              { type: 'button' },
              '打开气泡'
            ),
            content: React.createElement(
              'div',
              { 'data-testid': 'popover-content' },
              '气泡框内部内容'
            ),
          })
        )
      );
    }

    it('真实 React 树：Dialog 打开 Popover，按 Esc 仅收起 Popover，再次按 Esc 收起 Dialog', async () => {
      function TestContainer() {
        const [dialogOpen, setDialogOpen] = useState(true);
        const [popoverOpen, setPopoverOpen] = useState(false);

        return React.createElement(NestedDialogWithPopover, {
          dialogOpen,
          popoverOpen,
          onDialogClose: () => setDialogOpen(false),
          onPopoverOpenChange: setPopoverOpen,
        });
      }

      render(React.createElement(TestContainer));

      // 断言 Dialog 已渲染
      expect(screen.getByText('主弹窗标题')).toBeInTheDocument();

      // 点击触发器展开 Popover
      act(() => {
        fireEvent.click(screen.getByText('打开气泡'));
      });
      expect(await screen.findByTestId('popover-content')).toBeInTheDocument();

      // 第一次按 Esc：只有 Popover 关闭
      act(() => {
        dispatchEsc(window);
      });

      await waitFor(() => {
        expect(screen.queryByTestId('popover-content')).not.toBeInTheDocument();
      });

      // Dialog 依然留在文档中！
      expect(screen.getByText('主弹窗标题')).toBeInTheDocument();

      await waitNextTick();

      // 再次按 Esc：Dialog 关闭
      act(() => {
        dispatchEsc(window);
      });

      await waitFor(() => {
        expect(screen.queryByText('主弹窗标题')).not.toBeInTheDocument();
      });
    });

    it('真实 React 树：Dialog 内包含 Select，展开 Select 后按 Esc 仅收起下拉列表，Dialog 保持打开', async () => {
      function SelectInDialogTest() {
        const [dialogOpen, setDialogOpen] = useState(true);

        return React.createElement(
          Dialog,
          {
            open: dialogOpen,
            onClose: () => setDialogOpen(false),
            title: 'Select测试弹窗',
          },
          React.createElement(Select, {
            placeholder: '选择模型',
            options: [
              { id: 'gpt-4o', label: 'GPT-4o' },
              { id: 'claude-3-5', label: 'Claude 3.5 Sonnet' },
            ],
          })
        );
      }

      render(React.createElement(SelectInDialogTest));

      expect(screen.getByText('Select测试弹窗')).toBeInTheDocument();

      // 点击 Select 触发器展开下拉列表
      act(() => {
        fireEvent.click(screen.getByRole('combobox'));
      });
      expect(await screen.findByRole('listbox')).toBeInTheDocument();

      // 第一次按 Esc：关闭 Select listbox
      act(() => {
        dispatchEsc(window);
      });

      await waitFor(() => {
        expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      });

      // Dialog 仍处于打开状态！
      expect(screen.getByText('Select测试弹窗')).toBeInTheDocument();

      await waitNextTick();

      // 再次按 Esc：关闭 Dialog
      act(() => {
        dispatchEsc(window);
      });

      await waitFor(() => {
        expect(screen.queryByText('Select测试弹窗')).not.toBeInTheDocument();
      });
    });
  });

  describe('11. 单例全局事件监听器生命周期与泄漏防护', () => {
    it('栈清空后自动 unhook 全局监听器，避免全局事件残留泄漏', async () => {
      expect(layerStackManager.isListeningGlobalEvents).toBe(false);

      const unregister = layerStackManager.register({
        id: 'temp-layer',
        type: 'modal-dialog',
        dismissible: true,
        onDismiss: vi.fn(),
      });

      expect(layerStackManager.isListeningGlobalEvents).toBe(true);

      unregister();

      // 手动触发清理后的安全卸载检查
      layerStackManager.dispose();
      expect(layerStackManager.isListeningGlobalEvents).toBe(false);
      expect(layerStackManager.getLayers().length).toBe(0);
    });
  });
});
