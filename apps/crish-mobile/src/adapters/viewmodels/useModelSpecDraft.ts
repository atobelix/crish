// 通用模型规格草稿 Hook：供向导 Step 3 与单模型详情页共享复用。
// 纯净状态管理，负责单模型规格编辑、抽屉可见性、规格注水同步与未配置拦截检查。
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  LocalCurrencyKind,
  LocalModalitiesSpec,
  LocalModelSpec,
  LocalPricingSpec,
  LocalThinkingSpec,
  LocalThinkingTier,
} from '@/domain/types/localChat';

export interface UnconfiguredCheckResult {
  hasWarning: boolean;
  unconfiguredModelIds: string[];
  configuredModelIds: string[];
  warningMessage?: string;
}

export function isModelConfigured(spec?: LocalModelSpec | null): boolean {
  if (!spec) return false;
  return (
    spec.contextWindow !== undefined ||
    spec.maxOutputTokens !== undefined ||
    (spec.thinking !== undefined && spec.thinking.supported) ||
    (spec.modalities !== undefined &&
      (spec.modalities.input.length > 0 ||
        spec.modalities.output.length > 0)) ||
    spec.pricing !== undefined
  );
}

export function checkUnconfiguredModels(
  selectedModelIds: string[],
  customModelSpecs: Record<string, LocalModelSpec>
): UnconfiguredCheckResult {
  const configuredModelIds: string[] = [];
  const unconfiguredModelIds: string[] = [];
  for (const id of selectedModelIds) {
    if (isModelConfigured(customModelSpecs[id])) configuredModelIds.push(id);
    else unconfiguredModelIds.push(id);
  }
  const hasWarning =
    selectedModelIds.length > 1 &&
    configuredModelIds.length > 0 &&
    unconfiguredModelIds.length > 0;
  return {
    hasWarning,
    unconfiguredModelIds,
    configuredModelIds,
    warningMessage: hasWarning
      ? `您选择了 ${selectedModelIds.length} 个模型，其中 ${unconfiguredModelIds.length} 个尚未独立配置规格。是否批量应用当前规格或直接保存？`
      : undefined,
  };
}

export function applySpecsToAllModels(
  selectedModelIds: string[],
  sourceSpec: LocalModelSpec,
  existingSpecs?: Record<string, LocalModelSpec>
): Record<string, LocalModelSpec> {
  const result: Record<string, LocalModelSpec> = { ...(existingSpecs ?? {}) };
  for (const modelId of selectedModelIds) {
    const prev = existingSpecs?.[modelId];
    result[modelId] = {
      id: modelId,
      displayName:
        prev?.displayName ??
        (prev?.id === sourceSpec.id ? sourceSpec.displayName : undefined),
      enabled: prev?.enabled ?? sourceSpec.enabled ?? true,
      order: prev?.order,
      contextWindow: sourceSpec.contextWindow,
      maxOutputTokens: sourceSpec.maxOutputTokens,
      thinking: sourceSpec.thinking
        ? {
            supported: sourceSpec.thinking.supported,
            availableTiers: [...sourceSpec.thinking.availableTiers],
            defaultTier: sourceSpec.thinking.defaultTier,
          }
        : undefined,
      modalities: sourceSpec.modalities
        ? {
            input: [...sourceSpec.modalities.input],
            output: [...sourceSpec.modalities.output],
          }
        : undefined,
      pricing: sourceSpec.pricing ? { ...sourceSpec.pricing } : undefined,
      compat: sourceSpec.compat ? { ...sourceSpec.compat } : undefined,
    };
  }
  return result;
}

export function formatTokensText(tokens?: number): string {
  // 未设置（undefined）显示「自动」：发送时由协议默认决定，禁止伪造 128k 之类的具体数值。
  if (tokens === undefined || tokens === null || tokens <= 0) return '自动';
  if (tokens >= 1024 * 1024) {
    const m = tokens / (1024 * 1024);
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    const k = tokens / 1024;
    return `${Number.isInteger(k) ? k : k.toFixed(0)}k`;
  }
  return `${tokens}`;
}

export function formatThinkingBadgeText(spec?: LocalThinkingSpec): string {
  if (!spec || !spec.supported || spec.defaultTier === 'off') return '关闭';
  const labels: Record<LocalThinkingTier, string> = {
    off: '关闭',
    minimal: '极低',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '超高',
    max: '极限',
  };
  return labels[spec.defaultTier] ?? spec.defaultTier;
}

/**
 * 思考三字段各自独立的提交函数（详情页与向导 Step 3 共用同一套，杜绝两条
 * 路径行为分叉——历史上详情保存默认档会把 availableTiers 塌缩成
 * ['off', tier]，一次编辑毁掉多档；向导路径则保留。以下三个函数每个
 * 只改自己名下的字段。）
 */

/** 只改默认档：可选档清单与支持开关原样保留，永不塌缩 availableTiers。 */
export function withThinkingDefaultTier(
  spec: LocalModelSpec,
  tier: LocalThinkingTier
): LocalModelSpec {
  const prev = spec.thinking;
  if (!prev) {
    return {
      ...spec,
      thinking: {
        supported: tier !== 'off',
        availableTiers: tier === 'off' ? ['off'] : ['off', tier],
        defaultTier: tier,
      },
    };
  }
  return { ...spec, thinking: { ...prev, defaultTier: tier } };
}

/** 只改支持开关：可选档与默认档原样保留（关掉支持不丢已配的档位）。 */
export function withThinkingSupported(
  spec: LocalModelSpec,
  supported: boolean
): LocalModelSpec {
  const prev = spec.thinking;
  if (!prev) {
    if (!supported) return spec;
    return {
      ...spec,
      thinking: { supported: true, availableTiers: ['off'], defaultTier: 'off' },
    };
  }
  return { ...spec, thinking: { ...prev, supported } };
}

/** 只改可选档清单：支持开关不动；默认档若被移出清单，回落到清单首档。 */
export function withThinkingAvailableTiers(
  spec: LocalModelSpec,
  tiers: LocalThinkingTier[]
): LocalModelSpec {
  const nextTiers: LocalThinkingTier[] =
    tiers.length > 0 ? tiers : ['off'];
  const prev = spec.thinking;
  if (!prev) {
    return {
      ...spec,
      thinking: {
        supported: nextTiers.some((t) => t !== 'off'),
        availableTiers: nextTiers,
        defaultTier: nextTiers[0] ?? 'off',
      },
    };
  }
  return {
    ...spec,
    thinking: {
      ...prev,
      availableTiers: nextTiers,
      defaultTier: nextTiers.includes(prev.defaultTier)
        ? prev.defaultTier
        : (nextTiers[0] ?? 'off'),
    },
  };
}

function makeDefaultModelSpec(id = 'default-model'): LocalModelSpec {
  return {
    id,
    enabled: true,
    contextWindow: 131072,
    maxOutputTokens: 8192,
    modalities: { input: ['text'], output: ['text'] },
    thinking: { supported: false, availableTiers: ['off'], defaultTier: 'off' },
  };
}

export type DrawerSheetKey =
  | 'context'
  | 'output'
  | 'thinking'
  | 'inputModalities'
  | 'outputModalities'
  | 'pricing';

export interface UseModelSpecDraftOptions {
  initialSpec?: LocalModelSpec;
  isDefault?: boolean;
  onSpecChange?: (spec: LocalModelSpec) => void;
  onDefaultChange?: (isDefault: boolean) => void;
  selectedModelIds?: string[];
  customModelSpecs?: Record<string, LocalModelSpec>;
  onCustomModelSpecsChange?: (specs: Record<string, LocalModelSpec>) => void;
}

export interface ModelSpecDraftVm {
  readonly spec: LocalModelSpec;
  readonly isDefault: boolean;

  readonly contextWindowText: string;
  readonly maxOutputTokensText: string;
  readonly thinkingTiers: readonly LocalThinkingTier[];
  readonly thinkingBadgeText: string;
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
  readonly currency: LocalCurrencyKind;
  readonly pricingInput: string;
  readonly pricingOutput: string;

  readonly contextSheetOpen: boolean;
  readonly outputSheetOpen: boolean;
  readonly thinkingSheetOpen: boolean;
  readonly inputModalitiesOpen: boolean;
  readonly outputModalitiesOpen: boolean;
  readonly pricingSheetOpen: boolean;

  setContextSheetOpen: (open: boolean) => void;
  openContextSheet: () => void;
  closeContextSheet: () => void;
  setOutputSheetOpen: (open: boolean) => void;
  openOutputSheet: () => void;
  closeOutputSheet: () => void;
  setThinkingSheetOpen: (open: boolean) => void;
  openThinkingSheet: () => void;
  closeThinkingSheet: () => void;
  setInputModalitiesOpen: (open: boolean) => void;
  openInputModalities: () => void;
  closeInputModalities: () => void;
  setOutputModalitiesOpen: (open: boolean) => void;
  openOutputModalities: () => void;
  closeOutputModalities: () => void;
  setPricingSheetOpen: (open: boolean) => void;
  openPricingSheet: () => void;
  closePricingSheet: () => void;
  closeAllSheets: () => void;

  submitContextWindow: (tokens: number | undefined) => void;
  submitMaxOutputTokens: (tokens: number | undefined) => void;
  submitThinking: (thinking: LocalThinkingSpec | undefined) => void;
  submitPricing: (pricing: LocalPricingSpec | undefined) => void;
  submitInputModalities: (mods: string[]) => void;
  submitOutputModalities: (mods: string[]) => void;

  setIsDefault: (val: boolean) => void;
  setDisplayName: (name: string | undefined) => void;
  setEnabled: (enabled: boolean) => void;
  setContextWindow: (tokens: number | undefined) => void;
  setMaxOutputTokens: (tokens: number | undefined) => void;
  setThinking: (thinking: LocalThinkingSpec | undefined) => void;
  setThinkingTiers: (tiers: LocalThinkingTier[]) => void;
  setDefaultThinkingTier: (tier: LocalThinkingTier) => void;
  /** 只改思考支持开关（保留可选档/默认档） */
  setThinkingSupported: (supported: boolean) => void;
  /** 只改可选档清单（默认档被移出时回落首档） */
  setAvailableTiers: (tiers: LocalThinkingTier[]) => void;
  /** 只改默认档（永不塌缩可选档清单） */
  setDefaultTier: (tier: LocalThinkingTier) => void;
  setPricing: (pricing: LocalPricingSpec | undefined) => void;
  setModalities: (modalities: LocalModalitiesSpec | undefined) => void;
  setInputModalities: (mods: string[]) => void;
  setOutputModalities: (mods: string[]) => void;
  updateSpec: (updater: (prev: LocalModelSpec) => LocalModelSpec) => void;
  resetSpec: (newSpec: LocalModelSpec) => void;

  applySpecsToAllModels: (
    targetModelIds?: string[]
  ) => Record<string, LocalModelSpec>;
  readonly unconfiguredCheck: UnconfiguredCheckResult;
  readonly hasUnconfiguredWarning: boolean;
}

export function useModelSpecDraft(
  options: UseModelSpecDraftOptions = {}
): ModelSpecDraftVm {
  const {
    initialSpec,
    isDefault: initialIsDefault = false,
    onSpecChange,
    onDefaultChange,
    selectedModelIds,
    customModelSpecs,
    onCustomModelSpecsChange,
  } = options;

  const [draftSpec, setDraftSpec] = useState<LocalModelSpec>(
    () => initialSpec ?? makeDefaultModelSpec()
  );
  const [defaultState, setDefaultState] = useState<boolean>(initialIsDefault);
  const [openSheets, setOpenSheets] = useState<Record<DrawerSheetKey, boolean>>(
    {
      context: false,
      output: false,
      thinking: false,
      inputModalities: false,
      outputModalities: false,
      pricing: false,
    }
  );

  useEffect(() => {
    if (initialSpec) setDraftSpec(initialSpec);
  }, [initialSpec?.id]);
  useEffect(() => {
    if (initialIsDefault !== undefined) setDefaultState(initialIsDefault);
  }, [initialIsDefault]);

  const updateSpec = useCallback(
    (updater: (prev: LocalModelSpec) => LocalModelSpec) => {
      setDraftSpec((prev) => {
        const next = updater(prev);
        onSpecChange?.(next);
        return next;
      });
    },
    [onSpecChange]
  );

  const resetSpec = useCallback(
    (newSpec: LocalModelSpec) => {
      setDraftSpec(newSpec);
      onSpecChange?.(newSpec);
    },
    [onSpecChange]
  );

  const setIsDefault = useCallback(
    (val: boolean) => {
      setDefaultState(val);
      onDefaultChange?.(val);
    },
    [onDefaultChange]
  );

  const setDisplayName = useCallback(
    (displayName: string | undefined) =>
      updateSpec((p) => ({ ...p, displayName })),
    [updateSpec]
  );
  const setEnabled = useCallback(
    (enabled: boolean) => updateSpec((p) => ({ ...p, enabled })),
    [updateSpec]
  );
  const setContextWindow = useCallback(
    (contextWindow: number | undefined) =>
      updateSpec((p) => ({ ...p, contextWindow })),
    [updateSpec]
  );
  const setMaxOutputTokens = useCallback(
    (maxOutputTokens: number | undefined) =>
      updateSpec((p) => ({ ...p, maxOutputTokens })),
    [updateSpec]
  );
  const setThinking = useCallback(
    (thinking: LocalThinkingSpec | undefined) =>
      updateSpec((p) => ({ ...p, thinking })),
    [updateSpec]
  );
  const setModalities = useCallback(
    (modalities: LocalModalitiesSpec | undefined) =>
      updateSpec((p) => ({ ...p, modalities })),
    [updateSpec]
  );
  const setPricing = useCallback(
    (pricing: LocalPricingSpec | undefined) =>
      updateSpec((p) => ({ ...p, pricing })),
    [updateSpec]
  );

  const setThinkingTiers = useCallback(
    (tiers: LocalThinkingTier[]) =>
      updateSpec((prev) => withThinkingAvailableTiers(prev, tiers)),
    [updateSpec]
  );

  const setDefaultThinkingTier = useCallback(
    (tier: LocalThinkingTier) =>
      updateSpec((prev) => withThinkingDefaultTier(prev, tier)),
    [updateSpec]
  );

  const setThinkingSupported = useCallback(
    (supported: boolean) =>
      updateSpec((prev) => withThinkingSupported(prev, supported)),
    [updateSpec]
  );

  const setAvailableTiers = useCallback(
    (tiers: LocalThinkingTier[]) =>
      updateSpec((prev) => withThinkingAvailableTiers(prev, tiers)),
    [updateSpec]
  );

  const setDefaultTier = useCallback(
    (tier: LocalThinkingTier) =>
      updateSpec((prev) => withThinkingDefaultTier(prev, tier)),
    [updateSpec]
  );

  const setInputModalities = useCallback(
    (input: string[]) => {
      updateSpec((prev) => ({
        ...prev,
        modalities: { input, output: prev.modalities?.output ?? ['text'] },
      }));
    },
    [updateSpec]
  );

  const setOutputModalities = useCallback(
    (output: string[]) => {
      updateSpec((prev) => ({
        ...prev,
        modalities: { input: prev.modalities?.input ?? ['text'], output },
      }));
    },
    [updateSpec]
  );

  const setSheet = useCallback((key: DrawerSheetKey, open: boolean) => {
    setOpenSheets((prev) =>
      prev[key] === open ? prev : { ...prev, [key]: open }
    );
  }, []);

  const closeAllSheets = useCallback(() => {
    setOpenSheets({
      context: false,
      output: false,
      thinking: false,
      inputModalities: false,
      outputModalities: false,
      pricing: false,
    });
  }, []);

  const submitContextWindow = useCallback(
    (tokens: number | undefined) => {
      setContextWindow(tokens);
      setSheet('context', false);
    },
    [setContextWindow, setSheet]
  );

  const submitMaxOutputTokens = useCallback(
    (tokens: number | undefined) => {
      setMaxOutputTokens(tokens);
      setSheet('output', false);
    },
    [setMaxOutputTokens, setSheet]
  );

  const submitThinking = useCallback(
    (thinking: LocalThinkingSpec | undefined) => {
      setThinking(thinking);
      setSheet('thinking', false);
    },
    [setThinking, setSheet]
  );

  const submitInputModalities = useCallback(
    (mods: string[]) => {
      setInputModalities(mods);
      setSheet('inputModalities', false);
    },
    [setInputModalities, setSheet]
  );

  const submitOutputModalities = useCallback(
    (mods: string[]) => {
      setOutputModalities(mods);
      setSheet('outputModalities', false);
    },
    [setOutputModalities, setSheet]
  );

  const submitPricing = useCallback(
    (pricing: LocalPricingSpec | undefined) => {
      setPricing(pricing);
      setSheet('pricing', false);
    },
    [setPricing, setSheet]
  );

  const applySpecsToAll = useCallback(
    (targetModelIds?: string[]) => {
      const ids = targetModelIds ?? selectedModelIds ?? [];
      const updated = applySpecsToAllModels(ids, draftSpec, customModelSpecs);
      onCustomModelSpecsChange?.(updated);
      return updated;
    },
    [draftSpec, selectedModelIds, customModelSpecs, onCustomModelSpecsChange]
  );

  const unconfiguredCheck = useMemo(
    () =>
      checkUnconfiguredModels(selectedModelIds ?? [], customModelSpecs ?? {}),
    [selectedModelIds, customModelSpecs]
  );

  const contextWindowText = useMemo(
    () => formatTokensText(draftSpec.contextWindow),
    [draftSpec.contextWindow]
  );
  const maxOutputTokensText = useMemo(
    () => formatTokensText(draftSpec.maxOutputTokens),
    [draftSpec.maxOutputTokens]
  );
  const thinkingTiers = useMemo<readonly LocalThinkingTier[]>(
    () => draftSpec.thinking?.availableTiers ?? ['off'],
    [draftSpec.thinking?.availableTiers]
  );
  const thinkingBadgeText = useMemo(
    () => formatThinkingBadgeText(draftSpec.thinking),
    [draftSpec.thinking]
  );
  const inputModalities = useMemo(
    () => draftSpec.modalities?.input ?? ['text'],
    [draftSpec.modalities?.input]
  );
  const outputModalities = useMemo(
    () => draftSpec.modalities?.output ?? ['text'],
    [draftSpec.modalities?.output]
  );
  const currency = draftSpec.pricing?.currency ?? 'CNY';

  const pricingInput = useMemo(() => {
    const v =
      draftSpec.pricing?.inputPricePerMillion ?? draftSpec.pricing?.input;
    return v !== undefined ? String(v) : '';
  }, [draftSpec.pricing]);

  const pricingOutput = useMemo(() => {
    const v =
      draftSpec.pricing?.outputPricePerMillion ?? draftSpec.pricing?.output;
    return v !== undefined ? String(v) : '';
  }, [draftSpec.pricing]);

  return {
    spec: draftSpec,
    isDefault: defaultState,
    contextWindowText,
    maxOutputTokensText,
    thinkingTiers,
    thinkingBadgeText,
    inputModalities,
    outputModalities,
    currency,
    pricingInput,
    pricingOutput,
    contextSheetOpen: openSheets.context,
    outputSheetOpen: openSheets.output,
    thinkingSheetOpen: openSheets.thinking,
    inputModalitiesOpen: openSheets.inputModalities,
    outputModalitiesOpen: openSheets.outputModalities,
    pricingSheetOpen: openSheets.pricing,
    setContextSheetOpen: (v) => setSheet('context', v),
    openContextSheet: () => setSheet('context', true),
    closeContextSheet: () => setSheet('context', false),
    setOutputSheetOpen: (v) => setSheet('output', v),
    openOutputSheet: () => setSheet('output', true),
    closeOutputSheet: () => setSheet('output', false),
    setThinkingSheetOpen: (v) => setSheet('thinking', v),
    openThinkingSheet: () => setSheet('thinking', true),
    closeThinkingSheet: () => setSheet('thinking', false),
    setInputModalitiesOpen: (v) => setSheet('inputModalities', v),
    openInputModalities: () => setSheet('inputModalities', true),
    closeInputModalities: () => setSheet('inputModalities', false),
    setOutputModalitiesOpen: (v) => setSheet('outputModalities', v),
    openOutputModalities: () => setSheet('outputModalities', true),
    closeOutputModalities: () => setSheet('outputModalities', false),
    setPricingSheetOpen: (v) => setSheet('pricing', v),
    openPricingSheet: () => setSheet('pricing', true),
    closePricingSheet: () => setSheet('pricing', false),
    closeAllSheets,
    submitContextWindow,
    submitMaxOutputTokens,
    submitThinking,
    submitInputModalities,
    submitOutputModalities,
    submitPricing,
    setIsDefault,
    setDisplayName,
    setEnabled,
    setContextWindow,
    setMaxOutputTokens,
    setThinking,
    setThinkingTiers,
    setDefaultThinkingTier,
    setThinkingSupported,
    setAvailableTiers,
    setDefaultTier,
    setModalities,
    setInputModalities,
    setOutputModalities,
    setPricing,
    updateSpec,
    resetSpec,
    applySpecsToAllModels: applySpecsToAll,
    unconfiguredCheck,
    hasUnconfiguredWarning: unconfiguredCheck.hasWarning,
  };
}
