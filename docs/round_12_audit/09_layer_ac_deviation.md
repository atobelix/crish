# Layer A / C 实际落地偏差审计报告

> Agent 9 — 审计日期: 2026-07-24
> 对照文档: `docs/crish_desktop_architectural_remediation_plan/01_foundation_safety.md` (A), `docs/crish_desktop_architectural_remediation_plan/03_runtime_engine.md` (C)

---

## 检查项 1: workbench-contract.ts 拆分（A-1）

**评级：符合 ✅**

### 实际状态
- `apps/agent-workbench/src/shared/workbench-contract.ts` (L1-L5) — 已替换为 5 行 barrel，内容为 `export * from "./workbench-contract/index"`
- 子模块目录 `workbench-contract/` 包含 12 个 `.ts` 文件，所有文件 ≤ 500 行

| 文件 | 行数 | 符合计划 |
|------|------|---------|
| `index.ts` | 19 | ✅ barrel |
| `plan-document.ts` | 244 | ✅ D2 |
| `approval.ts` | 235 | ✅ D3 |
| `daemon-session.ts` | 249 | ✅ D4 |
| `conversation-rewind.ts` | 407 | ✅ D5 |
| `daemon-status.ts` | 290 | ✅ D6 |
| `task-snapshot.ts` | 311 | ✅ D7a |
| `workbench-ui.ts` | 457 | ✅ D7b |
| `sidecar.ts` | 5 | ✅ D7c (占位) |
| `config.ts` | 5 | ✅ D7d (占位) |
| `guards.ts` | 399 | ✅ guards |
| `ui-projections.ts` | 248 | ⚠️ 额外文件 |

### 偏差清单
| 偏差项 | 严重度 | 说明 |
|--------|--------|------|
| `ui-projections.ts` 非计划文件 | 低 | 原计划未列出此文件，但不破坏向后兼容性 |
| `config.ts` / `sidecar.ts` 近乎空文件 | 低 | 计划中 D7c/D7d 仅"保留未来类型"，当前确无对应类型需要迁移 |
| `WorkbenchJsonPrimitive/Value/Object` 已替换为 `@crish/shared-types` deprecated 别名 | ✅ 符合 | `index.ts` L3-L9 |
| barrel 导出覆盖全部子模块 | ✅ 符合 | `index.ts` L11-L21 |

### 推荐修复
- 无需修复。已完成拆分，子模块覆盖全部领域。

---

## 检查项 2: async-mutex 修复（A-3）

**评级：符合 ✅**

### 实际状态
- `AsyncMutex.acquire` L72: `queueMicrotask(() => this.release());` ✅
- `AsyncSemaphore.acquire` L156: `queueMicrotask(() => this.release());` ✅
- 测试文件 `async-mutex.test.ts` 包含两个 500 并发 abort 测试:
  - L95-L110: `AsyncMutex recursive release stack overflow`
  - L112-L127: `AsyncSemaphore recursive release stack overflow`

### 偏差清单
| 偏差项 | 严重度 | 说明 |
|--------|--------|------|
| 无 | — | 完全符合计划 A-3 要求 |

### 推荐修复
- 无需修复。

---

## 检查项 3: ErrorClassifier 统一（C2-8）

**评级：部分符合 ⚠️**

### 实际状态
#### 已完成的迁移
| 位置 | 行号 | 状态 | 证据 |
|------|------|------|------|
| `base-engine.ts` | L61-L73 | ✅ 已使用 `ErrorClassifier.classify` | `const classified = ErrorClassifier.classify(error, { status, signal })` |
| `fallback-chain/engine.ts` | L5-L17 | ✅ `classifyFallbackError` 使用 `ErrorClassifier.classify` | L9: `const classified = ErrorClassifier.classify(err, { status })` |
| `provider-openai-compatible.ts` 3 个包装函数 | L480-L494 | ✅ 内部委托给 `ErrorClassifier.classify` | 3 函数均调用 `ErrorClassifier.classify()` |
| `provider-error-classifier.ts` | L30-L48 | ✅ `ProviderErrorClassifier` 类存在 | `classify()` 方法内部调用 `ErrorClassifier.classify` |
| `error-classifier.ts` | L58 | ✅ `ErrorClassifier.classify` 静态方法 | 核心分类器已就位 |

#### 未完成/额外的独立分类逻辑
| 位置 | 行号 | 状态 | 说明 |
|------|------|------|------|
| `provider-stream-contract/error.ts` | L42-L61 | ❌ 自有 `classifyProviderStreamErrorKind` | 完全独立的 if/else 链，不调用 `ErrorClassifier` |
| `provider-stream-contract/normalizer.ts` | L50-L57 | ❌ 自有 `classifyErrorMessage` | 简化的内联 if/else，不调用 `ErrorClassifier` |
| `provider-openai-base.ts` → `classifyProviderErrorMessage` | L468 | ❌ 仍然导出 | 已包装 `ErrorClassifier.classify` 但作为独立函数仍存在 |
| `session-loop/index.ts` | L255 | ❌ 仍调用 `classifyProviderErrorMessage` | 未迁移到 `ErrorClassifier.classify` |
| `session-loop/types.ts` | L27 | ❌ 仍调用 `classifyProviderErrorMessage` | 未迁移到 `ErrorClassifier.classify` |

### 偏差清单
| 偏差项 | 严重度 | 说明 |
|--------|--------|------|
| `classifyProviderErrorMessage` 仍有 2 个生产调用者 | 中 | `session-loop/index.ts:255`、`session-loop/types.ts:27` |
| `classifyProviderStreamErrorKind` 独立逻辑未合并 | 中 | 位于 `provider-stream-contract/error.ts:42-61`，与 ErrorClassifier 逻辑重复 |
| `classifyErrorMessage` 内联逻辑未合并 | 低 | 位于 `provider-stream-contract/normalizer.ts:50-57`，简单的字符串匹配 |
| `classifyHttpProviderError` 在测试中以独立函数形式被测试 | 低 | `payload-image-recovery.test.ts:10` import |

### 推荐修复
1. 将 `session-loop/index.ts:255` 和 `session-loop/types.ts:27` 的 `classifyProviderErrorMessage` 调用改为 `ErrorClassifier.classify`
2. 将 `provider-stream-contract/error.ts:42-61` 的 `classifyProviderStreamErrorKind` 内联分类改为委托 `ErrorClassifier.classify`
3. 将 `provider-stream-contract/normalizer.ts:50-57` 的 `classifyErrorMessage` 改为使用 ErrorClassifier

---

## 检查项 4: ProviderRegistryV2（C2-1）

**评级：符合（带警告）⚠️**

### 实际状态
| 方法 | 行号 | 实现 | 状态 |
|------|------|------|------|
| `registerProviderClass(id, providerClass)` | L113-L115 | `this.providerClasses.set(id, providerClass)` | ✅ |
| `registerProviderFactory(id, factory)` | L117-L119 | `this.providerFactories.set(id, factory)` | ✅ |
| `registerEngineClass(id, engineClass)` | L121-L124 | `this.engineClasses.set(engineClass.id, engineClass)` | ✅ |
| `syncRoutes()` | L305-L307 | 空实现 + 注释 | ⚠️ stub |
| 接口定义 | L54-L72 | 完整接口方法签名 | ✅ |

### 偏差清单
| 偏差项 | 严重度 | 说明 |
|--------|--------|------|
| `syncRoutes()` 为 no-op stub | 中 | L305-L307: 注释标明 "Route sync will be implemented in C2-12"；计划文档要求 `syncRoutes()` 确保 StaticProviderRouteCatalog 与 Registry 一致 |

### 推荐修复
- 实现 `syncRoutes()` 逻辑，将新注册的 Provider 同步到 `StaticProviderRouteCatalog`

---

## 检查项 5: GatewayV2Bridge 去单例化（C2-9）

**评级：符合 ✅**

### 实际状态
- `provider-gateway/factory.ts` 全文 35 行：**无全局变量 `_gatewayBridge`**
- 全代码库搜索 `_gatewayBridge`：**0 个匹配**
- `factory.ts` 中 `initProviderEngine()` 直接 `new GatewayV2Bridge(undefined, secretStore)`（L7）
- `GatewayV2Bridge` 类（`provider/provider-gateway-v2.ts`）通过构造函数依赖注入（L42: `constructor(registry?, secretStore?)`）
- `resetProviderEngine()` 注释确认去单例化已完成（L33）

### 偏差清单
| 偏差项 | 严重度 | 说明 |
|--------|--------|------|
| 无 | — | 完全符合 C2-9 要求 |

### 推荐修复
- 无需修复。

---

## 总结表

| 编号 | 检查项 | 评级 | 关键偏差 |
|------|--------|------|---------|
| A-1 | workbench-contract 拆分 | ✅ 符合 | 新增 `ui-projections.ts` 非计划文件（低）；`config.ts`/`sidecar.ts` 占位（低） |
| A-3 | async-mutex `queueMicrotask` | ✅ 符合 | 无 |
| C2-8 | ErrorClassifier 统一 | ⚠️ 部分符合 | `classifyProviderErrorMessage` 仍有 2 个生产调用者；`classifyProviderStreamErrorKind` 独立逻辑未合并 |
| C2-1 | ProviderRegistryV2 双轨注册 | ⚠️ 符合（stub） | `syncRoutes()` 为 no-op |
| C2-9 | GatewayV2Bridge 去单例化 | ✅ 符合 | 无 |
