// 平滑阻尼滑动的分段胶囊选择条（SegmentedBar）
// 遵循 docs/mobile-provider-architecture/analysis/05-rn-components-and-gestures.md §4.2
// 与 docs/mobile-provider-architecture/analysis/01-prototype-ui-ux-spec.md §5.2 规范。
// 纯白滑块在浅灰槽内通过 withSpring 平滑阻尼滑动，支持多项横向滚动与触感交互。
import { useCallback, useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { LayoutChangeEvent, StyleProp, ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { useReducedMotion } from '@/adapters/platform/useReducedMotion';
import { haptics } from '@/adapters/platform/haptics';
import { AppText } from '@/presentation/ui';

export interface SegmentedOption<T extends string> {
  key: T;
  label: string;
  badge?: string;
}

export interface SegmentedBarProps<T extends string> {
  /** 选项列表 */
  options: readonly SegmentedOption<T>[] | Array<SegmentedOption<T>>;
  /** 当前选中的项 key */
  selectedKey: T;
  /** 选中变更回调 */
  onSelect: (key: T) => void;
  /** 外层容器自定义样式 */
  style?: StyleProp<ViewStyle>;
  /** 测试标识 */
  testID?: string;
}

const TRACK_PADDING = 3;

interface LayoutInfo {
  x: number;
  width: number;
}

export function SegmentedBar<T extends string>({
  options,
  selectedKey,
  onSelect,
  style,
  testID,
}: SegmentedBarProps<T>) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const scrollViewRef = useRef<ScrollView>(null);
  const itemsLayout = useRef<Record<string, LayoutInfo>>({});

  const indicatorX = useSharedValue(0);
  const indicatorWidth = useSharedValue(0);
  const indicatorOpacity = useSharedValue(0);
  const hasInitialized = useRef(false);

  const updateIndicator = useCallback(
    (targetKey: T, animate = true) => {
      const layout = itemsLayout.current[targetKey];
      if (!layout || layout.width <= 0) return;

      if (!hasInitialized.current) {
        // 首帧测量完成后瞬时落位并渐显，避免从 (0, 0) 产生横跨飞掠动画
        indicatorX.value = layout.x;
        indicatorWidth.value = layout.width;
        indicatorOpacity.value = withTiming(1, {
          duration: theme.motion.duration.snappy,
        });
        hasInitialized.current = true;
      } else if (reducedMotion || !animate) {
        indicatorX.value = layout.x;
        indicatorWidth.value = layout.width;
        indicatorOpacity.value = 1;
      } else {
        indicatorX.value = withSpring(layout.x, theme.motion.spring.slideThumb);
        indicatorWidth.value = withSpring(
          layout.width,
          theme.motion.spring.slideThumb
        );
        indicatorOpacity.value = 1;
      }

      // 横向滚动容器视口自动对齐居中/靠边展示当前选中项
      scrollViewRef.current?.scrollTo({
        x: Math.max(0, layout.x - 24),
        animated: animate && !reducedMotion,
      });
    },
    [
      indicatorOpacity,
      indicatorWidth,
      indicatorX,
      reducedMotion,
      theme.motion.duration.snappy,
      theme.motion.spring.slideThumb,
    ]
  );

  useEffect(() => {
    updateIndicator(selectedKey, true);
  }, [selectedKey, updateIndicator]);

  const handleItemLayout = (key: T, event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout;
    itemsLayout.current[key] = { x, width };
    if (key === selectedKey) {
      updateIndicator(key, hasInitialized.current);
    }
  };

  const handleSelect = (key: T) => {
    if (key !== selectedKey) {
      // 触觉反馈统一走 adapters/platform/haptics 单门面（遵循 feelInfra.guard 与用户设置）
      haptics.selection();
      onSelect(key);
    }
  };

  const indicatorAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: indicatorX.value }],
    width: indicatorWidth.value,
    opacity: indicatorOpacity.value,
  }));

  return (
    <ScrollView
      ref={scrollViewRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      bounces={false}
      style={[styles.scrollView, style]}
      contentContainerStyle={styles.scrollContent}
      testID={testID ?? 'segmented-bar'}
      accessibilityRole="tablist"
    >
      <View
        style={[
          styles.track,
          {
            backgroundColor: theme.colors.fillSubtle,
            borderRadius: theme.radius.pill,
            borderColor: theme.dark ? theme.colors.hairline : 'transparent',
            borderWidth: theme.dark ? StyleSheet.hairlineWidth : 0,
          },
        ]}
      >
        <Animated.View
          style={[
            styles.indicator,
            {
              backgroundColor: theme.colors.surface,
              borderRadius: theme.radius.pill,
              borderColor: theme.dark ? theme.colors.hairline : 'transparent',
              borderWidth: theme.dark ? StyleSheet.hairlineWidth : 0,
            },
            indicatorAnimatedStyle,
          ]}
          testID={`${testID ?? 'segmented-bar'}-indicator`}
        />

        {options.map((option) => {
          const isSelected = option.key === selectedKey;
          return (
            <Pressable
              key={option.key}
              onLayout={(e) => handleItemLayout(option.key, e)}
              onPress={() => handleSelect(option.key)}
              style={styles.optionItem}
              accessibilityRole="tab"
              accessibilityState={{ selected: isSelected }}
              accessibilityLabel={`${option.label}${option.badge ? `, ${option.badge}` : ''}`}
              testID={`${testID ?? 'segmented-bar'}-option-${option.key}`}
            >
              <AppText
                variant="footnote"
                color={isSelected ? 'textPrimary' : 'textTertiary'}
                style={[
                  styles.optionLabel,
                  { fontWeight: isSelected ? '600' : '500' },
                ]}
              >
                {option.label}
              </AppText>
              {option.badge ? (
                <View
                  style={[
                    styles.badgeContainer,
                    {
                      backgroundColor: isSelected
                        ? theme.colors.brandSoft
                        : theme.colors.hairline,
                      borderRadius: theme.radius.pill,
                    },
                  ]}
                >
                  <AppText
                    variant="caption"
                    color={isSelected ? 'brandStrong' : 'textTertiary'}
                    style={styles.badgeText}
                  >
                    {option.badge}
                  </AppText>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollView: {
    flexGrow: 0,
  },
  scrollContent: {
    flexDirection: 'row',
    alignItems: 'center',
    flexGrow: 1,
  },
  track: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: TRACK_PADDING,
    position: 'relative',
    minHeight: 38,
    flexGrow: 1,
  },
  indicator: {
    position: 'absolute',
    top: TRACK_PADDING,
    bottom: TRACK_PADDING,
  },
  optionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    minHeight: 32,
    zIndex: 1,
    gap: 4,
    flexGrow: 1,
  },
  optionLabel: {
    textAlign: 'center',
  },
  badgeContainer: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontWeight: '600',
  },
});

export default SegmentedBar;
