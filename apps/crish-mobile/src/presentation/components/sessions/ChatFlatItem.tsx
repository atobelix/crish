// 主屏平铺会话行（原型 chat-flat-item）：无卡片外壳、无阴影；
// 首行 = 标题 + 状态（灰环转动 / 橙点+待审批 / 绿点）+ 右上时间；次行 = 摘要单行省略；
// 行间大间距 + 若有若无虚线分隔（末行无）。
// 按压过渡（手感基建批，改善项 11）：整行按压 opacity 0.6 不再瞬时跳变，
// 改走 120ms（duration.snappy）过渡（内容包一层 Animated.View 承载，
// Pressable 本体只保留间距/分隔线几何）。
import { memo, useEffect, useRef } from 'react';
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
import {
  beginInteraction,
  type InteractionHandle,
} from '@/presentation/perf/interactionTiming';

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
    rotation.value = withRepeat(
      withTiming(360, { duration: theme.motion.duration.spin }),
      -1,
      false
    );
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
          // 原型 spinner-ring-gray：12px、线 1.8、轨道 #e5e5e5（borderStrong）
          width: theme.size.iconSmall - 4,
          height: theme.size.iconSmall - 4,
          borderRadius: theme.radius.pill,
          borderWidth: theme.layout.iconStroke,
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
  /** 长按打开会话操作（G3：与 Composer 语音长按同为 App 既有手势面） */
  onLongPress?: (sessionId: string) => void;
}

export const ChatFlatItem = memo(function ChatFlatItem({
  session,
  snippet,
  nowMs,
  isLast = false,
  onPress,
  onLongPress,
}: ChatFlatItemProps) {
  const theme = useTheme();
  const status = chatStatusOf(session);
  const time = formatRelativeTime(
    session.updatedAt ?? session.receivedAtMs,
    nowMs
  );
  // 按压进度：整行 opacity 向 0.6 过渡（120ms），语义与原瞬时 pressed 一致
  const pressProgress = useSharedValue(0);
  const spanRef = useRef<InteractionHandle | null>(null);
  const contentFadeStyle = useAnimatedStyle(() => ({
    opacity: 1 - 0.4 * pressProgress.value,
  }));
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
      onLongPress={
        onLongPress
          ? () => {
              const span = spanRef.current;
              if (span) {
                span.mark('request');
                span.end('request');
                spanRef.current = null;
              }
              onLongPress(session.id);
            }
          : undefined
      }
      onPressIn={() => {
        pressProgress.value = withTiming(1, {
          duration: theme.motion.duration.snappy,
        });
        spanRef.current?.cancel();
        const span = beginInteraction('chat-row-long-press');
        span.mark('press');
        spanRef.current = span;
      }}
      onPressOut={() => {
        pressProgress.value = withTiming(0, {
          duration: theme.motion.duration.snappy,
        });
        spanRef.current?.cancel();
        spanRef.current = null;
      }}
      style={[
        {
          paddingBottom: theme.space.xl,
          borderBottomColor: theme.colors.hairline,
        },
        !isLast && styles.divider,
      ]}
    >
      <Animated.View style={[{ gap: theme.space.xs + 2 }, contentFadeStyle]}>
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
                <Badge dot tone="warning" dotSize={6.5} />
                <AppText
                  variant="caption"
                  color="textTertiary"
                  style={{
                    // 原型徽标文字 10.5/400（自 caption 派生，同抽屉会话行口径）
                    fontSize: theme.type.caption.fontSize - 2,
                    lineHeight: theme.type.caption.lineHeight - 2,
                  }}
                >
                  待审批
                </AppText>
              </View>
            ) : null}
            {status === 'done' ? <Badge dot tone="accent" dotSize={7} /> : null}
          </View>
          <AppText variant="caption" color="textTertiary">
            {time}
          </AppText>
        </View>
        {snippet ? (
          <AppText
            variant="footnote"
            color="textSecondary"
            numberOfLines={1}
            style={{
              // 原型摘要 13.5/400、行高 1.45（≈20），自 footnote 派生
              fontSize: theme.type.footnote.fontSize + 0.5,
              lineHeight: theme.type.footnote.lineHeight + 2,
            }}
          >
            {snippet}
          </AppText>
        ) : null}
      </Animated.View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  divider: {
    // 发丝线口径（2026-11-02 分割线裁决：更浅更细）
    borderBottomWidth: StyleSheet.hairlineWidth,
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
