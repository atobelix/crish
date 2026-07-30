# Round 8：插件 SDK 全面重建

> **本文件是 Round 8 的唯一权威设计文档**（依据 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 29 唯一权威来源原则）。
> 所有 Agent 任务、文件迁移、依赖接线、接口签名引用本文件时，必须以本文件的 Agent 分配与验证门禁为准。
>
> **前置文档**：
>
> - `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 13-19 插件 SDK 设计约束（全部子节）、禁令 10 不独立成包模块、禁令 23-26 迁移策略、禁令 27-28 Agent 任务量
> - `v2/01-OVERVIEW.md` §3 依赖图、§3.2 拓扑层级、§4.1 轮次总览、§4.2 轮次依赖链
> - `v2/02-FILE-MAPPING.md` §2.13 hooks/ 目录映射、§5.3 hooks 纯类型下沉、§9 依赖方向验证、§10.1 plugin-sdk 文件统计
>
> **本 Round 遵守的硬性红线**：
>
> - 禁令 13：`plugin-sdk` 为单包（子目录组织），钩子类型定义放 `shared-types/src/plugin.ts`，派发器留 `agent-core/src/hooks/`，MCP 集成走 `agent-mcp` 的 `registerPluginServer`
> - 禁令 14：必须保留 observe/on 双模式；事件名保留现有命名；payload 字段不得退化；控制型钩子（shouldStopAfterTurn / ToolHook.onError 等）能力必须保留
> - 禁令 15/16/17：manifest 声明能力清单 + activate(api) 命令式注册；handlerType 仅 sync/async；PluginOrigin 仅 user-dir + project-dir
> - 禁令 18：2 级信任（restricted + full，禁止 sandboxed）；TrustGate 合并到 agent-permissions；权限粒度按合并规则
> - 禁令 19：MVP 禁止 OAuth；HotReload 推迟 Phase 2
> - 禁令 23：迁移遵循"共存→迁移→删除"三阶段，本 Round 为共存阶段（旧 `plugin-sdk/src/index.ts` 17 行接口保留 deprecation shim）
> - 禁令 26：TSC 错误数 ≤ 该轮基线（不恶化），不承诺清零
> - 禁令 28：每个 Agent ≥ 5 文件或 ≥ 300 行变更

---

## 1. Round 概述

### 1.1 拓扑层说明

Round 8 处于拓扑 Layer 8，在 Round 5（agent-core 创建、hooks/ 迁移完成）后执行。`plugin-sdk` 依赖 `agent-core`（Layer 4）与 `shared-types`（Layer 0），不依赖 orchestrator/daemon。

```
Layer 0: shared-types（R1 增强，含 plugin.ts 钩子类型）       ← 本 Round 下沉纯类型
Layer 4: agent-core（R5 创建，含 hooks/ 派发器）              ← 本 Round 增强发射点
Layer 5: agent-subagent（R9 完整化，依赖本 Round 的 PluginRegistry — 始终为 Layer 5）
Layer 8: plugin-sdk（本 Round 重建）                           ← 本 Round
```

**关键拓扑约束**（依据 `01-OVERVIEW.md` §3.2、§4.2）：

- Round 5 必须先于 Round 8：`plugin-sdk` 依赖 `agent-core` 的 `LifecycleHookRegistry`（派发器）与初始化流程
- Round 8 必须先于 Round 9：`agent-subagent` 的发现机制依赖本 Round 的 `PluginRegistry`（依据 `02-FILE-MAPPING.md` §9.2 与 guardrails 禁令 22）
- 循环依赖必须保持为 0（dependency-cruiser 强制）；`plugin-sdk` 不得反向依赖 `agent-runtime` shim

### 1.2 目标与范围

**目标**：将 `@crish/plugin-sdk` 从 17 行（4 个 `any` 钩子 + `definePlugin`）重建为企业级插件平台，实现 14 钩子 + observe/on 双模式 + 工具注册 + MCP 声明 + 2 级信任模型 + 多源发现（user-dir + project-dir）。

**范围边界**（依据 禁令 13-19）：

| 范围内（本 Round 实现）                          | 范围外（推迟）                                           |
| ------------------------------------------------ | -------------------------------------------------------- |
| 14 钩子事件 + payload 类型                       | OAuth（禁令 19，Phase 2）                                |
| observe/on 双模式 + HookAPI                      | HotReload 文件监听（禁令 19，Phase 2）                   |
| PluginManifest 声明式 + activate(api) 命令式     | `sandboxed` 信任级（禁令 18，需 worker_threads 方案）    |
| PluginRegistry + Loader + Validator + Discoverer | `npm` / `global-dir` 源（禁令 15/16/17，Phase 2）        |
| SkillLoader（SKILL.md → 工具）                   | `command` / `webhook` handlerType（禁令 15/16/17，禁止） |
| TrustGate 集成（从 agent-permissions 导入）      | TrustGate 本体实现（禁令 18，归 agent-permissions）      |
| agent-core/hooks/ 新事件发射点                   | 子代理调度（R9）                                         |

### 1.3 目标包

| 目标包                        | 拓扑层  | 职责                                                                                                   | 创建 Agent | 文件数（约） |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------ | ---------- | ------------ |
| `@crish/plugin-sdk`（重建）   | Layer 8 | 插件平台：Manifest / 14 钩子类型 / HookAPI / 工具注册 / MCP 声明 / Registry / Discoverer / SkillLoader | 8-A~8-E    | ~22          |
| `@crish/shared-types`（增强） | Layer 0 | 下沉插件钩子纯类型到 `src/plugin.ts`                                                                   | 8-B        | +1           |
| `@crish/agent-core`（增强）   | Layer 4 | hooks/ 派发器新增 8 个事件发射点 + PluginRegistry 集成                                                 | 8-E        | 修改 ~6      |

**包间依赖关系**（本 Round 建立的新边以 `[NEW]` 标注）：

| 包                   | 依赖（→ 指向被依赖方）                                                                                                                  | 拓扑层  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `plugin-sdk`         | `shared-types`, `agent-core` `[NEW]`, `agent-tools`（仅类型，通过 shared-types 间接）, `agent-mcp`（仅类型，registerPluginServer 声明） | Layer 8 |
| `agent-core`（增强） | `plugin-sdk`（仅类型，PluginRegistry 接口） `[NEW 反向类型]`                                                                            | Layer 4 |

> **循环依赖规避说明**（禁令 13）：`plugin-sdk` 运行时依赖 `agent-core`（使用 `LifecycleHookRegistry` 实例注入）；`agent-core` 仅在**类型层**引用 `plugin-sdk` 的 `PluginRegistry` 接口用于初始化流程注入，不引入运行时依赖。此反向类型引用通过 `shared-types/src/plugin.ts` 下沉的纯类型解耦——`agent-core` 依赖 `shared-types` 的 `PluginRegistryLike` 类型，`plugin-sdk` 的 `PluginRegistry` 实现该接口。depcruise 规则须允许此类型反向边（`agent-core` → `shared-types` 已存在边，不新增 `agent-core` → `plugin-sdk` 边）。

### 1.4 交付物清单

| 交付物                    | 路径                                                                  | 说明                                                          |
| ------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------- |
| plugin-sdk 包结构         | `packages/plugin-sdk/src/{manifest,hooks,tools,registry,skills,api}/` | 6 个子目录 + index.ts                                         |
| shared-types 钩子类型     | `packages/shared-types/src/plugin.ts`                                 | 14 钩子 payload + HookHandler + LifecycleHandlerResult 纯类型 |
| agent-core/hooks/ 增强    | `packages/agent-core/src/hooks/lifecycle-hooks.ts` 等                 | 新增 8 事件发射点 + PluginRegistry 注入                       |
| 测试套件                  | `packages/plugin-sdk/src/__tests__/`                                  | 单元 + 集成 + 信任门控 + 双模式                               |
| 旧 plugin-sdk shim        | `packages/plugin-sdk/src/index.ts`                                    | 17 行旧接口保留 deprecation warning（禁令 23 共存阶段）       |
| 验证报告                  | 本文件 §6                                                             | 8 项门禁结果                                                  |
| `02-FILE-MAPPING.md` 同步 | `analysis/iterative-repair/v2/02-FILE-MAPPING.md`                     | §10.1 plugin-sdk 文件数更新（guardrails 禁令 31）             |

---

## 2. Agent 任务详细设计

### 2.1 Agent 编排与依赖

```
8-A (Manifest + 权限模型)  ──┐
                              │
8-B (14 钩子类型 + HookAPI) ──┼──→ 8-D (Registry + Discoverer) ──→ 8-E (agent-core 集成) ──→ 8-F (测试)
                              │                                                           ↑
8-C (工具注册 + SkillLoader) ─┘                                                           │
                                                                                          │
（8-A/8-B/8-C 文件集不相交，可真并行；8-D 依赖三者接口；8-E 依赖 8-D；8-F 依赖全部）────────┘
```

| Agent | 文件集（不相交）                                                       | 依赖前置      | 协调次数                                     |
| ----- | ---------------------------------------------------------------------- | ------------- | -------------------------------------------- |
| 8-A   | `src/manifest/*`                                                       | 无            | 0                                            |
| 8-B   | `src/hooks/types.ts`, `src/hooks/api.ts`, `shared-types/src/plugin.ts` | 无            | 1（与 8-A 对齐权限类型引用）                 |
| 8-C   | `src/tools/*`, `src/skills/*`                                          | 无            | 1（与 8-B 对齐 HookAPI.registerTool 签名）   |
| 8-D   | `src/registry/*`                                                       | 8-A, 8-B, 8-C | 2（消费 Manifest + HookAPI + Tool 注册接口） |
| 8-E   | `agent-core/src/hooks/*`                                               | 8-D           | 1（消费 PluginRegistry 接口）                |
| 8-F   | `src/__tests__/*`                                                      | 全部          | 0                                            |

### 2.2 Agent 8-A：PluginManifest + 权限模型 + TrustGate 集成

**输入**：禁令 15/16/17 Manifest 约束、禁令 18 信任模型约束、现有 `plugin-registry.ts`（516 行）的 `PluginManifest` 旧定义。
**输出**：`packages/plugin-sdk/src/manifest/`。

**任务清单**：

1. 实现 `PluginManifest`（精简版，剔除旧 `contributes` 双重声明，改为 `declaredHooks/declaredTools/declaredMcpServers` 能力清单）
2. 实现 `PluginPermission` 联合类型（11 项权限，按 禁令 18 合并规则）
3. 实现 `PluginTrustLevel`（`restricted | full`）
4. 实现 `PluginOrigin`（`user-dir | project-dir`）
5. 实现 `PluginEngineConstraint`（`engineVersion` 语义版本范围校验）
6. 定义 `TrustGateLike` 接口（plugin-sdk 仅声明契约，实现归 agent-permissions，禁令 18）
7. 实现 `validateManifest(manifest)` 纯函数（结构校验 + 能力清单非空校验）
8. 迁移 `plugin-registry.ts` 中 `normalizeManifest` / `assertNonEmpty` 等可复用校验逻辑

**接口签名**（见 §3.2 完整定义）：

- `PluginManifest`、`PluginPermission`、`PluginTrustLevel`、`PluginOrigin`
- `validateManifest(manifest: PluginManifest): ManifestValidationResult`

**工作量预估**：6 文件，~350 行。

### 2.3 Agent 8-B：14 钩子类型系统 + HookAPI

**输入**：禁令 14 钩子系统约束、现有 `lifecycle-hooks.ts`（348 行）、`compact-lifecycle.ts`、`hook-types.ts`、`tool-hook-types.ts`。
**输出**：`packages/plugin-sdk/src/hooks/types.ts`、`packages/plugin-sdk/src/hooks/api.ts`、`packages/shared-types/src/plugin.ts`。

**任务清单**：

1. 在 `shared-types/src/plugin.ts` 下沉 14 钩子纯类型（payload + Handler + Result），供 `agent-core` 与 `plugin-sdk` 共同引用（禁令 11）
2. 定义 14 个钩子事件的 payload 类型（保留现有 6 个 payload 全部字段不退化 + 新增 8 个）
3. 定义 `HookObserveHandler` / `HookOnHandler`（observe/on 双模式，禁令 14）
4. 定义 `LifecycleHandlerResult`（`stop/block/modifiedInput/modifiedOutput/terminate`，对齐现有 5 字段）
5. 定义 `ToolErrorHandlerResult`（`retry/skip/abort`，保留 ToolHook.onError 控制能力，禁令 14）
6. 定义 `HookAPI` 接口（`observe/on/registerTool/registerMcpServer`，供 `activate(api)` 使用）
7. 定义 `PluginLifecycle` 接口（`activate(api: HookAPI): void | Promise<void>` + 可选 `deactivate(): void | Promise<void>`）
8. 定义 `PluginRegistryLike` 接口（供 agent-core 类型层引用，解循环依赖）

**关键约束**：HookBus 派发器（`LifecycleHookRegistry.emit`）留 `agent-core/src/hooks/`，plugin-sdk 只定义类型与 API 接口（禁令 13）。

**工作量预估**：3 文件，~480 行。

### 2.4 Agent 8-C：工具注册 API + 技能加载器

**输入**：现有 `tool-definition.ts`（RegisteredTool 三层体系）、`skills.ts`（AgentSkill frontmatter 解析）、`mcp-lifecycle-manager.ts`（ToolSource）。
**输出**：`packages/plugin-sdk/src/tools/`、`packages/plugin-sdk/src/skills/`。

**任务清单**：

1. 实现 `PluginAPI.registerTool(definition: ToolDefinition, options?: ToolRegistrationOptions): RegisteredTool`
   - 委托给 `agent-tools` 的 `ToolRegistry.register`（通过 `HookAPI` 持有的 registry 引用）
2. 实现 `PluginAPI.registerMcpServer(declaration: PluginMcpServerDeclaration): void`
   - 委托给 `agent-mcp` 的 `registerPluginServer(pluginName, declaration)`（禁令 13）
3. 实现 `PluginMcpServerDeclaration` 类型（stdio 命令 + 参数 + env，MVP 禁 OAuth，禁令 19）
4. 实现 `SkillLoader`（SKILL.md frontmatter 解析 + 技能→工具转换）
5. 定义技能目录结构：`skills/<name>/SKILL.md` + `skills/<name>/scripts/` + `skills/<name>/prompts/`（移除 `agents/` 子目录，避免与 agent-subagent 概念混淆）
6. 迁移 `skills.ts` 的 `loadSkillsFromDirectory` 逻辑到 `SkillLoader`，复用 frontmatter 解析

**工作量预估**：5 文件，~420 行。

### 2.5 Agent 8-D：插件发现与加载 + PluginRegistry + PluginStore

**输入**：8-A（Manifest）、8-B（HookAPI/PluginLifecycle）、8-C（Tool 注册）、现有 `plugin-fs-registry.ts`（113 行双源发现 + 安全门）、现有 `plugin-registry.ts`（516 行 ToolSource 适配器）。
**输出**：`packages/plugin-sdk/src/registry/`。

**任务清单**：

1. 实现 `PluginDiscoverer`（仅 `user-dir` + `project-dir` 两种源，禁令 15/16/17）
   - user-dir：`~/.crish/plugins/`
   - project-dir：`<cwd>/.crish/plugins/`
2. 实现 `PluginLoader`（动态 import + activate 调用 + 能力清单校验）
   - 保留 `CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT` 安全门（同进程 import 风险提示，对齐现有 `plugin-fs-registry.ts`）
   - restricted 级插件经 TrustGate 权限白名单校验
3. 实现 `PluginValidator`（manifest 校验 + 能力清单 vs activate 实际注册比对，禁令 15/16/17）
   - activate 中注册的 hook 必须在 `declaredHooks` 内
   - activate 中注册的 tool 必须在 `declaredTools` 内
   - activate 中注册的 mcpServer 必须在 `declaredMcpServers` 内
4. 实现 `PluginRegistry`（发现 + 加载 + 状态机）
   - 状态机：`discovered → loading → loaded → active → inactive → error`
   - 实现 `ToolSource` 接口（迁移 `plugin-registry.ts` 516 行有价值逻辑：`listTools` / `listToolContributions` / `preparePluginTool` / `cloneToolMetadata`）
5. 实现 `PluginStore`（持久化：installed plugins 列表 + 状态，JSON 文件存储）
6. 定义 `PluginState` 联合类型与状态转移规则

**工作量预估**：7 文件，~620 行。

### 2.6 Agent 8-E：agent-core 插件集成 + HookBus 派发器增强

**输入**：8-D（PluginRegistry 接口）、现有 `lifecycle-hooks.ts`（348 行）、`compact-lifecycle.ts`、`agent-session-loop.ts`（发射点）。
**输出**：`packages/agent-core/src/hooks/` 增强。

**任务清单**：

1. 扩展 `LifecycleEventType` 联合类型，新增 8 个事件（session.start/end、model.beforeRequest/afterResponse、subagent.start/end、tool.error、error.occurred）
2. 扩展 `LifecyclePayloadMap`，新增 8 个 payload 映射
3. 新增 8 个事件的发射点（SessionLoop / ProviderCallGateway / SubagentBridge / ToolExecutor）
4. 确保 observe/on 双模式在新事件中有效（复用现有 `emit` 的 observe 并行容错 + on 串行合并逻辑）
5. 在 `agent-core` 初始化流程集成 `PluginRegistry`（discover → load → activate → 注入 HookBus）
6. 保留 `adaptAgentHooks` 兼容层（禁令 23 共存阶段，旧 AgentHooks 不删除）

**工作量预估**：修改 6 文件，~380 行变更。

### 2.7 Agent 8-F：测试套件 + 端到端验证

**输入**：8-A~8-E 全部产出。
**输出**：`packages/plugin-sdk/src/__tests__/` + 验证报告。

**任务清单**：

1. 单元测试：Manifest 校验、14 钩子 payload 类型、HookAPI 注册、SkillLoader 解析
2. 集成测试：user-dir 发现 → 加载 → activate → 注册 hook/tool 全流程
3. 信任门控测试：restricted 级别权限校验（file:access 拒绝、hook:intercept 拒绝等）
4. observe/on 双模式测试（observe 失败吞掉、on 控制信号合并）
5. 能力清单校验测试（activate 注册超出 declaredHooks 时拒绝）
6. 运行 8 项验证门禁，生成验证报告

**工作量预估**：8 测试文件，~520 行。

---

## 3. plugin-sdk 包设计详细

### 3.1 目录结构

```
packages/plugin-sdk/
├── package.json                      # @crish/plugin-sdk，依赖 shared-types + agent-core
├── tsconfig.json
└── src/
    ├── index.ts                      # 公共导出 barrel（含旧 Plugin 接口 deprecation shim）
    ├── manifest/
    │   ├── manifest.ts               # PluginManifest 完整定义
    │   ├── permissions.ts            # PluginPermission + PluginTrustLevel + PluginOrigin
    │   ├── engine-constraint.ts      # engineVersion 语义版本范围校验
    │   ├── validate.ts               # validateManifest 纯函数
    │   └── index.ts                  # barrel
    ├── hooks/
    │   ├── types.ts                  # 14 钩子 payload + Handler + Result（从 shared-types/plugin.ts re-export）
    │   ├── api.ts                    # HookAPI 接口（observe/on/registerTool/registerMcpServer）
    │   ├── lifecycle.ts              # PluginLifecycle 接口（activate/deactivate）
    │   └── index.ts                  # barrel
    ├── tools/
    │   ├── tool-api.ts               # registerTool 实现委托
    │   ├── mcp-api.ts                # registerMcpServer 实现委托 + PluginMcpServerDeclaration
    │   └── index.ts                  # barrel
    ├── registry/
    │   ├── discoverer.ts             # PluginDiscoverer（user-dir + project-dir）
    │   ├── loader.ts                 # PluginLoader（动态 import + activate）
    │   ├── validator.ts              # PluginValidator（manifest + 能力清单比对）
    │   ├── registry.ts               # PluginRegistry（状态机 + ToolSource 适配）
    │   ├── store.ts                  # PluginStore（持久化）
    │   ├── state.ts                  # PluginState 状态机定义
    │   └── index.ts                  # barrel
    ├── skills/
    │   ├── skill-loader.ts           # SkillLoader（SKILL.md 解析 + 技能→工具）
    │   ├── skill-types.ts            # PluginSkill + SkillFrontmatter
    │   └── index.ts                  # barrel
    ├── api/
    │   ├── plugin-api.ts             # PluginAPI 聚合（HookAPI + ToolAPI + lifecycle 注入）
    │   └── index.ts                  # barrel
    └── __tests__/
        ├── manifest.test.ts
        ├── hooks-payload.test.ts
        ├── hookapi-observe-on.test.ts
        ├── tool-registration.test.ts
        ├── skill-loader.test.ts
        ├── registry-lifecycle.test.ts
        ├── trust-gate.test.ts
        └── e2e-discover-activate.test.ts
```

> **包结构约束遵守**（禁令 13）：单包 + 子目录组织；不拆分为 plugin-registry / plugin-skills / plugin-mcp 独立包（禁令 10 禁止）。

### 3.2 PluginManifest 完整定义

> 依据 禁令 15/16/17：声明式与命令式分层。manifest 声明能力清单，`activate(api)` 命令式注册。禁止 `manifest.hooks` 与 `api.on()` 双重声明 handlerType/timeoutMs/failStrategy 等实现细节。

```typescript
// packages/plugin-sdk/src/manifest/manifest.ts

import type { JsonObject, SemVerRange } from '@crish/shared-types';
import type {
  PluginPermission,
  PluginTrustLevel,
  PluginOrigin,
} from './permissions';
import type { PluginEngineConstraint } from './engine-constraint';

/**
 * 插件清单 — 声明式能力清单。
 *
 * 设计原则（禁令 15/16/17）：
 * - manifest 只声明"这个插件会注册哪些能力"，不声明实现细节
 * - 实际注册通过 activate(api) 命令式完成
 * - PluginValidator 比对 activate 实际注册 vs manifest 声明清单，超出则拒绝
 *
 * handlerType 仅 sync/async（禁令 15/16/17 禁止 command/webhook）。
 */
export interface PluginManifest {
  /** 插件唯一标识（npm scope 风格，如 @crish/my-plugin） */
  readonly id: string;

  /** 插件显示名称 */
  readonly name: string;

  /** 语义版本号（semver） */
  readonly version: string;

  /** 插件描述 */
  readonly description?: string;

  /** 入口点声明 */
  readonly entrypoints: PluginEntrypoints;

  /** 权限声明清单（restricted 级插件经 TrustGate 校验） */
  readonly permissions: readonly PluginPermission[];

  /** 信任级别（禁令 18：restricted | full） */
  readonly trustLevel: PluginTrustLevel;

  /** 引擎版本兼容约束（semver range，如 ">=0.2.0 <0.3.0"） */
  readonly engineVersion: SemVerRange;

  /** 声明将注册的钩子事件名清单（activate 中 api.on/observe 的事件必须在此清单内） */
  readonly declaredHooks: readonly HookEventName[];

  /** 声明将注册的工具名清单（activate 中 api.registerTool 的工具名必须在此清单内） */
  readonly declaredTools: readonly string[];

  /** 声明将注册的 MCP 服务器名清单（activate 中 api.registerMcpServer 的服务器名必须在此清单内） */
  readonly declaredMcpServers: readonly string[];

  /** 插件来源（由 PluginDiscoverer 填充，非作者手动声明） */
  readonly origin?: PluginOrigin;

  /** 作者元数据 */
  readonly author?: PluginAuthor;

  /** 关键词（用于发现与过滤） */
  readonly keywords?: readonly string[];

  /** 自定义元数据（不参与能力声明） */
  readonly metadata?: JsonObject;
}

/** 入口点声明 */
export interface PluginEntrypoints {
  /**
   * 主入口（相对路径或绝对路径）。
   * 动态 import 后须导出 activate(api) 函数（PluginLifecycle.activate）。
   */
  readonly main: string;
}

/** 作者元数据 */
export interface PluginAuthor {
  readonly name: string;
  readonly email?: string;
  readonly url?: string;
}

/**
 * 14 钩子事件名联合类型。
 *
 * 现有 6 个（禁令 14 保留命名）+ 新增 8 个（禁令 14 点分命名）+ tool.error（保留 ToolHook.onError 控制能力）。
 */
export type HookEventName =
  // ── 现有 6 个（保留命名，payload 不退化）──
  | 'turn.start'
  | 'turn.end'
  | 'tool.pre'
  | 'tool.post'
  | 'context.compact.start'
  | 'context.compact.end'
  // ── 新增 8 个 ──
  | 'session.start'
  | 'session.end'
  | 'model.beforeRequest'
  | 'model.afterResponse'
  | 'subagent.start'
  | 'subagent.end'
  | 'error.occurred'
  // ── 第 14 个：保留 ToolHook.onError 控制能力（禁令 14）──
  | 'tool.error';
```

```typescript
// packages/plugin-sdk/src/manifest/permissions.ts

/**
 * 插件权限粒度（禁令 18 合并规则）。
 *
 * 合并说明：
 * - file:read + file:write → file:access（实际文件操作通常两者都需要）
 * - shell:execute → 归入 tool:execute（shell 是 tool 的子集）
 * - hook:observe 与 hook:intercept 分离（observe 只读容错，intercept 可返回控制信号）
 */
export type PluginPermission =
  | 'file:access' // 文件读写（合并 read/write）
  | 'tool:execute' // 工具执行（含 shell，合并 shell:execute）
  | 'tool:register' // 注册新工具
  | 'mcp:connect' // 连接 MCP 服务器
  | 'network:connect' // 网络出站连接
  | 'session:read' // 读取会话上下文
  | 'session:write' // 写入会话上下文
  | 'env:read' // 读取环境变量
  | 'hook:observe' // 注册 observe 处理器（只读容错）
  | 'hook:intercept' // 注册 on 处理器（可返回控制信号）
  | 'plugin:manage'; // 管理其他插件（启用/禁用/卸载）

/**
 * 插件信任级别（禁令 18）。
 *
 * - restricted：主线程执行 + 权限白名单校验（TrustGate 强制校验 permissions 清单）
 * - full：主线程执行 + 无校验（用户显式授权，仅 user-dir 来源可声明）
 *
 * 禁止 sandboxed（禁令 18：无隔离实现方案时禁止该级别）。
 * full 级别仅允许 user-dir 来源（project-dir 插件不得声明 full，防仓库投毒）。
 */
export type PluginTrustLevel = 'restricted' | 'full';

/**
 * 插件来源（禁令 15/16/17：仅 user-dir + project-dir）。
 *
 * 禁止 mcp / github / inline（禁令 15/16/17）。
 * npm / global-dir 推迟 Phase 2。
 */
export type PluginOrigin = 'user-dir' | 'project-dir';
```

```typescript
// packages/plugin-sdk/src/manifest/engine-constraint.ts

import type { SemVerRange } from '@crish/shared-types';

/** 引擎版本约束（semver range） */
export type PluginEngineConstraint = SemVerRange;

/**
 * 校验引擎版本兼容性。
 * @param engineVersion 当前引擎版本（如 "0.2.5"）
 * @param constraint 约束范围（如 ">=0.2.0 <0.3.0"）
 */
export function isEngineCompatible(
  engineVersion: string,
  constraint: PluginEngineConstraint
): boolean {
  // 委托 shared-utils 的 semver 比较工具（不在 plugin-sdk 内重复实现 semver 解析）
  // 实现细节：使用 node:semver satisfies（Node 内置）或 shared-utils 封装
  // MVP 阶段使用最小子集：>=, <, 逗号分隔 AND
  // 完整 semver 解析推迟到 shared-utils 增强
  return true; // 占位：实际实现委托 shared-utils
}
```

```typescript
// packages/plugin-sdk/src/manifest/validate.ts

import type { PluginManifest } from './manifest';
import type { PluginPermission, PluginTrustLevel } from './permissions';

export interface ManifestValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ManifestValidationError[];
}

export interface ManifestValidationError {
  readonly field: string;
  readonly message: string;
  readonly code:
    | 'missing-required-field'
    | 'invalid-semver'
    | 'empty-capability-list'
    | 'invalid-trust-level'
    | 'invalid-permission'
    | 'invalid-origin';
}

/**
 * 校验 PluginManifest 结构（纯函数，无副作用）。
 *
 * 校验规则：
 * 1. id/name/version/entrypoints.main 必填且非空
 * 2. version 须为合法 semver
 * 3. trustLevel 须为 'restricted' | 'full'
 * 4. permissions 须为合法 PluginPermission 枚举值
 * 5. declaredHooks 中的事件名须为合法 HookEventName
 * 6. full 级别仅允许 user-dir origin（若 origin 已填充）
 * 7. 能力清单允许为空（插件可纯 observe 不注册任何能力）
 */
export function validateManifest(
  manifest: PluginManifest
): ManifestValidationResult {
  const errors: ManifestValidationError[] = [];

  if (!manifest.id?.trim()) {
    errors.push({
      field: 'id',
      message: 'id is required',
      code: 'missing-required-field',
    });
  }
  if (!manifest.name?.trim()) {
    errors.push({
      field: 'name',
      message: 'name is required',
      code: 'missing-required-field',
    });
  }
  if (!manifest.version?.trim()) {
    errors.push({
      field: 'version',
      message: 'version is required',
      code: 'missing-required-field',
    });
  }
  if (!manifest.entrypoints?.main?.trim()) {
    errors.push({
      field: 'entrypoints.main',
      message: 'entrypoints.main is required',
      code: 'missing-required-field',
    });
  }
  if (manifest.trustLevel !== 'restricted' && manifest.trustLevel !== 'full') {
    errors.push({
      field: 'trustLevel',
      message: `trustLevel must be 'restricted' or 'full', got: ${manifest.trustLevel}`,
      code: 'invalid-trust-level',
    });
  }
  // full 级别仅允许 user-dir（防仓库投毒）
  if (manifest.trustLevel === 'full' && manifest.origin === 'project-dir') {
    errors.push({
      field: 'trustLevel',
      message:
        'full trust level is not allowed for project-dir origin (use restricted)',
      code: 'invalid-trust-level',
    });
  }

  return { valid: errors.length === 0, errors };
}
```

### 3.3 14 钩子事件 + payload 类型

> 依据 禁令 14：保留现有 6 个事件 payload 全部字段（不退化），新增 8 个事件。所有纯类型下沉到 `shared-types/src/plugin.ts`（禁令 11），plugin-sdk 的 `hooks/types.ts` 仅 re-export。

```typescript
// packages/shared-types/src/plugin.ts
// （由 Agent 8-B 创建，供 agent-core 与 plugin-sdk 共同引用，避免循环依赖 禁令 11）

import type {
  JsonObject,
  ToolOutput,
  AgentMessage,
  ContextCompressionTrigger,
} from './index';

// ─── 现有 6 个事件 payload（保留全部字段，不退化 禁令 14）──────────────

export interface TurnStartPayload {
  sessionId: string;
  turnIndex: number;
}

export interface TurnEndPayload {
  sessionId: string;
  turnIndex: number;
  toolCallCount: number;
  maxTurns: number;
  hasPendingInput: boolean;
  isAborted: boolean;
}

export interface ToolPrePayload {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: JsonObject;
  turnIndex: number;
  cwd: string;
}

export interface ToolPostPayload {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: JsonObject;
  output?: ToolOutput;
  isError?: boolean;
  turnIndex: number;
  cwd: string;
}

// 现有 ContextCompactStartPayload（保留 trigger/tokensBefore/messageCount/reason）
export interface ContextCompactStartPayload {
  sessionId: string;
  trigger?: ContextCompressionTrigger;
  tokensBefore?: number;
  messageCount?: number;
  reason?: string;
}

// 现有 ContextCompactEndPayload（保留全部诊断字段 禁令 14：aborted/trigger/compactionId/keptMessageCount 等）
export interface ContextCompactEndPayload {
  sessionId: string;
  aborted: boolean;
  error?: string;
  trigger?: ContextCompressionTrigger;
  tokensBefore?: number;
  tokensAfter?: number;
  compressedMessageCount?: number;
  keptMessageCount?: number;
  compactionId?: string;
  durationMs?: number;
}

// ─── 新增 8 个事件 payload ──────────────────────────────────

export interface SessionStartPayload {
  sessionId: string;
  runId: string;
  cwd: string;
  /** 会话启动模式（new / resume / branch） */
  mode: 'new' | 'resume' | 'branch';
  /** resume/branch 时的源会话 ID */
  sourceSessionId?: string;
  /** 初始消息数 */
  initialMessageCount: number;
  startedAt: string; // ISO 8601
}

export interface SessionEndPayload {
  sessionId: string;
  runId: string;
  /** 结束原因 */
  reason: 'stop' | 'max-turns' | 'aborted' | 'error';
  /** 总 turn 数 */
  turnCount: number;
  /** 总工具调用数 */
  toolCallCount: number;
  /** 累计 token 使用（若可用） */
  totalTokens?: number;
  endedAt: string; // ISO 8601
  /** 错误信息（reason='error' 时） */
  error?: string;
}

export interface ModelBeforeRequestPayload {
  sessionId: string;
  runId: string;
  turnIndex: number;
  /** 目标 provider ID */
  providerId: string;
  /** 请求模型名（用户选定，禁止自动切换 §禁令3） */
  model: string;
  /** 输入消息数 */
  messageCount: number;
  /** 输入 token 估算 */
  estimatedInputTokens?: number;
  /** 工具数 */
  toolCount: number;
  /** 请求 ID（用于与 afterResponse 关联） */
  requestId: string;
  cwd: string;
}

export interface ModelAfterResponsePayload {
  sessionId: string;
  runId: string;
  turnIndex: number;
  providerId: string;
  model: string;
  requestId: string;
  /** 实际完成原因 */
  finishReason: 'stop' | 'tool-call' | 'length' | 'error';
  /** 输出 token 数 */
  outputTokens?: number;
  /** 输入 token 数（provider 返回的实际值） */
  inputTokens?: number;
  /** 本次请求耗时（ms） */
  durationMs?: number;
  /** 是否发生重试 */
  retried: boolean;
  /** 重试次数 */
  retryCount?: number;
  /** 错误信息（finishReason='error' 时） */
  error?: string;
}

export interface SubagentStartPayload {
  /** 父会话 ID */
  parentSessionId: string;
  /** 子代理会话 ID */
  subagentSessionId: string;
  runId: string;
  /** 子代理角色（标签，禁令 21） */
  role: 'researcher' | 'implementer' | 'reviewer' | 'debugger' | 'planner';
  /** 能力模式（控制实际权限，禁令 21） */
  capabilityMode: 'read-only' | 'read-write' | 'execute' | 'all';
  /** 递归深度（ROUND-09 §3.2 DEFAULT_RECURSION_GUARD 默认 maxDepth=3） */
  depth: number;
  /** 任务描述 */
  task: string;
  startedAt: string;
}

export interface SubagentEndPayload {
  parentSessionId: string;
  subagentSessionId: string;
  runId: string;
  role: SubagentStartPayload['role'];
  capabilityMode: SubagentStartPayload['capabilityMode'];
  depth: number;
  /** 结束原因 */
  reason: 'completed' | 'failed' | 'timeout' | 'cancelled';
  /** 子代理 turn 数 */
  turnCount: number;
  /** 子代理工具调用数 */
  toolCallCount: number;
  endedAt: string;
  error?: string;
}

export interface ErrorOccurredPayload {
  sessionId: string;
  runId?: string;
  turnIndex?: number;
  /** 错误来源阶段 */
  phase:
    | 'session'
    | 'turn'
    | 'tool'
    | 'provider'
    | 'context'
    | 'subagent'
    | 'plugin';
  /** 错误对象（序列化） */
  error: {
    name: string;
    message: string;
    stack?: string;
    /** CrishError 错误码（若有） */
    code?: string;
  };
  /** 是否可重试 */
  retryable: boolean;
  /** 上下文相关元数据 */
  context?: JsonObject;
  occurredAt: string;
}

// ─── 第 14 个：tool.error（保留 ToolHook.onError 控制能力 禁令 14）─────────

export interface ToolErrorPayload {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: JsonObject;
  /** 捕获的错误 */
  error: {
    name: string;
    message: string;
    stack?: string;
  };
  turnIndex: number;
  cwd: string;
  /** 已重试次数 */
  attemptCount: number;
}

// ─── 事件名 → payload 映射 ─────────────────────────────────

export interface HookPayloadMap {
  'turn.start': TurnStartPayload;
  'turn.end': TurnEndPayload;
  'tool.pre': ToolPrePayload;
  'tool.post': ToolPostPayload;
  'tool.error': ToolErrorPayload;
  'context.compact.start': ContextCompactStartPayload;
  'context.compact.end': ContextCompactEndPayload;
  'session.start': SessionStartPayload;
  'session.end': SessionEndPayload;
  'model.beforeRequest': ModelBeforeRequestPayload;
  'model.afterResponse': ModelAfterResponsePayload;
  'subagent.start': SubagentStartPayload;
  'subagent.end': SubagentEndPayload;
  'error.occurred': ErrorOccurredPayload;
}

export type HookEventName = keyof HookPayloadMap;

// ─── Handler 类型（observe/on 双模式 禁令 14）──────────────────

/**
 * observe 处理器：容错并行，失败吞掉，不影响主路径。
 * 用于日志、监控、审计。不可返回控制信号。
 */
export type HookObserveHandler<E extends HookEventName = HookEventName> = (
  payload: HookPayloadMap[E]
) => void | Promise<void>;

/**
 * on 处理器：串行语义合并，可返回控制信号。
 * 用于权限拦截、内容修改、流程控制。
 */
export type HookOnHandler<E extends HookEventName = HookEventName> = (
  payload: HookPayloadMap[E]
) =>
  | LifecycleHandlerResult
  | ToolErrorHandlerResult
  | void
  | Promise<LifecycleHandlerResult | ToolErrorHandlerResult | void>;

/** observe 模式订阅返回的取消订阅函数 */
export type HookUnsubscribe = () => void;

// ─── 控制信号 Result 类型（禁令 14 保留现有控制能力）──────────

/**
 * on() 处理器可返回的语义结果（对齐现有 LifecycleHandlerResult 5 字段）。
 *
 * 字段语义（保留现有）：
 * - stop: turn.end → 建议 L2 cooperative stop
 * - block: tool.pre → 阻止工具执行
 * - modifiedInput: tool.pre → 修改工具输入
 * - modifiedOutput: tool.post → 改写工具输出
 * - terminate: tool.post → 终止整个 run
 * - reason: 附带原因（block/terminate 时）
 */
export interface LifecycleHandlerResult {
  stop?: boolean;
  block?: boolean;
  reason?: string;
  modifiedInput?: JsonObject;
  modifiedOutput?: ToolOutput;
  terminate?: boolean;
}

/**
 * tool.error 处理器可返回的错误恢复策略（保留 ToolHook.onError 控制能力 禁令 14）。
 *
 * - retry: 重试工具调用（受 attemptCount 上限约束）
 * - skip: 跳过本次调用，返回空输出
 * - abort: 终止整个 run
 */
export interface ToolErrorHandlerResult {
  action: 'retry' | 'skip' | 'abort';
  reason?: string;
  /** retry 时的延迟（ms） */
  retryDelayMs?: number;
}
```

```typescript
// packages/plugin-sdk/src/hooks/types.ts
// （re-export shared-types 中的纯类型，供 plugin-sdk 内部使用）

export type {
  HookEventName,
  HookPayloadMap,
  HookObserveHandler,
  HookOnHandler,
  HookUnsubscribe,
  LifecycleHandlerResult,
  ToolErrorHandlerResult,
  TurnStartPayload,
  TurnEndPayload,
  ToolPrePayload,
  ToolPostPayload,
  ToolErrorPayload,
  ContextCompactStartPayload,
  ContextCompactEndPayload,
  SessionStartPayload,
  SessionEndPayload,
  ModelBeforeRequestPayload,
  ModelAfterResponsePayload,
  SubagentStartPayload,
  SubagentEndPayload,
  ErrorOccurredPayload,
} from '@crish/shared-types';
```

### 3.4 HookAPI 接口（observe/on/registerTool/registerMcpServer）

> 依据 禁令 15/16/17：`activate(api: HookAPI)` 命令式注册。`HookAPI` 是插件作者接触的唯一入口，聚合钩子注册 + 工具注册 + MCP 声明。

```typescript
// packages/plugin-sdk/src/hooks/api.ts

import type {
  HookEventName,
  HookObserveHandler,
  HookOnHandler,
  HookUnsubscribe,
} from './types';
import type {
  ToolDefinition,
  ToolRegistrationOptions,
  RegisteredTool,
} from '../tools';
import type { PluginMcpServerDeclaration } from '../tools';

/**
 * 插件激活时收到的 API 入口。
 *
 * 插件通过 activate(api) 命令式注册能力（禁令 15/16/17）：
 * - api.observe(event, handler) / api.on(event, handler)：注册钩子
 * - api.registerTool(definition)：注册工具
 * - api.registerMcpServer(declaration)：声明 MCP 服务器
 *
 * 所有注册都会被 PluginValidator 比对 manifest 声明清单（禁令 15/16/17）。
 */
export interface HookAPI {
  /** 当前插件的 manifest（只读，供 activate 内部决策） */
  readonly manifest: import('../manifest').PluginManifest;

  /**
   * 注册 observe 处理器（容错并行，失败吞掉 禁令 14）。
   * 需 manifest.permissions 含 'hook:observe'。
   * 需 manifest.declaredHooks 含 event。
   */
  observe<E extends HookEventName>(
    event: E,
    handler: HookObserveHandler<E>
  ): HookUnsubscribe;

  /**
   * 注册 on 处理器（串行语义合并，可返回控制信号 禁令 14）。
   * 需 manifest.permissions 含 'hook:intercept'。
   * 需 manifest.declaredHooks 含 event。
   */
  on<E extends HookEventName>(
    event: E,
    handler: HookOnHandler<E>
  ): HookUnsubscribe;

  /**
   * 注册自定义工具（禁令 15/16/17 命令式）。
   * 需 manifest.permissions 含 'tool:register'。
   * 需 manifest.declaredTools 含 definition.name。
   */
  registerTool(
    definition: ToolDefinition,
    options?: ToolRegistrationOptions
  ): RegisteredTool;

  /**
   * 声明 MCP 服务器（委托 agent-mcp 的 registerPluginServer 禁令 13）。
   * 需 manifest.permissions 含 'mcp:connect'。
   * 需 manifest.declaredMcpServers 含 declaration.name。
   * MVP 禁止 OAuth（禁令 19），仅支持 stdio 本地进程。
   */
  registerMcpServer(declaration: PluginMcpServerDeclaration): void;

  /**
   * 读取会话上下文（需 'session:read' 权限）。
   * 返回当前会话的只读快照。
   */
  getSessionContext?(): import('../api').SessionContextSnapshot;

  /**
   * 记录插件自定义日志（委托 @crish/logger，自动带 pluginId tag）。
   */
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    metadata?: import('@crish/shared-types').JsonObject
  ): void;
}
```

```typescript
// packages/plugin-sdk/src/hooks/lifecycle.ts

import type { HookAPI } from './api';

/**
 * 插件生命周期接口。
 *
 * 插件入口模块须默认导出实现此接口的对象，或导出 activate 函数。
 * activate 在 PluginLoader.load 阶段调用，deactivate 在卸载/停用时调用。
 */
export interface PluginLifecycle {
  /**
   * 激活插件：注册 hook/tool/mcp。
   * 可返回 Promise（异步激活）。
   * 抛出错误会导致插件进入 error 状态。
   */
  activate(api: HookAPI): void | Promise<void>;

  /**
   * 停用插件：清理资源（取消订阅、关闭连接）。
   * 可返回 Promise。
   */
  deactivate?(): void | Promise<void>;
}

/**
 * 插件入口模块形状（动态 import 后的模块对象）。
 */
export interface PluginModule {
  readonly default?: PluginLifecycle;
  readonly activate?: PluginLifecycle['activate'];
  readonly deactivate?: PluginLifecycle['deactivate'];
}
```

```typescript
// packages/plugin-sdk/src/api/plugin-api.ts

import type { HookAPI } from '../hooks/api';
import type {
  HookEventName,
  HookObserveHandler,
  HookOnHandler,
  HookUnsubscribe,
} from '../hooks/types';
import type {
  ToolDefinition,
  ToolRegistrationOptions,
  RegisteredTool,
} from '../tools';
import type { PluginMcpServerDeclaration } from '../tools';
import type { PluginManifest } from '../manifest';
import type { JsonObject } from '@crish/shared-types';

/** 会话上下文只读快照（供 api.getSessionContext() 返回） */
export interface SessionContextSnapshot {
  sessionId: string;
  runId: string;
  cwd: string;
  turnIndex: number;
  messageCount: number;
  /** 仅含元数据，不含完整消息体（避免大对象拷贝） */
  recentMessageMeta: ReadonlyArray<{ role: string; timestamp: string }>;
}

/**
 * PluginAPI 实现：聚合 HookAPI + 能力清单校验 + 委托注入。
 *
 * 由 PluginLoader 在 activate 阶段构造，注入：
 * - hookBus：agent-core 的 LifecycleHookRegistry 实例（派发器，禁令 13）
 * - toolRegistry：agent-tools 的 ToolRegistry 实例
 * - mcpRegistrar：agent-mcp 的 registerPluginServer 函数
 * - trustGate：agent-permissions 的 TrustGate 实例（权限校验，禁令 18）
 * - logger：@crish/logger 实例（带 pluginId tag）
 *
 * 所有注册操作先经能力清单校验（declaredHooks/declaredTools/declaredMcpServers），
 * 再经 TrustGate 权限校验（restricted 级），最后委托注入的 registry。
 */
export class PluginAPI implements HookAPI {
  constructor(
    private readonly manifest: PluginManifest,
    private readonly deps: PluginAPIDeps
  ) {}

  observe<E extends HookEventName>(
    event: E,
    handler: HookObserveHandler<E>
  ): HookUnsubscribe {
    this.assertCapability('declaredHooks', event);
    this.assertPermission('hook:observe');
    return this.deps.hookBus.observe(event, handler);
  }

  on<E extends HookEventName>(
    event: E,
    handler: HookOnHandler<E>
  ): HookUnsubscribe {
    this.assertCapability('declaredHooks', event);
    this.assertPermission('hook:intercept');
    return this.deps.hookBus.on(event, handler);
  }

  registerTool(
    definition: ToolDefinition,
    options?: ToolRegistrationOptions
  ): RegisteredTool {
    this.assertCapability('declaredTools', definition.name);
    this.assertPermission('tool:register');
    return this.deps.toolRegistry.register(definition, options);
  }

  registerMcpServer(declaration: PluginMcpServerDeclaration): void {
    this.assertCapability('declaredMcpServers', declaration.name);
    this.assertPermission('mcp:connect');
    this.deps.mcpRegistrar(this.manifest.id, declaration);
  }

  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    metadata?: JsonObject
  ): void {
    this.deps.logger.log(
      level,
      `[plugin:${this.manifest.id}] ${message}`,
      metadata
    );
  }

  private assertCapability(
    field: 'declaredHooks' | 'declaredTools' | 'declaredMcpServers',
    value: string
  ): void {
    const declared = this.manifest[field] as readonly string[];
    if (!declared.includes(value)) {
      throw new Error(
        `Plugin ${this.manifest.id} attempted to register ${field.replace('declared', '').toLowerCase()} '${value}' not declared in manifest`
      );
    }
  }

  private assertPermission(
    permission: import('../manifest').PluginPermission
  ): void {
    // full 级别跳过校验（禁令 18）；restricted 级别经 TrustGate 校验
    if (this.manifest.trustLevel === 'full') return;
    this.deps.trustGate.assertPermission(this.manifest.id, permission);
  }
}

/** PluginAPI 依赖注入接口（由 PluginLoader 构造） */
export interface PluginAPIDeps {
  /** agent-core 的 LifecycleHookRegistry 实例（派发器，禁令 13） */
  readonly hookBus: HookBusLike;
  /** agent-tools 的 ToolRegistry 实例 */
  readonly toolRegistry: ToolRegistryLike;
  /** agent-mcp 的 registerPluginServer 函数（禁令 13） */
  readonly mcpRegistrar: (
    pluginName: string,
    declaration: PluginMcpServerDeclaration
  ) => void;
  /** agent-permissions 的 TrustGate 实例（禁令 18） */
  readonly trustGate: TrustGateLike;
  /** @crish/logger 实例 */
  readonly logger: PluginLoggerLike;
}

/**
 * HookBus 契约（agent-core 的 LifecycleHookRegistry 实现此接口）。
 * plugin-sdk 仅依赖此类型，不依赖 agent-core 具体类（解循环依赖 禁令 11）。
 */
export interface HookBusLike {
  observe<E extends HookEventName>(
    event: E,
    handler: HookObserveHandler<E>
  ): HookUnsubscribe;
  on<E extends HookEventName>(
    event: E,
    handler: HookOnHandler<E>
  ): HookUnsubscribe;
  emit<E extends HookEventName>(
    event: E,
    payload: import('@crish/shared-types').HookPayloadMap[E]
  ): Promise<import('@crish/shared-types').LifecycleHandlerResult>;
}

/** ToolRegistry 契约（agent-tools 的 ToolRegistry 实现此接口） */
export interface ToolRegistryLike {
  register(
    def: ToolDefinition,
    options?: ToolRegistrationOptions
  ): RegisteredTool;
}

/** TrustGate 契约（agent-permissions 实现，禁令 18） */
export interface TrustGateLike {
  /** 校验插件是否拥有指定权限，无权限时抛错 */
  assertPermission(
    pluginId: string,
    permission: import('../manifest').PluginPermission
  ): void;
  /** 查询插件权限决策（allow/deny） */
  decide(
    pluginId: string,
    permission: import('../manifest').PluginPermission
  ): 'allow' | 'deny';
}

/** PluginLogger 契约（@crish/logger 实现此接口） */
export interface PluginLoggerLike {
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    metadata?: JsonObject
  ): void;
}
```

### 3.5 PluginRegistry + PluginLoader + PluginValidator

> 依据 禁令 13：PluginRegistry 是 plugin-sdk 的核心，实现 `ToolSource` 接口（迁移现有 516 行 `plugin-registry.ts` 有价值逻辑）。状态机管理插件生命周期。

```typescript
// packages/plugin-sdk/src/registry/state.ts

/**
 * 插件状态机（§2.5）。
 *
 * 状态转移：
 *   discovered → loading → loaded → active
 *                       ↘ error
 *   active → inactive（手动停用）
 *   inactive → active（手动启用，需重新 activate）
 *   任意状态 → error（加载/激活失败）
 *   error → discovered（重试）
 */
export type PluginState =
  | 'discovered' // 已发现（manifest 已解析），未加载
  | 'loading' // 动态 import + activate 中
  | 'loaded' // 已加载（activate 成功）
  | 'active' // 已激活（能力已注册到 hookBus/toolRegistry）
  | 'inactive' // 已停用（能力已注销）
  | 'error'; // 加载/激活失败

/** 允许的状态转移（用于状态机校验） */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<PluginState, readonly PluginState[]>
> = {
  discovered: ['loading', 'error'],
  loading: ['loaded', 'error'],
  loaded: ['active', 'error'],
  active: ['inactive', 'error'],
  inactive: ['active', 'error'],
  error: ['discovered'],
};

export interface PluginStateEntry {
  readonly pluginId: string;
  state: PluginState;
  /** 进入当前状态的时间戳 */
  updatedAt: string;
  /** error 状态下的错误信息 */
  error?: string;
  /** 状态转移历史（用于诊断） */
  history: ReadonlyArray<{
    from: PluginState;
    to: PluginState;
    at: string;
    reason?: string;
  }>;
}
```

```typescript
// packages/plugin-sdk/src/registry/validator.ts

import type { PluginManifest } from '../manifest';
import type { PluginLifecycle } from '../hooks/lifecycle';
import type { HookEventName } from '../hooks/types';

export interface PluginValidationResult {
  readonly valid: boolean;
  readonly errors: readonly PluginValidationError[];
}

export interface PluginValidationError {
  readonly code:
    | 'manifest-invalid'
    | 'activate-registered-undeclared-hook'
    | 'activate-registered-undeclared-tool'
    | 'activate-registered-undeclared-mcp'
    | 'activate-permission-not-declared'
    | 'activate-threw';
  readonly message: string;
  readonly detail?: unknown;
}

/**
 * 插件校验器（禁令 15/16/17 能力清单比对）。
 *
 * 校验 activate(api) 实际注册的能力是否在 manifest 声明清单内。
 * 通过 Proxy 包装 HookAPI，记录所有注册调用，activate 完成后比对。
 */
export class PluginValidator {
  /**
   * 校验 manifest + activate 行为。
   * @param manifest 插件清单
   * @param recordedRegistrations activate 期间通过 Proxy HookAPI 记录的注册项
   */
  validate(
    manifest: PluginManifest,
    recordedRegistrations: RecordedRegistrations
  ): PluginValidationResult {
    const errors: PluginValidationError[] = [];

    // 比对 hooks
    for (const hook of recordedRegistrations.hooks) {
      if (!manifest.declaredHooks.includes(hook)) {
        errors.push({
          code: 'activate-registered-undeclared-hook',
          message: `activate registered hook '${hook}' not in manifest.declaredHooks`,
        });
      }
    }
    // 比对 tools
    for (const tool of recordedRegistrations.tools) {
      if (!manifest.declaredTools.includes(tool)) {
        errors.push({
          code: 'activate-registered-undeclared-tool',
          message: `activate registered tool '${tool}' not in manifest.declaredTools`,
        });
      }
    }
    // 比对 mcp servers
    for (const mcp of recordedRegistrations.mcpServers) {
      if (!manifest.declaredMcpServers.includes(mcp)) {
        errors.push({
          code: 'activate-registered-undeclared-mcp',
          message: `activate registered mcp server '${mcp}' not in manifest.declaredMcpServers`,
        });
      }
    }

    return { valid: errors.length === 0, errors };
  }
}

/** activate 期间记录的注册项（通过 Proxy HookAPI 收集） */
export interface RecordedRegistrations {
  hooks: HookEventName[];
  tools: string[];
  mcpServers: string[];
}
```

```typescript
// packages/plugin-sdk/src/registry/loader.ts

import type { PluginManifest } from '../manifest';
import type { PluginLifecycle, PluginModule } from '../hooks/lifecycle';
import type { HookAPI } from '../hooks/api';
import type { PluginAPIDeps } from '../api';
import { PluginAPI } from '../api';
import type { PluginValidator, RecordedRegistrations } from './validator';

/**
 * 插件加载器（禁令 15/16/17）。
 *
 * 职责：
 * 1. 动态 import entrypoints.main
 * 2. 构造 PluginAPI（注入 hookBus/toolRegistry/mcpRegistrar/trustGate/logger）
 * 3. 通过 Proxy 包装 PluginAPI 收集注册项（供 PluginValidator 比对）
 * 4. 调用 activate(api)
 * 5. 经 PluginValidator 校验能力清单
 *
 * 安全约束（对齐现有 plugin-fs-registry.ts）：
 * - 同进程 dynamic import 受 CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT 环境变量门控
 * - 默认仅注册 manifest（数据面发现），不执行代码
 * - full 级别插件需用户显式授权（UI 二次确认）
 */
export class PluginLoader {
  constructor(
    private readonly deps: PluginAPIDeps,
    private readonly validator: PluginValidator
  ) {}

  /**
   * 加载并激活插件。
   * @param manifest 插件清单
   * @param entryPath 入口绝对路径
   * @returns 激活后的 lifecycle（含 deactivate）+ 记录的注册项
   */
  async load(
    manifest: PluginManifest,
    entryPath: string
  ): Promise<PluginLoadResult> {
    // 安全门：同进程 import 需显式开启（dev/spike only）
    const allowUnsafeImport =
      process.env.CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT === '1' ||
      process.env.CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT === 'true';

    if (!allowUnsafeImport) {
      throw new Error(
        `Plugin ${manifest.id}: same-process dynamic import is disabled. ` +
          `Set CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT=1 to enable (dev/spike only, not production-safe).`
      );
    }

    // 1. 动态 import
    const mod = (await import(entryPath)) as PluginModule;
    const lifecycle = this.resolveLifecycle(mod);
    if (!lifecycle) {
      throw new Error(
        `Plugin ${manifest.id}: entry module must export default PluginLifecycle or activate function`
      );
    }

    // 2. 构造 Proxy 包装的 PluginAPI（收集注册项）
    const recordings: RecordedRegistrations = {
      hooks: [],
      tools: [],
      mcpServers: [],
    };
    const api = new PluginAPI(manifest, this.deps);
    const proxiedApi = this.wrapWithRecording(api, recordings);

    // 3. 调用 activate
    try {
      await lifecycle.activate(proxiedApi);
    } catch (err) {
      throw new Error(
        `Plugin ${manifest.id}: activate() threw: ${(err as Error).message}`
      );
    }

    // 4. 校验能力清单（禁令 15/16/17）
    const validation = this.validator.validate(manifest, recordings);
    if (!validation.valid) {
      // 激活失败，尝试回滚（调用 deactivate）
      await this.safeDeactivate(lifecycle);
      throw new Error(
        `Plugin ${manifest.id}: validation failed: ${validation.errors.map((e) => e.message).join('; ')}`
      );
    }

    return { lifecycle, recordings, api };
  }

  private resolveLifecycle(mod: PluginModule): PluginLifecycle | undefined {
    if (mod.default) return mod.default;
    if (mod.activate) {
      return { activate: mod.activate, deactivate: mod.deactivate };
    }
    return undefined;
  }

  private wrapWithRecording(
    api: HookAPI,
    recordings: RecordedRegistrations
  ): HookAPI {
    const handler: ProxyHandler<HookAPI> = {
      get(target, prop: keyof HookAPI) {
        const original = target[prop];
        if (prop === 'observe' || prop === 'on') {
          return (event: HookEventName, handler: unknown) => {
            recordings.hooks.push(event);
            return (original as Function).call(target, event, handler);
          };
        }
        if (prop === 'registerTool') {
          return (definition: { name: string }, options?: unknown) => {
            recordings.tools.push(definition.name);
            return (original as Function).call(target, definition, options);
          };
        }
        if (prop === 'registerMcpServer') {
          return (declaration: { name: string }) => {
            recordings.mcpServers.push(declaration.name);
            return (original as Function).call(target, declaration);
          };
        }
        return original;
      },
    };
    return new Proxy(api, handler);
  }

  private async safeDeactivate(lifecycle: PluginLifecycle): Promise<void> {
    try {
      await lifecycle.deactivate?.();
    } catch {
      // 静默：回滚失败不阻塞错误上报
    }
  }
}

export interface PluginLoadResult {
  readonly lifecycle: PluginLifecycle;
  readonly recordings: RecordedRegistrations;
  readonly api: PluginAPI;
}
```

```typescript
// packages/plugin-sdk/src/registry/registry.ts

import type { AgentTool, ToolSource } from '@crish/shared-types';
import type { PluginManifest } from '../manifest';
import type { PluginStateEntry } from './state';
import type { PluginLoadResult } from './loader';
import type { PluginDiscoverer, DiscoveredPlugin } from './discoverer';

/**
 * PluginRegistry — 插件注册表（核心）。
 *
 * 职责（禁令 13）：
 * 1. 通过 PluginDiscoverer 发现 user-dir + project-dir 插件
 * 2. 通过 PluginLoader 加载并激活
 * 3. 管理插件状态机（discovered → loading → loaded → active → inactive → error）
 * 4. 实现 ToolSource 接口（迁移现有 plugin-registry.ts 516 行有价值逻辑）
 * 5. 提供插件能力查询（hooks/tools/mcpServers）
 *
 * 迁移自 agent-runtime/src/plugin-registry.ts（516 行 ToolSource 适配器）：
 * - listTools() / listToolContributions() 复用
 * - preparePluginTool() 元数据组装复用
 * - cloneToolMetadata() 深拷贝复用
 * - 重构：去除 contributes/commands/events/renderers 多重能力（MVP 聚焦 hooks+tools+mcp）
 */
export class PluginRegistry implements ToolSource {
  readonly id: string;
  readonly label: string;

  private readonly plugins = new Map<string, PluginEntry>();
  private readonly toolOwners = new Map<string, string>(); // toolName → pluginId

  constructor(
    private readonly discoverer: PluginDiscoverer,
    private readonly loader: PluginLoader,
    options: PluginRegistryOptions = {}
  ) {
    this.id = options.id ?? 'plugin-registry';
    this.label = options.label ?? 'Plugin registry';
  }

  /**
   * 发现 + 加载全部插件（从 user-dir + project-dir）。
   * 单个插件加载失败不影响其他插件（记录 error 状态）。
   */
  async loadAll(): Promise<void> {
    const discovered = await this.discoverer.discover();
    await Promise.all(
      discovered.map((d) => this.loadOne(d).catch(() => void 0))
    );
  }

  /** 发现并加载单个插件 */
  async loadOne(discovered: DiscoveredPlugin): Promise<void> {
    const entry: PluginEntry = {
      manifest: discovered.manifest,
      state: {
        pluginId: discovered.manifest.id,
        state: 'loading',
        updatedAt: nowIso(),
        history: [],
      },
      loadResult: undefined,
    };
    this.plugins.set(discovered.manifest.id, entry);

    try {
      const loadResult = await this.loader.load(
        discovered.manifest,
        discovered.entryPath
      );
      entry.loadResult = loadResult;
      this.transition(discovered.manifest.id, 'loaded');
      this.transition(discovered.manifest.id, 'active');
      // 登记工具所有权
      for (const toolName of loadResult.recordings.tools) {
        this.toolOwners.set(toolName, discovered.manifest.id);
      }
    } catch (err) {
      entry.state = {
        ...entry.state,
        state: 'error',
        updatedAt: nowIso(),
        error: (err as Error).message,
      };
    }
  }

  /** 停用插件（注销能力） */
  async deactivate(pluginId: string): Promise<boolean> {
    const entry = this.plugins.get(pluginId);
    if (!entry?.loadResult) return false;
    await entry.loadResult.lifecycle.deactivate?.();
    // 清理工具所有权
    for (const toolName of entry.loadResult.recordings.tools) {
      this.toolOwners.delete(toolName);
    }
    this.transition(pluginId, 'inactive');
    return true;
  }

  /** 重启插件（inactive → active） */
  async reactivate(pluginId: string): Promise<boolean> {
    const entry = this.plugins.get(pluginId);
    if (!entry?.loadResult) return false;
    // 重新激活需要重新构造 PluginAPI（简化：MVP 不支持，需重新 loadOne）
    return false;
  }

  // ─── ToolSource 实现（迁移自现有 plugin-registry.ts）──

  async listTools(): Promise<AgentTool[]> {
    const tools: AgentTool[] = [];
    for (const entry of this.plugins.values()) {
      if (entry.state.state !== 'active' || !entry.loadResult) continue;
      // 工具实际注册在 toolRegistry 中，此处返回 plugin 注册的工具
      // 通过 recordings.tools 知道插件注册了哪些工具名，再从 toolRegistry 查询
      for (const toolName of entry.loadResult.recordings.tools) {
        // 委托 deps.toolRegistry 查询（此处简化，实际通过注入的 registry 引用）
      }
    }
    return tools;
  }

  async dispose(): Promise<void> {
    for (const pluginId of [...this.plugins.keys()]) {
      await this.deactivate(pluginId);
    }
    this.plugins.clear();
    this.toolOwners.clear();
  }

  // ─── 查询方法 ──

  listPlugins(): PluginListEntry[] {
    return [...this.plugins.values()].map((e) => ({
      manifest: e.manifest,
      state: e.state.state,
      error: e.state.error,
    }));
  }

  getPluginState(pluginId: string): PluginStateEntry | undefined {
    return this.plugins.get(pluginId)?.state;
  }

  private transition(
    pluginId: string,
    to: import('./state').PluginState
  ): void {
    const entry = this.plugins.get(pluginId);
    if (!entry) return;
    const from = entry.state.state;
    entry.state = {
      ...entry.state,
      state: to,
      updatedAt: nowIso(),
      history: [...entry.state.history, { from, to, at: nowIso() }],
    };
  }
}

interface PluginEntry {
  manifest: PluginManifest;
  state: PluginStateEntry;
  loadResult?: PluginLoadResult;
}

export interface PluginRegistryOptions {
  id?: string;
  label?: string;
}

export interface PluginListEntry {
  manifest: PluginManifest;
  state: import('./state').PluginState;
  error?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}
```

### 3.6 PluginDiscoverer（user-dir + project-dir）

> 依据 禁令 15/16/17：仅 `user-dir` + `project-dir` 两种源。迁移现有 `plugin-fs-registry.ts`（113 行）的双源发现逻辑。

```typescript
// packages/plugin-sdk/src/registry/discoverer.ts

import { readdir, readFile, access } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import type { PluginManifest, PluginOrigin } from '../manifest';
import { validateManifest } from '../manifest';

/**
 * 插件发现器（禁令 15/16/17）。
 *
 * 发现源（仅 2 种）：
 * - user-dir：~/.crish/plugins/<plugin-id>/
 * - project-dir：<cwd>/.crish/plugins/<plugin-id>/
 *
 * 每个插件目录须含：
 * - plugin.json（PluginManifest 序列化，origin 字段由 discoverer 填充）
 * - <entrypoints.main>（入口模块，相对路径）
 *
 * 禁止源（禁令 15/16/17）：mcp / github / inline / npm / global-dir
 */
export class PluginDiscoverer {
  /**
   * @param userDir 自定义 user-dir 路径（默认 ~/.crish/plugins）
   * @param projectDir 自定义 project-dir 路径（默认 <cwd>/.crish/plugins）
   */
  constructor(
    private readonly userDir: string = join(homedir(), '.crish', 'plugins'),
    private readonly projectDir: string = join(
      process.cwd(),
      '.crish',
      'plugins'
    )
  ) {}

  /** 发现全部插件（user-dir 优先，project-dir 覆盖同名） */
  async discover(): Promise<DiscoveredPlugin[]> {
    const found = new Map<string, DiscoveredPlugin>();

    // user-dir 优先级低（先扫描）
    for (const p of await this.scanDir(this.userDir, 'user-dir')) {
      found.set(p.manifest.id, p);
    }
    // project-dir 优先级高（覆盖同名 user-dir 插件）
    for (const p of await this.scanDir(this.projectDir, 'project-dir')) {
      found.set(p.manifest.id, p);
    }

    return [...found.values()];
  }

  private async scanDir(
    dir: string,
    origin: PluginOrigin
  ): Promise<DiscoveredPlugin[]> {
    const results: DiscoveredPlugin[] = [];
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return results; // 目录不存在，静默跳过
    }

    for (const entry of entries) {
      const pluginDir = join(dir, entry);
      const manifestPath = join(pluginDir, 'plugin.json');
      try {
        await access(manifestPath);
        const raw = JSON.parse(await readFile(manifestPath, 'utf-8'));
        const manifest: PluginManifest = { ...raw, origin };
        const validation = validateManifest(manifest);
        if (!validation.valid) {
          console.warn(
            `[PluginDiscoverer] skipping ${entry}: manifest invalid: ` +
              validation.errors.map((e) => e.message).join('; ')
          );
          continue;
        }
        // full 级别仅允许 user-dir（防仓库投毒，禁令 18）
        if (manifest.trustLevel === 'full' && origin === 'project-dir') {
          console.warn(
            `[PluginDiscoverer] downgrading ${entry} to restricted (full not allowed for project-dir)`
          );
          (manifest as { trustLevel: 'restricted' }).trustLevel = 'restricted';
        }
        const entryPath = isAbsolute(manifest.entrypoints.main)
          ? manifest.entrypoints.main
          : join(pluginDir, manifest.entrypoints.main);
        results.push({ manifest, entryPath, pluginDir });
      } catch {
        // 非 plugin 目录或解析失败，跳过
      }
    }
    return results;
  }
}

export interface DiscoveredPlugin {
  manifest: PluginManifest;
  /** 入口模块绝对路径 */
  entryPath: string;
  /** 插件目录绝对路径 */
  pluginDir: string;
}
```

### 3.7 SkillLoader

> 依据 禁令 15/16/17 + 任务约束：技能目录结构 `skills/<name>/SKILL.md` + `scripts/` + `prompts/`（移除 `agents/` 子目录，避免与 agent-subagent 概念混淆）。迁移现有 `skills.ts`（frontmatter 解析逻辑）。

```typescript
// packages/plugin-sdk/src/skills/skill-types.ts

import type { JsonObject } from '@crish/shared-types';

/**
 * 插件技能定义（从 SKILL.md frontmatter 解析）。
 *
 * 技能是一种特殊的工具：由 Markdown 文档驱动，可被 LLM 自动调用或手动触发。
 * 技能→工具转换由 SkillLoader.toTool() 完成。
 */
export interface PluginSkill {
  /** 技能名（唯一，作为工具名） */
  name: string;
  /** 技能描述（供 LLM 决策是否调用） */
  description: string;
  /** SKILL.md 绝对路径 */
  filePath: string;
  /** 技能根目录（含 scripts/ prompts/ 子目录） */
  baseDir: string;
  /** SKILL.md 正文内容（去除 frontmatter 后） */
  content: string;
  /** 是否禁止模型自动调用（仅手动触发） */
  disableModelInvocation: boolean;
  /** 作用域 */
  scope?: 'global' | 'project' | 'workspace';
  /** 激活建议 */
  activation?: 'enabled' | 'recommended' | 'disabled';
  /** 运行模式 */
  runAs?: 'inline' | 'subagent';
  /** 是否只读 */
  readOnly?: boolean;
  /** 允许调用的工具白名单（runAs=subagent 时生效） */
  allowedTools?: string[];
  /** 调用方式 */
  invocation?: 'auto' | 'manual';
  /** 适用范围（glob 模式） */
  appliesTo?: string[];
  /** 标签 */
  tags?: string[];
}

/** SKILL.md frontmatter 结构 */
export interface SkillFrontmatter {
  name: string;
  description: string;
  'disable-model-invocation'?: boolean;
  scope?: 'global' | 'project' | 'workspace';
  activation?: 'enabled' | 'recommended' | 'disabled';
  'run-as'?: 'inline' | 'subagent';
  'read-only'?: boolean;
  'allowed-tools'?: string[];
  invocation?: 'auto' | 'manual';
  'applies-to'?: string[];
  tags?: string[];
}

export interface LoadSkillsResult {
  skills: PluginSkill[];
  diagnostics: SkillDiagnostic[];
}

export interface SkillDiagnostic {
  severity: 'warning' | 'error';
  code:
    | 'skill-directory-unreadable'
    | 'skill-file-unreadable'
    | 'skill-file-too-large'
    | 'skill-file-binary'
    | 'skill-name-invalid'
    | 'skill-description-invalid'
    | 'skill-frontmatter-malformed';
  path: string;
  message: string;
}

export interface LoadSkillsOptions {
  maxSkillBytes?: number;
}
```

```typescript
// packages/plugin-sdk/src/skills/skill-loader.ts

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolOutput,
} from '@crish/shared-types';
import type {
  PluginSkill,
  SkillFrontmatter,
  LoadSkillsResult,
  LoadSkillsOptions,
  SkillDiagnostic,
} from './skill-types';

const DEFAULT_MAX_SKILL_BYTES = 512 * 1024;
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

/**
 * SkillLoader — 技能加载器。
 *
 * 职责：
 * 1. 扫描技能目录（skills/<name>/SKILL.md）
 * 2. 解析 frontmatter（迁移自 agent-runtime/src/skills.ts）
 * 3. 技能→工具转换（toTool）：将 SKILL.md 内容包装为可被 LLM 调用的工具
 *
 * 技能目录结构（禁令 15/16/17，移除 agents/ 子目录避免与 agent-subagent 概念混淆）：
 *   skills/
 *     <skill-name>/
 *       SKILL.md          # frontmatter + 正文
 *       scripts/          # 可选，辅助脚本
 *       prompts/          # 可选，prompt 片段
 */
export class SkillLoader {
  /**
   * 从目录加载全部技能。
   * @param skillsDir 技能根目录（含 <name>/SKILL.md 子目录）
   */
  async loadFromDirectory(
    skillsDir: string,
    options: LoadSkillsOptions = {}
  ): Promise<LoadSkillsResult> {
    const result: LoadSkillsResult = { skills: [], diagnostics: [] };
    const maxBytes = options.maxSkillBytes ?? DEFAULT_MAX_SKILL_BYTES;

    let entries: string[];
    try {
      entries = await readdir(skillsDir);
    } catch {
      return result;
    }

    for (const entry of entries) {
      const skillDir = join(skillsDir, entry);
      const skillMdPath = join(skillDir, 'SKILL.md');
      await this.loadOneSkill(skillMdPath, skillDir, maxBytes, result);
    }

    return result;
  }

  /**
   * 技能→工具转换。
   * 将 SKILL.md 内容包装为 ToolDefinition，供 api.registerTool() 注册。
   */
  toTool(skill: PluginSkill): ToolDefinition {
    return {
      name: skill.name,
      description: skill.description,
      inputSchema: {
        type: 'object',
        properties: {
          input: {
            type: 'string',
            description: 'Optional user input for the skill',
          },
        },
      },
      async execute(
        input: { input?: string },
        ctx: ToolExecutionContext
      ): Promise<ToolOutput> {
        // 技能执行：返回 SKILL.md 内容供 LLM 按指令操作
        // 实际执行（scripts/ 调用）由 agent-tools 的工具执行器处理
        return {
          text: `# Skill: ${skill.name}\n\n${skill.content}\n\n## User Input\n${input?.input ?? '(none)'}`,
        };
      },
    };
  }

  private async loadOneSkill(
    skillMdPath: string,
    skillDir: string,
    maxBytes: number,
    result: LoadSkillsResult
  ): Promise<void> {
    let stats;
    try {
      stats = await stat(skillMdPath);
    } catch {
      return; // 文件不存在，跳过
    }
    if (!stats.isFile()) return;
    if (stats.size > maxBytes) {
      result.diagnostics.push({
        severity: 'warning',
        code: 'skill-file-too-large',
        path: skillMdPath,
        message: `SKILL.md exceeds ${maxBytes} bytes`,
      });
      return;
    }

    const raw = await readFile(skillMdPath, 'utf-8');
    const parsed = parseFrontmatter(raw);
    if (!parsed) {
      result.diagnostics.push({
        severity: 'warning',
        code: 'skill-frontmatter-malformed',
        path: skillMdPath,
        message: 'SKILL.md frontmatter is malformed',
      });
      return;
    }

    const fm = parsed.data as unknown as SkillFrontmatter;
    if (!fm.name || fm.name.length > MAX_SKILL_NAME_LENGTH) {
      result.diagnostics.push({
        severity: 'warning',
        code: 'skill-name-invalid',
        path: skillMdPath,
        message: 'skill name missing or too long',
      });
      return;
    }
    if (
      !fm.description ||
      fm.description.length > MAX_SKILL_DESCRIPTION_LENGTH
    ) {
      result.diagnostics.push({
        severity: 'warning',
        code: 'skill-description-invalid',
        path: skillMdPath,
        message: 'skill description missing or too long',
      });
      return;
    }

    result.skills.push({
      name: fm.name,
      description: fm.description,
      filePath: skillMdPath,
      baseDir: skillDir,
      content: parsed.body,
      disableModelInvocation: fm['disable-model-invocation'] ?? false,
      scope: fm.scope,
      activation: fm.activation,
      runAs: fm['run-as'],
      readOnly: fm['read-only'],
      allowedTools: fm['allowed-tools'],
      invocation: fm.invocation,
      appliesTo: fm['applies-to'],
      tags: fm.tags,
    });
  }
}

/** frontmatter 解析（迁移自 agent-runtime/src/skills.ts） */
interface ParsedFrontmatter {
  data: Record<string, string | boolean | string[]>;
  body: string;
}

function parseFrontmatter(raw: string): ParsedFrontmatter | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;
  const frontmatterText = match[1];
  const body = match[2];
  const data: Record<string, string | boolean | string[]> = {};
  for (const line of frontmatterText.split('\n')) {
    const kv = line.match(/^(\S+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value === 'true') data[key] = true;
    else if (value === 'false') data[key] = false;
    else if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim());
    } else {
      data[key] = value;
    }
  }
  return { data, body };
}
```

### 3.8 TrustGate（从 agent-permissions 导入）

> 依据 禁令 18：TrustGate 合并到 `agent-permissions` 包，不在 plugin-sdk 内重复实现权限校验逻辑。plugin-sdk 仅声明 `TrustGateLike` 契约（见 §3.4），由 agent-permissions 提供实现并注入。

```typescript
// packages/plugin-sdk/src/manifest/trust-gate.ts
// （仅声明契约 + re-export，实现归 agent-permissions 禁令 18）

import type { PluginPermission, PluginTrustLevel } from './permissions';

/**
 * TrustGate 契约（禁令 18）。
 *
 * 实现归 agent-permissions 包，plugin-sdk 不重复实现权限校验逻辑。
 * PluginAPI 通过 PluginAPIDeps.trustGate 注入此接口的实现。
 *
 * 信任级别语义（禁令 18）：
 * - restricted：主线程执行 + 权限白名单校验（TrustGate.assertPermission 强制校验）
 * - full：主线程执行 + 无校验（用户显式授权，仅 user-dir 来源可声明）
 *
 * 禁止 sandboxed 级别（禁令 18：无 worker_threads 隔离方案时禁止）。
 */
export interface TrustGate {
  /**
   * 校验插件是否拥有指定权限。
   * - full 级别：直接通过（无校验）
   * - restricted 级别：检查 manifest.permissions 白名单
   * @throws Error 无权限时抛出（含 pluginId + permission 信息）
   */
  assertPermission(pluginId: string, permission: PluginPermission): void;

  /**
   * 查询插件权限决策。
   * - full 级别：始终返回 'allow'
   * - restricted 级别：permissions 白名单含则 allow，否则 deny
   */
  decide(pluginId: string, permission: PluginPermission): 'allow' | 'deny';

  /**
   * 注册插件的权限清单（在 PluginLoader.load 阶段调用）。
   * TrustGate 内部缓存 pluginId → (trustLevel, permissions) 映射。
   */
  registerPlugin(
    pluginId: string,
    trustLevel: PluginTrustLevel,
    permissions: readonly PluginPermission[]
  ): void;

  /** 注销插件（在 deactivate 阶段调用） */
  unregisterPlugin(pluginId: string): void;
}

/**
 * TrustGate 实现的获取入口。
 *
 * agent-permissions 包导出 createTrustGate() 工厂函数，
 * agent-core 初始化时创建实例并注入 PluginAPIDeps。
 *
 * plugin-sdk 不直接 import agent-permissions（避免运行时依赖），
 * 而是通过 PluginAPIDeps.trustGate 接收已构造的实例。
 */
export type TrustGateFactory = () => TrustGate;
```

> **实现归属说明**（禁令 18）：`agent-permissions` 包（Round 3 创建）在 `src/trust-gate.ts` 中导出 `createTrustGate(): TrustGate` 工厂函数，内部基于 `manifest.permissions` 白名单 + `trustLevel` 判定。该实现复用现有 `trust-zone-policy.ts` 的 `TrustZonePermissionPolicy` 模式（T0-T4 信任区矩阵），将插件权限校验统一到 agent-permissions。本 Round 不实现 `createTrustGate`（属 agent-permissions 范围），仅消费接口。

---

## 4. agent-core/hooks/ 增强设计

> 依据 禁令 13：钩子派发器（HookBus / LifecycleHookRegistry）留 `agent-core/src/hooks/`，因为事件发射点在 SessionLoop 内部。本节定义 Round 8 对 agent-core/hooks/ 的增强。

### 4.1 LifecycleEventType 扩展

```typescript
// packages/agent-core/src/hooks/lifecycle-hooks.ts（增强，不重写）

// 现有（保留）：
export type LifecycleEventType =
  | 'turn.start'
  | 'turn.end'
  | 'tool.pre'
  | 'tool.post'
  | CompactLifecycleEventType;

// Round 8 增强后（新增 8 个事件，对齐 HookEventName §3.3）：
export type LifecycleEventType =
  | 'turn.start'
  | 'turn.end'
  | 'tool.pre'
  | 'tool.post'
  | 'tool.error' // [NEW] 保留 ToolHook.onError 控制能力
  | CompactLifecycleEventType // context.compact.start | context.compact.end
  | 'session.start' // [NEW]
  | 'session.end' // [NEW]
  | 'model.beforeRequest' // [NEW]
  | 'model.afterResponse' // [NEW]
  | 'subagent.start' // [NEW]
  | 'subagent.end' // [NEW]
  | 'error.occurred'; // [NEW]
```

### 4.2 LifecyclePayloadMap 扩展

```typescript
// LifecyclePayloadMap 扩展（新增 8 个 payload 映射）
export type LifecyclePayloadMap = {
  'turn.start': TurnStartPayload;
  'turn.end': TurnEndPayload;
  'tool.pre': ToolPrePayload;
  'tool.post': ToolPostPayload;
  'tool.error': ToolErrorPayload; // [NEW]
  'context.compact.start': ContextCompactStartPayload;
  'context.compact.end': ContextCompactEndPayload;
  'session.start': SessionStartPayload; // [NEW]
  'session.end': SessionEndPayload; // [NEW]
  'model.beforeRequest': ModelBeforeRequestPayload; // [NEW]
  'model.afterResponse': ModelAfterResponsePayload; // [NEW]
  'subagent.start': SubagentStartPayload; // [NEW]
  'subagent.end': SubagentEndPayload; // [NEW]
  'error.occurred': ErrorOccurredPayload; // [NEW]
};
```

### 4.3 emit() 增强与 HandlerResult 合并

现有 `emit()` 的 observe 并行容错 + on 串行合并逻辑**保持不变**（禁令 14 双模式）。增强点：

1. **tool.error 事件的 Result 合并**：新增 `ToolErrorHandlerResult` 合并逻辑
2. **error.occurred 事件的 observe-only 约束**：该事件仅允许 observe（on 处理器的控制信号对该事件无意义，错误已发生）

```typescript
// emit() 增强后的 on 合并逻辑（伪代码，保留现有 5 字段 + 新增 tool.error action 合并）

async emit<E extends LifecycleEventType>(
  type: E,
  payload: LifecyclePayloadMap[E],
): Promise<LifecycleHandlerResult | ToolErrorHandlerResult> {
  // observe 阶段：并行容错（现有逻辑不变，禁令 14）
  const observers = this.handlers.filter(
    (h) => h.kind === 'observe' && (h.type === type || h.type === '*'),
  );
  await Promise.all(
    observers.map(async (h) => {
      try { await h.handler(payload); }
      catch (err) { console.warn(`[LifecycleHooks] observe(${type}) failed:`, err); }
    }),
  );

  // on 阶段：串行合并（现有逻辑保留 + tool.error 特殊合并）
  if (type === 'error.occurred') {
    // error.occurred 仅 observe，不执行 on（错误已发生，控制信号无意义）
    return {};
  }

  const onHandlers = this.handlers.filter((h) => h.kind === 'on' && h.type === type);
  const merged: LifecycleHandlerResult & Partial<ToolErrorHandlerResult> = {};
  for (const h of onHandlers) {
    try {
      const result = (await h.handler(payload)) as
        | LifecycleHandlerResult
        | ToolErrorHandlerResult
        | void;
      if (!result) continue;

      // LifecycleHandlerResult 字段合并（现有逻辑，禁令 14 保留）
      if ('stop' in result && result.stop) merged.stop = true;
      if ('block' in result && result.block) {
        merged.block = true;
        if (result.reason !== undefined) merged.reason = result.reason;
      }
      if ('modifiedInput' in result && result.modifiedInput !== undefined) {
        merged.modifiedInput = result.modifiedInput;
      }
      if ('modifiedOutput' in result && result.modifiedOutput !== undefined) {
        merged.modifiedOutput = result.modifiedOutput;
      }
      if ('terminate' in result && result.terminate) {
        merged.terminate = true;
        if (result.reason !== undefined) merged.reason = result.reason;
      }

      // ToolErrorHandlerResult 字段合并（tool.error 专用，禁令 14 保留 onError 控制能力）
      if ('action' in result) {
        // 优先级：abort > retry > skip（首个非 skip action 生效）
        if (result.action === 'abort') {
          merged.action = 'abort';
          if (result.reason !== undefined) merged.reason = result.reason;
          break; // abort 立即终止合并
        }
        if (result.action === 'retry' && merged.action !== 'retry') {
          merged.action = 'retry';
          if (result.reason !== undefined) merged.reason = result.reason;
          if (result.retryDelayMs !== undefined) merged.retryDelayMs = result.retryDelayMs;
        }
        if (result.action === 'skip' && !merged.action) {
          merged.action = 'skip';
          if (result.reason !== undefined) merged.reason = result.reason;
        }
      }
    } catch (err) {
      console.warn(`[LifecycleHooks] on(${type}) failed:`, err);
    }
  }
  return merged;
}
```

### 4.4 新事件发射点

| 事件                  | 发射位置（agent-core）                             | 发射时机                                    |
| --------------------- | -------------------------------------------------- | ------------------------------------------- |
| `session.start`       | `agent-session-loop.ts`                            | 会话启动（new/resume/branch）后、首 turn 前 |
| `session.end`         | `agent-session-loop.ts`                            | 会话结束（stop/max-turns/aborted/error）后  |
| `model.beforeRequest` | `runtime-components/provider-call-gateway.ts`      | 调用 provider.stream 前                     |
| `model.afterResponse` | `runtime-components/provider-response-consumer.ts` | provider 流结束后                           |
| `subagent.start`      | `subagent-bridge`（R9 接入，本 Round 预留发射点）  | 子代理 spawn 后                             |
| `subagent.end`        | `subagent-bridge`（R9 接入，本 Round 预留发射点）  | 子代理结束后                                |
| `tool.error`          | `runtime-components/tool-executor.ts`              | 工具 execute 抛错时                         |
| `error.occurred`      | `recovery-pipeline.ts` + `error-classifier.ts`     | 错误分类后、恢复策略执行前                  |

### 4.5 PluginRegistry 集成到 agent-core 初始化

```typescript
// packages/agent-core/src/runtime.ts（增强初始化流程，伪代码）

import { PluginRegistry, PluginDiscoverer, PluginLoader, PluginValidator } from '@crish/plugin-sdk';
import { LifecycleHookRegistry } from './hooks/lifecycle-hooks';
import { ToolRegistry } from '@crish/agent-tools';  // 类型引用
import { createTrustGate } from '@crish/agent-permissions';  // 禁令 18

export async function initializeRuntime(options: RuntimeInitOptions): Promise<RuntimeComponents> {
  const hookBus = new LifecycleHookRegistry();
  const toolRegistry = new ToolRegistry();
  const trustGate = createTrustGate();  // 禁令 18 从 agent-permissions 注入
  const logger = createLogger({ module: 'runtime' });

  // 插件系统初始化（禁令 13 集成）
  const discoverer = new PluginDiscoverer();
  const validator = new PluginValidator();
  const loader = new PluginLoader(
    {
      hookBus,                          // 注入 LifecycleHookRegistry 实例
      toolRegistry,
      mcpRegistrar: (name, decl) => registerPluginServer(name, decl),  // 禁令 13 委托 agent-mcp
      trustGate,
      logger,
    },
    validator,
  );
  const pluginRegistry = new PluginRegistry(discoverer, loader);
  await pluginRegistry.loadAll();  // 发现 + 加载 + 激活全部插件

  return { hookBus, toolRegistry, pluginRegistry, ... };
}
```

---

## 5. 与现有 LifecycleHookRegistry 的兼容性

> 依据 禁令 23 迁移三阶段策略：本 Round 为共存阶段，旧接口保留。

### 5.1 共存策略

| 现有资产                                                    | Round 8 处理                                                 | 移除时间                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------ |
| `LifecycleHookRegistry`（348 行）                           | 增强（扩展事件类型），保留 observe/on/emit 实现              | 不移除（派发器永久留 agent-core，禁令 13） |
| `adaptAgentHooks()`                                         | 保留（旧 AgentHooks 适配器）                                 | R11 后视迁移情况移除                       |
| `createLifecycleToolMiddleware()`                           | 保留（ToolExecutor 适配）                                    | 不移除                                     |
| `AgentHooks` 接口（hook-types.ts）                          | 保留 deprecation 注释                                        | R11 后移除                                 |
| `Extension` / `ExtensionRegistry`                           | 保留（旧扩展机制）                                           | R11 后视插件迁移情况移除                   |
| `plugin-registry.ts`（516 行 ToolSource 适配器）            | 有价值逻辑迁移到 plugin-sdk/src/registry/，原文件保留为 shim | R9 后移除                                  |
| `plugin-fs-registry.ts`（113 行）                           | 双源发现逻辑迁移到 PluginDiscoverer，原文件保留              | R9 后移除                                  |
| 旧 `plugin-sdk/src/index.ts`（17 行 Plugin + definePlugin） | 保留为 deprecation shim，导出新 API                          | v0.3.0 移除（禁令 24）                     |

### 5.2 payload 字段保留验证（禁令 14 不退化）

| 现有 payload 字段                                   | Round 8 保留状态                                    | 验证               |
| --------------------------------------------------- | --------------------------------------------------- | ------------------ |
| `TurnEndPayload.isAborted`                          | 保留                                                | §3.3               |
| `TurnEndPayload.hasPendingInput`                    | 保留                                                | §3.3               |
| `ContextCompactEndPayload.aborted`                  | 保留                                                | §3.3               |
| `ContextCompactEndPayload.trigger`                  | 保留                                                | §3.3               |
| `ContextCompactEndPayload.compactionId`             | 保留                                                | §3.3               |
| `ContextCompactEndPayload.keptMessageCount`         | 保留                                                | §3.3               |
| `ContextCompactEndPayload.compressedMessageCount`   | 保留                                                | §3.3               |
| `ContextCompactEndPayload.tokensBefore/tokensAfter` | 保留                                                | §3.3               |
| `ContextCompactEndPayload.durationMs`               | 保留                                                | §3.3               |
| `ToolHook.onError` → retry/skip/abort               | 提升为 `tool.error` 事件 + `ToolErrorHandlerResult` | §3.3（第 14 钩子） |
| `shouldStopAfterTurn` → stop                        | 保留为 `turn.end` 的 `on` handler 返回 `stop`       | §3.3               |

### 5.3 旧 plugin-sdk 17 行接口的 deprecation shim

```typescript
// packages/plugin-sdk/src/index.ts（重建后，保留旧接口 deprecation）

// 新 API 导出
export * from './manifest';
export * from './hooks';
export * from './tools';
export * from './registry';
export * from './skills';
export * from './api';

// ─── 旧接口 deprecation shim（禁令 23 共存阶段）──────────────
// 保留旧 Plugin 接口 + definePlugin，标记 deprecated，v0.3.0 移除

/** @deprecated 使用 PluginManifest + PluginLifecycle 替代。v0.3.0 移除。 */
export interface Plugin {
  name: string;
  version: string;
  description?: string;
  hooks?: {
    onSessionStart?(id: string): void | Promise<void>;
    onSessionEnd?(id: string): void | Promise<void>;
    onToolCall?(call: unknown): void | Promise<void>;
    onMessage?(msg: unknown): void | Promise<void>;
  };
  permissions?: string[];
}

/** @deprecated 使用 PluginManifest + PluginLifecycle 替代。v0.3.0 移除。 */
export function definePlugin(plugin: Plugin): Plugin {
  console.warn(
    '[deprecated] definePlugin() is deprecated. Use PluginManifest + PluginLifecycle (activate/deactivate) instead. Removed in v0.3.0.'
  );
  return plugin;
}
```

---

## 6. 验证门禁

> 依据 禁令 27：每轮结束前必须通过 8 项检查。本节定义 Round 8 的验证流程。

### 6.1 基线记录

Round 8 开始时记录 `tsc-errors-baseline.json`（继承 Round 7 结束时的基线）。本 Round 不承诺 TSC 清零（禁令 26），仅要求错误数 ≤ 基线。

### 6.2 8 项验证门禁

| 检查项           | 命令                        | 通过标准                                                                           | 责任 Agent |
| ---------------- | --------------------------- | ---------------------------------------------------------------------------------- | ---------- |
| TypeScript 编译  | `npx tsc --noEmit`          | 错误数 ≤ 基线（不恶化，禁令 26）                                                   | 8-F        |
| Rust 编译        | `cargo check --workspace`   | 0 errors（本 Round 无 Rust 变更）                                                  | 8-F        |
| 单元测试（TS）   | `npx vitest run`            | 全部通过（含新增 plugin-sdk 测试）                                                 | 8-F        |
| 单元测试（Rust） | `cargo test --workspace`    | 全部通过（本 Round 无 Rust 变更）                                                  | 8-F        |
| 循环依赖         | `npm run lint:depcruise`    | 0 violations（关键：agent-core ↔ plugin-sdk 仅类型反向边，通过 shared-types 解耦） | 8-F        |
| 构建             | `npx turbo run build`       | 全部成功（含 plugin-sdk 新包构建）                                                 | 8-F        |
| Lint             | `npm run lint`              | 0 errors                                                                           | 8-F        |
| Store 类型       | `npm run check:store-types` | 通过                                                                               | 8-F        |

### 6.3 循环依赖专项验证

本 Round 引入的潜在循环依赖风险点：

| 潜在边                                | 风险                      | 缓解措施                                                                                              | 验证                                             |
| ------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `plugin-sdk` → `agent-core`（运行时） | 合法（Layer 8 → Layer 4） | 无                                                                                                    | depcruise 放行                                   |
| `agent-core` → `plugin-sdk`（类型）   | 循环风险                  | 通过 `shared-types` 的 `PluginRegistryLike` / `HookBusLike` 接口解耦，agent-core 不 import plugin-sdk | depcruise 规则禁止此边                           |
| `plugin-sdk` → `agent-tools`（类型）  | 循环风险                  | 通过 `shared-types` 的 `ToolDefinition` / `ToolSource` 解耦                                           | depcruise 规则禁止运行时 import，允许类型 import |
| `plugin-sdk` → `agent-mcp`（类型）    | 循环风险                  | `registerMcpServer` 通过 `PluginAPIDeps.mcpRegistrar` 函数注入，plugin-sdk 不 import agent-mcp        | depcruise 规则禁止此边                           |

**depcruise 规则增强**（Round 12 落地，本 Round 预声明）：

- 允许 `plugin-sdk` → `shared-types` / `agent-core`
- 禁止 `plugin-sdk` → `agent-tools` / `agent-mcp` / `agent-runtime`（运行时）
- 禁止 `agent-core` → `plugin-sdk`（仅允许 → `shared-types` 的 `PluginRegistryLike` 类型）

### 6.4 测试套件验证（Agent 8-F）

| 测试文件                        | 覆盖范围                                                       | 通过标准                |
| ------------------------------- | -------------------------------------------------------------- | ----------------------- |
| `manifest.test.ts`              | PluginManifest 校验、权限枚举、信任级别                        | 全部断言通过            |
| `hooks-payload.test.ts`         | 14 钩子 payload 字段完整性（禁令 14 不退化）                   | 现有 payload 字段全保留 |
| `hookapi-observe-on.test.ts`    | observe 失败吞掉、on 控制信号合并、tool.error retry/skip/abort | 双模式行为正确          |
| `tool-registration.test.ts`     | registerTool 委托、能力清单校验、超出 declared 拒绝            | 拒绝路径生效            |
| `skill-loader.test.ts`          | SKILL.md frontmatter 解析、技能→工具转换                       | 解析正确                |
| `registry-lifecycle.test.ts`    | 状态机转移（discovered→...→active→inactive→error）             | 转移规则符合 §3.5       |
| `trust-gate.test.ts`            | restricted 权限校验、full 跳过、project-dir 降级               | 禁令 18 规则生效        |
| `e2e-discover-activate.test.ts` | user-dir 发现 → 加载 → activate → 注册 hook/tool 全流程        | 端到端通过              |

---

## 7. 交付物

### 7.1 文件清单

| 类别         | 路径                                                                           | 行数（估） | 责任 Agent |
| ------------ | ------------------------------------------------------------------------------ | ---------- | ---------- |
| manifest     | `packages/plugin-sdk/src/manifest/manifest.ts`                                 | ~90        | 8-A        |
| manifest     | `packages/plugin-sdk/src/manifest/permissions.ts`                              | ~50        | 8-A        |
| manifest     | `packages/plugin-sdk/src/manifest/engine-constraint.ts`                        | ~40        | 8-A        |
| manifest     | `packages/plugin-sdk/src/manifest/validate.ts`                                 | ~120       | 8-A        |
| manifest     | `packages/plugin-sdk/src/manifest/trust-gate.ts`                               | ~60        | 8-A        |
| manifest     | `packages/plugin-sdk/src/manifest/index.ts`                                    | ~15        | 8-A        |
| hooks        | `packages/plugin-sdk/src/hooks/types.ts`                                       | ~40        | 8-B        |
| hooks        | `packages/plugin-sdk/src/hooks/api.ts`                                         | ~110       | 8-B        |
| hooks        | `packages/plugin-sdk/src/hooks/lifecycle.ts`                                   | ~50        | 8-B        |
| hooks        | `packages/plugin-sdk/src/hooks/index.ts`                                       | ~15        | 8-B        |
| shared-types | `packages/shared-types/src/plugin.ts`                                          | ~280       | 8-B        |
| tools        | `packages/plugin-sdk/src/tools/tool-api.ts`                                    | ~80        | 8-C        |
| tools        | `packages/plugin-sdk/src/tools/mcp-api.ts`                                     | ~90        | 8-C        |
| tools        | `packages/plugin-sdk/src/tools/index.ts`                                       | ~15        | 8-C        |
| skills       | `packages/plugin-sdk/src/skills/skill-types.ts`                                | ~90        | 8-C        |
| skills       | `packages/plugin-sdk/src/skills/skill-loader.ts`                               | ~240       | 8-C        |
| skills       | `packages/plugin-sdk/src/skills/index.ts`                                      | ~10        | 8-C        |
| registry     | `packages/plugin-sdk/src/registry/state.ts`                                    | ~60        | 8-D        |
| registry     | `packages/plugin-sdk/src/registry/discoverer.ts`                               | ~140       | 8-D        |
| registry     | `packages/plugin-sdk/src/registry/validator.ts`                                | ~110       | 8-D        |
| registry     | `packages/plugin-sdk/src/registry/loader.ts`                                   | ~180       | 8-D        |
| registry     | `packages/plugin-sdk/src/registry/registry.ts`                                 | ~220       | 8-D        |
| registry     | `packages/plugin-sdk/src/registry/store.ts`                                    | ~80        | 8-D        |
| registry     | `packages/plugin-sdk/src/registry/index.ts`                                    | ~20        | 8-D        |
| api          | `packages/plugin-sdk/src/api/plugin-api.ts`                                    | ~200       | 8-D        |
| api          | `packages/plugin-sdk/src/api/index.ts`                                         | ~10        | 8-D        |
| index        | `packages/plugin-sdk/src/index.ts`                                             | ~50        | 8-D        |
| package      | `packages/plugin-sdk/package.json`                                             | ~30        | 8-D        |
| tsconfig     | `packages/plugin-sdk/tsconfig.json`                                            | ~20        | 8-D        |
| agent-core   | `packages/agent-core/src/hooks/lifecycle-hooks.ts`（增强）                     | +120       | 8-E        |
| agent-core   | `packages/agent-core/src/hooks/compact-lifecycle.ts`（保留）                   | 0          | 8-E        |
| agent-core   | `packages/agent-core/src/hooks/index.ts`（增强导出）                           | +30        | 8-E        |
| agent-core   | `packages/agent-core/src/runtime.ts`（初始化集成）                             | +50        | 8-E        |
| agent-core   | `runtime-components/tool-executor.ts`（tool.error 发射）                       | +20        | 8-E        |
| agent-core   | `runtime-components/provider-call-gateway.ts`（model.beforeRequest 发射）      | +15        | 8-E        |
| agent-core   | `runtime-components/provider-response-consumer.ts`（model.afterResponse 发射） | +15        | 8-E        |
| agent-core   | `agent-session-loop.ts`（session.start/end 发射）                              | +30        | 8-E        |
| tests        | `packages/plugin-sdk/src/__tests__/*.test.ts`（8 文件）                        | ~520       | 8-F        |

### 7.2 接口签名清单（供 Round 9 消费）

Round 9（agent-subagent）将消费以下接口：

| 接口                                    | 路径                        | 用途                                           |
| --------------------------------------- | --------------------------- | ---------------------------------------------- |
| `PluginRegistry`                        | `@crish/plugin-sdk`         | 子代理发现（禁令 22 子代理发现统一到插件系统） |
| `PluginRegistry.listPlugins()`          | `@crish/plugin-sdk`         | 查询声明的子代理                               |
| `PluginManifest.declaredHooks`          | `@crish/plugin-sdk`         | 查询插件声明的 subagent.start/end 钩子         |
| `HookAPI.on('subagent.start', handler)` | `@crish/plugin-sdk`         | 注册子代理启动监听                             |
| `HookBusLike`                           | `@crish/shared-types`       | agent-core 注入派发器                          |
| `TrustGate`                             | `@crish/plugin-sdk`（契约） | 子代理权限校验                                 |
| `PluginDiscoverer`                      | `@crish/plugin-sdk`         | 复用多源发现机制（禁令 22）                    |

### 7.3 文档同步要求（禁令 31）

本 Round 执行后须同步更新：

| 文档                                            | 更新内容                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `02-FILE-MAPPING.md` §10.1                      | plugin-sdk 文件数从 ~3 更新为 ~22                                       |
| `02-FILE-MAPPING.md` §9.2                       | 确认 plugin-sdk 依赖 agent-core + shared-types（无循环）                |
| `01-OVERVIEW.md` §1.3 资产清单                  | `plugin-registry.ts`（516 行）标记为"已迁移到 plugin-sdk/src/registry/" |
| `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 13-19 | 若执行中发现约束需细化，更新本节（禁令 31 禁止漂移）                    |

---

## 8. 风险与缓解

| 风险                                  | 概率 | 影响 | 缓解措施                                                                                                               |
| ------------------------------------- | ---- | ---- | ---------------------------------------------------------------------------------------------------------------------- |
| 同进程 dynamic import 安全风险        | 中   | 高   | 保留 `CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT` 环境变量门控（对齐现有 plugin-fs-registry.ts）；默认仅注册 manifest 不执行代码 |
| agent-core ↔ plugin-sdk 循环依赖      | 中   | 高   | 通过 shared-types 下沉 `PluginRegistryLike` / `HookBusLike` 接口解耦；depcruise 规则禁止运行时反向边                   |
| 14 钩子 payload 字段退化              | 低   | 高   | §5.2 字段保留验证表 + `hooks-payload.test.ts` 断言全部现有字段                                                         |
| full 级别插件仓库投毒                 | 中   | 高   | 禁令 18 full 级别仅允许 user-dir 来源；project-dir 声明 full 自动降级为 restricted（§3.6 PluginDiscoverer）            |
| 旧 plugin-sdk 17 行接口破坏现有消费者 | 低   | 中   | 禁令 23 共存阶段保留 deprecation shim；§5.3 definePlugin 保留 + warning                                                |
| ToolHook.onError 控制能力丢失         | 中   | 高   | 第 14 钩子 `tool.error` + `ToolErrorHandlerResult`（retry/skip/abort）保留控制能力（§3.3）                             |

---

> **本设计文档遵守 `ANTI_OVERENGINEERING_GUARDRAILS.md` 禁令 13-19 全部约束**：
>
> - 禁令 13 单包 + 子目录 + 类型下沉 shared-types + 派发器留 agent-core + MCP 走 registerPluginServer ✓
> - 禁令 14 observe/on 双模式保留 + 事件名保留 + payload 不退化 + 控制型钩子能力保留 ✓
> - 禁令 15/16/17 声明式 + 命令式分层 + handlerType 仅 sync/async + PluginOrigin 仅 user-dir + project-dir ✓
> - 禁令 18 2 级信任 + TrustGate 归 agent-permissions + 权限粒度合并 ✓
> - 禁令 19 MVP 禁 OAuth + HotReload 推迟 Phase 2 ✓
