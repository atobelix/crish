// 打开 (main) 抽屉：供新对话页与会话页的汉堡按钮使用。
import { useCallback } from 'react';
import { useNavigation } from 'expo-router';
import { DrawerActions } from 'expo-router/react-navigation';

export function useOpenDrawer(): () => void {
  const navigation = useNavigation();
  return useCallback(() => {
    navigation.dispatch(DrawerActions.openDrawer());
  }, [navigation]);
}
