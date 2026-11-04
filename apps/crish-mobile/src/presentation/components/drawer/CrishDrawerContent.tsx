// 抽屉面板内容（原型 crish-mobile-drawer 移植，去底色与轻量化重构）：
// 顶部吸顶【搜索胶囊 + 叉号 + 扫一扫 + 通知极简图标（variant="plain"）】——点搜索原地展开为输入态，
// 右侧动作钮平滑收拢、叉号展开（键盘弹起永不遮挡）；
// 中部【待审批（仅有待办时）/ 审批记录 + 会话列表，全透明选项行】；
// 底部单行通栏【头像昵称 → 设置 / 新对话通透极简图标（variant="plain"，无底色块）】。全部样式走 theme token，零描边。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useTheme } from '@/adapters/platform/theme';
import { useSessionListVm } from '@/adapters/viewmodels/useSessionListVm';
import { useAccountStore } from '@/adapters/hooks/useAccountStore';
import { useApprovalStore } from '@/adapters/hooks/useAppStore';
import { countUserDecisions } from '@/domain/pure/approvalAttention';
import type { DrawerRow } from '@/domain/pure/drawerRows';
import {
  AppText,
  EmptyState,
  ErrorState,
  Icon,
  IconButton,
  LoadingState,
} from '@/presentation/ui';
import {
  AnimatedPressable,
  usePressFade,
} from '@/presentation/ui/pressFeedback';
import { useDelayedFlag } from '@/presentation/ui/useDelayedFlag';
import {
  deriveDrawerListState,
  DRAWER_LIST_LOADING_DELAY_MS,
  type DrawerListViewState,
} from './drawerListState';
import { SessionListItem } from '@/presentation/components/sessions/SessionListItem';
import { LocalSessionListItem } from '@/presentation/components/sessions/LocalSessionListItem';
import { useSessionOpsController } from '@/presentation/components/sessions/useSessionOpsController';
import { useLocalThreadOpsController } from '@/presentation/components/sessions/useLocalThreadOpsController';
import { AccountAvatar } from '@/presentation/account/ui';
import { useDrawerActions, useDrawerController } from './DrawerContext';
import { dismissKeyboardAndBlur } from './drawerFocus';

/**
 * 从当前路径解析聚焦对话：远端 /session/[id] 与本地 /thread/[id] 同为
 * (main) 壳内对话槽位，选中态按 {kind, id} 判定——当前分区列表内的
 * 对应行高亮（本地与远端分区分列，见 drawerRows 分区口径）。
 */
export function selectedConversationOf(
  pathname: string
): { kind: 'remote' | 'local'; id: string } | null {
  const remote = /^\/session\/([^/]+)/.exec(pathname);
  if (remote) return { kind: 'remote', id: decodeURIComponent(remote[1]!) };
  const local = /^\/thread\/([^/]+)/.exec(pathname);
  if (local) return { kind: 'local', id: decodeURIComponent(local[1]!) };
  return null;
}

function displayNameOf(profile: {
  displayName?: string;
  email?: string | null;
}): string {
  return profile.displayName?.trim() || profile.email?.trim() || '本地用户';
}

export function CrishDrawerContent({
  registerCloseListener,
}: {
  registerCloseListener?: (listener: () => void) => () => void;
} = {}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const controller = useDrawerController();
  // 动作走稳定动作面（C-PERF）：导航回调以 actions 为依赖后跨 isOpen
  // 中点翻转稳定，不再逐渲染换新引用击穿行 memo；controller 只余
  // isOpen 状态用途（下方时钟刷新与搜索收起）。
  const actions = useDrawerActions();
  const pathname = usePathname();
  // 解析结果按 pathname 记忆：旧实现每渲染重造对象，作为列表段的
  // selected 入参会逐渲染换引用、击穿其 memo（C-PERF）。
  const selected = useMemo(
    () => selectedConversationOf(pathname ?? ''),
    [pathname]
  );
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
  // 会话操作（G3）：远端行长按 → 操作 Sheet（改名/置顶/归档/导出/删除）。
  // 回调稳定化（C-PERF）：行组件已 memo，回调逐渲染换新引用会把 memo
  // 击穿——本区全部行回调 useCallback 化，依赖只取行数组与控制器内
  // 稳定的 openActions 本体（不依赖控制器对象整体）。
  const sessionOps = useSessionOpsController();
  const sessionOpenActions = sessionOps.openActions;
  const openSessionActions = useCallback(
    (sessionId: string) => {
      const target = [...vm.today, ...vm.earlier].find(
        (row): row is Extract<DrawerRow, { kind: 'remote' }> =>
          row.kind === 'remote' && row.id === sessionId
      );
      if (target) sessionOpenActions(target.session);
    },
    [vm.today, vm.earlier, sessionOpenActions]
  );
  // 本地线程操作：本地分区行长按 → 操作 Sheet（重命名/清空/删除，
  // 作用于本地真源，不经桌面命令通道）
  const handleThreadDeleted = useCallback(
    (threadId: string) => {
      // 删的正是当前打开的本地线程 → 回主页，不停留在已删线程的空屏
      if (selected?.kind === 'local' && selected.id === threadId) {
        router.navigate('/');
      }
    },
    [selected]
  );
  const localOps = useLocalThreadOpsController({
    onThreadDeleted: handleThreadDeleted,
  });
  const localOpenActions = localOps.openActions;
  const openLocalThreadActions = useCallback(
    (threadId: string) => {
      const target = [...vm.today, ...vm.earlier].find(
        (row): row is Extract<DrawerRow, { kind: 'local' }> =>
          row.kind === 'local' && row.id === threadId
      );
      if (target) localOpenActions(target.thread);
    },
    [vm.today, vm.earlier, localOpenActions]
  );

  // 搜索态：0 = 常态（扫一扫/通知展开），1 = 搜索（叉号展开、动作钮收拢）
  const [searching, setSearching] = useState(false);
  const searchInputRef = useRef<TextInput>(null);
  const searchProgress = useSharedValue(0);
  // 底部身份行按压反馈（按压过渡统一批）
  const identityPress = usePressFade();
  const toggleSearch = useCallback(
    (next: boolean) => {
      if (!next) {
        searchInputRef.current?.blur();
        dismissKeyboardAndBlur();
      }
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

  // 抽屉收起监听：主控抽屉关闭触发时立即收起搜索并清空焦点
  useEffect(() => {
    if (!registerCloseListener) return;
    return registerCloseListener(() => {
      if (searching) {
        toggleSearch(false);
      }
    });
  }, [registerCloseListener, searching, toggleSearch]);

  useEffect(() => {
    if (!controller.isOpen && searching) toggleSearch(false);
  }, [controller.isOpen, searching, toggleSearch]);

  // N04 单入口编排：会话切换在 (main) 内完成（无栈动画）→ 定时收起即转场；
  // 根栈页面 → 先 push，抽屉无动画静默重置，杜绝双动画竞争。
  // 导航回调稳定化（C-PERF）：依赖稳定动作面 actions，跨 isOpen 翻转
  // 与无关重渲染保持同一引用（行 memo 与列表段 memo 的前提）。
  const openSession = useCallback(
    (sessionId: string) => {
      if (searching) toggleSearch(false);
      actions.close();
      router.navigate(`/session/${sessionId}`);
    },
    [actions, searching, toggleSearch]
  );
  // 本地线程同款壳内编排：(main) 内换 Slot 到 /thread，无根栈动画
  const openLocalThread = useCallback(
    (threadId: string) => {
      if (searching) toggleSearch(false);
      actions.close();
      router.navigate(`/thread/${threadId}`);
    },
    [actions, searching, toggleSearch]
  );
  const openRootPage = useCallback(
    (href: string) => {
      if (searching) toggleSearch(false);
      router.push(href as '/approvals');
      actions.closeImmediate();
    },
    [actions, searching, toggleSearch]
  );
  const newChat = useCallback(() => {
    if (searching) toggleSearch(false);
    router.navigate('/');
    actions.close();
  }, [actions, searching, toggleSearch]);

  const identityName = displayNameOf({
    displayName: profile?.displayName,
    email: accountUser?.email ?? profile?.email ?? null,
  });

  const sections = useMemo(
    () => [
      { key: 'today', label: '今天', data: vm.today },
      { key: 'earlier', label: '更早', data: vm.earlier },
    ],
    [vm.today, vm.earlier]
  );
  // 列表三态（批 D）：裁决在 drawerListState 纯函数（有行即内容、
  // 数据未到先加载不闪空、错误仅空列表占面、空态文案沿分区口径）；
  // 加载面再过 200ms 防闪窗——窗内 blank，数据窗内到达直接出内容。
  const totalRows = vm.today.length + vm.earlier.length;
  const rawListState = useMemo(
    () =>
      deriveDrawerListState({
        partition: vm.partition,
        rowCount: totalRows,
        query: vm.query,
        connected: vm.connected,
        syncStatus: vm.syncStatus,
        lastReconcileAt: vm.lastReconcileAt,
        localHydrated: vm.localHydrated,
      }),
    [
      vm.partition,
      totalRows,
      vm.query,
      vm.connected,
      vm.syncStatus,
      vm.lastReconcileAt,
      vm.localHydrated,
    ]
  );
  const loadingSettled = useDelayedFlag(
    rawListState.kind === 'loading',
    DRAWER_LIST_LOADING_DELAY_MS
  );
  const listState: DrawerListViewState =
    rawListState.kind === 'loading' && !loadingSettled
      ? { kind: 'blank' }
      : rawListState;

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
          inputRef={searchInputRef}
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
          {/* 顶部动作钮：通透极简图标（variant="plain"，彻底去除白底圆盘与阴影） */}
          <IconButton
            name="qr-code"
            variant="plain"
            diameter={theme.size.iconButton}
            accessibilityLabel="扫码连接桌面"
            onPress={() => openRootPage('/pair/scan')}
            testID="drawer-scan"
          />
          <IconButton
            name="bell"
            variant="plain"
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
            variant="plain"
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
      {/* 「本地对话」独立入口行已删：目标为本机时本地线程就是下方
          会话列表里的行，不再有独立列表页 */}

      {/* 会话区标题 = 当前分区目标名（与主页设备胶囊同源：本机 /
          设备名）——分区身份在此一处呈现，行上不再另挂标识 */}
      <View
        testID="drawer-partition-label"
        style={{
          marginLeft: theme.space.lg,
          marginRight: theme.space.md + 2,
          paddingHorizontal: theme.space.md,
          paddingTop: theme.space.sm,
        }}
      >
        <AppText variant="sectionLabel" color="textSecondary">
          {vm.partitionLabel}
        </AppText>
      </View>

      {/* 会话列表（memo 段：入参未变时整段跳过，见 DrawerSessionList） */}
      <DrawerSessionList
        sections={sections}
        listState={listState}
        onRetry={vm.refresh}
        selected={selected}
        onOpenSession={openSession}
        onOpenLocalThread={openLocalThread}
        onSessionActions={openSessionActions}
        onLocalThreadActions={openLocalThreadActions}
      />

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
        <AnimatedPressable
          accessibilityRole="button"
          accessibilityLabel="设置"
          onPress={() => openRootPage('/settings')}
          onPressIn={identityPress.onPressIn}
          onPressOut={identityPress.onPressOut}
          style={[
            styles.identity,
            // 原型 user-profile gap 10
            { gap: theme.space.sm + 2 },
            identityPress.fadeStyle,
          ]}
          testID="drawer-identity"
        >
          {/* 头像与设置/账号页同源同组件：消费 profile.avatarUrl（相对
              路径由 AccountAvatar 统一补全账号中心域名）；无头像时才
              落首字占位。旧实现在此手搓首字盘、从不读 avatarUrl，是
              登录后抽屉头像仍为默认的断点（2026-11-02 用户投诉） */}
          <AccountAvatar
            name={identityName}
            uri={profile?.avatarUrl ?? null}
            size={theme.size.avatarSmall}
            testID="drawer-avatar"
          />
          {/* 原型 user-name 14/600 */}
          <AppText
            variant="body"
            numberOfLines={1}
            style={[styles.flex, styles.identityName]}
          >
            {identityName}
          </AppText>
        </AnimatedPressable>
        <IconButton
          name="settings"
          variant="plain"
          accessibilityLabel="设置"
          onPress={() => openRootPage('/settings')}
          testID="drawer-settings"
        />
        <IconButton
          name="add"
          variant="plain"
          accessibilityLabel="新建对话"
          onPress={newChat}
          testID="drawer-new-chat"
        />
      </View>

      {/* 会话操作层（G3：操作 Sheet + 改名弹窗 + 删除确认） */}
      {sessionOps.layer}
      {/* 本地线程操作层（U3：操作 Sheet + 改名弹窗 + 清空/删除确认） */}
      {localOps.layer}
    </View>
  );
}

/**
 * 会话列表段（C-PERF memo 化）：行组件（SessionListItem /
 * LocalSessionListItem）本已 memo，但内容区每次重渲染（账号/审批
 * 订阅、isOpen 中点翻转）都重造整表 JSX 与内联回调，行 memo 被击穿、
 * 关闭态被主卡遮挡时也照样整表重渲染。本段抽为 memo 组件，入参 =
 * 分组行数组（VM useMemo 产出，数据未变引用不变）+ pathname 记忆的
 * selected + useCallback 稳定的四个回调：入参皆未变时整段跳过——
 * 无关订阅不再连带列表；行数据真变（引用变）仍即时穿透，下次打开
 * 所见恒为最新（不冻结订阅/数据，M5 首开就位口径不变）。分区形态
 * 与行序由 sections 的生产方（drawerRows 分区口径）决定，本段只
 * 呈现，不做任何重排。
 */
export const DrawerSessionList = memo(function DrawerSessionList({
  sections,
  listState,
  onRetry,
  selected,
  onOpenSession,
  onOpenLocalThread,
  onSessionActions,
  onLocalThreadActions,
}: {
  sections: { key: string; label: string; data: DrawerRow[] }[];
  /** 三态呈现（批 D）：content 才渲染行组，其余走 ContentState 家族 */
  listState: DrawerListViewState;
  onRetry: () => void;
  selected: { kind: 'remote' | 'local'; id: string } | null;
  onOpenSession: (sessionId: string) => void;
  onOpenLocalThread: (threadId: string) => void;
  onSessionActions: (sessionId: string) => void;
  onLocalThreadActions: (threadId: string) => void;
}) {
  const theme = useTheme();
  return (
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
      {listState.kind === 'loading' ? (
        <LoadingState testID="drawer-list-loading" label={listState.label} />
      ) : null}
      {listState.kind === 'error' ? (
        <ErrorState
          testID="drawer-list-error"
          title="会话列表同步失败"
          onRetry={onRetry}
        />
      ) : null}
      {listState.kind === 'empty' ? (
        <EmptyState testID="drawer-list-empty" title={listState.text} />
      ) : null}
      {listState.kind === 'content'
        ? sections.map((section) =>
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
                {section.data.map((row: DrawerRow) =>
                  row.kind === 'remote' ? (
                    <SessionListItem
                      key={`remote-${row.id}`}
                      session={row.session}
                      selected={
                        selected?.kind === 'remote' && selected.id === row.id
                      }
                      onPress={onOpenSession}
                      onLongPress={onSessionActions}
                    />
                  ) : (
                    <LocalSessionListItem
                      key={`local-${row.id}`}
                      thread={row.thread}
                      streaming={row.streaming}
                      failed={row.failed}
                      selected={
                        selected?.kind === 'local' && selected.id === row.id
                      }
                      onPress={onOpenLocalThread}
                      onLongPress={onLocalThreadActions}
                    />
                  )
                )}
              </View>
            )
          )
        : null}
    </ScrollView>
  );
});

/** 搜索胶囊：常态显示图标 + 占位文案；点击原地展开为输入态（通透微凹槽质感融入抽屉底板，无白底，无描边，无阴影） */
function SearchPill({
  searching,
  query,
  onQueryChange,
  onOpen,
  inputRef,
}: {
  searching: boolean;
  query: string;
  onQueryChange: (text: string) => void;
  onOpen: () => void;
  inputRef?: React.RefObject<TextInput | null>;
}) {
  const theme = useTheme();
  const pillHeight = theme.size.iconButton; // 40

  useEffect(() => {
    return () => {
      dismissKeyboardAndBlur();
    };
  }, []);

  // 搜索框通透化（融入抽屉底板）：浅色走微弱凹槽质感（rgba(0, 0, 0, 0.03)），深色走 surfaceRaised，
  // 彻底移除厚重白色底色块与 SoftShadow 软阴影，通透扁平融入 canvasDrawer。
  const pillFill = theme.dark
    ? theme.colors.surfaceRaised
    : 'rgba(0, 0, 0, 0.03)';

  return (
    <Pressable
      testID="drawer-search-pill"
      accessibilityRole={searching ? 'search' : 'button'}
      accessibilityLabel="搜索会话"
      onPress={searching ? undefined : onOpen}
      style={[
        styles.searchPill,
        {
          borderRadius: theme.radius.pill,
          backgroundColor: pillFill,
          // 原型 search-pill padding 0 14、高 40
          paddingHorizontal: theme.space.md + 2,
          height: pillHeight,
          gap: theme.space.xs + 2,
        },
      ]}
    >
      <Icon
        name="search"
        size={theme.size.iconSmall}
        color={theme.colors.textSecondary}
      />
      {searching ? (
        <TextInput
          ref={inputRef}
          value={query}
          onChangeText={onQueryChange}
          placeholder="搜索会话与命令..."
          placeholderTextColor={theme.colors.textTertiary}
          autoFocus
          accessibilityLabel="搜索会话"
          onBlur={dismissKeyboardAndBlur}
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

/** 弱化导航行（审批入口）：纯文字 + 可选计数，恒透明底，视觉让位于会话列表 */
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
  const press = usePressFade();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={count > 0 ? `${label}，${count} 项` : label}
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={[
        styles.navRow,
        {
          // 与会话行同盒模型（原型 menu-item：padding 9/12、行区随面板 16/14 内缩）
          marginLeft: theme.space.lg,
          marginRight: theme.space.md + 2,
          paddingHorizontal: theme.space.md,
          paddingVertical: theme.space.sm + 1,
          borderRadius: theme.radius.control,
          backgroundColor: 'transparent',
        },
      ]}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: theme.radius.control,
            backgroundColor: theme.colors.fillPressed,
          },
          press.overlayStyle,
        ]}
      ></Animated.View>
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

/** 右侧动作钮簇：常态展开（宽 = N×钮 + 间距，保持 overflow: visible 确保软阴影四向漫射不被截断），搜索收拢动画中裁剪 */
function useActionClusterStyle(
  progress: SharedValue<number>,
  buttonSize: number,
  gap: number
) {
  return useAnimatedStyle(() => ({
    width: interpolate(progress.value, [0, 1], [buttonSize * 2 + gap, 0]),
    marginLeft: interpolate(progress.value, [0, 1], [gap, 0]),
    opacity: interpolate(progress.value, [0, 1], [1, 0]),
    overflow: progress.value > 0.01 ? 'hidden' : 'visible',
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
    overflow: progress.value < 0.99 ? 'hidden' : 'visible',
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
});
