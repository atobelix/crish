// packages/plugin-sdk/src/registry/plugin-store.ts
// 约束来源：ROUND-08-plugin-sdk.md §2.5 任务 5（PluginStore 持久化）
//
// 系统化设计：
// - PluginStore 负责持久化 installed plugins 列表 + 状态到 JSON 文件
// - 与 PluginRegistry 职责分离：Registry 管理内存态，Store 管理持久态
// - Store 不直接调用 Loader/Discoverer（不触发加载），仅读写持久化数据
// - JSON 文件格式向前兼容（未知字段保留，不拒绝）
// - 读写失败时静默降级（不阻塞 Registry 运行），仅记录 warning

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PluginState } from './plugin-state';
import type { PluginManifest, PluginOrigin } from '../manifest';

/**
 * PluginStore — 插件持久化存储。
 *
 * 存储格式：JSON 文件，含 installed plugins 列表 + 状态 + 最后更新时间。
 *
 * 职责边界：
 * - Store 仅负责读写持久化数据（不触发发现/加载/激活）
 * - Registry 在状态变更时调用 Store 持久化（可选，非阻塞）
 * - 启动时 Registry 可从 Store 恢复上次已安装插件列表（加速冷启动）
 *
 * 设计原则（系统化）：
 * - 持久化失败不阻塞运行时（catch + warning，返回 undefined）
 * - JSON 格式向前兼容（额外字段保留）
 * - 文件路径可自定义（测试可注入临时路径）
 */
export class PluginStore {
  /**
   * @param storePath JSON 文件路径（默认 ~/.crish/plugin-store.json）
   */
  constructor(
    private readonly storePath: string,
  ) {}

  /**
   * 读取持久化的插件列表。
   *
   * @returns 存储的插件列表；文件不存在或解析失败时返回空数组
   */
  async load(): Promise<StoredPluginEntry[]> {
    try {
      const content = await readFile(this.storePath, 'utf-8');
      const data = JSON.parse(content) as StoreFileFormat;
      return data.plugins ?? [];
    } catch {
      // 文件不存在或解析失败：静默返回空数组（冷启动正常路径）
      return [];
    }
  }

  /**
   * 持久化插件列表。
   *
   * @param plugins 要存储的插件列表
   * @throws Error 当写入失败时（调用方决定是否忽略）
   */
  async save(plugins: readonly StoredPluginEntry[]): Promise<void> {
    const data: StoreFileFormat = {
      version: STORE_FORMAT_VERSION,
      updatedAt: new Date().toISOString(),
      plugins: [...plugins],
    };
    try {
      await mkdir(dirname(this.storePath), { recursive: true });
      await writeFile(this.storePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.warn(
        `[PluginStore] failed to save ${this.storePath}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * 更新单个插件的状态（读取 → 更新 → 写回）。
   *
   * 系统化设计：原子化更新单个插件状态，不影响其他插件条目。
   * 若插件不存在则新增条目。
   */
  async updatePluginState(
    pluginId: string,
    state: PluginState,
    error?: string,
  ): Promise<void> {
    const plugins = await this.load();
    const idx = plugins.findIndex((p) => p.id === pluginId);
    const existing = idx >= 0 ? plugins[idx] : undefined;
    const entry: StoredPluginEntry = {
      id: pluginId,
      state,
      updatedAt: new Date().toISOString(),
      ...(error !== undefined ? { error } : {}),
      ...(existing?.manifest ? { manifest: existing.manifest } : {}),
      ...(existing?.origin ? { origin: existing.origin } : {}),
    };
    if (idx >= 0 && existing) {
      plugins[idx] = { ...existing, ...entry };
    } else {
      plugins.push(entry);
    }
    await this.save(plugins);
  }

  /**
   * 移除单个插件条目。
   */
  async removePlugin(pluginId: string): Promise<void> {
    const plugins = await this.load();
    const filtered = plugins.filter((p) => p.id !== pluginId);
    if (filtered.length !== plugins.length) {
      await this.save(filtered);
    }
  }

  /**
   * 查询单个插件条目。
   */
  async getPlugin(pluginId: string): Promise<StoredPluginEntry | undefined> {
    const plugins = await this.load();
    return plugins.find((p) => p.id === pluginId);
  }
}

/** 存储的插件条目 */
export interface StoredPluginEntry {
  /** 插件 ID */
  readonly id: string;
  /** 插件状态 */
  readonly state: PluginState;
  /** 最后更新时间（ISO 8601） */
  readonly updatedAt: string;
  /** error 状态下的错误信息 */
  readonly error?: string;
  /** 插件 manifest（可选，仅在 discover 后持久化） */
  readonly manifest?: PluginManifest;
  /** 插件来源 */
  readonly origin?: PluginOrigin;
}

/** 存储文件格式 */
interface StoreFileFormat {
  /** 格式版本（向前兼容校验） */
  readonly version: string;
  /** 最后更新时间 */
  readonly updatedAt: string;
  /** 插件列表 */
  readonly plugins: StoredPluginEntry[];
}

/** 存储格式版本（breaking change 时递增） */
const STORE_FORMAT_VERSION = '1';
