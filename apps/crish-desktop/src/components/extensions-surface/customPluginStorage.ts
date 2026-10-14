/**
 * apps/crish-desktop/src/components/extensions-surface/customPluginStorage.ts
 *
 * 用户自定义插件持久化存储与分享 Payload 规范解析器
 * 读写统一经 api/localStorageApi 安全访问层（key: `crish_custom_plugins_v1`），并做跨组件广播
 */

import { safeGetJson, safeSetJson } from '../../api/localStorageApi';

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
  const parsed = safeGetJson<unknown>(CUSTOM_PLUGINS_STORAGE_KEY, []);
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

    safeSetJson(CUSTOM_PLUGINS_STORAGE_KEY, updated);
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
    safeSetJson(CUSTOM_PLUGINS_STORAGE_KEY, updated);
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

/**
 * 从文件文本（manifest.json、package.json 等）解析插件元数据
 */
export function parsePluginFromFileContent(
  text: string,
  fileName?: string
): CustomPluginItem | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const data = JSON.parse(trimmed);
    if (!data || typeof data !== 'object') return null;

    const rawName = String(
      data.name || data.title || data.displayName || ''
    ).trim();
    const fallbackName = fileName
      ? fileName.replace(/\.(json|zip)$/i, '').replace(/[_-]+/g, ' ')
      : '已导入插件';
    const name = rawName || fallbackName;

    let rawId = String(data.id || '').trim();
    if (!rawId && rawName) {
      const unscoped = rawName.includes('/')
        ? rawName.split('/').pop()!
        : rawName;
      rawId = unscoped.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
    }
    if (!rawId) {
      rawId = (
        fileName ? fileName.replace(/\.(json|zip)$/i, '') : 'custom-plugin'
      )
        .replace(/[^a-zA-Z0-9_-]/g, '-')
        .toLowerCase();
    }
    const id = rawId.replace(/^-+|-+$/g, '') || `plugin-${Date.now()}`;

    const version = String(data.version || '1.0.0').trim();
    const description = String(
      data.description ||
        data.desc ||
        `从 ${fileName || '外部文件'} 导入的扩展插件`
    ).trim();

    const author =
      typeof data.author === 'string'
        ? data.author.trim()
        : data.author &&
            typeof data.author === 'object' &&
            'name' in data.author
          ? String((data.author as { name?: string }).name || '').trim()
          : undefined;

    const type =
      data.type === 'tool' || data.type === 'view' ? data.type : 'custom';
    const tags = Array.isArray(data.tags)
      ? data.tags.map(String)
      : Array.isArray(data.keywords)
        ? data.keywords.map(String)
        : ['imported'];

    return {
      id,
      name,
      version: version || '1.0.0',
      description,
      author: author || undefined,
      type,
      tags,
      config:
        data.config && typeof data.config === 'object'
          ? data.config
          : undefined,
      createdAt: Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * 从 ZIP 压缩包解析插件元数据（优先读取 zip 内的 manifest.json / package.json，失败时回退从文件名提取）
 */
export async function parsePluginFromZipFile(
  file: File
): Promise<CustomPluginItem | null> {
  const fileName = file.name;
  const baseName = fileName.replace(/\.zip$/i, '');
  const cleanId =
    baseName.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase() ||
    `plugin-${Date.now()}`;

  try {
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength === 0) return null;
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    let pos = 0;
    while (pos + 30 < view.byteLength) {
      if (view.getUint32(pos, true) !== 0x04034b50) {
        break;
      }

      const method = view.getUint16(pos + 8, true);
      const compressedSize = view.getUint32(pos + 18, true);
      const nameLen = view.getUint16(pos + 26, true);
      const extraLen = view.getUint16(pos + 28, true);

      const nameBytes = bytes.slice(pos + 30, pos + 30 + nameLen);
      const entryName = new TextDecoder('utf-8').decode(nameBytes);
      const dataStart = pos + 30 + nameLen + extraLen;
      const dataEnd = dataStart + compressedSize;

      const baseEntryName = entryName.split('/').pop() || entryName;
      if (
        (baseEntryName === 'manifest.json' ||
          baseEntryName === 'package.json') &&
        dataEnd <= bytes.length
      ) {
        if (method === 0) {
          const jsonText = new TextDecoder('utf-8').decode(
            bytes.slice(dataStart, dataEnd)
          );
          const parsed = parsePluginFromFileContent(jsonText, baseEntryName);
          if (parsed) return parsed;
        } else if (method === 8 && typeof DecompressionStream !== 'undefined') {
          try {
            const ds = new DecompressionStream('deflate-raw');
            const writer = ds.writable.getWriter();
            writer.write(buffer.slice(dataStart, dataEnd));
            writer.close();
            const decompressedBuf = await new Response(
              ds.readable
            ).arrayBuffer();
            const decompressedText = new TextDecoder('utf-8').decode(
              decompressedBuf
            );
            const parsed = parsePluginFromFileContent(
              decompressedText,
              baseEntryName
            );
            if (parsed) return parsed;
          } catch {
            // fallback
          }
        }
      }

      pos = dataEnd;
      if (compressedSize === 0) break;
    }
  } catch {
    // ignore
  }

  return {
    id: cleanId,
    name: baseName,
    version: '1.0.0',
    description: `从压缩包「${fileName}」导入的插件`,
    type: 'custom',
    tags: ['imported', 'zip'],
    createdAt: Date.now(),
  };
}

/**
 * 从文件夹所包含的文件列表中检索 manifest.json / package.json 进行解析
 */
export async function parsePluginFromDirectoryFiles(
  files: File[]
): Promise<CustomPluginItem | null> {
  if (!files || files.length === 0) return null;

  const manifestFile =
    files.find((f) => f.name.toLowerCase() === 'manifest.json') ||
    files.find((f) => f.name.toLowerCase() === 'package.json') ||
    files.find((f) => f.name.toLowerCase().endsWith('.json'));

  if (manifestFile) {
    try {
      const text =
        typeof manifestFile.text === 'function'
          ? await manifestFile.text()
          : await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = reject;
              reader.readAsText(manifestFile);
            });
      const parsed = parsePluginFromFileContent(text, manifestFile.name);
      if (parsed) return parsed;
    } catch {
      // fallback to folder name
    }
  }

  const first = files[0];
  if (!first) return null;
  const relativePath = (first as any).webkitRelativePath || '';
  const dirName =
    (relativePath ? relativePath.split('/')[0] : '') ||
    first.name ||
    'plugin-dir';
  const cleanId =
    dirName.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase() ||
    `plugin-${Date.now()}`;

  return {
    id: cleanId,
    name: dirName,
    version: '1.0.0',
    description: `从插件目录「${dirName}」导入的插件`,
    type: 'custom',
    tags: ['imported', 'directory'],
    createdAt: Date.now(),
  };
}
