// 移动端单模型规格深度视图（ModelSpecView）
// 权威依据：docs/mobile-provider-architecture/analysis/01-prototype-ui-ux-spec.md 与 00-总方案.md
// 提供：默认模型设置 + Token限制规格 + 思考档位/多模态配置 + 独立计费单价 + 移除模型危急操作
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useTheme } from '@/adapters/platform/theme';
import type { LocalThinkingTier } from '@/domain/types/localChat';
import {
  useModelDetailVm,
  type ModelDetailVm,
} from '@/adapters/viewmodels/useModelDetailVm';
import {
  AppHeader,
  AppText,
  Button,
  Dialog,
  EmptyState,
  ListRow,
  Screen,
  SectionHeader,
  useToast,
} from '@/presentation/ui';
import { SettingsSwitch } from '@/presentation/components/settings/SettingsSwitch';
import { TokenPresetSheet } from '../sheets/TokenPresetSheet';
import { ThinkingConfigSheet } from '../sheets/ThinkingConfigSheet';
import { ModalitySelectSheet } from '../sheets/ModalitySelectSheet';
import { PricingSheet } from '../sheets/PricingSheet';

export interface ModelSpecViewProps {
  providerId: string;
  modelId: string;
  vm?: ModelDetailVm;
  onBack?: () => void;
  onSaved?: () => void;
  onDeleted?: () => void;
  testID?: string;
}

const MODALITY_LABELS: Record<string, string> = {
  text: '文本',
  image: '视觉',
  file: '文档',
  audio: '语音',
  video: '视频',
};

function formatModalities(modalities: readonly string[]): string {
  if (!modalities || modalities.length === 0) return '未设置';
  return modalities.map((m) => MODALITY_LABELS[m] ?? m).join(' · ');
}

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

export default function ModelSpecView({
  providerId,
  modelId,
  vm: customVm,
  onBack,
  onSaved,
  onDeleted,
  testID = 'model-spec-view',
}: ModelSpecViewProps) {
  const defaultVm = useModelDetailVm(providerId, modelId);
  const vm = customVm ?? defaultVm;
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useSafeToast();

  const [saving, setSaving] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const handleBack = useCallback(
    () => (onBack ? onBack() : router.back()),
    [onBack]
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const ok = await vm.save();
      if (ok) {
        toast.show({ message: '模型规格已保存', tone: 'success' });
        onSaved?.();
      }
    } finally {
      setSaving(false);
    }
  }, [vm, toast, onSaved]);

  const handleDeleteConfirm = useCallback(async () => {
    setDeleteDialogOpen(false);
    await vm.removeModel();
    toast.show({ message: '模型已移除', tone: 'info' });
    if (onDeleted) onDeleted();
    else router.back();
  }, [vm, toast, onDeleted]);

  if (vm.isNotFound) {
    return (
      <Screen
        style={{ backgroundColor: theme.colors.canvasGrouped }}
        testID={testID}
      >
        <AppHeader title="模型规格" onBack={handleBack} floating />
        <View
          style={[
            styles.notFoundBox,
            {
              paddingTop: insets.top + theme.size.touchLarge + theme.space.xl,
              paddingHorizontal: theme.space.lg,
            },
          ]}
        >
          <EmptyState title="未找到该模型" />
          <Button label="返回上一页" variant="secondary" onPress={handleBack} />
        </View>
      </Screen>
    );
  }

  const currencySymbol = vm.currency === 'USD' ? '$' : '¥';
  const pricingSummary = `${currencySymbol}${vm.pricingInput || '0.00'} / ${currencySymbol}${vm.pricingOutput || '0.00'}`;

  return (
    <Screen
      style={{ backgroundColor: theme.colors.canvasGrouped }}
      testID={testID}
    >
      <AppHeader
        title="模型规格"
        onBack={handleBack}
        floating
        actions={
          <Button
            label="保存"
            size="compact"
            variant="primary"
            loading={saving}
            onPress={handleSave}
            testID="btn-save-model-spec"
            style={styles.saveBtn}
          />
        }
      />

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingTop: insets.top + theme.size.touchLarge + theme.space.sm + 2,
            paddingBottom: insets.bottom + theme.space.xxl,
            paddingHorizontal: theme.space.lg,
          },
        ]}
      >
        {/* 模型标识信息头 */}
        <View style={styles.modelHeaderCard}>
          <AppText
            variant="headline"
            numberOfLines={1}
            style={styles.monoTitle}
          >
            {vm.modelId}
          </AppText>
          <AppText variant="caption" color="textTertiary">
            隶属于当前服务商 · 独立配置生效
          </AppText>
        </View>

        {/* 1. 默认模型设置 */}
        <View style={styles.sectionWrap}>
          <SectionHeader title="首选配置" />
          <View
            style={[
              styles.cardGroup,
              {
                backgroundColor: theme.colors.surfaceGrouped,
                borderRadius: theme.radius.lg,
              },
            ]}
          >
            <ListRow
              title="设为默认模型"
              subtitle="在当前供应商中作为首选对话模型"
              divider={false}
              trailing={
                <SettingsSwitch
                  value={vm.isDefault}
                  onValueChange={(val) => vm.draft.setIsDefault(val)}
                  testID="switch-default-model"
                  accessibilityLabel="设为此供应商默认模型"
                />
              }
            />
          </View>
        </View>

        {/* 2. Token 限制规格 */}
        <View style={styles.sectionWrap}>
          <SectionHeader title="Token 限制规格" />
          <View
            style={[
              styles.cardGroup,
              {
                backgroundColor: theme.colors.surfaceGrouped,
                borderRadius: theme.radius.lg,
              },
            ]}
          >
            <ListRow
              title="上下文窗口容量"
              subtitle="最大接收 Token 限制"
              divider
              showChevron
              onPress={vm.draft.openContextSheet}
              testID="row-context-window"
              trailing={
                <AppText variant="mono" color="textSecondary">
                  {vm.contextWindowText || '128k'}
                </AppText>
              }
            />
            <ListRow
              title="最大输出长度"
              subtitle="单次回复生成上限"
              divider={false}
              showChevron
              onPress={vm.draft.openOutputSheet}
              testID="row-max-output"
              trailing={
                <AppText variant="mono" color="textSecondary">
                  {vm.maxOutputTokensText || '8k'}
                </AppText>
              }
            />
          </View>
        </View>

        {/* 3. 推理与多模态能力 */}
        <View style={styles.sectionWrap}>
          <SectionHeader title="推理与多模态能力" />
          <View
            style={[
              styles.cardGroup,
              {
                backgroundColor: theme.colors.surfaceGrouped,
                borderRadius: theme.radius.lg,
              },
            ]}
          >
            <ListRow
              title="深度思考 / 推理档位"
              subtitle="思维链推导强度"
              divider
              showChevron
              onPress={vm.draft.openThinkingSheet}
              testID="row-thinking-tier"
              trailing={
                <AppText variant="callout" color="textSecondary">
                  {vm.thinkingBadgeText || '关闭'}
                </AppText>
              }
            />
            <ListRow
              title="输入模态支持"
              subtitle="模型可接收的内容格式"
              divider
              showChevron
              onPress={vm.draft.openInputModalities}
              testID="row-input-modalities"
              trailing={
                <AppText variant="callout" color="textSecondary">
                  {formatModalities(vm.inputModalities)}
                </AppText>
              }
            />
            <ListRow
              title="输出生成能力"
              subtitle="模型原生生成的内容形式"
              divider={false}
              showChevron
              onPress={vm.draft.openOutputModalities}
              testID="row-output-modalities"
              trailing={
                <AppText variant="callout" color="textSecondary">
                  {formatModalities(vm.outputModalities)}
                </AppText>
              }
            />
          </View>
        </View>

        {/* 4. 模型单价与计费 */}
        <View style={styles.sectionWrap}>
          <SectionHeader title="模型计费 (每 1M Tokens)" />
          <View
            style={[
              styles.cardGroup,
              {
                backgroundColor: theme.colors.surfaceGrouped,
                borderRadius: theme.radius.lg,
              },
            ]}
          >
            <ListRow
              title="结算单价与币种"
              subtitle="提示词 (Input) / 补全 (Output)"
              divider={false}
              showChevron
              onPress={vm.draft.openPricingSheet}
              testID="row-pricing"
              trailing={
                <AppText variant="mono" color="textSecondary">
                  {pricingSummary}
                </AppText>
              }
            />
          </View>
        </View>

        {/* 5. 危险区：移除模型 */}
        <View style={styles.dangerSection}>
          <Button
            label="从供应商中移除此模型"
            variant="danger"
            onPress={() => setDeleteDialogOpen(true)}
            testID="btn-delete-model"
          />
        </View>
      </ScrollView>

      {/* 确认删除对话框 */}
      <Dialog
        visible={deleteDialogOpen}
        title="移除模型"
        description={`确定要从该供应商中移除模型 "${vm.modelId}" 吗？此操作不可撤销。`}
        onDismiss={() => setDeleteDialogOpen(false)}
        actions={[
          {
            label: '取消',
            variant: 'secondary',
            onPress: () => setDeleteDialogOpen(false),
            testID: 'dialog-cancel-delete',
          },
          {
            label: '确认移除',
            variant: 'danger',
            onPress: handleDeleteConfirm,
            testID: 'dialog-confirm-delete',
          },
        ]}
      />

      {/* 6 大底抽屉弹窗 */}
      <TokenPresetSheet
        visible={vm.draft.contextSheetOpen}
        onClose={vm.draft.closeContextSheet}
        title="上下文窗口容量"
        subtitle="设置模型可接收的最大上下文 Token 上限"
        value={vm.spec.contextWindow ?? 131072}
        presets={[16384, 32768, 65536, 131072, 200000, 1048576]}
        onApply={(val) => vm.draft.submitContextWindow(val)}
        testID="sheet-context-window"
      />

      <TokenPresetSheet
        visible={vm.draft.outputSheetOpen}
        onClose={vm.draft.closeOutputSheet}
        title="最大输出长度"
        subtitle="设置模型单次回复生成的最大 Token 限制"
        value={vm.spec.maxOutputTokens ?? 8192}
        presets={[2048, 4096, 8192, 16384, 32768, 65536]}
        onApply={(val) => vm.draft.submitMaxOutputTokens(val)}
        testID="sheet-max-output"
      />

      <ThinkingConfigSheet
        visible={vm.draft.thinkingSheetOpen}
        onClose={vm.draft.closeThinkingSheet}
        selectedTier={
          (vm.spec.thinking?.defaultTier as LocalThinkingTier) ?? 'off'
        }
        onApply={(tier) => {
          vm.draft.submitThinking({
            supported: tier !== 'off',
            availableTiers: tier === 'off' ? ['off'] : ['off', tier],
            defaultTier: tier,
          });
        }}
        testID="sheet-thinking-tier"
      />

      <ModalitySelectSheet
        visible={vm.draft.inputModalitiesOpen}
        onClose={vm.draft.closeInputModalities}
        type="input"
        selected={[...vm.inputModalities]}
        onApply={(mods) => vm.draft.submitInputModalities(mods)}
        testID="sheet-input-modalities"
      />

      <ModalitySelectSheet
        visible={vm.draft.outputModalitiesOpen}
        onClose={vm.draft.closeOutputModalities}
        type="output"
        selected={[...vm.outputModalities]}
        onApply={(mods) => vm.draft.submitOutputModalities(mods)}
        testID="sheet-output-modalities"
      />

      <PricingSheet
        visible={vm.draft.pricingSheetOpen}
        onClose={vm.draft.closePricingSheet}
        pricing={vm.spec.pricing}
        onApply={(pricing) => vm.draft.submitPricing(pricing)}
        testID="sheet-pricing"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  saveBtn: { minHeight: 34, height: 34, paddingHorizontal: 16 },
  scrollContent: { gap: 16 },
  modelHeaderCard: { paddingVertical: 8, paddingHorizontal: 4, gap: 4 },
  monoTitle: { fontWeight: '700' },
  sectionWrap: { gap: 8 },
  cardGroup: { overflow: 'hidden' },
  dangerSection: { marginTop: 8, paddingTop: 8 },
  notFoundBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
});
