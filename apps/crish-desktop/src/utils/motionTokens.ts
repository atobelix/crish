/**
 * 动效 token 的 TS 侧镜像 —— 与 tokens.css 的 --duration-* / --ease-* 一一对应。
 *
 * 单一真理路径约束：
 * - 全仓组件禁止内联毫秒时长与 cubic-bezier 曲线字面量；JS 需要动效值时只允许
 *   从本模块取用，CSS 只允许从 tokens.css 取用；
 * - 两侧同步由 tabStripMotionContract 守卫测试锁定，改值必须两处同改（测试会拦截漂移）。
 */

import type { Transition } from 'motion/react';

/** 标准缓动：色彩 / 透明度 / 常规过渡（对应 --ease-standard） */
export const EASE_STANDARD = 'cubic-bezier(0.4, 0, 0.2, 1)';

/** 强调缓动：几何位移（flex-basis / transform / margin），快出型，服务光标追踪（对应 --ease-emphasized） */
export const EASE_EMPHASIZED = 'cubic-bezier(0.16, 1, 0.3, 1)';

/** 微交互时长（对应 --duration-micro） */
export const DURATION_MICRO_MS = 100;

/** 爽快微交互时长（毫秒，对应 tokens.css 中的 --duration-snappy） */
export const DURATION_SNAPPY_MS = 120;

/** 快速几何时长（对应 --duration-fast） */
export const DURATION_FAST_MS = 150;

/** 常规时长（对应 --duration-normal） */
export const DURATION_NORMAL_MS = 200;

/** 手风琴折叠展开平滑过渡时长（对应 tokens.css 中 --transition-accordion 220ms） */
export const DURATION_ACCORDION_MS = 220;

/** 手风琴内部插槽渐隐/渐显时长（对应 tokens.css 中 --duration-accordion-fade 180ms） */
export const DURATION_ACCORDION_FADE_MS = 180;

/** 新对话落地框平滑变形过渡时长（对应 tokens.css 中 --transition-landing-settle 260ms） */
export const DURATION_LANDING_SETTLE_MS = 260;

/** 新对话落地品牌渐隐时长（对应 tokens.css 中 --duration-landing-fade 260ms） */
export const DURATION_LANDING_FADE_MS = 260;

/** 减速入场曲线（对应 tokens.css 中的 --ease-decelerate） */
export const EASE_DECELERATE = 'cubic-bezier(0.2, 0, 0, 1)';

/** 加速退场曲线（对应 tokens.css 中的 --ease-accelerate） */
export const EASE_ACCELERATE = 'cubic-bezier(0.4, 0, 1, 1)';

/**
 * 37 点高精临界阻尼原生弹簧曲线（与 tokens-base.css 中的 --ease-spring 1:1 严格对齐）
 */
export const EASE_SPRING_LINEAR =
  'linear(0, 0.0213, 0.0739, 0.1443, 0.2235, 0.305, 0.3849, 0.4606, 0.5305, 0.594, 0.6508, 0.7011, 0.7452, 0.7836, 0.8168, 0.8454, 0.8699, 0.8907, 0.9084, 0.9234, 0.9361, 0.9467, 0.9557, 0.9632, 0.9694, 0.9747, 0.979, 0.9826, 0.9857, 0.9882, 0.9902, 0.992, 0.9934, 0.9946, 0.9955, 0.9963, 1)';

/** 弹簧过渡时长毫秒常量（与 tokens-base.css --duration-spring-* 保持同步） */
export const DURATION_SPRING_SNAPPY_MS = 260;
export const DURATION_SPRING_SMOOTH_MS = 400;
export const DURATION_SPRING_MORPH_MS = 420;
export const DURATION_SPRING_MS = 580;

/** 消息发送入场时效守卫窗口常量（Batch 3 消息发送入场飞行专用） */
export const BUBBLE_ENTRANCE_WINDOW_MS = 2000;
export const BUBBLE_ENTRANCE_CLOCK_SKEW_TOLERANCE_MS = 500;

/** 动效时长常量单一真相源（与 tokens.css 严格同步） */
export const MOTION_DURATION = {
  MICRO_MS: DURATION_MICRO_MS,
  SNAPPY_MS: DURATION_SNAPPY_MS,
  FAST_MS: DURATION_FAST_MS,
  NORMAL_MS: DURATION_NORMAL_MS,
  ACCORDION_MS: DURATION_ACCORDION_MS,
  ACCORDION_FADE_MS: DURATION_ACCORDION_FADE_MS,
  LANDING_SETTLE_MS: DURATION_LANDING_SETTLE_MS,
  LANDING_FADE_MS: DURATION_LANDING_FADE_MS,
  SPRING_SNAPPY_MS: DURATION_SPRING_SNAPPY_MS,
  SPRING_SMOOTH_MS: DURATION_SPRING_SMOOTH_MS,
  SPRING_MORPH_MS: DURATION_SPRING_MORPH_MS,
  SPRING_MS: DURATION_SPRING_MS,
} as const;

/** 消息气泡入场时效配置单一真理源 */
export const BUBBLE_ENTRANCE_CONFIG = {
  MAX_AGE_MS: BUBBLE_ENTRANCE_WINDOW_MS,
  CLOCK_SKEW_TOLERANCE_MS: BUBBLE_ENTRANCE_CLOCK_SKEW_TOLERANCE_MS,
} as const;

/**
 * 读取元素上指定 transition 属性的真实时长（毫秒）。
 * 返回的是 computed 值，已包含 reduced-motion 全局覆盖后的实际效果；
 * 解析不到时返回 0，由调用方决定兜底。
 */
export function readTransitionMs(
  el: HTMLElement,
  propertyName: string
): number {
  const cs = getComputedStyle(el);
  const props = cs.transitionProperty.split(',').map((s) => s.trim());
  const durations = cs.transitionDuration.split(',').map((s) => {
    const trimmed = s.trim();
    const val = Number.parseFloat(trimmed) || 0;
    return trimmed.endsWith('ms') ? val : Math.round(val * 1000);
  });
  const idx = props.indexOf(propertyName);
  return idx >= 0 ? (durations[idx] ?? 0) : (durations[0] ?? 0);
}

/**
 * 读取 :root 上形如 "150ms cubic-bezier(...)" 的组合 token 的时长部分（毫秒）。
 * 解析不到返回 fallback。
 */
export function readTokenMs(varName: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  const m = /([\d.]+)(ms|s)\b/.exec(raw);
  if (!m) return fallback;
  const numStr = m[1];
  if (!numStr) return fallback;
  const n = Number.parseFloat(numStr);
  return m[2] === 's' ? n * 1000 : n;
}

/** 临界阻尼弹簧配置标量参数 */
export interface VisualSpringConfig {
  /** 物理弹簧类型标识 */
  readonly type: 'spring';
  /** 人眼视觉感知时长（秒） */
  readonly visualDuration: number;
  /** 反弹弹性系数（0 表示临界阻尼无超调） */
  readonly bounce: number;
}

/** 传统机械刚度阻尼弹簧配置 */
export interface StiffnessSpringConfig {
  readonly type: 'spring';
  readonly stiffness: number;
  readonly damping: number;
  readonly mass?: number;
}

/** 物理求解器转换扩展选项 */
export interface SpringPhysicalOptions {
  /** 运动休眠的位移阈值（默认 0.001） */
  readonly restDelta?: number;
  /** 运动休眠的速度阈值（默认 restDelta * 2） */
  readonly restSpeed?: number;
  /** 振子等效质量（默认 1） */
  readonly mass?: number;
}

/** 速度连续性物理弹簧 Transition 规格 */
export type SpringTransition = Transition & {
  type: 'spring';
  stiffness: number;
  damping: number;
  mass: number;
  restDelta?: number;
  restSpeed?: number;
};

/**
 * 结构化弹簧预设集合（供 Motion v13 动效组件使用）
 * 核心哲学：snappy / smooth / morph 均采用 bounce: 0（临界阻尼），绝不抖动
 */
export const MOTION_SPRING = {
  /** 极速响应微交互：按钮、开关滑块、标签指示器（visualDuration: 0.26s, bounce: 0） */
  snappy: { type: 'spring', visualDuration: 0.26, bounce: 0 } as const,

  /** 舒展结构几何：面板展开折叠、抽屉滑入（visualDuration: 0.40s, bounce: 0） */
  smooth: { type: 'spring', visualDuration: 0.4, bounce: 0 } as const,

  /** 共享布局与尺寸形变：Tab 胶囊移动、动态内容自适应宽（visualDuration: 0.42s, bounce: 0） */
  morph: { type: 'spring', visualDuration: 0.42, bounce: 0 } as const,

  /** 机械高响应弹簧：stiffness: 520, damping: 44 */
  responsive: { type: 'spring', stiffness: 520, damping: 44 } as const,

  /** 机械柔和弹簧：stiffness: 340, damping: 34 */
  gentle: { type: 'spring', stiffness: 340, damping: 34 } as const,

  /** 二阶谐振子物理弹簧（Switch / Slider / SegmentedControl 严紧无超调微动效） */
  harmonic: { type: 'spring', stiffness: 420, damping: 32, bounce: 0 } as const,
} as const;

/** 二阶谐振子物理弹簧单一真理源（Switch 滑块、Slider 手柄与填充条、SegmentedControl） */
export const SPRING_SWITCH_SLIDER = MOTION_SPRING.harmonic;

/**
 * 四级交错步长常量（秒）
 */
export const MOTION_STAGGER = {
  char: 0.016, // 16ms: 单字符打字机或渐现
  item: 0.035, // 35ms: 列表条目/选项卡
  word: 0.04, // 40ms: 自然语言词汇涌现
  line: 0.08, // 80ms: 段落换行升起
  maxTotal: 0.4, // 400ms: 全局交错熔断上限
} as const;

/**
 * 动态模糊像素常量（px）
 */
export const MOTION_BLUR = {
  subtle: 2, // 2px: 数字滚动防闪
  soft: 4, // 4px: 界面视图交错过渡
  text: 8, // 8px: 标题变形重叠
} as const;

/**
 * 将人眼感知的 visualDuration 与 bounce 转换为具备速度连续性的 stiffness 与 damping。
 *
 * 力学转换数学推导：
 * 固有角频率 root = omega_0 = (2 * PI) / (visualDuration * 1.2)
 * 弹簧刚度 stiffness = k = root^2 * mass
 * 临界阻尼比 c_crit = 2 * sqrt(k * mass) = 2 * root * mass
 * 阻尼系数 damping = c = c_crit * (1 - bounce) = 2 * (1 - bounce) * root * mass
 *
 * 验收断言：
 * - 当 bounce = 0 时，damping = 2 * root * mass，阻尼比 zeta = 1.0，严格临界阻尼无超调；
 * - 飞行中途重靶向时继承瞬时初速度 v0，消除一切视觉跳变断层。
 */
export function springPhysical(
  config: { visualDuration: number; bounce?: number },
  options?: SpringPhysicalOptions
): SpringTransition {
  const { visualDuration, bounce = 0 } = config;
  const mass = options?.mass ?? 1;
  const restDelta = options?.restDelta ?? 0.001;
  const restSpeed = options?.restSpeed ?? restDelta * 2;

  // 固有特征根计算（加入 1.2 视觉平缓系数对齐人眼感知）
  const root = (2 * Math.PI) / (Math.max(visualDuration, 0.01) * 1.2);
  const stiffness = root * root * mass;
  const damping = 2 * Math.max(1 - bounce, 0) * root * Math.sqrt(mass);

  return {
    type: 'spring',
    stiffness: Number.parseFloat(stiffness.toFixed(3)),
    damping: Number.parseFloat(damping.toFixed(3)),
    mass,
    restDelta,
    restSpeed,
  };
}

/**
 * 安全交错步长计算器（带总延迟上限熔断机制）
 *
 * @param count 待渲染的项目总数
 * @param preferredStep 偏好的单项步长（秒，默认 0.035s）
 * @param maxTotal 允许的整体最大交错时间跨度（秒，默认 0.4s）
 * @returns 经过安全自适应压缩后的单项步长（秒）
 */
export function calculateSafeStagger(
  count: number,
  preferredStep: number = MOTION_STAGGER.item,
  maxTotal: number = MOTION_STAGGER.maxTotal
): number {
  if (count <= 1) return 0;
  // 若按偏好步长累加的总耗时超过上限，则平滑线性压缩步长
  const totalWithPreferred = (count - 1) * preferredStep;
  if (totalWithPreferred <= maxTotal) {
    return preferredStep;
  }
  return Number.parseFloat((maxTotal / (count - 1)).toFixed(4));
}

/**
 * 距离自适应手风琴折叠展开物理时长计算器。
 * 替代全局生硬死板的固定 220ms，根据内容物理真实位移高度动态推导。
 *
 * @param height 展开目标高度（像素）
 * @param isOpening 是否为展开动作（true 为展开，false 为收起）
 * @returns 毫秒时长（整数）
 */
export function calcAccordionDuration(
  height: number,
  isOpening: boolean
): number {
  const safeHeight = Math.max(0, Number.isFinite(height) ? height : 0);

  if (isOpening) {
    // 展开：180ms 起步，上限 480ms
    const raw = 180 + 90 * Math.log(1 + safeHeight / 120);
    return Math.round(Math.min(480, Math.max(180, raw)));
  } else {
    // 收起：150ms 起步，上限 350ms（收起动作要求更为干净敏捷）
    const raw = 150 + 65 * Math.log(1 + safeHeight / 120);
    return Math.round(Math.min(350, Math.max(150, raw)));
  }
}
