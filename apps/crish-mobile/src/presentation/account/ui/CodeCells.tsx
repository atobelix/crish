// 6 位验证码格：隐藏输入框承接键盘与短信自动填充，格子只负责展示。
// 填满即回调 onComplete；errorKey 递增时整排 Reanimated 原生抖动（UI 线程），
// **保留已输入数字**（用户可退格修正，不再 470ms 强制清空——实现波总方案 F3）；
// 激活格内置 2dp 纯色光标条（Reanimated 呼吸，UI 线程，U8 零描边）。
import { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { AppText } from '@/presentation/ui';

export const CODE_LENGTH = 6;

export interface CodeCellsProps {
  value: string;
  onChange: (value: string) => void;
  onComplete: (code: string) => void;
  /** 每次校验失败 +1，触发原生轻抖（数字保留） */
  errorKey: number;
  disabled?: boolean;
  testID?: string;
}

export function CodeCells({
  value,
  onChange,
  onComplete,
  errorKey,
  disabled = false,
  testID = 'code-cells',
}: CodeCellsProps) {
  const theme = useTheme();
  const inputRef = useRef<TextInput>(null);
  const translateX = useSharedValue(0);
  const caretOpacity = useSharedValue(1);

  // 光标呼吸（UI 线程循环；伴随 disabled 冻结由 busy 态点击无副作用兜底）
  useEffect(() => {
    caretOpacity.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 400 }),
        withTiming(0.15, { duration: 400 })
      ),
      -1
    );
  }, [caretOpacity]);

  // 出错轻抖（Reanimated 原生序列；不清空输入）
  useEffect(() => {
    if (errorKey === 0) return;
    const { duration, distance, cycles } = theme.motion.shake;
    const step = Math.round(duration / (cycles * 2 + 1));
    const swings: number[] = [];
    for (let i = 0; i < cycles; i += 1) {
      swings.push(distance, -distance);
    }
    translateX.value = withSequence(
      ...swings.map((to) => withTiming(to, { duration: step })),
      withTiming(0, { duration: step })
    );
  }, [errorKey, translateX, theme.motion.shake]);

  const shakeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const caretStyle = useAnimatedStyle(() => ({
    opacity: caretOpacity.value,
  }));

  const handleChange = (text: string) => {
    const digits = text.replace(/\D/g, '').slice(0, CODE_LENGTH);
    onChange(digits);
    if (digits.length === CODE_LENGTH) onComplete(digits);
  };

  return (
    <Pressable
      accessibilityLabel="验证码输入"
      accessibilityValue={{
        text:
          value.length === 0
            ? '未输入'
            : `已输入 ${value.length} 位，共 ${CODE_LENGTH} 位`,
      }}
      accessibilityHint="双击调起数字键盘"
      onPress={() => inputRef.current?.focus()}
    >
      <Animated.View style={[styles.row, { gap: theme.space.sm }, shakeStyle]}>
        {Array.from({ length: CODE_LENGTH }, (_, index) => {
          const digit = value[index] ?? '';
          const active = index === value.length;
          return (
            <View
              key={index}
              testID={`${testID}-cell-${index}`}
              style={[
                styles.cell,
                {
                  height: theme.size.field,
                  borderRadius: theme.radius.codeCell,
                  backgroundColor: digit
                    ? theme.colors.field
                    : active
                      ? theme.colors.fieldFocus
                      : theme.colors.fillSubtle,
                },
              ]}
            >
              {digit ? (
                <AppText variant="codeDigit" color="textPrimary">
                  {digit}
                </AppText>
              ) : active ? (
                <Animated.View
                  testID={`${testID}-caret-${index}`}
                  style={[
                    styles.caret,
                    { backgroundColor: theme.colors.textPrimary },
                    caretStyle,
                  ]}
                />
              ) : null}
            </View>
          );
        })}
      </Animated.View>
      <TextInput
        ref={inputRef}
        testID={`${testID}-input`}
        value={value}
        onChangeText={handleChange}
        editable={!disabled}
        autoFocus
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={CODE_LENGTH}
        caretHidden
        selectionColor={theme.colors.textPrimary}
        style={styles.hiddenInput}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  cell: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  caret: {
    width: 2,
    height: 20,
  },
  // 保留可聚焦但不可见：用于承接键盘输入与短信验证码自动填充
  hiddenInput: { position: 'absolute', width: 1, height: 1, opacity: 0 },
});

export default CodeCells;
