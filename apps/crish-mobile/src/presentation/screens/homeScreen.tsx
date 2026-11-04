// 主屏（原型 main-screen 移植）：头栏左组【汉堡 · 设备胶囊】+ 右侧更多下拉；
// 悬浮通知层（本地横幅/同步错误/陈旧标注）；状态板（≤4 行，少条目垂直居中）；
// 底部 Composer。
// 主界面 = 状态板（用户裁决 2026-11-02）：不是消息列表——只显示待审批的
// 对话、正在运行的对话（含本地生成中线程）、本次连接建立之后才完成的
// 对话，总数上限 4，优先级 审批 > 运行中 > 刚完成（选择器 =
// domain/pure/hubRows.selectStatusBoardRows）；连接前完成的历史对话只在
// 完整会话列表页（抽屉）里。无符合项时 = 时段问候空态。
// 模式口径（CON-2）：有效对话模式由中央派生决定（ready → remote，否则 →
// local）。无远端会话且无本地线程时 = 时段问候空态（不分模式）；local 模式
// （未连接）不再是死空态——横幅改述「桌面未连接 · 正在使用本地对话」，
// Composer 可编辑、提交走本地发送并直达该线程页。
// 分区口径：远端会话行只来自 sessionStore——其数据由接线生命周期按当前
// 目标设备（accountStore.targetDeviceId）单一作用域维护（切换设备即整表
// reset 后按新设备重同步，绝不跨设备串入）；本地线程行是手机自身的
// 分区（每行带「本地」标识），数据源与远端严格分开、不受设备切换影响。
// 通知口径（2026-11-02）：主页一切通知类表面（本地模式横幅 / 同步错误 /
// 陈旧标注）都是悬浮面板——绝对定位浮于内容之上，不占布局高度、内容
// 不被顶下去（容器 testID home-status-overlay，pointerEvents=box-none）。
// 输入态口径（M6）：键盘升起时只有中段（状态板/问候，testID home-board）
// 随键盘逐帧 progress 变淡至半透明下限；浮层在淡出容器之外，输入态
// 保持可见——连接异常与审批信息不得因打字而消失。
// 同步呈现口径：无「正在同步…」呈现（静默同步零呈现）；同步错误只经
// 悬浮面板 + 重试；用户主动下拉刷新走 RefreshControl 原生指示。
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import {
  FlatList,
  Keyboard,
  RefreshControl,
  StyleSheet,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  interpolate,
  useAnimatedStyle,
} from 'react-native-reanimated';
import {
  KeyboardStickyView,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { useReducedMotion } from '@/adapters/platform/useReducedMotion';
import {
  AnimatedPressable,
  usePressFade,
} from '@/presentation/ui/pressFeedback';
import { useDeviceStatusVm } from '@/adapters/viewmodels/useDeviceStatusVm';
import { useQuickRunVm } from '@/adapters/viewmodels/useQuickRunVm';
import { useEffectiveChatMode } from '@/adapters/hooks/useAppStore';
import { sendLocalChatMessage } from '@/adapters/localChat/localChatEngine';
import { localChatSessionStore } from '@/domain/store/localChatSessionStore';
import { localChatStore } from '@/domain/store/localChatStore';
import { useLocalHubEntryVm } from '@/adapters/viewmodels/useLocalHubEntryVm';
import { useComposerContextVm } from '@/adapters/viewmodels/useComposerContextVm';
import { useSkillsVm } from '@/adapters/viewmodels/useSkillsVm';
import { useComposerAttachments } from '@/adapters/viewmodels/useComposerAttachments';
import { useVoiceInput } from '@/adapters/asr/useVoiceInput';
import { useSessionsVm } from '@/adapters/viewmodels/useSessionsVm';
import { lastPreviewOfWindow } from '@/domain/pure/sessionPreview';
import { selectStatusBoardRows, type HubRow } from '@/domain/pure/hubRows';
import { connectionStore } from '@/domain/store/connectionStore';
import { sessionStore } from '@/domain/store/sessionStore';
import { approvalStore } from '@/domain/store/approvalStore';
import { SNAPSHOT_STALE_LABEL } from '@/domain/pure/selectors';
import { formatRelativeTime } from '@/domain/pure/time';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import {
  AppText,
  Composer,
  ComposerAmbientVeil,
  DEFAULT_COMPOSER_PLACEHOLDER,
  DropdownMenu,
  IconButton,
  Screen,
  useToast,
} from '@/presentation/ui';
import { ConnectionBanner } from '@/presentation/components/status/ConnectionBanner';
import { AttachmentSheet } from '@/presentation/components/chat/AttachmentSheet';
import { AttachmentStrip } from '@/presentation/components/chat/AttachmentStrip';
import { DevicePill } from '@/presentation/components/chat/DevicePill';
import { DeviceSheet } from '@/presentation/components/chat/DeviceSheet';
import { MenuButton } from '@/presentation/components/chat/MenuButton';
import { ModelSheet } from '@/presentation/components/chat/ModelSheet';
import { LocalModelSheet } from '@/presentation/components/chat/LocalModelSheet';
import { PermissionModeSheet } from '@/presentation/components/chat/PermissionModeSheet';
import { SkillsSheet } from '@/presentation/components/chat/SkillsSheet';
import { WorkspaceSheet } from '@/presentation/components/files/WorkspaceSheet';
import { ChatFlatItem } from '@/presentation/components/sessions/ChatFlatItem';
import { LocalChatHubRow } from '@/presentation/components/sessions/LocalChatHubRow';
import { SessionSyncBar } from '@/presentation/components/sessions/SessionSyncBar';
import { useSessionOpsController } from '@/presentation/components/sessions/useSessionOpsController';

/** 问候语按本地时段切换 */
export function greetingFor(hour: number): string {
  if (hour < 5) return '夜深了';
  if (hour < 12) return '早上好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

/** 输入态中段淡出下限（M6 定案）：只降到半透明，永不整体全隐 */
const INPUT_FADE_FLOOR = 0.2;

/** 点中段内容区收键盘（模块级稳定引用）：接线点在 home-board
 * 容器的 onTouchStart（被动通知，口径见该处注释）。 */
function dismissKeyboardForOutsideTap(): void {
  Keyboard.dismiss();
}

/**
 * Sheet 懒挂载闩（PERF #3）：open 首次为 true 后闩住 true——Sheet 子树
 * 在首次打开前不进主页常驻面；一旦挂载不再卸载，关闭动画与再次打开
 * 的时序与常驻挂载完全一致。
 */
function useEverOpened(open: boolean): boolean {
  const [ever, setEver] = useState(open);
  useEffect(() => {
    if (open) setEver(true);
  }, [open]);
  return ever;
}

export interface HomeScreenProps {
  onOpenDrawer: () => void;
  onOpenNotifications: () => void;
  /** 会话打开（列表点按与新建会话回跳共用） */
  onOpenSession: (sessionId: string) => void;
  /** 本地线程打开（状态板本地行点按与本地发送落点共用；壳内 replace） */
  onOpenLocalThread: (threadId: string) => void;
}

export default function HomeScreen({
  onOpenDrawer,
  onOpenNotifications,
  onOpenSession,
  onOpenLocalThread,
}: HomeScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { showToast } = useToast();
  const { sessions, windows, refresh, syncStatus, syncError, snapshotStale } =
    useSessionsVm();
  const quickRun = useQuickRunVm();
  // 有效对话模式（CON-2 中央派生）：本屏一切模式判定只消费此值，
  // 不再自写 phase === 'ready' 谓词（派生本体 = domain/pure/selectors）
  const mode = useEffectiveChatMode();
  const remoteMode = mode === 'remote';
  // hub 本地数据面：逐线程行输入 + 逐线程摘要 + 本地模式的
  // 配置/生成/模型标签事实（主页与本地页同源，不复制本地引擎）
  const localEntry = useLocalHubEntryVm();
  // Composer 上下文（G1）：快捷条项目/权限 + 展开行模型钮的数据面
  const composerCtx = useComposerContextVm();
  // 技能目录（G7）：附件面板入口计数 + SkillsSheet 数据面（只读）
  const skillsVm = useSkillsVm();
  // 已选附件（G5b）：选取/移除在本屏管理；发送成功随 feedback 清空，
  // 失败保留（VM 的 clear 只在成功路径调用）
  const attachments = useComposerAttachments({ notify: showToast });
  const clearAttachments = attachments.clear;
  const hasAttachments = attachments.attachments.length > 0;
  // 本地模式提交（CON-2）：文本交给本地发送引擎（localChatEngine，
  // 与本地页同一份实现），随即导航进本地线程面看流式呈现。落点线程 =
  // 当前活动线程；尚无线程时先建（模型快照 = 全局活动模型，与线程页
  // 发送同口径）。发送成功才清稿；未配置时引擎已把错误写入该线程的
  // error 槽（线程页横幅呈现），主页仍导航——发送永远有明确去向，
  // 不静默吞稿；空文本无操作。
  // 落点（界面统一 U3）：壳内 /thread/<target>，经宿主 onOpenLocalThread
  // 以 replace 换 (main) 槽位内容——与远端发送同一条路径，无根栈压栈
  // 的「明显切换」；消息在 submit 同步入 store，线程屏挂载首帧即已在列。
  // 【维度 1 核心重塑】：主页发送永远代表全新对话！严禁复用 session.activeThreadId！
  // 必须无条件调用 session.createThread(activeModel) 获取纯净新线程槽位（若前一线程为空则自动复用），
  // 彻底阻断消息向历史对话倒灌！
  const submitLocalFromHome = useCallback(
    (text: string) => {
      if (text.trim() === '') return;
      const session = localChatSessionStore.getState();
      const target = session.createThread(
        localChatStore.getState().config.activeModel
      );
      if (sendLocalChatMessage(target, text)) quickRun.setPrompt('');
      onOpenLocalThread(target);
    },
    [quickRun, onOpenLocalThread]
  );
  // 离线语音输入（W-D）：松开直发——先回填输入框再以显式文本提交；
  // G5b：有已选附件时语音文本走富路径一并发出（附件不滞留）；
  // CON-2：本地模式下识别结果走本地发送（ASR 本就是端侧离线能力，
  // 此前随 editable 被连接态连带误杀，现随模式解封）
  const voice = useVoiceInput({
    onFillText: quickRun.setPrompt,
    onSubmitText: (text) => {
      if (mode === 'local') {
        submitLocalFromHome(text);
      } else if (attachments.attachments.length > 0) {
        quickRun.submitWithAttachments(
          text,
          attachments.attachments,
          composerCtx.activeModelVisionSupported
        );
      } else {
        quickRun.submitText(text);
      }
    },
    notify: showToast,
  });
  const device = useDeviceStatusVm();
  // 未送达汇总入口按压反馈（按压过渡统一批口径）
  const undeliveredPress = usePressFade();
  // 会话操作（G3）：行长按 → 操作 Sheet（改名/置顶/归档/导出/删除）。
  // openActions 本身是控制器内的稳定回调，单独解构作依赖——避免控制器
  // 返回对象每次渲染换引用使本回调与状态板 memo 墙失效（PERF #3）。
  const sessionOps = useSessionOpsController();
  const openSessionActionsFn = sessionOps.openActions;
  const openSessionActions = useCallback(
    (sessionId: string) => {
      const target = sessions.find((s) => s.id === sessionId);
      if (target) openSessionActionsFn(target);
    },
    [sessions, openSessionActionsFn]
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [deviceOpen, setDeviceOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [localModelOpen, setLocalModelOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  // Sheet 懒挂载（PERF #3）：首次打开后才挂载、挂载后保持——主页常驻
  // 面不再背 7 个 Sheet 的完整子树；打开/关闭时序与动画口径不变
  // （关闭仍走 visible=false 的退出动画，组件已在场）。
  const deviceEverOpened = useEverOpened(deviceOpen);
  const workspaceEverOpened = useEverOpened(workspaceOpen);
  const permissionEverOpened = useEverOpened(permissionOpen);
  const modelEverOpened = useEverOpened(modelOpen);
  const localModelEverOpened = useEverOpened(localModelOpen);
  const attachEverOpened = useEverOpened(attachOpen);
  const skillsEverOpened = useEverOpened(skillsOpen);
  const [greeting] = useState(() => greetingFor(new Date().getHours()));
  const { feedback } = quickRun;

  // 【维度 1 保护】：当主屏挂载或用户回到主屏时，若当前存在非空白的活动历史会话，
  // 自动将槽位重置为纯净无选中态，确保抽屉高亮与会话状态完全与主屏新对话语义对齐。
  useEffect(() => {
    const localState = localChatSessionStore.getState();
    if (localState.activeThreadId !== null) {
      localState.resetActiveThread();
    }
    const remoteSelected = sessionStore.getState().selectedSessionId;
    if (remoteSelected !== null) {
      sessionStore.getState().setSelected(null);
    }
  }, []);

  // 键盘弹起 = 输入态：中段（状态板/问候）随键盘升起联动变淡上移
  // （原型 composer-expanded-state）。M6 定案口径（巡检后裁决）：
  // - 驱动源 = 键盘动画自身的逐帧 progress（键盘库动画面
  //   useReanimatedKeyboardAnimation）——与根 KeyboardProvider 同一
  //   数据源（单源纪律：不另接 RN Keyboard 事件、不经离散高度中转），
  //   淡出起止与键盘动画逐帧同步；旧实现用离散高度触发 + 自管 280ms
  //   定时，与系统键盘动画时长无关、起止难同步，已退役；
  // - 下限 = INPUT_FADE_FLOOR 半透明而非全隐（旧实现淡到 0）；
  // - 状态浮层（连接横幅/同步错误/陈旧标注）已拆出本淡出容器（见
  //   下方 JSX 的 home-status-overlay 与 home-board 的同层关系），
  //   输入态下审批与连接信息保持可见。
  const { progress: keyboardProgress } = useReanimatedKeyboardAnimation();
  const fadeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(keyboardProgress.value, [0, 1], [1, INPUT_FADE_FLOOR]),
    transform: [
      { translateY: interpolate(keyboardProgress.value, [0, 1], [0, -6]) },
    ],
  }));

  // 状态板行进出（S3）：行出现/消失走 layout 级过渡——下方行平滑
  // 补位，不再瞬时跳位；问候空态↔列表切换整体交叉淡化。口径与时间线
  // 明确区分：时间线是回收面（条目回收再挂载会闪烁，故明令禁条目
  // 动画）；状态板 ≤4 行、不滚动回收，不适用该禁令。减动效时全部
  // 关闭、直切（共享信号 useReducedMotion）。
  const reduceMotion = useReducedMotion();
  const boardEntering = reduceMotion
    ? undefined
    : FadeIn.duration(theme.motion.duration.fast);
  const boardExiting = reduceMotion
    ? undefined
    : FadeOut.duration(theme.motion.duration.fast);
  // 列表侧的 entering/exiting/layout 由 StatusBoardList 内部同口径
  // 计算（动画对象每渲染新建，不能经 props 穿 memo 墙）

  useEffect(() => {
    if (feedback.kind === 'success') {
      // 发送成功才清空已选附件（失败保留，用户可改后重发）
      clearAttachments();
      onOpenSession(feedback.sessionId);
    } else if (feedback.kind === 'error') showToast(feedback.message, 'error');
  }, [feedback, onOpenSession, showToast, clearAttachments]);

  // 平铺列表数据：未归档会话。排序即优先级口径——store 的 sortSessions 已保证
  // 置顶 → 活动中（activeRunIds 非空，含待审批会话）→ updatedAt 降序，本屏不再重排：
  // 运行中（含待审批）按最近活动在前，已完成按最近更新在后。
  const visibleSessions = useMemo(
    () => sessions.filter((s: SessionSummary) => s.isArchived !== true),
    [sessions]
  );
  // 未送达汇总（批 C 03-4）：outbox 未送达计数（approvalStore 既有
  // 角标面）——状态板只给汇总入口，会话现场才有逐会话行，不两处
  // 各造一套行组件
  const undeliveredCount = useStore(approvalStore, (s) => s.outboxCount);
  // 状态板行合成：远端行仅在 remote 模式参与（数据只来自当前设备作用域
  // 的 sessionStore；本地模式下远端数据是保留快照，不冒充实时状态）；
  // 本地线程行恒参与（手机自身分区）。资格与上限由选择器裁决：审批 >
  // 运行中 > 本次连接后完成，总数 ≤ 4；都不符合 → 空数组 → 问候空态。
  const connectedSinceMs = useStore(connectionStore, (s) => s.connectedSinceMs);
  const listItems = useMemo<HubRow[]>(
    () =>
      selectStatusBoardRows({
        remoteSessions: remoteMode ? visibleSessions : [],
        localThreads: localEntry.localThreads,
        connectedSinceMs,
      }),
    [remoteMode, visibleSessions, localEntry.localThreads, connectedSinceMs]
  );
  // 下拉刷新（M1）：接 useSessionsVm.refresh（现成对账路径，此前备而未
  // 接 UI）。refreshing 本屏局部持有——后台对账（重连/updatedAll 触发）
  // 不亮下拉指示，指示只跟随用户手势这一轮 refresh() 的完成。
  const [refreshing, setRefreshing] = useState(false);
  const handlePullRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);
  // 滚动开始时刷新相对时间基准（回调引用稳定，状态板 memo 墙前提）
  const handleBoardScrollBegin = useCallback(() => {
    setNowMs(Date.now());
  }, []);

  // 相对时间随滚动/交互刷新（不挂定时器，避免常驻唤醒）
  const [nowMs, setNowMs] = useState(() => Date.now());
  const previewOf = useCallback(
    (sessionId: string) => lastPreviewOfWindow(windows[sessionId]),
    [windows]
  );

  // 发送分发（CON-2 按模式）：local → 本地发送 + 导航进本地线程页
  // （附件是远程面能力，本地模式不渲染附件入口，此处不处理附件）；
  // remote → 既有管线（G5b：有已选附件走富路径，否则纯文本）
  const handleSubmit = useCallback(() => {
    // 发送即收附件菜单（锚定 Popover 的关闭路径之一，批 A）
    setAttachOpen(false);
    if (mode === 'local') {
      submitLocalFromHome(quickRun.prompt);
      return;
    }
    if (hasAttachments) {
      quickRun.submitWithAttachments(
        quickRun.prompt,
        attachments.attachments,
        composerCtx.activeModelVisionSupported
      );
    } else {
      quickRun.submit();
    }
  }, [
    mode,
    submitLocalFromHome,
    hasAttachments,
    quickRun,
    attachments.attachments,
    composerCtx.activeModelVisionSupported,
  ]);

  return (
    <Screen avoidKeyboard={false}>
      {/* 头栏：左组 = 汉堡 + 设备胶囊；右侧 = 更多 */}
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + theme.space.xs,
            // 原型 main-header 横向 padding 16
            paddingHorizontal: theme.space.lg,
          },
        ]}
      >
        {/* 原型 header-left-group gap 10 */}
        <View style={[styles.headerGroup, { gap: theme.space.sm + 2 }]}>
          <MenuButton onPress={onOpenDrawer} />
          <DevicePill onPress={() => setDeviceOpen(true)} />
        </View>
        <IconButton
          name="more"
          variant="floating"
          accessibilityLabel="更多选项"
          onPress={() => setMenuOpen(true)}
          testID="home-more"
        />
      </View>

      {/* 中段：状态板/问候空态（输入态联动变淡，容器 testID home-board）；
          状态浮层与中段同层并列、不参与淡出（M6）；方案 05 移除硬件纹理杜绝显存抖动 */}
      <View style={styles.body}>
        <Animated.View
          testID="home-board"
          collapsable={false}
          style={[styles.bodyContent, fadeStyle]}
          // 点外失焦（2026-11-03 用户实测，与会话屏同簇）：中段内容区
          // （问候空态/状态板）原无任何收键盘接线——板列表只有
          // on-drag 一路、空态与大片空白根本不是滚动面，点下去无人
          // 收键盘。onTouchStart 被动通知不认领 responder：板行点按/
          // 长按、空态呈现照常，触摸冒泡到此即收键盘。头栏与底部
          // Composer 是本容器之外的兄弟层，不受影响；状态浮层是
          // box-none 兄弟层、其面板按钮也不经此路。
          onTouchStart={dismissKeyboardForOutsideTap}
        >
          {listItems.length === 0 ? (
            // 状态板无符合项时到这里（不分模式）：时段问候空态——历史
            // 对话不在主页（完整列表在抽屉）；本地模式下 Composer 仍可
            // 编辑，发送即建线程并直达线程页
            <Animated.View
              entering={boardEntering}
              exiting={boardExiting}
              style={[
                styles.hero,
                {
                  gap: theme.space.md,
                  paddingHorizontal: theme.space.screenX,
                },
              ]}
            >
              <AppText variant="title2" style={styles.centerText}>
                {greeting}
              </AppText>
              <AppText
                variant="callout"
                color="textSecondary"
                style={styles.centerText}
              >
                今天想让它做点什么？
              </AppText>
            </Animated.View>
          ) : (
            <StatusBoardList
              items={listItems}
              snippetOf={localEntry.snippetOf}
              previewOf={previewOf}
              nowMs={nowMs}
              onOpenSession={onOpenSession}
              onOpenLocalThread={onOpenLocalThread}
              onLongPressSession={openSessionActions}
              refreshing={refreshing}
              onRefresh={handlePullRefresh}
              onScrollBeginDrag={handleBoardScrollBegin}
            />
          )}
        </Animated.View>
        {/* 状态浮层（2026-11-02 用户裁决）：通知类表面一律悬浮覆盖——
            绝对定位浮于状态板/空态之上，不占布局高度、内容不被顶下去；
            容器 box-none 放行触摸，仅面板本体可点。M6 起浮层位于输入
            淡出容器（home-board）之外，与中段同层并列：打字时横幅/
            同步错误/陈旧标注不跟随中段一起变淡，输入态保持可见。 */}
        <View
          testID="home-status-overlay"
          pointerEvents="box-none"
          style={styles.statusOverlay}
        >
          {mode === 'local' && !localEntry.configured ? (
            // 本地模式横幅（CON-2 + 2026-11-02 晚抑制裁决）：仅本地未
            // 配置时呈——设备未连接（事实 + 排障入口保留），且本地能力
            // 正在顶上（不是纯故障口吻）；本地已配置（密钥已填）后不再
            // 显示，设备身份由设备胶囊承载，常驻通知卡只是噪音。远端/
            // 错误类浮层（下方 SessionSyncBar、陈旧标注）不受此条件影响
            <ConnectionBanner
              phaseLabel="桌面未连接 · 正在使用本地对话"
              lastError={device.lastError}
              onRetry={device.reconnect}
              onSwitch={() => setDeviceOpen(true)}
            />
          ) : null}
          {remoteMode ? (
            // 同步错误浮层：仅 error 呈现（组件内守卫）；syncing/ok/idle
            // 零呈现——无「正在同步…」，用户刷新的反馈走下拉原生指示。
            // local 模式不挂（横幅已说明连接事实），避免双横幅
            <SessionSyncBar
              status={syncStatus}
              error={syncError}
              onRetry={() => void refresh()}
            />
          ) : null}
          {undeliveredCount > 0 ? (
            // 未送达汇总入口（批 C 03-4）：离线决策等待送达是连接
            // 恢复也未必已送出的真实状态，恒在浮层呈现（不分模式：
            // 本地模式正是离线决策的产生场景）；点按去审批中心
            <AnimatedPressable
              testID="home-undelivered-chip"
              accessibilityRole="button"
              accessibilityLabel="审批中心"
              onPress={() => router.push('/approvals')}
              onPressIn={undeliveredPress.onPressIn}
              onPressOut={undeliveredPress.onPressOut}
              style={[
                styles.staleChip,
                styles.undeliveredChip,
                {
                  marginLeft: theme.space.lg,
                  marginTop: theme.space.sm + 2,
                  borderRadius: theme.radius.pill,
                  backgroundColor: theme.colors.surface,
                  paddingHorizontal: theme.space.md,
                  paddingVertical: theme.space.xs,
                  gap: theme.space.xs,
                },
                undeliveredPress.fadeStyle,
              ]}
            >
              <View
                style={[
                  styles.undeliveredDot,
                  {
                    borderRadius: theme.radius.pill,
                    backgroundColor: theme.colors.danger,
                  },
                ]}
              />
              <AppText variant="caption" color="textPrimary">
                {`${undeliveredCount} 条审批决策未送达`}
              </AppText>
            </AnimatedPressable>
          ) : null}
          {remoteMode && snapshotStale && visibleSessions.length > 0 ? (
            // 陈旧标注（CON-3）：断线保留/快照恢复的远端列表是上次同步的
            // 存量，必须明示而非冒充实时列表（接线 dead/资格丢失保留/
            // 快照恢复时置位；对账落盘或真实增量落地即清除——已连接
            // 数据在流时不得残留此标注）。本地线程行不受影响（活数据）。
            <View
              testID="home-snapshot-stale"
              style={[
                styles.staleChip,
                {
                  marginLeft: theme.space.lg,
                  marginTop: theme.space.sm + 2,
                  borderRadius: theme.radius.pill,
                  backgroundColor: theme.colors.surface,
                  paddingHorizontal: theme.space.md,
                  paddingVertical: theme.space.xs,
                },
              ]}
            >
              <AppText variant="caption" color="textSecondary">
                {SNAPSHOT_STALE_LABEL}
              </AppText>
            </View>
          ) : null}
        </View>
      </View>

      {/* 底部 Composer：方案 05 KeyboardStickyView UI 线程硬件位移贴合，消除全屏 Yoga 重排 */}
      <KeyboardStickyView
        style={[
          styles.composerArea,
          {
            paddingHorizontal: theme.space.lg,
            paddingTop: theme.space.sm,
            paddingBottom: Math.max(insets.bottom, theme.space.sm),
          },
        ]}
      >
        {/* 宏观贯穿环境遮蔽大软阴影：位于最底层，贯穿全宽，自输入框容器顶缘向上消散 28dp */}
        <ComposerAmbientVeil testID="composer-ambient-veil" />

        {/* 附件菜单（批 A 锚定 Popover 形态）：渲染在 StickyView 内、
            composer 正上方——开合不收键盘（双政策的保键盘面）；
            everOpened 门保留（首开前不挂载，同 Sheet 族先例） */}
        {attachEverOpened ? (
          <AttachmentSheet
            visible={attachOpen}
            onClose={() => setAttachOpen(false)}
            onTakePhoto={attachments.pickFromCamera}
            onPickImage={attachments.pickFromLibrary}
            onPickFile={attachments.pickFromFiles}
            skillsCount={skillsVm.skillsCount}
            onOpenSkills={() => {
              skillsVm.openList();
              setSkillsOpen(true);
            }}
            testID="home-attachment-sheet"
          />
        ) : null}
        <AttachmentStrip
          attachments={attachments.attachments}
          onRemove={attachments.remove}
          picking={attachments.picking}
          testID="home-attachment-strip"
        />
        <Composer
          testID="home-composer"
          placeholder={
            remoteMode || localEntry.configured
              ? DEFAULT_COMPOSER_PLACEHOLDER
              : '先配置本地供应商后即可对话'
          }
          value={quickRun.prompt}
          onChangeText={quickRun.setPrompt}
          onSubmit={handleSubmit}
          canSubmit={
            remoteMode
              ? quickRun.canSubmit ||
                (quickRun.connected && !quickRun.busy && hasAttachments)
              : quickRun.prompt.trim().length > 0 && !localEntry.streaming
          }
          // 仅在明确忙碌时锁定编辑；未连接状态下放开编辑草稿与语音录制（方案 01 解耦）
          editable={
            remoteMode
              ? !quickRun.busy
              : // 本地模式解封（CON-2）：与连接态无关，仅本地生成中锁定
                !localEntry.streaming
          }
          maxLength={4096}
          voice={voice}
          onAttachPress={
            remoteMode
              ? // ＋ = 附件菜单开关（toggle：锚定 Popover 无全屏关闭层，
                // 再点 ＋ 收起，批 A 双政策）
                () => setAttachOpen((v) => !v)
              : () =>
                  // 输入框形态不分模式（用户裁定）：附件钮在本地也在场。
                  // 附件随消息发往桌面执行，本地对话不承载——点按给诚实
                  // 提示，不藏钮、不假装可用。
                  showToast('本地对话暂不支持附件', 'info')
          }
          hasAttachments={hasAttachments}
          contextBar={
            // 工作区/权限是连上电脑才有的概念（用户 2026-11-02 22:05
            // 裁决细化，净化 M-删9/10）：本地模式不注入 contextBar——
            // Composer 未注入即不渲染选择行，不再假显示 + 点按弹解释
            // toast。输入框的两行形态（输入行 + 工具/模型行）不分模式，
            // 不受影响；远端模式注入真实选择行，口径不变。
            remoteMode
              ? {
                  workspaceLabel: composerCtx.workspaceLabel,
                  permissionLabel: composerCtx.permissionLabel,
                  onWorkspacePress: () => {
                    composerCtx.openWorkspaceList();
                    setWorkspaceOpen(true);
                  },
                  onPermissionPress: () => setPermissionOpen(true),
                }
              : undefined
          }
          model={
            remoteMode
              ? {
                  label: composerCtx.modelLabel,
                  onPress: () => {
                    composerCtx.openModelList();
                    setModelOpen(true);
                  },
                }
              : {
                  // 本地模式：模型钮改指本地 selection（localChatStore）；
                  // 未配置时点按直达供应商配置，不冒充可选模型
                  label: localEntry.activeLabel ?? '未配置供应商',
                  onPress: () => {
                    if (localEntry.configured) setLocalModelOpen(true);
                    else router.push('/settings-local-providers');
                  },
                }
          }
        />
      </KeyboardStickyView>

      {/* 右上更多下拉：真实入口（通知中心 / 偏好设置） */}
      <DropdownMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        top={insets.top + theme.size.header + theme.space.md}
        right={theme.space.md}
        testID="home-menu"
        entries={[
          {
            key: 'notifications',
            label: '通知中心',
            icon: 'bell',
            onPress: onOpenNotifications,
          },
          {
            key: 'settings',
            label: '偏好设置',
            icon: 'settings',
            onPress: () => router.push('/settings'),
          },
        ]}
      />

      {/* 连接设备 Sheet（懒挂载：首次打开后才进常驻面，PERF #3） */}
      {deviceEverOpened ? (
        <DeviceSheet
          visible={deviceOpen}
          onClose={() => setDeviceOpen(false)}
          device={device}
          onOpenScan={() => router.push('/pair/scan')}
          onUseLocal={() => {
            // 「现在用本地」落点（界面统一 U3）：回主页即本地能力面
            // （本地对话不再有独立页），关 Sheet 并 navigate 回既有
            // 主页路由，不压新栈
            setDeviceOpen(false);
            router.navigate('/');
          }}
          testID="home-device-sheet"
        />
      ) : null}

      {/* 项目选择 Sheet（G1：复用文件页 WorkspaceSheet 数据面） */}
      {workspaceEverOpened ? (
        <WorkspaceSheet
          visible={workspaceOpen}
          onClose={() => setWorkspaceOpen(false)}
          workspaces={composerCtx.workspaces ?? []}
          status={composerCtx.workspacesStatus}
          activeRoot={composerCtx.activeWorkspaceRoot ?? ''}
          switching={composerCtx.switchingWorkspace}
          onSelect={(root) => {
            composerCtx.selectWorkspace(root);
            setWorkspaceOpen(false);
          }}
          onRetry={composerCtx.retryWorkspaces}
        />
      ) : null}

      {/* 权限模式 Sheet（G1：桌面三档对齐，选择即持久化） */}
      {permissionEverOpened ? (
        <PermissionModeSheet
          visible={permissionOpen}
          onClose={() => setPermissionOpen(false)}
          value={composerCtx.permissionMode}
          onSelect={(mode) => {
            composerCtx.setPermissionMode(mode);
            setPermissionOpen(false);
          }}
          testID="home-permission-sheet"
        />
      ) : null}

      {/* 模型选择 Sheet（G2：真实列表 + 全局默认切换，桌面同一真源） */}
      {modelEverOpened ? (
        <ModelSheet
          visible={modelOpen}
          onClose={() => setModelOpen(false)}
          connected={composerCtx.connected}
          models={composerCtx.models}
          status={composerCtx.modelsStatus}
          activeModelId={composerCtx.activeModelId}
          activeModel={composerCtx.activeModel}
          activeModelSelectable={composerCtx.activeModelSelectable}
          switching={composerCtx.switchingModel}
          errorCode={composerCtx.modelsError}
          onSelectModel={(providerId, modelId) => {
            void composerCtx.selectModel(providerId, modelId).then((ok) => {
              if (ok) setModelOpen(false);
            });
          }}
          onRetry={composerCtx.retryModels}
          testID="home-model-sheet"
        />
      ) : null}

      {/* 本地模型选择 Sheet（CON-2：本地模式模型钮；本机供应商配置面） */}
      {localModelEverOpened ? (
        <LocalModelSheet
          visible={localModelOpen}
          onClose={() => setLocalModelOpen(false)}
          onOpenProviders={() => {
            setLocalModelOpen(false);
            router.push('/settings-local-providers');
          }}
          testID="home-local-model-sheet"
        />
      ) : null}

      {/* 附件菜单已移入上方 KeyboardStickyView 内（批 A 锚定 Popover
          形态，见 composer 区注释）——此处不再渲染 */}

      {/* 技能目录 Sheet（G7：宿主技能发现只读浏览，桌面同一真源） */}
      {skillsEverOpened ? (
        <SkillsSheet
          visible={skillsOpen}
          onClose={() => setSkillsOpen(false)}
          connected={skillsVm.connected}
          skills={skillsVm.skills}
          status={skillsVm.status}
          errorCode={skillsVm.errorCode}
          onRetry={skillsVm.retry}
          testID="home-skills-sheet"
        />
      ) : null}

      {/* 会话操作层（G3：操作 Sheet + 改名弹窗 + 删除确认） */}
      {sessionOps.layer}
    </Screen>
  );
}

interface StatusBoardListProps {
  items: HubRow[];
  /** 本地行摘要（生成中取实时内容摘取，否则 meta.preview；VM 已 memo） */
  snippetOf: (threadId: string) => string;
  /** 远端行摘要（事件窗口预览） */
  previewOf: (sessionId: string) => string;
  nowMs: number;
  onOpenSession: (sessionId: string) => void;
  onOpenLocalThread: (threadId: string) => void;
  onLongPressSession: (sessionId: string) => void;
  refreshing: boolean;
  onRefresh: () => void;
  onScrollBeginDrag: () => void;
}

/**
 * 状态板列表（PERF #3 的 memo 墙）：主页逐键输入只应重渲 Composer。
 * 本组件的 props 全部引用稳定——行数据经 selectStatusBoardRows 与
 * useLocalHubEntryVm 的 memo 备料、回调经宿主 useCallback、动画对象在
 * 组件内由 theme/减动效（稳定输入）计算——宿主因 prompt 变化重渲时
 * memo 命中，整段列表跳过。行进出动画（S3）数值与迁出前一致。
 */
const StatusBoardList = memo(function StatusBoardList({
  items,
  snippetOf,
  previewOf,
  nowMs,
  onOpenSession,
  onOpenLocalThread,
  onLongPressSession,
  refreshing,
  onRefresh,
  onScrollBeginDrag,
}: StatusBoardListProps) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const boardEntering = reduceMotion
    ? undefined
    : FadeIn.duration(theme.motion.duration.fast);
  const boardExiting = reduceMotion
    ? undefined
    : FadeOut.duration(theme.motion.duration.fast);
  const boardLayout = reduceMotion
    ? undefined
    : LinearTransition.duration(theme.motion.duration.normal);
  return (
    <Animated.View
      entering={boardEntering}
      exiting={boardExiting}
      style={styles.listWrap}
    >
      <FlatList
        testID="home-chat-list"
        data={items}
        keyExtractor={(item) =>
          item.kind === 'local' ? `local-${item.id}` : item.id
        }
        renderItem={({ item, index }) => (
          // S3：每行包一层 layout 动画壳——行进出交叉淡化、兄弟行
          // 位置变化走 LinearTransition 平滑补位（状态板 ≤4 行、
          // 非回收面，口径见 HomeScreen 的 boardEntering 处注释）
          <Animated.View
            entering={boardEntering}
            exiting={boardExiting}
            layout={boardLayout}
          >
            {item.kind === 'local' ? (
              <LocalChatHubRow
                threadId={item.thread.id}
                title={item.thread.title}
                snippet={snippetOf(item.thread.id)}
                streaming={item.streaming}
                time={formatRelativeTime(item.thread.updatedAt, nowMs)}
                isLast={index === items.length - 1}
                onPress={() => onOpenLocalThread(item.thread.id)}
              />
            ) : (
              <ChatFlatItem
                session={item.session}
                snippet={previewOf(item.session.id)}
                nowMs={nowMs}
                isLast={index === items.length - 1}
                onPress={onOpenSession}
                onLongPress={onLongPressSession}
              />
            )}
          </Animated.View>
        )}
        contentContainerStyle={[
          styles.listContent,
          {
            // 原型 chat-list 横向 padding 22
            paddingHorizontal: theme.space.screenX + 2,
            paddingTop: theme.space.lg,
            gap: theme.space.messageGap,
          },
          // 少条目垂直居中（原型视距）：listContent 的 flexGrow 让容器随内容
          // 增长，内容超出视口后居中自然失效、回到顶部滚动，故恒定应用。
          styles.listCentered,
        ]}
        onScrollBeginDrag={onScrollBeginDrag}
        keyboardDismissMode="on-drag"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      />
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerGroup: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    flex: 1,
  },
  listWrap: {
    flex: 1,
  },
  statusOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  staleChip: {
    alignSelf: 'flex-start',
  },
  undeliveredChip: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  // 圆角走 theme.radius.pill（内联注入，styleTokens 守卫禁数字圆角）
  undeliveredDot: {
    width: 8,
    height: 8,
  },
  hero: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerText: { textAlign: 'center' },
  listContent: {
    flexGrow: 1,
  },
  listCentered: {
    justifyContent: 'center',
  },
  composerArea: {
    flexShrink: 1,
  },
});
