// 会话内状态自愈横幅（方案 06 落地）：
// - 挂载于会话聊天流顶部或输入框上方，提供连接与可用性状态感知；
// - 细分断开连接、弱网、重连中、未授权等状态，就地提供“重试连接”、“使用本地模式”或“修复配对”Action；
// - 视觉上与背景保持轻柔对比度，不遮挡主对话内容（SoftShadowSurface banner 档软阴影）；
// - 当可用性状态为 enabled 或无异常时返回 null，不占用任何视觉布局空间。
import {
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import AppText from '@/presentation/ui/AppText';
import { Icon, type IconName } from '@/presentation/ui/Icon';
import { SoftShadowSurface } from '@/presentation/ui/SoftShadowSurface';

export type StatusBannerReason =
  | 'disconnected'
  | 'weak-network'
  | 'poor-connection'
  | 'reconnecting'
  | 'synchronizing'
  | 'unreachable'
  | 'needs-repair'
  | 'not-authorized'
  | 'upgrade-required'
  | 'discovery-unavailable'
  | 'offline';

export interface DeviceAvailability {
  state: 'enabled' | 'disabled';
  reason?: StatusBannerReason;
  message?: string;
}

export interface ConversationStatusBannerProps {
  /** 设备与连接可用性状态对象；若 state === 'enabled' 则不展示 */
  availability?: DeviceAvailability | null;
  /** 快捷传入状态 reason（当未传 availability 时生效） */
  status?: StatusBannerReason | null;
  /** 自定义提示信息（覆盖默认 reason 对应文案） */
  message?: string;
  /** “重试连接”回调 */
  onRetry?: () => void;
  /** “使用本地模式”切换回调 */
  onUseLocalMode?: () => void;
  /** “修复配对”回调 */
  onRepairPairing?: () => void;
  /** “打开设置”回调 */
  onOpenSettings?: () => void;
  /** 自定义外层样式 */
  style?: StyleProp<ViewStyle>;
  /** 测试标识 */
  testID?: string;
}

const DEFAULT_MESSAGES: Record<StatusBannerReason, string> = {
  disconnected: '与桌面端连接已断开',
  'weak-network': '网络连接较弱，可能存在延迟',
  'poor-connection': '网络连接较弱，可能存在延迟',
  reconnecting: '正在重新连接桌面端...',
  synchronizing: '正在与桌面端重新同步...',
  unreachable: '网络不可达，请检查 Wi-Fi',
  'needs-repair': '配对令牌已失效，需重新配对',
  'not-authorized': '桌面端拒绝了连接授权',
  'upgrade-required': '桌面端版本过低，请升级',
  'discovery-unavailable': '局域网服务发现失败',
  offline: '当前处于离线状态',
};

export function ConversationStatusBanner({
  availability,
  status,
  message,
  onRetry,
  onUseLocalMode,
  onRepairPairing,
  onOpenSettings,
  style,
  testID,
}: ConversationStatusBannerProps) {
  const theme = useTheme();

  // 若明确声明为 enabled，或未提供任何异常状态，则不渲染
  if (availability?.state === 'enabled') {
    return null;
  }
  if (!availability && !status) {
    return null;
  }

  const reason: StatusBannerReason =
    availability?.reason ?? status ?? 'disconnected';

  const displayText =
    message ?? availability?.message ?? DEFAULT_MESSAGES[reason] ?? '连接异常';

  const isDisconnectedOrWeak =
    reason === 'disconnected' ||
    reason === 'weak-network' ||
    reason === 'poor-connection' ||
    reason === 'unreachable' ||
    reason === 'offline' ||
    reason === 'discovery-unavailable' ||
    reason === 'reconnecting' ||
    reason === 'synchronizing';

  const needsRepair = reason === 'needs-repair' || reason === 'not-authorized';

  const isReconnecting =
    reason === 'reconnecting' || reason === 'synchronizing';

  const iconName: IconName = isReconnecting ? 'refresh' : 'alert-circle';

  const iconColor = needsRepair
    ? theme.colors.danger
    : isReconnecting
      ? theme.colors.textSecondary
      : reason === 'weak-network' || reason === 'poor-connection'
        ? theme.colors.warning
        : theme.colors.textSecondary;

  return (
    <Animated.View
      testID={testID ?? 'conversation-status-banner'}
      entering={FadeIn.duration(theme.motion.duration.normal)}
      exiting={FadeOut.duration(theme.motion.duration.menu)}
      style={[
        styles.wrapper,
        {
          marginHorizontal: theme.space.lg,
          marginTop: theme.space.xs,
          marginBottom: theme.space.xs,
        },
        style,
      ]}
    >
      <SoftShadowSurface
        preset="banner"
        borderRadius={theme.radius.card}
        fill={theme.colors.surface}
        fillStyle={{
          borderRadius: theme.radius.card,
          paddingVertical: theme.space.sm,
          paddingHorizontal: theme.space.md,
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space.sm,
        }}
      >
        <Icon name={iconName} size={theme.size.iconSmall} color={iconColor} />

        <AppText
          variant="caption"
          color="textSecondary"
          numberOfLines={1}
          style={styles.text}
        >
          {displayText}
        </AppText>

        <View style={styles.actionsContainer}>
          {isDisconnectedOrWeak && onRetry ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="重试连接"
              onPress={onRetry}
              style={[
                styles.actionBtn,
                {
                  borderRadius: theme.radius.sm,
                  backgroundColor: theme.colors.fillSubtle,
                  paddingHorizontal: theme.space.sm,
                  paddingVertical: theme.space.xxs + 1,
                },
              ]}
            >
              <AppText
                variant="caption"
                color="actionPrimary"
                style={styles.actionText}
              >
                重试连接
              </AppText>
            </Pressable>
          ) : null}

          {isDisconnectedOrWeak && onUseLocalMode ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="使用本地模式"
              onPress={onUseLocalMode}
              style={[
                styles.actionBtn,
                {
                  borderRadius: theme.radius.sm,
                  backgroundColor: theme.colors.fillSubtle,
                  paddingHorizontal: theme.space.sm,
                  paddingVertical: theme.space.xxs + 1,
                },
              ]}
            >
              <AppText
                variant="caption"
                color="textSecondary"
                style={styles.actionText}
              >
                使用本地模式
              </AppText>
            </Pressable>
          ) : null}

          {needsRepair && onRepairPairing ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="修复配对"
              onPress={onRepairPairing}
              style={[
                styles.actionBtn,
                {
                  borderRadius: theme.radius.sm,
                  backgroundColor: theme.colors.fillSubtle,
                  paddingHorizontal: theme.space.sm,
                  paddingVertical: theme.space.xxs + 1,
                },
              ]}
            >
              <AppText
                variant="caption"
                color="danger"
                style={styles.actionText}
              >
                修复配对
              </AppText>
            </Pressable>
          ) : null}

          {onOpenSettings ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="打开设置"
              onPress={onOpenSettings}
              style={[
                styles.actionBtnSubtle,
                {
                  paddingHorizontal: theme.space.xs,
                  paddingVertical: theme.space.xxs + 1,
                },
              ]}
            >
              <AppText variant="caption" color="textTertiary">
                设置
              </AppText>
            </Pressable>
          ) : null}
        </View>
      </SoftShadowSurface>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    alignSelf: 'stretch',
  },
  text: {
    flex: 1,
    fontWeight: '500',
  },
  actionsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  actionBtn: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionBtnSubtle: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionText: {
    fontWeight: '600',
  },
});

export default ConversationStatusBanner;
