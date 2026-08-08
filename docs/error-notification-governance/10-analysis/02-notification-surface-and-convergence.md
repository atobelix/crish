# 用户可见提示/通知展示面全景与收敛建议（分析文档）

- 状态：分析完成（仅实读，未改代码）
- 范围：`apps/crish-desktop` React 前端全部用户可见提示通道
- 性质：本文件全部建议均为**选项**，最终保留/去掉/改动由用户裁决
- 核心理由引用的用户原则：
  ① 重复提示要收敛（状态展示唯一性、事件唯一性）
  ② 成功提示不必每次说
  ③ 真错误必须显示
  ④ 「服务暂时不可用」可保留在输入框上方持久展示位置

---

## 1. 展示面全景表

实读确认的展示通道（按空间位置从上到下、从全局到局部排列）。

| # | 展示位置 | 组件实现 | 消息类型 | 时长 / 关闭方式 | 当前去重机制 |
|---|----------|----------|----------|----------------|--------------|
| A | 全局 toast（页面底部居中浮层） | `components/overlay/ToastStack.tsx`（渲染挂载 `app/AppGlobalDialogs.tsx:107-113`）；队列 `hooks/useToastQueue.ts:422-508`；挂载 `App.tsx:100` | 错误 / 可撤销操作（归档/分叉 Undo）/ 部分用法与降级提示 | TTL 5s（`useToastQueue.ts:35` TOAST_TTL_MS）；手动 × 关闭（`ToastStack.tsx:61-68`）；队列上限 5，FIFO 挤最旧（`useToastQueue.ts:38,337-350`） | 文案+是否可撤销为键去重（`toastDedupeKey`，`useToastQueue.ts:238-240`），命中刷新 TTL 不叠层（:477-485）；成功/状态/提示类文案**产品禁令**静默丢弃（FORBIDDEN_SUCCESS_TOAST_PATTERNS，:55-124；门闩 `shouldDropSuccessToast` :183-190） |
| B | 输入框上方横幅（footer 顶、composer 正上方） | `components/chat-card/RunNoticeBar.tsx:21-60`（装配于 `ChatStatusRibbons.tsx:364`，再经 `ChatComposerWrapper.tsx:82-113` 渲染在 composer 上方；布局 `.chatFooter > .chatCol` flex column，`ChatCard.module.css:51-67`） | 系统 run 提示：流错误（「服务暂时不可用…」等）/ 空回复 / 已停止 | 默认 8s、错误 14s、空回复 6s、停止 5s（`hooks/chat-stream/index.ts:36` pushRunNotice TTL；`useStreamCallbacks.ts:604/702/977`）；手动 ×（`RunNoticeBar.tsx:50-57`）；新 run 开始或收到 chunk 时自动清除（`useStreamCallbacks.ts:215,558`） | **无去重**：每次 push 直接覆盖并重置 TTL（`index.ts:35-47`）；同文案重复触发会重新显示 8~14s。aria-live 按 kind 分级（`chatStatusRibbonsLib.ts:254-264`） |
| C | 输入框上方 soft-hint（引导态条） | `components/chat-card/SetupHintBanner.tsx:34-59`（`ChatStatusRibbons.tsx:343`） | 四种互斥引导：engine-down / needs-key / needs-model / sync-engine | 无时长：状态驱动，条件解除才消失；带动作按钮（去设置/选模型） | 互斥单条出口 `resolveSetupHintKind`（`chatStatusRibbonsLib.ts:30-71`）；keep-alive 下不因短暂断连展示 engine-down（:26-28）；engine-down 文案为「引擎连接恢复中，请稍候」（:190-195），与 B 通道文案不同 |
| D | assistant 气泡内错误卡 | `components/chat-message/MessageContent.tsx:71-93`（`msg.status==='error'` 且无 timeline 时渲染 AlertCircle 错误块；兜底文案在 :89） | 流错误（`errorDetail.message`，兜底「服务暂时不可用，请检查网络或后端配置」由 `useStreamCallbacks.ts:622` 写入） | 持久：随消息存在，无关闭按钮 | 无去重：每条失败消息一个错误卡。注意 `userFacingErrors.ts:116-126` 已标 `@deprecated`：禁止再写入气泡，错误只走 onRunError → 横幅/toast |
| E | onRunError 三路并报（非独立展示位，而是"一次错误 → 三个面"的分发点） | `hooks/chat-stream/useStreamCallbacks.ts:578-634` | 同一错误同时：① pushRunNotice 横幅（:598-605）② onShowToast toast（:606）③ 有文本→气泡 errorDetail（:615-632）/ 无文本→withdrawMessage 撤下占位（:612-613） | — | **展示面未收敛**：事件面已收敛（EventRouter 四源 → `BridgeErrorPolicy.ts:14-41` surfaceStreamFailure 单一出口 → onRunError），但展示面一次错误三个位置同时出现，是"重复多报"的核心路径 |
| F | ToastBus 旧单例 toast（**死通道**） | `services/ToastBus.ts:48-221`（单例 + `eventBus` 'toast:show' 接线 :223-227） | 仅剩调用：`SettingsProfileTab.tsx:70,111`（导出/导入成功）、`pickWorkspaceFolder.ts:37,41`（无法打开文件夹选择器）、ErrorStore.push 的 warning/error/critical（`ErrorStore.ts:123,157`） | 有 TTL 定义（`ToastBus.ts:31-37`：success 3s / error 10s） | 按 group 覆盖（:70-80）+ maxVisible 5 挤旧（:84-91） | 实读结论：**无任何组件订阅渲染**（`toastBus.subscribe` 无调用方），发射后不可见——成功提示实际是"无声发射"（碰巧符合原则②，但属于失效代码而非策略） |
| G | 侧栏 Undo toast（A 通道的可撤销变体） | 文案 `components/sidebar/SidebarContextMenus.tsx:50`（archiveUndoToastMessage / branchUndoToastMessage），与 `useChatHandlers.ts` 同源；走 useToastQueue | 归档/分叉 + 撤销按钮 | 同 A（5s TTL + 手动关闭） | 同 A（文案键去重；带 Undo 与不带 Undo 不互相折叠，`useToastQueue.ts:238-240`） |
| H | 审批 sticky 条（footer 顶部、RunNoticeBar 下方） | `components/chat-card/ApprovalDock.tsx`（装配 `ChatStatusRibbons.tsx:367-375`；门闩 `chatStatusRibbonsLib.ts:270-277`） | 「N 待审批 · 队列/协作…」审批跳转条 | 无时长：审批驱动；点击跳转目标消息 | 计数门闩 show + count>0 才挂载；单条主时间线内联卡时不展示（`ChatStatusRibbons.tsx:92` 注释） |
| I | 动态快捷状态浮条（chip 条，footer 顶部最上层） | `ChatStatusRibbons.tsx:256-306` | 后台任务 (N) / 计划模式 / 目标模式 / N 个文件变更 | 无时长：状态驱动；点击跳转终端/抽屉/差异 | 仅在有活跃状态时整体挂载 |
| J | 计划/目标模式条 | `components/chat-card/PlanGoalRibbons.tsx`（`ChatStatusRibbons.tsx:345`） | 计划模式·已批准 / 目标·第 N 轮·进度 | 无时长：模式驱动 | 单条（布尔态互斥） |
| K | 排队消息条（composer 内、输入框正上方） | `components/chat-composer/ChatQueuePanel.tsx:23-97`（`ChatComposer.tsx:161-166`） | 排队消息（编辑/删除/立即发送） | 无时长：队列非空才显示 | 队列长度 > 0 才挂载（:40）——功能条非提示 |
| L | 模态对话框层 | `app/AppGlobalDialogs.tsx`：FirstRunWizard（:86-105）/ TelemetryDialog（:115）/ CheatsheetModal（:119-125）/ SettingsPanel 全屏盖层（:129-168）；`ChatCard.tsx:244-253` WithdrawConfirmDialog（撤回确认）；`ChatStatusRibbons.tsx:308-340` planDrawer 计划详情抽屉 | 向导 / 首启确认 / 快捷键帮助 / 设置 / 撤回确认 / 计划详情 | 用户主动关闭；planDrawer Escape 可关（:157-168） | 布尔门闩单开（`showFirstRun` / `showSettingsOverlay` 等 store 位） |
| M | AppErrorBoundary 分层渲染错误 | `components/AppErrorBoundary.tsx`：fullscreen 整页（:310-349）/ compact 行内卡（:268-308）/ minimal 仅图标（:258-265）；熔断 30s 窗口 3 次 →「频繁出错」页（:119-134, 219-255） | React 渲染崩溃（REACT_RENDER_ERROR → errorStore.push，:136-146） | fullscreen 阻断整页直到用户点「尝试恢复/重新加载」；compact/minimal 有重试/关闭 | 熔断计数（sessionStorage `crish_error_boundary_circuit`，:43）；挂载面：全局、ChatStatusRibbons（minimal，:254）、ChatComposer（compact，`ChatComposer.tsx:156`）、AppGlobalDialogs 各模态 |
| N | 聊天区顶部过滤条 | `components/chat-card/ChatMsgFilterBar.tsx` | 消息关键词过滤（功能条） | 用户主动开关 | — |
| O | 空态引导（无会话欢迎面） | `components/chat-card/ChatEmptyState.tsx` | 欢迎 + 快捷 prompt 引导（点按填充并聚焦输入框，:106-107） | 状态驱动 | 空态布尔门闩 |
| P | 输入框内联错误（pickerInlineError） | 状态 `useChatCardState.ts:136`；**没有独立内联渲染位**——useEffect 直接升为 toast（:299-304）；触发点 `hooks/chat-stream/useSlashSend.ts:86,91,253,321,368` | 缺密钥/缺模型、会话不可用、发送失败（「会话消息发送失败，已为您保留输入内容」:368） | 立即 toast（5s）后清空状态 | 无（每次发送失败各报一次；但文案命中 FORBIDDEN 名单外的 ALLOWED 名单「请先/失败」则放行） |
| Q | 头部模型徽标 / 模型下拉 | `components/chat-card/ChatHeaderControls.tsx`（modelBadge :140 附近；`ModelBadgePickerMenu`） | 当前模型名 + 下拉选择；引擎 15s 探测超时 → engineHint 标记离线（:68-74）→ 间接触发 C 通道 engine-down | 状态驱动 | 单值 |
| R | 引擎状态存储（非直接展示） | `services/ErrorStore.ts`（connectionStatus / activeErrors 订阅面）+ `api/streamDiag.ts`（环形缓冲 + console.warn + `window.__crishStreamDiag`） | 内部状态与诊断，不直接渲染 UI | — | errorStore 按 code 合并活跃错误（:107-126）；streamDiag 上限 40 条环形缓冲（:22-23） |
| S | 设置 · 状态诊断面板（**死组件，未挂载**） | `components/settings/StatusDiagnosticsPanel.tsx`（5s 轮询、子系统就绪/最近错误/诊断列表） | 核心状态只读诊断 | 面板内 | 无 | 实读确认：全仓库仅测试文件引用（StatusDiagnosticsPanel.test.tsx），无生产挂载点 |

**通道计数：18 个展示位/分发点（A–R），其中活通道 15（A/B/C/D/E/G/H/I/J/K/L/M/N/O/P/Q），死通道 3（F/S，另 R 为存储层）。**

---

## 2. 「输入框上方」提示形态定位

**结论：输入框上方目前有 3 个独立机制 + 1 个功能条，没有"发送失败后留在输入框上方的持久 notice"——发送失败类错误（P 通道）会被立即升为 toast 而不是留在输入框上方。**

布局证据链：`ChatCard.tsx:201-241` → `ChatComposerWrapper.tsx:72-118`（`.chatFooter`）→ chatCol flex column 内先 `ChatStatusRibbons`（:82-113）后 `composerElement`（:116）→ `ChatStatusRibbons.tsx:343/345/364/367` 依次渲染 SetupHintBanner / PlanGoalRibbons / RunNoticeBar / ApprovalDock。即输入框上方从上到下：**SetupHintBanner（C）→ PlanGoalRibbons（J）→ RunNoticeBar（B）→ ApprovalDock（H）→ composer（含 ChatQueuePanel K）**。

| 机制 | 形态 | 显示条件 | 时长/消失逻辑 | 是否"发送失败"载体 |
|------|------|----------|---------------|--------------------|
| RunNoticeBar（B） | 圆角描边横幅「运行提示」+ 文案 + detail tooltip + × | 流错误/空回复/已停止（pushRunNotice） | TTL 8/14/6/5s；手动 ×；新 run 或收到 chunk 清除 | 是（错误横幅出现在这里），但**是临时的**（最长 14s），且与 toast/气泡三路并报 |
| SetupHintBanner（C） | 单行 soft-hint + 图标 + 动作按钮 | 四种引导态（引擎恢复中/缺密钥/缺模型/待同步） | **无时长，状态驱动持久显示**——这就是现成的"输入框上方持久提示"基座 | 否（引导态专用，互斥一条） |
| ChatQueuePanel（K） | 排队消息列表条 | 队列非空 | 队列清空消失 | 否（功能条） |
| pickerInlineError（P） | **无内联渲染位** | 发送门闩失败 | 立即 toast 5s（`useChatCardState.ts:299-304`） | 名义上是"输入框错误"，实际展示在 toast 通道 |

**用户原则④的落点评估**：`SetupHintBanner` 是现成的"输入框上方持久展示"载体（无 TTL、状态驱动、互斥），`RunNoticeBar` 是现成的"错误横幅"载体（目前临时 TTL）。「服务暂时不可用，正在自动恢复」类 network 错误的持久化选项可分别落在这两个机制上（详见 §4 通道 B/C 选项）。

---

## 3. 秒弹与挡使用路径分析

### 3.1 "发送瞬间弹错误"的完整路径

```
用户点发送
  → useSlashSend.handleSendChat（useSlashSend.ts:349-397）
  → runStreamingAssistant（useStreamCallbacks.ts:180-215，发送前 dismissRunNotice 清旧横幅）
  → createStreamSession（ConnectionLifecycle.ts:311-501）
      → transport.waitUntilConnected(1_500)   ← 1.5s 等待（:325）
      → 未就绪 → callbacks.onRunError(networkUserMessage(), 'network')（:336-340）
  → useStreamCallbacks.ts:578 onRunError 三路并报：
      ① pushRunNotice（横幅，TTL 14s）      :598-605
      ② onShowToast（toast，TTL 5s）         :606
      ③ 气泡 errorDetail / withdrawMessage   :607-634
```

用户输入被打断的感知路径：
1. **发送瞬间**输入区上方插入横幅（布局跳动）+ 底部弹出 toast（输入框下方视觉遮挡）——两个位置同时出现"服务暂时不可用"。
2. toast 固定定位 `bottom: 16px` 居中（`ToastStack.module.css:1-14`），输入框恰好位于页面底部时**直接覆盖输入区**（容器 pointer-events:none 不拦点击，但视觉遮挡 + 布局紧张）。
3. 引擎恢复后用户再次发送 → 若仍失败，横幅**无去重**再次刷新 14s（`index.ts:35-47`），toast 有去重刷新 5s——横幅的"重复多报"感强于 toast。

### 3.2 会"挡使用"的通道（实读证据）

| 通道 | 遮挡/打断行为 | 证据 |
|------|--------------|------|
| ToastStack（A） | 视觉遮挡页面底部输入区（fixed bottom 居中，最多 5 条纵向堆叠） | `ToastStack.module.css:1-14` |
| planDrawer（L） | **自动聚焦第一个可聚焦元素，抢走输入焦点** | `ChatStatusRibbons.tsx:170-178`（requestAnimationFrame → querySelector → focus()） |
| FirstRunWizard / SettingsPanel / WithdrawConfirmDialog / TelemetryDialog / CheatsheetModal（L） | 全屏盖层 / 模态阻断（role=aria-modal 或整页盖层） | `AppGlobalDialogs.tsx:86-168`、`ChatCard.tsx:244-253` |
| AppErrorBoundary fullscreen（M） | 整页阻断，需手动"尝试恢复/重新加载" | `AppErrorBoundary.tsx:310-349` |
| RunNoticeBar（B） | 非阻断但**插入式布局跳动**（composer 上方新行），连续失败时反复弹入/消失 | `ChatComposerWrapper.tsx:82-116` + TTL 逻辑 |
| 气泡错误卡（D） | 非阻断；但错误只留卡片不写正文，多条失败累积在消息流里 | `MessageContent.tsx:71-93` |

### 3.3 重复多报的三条根因

1. **展示面三路并报**（核心）：onRunError 一次错误 → 横幅+toast+气泡错误卡三个位置（`useStreamCallbacks.ts:578-634`）。事件面已收敛（C2.4 四源 → surfaceStreamFailure 单一出口，`BridgeErrorPolicy.ts:14-41`），但展示面没有"唯一性"裁决。
2. **横幅无去重**：`pushRunNotice` 每次直接 setRunNotice + 重置 TTL（`index.ts:35-47`），与 toast 的 dedupe 机制（`useToastQueue.ts:238-240,477-485`）不对称。
3. **多 run 累积**：引擎恢复期用户每点一次发送失败一次 → N 条横幅刷新 + N 个 toast（toast 去重但刷新 TTL 让同文案反复存活）+ N 条失败消息的 errorDetail/占位卡。

### 3.4 成功提示现状（原则②）

toast 通道已实现文案禁令（`useToastQueue.ts:55-124` FORBIDDEN_SUCCESS_TOAST_PATTERNS + `classifyToastPolicy` :193-201）：以「已保存/已复制/正在…/提示：」等开头的成功/状态/进度文案直接静默丢弃（仅可撤销操作放行）。**注意**：这条禁令只作用于 useToastQueue 通道；ToastBus 死通道（F）的"导出/导入成功"属于失效代码而非策略生效。

---

## 4. 收敛选项表（每通道：现状 → 选项 A/B/C，影响面）

> 约定：A=保留（维持现状或仅微调）、B=收敛（降级/合并/加去重）、C=移除。标注 ⭐ 表示与用户四条原则直接相关。

### 通道 A：全局 toast（ToastStack / useToastQueue）—— ⭐

| 选项 | 内容 | 影响面 |
|------|------|--------|
| 现状 | 错误/可撤销/部分降级提示，5s TTL，文案去重 + 成功禁令 | 全应用最广泛的展示通道 |
| A 保留 | 维持现状；可微调：错误 TTL 拉长（如 8s）、队列上限 5→3 | 全调用方（约 30 处 ShowToastFn 消费点） |
| B 收敛 ⭐ | ①「服务暂时不可用」类 network 错误**不再走 toast**（转 C/B 持久条）；② toast 只保留"单次、可操作"错误（发送失败、校验失败）与 Undo 操作；③ 恢复类文案（「已恢复」）保持静默 | 改 onRunError 展示分发（`useStreamCallbacks.ts:606`）；需新增"network 类不进 toast"的门闩 |
| C 移除 | 全局移除 toast，错误全走横幅/气泡 | 撤销归档/分叉将失去快速操作入口（G 通道同源），不推荐 |

### 通道 B：RunNoticeBar（输入框上方错误横幅）—— ⭐⭐

| 选项 | 内容 | 影响面 |
|------|------|--------|
| 现状 | 错误 14s / 空回复 6s / 停止 5s，**无去重**，与 toast/气泡三路并报 | 输入框上方核心错误位 |
| A 保留 | 维持现状，仅补"同文案刷新 TTL"去重（对齐 toast 的 dedupe 语义，`index.ts:35-47` 改造） | 改动小，消除"重复刷新"感 |
| B 收敛 ⭐ | **network/恢复类错误转为持久条**：复用 SetupHintBanner 形态或 RunNoticeBar 去掉 TTL（状态驱动，恢复后自动消失）——对应原则④「服务暂时不可用」留在输入框上方持久展示；同时**取消 toast 路**（唯一性：同一状态只占一个面）；错误明细走 detail tooltip 或仅日志 | 改 pushRunNotice 语义（加 persistent 变体）+ onRunError 分发（`useStreamCallbacks.ts:598-606`）；持久条需"恢复即消失"的驱动点（transport onStatus connected → dismiss） |
| C 移除 | 横幅移除，错误只走 toast/气泡 | 失去输入框上方的就近反馈（用户原则④明确要求保留此位置），不推荐 |

### 通道 C：SetupHintBanner（输入框上方引导 soft-hint）—— ⭐

| 选项 | 内容 | 影响面 |
|------|------|--------|
| 现状 | 四种互斥引导，状态驱动持久显示，engine-down 文案「引擎连接恢复中，请稍候」 | 无 |
| A 保留 | 维持现状 | 无 |
| B 收敛 ⭐ | **作为 network 错误持久条的宿主**：engine-down 类与"服务暂时不可用"合并为同一持久态（文案统一为 `networkUserMessage()`：'服务暂时不可用，正在自动恢复，请稍后再试。'），互斥保证同一时刻最多一条；区分状态（恢复中）与错误（不可用）两档 | `chatStatusRibbonsLib.ts:30-71` resolveSetupHintKind 扩展；与通道 B 选 B 时需定"谁优先"（建议：持久态优先于临时横幅，临时横幅不与之并存） |
| C 移除 | 移除引导条，引导转空态/设置页 | 首启引导与引擎恢复提示丢失，不推荐 |

### 通道 D：气泡内错误卡 —— ⭐

| 选项 | 内容 | 影响面 |
|------|------|--------|
| 现状 | `msg.status==='error'` 且无正文 → 错误卡（兜底文案 :89）；**userFacingErrors.ts:116-126 已标注 deprecated**（禁止写入气泡），但 `useStreamCallbacks.ts:615-632` 仍在有文本时写 errorDetail | 消息流内的失败反馈 |
| A 保留 | 维持现状（错误卡作为"这条消息失败了"的本地标注） | 无 |
| B 收敛 ⭐ | **错误卡保留但文案收敛**：与横幅/toast 文案同源（统一走 `softFailureMessage`），只显示错误卡不重复横幅/toast（有正文的失败不必再弹横幅+toast，错误已在流内可见）；`useStreamCallbacks.ts:598-606` 按"是否有文本"分流（有文本→仅错误卡；无文本→横幅/toast） | onRunError 分发逻辑；MessageContent 文案兜底对齐 |
| C 移除 | 错误不再写气泡（彻底执行 deprecated 注释），无文本时直接 withdraw 占位 | 失败消息失去流内标注；需横幅/toast 全量接管，不推荐单独采用 |

### 通道 E：onRunError 三路并报（分发点）—— ⭐⭐

| 选项 | 内容 | 影响面 |
|------|------|--------|
| 现状 | 一次错误 → 横幅 + toast + 气泡三面 | 全部失败场景 |
| A 保留 | 维持现状 | 重复多报不解决 |
| B 收敛 ⭐（推荐） | **按错误分类选面**（展示唯一性裁决表）：
  - `network`/恢复类 → 仅持久条（通道 C/B 合并），无 toast；
  - 有正文的失败 → 仅气泡错误卡，无横幅无 toast；
  - 无正文的失败 → 仅横幅（可 14s TTL），无 toast；
  - `blocked`/`auth`/`no_key`/`no_project` 等可行动错误 → 横幅 + 静默 toast（只一次）
 | `useStreamCallbacks.ts:578-634` 重构为分级分发函数；测试（useStreamCallbacks.test.ts）同步 |
| C 移除 | 只保留单一通道（全部走横幅） | 可行动错误（密钥无效等）失去 toast 提醒，不推荐 |

### 通道 F：ToastBus 旧单例（死通道）—— ⭐

| 选项 | 内容 | 影响面 |
|------|------|--------|
| 现状 | 无渲染器的单例；`SettingsProfileTab.tsx:70,111` 成功 toast 与 `pickWorkspaceFolder.ts:37,41` 警告"发射即不可见"；ErrorStore → eventBus 'toast:show' 接线（`ToastBus.ts:223-227`）也无人渲染 | 3 个调用点 + eventBus 接线 |
| A 保留 | 维持现状 | 失效代码继续存在 |
| B 收敛 | 三处调用迁移到 useToastQueue 语义（pickWorkspaceFolder 警告是真错误 → 应可见；导出/导入成功 → 按原则②应保持静默，直接删调用） | `SettingsProfileTab.tsx`、`pickWorkspaceFolder.ts`、`ErrorStore.ts:123,157` |
| C 移除 ⭐ | 删除 ToastBus 单例与 eventBus 'toast:show' 接线（AppToast 类型保留，ToastStack 复用） | 删 `ToastBus.ts`（或仅保留类型定义）；ErrorStore 的 toast 侧路随之移除（errorStore 仍保留订阅面供未来接线） |

### 通道 G：侧栏 Undo toast ——

| 选项 | 内容 | 影响面 |
|------|------|--------|
| 现状 | 归档/分叉带撤销按钮，走 useToastQueue | 侧栏操作 |
| A 保留 ⭐ | 维持现状（可撤销操作是 toast 的正确语义：一次性 + 操作入口） | 无 |
| B 收敛 | 多会话批量归档时聚合为一条（「已归档 N 个会话」+ 撤销全部） | SidebarContextMenus 批量操作路径 |
| C 移除 | 移除撤销提示 | 误归档无法快速恢复，不推荐 |

### 通道 H/I/J：审批条 / 动态 chip / 计划目标条 ——

| 选项 | 内容 | 影响面 |
|------|------|--------|
| 现状 | 状态驱动常驻条，无 TTL | 无 |
| A 保留 ⭐ | 维持现状（均为"状态展示唯一性"的正面案例：同状态单条、计数聚合） | 无 |
| B 收敛 | 无必要（已互斥/计数化）；如与 C 持久条同排，注意视觉层次区分 | 视觉层 |
| C 移除 | 移除任一 | 丢失状态入口，不推荐 |

### 通道 K：排队消息条 ——

| 选项 | 内容 | 影响面 |
|------|------|--------|
| A 保留 | 功能条，非提示；维持现状 | 无 |
| B/C | 不适用（功能而非提示） | — |

### 通道 L：模态对话框 ——

| 选项 | 内容 | 影响面 |
|------|------|--------|
| A 保留 | FirstRun/Settings/撤回确认等模态维持现状（用户主动触发，非错误弹窗） | 无 |
| B 收敛 | planDrawer 的**自动聚焦**移除或改为不抢输入焦点（`ChatStatusRibbons.tsx:170-178`）——除非用户主动打开，模态不应打断输入 | 焦点管理；无障碍测试 |
| C 移除 | 不适用 | — |

### 通道 M：AppErrorBoundary ——

| 选项 | 内容 | 影响面 |
|------|------|--------|
| A 保留 ⭐ | 维持现状（真错误必须显示；熔断已防刷屏，30s 窗口 3 次 →「频繁出错」页） | 无 |
| B 收敛 | fullscreen 页增加「自动重试 N 秒后」倒计时按钮（当前需手动点） | AppErrorBoundary 渲染层 |
| C 移除 | 不适用（错误边界的兜底不可移除） | — |

### 通道 P：pickerInlineError（发送门闩错误）—— ⭐

| 选项 | 内容 | 影响面 |
|------|------|--------|
| 现状 | 发送失败 → 立即升为 toast（`useChatCardState.ts:299-304`），无内联位 | 「会话消息发送失败，已为您保留输入内容」等 |
| A 保留 | 维持现状 | 无 |
| B 收敛 ⭐ | **补上"输入框上方内联位"**：发送失败时在 composer 上方（复用 ChatQueuePanel 同层或 SetupHintBanner 形态）显示错误 + 保留输入内容提示，不再/toast 双通道；错误解除（下次成功发送或用户编辑）即消失——对应原则①③④ | `useChatCardState.ts:299-304` 改渲染目标；composer 增加内联错误位（若采纳通道 B 持久条，可与之一并设计） |
| C 移除 | 删除该提示 | 发送失败无任何反馈且输入内容可能被误以为已发送，不推荐 |

### 通道 Q：模型徽标 ——

| 选项 | 内容 | 影响面 |
|------|------|--------|
| A 保留 | 状态展示，维持现状 | 无 |
| B 收敛 | 引擎离线的 15s 探测超时（`ChatHeaderControls.tsx:68-74`）与 C 通道 engine-down 联动去重（避免"徽标假离线 + 横幅真离线"两处不一致） | 探测超时判定与 resolveSetupHintKind 的输入对齐 |
| C 移除 | 不适用 | — |

### 通道 S：StatusDiagnosticsPanel（死组件）—— ⭐

| 选项 | 内容 | 影响面 |
|------|------|--------|
| 现状 | 未挂载（仅测试引用） | 无 |
| B 收敛 | 若保留设置页诊断诉求：挂载到设置页（显式开启），仅显示最近一次错误而非每次报 | 挂载点 + 设置导航 |
| C 移除 ⭐ | 删除组件与测试（或移入归档） | 删 `StatusDiagnosticsPanel.tsx` + `.test.tsx` + `.module.css`；若无挂载计划，推荐此选项（死代码不服务用户） |

### 通道 R：ErrorStore / streamDiag（存储层）——

| 选项 | 内容 | 影响面 |
|------|------|--------|
| A 保留 | 存储/诊断保留（错误查询与 `window.__crishStreamDiag` 调试入口有用） | 无 |
| B 收敛 | ErrorStore 的 eventBus 'toast:show' 侧路随通道 F 一并移除；若未来要"最近错误"UI，接订阅面而非 toast | ErrorStore.ts:123,157 |
| C 移除 | 不推荐（诊断资产） | — |

---

## 5. 分级矩阵建议（供用户裁决）

### 5.1 分级 × 展示位置 × 时长 × 去重（推荐方案 B 组合）

| 级别 | 典型消息 | 展示位置 | 时长 | 去重/收敛 | 对应通道 |
|------|----------|----------|------|-----------|----------|
| **错误·可行动**（真错误，原则③） | 密钥无效、被拦截、会话不可用、发送失败 | 输入框上方横幅（或内联错误位）+ 一次性 toast（只报一次）；气泡错误卡（有正文时） | 横幅 14s / toast 5s / 错误卡持久 | 文案键去重（同文案 30s 内只报一次，刷新 TTL 不叠层） | B/D/E/P |
| **错误·环境恢复类**（原则④） | 「服务暂时不可用，正在自动恢复，请稍后再试。」 | **输入框上方持久条**（SetupHintBanner 形态或 RunNoticeBar persistent 变体），**无 toast** | 无 TTL：状态驱动，连接恢复（transport onStatus connected）即消失 | 互斥单条：与 engine-down/引导态同出口，同一时刻最多一条 | B/C/E |
| **警告·降级** | 引擎未同步（本机已保存）、本地未配密钥 | 输入框上方 soft-hint（现状）+ 降级场景一次性 toast | soft-hint 状态驱动 / toast 5s | 互斥单条 + 文案去重 | C/E/A |
| **成功**（原则②） | 已保存/已复制/已导出/已归档 | **默认静默**（现状禁令保持）；仅可撤销操作（归档/分叉）走 toast 带 Undo | 5s | 文案禁令名单 + 可撤销放行 | A/G |
| **状态**（非提示） | 计划模式、目标进度、后台任务、审批待办、排队消息 | 常驻条/chip（现状），**不弹窗** | 状态驱动 | 计数聚合、互斥单条 | H/I/J/K/Q |
| **引导** | 首启向导、快捷键帮助、空态欢迎 | 模态（用户主动触发）/空态页 | 用户关闭 | 布尔门闩 | L/O |
| **崩溃**（真错误） | React 渲染崩溃 | AppErrorBoundary fullscreen/compact/minimal | 手动恢复；30s 3 次熔断 | 熔断计数（现状） | M |
| **诊断** | 引擎状态、最近错误详情 | 设置页面板（显式开启）或仅日志 | 面板内 | 只显示最近一条，不弹 | S/R |

### 5.2 收敛总原则（对应四条用户原则）

1. **展示唯一性**（原则①）：同一状态/同一错误在任意时刻最多占据一个展示面。落地：onRunError 分级分发（通道 E-B）、持久条与临时横幅互斥（B/C）、pickerInlineError 不双通道（P-B）。
2. **成功静默**（原则②）：保持 useToastQueue 文案禁令；清理 ToastBus 死通道中的"导出/导入成功"发射（F-B/C）。
3. **真错误必显**（原则③）：错误类消息永不降级为静默——移除或收敛的是"重复展示面"而非消息本身；AppErrorBoundary 兜底保留。
4. **「服务暂时不可用」持久于输入框上方**（原则④）：network 类错误落输入框上方持久条（B-B / C-B / P-B 组合），恢复即消失，不弹 toast。

### 5.3 建议采纳顺序（改动从小到大）

1. 通道 F/S 清理（死代码：ToastBus 发射 + StatusDiagnosticsPanel）——零风险。
2. 通道 B 补文案去重（横幅同文案刷新 TTL）——小改动，直接缓解"重复多报"。
3. 通道 E 分级分发（network → 持久条；有正文 → 仅错误卡；无正文 → 仅横幅）——核心收敛，需测试同步。
4. 通道 B/C 持久条落位（networkUserMessage 文案 + 恢复驱动）——对应原则④。
5. 通道 P 内联位（发送失败留在输入框上方）——可与 4 合并设计。

> 注：以上所有改动均需用户裁决后实施；本文件不包含任何代码修改。
