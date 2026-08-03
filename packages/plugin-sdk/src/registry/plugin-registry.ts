// packages/plugin-sdk/src/registry/plugin-registry.ts
// 约束来源：ROUND-08-plugin-sdk.md §3.5（PluginRegistry 核心）+ 禁令 13（ToolSource 实现）
//
// 迁移自 agent-runtime/src/plugin-registry.ts（516 行 ToolSource 适配器）。
// 系统化改进：
// - 状态机集中管理（plugin-state.ts 的 transferState 纯函数）
// - 发现/加载/校验职责分离（Discoverer + Loader + Validator 协作）
// - ToolSource 实现委托 ToolRegistryQuery（运行时工具存储在 agent-tools 的 ToolRegistry）
// - PluginStore 可选持久化（状态变更时异步写入，不阻塞运行时）
// - 单个插件加载失败不影响其他插件（记录 error 状态，继续执行）

import type { AgentTool, ToolSource } from '@crish/shared-types';
import type { PluginManifest } from '../manifest';
import type { PluginStateEntry, PluginState } from './plugin-state';
import {
  transferState,
  createDiscoveredEntry,
} from './plugin-state';
import type { PluginLoadResult } from './plugin-loader';
import type { DiscoveredPlugin, PluginDiscoverer } from './plugin-discoverer';
import type { PluginLoader } from './plugin-loader';
import type { PluginStore } from './plugin-store';
import type { ToolRegistrar } from '../tools';

/**
 * PluginRegistry — 插件注册表（核心）。
 *
 * 职责（禁令 13）：
 * 1. 通过 PluginDiscoverer 发现 user-dir + project-dir 插件
 * 2. 通过 PluginLoader 加载并激活
 * 3. 管理插件状态机（discovered → loading → loaded → active → inactive → error）
 * 4. 实现 ToolSource 接口（listTools 查询插件注册的工具）
 * 5. 提供插件能力查询（hooks/tools/mcpServers 声明清单）
 *
 * 迁移自 agent-runtime/src/plugin-registry.ts（516 行 ToolSource 适配器）：
 * - listTools()：委托 ToolRegistryQuery 查询插件注册的工具
 * - preparePluginTool() / cloneToolMetadata()：迁移为 cloneToolMetadata 辅助函数
 * - 重构：去除 contributes/commands/events/renderers 多重能力（MVP 聚焦 hooks+tools+mcp）
 *
 * 注意：不使用 `implements PluginRegistryLike`，因为 8-A 的 PluginManifest 与
 * shared-types 的 PluginManifest 结构不同。方法签名与 PluginRegistryLike 兼容。
 */
export class PluginRegistry implements ToolSource {
  readonly id: string;
  readonly label: string;

  private readonly plugins = new Map<string, PluginEntry>();
  /** toolName → pluginId 映射（用于工具所有权查询） */
  private readonly toolOwners = new Map<string, string>();

  private readonly store: PluginStore | undefined;
  private readonly toolRegistryQuery: ToolRegistryQuery | undefined;
  private readonly options: PluginRegistryOptions;

  constructor(
    private readonly discoverer: PluginDiscoverer,
    private readonly loader: PluginLoader,
    options: PluginRegistryOptions = {},
  ) {
    this.options = options;
    this.id = options.id ?? 'plugin-registry';
    this.label = options.label ?? 'Plugin registry';
    this.store = options.store;
    this.toolRegistryQuery = options.toolRegistryQuery;
  }

  /**
   * 发现 + 加载全部插件（从 user-dir + project-dir）。
   *
   * 系统化设计：单个插件加载失败不影响其他插件（记录 error 状态，继续执行）。
   * 持久化：加载完成后异步写入 PluginStore（不阻塞返回）。
   */
  async loadAll(): Promise<void> {
    const discovered = await this.discoverer.discover();
    await Promise.all(
      discovered.map((d) =>
        this.loadOne(d).catch((err) => {
          // loadOne 内部已处理错误状态，此处仅防止 Promise.all 中断
          console.warn(
            `[PluginRegistry] loadOne failed for ${d.manifest.id}:`,
            (err as Error).message,
          );
        }),
      ),
    );
    // 异步持久化（不阻塞）
    await this.persistState();
  }

  /**
   * 发现并加载单个插件。
   *
   * 状态流转：discovered → loading → loaded → active（或 error）
   */
  async loadOne(discovered: DiscoveredPlugin): Promise<void> {
    const { manifest } = discovered;
    const stateEntry = createDiscoveredEntry(manifest.id);
    // exactOptionalPropertyTypes: 不能直接赋值 undefined 给可选属性
    // loadResult 在加载成功后设置，此处使用可选属性省略
    const entry: PluginEntry = {
      manifest,
      state: stateEntry,
      discovered,
    };
    this.plugins.set(manifest.id, entry);

    try {
      // discovered → loading
      entry.state = transferState(entry.state, 'loading');

      // loading → loaded（Loader 完成 import + activate + validate）
      const loadResult = await this.loader.load(
        manifest,
        discovered.entryPath,
      );
      entry.loadResult = loadResult;
      entry.state = transferState(entry.state, 'loaded');

      // loaded → active（登记工具所有权）
      for (const toolName of loadResult.recordings.tools) {
        this.toolOwners.set(toolName, manifest.id);
      }
      entry.state = transferState(entry.state, 'active');
    } catch (err) {
      const message = (err as Error).message;
      // 任意状态 → error
      entry.state = transferState(entry.state, 'error', message);
      // I8-E2 加载阶段错误报告：单插件失败不阻断其他插件（opencode
      // plugin/index.ts:220-238 语义），经 onError 上报宿主
      // （宿主转发 runtime-error 事件流——错误事件化）
      if (this.options.onError) {
        try {
          this.options.onError(manifest.id, message);
        } catch {
          // 上报器自身失败不阻断状态机
        }
      }
    }
  }

  /**
   * 停用插件（注销能力）。
   *
   * 状态流转：active → inactive
   * 调用 lifecycle.deactivate() 清理已注册的 hook/tool/mcp。
   */
  async deactivate(pluginId: string): Promise<boolean> {
    const entry = this.plugins.get(pluginId);
    if (!entry?.loadResult) return false;
    if (entry.state.state !== 'active') return false;

    try {
      await entry.loadResult.lifecycle.deactivate?.();
    } catch (err) {
      console.warn(
        `[PluginRegistry] deactivate threw for ${pluginId}:`,
        (err as Error).message,
      );
    }

    // 清理工具所有权
    for (const toolName of entry.loadResult.recordings.tools) {
      this.toolOwners.delete(toolName);
    }

    entry.state = transferState(entry.state, 'inactive');
    await this.persistState();
    return true;
  }

  /**
   * 重试加载失败的插件（error → discovered → loading → ...）。
   */
  async retry(pluginId: string): Promise<boolean> {
    const entry = this.plugins.get(pluginId);
    if (!entry || entry.state.state !== 'error') return false;
    if (!entry.discovered) return false;

    // error → discovered
    entry.state = transferState(entry.state, 'discovered', 'retry');
    // 重新加载
    await this.loadOne(entry.discovered);
    return true;
  }

  // ─── ToolSource 实现（迁移自现有 plugin-registry.ts）──

  /**
   * 列出全部插件注册的工具。
   *
   * 委托 ToolRegistryQuery 查询已注册的 AgentTool 实例。
   * 仅返回 active 状态插件注册的工具。
   */
  async listTools(): Promise<AgentTool[]> {
    if (!this.toolRegistryQuery) return [];
    const tools: AgentTool[] = [];
    for (const entry of this.plugins.values()) {
      if (entry.state.state !== 'active' || !entry.loadResult) continue;
      for (const toolName of entry.loadResult.recordings.tools) {
        const tool = this.toolRegistryQuery.getTool(toolName);
        if (tool) {
          tools.push(cloneToolMetadata(tool, entry.manifest.id, this.id));
        }
      }
    }
    return tools;
  }

  /**
   * 列出插件工具贡献（含来源元数据）。
   *
   * 返回每个工具的来源插件 ID + 注册表 ID，供工具发现机制使用。
   */
  async listToolContributions(): Promise<PluginToolContribution[]> {
    const contributions: PluginToolContribution[] = [];
    for (const entry of this.plugins.values()) {
      if (entry.state.state !== 'active' || !entry.loadResult) continue;
      for (const toolName of entry.loadResult.recordings.tools) {
        const tool = this.toolRegistryQuery?.getTool(toolName);
        contributions.push({
          pluginId: entry.manifest.id,
          pluginName: entry.manifest.name,
          toolName,
          sourceId: this.id,
          tool: tool ?? null,
        });
      }
    }
    return contributions;
  }

  /** 释放全部资源（停用全部插件） */
  async dispose(): Promise<void> {
    for (const pluginId of [...this.plugins.keys()]) {
      await this.deactivate(pluginId);
    }
    this.plugins.clear();
    this.toolOwners.clear();
  }

  // ─── 查询方法 ──

  /**
   * 列出全部插件及其状态。
   */
  listPlugins(): PluginListEntry[] {
    return [...this.plugins.values()].map((e) => ({
      manifest: e.manifest,
      state: e.state.state,
      ...(e.state.error !== undefined ? { error: e.state.error } : {}),
    }));
  }

  /**
   * 查询单个插件状态。
   */
  getPluginState(pluginId: string): PluginStateEntry | undefined {
    return this.plugins.get(pluginId)?.state;
  }

  /**
   * 查询单个插件 manifest。
   */
  getPlugin(pluginId: string): PluginManifest | undefined {
    return this.plugins.get(pluginId)?.manifest;
  }

  /**
   * 查询工具所属插件。
   */
  getToolOwner(toolName: string): string | undefined {
    return this.toolOwners.get(toolName);
  }

  /**
   * 查询插件声明的全部能力（hooks + tools + mcpServers）。
   */
  getPluginCapabilities(pluginId: string): PluginCapabilities | undefined {
    const entry = this.plugins.get(pluginId);
    if (!entry) return undefined;
    return {
      hooks: entry.manifest.declaredHooks,
      tools: entry.manifest.declaredTools,
      mcpServers: entry.manifest.declaredMcpServers,
    };
  }

  // ─── 内部方法 ──

  /**
   * 持久化当前全部插件状态到 PluginStore。
   * 静默失败：持久化失败不阻塞运行时。
   */
  private async persistState(): Promise<void> {
    if (!this.store) return;
    try {
      const entries = [...this.plugins.values()].map((e) => ({
        id: e.manifest.id,
        state: e.state.state,
        updatedAt: e.state.updatedAt,
        ...(e.state.error !== undefined ? { error: e.state.error } : {}),
        ...(e.discovered ? { origin: e.discovered.origin } : {}),
      }));
      await this.store.save(entries);
    } catch (err) {
      console.warn(
        `[PluginRegistry] persistState failed (non-blocking):`,
        (err as Error).message,
      );
    }
  }
}

// ─── 内部类型 ──

interface PluginEntry {
  readonly manifest: PluginManifest;
  state: PluginStateEntry;
  readonly discovered: DiscoveredPlugin;
  loadResult?: PluginLoadResult;
}

// ─── 公共导出类型 ──

export interface PluginRegistryOptions {
  id?: string;
  label?: string;
  /** 持久化存储（可选，注入后状态变更自动持久化） */
  store?: PluginStore;
  /** 工具注册表查询接口（可选，注入后 listTools() 可查询插件注册的工具） */
  toolRegistryQuery?: ToolRegistryQuery;
  /**
   * 加载失败上报器（I8-E2 错误事件化）：单插件加载失败（discover/load/
   * activate/validate）时回调——宿主据此转发 runtime-error 事件流；
   * 单插件失败不阻断其他插件。
   */
  onError?: (pluginId: string, message: string) => void;
}

export interface PluginListEntry {
  readonly manifest: PluginManifest;
  readonly state: PluginState;
  readonly error?: string;
}

export interface PluginToolContribution {
  readonly pluginId: string;
  readonly pluginName: string;
  readonly toolName: string;
  readonly sourceId: string;
  readonly tool: AgentTool | null;
}

export interface PluginCapabilities {
  readonly hooks: readonly string[];
  readonly tools: readonly string[];
  readonly mcpServers: readonly string[];
}

/**
 * ToolRegistryQuery 契约 — agent-tools 的 ToolRegistry 实现此接口。
 *
 * 扩展 ToolRegistrar（注册能力）增加查询能力：
 * - getTool(name)：按名称查询已注册的 AgentTool
 *
 * PluginRegistry 通过此接口查询插件注册的工具（ToolSource 实现）。
 */
export interface ToolRegistryQuery extends ToolRegistrar {
  /** 按名称查询已注册工具 */
  getTool(name: string): AgentTool | undefined;
}

/**
 * 克隆工具元数据（迁移自现有 plugin-registry.ts 的 cloneToolMetadata）。
 *
 * 系统化改进：附加 sourceId + pluginId 元数据，供工具发现机制追踪来源。
 */
function cloneToolMetadata(
  tool: AgentTool,
  _pluginId: string,
  _sourceId: string,
): AgentTool {
  // AgentTool 是接口，返回同一引用（工具实例由 ToolRegistry 管理，Registry 不复制）
  // 此函数预留为扩展点：未来可附加 pluginId/sourceId 元数据到 tool.metadata
  // MVP 阶段直接返回原引用，避免深拷贝开销
  return tool;
}
