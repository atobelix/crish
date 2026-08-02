# Layer F/G/J 落地偏差审计报告（Round 12）

> 审计时间：2026-07-24 | 审计 Agent：Agent 12
> 对照文档：06_ui_components.md / 07_performance_recovery.md / 10_testing_infrastructure.md

---

## 1. F-1：ChatCard 拆分

### 行数检查

| 文件 | 实际行数 | 规划上限 | 状态 |
|------|----------|----------|------|
| `chat/ChatCard.tsx` | 192 | ≤300 | ✅ |
| `chat/ChatHeader.tsx` | 78 | ≤250 | ✅ |
| `chat/ChatProviderGuard.tsx` | 99 | ≤180 | ✅ |
| `chat/ChatCheckpointActions.tsx` | 15 | ≤200 | ✅ |
| `chat/hooks/useChatCardSelectors.ts` | 31 | ≤60 | ✅ |
| `chat/hooks/useChatApproval.ts` | 79 | ≤150 | ✅ |
| `chat/hooks/useChatComposerProps.ts` | 52 | ≤120 | ✅ |

### 子组件使用情况

| 子组件 | 在 ChatCard 中 import? | 在 ChatCard 中使用? | 状态 |
|--------|----------------------|---------------------|------|
| `ChatHeader` | ✅ 是（line 27） | ✅ 作为 `composerElement` 的 `rightActions` | ✅ |
| `ChatProviderGuard` | ❌ **未导入** | ❌ **未使用** | ❌ |
| `ChatCheckpointActions` | ❌ **未导入** | ❌ **未使用**（stub，reutrns null） | ❌ |

- `ChatProviderGuard` 提取了 provider 检测逻辑，但 `ChatCard` 在使用时 **duplicated the logic inline**（`fetchEngineStatus` / `applyResolvedModelLabel` / `hydrateTimedOut` 均在 ChatCard 内自行管理）。`ChatProviderGuard` 组件废弃为死代码。
- `ChatCheckpointActions` 是空壳 stub（仅 reutrns null），checkpoint/rollback 逻辑未从 ChatCard 移入。
- 约定 3 个 hooks（plan 结构图显示 3 个），实际有 3 个 hooks（user 要求中"4 个 hooks"为计数差异），均为 fully utilized。

### 测试覆盖

- `chat/` 目录下 **zero test files**（`.test.ts` / `.spec.ts`）
- `useChatApproval` coverage report exists（da apenas coverage html），但 **no dedicated test file**

---

## 2. F-2：FilesCard 拆分 / 虚拟滚动迁移

### 行数检查

| 文件 | 实际行数 | 规划上限 | 状态 |
|------|----------|----------|------|
| `components/FilesCard.tsx` | 2（barrel） | ≤300 | ✅ |
| `files/FilesCard.tsx` | 244 | ≤300 | ✅ |
| `files/FileTree.tsx` | 148 | ≤350 | ✅ |
| `files/FilePreview.tsx` | 193 | ≤300 | ✅ |
| `files/FileEditor.tsx` | 25 | ≤200 | ✅ |
| `files/FileActions.tsx` | 100 | ≤150 | ✅ |
| `files/FileBreadcrumb.tsx` | 173 | ≤200 | ✅ |
| `files/hooks/useFileNavigation.ts` | 120 | ≤120 | ✅ |
| `files/hooks/useFilePreview.ts` | 96 | ≤150 | ✅ |

### 虚拟滚动迁移

| 检查项 | 结果 |
|--------|------|
| `FileTree.tsx` 使用 `hooks/useVirtualScroll`? | ✅ `import { useVirtualScroll } from '../../hooks/useVirtualScroll'`（line 7）+ 调用（line 51） |
| 原始 `FilesCard.tsx` 内联 `function useVirtualScroll`? | ❌ **已删除**（grep 无结果） |
| 原始 1,629 行的 `FilesCard.tsx` | ✅ 已拆分为 barrel re-export + 8 个文件 |

### F-2g：未保存切换拦截 Guard（新增子任务）

| 要求 | useFileNavigation | useFilePreview | 状态 |
|------|-------------------|----------------|------|
| `isDirty(): boolean` | ❌ 未实现 | ✅ 有 `dirty` 状态 reutrned | ❌ |
| `confirmNavigation(): Promise<boolean>` | ❌ 未实现 | N/A | ❌ |
| `onDirtyChange` callback | ❌ 未接收 | ❌ 未暴露 | ❌ |
| dirty check before navigation | ❌ 无逻辑 | N/A | ❌ |

**建议**：补全 F-2g guard，在 `useFileNavigation` 中接收 `dirty` 状态，在 navigation 时检查并弹窗确认。

### 测试覆盖

- `files/` 目录下 **zero test files**

---

## 3. F-6：App.tsx 引导链拆分

### 行数检查

| 文件 | 实际行数 | 规划上限 | 状态 |
|------|----------|----------|------|
| `src/App.tsx` | 138 | ≤250 | ✅ |
| `app/AppBootstrap.ts` | 170 | ≤200 | ✅ |
| `app/AppHeader.tsx` | ~75 | ≤250 | ✅ |
| `app/AppKeyboardHandler.ts` | 1（re-export）→ `hooks/useAppKeyboard.ts` 190 | ≤120 | ❌ |
| `app/AppGlobalDialogs.tsx` | ~99 | ≤150 | ✅ |
| `app/useEngineBootstrap.ts` | ~55 | ≤100 | ✅ |

**注**：`AppKeyboardHandler.ts` 本身是 barrel re-export（1 行），但实际 hook `useAppKeyboard` 为 190 行，超出 120 行上限。

### 子模块存在性

| 模块 | 文件 | 状态 |
|------|------|------|
| `AppBootstrap` | ✅ `app/AppBootstrap.ts` | ✅ |
| `AppHeader` | ✅ `app/AppHeader.tsx` | ✅ |
| `AppKeyboardHandler` | ✅ `app/AppKeyboardHandler.ts` | ✅ |
| `AppGlobalDialogs` | ✅ `app/AppGlobalDialogs.tsx` | ✅ |
| `useEngineBootstrap` | ✅ `app/useEngineBootstrap.ts` | ✅ |
| `useProjectRebind` | — 合并入 AppBootstrap（useLayoutEffect） | ⚠️ |

### 12 个 useEffect 顺序保持检查

| # | 规划 effect | 实际位置 in AppBootstrap | 顺序保持? |
|---|-------------|--------------------------|-----------|
| 1 | import daemonClient → setEngineReady | `useEngineBootstrap.ts`（独立文件） | ⚠️ 移出 |
| 2 | AUTO_FOLD_DELAY | AppBootstrap L144-149（末尾） | ❌ 位置下移 |
| 3 | document.title + lang | AppBootstrap L151-157（末尾） | ❌ 位置下移 |
| 4 | initLayoutStorePersistence() | AppBootstrap L15-17（首位） | ❌ 位置上移 |
| 5 | bootstrapServices() | AppBootstrap L19-22 | ❌ 位置前移 |
| 6 | crash detection | AppBootstrap L24-28 | ❌ 位置前移 |
| 7 | bootstrapStores() | AppBootstrap L30-33 | ❌ 位置前移 |
| 8 | project folder rebind（useLayoutEffect） | AppBootstrap L35-76 | ✅ 相对顺序靠前 |
| 9 | initWorkspaceLayoutSync() | AppBootstrap L78-86 | ✅ 紧随 rebind |
| 10 | theme/font/settings/TabMode init | AppBootstrap L88-121 | ✅ 居中 |
| 11 | engine startup（daemonChatBridge + provider + session） | `useEngineBootstrap.ts`（独立文件） | ⚠️ 移出 |
| 12 | WindowResizeBridge | AppBootstrap L123-135 handleResize | ❌ 位置提前 |

**风险**：AppBootstrap 中全部 effects 均为 `[]` 空依赖（仅 #8 为 `useLayoutEffect`），在 React 18 strict mode 下 effect re-execution 顺序与规划不完全一致。但各 effect 无内部交叉依赖（除 #8 rebind 需 DOM 就绪），实际运行时 breakage 风险较低。

**建议**：将 #2（AUTO_FOLD_DELAY）、#3（document.title）、#4（initLayoutStorePersistence）、#5（bootstrapServices）、#6（crash）、#7（bootstrapStores）按规划顺序排列。

### 双 Chrome 模式 Header 提取

- `AppHeader.tsx` 已提取 ✅，内部处理 `shellChromeMode` 分支渲染 ✅

### 测试覆盖

- `app/` 下 **zero test files**

---

## 4. MR-1 (G-2)：StreamRenderBuffer 帧率降级

### maxBacklogBytes 阈值

| 检查项 | 结果 |
|--------|------|
| `maxBacklogBytes` 字段 | ✅ `private readonly maxBacklogBytes: number`（line 49） |
| constructor 参数 | ✅ `options?.maxBacklogBytes`（line 58） |
| 默认值 | ✅ `32_768`（32KB, line 66） |
| 积压降级检测 | ✅ `this.bufferedLength() > this.maxBacklogBytes`（line 244） |
| 降级行为 | ✅ `degraded` = true 时跳过 `onFrame` 回调，仅累积不渲染（line 246-257） |

### 测试覆盖

- **无专属测试文件**（`*StreamRenderBuffer*.test.ts` 不存在）
- Coverage 报告存在，但缺乏单元测试覆盖降级路径

---

## 5. J-4：vitest.globalSetup 外层隔离

### 文件存在性

- ✅ `C:\Software\conex\vitest.globalSetup.ts` 存在

### API Key 环境变量覆盖度

| 环境变量 | 在 globalSetup 中 | 在代码库中使用 | 状态 |
|----------|-------------------|----------------|------|
| `ANTHROPIC_API_KEY` | ✅ | ✅ `provider-anthropic.ts` | ✅ |
| `OPENAI_API_KEY` | ✅ | ✅ `provider-openai-base.ts` / `provider-openai-compatible.ts` | ✅ |
| `GOOGLE_API_KEY` | ✅ | ✅ `provider-gemini.ts` | ✅ |
| `GEMINI_API_KEY` | ✅ | ✅ `provider-gemini.ts` | ✅ |
| `AZURE_OPENAI_API_KEY` | ✅ | — | ✅ |
| `MISTRAL_API_KEY` | ✅ | — | ✅ |
| `COHERE_API_KEY` | ✅ | — | ✅ |
| `TOGETHER_API_KEY` | ✅ | — | ✅ |
| `GROQ_API_KEY` | ✅ | — | ✅ |
| `DEEPSEEK_API_KEY` | ✅ | — | ✅ |
| `PERPLEXITY_API_KEY` | ✅ | — | ✅ |
| `OPENROUTER_API_KEY` | ✅ | — | ✅ |
| `CUSTOM_PROVIDER_API_KEY` | ✅ | — | ✅ |
| `CRISH_API_KEY` | ❌ **缺失** | ✅ `provider-openai-base.ts` / `provider-openai-compatible.ts` | ❌ |
| `FLOWBIT_API_KEY` | ❌ **缺失** | ✅ `provider-openai-base.ts` / `provider-openai-compatible.ts` | ❌ |
| `CONEX_API_KEY_*`（prefix） | ❌ **缺失** | ✅ `provider-gateway/index.ts` L252 | ❌ |

**建议**：追加 `CRISH_API_KEY`、`FLOWBIT_API_KEY`，并对 `CONEX_API_KEY_` prefix 实施通配清除。

---

## 6. J-1：FauxAgentProvider 测试替身

### 文件存在性

| 文件 | 状态 |
|------|------|
| `packages/agent-runtime/src/testing/faux-provider.ts`（FauxAgentProvider） | ✅ |
| `packages/agent-runtime/src/provider/faux-provider.ts`（FauxProvider） | ✅（provider 目录，作为 standalone fake 实现） |

### 接口完整性（`testing/faux-provider.ts`）

| 方法/属性 | 要求 | 实际 | 状态 |
|-----------|------|------|------|
| `setEvents(events)` | ✅ | ✅ `setEvents(events: ProviderStreamContractEvent[])` | ✅ |
| `setError(error)` | ✅ | ✅ `setError(error: Error)` | ✅ |
| `setLatency(ms)` | ✅ | ✅ `setLatency(ms: number)` | ✅ |
| `setFailAfter(n)` | ✅ | ✅ `setFailAfter(n: number)` | ✅ |
| `reset()` | ✅ | ✅ `reset()` — clears events/error/latency/failAfter | ✅ |
| `stream(request)` returns AsyncIterable | ✅ | ✅ `async *stream(_request): AsyncIterable<ProviderStreamContractEvent>` | ✅ |
| `implements AgentProvider` | ✅ | ❌ `Pick<import("../types").AgentProvider, "id">` | ❌ |

### 偏差

- `FauxAgentProvider` uses `Pick<AgentProvider, "id">` instead of `implements AgentProvider` → **type safety 不完整**。当 `AgentProvider` 接口变更时，`FauxAgentProvider` 不报类型错误。
- 此外 `FauxProvider`（`provider/` 目录下）是另一个独立的实现了类似功能的类，有更多方法（`init`、`dispose`、`healthCheck`、`addEvent`），但两者缺乏统一接口契约。

### J-2 / J-3 同伴文件

| 文件 | 存在 |
|------|------|
| `testing/faux-call-gateway.ts` | ✅（147 行） |
| `testing/mock-tool.ts` | ✅（存在） |

### 测试覆盖

- `faux-provider`、`faux-call-gateway`、`mock-tool` 均 **无测试文件**

---

## 总结

| 检查项 | 状态 | 严重度 |
|--------|------|--------|
| F-1 ChatCard ≤300 行 | ✅ | — |
| F-1 ChatProviderGuard / ChatCheckpointActions 未使用 | ❌ | **高** |
| F-1 3 hooks 已提取使用 | ✅ | — |
| F-2 FilesCard 已拆分，内联 useVirtualScroll 已删除 | ✅ | — |
| F-2 虚拟滚动已迁移到全局 hook | ✅ | — |
| F-2g 未保存切换拦截未实现 | ❌ | 中 |
| F-6 App.tsx ≤250 行，子模块齐全 | ✅ | — |
| F-6 useEffect 顺序偏差，AppKeyboardHandler 超行 | ⚠️ | 低 |
| MR-1 maxBacklogBytes + 积压降级 | ✅ | — |
| J-4 globalSetup 缺失 CRISH_API_KEY / FLOWBIT_API_KEY | ❌ | 中 |
| J-1 FauxAgentProvider 缺 AgentProvider implements | ❌ | 中 |
| F-1/F-2/F-6/J-1/J-4 均无专属测试 | ❌ | **高** |
| J-2/FauxCallGateway / J-3/MockTool 存在 | ✅ | — |

### 高优先级改进

1. **ChatProviderGuard / ChatCheckpointActions**：要么在 ChatCard 中集成使用，要么删除死代码
2. **测试覆盖**：useChatApproval（竞态守卫）、useFileNavigation（dirty guard）、FauxAgentProvider（单元测试）、StreamRenderBuffer（降级路径）缺失
3. **F-2g**：补全 `useFileNavigation` 的 `isDirty`/`confirmNavigation` guard 和 `useFilePreview` 的 `onDirtyChange`
4. **globalSetup**：追加 `CRISH_API_KEY`、`FLOWBIT_API_KEY` prefix 清除
5. **FauxAgentProvider**：改为 `implements AgentProvider` 确保接口契约
