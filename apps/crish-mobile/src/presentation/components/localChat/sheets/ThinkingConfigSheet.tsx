// 移动端规格配置底抽屉：ThinkingConfigSheet
// 遵循 docs/mobile-provider-architecture/analysis/01-prototype-ui-ux-spec.md 与 05-rn-components-and-gestures.md
// 深度思考推理档位选择（7 档精炼强度，复用 SheetOptionRow + 触感 + 确定保存主按钮）
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { haptics } from '@/adapters/platform/haptics';
import type { LocalThinkingTier } from '@/domain/types/localChat';
import { AppText, Button, Sheet, SheetOptionRow } from '@/presentation/ui';

export interface ThinkingTierOption {
  tier: LocalThinkingTier;
  label: string;
}

export const THINKING_TIER_OPTIONS: readonly ThinkingTierOption[] = [
  { tier: 'off', label: '关闭 Off' },
  { tier: 'minimal', label: '最低 Minimal' },
  { tier: 'low', label: '低 Low' },
  { tier: 'medium', label: '中 Medium' },
  { tier: 'high', label: '高 High' },
  { tier: 'xhigh', label: '极高 X-High' },
  { tier: 'max', label: '最高 Max' },
] as const;

export interface ThinkingConfigSheetProps {
  visible: boolean;
  onClose: () => void;
  selectedTier: LocalThinkingTier;
  onApply: (tier: LocalThinkingTier) => void;
  title?: string;
  subtitle?: string;
  availableTiers?: readonly LocalThinkingTier[];
  /** 兼容契约（底座 Sheet 语义档位，默认 large） */
  snapPoints?: readonly (string | number)[];
  testID?: string;
}

export function ThinkingConfigSheet({
  visible,
  onClose,
  selectedTier,
  onApply,
  title = '深度思考档位',
  subtitle = '设置思维链推导强度',
  availableTiers,
  snapPoints: _snapPoints,
  testID = 'thinking-config-sheet',
}: ThinkingConfigSheetProps) {
  const theme = useTheme();
  const [draftTier, setDraftTier] = useState<LocalThinkingTier>(selectedTier);

  useEffect(() => {
    if (visible) {
      setDraftTier(selectedTier);
    }
  }, [visible, selectedTier]);

  const handleSelect = (tier: LocalThinkingTier) => {
    setDraftTier(tier);
    haptics.selection();
  };

  const handleApply = () => {
    onApply(draftTier);
    onClose();
  };

  const options = availableTiers
    ? THINKING_TIER_OPTIONS.filter((opt) => availableTiers.includes(opt.tier))
    : THINKING_TIER_OPTIONS;

  return (
    <Sheet
      keyboard="none"
      visible={visible}
      onClose={onClose}
      title={title}
      size="large"
      testID={testID}
      footer={
        <Button
          testID={`${testID}-apply`}
          label="确定保存"
          variant="primary"
          onPress={handleApply}
        />
      }
    >
      <View style={styles.container}>
        {subtitle ? (
          <AppText
            variant="footnote"
            color="textSecondary"
            style={[styles.subtitle, { marginBottom: theme.space.md }]}
          >
            {subtitle}
          </AppText>
        ) : null}

        <View style={{ gap: theme.space.sm }}>
          {options.map((item) => (
            <SheetOptionRow
              key={item.tier}
              testID={`${testID}-option-${item.tier}`}
              label={item.label}
              selected={draftTier === item.tier}
              onPress={() => handleSelect(item.tier)}
            />
          ))}
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  container: {
    alignSelf: 'stretch',
  },
  subtitle: {
    paddingHorizontal: 2,
  },
});

export default ThinkingConfigSheet;
