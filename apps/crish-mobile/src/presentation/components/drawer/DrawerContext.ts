import { createContext, useContext } from 'react';

/**
 * 抽屉动作面（开/合/静默合）：与开合状态分离的稳定通道（C-PERF）——
 * 动作对象只随动画参数（弹簧/时长/减动效）变，**不随 isOpen 翻转而
 * 换 identity**。旧形态只有单一 controller：isOpen 在动画中点
 * （progress 过 0.5）翻转 → controller 对象换新 → 全体消费方重渲染，
 * 恰好砸在开合动画中段。纯动作消费方（汉堡钮、内容区导航回调）改走
 * 本通道后，翻转只惊动真正订阅 isOpen 的消费方。
 */
export interface DrawerActions {
  /** 弹簧动画展开 */
  open: () => void;
  /** 弹簧动画收起 */
  close: () => void;
  /** 无动画静默收起（跳根栈页面时的单入口编排用） */
  closeImmediate: () => void;
}

export interface DrawerController extends DrawerActions {
  /** 响应式开合状态（驱动点击关闭层与返回键订阅） */
  isOpen: boolean;
}

export const DrawerControllerContext = createContext<DrawerController | null>(
  null
);

export const DrawerActionsContext = createContext<DrawerActions | null>(null);

const NOOP_ACTIONS: DrawerActions = {
  open: () => {},
  close: () => {},
  closeImmediate: () => {},
};

/** 抽屉控制器（汉堡按钮/内容区消费；容器外调用返回 no-op，深链安全） */
export function useDrawerController(): DrawerController {
  return (
    useContext(DrawerControllerContext) ?? { ...NOOP_ACTIONS, isOpen: false }
  );
}

/** 抽屉动作（稳定 identity；容器外调用返回 no-op，深链安全） */
export function useDrawerActions(): DrawerActions {
  return (
    useContext(DrawerActionsContext) ??
    useContext(DrawerControllerContext) ??
    NOOP_ACTIONS
  );
}
