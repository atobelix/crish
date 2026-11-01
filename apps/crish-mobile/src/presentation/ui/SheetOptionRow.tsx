// Sheet 内统一选项行（原型 sheet-clean-item）：浅灰圆角面、左标题 + 右侧对号/箭头。
// 激活态只以绿色对号表达，行本身不加高亮底色（原型裁定）。
import {
  Pressable,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import AppText from './AppText';
import Icon from './Icon';

export interface SheetOptionRowProps {
  label: string;
  onPress: () => void;
  /** 选中：右侧显示品牌色对号 */
  selected?: boolean;
  /** 右侧弱提示（如数量），与对号互斥 */
  hint?: string;
  /** 右侧箭头（二级入口） */
  showChevron?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export function SheetOptionRow({
  label,
  onPress,
  selected = false,
  hint,
  showChevron = false,
  testID,
  style,
}: SheetOptionRowProps) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          borderRadius: theme.radius.md,
          backgroundColor: pressed
            ? theme.colors.fillPressed
            : theme.colors.fillSubtle,
          paddingHorizontal: theme.space.md,
          paddingVertical: theme.space.md - 1,
          gap: theme.space.sm,
        },
        style,
      ]}
    >
      <AppText variant="body" numberOfLines={1} style={styles.label}>
        {label}
      </AppText>
      {selected ? (
        <Icon
          name="check"
          size={theme.size.iconSmall}
          color={theme.colors.brand}
        />
      ) : null}
      {!selected && hint ? (
        <AppText variant="footnote" color="textTertiary">
          {hint}
        </AppText>
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
  label: {
    flex: 1,
  },
});

export default SheetOptionRow;
