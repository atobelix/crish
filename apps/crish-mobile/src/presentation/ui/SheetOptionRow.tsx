// Sheet 内统一选项行（原型 sheet-clean-item）：浅灰圆角面、左标题 + 右侧对号/箭头。
// 激活态只以绿色对号表达，行本身不加高亮底色（原型裁定）。
// 状态文（如设备「在线」）按原型 device-status-text 口径：标题后内联小字，
// 在线为纯绿字 12，其余状态为弱灰字 12——不占右侧、不与对号互斥。
// 按压反馈（按压过渡统一批，2026-11-02）：按压叠层 120ms 淡入淡出，
// 取代瞬时换色（fillPressed 叠层 ListRow 同款）。
import { Pressable, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import AppText from './AppText';
import Icon from './Icon';
import { usePressFade } from './pressFeedback';

export interface SheetOptionRowProps {
  label: string;
  onPress: () => void;
  /** 选中：右侧显示品牌色对号 */
  selected?: boolean;
  /** 危险动作（红字；与 DropdownMenu 条目的 danger 口径一致，G3 删除行用） */
  danger?: boolean;
  /** 标题后内联状态文（如「在线」/ 连接阶段文案） */
  hint?: string;
  /** 状态文色调：success = 纯绿（在线）；muted = 弱灰 */
  hintTone?: 'muted' | 'success';
  /** 右侧箭头（二级入口） */
  showChevron?: boolean;
  /** 禁用（如离线设备行）：不可点、整体弱化呈现，不触发 onPress */
  disabled?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export function SheetOptionRow({
  label,
  onPress,
  selected = false,
  danger = false,
  hint,
  hintTone = 'muted',
  showChevron = false,
  disabled = false,
  testID,
  style,
}: SheetOptionRowProps) {
  const theme = useTheme();
  const press = usePressFade();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={[
        styles.row,
        {
          borderRadius: theme.radius.md,
          backgroundColor: theme.colors.fillSubtle,
          paddingHorizontal: theme.space.md + theme.space.xxs,
          paddingVertical: theme.space.md + 1,
          gap: theme.space.sm,
          opacity: disabled ? 0.45 : 1,
        },
        style,
      ]}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.fillPressed,
          },
          press.overlayStyle,
        ]}
      />
      <View style={[styles.left, { gap: theme.space.xs }]}>
        <AppText
          variant="body"
          numberOfLines={1}
          color={danger ? 'danger' : undefined}
          style={styles.label}
        >
          {label}
        </AppText>
        {hint ? (
          <AppText
            variant="sectionLabel"
            color={hintTone === 'success' ? 'brand' : 'textTertiary'}
            style={styles.hint}
          >
            {hint}
          </AppText>
        ) : null}
      </View>
      {selected ? (
        <Icon name="check" size={15} color={theme.colors.brand} />
      ) : null}
      {!selected && showChevron ? (
        <Icon
          name="chevron-right"
          size={theme.size.iconSmall}
          color={theme.colors.textTertiary}
        />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  left: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  label: {
    flexShrink: 1,
    fontWeight: '500',
  },
  hint: {
    // sectionLabel 为 12/600；状态文按原型 12/400 落字重（字号走 variant，守卫禁裸数字字号）
    fontWeight: '400',
  },
});

export default SheetOptionRow;
