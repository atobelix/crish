/**
 * 视口分页锚点与防抖契约类型定义
 * 文件位置：apps/crish-desktop/src/components/chat-message-list/pagingAnchorTypes.ts
 *
 * 严格对齐 DIM-02 §1.2 / §1.3 与评审报告 03 / 04 核心测试资产保护铁律：
 * 1. PagingAnchor 视口语义锚点凭据（key 与相对 top 偏移）
 * 2. PagingAnchorState 视口状态机（observedTopRef 账本、lastScrollTop、isPinLocked）
 * 3. ScrollDeltaAssertion 视口相对位移差量数学断言契约（ΔY ≡ 0 守护）
 * 4. PreActionAnchor 主动交互前置快照锚点契约（折叠/展开预挂载补偿）
 */

import type React from 'react';
import type { MessageDelta } from '../../api/MessageSnapshots';

/**
 * 亚像素微调门槛（px）
 * 绝对偏差 >= 0.5px 才调整 scrollTop，避免浮点舍入导致的 1px 震荡
 */
export const SUBPIXEL_TOLERANCE_PX = 0.5;

/**
 * 地表收缩容差窗口（px）
 * Windows 125%/150% DPI 缩放下，被动钳位可能产生 0.2~0.8px 舍入误差，
 * ε = 2.0px 用于拦截误判主动上滑。
 */
export const SCROLL_FLOOR_EPSILON = 2.0;

/**
 * 默认行节点选择器：兼容全新 ChatNodeSeat 与已有虚拟列表 data-vindex
 */
export const DEFAULT_ITEM_SELECTOR = '[data-chat-node-key], [data-vindex]';

/**
 * 视口稳定语义锚点凭据
 */
export interface PagingAnchor {
  /** 锚点消息唯一主键（messageId / chatNodeKey） */
  key: string;
  /** 锚点行顶部相对滚动容器内顶部的相对位移（px，通常 <= 0） */
  top: number;
}

/**
 * PagingAnchor 状态机契约
 * 统一收敛 observedTopRef 账本、最后滚动位置与贴底/锁定态
 */
export interface PagingAnchorState {
  /**
   * 视口观测基准账本 Ref
   * 记录经算法认证的最新视口顶部位置，用于识别地表收缩被动钳位并拦截误杀
   */
  observedTopRef: { current: number } | React.MutableRefObject<number>;
  /** 上一次确认的滚动条物理 scrollTop (px) */
  lastScrollTop: number;
  /** 是否处于置顶吸附或流式吸附锁定态 (isPinLocked / stickToBottomLock) */
  isPinLocked: boolean;
  /** 当前待补偿或活跃的锚点凭据 */
  anchor?: PagingAnchor | null;
  /** 是否位于物理滚动容器底部 (isAtBottom) */
  isAtBottom?: boolean;
}

/**
 * 视口相对位移差量数学断言契约
 * 校验锚点在 DOM 形变/前置插入/折叠前后的视口绝对位移偏差 ΔY ≡ 0
 */
export interface ScrollDeltaAssertion {
  /** 锚点行唯一主键 */
  anchorKey: string;
  /** 动作前锚点在视口内的相对坐标 (px) */
  beforeTop: number;
  /** 动作后锚点在视口内的相对坐标 (px) */
  afterTop: number;
  /** 视口相对位移差量: ΔY = afterTop - beforeTop (px) */
  deltaY: number;
  /** 允许的最大位移容差 (px) */
  tolerance: number;
  /** 数学断言判定：|ΔY| <= tolerance */
  passed: boolean;
}

/**
 * 创建视口位移断言对象并校验 ΔY ≡ 0
 */
export function createScrollDeltaAssertion(
  anchorKey: string,
  beforeTop: number,
  afterTop: number,
  tolerance: number = SUBPIXEL_TOLERANCE_PX
): ScrollDeltaAssertion {
  const deltaY = afterTop - beforeTop;
  return {
    anchorKey,
    beforeTop,
    afterTop,
    deltaY,
    tolerance,
    passed: Math.abs(deltaY) <= tolerance,
  };
}

/**
 * 主动交互前置快照锚点凭据契约
 * 用于折叠/展开、思维链收起等主动交互引发的大面积形变
 */
export interface PreActionAnchor {
  /** 捕获到的视口稳定锚点 */
  anchor: PagingAnchor | null;
  /** 快照捕获时滚动容器的 scrollTop (px) */
  snapshotScrollTop: number;
  /** 快照捕获时滚动容器的 scrollHeight (px) */
  snapshotScrollHeight: number;
  /** 快照捕获时间戳 (ms) */
  timestamp: number;
}

/**
 * 主动交互防抖 Hook 返回值契约
 */
export interface PreActionAnchorHookResult {
  /** 包裹可能引发内部大面积形变的动作函数 */
  wrapAction: <T>(action: () => T) => T;
  /** 捕获当前视口快照 */
  captureSnapshot: () => PreActionAnchor | null;
  /** Pre-paint 阶段手动或自动恢复锚点 */
  restoreSnapshot: () => void;
  /** 当前待补偿快照的 Ref 引用 */
  pendingAnchorRef: { current: PreActionAnchor | null } | React.MutableRefObject<PreActionAnchor | null>;
}

/**
 * 撤销/重做操作结果契约（继承自旧 useUndoWithScrollAnchor）
 */
export interface UndoWithScrollAnchorResult {
  restoredDelta?: MessageDelta;
  [key: string]: unknown;
}

/**
 * 视口双径补偿参数契约
 */
export interface PagingCompensationOptions {
  /** DOM 节点选择器 */
  itemSelector?: string;
  /** 亚像素容差阈值 (px) */
  subpixelTolerance?: number;
}
