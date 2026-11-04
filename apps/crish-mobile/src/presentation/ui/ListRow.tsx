// 列表行：leading + 标题/副标题 + trailing（原型 settings-row 口径：
// 内衬 14/16、标题 14/500、值 13/400 #777、箭头 14、分隔线 dashed faint 从文字起点开始）。
// 按压过渡（手感基建批，改善项 11）：按压底色 fillPressed 不再瞬时跳变——
// 常驻填充色 + 透明度 120ms（duration.snappy）过渡，对齐 IconButton 的
// pressProgress 先例与亮度变化带过渡的纪律；覆盖层不拦触摸。
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import AppText from './AppText';
import Icon from './Icon';

export interface ListRowProps {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  showChevron?: boolean;
  destructive?: boolean;
  /** 是否绘制底部分隔线（分组最后一行传 false） */
  divider?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}

export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
  showChevron = false,
  destructive = false,
  divider = true,
  testID,
  accessibilityLabel,
}: ListRowProps) {
  const theme = useTheme();
  // 按压进度：按下/抬起各走 120ms 过渡（IconButton 同款 pressProgress 模式）
  const pressProgress = useSharedValue(0);
  const pressOverlayStyle = useAnimatedStyle(() => ({
    opacity: pressProgress.value,
  }));
  const content = (
    <>
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View
        style={[
          styles.body,
          { borderBottomColor: theme.colors.hairline },
          divider && styles.divider,
        ]}
      >
        <View style={styles.texts}>
          <AppText
            variant="body"
            color={destructive ? 'danger' : 'textPrimary'}
            numberOfLines={1}
            style={styles.titleWeight}
          >
            {title}
          </AppText>
          {subtitle ? (
            <AppText variant="caption" color="textTertiary" numberOfLines={2}>
              {subtitle}
            </AppText>
          ) : null}
        </View>
        {trailing ?? null}
        {showChevron ? (
          <Icon
            name="chevron-right"
            size={theme.size.iconSmall - 2}
            color={theme.colors.textTertiary}
          />
        ) : null}
      </View>
    </>
  );

  if (!onPress) {
    return (
      <View testID={testID} style={styles.row}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      onPress={onPress}
      onPressIn={() => {
        pressProgress.value = withTiming(1, {
          duration: theme.motion.duration.snappy,
        });
      }}
      onPressOut={() => {
        pressProgress.value = withTiming(0, {
          duration: theme.motion.duration.snappy,
        });
      }}
      style={styles.row}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: theme.colors.fillPressed },
          pressOverlayStyle,
        ]}
      />
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingLeft: 16,
  },
  leading: {
    width: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  body: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingRight: 16,
  },
  divider: {
    // 发丝线口径（2026-11-02 分割线裁决：更浅更细）
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
  },
  titleWeight: {
    fontWeight: '500',
  },
  texts: {
    flex: 1,
    gap: 3,
  },
});

export default ListRow;
