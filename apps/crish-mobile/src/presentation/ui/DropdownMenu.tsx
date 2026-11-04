// 右上锚定下拉菜单（原型 dropdown-menu-popover）：原生 Modal 视口脱离 + 纯白圆角浮层 + 透明全屏关闭层。
// 移动端交互精进方案 17：全面升级为原生透明 Modal 宿主，彻底脱离父级局部 DOM 拓扑陷阱与 overflow: hidden 裁剪。
// 支持现代物理锚点矩形（anchorRect）与垂直自适应智能翻转（空间不足时向上升起，位移动画反向映射），水平安全夹取。
// 兼容遗留 top / right 属性。
// 入场 = 位移 -6px/+6px + 淡入、0.18s（原型口径；淡入/淡出走 reanimated builder，
// 位移走 withTiming animated style + token emphasized 曲线）。
// 浮层阴影：卡片走 SoftShadowSurface menu 档（几何沿原型 dropdown-menu.css，α 收到按钮档
// 两层 0.008/0.012——阴影上限硬裁决），仅 Android 浅色渲染。
// 选中态 = 浅叠色 + 600 + 黑对号（原型 .dropdown-item.selected）。
// 条目按压：叠层 120ms 淡入淡出（fillPressed/dangerSoft），禁止瞬时换色。
import { useContext, useEffect, useId, useMemo } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import AppText from './AppText';
import Icon from './Icon';
import { SoftShadowSurface } from './SoftShadowSurface';
import { usePressFade } from './pressFeedback';
import { handleOverlayBackFor, useOverlayRegistration } from './overlayStack';
import {
  calculateDropdownLayout,
  type AnchorRect,
  type DropdownAlign,
  type DropdownPlacement,
} from './dropdownLayout';
import type { IconName } from './iconPaths';

const DEFAULT_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };

function useSafeInsets() {
  const insets = useContext(SafeAreaInsetsContext);
  return insets ?? DEFAULT_INSETS;
}

export type { AnchorRect, DropdownAlign, DropdownPlacement };

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
  return 'divider' in entry && (entry as DropdownMenuDivider).divider === true;
}

export interface DropdownMenuProps {
  visible: boolean;
  onClose: () => void;
  entries: readonly DropdownMenuEntry[];
  /** 现代物理锚点矩形（推荐：由触发源 measureInWindow 传入） */
  anchorRect?: AnchorRect | null;
  /** 期望展示方向：auto 智能翻转；top 向上；bottom 向下 */
  placement?: DropdownPlacement;
  /** 水平对齐倾向：auto 智能选择；right 靠右；left 靠左 */
  align?: DropdownAlign;
  /** 兼容旧代码：菜单卡片顶部偏移 */
  top?: number;
  /** 兼容旧代码：菜单卡片右侧偏移 */
  right?: number;
  /** 缺省 170（原型固定宽） */
  width?: number;
  testID?: string;
}

export function DropdownMenu({
  visible,
  onClose,
  entries,
  anchorRect,
  placement = 'auto',
  align = 'auto',
  top,
  right,
  width = 170,
  testID,
}: DropdownMenuProps) {
  const theme = useTheme();
  const insets = useSafeInsets();
  const { width: scrW, height: scrH } = useWindowDimensions();
  const rise = useSharedValue(0);

  // 覆盖层登记（批 D）：Modal 型浮层返回经 onRequestClose 汇入栈顶裁决
  const generatedOverlayId = useId();
  const overlayId = testID ?? generatedOverlayId;
  useOverlayRegistration(overlayId, visible, {
    dismissible: true,
    onRequestClose: onClose,
  });

  // 预估菜单卡片高度（每条目约 38dp，有副说明约 52dp，分割线约 9dp，外框内衬 12dp）
  const estimatedHeight = useMemo(() => {
    return entries.reduce((acc, item) => {
      if (isDivider(item)) return acc + 9;
      return acc + (item.desc ? 52 : 38);
    }, 12);
  }, [entries]);

  // 视口数学模型解算
  const layout = useMemo(() => {
    return calculateDropdownLayout({
      anchorRect,
      top,
      right,
      width,
      estimatedHeight,
      windowWidth: scrW,
      windowHeight: scrH,
      insets,
      defaultTop: insets.top + theme.size.header + theme.space.md,
      placement,
      align,
    });
  }, [
    anchorRect,
    top,
    right,
    width,
    estimatedHeight,
    scrW,
    scrH,
    insets,
    theme.size.header,
    theme.space.md,
    placement,
    align,
  ]);

  useEffect(() => {
    if (visible) {
      rise.value = 0;
      rise.value = withTiming(1, {
        duration: theme.motion.duration.menu,
        easing: Easing.bezier(...theme.motion.easing.emphasized),
      });
    }
  }, [visible, rise, theme]);

  const direction = layout.direction;
  const riseStyle = useAnimatedStyle(() => {
    const offset = direction === 'down' ? -6 : 6;
    return {
      transform: [{ translateY: (1 - rise.value) * offset }],
    };
  }, [direction]);

  if (!visible) return null;

  return (
    <Modal
      transparent
      visible={visible}
      animationType="none"
      onRequestClose={() => {
        if (!handleOverlayBackFor(overlayId)) {
          onClose();
        }
      }}
      statusBarTranslucent
    >
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        {/* 全屏透明关闭层：真正覆盖物理屏幕全视口，点击空白处立即收起 */}
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
              top: layout.top,
              left: layout.left,
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
                  testID={testID ? `${testID}-${entry.key}` : entry.key}
                  onPress={onPressOf(entry, onClose)}
                />
              )
            )}
          </SoftShadowSurface>
        </Animated.View>
      </View>
    </Modal>
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
