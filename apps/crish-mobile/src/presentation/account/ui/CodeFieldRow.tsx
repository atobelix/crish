// 验证码行（换绑邮箱 / 修改密码共用，原型换绑邮箱页口径）：外置标签 +
// 白色输入盒 + 右侧独立白色胶囊「获取验证码」钮，胶囊与输入盒同高同行。
// 错误文案走字段级口径：行下方红字（本组件渲染），输入盒同步染 dangerSoft
// 底（借 AuthField 空串 error 只染底不印字的既有约定）；改动字段由调用方
// 清除对应错误。倒计时由调用方以秒数传入，倒计时内胶囊禁用并显示剩余秒数。
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { AppText } from '@/presentation/ui';
import { usePressFade } from '@/presentation/ui/pressFeedback';
import { AuthField } from './AuthField';

export interface CodeFieldRowProps {
  /** 外置标签（如「邮箱验证码」） */
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  /** 字段级错误；非空时行下红字 + 输入盒染红底 */
  error?: string | null;
  /** 点按「获取验证码」 */
  onRequestCode: () => void;
  /** 发码请求进行中（胶囊转菊花 + 「发送中」） */
  requesting?: boolean;
  /** 重发倒计时剩余秒数（>0 时胶囊禁用并显示秒数） */
  cooldown?: number;
  editable?: boolean;
  /** 输入框 testID；胶囊为 `${testID}-request`，错误为 `${testID}-error` */
  testID: string;
}

export function CodeFieldRow({
  label,
  value,
  onChangeText,
  error,
  onRequestCode,
  requesting = false,
  cooldown = 0,
  editable = true,
  testID,
}: CodeFieldRowProps) {
  const theme = useTheme();
  const press = usePressFade();
  const hasError = Boolean(error);
  const buttonDisabled = requesting || cooldown > 0 || !editable;
  const buttonLabel = requesting
    ? '发送中'
    : cooldown > 0
      ? `${cooldown}s`
      : '获取验证码';

  return (
    <View style={{ gap: theme.space.xs + 2 }}>
      <AppText
        variant="sectionLabel"
        color="textTertiary"
        style={{
          paddingHorizontal: theme.space.xs,
          fontWeight: '500',
          letterSpacing: -(theme.type.sectionLabel.letterSpacing ?? 0),
        }}
      >
        {label}
      </AppText>
      <View style={[styles.row, { gap: theme.space.sm }]}>
        <View style={styles.fieldWrap}>
          <AuthField
            value={value}
            onChangeText={onChangeText}
            error={hasError ? '' : null}
            editable={editable}
            placeholder="6 位验证码"
            keyboardType="number-pad"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="sms-otp"
            textContentType="oneTimeCode"
            maxLength={6}
            testID={testID}
          />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            cooldown > 0
              ? `获取验证码，${cooldown} 秒后可重新获取`
              : '获取验证码'
          }
          accessibilityState={{ disabled: buttonDisabled, busy: requesting }}
          disabled={buttonDisabled}
          testID={`${testID}-request`}
          onPress={onRequestCode}
          onPressIn={press.onPressIn}
          onPressOut={press.onPressOut}
          style={[
            styles.capsule,
            {
              borderRadius: theme.radius.pill,
              paddingHorizontal: theme.space.lg,
              backgroundColor: buttonDisabled
                ? theme.colors.fillSubtle
                : theme.colors.surface,
            },
          ]}
        >
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              {
                borderRadius: theme.radius.pill,
                backgroundColor: theme.colors.fillPressed,
              },
              press.overlayStyle,
            ]}
          />
          {requesting ? (
            <ActivityIndicator
              size="small"
              color={theme.colors.textSecondary}
              style={styles.spinnerGap}
            />
          ) : null}
          <AppText
            variant="body"
            color={buttonDisabled ? 'textDisabled' : 'textPrimary'}
            style={styles.capsuleText}
          >
            {buttonLabel}
          </AppText>
        </Pressable>
      </View>
      {hasError ? (
        <AppText
          variant="footnote"
          color="danger"
          testID={`${testID}-error`}
          style={{
            marginTop: theme.space.sm,
            paddingHorizontal: theme.space.xs,
          }}
        >
          {error}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'stretch' },
  fieldWrap: { flex: 1 },
  capsule: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  capsuleText: { fontWeight: '500' },
  spinnerGap: { marginRight: 6 },
});

export default CodeFieldRow;
