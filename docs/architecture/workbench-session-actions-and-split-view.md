# Workbench 会话动作（SessionAction 产品合约）与 Split View 设计

日期：2026-06-09

范围：左侧会话列表、会话 More 菜单、Open in 二级菜单、Split View、多会话并行查看、撤回/回溯入口。

> **命名澄清（OPT-E8 / W4-2）：** 本文描述的是 **产品侧 SessionAction 协议 / Workbench UI 动作**（More 菜单、pin/rename/fork/delete、Split View pane binding 等），**不是** 已删除的前端目录 `apps/crish-desktop/src/store/session-actions/`。  
> 该 store 子目录已于 W4-2 物理删除。现行 Zustand session **store** actions 为：`sessionCrudActions.ts` / `sessionMessageActions.ts` / `sessionOrderingActions.ts` / `sessionAgentActions.ts` / barrel `sessionActions.ts`。勿把本文标题中的 “session-actions” 误读为上述已删路径。

## 目标

Crish 的会话 UI 要像产品工作台，而不是本地数组编辑器。用户看到的会话标题、置顶、归档、删除、分支、回溯、活跃运行、错误状态，都必须来自 daemon/orchestrator 的权威状态。Workbench 可以做布局、选中态、pending overlay 和局部预加载，但不能自己制造第二套会话事实。

## 设计原则

1. 单一事实源：session/run/action/approval/event/snapshot 由 daemon 拥有。
2. 真实能力优先：未接线能力显示禁用、实验、未接入或诊断，不显示假成功。
3. 操作先有回执：More 菜单动作发送 `SessionAction`，收到 `SessionActionReceipt` 后再提交 UI canonical state。
4. 布局与数据分离：Split View 是 Workbench 的 pane/layout 投影，不复制会话历史。
5. 列表先快起来：启动时先加载轻量会话索引，再按优先级懒加载消息和事件详情。
6. 危险操作可恢复：Delete 默认 soft delete；Rewind/Withdraw 必须有 boundary/checkpoint facts，不能只删前端消息。
7. 多对话隔离：每个 pane、run、approval、artifact、metric 都要携带 sessionId/runId，不能串流。

## More 菜单信息架构

会话行右侧 More 菜单分四组：

| 分组 | 动作 | 所有者 | 状态规则 |
| --- | --- | --- | --- |
| 打开 | Open in current pane、Open in split view | Workbench layout + daemon session id | 只改变 pane binding，不改会话历史 |
| 外部打开 | 当前机器发现到的编辑器、文件管理器 | Tauri OS adapter | 动态发现，不写死到 daemon protocol；失败进入 typed diagnostics |
| 元数据 | Pin/Unpin、Mark unread、Rename、Archive/Unarchive | daemon session metadata store | 必须返回 committed receipt 才更新列表 |
| 结构/危险 | Fork、Delete、Rewind、Withdraw | daemon/orchestrator + workspace version facts | 没有版本事实时 rejected；Delete 先 tombstone |

菜单展示规则：

- `implemented`：正常显示，可点击。
- `experimental`：显示，但带轻量状态提示，失败必须有可见诊断。
- `backend-not-wired` / `unsupported`：默认禁用；开发模式可显示原因。
- `degraded`：显示为不可用或需要重试，原因来自 daemon capability snapshot。

## SessionAction 合约

Workbench 只发送 protocol-versioned `SessionAction`：

- `pin/unpin/rename/archive/unarchive/delete` 更新 daemon session metadata store。
- `open` 只表达内部布局打开意图，例如 `split-view`；外部编辑器和文件管理器由 Tauri host adapter 动态发现并执行，不进入 daemon session action 枚举。
- `fork` 必须产生真实会话分支或新 session id。没有 branch facts 时 rejected。
- `rewind` 不走普通 session action，继续走 Conversation Rewind preview/apply。
- `withdraw` 是消息级撤回能力，后端未完成前不能伪装为 rewind 或前端删除。

Receipt 处理：

- `committed`：清 pending overlay，合并 daemon 返回状态。
- `rejected`：保留原状态，显示简短原因。
- `failed`：保留原状态，写入 diagnostics。
- 重复点击使用 `idempotencyKey`，避免 rename/delete 等动作重放。

## Split View

Split View 使用 `SplitLayout`：

- 最多 6 个 pane。
- 每个 pane 绑定一个 daemon session id。
- layout tree 只记录 split 拓扑和比例。
- pane binding 记录 sessionId、role、title、selectedEventId、selectedMessageId、pendingActionIds。
- 渲染前必须调用 `validateSplitLayout`；无效布局降级为单 pane 并记录诊断。

交互建议：

- `Open in split view` 默认在当前 pane 右侧打开。
- 二级菜单固定保留 `Split view`；外部打开项来自当前系统发现结果，例如已安装编辑器或文件管理器，不把具体应用名写进核心协议。
- 多 pane 时只保留一个 active pane，输入框和权限提示跟随 active pane。
- 每个 pane 顶部只显示项目名、会话名、状态、关闭/更多，不加重装饰。
- pane 之间用空间和浅背景区分，尽量少用粗边框或嵌套卡片。

## 会话列表首屏加载

启动加载优先级：

1. app config、workspace、daemon status。
2. daemon-owned session summaries：title、lastUpdated、preview、runCount、eventCount、active/degraded flags、pinned/archived/deleted metadata。
3. 当前 session 的可见消息窗口。
4. 活跃 run snapshot 和未处理 approval。
5. pinned/recent/error sessions 的后台预加载。

不要在启动时全量 hydrate 所有历史消息。空列表必须区分：

- 真无数据。
- daemon 断连。
- 后端未接入。
- 正在加载。
- 协议/游标不匹配。

## UI 风格

- 左侧列表保持密、轻、可扫：标题、短预览、状态点、时间。
- More 按钮仅在 hover/active 时出现。
- 菜单使用熟悉图标和文字，不用解释内部实现。
- 避免为每个状态加边框；优先用背景、字重、间距和小状态标识。
- Delete 使用危险色，但不大面积渲染。
- 开发诊断不进普通用户主路径，放到 diagnostics 或 dev mode。

## 落地顺序

P0：

- daemon session metadata store 接住 `pin/rename/archive/delete`。
- Workbench More 菜单只调用 `apply-session-action`，不再直接改本地 session title/status。
- 会话列表消费 daemon summaries，并合并 metadata。
- unsupported/backend-not-wired 能力禁用且可诊断。

P1：

- SplitLayout 持久化到 Workbench layout store。
- `Open in split view` 使用 pane binding，不创建新会话。
- 外部 open adapter 补 Tauri command capability 和 host discovery：系统发现到什么应用，菜单就展示什么应用。
- Rewind/Withdraw 从消息菜单接入 daemon boundary preview/apply。

P2：

- Fork 生成真实 branch/new session，并关联 workspace checkpoint facts。
- 多 pane 恢复上次布局。
- 键盘快捷键：Pin、Rename、Archive、Delete、Open in split。
- pin/unread/archive/search 与轻量 session index 联动。

## 验收标准

- 刷新或重启后 pin/rename/archive/delete 状态仍在。
- Workbench 不直接修改 daemon session canonical state。
- 后端 rejected 的 action 不改变列表事实。
- soft delete 后历史仍可从 archive/deleted 视图或诊断入口恢复。
- Split View 关闭/重开不丢 pane/session binding。
- 任意 pane 的 run、approval、event replay 不串到其他会话。
- session list 首屏不等待全量消息历史。
