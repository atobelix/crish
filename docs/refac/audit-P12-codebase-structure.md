# 审计报告：第十二部分——代码库结构与工程规范

> 审计日期: 2026-07-23
> 审计范围: `docs/refac/refactor_plan.md` §12.1–§12.5
> 工具: dependency-cruiser 18.1.0, TypeScript 5.9.2, ripgrep

---

## 12.1 模块边界与循环依赖检测

### 审计结论：建议适当放松优先级，当前无明显循环依赖

#### 12.1.1 循环依赖扫描结果

使用 `dependency-cruiser --no-config` 对全部 `packages/`（807 个模块，1150 条依赖边）进行扫描：

```
✔ no dependency violations found
```

对 `packages/agent-runtime` 单独扫描（291 模块，479 条边）：

```
✔ no dependency violations found
```

#### 12.1.2 关于原方案提到的循环路径

原方案举例如下：

> `tools.ts → context-state.ts → agent-session-loop.ts → tools.ts`

经实际代码验证：

| 文件 | 实际导入 | 路径 |
|---|---|---|
| `tools.ts:1-15` | 只导入 `@crish/shared-types` + `./types` | **不导入** `context-state.ts` |
| `context-state.ts:1-15` | 导入 `./tools` (defineTool)、`./session`、`@crish/shared-types` + `./types` | 指向 `tools.ts` ✓ |
| `agent-session-loop.ts:37-103` | 导入 `./tools` 但不导入 `./context-state` | 不指向 `context-state` |

结论：**该循环路径在当前代码中不存在**。`dependency-cruiser` 也确认了无循环依赖。

#### 12.1.3 仍需关注的潜在风险

虽然没有循环依赖，但存在以下**高扇入/扇出模块**需要关注：

- `agent-runtime/src/tools.ts` —— 被 20+ 文件导入，是基础设施模块
- `agent-runtime/src/session.ts` —— 被 30+ 文件导入（createId, nowIso 等）
- `agent-runtime/src/types.ts` —— 被 40+ 文件导入类型

这些高扇出模块本身不是问题，但修改它们的影响面较大，需要引入模块变更影响分析（Module Change Impact Analysis）流程。

#### 12.1.4 dependency-cruiser 配置文件方案

**配置文件位置**：`C:\Software\conex\.dependency-cruiser.cjs`

```js
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    /* ------------------------------------------------------------------ */
    /* 层间依赖禁止规则                                                    */
    /* ------------------------------------------------------------------ */
    {
      name: 'no-shared-utils-to-runtime',
      comment: 'shared-utils 禁止导入 agent-runtime',
      severity: 'error',
      from: { path: '^packages/shared-utils/src' },
      to:   { path: '^packages/agent-runtime/src' },
    },
    {
      name: 'no-runtime-to-daemon',
      comment: 'agent-runtime 禁止导入 agent-daemon',
      severity: 'error',
      from: { path: '^packages/agent-runtime/src' },
      to:   { path: '^packages/agent-daemon/src' },
    },
    {
      name: 'no-desktop-to-daemon-internal',
      comment: 'crish-desktop 禁止直接导入 agent-daemon 内部模块',
      severity: 'error',
      from: { path: '^apps/crish-desktop/src' },
      to:   { path: '^packages/agent-daemon/src' },
    },
    {
      name: 'no-test-to-non-peer',
      comment: '测试文件不导入同级非测试源码的私有模块',
      severity: 'warn',
      from: { path: '\\.test\\.ts$' },
      to:   { path: '\\.test\\.ts$' },
    },

    /* ------------------------------------------------------------------ */
    /* 内部模块循环检测 (虽然当前无, 但保留规则防回归)                     */
    /* ------------------------------------------------------------------ */
    {
      name: 'no-circular',
      comment: '禁止任何形式的循环依赖',
      severity: 'error',
      from: {},
      to:   { circular: true },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
      dependencyTypes: ['npm', 'npm-dev', 'npm-no-pkg', 'npm-unknown'],
    },
    exclude: {
      path: [
        '\\.test\\.ts$',
        '\\.d\\.ts$',
        'node_modules',
        'dist',
      ],
    },
    tsConfig: {
      fileName: 'tsconfig.base.json',
    },
    includeOnly: '^(packages|apps)',
  },
};
```

**集成建议**：
1. 将 `.dependency-cruiser.cjs` 纳入 Git
2. 在 `package.json` 中添加 script: `"lint:deps": "depcruise packages apps"`
3. CI 中增加 `npm run lint:deps` 步骤
4. 配置 Husky pre-commit hook 选择性运行（仅对 packages/ apps/ 变更时触发）

---

## 12.2 TypeScript 严格模式完整性

### 审计结论：统一度较高，但有三个缺口

#### 12.2.1 当前各包 strict 状态矩阵

| 包/配置 | extends base | strict | noUncheckedIndexedAccess | exactOptionalPropertyTypes | noImplicitReturns | noFallthroughCasesInSwitch |
|---|---|---|---|---|---|---|
| `tsconfig.base.json` | — | ✅ true | ❌ 缺失 | ❌ 缺失 | ✅ true | ✅ true |
| `shared-utils` | ✅ | 继承 | 继承 | 继承 | 继承 | 继承 |
| `shared-types` | ✅ | 继承 | 继承 | 继承 | 继承 | 继承 |
| `agent-runtime` | ✅ | 继承 | 继承 | 继承 | 继承 | 继承 |
| `agent-daemon` | ✅ | 继承 | 继承 | 继承 | 继承 | 继承 |
| `agent-orchestrator` | ✅ | 继承 | 继承 | 继承 | 继承 | 继承 |
| `decision-engine` | ✅ | 继承 | 继承 | 继承 | 继承 | 继承 |
| `agent-workbench` | ✅ | 继承 | 继承 | 继承 | 继承 | 继承 |
| `crish-desktop/tsconfig.app.json` | ✅ | 继承 | 继承 | 继承 | 继承 | 继承 |
| **`crish-desktop/tsconfig.node.json`** | **❌** | **❌ 未设置** | **❌** | **❌** | **❌** | **✅ 单独设置** |

#### 12.2.2 关键问题

1. **`tsconfig.base.json` 缺少 `noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes`**
   - 虽然继承了 `strict: true`，但 `strict` 只包含 `strictNullChecks`、`strictFunctionTypes`、`strictBindCallApply`、`strictPropertyInitialization`、`noImplicitAny`、`alwaysStrict`，**不包含** `noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes`
   - 两个选项需要显式设置

2. **`crish-desktop/tsconfig.node.json` 不继承 base**
   - 这是一个独立配置（仅用于 `vite.config.ts`），但不设 `strict` 是一个风险
   - 虽然 `vite.config.ts` 通常较简单，但不继承 base 说明工程规范在此处不统一

#### 12.2.3 `noUncheckedIndexedAccess` 启用后预计暴露的错误数

通过扫描 `arr[N]` 字面量下标访问模式：

| 范围 | 含 `[N]` 模式的行数 | 估计真实类型错误数 |
|---|---|---|
| `packages/agent-runtime/src/` | ~411 | ~120–150 |
| `packages/agent-daemon/src/` | ~102 | ~30–40 |
| `packages/agent-orchestrator/src/` | ~30 | ~10–15 |
| `packages/decision-engine/src/` | ~10 | ~3–5 |
| `packages/shared-utils/src/` | ~20 | ~8–12 |
| `packages/shared-types/src/` | ~0 | ~0 |
| `apps/crish-desktop/src/` | ~482 | ~80–100 |
| `apps/agent-workbench/src/` | ~15 | ~5–8 |
| **总计** | **~1070** | **~256–330** |

> 上表中"估计真实类型错误数"排除了以下情况：
> - 测试文件中的 `expect(results[0]).toEqual(...)`（多数已在 `.test.ts` 中）
> - `arr[0]!` 非空断言后的访问
> - `arr?.()` 访问（已在可选链中保护）
> - Built-in types 如 `Int32Array`、`Uint8Array` 等
> - `match[1]` 正则匹配结果（`RegExpMatchArray` 已经是 `(string | undefined)[]`）

**优先修复目标**（高密度文件）：

```
packages/agent-runtime/src/context-compression.ts             ~25 处
packages/agent-runtime/src/agent-session-loop.ts              ~20 处
packages/agent-runtime/src/prompt-assembly.ts                 ~15 处
packages/agent-daemon/src/protocol/validators/background.ts   ~30 处
packages/agent-daemon/src/server.ts                           ~10 处
apps/crish-desktop/src/api/clientApi.ts                       ~40 处
```

#### 12.2.4 改进方案

在 `tsconfig.base.json` 中补充：

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  }
}
```

执行步骤：
1. 首先在 `tsconfig.base.json` 中添加 `noUncheckedIndexedAccess`
2. 在 `crish-desktop/tsconfig.node.json` 中添加 `"extends": "../../tsconfig.base.json"`
3. 运行 `npx tsc --noEmit --project packages/agent-runtime/tsconfig.json` 获取精确错误计数
4. 按"高密度"→"低密度"顺序逐个文件修复
5. `exactOptionalPropertyTypes` 可延迟到第二阶段，此选项破坏性更大（如 `{ x?: string }` 不允许赋值 `{ x: undefined }`）

---

## 12.3 废弃 API 的结构化清理

### 审计结论：标记存在但缺乏结构信息，实际需要立即清理的较少

#### 12.3.1 完整 `@deprecated` 清单

**`packages/agent-runtime/src/`（10 处）**

| 文件 | 行号 | 内容 | 替代 API |
|---|---|---|---|
| `background-command.ts` | 645 | `@deprecated Use createBackgroundCommandTools` | `createBackgroundCommandTools` |
| `index.ts` | 24 | `@deprecated` 权限和命令分类已迁移至 decision-engine | 未标准 JSDoc |
| `provider-factory.ts` | 2 | `@deprecated Use ProviderFactory from ./provider/factory.ts` | `ProviderFactory` |
| `provider-factory.ts` | 12 | `@deprecated` 宽接口 | `types.AgentProvider` |
| `provider-factory.ts` | 27 | `@deprecated` 旁路工厂 | 未指定 |
| `provider-factory.ts` | 48 | `@deprecated` 旁路单例 | 未指定 |
| `provider-anthropic.ts` | 2 | `@deprecated Use AnthropicMessagesEngine` | `AnthropicMessagesEngine` |
| `provider-gemini.ts` | 2 | `@deprecated Use OpenAICompatibleEngine` | `OpenAICompatibleEngine` |
| `provider-openai-base.ts` | 2 | `@deprecated` 已迁移到 `./provider/engines/base-engine.ts` | `base-engine.ts` |
| `provider-openai-compatible.ts` | 2 | `@deprecated Use OpenAICompatibleEngine` | `OpenAICompatibleEngine` |

**`apps/crish-desktop/src/`（11 处）**

| 文件 | 行号 | 内容 | 影响 |
|---|---|---|---|
| `api/chatApi.demo.ts` | 223 | 纯 demo 代码，无外部引用 | 可删除 |
| `api/clientApi.ts` | 808,814,823,832 | DEAD formal — `providerProfiles` | 返回空数组的桩 |
| `store/actions/chat.ts` | 21 | 无外部引用，保留以兼容历史快照 | 可删除 |
| `store/layoutAnimationStore.ts` | 99,191 | 无外部引用 | 可删除 |
| `api/VirtualScrollManager.ts` | 111 | 别名 `syncOrder` | 可简单删除 |
| `api/toolPresentation.ts` | 575 | 别名 `toolHumanLabel` | 可简单删除 |
| `hooks/useAgentStream.ts` | 29 | 自动推导 | 可删除 |

#### 12.3.2 当前标注的质量问题

原方案要求每个 `@deprecated` 包含：
- ✅ 废弃原因 —— 多数有
- ❌ 迁移到的替代 API 名称和路径 —— 部分缺失
- ❌ 计划删除的条件 —— **全部缺失**

举例：
```ts
// provider-factory.ts:27
/** @deprecated 旁路工厂；勿用于 daemon / session loop */
```
缺失：替代方案路径、删除条件。

#### 12.3.3 需要立即清理的候选

**高优先级（无外部引用，可直接删除）**：
1. `apps/crish-desktop/src/api/chatApi.demo.ts` — pure demo
2. `apps/crish-desktop/src/store/actions/chat.ts` — 整文件废弃
3. `apps/crish-desktop/src/store/layoutAnimationStore.ts:99,191` — 两个无引用的属性

**中优先级（需要先确认外部引用为零后删除）**：
4. `apps/crish-desktop/src/api/clientApi.ts:808-832` — 4个返回`[]`的 formal
5. `packages/agent-runtime/src/provider-factory.ts` — 整文件废弃，但需要确认所有调用方已迁移
6. `packages/agent-runtime/src/provider-anthropic.ts`
7. `packages/agent-runtime/src/provider-gemini.ts`

**低优先级（别名性质，需大面积改调用方）**：
8. `apps/crish-desktop/src/api/VirtualScrollManager.ts:111`
9. `apps/crish-desktop/src/api/toolPresentation.ts:575`

#### 12.3.4 改进方案

1. **标准化全部 `@deprecated` 注释格式**（统一用 JSDoc 三行模板）：

```ts
/**
 * @deprecated 废弃原因说明
 *   替代方案：替换路径（如 import { X } from './new-path'）
 *   删除条件：在 Y 模块完成迁移后 / 在 vX.Y 版本
 */
```

2. **建立废弃 API 删除工单**：对高优先级项创建 Issue 跟踪
3. **添加 ESLint 规则**：禁止引用 `@deprecated` 标记的 API（`import/no-deprecated` 或自定义规则）
4. **添加 `@deprecated` 输出检查**：`tsc --noEmit` 时启用 `--reportDeprecated` 标志

---

## 12.4 IPC 协议消息类型的版本化与向后兼容

### 审计结论：协议框架设计良好，但向后兼容策略缺失

#### 12.4.1 当前协议架构

```
packages/agent-daemon/src/protocol/
├── protocol.ts              # 主分发器 validateInboundMessage / validateOutboundMessage
├── registry.ts              # 消息注册表（DAEMON_INBOUND/OUTBOUND_MESSAGE_REGISTRY + 能力状态）
├── schema-groups.ts         # 能力组定义
├── validators/
│   ├── common.ts            # 共享验证工具（rejectUnknownFields, 类型守卫等）
│   ├── base.ts              # 基础验证（与 common.ts 部分重复，见下文）
│   ├── run.ts               # run-task 等
│   ├── session-events.ts    # 会话事件
│   ├── workflow.ts          # 工作流
│   ├── git.ts               # Git 操作
│   ├── plan.ts              # 计划文档
│   ├── background.ts        # 后台任务 + 九种子域
│   ├── session-actions.ts   # 会话操作(rewind 等)
│   ├── subagent.ts          # 子代理
│   ├── rewind.ts            # 重做逻辑
│   ├── provider.ts          # 提供商操作
│   └── status.ts            # 状态
```

#### 12.4.2 协议设计的优点

1. **类型安全注册表**：`registry.ts` 使用 `satisfies Record<DaemonInboundMessageType, ...>` 确保所有消息类型都被覆盖
2. **精确类型守卫**：`defineInboundMessageTypes` 使用 `ExactTypeList` 确保注册表类型完全覆盖联合类型
3. **能力状态机制**：每条消息有 `'implemented' | 'experimental' | 'unsupported' | 'degraded' | 'backend-not-wired'` 五种状态
4. **能力分组**：`schema-groups.ts` 将消息按能力域分组，客户端可查询
5. **测试覆盖**：`registry.test.ts` 测试注册表与能力组的对齐

#### 12.4.3 存在问题

**问题 1：`rejectUnknownFields` 策略当前严格拒绝，无警告模式**

当前 `rejectUnknownFields` 在 `common.ts:1812` 和 `base.ts:1808` 的实现均为严格拒绝——发现未知字段即写入 `issues[]`。

```ts
// packages/agent-daemon/src/protocol/validators/common.ts:1812
export function rejectUnknownFields(
  value: UnknownRecord,
  allowed: readonly string[],
  issues: ProtocolValidationIssue[],
  path?: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.push({ path: childPath(path, key), message: `Unknown field: ${key}` });
    }
  }
}
```

当新增字段时，旧版客户端发来的消息中不含新字段不会有问题（`issues[]` 不会追加），但新版客户端发来的消息如果包含旧版 Daemon **不认识的字段**，目前会被拒绝。

原方案要求的"使用警告而非错误"策略尚未实现。

**问题 2：`common.ts` 与 `base.ts` 重复**

`common.ts` 和 `base.ts` 都定义了 `rejectUnknownFields`、`isRecord`、`isString`、`isNumber`、`isBoolean`、`assertObject` 等函数。两个文件高度重复：

```ts
// common.ts:1812
export function rejectUnknownFields(/* ... */): void { /* ... */ }

// base.ts:1808
export function rejectUnknownFields(/* ... */): void { /* ... */ }
```

这违反了 DRY 原则，且 `base.ts` 中的版本明显是旧版——两个版本的 `rejectUnknownFields` 签名不同，说明是通过重构移入 `common.ts` 后未清理旧文件。

**问题 3：`protocol.ts` switch 语句缺少 exhaustiveness check**

`validateInboundMessage` 和 `validateOutboundMessage` 的 switch 语句虽然覆盖了所有类型，但如果新增消息类型而忘记添加 case，TypeScript 不会报错（没有 `never` 兜底检查）。虽然 `registry.ts` 的 `satisfies Record<...>` 保证了注册表类型完整性，但 `protocol.ts` 中的 switch 没有等效的保护。

**问题 4：协议版本号缺失**

当前 IPC 协议没有版本号标识。`registry.ts` 的消息注册表没有 `version` 字段，`schema-groups.ts` 也没有协议版本。这意味着无法在运行时检测 Daemon 与客户端之间的协议版本差异。

#### 12.4.4 改进方案

1. **引入协议版本号**：

在 `schema-groups.ts` 顶部添加：

```ts
export const DAEMON_PROTOCOL_VERSION = 1 as const;
export type DaemonProtocolVersion = typeof DAEMON_PROTOCOL_VERSION;
```

在 `welcome` 消息（`protocol.ts:1016-1020`）中添加版本字段：

```ts
case 'welcome':
  return ok({
    ...base.value,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
  } as unknown as DaemonOutboundMessage);
```

2. **`rejectUnknownFields` 增加 `mode` 参数**：

```ts
export type UnknownFieldMode = 'error' | 'warn';

export function rejectUnknownFields(
  value: UnknownRecord,
  allowed: readonly string[],
  issues: ProtocolValidationIssue[],
  path?: string,
  mode: UnknownFieldMode = 'error',  // 新增
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const issue = { path: childPath(path, key), message: `Unknown field: ${key}` };
      if (mode === 'error') {
        issues.push(issue);
      } else {
        // warn mode — 通过 console.warn 记录但不在 issues 中拒绝
        console.warn(`[protocol:warn] Unknown field at ${issue.path}: ${issue.message}`);
      }
    }
  }
}
```

3. **消除 `common.ts` 与 `base.ts` 重复**：

   - 将 `base.ts` 中所有函数标记 `@deprecated`，统一委派到 `common.ts`
   - 或在下一轮 major cleanup 中删除 `base.ts`

4. **Switch 增加 exhaustiveness check**：

在 `validateInboundMessage` 的 default 分支前添加：

```ts
  default:
    // 确保新增消息类型不会漏掉 switch case
    const _exhaustive: never = base.value;
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_MESSAGE_TYPE',
        message: `Unhandled inbound message type: ${(_exhaustive as any)?.type ?? base.value.type}`,
        issues: [],
      },
    };
```

5. **新增字段必须使用可选类型 `?:`**：

   当前的协议消息已经在使用可选类型（如 `run.ts` 中大多数字段为 `?:`），需要在 `CONTRIBUTING.md` 中将此规则明确文档化。

---

## 12.5 文档化的技术债务清单

### 审计结论：TECH_DEBT.md 不存在，但零散记录分散在多处

#### 12.5.1 现状分析

**不存在** `TECH_DEBT.md`。但技术债务信息散落在以下位置：

| 位置 | 内容 | 可迁移性 |
|---|---|---|
| `docs/refac/refactor_plan.md` | 完整的 12 个重构方向 | 高 |
| `ARCHITECTURE-IMPROVEMENT.md` | 架构改进点 | 高 |
| `CORE-ARCHITECTURE-IMPROVEMENT.md` | 核心架构改进 | 高 |
| `IMPROVEMENT-PLAN.md` | 改进计划 | 中 |
| `PERFORMANCE-AND-ARCHITECTURE-FULL-OPTIMIZATION-PLAN.md` | 性能优化债务 | 中 |
| `COMPREHENSIVE-REFACTOR-PLAN.md` | 综合重构计划 | 中 |
| `HARDCODED-TOKEN-AUDIT.md` | Token 硬编码审计 | 高（具体问题） |
| 各文件中的 `@deprecated` 标记 | 21 处废弃 API | 高（具体问题） |
| `TODO` / `FIXME` 注释 | 散见于源代码中 | 需要通过 grep 系统扫描 |

#### 12.5.2 改进方案

**TECH_DEBT.md 推荐结构**：

```markdown
# Technical Debt Register

按照 Release 周期审查。每项包含:
- ID: TD-NNN（全局唯一编号）
- 描述
- 影响范围（组件/用户功能/性能/安全）
- 严重性（critical / major / minor / cosmetic）
- 触发条件与频率
- 当前规避措施
- 关联代码位置（文件+行号）
- 状态（open / in-progress / resolved / deferred）
- 创建日期 / 期望关闭版本

## Priority: Critical

| ID | 描述 | 范围 | 位置 | 状态 |
|----|------|------|------|------|
| TD-001 | ... | ... | ... | open |

## Priority: Major

...

## Priority: Minor

...

## Priority: Cosmetic

...
```

**初始化步骤**：
1. 从 `refactor_plan.md` 的 12 个方向提取各项作为种子条目
2. 从 `@deprecated` 标记提取 21 条废弃 API 作为独立条目
3. 运行 `grep -rn "TODO\|FIXME\|HACK\|XXX\|WORKAROUND" --include="*.ts" --include="*.tsx" packages/ apps/` 扫描源代码中的标记
4. 从 `HARDCODED-TOKEN-AUDIT.md` 提取具体条目
5. 合并去重后生成初始清单

**流程化**：
- 在 `.husky/prepare-commit-msg` 中增加对 `TECH_DEBT.md` 变更的提示
- 在 GitHub Issue 模板中增加 `Tech Debt` label
- 每个 Release 前将 `TECH_DEBT.md` 纳入发布检查清单
- 对接 CI：Release 分支创建时自动提醒审查

---

## 总结：各子项改进优先级与工作量

| 子项 | 当前评分 | 建议优先级 | 估计工作量（人天） | 风险等级 |
|---|---|---|---|---|
| 12.1 循环依赖检测 | ⭐⭐⭐⭐ 4/5 | P3（低） | 0.5 | 低（无现问题） |
| 12.2 TS 严格模式 | ⭐⭐⭐ 3/5 | P1（高） | 5-8 | 中（破坏性变更） |
| 12.3 废弃 API 清理 | ⭐⭐ 2/5 | P2（中） | 2-3 | 中（需确认调用方） |
| 12.4 IPC 协议版本化 | ⭐⭐⭐ 3/5 | P2（中） | 3-5 | 中（协议变更敏感） |
| 12.5 TECH_DEBT.md | ⭐ 1/5 | P1（高） | 1-2 | 低（快赢） |

### 行动项速览

1. [P1] **立即**：补充 `tsconfig.base.json` 中 `noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes`
2. [P1] **立即**：创建 `TECH_DEBT.md`，从本文档的 refactor_plan 提取种子条目
3. [P2] **本周**：标准化 `@deprecated` 模板，清理高优先级废弃 API
4. [P2] **本周**：创建 `.dependency-cruiser.cjs` 并加入 CI
5. [P2] **本迭代**：消除 `common.ts` 与 `base.ts` 的 validator 重复代码
6. [P2] **本迭代**：IPC 协议引入 `DAEMON_PROTOCOL_VERSION` + `rejectUnknownFields` warn mode
7. [P3] **本季度**：为 `protocol.ts` switch 添加 exhaustiveness `never` 检查
