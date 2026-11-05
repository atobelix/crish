// 交互式正文引证角标（方案 §4.3，跨端对齐与微光联动）：
// - 渲染诸如 [1] 的微型标识胶囊；
// - 微上标排版：紧凑微型胶囊、负 translateY 轻微上移，符合学术/引文微上标视觉；
// - 圆角 theme.radius.pill、内衬 paddingHorizontal: 4 / paddingVertical: 1；
// - 色彩规范：未高亮时背景 surfaceGrouped、边框 hairline、文字 textSecondary；
//   高亮时（与外部搜索卡片或被点击项联动）背景 fillPressed、边框 brand、文字 brand；
// - 交互：onPress 触发 haptics.selection() 触感震动与按压微透明动效（usePressFade）；
// - 可访问性：accessibilityRole="button" 与 accessibilityLabel="引用来源 {index}"。
import { useCallback } from 'react';
import {
  StyleSheet,
  Text,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { haptics } from '@/adapters/platform/haptics';
import {
  AnimatedPressable,
  usePressFade,
} from '@/presentation/ui/pressFeedback';
import type { CitationItem } from '@crish/shared-types';

export interface CitationPillProps {
  /** 引用序号（1-based，如 1 对应渲染 [1]） */
  index: number;
  /** 可选关联的引用项实体 */
  citation?: CitationItem | undefined;
  /** 是否处于联动高亮态 */
  highlighted?: boolean;
  /** 点击回调 */
  onPress?: ((index: number, citation?: CitationItem) => void) | undefined;
  /** 胶囊外部容器样式 */
  style?: StyleProp<ViewStyle> | undefined;
  /** 胶囊文字样式 */
  textStyle?: StyleProp<TextStyle> | undefined;
  /** 测试唯一标识，缺省为 citation-pill-{index} */
  testID?: string | undefined;
}

export function CitationPill({
  index,
  citation,
  highlighted = false,
  onPress,
  style,
  textStyle,
  testID,
}: CitationPillProps) {
  const theme = useTheme();
  const press = usePressFade();

  const handlePress = useCallback(() => {
    haptics.selection();
    onPress?.(index, citation);
  }, [index, citation, onPress]);

  const pillId = testID ?? `citation-pill-${index}`;

  return (
    <AnimatedPressable
      testID={pillId}
      accessibilityRole="button"
      accessibilityLabel={`引用来源 ${index}`}
      onPress={handlePress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={[
        styles.pill,
        {
          borderRadius: theme.radius.pill,
          backgroundColor: highlighted
            ? theme.colors.fillPressed
            : theme.colors.surfaceGrouped,
          borderColor: highlighted ? theme.colors.brand : theme.colors.hairline,
        },
        press.fadeStyle,
        style,
      ]}
    >
      <Text
        style={[
          styles.text,
          {
            fontSize: theme.type.caption.fontSize - 2,
            lineHeight: theme.type.caption.lineHeight - 4,
            color: highlighted
              ? theme.colors.brand
              : theme.colors.textSecondary,
            fontFamily: theme.type.mono.fontFamily,
          },
          textStyle,
        ]}
      >
        {`[${index}]`}
      </Text>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: 4,
    paddingVertical: 1,
    marginHorizontal: 2,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    transform: [{ translateY: -2 }],
  },
  text: {
    fontWeight: '600',
    textAlign: 'center',
    includeFontPadding: false,
  },
});

export default CitationPill;
