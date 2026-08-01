import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { persist, createJSONStorage } from "zustand/middleware";
import type { ProviderConfig, ModelMeta, ModelRoute, Account, HealthStatus } from "./types";
import { migrateFromV1 } from "./migration";
import { refreshAccountStatus as fetchAccountStatus } from "../../api/accountStatusApi";

function mapReviver(_key: string, value: unknown): unknown {
  if (_key === 'providers' && value && typeof value === 'object' && !(value instanceof Map)) {
    return new Map(Object.entries(value as Record<string, unknown>));
  }
  if (_key === 'healthStatus' && value && typeof value === 'object' && !(value instanceof Map)) {
    return new Map(Object.entries(value as Record<string, unknown>));
  }
  return value;
}

function mapReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(value);
  }
  return value;
}

interface ProviderStoreState {
  providers: Map<string, ProviderConfig>;
  activeProviderId: string | null;
  addProvider: (config: ProviderConfig) => void;
  updateProvider: (id: string, patch: Partial<ProviderConfig>) => void;
  removeProvider: (id: string) => void;
  setActiveProvider: (id: string | null) => void;

  addModel: (providerId: string, model: ModelMeta) => void;
  updateModel: (providerId: string, modelId: string, patch: Partial<ModelMeta>) => void;
  removeModel: (providerId: string, modelId: string) => void;

  routes: ModelRoute[];
  addRoute: (route: ModelRoute) => void;
  updateRoute: (id: string, patch: Partial<ModelRoute>) => void;
  removeRoute: (id: string) => void;

  accounts: Account[];
  addAccount: (account: Account) => void;
  updateAccount: (id: string, patch: Partial<Account>) => void;
  removeAccount: (id: string) => void;
  refreshAccountStatus: (id: string) => Promise<void>;
  refreshAllAccounts: () => Promise<void>;

  healthStatus: Map<string, HealthStatus>;
  setHealthStatus: (providerId: string, status: HealthStatus) => void;
}

export const useProviderStore = create<ProviderStoreState>()(
  persist(
    immer((set, get) => ({
      providers: new Map(),
      activeProviderId: null,

      addProvider: (config) => set((state) => { state.providers.set(config.id, config); }),
      updateProvider: (id, patch) => set((state) => {
        const p = state.providers.get(id);
        if (p) state.providers.set(id, { ...p, ...patch, updatedAt: new Date().toISOString() });
      }),
      removeProvider: (id) => set((state) => {
        state.providers.delete(id);
        if (state.activeProviderId === id) state.activeProviderId = null;
      }),
      setActiveProvider: (id) => set((state) => { state.activeProviderId = id; }),

      addModel: (providerId, model) => set((state) => {
        const p = state.providers.get(providerId);
        if (p) p.models.push(model);
      }),
      updateModel: (providerId, modelId, patch) => set((state) => {
        const p = state.providers.get(providerId);
        if (p) { const m = p.models.find(m => m.id === modelId); if (m) Object.assign(m, patch); }
      }),
      removeModel: (providerId, modelId) => set((state) => {
        const p = state.providers.get(providerId);
        if (p) p.models = p.models.filter(m => m.id !== modelId);
      }),

      routes: [],
      addRoute: (route) => set((state) => { state.routes.push(route); }),
      updateRoute: (id, patch) => set((state) => {
        const r = state.routes.find(r => r.id === id);
        if (r) Object.assign(r, patch);
      }),
      removeRoute: (id) => set((state) => { state.routes = state.routes.filter(r => r.id !== id); }),

      accounts: [],
      addAccount: (account) => set((state) => { state.accounts.push(account); }),
      updateAccount: (id, patch) => set((state) => {
        const a = state.accounts.find(a => a.id === id);
        if (a) Object.assign(a, patch);
      }),
      removeAccount: (id) => set((state) => { state.accounts = state.accounts.filter(a => a.id !== id); }),

      refreshAccountStatus: async (id) => {
        set((state) => {
          const a = state.accounts.find(a => a.id === id);
          if (!a) return;
          a.lastCheckedAt = Date.now();
        });
        try {
          // T06.9.2：网络调用收口到 api 层（accountStatusApi，transport 优先），store 不再直连 fetch
          const data = await fetchAccountStatus(id);
          set((state) => {
            const a = state.accounts.find(a => a.id === id);
            if (!a) return;
            if (data.status) a.status = data.status;
            if (data.expiresAt != null) a.expiresAt = data.expiresAt;
            if (data.cooldownUntil != null) a.cooldownUntil = data.cooldownUntil;
            if (data.usageScore != null) a.usageScore = data.usageScore;
          });
        } catch {
          set((state) => {
            const a = state.accounts.find(a => a.id === id);
            if (!a) return;
            a.status = 'error';
          });
        }
      },

      refreshAllAccounts: async () => {
        const ids = get().accounts.map(a => a.id);
        await Promise.all(ids.map(id => get().refreshAccountStatus(id)));
      },

      healthStatus: new Map(),
      setHealthStatus: (providerId, status) => set((state) => { state.healthStatus.set(providerId, status); }),
    })),
    {
      name: "crish_provider_store_v2",
      storage: createJSONStorage(() => localStorage, {
        reviver: mapReviver,
        replacer: mapReplacer,
      }),
      partialize: (state) => ({
        providers: state.providers,
        routes: state.routes,
        accounts: state.accounts,
      }),
      onRehydrateStorage: () => (state, error) => {
        if (error || !state) return;
        try {
          const v1Raw = localStorage.getItem("crish_provider_profiles_v1");
          if (v1Raw) {
            const migrated = migrateFromV1();
            if (migrated.length > 0) {
              migrated.forEach((config) => state.addProvider(config));
            }
            localStorage.removeItem("crish_provider_profiles_v1");
          }
        } catch {
          /* ignore migration errors */
        }
      },
    }
  )
);
