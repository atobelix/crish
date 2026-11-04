// 打开 (main) 抽屉：汉堡按钮统一入口（实现波总方案 D8）。
// 走稳定动作面 useDrawerActions（C-PERF）：旧实现依赖整个 controller，
// isOpen 在开合动画中点翻转 → controller 换 identity → 本回调跟着换、
// 全体汉堡钮消费方在动画中段重渲染。动作面不随 isOpen 变，本回调
// 自此跨翻转稳定。容器外调用为 no-op（深链/测试安全）。
import { useCallback } from 'react';
import { useDrawerActions } from '@/presentation/components/drawer/DrawerContext';

export function useOpenDrawer(): () => void {
  const actions = useDrawerActions();
  return useCallback(() => {
    actions.open();
  }, [actions]);
}

export default useOpenDrawer;
