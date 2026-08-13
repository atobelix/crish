// 设置开关行（R2-06 设置页；F6 §12.1 设置行 + R2UX-06-08 无障碍）：
// - 行 = label + description + Switch（原生，M4 §6.1 平台原生优先）；
// - 未连接 → disabled + 右侧「未连接」灰字提示（任务书：settingsCommands 读取/
//   更新未连接时禁用态）；禁用不只靠颜色（M4 §6.2-4：附原因文案）；
// - 无障碍：Switch accessibilityLabel = 「label + 状态/未连接」，行热区 ≥44
//   （minHeight 48，M4 §3.4 触控尺寸）。
import { StyleSheet, Switch, Text, View } from 'react-native';
import { useAppTheme } from '@/adapters/settings/themeProjection';

export interface SettingsSwitchRowProps {
  label: string;
  description?: string;
  value: boolean;
  /** 未连接等禁用原因（true 时禁用 + 展示 hint） */
  disabled?: boolean;
  /** 禁用原因文案（如「未连接」；缺省「未连接」） */
  disabledHint?: string;
  onValueChange: (value: boolean) => void;
  testID?: string;
}

export default function SettingsSwitchRow({
  label,
  description,
  value,
  disabled = false,
  disabledHint = '未连接',
  onValueChange,
  testID,
}: SettingsSwitchRowProps) {
  const theme = useAppTheme();
  const stateLabel = disabled
    ? `${label}，${disabledHint}`
    : `${label}，${value ? '已开启' : '已关闭'}`;
  return (
    <View
      testID={testID}
      style={[
        styles.row,
        { borderBottomColor: theme.hairline },
        disabled && styles.disabled,
      ]}
    >
      <View style={styles.textCol}>
        <Text style={[styles.label, { color: theme.textPrimary }]}>
          {label}
        </Text>
        {description ? (
          <Text style={[styles.description, { color: theme.textSecondary }]}>
            {description}
          </Text>
        ) : null}
      </View>
      <View style={styles.controlCol}>
        {disabled ? (
          <Text style={[styles.hint, { color: theme.textTertiary }]}>
            {disabledHint}
          </Text>
        ) : null}
        <Switch
          testID={testID ? `${testID}-switch` : undefined}
          accessibilityRole="switch"
          accessibilityLabel={stateLabel}
          value={value}
          disabled={disabled}
          onValueChange={onValueChange}
          trackColor={{ true: theme.colorSuccess, false: theme.hairlineStrong }}
          thumbColor={theme.bgElevated}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  textCol: {
    flex: 1,
    paddingRight: 12,
    gap: 2,
  },
  controlCol: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
  },
  description: {
    fontSize: 12,
    lineHeight: 18,
  },
  hint: {
    fontSize: 12,
  },
  disabled: {
    opacity: 0.5,
  },
});
