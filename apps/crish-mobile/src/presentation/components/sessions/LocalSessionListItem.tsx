// 本地线程行（抽屉本地分区）：与远端 SessionListItem 同盒模型同字阶
// ——选中态纯透明底、文字加粗与高亮（去底色裁决）。
// 分区内身份自明（会话区标题即目标名），行上不挂「本地」标识（分区口径 2026-11-03，
// 取代 U3 的行上小签）。差异仅：生成中同款呼吸点；失败同款失败徽标
// （批 D，运行时 error 派生）；本地无待审批/未读概念，不留空占位。
import { memo } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { LOCAL_THREAD_PLACEHOLDER_TITLE } from '@/domain/store/localChatSessionStore';
import type { LocalThreadMeta } from '@/domain/types/localChat';
import { AppText } from '@/presentation/ui';
import { usePressFade } from '@/presentation/ui/pressFeedback';
import { RunningPulseDot } from '@/presentation/components/status/RunningPulseDot';
import { RowFailureBadge } from './RowFailureBadge';
import { useSessionRowActions } from './useSessionRowActions';

export interface LocalSessionListItemProps {
  thread: LocalThreadMeta;
  /** 该线程正在生成 */
  streaming: boolean;
  /** 最近一次生成以失败收场（与远端行同口径呈现） */
  failed?: boolean;
  onPress: (threadId: string) => void;
  /** 长按打开线程操作（重命名 / 清空 / 删除） */
  onLongPress?: (threadId: string) => void;
  /** 当前打开的线程 */
  selected?: boolean;
}

function threadTitle(thread: LocalThreadMeta): string {
  return thread.title?.trim() || LOCAL_THREAD_PLACEHOLDER_TITLE;
}

export const LocalSessionListItem = memo(function LocalSessionListItem({
  thread,
  streaming,
  failed = false,
  onPress,
  onLongPress,
  selected = false,
}: LocalSessionListItemProps) {
  const theme = useTheme();
  const press = usePressFade();
  const title = threadTitle(thread);
  const rowActions = useSessionRowActions({
    rowId: thread.id,
    onPress,
    onLongPress,
    timingName: 'local-thread-row-long-press',
    onPressInVisual: press.onPressIn,
    onPressOutVisual: press.onPressOut,
  });
  return (
    <Pressable
      testID={`local-row-${thread.id}`}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`本地对话：${title}${streaming ? '，正在生成' : failed ? '，上次生成失败' : ''}`}
      delayLongPress={rowActions.delayLongPress}
      onPress={rowActions.onPress}
      onLongPress={onLongPress ? rowActions.onLongPress : undefined}
      onPressIn={rowActions.onPressIn}
      onPressOut={rowActions.onPressOut}
      style={[
        styles.row,
        {
          // 与 SessionListItem 同盒（原型 session-item：padding 11/12、行高约 40）
          minHeight: theme.size.touch - 4,
          paddingVertical: theme.space.md - 1,
          paddingHorizontal: theme.space.md,
          gap: theme.space.sm,
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
      <AppText
        variant="body"
        color={selected ? 'textPrimary' : 'textSecondary'}
        numberOfLines={1}
        style={[styles.flex, styles.title, selected && styles.titleSelected]}
      >
        {title}
      </AppText>
      {streaming ? (
        // 生成中 = 呼吸点（S4 口径，与远端运行行同款）
        <RunningPulseDot testID="local-running" />
      ) : failed ? (
        <RowFailureBadge testID="local-failed-badge" />
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // 与 SessionListItem 同字重（原型会话行字 14/500）
  title: { fontWeight: '500' },
  // 选中态纯视觉字阶加粗（去底色后由字重 600 与高亮字色区分）
  titleSelected: { fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center' },
});

export default LocalSessionListItem;
