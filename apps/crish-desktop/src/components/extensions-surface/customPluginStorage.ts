/**
 * apps/crish-desktop/src/components/extensions-surface/customPluginStorage.ts
 *
 * 用户自定义插件持久化存储与分享 Payload 规范解析器
 * 基于 localStorage `crish_custom_plugins_v1` 进行容错读写与跨组件广播
 */

export interface CustomPluginItem {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  type: 'custom' | 'tool' | 'view';
  tags?: string[];
  config?: Record<string, unknown>;
  createdAt: number;
}

export const CUSTOM_PLUGINS_STORAGE_KEY = 'crish_custom_plugins_v1';

/**
 * 从 localStorage 读取所有自定义插件并进行容错解析
 */
export function loadCustomPlugins(): CustomPluginItem[] {
  try {
    const raw = localStorage.getItem(CUSTOM_PLUGINS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((item): item is CustomPluginItem =>
      Boolean(
        item &&
        typeof item === 'object' &&
        typeof item.id === 'string' &&
        item.id.trim() !== '' &&
        typeof item.name === 'string' &&
        item.name.trim() !== ''
      )
    );
  } catch (err) {
    console.warn(
      '[customPluginStorage] 无法解析自定义插件缓存，已回退为空列表:',
      err
    );
    return [];
  }
}

/**
 * 保存单个自定义插件（若已存在相同 id 则就地更新，否则在首部新增）
 */
export function saveCustomPlugin(item: CustomPluginItem): void {
  try {
    const current = loadCustomPlugins();
    const index = current.findIndex((p) => p.id === item.id);
    let updated: CustomPluginItem[];

    if (index >= 0) {
      updated = [...current];
      updated[index] = { ...current[index], ...item };
    } else {
      updated = [item, ...current];
    }

    localStorage.setItem(CUSTOM_PLUGINS_STORAGE_KEY, JSON.stringify(updated));
    if (
      typeof window !== 'undefined' &&
      typeof window.dispatchEvent === 'function'
    ) {
      window.dispatchEvent(
        new CustomEvent('crish:custom-plugins-changed', {
          detail: { updated, item },
        })
      );
    }
  } catch (err) {
    console.error('[customPluginStorage] 保存自定义插件失败:', err);
  }
}

/**
 * 根据 ID 移除自定义插件
 */
export function removeCustomPlugin(id: string): void {
  try {
    const current = loadCustomPlugins();
    const updated = current.filter((p) => p.id !== id);
    localStorage.setItem(CUSTOM_PLUGINS_STORAGE_KEY, JSON.stringify(updated));
    if (
      typeof window !== 'undefined' &&
      typeof window.dispatchEvent === 'function'
    ) {
      window.dispatchEvent(
        new CustomEvent('crish:custom-plugins-changed', {
          detail: { updated, removedId: id },
        })
      );
    }
  } catch (err) {
    console.error('[customPluginStorage] 移除自定义插件失败:', err);
  }
}

/**
 * 生成标准 JSON 格式的插件定义字符串，便于对外分享与导出
 */
export function generatePluginSharePayload(
  plugin:
    | CustomPluginItem
    | { id: string; name: string; description: string; version?: string }
): string {
  const isCustom = 'createdAt' in plugin;
  const custom = isCustom ? (plugin as CustomPluginItem) : null;

  const payload = {
    $schema: 'https://crish.dev/schemas/plugin.v1.json',
    id: plugin.id,
    name: plugin.name,
    version: plugin.version || '1.0.0',
    description: plugin.description || '',
    type: custom?.type || 'custom',
    author: custom?.author || 'Crish User',
    tags: custom?.tags || ['custom', 'extension'],
    config: custom?.config || {},
    exportedAt: new Date().toISOString(),
  };

  return JSON.stringify(payload, null, 2);
}

/**
 * 容错校验并解析导入的分享配置文本
 */
export function parsePluginSharePayload(
  raw: string
): Partial<CustomPluginItem> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const data = JSON.parse(trimmed);
    if (!data || typeof data !== 'object') return null;

    const name = String(data.name || data.id || '').trim();
    if (!name) return null;

    const id = String(
      data.id || name.toLowerCase().replace(/[^a-z0-9_-]/g, '-')
    ).trim();
    const version = String(data.version || '1.0.0').trim();
    const description = String(data.description || '').trim();
    const type =
      data.type === 'tool' || data.type === 'view' ? data.type : 'custom';
    const author = data.author ? String(data.author).trim() : undefined;
    const tags = Array.isArray(data.tags) ? data.tags.map(String) : undefined;
    const config =
      data.config && typeof data.config === 'object'
        ? (data.config as Record<string, unknown>)
        : undefined;

    return {
      id,
      name,
      version,
      description,
      type,
      author,
      tags,
      config,
    };
  } catch {
    return null;
  }
}

/**
 * 解析用户手动输入的插件定义：支持 JSON 规格、本地路径与 npm 包名
 */
export function parseManualPluginInput(raw: string): CustomPluginItem | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // 1. 尝试作为 JSON 规格解析
  const parsed = parsePluginSharePayload(trimmed);
  if (parsed && parsed.name && parsed.id) {
    return {
      id: parsed.id,
      name: parsed.name,
      version: parsed.version || '1.0.0',
      description: parsed.description || '从规格导入的插件',
      author: parsed.author,
      type: parsed.type || 'custom',
      tags: parsed.tags || ['imported'],
      config: parsed.config,
      createdAt: Date.now(),
    };
  }

  // 2. 作为本地路径或 npm 包名解析
  const normalized = trimmed.replace(/[\\/]+$/, '');
  const segments = normalized.split(/[\\/]/);
  const lastPart = segments[segments.length - 1] || trimmed;
  const cleanId =
    lastPart.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase() ||
    `plugin-${Date.now()}`;
  const isPath =
    trimmed.startsWith('.') || trimmed.includes('/') || trimmed.includes('\\');

  return {
    id: cleanId,
    name: lastPart || '外部扩展插件',
    version: '1.0.0',
    description: isPath ? `本地扩展路径：${trimmed}` : `npm 扩展包：${trimmed}`,
    type: 'custom',
    tags: ['manual-installed'],
    config: { installRef: trimmed },
    createdAt: Date.now(),
  };
}
