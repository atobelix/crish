// 输入原子：标准表单态（纯表面色阶表达焦点，零描边零阴影）。
// 焦点表达 = 表面色 fillSubtle ↔ fieldFocus 切换 + 原生光标（U8 禁描边铁律）；
// 错误表达 = 底色 dangerSoft 染色 + 下方红字，不画红框。
// tone='field'（表单页口径，与账号表单 AuthField 同源）：静置底走 field 白盒、
// 圆角走 radius.field——grouped 背景（canvasGrouped）与 fillSubtle 同值，默认
// subtle 壳在其上不可见，表单页必须用此档（供应商编辑页 2026-11-02 用户点名）。
// 焦点底色过渡（手感基建批，改善项 11）：fillSubtle ↔ fieldFocus 不再瞬时
// 跳变，走 120ms（duration.snappy）插值——亮度变化必须带过渡（桌面纪律同
// 源）；错误态属异常态、即时落色不走过渡。减动效时过渡时长归零（共享信号）。
// 对话输入条见 Composer，不在这里。
import { forwardRef, useEffect, useState } from 'react';
import {
  Platform,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { useReducedMotion } from '@/adapters/platform/useReducedMotion';
import AppText from './AppText';

export interface InputProps extends Omit<TextInputProps, 'style'> {
  label?: string;
  error?: string;
  /** 壳底色口径：subtle = fillSubtle（白面上的默认档）；field = field 白盒
   * （grouped 背景上的表单页档，与 AuthField 同源） */
  tone?: 'subtle' | 'field';
  containerStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<TextStyle>;
  testID?: string;
}

export const Input = forwardRef<TextInput, InputProps>(function Input(
  {
    label,
    error,
    tone = 'subtle',
    containerStyle,
    style,
    editable = true,
    onFocus,
    onBlur,
    testID,
    placeholderTextColor,
    ...rest
  },
  ref
) {
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  const [focused, setFocused] = useState(false);
  const multiline = rest.multiline === true;
  // 焦点底色插值进度（0 = fillSubtle，1 = fieldFocus）：焦点切换走 120ms
  // 过渡，减动效时直达终值
  const focusProgress = useSharedValue(0);
  useEffect(() => {
    focusProgress.value = withTiming(focused ? 1 : 0, {
      duration: reduceMotion ? 0 : theme.motion.duration.snappy,
    });
  }, [focused, focusProgress, reduceMotion, theme.motion.duration.snappy]);
  // 静置底：subtle 档 = fillSubtle；field 档 = field 白盒（焦点端同为 fieldFocus）
  const restColor =
    tone === 'field' ? theme.colors.field : theme.colors.fillSubtle;
  const shellBgStyle = useAnimatedStyle(
    () => ({
      backgroundColor: interpolateColor(
        focusProgress.value,
        [0, 1],
        [restColor, theme.colors.fieldFocus]
      ),
    }),
    [restColor, theme.colors.fieldFocus]
  );
  // 焦点/错误全部用表面色阶表达：无 borderWidth、无 borderColor、无阴影。
  // 错误态即时落色（异常态不走过渡）：静态底色覆盖动画底色。
  const errorSurface = error ? theme.colors.dangerSoft : undefined;

  return (
    <View style={[styles.wrapper, { gap: theme.space.xs }, containerStyle]}>
      {label ? (
        <AppText
          variant="footnote"
          color="textSecondary"
          style={{ paddingLeft: theme.space.xxs }}
        >
          {label}
        </AppText>
      ) : null}
      <Animated.View
        style={[
          styles.shell,
          {
            gap: theme.space.sm,
            height: multiline ? 'auto' : theme.size.touchLarge,
            minHeight: multiline ? theme.size.inputMultilineMin : undefined,
            borderRadius:
              tone === 'field' ? theme.radius.field : theme.radius.control,
            paddingHorizontal: theme.space.md,
            paddingVertical: multiline ? theme.space.sm : undefined,
            alignItems: multiline ? 'flex-start' : 'center',
          },
          shellBgStyle,
          // 错误态静态底色在数组后位，覆盖动画底色
          errorSurface ? { backgroundColor: errorSurface } : null,
          !editable && styles.disabled,
        ]}
      >
        <TextInput
          ref={ref}
          testID={testID}
          editable={editable}
          selectionColor={theme.colors.textPrimary}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          placeholderTextColor={
            placeholderTextColor ?? theme.colors.textTertiary
          }
          style={[
            styles.input,
            theme.type.callout,
            multiline && styles.multilineInput,
            Platform.OS === 'web' ? styles.webOutline : null,
            { color: theme.colors.textPrimary },
            style,
          ]}
          {...rest}
        />
      </Animated.View>
      {error ? (
        <AppText
          variant="caption"
          color="danger"
          style={{ paddingLeft: theme.space.xxs }}
        >
          {error}
        </AppText>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrapper: {
    alignSelf: 'stretch',
  },
  shell: {
    flexDirection: 'row',
  },
  input: {
    flex: 1,
    paddingVertical: 0,
  },
  multilineInput: {
    height: 'auto',
    alignSelf: 'stretch',
    textAlignVertical: 'top',
  },
  webOutline: {
    outlineStyle: 'none',
    outlineWidth: 0,
  } as unknown as TextStyle,
  disabled: {
    opacity: 0.5,
  },
});

export default Input;
