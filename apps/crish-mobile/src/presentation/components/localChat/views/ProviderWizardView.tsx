// 移动端三步添加供应商与模型向导全量视图（ProviderWizardView）：
// 权威依据：01-prototype-ui-ux-spec.md, 05-rn-components-and-gestures.md, 00-总方案.md
// 集成 useProviderWizardVm 与 WizardStepper, SwipeMultiSelect, SegmentedBar, VendorLogo, 4 大规格抽屉
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { haptics } from '@/adapters/platform/haptics';
import {
  useProviderWizardVm,
  type ProviderWizardVm,
  type UseProviderWizardVmOptions,
} from '@/adapters/viewmodels/useProviderWizardVm';
import { withThinkingDefaultTier } from '@/adapters/viewmodels/useModelSpecDraft';
import type { LocalPricingSpec } from '@/adapters/localChat/providerPresets';
import {
  AnimatedPressable,
  AppHeader,
  AppText,
  Button,
  Dialog,
  Icon,
  Input,
  ListRow,
  Screen,
  Spinner,
} from '@/presentation/ui';
import { WizardStepper } from '../ui/WizardStepper';
import { SegmentedBar } from '../ui/SegmentedBar';
import {
  SwipeMultiSelect,
  type SwipeMultiSelectItem,
} from '../ui/SwipeMultiSelect';
import { VendorLogo } from '../ui/VendorLogo';
import {
  TokenPresetSheet,
  formatTokenPreset,
} from '../sheets/TokenPresetSheet';
import {
  ThinkingConfigSheet,
  THINKING_TIER_OPTIONS,
} from '../sheets/ThinkingConfigSheet';
import { ModalitySelectSheet } from '../sheets/ModalitySelectSheet';
import { PricingSheet } from '../sheets/PricingSheet';

export interface ProviderWizardViewProps extends UseProviderWizardVmOptions {
  vm?: ProviderWizardVm;
  onBack: () => void;
  testID?: string;
}

type ActiveSheet =
  | 'context'
  | 'output'
  | 'thinking'
  | 'inputModalities'
  | 'outputModalities'
  | 'pricing'
  | null;

const MODALITY_MAP: Record<string, string> = {
  text: '文本',
  image: '图片',
  vision: '视觉',
  file: '文档',
  audio: '音频',
  video: '视频',
};

function formatPricingText(pricing?: LocalPricingSpec): string {
  if (!pricing) return '未配置';
  const sym = pricing.currency === 'USD' ? '$' : '¥';
  // 未设置的价格如实显示「未设置」，不用 1.00 / 2.00 冒充已保存值
  const inPrice =
    pricing.input !== undefined ? `${sym}${pricing.input.toFixed(2)}` : '未设置';
  const outPrice =
    pricing.output !== undefined
      ? `${sym}${pricing.output.toFixed(2)}`
      : '未设置';
  if (pricing.input === undefined && pricing.output === undefined)
    return '未设置';
  return `${inPrice} / ${outPrice}`;
}

function formatThinkingTier(tier?: string): string {
  if (!tier || tier === 'off') return '关闭 Off';
  const found = THINKING_TIER_OPTIONS.find((t) => t.tier === tier);
  return found ? found.label : tier;
}

function formatModalities(mods?: readonly string[]): string {
  if (!mods || mods.length === 0) return '文本';
  return mods.map((m) => MODALITY_MAP[m] || m).join(' · ');
}

export default function ProviderWizardView({
  vm: customVm,
  initialPresetKey,
  targetProviderId,
  onSaved,
  onCancel,
  onBack,
  testID = 'provider-wizard-view',
}: ProviderWizardViewProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const defaultVm = useProviderWizardVm({
    initialPresetKey,
    targetProviderId,
    onSaved,
    onCancel: onCancel ?? onBack,
  });
  const vm = customVm ?? defaultVm;

  const [keyVisible, setKeyVisible] = useState(false);
  const [customModelInput, setCustomModelInput] = useState('');
  const [activeSheet, setActiveSheet] = useState<ActiveSheet>(null);

  // 测速指示点呼吸动画
  const pingScale = useSharedValue(1);
  useEffect(() => {
    if (vm.pingStatus === 'testing') {
      pingScale.value = withRepeat(
        withTiming(1.3, { duration: theme.motion.duration.blink }),
        -1,
        true
      );
    } else {
      pingScale.value = 1;
    }
  }, [vm.pingStatus, pingScale, theme.motion.duration.blink]);

  const pingAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pingScale.value }],
  }));

  const pingColor =
    vm.pingStatus === 'success'
      ? theme.colors.actionPrimary
      : vm.pingStatus === 'testing'
        ? theme.colors.warning
        : vm.pingStatus === 'error'
          ? theme.colors.danger
          : theme.colors.borderStrong;

  // 步骤 1 主结果只留成功/失败；毫秒数移到次级说明，与连接诊断页
  // 同一套文案（「模型列表请求耗时」），不在主结果上单独成名。
  const pingText =
    vm.pingStatus === 'success'
      ? '连接成功'
      : vm.pingStatus === 'testing'
        ? '正在测速...'
        : vm.pingStatus === 'error'
          ? vm.pingResult?.error || '连接失败'
          : '未测试连接';

  const pingLatencyNote =
    vm.pingStatus === 'success' && vm.latencyMs != null
      ? `模型列表请求耗时 ${vm.latencyMs}ms`
      : null;

  // Step 3 数值摘要：未设置显示「自动」（发送时协议默认），不伪造 128k / 8k
  const currentContextWindow = vm.currentSpec?.contextWindow;
  const step3ContextText =
    currentContextWindow != null
      ? formatTokenPreset(currentContextWindow)
      : '自动';
  const currentMaxOutput = vm.currentSpec?.maxOutputTokens;
  const step3OutputText =
    currentMaxOutput != null ? formatTokenPreset(currentMaxOutput) : '自动';

  const handleBack = useCallback(() => {
    if (vm.step === 3) vm.goToPrevStep();
    else if (vm.step === 2 && !vm.isTargetedMode) vm.goToPrevStep();
    else onBack();
  }, [vm, onBack]);

  const handleAddCustom = useCallback(() => {
    const val = customModelInput.trim();
    if (!val) return;
    if (vm.addCustomModel(val)) {
      haptics.selection();
      setCustomModelInput('');
    }
  }, [customModelInput, vm]);

  const swipeItems = useMemo<SwipeMultiSelectItem[]>(() => {
    return vm.filteredModels.map((m) => ({
      id: m.id,
      displayName: m.displayName ?? m.id,
      contextLength: m.contextWindow
        ? m.contextWindow >= 1024
          ? `${Math.round(m.contextWindow / 1024)}k`
          : `${m.contextWindow}`
        : undefined,
      capabilities: m.modalities,
      supportsThinking:
        m.thinking?.supported ??
        Boolean(m.thinking?.defaultTier && m.thinking.defaultTier !== 'off'),
    }));
  }, [vm.filteredModels]);

  const title = vm.isTargetedMode
    ? vm.targetProviderName
      ? `添加模型 · ${vm.targetProviderName}`
      : '添加模型'
    : '添加供应商';

  return (
    <Screen style={{ backgroundColor: theme.colors.canvasGrouped }}>
      <AppHeader title={title} onBack={handleBack} floating />

      <KeyboardAwareScrollView
        testID={testID}
        bottomOffset={theme.space.md}
        contentContainerStyle={{
          paddingHorizontal: theme.space.lg,
          paddingTop: insets.top + theme.size.touchLarge + theme.space.sm + 2,
          paddingBottom: theme.space.section,
          gap: theme.space.lg,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {/* 顶部步进器：定向增模模式自动隐藏 */}
        {!vm.isTargetedMode ? (
          <WizardStepper
            currentStep={vm.step}
            onStepPress={(s) => vm.setStep(s)}
            testID="provider-wizard-stepper"
          />
        ) : null}

        {/* 第 1 步：基础连接配置 */}
        {vm.step === 1 && !vm.isTargetedMode ? (
          <View style={styles.stepContainer}>
            <View
              style={[
                styles.vendorBanner,
                {
                  backgroundColor: theme.colors.surface,
                  borderRadius: theme.radius.field,
                },
              ]}
            >
              <VendorLogo vendor={vm.vendor} size={36} />
              <View style={styles.vendorBannerTexts}>
                <AppText variant="headline" color="textPrimary">
                  {vm.name || 'AI 供应商'}
                </AppText>
                <AppText
                  variant="footnote"
                  color="textTertiary"
                  numberOfLines={1}
                >
                  {vm.baseUrl || '兼容 OpenAI 标准接口协议'}
                </AppText>
              </View>
            </View>

            <View style={{ gap: theme.space.sm }}>
              <AppText variant="footnote" color="textSecondary">
                供应商名称
              </AppText>
              <Input
                testID="wizard-input-name"
                tone="field"
                value={vm.name}
                onChangeText={vm.setName}
                placeholder="供应商名称，如 DeepSeek"
                autoCapitalize="none"
              />

              <AppText variant="footnote" color="textSecondary">
                API Base URL
              </AppText>
              <Input
                testID="wizard-input-url"
                tone="field"
                value={vm.baseUrl}
                onChangeText={vm.setBaseUrl}
                placeholder="https://api.deepseek.com/v1"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />

              <AppText variant="footnote" color="textSecondary">
                API Key
              </AppText>
              <View style={styles.keyInputRow}>
                <View style={styles.flex1}>
                  <Input
                    testID="wizard-input-key"
                    tone="field"
                    value={vm.apiKey}
                    onChangeText={vm.setApiKey}
                    placeholder={vm.apiKeyPlaceholder}
                    secureTextEntry={!keyVisible}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
                <AnimatedPressable
                  testID="btn-wizard-toggle-key"
                  accessibilityRole="button"
                  accessibilityLabel={keyVisible ? '隐藏密钥' : '显示密钥'}
                  onPress={() => setKeyVisible((v) => !v)}
                  style={[
                    styles.keyActionBtn,
                    {
                      backgroundColor: theme.colors.surface,
                      borderRadius: theme.radius.control,
                    },
                  ]}
                >
                  <Icon
                    name={keyVisible ? 'eye-off' : 'eye'}
                    size={theme.size.iconSmall + 2}
                    color={theme.colors.textSecondary}
                  />
                </AnimatedPressable>
                <AnimatedPressable
                  testID="btn-wizard-paste-key"
                  accessibilityRole="button"
                  accessibilityLabel="从剪贴板粘贴密钥"
                  onPress={() => void vm.pasteApiKey()}
                  style={[
                    styles.keyActionBtn,
                    {
                      backgroundColor: theme.colors.surface,
                      borderRadius: theme.radius.control,
                    },
                  ]}
                >
                  <Icon
                    name="copy"
                    size={theme.size.iconSmall + 2}
                    color={theme.colors.textSecondary}
                  />
                </AnimatedPressable>
              </View>
            </View>

            {/* 即时测速条 */}
            <View
              style={[
                styles.pingStrip,
                {
                  backgroundColor: theme.colors.surface,
                  borderRadius: theme.radius.field,
                },
              ]}
            >
              <View style={styles.pingLeft}>
                <Animated.View
                  style={[
                    styles.pingDot,
                    {
                      backgroundColor: pingColor,
                      borderRadius: theme.radius.pill,
                    },
                    pingAnimatedStyle,
                  ]}
                />
                <View style={styles.pingText}>
                  <AppText
                    variant="footnote"
                    color="textSecondary"
                    numberOfLines={1}
                  >
                    {pingText}
                  </AppText>
                  {pingLatencyNote ? (
                    <AppText
                      variant="caption"
                      color="textTertiary"
                      numberOfLines={1}
                      testID="wizard-ping-latency-note"
                    >
                      {pingLatencyNote}
                    </AppText>
                  ) : null}
                </View>
              </View>
              <AnimatedPressable
                testID="btn-wizard-test-ping"
                accessibilityRole="button"
                accessibilityLabel="测速"
                onPress={() => void vm.runPing()}
                disabled={vm.pinging || !vm.baseUrl.trim()}
                style={[
                  styles.pingActionBtn,
                  {
                    backgroundColor: theme.colors.fillSubtle,
                    borderRadius: theme.radius.pill,
                  },
                ]}
              >
                <Icon name="zap" size={14} color={theme.colors.actionPrimary} />
                <AppText variant="footnote" color="actionPrimary">
                  {vm.pinging ? '测速中...' : '测速'}
                </AppText>
              </AnimatedPressable>
            </View>

            <Button
              testID="btn-wizard-go-step2"
              label="下一步: 获取可用模型"
              variant="primary"
              disabled={!vm.isStep1Valid}
              onPress={vm.goToNextStep}
            />
          </View>
        ) : null}

        {/* 第 2 步：模型拉取与连续滑动多选 */}
        {vm.step === 2 ? (
          <View style={styles.stepContainer}>
            <View style={styles.searchBarRow}>
              <View style={styles.flex1}>
                <Input
                  testID="wizard-search-box"
                  tone="field"
                  value={vm.searchQuery}
                  onChangeText={vm.setSearchQuery}
                  placeholder="搜索过滤模型 ID..."
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              <View style={styles.batchBtnRow}>
                <AnimatedPressable
                  testID="btn-wizard-select-all"
                  accessibilityRole="button"
                  accessibilityLabel="全选模型"
                  onPress={vm.selectAll}
                  style={[
                    styles.batchPill,
                    {
                      backgroundColor: theme.colors.surface,
                      borderRadius: theme.radius.pill,
                    },
                  ]}
                >
                  <AppText variant="footnote" color="textPrimary">
                    全选
                  </AppText>
                </AnimatedPressable>
                <AnimatedPressable
                  testID="btn-wizard-clear-all"
                  accessibilityRole="button"
                  accessibilityLabel="清空选择"
                  onPress={vm.clearAll}
                  style={[
                    styles.batchPill,
                    {
                      backgroundColor: theme.colors.surface,
                      borderRadius: theme.radius.pill,
                    },
                  ]}
                >
                  <AppText variant="footnote" color="textSecondary">
                    清空
                  </AppText>
                </AnimatedPressable>
              </View>
            </View>

            <View style={styles.swipeHintBar}>
              <AppText variant="caption" color="textTertiary">
                轻点勾选，按住滑动可连续多选
              </AppText>
              <View
                style={[
                  styles.selectedCountBadge,
                  {
                    backgroundColor: theme.colors.fillSubtle,
                    borderRadius: theme.radius.pill,
                  },
                ]}
              >
                <AppText
                  variant="caption"
                  color={
                    vm.selectedModelIds.size > 0 ? 'brand' : 'textSecondary'
                  }
                >
                  {`已选 ${vm.selectedModelIds.size} 项`}
                </AppText>
              </View>
            </View>

            {vm.fetchingModels ? (
              <View style={styles.centerBox}>
                <Spinner />
                <AppText
                  variant="footnote"
                  color="textSecondary"
                  style={{ marginTop: theme.space.xs }}
                >
                  正在获取可用模型...
                </AppText>
              </View>
            ) : null}

            {vm.fetchError ? (
              <View style={styles.errorNotice}>
                <Icon
                  name="alert-circle"
                  size={16}
                  color={theme.colors.danger}
                />
                <AppText
                  variant="footnote"
                  color="danger"
                  style={{ marginLeft: theme.space.xs }}
                >
                  {vm.fetchError}
                </AppText>
              </View>
            ) : null}

            <SwipeMultiSelect
              items={swipeItems}
              selectedIds={vm.selectedModelIds}
              onSelectionChange={vm.setSelectedModelIds}
              onToggleItem={vm.toggleModel}
              testID="wizard-model-pick-list"
            />

            <View style={styles.addCustomBox}>
              <View style={styles.flex1}>
                <Input
                  testID="wizard-input-custom-model"
                  tone="field"
                  value={customModelInput}
                  onChangeText={setCustomModelInput}
                  placeholder="补充未拉取到的模型 ID..."
                  autoCapitalize="none"
                  autoCorrect={false}
                  onSubmitEditing={handleAddCustom}
                />
              </View>
              <AnimatedPressable
                testID="btn-wizard-add-custom-model"
                accessibilityRole="button"
                accessibilityLabel="添加自定义模型"
                onPress={handleAddCustom}
                style={[
                  styles.addCustomBtn,
                  {
                    backgroundColor: theme.colors.actionPrimary,
                    borderRadius: theme.radius.pill,
                  },
                ]}
              >
                <Icon
                  name="add"
                  size={20}
                  color={theme.colors.actionPrimaryText}
                />
              </AnimatedPressable>
            </View>

            <Button
              testID="btn-wizard-go-step3"
              label="下一步: 配置模型详细规格"
              variant="primary"
              disabled={!vm.isStep2Valid}
              onPress={vm.goToNextStep}
            />
          </View>
        ) : null}

        {/* 第 3 步：模型详细规格与能力配置 */}
        {vm.step === 3 ? (
          <View style={styles.stepContainer}>
            {/* 已选模型分段选择胶囊：单模型自动隐藏 */}
            {vm.selectedModels.length > 1 ? (
              <SegmentedBar
                options={vm.selectedModels.map((m) => ({
                  key: m.id,
                  label: m.displayName || m.id,
                }))}
                selectedKey={vm.activeModelId}
                onSelect={vm.setActiveModelId}
                testID="wizard-model-tabs-bar"
              />
            ) : null}

            <View
              style={[
                styles.specsGroupCard,
                {
                  backgroundColor: theme.colors.surface,
                  borderRadius: theme.radius.card,
                },
              ]}
            >
              <ListRow
                testID="spec-row-context"
                title="上下文窗口容量"
                subtitle="设置模型可接收的最大上下文 Token 上限"
                trailing={
                  <AppText variant="callout" color="textSecondary">
                    {step3ContextText}
                  </AppText>
                }
                showChevron
                onPress={() => setActiveSheet('context')}
              />
              <ListRow
                testID="spec-row-output"
                title="最大输出长度"
                subtitle="设置模型单次回复生成的最大 Token 限制"
                trailing={
                  <AppText variant="callout" color="textSecondary">
                    {step3OutputText}
                  </AppText>
                }
                showChevron
                onPress={() => setActiveSheet('output')}
              />
              <ListRow
                testID="spec-row-thinking"
                title="深度思考 / 推理档位"
                subtitle="思维链推导强度"
                trailing={
                  <AppText variant="callout" color="textSecondary">
                    {formatThinkingTier(vm.currentSpec?.thinking?.defaultTier)}
                  </AppText>
                }
                showChevron
                onPress={() => setActiveSheet('thinking')}
              />
              <ListRow
                testID="spec-row-input-mods"
                title="输入模态支持"
                subtitle="支持的内容格式"
                trailing={
                  <AppText variant="callout" color="textSecondary">
                    {formatModalities(vm.currentSpec?.modalities?.input)}
                  </AppText>
                }
                showChevron
                onPress={() => setActiveSheet('inputModalities')}
              />
              <ListRow
                testID="spec-row-output-mods"
                title="输出生成能力"
                subtitle="原生生成的内容形式"
                trailing={
                  <AppText variant="callout" color="textSecondary">
                    {formatModalities(vm.currentSpec?.modalities?.output)}
                  </AppText>
                }
                showChevron
                onPress={() => setActiveSheet('outputModalities')}
              />
              <ListRow
                testID="spec-row-pricing"
                title="模型单价 (1M Tokens)"
                subtitle="Prompt / Completion 计费"
                trailing={
                  <AppText variant="callout" color="textSecondary">
                    {formatPricingText(vm.currentSpec?.pricing)}
                  </AppText>
                }
                showChevron
                divider={false}
                onPress={() => setActiveSheet('pricing')}
              />
            </View>

            {vm.selectedModelIds.size > 1 ? (
              <Button
                testID="btn-wizard-apply-to-all"
                label="应用到所有已选模型"
                variant="secondary"
                onPress={vm.applyCurrentSpecToAll}
              />
            ) : null}

            <Button
              testID="btn-wizard-finish"
              label="完成并存储供应商配置"
              variant="primary"
              onPress={() => void vm.finishWizard()}
            />
          </View>
        ) : null}
      </KeyboardAwareScrollView>

      {/* 未配置模型二次确认弹窗 */}
      <Dialog
        visible={vm.unconfiguredWarningOpen}
        title="提示"
        description="尚有模型未单独配置，是否直接保存？"
        onDismiss={() => vm.setUnconfiguredWarningOpen(false)}
        actions={[
          {
            label: '继续配置',
            variant: 'secondary',
            onPress: () => vm.setUnconfiguredWarningOpen(false),
            testID: 'btnContinueConfiguringModel',
          },
          {
            label: '直接保存',
            variant: 'primary',
            onPress: () => {
              vm.setUnconfiguredWarningOpen(false);
              void vm.finishWizard(true);
            },
            testID: 'btnDirectSaveAllModels',
          },
        ]}
        testID="modalUnconfiguredModelsWarning"
      />

      {/* 4 大规格配置底抽屉 */}
      <TokenPresetSheet
        visible={activeSheet === 'context'}
        onClose={() => setActiveSheet(null)}
        title="上下文窗口容量"
        subtitle="设置模型可接收的最大上下文 Token 上限"
        value={vm.currentSpec?.contextWindow}
        presets={[16384, 32768, 65536, 131072, 200000, 1048576]}
        onApply={(val) =>
          vm.updateCurrentModelSpec((prev) => ({ ...prev, contextWindow: val }))
        }
        testID="sheet-context-tokens"
      />

      <TokenPresetSheet
        visible={activeSheet === 'output'}
        onClose={() => setActiveSheet(null)}
        title="最大输出长度"
        subtitle="设置模型单次回复生成的最大 Token 限制"
        value={vm.currentSpec?.maxOutputTokens}
        presets={[2048, 4096, 8192, 16384, 32768, 65536]}
        onApply={(val) =>
          vm.updateCurrentModelSpec((prev) => ({
            ...prev,
            maxOutputTokens: val,
          }))
        }
        testID="sheet-output-tokens"
      />

      <ThinkingConfigSheet
        visible={activeSheet === 'thinking'}
        onClose={() => setActiveSheet(null)}
        selectedTier={vm.currentSpec?.thinking?.defaultTier ?? 'off'}
        onApply={(tier) =>
          // 与详情页共用同一提交函数：只改默认档，availableTiers 原样保留
          vm.updateCurrentModelSpec((prev) =>
            withThinkingDefaultTier(prev, tier)
          )
        }
        testID="sheet-thinking"
      />

      <ModalitySelectSheet
        visible={activeSheet === 'inputModalities'}
        onClose={() => setActiveSheet(null)}
        type="input"
        selected={vm.currentSpec?.modalities?.input ?? ['text']}
        onApply={(mods) =>
          vm.updateCurrentModelSpec((prev) => ({
            ...prev,
            modalities: {
              input: mods,
              output: prev.modalities?.output ?? ['text'],
            },
          }))
        }
        testID="sheet-input-modalities"
      />

      <ModalitySelectSheet
        visible={activeSheet === 'outputModalities'}
        onClose={() => setActiveSheet(null)}
        type="output"
        selected={vm.currentSpec?.modalities?.output ?? ['text']}
        onApply={(mods) =>
          vm.updateCurrentModelSpec((prev) => ({
            ...prev,
            modalities: {
              input: prev.modalities?.input ?? ['text'],
              output: mods,
            },
          }))
        }
        testID="sheet-output-modalities"
      />

      <PricingSheet
        visible={activeSheet === 'pricing'}
        onClose={() => setActiveSheet(null)}
        pricing={vm.currentSpec?.pricing}
        onApply={(pricing) =>
          vm.updateCurrentModelSpec((prev) => ({ ...prev, pricing }))
        }
        testID="sheet-pricing"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  stepContainer: { gap: 16 },
  flex1: { flex: 1 },
  vendorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    gap: 12,
  },
  vendorBannerTexts: { flex: 1, gap: 2 },
  keyInputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  keyActionBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pingStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 10,
  },
  pingLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  pingDot: { width: 8, height: 8 },
  pingText: { flex: 1 },
  pingActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  searchBarRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  batchBtnRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  batchPill: { paddingHorizontal: 12, paddingVertical: 8 },
  swipeHintBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  selectedCountBadge: { paddingHorizontal: 8, paddingVertical: 3 },
  centerBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
  },
  errorNotice: { flexDirection: 'row', alignItems: 'center' },
  addCustomBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
  },
  addCustomBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  specsGroupCard: { overflow: 'hidden' },
});
