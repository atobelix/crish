import type { TransitionEvent as ReactTransitionEvent } from 'react';

/**
 * 动效存在性状态：'open' 表示展示中，'closed' 表示收起中/已收起
 */
export type ModernPresenceState = 'open' | 'closed';

/**
 * useModernPresence 输入配置项
 */
export interface UseModernPresenceOptions {
  /**
   * 目标浮层当前是否应该可见/打开
   */
  visible: boolean;

  /**
   * 动效预期持续时间（毫秒），如 150, 200, 260 等。
   * 若未显式传入 safetyTimeoutMs，将依据此值计算安全兜底天花板：
   * safetyTimeoutMs = Math.max(durationMs, 150) + 50
   */
  durationMs?: number;

  /**
   * 动效预期持续时间别名（兼容写法）
   */
  duration?: number;

  /**
   * 最大安全超时兜底时间（毫秒）。
   * 防 transitionend 事件丢失（如 prefers-reduced-motion、transition: none、后台 tab 节流）导致永久挂死。
   * 若未显式指定，将自动依据 durationMs/duration 按 Math.max(duration, 150) + 50 计算；
   * 若两者均未指定，则默认 300ms。
   */
  safetyTimeoutMs?: number;

  /**
   * 触发卸载的目标 CSS 属性名（如 'opacity'、'transform'）。
   * 若指定，仅在该属性完成 transitionend 时卸载，避免多属性过渡中较快属性提前中断动画。
   * 若不指定，则任一发生在当前宿主容器上的主 transitionend 均可触发卸载。
   */
  exitProperty?: string;

  /**
   * 退出动效完成并物理卸载后的回调函数
   */
  onExitComplete?: () => void;

  /**
   * 测试环境配置：是否在 JSDOM 环境中自动旁路。
   * - 默认（undefined）：自动探测（若检测到 JSDOM 或无真实动效引擎，则在 visible 变为 false 时直接同步置 isMounted: false）；
   * - true：强制旁路；
   * - false：禁用旁路（即使在 JSDOM 环境下也走完整定时器与 transitionend 事件流，便于单测验证）。
   */
  bypassInTest?: boolean;
}

/**
 * 注入给宿主 DOM 根节点的原生动效属性与事件监听器
 */
export interface ModernPresenceProps {
  /**
   * 挂载在 DOM 上的状态标记，驱动 CSS 选择器：
   * .popover[data-state='open'] 与 .popover[data-state='closed']
   */
  'data-state': ModernPresenceState;

  /**
   * 原生 transitionend 事件处理函数，在退场动效结束时触发物理卸载
   */
  onTransitionEnd: (e: ReactTransitionEvent<any> | TransitionEvent) => void;
}

/**
 * useModernPresence 返回值结构
 */
export interface UseModernPresenceResult {
  /**
   * 当前组件是否应该挂载在 DOM 中。
   * 当 isMounted 为 false 时，消费者可直接返回 null 实施物理卸载。
   */
  isMounted: boolean;

  /**
   * 当前状态 'open' | 'closed'
   */
  dataState: ModernPresenceState;

  /**
   * 可直接展开到宿主 DOM 根容器的属性集合：{ 'data-state', onTransitionEnd }
   */
  presenceProps: ModernPresenceProps;
}
