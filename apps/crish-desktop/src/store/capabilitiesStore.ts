import { create } from 'zustand';
import {
  getCachedCapabilities,
  refreshCapabilities,
  refreshProductCapabilities,
  resetCapabilitiesCache,
} from '../api/capabilitiesStore';

export type CapabilityState = 'unsupported' | 'experimental' | 'available';

type CapabilitiesSlice = {
  capabilities: Record<string, CapabilityState>;
  cachedAt: number | null;
};

type CapabilitiesActions = {
  refresh: (force?: boolean) => Promise<void>;
  reset: () => void;
};

type CapabilitiesStore = CapabilitiesSlice & CapabilitiesActions;

function extractCapabilities(raw: unknown): Record<string, CapabilityState> {
  if (!raw || typeof raw !== 'object') return {};
  const snapshot = (raw as Record<string, unknown>).snapshot as
    | Record<string, unknown>
    | undefined;
  const caps = Array.isArray(snapshot?.capabilities)
    ? (snapshot!.capabilities as Record<string, unknown>[])
    : Array.isArray((raw as Record<string, unknown>).capabilities)
      ? ((raw as Record<string, unknown>).capabilities as Record<string, unknown>[])
      : [];
  const map: Record<string, CapabilityState> = {};
  for (const c of caps) {
    const id = typeof c.id === 'string' ? c.id : '';
    if (!id) continue;
    const state = String(c.state ?? '').toLowerCase().trim();
    if (state === 'unsupported' || state === 'experimental' || state === 'available') {
      map[id] = state;
    } else if (state && state !== 'unknown') {
      map[id] = 'unsupported';
    }
  }
  return map;
}

const _initialSlice: CapabilitiesSlice = {
  capabilities: {},
  cachedAt: null,
};

export const useCapabilitiesStore = create<CapabilitiesStore>((set) => ({
  ..._initialSlice,

  refresh: async (force = false) => {
    await refreshCapabilities(force);
    const cached = getCachedCapabilities();
    if (cached) {
      set({
        capabilities: extractCapabilities(cached.raw ?? cached.probe),
        cachedAt: cached.at,
      });
    }
  },

  reset: () => {
    resetCapabilitiesCache();
    set(_initialSlice);
  },
}));

export function useCapability(key: string): CapabilityState {
  const caps = useCapabilitiesStore((s) => s.capabilities);
  return caps[key] ?? 'unsupported';
}

export function useCapabilities(): Record<string, CapabilityState> {
  return useCapabilitiesStore((s) => s.capabilities);
}

export function getCapabilityState(key: string): CapabilityState {
  const cached = getCachedCapabilities();
  if (!cached) return 'unsupported';
  const caps = extractCapabilities(cached.raw ?? cached.probe);
  return caps[key] ?? 'unsupported';
}

export {
  refreshCapabilities,
  refreshProductCapabilities,
  getCachedCapabilities,
  resetCapabilitiesCache,
};
