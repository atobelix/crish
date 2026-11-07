// 可选思考档位多选底抽屉（ThinkingTiersSheet）
// 详情「思考」组的可选档清单编辑点：一次只编辑 availableTiers 一个字段。
// 选中语言用「点」与 ModelSelectCard / ModalityCard 统一：选中 =
// textPrimary 实心点（size.dot），未选 = hairline 空心点，不用绿色描边；
// 至少保留一档（最后一档不可取消）。选择型 Sheet（keyboard="none"）。
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { haptics } from '@/adapters/platform/haptics';
import type { LocalThinkingTier } from '@/domain/types/localChat';
import { AppText, Button, Sheet, useToast } from '@/presentation/ui';
import { THINKING_TIER_OPTIONS } from './ThinkingConfigSheet';

export interface ThinkingTiersSheetProps {
  visible: boolean;
  onClose: () => void;
  selectedTiers: readonly LocalThinkingTier[];
  onApply: (tiers: LocalThinkingTier[]) => void;
  testID?: string;
}

/** 安全使用 Toast 控制器，防未包裹 ToastProvider 时异常 */
function useSafeToast() {
  try {
    return useToast();
  } catch {
    return {
      show: () => '',
      showToast: () => '',
      hide: () => {},
      clear: () => {},
    };
  }
}

export function ThinkingTiersSheet({
  visible,
  onClose,
  selectedTiers,
  onApply,
  testID = 'thinking-tiers-sheet',
}: ThinkingTiersSheetProps) {
  const theme = useTheme();
  const toast = useSafeToast();
  const [draft, setDraft] = useState<LocalThinkingTier[]>([...selectedTiers]);

  useEffect(() => {
    if (visible) {
      setDraft([...selectedTiers]);
    }
  }, [visible, selectedTiers]);

  const handleToggle = useCallback(
    (tier: LocalThinkingTier) => {
      setDraft((prev) => {
        if (prev.includes(tier)) {
          if (prev.length <= 1) {
            toast.show({ message: '至少保留一个可选档位', tone: 'warning' });
            return prev;
          }
          haptics.selection();
          return prev.filter((t) => t !== tier);
        }
        haptics.selection();
        return [...prev, tier];
      });
    },
    [toast]
  );

  const handleApply = useCallback(() => {
    // 回传按标准档位顺序排布，与数据层「升序排布」口径一致
    const ordered = THINKING_TIER_OPTIONS.map((opt) => opt.tier).filter(
      (tier) => draft.includes(tier)
    );
    onApply(ordered);
    onClose();
  }, [draft, onApply, onClose]);

  return (
    <Sheet
      keyboard="none"
      visible={visible}
      onClose={onClose}
      title="可选思考档位"
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
        <AppText
          variant="footnote"
          color="textSecondary"
          style={[styles.subtitle, { marginBottom: theme.space.md }]}
        >
          对话时可切换的思考强度范围
        </AppText>
        <View style={{ gap: theme.space.xs }}>
          {THINKING_TIER_OPTIONS.map((item) => {
            const selected = draft.includes(item.tier);
            return (
              <Pressable
                key={item.tier}
                testID={`${testID}-option-${item.tier}`}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: selected }}
                accessibilityLabel={item.label}
                onPress={() => handleToggle(item.tier)}
                style={[
                  styles.row,
                  {
                    borderRadius: theme.radius.md,
                    paddingHorizontal: theme.space.sm,
                    paddingVertical: theme.space.md,
                  },
                ]}
              >
                <AppText variant="body" style={styles.label}>
                  {item.label}
                </AppText>
                <View
                  testID={`${testID}-dot-${item.tier}`}
                  style={{
                    width: theme.size.dot,
                    height: theme.size.dot,
                    borderRadius: theme.radius.pill,
                    backgroundColor: selected
                      ? theme.colors.textPrimary
                      : 'transparent',
                    borderWidth: selected ? 0 : 1,
                    borderColor: theme.colors.hairline,
                  }}
                />
              </Pressable>
            );
          })}
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 48,
  },
  label: {
    fontWeight: '500',
  },
});

export default ThinkingTiersSheet;
