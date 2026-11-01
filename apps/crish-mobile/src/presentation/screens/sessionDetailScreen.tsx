// 会话页（原型 conversation-screen 移植）：
// - 消息流全屏滚动，上下边缘羽化（EdgeFade），头栏/输入框通透悬浮其上；
// - 悬浮头栏 = 返回白圆钮 + 标题胶囊 + 更多（下拉菜单：运行详情/终端输出/工具调用）；
// - 审批统一交给全局 ApprovalFloat（悬浮于输入框上方）；
//   本会话有待审批时 Composer 锁定（原型 approval-locked：输入禁用 + 引导文案）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { useSessionStore } from '@/adapters/hooks/useAppStore';
import { sessionStore } from '@/domain/store/sessionStore';
import { useSessionComposer } from '@/adapters/viewmodels/useSessionComposer';
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
  // 离线语音输入（W-D）：松开直发——先回填输入框再以显式文本提交
  const voice = useVoiceInput({
    onFillText: composer.setPrompt,
    onSubmitText: (text) => {
      void composer.submitText(text);
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

  // 原型 approval-locked：本会话待审批未决时锁定输入，引导先处理审批
  const approvalLocked = (summary?.pendingApprovalCount ?? 0) > 0;
  const editable = composer.connected && !composer.busy && !approvalLocked;

  // 悬浮 Composer 区高度估算（羽化与回到底部按钮的偏移基准）
  const composerBlockHeight =
    theme.size.composerMin +
    theme.space.xl +
    Math.max(insets.bottom, theme.space.sm);

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
    ],
    [currentRunId, hasTools, onOpenRun, onOpenTerminal, onOpenTools]
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
        <Composer
          testID="session-composer"
          placeholder={
            approvalLocked
              ? '请先处理上方权限审批…'
              : composer.connected
                ? '回复助手或发送指令…'
                : '未连接'
          }
          value={composer.prompt}
          onChangeText={composer.setPrompt}
          onSubmit={() => void composer.submit()}
          canSubmit={composer.canSubmit && !approvalLocked}
          editable={editable}
          maxLength={4096}
          voice={voice}
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
