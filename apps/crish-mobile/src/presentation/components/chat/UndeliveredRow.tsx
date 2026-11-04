// 未送达行（批 C 03-4 规格化呈现）：每会话一行——状态点 + 原因
// （7 类家族文案）+ 条数（>1 才显示）+ 动作（重发 / 编辑，家族裁决）；
// 送达后同一行原地转绿显示「已送达」，停留恰 2000ms 后由 VM 投影
// 退场（组件本身不计时）。会话屏（现场）与其它呈现面共用本组件，
// 不另造第二套行。
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText } from '@/presentation/ui';
import {
  AnimatedPressable,
  usePressFade,
} from '@/presentation/ui/pressFeedback';

export interface UndeliveredRowProps {
  /** 原因文案（家族标签）或送达态文案 */
  label: string;
  /** 未送达条数（>1 才呈现计数；送达态传 0） */
  count: number;
  /** 送达转绿态（true 时无动作钮，点色转绿） */
  delivered?: boolean;
  /** 动作（家族裁决结果；送达态不传） */
  action?: 'resend' | 'edit';
  onAction?: () => void;
}

export function UndeliveredRow({
  label,
  count,
  delivered = false,
  action,
  onAction,
}: UndeliveredRowProps) {
  const theme = useTheme();
  const actionPress = usePressFade();
  return (
    <View
      testID={delivered ? 'undelivered-delivered' : 'undelivered-row'}
      style={[
        styles.row,
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
      <View
        style={[
          styles.dot,
          {
            borderRadius: theme.radius.pill,
            backgroundColor: delivered
              ? theme.colors.success
              : theme.colors.danger,
          },
        ]}
      />
      <AppText
        variant="footnote"
        color={delivered ? 'success' : 'textPrimary'}
        style={styles.flex}
      >
        {count > 1 ? `${label} · ${count} 条` : label}
      </AppText>
      {!delivered && action && onAction ? (
        <AnimatedPressable
          testID="undelivered-action"
          accessibilityRole="button"
          accessibilityLabel={action === 'resend' ? '重发' : '编辑'}
          onPress={onAction}
          onPressIn={actionPress.onPressIn}
          onPressOut={actionPress.onPressOut}
          hitSlop={theme.space.sm}
          style={actionPress.fadeStyle}
        >
          <AppText
            variant="footnote"
            color="textPrimary"
            style={styles.actionText}
          >
            {action === 'resend' ? '重发' : '编辑'}
          </AppText>
        </AnimatedPressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  // 圆角走 theme.radius.pill（内联注入，styleTokens 守卫禁数字圆角）
  dot: { width: 8, height: 8 },
  flex: { flex: 1 },
  actionText: { fontWeight: '600' },
});
