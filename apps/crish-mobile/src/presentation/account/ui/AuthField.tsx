// 账号输入框：无描边，圆角 18、高 56（多行 104）。
// 聚焦时底色在 160ms 内由 field 过渡到 fieldFocus；出错时底色换 dangerSoft，下方一行红字。
import { useRef, useState } from 'react';
import {
  Animated,
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
  /** 出错文案；为空字符串时只染底色不出字 */
  error?: string | null;
  /** 多行（104 高） */
  tall?: boolean;
  /** 密码框：带显隐切换 */
  secure?: boolean;
}

export function AuthField({
  error,
  tall = false,
  secure = false,
  onFocus,
  onBlur,
  testID,
  ...input
}: AuthFieldProps) {
  const theme = useTheme();
  const focus = useRef(new Animated.Value(0)).current;
  const [hidden, setHidden] = useState(true);
  const hasError = error !== undefined && error !== null;

  const animateTo = (toValue: number) => {
    Animated.timing(focus, {
      toValue,
      duration: theme.motion.account.fieldFocus,
      // 颜色插值不支持原生驱动
      useNativeDriver: false,
    }).start();
  };

  const backgroundColor = hasError
    ? theme.colors.dangerSoft
    : focus.interpolate({
        inputRange: [0, 1],
        outputRange: [theme.colors.field, theme.colors.fieldFocus],
      });
  const height = tall ? theme.size.fieldTall : theme.size.field;

  return (
    <View>
      <Animated.View
        style={[
          styles.box,
          tall ? styles.boxTall : null,
          {
            backgroundColor,
            borderRadius: theme.radius.field,
            minHeight: height,
            paddingHorizontal: theme.layout.fieldPadding,
            gap: theme.space.sm,
          },
        ]}
      >
        <TextInput
          {...input}
          testID={testID}
          multiline={tall}
          secureTextEntry={secure && hidden}
          placeholderTextColor={theme.colors.textTertiary}
          selectionColor={theme.colors.textPrimary}
          onFocus={(event) => {
            animateTo(1);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            animateTo(0);
            onBlur?.(event);
          }}
          style={[
            styles.input,
            {
              color: theme.colors.textPrimary,
              fontSize: theme.type.body.fontSize,
              minHeight: height,
            },
            tall
              ? { paddingVertical: theme.layout.fieldPadding }
              : styles.singleLine,
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
      </Animated.View>
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
});

export default AuthField;
