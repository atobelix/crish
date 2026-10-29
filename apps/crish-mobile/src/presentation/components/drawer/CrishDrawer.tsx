// 左侧抽屉内容：设备状态头、审批两项、今天 / 更早会话、底部搜索与设置。
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  DrawerContentScrollView,
  useDrawerStatus,
  type DrawerContentComponentProps,
} from 'expo-router/drawer';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { useSessionListVm } from '@/adapters/viewmodels/useSessionListVm';
import { DrawerFooter } from './DrawerFooter';
import { DrawerHeader } from './DrawerHeader';
import { DrawerNav } from './DrawerNav';
import { DrawerSessionGroups } from './DrawerSessionGroups';

type DrawerState = DrawerContentComponentProps['state'];

/** 当前聚焦的会话 id（只在会话路由上有值） */
export function selectedSessionIdOf(state: DrawerState): string | null {
  const params = state.routes[state.index]?.params;
  if (params && 'sessionId' in params && typeof params.sessionId === 'string') {
    return params.sessionId;
  }
  return null;
}

export function CrishDrawer(props: DrawerContentComponentProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const drawerStatus = useDrawerStatus();
  // 每次开合重算「今天」的边界，跨零点也不会分错组（渲染期按状态变化同步更新）
  const [clock, setClock] = useState(() => ({
    status: drawerStatus,
    nowMs: Date.now(),
  }));
  if (clock.status !== drawerStatus) {
    setClock({ status: drawerStatus, nowMs: Date.now() });
  }
  const vm = useSessionListVm(clock.nowMs);
  const { navigation } = props;

  // 抽屉内的会话切换只换参数；打开根 Stack 页面前先收起抽屉
  const openSession = (sessionId: string) => {
    navigation.closeDrawer();
    router.navigate(`/session/${sessionId}`);
  };
  const openRootPage = (
    href: '/approvals' | '/approval-history' | '/settings'
  ) => {
    navigation.closeDrawer();
    router.push(href);
  };

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.canvas }]}>
      <DrawerContentScrollView
        {...props}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingTop: insets.top + theme.space.sm,
          paddingHorizontal: theme.space.sm,
          paddingBottom: theme.space.lg,
        }}
      >
        <DrawerHeader
          onNewChat={() => {
            navigation.closeDrawer();
            router.navigate('/');
          }}
        />
        <DrawerNav
          onOpenApprovals={() => openRootPage('/approvals')}
          onOpenHistory={() => openRootPage('/approval-history')}
        />
        <DrawerSessionGroups
          today={vm.today}
          earlier={vm.earlier}
          hasSessions={vm.hasSessions}
          connected={vm.connected}
          selectedSessionId={selectedSessionIdOf(props.state)}
          onOpenSession={openSession}
        />
      </DrawerContentScrollView>
      <DrawerFooter
        query={vm.query}
        onChangeQuery={vm.setQuery}
        onOpenSettings={() => openRootPage('/settings')}
        bottomInset={insets.bottom}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
