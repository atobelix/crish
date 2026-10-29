// 统一头栏：根页大标题 / 二级页紧凑标题，无底部发丝线。
// 返回只使用图标，不出现「← 返回」文字。
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import AppText from './AppText';
import IconButton from './IconButton';

export interface AppHeaderProps {
  title: string;
  /** 大标题（根页） */
  large?: boolean;
  /** 返回动作（存在即显示左侧返回图标） */
  onBack?: () => void;
  /** 右侧动作（最多 2 个） */
  actions?: ReactNode;
  /** 标题下方状态行（仅连接状态等真实状态） */
  status?: ReactNode;
  /** 标题前置元素（品牌标记 / 头像） */
  leading?: ReactNode;
  /** 分组页样式：返回圆钮 + 居中标题（设置等二级页） */
  centered?: boolean;
  testID?: string;
}

export function AppHeader({
  title,
  large = false,
  onBack,
  actions,
  status,
  leading,
  centered = false,
  testID,
}: AppHeaderProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  if (centered) {
    return (
      <View
        testID={testID}
        style={[
          styles.container,
          {
            paddingTop: insets.top + theme.space.xs,
            paddingLeft: insets.left + theme.space.sm,
            paddingRight: insets.right + theme.space.sm,
          },
        ]}
      >
        <View style={[styles.row, { minHeight: theme.size.header }]}>
          <View style={styles.side}>
            {onBack ? (
              <IconButton
                name="chevron-left"
                variant="floating"
                accessibilityLabel="返回"
                onPress={onBack}
                testID="header-back"
              />
            ) : null}
          </View>
          <View style={[styles.centerWrap, { gap: theme.space.xxs }]}>
            <AppText
              variant="headline"
              numberOfLines={1}
              accessibilityRole="header"
              testID="header-title"
            >
              {title}
            </AppText>
            {status ?? null}
          </View>
          <View style={[styles.side, styles.sideEnd, { gap: theme.space.xxs }]}>
            {actions}
          </View>
        </View>
      </View>
    );
  }
  return (
    <View
      testID={testID}
      style={[
        styles.container,
        {
          paddingTop: insets.top + (large ? theme.space.sm : theme.space.xs),
          paddingLeft: insets.left + theme.space.lg,
          paddingRight: insets.right + theme.space.sm,
        },
      ]}
    >
      <View
        style={[
          styles.row,
          { minHeight: large ? theme.size.touchLarge : theme.size.touch },
        ]}
      >
        {onBack ? (
          <IconButton
            name="chevron-left"
            accessibilityLabel="返回"
            onPress={onBack}
            testID="header-back"
            // 抵消圆钮内边距，让图标与内容左缘对齐
            style={{ marginLeft: -theme.space.md, marginRight: theme.space.xs }}
          />
        ) : null}
        {leading ? (
          <View style={{ marginRight: theme.space.md }}>{leading}</View>
        ) : null}
        <View style={[styles.titleWrap, { gap: theme.space.xxs }]}>
          <AppText
            variant={large ? 'title' : 'headline'}
            numberOfLines={1}
            testID="header-title"
          >
            {title}
          </AppText>
          {status ?? null}
        </View>
        <View style={[styles.actions, { gap: theme.space.xxs }]}>
          {actions}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  titleWrap: {
    flex: 1,
    justifyContent: 'center',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  side: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  sideEnd: {
    justifyContent: 'flex-end',
  },
  centerWrap: {
    flexShrink: 1,
    alignItems: 'center',
  },
});

export default AppHeader;
