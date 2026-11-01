// 会话页（原型 conversation-screen 移植）：
// - 消息流全屏滚动，上下边缘羽化（EdgeFade），头栏/输入框通透悬浮其上；
// - 悬浮头栏 = 返回白圆钮 + 标题胶囊 + 更多（下拉菜单：运行详情/终端输出/工具调用）；
// - 审批统一交给全局 ApprovalFloat（悬浮于输入框上方）；
//   本会话有待审批时 Composer 锁定（原型 approval-locked：输入禁用、占位不换文，
//   锁定以容器实心 + 工具图标变淡的形态表达）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { useSessionStore } from '@/adapters/hooks/useAppStore';
import { sessionStore } from '@/domain/store/sessionStore';
import { useSessionComposer } from '@/adapters/viewmodels/useSessionComposer';
import { useComposerContextVm } from '@/adapters/viewmodels/useComposerContextVm';
import { useSkillsVm } from '@/adapters/viewmodels/useSkillsVm';
import { useComposerAttachments } from '@/adapters/viewmodels/useComposerAttachments';
import { useVoiceInput } from '@/adapters/asr/useVoiceInput';
import { ensureSessionHistory } from '@/adapters/runtime/appRuntime';
import {
  buildSessionTimeline,
  type TimelineBlock,
} from '@/presentation/timeline/buildTimeline';
import type { DisplayBlock } from '@/presentation/timeline/groupToolRuns';
import { TimelineView } from '@/presentation/timeline/TimelineView';
import {
  latestRunIdOf,
  useSessionWindow,
} from '@/presentation/timeline/useSessionWindow';
import { SessionHeader } from '@/presentation/components/chat/SessionHeader';
import {
  AttachmentStrip,
  ATTACHMENT_STRIP_HEIGHT,
} from '@/presentation/components/chat/AttachmentStrip';
import { AttachmentSheet } from '@/presentation/components/chat/AttachmentSheet';
import { ModelSheet } from '@/presentation/components/chat/ModelSheet';
import { SkillsSheet } from '@/presentation/components/chat/SkillsSheet';
import { useSessionOpsController } from '@/presentation/components/sessions/useSessionOpsController';
import { PermissionModeSheet } from '@/presentation/components/chat/PermissionModeSheet';
import { WorkspaceSheet } from '@/presentation/components/files/WorkspaceSheet';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';
import {
  AppText,
  Composer,
  DropdownMenu,
  EdgeFade,
  Screen,
  ScrollToBottomButton,
  useToast,
} from '@/presentation/ui';

export interface SessionDetailScreenProps {
  sessionId: string;
  onOpenRun?: (runId: string) => void;
  onOpenTerminal?: (runId: string) => void;
  /** 打开工具抽屉；focusId 为某组首个工具 id */
  onOpenTools?: (focusId?: string) => void;
}

export default function SessionDetailScreen({
  sessionId,
  onOpenRun,
  onOpenTerminal,
  onOpenTools,
}: SessionDetailScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const goBack = useSafeBack();
  const window = useSessionWindow(sessionId);
  const summary = useSessionStore((s) =>
    s.sessions.find((item) => item.id === sessionId)
  );
  const [follow, setFollow] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  // 会话操作（G3）：··· 菜单直达改名/置顶/归档/导出/删除；删本会话后返回
  const sessionOps = useSessionOpsController({
    onSessionDeleted: (deletedId) => {
      if (deletedId === sessionId) goBack();
    },
  });
  // Composer 上下文（G1）：快捷条项目/权限 + 展开行模型钮（与主屏同一数据面）
  const composerCtx = useComposerContextVm();
  // 技能目录（G7）：附件面板入口计数 + SkillsSheet 数据面（只读）
  const skillsVm = useSkillsVm();
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const listRef = useRef<FlatList<DisplayBlock> | null>(null);
  const [localPrompts, setLocalPrompts] = useState<
    { id: string; text: string; atMs: number }[]
  >([]);

  const composer = useSessionComposer(sessionId, (prompt, runId) => {
    setLocalPrompts((current) => [
      ...current,
      { id: `local-${runId}`, text: prompt, atMs: Date.now() },
    ]);
  });

  const { showToast } = useToast();
  // 已选附件（G5b）：发送成功清空、失败保留（清空只发生在成功回执后）
  const attachments = useComposerAttachments({ notify: showToast });
  const hasAttachments = attachments.attachments.length > 0;
  // 富提交（G5b）：组装 + 预检在 VM；成功后清空已选区
  const submitRich = useCallback(
    (rawText: string) => {
      void composer
        .submitWithAttachments(
          rawText,
          attachments.attachments,
          composerCtx.activeModelVisionSupported
        )
        .then((ok) => {
          if (ok) attachments.clear();
        });
    },
    [composer, attachments, composerCtx.activeModelVisionSupported]
  );
  // 离线语音输入（W-D）：松开直发——先回填输入框再以显式文本提交；
  // G5b：有已选附件时语音文本走富路径一并发出（附件不滞留）
  const voice = useVoiceInput({
    onFillText: composer.setPrompt,
    onSubmitText: (text) => {
      if (attachments.attachments.length > 0) {
        submitRich(text);
      } else {
        void composer.submitText(text);
      }
    },
    notify: showToast,
  });

  const currentRunId = latestRunIdOf(
    window.entries,
    summary?.engineLastRunId ?? null
  );

  const blocks = useMemo(() => {
    const base = buildSessionTimeline(window.entries);
    const prompts = localPrompts.map<TimelineBlock>((prompt) => ({
      kind: 'message',
      id: prompt.id,
      role: 'user',
      text: prompt.text,
      streaming: false,
      atMs: prompt.atMs,
    }));
    if (prompts.length === 0) return base;
    return [...base, ...prompts].sort((a, b) => a.atMs - b.atMs);
  }, [window.entries, localPrompts]);
  const hasTools = blocks.some((block) => block.kind === 'tool');

  useEffect(() => {
    ensureSessionHistory(sessionId);
  }, [sessionId]);

  useEffect(() => {
    if (follow && window.lastSeq > 0) {
      sessionStore.getState().markRead(sessionId, window.lastSeq);
    }
  }, [follow, sessionId, window.lastSeq]);

  const handleSent = useCallback(() => {
    setFollow(true);
  }, []);

  useEffect(() => {
    if (composer.feedback.kind === 'success') handleSent();
  }, [composer.feedback.kind, handleSent]);

  // 原型 approval-locked：本会话待审批未决时锁定输入（占位文案保持不变）
  const approvalLocked = (summary?.pendingApprovalCount ?? 0) > 0;
  const editable = composer.connected && !composer.busy && !approvalLocked;

  // 悬浮 Composer 区高度估算（羽化与回到底部按钮的偏移基准）；
  // G1 起含快捷条高度（胶囊 22 + 下距 5，随 Composer 一体悬浮）；
  // G5b：已选附件条呈现时再叠其高度
  const composerBlockHeight =
    theme.size.composerMin +
    27 +
    theme.space.xl +
    Math.max(insets.bottom, theme.space.sm) +
    (hasAttachments ? ATTACHMENT_STRIP_HEIGHT : 0);

  const menuEntries = useMemo(
    () => [
      ...(currentRunId && onOpenRun
        ? [
            {
              key: 'run',
              label: '运行详情',
              icon: 'eye' as const,
              onPress: () => onOpenRun(currentRunId),
            },
          ]
        : []),
      ...(currentRunId && onOpenTerminal
        ? [
            {
              key: 'terminal',
              label: '终端输出',
              icon: 'terminal' as const,
              onPress: () => onOpenTerminal(currentRunId),
            },
          ]
        : []),
      ...(hasTools && onOpenTools
        ? [
            {
              key: 'tools',
              label: '工具调用',
              icon: 'folder' as const,
              onPress: () => onOpenTools(),
            },
          ]
        : []),
      // 会话操作（G3：与抽屉/主屏行操作同一命令面；删除走确认弹窗）
      ...(summary
        ? [
            {
              key: 'pin',
              label: summary.isPinned ? '取消置顶' : '置顶会话',
              onPress: () => sessionOps.togglePin(summary),
            },
            {
              key: 'rename',
              label: '重命名',
              onPress: () => sessionOps.renameSession(summary),
            },
            {
              key: 'archive',
              label: summary.isArchived ? '取消归档' : '归档会话',
              onPress: () => sessionOps.toggleArchive(summary),
            },
            {
              key: 'export',
              label: '导出 Markdown',
              onPress: () => sessionOps.exportSession(summary),
            },
            { key: 'ops-divider', divider: true as const },
            {
              key: 'delete',
              label: '删除会话',
              danger: true,
              onPress: () => sessionOps.deleteSession(summary),
            },
          ]
        : []),
    ],
    [
      currentRunId,
      hasTools,
      onOpenRun,
      onOpenTerminal,
      onOpenTools,
      summary,
      sessionOps,
    ]
  );

  return (
    <Screen>
      {/* 全屏消息流（头栏与 Composer 均悬浮其上） */}
      <TimelineView
        blocks={blocks}
        follow={follow}
        onFollowChange={setFollow}
        listRef={listRef}
        onOpenTools={onOpenTools}
        headerClearance={insets.top + theme.size.header + theme.space.lg}
      />

      {/* 上下羽化：内容临近边缘渐隐（含头栏/输入框背后的过渡区） */}
      <EdgeFade
        side="top"
        height={insets.top + theme.size.header + theme.space.lg}
      />
      <EdgeFade side="bottom" height={composerBlockHeight + theme.space.xl} />

      {/* 悬浮头栏（通透，无底色） */}
      <SessionHeader
        title={summary?.title?.trim() || '会话'}
        onBack={goBack}
        onMore={() => setMenuOpen(true)}
      />

      {!follow ? (
        <ScrollToBottomButton
          bottomOffset={composerBlockHeight + theme.space.section}
          onPress={() => {
            listRef.current?.scrollToEnd({ animated: true });
            setFollow(true);
          }}
          testID="session-back-to-bottom"
        />
      ) : null}

      {/* 悬浮 Composer（透明底，白胶囊直接浮于滚动层上方） */}
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
        {composer.feedback.kind === 'error' ? (
          <AppText
            variant="caption"
            color="danger"
            style={{ paddingHorizontal: theme.space.lg }}
          >
            {composer.feedback.message}
          </AppText>
        ) : null}
        <AttachmentStrip
          attachments={attachments.attachments}
          onRemove={attachments.remove}
          testID="session-attachment-strip"
        />
        <Composer
          testID="session-composer"
          placeholder={composer.connected ? '回复助手或发送指令…' : '未连接'}
          value={composer.prompt}
          onChangeText={composer.setPrompt}
          onSubmit={() => {
            if (hasAttachments) submitRich(composer.prompt);
            else void composer.submit();
          }}
          canSubmit={
            (composer.canSubmit ||
              (composer.connected && !composer.busy && hasAttachments)) &&
            !approvalLocked
          }
          editable={editable}
          locked={approvalLocked}
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

      {/* 会话选项下拉：真实能力（运行详情 / 终端输出 / 工具调用） */}
      <DropdownMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        top={insets.top + theme.size.header + theme.space.md}
        right={theme.space.md}
        testID="session-menu"
        entries={menuEntries}
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
        testID="session-permission-sheet"
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
        testID="session-model-sheet"
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
        testID="session-attachment-sheet"
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
        testID="session-skills-sheet"
      />

      {/* 会话操作层（G3：改名弹窗 + 删除确认；本页无行 Sheet 入口） */}
      {sessionOps.layer}
    </Screen>
  );
}

const styles = StyleSheet.create({
  composerArea: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
});
