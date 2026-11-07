// 移动端单模型规格深度视图（ModelSpecView）
// 权威依据：docs/mobile-provider-architecture/analysis/01-prototype-ui-ux-spec.md 与 00-总方案.md
// 字段按六组重组（P4）：基础（展示名/默认/启用）/ 能力（输入·输出模态）/
// 上下文与输出 / 思考（支持开关·可选档·默认档三拆）/ 价格 / 高级（compat 三项）。
// 一个字段一个编辑点：每个 Sheet 只改它标题上的那一个字段；思考保存
// 走共享提交函数 withThinking*（与向导同一套），永不塌缩 availableTiers；
// 未设置的数值显示「自动」，不伪造 128k / 1.00 之类的默认值。
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useTheme } from '@/adapters/platform/theme';
import type {
  LocalCompatSpec,
  LocalThinkingTier,
} from '@/domain/types/localChat';
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
import { ThinkingTiersSheet } from '../sheets/ThinkingTiersSheet';
import { ModalitySelectSheet } from '../sheets/ModalitySelectSheet';
import { PricingSheet } from '../sheets/PricingSheet';
import { DisplayNameSheet } from '../sheets/DisplayNameSheet';
import {
  CompatSelectSheet,
  type CompatOption,
} from '../sheets/CompatSelectSheet';

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

const TIER_SHORT_LABELS: Record<LocalThinkingTier, string> = {
  off: '关闭',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '极限',
};

type CompatField = 'thinkingFormat' | 'maxTokensField' | 'supportsDeveloperRole';

const THINKING_FORMAT_OPTIONS: readonly CompatOption[] = [
  { key: 'openai', label: 'OpenAI（reasoning_effort）' },
  { key: 'deepseek', label: 'DeepSeek' },
  { key: 'qwen', label: 'Qwen' },
  { key: 'zai', label: 'ZAI' },
  { key: 'anthropic', label: 'Anthropic' },
  { key: 'gemini', label: 'Gemini' },
];

const MAX_TOKENS_FIELD_OPTIONS: readonly CompatOption[] = [
  { key: 'max_tokens', label: 'max_tokens' },
  { key: 'max_completion_tokens', label: 'max_completion_tokens' },
];

const DEVELOPER_ROLE_OPTIONS: readonly CompatOption[] = [
  { key: 'true', label: '支持' },
  { key: 'false', label: '不支持（降级为 system）' },
];

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
  const [nameSheetOpen, setNameSheetOpen] = useState(false);
  const [tiersSheetOpen, setTiersSheetOpen] = useState(false);
  const [compatField, setCompatField] = useState<CompatField | null>(null);

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

  /** 高级组单字段写入：undefined = 删除模型级覆盖（跟随供应商）；三项全空则 compat 整体回落未设置 */
  const setCompatValue = useCallback(
    (field: CompatField, value: string | boolean | undefined) => {
      vm.draft.updateSpec((prev) => {
        const compat: LocalCompatSpec = { ...(prev.compat ?? {}) };
        if (field === 'thinkingFormat') {
          if (value === undefined) delete compat.thinkingFormat;
          else compat.thinkingFormat = value as LocalCompatSpec['thinkingFormat'];
        } else if (field === 'maxTokensField') {
          if (value === undefined) delete compat.maxTokensField;
          else compat.maxTokensField = value as LocalCompatSpec['maxTokensField'];
        } else {
          if (value === undefined) delete compat.supportsDeveloperRole;
          else compat.supportsDeveloperRole = value as boolean;
        }
        return {
          ...prev,
          compat: Object.keys(compat).length > 0 ? compat : undefined,
        };
      });
    },
    [vm.draft]
  );

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

  const spec = vm.spec;
  const thinking = spec.thinking;
  const thinkingSupported = thinking?.supported ?? false;
  const tiersSummary = vm.thinkingTiers
    .map((t) => TIER_SHORT_LABELS[t] ?? t)
    .join(' · ');
  const currencySymbol = vm.currency === 'USD' ? '$' : '¥';
  const pricingSummary = !spec.pricing
    ? '未设置'
    : vm.pricingInput === '' && vm.pricingOutput === ''
      ? '未设置'
      : `${vm.pricingInput === '' ? '未设置' : `${currencySymbol}${vm.pricingInput}`} / ${vm.pricingOutput === '' ? '未设置' : `${currencySymbol}${vm.pricingOutput}`}`;
  const compat = spec.compat;
  const thinkingFormatText = compat?.thinkingFormat
    ? (THINKING_FORMAT_OPTIONS.find((o) => o.key === compat.thinkingFormat)
        ?.label ?? compat.thinkingFormat)
    : '跟随供应商';
  const maxTokensFieldText = compat?.maxTokensField ?? '跟随供应商';
  const developerRoleText =
    compat?.supportsDeveloperRole === undefined
      ? '跟随供应商'
      : compat.supportsDeveloperRole
        ? '支持'
        : '不支持';

  const compatSheetConfig =
    compatField === 'thinkingFormat'
      ? {
          title: '思考格式',
          subtitle: '模型级覆盖优先于供应商级设置',
          options: THINKING_FORMAT_OPTIONS,
          selectedKey: compat?.thinkingFormat,
          onApply: (key: string | undefined) =>
            setCompatValue('thinkingFormat', key),
        }
      : compatField === 'maxTokensField'
        ? {
            title: '最大输出字段',
            subtitle: '生成长度参数的字段名方言',
            options: MAX_TOKENS_FIELD_OPTIONS,
            selectedKey: compat?.maxTokensField,
            onApply: (key: string | undefined) =>
              setCompatValue('maxTokensField', key),
          }
        : compatField === 'supportsDeveloperRole'
          ? {
              title: '开发者角色',
              subtitle: '模型是否支持 developer 角色消息',
              options: DEVELOPER_ROLE_OPTIONS,
              selectedKey:
                compat?.supportsDeveloperRole === undefined
                  ? undefined
                  : String(compat.supportsDeveloperRole),
              onApply: (key: string | undefined) =>
                setCompatValue(
                  'supportsDeveloperRole',
                  key === undefined ? undefined : key === 'true'
                ),
            }
          : null;

  const cardGroupStyle = [
    styles.cardGroup,
    {
      backgroundColor: theme.colors.surfaceGrouped,
      borderRadius: theme.radius.lg,
    },
  ];

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
            {spec.displayName ?? vm.modelId}
          </AppText>
          <AppText variant="caption" color="textTertiary">
            {vm.modelId} · 隶属于当前服务商 · 独立配置生效
          </AppText>
        </View>

        {/* 1. 基础：展示名 / 默认模型 / 启用 */}
        <View style={styles.sectionWrap}>
          <SectionHeader title="基础" />
          <View style={cardGroupStyle}>
            <ListRow
              title="展示名"
              subtitle="列表与对话中显示的名字"
              divider
              showChevron
              onPress={() => setNameSheetOpen(true)}
              testID="row-display-name"
              trailing={
                <AppText variant="callout" color="textSecondary">
                  {spec.displayName ?? '同模型 ID'}
                </AppText>
              }
            />
            <ListRow
              title="设为默认模型"
              subtitle="在当前供应商中作为首选对话模型"
              divider
              trailing={
                <SettingsSwitch
                  value={vm.isDefault}
                  onValueChange={(val) => vm.draft.setIsDefault(val)}
                  testID="switch-default-model"
                  accessibilityLabel="设为此供应商默认模型"
                />
              }
            />
            <ListRow
              title="启用模型"
              subtitle="关闭后不出现在活动模型列表中"
              divider={false}
              trailing={
                <SettingsSwitch
                  value={spec.enabled ?? true}
                  onValueChange={(val) => vm.draft.setEnabled(val)}
                  testID="switch-model-enabled"
                  accessibilityLabel="启用此模型"
                />
              }
            />
          </View>
        </View>

        {/* 2. 能力：输入 / 输出模态 */}
        <View style={styles.sectionWrap}>
          <SectionHeader title="能力" />
          <View style={cardGroupStyle}>
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

        {/* 3. 上下文与输出：两个数字各自编辑，未设置显示「自动」 */}
        <View style={styles.sectionWrap}>
          <SectionHeader title="上下文与输出" />
          <View style={cardGroupStyle}>
            <ListRow
              title="上下文窗口容量"
              subtitle="最大接收 Token 限制"
              divider
              showChevron
              onPress={vm.draft.openContextSheet}
              testID="row-context-window"
              trailing={
                <AppText variant="mono" color="textSecondary">
                  {vm.contextWindowText}
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
                  {vm.maxOutputTokensText}
                </AppText>
              }
            />
          </View>
        </View>

        {/* 4. 思考：支持开关 / 可选档 / 默认档 三个独立编辑点 */}
        <View style={styles.sectionWrap}>
          <SectionHeader title="思考" />
          <View style={cardGroupStyle}>
            <ListRow
              title="深度思考"
              subtitle="模型是否支持思维链推导"
              divider={thinkingSupported}
              trailing={
                <SettingsSwitch
                  value={thinkingSupported}
                  onValueChange={(val) => vm.draft.setThinkingSupported(val)}
                  testID="switch-thinking-supported"
                  accessibilityLabel="支持深度思考"
                />
              }
            />
            {thinkingSupported ? (
              <>
                <ListRow
                  title="可选档位"
                  subtitle="对话时可切换的思考强度范围"
                  divider
                  showChevron
                  onPress={() => setTiersSheetOpen(true)}
                  testID="row-thinking-tiers"
                  trailing={
                    <AppText variant="callout" color="textSecondary">
                      {tiersSummary}
                    </AppText>
                  }
                />
                <ListRow
                  title="默认档位"
                  subtitle="进入对话时的缺省思考强度"
                  divider={false}
                  showChevron
                  onPress={vm.draft.openThinkingSheet}
                  testID="row-thinking-tier"
                  trailing={
                    <AppText variant="callout" color="textSecondary">
                      {vm.thinkingBadgeText}
                    </AppText>
                  }
                />
              </>
            ) : null}
          </View>
        </View>

        {/* 5. 价格：摘要一行，编辑页内三字段分开 */}
        <View style={styles.sectionWrap}>
          <SectionHeader title="价格" />
          <View style={cardGroupStyle}>
            <ListRow
              title="结算单价与币种"
              subtitle="提示词 (Input) / 补全 (Output)，每 1M Tokens"
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

        {/* 6. 高级：模型级 compat 三项，缺省跟随供应商 */}
        <View style={styles.sectionWrap}>
          <SectionHeader title="高级" />
          <View style={cardGroupStyle}>
            <ListRow
              title="思考格式"
              subtitle="思考参数的组装方言"
              divider
              showChevron
              onPress={() => setCompatField('thinkingFormat')}
              testID="row-compat-thinking-format"
              trailing={
                <AppText variant="callout" color="textSecondary">
                  {thinkingFormatText}
                </AppText>
              }
            />
            <ListRow
              title="最大输出字段"
              subtitle="生成长度参数的字段名"
              divider
              showChevron
              onPress={() => setCompatField('maxTokensField')}
              testID="row-compat-max-tokens-field"
              trailing={
                <AppText variant="callout" color="textSecondary">
                  {maxTokensFieldText}
                </AppText>
              }
            />
            <ListRow
              title="开发者角色"
              subtitle="是否支持 developer 角色消息"
              divider={false}
              showChevron
              onPress={() => setCompatField('supportsDeveloperRole')}
              testID="row-compat-developer-role"
              trailing={
                <AppText variant="callout" color="textSecondary">
                  {developerRoleText}
                </AppText>
              }
            />
          </View>
        </View>

        {/* 7. 危险区：移除模型 */}
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

      {/* 规格编辑底抽屉：一个字段一个编辑点 */}
      <DisplayNameSheet
        visible={nameSheetOpen}
        onClose={() => setNameSheetOpen(false)}
        modelId={vm.modelId}
        displayName={spec.displayName}
        onApply={(name) => vm.draft.setDisplayName(name)}
        testID="sheet-display-name"
      />

      <TokenPresetSheet
        visible={vm.draft.contextSheetOpen}
        onClose={vm.draft.closeContextSheet}
        title="上下文窗口容量"
        subtitle="设置模型可接收的最大上下文 Token 上限，留空为自动"
        value={spec.contextWindow}
        presets={[16384, 32768, 65536, 131072, 200000, 1048576]}
        validate={(val) =>
          val !== undefined &&
          spec.maxOutputTokens !== undefined &&
          spec.maxOutputTokens > val
            ? '上下文窗口不能小于已设置的最大输出长度'
            : null
        }
        onApply={(val) => vm.draft.submitContextWindow(val)}
        testID="sheet-context-window"
      />

      <TokenPresetSheet
        visible={vm.draft.outputSheetOpen}
        onClose={vm.draft.closeOutputSheet}
        title="最大输出长度"
        subtitle="设置模型单次回复生成的最大 Token 限制，留空为自动"
        value={spec.maxOutputTokens}
        presets={[2048, 4096, 8192, 16384, 32768, 65536]}
        validate={(val) =>
          val !== undefined &&
          spec.contextWindow !== undefined &&
          val > spec.contextWindow
            ? '最大输出不能超过上下文窗口容量'
            : null
        }
        onApply={(val) => vm.draft.submitMaxOutputTokens(val)}
        testID="sheet-max-output"
      />

      <ThinkingConfigSheet
        visible={vm.draft.thinkingSheetOpen}
        onClose={vm.draft.closeThinkingSheet}
        title="默认档位"
        selectedTier={thinking?.defaultTier ?? 'off'}
        availableTiers={vm.thinkingTiers}
        onApply={(tier) => vm.draft.setDefaultTier(tier)}
        testID="sheet-thinking-tier"
      />

      <ThinkingTiersSheet
        visible={tiersSheetOpen}
        onClose={() => setTiersSheetOpen(false)}
        selectedTiers={vm.thinkingTiers}
        onApply={(tiers) => vm.draft.setAvailableTiers(tiers)}
        testID="sheet-thinking-tiers"
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
        pricing={spec.pricing}
        onApply={(pricing) => vm.draft.submitPricing(pricing)}
        testID="sheet-pricing"
      />

      {compatSheetConfig ? (
        <CompatSelectSheet
          visible={compatField !== null}
          onClose={() => setCompatField(null)}
          title={compatSheetConfig.title}
          subtitle={compatSheetConfig.subtitle}
          options={compatSheetConfig.options}
          selectedKey={compatSheetConfig.selectedKey}
          onApply={compatSheetConfig.onApply}
          testID={`sheet-compat-${compatField}`}
        />
      ) : null}
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
