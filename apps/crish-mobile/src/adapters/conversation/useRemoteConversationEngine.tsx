// 远端会话引擎适配（移动界面统一方案 §2.1）：把原会话页的全部接线
// （事件窗口 / 时间线投影 / Composer / 上下文 / 附件 / 语音 / 会话操作 /
// 五种 Sheet）收进适配器，向统一 ConversationScreen 供能力面。
// U1 为接线平移：行为、时序、文案与迁移前逐项等价，不改任何呈现。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/adapters/platform/theme';
import {
  AnimatedPressable,
  usePressFade,
} from '@/presentation/ui/pressFeedback';
import { useSessionStore } from '@/adapters/hooks/useAppStore';
import { sessionStore } from '@/domain/store/sessionStore';
import { useSessionComposer } from '@/adapters/viewmodels/useSessionComposer';
import { useSendQueue } from '@/adapters/viewmodels/useSendQueue';
import { useUndeliveredVm } from '@/adapters/viewmodels/useUndeliveredVm';
import { UNDELIVERED_FAMILY_LABEL } from '@/domain/pure/undelivered';
import { retireNotificationsForSession } from '@/notifications/retireOnSessionOpen';
import type { SendQueueItem } from '@/domain/store/sendQueueStore';
import { useComposerContextVm } from '@/adapters/viewmodels/useComposerContextVm';
import { useSkillsVm } from '@/adapters/viewmodels/useSkillsVm';
import { useComposerAttachments } from '@/adapters/viewmodels/useComposerAttachments';
import { useVoiceInput } from '@/adapters/asr/useVoiceInput';
import { ensureSessionHistory } from '@/adapters/runtime/appRuntime';
import {
  buildSessionTimeline,
  type TimelineBlock,
} from '@/presentation/timeline/buildTimeline';
import {
  latestRunIdOf,
  useSessionWindow,
} from '@/presentation/timeline/useSessionWindow';
import { AttachmentStrip } from '@/presentation/components/chat/AttachmentStrip';
import { AttachmentSheet } from '@/presentation/components/chat/AttachmentSheet';
import { SendQueueRows } from '@/presentation/components/chat/SendQueueRows';
import { UndeliveredRow } from '@/presentation/components/chat/UndeliveredRow';
import { ModelSheet } from '@/presentation/components/chat/ModelSheet';
import { SkillsSheet } from '@/presentation/components/chat/SkillsSheet';
import { useSessionOpsController } from '@/presentation/components/sessions/useSessionOpsController';
import { PermissionModeSheet } from '@/presentation/components/chat/PermissionModeSheet';
import { WorkspaceSheet } from '@/presentation/components/files/WorkspaceSheet';
import { useSafeBack } from '@/presentation/navigation/useSafeBack';
import { AppText, useToast } from '@/presentation/ui';
import type { DropdownMenuEntry } from '@/presentation/ui/DropdownMenu';
import type { ConversationEngine } from './types';
import { createLocalPromptEchoCache } from './localPromptEcho';

/** 宿主导航面（路由层供给：运行/终端/工具子页的打开方式） */
export interface RemoteConversationNav {
  onOpenRun?: (runId: string) => void;
  onOpenTerminal?: (runId: string) => void;
  /** 打开工具抽屉；focusId 为某组首个工具 id */
  onOpenTools?: (focusId?: string) => void;
}

/** 与宿主 ConversationScreen 的跟随态同步面（时间线跟随由宿主持有的 UI 态） */
export interface RemoteConversationSync {
  /** 时间线跟随态：跟随中且窗口有新事件时标已读（原会话页 markRead 语义） */
  follow: boolean;
  /** 发送成功回调（宿主据此恢复跟随，原 handleSent 语义） */
  onSendSuccess: () => void;
}

export function useRemoteConversationEngine(
  sessionId: string,
  nav: RemoteConversationNav,
  sync: RemoteConversationSync
): ConversationEngine {
  const { onOpenRun, onOpenTerminal, onOpenTools } = nav;
  const { follow, onSendSuccess } = sync;
  const theme = useTheme();
  const router = useRouter();
  const goBack = useSafeBack();
  // 离线出口「去本地对话」按压反馈（按压过渡统一批）
  const exitPress = usePressFade();
  const window = useSessionWindow(sessionId);
  const summary = useSessionStore((s) =>
    s.sessions.find((item) => item.id === sessionId)
  );
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
  const [localPrompts, setLocalPrompts] = useState<
    { id: string; text: string; atMs: number }[]
  >([]);
  // 回显块身份缓存（localPromptEcho）：未变的回显行在投影重跑时保持
  // 块引用稳定，不击穿行级 memo（时间线身份专项登记项）
  const echoOfRef = useRef<ReturnType<
    typeof createLocalPromptEchoCache
  > | null>(null);
  if (echoOfRef.current === null) {
    echoOfRef.current = createLocalPromptEchoCache();
  }
  const echoOf = echoOfRef.current;

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

  const currentRunId = latestRunIdOf(
    window.entries,
    summary?.engineLastRunId ?? null
  );

  const blocks = useMemo(() => {
    const base = buildSessionTimeline(window.entries);
    const prompts = localPrompts.map<TimelineBlock>((prompt) => echoOf(prompt));
    if (prompts.length === 0) return base;
    return [...base, ...prompts].sort((a, b) => a.atMs - b.atMs);
  }, [window.entries, localPrompts]);
  const hasTools = blocks.some((block) => block.kind === 'tool');

  // 生成进行中判定（批 C ② 排队触发面）：块流中任一消息/思考流式
  // 未封口或工具运行中 = 本会话有运行在生成。composer.busy 只是
  // runTask 调用在飞窗，不代表生成态，两者分开（引擎 busy 面不变）。
  const runActive = useMemo(
    () =>
      blocks.some(
        (block) =>
          (block.kind === 'message' && block.streaming) ||
          (block.kind === 'reasoning' &&
            (block.streaming || block.isThinking)) ||
          (block.kind === 'tool' && block.status === 'running')
      ),
    [blocks]
  );
  // 最近一条运行终局 notice 的时刻（排空状态机的终局信号源：运行
  // 瞬间失败/完成、没有任何流式块时 awaiting 靠它收敛）
  const terminalEpoch = useMemo(() => {
    let latest = 0;
    for (const block of blocks) {
      if (block.kind === 'notice' && block.id.startsWith('run-terminal-')) {
        latest = Math.max(latest, block.atMs);
      }
    }
    return latest;
  }, [blocks]);

  // 排队发送（批 C ②）：生成中（或调用在飞）再发送 → 进 sendQueueStore
  // 的本会话队列（持久化、逐条可撤），生成结束由排空状态机逐条续发；
  // 发送走既有 composer 管线（submitText / submitWithAttachments），
  // 不另设第二条发送链。
  const sendQueuedItem = useCallback(
    (item: SendQueueItem): Promise<boolean> => {
      if (item.attachments.length > 0) {
        return composer.submitWithAttachments(
          item.text,
          item.attachments,
          composerCtx.activeModelVisionSupported
        );
      }
      return composer.submitText(item.text);
    },
    [composer, composerCtx.activeModelVisionSupported]
  );
  const queue = useSendQueue(`remote:${sessionId}`, {
    active: runActive || composer.busy,
    blocked: !composer.connected,
    send: sendQueuedItem,
    terminalSignal: (sinceMs) => terminalEpoch > 0 && terminalEpoch >= sinceMs,
    signalEpoch: terminalEpoch,
  });
  // 当前输入（文本 + 已选附件快照）入队：入队成功才清输入与已选区
  // （入队被拒 = 队列已满，输入保留并给诚实提示，不静默吞）
  const enqueueCurrentDraft = useCallback(
    (text: string, withAttachments: boolean) => {
      const ok = queue.enqueue(
        text,
        withAttachments ? attachments.attachments : []
      );
      if (ok) {
        composer.setPrompt('');
        if (withAttachments) attachments.clear();
      } else {
        showToast('排队消息已达上限，请等前面的消息发出', 'error');
      }
    },
    [queue, attachments, composer, showToast]
  );
  // 生成中判定（提交分发共用）：运行生成中或发送调用在飞
  const sendBusy = runActive || composer.busy;

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
  // 显式文本提交（语音直发与引擎 composer.submitText 共用同一分发）：
  // 生成中 → 入队（附件快照一并入队，不滞留已选区）；否则有已选附件
  // 走富路径一并发出，无附件走纯文本路径
  const submitText = useCallback(
    (text: string) => {
      if (sendBusy) {
        if (text.trim().length > 0 || attachments.attachments.length > 0) {
          enqueueCurrentDraft(text, attachments.attachments.length > 0);
        }
        return Promise.resolve(true);
      }
      if (attachments.attachments.length > 0) {
        submitRich(text);
        return undefined;
      }
      return composer.submitText(text);
    },
    [
      sendBusy,
      attachments.attachments.length,
      enqueueCurrentDraft,
      composer,
      submitRich,
    ]
  );
  // 离线语音输入（W-D）：松开直发——先回填输入框再以显式文本提交
  const voice = useVoiceInput({
    onFillText: composer.setPrompt,
    onSubmitText: submitText,
    notify: showToast,
  });

  // 未送达行（批 C 03-4）：本会话 outbox 未送达组 + 送达转绿投影
  const undelivered = useUndeliveredVm(sessionId);

  useEffect(() => {
    ensureSessionHistory(sessionId);
  }, [sessionId]);

  // 打开即退休（批 C ⑫）：经任何入口打开本会话 → 该会话的通知中心
  // 未读条目一并退休（归属判定与幂等在 retireNotificationsForSession）
  useEffect(() => {
    retireNotificationsForSession(sessionId);
  }, [sessionId]);

  useEffect(() => {
    if (follow && window.lastSeq > 0) {
      sessionStore.getState().markRead(sessionId, window.lastSeq);
    }
  }, [follow, sessionId, window.lastSeq]);

  useEffect(() => {
    if (composer.feedback.kind === 'success') onSendSuccess();
  }, [composer.feedback.kind, onSendSuccess]);

  // 原型 approval-locked：本会话待审批未决时锁定输入（占位文案保持不变）
  const approvalLocked = (summary?.pendingApprovalCount ?? 0) > 0;
  const editable = composer.connected && !composer.busy && !approvalLocked;

  const menuEntries = useMemo<DropdownMenuEntry[]>(
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

  // Composer 上方引擎专属行：未送达行 + 排队行 + 断线出口 + 已选
  // 附件条（见 types.ts 的槽位说明）
  const renderComposerLead = () => (
    <>
      {undelivered.group ? (
        <UndeliveredRow
          label={UNDELIVERED_FAMILY_LABEL[undelivered.group.family]}
          count={undelivered.group.items.length}
          action={undelivered.group.action}
          onAction={() => {
            if (undelivered.group?.action === 'resend') {
              undelivered.resend();
            } else if (undelivered.editToolCallId) {
              router.push(`/approval/${undelivered.editToolCallId}`);
            }
          }}
        />
      ) : undelivered.flash ? (
        <UndeliveredRow label="已送达" count={0} delivered />
      ) : null}
      <SendQueueRows items={queue.items} onWithdraw={queue.withdraw} />
      {!composer.connected ? (
        // 断线出路（CON-2）：本页对象是远端会话，断线不能发本身合理，
        // 但不能只剩死输入框——明确告知 + 一键去本地对话（本地能力
        // 不依赖设备连接）。连接恢复后本条自动消失。
        // 落点（界面统一 U3）：本地对话不再有独立界面，回主页即本地
        // 能力面（未连接时主页自动派生本地模式，输入框就是本地对话），
        // navigate 回既有主页路由，不压新栈。
        <View
          testID="session-offline-exit"
          style={[
            styles.offlineExit,
            {
              backgroundColor: theme.colors.surface,
              borderRadius: theme.radius.menu,
              paddingHorizontal: theme.space.md,
              paddingVertical: theme.space.sm,
              gap: theme.space.sm,
              marginBottom: theme.space.sm,
            },
          ]}
        >
          <AppText variant="footnote" color="textSecondary" style={styles.flex}>
            设备未连接，此会话暂时无法发送
          </AppText>
          <AnimatedPressable
            accessibilityRole="button"
            accessibilityLabel="去本地对话"
            testID="session-offline-exit-local"
            onPress={() => router.navigate('/')}
            onPressIn={exitPress.onPressIn}
            onPressOut={exitPress.onPressOut}
            hitSlop={theme.space.sm}
            style={exitPress.fadeStyle}
          >
            <AppText
              variant="footnote"
              color="textPrimary"
              style={styles.exitAction}
            >
              去本地对话
            </AppText>
          </AnimatedPressable>
        </View>
      ) : null}
      {/* 附件菜单（批 A 锚定 Popover 形态）：lead 区在宿主
          KeyboardStickyView 内、composer 正上方——开合不收键盘
          （双政策的保键盘面）；菜单本体见 AttachmentSheet 头注 */}
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
      <AttachmentStrip
        attachments={attachments.attachments}
        onRemove={attachments.remove}
        picking={attachments.picking}
        testID="session-attachment-strip"
      />
    </>
  );

  // 引擎专属浮层宿主：四种 Sheet + 会话操作层（改名弹窗 + 删除确认）；
  // 附件菜单不在此列——批 A 起它渲染在 renderComposerLead（锚定形态）
  const renderSheets = () => (
    <>
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
        testID="session-model-sheet"
      />

      {/* 附件菜单已移入 renderComposerLead（批 A 锚定 Popover 形态，
          见 lead 区注释）——此处不再渲染 */}

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
    </>
  );

  return {
    kind: 'remote',
    id: sessionId,
    title: summary?.title?.trim() || null,
    blocks,
    busy: composer.busy,
    available: composer.connected,
    error:
      composer.feedback.kind === 'error'
        ? { message: composer.feedback.message ?? '' }
        : null,
    composer: {
      prompt: composer.prompt,
      setPrompt: composer.setPrompt,
      submit: () => {
        // 发送即收附件菜单（锚定 Popover 的关闭路径之一，批 A）
        setAttachOpen(false);
        // 生成中发送 = 入队（批 C ②）：发送钮不消失、点击入队，
        // 生成结束自动续发；非生成中走既有发送路径
        if (sendBusy) {
          if (composer.prompt.trim().length > 0 || hasAttachments) {
            enqueueCurrentDraft(composer.prompt, hasAttachments);
          }
          return;
        }
        if (hasAttachments) submitRich(composer.prompt);
        else void composer.submit();
      },
      submitText,
      submitWithAttachments: composer.submitWithAttachments,
      canSubmit:
        (composer.canSubmit ||
          (composer.connected && !composer.busy && hasAttachments)) &&
        !approvalLocked,
      editable,
      locked: approvalLocked,
      placeholder: composer.connected
        ? '点击发消息、长按语音输入'
        : '设备未连接 · 可切换到本地对话',
      contextBar: {
        workspaceLabel: composerCtx.workspaceLabel,
        permissionLabel: composerCtx.permissionLabel,
        onWorkspacePress: () => {
          composerCtx.openWorkspaceList();
          setWorkspaceOpen(true);
        },
        onPermissionPress: () => setPermissionOpen(true),
      },
      modelControl: {
        label: composerCtx.modelLabel,
        onPress: () => {
          composerCtx.openModelList();
          setModelOpen(true);
        },
      },
      // ＋ = 附件菜单开关（toggle：锚定 Popover 无全屏关闭层，再点
      // ＋ 收起，批 A 双政策）
      onAttachPress: () => setAttachOpen((v) => !v),
      hasAttachments,
      voice,
    },
    menuEntries,
    // 空态标题与迁移前 TimelineView 缺省值一致（显式化为引擎供给）
    emptyState: { title: '暂无消息' },
    renderSheets,
    renderComposerLead,
  };
}

const styles = StyleSheet.create({
  offlineExit: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  flex: { flex: 1 },
  exitAction: { fontWeight: '600' },
});

export default useRemoteConversationEngine;
