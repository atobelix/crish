// 统一头栏：根页大标题 / 二级页紧凑标题，无底部发丝线。
// 返回只使用图标，不出现「← 返回」文字。
// floating = 设置族悬浮口径（原型 settings-topbar）：绝对定位通透层，内容滚行其下；
// 返回走共享 IconButton floating 档（与主界面汉堡钮一致的圆角软阴影悬浮白盘，
// Ø38、热区补足 44、SoftShadow 微浮雕），标题为纯文字 15.5/600 左置，无胶囊。
// centered / 默认模式的返回同走 floating 软阴影悬浮盘。
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
  /** 设置族悬浮顶栏：绝对定位通透层（返回台阶盘 40 + 纯文字标题 15.5/600 左置） */
  floating?: boolean;
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
  floating = false,
  testID,
}: AppHeaderProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  if (floating) {
    return (
      <View
        testID={testID}
        pointerEvents="box-none"
        style={[
          styles.floatingBar,
          {
            paddingTop: insets.top + theme.space.xs,
            paddingLeft: insets.left + theme.space.lg,
            paddingRight: insets.right + theme.space.lg,
          },
        ]}
      >
        <View
          style={[
            styles.row,
            { height: theme.size.touchLarge, gap: theme.space.md },
          ]}
        >
          {onBack ? (
            <IconButton
              name="chevron-left"
              variant="floating"
              accessibilityLabel="返回"
              testID="header-back"
              onPress={onBack}
              size={theme.size.icon}
            />
          ) : null}
          <AppText
            variant="headline"
            numberOfLines={1}
            accessibilityRole="header"
            testID="header-title"
            style={{ fontSize: (theme.type.headline.fontSize ?? 0) - 0.5 }}
          >
            {title}
          </AppText>
          <View style={[styles.floatingActions, { gap: theme.space.xxs }]}>
            {actions}
          </View>
        </View>
      </View>
    );
  }
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
            variant="floating"
            accessibilityLabel="返回"
            onPress={onBack}
            testID="header-back"
            // 实盘左缘与内容左缘齐平（容器已有 space.lg 左内距，不再用负
            // margin 做裸字形的光学补偿）；盘与标题间距与 floating 同口径
            style={{ marginRight: theme.space.md }}
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
  floatingBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  floatingActions: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
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
