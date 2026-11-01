// 外观与主题子面板（原型 subTheme）：跟随系统 / 浅色 / 深色 / 纯净中性灰四档
// 单选（第四档为推导档，J5/J8)，选中行 = 绿色对号 15。
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  useTheme,
  THEME_MODES,
  THEME_MODE_LABELS,
} from '@/adapters/platform/theme';
import type { ThemeMode } from '@/domain/store/settingsReducers';
import { AppHeader, AppText, Icon, ListRow, Screen } from '@/presentation/ui';
import type { SettingsVm } from '@/adapters/viewmodels/useSettingsVm';

export interface SettingsThemeViewProps {
  vm: SettingsVm;
  onBack: () => void;
}

export function SettingsThemeView({ vm, onBack }: SettingsThemeViewProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Screen style={{ backgroundColor: theme.colors.canvasGrouped }}>
      <AppHeader title="外观与主题" onBack={onBack} floating />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.space.lg,
          paddingTop: insets.top + theme.size.touchLarge + theme.space.sm + 2,
          paddingBottom: theme.space.section,
          gap: theme.space.lg,
        }}
      >
        <View style={{ gap: theme.space.xs + 2 }}>
          <AppText
            variant="sectionLabel"
            color="textTertiary"
            style={{
              paddingHorizontal: theme.space.xs + 2,
              fontWeight: '500',
              letterSpacing: -(theme.type.sectionLabel.letterSpacing ?? 0),
            }}
          >
            界面主题
          </AppText>
          <View
            style={{
              borderRadius: theme.radius.card,
              backgroundColor: theme.colors.surfaceGrouped,
              overflow: 'hidden',
            }}
          >
            {THEME_MODES.map((mode: ThemeMode, index: number) => (
              <ListRow
                key={mode}
                title={THEME_MODE_LABELS[mode]}
                onPress={() => vm.setThemeMode(mode)}
                divider={index < THEME_MODES.length - 1}
                trailing={
                  vm.themeMode === mode ? (
                    <Icon
                      name="check"
                      size={theme.size.iconSmall - 1}
                      color={theme.colors.brand}
                    />
                  ) : null
                }
                testID={`settings-theme-${mode}`}
              />
            ))}
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}

export default SettingsThemeView;
