// 账号页导航行：高 56、左右 24、底部分隔线，右侧可选数值 + textTertiary 箭头。
import { Pressable, StyleSheet } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Icon } from '@/presentation/ui';

export interface NavRowProps {
  label: string;
  value?: string;
  onPress: () => void;
  /** 分组最后一行不画分隔线 */
  last?: boolean;
  testID?: string;
}

export function NavRow({
  label,
  value,
  onPress,
  last = false,
  testID,
}: NavRowProps) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={value ? `${label}，${value}` : label}
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          height: theme.size.navRow,
          marginHorizontal: theme.layout.accountPageX,
          gap: theme.space.sm,
          borderBottomColor: theme.colors.hairline,
          borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
          opacity: pressed ? theme.motion.pressOpacity : 1,
        },
      ]}
    >
      <AppText variant="body" color="textPrimary" style={styles.label}>
        {label}
      </AppText>
      {value ? (
        <AppText variant="callout" color="textTertiary">
          {value}
        </AppText>
      ) : null}
      <Icon
        name="chevron-right"
        size={theme.size.iconSmall}
        color={theme.colors.textTertiary}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  label: { flex: 1 },
});

export default NavRow;
