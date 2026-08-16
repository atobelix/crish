/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * apps/crish-desktop/src/plugins/usePluginStore.ts
 * Crish 插件系统 Zustand 状态管理与 React Hook (DIM-06)。
 * 驱动 UI 响应式感知插件注册、激活、状态变更。
 *
 * CI Guardrail: Business Logic (Max 400 lines of effective code, UTF-8 无 BOM)
 */

import { create } from 'zustand';
import { pluginRegistry } from './PluginRegistry';
import type { CrishPlugin, PluginManifest, PluginStatus } from './types';

export interface PluginItemState {
  manifest: PluginManifest;
  status: PluginStatus;
  error?: string;
}

export interface PluginStoreState {
  plugins: Record<string, PluginItemState>;
  activePluginIds: string[];
  registerPlugin: (plugin: CrishPlugin) => void;
  unregisterPlugin: (pluginId: string) => Promise<void>;
  activatePlugin: (
    pluginId: string,
    customConfig?: Record<string, any>,
    runtime?: { isSubagent?: boolean; sessionId?: string }
  ) => Promise<void>;
  deactivatePlugin: (pluginId: string) => Promise<void>;
  togglePlugin: (pluginId: string) => Promise<void>;
  refresh: () => void;
}

function syncStateFromRegistry(): {
  plugins: Record<string, PluginItemState>;
  activePluginIds: string[];
} {
  const registrations = pluginRegistry.getAllRegistrations();
  const pluginsMap: Record<string, PluginItemState> = {};
  const activeIds: string[] = [];

  for (const reg of registrations) {
    pluginsMap[reg.plugin.manifest.id] = {
      manifest: reg.plugin.manifest,
      status: reg.status,
      error: reg.error,
    };
    if (reg.status === 'active') {
      activeIds.push(reg.plugin.manifest.id);
    }
  }

  return { plugins: pluginsMap, activePluginIds: activeIds };
}

export const usePluginStore = create<PluginStoreState>((set, get) => {
  // 注册表变更订阅
  pluginRegistry.subscribe(() => {
    set(syncStateFromRegistry());
  });

  return {
    ...syncStateFromRegistry(),

    registerPlugin: (plugin: CrishPlugin) => {
      pluginRegistry.register(plugin);
      set(syncStateFromRegistry());
    },

    unregisterPlugin: async (pluginId: string) => {
      await pluginRegistry.unregister(pluginId);
      set(syncStateFromRegistry());
    },

    activatePlugin: async (
      pluginId: string,
      customConfig?: Record<string, any>,
      runtime?: { isSubagent?: boolean; sessionId?: string }
    ) => {
      await pluginRegistry.activate(pluginId, customConfig, runtime);
      set(syncStateFromRegistry());
    },

    deactivatePlugin: async (pluginId: string) => {
      await pluginRegistry.deactivate(pluginId);
      set(syncStateFromRegistry());
    },

    togglePlugin: async (pluginId: string) => {
      const { plugins } = get();
      const current = plugins[pluginId];
      if (current?.status === 'active') {
        await get().deactivatePlugin(pluginId);
      } else {
        await get().activatePlugin(pluginId);
      }
    },

    refresh: () => {
      set(syncStateFromRegistry());
    },
  };
});
