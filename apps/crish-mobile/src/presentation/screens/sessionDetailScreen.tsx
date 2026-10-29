// 会话页：汉堡 · 居中标题（副行为运行状态与设备）· ⋯；时间线 + 悬浮 Composer。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { useSessionStore } from '@/adapters/hooks/useAppStore';
import { sessionStore } from '@/domain/store/sessionStore';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import { useSessionComposer } from '@/adapters/viewmodels/useSessionComposer';
import {
  deviceLineOf,
  useDeviceStatusVm,
} from '@/adapters/viewmodels/useDeviceStatusVm';
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
import { MainHeader } from '@/presentation/components/chat/MainHeader';
import { MenuButton } from '@/presentation/components/chat/MenuButton';
import {
  AppText,
  Composer,
  Icon,
  IconButton,
  ListRow,
  Screen,
  ScrollToBottomButton,
  Sheet,
} from '@/presentation/ui';

export interface SessionDetailScreenProps {
  sessionId: string;
  onOpenDrawer: () => void;
  onOpenRun?: (runId: string) => void;
  onOpenTerminal?: (runId: string) => void;
  /** 打开工具抽屉；focusId 为某组首个工具 id */
  onOpenTools?: (focusId?: string) => void;
}

function runStatusOf(summary: SessionSummary | undefined): string | null {
  if (!summary) return null;
  if (summary.activeRunIds.length > 0) return '运行中';
  if (summary.pendingApprovalCount > 0) return '待审批';
  return null;
}

export default function SessionDetailScreen({
  sessionId,
  onOpenDrawer,
  onOpenRun,
  onOpenTerminal,
  onOpenTools,
}: SessionDetailScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const window = useSessionWindow(sessionId);
  const summary = useSessionStore((s) =>
    s.sessions.find((item) => item.id === sessionId)
  );
  const device = useDeviceStatusVm();
  const [follow, setFollow] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);
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

  const subtitle = [runStatusOf(summary), deviceLineOf(device)]
    .filter((part): part is string => part !== null)
    .join(' · ');

  const closeMoreThen = (action: () => void) => () => {
    setMoreOpen(false);
    action();
  };

  return (
    <Screen avoidKeyboard>
      <MainHeader
        leading={<MenuButton onPress={onOpenDrawer} />}
        center={
          <View style={styles.titleBlock}>
            <AppText variant="headline" numberOfLines={1}>
              {summary?.title?.trim() || '会话'}
            </AppText>
            <AppText
              variant="caption"
              color="textTertiary"
              numberOfLines={1}
              testID="session-subtitle"
            >
              {subtitle}
            </AppText>
          </View>
        }
        trailing={
          <IconButton
            name="more"
            accessibilityLabel="更多操作"
            onPress={() => setMoreOpen(true)}
            testID="session-more"
          />
        }
      />
      <TimelineView
        blocks={blocks}
        follow={follow}
        onFollowChange={setFollow}
        listRef={listRef}
        onOpenTools={onOpenTools}
      />
      {!follow ? (
        <ScrollToBottomButton
          bottomOffset={
            insets.bottom + theme.size.composerMin + theme.space.section
          }
          onPress={() => {
            listRef.current?.scrollToEnd({ animated: true });
            setFollow(true);
          }}
          testID="session-back-to-bottom"
        />
      ) : null}
      <View
        style={{
          paddingHorizontal: theme.space.md,
          paddingTop: theme.space.sm,
          paddingBottom: Math.max(insets.bottom, theme.space.sm),
          gap: theme.space.xs,
        }}
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
          placeholder={composer.connected ? '继续对话…' : '未连接'}
          value={composer.prompt}
          onChangeText={composer.setPrompt}
          onSubmit={() => void composer.submit()}
          canSubmit={composer.canSubmit}
          editable={composer.connected && !composer.busy}
          maxLength={4096}
        />
      </View>

      <Sheet
        visible={moreOpen}
        onClose={() => setMoreOpen(false)}
        title="更多"
        testID="session-more-sheet"
      >
        {currentRunId && onOpenRun ? (
          <ListRow
            title="运行详情"
            leading={<Icon name="activity" size={theme.size.icon} />}
            onPress={closeMoreThen(() => onOpenRun(currentRunId))}
            divider
          />
        ) : null}
        {currentRunId && onOpenTerminal ? (
          <ListRow
            title="终端输出"
            leading={<Icon name="terminal" size={theme.size.icon} />}
            onPress={closeMoreThen(() => onOpenTerminal(currentRunId))}
            divider
          />
        ) : null}
        {hasTools && onOpenTools ? (
          <ListRow
            title="工具调用"
            leading={<Icon name="wrench" size={theme.size.icon} />}
            onPress={closeMoreThen(() => onOpenTools())}
            divider={false}
            testID="session-more-tools"
          />
        ) : null}
        {!currentRunId ? (
          <AppText variant="footnote" color="textTertiary">
            当前会话还没有运行记录
          </AppText>
        ) : null}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  titleBlock: { alignItems: 'center' },
});
