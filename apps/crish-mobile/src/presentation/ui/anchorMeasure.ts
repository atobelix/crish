// 浮层锚点测量接缝（2026-11-05 返工，题 7 透传回归的落点）：
// - DropdownMenu 三家消费方（MessageActionBar / 主页 / 会话头）测量触发
//   源的统一入口：measureInWindow 全量 {x, y, width, height} 原样转出
//   （窗口坐标系），不换算、不取整——锚点几何的解算真源仍是
//   dropdownLayout.calculateDropdownLayout，本接缝只负责「测得准、传不丢」；
// - 节点缺失 / 无 measureInWindow / 测量抛错 / 零尺寸（未布局完成）时
//   不回调：调用方据此不开菜单——几何不猜测，绝不注入占位锚点（旧实现
//   在生产代码内嵌 NODE_ENV==='test' 零锚点脚手架掩盖了透传缺测，已删除）；
// - 收敛为模块接缝是为可测性：宿主 View 的 measureInWindow 在 jest 里
//   是不回调的桩、ref 实例在测试渲染器中不可达，调用方的透传契约只能
//   在模块边界钉住；本接缝自身以假节点单测覆盖映射保真（见 __tests__）。
import type { AnchorRect } from './dropdownLayout';

/** 可被测量的节点形状（RN View ref 的结构子集） */
export interface MeasurableNode {
  measureInWindow?: (
    callback: (x: number, y: number, width: number, height: number) => void
  ) => void;
}

/**
 * 测量节点窗口矩形并原样回调。测量不可用时静默不回调（调用方不开菜单）。
 */
export function measureAnchorRect(
  node: MeasurableNode | null | undefined,
  onRect: (rect: AnchorRect) => void
): void {
  if (!node || typeof node.measureInWindow !== 'function') return;
  try {
    node.measureInWindow((x, y, width, height) => {
      if (width <= 0 || height <= 0) return;
      onRect({ x, y, width, height });
    });
  } catch {
    // 测量通道异常时不开菜单（几何不猜测）
  }
}
