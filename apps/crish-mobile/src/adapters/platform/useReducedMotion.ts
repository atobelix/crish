// 减动效单一信号源（手感基建批收口，工程审计 H-1 / 交互审计 D7）：
// 全仓禁止再手写 AccessibilityInfo 减动效探测——Composer 与 SlideToConfirm
// 曾各存一份几乎相同的实现，已合并至此。底层用 reanimated 的
// useReducedMotion（指南口径：与动画运行时同源、随系统设置变化即时更新）。
// 消费面（静态守卫 src/__tests__/feelInfra.guard.test.ts 钉住）：Sheet /
// Dialog / 抽屉 / Toast 的空间动画在本信号为 true 时塌缩为交叉淡化或瞬时
// 落位；新增空间动画必须消费本信号，不得另起探测。
import { useReducedMotion as useReanimatedReducedMotion } from 'react-native-reanimated';

/** 系统「减少动态效果」是否开启（true 时空间动画必须降级） */
export function useReducedMotion(): boolean {
  return useReanimatedReducedMotion();
}

export default useReducedMotion;
