// 本地供应商配置 store（领域层）：与桌面 UnifiedModelsConfig 同构的配置面
// + 凭据引用纪律——
// - 非密配置（供应商/模型/活动选择）以 JSON 存 kv（键 localchat.config，
//   经注入的 SettingsPersist，与 settingsStore 同一持久化面 SqlSettingsDao）；
// - API Key 材料只进 SecureStore（注入的 SecureStoreDriver），配置里只留
//   apiKeyRef = secure:<providerId>（桌面 dpapi:<槽> 的移动端对应形态）；
// - 纯逻辑（草稿→条目/默认模型/活动解析）在 domain/pure/localChatProtocol，
//   本文件只做状态装配 + IO 编排（对齐 settingsStore 的分工纪律）。
import { createStore, type StoreApi } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';
import {
  apiKeyRefFor,
  apiKeySlotFor,
  providerDefaultModelId,
} from '../pure/localChatProtocol';
import {
  emptyLocalModelsConfig,
  type LocalModelsConfig,
  type LocalProviderSpec,
} from '../types/localChat';
import type { SettingsPersist } from './settingsStore';
import type { SecureStoreDriver } from '@/db/secureStore';

/** 配置 kv 键（本机偏好命名空间，与 settings.* 分开：这是功能配置非偏好组） */
export const LOCAL_CHAT_CONFIG_KEY = 'localchat.config';

export interface LocalChatState {
  /** 本地模型配置（同构桌面 UnifiedModelsConfig） */
  config: LocalModelsConfig;
  /** 水合完成标志（kv 回填前 UI 显示空态即可，不阻塞） */
  hydrated: boolean;
  /** 供应商是否有已存密钥（providerId → bool；密钥材料本身不进状态） */
  keyPresence: Record<string, boolean>;

  /** 启动水合：读 kv 配置 + 逐供应商探 SecureStore 密钥存在性 */
  hydrate: (
    persist?: SettingsPersist,
    secure?: SecureStoreDriver
  ) => Promise<void>;
  /** 新增/整条替换供应商（apiKey：undefined=不触碰密钥，null=清除，非空=写入） */
  upsertProvider: (
    providerId: string,
    spec: LocalProviderSpec,
    apiKey?: string | null
  ) => Promise<void>;
  /** 删除供应商（连带清除其 SecureStore 密钥与失效的活动选择） */
  deleteProvider: (providerId: string) => Promise<void>;
  /** 设活动模型（二元身份；与桌面 setActiveModel 同语义） */
  setActiveModel: (providerId: string, modelId: string) => void;
  /** 读某供应商的密钥材料（仅发送瞬间由 client 层调用，不进 UI 状态） */
  readApiKey: (providerId: string) => Promise<string | null>;
}

/** 默认持久化注入（接线层 configureSqlitePersistence 时一并注入；测试按参数优先） */
let defaultPersist: SettingsPersist | null = null;
let defaultSecure: SecureStoreDriver | null = null;

export function configureLocalChatPersistence(
  persist: SettingsPersist | null
): void {
  defaultPersist = persist;
}

export function configureLocalChatSecure(
  secure: SecureStoreDriver | null
): void {
  defaultSecure = secure;
}

function persistOf(persist?: SettingsPersist): SettingsPersist | null {
  return persist ?? defaultPersist;
}

function secureOf(secure?: SecureStoreDriver): SecureStoreDriver | null {
  return secure ?? defaultSecure;
}

/** 配置写 kv（失败静默：本机配置尽力持久化，内存态已生效；同 settingsStore 口径） */
function writeConfig(
  config: LocalModelsConfig,
  persist?: SettingsPersist
): void {
  const p = persistOf(persist);
  if (!p) return;
  void p.set(LOCAL_CHAT_CONFIG_KEY, JSON.stringify(config)).catch(() => {
    // 写入失败静默（不阻断交互）
  });
}

/** 配置解码（非法 JSON / 形态不对 → 空配置，不猜测修复） */
export function decodeLocalModelsConfig(raw: string | null): LocalModelsConfig {
  if (raw === null) return emptyLocalModelsConfig();
  try {
    const parsed = JSON.parse(raw) as Partial<LocalModelsConfig>;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof parsed.providers !== 'object' ||
      parsed.providers === null
    ) {
      return emptyLocalModelsConfig();
    }
    const providers: Record<string, LocalProviderSpec> = {};
    for (const [id, spec] of Object.entries(parsed.providers)) {
      if (spec === null || typeof spec !== 'object') continue;
      const s = spec as LocalProviderSpec;
      providers[id] = {
        ...s,
        protocol: 'openai/chat',
        models: Array.isArray(s.models)
          ? s.models.filter(
              (m) =>
                m !== null && typeof m === 'object' && typeof m.id === 'string'
            )
          : [],
      };
    }
    const active =
      parsed.activeModel !== null &&
      typeof parsed.activeModel === 'object' &&
      typeof parsed.activeModel.providerId === 'string' &&
      typeof parsed.activeModel.modelId === 'string' &&
      providers[parsed.activeModel.providerId] !== undefined
        ? parsed.activeModel
        : null;
    return { version: 2, providers, activeModel: active };
  } catch {
    return emptyLocalModelsConfig();
  }
}

export const localChatStore: StoreApi<LocalChatState> =
  createStore<LocalChatState>()(
    immer((set, get) => ({
      config: emptyLocalModelsConfig(),
      hydrated: false,
      keyPresence: {},

      hydrate: async (persist, secure) => {
        const p = persistOf(persist);
        let config = emptyLocalModelsConfig();
        if (p) {
          try {
            config = decodeLocalModelsConfig(
              await p.get(LOCAL_CHAT_CONFIG_KEY)
            );
          } catch {
            config = emptyLocalModelsConfig();
          }
        }
        const s = secureOf(secure);
        const keyPresence: Record<string, boolean> = {};
        if (s) {
          await Promise.all(
            Object.keys(config.providers).map(async (id) => {
              try {
                keyPresence[id] = (await s.getItem(apiKeySlotFor(id))) !== null;
              } catch {
                keyPresence[id] = false;
              }
            })
          );
        }
        set((state) => {
          state.config = config;
          state.keyPresence = keyPresence;
          state.hydrated = true;
        });
      },

      upsertProvider: async (providerId, spec, apiKey) => {
        const s = secureOf();
        const withRef: LocalProviderSpec = { ...spec };
        if (apiKey !== undefined && s) {
          if (apiKey === null || apiKey.trim() === '') {
            await s.deleteItem(apiKeySlotFor(providerId));
            delete withRef.apiKeyRef;
          } else {
            await s.setItem(apiKeySlotFor(providerId), apiKey.trim());
            withRef.apiKeyRef = apiKeyRefFor(providerId);
          }
        } else if (
          get().config.providers[providerId]?.apiKeyRef !== undefined
        ) {
          withRef.apiKeyRef = get().config.providers[providerId]?.apiKeyRef;
        }
        set((state) => {
          state.config.providers[providerId] = withRef;
          state.keyPresence[providerId] =
            withRef.apiKeyRef !== undefined
              ? true
              : (state.keyPresence[providerId] ?? false);
          if (apiKey === null || apiKey === '') {
            state.keyPresence[providerId] = false;
          }
          // 首个供应商自动成为活动选择（桌面归一：活动为空且有可用模型时
          // 不自动选——此处仅在「全局尚无活动选择」时以首个模型落位，
          // 属于移动端本地的显式产品口径：减少用户一步操作，UI 可随时改选）
          if (state.config.activeModel === null) {
            const modelId = providerDefaultModelId(state.config, providerId);
            if (modelId !== null) {
              state.config.activeModel = { providerId, modelId };
            }
          }
        });
        writeConfig(get().config);
      },

      deleteProvider: async (providerId) => {
        const s = secureOf();
        if (s) {
          try {
            await s.deleteItem(apiKeySlotFor(providerId));
          } catch {
            // 删除密钥失败不阻断配置删除（槽位残留无引用即不可达）
          }
        }
        set((state) => {
          delete state.config.providers[providerId];
          delete state.keyPresence[providerId];
          if (state.config.activeModel?.providerId === providerId) {
            state.config.activeModel = null;
          }
        });
        writeConfig(get().config);
      },

      setActiveModel: (providerId, modelId) => {
        set((state) => {
          state.config.activeModel = { providerId, modelId };
        });
        writeConfig(get().config);
      },

      readApiKey: async (providerId) => {
        const s = secureOf();
        if (!s) return null;
        try {
          return await s.getItem(apiKeySlotFor(providerId));
        } catch {
          return null;
        }
      },
    }))
  );
