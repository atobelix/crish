// 6 位验证码格：隐藏输入框承接键盘与短信自动填充，格子只负责展示。
// 填满即回调 onComplete；errorKey 递增时整排左右抖动（±6 ×3，320ms），随后清空。
import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText } from '@/presentation/ui';

export const CODE_LENGTH = 6;

export interface CodeCellsProps {
  value: string;
  onChange: (value: string) => void;
  onComplete: (code: string) => void;
  /** 每次校验失败 +1，触发抖动并清空 */
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
  const offset = useRef(new Animated.Value(0)).current;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const shake = theme.motion.account.shake;

  useEffect(() => {
    if (errorKey === 0) return undefined;
    const step = shake.duration / (shake.count * 2 + 1);
    const swings: Animated.CompositeAnimation[] = [];
    for (let i = 0; i < shake.count; i += 1) {
      swings.push(
        Animated.timing(offset, {
          toValue: shake.distance,
          duration: step,
          useNativeDriver: true,
        }),
        Animated.timing(offset, {
          toValue: -shake.distance,
          duration: step,
          useNativeDriver: true,
        })
      );
    }
    swings.push(
      Animated.timing(offset, {
        toValue: 0,
        duration: step,
        useNativeDriver: true,
      })
    );
    Animated.sequence(swings).start();
    const timer = setTimeout(
      () => onChangeRef.current(''),
      shake.duration + shake.clear
    );
    return () => clearTimeout(timer);
  }, [errorKey, offset, shake]);

  const handleChange = (text: string) => {
    const digits = text.replace(/\D/g, '').slice(0, CODE_LENGTH);
    onChange(digits);
    if (digits.length === CODE_LENGTH) onComplete(digits);
  };

  return (
    <Pressable
      accessibilityLabel="验证码输入"
      onPress={() => inputRef.current?.focus()}
    >
      <Animated.View
        style={[
          styles.row,
          { gap: theme.space.sm, transform: [{ translateX: offset }] },
        ]}
      >
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
              <AppText variant="codeDigit" color="textPrimary">
                {digit}
              </AppText>
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
        style={styles.hiddenInput}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  cell: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  // 保留可聚焦但不可见：用于承接键盘输入与短信验证码自动填充
  hiddenInput: { position: 'absolute', width: 1, height: 1, opacity: 0 },
});

export default CodeCells;
