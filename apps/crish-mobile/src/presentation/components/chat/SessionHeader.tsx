// 会话页悬浮头栏（原型 conv-top-bar）：完全通透，无底色、无边界，
// 浮于滚动流之上；返回白圆钮 + 纯白标题胶囊 + 更多白圆钮。
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, IconButton } from '@/presentation/ui';

export interface SessionHeaderProps {
  title: string;
  onBack: () => void;
  /** 更多菜单触发（菜单本体由调用方渲染，锚点见 DropdownMenu top） */
  onMore: () => void;
  /** 标题胶囊内尾随元素（预留） */
  trailing?: ReactNode;
  testID?: string;
}

export function SessionHeader({
  title,
  onBack,
  onMore,
  trailing,
  testID,
}: SessionHeaderProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      testID={testID}
      pointerEvents="box-none"
      style={[
        styles.anchor,
        {
          top: insets.top,
          paddingLeft: theme.space.sm + insets.left,
          paddingRight: theme.space.sm + insets.right,
        },
      ]}
    >
      <View style={[styles.row, { gap: theme.space.sm }]}>
        <View style={styles.side}>
          <IconButton
            name="chevron-left"
            variant="floating"
            accessibilityLabel="返回会话列表"
            onPress={onBack}
            testID="session-back"
          />
        </View>
        {/* 标题胶囊：纯白、仅文字，无任何多余图标 */}
        <View
          style={[
            styles.titlePill,
            {
              height: theme.size.barAction + 2,
              borderRadius: theme.radius.pill,
              backgroundColor: theme.colors.surface,
              paddingHorizontal: theme.space.lg,
              maxWidth: theme.layout.dialogMaxWidth,
            },
            theme.shadow.sm,
          ]}
        >
          <AppText variant="footnote" numberOfLines={1}>
            {title}
          </AppText>
          {trailing ?? null}
        </View>
        <View style={[styles.side, styles.sideEnd]}>
          <IconButton
            name="more"
            variant="floating"
            accessibilityLabel="会话选项"
            onPress={onMore}
            testID="session-more"
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 20,
  },
  row: {
    height: 52,
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
  titlePill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    flexShrink: 1,
  },
});

export default SessionHeader;
