/**
 * 扩展导入与卸载动作。
 * MCP 写入全局设置；技能卸载只删除本应用复制的副本，不删外部软件里的原件。
 */

import { clientApi, type McpServer, type Settings } from '../../api/clientApi';
import { t } from '../../i18n';
import {
  getExtraSkillDirs,
  removeExtraSkillDir,
  removePathAny,
  setSkillActivation,
} from '../../api/skillsApi';
import type { DesktopSkill } from '../../api/skillsApi';
import { commitUserMcpRoster, useSettingsStore } from '../../store/storeAccess';
import { resolveMcpTools } from './knownMcpTools';
import type { DetectedExternalMcpServer } from './detectExternalMcpServers';
import type { InstalledExtension } from '../../api/extensionCatalog';
import { setOfficialPluginUninstalled } from '../../api/extensionCatalog';
import {
  CANONICAL_IMPORT_PLUGIN_ID,
  isImportClaudeCodexPlugin,
} from './extensionIdentity';
import { setPluginEnabled } from '../settings-extensions/pluginRegistryAdapter';
import { removeCustomPlugin } from './customPluginStorage';
import type { UnifiedExtensionItem } from './buildUnifiedItems';
import {
  isSkillDismissed,
  notifyExtensionLifecycle,
  setSkillDismissed,
} from './skillDismissState';
import { normalizeSlashName } from '../../api/skillsApiHelpers';

export interface ExtensionActionResult {
  ok: boolean;
  message: string;
}

function mcpKey(name: string): string {
  return name.trim().toLowerCase();
}

async function persistMcpServers(list: McpServer[]): Promise<McpServer[]> {
  const saved = await clientApi.saveSettingsEx('__global__', 'global', {
    mcpServers: list,
  } as unknown as Partial<Settings>);
  const persisted = Array.isArray(saved.mcpServers) ? saved.mcpServers : list;
  commitUserMcpRoster(persisted);
  return persisted;
}

export async function importDetectedMcpServer(
  mcp: DetectedExternalMcpServer
): Promise<ExtensionActionResult> {
  const current = useSettingsStore.getState().mcpServers || [];
  const resolvedTools = resolveMcpTools(mcp.name, mcp.command, mcp.args);
  const newServer: McpServer = {
    id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: mcp.name,
    type: mcp.type || 'stdio',
    ...(mcp.command ? { command: mcp.command, args: mcp.args } : {}),
    ...(mcp.url ? { url: mcp.url } : {}),
    ...(mcp.env ? { env: mcp.env } : {}),
    status: 'connected',
    tools: resolvedTools.length > 0 ? resolvedTools : ['default_tool'],
  };
  const updated = [
    ...current.filter(
      (server) =>
        mcpKey(server.name) !== mcpKey(newServer.name) &&
        server.id !== newServer.id
    ),
    newServer,
  ];
  commitUserMcpRoster(updated);
  try {
    const persisted = await persistMcpServers(updated);
    const kept = persisted.some(
      (server) => mcpKey(server.name) === mcpKey(newServer.name)
    );
    if (!kept) {
      commitUserMcpRoster(current);
      return {
        ok: false,
        message: t('extensions.mcp.importNoWrite', { name: mcp.name }),
      };
    }
    notifyExtensionLifecycle();
    return {
      ok: true,
      message: t('extensions.mcp.imported', { name: mcp.name }),
    };
  } catch (err) {
    commitUserMcpRoster(current);
    return {
      ok: false,
      message: t('extensions.mcp.importFailed', {
        detail: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

export async function removeImportedMcpByName(
  name: string
): Promise<ExtensionActionResult> {
  const current = useSettingsStore.getState().mcpServers || [];
  const key = mcpKey(name);
  const next = current.filter((server) => mcpKey(server.name) !== key);
  if (next.length === current.length) {
    return { ok: false, message: t('extensions.mcp.notFound', { name }) };
  }
  try {
    commitUserMcpRoster(next);
    await persistMcpServers(next);
    notifyExtensionLifecycle();
    return { ok: true, message: t('extensions.mcp.uninstalled', { name }) };
  } catch (err) {
    commitUserMcpRoster(current);
    return {
      ok: false,
      message: t('extensions.mcp.uninstallFailed', {
        detail: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

/** 只允许删除本应用复制进 .conex/skills 或 .crish/skills 的副本。 */
export function isOwnedSkillCopyPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  return (
    normalized.includes('/.conex/skills/') ||
    normalized.includes('/.crish/skills/') ||
    normalized.endsWith('/.conex/skills') ||
    normalized.endsWith('/.crish/skills')
  );
}

export function skillMatchesInstalledSet(
  name: string,
  installed: Set<string>
): boolean {
  if (isSkillDismissed(name)) return false;
  const lower = name.trim().toLowerCase();
  const slug = normalizeSlashName(name);
  return installed.has(lower) || Boolean(slug && installed.has(slug));
}

export async function uninstallDesktopSkill(skill: {
  id?: string;
  name: string;
  filePath?: string;
  baseDir?: string;
  description?: string;
  scope?: DesktopSkill['scope'];
}): Promise<ExtensionActionResult> {
  const name = skill.name?.trim();
  if (!name) return { ok: false, message: t('extensions.skill.nameEmpty') };

  const dir = (skill.baseDir || '').trim();
  const file = (skill.filePath || '').trim();
  let removedCopy = false;
  if (dir && isOwnedSkillCopyPath(dir)) {
    removedCopy = await removePathAny(dir, true);
  } else if (file && isOwnedSkillCopyPath(file)) {
    const parent = file.replace(/[\\/][^\\/]+$/, '');
    removedCopy =
      parent && isOwnedSkillCopyPath(parent)
        ? await removePathAny(parent, true)
        : await removePathAny(file, false);
  }

  if (dir) {
    const norm = dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    for (const extra of getExtraSkillDirs()) {
      const extraNorm = extra
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase();
      if (extraNorm === norm || norm.startsWith(`${extraNorm}/`)) {
        removeExtraSkillDir(extra);
      }
    }
  }

  setSkillDismissed(name, true);
  const record: DesktopSkill = {
    id: skill.id || name,
    name,
    description: skill.description || '',
    filePath: file,
    baseDir: dir,
    content: '',
    raw: '',
    scope: skill.scope || 'project',
    activation: 'disabled',
    tags: [],
    appliesTo: [],
    disableModelInvocation: false,
    system: false,
  };
  await setSkillActivation(record, 'disabled');
  notifyExtensionLifecycle();
  window.dispatchEvent(new CustomEvent('crish-skills-changed'));
  return {
    ok: true,
    message: removedCopy
      ? t('extensions.skill.uninstalledDeleted', { name })
      : t('extensions.skill.uninstalled', { name }),
  };
}

export async function uninstallUnifiedExtension(
  item: UnifiedExtensionItem,
  removePackage: (installed: InstalledExtension) => void | Promise<void>
): Promise<ExtensionActionResult> {
  if (item.kind === 'mcp') {
    return removeImportedMcpByName(item.name);
  }
  if (item.rawSkill || item.kind === 'skill') {
    return uninstallDesktopSkill({
      id: item.rawSkill?.id || item.id,
      name: item.name,
      filePath: item.rawSkill?.filePath,
      baseDir: item.rawSkill?.baseDir,
      description: item.rawSkill?.description || item.description,
      scope: item.rawSkill?.scope,
    });
  }
  if (isImportClaudeCodexPlugin(item)) {
    setOfficialPluginUninstalled(CANONICAL_IMPORT_PLUGIN_ID, true);
    setPluginEnabled(CANONICAL_IMPORT_PLUGIN_ID, false);
    notifyExtensionLifecycle();
    return {
      ok: true,
      message: t('extensions.plugin.uninstalled', { name: item.name }),
    };
  }
  if (item.id.startsWith('custom-plugin:')) {
    removeCustomPlugin(item.id.replace('custom-plugin:', ''));
    notifyExtensionLifecycle();
    return {
      ok: true,
      message: t('extensions.plugin.deleted', { name: item.name }),
    };
  }
  if (item.installedItem) {
    await removePackage(item.installedItem);
    notifyExtensionLifecycle();
    return {
      ok: true,
      message: t('extensions.generic.uninstalled', { name: item.name }),
    };
  }
  return {
    ok: false,
    message: t('extensions.generic.noInstallRecord', { name: item.name }),
  };
}

export async function uninstallInstalledRecord(
  item: InstalledExtension,
  removePackage: (installed: InstalledExtension) => void | Promise<void>
): Promise<ExtensionActionResult> {
  if (isImportClaudeCodexPlugin(item)) {
    setOfficialPluginUninstalled(CANONICAL_IMPORT_PLUGIN_ID, true);
    setPluginEnabled(CANONICAL_IMPORT_PLUGIN_ID, false);
    notifyExtensionLifecycle();
    return {
      ok: true,
      message: t('extensions.plugin.uninstalled', { name: item.name }),
    };
  }
  if (item.kind === 'skill') {
    return uninstallDesktopSkill({
      id: item.id,
      name: item.name,
      filePath: item.skillPath,
      description: item.description,
    });
  }
  if (item.kind === 'mcp') {
    return removeImportedMcpByName(item.name);
  }
  await removePackage(item);
  notifyExtensionLifecycle();
  return {
    ok: true,
    message: t('extensions.generic.uninstalled', { name: item.name }),
  };
}
