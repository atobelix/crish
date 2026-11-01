// 右上锚定下拉菜单（原型 dropdown-menu-popover）：纯白圆角浮层 + 透明全屏关闭层。
// 锚点由调用方以 top/right 显式给出（头栏高度固定，无需测量），菜单绝不遮挡触发钮。
// 入场 = 位移 -6px + 淡入、0.18s（原型口径；淡入/淡出走 reanimated builder，
// 位移走 withTiming animated style——Easing/Keyframe 在本仓 jest mock 不可用，全仓无先例）。
// 选中态 = 浅叠色 + 600 + 黑对号（原型 .dropdown-item.selected）。
import { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
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
  /** 选中态：浅叠色底 + 字重 600 + 右侧黑对号 */
  selected?: boolean;
  /** 标签下副说明（弱字小档） */
  desc?: string;
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
  /** 缺省 170（原型固定宽） */
  width?: number;
  testID?: string;
}

export function DropdownMenu({
  visible,
  onClose,
  entries,
  top,
  right = 0,
  width = 170,
  testID,
}: DropdownMenuProps) {
  const theme = useTheme();
  const rise = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      rise.value = 0;
      rise.value = withTiming(1, { duration: 180 });
    }
  }, [visible, rise]);

  const riseStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - rise.value) * -6 }],
  }));

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
        entering={FadeIn.duration(180)}
        exiting={FadeOut.duration(theme.motion.duration.snappy)}
        style={[
          styles.card,
          {
            top,
            right,
            width,
            borderRadius: theme.radius.menu,
            backgroundColor: theme.colors.surfaceRaised,
            padding: theme.space.xs + theme.space.xxs,
            gap: theme.space.xxs,
          },
          theme.shadow.lg,
          riseStyle,
        ]}
      >
        {entries.map((entry) =>
          isDivider(entry) ? (
            <View
              key={entry.key}
              style={[
                styles.divider,
                {
                  marginVertical: theme.space.xxs + 1,
                  marginHorizontal: theme.space.sm - theme.space.xxs,
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
              accessibilityState={{ selected: entry.selected ?? false }}
              onPress={onPressOf(entry, onClose)}
              style={({ pressed }) => [
                styles.item,
                {
                  borderRadius: theme.radius.control,
                  paddingHorizontal: theme.space.md - 1,
                  paddingVertical: theme.space.sm + 1,
                  gap: theme.space.sm + theme.space.xxs,
                },
                entry.selected && {
                  backgroundColor: theme.colors.fillSelected,
                },
                pressed && {
                  backgroundColor: entry.danger
                    ? theme.colors.dangerSoft
                    : theme.colors.fillPressed,
                },
              ]}
            >
              <View
                style={[
                  styles.itemLeft,
                  { gap: theme.space.sm + theme.space.xxs },
                ]}
              >
                {entry.icon ? (
                  <Icon
                    name={entry.icon}
                    size={15}
                    color={
                      entry.danger
                        ? theme.colors.danger
                        : entry.selected
                          ? theme.colors.textPrimary
                          : theme.colors.textSecondary
                    }
                  />
                ) : null}
                <View style={styles.texts}>
                  <AppText
                    variant="footnote"
                    color={entry.danger ? 'danger' : 'textPrimary'}
                    numberOfLines={1}
                    style={{
                      fontWeight: entry.selected ? '600' : '500',
                    }}
                  >
                    {entry.label}
                  </AppText>
                  {entry.desc ? (
                    <AppText
                      variant="sectionLabel"
                      color="textTertiary"
                      numberOfLines={1}
                      style={styles.desc}
                    >
                      {entry.desc}
                    </AppText>
                  ) : null}
                </View>
              </View>
              {entry.selected ? (
                <Icon name="check" size={15} color={theme.colors.textPrimary} />
              ) : null}
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
  itemLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  texts: {
    flex: 1,
  },
  desc: {
    // sectionLabel 为 12/600；副说明按弱字 400 落字重（字号走 variant，守卫禁裸数字字号）
    fontWeight: '400',
  },
  divider: {
    height: 1,
  },
});

export default DropdownMenu;
