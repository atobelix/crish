// 字体与字号子面板（原型 subFont）：正文字号三选 + 代码字体三选，真实生效。
// 预览即时性：本视图与预览文本都走 useTheme()，其投影订阅 appearance 组——
// 切换选项后字阶/等宽族立即重投影，预览所见即所得（Q1 裁决）。
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import type { FontScale, MonoFont } from '@/domain/store/settingsReducers';
import { AppHeader, AppText, Icon, ListRow, Screen } from '@/presentation/ui';
import type { SettingsVm } from '@/adapters/viewmodels/useSettingsVm';

/** 正文字号渲染顺序（UI 顺序 = 读屏顺序） */
export const FONT_SCALES: readonly FontScale[] = [
  'standard',
  'large',
  'xlarge',
];

export const FONT_SCALE_LABELS: Record<FontScale, string> = {
  standard: '标准',
  large: '大',
  xlarge: '特大',
};

const FONT_SCALE_HINTS: Record<FontScale, string> = {
  standard: '默认大小',
  large: '放大 12.5%',
  xlarge: '放大 25%',
};

/** 代码字体渲染顺序 */
export const MONO_FONTS: readonly MonoFont[] = ['system', 'jetbrains', 'fira'];

export const MONO_FONT_LABELS: Record<MonoFont, string> = {
  system: '系统等宽',
  jetbrains: 'JetBrains Mono',
  fira: 'Fira Code',
};

export interface SettingsFontViewProps {
  vm: SettingsVm;
  onBack: () => void;
}

export function SettingsFontView({ vm, onBack }: SettingsFontViewProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Screen style={{ backgroundColor: theme.colors.canvasGrouped }}>
      <AppHeader title="字体与字号" onBack={onBack} floating />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.space.lg,
          paddingTop: insets.top + theme.size.touchLarge + theme.space.sm + 2,
          paddingBottom: theme.space.section,
          gap: theme.space.lg,
        }}
      >
        <FontGroup label="正文字号">
          {FONT_SCALES.map((scale, index) => (
            <ListRow
              key={scale}
              title={FONT_SCALE_LABELS[scale]}
              subtitle={FONT_SCALE_HINTS[scale]}
              onPress={() => vm.setFontScale(scale)}
              divider={index < FONT_SCALES.length - 1}
              trailing={
                vm.fontScale === scale ? (
                  <Icon
                    name="check"
                    size={theme.size.iconSmall - 1}
                    color={theme.colors.brand}
                  />
                ) : null
              }
              testID={`settings-font-scale-${scale}`}
            />
          ))}
        </FontGroup>

        {/* 字号预览：正文按当前字阶实时渲染 */}
        <FontGroup label="预览">
          <View
            style={{
              paddingHorizontal: theme.space.lg,
              paddingVertical: theme.space.md,
              gap: theme.space.xs,
            }}
          >
            <AppText variant="body">
              这段文字使用当前字号显示，切换上方选项会立即生效。
            </AppText>
            <AppText variant="footnote" color="textTertiary">
              The quick brown fox jumps over the lazy dog.
            </AppText>
          </View>
        </FontGroup>

        <FontGroup label="代码字体">
          {MONO_FONTS.map((font, index) => (
            <ListRow
              key={font}
              title={MONO_FONT_LABELS[font]}
              onPress={() => vm.setMonoFont(font)}
              divider={index < MONO_FONTS.length - 1}
              trailing={
                vm.monoFont === font ? (
                  <Icon
                    name="check"
                    size={theme.size.iconSmall - 1}
                    color={theme.colors.brand}
                  />
                ) : null
              }
              testID={`settings-font-mono-${font}`}
            />
          ))}
        </FontGroup>

        {/* 等宽预览：代码样本与配对码数字按当前所选等宽字体实时渲染 */}
        <FontGroup label="预览">
          <View
            style={{
              paddingHorizontal: theme.space.lg,
              paddingVertical: theme.space.md,
              gap: theme.space.sm,
            }}
          >
            <AppText variant="mono">
              const pairCode = &quot;483 920&quot;;
            </AppText>
            <AppText variant="codeDigit">483920</AppText>
          </View>
        </FontGroup>
      </ScrollView>
    </Screen>
  );
}

/** 分组：弱化标签 + 白色分组卡（与主题子页同构） */
function FontGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
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
        {label}
      </AppText>
      <View
        style={{
          borderRadius: theme.radius.card,
          backgroundColor: theme.colors.surfaceGrouped,
          overflow: 'hidden',
        }}
      >
        {children}
      </View>
    </View>
  );
}

export default SettingsFontView;
