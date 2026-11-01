// 主屏（原型 main-screen 移植）：头栏左组【汉堡 · 设备胶囊】+ 右侧更多下拉；
// 离线白色横幅；平铺会话列表（标题/状态/时间/摘要，虚线分隔，少条目垂直居中）；
// 底部 Composer。
// 会话优先级（产品口径）：正在运行的对话（含待审批）置顶、按最近活动排序，其后为
// 已完成对话按最近更新排序——由 store 的 sortSessions 保证（置顶 → 活动 → updatedAt
// 降序），本屏只过滤归档、不再二次排序。空态分连接态：连接后无会话 = 时段问候；
// 未连接 = 明确的未连接空态（与问候区分，其上另有离线横幅）。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { useKeyboardHeight } from '@/adapters/platform/useKeyboardHeight';
import { useDeviceStatusVm } from '@/adapters/viewmodels/useDeviceStatusVm';
import { useQuickRunVm } from '@/adapters/viewmodels/useQuickRunVm';
import { useComposerContextVm } from '@/adapters/viewmodels/useComposerContextVm';
import { useSkillsVm } from '@/adapters/viewmodels/useSkillsVm';
import { useComposerAttachments } from '@/adapters/viewmodels/useComposerAttachments';
import { useVoiceInput } from '@/adapters/asr/useVoiceInput';
import { useSessionsVm } from '@/adapters/viewmodels/useSessionsVm';
import { lastPreviewOfWindow } from '@/domain/pure/sessionPreview';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import {
  AppText,
  Composer,
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
import { PermissionModeSheet } from '@/presentation/components/chat/PermissionModeSheet';
import { SkillsSheet } from '@/presentation/components/chat/SkillsSheet';
import { WorkspaceSheet } from '@/presentation/components/files/WorkspaceSheet';
import { ChatFlatItem } from '@/presentation/components/sessions/ChatFlatItem';
import { useSessionOpsController } from '@/presentation/components/sessions/useSessionOpsController';

/** 问候语按本地时段切换 */
export function greetingFor(hour: number): string {
  if (hour < 5) return '夜深了';
  if (hour < 12) return '早上好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

export interface HomeScreenProps {
  onOpenDrawer: () => void;
  onOpenNotifications: () => void;
  /** 会话打开（列表点按与新建会话回跳共用） */
  onOpenSession: (sessionId: string) => void;
}

export default function HomeScreen({
  onOpenDrawer,
  onOpenNotifications,
  onOpenSession,
}: HomeScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { showToast } = useToast();
  const { sessions, windows, connected } = useSessionsVm();
  const quickRun = useQuickRunVm();
  // Composer 上下文（G1）：快捷条项目/权限 + 展开行模型钮的数据面
  const composerCtx = useComposerContextVm();
  // 技能目录（G7）：附件面板入口计数 + SkillsSheet 数据面（只读）
  const skillsVm = useSkillsVm();
  // 已选附件（G5b）：选取/移除在本屏管理；发送成功随 feedback 清空，
  // 失败保留（VM 的 clear 只在成功路径调用）
  const attachments = useComposerAttachments({ notify: showToast });
  const clearAttachments = attachments.clear;
  const hasAttachments = attachments.attachments.length > 0;
  // 离线语音输入（W-D）：松开直发——先回填输入框再以显式文本提交；
  // G5b：有已选附件时语音文本走富路径一并发出（附件不滞留）
  const voice = useVoiceInput({
    onFillText: quickRun.setPrompt,
    onSubmitText: (text) => {
      if (attachments.attachments.length > 0) {
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
  // 会话操作（G3）：行长按 → 操作 Sheet（改名/置顶/归档/导出/删除）
  const sessionOps = useSessionOpsController();
  const openSessionActions = useCallback(
    (sessionId: string) => {
      const target = sessions.find((s) => s.id === sessionId);
      if (target) sessionOps.openActions(target);
    },
    [sessions, sessionOps]
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [deviceOpen, setDeviceOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [greeting] = useState(() => greetingFor(new Date().getHours()));
  const { feedback } = quickRun;

  // 键盘弹起 = 输入态：列表与横幅联动淡出上移（原型 composer-expanded-state，
  // 0.28s emphasized——§3.3 #25 全局动效口径）。jest 环境由 jest.setup 的
  // reanimated 桩提供 Easing.bezier（M8 补桩），测试与真机同走 token 曲线。
  const keyboardHeight = useKeyboardHeight();
  const composing = keyboardHeight > 0;
  const fade = useSharedValue(0);
  useEffect(() => {
    fade.value = withTiming(composing ? 1 : 0, {
      duration: theme.motion.duration.expand,
      easing: Easing.bezier(...theme.motion.easing.emphasized),
    });
  }, [
    composing,
    fade,
    theme.motion.duration.expand,
    theme.motion.easing.emphasized,
  ]);
  const fadeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(fade.value, [0, 1], [1, 0]),
    transform: [{ translateY: interpolate(fade.value, [0, 1], [0, -6]) }],
  }));

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
  // 相对时间随滚动/交互刷新（不挂定时器，避免常驻唤醒）
  const [nowMs, setNowMs] = useState(() => Date.now());
  const previewOf = useCallback(
    (sessionId: string) => lastPreviewOfWindow(windows[sessionId]),
    [windows]
  );

  // 发送分发（G5b）：有已选附件走富路径（组装 + 预检在 VM），否则纯文本
  const handleSubmit = useCallback(() => {
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
    hasAttachments,
    quickRun,
    attachments.attachments,
    composerCtx.activeModelVisionSupported,
  ]);

  return (
    <Screen avoidKeyboard>
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

      {/* 中段：横幅 + 平铺列表（输入态联动淡出） */}
      <Animated.View style={[styles.body, fadeStyle]}>
        {!connected ? (
          <ConnectionBanner
            phaseLabel={device.phaseLabel}
            lastError={device.lastError}
            onRetry={device.reconnect}
            onSwitch={() => setDeviceOpen(true)}
          />
        ) : null}
        {visibleSessions.length === 0 ? (
          !connected ? (
            // 未连接空态：与连接后的问候空态明确区分（上方另有离线横幅）
            <View
              style={[
                styles.hero,
                {
                  gap: theme.space.md,
                  paddingHorizontal: theme.space.screenX,
                },
              ]}
            >
              <AppText variant="title2" style={styles.centerText}>
                尚未连接桌面
              </AppText>
              <AppText
                variant="callout"
                color="textSecondary"
                style={styles.centerText}
              >
                连接后，这里会优先显示正在运行的对话
              </AppText>
            </View>
          ) : (
            <View
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
            </View>
          )
        ) : (
          <FlatList
            testID="home-chat-list"
            data={visibleSessions}
            keyExtractor={(session) => session.id}
            renderItem={({ item, index }) => (
              <ChatFlatItem
                session={item}
                snippet={previewOf(item.id)}
                nowMs={nowMs}
                isLast={index === visibleSessions.length - 1}
                onPress={onOpenSession}
                onLongPress={openSessionActions}
              />
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
            onScrollBeginDrag={() => setNowMs(Date.now())}
          />
        )}
      </Animated.View>

      {/* 底部 Composer */}
      <View
        style={[
          styles.composerArea,
          {
            paddingHorizontal: theme.space.lg,
            paddingTop: theme.space.sm,
            paddingBottom: Math.max(insets.bottom, theme.space.sm),
          },
        ]}
      >
        <AttachmentStrip
          attachments={attachments.attachments}
          onRemove={attachments.remove}
          testID="home-attachment-strip"
        />
        <Composer
          testID="home-composer"
          placeholder={connected ? '发消息…' : '未连接'}
          value={quickRun.prompt}
          onChangeText={quickRun.setPrompt}
          onSubmit={handleSubmit}
          canSubmit={
            quickRun.canSubmit ||
            (quickRun.connected && !quickRun.busy && hasAttachments)
          }
          editable={connected && !quickRun.busy}
          maxLength={4096}
          voice={voice}
          onAttachPress={() => setAttachOpen(true)}
          hasAttachments={hasAttachments}
          contextBar={{
            workspaceLabel: composerCtx.workspaceLabel,
            permissionLabel: composerCtx.permissionLabel,
            onWorkspacePress: () => {
              composerCtx.openWorkspaceList();
              setWorkspaceOpen(true);
            },
            onPermissionPress: () => setPermissionOpen(true),
          }}
          model={{
            label: composerCtx.modelLabel,
            onPress: () => {
              composerCtx.openModelList();
              setModelOpen(true);
            },
          }}
        />
      </View>

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

      {/* 连接设备 Sheet */}
      <DeviceSheet
        visible={deviceOpen}
        onClose={() => setDeviceOpen(false)}
        device={device}
        onOpenScan={() => router.push('/pair/scan')}
        testID="home-device-sheet"
      />

      {/* 项目选择 Sheet（G1：复用文件页 WorkspaceSheet 数据面） */}
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

      {/* 权限模式 Sheet（G1：桌面三档对齐，选择即持久化） */}
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

      {/* 模型选择 Sheet（G2：真实列表 + 全局默认切换，桌面同一真源） */}
      <ModelSheet
        visible={modelOpen}
        onClose={() => setModelOpen(false)}
        connected={composerCtx.connected}
        models={composerCtx.models}
        status={composerCtx.modelsStatus}
        activeModelId={composerCtx.activeModelId}
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

      {/* 附件面板（G5b：拍照/相册/文件三入口，选取即处理） */}
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

      {/* 技能目录 Sheet（G7：宿主技能发现只读浏览，桌面同一真源） */}
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

      {/* 会话操作层（G3：操作 Sheet + 改名弹窗 + 删除确认） */}
      {sessionOps.layer}
    </Screen>
  );
}

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
