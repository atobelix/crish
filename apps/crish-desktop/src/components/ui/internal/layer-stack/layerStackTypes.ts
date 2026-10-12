/**
 * 浮层栈类型契约与常量（拆分自 LayerStackManager）。
 */

import type React from 'react';

export type LayerType =
  | 'modal-dialog' // 全局模态弹窗（SettingsPanel, SkillEditorModal, FirstRunWizard）
  | 'confirm-dialog' // 二次确认对话框（ConfirmDialog）
  | 'drawer' // 抽屉浮层（ChatStatusRibbons, PlanDrawer）
  | 'context-menu' // 右键上下文菜单（SessionContextMenu, SidebarMenu）
  | 'dropdown-menu' // 下拉菜单（Menu, Select, ModelPicker）
  | 'cascade-submenu' // 级联二级子菜单（ContextMenuFlyout, Submenu）
  | 'popover' // 普通气泡（TiptapSlashMenu, Popover）
  | 'tooltip' // 悬浮提示（Tooltip）
  | 'toast' // 全局通知（ToastStack）
  | 'virtual-interceptor'; // 虚拟拦截器（快捷键录制态、分屏拖拽态）

export type DismissReason =
  | 'escape' // 按下 Esc 键退出
  | 'outside-pointer' // 点击外部区域退出
  | 'item-select' // 选中菜单项退出
  | 'programmatic' // 代码显式命令式调用退出
  | 'parent-dismissed'; // 父层被销毁导致级联关闭

export interface LayerRegistration {
  /** 唯一标识 */
  id: string;
  /** 浮层语义类型 */
  type: LayerType;
  /** 父浮层 ID（用于三层级联拓扑追踪） */
  parentId?: string;
  /** 浮层容器的 DOM 引用（虚拟拦截层为 undefined） */
  elementRef?: React.RefObject<HTMLElement | null> | HTMLElement | null;
  /** 挂载的 Portal 容器节点 */
  portalContainer?: HTMLElement | null;
  /** 关联的触发源节点（用于外点判定豁免与焦点还原） */
  anchorRef?: React.RefObject<HTMLElement | null> | HTMLElement | null;
  /** 是否允许通过 Esc / 外点关闭 */
  dismissible: boolean;
  /** 是否为模态层（阻断外部交互） */
  modal?: boolean;
  /** 显式指定的焦点还原目标 */
  restoreFocusTarget?: HTMLElement | null;
  /** 浮层关闭回调 */
  onDismiss: (reason: DismissReason) => void;
  /**
   * Esc 键盘按下时的定制钩子
   * @returns true 表示浮层内部已消费此事件（如子状态回退、快捷键录制），中枢不执行默认 onDismiss
   */
  onEscapeKeyDown?: (event: KeyboardEvent) => boolean | void;
  /**
   * 外点交互按下时的定制钩子
   * @returns true 表示拦截外点关闭
   */
  onPointerDownOutside?: (event: PointerEvent) => boolean | void;
  /** 注册时间戳（用于稳定排序与 Trace 审计） */
  mountedAt: number;
}

export interface LayerTraceRecord {
  id: string;
  type: LayerType;
  parentId?: string;
  mountedAt: number;
  dismissedAt: number;
  dismissReason: DismissReason;
}

export interface DismissedByPointerSnapshot {
  pointerId: number;
  layerId: string;
  anchor: HTMLElement | null;
  target: EventTarget | null;
  timestamp: number;
}

export const LAYER_TYPE_PRIORITY: Record<LayerType, number> = {
  'modal-dialog': 10,
  'confirm-dialog': 15,
  drawer: 20,
  popover: 30,
  'dropdown-menu': 40,
  'context-menu': 40,
  'cascade-submenu': 50,
  tooltip: 60,
  toast: 70,
  'virtual-interceptor': 100,
};

/** 点击展开互斥：全仓所有非模态弹出型浮层统一互斥，登记时驱逐同级 */
export const EXCLUSIVE_PEER_LAYER_TYPES: ReadonlySet<LayerType> = new Set([
  'dropdown-menu',
  'context-menu',
  'cascade-submenu',
  'popover',
]);

export function isExclusivePeerLayerType(type: LayerType): boolean {
  return EXCLUSIVE_PEER_LAYER_TYPES.has(type);
}

export const PROCESSED_EVENTS = new WeakSet<Event>();

/**
 * 解析 Ref 或 DOM 元素（纯工具，供中枢与焦点还原复用）。
 */
export function resolveElement(
  ref?: React.RefObject<HTMLElement | null> | HTMLElement | null
): HTMLElement | null {
  if (!ref) return null;
  if ('current' in ref) return ref.current;
  return ref;
}
