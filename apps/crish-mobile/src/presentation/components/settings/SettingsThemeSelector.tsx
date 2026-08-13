// 深色模式三选（R2UX-06-05：跟随系统/浅色/深色，F6 §9 外观）：
// - 分段式三选（chips 行内切换，M4 §6.1 分段控件）；选中态 = 绿底绿字双通道
//   （颜色 + accessibilityState.selected，M4 §6.5 状态表达双通道）；
// - 模式文案/顺序单一真源：THEME_MODES / THEME_MODE_LABELS（themeProjection）；
// - 切换即时生效（themeModeStore → useAppTheme 投影 token，设置页与后续全局一致）。
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  THEME_MODES,
  THEME_MODE_LABELS,
  useAppTheme,
  type ThemeMode,
} from '@/adapters/settings/themeProjection';

export interface SettingsThemeSelectorProps {
  value: ThemeMode;
  onChange: (mode: ThemeMode) => void;
  /** 容器 testID（选项 testID = `${testID}-${mode}`） */
  testID?: string;
}

const OPTION_TEST_ID: Record<ThemeMode, string> = {
  system: 'setting-theme-system',
  light: 'setting-theme-light',
  dark: 'setting-theme-dark',
};

export default function SettingsThemeSelector({
  value,
  onChange,
  testID = 'setting-theme',
}: SettingsThemeSelectorProps) {
  const theme = useAppTheme();
  return (
    <View
      testID={testID}
      style={[styles.selector, { borderColor: theme.hairline }]}
    >
      {THEME_MODES.map((mode) => {
        const active = value === mode;
        return (
          <Pressable
            key={mode}
            testID={OPTION_TEST_ID[mode]}
            accessibilityRole="button"
            accessibilityLabel={`${THEME_MODE_LABELS[mode]}${active ? '（当前）' : ''}`}
            accessibilityState={{ selected: active }}
            onPress={() => onChange(mode)}
            style={({ pressed }) => [
              styles.option,
              {
                borderColor: active ? theme.colorSuccess : 'transparent',
                backgroundColor: active ? theme.colorSuccessBg : 'transparent',
              },
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text
              style={[
                styles.optionText,
                { color: active ? theme.colorSuccess : theme.textSecondary },
              ]}
            >
              {THEME_MODE_LABELS[mode]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  selector: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginVertical: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 4,
    gap: 4,
  },
  option: {
    flex: 1,
    minHeight: 36,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  optionText: {
    fontSize: 13,
    fontWeight: '500',
  },
});
