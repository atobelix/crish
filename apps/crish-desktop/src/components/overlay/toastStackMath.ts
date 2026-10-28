/**
 * 通知堆叠系统几何与物理纯函数模块 (Toast Stack Math)
 * 遵循 docs/arc-library-animation-study/implementation-plans/03-通知堆叠系统现代化方案.md
 */

export interface StackTarget {
  y: number; // 纵向物理偏移量 (px)
  scale: number; // 缩放比例
  height: number; // 动画目标高度 (px)
  opacity: number; // 卡片整体透明度 (0 | 1)
  content: number; // 卡片内部文本与控件透明度 (0 | 1)
  origin: string; // 缩放变换原点 (CSS transform-origin)
}

export interface LayoutStackResult {
  targets: StackTarget[];
  listHeight: number; // 连续悬停画布外框真实高度 (px)
}

/** 物理堆叠常量配置 */
export const STACK_CONSTANTS = {
  PEEK: 14, // 折叠态每层卡片露头高度 (px)
  GAP: 12, // 展开态卡片之间的物理间距 (px)
  STEP: 0.05, // 折叠态每往深层退步缩放递减 (5%)
  BORDER: 2, // 边框补正 (px)
  DEFAULT_HEIGHT: 48, // 测量未就绪时的保底高度 (px)
} as const;

/**
 * layoutStack: 堆叠几何纯函数计算器
 * @param toasts 活跃通知队列 (最前排为 index 0)
 * @param heights 卡片 ID 到实测高度的映射字典
 * @param expanded 是否处于展开态 (悬停/聚焦)
 * @param visibleToasts 允许渲染的最大可见层数 (默认 3)
 * @param isTop 视口是否锚定于顶部 (true: 顶部居中/左右; false: 底部居中/左右)
 */
export function layoutStack(
  toasts: readonly { id: string }[],
  heights: Record<string, number>,
  expanded: boolean,
  visibleToasts: number = 3,
  isTop: boolean = true
): LayoutStackResult {
  const { PEEK, GAP, STEP, DEFAULT_HEIGHT } = STACK_CONSTANTS;
  const count = toasts.length;
  if (count === 0) {
    return { targets: [], listHeight: 0 };
  }

  // 1. 提取最前排卡片的高度 (Front Height)
  const frontId = toasts[0]!.id;
  const frontHeight = heights[frontId] ?? DEFAULT_HEIGHT;

  // 2. 计算展开态前缀和高度 (Tops prefix sums)
  // tops[i] 表示第 i 张卡片在展开态下的起始累加偏移量
  const tops = toasts.reduce<number[]>(
    (acc, item, index) => {
      const currentH = heights[item.id] ?? DEFAULT_HEIGHT;
      const step = index < visibleToasts ? currentH + GAP : 0;
      return [...acc, acc[index]! + step];
    },
    [0]
  );

  // 3. 方向符号因子: 顶部锚定向下排布 (+1), 底部锚定向上排布 (-1)
  const dir = isTop ? 1 : -1;
  // 变换原点: 顶部锚定以顶边向内缩 (50% 0), 底部锚定以底边向内缩 (50% 100%)
  const origin = isTop ? '50% 0' : '50% 100%';

  // 4. 映射每张卡片的几何形态
  const targets = toasts.map((item, index): StackTarget => {
    const visible = index < visibleToasts;
    const depth = Math.min(index, visibleToasts);
    const itemHeight = heights[item.id] ?? DEFAULT_HEIGHT;

    if (expanded) {
      // 展开态: 每张卡片恢复独立实测高度, 间距为 GAP, 内容完全可见
      const y = dir * tops[index]! || 0;
      return {
        y,
        scale: 1,
        height: itemHeight,
        opacity: visible ? 1 : 0,
        content: 1,
        origin: '50% 50%',
      };
    }

    // 折叠态核心力学:
    // A. 高度归一化: 后排卡片强制统一使用 frontHeight, 下边缘平整严丝合缝
    // B. 露头偏移: y = dir * (PEEK * depth)
    // C. 缩放阶梯: scale = 1 - STEP * depth
    // D. 内容遮蔽: 后排卡片 content 置 0, 杜绝半透明磨砂底板下的透字与噪点
    const y = dir * (PEEK * depth) || 0;
    return {
      y,
      scale: Math.max(0.5, 1 - STEP * depth),
      height: index === 0 ? itemHeight : frontHeight,
      opacity: visible ? 1 : 0,
      content: index === 0 ? 1 : 0,
      origin,
    };
  });

  // 5. 动态计算外框画布高度 (listHeight)
  const visibleCount = Math.min(count, visibleToasts);
  const listHeight = expanded
    ? Math.max(0, tops[count]! - GAP)
    : frontHeight + PEEK * (visibleCount - 1);

  return { targets, listHeight };
}

/**
 * 苹果双曲橡皮筋阻尼计算
 * @param distance 超出边界的拉动距离 (>= 0)
 * @param dimension 容器的主轴尺寸 (如卡片宽度)
 * @returns 经过非线性衰减后的物理像素位移
 */
export function rubberBand(distance: number, dimension: number): number {
  if (
    !Number.isFinite(distance) ||
    !Number.isFinite(dimension) ||
    distance <= 0 ||
    dimension <= 0
  ) {
    return 0;
  }
  return (1 - 1 / ((distance * 0.55) / dimension + 1)) * dimension;
}

/**
 * 惯性滑行停止位置投影 (速度投影模型)
 * @param velocity 释放瞬时速度 (px/s)
 * @returns 预估自然滑行距离 (px)
 */
export function projectVelocity(velocity: number): number {
  if (!Number.isFinite(velocity)) return 0;
  return (velocity / 1000) * (0.99 / (1 - 0.99)); // 0.099 * velocity
}
