// 右上锚定下拉菜单（原型 dropdown-menu-popover）：纯白圆角浮层 + 透明全屏关闭层。
// 锚点由调用方以 top/right 显式给出（头栏高度固定，无需测量），菜单绝不遮挡触发钮。
// Reanimated 淡入下移 / 淡出（theme.motion，emphasized 曲线族）。
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import AppText from './AppText';
import Icon from './Icon';
import type { IconName } from './iconPaths';

export interface DropdownMenuItem {
  key: string;
  label: string;
  icon?: IconName;
  onPress: () => void;
  /** 危险动作（红字） */
  danger?: boolean;
}

export interface DropdownMenuDivider {
  key: string;
  divider: true;
}

export type DropdownMenuEntry = DropdownMenuItem | DropdownMenuDivider;

function isDivider(entry: DropdownMenuEntry): entry is DropdownMenuDivider {
  return (entry as DropdownMenuDivider).divider === true;
}

export interface DropdownMenuProps {
  visible: boolean;
  onClose: () => void;
  entries: readonly DropdownMenuEntry[];
  /** 菜单卡片顶部偏移（一般 = 安全区 + 头栏高度 + 视距） */
  top: number;
  right?: number;
  width?: number;
  testID?: string;
}

export function DropdownMenu({
  visible,
  onClose,
  entries,
  top,
  right = 0,
  width,
  testID,
}: DropdownMenuProps) {
  const theme = useTheme();
  if (!visible) return null;
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      {/* 全屏透明关闭层：点击任意空白处立即收起 */}
      <Pressable
        testID={testID ? `${testID}-backdrop` : 'dropdown-backdrop'}
        accessibilityRole="button"
        accessibilityLabel="关闭菜单"
        onPress={onClose}
        style={StyleSheet.absoluteFill}
      />
      <Animated.View
        testID={testID}
        entering={FadeIn.duration(theme.motion.duration.fast)}
        exiting={FadeOut.duration(theme.motion.duration.micro)}
        style={[
          styles.card,
          {
            top,
            right,
            width,
            borderRadius: theme.radius.menu,
            backgroundColor: theme.colors.surfaceRaised,
            padding: theme.space.xs + 2,
            gap: 2,
          },
          theme.shadow.lg,
        ]}
      >
        {entries.map((entry) =>
          isDivider(entry) ? (
            <View
              key={entry.key}
              style={[
                styles.divider,
                {
                  marginHorizontal: theme.space.xs,
                  backgroundColor: theme.colors.hairline,
                },
              ]}
            />
          ) : (
            <Pressable
              key={entry.key}
              testID={`${testID}-${entry.key}`}
              accessibilityRole="button"
              accessibilityLabel={entry.label}
              onPress={onPressOf(entry, onClose)}
              style={({ pressed }) => [
                styles.item,
                {
                  borderRadius: theme.radius.control,
                  paddingHorizontal: theme.space.sm + 3,
                  paddingVertical: theme.space.sm + 1,
                  gap: theme.space.sm,
                },
                pressed && { backgroundColor: theme.colors.fillPressed },
              ]}
            >
              {entry.icon ? (
                <Icon
                  name={entry.icon}
                  size={theme.size.iconSmall}
                  color={
                    entry.danger
                      ? theme.colors.danger
                      : theme.colors.textSecondary
                  }
                />
              ) : null}
              <AppText
                variant="body"
                color={entry.danger ? 'danger' : 'textPrimary'}
                numberOfLines={1}
                style={styles.label}
              >
                {entry.label}
              </AppText>
            </Pressable>
          )
        )}
      </Animated.View>
    </View>
  );
}

/** 收起菜单后执行动作（保持单一关闭路径） */
function onPressOf(item: DropdownMenuItem, onClose: () => void): () => void {
  return () => {
    onClose();
    item.onPress();
  };
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    overflow: 'hidden',
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  label: {
    flex: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
});

export default DropdownMenu;
