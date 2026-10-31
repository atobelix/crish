// 抽屉面板内容（实现波总方案 D8 版式重排）：
// 顶部吸顶【搜索胶囊 + 扫一扫】（键盘弹起永不遮挡）；中部【审批导航 + 会话列表】；
// 底部单行通栏【头像昵称 → 设置 → 新对话】。全部样式走 theme token，零描边。
import { useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { usePathname, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, avatarToneFor } from '@/adapters/platform/theme';
import { useSessionListVm } from '@/adapters/viewmodels/useSessionListVm';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import { useApprovalStore } from '@/adapters/hooks/useAppStore';
import { countUserDecisions } from '@/domain/pure/approvalAttention';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import { AppText, IconButton } from '@/presentation/ui';
import { SessionListItem } from '@/presentation/components/sessions/SessionListItem';
import { useDrawerController } from './DrawerContext';

/** 从当前路径解析聚焦会话 id（/session/[id]） */
export function selectedSessionIdOf(pathname: string): string | null {
  const match = /^\/session\/([^/]+)/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

function displayNameOf(profile: {
  displayName?: string;
  email?: string | null;
}): { name: string; initial: string } {
  const name =
    profile.displayName?.trim() || profile.email?.trim() || '本地用户';
  const initial = [...name][0]?.toUpperCase() ?? 'C';
  return { name, initial };
}

export function CrishDrawerContent() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const controller = useDrawerController();
  const pathname = usePathname();
  const selectedSessionId = selectedSessionIdOf(pathname ?? '');
  const accountUser = useAccountStore((s) => s.user);
  const profile = useAccountStore((s) => s.profile);
  const pending = useApprovalStore((s) => s.pending);
  const approvalCount = useMemo(() => countUserDecisions(pending), [pending]);

  // 每次展开重算「今天」分组边界（跨零点不分错组）；isOpen 翻转时刷新 nowMs
  const [clock, setClock] = useState(() => ({
    open: controller.isOpen,
    nowMs: Date.now(),
  }));
  if (clock.open !== controller.isOpen) {
    setClock({ open: controller.isOpen, nowMs: Date.now() });
  }
  const vm = useSessionListVm(clock.nowMs);

  // N04 单入口编排：会话切换在 (main) 内完成（无栈动画）→ 弹簧收起即转场；
  // 根栈页面 → 先 push，抽屉无动画静默重置，杜绝双动画竞争。
  const openSession = (sessionId: string) => {
    controller.close();
    router.navigate(`/session/${sessionId}`);
  };
  const openRootPage = (href: string) => {
    router.push(href as '/approvals');
    controller.closeImmediate();
  };
  const newChat = () => {
    router.navigate('/');
    controller.close();
  };

  const identity = displayNameOf({
    displayName: profile?.displayName,
    email: accountUser?.email ?? profile?.email ?? null,
  });
  const tone = avatarToneFor(accountUser?.id ?? identity.name, theme);

  const sections = useMemo(
    () => [
      { key: 'today', label: '今天', data: vm.today },
      { key: 'earlier', label: '更早', data: vm.earlier },
    ],
    [vm.today, vm.earlier]
  );
  const emptyText = !vm.connected
    ? '连接桌面后同步会话'
    : !vm.hasSessions
      ? '还没有会话'
      : vm.query
        ? '没有匹配的会话'
        : '';

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: theme.colors.canvas,
          paddingTop: insets.top + theme.space.sm,
          paddingBottom: insets.bottom + theme.space.sm,
        },
      ]}
    >
      {/* 顶部吸顶：搜索胶囊 + 扫一扫（固定不随列表滚动，键盘弹起仍完整可见） */}
      <View
        style={[
          styles.topBar,
          {
            paddingHorizontal: theme.space.md,
            gap: theme.space.sm,
            paddingBottom: theme.space.sm,
          },
        ]}
      >
        <View
          style={[
            styles.searchPill,
            {
              backgroundColor: theme.colors.fillSubtle,
              borderRadius: theme.radius.pill,
              paddingHorizontal: theme.space.md,
              height: theme.size.touch,
            },
          ]}
        >
          <TextInput
            value={vm.query}
            onChangeText={vm.setQuery}
            placeholder="搜索会话"
            placeholderTextColor={theme.colors.textTertiary}
            accessibilityLabel="搜索会话"
            style={[
              styles.searchInput,
              theme.type.callout,
              { color: theme.colors.textPrimary },
            ]}
            testID="drawer-search"
          />
        </View>
        <IconButton
          name="qr-code"
          variant="plain"
          accessibilityLabel="扫码连接桌面"
          onPress={() => openRootPage('/pair/scan')}
          testID="drawer-scan"
        />
      </View>

      {/* 审批导航（纯文字行） */}
      <View style={{ paddingHorizontal: theme.space.md }}>
        <NavRow
          label="待审批"
          count={approvalCount}
          testID="drawer-approvals"
          onPress={() => openRootPage('/approvals')}
        />
        <NavRow
          label="审批记录"
          testID="drawer-approval-history"
          onPress={() => openRootPage('/approval-history')}
        />
      </View>

      {/* 会话列表（ScrollView 内轻量分组；数据量为数十条级，过滤即时） */}
      <ScrollView
        style={styles.list}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{
          paddingHorizontal: theme.space.sm,
          paddingBottom: theme.space.lg,
        }}
      >
        {emptyText ? (
          <AppText
            variant="body"
            color="textTertiary"
            style={{ textAlign: 'center', marginTop: theme.space.xxl }}
          >
            {emptyText}
          </AppText>
        ) : null}
        {sections.map((section) =>
          section.data.length === 0 ? null : (
            <View key={section.key} style={{ marginTop: theme.space.lg }}>
              <AppText
                variant="sectionLabel"
                color="textTertiary"
                style={{
                  paddingHorizontal: theme.space.md,
                  paddingBottom: theme.space.xs,
                }}
              >
                {section.label}
              </AppText>
              {section.data.map((session: SessionSummary) => (
                <SessionListItem
                  key={session.id}
                  session={session}
                  selected={session.id === selectedSessionId}
                  onPress={openSession}
                />
              ))}
            </View>
          )
        )}
      </ScrollView>

      {/* 底部单行通栏：头像昵称（进账号页）→ 设置 → 新对话（主操作） */}
      <View
        style={[
          styles.bottomBar,
          {
            paddingHorizontal: theme.space.md,
            paddingTop: theme.space.sm,
            gap: theme.space.sm,
          },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="账号中心"
          onPress={() => openRootPage('/account')}
          style={({ pressed }) => [
            styles.identity,
            { gap: theme.space.sm },
            pressed && { opacity: 0.7 },
          ]}
          testID="drawer-identity"
        >
          <View
            style={[
              styles.avatar,
              {
                backgroundColor: tone.bg,
                borderRadius: theme.radius.pill,
                width: theme.size.avatarSmall,
                height: theme.size.avatarSmall,
              },
            ]}
          >
            <AppText variant="callout" style={{ color: tone.fg }}>
              {identity.initial}
            </AppText>
          </View>
          <AppText variant="bodyStrong" numberOfLines={1} style={styles.flex}>
            {identity.name}
          </AppText>
        </Pressable>
        <IconButton
          name="settings"
          variant="plain"
          accessibilityLabel="设置"
          onPress={() => openRootPage('/settings')}
          testID="drawer-settings"
        />
        <IconButton
          name="new-chat"
          variant="plain"
          accessibilityLabel="新建对话"
          onPress={newChat}
          testID="drawer-new-chat"
        />
      </View>
    </View>
  );
}

function NavRow({
  label,
  count = 0,
  onPress,
  testID,
}: {
  label: string;
  count?: number;
  onPress: () => void;
  testID: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={count > 0 ? `${label}，${count} 项` : label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.navRow,
        {
          minHeight: theme.size.touch,
          paddingHorizontal: theme.space.md,
          borderRadius: theme.radius.control,
        },
        pressed && { backgroundColor: theme.colors.fillPressed },
      ]}
    >
      <AppText variant="body" style={styles.flex}>
        {label}
      </AppText>
      {count > 0 ? (
        <View
          testID="drawer-approvals-count"
          style={{
            minWidth: theme.size.badge,
            paddingHorizontal: theme.space.sm,
            paddingVertical: theme.space.xxs,
            borderRadius: theme.radius.pill,
            backgroundColor: theme.colors.warningSoft,
            alignItems: 'center',
          }}
        >
          <AppText variant="caption" color="warning">
            {count > 99 ? '99+' : String(count)}
          </AppText>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  searchPill: {
    flex: 1,
    justifyContent: 'center',
  },
  searchInput: {
    paddingVertical: 0,
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  list: { flex: 1 },
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  identity: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatar: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
