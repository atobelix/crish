// 账号输入框（原型表单体系）：标签外置 12/500 #777（盒上、内衬 4、与盒 gap 6），
// 输入盒纯白、圆角 18、内衬 13/16（单行高 ≈46；多行最小高 104），字 14、占位 #aaaaaa。
// 聚焦/失焦 = 表面色一次状态切换（field ↔ fieldFocus，浅色恒白），无逐帧插值
// （实现波总方案 F4：删除旧 Animated useNativeDriver:false 的 JS 线程色值插值，
// 与软键盘弹起不再争抢 JS 线程）；出错时底色换 dangerSoft + 下方一行红字。
import { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Icon } from '@/presentation/ui';

export interface AuthFieldProps extends Omit<
  TextInputProps,
  'style' | 'multiline' | 'secureTextEntry'
> {
  /** 外置标签（原型表单体系：盒上方 12/500 #777） */
  label?: string;
  /** 出错文案；为空字符串时只染底色不出字 */
  error?: string | null;
  /** 多行（最小高 104） */
  tall?: boolean;
  /** 密码框：带显隐切换 */
  secure?: boolean;
}

export function AuthField({
  label,
  error,
  tall = false,
  secure = false,
  onFocus,
  onBlur,
  testID,
  ...input
}: AuthFieldProps) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(true);
  const hasError = error !== undefined && error !== null;

  const backgroundColor = hasError
    ? theme.colors.dangerSoft
    : focused
      ? theme.colors.fieldFocus
      : theme.colors.field;

  return (
    <View style={{ gap: label ? theme.space.xs + 2 : 0 }}>
      {label ? (
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
      ) : null}
      <View
        style={[
          styles.box,
          tall ? styles.boxTall : null,
          {
            backgroundColor,
            borderRadius: theme.radius.field,
            minHeight: tall ? theme.size.fieldTall : undefined,
            paddingVertical: theme.space.md + 1,
            paddingHorizontal: theme.space.lg,
            gap: theme.space.sm,
          },
        ]}
      >
        <TextInput
          {...input}
          testID={testID}
          multiline={tall}
          secureTextEntry={secure && hidden}
          placeholderTextColor={theme.colors.textDisabled}
          selectionColor={theme.colors.textPrimary}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          style={[
            styles.input,
            {
              color: theme.colors.textPrimary,
              fontSize: theme.type.body.fontSize,
            },
            tall ? styles.tallInput : styles.singleLine,
          ]}
        />
        {secure ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={hidden ? '显示密码' : '隐藏密码'}
            testID={testID ? `${testID}-eye` : undefined}
            hitSlop={theme.space.sm}
            onPress={() => setHidden((value) => !value)}
          >
            <Icon
              name={hidden ? 'eye' : 'eye-off'}
              color={theme.colors.textTertiary}
            />
          </Pressable>
        ) : null}
      </View>
      {hasError && error ? (
        <AppText
          variant="footnote"
          color="danger"
          testID={testID ? `${testID}-error` : undefined}
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
  box: { flexDirection: 'row', alignItems: 'center' },
  boxTall: { alignItems: 'flex-start' },
  input: { flex: 1 },
  singleLine: { paddingVertical: 0 },
  tallInput: { paddingVertical: 0, textAlignVertical: 'top' },
});

export default AuthField;
