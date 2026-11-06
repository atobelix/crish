// 会话行（抽屉）：纯标题 + 状态徽标；恒纯透明底、文字加粗与高亮（去底色裁决）。
// 待审批 = 橙点 + 「待审批」弱文字（原型 session-item-badge）；运行中 = 品牌色点；
// 失败 = 危险色图标 + 「失败」弱文字（批 D：上一轮运行失败打点
// lastRunFailedAtMs）。徽标单槽优先级：待审批（要用户决策）> 运行中
// （新一轮已在路上，旧失败已被数据面清打点）> 失败。
import { memo, useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import { AppText, Badge } from '@/presentation/ui';
import { usePressFade } from '@/presentation/ui/pressFeedback';
import {
  beginInteraction,
  type InteractionHandle,
} from '@/presentation/perf/interactionTiming';
import { RunningPulseDot } from '@/presentation/components/status/RunningPulseDot';
import { RowFailureBadge } from './RowFailureBadge';

/** 行状态徽标的单槽裁决（纯函数，呈现口径的单一真理） */
export function sessionRowBadge(
  session: SessionSummary
): 'approval' | 'running' | 'failed' | 'none' {
  if (session.pendingApprovalCount > 0) return 'approval';
  if (session.activeRunIds.length > 0) return 'running';
  if (session.lastRunFailedAtMs != null) return 'failed';
  return 'none';
}

export interface SessionListItemProps {
  session: SessionSummary;
  onPress: (sessionId: string) => void;
  /** 长按打开会话操作（G3：与 Composer 语音长按同为 App 既有手势面） */
  onLongPress?: (sessionId: string) => void;
  /** 当前打开的会话 */
  selected?: boolean;
}

function sessionTitle(session: SessionSummary): string {
  return session.title?.trim() || '未命名会话';
}

function sessionA11yLabel(session: SessionSummary): string {
  const running = session.activeRunIds.length > 0 ? '，运行中' : '';
  const approvals =
    session.pendingApprovalCount > 0
      ? `，${session.pendingApprovalCount} 项待审批`
      : '';
  const failed = sessionRowBadge(session) === 'failed' ? '，上次运行失败' : '';
  const unread =
    session.unreadCount > 0 ? `，${session.unreadCount} 条未读` : '';
  return `会话：${sessionTitle(session)}${running}${approvals}${failed}${unread}`;
}

export const SessionListItem = memo(function SessionListItem({
  session,
  onPress,
  onLongPress,
  selected = false,
}: SessionListItemProps) {
  const theme = useTheme();
  const badge = sessionRowBadge(session);
  const press = usePressFade();
  const spanRef = useRef<InteractionHandle | null>(null);
  return (
    <Pressable
      testID={`session-row-${session.id}`}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={sessionA11yLabel(session)}
      onPress={() => onPress(session.id)}
      onLongPress={
        onLongPress
          ? () => {
              const span = spanRef.current;
              if (span) {
                span.mark('request');
                // 操作表的可见完成在未纳入本轮的公共控制器里，这里只记到请求。
                span.end('request');
                spanRef.current = null;
              }
              onLongPress(session.id);
            }
          : undefined
      }
      onPressIn={() => {
        press.onPressIn();
        spanRef.current?.cancel();
        const span = beginInteraction('session-row-long-press');
        span.mark('press');
        spanRef.current = span;
      }}
      onPressOut={() => {
        press.onPressOut();
        spanRef.current?.cancel();
        spanRef.current = null;
      }}
      style={[
        styles.row,
        {
          // 原型 session-item：padding 11/12、行高约 40、字 14/500
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
        {sessionTitle(session)}
      </AppText>
      {badge === 'approval' ? (
        <View
          testID="session-approval-badge"
          style={[styles.badge, { gap: theme.space.xs + 1 }]}
        >
          <Badge dot tone="warning" dotSize={6.5} />
          <AppText
            variant="caption"
            color="textTertiary"
            style={{
              // 原型徽标文字 10.5/400（字号守卫口径：自 caption 派生，同 ApprovalFloatCard 先例）
              fontSize: theme.type.caption.fontSize - 2,
              lineHeight: theme.type.caption.lineHeight - 2,
            }}
          >
            待审批
          </AppText>
        </View>
      ) : null}
      {badge === 'running' ? (
        // 运行中 = 呼吸点（S4：与桌面 1.6s 口径对齐；尺寸/色与原 Badge
        // accent 点同档，仅静止改呼吸，Reduce Motion 时组件内静态呈现）
        <RunningPulseDot testID="session-running" />
      ) : null}
      {badge === 'failed' ? (
        <RowFailureBadge testID="session-failed-badge" />
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // 原型会话行字 14/500（body 为 14/400，仅提一档字重）
  title: { fontWeight: '500' },
  // 选中态纯视觉字阶加粗（去底色后由字重 600 与高亮字色区分）
  titleSelected: { fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center' },
  badge: { flexDirection: 'row', alignItems: 'center' },
});

export default SessionListItem;
