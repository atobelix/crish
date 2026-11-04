// 账号输入框（原型表单体系）：标签外置 12/500 #777（盒上、内衬 4、与盒 gap 6），
// 输入盒纯白、圆角 18、内衬 13/16（单行高 ≈46；多行最小高 104），字 14、占位 #aaaaaa。
// 聚焦/失焦 = 表面色一次状态切换（field ↔ fieldFocus，浅色恒白），无逐帧插值
// （实现波总方案 F4：删除旧 Animated useNativeDriver:false 的 JS 线程色值插值，
// 与软键盘弹起不再争抢 JS 线程）；出错时底色换 dangerSoft + 下方一行红字。
// 整盒可点聚焦（2026-11-03 细修）：盒身是 Pressable，点盒内任意处都把焦点
// 转发给输入框；多行时输入框在盒内纵向拉伸填满（旧实现 alignItems:
// flex-start 让输入只占顶部一行高，104 高的盒里约八成面积是无响应的
// 纯 View——「个性签名要点好几次才能输入」的根因；昵称盒高 ≈ 输入高，
// 故不明显）。单行维持居中（盒高与输入高基本同量）。
import { useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import {
  AnimatedPressable,
  usePressFade,
} from '@/presentation/ui/pressFeedback';
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
  const inputRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(true);
  // 显隐切换钮按压反馈（按压过渡统一批）
  const eyePress = usePressFade();
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
      <Pressable
        testID={testID ? `${testID}-box` : undefined}
        onPress={() => inputRef.current?.focus()}
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
          ref={inputRef}
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
          <AnimatedPressable
            accessibilityRole="button"
            accessibilityLabel={hidden ? '显示密码' : '隐藏密码'}
            testID={testID ? `${testID}-eye` : undefined}
            hitSlop={theme.space.sm}
            onPress={() => setHidden((value) => !value)}
            onPressIn={eyePress.onPressIn}
            onPressOut={eyePress.onPressOut}
            style={eyePress.fadeStyle}
          >
            <Icon
              name={hidden ? 'eye' : 'eye-off'}
              color={theme.colors.textTertiary}
            />
          </AnimatedPressable>
        ) : null}
      </Pressable>
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
  // 多行：输入框纵向拉伸填满盒高（整盒都是原生点按命中区，配合盒身
  // Pressable 转发聚焦）；文字仍顶对齐（tallInput 的 textAlignVertical）
  boxTall: { alignItems: 'stretch' },
  input: { flex: 1 },
  singleLine: { paddingVertical: 0 },
  tallInput: { paddingVertical: 0, textAlignVertical: 'top' },
});

export default AuthField;
