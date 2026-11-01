// 抽屉面板内容（原型 crish-mobile-drawer 移植）：
// 顶部吸顶【搜索胶囊 + 叉号 + 扫一扫 + 通知】——点搜索原地展开为输入态，
// 右侧动作钮平滑收拢、叉号展开（键盘弹起永不遮挡）；
// 中部【待审批（仅有待办时）/ 审批记录 + 会话列表】；
// 底部单行通栏【头像昵称 → 设置 / 新对话白圆钮】。全部样式走 theme token，零描边。
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { usePathname, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, avatarToneFor } from '@/adapters/platform/theme';
import { useSessionListVm } from '@/adapters/viewmodels/useSessionListVm';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import { useApprovalStore } from '@/adapters/hooks/useAppStore';
import { countUserDecisions } from '@/domain/pure/approvalAttention';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import { AppText, Icon, IconButton } from '@/presentation/ui';
import { SessionListItem } from '@/presentation/components/sessions/SessionListItem';
import { useSessionOpsController } from '@/presentation/components/sessions/useSessionOpsController';
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
  // 会话操作（G3）：行长按 → 操作 Sheet（改名/置顶/归档/导出/删除）
  const sessionOps = useSessionOpsController();
  const openSessionActions = (sessionId: string) => {
    const target = [...vm.today, ...vm.earlier].find((s) => s.id === sessionId);
    if (target) sessionOps.openActions(target);
  };

  // 搜索态：0 = 常态（扫一扫/通知展开），1 = 搜索（叉号展开、动作钮收拢）
  const [searching, setSearching] = useState(false);
  const searchProgress = useSharedValue(0);
  const toggleSearch = useCallback(
    (next: boolean) => {
      setSearching(next);
      // 原型搜索展开动画：0.28s emphasized 定时（不用弹簧）。
      // jest 环境由 jest.setup 的 reanimated 桩提供 Easing.bezier（M8 补桩）。
      searchProgress.value = withTiming(next ? 1 : 0, {
        duration: theme.motion.duration.expand,
        easing: Easing.bezier(...theme.motion.easing.emphasized),
      });
      if (!next) vm.setQuery('');
    },
    [
      searchProgress,
      theme.motion.duration.expand,
      theme.motion.easing.emphasized,
      vm,
    ]
  );
  useEffect(() => {
    if (!controller.isOpen && searching) toggleSearch(false);
  }, [controller.isOpen, searching, toggleSearch]);

  // N04 单入口编排：会话切换在 (main) 内完成（无栈动画）→ 定时收起即转场；
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
          // 原型 drawer 底 #f5f5f5（canvasDrawer，与主界面 #f9f9f9 分层）
          backgroundColor: theme.colors.canvasDrawer,
          paddingTop: insets.top + theme.space.sm,
          paddingBottom: insets.bottom + theme.space.sm,
        },
      ]}
    >
      {/* 顶部吸顶：搜索胶囊 + 叉号 + 扫一扫 + 通知（固定不随列表滚动） */}
      <View
        style={[
          styles.topBar,
          {
            // 原型面板横向 padding：左 16 / 右 14
            paddingLeft: theme.space.lg,
            paddingRight: theme.space.md + 2,
            paddingBottom: theme.space.sm,
          },
        ]}
      >
        <SearchPill
          searching={searching}
          query={vm.query}
          onQueryChange={vm.setQuery}
          onOpen={() => toggleSearch(true)}
        />
        {/* 搜索态收拢的右侧动作钮：宽度联动 + 透明度淡出 */}
        <Animated.View
          pointerEvents={searching ? 'none' : 'auto'}
          style={[
            styles.actionCluster,
            { gap: theme.space.sm },
            useActionClusterStyle(
              searchProgress,
              theme.size.iconButton,
              theme.space.sm
            ),
          ]}
        >
          {/* 原型顶部动作钮专档 40（通用白圆钮 38）；簇宽动画按 40 计算 */}
          <IconButton
            name="qr-code"
            variant="floating"
            diameter={theme.size.iconButton}
            accessibilityLabel="扫码连接桌面"
            onPress={() => openRootPage('/pair/scan')}
            testID="drawer-scan"
          />
          <IconButton
            name="bell"
            variant="floating"
            diameter={theme.size.iconButton}
            accessibilityLabel="通知中心"
            onPress={() => openRootPage('/notifications')}
            testID="drawer-notifications"
          />
        </Animated.View>
        {/* 搜索态展开的外部叉号 */}
        <Animated.View
          pointerEvents={searching ? 'auto' : 'none'}
          style={[
            styles.actionCluster,
            useCancelStyle(
              searchProgress,
              theme.size.iconButton,
              theme.space.sm
            ),
          ]}
        >
          <IconButton
            name="x"
            variant="floating"
            diameter={theme.size.iconButton}
            accessibilityLabel="取消搜索"
            onPress={() => toggleSearch(false)}
            testID="drawer-search-cancel"
          />
        </Animated.View>
      </View>

      {/* 审批导航（压缩弱化：待审批仅有待办时出现） */}
      {approvalCount > 0 ? (
        <QuietNavRow
          label="待审批"
          count={approvalCount}
          testID="drawer-approvals"
          onPress={() => openRootPage('/approvals')}
        />
      ) : null}
      <QuietNavRow
        label="审批记录"
        testID="drawer-approval-history"
        onPress={() => openRootPage('/approval-history')}
      />

      {/* 会话列表（ScrollView 内轻量分组；数据量为数十条级，过滤即时） */}
      <ScrollView
        style={styles.list}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{
          paddingLeft: theme.space.lg,
          paddingRight: theme.space.md + 2,
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
            <View key={section.key} style={{ marginTop: theme.space.sm }}>
              <AppText
                variant="sectionLabel"
                color="textTertiary"
                style={{
                  // 原型 group-label：padding 8/12/6
                  paddingHorizontal: theme.space.md,
                  paddingTop: theme.space.sm,
                  paddingBottom: theme.space.xs + 2,
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
                  onLongPress={openSessionActions}
                />
              ))}
            </View>
          )
        )}
      </ScrollView>

      {/* 底部单行通栏：头像昵称 → 设置 / 新对话白圆钮（裁决 J9：点头像与点设置同落设置界面） */}
      <View
        style={[
          styles.bottomBar,
          {
            // 原型底部通栏：横向 16/14、padding-top 14
            paddingLeft: theme.space.lg,
            paddingRight: theme.space.md + 2,
            paddingTop: theme.space.md + 2,
            gap: theme.space.sm,
          },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="设置"
          onPress={() => openRootPage('/settings')}
          style={({ pressed }) => [
            styles.identity,
            // 原型 user-profile gap 10
            { gap: theme.space.sm + 2 },
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
            {/* 原型头像首字 15px（自 body 字号派生，同 Composer 先例） */}
            <AppText
              variant="callout"
              style={{ color: tone.fg, fontSize: theme.type.body.fontSize + 1 }}
            >
              {identity.initial}
            </AppText>
          </View>
          {/* 原型 user-name 14/600 */}
          <AppText
            variant="body"
            numberOfLines={1}
            style={[styles.flex, styles.identityName]}
          >
            {identity.name}
          </AppText>
        </Pressable>
        <IconButton
          name="settings"
          variant="floating"
          accessibilityLabel="设置"
          onPress={() => openRootPage('/settings')}
          testID="drawer-settings"
        />
        <IconButton
          name="add"
          variant="floating"
          accessibilityLabel="新建对话"
          onPress={newChat}
          testID="drawer-new-chat"
        />
      </View>

      {/* 会话操作层（G3：操作 Sheet + 改名弹窗 + 删除确认） */}
      {sessionOps.layer}
    </View>
  );
}

/** 搜索胶囊：常态显示图标 + 占位文案；点击原地展开为输入态（无描边、无光圈） */
function SearchPill({
  searching,
  query,
  onQueryChange,
  onOpen,
}: {
  searching: boolean;
  query: string;
  onQueryChange: (text: string) => void;
  onOpen: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole={searching ? 'search' : 'button'}
      accessibilityLabel="搜索会话"
      onPress={searching ? undefined : onOpen}
      style={[
        styles.searchPill,
        {
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.surface,
          // 原型 search-pill padding 0 14、高 40
          paddingHorizontal: theme.space.md + 2,
          height: theme.size.iconButton,
          gap: theme.space.xs + 2,
        },
        theme.shadow.sm,
      ]}
    >
      <Icon
        name="search"
        size={theme.size.iconSmall}
        color={theme.colors.textSecondary}
      />
      {searching ? (
        <TextInput
          value={query}
          onChangeText={onQueryChange}
          placeholder="搜索会话与命令..."
          placeholderTextColor={theme.colors.textTertiary}
          autoFocus
          accessibilityLabel="搜索会话"
          style={[
            styles.searchInput,
            theme.type.callout,
            { color: theme.colors.textPrimary },
          ]}
          testID="drawer-search"
        />
      ) : (
        <AppText variant="callout" color="textTertiary" style={styles.flex}>
          搜索会话与命令...
        </AppText>
      )}
    </Pressable>
  );
}

/** 弱化导航行（审批入口）：纯文字 + 可选计数，视觉让位于会话列表 */
function QuietNavRow({
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
          // 与会话行同盒模型（原型 menu-item：padding 9/12、行区随面板 16/14 内缩）
          marginLeft: theme.space.lg,
          marginRight: theme.space.md + 2,
          paddingHorizontal: theme.space.md,
          paddingVertical: theme.space.sm + 1,
          borderRadius: theme.radius.control,
        },
        pressed && { backgroundColor: theme.colors.fillPressed },
      ]}
    >
      {/* 原型 menu-item 字 14.5/500（字号自 body 派生） */}
      <AppText
        variant="callout"
        color="textSecondary"
        style={[
          styles.flex,
          styles.navLabel,
          { fontSize: theme.type.body.fontSize + 0.5 },
        ]}
      >
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

/** 右侧动作钮簇：常态展开（宽 = N×钮 + 间距），搜索态收拢为 0 */
function useActionClusterStyle(
  progress: SharedValue<number>,
  buttonSize: number,
  gap: number
) {
  return useAnimatedStyle(() => ({
    width: interpolate(progress.value, [0, 1], [buttonSize * 2 + gap, 0]),
    marginLeft: interpolate(progress.value, [0, 1], [gap, 0]),
    opacity: interpolate(progress.value, [0, 1], [1, 0]),
  }));
}

/** 搜索取消钮：搜索态展开，常态收拢 */
function useCancelStyle(
  progress: SharedValue<number>,
  buttonSize: number,
  gap: number
) {
  return useAnimatedStyle(() => ({
    width: interpolate(progress.value, [0, 1], [0, buttonSize]),
    marginLeft: interpolate(progress.value, [0, 1], [0, gap]),
    opacity: interpolate(progress.value, [0, 1], [0, 1]),
  }));
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 0,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 0,
  },
  actionCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 0,
    overflow: 'hidden',
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  navLabel: { fontWeight: '500' },
  identityName: { fontWeight: '600' },
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
