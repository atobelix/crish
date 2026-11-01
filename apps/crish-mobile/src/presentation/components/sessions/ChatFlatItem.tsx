// 主屏平铺会话行（原型 chat-flat-item）：无卡片外壳、无阴影；
// 首行 = 标题 + 状态（灰环转动 / 橙点+待审批 / 绿点）+ 右上时间；次行 = 摘要单行省略；
// 行间大间距 + 若有若无虚线分隔（末行无）。
import { memo, useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import { formatRelativeTime } from '@/domain/pure/time';
import { AppText, Badge } from '@/presentation/ui';

export type ChatItemStatus = 'running' | 'pending' | 'done';

/** 状态派生（纯函数供单测）：运行中 > 待审批 > 已完成 */
export function chatStatusOf(session: {
  activeRunIds: readonly string[];
  pendingApprovalCount: number;
}): ChatItemStatus {
  if (session.activeRunIds.length > 0) return 'running';
  if (session.pendingApprovalCount > 0) return 'pending';
  return 'done';
}

/** 中性灰环运行态（原型 spinner-ring-gray）：1.5s 舒缓线性旋转，无文字 */
function RunRing() {
  const theme = useTheme();
  const rotation = useSharedValue(0);
  useEffect(() => {
    rotation.value = withRepeat(withTiming(360, { duration: 1500 }), -1, false);
  }, [rotation]);
  const style = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));
  return (
    <Animated.View
      accessibilityLabel="运行中"
      testID="chat-item-running"
      style={[
        styles.ring,
        {
          width: theme.size.iconSmall,
          height: theme.size.iconSmall,
          borderRadius: theme.radius.pill,
          borderWidth: theme.layout.iconStroke / 2 + 1,
          borderColor: theme.colors.borderStrong,
          borderTopColor: theme.colors.textTertiary,
        },
        style,
      ]}
    />
  );
}

export interface ChatFlatItemProps {
  session: SessionSummary;
  /** 摘要文本（事件窗口尾部预览） */
  snippet: string;
  /** 相对时间基准（抽屉同款口径：展开时刷新） */
  nowMs: number;
  /** 末行不画虚线分隔 */
  isLast?: boolean;
  onPress: (sessionId: string) => void;
}

export const ChatFlatItem = memo(function ChatFlatItem({
  session,
  snippet,
  nowMs,
  isLast = false,
  onPress,
}: ChatFlatItemProps) {
  const theme = useTheme();
  const status = chatStatusOf(session);
  const time = formatRelativeTime(
    session.updatedAt ?? session.receivedAtMs,
    nowMs
  );
  return (
    <Pressable
      testID={`chat-item-${session.id}`}
      accessibilityRole="button"
      accessibilityLabel={`会话：${session.title ?? session.id}，${
        status === 'running'
          ? '运行中'
          : status === 'pending'
            ? '待审批'
            : '已完成'
      }`}
      onPress={() => onPress(session.id)}
      style={({ pressed }) => [
        {
          gap: theme.space.xs + 2,
          paddingBottom: theme.space.xl,
          borderBottomColor: theme.colors.hairline,
        },
        !isLast && styles.divider,
        pressed && { opacity: 0.6 },
      ]}
    >
      <View style={[styles.header, { gap: theme.space.sm }]}>
        <View style={[styles.titleGroup, { gap: theme.space.sm }]}>
          <AppText variant="bodyStrong" numberOfLines={1}>
            {session.title?.trim() || '未命名会话'}
          </AppText>
          {status === 'running' ? <RunRing /> : null}
          {status === 'pending' ? (
            <View
              testID="chat-item-pending"
              style={[styles.badge, { gap: theme.space.xs + 1 }]}
            >
              <Badge dot tone="warning" />
              <AppText variant="caption" color="textTertiary">
                待审批
              </AppText>
            </View>
          ) : null}
          {status === 'done' ? <Badge dot tone="accent" /> : null}
        </View>
        <AppText variant="caption" color="textTertiary">
          {time}
        </AppText>
      </View>
      {snippet ? (
        <AppText variant="footnote" color="textSecondary" numberOfLines={1}>
          {snippet}
        </AppText>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  divider: {
    borderBottomWidth: 1,
    borderStyle: 'dashed',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  titleGroup: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  ring: {
    flexShrink: 0,
  },
});

export default ChatFlatItem;
