// 账号页导航行（原型 subAccount 行口径）：置于白色分组卡内，内衬 14/16、
// 标签 14/500、值 13/400 #777、箭头 14、分隔线 dashed faint（末行不画），按压 alpha 底。
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
          paddingVertical: theme.space.md + 2,
          paddingHorizontal: theme.space.lg,
          gap: theme.space.xs + 2,
          borderBottomColor: theme.colors.hairline,
          borderBottomWidth: last ? 0 : 1,
          backgroundColor: pressed ? theme.colors.fillSelected : 'transparent',
        },
      ]}
    >
      <AppText
        variant="body"
        color="textPrimary"
        style={[styles.label, styles.labelWeight]}
      >
        {label}
      </AppText>
      {value ? (
        <AppText variant="footnote" color="textTertiary">
          {value}
        </AppText>
      ) : null}
      <Icon
        name="chevron-right"
        size={theme.size.iconSmall - 2}
        color={theme.colors.textTertiary}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderStyle: 'dashed',
  },
  label: { flex: 1 },
  labelWeight: { fontWeight: '500' },
});

export default NavRow;
