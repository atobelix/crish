# 代码质量审查与系统性修复方案（2026-07-25）

> 本文档用于记录当前会话中已完成与待完成的系统性修复，防止上下文压缩时信息丢失。
> 起始基线：`apps/crish-desktop` tsc 报 462 行错误。

## 一、已完成的修复（来自前序会话）

以下文件在 `git status` 中标记为 `M`（已修改但未提交），并已通过对应测试：

| 文件 | 修复内容 |
|---|---|
| `apps/crish-desktop/src/services/StreamRecovery.ts` | 系统性重写，修复 8 个 pre-existing 失败：`suffixDelta` 对称处理、`projectAssistantTextFromEvents` 多形态解包、`orchestratorEventToAgentEvent` 正确解包、terminal 状态幂等、snapshot+read-run-events 重放协议、replay 过滤排序、背压模块重建、chunk 队列 |
| `apps/crish-desktop/src/api/daemonClient.ts` | 新增 `sendStreamPause` / `sendStreamResume` 支持 JSON 传输的流控制 |
| `apps/crish-desktop/src/services/ConnectionManager.ts` | 重新设计为纯 UI projection 层，移除独立 probe/reconnect 逻辑 |
| `apps/crish-desktop/src/api/daemonChatBridge.ts` | 修复类型逃逸、非空断言、事件处理逻辑 |
| `apps/crish-desktop/src/store/settingsUiStore.ts` | 修复 slice 结构与语法错误（**注：仍未完成，见下方 Phase 4**） |
| `apps/crish-desktop/src/components/ChatMessageList.tsx` | 修复定时器 ID 类型混用、类型逃逸 |
| `apps/crish-desktop/src/components/diff/DiffGitPanel.tsx` | 修复 stale closures 与类型断言 |
| `apps/crish-desktop/src/services/TelemetryMonitor.ts` | 部分修复（**注：仍有 TS2367/TS2375 问题，见下方 Phase 7**） |
| `apps/crish-desktop/src/api/binaryFrame.ts` | Binary frame 协议实现 |

## 二、当前 tsc 错误分类（462 行）

### Phase 1：Broken Imports / Missing Modules（高严重度，编译阻塞）

| # | 文件:行 | 错误 | 系统性修复 |
|---|---|---|---|
| 1 | `src/api/daemon-chat-bridge/EventRouter.ts:24` | `../services/StreamRecovery` 找不到 | 改为 `../../services/StreamRecovery` |
| 2 | `src/api/daemon-chat-bridge/EventRouter.ts:37` | `StreamState` 未用 `import type` | 改 `import type` |
| 3 | `src/api/daemon-chat-bridge/streamViaDaemon.ts:7,10` | 同上两条 | 同上 |
| 4 | `src/components/composer/ComposerActions.tsx:7` | `../api/permissionModes` 找不到 | 改为 `../../api/permissionModes` |
| 5 | `src/components/composer/ComposerAttachmentsBar.tsx:5` | `../hooks/useChatStream` 找不到 | 改为 `../../hooks/useChatStream` |
| 6 | `src/components/composer/ComposerSlashMenu.tsx:3` | `../api/resolveSlashCommand` 找不到 | 改为 `../../api/resolveSlashCommand` |
| 7 | `src/components/DiffCard.tsx:39` | `../utils/compactObj` 找不到 | 新建 `src/utils/compactObj.ts`（store/types.ts 多处注释引用此名，应有实体） |
| 8 | `src/components/workspace/useWorkspaceResize.ts:8` | `../store/layoutStore` 找不到 | 改为 `../../store/layoutStore` |
| 9 | `src/components/files/FilePreview.tsx:5`、`FilesCard.tsx:5` | `openPathDefault` 不存在 | 改用 `workspaceFsApi` 实际导出（待确认） |
| 10 | `src/components/overview/ChangesSection.tsx:11` | `DiffFileInfo` 不存在于 `storeAccess` | 改用 `FileDiff` 类型 |
| 11 | `src/hooks/chat-stream/useStreamCallbacks.ts:27` | `addTerminalLine` 不存在于 `storeAccess` | 改用实际导出 |
| 12 | `src/hooks/chat-stream/useSlashSend.ts:295` | `SessionStreamManager.has` 不存在 | 改用实际方法（`hasSession`/`get`） |

### Phase 2：死代码 / 孤儿模块（高严重度）

| # | 文件 | 问题 | 修复 |
|---|---|---|---|
| 13 | `src/app/AppKeyboardHandler.ts` | 仅一行 `export { useAppKeyboard } from '../hooks/useAppKeyboard'`，但目标模块不存在且无人 import 此文件 | 删除整个文件 |
| 14 | `src/hooks/keyboard/editing-keys.ts`、`navigation-keys.ts` | 引用不存在的 `../useAppKeyboard`，且 `useKeyboardEditing/useKeyboardNavigation` 无人 import | 删除整个 `hooks/keyboard/` 目录 |
| 15 | `src/components/ModelsSettingsTab.tsx` | 与 `components/settings/models/*` 重复，且引用不存在的 `mergeModelIds`、`normalizeModelIds`、`formatModelDisplayName` | 删除（已被 settings/models/* 取代） |
| 16 | `src/store/settingsUiStore.ts:1-4` | `create`、`immer`、`withDevtools`、`withLogger` 已不再使用（复用 `useLayoutStore`），但 import 未清理 | 删除死 import（见 Phase 4） |
| 17 | `src/store/workspaceStore.ts:1-5,18-19,28` | 同上，`create`、`immer`、`withDevtools`、`withLogger`、`createWorkspaceActions`、`upsertDiffFile`、`WorkspaceStore` 类型、`_workspaceData` 全部死代码 | 删除死代码（见 Phase 4） |

### Phase 3：StreamRecovery TS2367 narrowing Bug（高严重度，运行时风险）

**位置**：`src/services/StreamRecovery.ts:493`

**问题**：
```typescript
async recoverStream(sessionId: string): Promise<boolean> {
  const s = this.streams.get(sessionId);
  if (!s) return false;
  if (s.status === 'completed') return true;   // 这里 TS 把 s.status 收窄为 'streaming'|'paused'
  if (s.status === 'failed') return false;
  // ... await 期间可能并发 markCompleted/markFailed 改 s.status
  try { ... } catch (e) {
    if (this.isTerminal(s)) {
      return s.status === 'completed';  // TS2367: 这里 s.status 仍是 'streaming'|'paused'，与 'completed' 无交集
    }
  }
}
```

**根因**：`s` 是 mutable 引用，跨 await 后 TS 保留 narrowing，但实际状态可能已被并发 `markCompleted/markFailed` 修改。

**系统性修复**：在 catch 块**重新从 Map 读取**状态：
```typescript
catch (e) {
  const cur = this.streams.get(sessionId);
  if (cur && this.isTerminal(cur)) {
    return cur.status === 'completed';
  }
  if (s && !this.isTerminal(s)) {
    s.status = 'paused';
    eventBus.emit('stream:paused', { sessionId, runId: s.runId, error: String(e) }, 'daemon');
  }
  return false;
}
```

### Phase 4：settingsUiStore / workspaceStore 半重构状态（高严重度）

**`settingsUiStore.ts` 现状**：
- 顶部 import `create`、`immer`、`withDevtools`、`withLogger` — 但实际复用 `useLayoutStore`，全死
- import `permissionModeAfterPlanToggle`、`persistPermissionMode`、`isSettingsTabType`、`parseSettingsTab` — 死
- 类型 `SettingsUiStore` 声明但未使用（TS6196）
- `createSettingsUiSlice` 用 `set: any`，导致 `cmd`、`state`、`list`、`w` 全部隐式 any（TS7006 × 10）
- 这是上次会话重构到一半的产物：原本要拆 slice 但没拆完

**系统性修复**：
1. 删除顶部死 import
2. `createSettingsUiSlice` 参数改为 `(set: (updater: (state: SettingsUiStoreData & SettingsUiActions) => void) => void)` 或使用 zustand 的 `StateCreator` 类型
3. 内部 `set((state) => {...})` 回调参数显式标注 `state: SettingsUiStoreData & SettingsUiActions`
4. `cmd`、`list`、`w` 参数显式标 `string`、`string[]`、`ActiveWorkerState`

**`workspaceStore.ts` 现状**：同样问题，`create`、`immer`、`withDevtools`、`withLogger`、`createWorkspaceActions`、`upsertDiffFile`、`WorkspaceStore` 类型、`_workspaceData` 全死。

**修复**：删除死 import 与死代码。

### Phase 5：Provider 组件类型陈旧（高严重度）

**根因**：`store/provider/types.ts` 已重命名，但 `src/components/provider/*` 与 `src/components/settings/models/*` 仍用旧名。

| 旧名 | 新名 |
|---|---|
| `ProviderModel` | `ModelMeta` |
| `ProviderHealth` | `HealthStatus` |
| `ModelRole` | `RoutingRole` |

**字段漂移**：
- `ModelMeta.displayName?` 取代 `ProviderModel.name`
- `AuthConfig.mode` 取代 `AuthConfig.type`（`'api_key' | 'oauth2' | 'none' | 'sigv4' | 'custom_header'`）
- `AuthConfig.oauth2.clientId` 取代 `oauthClientId`
- `AuthConfig.oauth2.tokenUrl` 取代 `oauthTokenUrl`
- `FallbackConfig.errorTypes: FallbackRule[]` 取代 `enabled/fallbackProviderId/fallbackModels/onTimeout/onRateLimit/onError`
- `RateLimitConfig.rpm` 取代 `maxRequestsPerMinute`
- `RateLimitConfig.tpm` 取代 `maxTokensPerMinute`
- `RateLimitConfig.maxConcurrency` 取代 `maxConcurrentRequests`

**涉及文件**：
- `src/components/provider/ModelListSection.tsx`
- `src/components/provider/HealthCheckIndicator.tsx`
- `src/components/provider/AuthConfigSection.tsx`
- `src/components/provider/FallbackConfigSection.tsx`
- `src/components/provider/RateLimitConfig.tsx`
- `src/components/provider/ProviderDetail.tsx`（`provider: ProviderConfig | null = null` 写死 null，需接 store）
- `src/components/provider/ProviderRail.tsx`
- `src/components/settings/RoutingSettingsTab.tsx`
- `src/components/settings/models/ModelProviderDetail.tsx`（引用不存在的 `setModelEnabled` 等 5 个 setter + `mergeModelIds`、`normalizeModelIds`）
- `src/components/settings/models/ModelsCascadeSelect.tsx`（`formatModelDisplayName` 不存在）

### Phase 6：DropIndicatorLayer 类型脱节（高严重度）

**位置**：`src/components/DropIndicatorLayer.tsx:27`

**问题**：解构 `{ left, top, width, height, className }`，但 `DropPreviewState`（store/types.ts:543）实际只有 `{ colIdx, groupIdx, direction }`。

**根因**：UI 渲染期望几何字段，但类型设计未包含。两种修复路径：
- (a) 扩展 `DropPreviewState` 加入几何字段，由 pointer-state 在创建 preview 时填入
- (b) `DropIndicatorLayer` 通过 `colIdx/groupIdx` 自行查询 layout 计算几何

**采用 (b)**：几何是渲染派生量，不应入 store（保持 store 最小化、避免重复数据源）。

### Phase 7：exactOptionalPropertyTypes 违例（~25 处，中高严重度）

**根因模式**：调用方持 `T | undefined` 直接构造 `{ opt?: T }` 对象。

**系统性修复策略**（非补丁）：
1. 优先在源头修复（使值不为 undefined）
2. 确实可选时用条件展开：`...(value != null ? { field: value } : {})`
3. 不允许 `as any` 或类型断言绕过

**涉及文件**（按 error ID）：
- `src/api/client-api/settings.ts:396`
- `src/api/daemon-chat-bridge/EventRouter.ts:542,574`
- `src/api/daemon-chat-bridge/handlers/toolUtils.ts:105`
- `src/api/daemon-chat-bridge/streamViaDaemon.ts:369,376,379`
- `src/api/doctorReport.ts:74,104,150`
- `src/api/doctorReport.test.ts:79,90`
- `src/api/providerAuth.ts:303`
- `src/api/quickOpenHelpers.test.ts:96`
- `src/components/accounts/AccountCard.tsx:45`
- `src/components/diff/DiffToolbar.tsx:90,95`
- `src/components/diff/useDiffData.ts:100`
- `src/components/overview/BackgroundSection.tsx:35`
- `src/components/overview/OverviewCard.tsx:127`
- `src/components/QuickOpen.tsx:136`
- `src/components/settings/AccountSettingsTab.tsx:105`
- `src/hooks/chat-stream/useSlashSend.ts:176,219`
- `src/hooks/chat-stream/useStreamBatchers.ts:84`
- `src/hooks/chat-stream/useStreamCallbacks.ts:206,272,348,408,489,490`
- `src/hooks/tab-drag/collision.ts:23,39,56,193,207,274,288`
- `src/hooks/tab-drag/index.ts:256,345`
- `src/services/TelemetryMonitor.ts:25,63,84`

### Phase 8：noUncheckedIndexedAccess + 测试文件（中严重度）

**涉及文件**：
- `src/__tests__/chatInvariants.test.ts`
- `src/api/daemonClient.test.ts`
- `src/api/MessageSnapshots.test.ts`
- `src/api/VirtualScrollManager.test.ts`
- `src/app/__tests__/AppBootstrap.test.ts`
- `src/components/diff/useDiffData.ts`
- `src/components/files/hooks/useFileNavigation.ts`
- `src/hooks/tab-drag/pointer-state.ts`
- `src/hooks/tab-drag/types.ts`
- `src/store/layoutStore.test.ts`
- `src/utils/layoutSerializer.test.ts`
- `src/utils/collisionDetection.test.ts`
- 多个 `*.test.tsx` 文件的 `TS6133` 未使用 import

### Phase 9：文档 30+ 维度一致性（中严重度）

**已知问题**（subagent 初步审查，需进一步细化）：
1. `packages/agent-runtime/src/index.ts` 缺失文档承诺的 7 个导出（`OpenAICompatibleProvider`、`createLocalWorkspaceTools`、`createPermissionPolicy`、`JsonlMemoryStore`、`createMemoryTools`、`runRuntimeWithProbe`、`createSubagentTool`）
2. `docs/provider-dx/ARCHITECTURE.md` 中 `AuthMethod` 文档 8 种 vs 代码 9 种（缺 `chain`）
3. `packages/agent-daemon/src/env-whitelist.ts` 缺 `CRISH_CREDENTIAL_MODE`
4. `apps/crish-desktop/src/api/providerProfiles.ts` localStorage key `crish_provider_profiles_v1` 已废弃
5. `packages/agent-runtime/src/provider/builtin/providers/anthropic.json` 的 `engine` 字段不一致（文档 `anthropic` vs 代码 `anthropic-messages`）

## 三、执行顺序与依赖

```
Phase 1 (broken imports)  ─┐
Phase 2 (delete dead code)─┼──> 让 tsc 能编译 → 验证
Phase 3 (StreamRecovery)  ─┤
Phase 4 (store slice)     ─┘

Phase 5 (provider 组件)   ───> 类型对齐 → 验证
Phase 6 (DropIndicator)   ───> 类型对齐
Phase 7 (exactOptional)   ───> 系统性条件展开

Phase 8 (test null safety)──> 测试通过

Phase 9 (docs sync)       ───> 文档与代码一致
```

## 四、验证基线

- 起始：462 行 tsc 错误
- 目标：0 行 tsc 错误
- 测试：`StreamRecovery.test.ts` 11 个测试必须全部通过
- 关键文件不可回退：`StreamRecovery.ts`、`daemonClient.ts`、`ConnectionManager.ts` 已修复部分必须保留

## 五、关键约束

1. **不允许补丁式修复**：所有修复必须系统性，接口需要重新设计就重新设计
2. **不允许 `as any`**：严格类型安全
3. **不允许简化**：不允许为了过 tsc 而删除功能或简化逻辑
4. **不允许兼容式**：旧接口直接替换为新接口，不保留兼容层
5. **代码注释使用中文**（与现有风格一致）
6. **不允许 emoji**（仅允许 svg）
