// 震动反馈子面板（2026-11-03 用户裁决：震感由设置控制、默认关）：
// 总开关 + 强度三档单选。值经 settingsStore haptics 组持久化，触觉门面
// （adapters/platform/haptics）是唯一消费面——本页只写偏好与试听：
// 开启总开关后补一记 selection 让用户当场感知（开关自身的同帧 tick 在
// 旧值=关时被门面静默，正好由这次补发凑齐一次）；切档后同理以新档试听。
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { haptics } from '@/adapters/platform/haptics';
import type { HapticsStrength } from '@/domain/store/settingsReducers';
import type { SettingsVm } from '@/adapters/viewmodels/useSettingsVm';
import { AppHeader, AppText, Icon, ListRow, Screen } from '@/presentation/ui';
import { SettingsSwitch } from './SettingsSwitch';

/** 强度三档显示名（设置主页行摘要同源消费） */
export const HAPTICS_STRENGTH_LABELS: Record<HapticsStrength, string> = {
  light: '轻',
  standard: '标准',
  strong: '强',
};

const HAPTICS_STRENGTHS: readonly HapticsStrength[] = [
  'light',
  'standard',
  'strong',
];

export interface SettingsHapticsViewProps {
  vm: SettingsVm;
  onBack: () => void;
}

export function SettingsHapticsView({ vm, onBack }: SettingsHapticsViewProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const enabled = vm.hapticsEnabled;

  return (
    <Screen style={{ backgroundColor: theme.colors.canvasGrouped }}>
      <AppHeader title="震动反馈" onBack={onBack} floating />
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
            触感反馈
          </AppText>
          <View
            style={{
              borderRadius: theme.radius.card,
              backgroundColor: theme.colors.surfaceGrouped,
              overflow: 'hidden',
            }}
          >
            <ListRow
              title="震动反馈"
              trailing={
                <SettingsSwitch
                  testID="setting-haptics-enabled"
                  accessibilityLabel="震动反馈"
                  value={enabled}
                  onValueChange={(value) => {
                    vm.setHapticsEnabled(value);
                    // 开启后以新状态补发一记试听（关→开时开关自身的同帧
                    // tick 被门面按旧值静默，本次补发使反馈恰好一次）
                    if (value) haptics.selection();
                  }}
                />
              }
            />
            <View
              pointerEvents={enabled ? 'auto' : 'none'}
              style={{ opacity: enabled ? 1 : 0.5 }}
            >
              {HAPTICS_STRENGTHS.map((strength, index) => (
                <ListRow
                  key={strength}
                  title={HAPTICS_STRENGTH_LABELS[strength]}
                  divider={index < HAPTICS_STRENGTHS.length - 1}
                  onPress={() => {
                    vm.setHapticsStrength(strength);
                    // 以新档位试听一记（关闭态被门面静默，不会误发）
                    haptics.selection();
                  }}
                  trailing={
                    vm.hapticsStrength === strength ? (
                      <Icon
                        name="check"
                        size={theme.size.iconSmall - 1}
                        color={theme.colors.brand}
                      />
                    ) : null
                  }
                  testID={`settings-haptics-${strength}`}
                />
              ))}
            </View>
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}

export default SettingsHapticsView;
