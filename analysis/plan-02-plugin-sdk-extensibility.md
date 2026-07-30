# Crish 插件 SDK 与可扩展性架构设计

> **设计目标**: 将 Crish 当前 16 行插件系统重构为企业级可扩展平台，参考 Grok Build（12 事件 + 多源发现 + 信任门控）、Codex CLI（技能 + MCP）、Pi（扩展生命周期 + Harness 抽象）、Kimi Code（DI 服务 + 技能系统）的最佳实践。

---

## 目录

1. [多包架构概览](#1-多包架构概览)
2. [核心类型包: shared-plugin-types](#2-核心类型包-shared-plugin-types)
3. [插件注册表: packages/plugin-registry](#3-插件注册表-packagesplugin-registry)
4. [钩子系统: packages/plugin-hooks](#4-钩子系统-packagesplugin-hooks)
5. [插件 SDK: packages/plugin-sdk](#5-插件-sdk-packagesplugin-sdk)
6. [MCP 集成: packages/plugin-mcp](#6-mcp-集成-packagesplugin-mcp)
7. [技能系统: packages/plugin-skills](#7-技能系统-packagesplugin-skills)
8. [工具发现与注册](#8-工具发现与注册)
9. [插件生命周期管理](#9-插件生命周期管理)
10. [信任与权限模型](#10-信任与权限模型)
11. [热重载与开发体验](#11-热重载与开发体验)
12. [插件的 AGENTS.md 集成](#12-插件的-agentsmd-集成)

---

## 1. 多包架构概览

```
packages/
  plugin-sdk/          # 插件开发者 SDK（definePlugin、PluginAPI）
  plugin-registry/     # 插件注册表（多源发现、安装/卸载/升级）
  plugin-hooks/        # 钩子系统（事件派发、超时、故障策略）
  plugin-mcp/          # MCP 服务集成（生命周期、OAuth、传输管理）
  plugin-skills/       # 技能系统（SKILL.md 解析、技能→工具转换）
  shared-types/        # 已有，补充插件类型
```

### 包依赖关系

```
plugin-sdk
  -> shared-types (PluginManifest, HookEvent 等类型)
  -> plugin-hooks (HookAPI 派发能力)
  -> plugin-mcp (MCP 注册能力)
  -> plugin-skills (技能加载能力)

plugin-registry
  -> shared-types (PluginManifest 校验)
  -> plugin-sdk (Plugin 实例管理)

agent-runtime (消费者)
  -> plugin-registry (获取已加载插件)
  -> plugin-hooks (事件派发)
  -> plugin-mcp (MCP 服务器管理)
  -> plugin-skills (技能发现)
```

---

## 2. 核心类型包: shared-plugin-types

**文件**: `packages/shared-types/src/plugin.ts`

### 2.1 PluginManifest

```typescript
// ============================================================================
// Plugin Manifest — 插件元数据声明的源头
// ============================================================================

/**
 * 插件发现的来源类型，参考 Grok 的 PluginOrigin (7 种变体)
 */
export type PluginOrigin =
  | { kind: 'user-dir'; path: string } // ~/.crish/plugins/<name>/
  | { kind: 'project-dir'; path: string } // .crish/plugins/<name>/
  | { kind: 'global-dir'; path: string } // /etc/crish/plugins/<name>/
  | { kind: 'npm'; packageName: string } // npm 安装的插件
  | { kind: 'mcp'; mcpServerName: string } // 通过 MCP 发现的远端插件
  | { kind: 'github'; owner: string; repo: string; ref?: string } // GitHub 源
  | { kind: 'inline'; source: string }; // 内联定义（配置中直接声明）

export type PluginPermission =
  | 'session:read'
  | 'session:write'
  | 'tool:execute'
  | 'tool:register'
  | 'mcp:connect'
  | 'network:connect'
  | 'file:read'
  | 'file:write'
  | 'shell:execute'
  | 'env:read'
  | 'plugin:install'
  | 'hook:intercept';

export type PluginTrustLevel = 'sandboxed' | 'restricted' | 'full';

export interface PluginEntrypoint {
  /** 插件主入口文件路径（相对于插件根目录） */
  main?: string;
  /** 浏览器端入口 */
  browser?: string;
  /** Node.js 特定入口 */
  node?: string;
}

export interface PluginHookBinding {
  /** 钩子事件名 */
  event: string;
  /** 处理器类型 */
  handlerType: 'sync' | 'async' | 'command' | 'webhook';
  /** 执行模式 */
  mode?: 'serial' | 'parallel';
  /** 超时毫秒，默认 5000 */
  timeoutMs?: number;
  /** 故障策略 */
  failStrategy?: 'fail-open' | 'fail-close';
  /** 如果是 command 类型，指定 CLI 子进程命令 */
  command?: string;
  /** 如果是 webhook 类型，指定 URL */
  url?: string;
}

export interface PluginToolDef {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  /** 工具所需的权限 */
  requiredPermissions?: PluginPermission[];
  /** 执行类别，用于并发控制 */
  category?: 'filesystem' | 'network' | 'shell' | 'readonly' | 'agent' | 'mcp';
  /** 并发模式 */
  concurrency?: 'parallel' | 'sequential' | 'exclusive';
}

export interface PluginMcpServerDeclaration {
  name: string;
  description?: string;
  transport: 'stdio' | 'http' | 'sse' | 'websocket';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  envKeys?: string[];
  headerKeys?: string[];
  oauth?: {
    name: string;
    clientId: string;
    authorizationUrl: string;
    tokenUrl: string;
    scopes: string[];
  };
}

export interface PluginSkillDef {
  /** 技能目录路径（相对于插件根目录） */
  path: string;
  /** 技能名称（可选，默认从 SKILL.md 读取） */
  name?: string;
}

export interface PluginManifest {
  /** 插件唯一名称，如 "@crish/mcp-server" */
  name: string;
  /** semver 版本号 */
  version: string;
  /** 可读名称 */
  displayName?: string;
  /** 简短描述 */
  description?: string;
  /** 详细描述 */
  longDescription?: string;
  /** 作者信息 */
  author?: {
    name?: string;
    email?: string;
    url?: string;
  };
  /** 许可证 */
  license?: string;
  /** 主页 */
  homepage?: string;
  /** 关键词 */
  keywords?: string[];
  /** 入口点配置 */
  entrypoints?: PluginEntrypoint;
  /** 插件依赖（name -> semver range） */
  dependencies?: Record<string, string>;
  /** 可选的依赖（name -> semver range） */
  optionalDependencies?: Record<string, string>;
  /** 所需的信任级别 */
  trustLevel?: PluginTrustLevel;
  /** 声明所需的权限 */
  permissions?: PluginPermission[];
  /** 注册的钩子 */
  hooks?: PluginHookBinding[];
  /** 注册的自定义工具 */
  tools?: PluginToolDef[];
  /** MCP 服务器声明 */
  mcpServers?: PluginMcpServerDeclaration[];
  /** 技能声明 */
  skills?: PluginSkillDef[];
  /** 最低 Crish 版本要求 */
  engineVersion?: string;
  /** 实验性标志开关 */
  experimentalFlags?: string[];
}
```

### 2.2 校验结果类型

```typescript
export type PluginValidationSeverity = 'error' | 'warn' | 'info';

export interface PluginValidationIssue {
  severity: PluginValidationSeverity;
  code: string;
  message: string;
  field?: string;
}

export interface PluginValidationResult {
  valid: boolean;
  manifest: PluginManifest;
  issues: PluginValidationIssue[];
}

// ============================================================================
// 运行时插件实例类型
// ============================================================================

export type PluginState =
  | 'discovered'
  | 'installing'
  | 'installed'
  | 'loading'
  | 'loaded'
  | 'activating'
  | 'active'
  | 'deactivating'
  | 'inactive'
  | 'error'
  | 'uninstalling'
  | 'uninstalled';

export interface PluginRuntime {
  id: string;
  manifest: PluginManifest;
  origin: PluginOrigin;
  state: PluginState;
  rootDir: string;
  installedAt: string;
  updatedAt?: string;
  /** 解析后的入口模块（懒加载） */
  module?: PluginModule;
  /** 运行时 MCP 服务器状态 */
  mcpServers: Map<string, PluginMcpServerState>;
  /** 技能目录的绝对路径列表 */
  skillPaths: string[];
  /** 已注册的工具定义 */
  tools: PluginToolDef[];
  /** 已注册的钩子绑定 */
  hookBindings: PluginHookBinding[];
  /** 错误信息（如果 state === "error"） */
  error?: string;
}

export interface PluginMcpServerState {
  processId?: number;
  status: 'starting' | 'running' | 'stopped' | 'error';
  transport: string;
  endpoint?: string;
  startedAt?: string;
  error?: string;
}
```

---

## 3. 插件注册表: packages/plugin-registry

**目录结构**:

```
packages/plugin-registry/src/
  index.ts              # 导出公共 API
  registry.ts           # PluginRegistry 主类
  discoverer.ts         # 多源发现 (Multisource Plugin Discovery)
  validator.ts          # Manifest 校验 + 依赖检查
  installer.ts          # 安装/更新/卸载流程
  resolver.ts           # 依赖解析器
  store.ts              # 持久化存储
```

### 3.1 PluginRegistry 主类

```typescript
// packages/plugin-registry/src/registry.ts

import type {
  PluginManifest,
  PluginOrigin,
  PluginRuntime,
  PluginState,
} from 'shared-types/plugin';

export interface RegistryOptions {
  /** 用户目录 ~/.crish/ */
  userDir: string;
  /** 项目目录（启动时传入） */
  projectDir?: string;
  /** 全局目录 */
  globalDir?: string;
  /** 是否启用 npm 发现 */
  enableNpmDiscovery?: boolean;
  /** 是否启用 MCP 远端发现 */
  enableMcpDiscovery?: boolean;
  /** 自定义发现目录 */
  extraDiscoveryPaths?: string[];
}

export class PluginRegistry {
  private runtimes: Map<string, PluginRuntime> = new Map();
  private discoverer: PluginDiscoverer;
  private validator: PluginManifestValidator;
  private installer: PluginInstaller;
  private store: PluginStore;

  constructor(options: RegistryOptions) {}

  // ========== 发现与加载 ==========

  /** 执行全量发现（所有源）*/
  async discoverAll(): Promise<PluginManifest[]> {}

  /** 发现并加载所有插件 */
  async loadAll(): Promise<PluginRuntime[]> {}

  /** 按 ID 加载单个插件 */
  async load(id: string): Promise<PluginRuntime> {}

  // ========== CRUD ==========

  /** 列出所有已发现/安装的插件 */
  list(filter?: {
    state?: PluginState;
    origin?: PluginOrigin['kind'];
  }): PluginRuntime[] {}

  /** 按 ID 获取运行时 */
  get(id: string): PluginRuntime | undefined {}

  /** 安装插件（从任意源）*/
  async install(source: string): Promise<PluginRuntime> {}

  /** 更新插件到最新版本 */
  async update(id: string): Promise<PluginRuntime> {}

  /** 卸载插件 */
  async uninstall(id: string): Promise<void> {}

  /** 启用插件 */
  async enable(id: string): Promise<void> {}

  /** 禁用插件（不卸载）*/
  async disable(id: string): Promise<void> {}

  // ========== 生命周期 ==========

  /** 激活插件（调用入口模块的 activate） */
  async activate(id: string, api: PluginAPI): Promise<void> {}

  /** 停用插件（调用入口模块的 deactivate） */
  async deactivate(id: string): Promise<void> {}

  /** 热重载单个插件 */
  async reload(id: string): Promise<PluginRuntime> {}

  // ========== 校验 ==========

  /** 校验插件 manifest */
  validateManifest(rootDir: string): Promise<PluginValidationResult> {}

  /** 检查依赖是否满足 */
  checkDependencies(
    manifest: PluginManifest
  ): Promise<{ satisfied: boolean; missing: string[] }> {}

  // ========== 事件通知 ==========

  private notifyStateChange(
    id: string,
    oldState: PluginState,
    newState: PluginState
  ): void {}
}
```

### 3.2 多源发现器

```typescript
// packages/plugin-registry/src/discoverer.ts

export interface DiscoveredCandidate {
  manifest: PluginManifest;
  origin: PluginOrigin;
  rootDir: string;
}

export class PluginDiscoverer {
  constructor(private options: RegistryOptions) {}

  /**
   * 从所有配置的源中搜索插件，参考 Grok 的 multisource discovery 设计
   *
   * 发现优先级（高 -> 低）：
   * 1. project-dir:   .crish/plugins/<name>/
   * 2. user-dir:      ~/.crish/plugins/<name>/
   * 3. global-dir:    /etc/crish/plugins/<name>/
   * 4. npm:           从 node_modules 发现 @crish/* 插件
   * 5. mcp:           通过 MCP 协议询问远端已知插件
   * 6. github:        从已知的 GitHub 仓库索引发现
   * 7. inline:        从 Crish 配置文件内联声明发现
   */
  async discover(): Promise<DiscoveredCandidate[]> {
    const results: DiscoveredCandidate[] = [];
    const seen = new Set<string>();

    // 1. 项目级目录
    if (this.options.projectDir) {
      const projectPlugins = await this.scanDir(
        path.join(this.options.projectDir, '.crish', 'plugins'),
        { kind: 'project-dir', path: this.options.projectDir }
      );
      for (const p of projectPlugins) {
        seen.add(p.manifest.name);
        results.push(p);
      }
    }

    // 2. 用户级目录
    const userPlugins = await this.scanDir(
      path.join(this.options.userDir, 'plugins'),
      { kind: 'user-dir', path: this.options.userDir }
    );
    for (const p of userPlugins) {
      if (!seen.has(p.manifest.name)) {
        seen.add(p.manifest.name);
        results.push(p);
      }
    }

    // 3. 全局目录
    if (this.options.globalDir) {
      const globalPlugins = await this.scanDir(
        path.join(this.options.globalDir, 'plugins'),
        { kind: 'global-dir', path: this.options.globalDir }
      );
      for (const p of globalPlugins) {
        if (!seen.has(p.manifest.name)) {
          seen.add(p.manifest.name);
          results.push(p);
        }
      }
    }

    // 4. npm 包发现
    if (this.options.enableNpmDiscovery) {
      const npmPlugins = await this.discoverNpmPlugins(seen);
      results.push(...npmPlugins);
    }

    // 5. MCP 远端发现
    if (this.options.enableMcpDiscovery) {
      const mcpPlugins = await this.discoverMcpPlugins(seen);
      results.push(...mcpPlugins);
    }

    // 6. 额外路径
    if (this.options.extraDiscoveryPaths) {
      for (const extraPath of this.options.extraDiscoveryPaths) {
        const extra = await this.scanDir(extraPath, {
          kind: 'user-dir',
          path: extraPath,
        });
        for (const p of extra) {
          if (!seen.has(p.manifest.name)) {
            seen.add(p.manifest.name);
            results.push(p);
          }
        }
      }
    }

    return results;
  }

  /**
   * 扫描目录下所有子目录，查找 crish.plugin.json 或 .crish-plugin/plugin.json
   */
  private async scanDir(
    dir: string,
    origin: PluginOrigin
  ): Promise<DiscoveredCandidate[]> {
    // 读取目录下所有子目录
    // 每个子目录查找 crish.plugin.json (root manifest)
    //   或 .crish-plugin/plugin.json (目录 manifest)
    // 解析为 DiscoveredCandidate
  }

  /**
   * 在 node_modules 中发现 @crish/* scope 的 npm 包
   */
  private async discoverNpmPlugins(
    seen: Set<string>
  ): Promise<DiscoveredCandidate[]> {}

  /**
   * 通过 MCP 协议发现远端插件
   */
  private async discoverMcpPlugins(
    seen: Set<string>
  ): Promise<DiscoveredCandidate[]> {}
}
```

### 3.3 Manifest 校验器

```typescript
// packages/plugin-registry/src/validator.ts

export class PluginManifestValidator {
  /**
   * 校验插件目录 / manifest 文件
   *
   * 校验规则：
   * - name 必填，符合 @scope/name 或 simple-name 格式
   * - version 必填，合法 semver
   * - engineVersion（如有）与当前 Crish 版本兼容
   * - permissions 声明（如有）在已知权限列表中
   * - hooks[].event 是已知事件名
   * - mcpServers[].transport 是合法传输类型
   * - dependencies（如有）无循环引用
   */
  async validate(
    rootDir: string,
    manifest?: PluginManifest
  ): Promise<PluginValidationResult> {}

  private validateName(name: unknown): PluginValidationIssue | null {}
  private validateVersion(version: unknown): PluginValidationIssue | null {}
  private validatePermissions(perms: unknown): PluginValidationIssue[] {}
  private validateHooks(
    hooks: unknown,
    knownEvents: Set<string>
  ): PluginValidationIssue[] {}
  private validateMcpServers(servers: unknown): PluginValidationIssue[] {}
  private validateDependencies(
    deps: unknown,
    allPlugins: Map<string, string>
  ): PluginValidationIssue[] {}
}
```

### 3.4 安装器

```typescript
// packages/plugin-registry/src/installer.ts

export class PluginInstaller {
  constructor(
    private registry: PluginRegistry,
    private store: PluginStore
  ) {}

  /**
   * 从 source 安装插件
   *
   * 支持以下 source 格式：
   * - 本地路径:     file:///path/to/plugin 或 /abs/path
   * - GitHub URL:   https://github.com/owner/repo 或 owner/repo
   * - GitHub + ref: owner/repo#v1.0.0 或 owner/repo#branch-name
   * - npm 包:      npm:@crish/plugin-name 或 @crish/plugin-name
   * - ZIP URL:     https://example.com/plugin.zip
   * - MCP 服务:    mcp://server-name/plugins/name
   */
  async install(source: string): Promise<PluginRuntime> {
    const resolved = this.resolveSource(source);
    const tempDir = await this.download(resolved);
    const validation = await this.registry.validateManifest(tempDir);
    if (!validation.valid) {
      throw new PluginInstallError(
        `Validation failed: ${validation.issues.map((i) => i.message).join('; ')}`
      );
    }
    const deps = await this.registry.checkDependencies(validation.manifest);
    if (!deps.satisfied) {
      throw new PluginDependencyError(
        `Missing dependencies: ${deps.missing.join(', ')}`
      );
    }
    const targetDir = this.resolveTargetDir(
      validation.manifest.name,
      resolved.origin
    );
    await this.copyToTarget(tempDir, targetDir);
    await this.cleanup(tempDir);
    const runtime = await this.registry.load(validation.manifest.name);
    await this.store.saveInstallRecord(runtime);
    return runtime;
  }

  async uninstall(id: string): Promise<void> {
    const runtime = this.registry.get(id);
    if (!runtime) throw new PluginNotFoundError(id);
    await this.registry.deactivate(id);
    await this.removeDirectory(runtime.rootDir);
    this.registry['runtimes'].delete(id);
    await this.store.removeInstallRecord(id);
  }

  async update(id: string): Promise<PluginRuntime> {
    const runtime = this.registry.get(id);
    if (!runtime) throw new PluginNotFoundError(id);
    const source = this.sourceFromOrigin(runtime.origin);
    await this.uninstall(id);
    return this.install(source);
  }

  private resolveSource(source: string): ResolvedInstallSource {}
  private async download(source: ResolvedInstallSource): Promise<string> {}
  private resolveTargetDir(name: string, origin: PluginOrigin): string {}
  private async copyToTarget(
    tempDir: string,
    targetDir: string
  ): Promise<void> {}
}

type ResolvedInstallSource =
  | { kind: 'local-path'; path: string }
  | { kind: 'github'; owner: string; repo: string; ref?: string }
  | { kind: 'npm'; packageName: string }
  | { kind: 'zip-url'; url: string }
  | { kind: 'mcp'; serverName: string; pluginName: string };
```

### 3.5 持久化存储

```typescript
// packages/plugin-registry/src/store.ts

export interface StoredPluginRecord {
  id: string;
  name: string;
  version: string;
  origin: PluginOrigin;
  rootDir: string;
  installedAt: string;
  updatedAt?: string;
  enabled: boolean;
  trustGranted: boolean;
  permissionGrants: PluginPermission[];
  lastActiveState?: PluginState;
}

export class PluginStore {
  constructor(private userDir: string) {}

  private get storePath(): string {
    return path.join(this.userDir, '.crish', 'plugins.json');
  }

  async loadAll(): Promise<StoredPluginRecord[]> {
    // 从 ~/.crish/plugins.json 加载已安装插件记录
  }

  async saveInstallRecord(runtime: PluginRuntime): Promise<void> {}
  async removeInstallRecord(id: string): Promise<void> {}
  async updatePermissionGrants(
    id: string,
    grants: PluginPermission[]
  ): Promise<void> {}
  async setEnabled(id: string, enabled: boolean): Promise<void> {}
  async setTrustGranted(id: string, granted: boolean): Promise<void> {}
}
```

---

## 4. 钩子系统: packages/plugin-hooks

**目录结构**:

```
packages/plugin-hooks/src/
  index.ts              # 导出 HookBus, HookEvent, HookHandler
  bus.ts                # HookBus 主类
  dispatcher.ts         # 事件派发引擎（串行/并行/超时/故障策略）
  events.ts             # 事件类型定义（14 个生命周期事件）
  runner/               # 命令运行器和 webhook 调用器
    command-runner.ts
    webhook-runner.ts
  trust.ts              # 信任门控检查
```

### 4.1 事件类型定义

```typescript
// packages/plugin-hooks/src/events.ts

// ============================================================================
// Crish 生命周期钩子事件（参考 Grok 的 12 事件 + Pi 的 ExtensionEvent）
// ============================================================================

/**
 * 所有钩子事件的联合类型。每个事件包含：
 * - type: 事件名称
 * - timestamp: 事件发生时间
 * - sessionId: 关联会话（如有）
 * - metadata: 可选的上下文元数据
 */

// --- 会话生命周期 ---

export interface HookSessionStartEvent {
  type: 'session:start';
  timestamp: string;
  sessionId: string;
  reason: 'new' | 'resume' | 'fork' | 'reload';
  cwd: string;
  metadata?: Record<string, unknown>;
}

export interface HookSessionEndEvent {
  type: 'session:end';
  timestamp: string;
  sessionId: string;
  reason: 'stop' | 'max-turns' | 'aborted' | 'error';
  turnCount: number;
  error?: string;
}

// --- Turn 周期 ---

export interface HookTurnStartEvent {
  type: 'turn:start';
  timestamp: string;
  sessionId: string;
  turnIndex: number;
  userMessage: string;
}

export interface HookTurnEndEvent {
  type: 'turn:end';
  timestamp: string;
  sessionId: string;
  turnIndex: number;
  toolCallCount: number;
  messageCount: number;
}

// --- 工具执行 ---

export interface HookToolBeforeEvent {
  type: 'tool:before';
  timestamp: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  category?: string;
}

export interface HookToolAfterEvent {
  type: 'tool:after';
  timestamp: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  isError: boolean;
  durationMs: number;
}

// --- 模型请求/响应 ---

export interface HookModelBeforeRequestEvent {
  type: 'model:beforeRequest';
  timestamp: string;
  sessionId: string;
  providerId: string;
  modelId: string;
  messages: unknown[];
  tools: unknown[];
  stream: boolean;
}

export interface HookModelAfterResponseEvent {
  type: 'model:afterResponse';
  timestamp: string;
  sessionId: string;
  providerId: string;
  modelId: string;
  status: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  error?: string;
}

// --- 子智能体 ---

export interface HookSubagentStartEvent {
  type: 'subagent:start';
  timestamp: string;
  sessionId: string;
  subagentId: string;
  taskDescription: string;
  parentToolCallId?: string;
}

export interface HookSubagentEndEvent {
  type: 'subagent:end';
  timestamp: string;
  sessionId: string;
  subagentId: string;
  taskDescription: string;
  resultSummary?: string;
  turnCount: number;
  error?: string;
}

// --- 上下文压缩 ---

export interface HookCompactionBeforeEvent {
  type: 'compaction:before';
  timestamp: string;
  sessionId: string;
  tokensBefore: number;
  reason: string;
}

export interface HookCompactionAfterEvent {
  type: 'compaction:after';
  timestamp: string;
  sessionId: string;
  tokensBefore: number;
  tokensAfter: number;
  compressedMessageCount: number;
  summary: string;
}

// --- 错误事件 ---

export interface HookErrorOccurredEvent {
  type: 'error:occurred';
  timestamp: string;
  sessionId: string;
  errorCode: string;
  errorMessage: string;
  category: 'transient' | 'permanent' | 'security' | 'protocol';
  source: 'tool' | 'model' | 'plugin' | 'internal' | 'user';
  retryable: boolean;
  context?: Record<string, unknown>;
}

export interface HookErrorResolvedEvent {
  type: 'error:resolved';
  timestamp: string;
  sessionId: string;
  errorCode: string;
  resolution: 'retry-succeeded' | 'fallback' | 'user-input' | 'ignored';
  durationMs: number;
}

export type CrishHookEvent =
  | HookSessionStartEvent
  | HookSessionEndEvent
  | HookTurnStartEvent
  | HookTurnEndEvent
  | HookToolBeforeEvent
  | HookToolAfterEvent
  | HookModelBeforeRequestEvent
  | HookModelAfterResponseEvent
  | HookSubagentStartEvent
  | HookSubagentEndEvent
  | HookCompactionBeforeEvent
  | HookCompactionAfterEvent
  | HookErrorOccurredEvent
  | HookErrorResolvedEvent;

export type HookEventName = CrishHookEvent['type'];

/** 事件名到事件类型的映射 */
export interface HookEventMap {
  'session:start': HookSessionStartEvent;
  'session:end': HookSessionEndEvent;
  'turn:start': HookTurnStartEvent;
  'turn:end': HookTurnEndEvent;
  'tool:before': HookToolBeforeEvent;
  'tool:after': HookToolAfterEvent;
  'model:beforeRequest': HookModelBeforeRequestEvent;
  'model:afterResponse': HookModelAfterResponseEvent;
  'subagent:start': HookSubagentStartEvent;
  'subagent:end': HookSubagentEndEvent;
  'compaction:before': HookCompactionBeforeEvent;
  'compaction:after': HookCompactionAfterEvent;
  'error:occurred': HookErrorOccurredEvent;
  'error:resolved': HookErrorResolvedEvent;
}
```

### 4.2 HookBus 主类

```typescript
// packages/plugin-hooks/src/bus.ts

import type { HookEventName, HookEventMap, CrishHookEvent } from './events';

export interface HookHandlerRegistration {
  id: string;
  pluginName: string;
  eventName: HookEventName;
  handlerType: 'sync' | 'async' | 'command' | 'webhook';
  handler: (event: any) => void | Promise<void>;
  priority: number;
  mode: 'serial' | 'parallel';
  timeoutMs: number;
  failStrategy: 'fail-open' | 'fail-close';
}

export type HookInterceptor = (
  event: CrishHookEvent,
  next: (event: CrishHookEvent) => Promise<void>
) => Promise<void>;

/**
 * HookBus — 核心事件总线，参考 Grok 的 dispatcher.rs 设计
 *
 * 职责：
 * - 管理所有钩子处理器注册
 * - 按事件名派发事件
 * - 支持串行/并行执行模式
 * - 超时控制
 * - 故障策略（fail-open / fail-close）
 * - 拦截器链（用于信任门控、日志、监控）
 */
export class HookBus {
  private handlers: Map<HookEventName, HookHandlerRegistration[]> = new Map();
  private interceptors: HookInterceptor[] = [];

  constructor() {}

  // ========== 注册 ==========

  /**
   * 注册钩子处理器
   */
  register(registration: HookHandlerRegistration): void {
    const existing = this.handlers.get(registration.eventName) || [];
    existing.push(registration);
    existing.sort((a, b) => a.priority - b.priority);
    this.handlers.set(registration.eventName, existing);
  }

  /**
   * 注销钩子处理器
   */
  unregister(id: string): void {
    for (const [eventName, handlers] of this.handlers) {
      const filtered = handlers.filter((h) => h.id !== id);
      if (filtered.length !== handlers.length) {
        this.handlers.set(eventName, filtered);
      }
    }
  }

  /**
   * 按插件名注销所有处理器
   */
  unregisterPlugin(pluginName: string): void {
    for (const [eventName, handlers] of this.handlers) {
      const filtered = handlers.filter((h) => h.pluginName !== pluginName);
      if (filtered.length !== handlers.length) {
        this.handlers.set(eventName, filtered);
      }
    }
  }

  /**
   * 添加拦截器（在处理器之前执行）
   */
  addInterceptor(interceptor: HookInterceptor): void {
    this.interceptors.push(interceptor);
  }

  // ========== 派发 ==========

  /**
   * 派发事件到所有已注册的处理器
   *
   * 执行流程：
   * 1. 运行拦截器链
   * 2. 按优先级排序处理器
   * 3. 按 mode 分组：串行组依次等待，并行组并发执行
   * 4. 每个处理器有独立超时
   * 5. 根据 failStrategy 决定整体行为
   */
  async emit<N extends HookEventName>(event: HookEventMap[N]): Promise<void> {
    const dispatcher = new HookDispatcher(
      event,
      this.handlers.get(event.type as HookEventName) || []
    );
    await this.runInterceptors(event, async () => {
      await dispatcher.dispatch();
    });
  }

  private async runInterceptors(
    event: CrishHookEvent,
    final: () => Promise<void>
  ): Promise<void> {
    const chain = [
      ...this.interceptors,
      (_event: CrishHookEvent, next: () => Promise<void>) => next(),
    ];
    let index = 0;
    const run = async (e: CrishHookEvent): Promise<void> => {
      if (index < chain.length) {
        const interceptor = chain[index++];
        await interceptor(e, run);
      } else {
        await final();
      }
    };
    await run(event);
  }
}
```

### 4.3 派发器

```typescript
// packages/plugin-hooks/src/dispatcher.ts

export interface DispatchResult {
  eventName: string;
  totalHandlers: number;
  succeeded: number;
  failed: number;
  timedOut: number;
  totalDurationMs: number;
  errors: Array<{ handlerId: string; error: string }>;
}

export class HookDispatcher {
  constructor(
    private event: CrishHookEvent,
    private handlers: HookHandlerRegistration[]
  ) {}

  async dispatch(): Promise<DispatchResult> {
    const startTime = Date.now();
    const serialHandlers = this.handlers.filter((h) => h.mode === 'serial');
    const parallelHandlers = this.handlers.filter((h) => h.mode === 'parallel');

    const errors: Array<{ handlerId: string; error: string }> = [];
    let succeeded = 0;
    let failed = 0;
    let timedOut = 0;

    // 1. 串行组 — 顺序执行，前一个完成后才执行下一个
    for (const handler of serialHandlers) {
      const result = await this.runHandler(handler);
      if (result.status === 'success') succeeded++;
      else if (result.status === 'timeout') timedOut++;
      else failed++;
      if (result.error)
        errors.push({ handlerId: handler.id, error: result.error });

      // fail-close: 如果处理器失败且策略为 fail-close，终止后续执行
      if (result.status === 'error' && handler.failStrategy === 'fail-close') {
        break;
      }
    }

    // 2. 并行组 — 并发执行
    if (parallelHandlers.length > 0) {
      const results = await Promise.allSettled(
        parallelHandlers.map((h) => this.runHandler(h))
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          if (result.value.status === 'success') succeeded++;
          else if (result.value.status === 'timeout') timedOut++;
          else failed++;
          if (result.value.error)
            errors.push({
              handlerId: result.value.handlerId,
              error: result.value.error,
            });
        } else {
          failed++;
          errors.push({
            handlerId: 'unknown',
            error: result.reason?.message ?? 'Unknown error',
          });
        }
      }
    }

    return {
      eventName: this.event.type,
      totalHandlers: this.handlers.length,
      succeeded,
      failed,
      timedOut,
      totalDurationMs: Date.now() - startTime,
      errors,
    };
  }

  private async runHandler(
    handler: HookHandlerRegistration
  ): Promise<{
    status: 'success' | 'error' | 'timeout';
    handlerId: string;
    error?: string;
  }> {
    try {
      const result = await withTimeout(
        handler.handler(this.event),
        handler.timeoutMs
      );
      return { status: 'success', handlerId: handler.id };
    } catch (err) {
      if (err instanceof TimeoutError) {
        return {
          status: 'timeout',
          handlerId: handler.id,
          error: `Handler timed out after ${handler.timeoutMs}ms`,
        };
      }
      return {
        status: 'error',
        handlerId: handler.id,
        error: (err as Error).message,
      };
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return promise;
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(`Timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([promise.finally(() => clearTimeout(timer!)), timeout]);
}
```

---

## 5. 插件 SDK: packages/plugin-sdk

**重构后的目录结构**:

```
packages/plugin-sdk/src/
  index.ts              # 导出 definePlugin, PluginAPI
  api.ts                # PluginAPI 实现（传给插件的 API 对象）
  types.ts              # 插件开发者看到的类型（PluginModule, PluginContext）
  define.ts             # definePlugin() 辅助函数
```

### 5.1 插件入口模块类型

```typescript
// packages/plugin-sdk/src/types.ts

/**
 * 插件开发者需要实现的模块接口。
 * 参考 Pi 的 ExtensionFactory 和 Kimi Code 的 plugin 设计。
 */
export interface PluginModule {
  /** 插件被激活时调用（此时所有 API 可用）*/
  activate?(api: PluginAPI): void | Promise<void>;

  /** 插件被停用时调用 */
  deactivate?(api: PluginAPI): void | Promise<void>;

  /** 插件热重载通知 */
  onReload?(): void | Promise<void>;

  /** 配置变更通知 */
  onConfigChange?(changes: Record<string, unknown>): void | Promise<void>;
}

/**
 * 插件上下文，在运行时传递给插件的各类处理器
 *
 * 参考 Pi 的 ExtensionContext 设计，但更轻量
 */
export interface PluginContext {
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  traceId?: string;
  metadata?: Record<string, unknown>;
}
```

### 5.2 PluginAPI（插件开发者看到的 API）

```typescript
// packages/plugin-sdk/src/api.ts

/**
 * PluginAPI — 框架注入给插件的全部能力。
 *
 * 参考:
 * - Pi 的 ExtensionAPI (事件订阅 + 工具注册 + 命令)
 * - Kimi Code 的 PluginManager (MCP + 技能)
 * - Grok 的 HookAPI (钩子派发 + HTTP 处理程序)
 */
export class PluginAPI {
  constructor(
    private pluginName: string,
    private hookBus: HookBus,
    private toolRegistry: ToolRegistry,
    private mcpManager: McpManager,
    private skillLoader: SkillLoader,
    private config: Record<string, unknown>
  ) {}

  // ==========================================================================
  // 钩子订阅
  // ==========================================================================

  /**
   * 订阅钩子事件。自动关联到当前插件，在插件停用时自动清理。
   */
  on<N extends HookEventName>(
    event: N,
    handler: (
      event: HookEventMap[N],
      ctx: PluginContext
    ) => void | Promise<void>,
    options?: {
      priority?: number;
      mode?: 'serial' | 'parallel';
      timeoutMs?: number;
      failStrategy?: 'fail-open' | 'fail-close';
    }
  ): void {
    this.hookBus.register({
      id: `${this.pluginName}:${event}`,
      pluginName: this.pluginName,
      eventName: event,
      handlerType: 'async',
      handler: handler as (event: any) => void | Promise<void>,
      priority: options?.priority ?? 100,
      mode: options?.mode ?? 'parallel',
      timeoutMs: options?.timeoutMs ?? 5000,
      failStrategy: options?.failStrategy ?? 'fail-open',
    });
  }

  /**
   * 一次性订阅（触发一次后自动取消）
   */
  once<N extends HookEventName>(
    event: N,
    handler: (
      event: HookEventMap[N],
      ctx: PluginContext
    ) => void | Promise<void>
  ): void {}

  // ==========================================================================
  // 工具注册
  // ==========================================================================

  /**
   * 注册自定义工具
   */
  registerTool(tool: ToolDefinition): void {
    this.toolRegistry.register({
      ...tool,
      pluginName: this.pluginName,
      source: `${this.pluginName}::${tool.name}`,
    });
  }

  /**
   * 注销自定义工具
   */
  unregisterTool(toolName: string): void {
    this.toolRegistry.unregister(`${this.pluginName}::${toolName}`);
  }

  // ==========================================================================
  // MCP 服务器注册
  // ==========================================================================

  /**
   * 注册 MCP 服务器配置
   */
  registerMcpServer(server: PluginMcpServerDeclaration): void {
    this.mcpManager.register(this.pluginName, server);
  }

  /**
   * 获取 MCP 工具列表（来自所有已连接的 MCP 服务器）
   */
  async getMcpTools(): Promise<ToolDefinition[]> {
    return this.mcpManager.listTools();
  }

  // ==========================================================================
  // 技能
  // ==========================================================================

  /**
   * 注册技能目录
   */
  registerSkillPath(skillPath: string): void {
    this.skillLoader.addSkillPath(this.pluginName, skillPath);
  }

  /**
   * 获取已发现的技能列表
   */
  getSkills(): SkillDefinition[] {
    return this.skillLoader.getSkillsForPlugin(this.pluginName);
  }

  // ==========================================================================
  // 配置
  // ==========================================================================

  /**
   * 获取插件配置
   */
  getConfig<T = unknown>(key: string, defaultValue?: T): T | undefined {
    return (this.config as any)?.[key] ?? defaultValue;
  }

  /**
   * 监听配置变化
   */
  onConfigChange(handler: (changes: Record<string, unknown>) => void): void {}

  // ==========================================================================
  // 日志
  // ==========================================================================

  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    meta?: Record<string, unknown>
  ): void {
    // 通过 Crish 的内部日志系统输出，会带上 [plugin:<name>] 前缀
  }

  // ==========================================================================
  // 权限查询
  // ==========================================================================

  /**
   * 检查当前插件是否有指定权限
   */
  hasPermission(permission: PluginPermission): boolean {}

  /**
   * 请求用户授予额外权限
   */
  async requestPermission(permission: PluginPermission): Promise<boolean> {}

  // ==========================================================================
  // 存储
  // ==========================================================================

  /**
   * 插件专属的持久化存储 KV
   */
  async getStorageItem<T = unknown>(key: string): Promise<T | undefined> {}
  async setStorageItem<T = unknown>(key: string, value: T): Promise<void> {}
  async removeStorageItem(key: string): Promise<void> {}
  async clearStorage(): Promise<void> {}
}
```

### 5.3 definePlugin

````typescript
// packages/plugin-sdk/src/define.ts

/**
 * 插件定义辅助函数。
 *
 * 用法：
 * ```typescript
 * // my-plugin/src/index.ts
 * import { definePlugin } from "@crish/plugin-sdk";
 *
 * export default definePlugin({
 *   activate(api) {
 *     api.on("tool:before", (event, ctx) => {
 *       api.log("info", `Tool ${event.toolName} starting`, { toolCallId: event.toolCallId });
 *     });
 *
 *     api.registerTool({
 *       name: "my-tool",
 *       description: "我的自定义工具",
 *       parameters: { type: "object", properties: { input: { type: "string" } } },
 *       execute: async (input, ctx) => {
 *         return { text: `Hello from plugin! Input was: ${input.input}` };
 *       }
 *     });
 *   },
 *   deactivate(api) {
 *     api.log("info", "Plugin deactivated");
 *   }
 * });
 * ```
 */
export function definePlugin(module: PluginModule): PluginModule {
  return module;
}
````

---

## 6. MCP 集成: packages/plugin-mcp

**目录结构**:

```
packages/plugin-mcp/src/
  index.ts              # 导出 McpManager
  manager.ts            # MCP 服务器生命周期管理
  transport/            # 多传输协议实现
    stdio.ts
    http.ts
    sse.ts
    websocket.ts
  oauth.ts              # OAuth 授权流
  types.ts              # MCP 相关类型
```

### 6.1 McpManager

```typescript
// packages/plugin-mcp/src/manager.ts

export interface McpServerInstance {
  pluginName: string;
  declaration: PluginMcpServerDeclaration;
  transport: IMcpTransport;
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  tools: ToolDefinition[];
  startedAt?: string;
  error?: string;
}

/**
 * MCP 服务器生命周期管理器
 *
 * 参考 Grok 的 xai-grok-mcp 设计：
 * - 服务器基于插件声明启动
 * - 多传输支持
 * - OAuth 授权流
 * - 工具列表自动同步
 */
export class McpManager {
  private servers: Map<string, McpServerInstance> = new Map();
  private transportFactory: TransportFactory;

  constructor() {
    this.transportFactory = new TransportFactory();
  }

  /**
   * 注册 MCP 服务器（由插件 activate 时调用）
   */
  async register(
    pluginName: string,
    declaration: PluginMcpServerDeclaration
  ): Promise<void> {
    const id = `${pluginName}:${declaration.name}`;
    if (this.servers.has(id)) {
      await this.stop(id);
    }
    const transport = this.transportFactory.create(declaration);
    this.servers.set(id, {
      pluginName,
      declaration,
      transport,
      status: 'stopped',
      tools: [],
    });
  }

  /**
   * 启动 MCP 服务器
   */
  async start(id: string): Promise<void> {
    const server = this.servers.get(id);
    if (!server) throw new McpServerNotFoundError(id);
    server.status = 'starting';
    try {
      await server.transport.connect();
      server.status = 'running';
      server.startedAt = new Date().toISOString();
      const toolsResult = await server.transport.listTools();
      server.tools = toolsResult.tools.map((t) => ({
        ...t,
        mcpServerId: id,
        pluginName: server.pluginName,
      }));
    } catch (err) {
      server.status = 'error';
      server.error = (err as Error).message;
      throw err;
    }
  }

  /**
   * 停止 MCP 服务器
   */
  async stop(id: string): Promise<void> {
    const server = this.servers.get(id);
    if (!server || server.status === 'stopped') return;
    server.status = 'stopping';
    try {
      await server.transport.disconnect();
    } finally {
      server.status = 'stopped';
    }
  }

  /**
   * 启动插件的所有 MCP 服务器
   */
  async startAllForPlugin(pluginName: string): Promise<void> {
    for (const [id, server] of this.servers) {
      if (server.pluginName === pluginName && server.status === 'stopped') {
        await this.start(id);
      }
    }
  }

  /**
   * 停止插件的所有 MCP 服务器
   */
  async stopAllForPlugin(pluginName: string): Promise<void> {
    for (const [id, server] of this.servers) {
      if (
        server.pluginName === pluginName &&
        (server.status === 'running' || server.status === 'error')
      ) {
        await this.stop(id);
      }
    }
  }

  /**
   * 列出所有可用的 MCP 工具
   */
  listTools(): ToolDefinition[] {
    const all: ToolDefinition[] = [];
    for (const server of this.servers.values()) {
      if (server.status === 'running') {
        all.push(...server.tools);
      }
    }
    return all;
  }

  /** 注销插件所有服务器 */
  async unregisterPlugin(pluginName: string): Promise<void> {
    await this.stopAllForPlugin(pluginName);
    for (const [id, server] of this.servers) {
      if (server.pluginName === pluginName) {
        this.servers.delete(id);
      }
    }
  }
}

// packages/plugin-mcp/src/oauth.ts

export interface OAuthFlow {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  redirectPort?: number;
}

/**
 * MCP OAuth 授权管理器
 *
 * 参考 Grok 的 OAuth 流设计，支持：
 * - Authorization Code 流
 * - 本地 Server 接收回调
 * - Token 刷新
 */
export class McpOAuthManager {
  async performOAuthFlow(
    config: PluginMcpServerDeclaration['oauth'],
    serverName: string
  ): Promise<OAuthCredentials> {
    if (!config) throw new McpOAuthError('No OAuth config provided');
    // 1. 启动本地 HTTP 服务监听回调
    // 2. 打开浏览器进行授权
    // 3. 接收授权码
    // 4. 换取 Access Token
    // 5. 返回凭据
  }

  async refreshToken(
    credentials: OAuthCredentials
  ): Promise<OAuthCredentials> {}
}

export interface OAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
}
```

### 6.2 传输实现骨架

```typescript
// packages/plugin-mcp/src/transport/stdio.ts

export interface IMcpTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listTools(): Promise<{ tools: ToolDefinition[] }>;
  callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  ping(): Promise<boolean>;
}

export class StdioTransport implements IMcpTransport {
  constructor(
    private command: string,
    private args: string[],
    private env?: Record<string, string>
  ) {}

  private process?: ChildProcess;
  private messageId = 0;
  private pending = new Map<number, { resolve: Function; reject: Function }>();

  async connect(): Promise<void> {
    // spawn 子进程
    // 建立 JSON-RPC 双向通信
  }

  async disconnect(): Promise<void> {
    this.process?.kill();
    this.process = undefined;
  }

  async listTools(): Promise<{ tools: ToolDefinition[] }> {
    return this.sendRequest('tools/list', {});
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.sendRequest('tools/call', { name, arguments: args });
  }

  async ping(): Promise<boolean> {
    return this.sendRequest('ping', {});
  }

  private async sendRequest(method: string, params: unknown): Promise<any> {
    const id = ++this.messageId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process?.stdin?.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          params,
        }) + '\n'
      );
    });
  }
}
```

---

## 7. 技能系统: packages/plugin-skills

**目录结构**:

```
packages/plugin-skills/src/
  index.ts              # 导出 SkillLoader
  loader.ts             # 技能加载器
  parser.ts             # SKILL.md 解析器
  converter.ts          # 技能→工具/钩子转换器
  types.ts              # 技能相关类型
```

### 7.1 技能类型

```typescript
// packages/plugin-skills/src/types.ts

/**
 * 技能定义，从 SKILL.md 解析而来。
 *
 * 参考 Codex CLI (.codex/skills/ 格式) 和 Kimi Code (.agents/skills/ 格式)
 */
export interface SkillDefinition {
  name: string;
  description: string;
  /** 技能目录的绝对路径 */
  rootDir: string;
  /** 源插件名（如果是插件提供的技能）*/
  pluginName?: string;
  /** 指令内容（从 SKILL.md 提取）*/
  instructions: string;
  /** 目录结构: agents/, scripts/, prompts/ 等子目录的绝对路径 */
  agentsDir?: string;
  scriptsDir?: string;
  promptsDir?: string;
  /** 技能导出的工具 */
  tools?: ToolDefinition[];
  /** 技能注册的钩子 */
  hooks?: PluginHookBinding[];
  /** 依赖的其他技能名 */
  dependsOn?: string[];
  /** 实验性标志要求 */
  experimentalFlags?: string[];
}

export interface SkillDiscoveryResult {
  skills: SkillDefinition[];
  errors: Array<{ path: string; error: string }>;
}
```

### 7.2 SKILL.md 解析

````typescript
// packages/plugin-skills/src/parser.ts

/**
 * SKILL.md 文件解析器
 *
 * 支持格式标准（参考 Codex CLI 的 SKILL.md + Kimi Code 的 skill 系统）：
 *
 * ```markdown
 * # Skill Name
 *
 * 技能描述...
 *
 * ## Agents
 * - agent-name: 简短描述
 *
 * ## Scripts
 * - script-name: 简短描述
 *
 * ## Prompts
 * - prompt-name: 简短描述
 *
 * ## Tools
 * - tool-name: 工具描述
 *
 * ## Hooks
 * - session:start: 钩子处理说明
 * - tool:before: 钩子处理说明
 * ```
 */
export class SkillMarkdownParser {
  /**
   * 解析 SKILL.md 文件
   */
  async parse(filePath: string): Promise<SkillDefinition> {
    const content = await readFile(filePath, 'utf-8');
    return this.parseContent(content, path.dirname(filePath));
  }

  parseContent(content: string, rootDir: string): SkillDefinition {
    const frontmatter = this.extractFrontmatter(content);
    const body = this.stripFrontmatter(content);

    return {
      name: frontmatter.name ?? this.extractTitle(body),
      description: frontmatter.description ?? this.extractDescription(body),
      rootDir,
      instructions: body,
      agentsDir: this.findSubdirectory(rootDir, 'agents'),
      scriptsDir: this.findSubdirectory(rootDir, 'scripts'),
      promptsDir: this.findSubdirectory(rootDir, 'prompts'),
      tools: this.parseToolsSection(body, rootDir),
      hooks: this.parseHooksSection(body),
      dependsOn: frontmatter.dependsOn,
      experimentalFlags: frontmatter.experimentalFlags,
    };
  }

  private extractFrontmatter(content: string): Record<string, any> {
    const match = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (!match) return {};
    const frontmatter: Record<string, any> = {};
    for (const line of match[1].split('\n')) {
      const [key, ...rest] = line.split(':');
      if (key && rest.length > 0) {
        frontmatter[key.trim()] = rest.join(':').trim();
      }
    }
    return frontmatter;
  }

  private extractTitle(body: string): string {
    const match = body.match(/^#\s+(.+)/m);
    return match ? match[1].trim() : 'Unnamed Skill';
  }

  private extractDescription(body: string): string {
    const afterTitle = body.replace(/^#\s+.+\n/, '').trim();
    const firstPara = afterTitle.split(/\n\n/)[0];
    return firstPara
      .replace(/^##\s+.*$/m, '')
      .trim()
      .slice(0, 200);
  }

  private parseToolsSection(body: string, rootDir: string): ToolDefinition[] {
    // 从 ## Tools 部分提取工具定义
    return [];
  }

  private parseHooksSection(body: string): PluginHookBinding[] {
    // 从 ## Hooks 部分提取钩子绑定
    return [];
  }

  private findSubdirectory(rootDir: string, name: string): string | undefined {
    const dir = path.join(rootDir, name);
    return fs.existsSync(dir) ? dir : undefined;
  }
}
````

### 7.3 技能加载器

```typescript
// packages/plugin-skills/src/loader.ts

/**
 * 技能加载器 — 负责发现、解析 SKILL.md、将技能注册到系统
 */
export class SkillLoader {
  private skills: Map<string, SkillDefinition> = new Map();
  private pluginSkillPaths: Map<string, string[]> = new Map();
  private parser = new SkillMarkdownParser();

  /**
   * 插件声明技能路径
   */
  addSkillPath(pluginName: string, skillPath: string): void {
    const paths = this.pluginSkillPaths.get(pluginName) || [];
    paths.push(skillPath);
    this.pluginSkillPaths.set(pluginName, paths);
  }

  /**
   * 移除插件的技能路径
   */
  removePluginSkills(pluginName: string): void {
    const paths = this.pluginSkillPaths.get(pluginName) || [];
    for (const skillPath of paths) {
      this.skills.delete(skillPath);
    }
    this.pluginSkillPaths.delete(pluginName);
  }

  /**
   * 扫描所有已注册的技能路径
   */
  async loadAll(): Promise<SkillDiscoveryResult> {
    const errors: Array<{ path: string; error: string }> = [];
    for (const [pluginName, paths] of this.pluginSkillPaths) {
      for (const skillPath of paths) {
        try {
          const skill = await this.loadSingle(skillPath, pluginName);
          this.skills.set(skillPath, skill);
        } catch (err) {
          errors.push({ path: skillPath, error: (err as Error).message });
        }
      }
    }
    return { skills: [...this.skills.values()], errors };
  }

  private async loadSingle(
    skillDir: string,
    pluginName?: string
  ): Promise<SkillDefinition> {
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      throw new SkillNotFoundError(`SKILL.md not found in ${skillDir}`);
    }
    const skill = await this.parser.parse(skillMdPath);
    skill.pluginName = pluginName;
    return skill;
  }

  /**
   * 获取插件的技能列表
   */
  getSkillsForPlugin(pluginName: string): SkillDefinition[] {
    const paths = this.pluginSkillPaths.get(pluginName) || [];
    return paths
      .map((p) => this.skills.get(p))
      .filter(Boolean) as SkillDefinition[];
  }

  /**
   * 获取所有技能
   */
  getAllSkills(): SkillDefinition[] {
    return [...this.skills.values()];
  }

  /**
   * 按名称查找技能
   */
  getByName(name: string): SkillDefinition | undefined {
    for (const skill of this.skills.values()) {
      if (skill.name === name) return skill;
    }
    return undefined;
  }
}
```

### 7.4 技能 → 工具转换器

```typescript
// packages/plugin-skills/src/converter.ts

/**
 * 将技能转换为工具和钩子注册。
 *
 * 参考 Codex CLI: 每个技能目录可以包含 agents/ 和 scripts/，
 * 系统自动将它们注册为 LLM 可调用的工具。
 */
export class SkillToToolConverter {
  /**
   * 将技能目录下的 agents/ 和 scripts/ 转换为工具定义
   */
  convertToTools(skill: SkillDefinition): ToolDefinition[] {
    const tools: ToolDefinition[] = [];

    // agents/ 目录下的子目录 → agent 工具
    if (skill.agentsDir) {
      const agentDirs = fs
        .readdirSync(skill.agentsDir)
        .filter((name) =>
          fs.statSync(path.join(skill.agentsDir!, name)).isDirectory()
        );
      for (const agentDir of agentDirs) {
        tools.push(this.agentDirToTool(skill, agentDir));
      }
    }

    // scripts/ 目录下的 .sh/.ps1 文件 → shell 工具
    if (skill.scriptsDir) {
      const scriptFiles = fs
        .readdirSync(skill.scriptsDir)
        .filter((name) => name.endsWith('.sh') || name.endsWith('.ps1'));
      for (const script of scriptFiles) {
        tools.push(this.scriptFileToTool(skill, script));
      }
    }

    return tools;
  }

  private agentDirToTool(
    skill: SkillDefinition,
    agentName: string
  ): ToolDefinition {
    return {
      name: `skill:${skill.name}:${agentName}`,
      description: `Execute ${agentName} agent from skill ${skill.name}`,
      category: 'agent',
      execute: async (input, ctx) => {
        // 将请求转发给 AgentOrchestrator 启动子 agent
        return { text: `Agent ${agentName} execution...` };
      },
    };
  }

  private scriptFileToTool(
    skill: SkillDefinition,
    scriptFile: string
  ): ToolDefinition {
    const scriptPath = path.join(skill.scriptsDir!, scriptFile);
    const name = path.basename(scriptFile, path.extname(scriptFile));
    return {
      name: `skill:${skill.name}:${name}`,
      description: `Run script ${scriptFile} from skill ${skill.name}`,
      category: 'shell',
      execute: async (input, ctx) => {
        // 执行脚本并返回结果
        return { text: `Script ${scriptFile} execution...` };
      },
    };
  }
}
```

---

## 8. 工具发现与注册

### 8.1 ToolRegistry（增强现有 ToolDiscoveryIndex）

```typescript
// 已有: packages/shared-types/src/tool.ts 定义了 ToolDefinition
// 增强点在 agent-runtime 或 plugin-registry 中

export interface RegisteredTool extends ToolDefinition {
  pluginName: string;
  source: string; // "plugin:<name>::<tool>" | "builtin:<name>"
  requiredPermissions?: PluginPermission[];
  category?: ToolCategory;
  concurrency?: ToolConcurrency;
}

export class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();

  register(tool: RegisteredTool): void {
    const existing = this.tools.get(tool.name);
    if (existing) {
      throw new ToolConflictError(
        `Tool "${tool.name}" already registered by ${existing.pluginName}`,
        { existing: existing.source, incoming: tool.source }
      );
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  unregisterPlugin(pluginName: string): void {
    for (const [name, tool] of this.tools) {
      if (tool.pluginName === pluginName) {
        this.tools.delete(name);
      }
    }
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  list(filter?: {
    category?: ToolCategory;
    pluginName?: string;
  }): RegisteredTool[] {
    const all = [...this.tools.values()];
    if (!filter) return all;
    return all.filter((t) => {
      if (filter.category && t.category !== filter.category) return false;
      if (filter.pluginName && t.pluginName !== filter.pluginName) return false;
      return true;
    });
  }

  /**
   * 模糊搜索工具（BM25，参考 Crish 现有 ToolDiscoveryIndex）
   */
  search(query: string): Array<{ tool: RegisteredTool; score: number }> {
    const normalized = query.toLowerCase();
    const results: Array<{ tool: RegisteredTool; score: number }> = [];
    for (const tool of this.tools.values()) {
      const score = this.computeRelevance(tool, normalized);
      if (score > 0) {
        results.push({ tool, score });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  private computeRelevance(tool: RegisteredTool, query: string): number {
    let score = 0;
    const nameLower = tool.name.toLowerCase();
    const descLower = tool.description.toLowerCase();
    if (nameLower === query) score += 100;
    if (nameLower.includes(query)) score += 50;
    if (descLower.includes(query)) score += 20;
    return score;
  }
}
```

---

## 9. 插件生命周期管理

### 9.1 生命周期状态机

```typescript
// packages/plugin-registry/src/lifecycle.ts

/**
 * 插件生命周期状态转换图:
 *
 * discovered
 *   │
 *   ▼
 * installing ──error──► error
 *   │
 *   ▼
 * installed
 *   │
 *   ▼
 * loading ──error──► error
 *   │
 *   ▼
 * loaded
 *   │
 *   ▼
 * activating ──error──► error
 *   │
 *   ▼
 * active ◄─────────────┐
 *   │                   │
 *   ├──► deactivating   │ (reload)
 *   │      │            │
 *   │      ▼            │
 *   │   inactive ───────┤
 *   │                   │
 *   └──► uninstalling   │
 *          │            │
 *          ▼            │
 *       uninstalled ────┘
 */

export class PluginLifecycleManager {
  constructor(
    private registry: PluginRegistry,
    private hookBus: HookBus,
    private toolRegistry: ToolRegistry,
    private mcpManager: McpManager,
    private skillLoader: SkillLoader
  ) {}

  async activate(id: string, api: PluginAPI): Promise<void> {
    const runtime = this.registry.get(id);
    if (!runtime) throw new PluginNotFoundError(id);
    if (runtime.state !== 'loaded' && runtime.state !== 'inactive') {
      throw new PluginStateError(id, runtime.state, 'activate');
    }

    runtime.state = 'activating';
    try {
      // 1. 启动 MCP 服务器
      await this.mcpManager.startAllForPlugin(id);

      // 2. 加载技能
      for (const skillDef of runtime.manifest.skills ?? []) {
        const absolutePath = path.resolve(runtime.rootDir, skillDef.path);
        this.skillLoader.addSkillPath(id, absolutePath);
      }
      await this.skillLoader.loadAll();

      // 3. 调用插件的 activate()
      if (runtime.module?.activate) {
        await runtime.module.activate(api);
      }

      // 4. 注册声明式钩子
      for (const hookBinding of runtime.manifest.hooks ?? []) {
        this.registerDeclarativeHook(runtime, hookBinding);
      }

      // 5. 注册声明式工具
      for (const toolDef of runtime.manifest.tools ?? []) {
        this.toolRegistry.register({
          ...toolDef,
          pluginName: id,
          source: `plugin:${id}::${toolDef.name}`,
        });
      }

      runtime.state = 'active';
    } catch (err) {
      runtime.state = 'error';
      runtime.error = (err as Error).message;
      throw err;
    }
  }

  async deactivate(id: string): Promise<void> {
    const runtime = this.registry.get(id);
    if (!runtime) throw new PluginNotFoundError(id);
    if (runtime.state !== 'active') return;

    runtime.state = 'deactivating';
    try {
      // 1. 调用插件的 deactivate()
      if (runtime.module?.deactivate) {
        await runtime.module.deactivate(null as any);
      }

      // 2. 注销钩子
      this.hookBus.unregisterPlugin(id);

      // 3. 注销工具
      this.toolRegistry.unregisterPlugin(id);

      // 4. 停止 MCP 服务器
      await this.mcpManager.stopAllForPlugin(id);

      // 5. 卸载技能
      this.skillLoader.removePluginSkills(id);

      runtime.state = 'inactive';
    } catch (err) {
      runtime.state = 'error';
      runtime.error = (err as Error).message;
      throw err;
    }
  }

  async reload(id: string): Promise<void> {
    const runtime = this.registry.get(id);
    if (!runtime) throw new PluginNotFoundError(id);

    const wasActive = runtime.state === 'active';
    if (wasActive) {
      await this.deactivate(id);
    }

    // 清除模块缓存，重新加载
    delete require.cache[
      require.resolve(
        path.join(
          runtime.rootDir,
          runtime.manifest.entrypoints?.main ?? 'index.js'
        )
      )
    ];
    runtime.module = await this.loadModule(runtime);
    runtime.state = 'loaded';

    if (wasActive) {
      await this.activate(id, this.createAPI(runtime));
    }
  }

  private registerDeclarativeHook(
    runtime: PluginRuntime,
    binding: PluginHookBinding
  ): void {
    if (binding.handlerType === 'command') {
      this.hookBus.register({
        id: `${runtime.id}:hook:${binding.event}:${binding.command}`,
        pluginName: runtime.id,
        eventName: binding.event as HookEventName,
        handlerType: 'command',
        handler: async (event) => {
          await this.runCommandHook(binding.command!, event);
        },
        priority: 100,
        mode: binding.mode ?? 'parallel',
        timeoutMs: binding.timeoutMs ?? 30000,
        failStrategy: binding.failStrategy ?? 'fail-open',
      });
    } else if (binding.handlerType === 'webhook') {
      this.hookBus.register({
        id: `${runtime.id}:hook:${binding.event}:${binding.url}`,
        pluginName: runtime.id,
        eventName: binding.event as HookEventName,
        handlerType: 'webhook',
        handler: async (event) => {
          await this.callWebhook(binding.url!, event);
        },
        priority: 100,
        mode: binding.mode ?? 'parallel',
        timeoutMs: binding.timeoutMs ?? 10000,
        failStrategy: binding.failStrategy ?? 'fail-open',
      });
    }
  }

  private async runCommandHook(command: string, event: any): Promise<void> {
    const env = { ...process.env, CRISH_EVENT: JSON.stringify(event) };
    const proc = spawn(command, [], { env, shell: true, stdio: 'inherit' });
    return new Promise((resolve, reject) => {
      proc.on('exit', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Command exited with ${code}`))
      );
      proc.on('error', reject);
    });
  }

  private async callWebhook(url: string, event: any): Promise<void> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    if (!response.ok) {
      throw new Error(`Webhook returned ${response.status}`);
    }
  }

  private async loadModule(
    runtime: PluginRuntime
  ): Promise<PluginModule | undefined> {
    const mainEntry = runtime.manifest.entrypoints?.main;
    if (!mainEntry) return undefined;
    const mainPath = path.resolve(runtime.rootDir, mainEntry);
    const mod = await import(mainPath);
    return mod.default ?? mod;
  }

  private createAPI(runtime: PluginRuntime): PluginAPI {
    return new PluginAPI(
      runtime.id,
      this.hookBus,
      this.toolRegistry,
      this.mcpManager,
      this.skillLoader,
      {} // 插件配置
    );
  }
}
```

### 9.2 版本兼容性与依赖检查

```typescript
// packages/plugin-registry/src/resolver.ts

import { satisfies } from 'semver';

export class PluginDependencyResolver {
  constructor(private registry: PluginRegistry) {}

  /**
   * 解析依赖图谱，检测循环依赖和版本冲突
   *
   * @returns 拓扑排序的依赖链（从根依赖到目标）
   */
  resolve(
    manifest: PluginManifest,
    allPlugins: Map<string, PluginRuntime>
  ): PluginManifest[] {
    const visited = new Set<string>();
    const sorted: PluginManifest[] = [];
    const visiting = new Set<string>();

    const visit = (
      name: string,
      version: string,
      deps: Record<string, string> | undefined
    ) => {
      if (visiting.has(name)) {
        throw new CircularDependencyError(
          `Circular dependency detected: ${name}`
        );
      }
      if (visited.has(name)) return;
      visiting.add(name);

      const existing = allPlugins.get(name);
      if (existing) {
        if (!satisfies(existing.manifest.version, deps?.[name] ?? '*')) {
          throw new DependencyVersionError(
            `Plugin ${name}@${existing.manifest.version} does not satisfy ${deps?.[name]}`
          );
        }
      }

      for (const [depName, depRange] of Object.entries(deps ?? {})) {
        const depPlugin = allPlugins.get(depName);
        if (depPlugin) {
          visit(
            depName,
            depPlugin.manifest.version,
            depPlugin.manifest.dependencies
          );
        } else {
          throw new MissingDependencyError(
            `Missing dependency: ${depName}@${depRange}`
          );
        }
      }

      visiting.delete(name);
      visited.add(name);
      sorted.unshift(manifest); // 拓扑保证依赖先于依赖者
    };

    visit(manifest.name, manifest.version, manifest.dependencies);
    return sorted;
  }

  /**
   * 检查 engineVersion 兼容性
   */
  checkEngineCompatibility(
    manifest: PluginManifest,
    currentVersion: string
  ): boolean {
    if (!manifest.engineVersion) return true;
    return satisfies(currentVersion, manifest.engineVersion);
  }
}
```

---

## 10. 信任与权限模型

### 10.1 信任门控

```typescript
// packages/plugin-hooks/src/trust.ts

/**
 * 信任门控系统。
 *
 * 参考 Grok 的 trust.rs 门控设计：
 * - 每个插件需要用户显式授权信任级别
 * - 信任级别决定哪些权限自动授予
 * - 特权操作需要审批
 */
export class TrustGate {
  private trustedPlugins: Map<string, TrustGrant> = new Map();

  constructor(private store: PluginStore) {}

  /**
   * 请求信任插件
   */
  async requestTrust(
    pluginName: string,
    manifest: PluginManifest,
    ui: { confirm: (title: string, message: string) => Promise<boolean> }
  ): Promise<boolean> {
    const existing = this.trustedPlugins.get(pluginName);
    if (existing?.granted) return true;

    const trustLevel = manifest.trustLevel ?? 'sandboxed';
    const permissions = manifest.permissions ?? [];

    const granted = await ui.confirm(
      `Trust "${pluginName}"?`,
      this.buildTrustMessage(pluginName, trustLevel, permissions)
    );

    if (granted) {
      this.trustedPlugins.set(pluginName, {
        pluginName,
        trustLevel,
        granted: true,
        permissionsGranted: permissions,
        grantedAt: new Date().toISOString(),
      });
      await this.store.setTrustGranted(pluginName, true);
    }

    return granted;
  }

  /**
   * 检查插件是否有执行操作的权限
   */
  checkPermission(pluginName: string, permission: PluginPermission): boolean {
    const grant = this.trustedPlugins.get(pluginName);
    if (!grant?.granted) return false;
    if (grant.trustLevel === 'full') return true;
    return grant.permissionsGranted.includes(permission);
  }

  private buildTrustMessage(
    name: string,
    level: PluginTrustLevel,
    permissions: PluginPermission[]
  ): string {
    const lines = [
      `Plugin: ${name}`,
      `Trust Level: ${level}`,
      `Requested Permissions: ${permissions.join(', ') || 'none'}`,
    ];
    if (level === 'full') {
      lines.push('WARNING: Full trust gives the plugin unrestricted access.');
    }
    return lines.join('\n');
  }
}

interface TrustGrant {
  pluginName: string;
  trustLevel: PluginTrustLevel;
  granted: boolean;
  permissionsGranted: PluginPermission[];
  grantedAt: string;
}
```

---

## 11. 热重载与开发体验

```typescript
// packages/plugin-registry/src/hot-reload.ts

/**
 * 插件热重载服务
 *
 * 参考 Codex CLI 和 Kimi Code 的开发体验设计：
 * - 文件变更监听
 * - 增量重载
 * - 状态保持
 */
export class HotReloadService {
  private watchers: Map<string, FSWatcher> = new Map();
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    private lifecycle: PluginLifecycleManager,
    private registry: PluginRegistry
  ) {}

  /**
   * 对指定插件目录启动文件监听
   */
  watch(id: string): void {
    const runtime = this.registry.get(id);
    if (!runtime) return;

    // 停止已有 watcher
    this.unwatch(id);

    const watcher = fs.watch(
      runtime.rootDir,
      { recursive: true },
      (eventType, filename) => {
        // 防抖：文件变更频繁时合并触发
        const existing = this.debounceTimers.get(id);
        if (existing) clearTimeout(existing);

        this.debounceTimers.set(
          id,
          setTimeout(async () => {
            try {
              await this.lifecycle.reload(id);
            } catch (err) {
              console.error(`[HotReload] Failed to reload plugin ${id}:`, err);
            }
          }, 300)
        );
      }
    );

    this.watchers.set(id, watcher);
  }

  /**
   * 停止监听
   */
  unwatch(id: string): void {
    const watcher = this.watchers.get(id);
    if (watcher) {
      watcher.close();
      this.watchers.delete(id);
    }
    const timer = this.debounceTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(id);
    }
  }

  /**
   * 停止所有监听
   */
  unwatchAll(): void {
    for (const id of this.watchers.keys()) {
      this.unwatch(id);
    }
  }
}
```

---

## 12. 插件的 AGENTS.md 集成

每个插件可以在其根目录下包含 `AGENTS.md`，描述该插件的能力、工具和钩子约定，使 AI 编码助理在开发该插件时获得上下文。

### 12.1 标准插件目录结构

```
~/.crish/plugins/my-plugin/
  crish.plugin.json           # PluginManifest
  AGENTS.md                   # AI 辅助开发指南（可选）
  src/
    index.ts                  # 插件入口（export default definePlugin(...)）
  skills/                     # 技能目录（可选）
    my-skill/
      SKILL.md
      agents/
        sub-agent/
          AGENTS.md
      scripts/
        deploy.sh
  prompts/                    # 提示词模板（可选）
  dist/                       # 编译产物
```

### 12.2 标准 Manifest 文件命名

支持两种 manifest 文件布局：

1. **单文件布局**（推荐）: `crish.plugin.json` 放在插件根目录
2. **目录布局**: `.crish-plugin/plugin.json` 放在插件根目录内

```typescript
// 示例 crish.plugin.json
{
  "name": "@crish/example-mcp",
  "version": "1.0.0",
  "displayName": "Example MCP Plugin",
  "description": "一个示例 MCP 集成插件",
  "author": { "name": "Crish Team" },
  "license": "MIT",
  "entrypoints": {
    "main": "dist/index.js"
  },
  "trustLevel": "restricted",
  "permissions": [
    "file:read",
    "network:connect"
  ],
  "hooks": [
    {
      "event": "session:start",
      "handlerType": "async",
      "mode": "parallel",
      "timeoutMs": 5000,
      "failStrategy": "fail-open"
    },
    {
      "event": "tool:before",
      "handlerType": "webhook",
      "url": "http://localhost:9090/hooks/tool-before"
    }
  ],
  "tools": [
    {
      "name": "example-search",
      "description": "通过示例 API 搜索",
      "parameters": {
        "type": "object",
        "properties": {
          "query": { "type": "string", "description": "搜索关键词" }
        },
        "required": ["query"]
      },
      "requiredPermissions": ["network:connect"]
    }
  ],
  "mcpServers": [
    {
      "name": "example-db",
      "transport": "stdio",
      "command": "node",
      "args": ["dist/mcp-server.js"],
      "envKeys": ["EXAMPLE_API_KEY"]
    }
  ],
  "skills": [
    { "path": "skills/my-skill" }
  ],
  "engineVersion": ">=0.1.0",
  "keywords": ["mcp", "example", "database"]
}
```

---

## 附录 A: 实施路线图

### Phase 1 (基础) — 当前 sprint

| 步骤 | 包              | 文件                | 工作量                                      |
| ---- | --------------- | ------------------- | ------------------------------------------- |
| 1    | shared-types    | `src/plugin.ts`     | 定义 PluginManifest, PluginOrigin, 所有类型 |
| 2    | plugin-registry | `src/validator.ts`  | manifest 校验器                             |
| 3    | plugin-registry | `src/discoverer.ts` | 多源发现（user-dir + project-dir 优先）     |
| 4    | plugin-registry | `src/store.ts`      | JSON 文件持久化                             |

### Phase 2 (钩子系统)

| 步骤 | 包           | 文件                | 工作量                  |
| ---- | ------------ | ------------------- | ----------------------- |
| 5    | plugin-hooks | `src/events.ts`     | 14 个事件类型定义       |
| 6    | plugin-hooks | `src/bus.ts`        | HookBus 注册/派发       |
| 7    | plugin-hooks | `src/dispatcher.ts` | 串行/并行/超时/故障策略 |
| 8    | plugin-hooks | `src/trust.ts`      | 信任门控                |

### Phase 3 (SDK)

| 步骤 | 包              | 文件               | 工作量         |
| ---- | --------------- | ------------------ | -------------- |
| 9    | plugin-sdk      | `src/api.ts`       | PluginAPI      |
| 10   | plugin-sdk      | `src/define.ts`    | definePlugin   |
| 11   | plugin-registry | `src/installer.ts` | 安装/更新/卸载 |
| 12   | plugin-registry | `src/resolver.ts`  | 依赖解析       |

### Phase 4 (MCP + 技能)

| 步骤 | 包            | 文件                 | 工作量                   |
| ---- | ------------- | -------------------- | ------------------------ |
| 13   | plugin-mcp    | `src/manager.ts`     | MCP 生命周期             |
| 14   | plugin-mcp    | `src/transport/*.ts` | stdio/HTTP/SSE/WebSocket |
| 15   | plugin-mcp    | `src/oauth.ts`       | OAuth 授权               |
| 16   | plugin-skills | `src/parser.ts`      | SKILL.md 解析            |
| 17   | plugin-skills | `src/loader.ts`      | 技能加载                 |
| 18   | plugin-skills | `src/converter.ts`   | 技能→工具转换            |

### Phase 5 (开发者体验)

| 步骤 | 包              | 文件                | 工作量   |
| ---- | --------------- | ------------------- | -------- |
| 19   | plugin-registry | `src/hot-reload.ts` | 热重载   |
| 20   | plugin-sdk      | 示例插件            | 发布示例 |

---

## 附录 B: 错误类型

```typescript
// 新增错误类型（扩展 shared-types）

export class PluginError extends CrishError {
  constructor(
    message: string,
    code: string,
    metadata?: Record<string, unknown>
  ) {
    super(message, code, 'permanent', false, metadata);
    this.name = 'PluginError';
  }
}

export class PluginNotFoundError extends PluginError {
  constructor(id: string) {
    super(`Plugin not found: ${id}`, 'plugin:not-found');
  }
}

export class PluginStateError extends PluginError {
  constructor(id: string, current: PluginState, expected: string) {
    super(
      `Plugin ${id} is in state ${current}, expected ${expected}`,
      'plugin:invalid-state',
      { current, expected }
    );
  }
}

export class PluginInstallError extends PluginError {
  constructor(message: string) {
    super(message, 'plugin:install-failed');
  }
}

export class PluginDependencyError extends PluginError {
  constructor(message: string) {
    super(message, 'plugin:dependency-error');
  }
}

export class CircularDependencyError extends PluginError {
  constructor(message: string) {
    super(message, 'plugin:circular-dependency');
  }
}

export class DependencyVersionError extends PluginError {
  constructor(message: string) {
    super(message, 'plugin:dependency-version-mismatch');
  }
}

export class MissingDependencyError extends PluginError {
  constructor(message: string) {
    super(message, 'plugin:missing-dependency');
  }
}

export class ToolConflictError extends PluginError {
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message, 'plugin:tool-conflict', metadata);
  }
}

export class McpServerNotFoundError extends PluginError {
  constructor(id: string) {
    super(`MCP server not found: ${id}`, 'plugin:mcp-server-not-found');
  }
}

export class McpOAuthError extends PluginError {
  constructor(message: string) {
    super(message, 'plugin:mcp-oauth-error');
  }
}

export class SkillNotFoundError extends PluginError {
  constructor(message: string) {
    super(message, 'plugin:skill-not-found');
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}
```
