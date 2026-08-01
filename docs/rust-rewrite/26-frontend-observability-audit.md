# 26 · 前端组件与 Rust 可观测性审计

> 审计日期：2026-08-01（只读研究，未改任何代码）
> 范围：apps/crish-desktop（前端 GUI）+ apps/agent-workbench/src-tauri + crates/*（Tauri IPC 进程内引擎）
> 触发需求：「前端 GUI 组件化系统化 + 全面旧债务清理」「异常/错误处理与日志继续改进、增强可观测性」

---

## 一、前端组件分层现状与债务清单

### 1.1 全景（apps/crish-desktop/src/components/）

- 非测试 `.tsx` 组件 **180 个**，配套 CSS Modules **78 个**（`*.module.css`）。
- 布局：**28 个域子目录 + 约 60 个顶层扁平组件**（`ChatCard.tsx`、`DiffCard.tsx`、`SettingsPanel.tsx` 等仍平铺在顶层）。
- 顶层与子目录并存双轨，同名组件出现两次（如 `AgentCard.tsx` 顶层 vs `agent-card/` 目录、`ChatCard.tsx` vs `chat-card/`、`FilesCard.tsx` vs `files/`、`OverviewCard.tsx` vs `overview/`）——**目录化迁移未完成，兼容 shim 层还在**。

#### 按域归类（每个目录一句话职责）

| 目录 | 职责 |
|---|---|
| `accounts/` | 账号卡片与状态指示（AccountCard / AccountStatusIndicator，~150 行） |
| `agent-card/` | Agent 浏览板/状态 Chip/消息行（AgentBrowsePad、AgentStatusChip、agentCardUtils） |
| `binary-tree/` | 二叉树工作区：LeafToolTabStrip、TreeLeafPanel、TreeResizeSash、UnitSessionTabStrip、useTopBarDrag（**718 行 hook**） |
| `card-panel/` | 卡片面板 Header/Layout/空态 + **Legacy 重定向 stub**（PlanLegacyRedirect / SettingsLegacyRedirect） |
| `chat-card/` | 聊卡片：ChatHeader、UnitChromeActions、useChat* 六个 hooks 系列 |
| `chat-composer/` | 输入区：ComposerField、ComposerSlashMenu、ChatQueuePanel、ComposerAttachmentBar |
| `chat-image/` | 图片画廊 ImageGallery / ImageTile / LocalImgResolver |
| `chat-message/` | 消息内容：MessageContent、MessageActions、MessageThinkingBlock |
| `chat-message-list/` | 消息虚拟列表：MessageVirtualizer（444 行）、useChatMessageState、useScrollAnchor |
| `chat-message-row/` | 行级渲染：ChatAssistantMessageRow、ChatUserMessageRow、MessageActionsBar、AsyncMarkdownBlock 等 8 文件 |
| `chat-tool-call/` | 工具调用渲染：CompactToolRow、ToolCallHeader、ToolCallOutput、ToolCallDiffPreview |
| `common/` | **仅 1 个文件**：UnifiedSelectPopover.tsx —— 所谓"公共组件库"形同虚设 |
| `diff/` | Diff 面板拆件：DiffCodeViewer、DiffGitPanel、DiffHeaderControls、DiffToolbar、useDiffData、useDiffGitActions |
| `files/` | 文件管理器：FilesCard、FileTreeView、FilePreview、FileBreadcrumb、FileActions + hooks |
| `overview/` | 总览卡拆件：OverviewCard、ActiveTasksSection、ChangesSection、ProgressSection 等 14 文件 |
| `provider/` | Provider 配置：ProviderRail、ProviderDetail、ModelListSection、AuthConfigSection、RateLimitConfig 等 |
| `right-tool-dock/` | 右侧工具坞 RightToolDockHeader |
| `settings/` | 设置通用件：ExternalSessionImport（542 行向导）、SettingsSchemaRenderer、UserViewDebugPanel |
| `settings-extensions/` | 扩展市场：ExtensionCard、ExtensionList、useExtensionMarket |
| `settings-mcp/` | MCP 配置：McpServerForm、McpServerList、useMcpSettings |
| `settings-models/` | 模型配置：ModelConfigEditor（538 行）、ModelProfileList、useModelProfilesState |
| `settings-skills/` | 技能：SkillCardList、SkillDetailPreview、SkillEditorModal、useSkillsSettingsState（639 行） |
| `settings-tabs/` | **遗留 stub 层**：models/ModelFormDialog.tsx 仅 6 行 re-export、skills/SkillList.tsx 仅 6 行 |
| `shell/` | 全局会话 Tab 条 GlobalSessionTabBar、SessionTabDragContext |
| `sidebar/` | 侧栏：SidebarNav/Header/Footer/ContextMenus + session-list/*（SessionRow、useSidebarSessionList 560 行） |
| `workspace/` | 工作区：WorkspaceCanvas、WorkspaceResizer、WorkspaceEmptyState、useWorkspaceResize |
| `Tooltip/` | **唯一成型的基础组件**：Tooltip.tsx（128 行） |

### 1.2 分层现状

- **无「基础组件库（ui 原子）→ 业务组件」分层**：`common/` 目录只有 1 个组件；没有 `ui/`、`primitives/` 原子层；Button / Input / Modal / Menu / Select **均无统一原语**，各业务组件自造。
- **样式方案：CSS Modules 为主 + 全局 CSS 双轨并行**：
  - 78 个 `*.module.css`（组件级）；
  - `src/styles/` 全局约 28 个文件：`tokens.css`（CSS 变量设计令牌，`--bg-primary`、`--accent-*` 等）、`design-system.css`、`theme-dark.css`、`breakpoints.css`、`z-index.css`、`chat/`、`settings/`、`shell/` 子目录；
  - 令牌体系已建好（tokens.css + `styles/tokens/zindex.ts`），但**组件 CSS 中仍有硬编码 hex/rgba（见 1.3）**。
- **状态管理：zustand v5 + immer v11**，单 god-store + 域 facade 架构（详见第二节），组件通过 `useSessionField` / `useWorkspaceField` / `useSettingsUiField` 等 selector 订阅。

### 1.3 债务清单（示例均为「文件:行号」）

**A. 大组件（>600 行，单文件职责过载）**

| 文件 | 行数 | 说明 |
|---|---|---|
| `components/ChatStatusRibbons.tsx` | **864** | 全仓最大组件：状态条带 + 引导提示 + ribbon 逻辑全在一文件 |
| `components/FirstRunWizard.tsx` | 776 | 多步向导单文件 |
| `components/SettingsPanel.tsx` | 703 | 设置大弹窗单文件 |
| `components/SettingsScheduleTab.tsx` | 669 | 定时任务设置 |
| `components/RuntimePanel.tsx` | 657 | 运行时面板 |
| `components/SettingsRulesTab.tsx` | 643 | 规则设置 |
| `components/PreviewCard.tsx` | 637 | 预览卡 |
| `components/ScheduledTasksPanel.tsx` | 626 | 定时面板 |
| `components/Workspace.tsx` | 618 | 工作区 |
| `components/ApprovalAskCard.tsx` | 579 | 审批卡 |
| `components/binary-tree/useTopBarDrag.ts` | 718 | hook 过大 |
| `components/settings-skills/useSkillsSettingsState.ts` | 639 | hook 过大 |

**B. 重复实现（同功能多实现）**

- **弹窗/Modal 至少 7 套独立实现**：`CheatsheetModal.tsx`、`WithdrawConfirmDialog.tsx`、`settings-skills/SkillEditorModal.tsx`、`TelemetryDialog.tsx`、`settings/ExternalSessionImport.tsx`、`FirstRunWizard.tsx`、`SettingsPanel.tsx`（自身即大弹窗）——无共享 Modal 原语。
- **自定义菜单/选择器至少 10 套**：`SettingsSelect.tsx`、`SettingsQuickMenu.tsx`、`common/UnifiedSelectPopover.tsx`、`ModelPicker.tsx`、`ModelBadgePickerMenu.tsx`、`ProjectPickerMenu.tsx`、`PermissionModeMenu.tsx`、`ComposePlusMenu.tsx`、`settings-tabs/skills/SkillsMoreMenu.tsx`、`chat-composer/ComposerSlashMenu.tsx`。
- **同名双轨**：顶层 `AgentCard.tsx`(401) vs `agent-card/`、顶层 `ChatCard.tsx` vs `chat-card/`、`FilesCard.tsx`(7 行 shim) vs `files/`、`OverviewCard.tsx`(9 行 shim) vs `overview/`。

**C. 遗留 stub / 兼容 shim 层**

- `components/settings-tabs/models/ModelFormDialog.tsx:1-6` —— 仅 re-export `settings-models/ModelConfigEditor`；
- `components/settings-tabs/skills/SkillList.tsx:1-6`、`settings-tabs/models/ModelList.tsx`（28 行包壳）、`settings-tabs/skills/useSkillsSettings.ts`（22 行转发）、`settings-tabs/skills/SkillDetailPanel.tsx`（11 行）；
- `components/FilesCard.tsx:7`、`components/OverviewCard.tsx:9`（9 行 memo 包壳）；
- `components/card-panel/PlanLegacyRedirect.tsx:12`、`SettingsLegacyRedirect.tsx:12`。

**D. daemon/WS 旧命名残留（命名债务，代码已走 Tauri IPC）**

- 全 src **99 个文件**仍含 `daemon/WebSocket/ws://` 字样；
- `api/daemon-chat-bridge/` 目录（`streamViaDaemon.ts`、`ConnectionLifecycle.ts`、`EventRouter.ts`、`ApprovalHandler.ts`）仍被 **16 个非测试文件**消费（`bootstrap-full.ts`、`hooks/useAgentStream.ts`、`api/chatApi.ts`、`components/RuntimePanel.tsx` 等）；
- `hooks/useDaemonState.ts` 仍被 `components/overview/OverviewCard.tsx`、`components/RuntimePanel.tsx` 使用；
- `services/ConnectionManager.ts:243-246` 仍广播事件名 `'daemon:connection:change'`；
- 但 `api/transport/index.ts:1-8` 注释已声明「WS 链路已删除，Tauri IPC 为唯一路径」——**运输层已切干净，命名与目录未清理**。

**E. 硬编码（颜色/文案）**

- hex 颜色全 src 共 **488 处**（tsx/ts）：`api/themeStore.ts` 225 处（调色板常量，属合理聚集）、`components` 52、`utils` 48、`services` 6；
- 组件内联 `style={{...color:#...}}` 仅 3 处：`chat-message/MessageContent.tsx:1`、`settings/SettingsSchemaRenderer.tsx:1`、`sidebar/SidebarContextMenus.tsx:1`；
- CSS Modules 中 hex 仅 10 处 + `rgba(` 29 处（大部分已走 tokens 变量，债务低）。

**F. 死代码 / 未接线日志设施**

- `services/LoggerService.ts`（109 行：RingBuffer + 级别过滤 + 结构化 `LogEntry{sessionId, runId}` + 彩色 console）——**全仓 0 处调用**；
- `console.*` 全 src 137 处（排除测试后生产代码 108 处），分散在约 60 个文件、每文件 1-3 次，无统一出口；
- `src/store/middleware/withLogger.ts` 是另一套 console 日志路径（2 处）。

**G. 其他**

- TODO/FIXME/HACK/XXX 全 src 仅 **6 处**（债务低，注释纪律良好）；
- 顶层组件目录化迁移未完成（60 个扁平文件 vs 28 个域目录并存）。

---

## 二、store 划分清单（apps/crish-desktop/src/store/）

### 2.1 实际 zustand 实例（`create()` 实体）

| Store | 文件 | 行数 | 职责 |
|---|---|---|---|
| **layoutStore（god store）** | `layoutStore.ts` | 363 | 会话/消息/agents/chrome/appSettings 权威实例；由 slices + actions 拼装 |
| — slices | `slices/diff-slice.ts`、`permission-slice.ts`、`terminal-slice.ts`、`ui-slice.ts` | | 横切域切片 |
| — 会话 actions | `sessionActions.ts` + `sessionAgentActions.ts`、`sessionCrudActions.ts`、`sessionMessageActions.ts`、`sessionOrderingActions.ts`、`draftSession.ts` | | 会话域写入 |
| — 工作区 actions | `workspaceActions.ts` | 529 | columns、Tab DnD、布局预设 |
| — 索引 | `sessionIndex.ts` | 626 | sessionsById O(1) + 一致性校验 |
| **workspaceShellStore** | `workspace-shell/workspaceShellStore.ts` | 574 | 打开 Tab / TabSurface / rightDock / activeTabId（独立实例） |
| — 适配 | `workspace-shell/adapterShape.ts` | **729** | shell↔layout 适配（过大） |
| **layoutTreeStore** | `layout-tree/layoutTreeStore.ts` | | 二叉树几何、activeLeafId、leaf↔session 绑定（独立实例） |
| — 操作 | `layout-tree/operations.ts` | **1015** | 树操作全集（全仓最大 ts 文件） |
| **streamingStore** | `streamingStore.ts` | 535 | 流式消息中间态 |
| **telemetryStore** | `telemetryStore.ts` | | 遥测/用量同步 |
| **capabilitiesStore** | `capabilitiesStore.ts` | | 引擎能力位 |
| **rustCoreStore** | `rustCoreStore.ts` | | Rust 核心状态投影 |
| **layoutAnimationStore** | `layoutAnimationStore.ts` | | 布局动画 |
| **providerStore** | `provider/providerStore.ts` | | Provider 配置 |
| **Facade 别名（非独立实例）** | `sessionStore.ts`、`workspaceStore.ts`、`settingsUiStore.ts` | | `use*Store === useLayoutStore` 同引用（已单测） |

### 2.2 架构要点（来自 store/README.md）

- **单实例 + 域 facade**：Phase 0/1 现状，`layoutStore` 是唯一权威；三 facade 对齐同一实例，禁止组件直连 `layoutStore.getState()`（README 门禁：新代码走 `api/storeAccess.ts` 编排）。
- **兄弟独立 store**：workspace-shell（Tab 打开）与 layout-tree（二叉树）各一实例；README 明示「sessions 仍住在 layoutStore，Phase 2 拆消息流」。
- **索引纪律**：`sessionsById` 与 `sessions[]` 同引用，immer 写路径须经 `getSessionForWrite` / `withAutoIndex`（README:118-121 专门警示）。
- **门禁脚本**：`npm run check:store-types` 扫 `as any`/`@ts-ignore`、facade 符号、storeAccess 编排（README 门禁节）。
- **债务点**：`layout-tree/operations.ts`（1015 行）、`adapterShape.ts`（729 行）、`sessionIndex.ts`（626 行）、`types.ts`（626 行）均为拆分候选；消息流未拆独立 store（Phase 2 计划内）。

---

## 三、Rust 可观测性能力矩阵（crates/conex-telemetry + src-tauri）

| 能力 | 现状 | 缺口 |
|---|---|---|
| **tracing subscriber** | `subscriber.rs::init_default` 已实现：EnvFilter + compact 格式到 stderr、OnceLock 幂等、level 解析回退 info | **运行时从未调用**：全 src-tauri 搜 `init_default` 仅出现在注释（error_bridge.rs:17/92 声称"已安装"，实际 main.rs setup 未调用）→ **所有 tracing 宏静默丢弃** |
| **panic hook** | `panic_hook.rs::install_panic_hook` 已实现：结构化 `error!(target:"panic", panic_message, panic_location, panic_thread)` + stderr 兜底 + 链式转发前 hook、幂等 | **同样从未安装**；Tauri 默认 panic 行为外无结构化落点 |
| **crash 恢复** | `crash.rs::catch_unwind` → `CrishErrorPayload{code:"common.panic", category:Permanent, retryable:false, metadata:{thread}}`；`error_bridge.rs::safe_invoke_sync` 包装已接线 | 调用点少且 `#[allow(dead_code)]`；异步命令 panic 无 catch（注释明示依赖未安装的 install_panic_hook） |
| **结构化日志字段约定** | 前端 `LoggerService/LogEntry` 与 `streamDiag` 有 `sessionId/runId` 字段；Rust 侧 **无** span、无 sessionId/runId 注入约定 | Rust 日志无统一上下文字段；无 `tracing::info_span!`/`#[instrument]`（全仓 0 处） |
| **日志落盘/轮转** | 无（仅 stderr）；前端另有 `apps/crish-desktop/logs/` 目录 | Rust 侧无文件日志、无崩溃转储、无 level 动态调整接口 |
| **错误注册表** | conex-types 77 码/20 域 `CRISH_ERROR_REGISTRY` + `CrishError`(struct) + `CrishErrorPayload`(IPC) + `migrate_error_code` 旧码迁移 | 注册表完备；但**核心引擎 crate 未使用**（见第四节） |
| **事件级可观测** | session-loop 已建模 `AgentEvent::RuntimeError`（含 retryable）、`ProviderDiagnostic`（phase/attempt/max_attempts/error_kind）——事件通道内可观测性好 | 事件只走 IPC 给前端，无 tracing 镜像记录 |

### 关键结论

- conex-telemetry 的**代码质量与设计意图良好**（幂等、结构化、链式转发、无高层依赖），但**接线缺失**：subscriber 与 panic hook 在运行期都不存在，src-tauri 中仅有的 17 处 tracing 调用（engine.rs 3、main.rs 2、pty/session.rs 10、core_run_commands.rs 2）实际不产生任何输出。
- 除 stderr 外无任何日志 sink；无 metrics、无 span 链路、无 trace 导出（`TELEMETRY_EXPORT_FAILED` 码存在但无对应实现）。

---

## 四、错误类型分布（crate | 错误类型 | 是否经统一体系）

| crate | 错误类型 | 定义 | 是否经 CrishError 统一体系 |
|---|---|---|---|
| conex-types | `CrishError`（struct + 77 码 registry）、`CrishErrorPayload`、`CoreError`（thiserror，`{kind,detail}` 标签枚举）、`ProviderErrorKind`、`RunTerminalError`、`TransitionError` | error.rs / lib.rs | **体系核心**（自 227 处引用） |
| agent-provider | `ProviderError`（thiserror 14 变体，13 类分类）、`ProviderSourceError`、`SseFrameError`、`SseReadError`、`StreamParseError` | error.rs、sse/* | **部分**：ProviderError 有 `to_crish_error()` 收敛（4 处 CrishError 引用）；细分帧/读错误直接裸露 |
| agent-tools | 内部错误 | tools/* | 部分（10 处 CrishError 引用） |
| orchestrator | `StoreError`（**plain struct**，kind/message 字符串，非 thiserror）、`RunError`（thiserror 3 变体）、`TransitionError` | persist.rs、run.rs | **否**（0 处 CrishError 引用）；src-tauri `core_error.rs` 用 `map_store_err/map_run_err` 归一为 CoreError |
| session-loop | `LoopError`（**plain struct，仅 message 字段，`pub(crate)`，未实现 std::error::Error**） | loop/mod.rs:49 | **否**（0 处 CrishError 引用）；是最原始的错误类型 |
| conex-db | `DbFailure`（plain struct，kind/message 字符串） | lib.rs:9 | **否**（0 处）；src-tauri `map_db_err` 按字符串匹配分流 |
| conex-ipc | `IpcError` | lib.rs:40 | 否 |
| conex-stream | `StreamError`（1 变体 NotOpen） | lib.rs:125 | 否 |
| conex-telemetry | 无自有错误类型，产出 `CrishErrorPayload` | | 是（15 处） |
| **src-tauri** | 无自有枚举；`error_bridge.rs` 提供 `map_string_err`/`map_core_err`/`map_io_err`/`map_db_err` → `CrishErrorPayload` | core_error.rs / error_bridge.rs | **收口层**（部分函数 `#[allow(dead_code)]`，未全面接线） |

### 结论

- **错误体系双轨运行**：conex-types 的统一 CrishError 体系（与 TS 端对齐、含旧码迁移表）已建成，但**核心引擎 crate（orchestrator / session-loop / conex-db / conex-ipc / conex-stream）全部未接入**——各自为政的 plain struct / 独立 thiserror 枚举仍在；统一只发生在 src-tauri 边界层（map_* 函数），且转换是有损的（InvalidInput→common.unsupported、StoreError→CoreError::Io）。
- `CoreError`（invoke 同步协议）与 `CrishError`（运行期语义）**双协议并存**，中间靠 `From<CoreError> for CrishError`（error.rs:982）做有损桥接。
- 最新 commit「feat(orchestrator): integrate CrishError + logger + CrishResult (Round 6)」标题与当前代码状态不符（orchestrator 0 处 CrishError 引用），说明集成尚未真正落地或刚起步。

---

## 五、日志覆盖度统计

### 5.1 Rust 侧

| 维度 | 数值 |
|---|---|
| 依赖 tracing 的 crate | 3/18（conex-telemetry、agent-provider、conex-test-utils）——**orchestrator、session-loop、conex-db 等核心引擎 crate 无 tracing 依赖** |
| crates 内日志宏调用 | **2 处**：agent-provider/retry.rs:1、conex-telemetry/panic_hook.rs:1 |
| src-tauri 日志宏调用 | **17 处**：pty/session.rs 10、engine.rs 3、main.rs 2、core_run_commands.rs 2 |
| eprintln/println | crates 内 2 处（panic_hook 兜底 + agent-tools/search.rs）；src-tauri 0 |
| tracing span / #[instrument] | **0 处** |
| 覆盖率 | 141 个 crate 源文件 × 18 crate → 日志调用文件约 5 个（~3.5% 文件有日志；全部 Rust 运行期日志约 19 条宏） |
| 结构化字段约定 | 无（无 sessionId/runId span 注入；仅 panic_hook 有 panic_* 前缀字段） |

### 5.2 前端

| 维度 | 数值 |
|---|---|
| `console.*` 全 src | 137 处（生产代码 108 处），分散约 60 文件，每文件 1-3 次，无统一出口 |
| `LoggerService`（结构化 logger，含 sessionId/runId） | **0 处调用（死代码）** |
| `streamDiag`（环形缓冲 40 条 + `window.__crishStreamDiag` + `[crish-stream]` 控制台） | 3 文件使用：`hooks/chat-stream/useStreamCallbacks.ts`、`api/daemon-chat-bridge/BridgeErrorPolicy.ts`、`handlers/streamState.ts`；结构（sessionId/runId/scope/kind/message/context）**是前端最佳实践，可推广** |
| `middleware/withLogger.ts` | 独立第 3 套 console 路径（2 处） |

### 5.3 缺口总结

1. Rust 运行期实际上**零日志输出**（无 subscriber）；
2. 前端三套日志并存（裸 console / LoggerService 死代码 / streamDiag），无统一入口；
3. 前后端日志均无链路追踪（traceId/spanId）；sessionId/runId 仅前端数据结构里有，Rust 侧无。

---

## 六、改进要点（按优先级）

### P0 · 让现有能力真正生效（接线，非新写）

1. **在 `main.rs::setup` 调用 `conex_telemetry::init_default(level)` + `install_panic_hook()`**：一行接线即恢复全部 tracing 输出与 panic 结构化捕获；补 `core_get_status` 暴露日志级别、支持动态调级。
2. **全面接线 `error_bridge.rs`**：移除 `#[allow(dead_code)]`，把 `map_*_err` 应用到所有 `Result<T, String>`/`Result<T, CoreError>`/`io::Error` 命令返回点；`safe_invoke_sync` 覆盖高频同步命令。

### P1 · 统一错误体系下沉

3. **orchestrator/session-loop 接入 CrishError**：`StoreError`、`RunError`、`LoopError` 增加 `From<X> for CrishError` 或迁移到 `CrishError` 构造；`LoopError`（仅 message 的 plain struct）是首要目标，至少实现 `std::error::Error` + 码映射。
4. **conex-db `DbFailure` → 结构化**：停止按字符串 `contains("corrupt")` 分流（error_bridge.rs:72-77），改为 `DbFailureKind` 枚举，减少魔法字符串。
5. 明确双协议边界：`CoreError`（invoke 同步）与 `CrishError`（运行期）的转换只允许在 `error_bridge` 一层，禁止散落各处 `map_err(|e| e.to_string())`。

### P2 · 日志约定与覆盖

6. **建立 Rust span 约定**：在 `core_run_commands::drive_run_loop` 入口建 `info_span!("run", session_id, run_id)`，引擎各阶段 `#[instrument(skip_all)]`；统一字段名（`session_id`、`run_id`、`event`）。
7. **事件镜像日志**：`AgentEvent::RuntimeError` / `ProviderDiagnostic` 在产生处加 `tracing::error!/warn!` 镜像（现在事件只进 IPC 通道，无本地记录）。
8. **前端统一日志出口**：废弃或启用 `LoggerService`（二选一，禁止三套并存）；把裸 `console.*` 收敛到 `streamDiag`（已有最佳结构）或 LoggerService；补导出/面板查看入口（现有 `UserViewDebugPanel.tsx` 可复用）。

### P3 · 组件分层与债务清理

9. **建立 `components/ui/` 原子层**：抽 Button / Input / Modal / Menu / Select / Tooltip / Badge 原语，从 10 套菜单、7 套弹窗的重复实现收敛；`Tooltip/` 与 `common/` 迁入。
10. **拆分大文件**：`ChatStatusRibbons.tsx`(864)、`FirstRunWizard.tsx`(776)、`SettingsPanel.tsx`(703)、`SettingsScheduleTab.tsx`(669)、`RuntimePanel.tsx`(657)、`SettingsRulesTab.tsx`(643)、`PreviewCard.tsx`(637)、`ScheduledTasksPanel.tsx`(626)、`Workspace.tsx`(618)、`binary-tree/useTopBarDrag.ts`(718)、`layout-tree/operations.ts`(1015)、`workspace-shell/adapterShape.ts`(729)。
11. **删除 stub/兼容层**：`settings-tabs/` 6-28 行 re-export 文件、`PlanLegacyRedirect`/`SettingsLegacyRedirect`、`FilesCard.tsx`/`OverviewCard.tsx` 包壳——消费侧改导入新路径后直接删。
12. **命名债务清理**：`api/daemon-chat-bridge/` → `api/engine-bridge/`（16 个消费文件同步改 import）；`useDaemonState.ts` 迁移为 `useEngineState.ts`；`ConnectionManager` 事件名 `daemon:connection:change` → `engine:connection:change`；`streamDiag` 中 `/websocket|network/` 文案更新为「引擎连接中断」（IPC 语境）。
13. **store Phase 2**：按 README 路线把会话消息流拆独立 store；`operations.ts`/`adapterShape.ts` 按域切文件；同时收紧 `useLayoutStore.getState()` 直连点（README 已列出可接受清单）。
