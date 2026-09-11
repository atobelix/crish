/**
 * 插件注册表状态适配（E3 UI 泛化：ExtensionCard/useExtensionMarket 展示 kind: 'plugin'）。
 *
 * v1 数据源：内置官方插件（@crish/plugin-import-claude-codex manifest）+ localStorage 启停状态。
 * E2 插件运行时（apps/crish-desktop/src/api/pluginRuntime.ts）落地后，
 * listPluginCardStates 改为消费注册表状态（本文件为「注册表状态 → UI 卡片」纯映射，
 * 不直接依赖 E2 文件域；注册表接入点见 PLUGIN_RUNTIME_HOOK 注释）。
 */

import {
  manifest as importPluginManifest,
  type ImportPluginManifest,
} from '@crish/plugin-import-claude-codex';

/** 插件卡片展示形态（settings-extensions 域内类型，映射自 manifest）。 */
export type PluginCardState = {
  id: string;
  kind: 'plugin';
  source: 'official';
  name: string;
  version: string;
  description: string;
  declaredTools: string[];
  declaredHooks: string[];
  trustLevel: string;
  enabled: boolean;
  fromSystem: boolean;
  installRef: string;
};

import {
  readPluginEnabledIds,
  writePluginEnabledIds,
} from '../../api/cache/runtimeCache';

function loadEnabledIds(): Set<string> {
  return readPluginEnabledIds();
}

function saveEnabledIds(ids: Set<string>): void {
  writePluginEnabledIds(ids);
}

/** 插件当前是否启用（localStorage 启停状态；默认启用——官方内置）。 */
function isPluginEnabled(id: string): boolean {
  const s = loadEnabledIds();
  // 官方内置插件默认启用：不在停用清单即视为启用
  return !s.has(id);
}

/** 切换插件启用状态（v1 只持久化停用清单；E2 运行时接入后同步注册表）。 */
export function setPluginEnabled(id: string, enabled: boolean): void {
  const s = loadEnabledIds();
  if (enabled) s.delete(id);
  else s.add(id);
  saveEnabledIds(s);
}

/** manifest → 卡片状态。 */
function manifestToCardState(m: ImportPluginManifest): PluginCardState {
  return {
    id: m.id,
    kind: 'plugin',
    source: 'official',
    name: m.name,
    version: m.version,
    description: m.description ?? '',
    declaredTools: [...m.declaredTools],
    declaredHooks: [...m.declaredHooks],
    trustLevel: m.trustLevel,
    enabled: isPluginEnabled(m.id),
    fromSystem: true,
    installRef: m.id,
  };
}

/**
 * 插件注册表视图（v1 = 内置官方插件清单）。
 *
 * PLUGIN_RUNTIME_HOOK（E2 接线点）：插件运行时落地后，改为：
 *   const runtime = await import('../../api/pluginRuntime');
 *   return runtime.listPluginStates().map(stateToCardState);
 * 保持返回 PluginCardState[] 不变，UI 侧无需改动。
 */
export function listPluginCardStates(): PluginCardState[] {
  return [manifestToCardState(importPluginManifest)];
}
