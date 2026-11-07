// 本地供应商列表视图模型：配置面（localChatStore）的只读投影 + 预置厂商接入 + 活动切换与级联删除。
import { useCallback, useEffect, useMemo } from 'react';
import { useStore } from 'zustand';
import { localChatStore } from '@/domain/store/localChatStore';
import { providerDefaultModelId } from '@/domain/pure/localChatProtocol';
import type { LocalVendorKey } from '@/domain/types/localChat';
import {
  detectVendorKey,
  PROVIDER_PRESETS,
  type ProviderPreset,
} from '@/adapters/localChat/providerPresets';
import {
  ON_DEVICE_PROVIDER_ID,
  syncOnDeviceProvider,
} from '@/adapters/onDevice/onDeviceProviderSync';
import { getOnDeviceModelManager } from '@/adapters/onDevice/onDeviceWiring';
import type {
  LocalModelsConfig,
  LocalProviderSpec,
} from '@/domain/types/localChat';

/** 预置厂商推荐展示卡片契约 */
export interface PresetVendorItem {
  readonly key: LocalVendorKey;
  readonly vendor: LocalVendorKey;
  readonly name: string;
  readonly displayName: string;
  readonly host: string;
  readonly desc: string;
  readonly defaultBaseUrl: string;
  readonly defaultKeyPlaceholder: string;
  readonly websiteUrl?: string;
  readonly preset: ProviderPreset;
}

function extractHost(urlStr: string): string {
  try {
    return new URL(urlStr).host;
  } catch {
    return urlStr.replace(/^https?:\/\//, '').split('/')[0] ?? '';
  }
}

const PRESET_DESCRIPTIONS: Record<LocalVendorKey, string> = {
  deepseek: '高性价比前沿推理与通用模型（DeepSeek-V3 / R1）',
  siliconflow: '开箱即用的大模型推理加速云平台',
  ollama: '手机局域网直连本地离线开源大模型',
  openai: '业界前沿旗舰大模型（GPT-4o 与 o1/o3 系列）',
  anthropic: 'Claude 3.7 旗舰推理与长上下文对话',
  google: 'Gemini 2.5 系列多模态大模型',
  custom: '自定义兼容 OpenAI Chat Completions 协议的端点',
};

/** 官方预置厂商静态列表（基于 PROVIDER_PRESETS 纯数据派生） */
export const PRESET_VENDORS: readonly PresetVendorItem[] = (
  Object.keys(PROVIDER_PRESETS) as LocalVendorKey[]
).map((key) => {
  const p = PROVIDER_PRESETS[key];
  return {
    key,
    vendor: key,
    name: p.name,
    displayName: p.displayName ?? p.name,
    host: extractHost(p.defaultBaseUrl),
    desc: PRESET_DESCRIPTIONS[key] ?? p.name,
    defaultBaseUrl: p.defaultBaseUrl,
    defaultKeyPlaceholder: p.apiKeyPlaceholder,
    websiteUrl: p.websiteUrl,
    preset: p,
  };
});

export const PRESETS = PRESET_VENDORS;

/** 本地供应商列表项投影契约（厂商、默认模型与启停投影；实测耗时不在列表展示，收敛到连接诊断页） */
export interface LocalProviderRow {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly host: string;
  /** 厂商标识（驱动官方矢量 Logo 渲染） */
  readonly vendor: LocalVendorKey;
  readonly vendorKey: LocalVendorKey;
  /** 默认模型 ID（活动模型优先，其次显式 defaultModelId，其次清单首个） */
  readonly defaultModelId: string | null;
  /** 默认模型展示名称 */
  readonly defaultModelName: string | null;
  readonly modelCount: number;
  readonly hasKey: boolean;
  readonly isActive: boolean;
}

export interface LocalProvidersVm {
  /** 已配置的直连供应商行（不含端侧内置条目，见 onDeviceRow） */
  readonly rows: readonly LocalProviderRow[];
  /**
   * 端侧内置条目「本机模型」的行投影（O4）：配置中尚无该条目（从未
   * 同步过任何就绪模型）时为 null；视图据此置顶特殊行，其计数即
   * 已下载且校验在案的模型数。与 rows 分开是因为它没有密钥/延迟/
   * 启停开关语义，点按去向也是模型管理面而非供应商详情。
   */
  readonly onDeviceRow: LocalProviderRow | null;
  readonly presets: readonly PresetVendorItem[];
  readonly activeProvider: LocalProviderRow | null;
  readonly hydrated: boolean;
  /** 设为当前（活动模型 = 该供应商默认模型） */
  activate: (providerId: string) => void;
  /** 删除供应商（级联清理 SecureStore 密钥、活动模型与悬挂线程引用） */
  remove: (providerId: string) => Promise<void>;
}

/** 单个供应商配置 → 列表行投影（直连供应商与端侧内置条目共用） */
function rowOf(
  config: LocalModelsConfig,
  keyPresence: Record<string, boolean>,
  id: string,
  spec: LocalProviderSpec
): LocalProviderRow {
  const defaultId = providerDefaultModelId(config, id);
  const defaultModel = defaultId
    ? spec.models.find((m) => m.id === defaultId)
    : null;
  const defaultModelName = defaultModel?.displayName ?? defaultId;

  const vendor =
    spec.vendor ??
    detectVendorKey({
      vendorKey: spec.vendor,
      name: spec.displayName ?? id,
      baseUrl: spec.baseUrl,
    });

  const baseUrl = spec.baseUrl ?? '';
  const host = extractHost(baseUrl);

  return {
    id,
    name: spec.displayName ?? id,
    baseUrl,
    host,
    vendor,
    vendorKey: vendor,
    defaultModelId: defaultId,
    defaultModelName,
    modelCount: spec.models.length,
    hasKey: keyPresence[id] ?? spec.apiKeyRef !== undefined,
    isActive: config.activeModel?.providerId === id,
  };
}

export function useLocalProvidersVm(): LocalProvidersVm {
  const config = useStore(localChatStore, (s) => s.config);
  const hydrated = useStore(localChatStore, (s) => s.hydrated);
  const keyPresence = useStore(localChatStore, (s) => s.keyPresence);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!localChatStore.getState().hydrated) {
        await localChatStore.getState().hydrate();
      }
      if (cancelled) return;
      // 端侧内置条目自愈同步（O4）：列表打开时以管理器就绪真值回写
      // models[]——首次出现、外部删文件导致的校验失效都在此收敛；
      // 失败静默（配置保持原状，管理面会如实呈现管理器状态）。
      await syncOnDeviceProvider(getOnDeviceModelManager()).catch(
        () => undefined
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo<LocalProviderRow[]>(() => {
    return Object.entries(config.providers)
      .filter(([id]) => id !== ON_DEVICE_PROVIDER_ID)
      .map(([id, spec]) => rowOf(config, keyPresence, id, spec));
  }, [config, keyPresence]);

  const onDeviceRow = useMemo<LocalProviderRow | null>(() => {
    const spec = config.providers[ON_DEVICE_PROVIDER_ID];
    return spec ? rowOf(config, keyPresence, ON_DEVICE_PROVIDER_ID, spec) : null;
  }, [config, keyPresence]);

  const activeProvider = useMemo<LocalProviderRow | null>(() => {
    const activeProviderId = config.activeModel?.providerId;
    if (!activeProviderId) return null;
    return (
      rows.find((r) => r.id === activeProviderId) ??
      (onDeviceRow?.id === activeProviderId ? onDeviceRow : null)
    );
  }, [rows, onDeviceRow, config.activeModel?.providerId]);

  const activate = useCallback((providerId: string) => {
    const state = localChatStore.getState();
    const modelId = providerDefaultModelId(state.config, providerId);
    if (modelId !== null) {
      state.setActiveModel(providerId, modelId);
    }
  }, []);

  const remove = useCallback(async (providerId: string) => {
    await localChatStore.getState().deleteProvider(providerId);
  }, []);

  return {
    rows,
    onDeviceRow,
    presets: PRESET_VENDORS,
    activeProvider,
    hydrated,
    activate,
    remove,
  };
}
