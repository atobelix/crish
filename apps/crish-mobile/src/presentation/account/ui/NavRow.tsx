// 账号页导航行（原型 subAccount 行口径）：置于白色分组卡内，内衬 14/16、
// 标签 14/500、值 13/400 #777、箭头 14、分隔线 dashed faint（末行不画），
// 按压叠层 120ms 过渡（按压过渡统一批）。
import { Pressable, StyleSheet } from 'react-native';
import Animated from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Icon } from '@/presentation/ui';
import { usePressFade } from '@/presentation/ui/pressFeedback';
import type { IconName } from '@/presentation/ui/iconPaths';

export interface NavRowProps {
  label: string;
  value?: string;
  onPress: () => void;
  /** 分组最后一行不画分隔线 */
  last?: boolean;
  testID?: string;
  /** 尾部图标（缺省 chevron-right 导航箭头；非导航行如 UID 复制行传 'copy'） */
  trailingIcon?: IconName;
}

export function NavRow({
  label,
  value,
  onPress,
  last = false,
  testID,
  trailingIcon,
}: NavRowProps) {
  const theme = useTheme();
  const press = usePressFade();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={value ? `${label}，${value}` : label}
      testID={testID}
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={[
        styles.row,
        {
          paddingVertical: theme.space.md + 2,
          paddingHorizontal: theme.space.lg,
          gap: theme.space.xs + 2,
          borderBottomColor: theme.colors.hairline,
          // 发丝线口径（2026-11-02 分割线裁决：更浅更细）
          borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        },
      ]}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: theme.colors.fillSelected },
          press.overlayStyle,
        ]}
      />
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
        name={trailingIcon ?? 'chevron-right'}
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
