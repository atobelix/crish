// 右上锚定下拉菜单（原型 dropdown-menu-popover）：纯白圆角浮层 + 透明全屏关闭层。
// 锚点由调用方以 top/right 显式给出（头栏高度固定，无需测量），菜单绝不遮挡触发钮。
// 入场 = 位移 -6px + 淡入、0.18s（原型口径；淡入/淡出走 reanimated builder，
// 位移走 withTiming animated style + token emphasized 曲线（浮层曲线统一批：
// 与抽屉/Sheet 同口径，Easing.bezier 由 jest.setup 的 reanimated 桩提供，M8 补桩））。
// 浮层阴影（容器外阴影批，2026-11-02；上限裁决同日晚修订）：卡片走
// SoftShadowSurface menu 档（几何沿原型 dropdown-menu.css，α 收到按钮档
// 两层 0.008/0.012——阴影上限硬裁决），仅 Android 浅色渲染。
// 选中态 = 浅叠色 + 600 + 黑对号（原型 .dropdown-item.selected）。
// 条目按压（按压过渡统一批）：叠层 120ms 淡入淡出（fillPressed/dangerSoft），
// 禁止瞬时换色。
import { useEffect, useId } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import AppText from './AppText';
import Icon from './Icon';
import { SoftShadowSurface } from './SoftShadowSurface';
import { usePressFade } from './pressFeedback';
import { useOverlayRegistration } from './overlayStack';
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
  // 覆盖层登记（批 D）：菜单是内流浮层（非 Modal），系统返回经根
  // 布局的注册表 BackHandler 关闭栈顶——打开期间登记，Back 先关菜单
  const overlayId = useId();
  useOverlayRegistration(overlayId, visible, {
    dismissible: true,
    onRequestClose: onClose,
  });

  useEffect(() => {
    if (visible) {
      rise.value = 0;
      rise.value = withTiming(1, {
        // 原型 dropdown-menu.css .dropdown-menu：0.18s emphasized
        // （theme.motion.duration.menu 档，批 A 字面量收编）
        duration: theme.motion.duration.menu,
        easing: Easing.bezier(...theme.motion.easing.emphasized),
      });
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
        entering={FadeIn.duration(theme.motion.duration.menu)}
        exiting={FadeOut.duration(theme.motion.duration.snappy)}
        style={[
          styles.card,
          {
            top,
            right,
            width,
          },
          riseStyle,
        ]}
      >
        <SoftShadowSurface
          testID={testID}
          preset="menu"
          borderRadius={theme.radius.menu}
          fill={theme.colors.surfaceRaised}
          fillStyle={{
            padding: theme.space.xs + theme.space.xxs,
            gap: theme.space.xxs,
          }}
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
              <DropdownItemRow
                key={entry.key}
                entry={entry}
                testID={`${testID}-${entry.key}`}
                onPress={onPressOf(entry, onClose)}
              />
            )
          )}
        </SoftShadowSurface>
      </Animated.View>
    </View>
  );
}

/** 菜单条目行：常驻透明底（选中态 fillSelected）+ 按压叠层 120ms 过渡 */
function DropdownItemRow({
  entry,
  testID,
  onPress,
}: {
  entry: DropdownMenuItem;
  testID: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  const press = usePressFade();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={entry.label}
      accessibilityState={{ selected: entry.selected ?? false }}
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={[
        styles.item,
        {
          borderRadius: theme.radius.control,
          paddingHorizontal: theme.space.md - 1,
          paddingVertical: theme.space.sm + 1,
          gap: theme.space.sm + theme.space.xxs,
        },
        entry.selected && { backgroundColor: theme.colors.fillSelected },
      ]}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: theme.radius.control,
            backgroundColor: entry.danger
              ? theme.colors.dangerSoft
              : theme.colors.fillPressed,
          },
          press.overlayStyle,
        ]}
      />
      <View
        style={[styles.itemLeft, { gap: theme.space.sm + theme.space.xxs }]}
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
    // 外层只定位：圆角/填充/裁剪归 SoftShadowSurface 内层（外层裁剪会剪掉阴影出血）
    position: 'absolute',
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
    // 发丝线口径（2026-11-02 分割线裁决：更浅更细）：hairline 色 + 发丝宽
    height: StyleSheet.hairlineWidth,
  },
});

export default DropdownMenu;
