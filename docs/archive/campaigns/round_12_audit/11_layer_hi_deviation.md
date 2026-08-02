# Layer H/I 落地偏差审计报告

> 对照文档：08_tool_hook_chain.md / 09_ci_cd_release.md
> 审计范围：Layer H (ToolHook / ApprovalPipeline / ToolPresetRegistry) + Layer I (CI/CD)
> 审计时间：2026-07-24

---

## 1. ToolHook 接口精简（H-1/H-2）

### 1.1 规划 vs 代码的方法数偏差

| 维度 | 规划文档 §4.2 | 代码落地 `tool-hook-types.ts` |
|------|-------------|---------------------------|
| 方法数 | **6**（beforeRegister / beforeResolve / beforeApprove / beforeExecute / afterExecute / onError） | **3**（beforeExecute / onResult / onError） |
| 命名 | afterExecute | onResult（重命名） |
| 缺失方法 | — | beforeRegister、beforeResolve、beforeApprove、afterExecute 均被裁剪 |

**结论：方法数从 6 精简到 3，属于规划范围外的主动简化。** 规划文档仍停留在 6 方法设计，未同步更新。`beforeRegister` / `beforeResolve` / `beforeApprove` 三个阶段的功能可能被隐式合并到了 `beforeExecute` 中，但缺少显式设计文档说明合并逻辑。

### 1.2 tool-hook-observability.ts 与 types 类型不一致

`tool-hook-observability.ts:17-21` 重新声明了 `ToolHook` 接口，而非从 `tool-hook-types.ts` 导入：

| 差异点 | tool-hook-types.ts | tool-hook-observability.ts |
|--------|-------------------|---------------------------|
| 返回类型 | `BeforeExecuteResult \| Promise<BeforeExecuteResult>` / `ToolResult<TOutput>` / `OnErrorResult` | 全部 `unknown` |
| 上下文 | `ToolExecutionContext`（来自 shared-types） | 自有 `ToolHookContext`（字段不同：sessionId/traceId/toolName/toolCallId/runId/mode） |
| 定义方式 | 独占定义 | 重复定义（类型漂移风险） |

**偏差：observability 层的 ToolHook 接口与 types 层不同步。** 若 types 层新增/修改方法签名，observability 层不会自动感知。

### 1.3 MiddlewarePipeline 废弃状态

`middleware-pipeline.ts`:
- 已标记 `@deprecated` ✅
- 仍包含完整的功能性实现（非空桩）
- 有 `@removeWhen 确认所有外部消费者已迁移` 但未明确目标版本

**结论：符合"标记废弃"期望，但尚未清除。** 需确认无外部消费者后移除。

---

## 2. ApprovalPipeline 独立（H-3）

### 2.1 导入清单检查

`approval-pipeline.ts` 的 import 清单：

```
@crish/shared-types  →  JsonObject, PermissionDecision, PermissionRequest, ApprovalHandler
../types             →  AgentTool, RuntimePermissionPolicy, RuntimePermissionRequest
./approval-cache     →  ApprovalCache
```

**未引用 `session-loop/` 或 `agent-session-loop` → 通过 ✅**

### 2.2 架构完整性偏差

规划文档 §4.3 设计 5 阶段流水线，但实际实现仅覆盖 3 个阶段：

| 规划阶段 | 代码落地 | 状态 |
|---------|---------|------|
| 规则匹配（RuleMatcher） | `permissionPolicy.decide()` 调用 | ✅ 间接实现 |
| 审批缓存（ApprovalCache） | `cache.get(intentKey)` | ✅ |
| 自动审批（AutoApprovalClassifier） | **缺失** | ❌ |
| 用户交互 | `handler.requestApproval()` | ✅ |
| 拒绝跟踪（DenialTracker） | **缺失** | ❌ |

### 2.3 阶段结构简化

实际 `decide()` 方法将规则匹配和自动审批合并为单一的 `permissionPolicy.decide()` 调用，未区分 policy 决策的不同子阶段。审批缓存仅覆盖 `ask` 分支，未覆盖 `allow`/`deny` 的缓存。

---

## 3. ToolPresetRegistry（H-6）

### 3.1 ToolMode 完整度

```typescript
export type ToolMode = "plan" | "ask" | "auto" | "full-access" | "unattended";
```

**全部 5 种 mode 已定义 ✅**

### 3.2 prompt-assembly.ts 调用链

`prompt-assembly.ts:142`:
```typescript
const filtered = ToolPresetRegistry.filterTools(input.tools, mode);
```

**已调用 `ToolPresetRegistry.filterTools()` ✅**

### 3.3 预设默认值与规划差异

| mode | 规划 §4.4 toolIds | 代码 toolIds | 偏差 |
|------|-------------------|-------------|------|
| plan | `["read_files", "search_codebase"]` | `["read_files", "search_codebase", "glob", "grep", "list_files"]` | 代码更宽松（额外 3 个工具），还有 `categoryFilter: ["filesystem"]` |

---

## 4. CI 门禁（I-1~I-7）

### 4.1 逐项检查

| 编号 | 要求 | 状态 | 证据 |
|------|------|------|------|
| I-1 | concurrency 控制（cancel-in-progress） | ❌ **缺失** | ci.yml 无 `concurrency:` 块（release.yml 有，但 ci.yml 无） |
| I-2 | workflow 权限最小化 | ❌ **缺失** | ci.yml 无 `permissions:` 块，使用默认 GITHUB_TOKEN 权限 |
| I-3 | 路径过滤（paths-ignore） | ❌ **缺失** | ci.yml 无 `paths-ignore` 或 `paths` 触发过滤 |
| I-4 | turbo 缓存 | ❌ **缺失** | CI 直接 `npm ci` + 裸命令，未使用 `turbo run`（turbo.json 已定义 pipeline） |
| I-5 | typecheck:ci 全覆盖 | ❌ **部分覆盖** | `typecheck` script 仅覆盖 `crish-desktop`；`check:core` 覆盖更多但未被 CI 使用 |
| I-6 | lint 零 warning 强制 | ✅ | CI line 28: `npm run lint:all`（package.json 中带 `--max-warnings 0`） |
| I-7 | 覆盖率硬性化（Rust 有，TS 无） | ⚠️ **仅 Rust 侧** | Rust 覆盖率阈值 50% 有硬性检查；TypeScript 侧无覆盖率阈值验证 |

### 4.2 整体 CI 评估

CI 目前的结构仍处于"基本验证"阶段，未达到 09 文档规划的 Round 0~Round 2 标准。与规划的四层架构相比，当前 CI 仅覆盖了 Layer 2（增量验证）的少量项目，缺少并发控制、权限最小化、路径过滤、turbo 集成等 Round 0 基础配置。

---

## 5. 安全审计（I-10/I-11）

| 项目 | 状态 | 说明 |
|------|------|------|
| `npm audit --audit-level=moderate` | ✅ ci.yml:27 | 已存在，无 `continue-on-error` |
| `cargo deny check` | ✅ ci.yml:83-84 | 已存在 |
| 密钥扫描（trufflehog/gitleaks） | ❌ **缺失** | ci.yml 无相关 job |
| `continue-on-error: true` 消除 | ✅ | 当前 ci.yml 无 `continue-on-error` 模式 |

**npm audit 和 cargo deny 已落实 ✅，密钥扫描（I-11）未落实 ❌**

---

## 6. depcruise 门禁（I-12）

### 6.1 CI 中排除 dist/

ci.yml:139:
```
npx depcruise --config .dependency-cruiser.cjs packages apps --ignore "dist/"
```

**`--ignore "dist/"` 已存在 ✅**

### 6.2 no-runtime-to-shared 降级

存在两份 depcruise 配置：

| 文件 | no-runtime-to-shared severity | 备注 |
|------|------------------------------|------|
| `.dependency-cruiser.js` | `error` | 旧配置，未用于 CI |
| `.dependency-cruiser.cjs` | **`warn`** | CI 实际使用的配置，doNotFollow 含 `dist` |

**已降级为 warn ✅**

两份配置并存存在维护风险——若修改 `.dependency-cruiser.js` 而 CI 使用 `.dependency-cruiser.cjs`，开发者可能误以为规则生效。

---

## 7. 总偏差矩阵

| 检查项 | 规划要求 | 实际状态 | 偏差级别 |
|--------|---------|---------|---------|
| H-1 ToolHook 方法数 | 6 方法（§4.2） | 3 方法 | ⚠️ 规划未同步简化 |
| H-2 observability 类型一致 | 与 types 对齐 | 重复声明，返回类型不匹配 | 🔴 类型漂移风险 |
| H-2 MiddlewarePipeline | 禁用/移除 | @deprecated 但仍有代码 | ✅ 可接受 |
| H-3 ApprovalPipeline 独立 | 无 session-loop 引用 | 无 session-loop 引用 | ✅ |
| H-3 ApprovalPipeline 阶段 | 5 阶段 | 3 阶段（缺 auto-classifier + denial-tracker） | ⚠️ 简化实现 |
| H-6 ToolMode 完整 | 5 种 mode | 5 种 mode | ✅ |
| H-6 prompt-assembly 调用 | 调用 filterTools() | 调用 filterTools() | ✅ |
| I-1 concurrency 控制 | 需配置 | **缺失** | 🔴 |
| I-2 权限最小化 | 需配置 | **缺失** | 🔴 |
| I-3 路径过滤 | 需配置 | **缺失** | 🔴 |
| I-4 turbo 缓存 | 需集成 | **缺失** | 🔴 |
| I-5 typecheck 全覆盖 | 所有包 | 仅 crish-desktop | 🔴 |
| I-10 npm audit | 已配置 | ✅ | ✅ |
| I-11 密钥扫描 | 需集成 | **缺失** | 🔴 |
| I-12 depcruise dist 排除 | 排除 | ✅ | ✅ |
| I-12 no-runtime-to-shared 降级 | 降级为 warn | ✅ 已降级 | ✅ |

---

## 8. 改进建议

### 优先级 🔴（阻断性）

1. **ci.yml 添加 concurrency 控制**：在 workflow 级别添加 `concurrency: group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true`
2. **ci.yml 添加 permissions**：`permissions: contents: read`（参考 release.yml 的模式）
3. **路径过滤**：添加 `paths-ignore: ['docs/**', '*.md', 'assets/**']`
4. **启用 turbo 缓存**：用 `turbo run typecheck build test` 替代直接命令
5. **新增 typecheck:ci 脚本**：覆盖所有 8 个 workspace package 的 `tsc --noEmit`

### 优先级 ⚠️（重要）

6. **同步 08_tool_hook_chain.md 规划**：将 §4.2 的 ToolHook 接口从 6 方法更新为 3 方法及实际签名
7. **`tool-hook-observability.ts` 改为导入 `tool-hook-types.ts`**：消除类型漂移，统一 ToolHook 定义源
8. **删除 `.dependency-cruiser.js` 或统一为 `.dependency-cruiser.cjs`**：消除双配置维护风险
9. **增加密钥扫描 job**：在 ci.yml 新增 gitleaks/trufflehog 步骤

### 优先级 📋（建议）

10. 制定 `middleware-pipeline.ts` 的移除计划（设目标版本）
11. 规划文档补充 3→5 阶段 ApprovalPipeline 的演进路径
12. TypeScript 侧添加覆盖率阈值验证（参考 Rust 侧模式）
