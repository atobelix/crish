// 本地供应商配置 store（领域层）：与桌面 UnifiedModelsConfig 同构的配置面
// + 凭据引用纪律与全规格模型持久化——
// - 非密配置（供应商/全量能力模型/活动选择）以单体 JSON 存 SQLite kv（键 localchat.config，
//   经注入的 SettingsPersist，与 settingsStore 同一持久化面 SqlSettingsDao）；
// - API Key 材料只进 SecureStore（注入的 SecureStoreDriver），配置里只留
//   apiKeyRef = secure:<providerId>（桌面 dpapi:<槽> 的移动端对应形态）；
// - 纯逻辑（草稿→条目/默认模型/活动解析/健壮解码器）在 domain/pure/localChatProtocol，
//   本文件只做状态装配 + IO 编排（对齐 settingsStore 的分工纪律）；
// - 供应商删除时执行级联清理：SecureStore 密钥注销、全局 activeModel 清空、
//   并在 localChatSessionStore 线程表中清理悬挂引用（自愈回退为全局活动模型）。
import { createStore, type StoreApi } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';
import {
  apiKeyRefFor,
  apiKeySlotFor,
  decodeLocalModelsConfig,
} from '../pure/localChatProtocol';
import {
  emptyLocalModelsConfig,
  type LocalModelsConfig,
  type LocalProviderSpec,
} from '../types/localChat';
import type { SettingsPersist } from './settingsStore';
import type { SecureStoreDriver } from '@/db/secureStore';
import { localChatSessionStore } from './localChatSessionStore';

/** 配置 kv 键（本机偏好命名空间，与 settings.* 分开：这是功能配置非偏好组） */
export const LOCAL_CHAT_CONFIG_KEY = 'localchat.config';

/** 纯函数解码器重导出（兼容从 localChatStore 导入的历史测试与调用方） */
export { decodeLocalModelsConfig };

export interface LocalChatState {
  /** 本地模型配置（同构桌面 UnifiedModelsConfig，包含全规格模型与供应商属性） */
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
  /** 删除供应商（连带清理 SecureStore 密钥、全局 activeModel 与线程表悬挂指针） */
  deleteProvider: (providerId: string) => Promise<void>;
  /** 设活动模型（二元身份；与桌面 setActiveModel 同语义） */
  setActiveModel: (providerId: string, modelId: string) => void;
  /** 更新供应商连通性延迟（实测延迟即刻落盘，null 代表测速失败） */
  updateProviderLatency: (providerId: string, latencyMs: number | null) => void;
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

          // 默认模型纪律（L3）：config.activeModel 是唯一真源，upsert
          // 永不替用户落位、永不回退替换——
          // - 活动为空时保持为空：默认由用户在「默认模型」页显式选定，
          //   写任何供应商（含本机条目同步）都不自动选；
          // - 本供应商正是活动供应商、而活动模型被本次写入删除或禁用
          //   时，活动选择只清空为未设置：不回退同供应商的建议项，
          //   更不跨供应商改投（失效原因在默认模型页明示）。
          if (
            state.config.activeModel?.providerId === providerId &&
            !withRef.models.some(
              (m) =>
                m.id === state.config.activeModel?.modelId &&
                m.enabled !== false
            )
          ) {
            state.config.activeModel = null;
          }
        });

        // 一致性自愈：若既有线程引用了该供应商中已被移除或禁用的模型，解除固化绑定退回跟随全局
        try {
          const sessionState = localChatSessionStore.getState();
          const danglingThreads = sessionState.threads.filter(
            (t) =>
              t.modelRef?.providerId === providerId &&
              !withRef.models.some(
                (m) => m.id === t.modelRef?.modelId && m.enabled !== false
              )
          );
          for (const thread of danglingThreads) {
            sessionState.setThreadModel(thread.id, null);
          }
        } catch {
          // 容错吸收（独立测试或无 sessionStore 环境不影响主配置流程）
        }

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

        // 一致性自愈：在线程表中清理该供应商引用，自愈退回跟随全局活动模型，根除悬挂指针
        try {
          const sessionState = localChatSessionStore.getState();
          const danglingThreads = sessionState.threads.filter(
            (t) => t.modelRef?.providerId === providerId
          );
          for (const thread of danglingThreads) {
            sessionState.setThreadModel(thread.id, null);
          }
        } catch {
          // 容错吸收
        }

        writeConfig(get().config);
      },

      setActiveModel: (providerId, modelId) => {
        set((state) => {
          state.config.activeModel = { providerId, modelId };
        });
        writeConfig(get().config);
      },

      updateProviderLatency: (providerId, latencyMs) => {
        const p = get().config.providers[providerId];
        if (!p) return;
        set((state) => {
          const target = state.config.providers[providerId];
          if (!target) return;
          target.latencyMs = latencyMs;
          target.latencyUpdatedAt = Date.now();
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
