# Crish 桌面应用系统性改进方案（总纲）

> 生成日期: 2026-07-20
> 来源: 20 个 Agent 分 4 轮交叉分析，覆盖 503+ 审计问题
> 本文档为顶层总纲，各子方案详见独立文档

---

## 目录

- [Part 1: 架构总览](#part-1-架构总览)
- [Part 2: 数据层改进](#part-2-数据层改进)
- [Part 3: 核心系统改进](#part-3-核心系统改进)
- [Part 4: 功能组件改进](#part-4-功能组件改进)
- [Part 5: 横切关注点](#part-5-横切关注点)
- [Part 6: 交叉依赖与排序](#part-6-交叉依赖与排序)

---

## Part 1: 架构总览

### 1.1 整体架构图

```
┌──────────────────────────────────────────────────────────────────┐
│                          UI 组件层                                │
│  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │
│  │ Sidebar │ │ ChatCard │ │ToolPanels│ │Settings  │ │Chrome  │ │
│  │         │ │ Composer │ │Ov/Files..│ │Panel     │ │Bars    │ │
│  └────┬────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └───┬────┘ │
│       │           │            │            │            │       │
├───────┴───────────┴────────────┴────────────┴────────────┴───────┤
│                    服务层 (Services)                              │
│  ┌──────────┐ ┌───────────┐ ┌───────────┐ ┌──────────────────┐  │
│  │Shortcut  │ │EventBus   │ │ToastBus   │ │FocusTrap         │  │
│  │Service   │ │           │ │           │ │useRestoreFocus   │  │
│  └──────────┘ └───────────┘ └───────────┘ └──────────────────┘  │
├──────────────────────────────────────────────────────────────────┤
│                  Store 层 (三独立 Zustand)                        │
│  ┌─────────────────┐ ┌──────────────┐ ┌────────────────────┐   │
│  │ SessionStore    │ │WorkspaceStore│ │ SettingsUiStore    │   │
│  │ sessions[]      │ │ workspaces[] │ │ showSettingsOverlay│   │
│  │ sessionsById    │ │ activeIdx    │ │ permissionMode     │   │
│  │ (auto-indexed)  │ │ tabMode      │ │ planMode/Approved  │   │
│  │ composerDrafts  │ │ sidebarColl. │ │ commandPermissions │   │
│  │ terminalBySess. │ │ chatMainSrfc │ └────────────────────┘   │
│  │ folderOrder     │ │ draggedTab   │                           │
│  └────────┬────────┘ │ dropPreview  │                           │
│           │          └──────┬───────┘                           │
│           └─────────────────┼───────────────────────────────────┘│
│                      ▼                          ▼                │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │        Cross-Store Coordination Layer (storeAccess.ts)       ││
│  │        事务编排 | 跨域操作 | 状态快照与回滚                   ││
│  └──────────────────────────────────────────────────────────────┘│
├──────────────────────────────────────────────────────────────────┤
│                   会话运行时 (SessionRuntime)                      │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │ SessionRuntimeRegistry (非 Zustand, 按 sessionId 索引)       ││
│  │ diffFiles | chatMainSurface | attachments | composeDraft     ││
│  │ scrollPosition | fileCompareModes | 流状态 | 审批状态         ││
│  └──────────────────────────────────────────────────────────────┘│
├──────────────────────────────────────────────────────────────────┤
│                Daemon 通信层                                      │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────────┐ │
│  │ Connection   │ │ Stream       │ │ SessionSync              │ │
│  │ Manager      │ │ Recovery     │ │ (双向同步协议)            │ │
│  │ (退避重连)    │ │ (流恢复/暂停)│ │ (增量+全量+冲突解决)     │ │
│  └──────┬───────┘ └──────┬───────┘ └───────────┬──────────────┘ │
│         │                │                      │                │
│         └────────────────┴──────────────────────┘                │
│                            ▼                                     │
│                    WebSocket (Daemon)                             │
├──────────────────────────────────────────────────────────────────┤
│                   持久化层 (存储)                                  │
│  ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ 内存     │ │localStore │ │IndexedDB │ │磁盘镜像(Tauri)   │  │
│  │ (Zustand)│ │(索引/设置) │ │(消息体)   │ │(冷备份)          │  │
│  └──────────┘ └───────────┘ └──────────┘ └──────────────────┘  │
│         WAL (Write-Ahead Log) + 版本迁移 + 配额预检               │
└──────────────────────────────────────────────────────────────────┘
```

### 1.2 核心改进领域

| 领域 | 描述 | Agent 来源 |
|------|------|-----------|
| **Store 架构** | 三独立 Zustand Store + 自动索引 + SessionRuntimeRegistry | R1-A, R1-C |
| **持久化** | WAL + IndexedDB + 版本迁移 + 配额预检 + beforeunload flush | R1-B |
| **状态一致性** | 状态机验证 + 操作队列 + 双份数据检测/修复 | R1-C |
| **错误处理** | 分层 ErrorBoundary + catch 三级处理 + Toast 总线 | R1-D |
| **事件系统** | EventBus + 命名规范 + 跨标签页 BroadcastChannel | R1-E |
| **消息管道** | 消息 ID 唯一性 + 状态机 + 撤回快照 + 附件按会话隔离 | R2-A |
| **审批/工具** | 审批状态机 + 工具超时恢复 + diff 按会话隔离 | R2-B |
| **Daemon 连接** | 三阶段连接管理 + 流恢复协议 + 双向会话同步 | R2-C |
| **UI 基础设施** | ShortcutService + FocusTrap + 拖拽增强 + A11Y | R2-D |
| **会话隔离** | SessionRuntimeState + 工作区级 activeSessionId | R2-E |
| **对话界面** | ChatCard 重构 + 消息窗口化 + 过滤/搜索改进 | R3-A |
| **工具面板** | OverviewCard/FilesCard/DiffCard/TerminalCard 重构 | R3-B |
| **设置面板** | SettingsSelect 键盘导航 + 持久化 + 错误通知 | R3-C |
| **ChromeBar** | FocusTrap + 标签溢出通知 + 拖拽排序 | R3-D, R2-E |
| **Agent 面板** | AgentCard/InlineAgentPanel 代码统一 + 团队看板增强 | R3-E |
| **Undo/Redo** | 撤回快照栈 + diff 回滚 + 消息原子替换 | R4-A |
| **数据完整性** | 消息永不丢失 + 输入持久化 + 配额预检 + 跨窗口 | R4-B |
| **跨窗口协调** | BroadcastChannel + storage 事件 + 版本号乐观锁 | R4-C |
| **国际化/A11Y** | focus-visible + reduced-motion + ARIA 完整 + 文案统一 | R4-D |

---

## Part 2: 数据层改进

### 2.1 Store 物理分离

**现状**: `useSessionStore`/`useWorkspaceStore`/`useSettingsUiStore` 均为 `useLayoutStore` 别名 (#341, #488)

**目标**: 三个独立 `create()` 实例，各司其职

**关键设计**:

```
SessionStore (会话域)
  ├── sessions: SessionState[]
  ├── sessionsById: Record<string, SessionState>  (auto-indexed)
  ├── folderOrder: string[]
  ├── activeSessionId: string
  ├── activeAgentId: string | null
  ├── composerDrafts: Record<string, string>
  └── terminalBySession: Record<string, string[]>

WorkspaceStore (面板/布局域)
  ├── workspaces: WorkspaceState[]
  ├── workspaceActiveSessions: Record<WorkspaceId, SessionId>  (新)
  ├── activeWorkspaceIndex: number
  ├── workspaceChromeBarSessionIds: Record<WorkspaceId, SessionId[]>  (新)
  ├── draggedTab / dropPreview
  ├── tabModeEnabled / uiSize / shellChromeMode / sidebarCollapsed
  └── chatMainSurface: string  (全局后备)

SettingsUiStore (设置/权限域)
  ├── showSettingsOverlay
  ├── settingsActiveTab
  ├── permissionMode / planModeEnabled / planApproved
  └── commandPermissions: string[]
```

**迁移**: 分 3 阶段 (facade 对齐 → 物理拆分 → 增强)

### 2.2 自动索引

**现状**: 10+ 处手动 `reindexSessionsById`，`branchSession`/`moveSessionRealtime` 遗漏 (#342, #440)

**目标**: sessionsById 完全由 sessions 数组变更自动派生

**实现**: Zustand `subscribeWithSelector` 中间件监听 `sessions` 变更

```typescript
useSessionStore.subscribe(
  (state) => state.sessions,
  (sessions) => {
    const byId = Object.create(null);
    for (const s of sessions) byId[s.id] = s;
    useSessionStore.setState({ sessionsById: byId });
  },
  { fireImmediately: true }
);
```

**消除**: 删除所有 `reindexSessionsById` 调用 (10+ 处)

### 2.3 状态版本控制

- 持久化数据添加 `__schemaVersion` 字段 (#408)
- 消息增加 `__seq` 乐观锁
- 迁移注册表: `migrations[版本号] = (data) => newData`

### 2.4 持久化分层

| 层 | 技术 | 内容 | 策略 |
|---|------|------|------|
| L1 | 内存 (Zustand) | 所有活跃数据 | 读写热点 |
| L2 | localStorage | 会话索引、设置、composerDrafts | 同步、轻量 |
| L3 | IndexedDB | 消息体、agent 数据、WAL | 异步、大量 |
| L4 | 磁盘镜像 (Tauri) | 冷备份 | 仅最坏情况 |

**写入顺序**: `L3 body → L2 index → L4 mirror` (先 body 后 index, 原子性保障)

### 2.5 WAL (Write-Ahead Log)

- 写入前在 IndexedDB 中记录 `{ type, sessionId, data, checksum, timestamp }`
- 写入成功后标记 committed
- 启动时扫描 WAL, 发现未提交条目 → 回滚或重放
- 作用: 消除 #399 关闭时丢失、#404 非原子写入

### 2.6 配额预检

```typescript
async function preCheckQuota(estimatedBytes: number): Promise<'ok' | 'low' | 'exhausted'> {
  const { usage, quota } = await navigator.storage.estimate();
  const ratio = (usage + estimatedBytes) / quota;
  if (ratio >= 1) return 'exhausted';
  if (ratio >= 0.9) return 'low';
  return 'ok';
}
```

- `exhausted`: 阻止写入 + toast 通知用户
- `low`: 自动清理最旧归档会话 + 提示用户

---

## Part 3: 核心系统改进

### 3.1 消息管道

**消息 ID 生成** (#1, #72, #441):

```typescript
function generateMessageId(role: 'user' | 'assistant' | 'tool'): string {
  const ts = Date.now().toString(36);
  const rand = crypto.randomUUID().slice(0, 8);
  const seq = nextLocalSeq();
  return `${role}-${ts}-${rand}-${seq.toString(16).padStart(4, '0')}`;
}
```

**消息状态机** (#390-391):

```
queued → processing → completed
                      → error
                      → cancelled
completed → processing  (仅 regenerate 路径, 带 token)
error     → processing  (仅 retry 路径)
```

在 `setSessionMessageStatus` 中强制执行 `VALID_TRANSITIONS` map。

**内容上限** (#383-388):

| 字段 | 上限 |
|------|------|
| text | 100KB |
| thinking | 50KB |
| toolCall.output | 200KB |
| toolCall.arguments | 50KB |
| diff per file | 500KB |
| StreamTextBatcher maxBufferedChars | 100,000 |

### 3.2 撤回与回滚

**消息快照** (#431, #432):

```typescript
class MessageSnapshots {
  // 保存截断前的消息副本 (最多 20 个/会话)
  // 支持 undo 恢复被截断的消息
  // 同时保存关联的 diffFiles 状态

  takeSnapshot(sessionId): snapshotId
  undo(sessionId): boolean      // 恢复上一次快照
  getStack(sessionId): SnapshotEntry[]
}
```

**原子替换模式** (消除 #432):

```
旧: withdraw → new stream → 失败 → 旧消息永久丢失
新: create new → stream → succeed → atomic swap
                         → fail → delete new, keep old
```

### 3.3 Diff 管理

**按会话隔离** (#423, #427):

```typescript
// sessionRuntimeStates[sessionId].diffFiles: FileDiff[]
// 不再有全局 diffFiles
```

**撤回时清理** (#425, #426):

```typescript
function cleanupDiffsForMessage(sessionId, msgId):
  1. 遍历 msg.toolCalls, 收集 filePath 列表
  2. 从 sessionRuntimeStates[sessionId].diffFiles 移除
  3. 清除 tc.diffs (消息内)
```

**分叉隔离**: branchSession 时深拷贝 `diffFiles`，分支间互不干扰 (#427)

### 3.4 审批流程

**状态机扩展**: 新增 `disconnected` 和 `auto_denied` 状态 (#412)

```
pending_approval → approving → success
                 → denying  → error
                 → disconnected → (重连后恢复或 auto_denied)
```

**断连处理**:

- WebSocket close → 扫描所有 pending_approval → 标记 `disconnected`
- 重连后恢复 → 引擎重新查询 approval 状态
- 断连超过 5min → 自动拒绝

**超时机制**: 审批等待超过 5min → 自动拒绝 (#412, #421)

### 3.5 Daemon 连接管理

**三阶段连接**:

```
DISCONNECTED → CONNECTING → AUTHENTICATING → READY
                                          → RECOVERING (断连后)
```

**指数退避重连** (#435):

| Attempt | 延迟 | 范围 |
|---------|------|------|
| 1 | 2s | 1.5-2.5s |
| 2 | 4s | 3-5s |
| 3 | 8s | 6-10s |
| 4 | 16s | 12-20s |
| 5 | 32s | 24-40s |
| 6+ | 60s | 45-60s |

**流恢复协议** (#370):

```
中断检测:
  - StreamMonitor 每 5s 检查活跃流 lastMessageTime
  - 10s 无数据 → 标记 SUSPECT → 查询引擎 run 状态

恢复流程:
  1. 查询 POST /api/runs/status (批量)
  2. running → 从 lastSequence 续接流
  3. completed → 拉取最终输出
  4. failed → 标记为 failed, 用户可见
  5. unknown → 标记为 failed, 自动触发重试
```

**Keep-alive 遮蔽消除** (#372):

- 引入 `probe` 消息: 每 30s 发送 `echo` 帧
- 3 次 probe 无响应才算断连
- 区分"连接健康"与"仅 keep-alive 通但消息流不通"

### 3.6 会话同步

**双向同步协议** (#371):

```
本地 → 引擎 (Push):
  - SyncQueue 持久化到 IndexedDB
  - 每 5s 或积压 10 条, 批量 POST /api/sessions/batch-sync
  - 指数退避重试, 最多 5 次

引擎 → 本地 (Pull):
  - 增量 GET /api/sessions?since=<timestamp>&limit=50
  - 间隔: 正常 5min, 重连后 10s 连续 3 次
```

**冲突解决**:

| 数据类型 | 策略 |
|----------|------|
| 消息内容 | 本地优先 |
| AI 回复/tool output | 引擎优先 |
| session 元数据 | LWW (高版本胜出) |
| 消息状态 | 引擎优先 |
| UI 状态 | 本地优先 |

### 3.7 事件系统

**EventBus 接口** (#366-369):

```typescript
interface EventBus {
  emit(event: AppEvent): void;
  on(type: string, handler: Handler): Unsubscribe;
  once(type: string, handler: Handler): Unsubscribe;
  off(type: string, handler: Handler): void;
}

type AppEvent = {
  type: string;             // "session:created" | "session:deleted" | ...
  payload: unknown;
  source: 'store' | 'daemon' | 'ui' | 'cross-tab';
  timestamp: number;
  id: string;               // 唯一事件 ID, 用于去重
};
```

**命名规范**: `category:scope:action` 三段式
- 旧: `crish-open-file`, `crish-project-changed`
- 新: `file:panel:open`, `project:list:changed`

**跨标签页**: BroadcastChannel + `storage` 事件降级

---

## Part 4: 功能组件改进

### 4.1 对话界面 (ChatCard)

**Composer 输入永不丢失** (#75, #78):

- `composerDrafts` 持久化到 localStorage (#78 消除)
- 图片粘贴时提取 `text/plain` 内容 (#75 消除)
- 附件按会话隔离 (`sessionRuntimeStates[id].attachments`) (#77 消除)
- beforeunload 时同步 flush

**消息列表改进** (#86, #85):

- `DEFAULT_RECENT_MESSAGE_COUNT = 80` (保持)
- CSS `content-visibility: auto` 辅助浏览器级虚拟化
- 滚动到搜索首条命中
- 搜索结果高亮匹配词

**消息过滤** (#71-74):

- 过滤结果中匹配词高亮
- 过滤激活时背景色变化
- 搜索词历史 (localStorage, 最近 10 条)

### 4.2 工具面板

**OverviewCard 重构** (#80-87, #118-133):

- 消除与 RuntimePanel 的 300 行重复代码 (#118)
- 定时任务 CRUD (创建/编辑/删除) (#82)
- 用量历史趋势图表 (#84)
- 后台任务停止/取消 (#83)
- 各折叠区段空态细致化

**FilesCard 增强** (#88-96, #134-147):

- 文件重命名/创建/删除 (#88-89)
- Git 状态标记在文件树上 (#91)
- 文件搜索/全局搜索 (#92)
- ErrorBoundary 包裹 (#146)
- 编辑冲突检测 (#147)

**DiffCard 优化** (#97-104, #148-161):

- 巨型组件 (1942 行) 拆分 (#155)
- `any` 类型替换为具体类型 (#156)
- 虚拟滚动 tabIndex 修复 (#160)
- Git 加载性能优化 (#158)

**TerminalCard 改造** (#105-113, #162-172):

- 交互式 shell 支持 (`xterm.js` 集成) (#105)
- ANSI 颜色解析 (#108)
- 命令补全 Tab (#109)
- 多标签页 (#106)

### 4.3 设置面板

**SettingsSelect 键盘导航** (#295, #458):

```
方向键: 上下选择
Enter:  确认选择
Escape: 关闭下拉
Tab:    循环在选项间
```

**持久化与错误通知** (#399-411):

- 各 tab 设置即时保存 + 写入失败时的 toast 通知
- 存储配额不足时的预警

**其他改进**:

- FocusTrap 包裹整个设置弹层 (#224)
- Suspense fallback 骨架屏 (#225)
- settingsUiStore 物理分离 (#488)

### 4.4 ChromeBar

**标签溢出管理** (#318, #156):

```
超过 16 个非置顶标签时:
  1. 移除最旧的非活跃非置顶标签
  2. Toast 通知: "已隐藏旧标签「XXX」"
  3. Toast 提供"查看"按钮
```

**FocusTrap + Roving Tabindex** (#303, #311, #455):

- 修复外层 `role="tab"` div + 内层 button 的嵌套冲突 (#303)
- 实现标准 tablist/tab/tabpanel 模式
- focus-visible 样式

**会话标签拖拽排序** (#240, #313):

- 按住标签拖拽到目标位置
- 释放后持久化到 localStorage

### 4.5 Agent 面板

**AgentCard + InlineAgentPanel 代码统一** (#119):

- 提取共享 hook `useAgentStream` (约 200 行)
- 消除二者约 150 行重复代码

**团队看板增强** (#217-218):

- summarySnippet 长度限制优化 (#217)
- CSS.escape fallback (#218)

---

## Part 5: 横切关注点

### 5.1 快捷键系统

**ShortcutService** (#1, #2, #366, #369):

```typescript
class ShortcutService {
  register(actionId, defaultBinding, meta): void
  handleKeyDown(e: KeyboardEvent): ShortcutAction | null
  detectConflicts(): Conflict[]
  getAllActions(): ShortcutMeta[]
  formatForDisplay(binding): string
}
```

**序列键引擎** (#1, #366):

- 独立 SequenceKeyHandler, 维护按键缓冲区
- `"Escape Escape"` 不再被 `matchShortcutActions` 跳过
- 缓冲区超时: 500ms

**平台适配** (#369):

- macOS: `⌘`, `⇧`, `⌥`
- Windows: `Ctrl`, `Shift`, `Alt`
- Cheatsheet 自动适配

### 5.2 拖拽系统

**全面 setPointerCapture** (#235, #28, #52):

- 所有拖拽启动点调用 `setPointerCapture`
- `lostpointercapture` 事件处理

**触摸支持** (#237, #363):

- 长按 300ms 触发拖拽
- touch 移动时 ghost 跟随手指

**自动滚动** (#238, #44):

- 拖拽到视口边缘 40px 内触发
- 滚动速度: 12px/frame

### 5.3 无障碍 (A11Y)

**focus-visible 全局策略** (#311, #466):

```css
:focus-visible { outline: 2px solid var(--accent-color); }
:focus:not(:focus-visible) { outline: none; }
```

**FocusTrap** (#224, #459):

- 所有弹窗/浮层统一 FocusTrap 组件
- 打开后自动聚焦首元素
- Tab/Shift+Tab 循环

**prefers-reduced-motion** (#103, #364):

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

### 5.4 错误处理

**分层 ErrorBoundary** (#3, #16, #146, #334):

```
App 级 (fullscreen) → 顶栏 (compact) → 侧栏 (compact) → 工作区 (compact)
                                                     → 每个面板 (compact)
                     → 设置弹层 (fullscreen, 尺寸受限)
                               → 每个 tab (compact)
```

**catch 三级处理** (#101, #400, #439):

```
try { ... } catch (err) {
  1. Record: 结构化日志
  2. Recover: 自动恢复尝试
  3. Notify: 根据恢复结果选择通知级别
}
```

**Toast 总线** (#23-25, #243-248):

```typescript
type ToastPriority = 'info' | 'success' | 'warning' | 'error' | 'recovery'
```

- `error`/`recovery`: `aria-live="assertive"`
- `info`/`success`/`warning`: `aria-live="polite"`
- 可操作 toast 必须有 `duration >= 8000`
- 支持手动关闭 (X 按钮)

### 5.5 Undo/Redo 系统

**操作快照** (新增):

```typescript
interface UndoableAction {
  id: string;
  type: 'withdraw' | 'regenerate' | 'archive' | 'delete-message' | 'batch-pin';
  snapshot: ActionSnapshot;     // 操作前的状态快照
  timestamp: number;
  description: string;          // 用户可见的操作描述
  
  inverse(): UndoableAction;    // 逆操作 (实现 redo)
}
```

**撤回消息的 undo**: 点击撤回后 toast "已撤回" + "撤销"按钮, 调用 `messageSnapshots.restore()`

**重生成的 undo**: 原子替换模式, 旧消息保留为新消息的 "前身", 可切回

**操作历史**: 每个会话维护最近 20 个操作, 支持 `Ctrl+Z` (撤销) 和 `Ctrl+Shift+Z` (重做)

### 5.6 消息完整性保障

**消息永不丢失**:

- 输入 → `composerDrafts` (内存 + localStorage)
- 发送 → `sessionStore.addMessage` (同步/乐观写入)
- 引擎确认 → `daemonChatBridge.onMessageEnd` (状态标记 completed)
- 网络失败 → 消息 status = `error` + 保留 UI 可重试
- 页面关闭 → `beforeunload` flush `composerDrafts` + `persistAllSessions`

**三种存储回退**:

| 失败场景 | 回退策略 |
|----------|---------|
| localStorage 满 | IndexedDB |
| IndexedDB 不可用 | localStorage (消息上限 200/会话) |
| 两者都失败 | toast 通知用户 |

### 5.7 跨窗口协调

**BroadcastChannel** (#447-454):

```typescript
const channel = new BroadcastChannel('crish-store-sync');

// 事件类型:
type CrossTabEvent =
  | { type: 'session:updated'; sessionId: string; version: number }
  | { type: 'session:deleted'; sessionId: string }
  | { type: 'draft:updated'; sessionId: string; draft: string }
  | { type: 'workflow:changed'; action: 'create'|'update'|'delete'; taskId: string }
  | { type: 'quota:warning'; usagePercent: number }
```

**乐观锁**: localStorage `__syncVersion` 递增, 接收方只应用更高版本的变更

**后备方案**: `window.addEventListener('storage', ...)` 监听 `crish_*` key 变更

---

## Part 6: 交叉依赖与排序

### 6.1 模块依赖图

```
No dependencies:
  ├── FocusTrap.tsx, useRestoreFocus.ts
  ├── focus-visible.css, reduced-motion.css
  ├── MessageSnapshots.ts
  ├── SizeValidator.ts
  ├── ShortcutPlatformAdapt.ts
  └── AppErrorBoundary.tsx (v2)

Depends on foundation:
  ├── ShortcutService.ts
  │   └── Depends on: ShortcutPlatformAdapt
  ├── EventBus.ts
  │   └── Depends on: none
  ├── ToastBus.ts
  │   └── Depends on: EventBus
  ├── ErrorStore.ts
  │   └── Depends on: EventBus
  └── SessionRuntimeRegistry.ts
      └── Depends on: none

Depends on store:
  ├── SessionStore (独立 create)
  │   └── Depends on: SessionRuntimeRegistry, MessageSnapshots
  ├── WorkspaceStore (独立 create)
  │   └── Depends on: SessionRuntimeRegistry
  ├── SettingsUiStore (独立 create)
  │   └── Depends on: none
  └── storeAccess.ts (跨域编排)
      └── Depends on: all three stores

Depends on stores + services:
  ├── useTabDrag (v2)
  │   └── Depends on: WorkspaceStore
  ├── useChatStream (v2)
  │   └── Depends on: SessionStore, EventBus, ToastBus
  ├── ConnectionManager
  │   └── Depends on: EventBus, daemonClient
  ├── StreamRecovery
  │   └── Depends on: ConnectionManager, EventBus
  └── SessionSyncService
      └── Depends on: ConnectionManager, SessionStore

Feature components (UI):
  ├── ChatCard (refactored)
  │   └── Depends on: SessionStore, WorkspaceStore, SessionRuntimeRegistry
  ├── ToolPanels (refactored)
  │   └── Depends on: SessionStore, SessionRuntimeRegistry
  ├── SettingsPanel (refactored)
  │   └── Depends on: SettingsUiStore, FocusTrap, SettingsSelect keyboard nav
  ├── ChromeBar (refactored)
  │   └── Depends on: WorkspaceStore, FocusTrap, SessionStore
  └── Agent Panels (unified)
      └── Depends on: SessionStore, EventBus

Cross-cutting:
  ├── PersistenceLayer
  │   └── Depends on: SessionStore (subscribe), IndexedDB
  ├── CrossTabCoordinator
  │   └── Depends on: EventBus, PersistenceLayer
  ├── UndoRedoSystem
  │   └── Depends on: SessionStore, MessageSnapshots
  └── CheatsheetModal (refactored)
      └── Depends on: ShortcutService.getAllActions()
```

### 6.2 逻辑执行顺序

**Phase 0 — 基础设施**:
1. focus-visible.css, reduced-motion.css (全局样式, 无代码改动)
2. SizeValidator.ts, generateMessageId.ts (工具函数)
3. FocusTrap.tsx, useRestoreFocus.ts (通用组件)
4. AppErrorBoundary.tsx (v2 重构)

**Phase 1 — 服务层**:
5. ShortcutPlatformAdapt.ts
6. ShortcutService.ts + ShortcutRegistry.ts
7. EventBus.ts
8. ToastBus.ts
9. ErrorStore.ts
10. SessionRuntimeRegistry.ts
11. MessageSnapshots.ts
12. OperationQueue.ts

**Phase 2 — Store 拆分**:
13. SessionStore 独立 create (含 auto-index middleware)
14. WorkspaceStore 独立 create
15. SettingsUiStore 独立 create
16. storeAccess.ts 跨域编排层
17. 消除所有手动 `reindexSessionsById`

**Phase 3 — Daemon/通信**:
18. ConnectionManager (三阶段 + 退避重连)
19. StreamRecovery (流恢复协议)
20. SessionSyncService (双向同步协议)

**Phase 4 — 持久化**:
21. WAL 实现 (IndexedDB)
22. PersistenceLayer (分层存储)
23. beforeunload flush 注册
24. 配额预检

**Phase 5 — 核心功能**:
25. 消息状态机 + 状态转换验证
26. 撤回快照 + undo 集成
27. 审批流程机重构 (6 态)
28. diff 按会话隔离迁移
29. 附件按会话隔离迁移

**Phase 6 — UI 组件**:
30. ChatCard 重构 (composer 持久化 + 附件隔离)
31. WorkspaceChromeBars 重构 (FocusTrap + 标签溢出管理)
32. SettingsPanel 重构 (FocusTrap + Select 键盘导航)
33. ToolPanels 重构 (代码重复消除)
34. AgentPanels 统一

**Phase 7 — 横切**:
35. 跨窗口 BroadcastChannel 协调
36. Undo/Redo 系统
37. A11Y 审计 + ARIA 修复
38. 国际化文案统一
39. CheatsheetModal 自动生成

---

## 子方案文档索引

| 文档 | 位置 | 内容 |
|------|------|------|
| 数据模型与 Store 架构 | R1-A 输出 | Store 分层、自动索引、SessionRuntimeRegistry |
| 存储与持久化层 | R1-B 输出 | WAL、IndexedDB、版本迁移、配额预检 |
| 状态一致性管理 | R1-C 输出 | SSOT、状态机、操作队列、双份数据检测 |
| 错误处理与恢复框架 | R1-D 输出 | ErrorBoundary 覆盖、Toast 总线、catch 三级处理 |
| 事件系统与通信架构 | R1-E 输出 | EventBus、命名规范、跨标签页通信 |
| 会话与消息管理系统 | R2-A 输出 | 消息管道、撤回快照、附件隔离 |
| 审批与工具执行管道 | R2-B 输出 | 审批状态机、工具超时恢复、diff 发布 |
| 连接与同步协议 | R2-C 输出 | 连接管理、流恢复、双向同步 |
| UI 基础设施改进 | R2-D 输出 | ShortcutService、FocusTrap、拖拽增强、A11Y |
| 多会话/项目隔离 | R2-E 输出 | SessionRuntimeState、工作区隔离、项目切换 |
| 对话界面改进 | R3-A 输出 | ChatCard 重构、消息窗口化、过滤增强 |
| 工具面板改进 | R3-B 输出 | OverviewCard/FilesCard/DiffCard/Terminal 重构 |
| 设置面板改进 | R3-C 输出 | 键盘导航、持久化、错误通知 |
| ChromeBar/Sidebar | R3-D 输出 | 标签管理、拖拽排序、同步一致性 |
| Agent 面板与定时任务 | R3-E 输出 | AgentCard/Inline 统一、团队看板 |
| Undo/Redo 系统 | R4-A 输出 | 操作快照栈、撤回 undo、重做 |
| 数据完整性保障 | R4-B 输出 | 消息永不丢失、输入持久化、跨窗口保证 |
| 跨窗口协调 | R4-C 输出 | BroadcastChannel、乐观锁、storage 事件 |
| 国际化与 A11Y | R4-D 输出 | 文案统一、focus-visible、reduced-motion |
| 集成测试策略 | R4-E 输出 | E2E 测试、一致性检查、性能基准 |

> 所有子方案文档在 `C:\Software\conex\` 目录下, 文件名以各自标题命名。
