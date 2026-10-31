// 打开 (main) 抽屉：汉堡按钮统一入口（实现波总方案 D8）。
// 薄封装 useDrawerController：容器外调用为 no-op（深链/测试安全）。
import { useCallback } from 'react';
import { useDrawerController } from '@/presentation/components/drawer/DrawerContext';

export function useOpenDrawer(): () => void {
  const controller = useDrawerController();
  return useCallback(() => {
    controller.open();
  }, [controller]);
}

export default useOpenDrawer;
