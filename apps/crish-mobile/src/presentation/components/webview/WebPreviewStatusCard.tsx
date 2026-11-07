/**
 * apps/crish-mobile/src/presentation/components/webview/WebPreviewStatusCard.tsx
 *
 * 网页预览状态展示卡片：
 * 1. WebPreviewBlockedCard: SSRF 刚性阻断居中卡片（禁止访问内网或高危地址）；
 * 2. WebPreviewErrorCard: 加载失败优雅错误卡片与一键重试。
 */

import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import {
  AnimatedPressable,
  AppText,
  Icon,
  usePressFade,
} from '@/presentation/ui';

export interface WebPreviewBlockedCardProps {
  reason?: string;
  testID?: string;
}

export function WebPreviewBlockedCard({
  reason,
  testID = 'web-preview-blocked',
}: WebPreviewBlockedCardProps) {
  const theme = useTheme();

  return (
    <View
      testID={testID}
      style={[styles.centerCard, { paddingHorizontal: theme.space.xl }]}
    >
      <View
        style={[
          styles.iconCircle,
          {
            borderRadius: theme.radius.pill,
            backgroundColor: theme.colors.dangerSoft,
          },
        ]}
      >
        <Icon name="shield" size={32} color={theme.colors.danger} />
      </View>
      <AppText
        variant="headline"
        style={[styles.statusTitle, { color: theme.colors.textPrimary }]}
      >
        安全拦截：禁止访问内网或高危地址
      </AppText>
      {reason ? (
        <AppText
          variant="caption"
          style={[styles.statusDesc, { color: theme.colors.textSecondary }]}
        >
          {reason}
        </AppText>
      ) : null}
    </View>
  );
}

export interface WebPreviewErrorCardProps {
  error: string;
  onReload: () => void;
  testID?: string;
}

export function WebPreviewErrorCard({
  error,
  onReload,
  testID = 'web-preview-error',
}: WebPreviewErrorCardProps) {
  const theme = useTheme();
  const press = usePressFade();

  return (
    <View
      testID={testID}
      style={[styles.centerCard, { paddingHorizontal: theme.space.xl }]}
    >
      <View
        style={[
          styles.iconCircle,
          {
            borderRadius: theme.radius.pill,
            backgroundColor: theme.colors.dangerSoft,
          },
        ]}
      >
        <Icon name="alert-circle" size={32} color={theme.colors.danger} />
      </View>
      <AppText
        variant="headline"
        style={[styles.statusTitle, { color: theme.colors.textPrimary }]}
      >
        网页加载失败
      </AppText>
      <AppText
        variant="caption"
        style={[styles.statusDesc, { color: theme.colors.textSecondary }]}
      >
        {error}
      </AppText>
      <AnimatedPressable
        testID="web-preview-reload"
        accessibilityRole="button"
        accessibilityLabel="重新加载"
        onPress={onReload}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={[
          styles.reloadButton,
          {
            borderRadius: theme.radius.pill,
            backgroundColor: theme.colors.fillSubtle,
            borderColor: theme.colors.hairline,
          },
          press.fadeStyle,
        ]}
      >
        <Icon name="refresh" size={16} color={theme.colors.textPrimary} />
        <AppText
          variant="body"
          style={[styles.reloadButtonText, { color: theme.colors.textPrimary }]}
        >
          重新加载
        </AppText>
      </AnimatedPressable>
    </View>
  );
}

const styles = StyleSheet.create({
  centerCard: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  iconCircle: {
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  statusTitle: {
    fontWeight: '600',
    textAlign: 'center',
  },
  statusDesc: {
    textAlign: 'center',
    maxWidth: 300,
  },
  reloadButton: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderWidth: 1,
  },
  reloadButtonText: {
    fontWeight: '500',
  },
});
