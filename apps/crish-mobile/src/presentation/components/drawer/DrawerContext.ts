import { createContext, useContext } from 'react';

export interface DrawerController {
  /** 弹簧动画展开 */
  open: () => void;
  /** 弹簧动画收起 */
  close: () => void;
  /** 无动画静默收起（跳根栈页面时的单入口编排用） */
  closeImmediate: () => void;
  /** 响应式开合状态（驱动点击关闭层与返回键订阅） */
  isOpen: boolean;
}

export const DrawerControllerContext = createContext<DrawerController | null>(
  null
);

/** 抽屉控制器（汉堡按钮/内容区消费；容器外调用返回 no-op，深链安全） */
export function useDrawerController(): DrawerController {
  return (
    useContext(DrawerControllerContext) ?? {
      open: () => {},
      close: () => {},
      closeImmediate: () => {},
      isOpen: false,
    }
  );
}
