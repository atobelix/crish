# 执行进度

> Orchestrator 更新门闩；执行 Agent 在各自小节自报完成情况。

## 状态总览

| Round | 状态 | 门闩 | 备注 |
|-------|------|------|------|
| R0 契约与基线 | completed | 已过（文档+Baseline） | 01-contract + 本 Baseline 齐 |
| R1 消息列表 | done (R6 复核) | **pass** | 无 startIndex→clear；会话切换 clear；Manager+fuzz 测绿 |
| R2 冻结统一 | done (R6 复核) | **pass** | store begin/end；useResizeFreeze 订 isLayoutFrozen；iframe CSS 齐 |
| R3 窗口桥 | done (R6 复核) | **pass** | 单一 useWindowLayoutFreeze；App 接线；window pulse 测绿 |
| R4 DragSession | done (R6 复核) | **pass** | 无 splice 占位 / 无 dockOverlay / tab-dragging begin/end；useTabDrag 35 绿 |
| R5 消息幂等 | done (R6 复核) | **pass** | addMessage upsert + generateMessageId 熵 + 专测绿 |
| R6 总装 | **done (agent)** | **pass**（自动化+静态）/ 手动 UI 待人工 | 见下方 R6 门闩表；R6-Perf 未做（可选） |
| R7 第二轮审计 | **done** | **pass**（Critical 0） | audits/01-list + 02-freeze-drag + 03-followup-plan |
| R8 P0 High | **done** | **Orchestrator 抽查 pass** | WsScope + Freeze-Hardening + List-SyncLayout 三自报齐 |
| R8+ P1/P2 | pending | — | CommitOrder / 宽变 invalidate / CSS 死代码（见 03-followup-plan） |

## Baseline（R0）

> 盘点时间：2026-07-22 · 工作区 `C:\Software\conex` · 焦点 `apps/crish-desktop` · 分支 `refactor/architecture`  
> 只读盘点；**不改业务源码**。并行 Agent（R1/R2/R5）已在同树改动部分锚点，下表同时标注 **契约动机（before）** 与 **盘点当下状态**。

### 1. 关键文件与问题锚点

| # | 锚点（任务清单） | 关键路径 | 盘点当下状态 | 符号 / 行号证据 |
|---|------------------|----------|--------------|-----------------|
| 1 | ChatMessageList `clearHeights` on `messageWindow.startIndex` | `apps/crish-desktop/src/components/ChatMessageList.tsx` | **已消（R1 接线）**：不再依赖 `startIndex` clear；会话切换 clear + 窗口仅 `syncOrder` | `useLayoutEffect` ~L573–613：`activeSessionId` 变 → `clearHeights()`；窗口前移做 scrollTop 补偿；**无** `[messageWindow.startIndex, clearHeights]` clear Effect。底层契约：`VirtualScrollManager.syncOrder` L53–56 注释「窗口平移应调用本方法，禁止 clear 全量高度」 |
| 2 | Workspace resizer 无 `startAnimation` / 无 pointer capture | `apps/crish-desktop/src/components/Workspace.tsx` | **已部分接线（R2）**：列/组 sash 走 `beginLayoutInteraction('workspace-resizing')` + `setPointerCapture` | `handleColResizerPointerDown` ~L355–450：`beginLayoutInteraction` L387、`setPointerCapture` L390、`endLayoutInteraction` L440；组高 `handleGroupResizerPointerDown` 对称 ~L452+。Helper：`layoutAnimationStore.beginLayoutInteraction` L274–280 → 内部 `startAnimation` |
| 3 | `useTabDrag` `cardSnapshots` + Workspace splice placeholder | `apps/crish-desktop/src/hooks/useTabDrag.ts`；`Workspace.tsx`；`CardPanel.tsx` | **问题仍在（R4 待做）** | **静态快照 hit-test**：`useTabDrag` L1017–1038 建 `cardSnapshots`；L1211–1215 `findCardSnapshotAtPoint(cardSnapshots, …)`。**假 tab 节点**：L1112–1123 插入 `.tab-placeholder-indicator`。**body 直写**（未走 store）：L1173/1199 `classList.add('dragging-card')`。**树结构 splice**：`Workspace` L257–329 `baseCols.splice` / `col.groups.splice` 插入 placeholder 列/组并改 ratio。**双轨 overlay**：`CardPanel` `dockOverlayStyle` ~L252–284 |
| 4 | `layoutAnimationStore` 谁调用 `startAnimation` | `apps/crish-desktop/src/store/layoutAnimationStore.ts` + 调用方 | Store API 存在；业务经 helper 或直写 class **双轨并存** | **定义**：`startAnimation` L142；`endAnimation` L157；**推荐入口**：`beginLayoutInteraction` / `endLayoutInteraction` L274–292。**已接线调用方**：`Workspace` sash（上表）；`Sidebar` 过渡 ~L365/377 与侧栏拖宽 ~L661/723。**未走 store（R3/R4 债）**：`App.tsx` L466–472 仅 `window-resizing` class；`useWindowControls.ts` L19–22 同；`useTabDrag` 仅 `dragging-card` classList，**无** `tab-dragging` / `startAnimation` |
| 5 | `addMessage` 是否 dedupe | `apps/crish-desktop/src/store/sessionActions.ts`（权威：`layoutStore` → `createSessionActions`）；镜像 `store/actions/chat.ts`（`createChatActions` 当前无其它引用） | **已 upsert（R5 接线）** | `sessionActions.addMessage` ~L385–419：`getMessageById` → 同 id `Object.assign` 就地合并，否则 `push`。`actions/chat.ts` L30–47 同逻辑。**残余风险**：`useChatStream.ts` 生成 id 仍含 `Date.now()` 片段（如 ~L647、L730），熵不足时真碰撞靠 upsert 兜底；双投递语义需 R5 测门闩确认 |

**契约权威（未改动机）**：`docs/ui-jank-message-dnd-rootfix/01-contract.md` §1–§4。

### 2. 现有相关测试入口与如何跑

#### 2.1 测试文件（绝对路径）

| 区域 | 路径 | 备注 |
|------|------|------|
| 虚拟滚动单测 | `C:\Software\conex\apps\crish-desktop\src\api\VirtualScrollManager.test.ts` | 默认 vitest include 命中 |
| 虚拟滚动 fuzz/边界 | `C:\Software\conex\apps\crish-desktop\tests\fuzz\virtual-scroll.test.ts` | **不在**根 `vitest.config.ts` 的 `include` 内，需显式路径 |
| Tab DnD pure helpers | `C:\Software\conex\apps\crish-desktop\src\hooks\useTabDrag.test.ts` | DropType / `findCardSnapshotAtPoint` 等 |
| 消息窗 | `C:\Software\conex\apps\crish-desktop\src\api\messageWindow.test.ts` | 窗口 startIndex 语义 |
| 会话 actions | `C:\Software\conex\apps\crish-desktop\src\store\sessionActions.test.ts` | 含 addMessage 标题等；**未见**「同 id 双 add 不增行」专测（R5-Test 债） |
| 流式 | `C:\Software\conex\apps\crish-desktop\src\hooks\useChatStream.test.ts` | 与投递相关 |
| layout helpers | `C:\Software\conex\apps\crish-desktop\src\store\layoutHelpers.test.ts`、`layoutHelpers.tab.test.ts` | 落点几何等 |
| 冻结 store | `C:\Software\conex\apps\crish-desktop\src\store\layoutAnimationStore.test.ts` | R2 已补 begin/end/class/catch-up；R2-Leak-Test 可再扩 cancel/卸载 |
| 快照 | `apps/crish-desktop/tests/snapshots/*` | 组件快照，非本根治主路径 |

#### 2.2 package scripts（仓库根 `C:\Software\conex\package.json`）

| 脚本 | 命令含义 | 与本课题关系 |
|------|----------|--------------|
| `npm test` | `vitest run` | 跑默认 include（packages + desktop/workbench `src/**/*.test.ts`） |
| `npm run test:desktop-helpers` | `vitest run apps/crish-desktop/src/api apps/crish-desktop/src/store` | api + store 助手（**不含** hooks / tests/fuzz） |
| `npm run test:coverage` | `vitest run --coverage` | 全量默认 include + 覆盖率 |
| `npm run typecheck` / `check:desktop` | tsc desktop | 合入门禁 |
| desktop `test:snapshots` | 仅 snapshots | 旁路 |

#### 2.3 推荐显式命令（根目录）

```text
# 虚拟滚动 + fuzz（fuzz 必须显式路径）
npx vitest run apps/crish-desktop/src/api/VirtualScrollManager.test.ts apps/crish-desktop/tests/fuzz/virtual-scroll.test.ts

# Tab DnD pure helpers
npx vitest run apps/crish-desktop/src/hooks/useTabDrag.test.ts

# 消息窗 + 会话 actions（幂等/窗口语义）
npx vitest run apps/crish-desktop/src/api/messageWindow.test.ts apps/crish-desktop/src/store/sessionActions.test.ts

# desktop helpers 批跑
npm run test:desktop-helpers
```

根 `vitest.config.ts` `include` 仅为：

- `packages/**/src/**/*.test.ts`
- `apps/crish-desktop/src/**/*.test.ts`
- `apps/agent-workbench/src/**/*.test.ts`

→ `apps/crish-desktop/tests/fuzz/**` **不会**被 `npm test` 自动收录。

### 3. Before 基线表（场景 | 预期风险 | 代码证据）

> 「Before」= 根治前契约定义的失败模式。若并行轮次已改代码，**证据列标注当前是否仍可复现**。

| 场景 | 预期风险 | 代码证据（路径 · 符号） |
|------|----------|-------------------------|
| 消息窗平移 / expand older / 过滤导致 `startIndex` 变 | 错误 `clearHeights`/`clear()` → 同 id 高度丢失 → 错位/「假重复」观感 | **契约动机**：原 `ChatMessageList` 对 `messageWindow.startIndex` clear（R1 自报已删）。**当下**：`ChatMessageList` L573–613 仅会话切换 clear；`useVirtualScroll` L61–67 `syncOrder(ids)`；`VirtualScrollManager.syncOrder` L53–89。**残余**：缺「startIndex 变不 clear」组件级回归测（R1-Test 已加强 Manager 测） |
| 会话切换 | 若不清高度 → 旧会话 id 高度污染新会话 | **当下已有**：`clearHeights()` on `activeSessionId` 变化 L575–579；`VirtualScrollManager.clear` L266–273 注释「切会话时调用」 |
| 列宽 / 组高 sash 拖拽 | 仅 body `resizing-active`、无 store 冻结、无 pointer capture → 跨 iframe 丢事件 / 永久 class / 重测抖动 | **当下已接线**：`Workspace` `beginLayoutInteraction` + capture。**before 模式仍见于窗口路径**：`App.tsx` L466–472、`useWindowControls.ts` L19–22 仅 `window-resizing` class，**未** `startAnimation`（R3） |
| 冻结消费者分裂 | `useResizeFreeze` 与 store 不一致 → 半冻结半重算 | **当下**：`useResizeFreeze.ts` 已订 `isLayoutFrozen`（L11–29）。**无 leak 单测**（R2-Leak-Test） |
| Tab 拖拽 hit-test | pointerdown 静态 `cardSnapshots` → 布局变化后指示器与落点错位 | **仍在**：`useTabDrag` L1022–1038、L1211–1215 + `findCardSnapshotAtPoint` L155–187 |
| Tab 拖期 layout tree 变 | React splice placeholder 列/组 + 改 widthRatio/heightRatio → reflow 卡顿与错位 | **仍在**：`Workspace` L257–329 placeholder splice |
| Tab 条假节点 + 双轨 overlay | 假 `.card-tab` 插入；`CardPanel.dockOverlay` 与全局指示器并存 | **仍在**：`useTabDrag` L1112–1123；`CardPanel` L252+ `dockOverlayStyle` |
| Tab 拖拽冻结 | 仅 `dragging-card` class，未 `tab-dragging` / store | **仍在**：`useTabDrag` L1173/1199/1343…；store 类型含 `'tab-dragging'`（`layoutAnimationStore` L8）但 **无调用方** |
| 同 id 双 `addMessage` | 静默 `push` 真重复行 | **当下 upsert**：`sessionActions` L411–418。**before**：无条件 `push`（R5 已改）。**测缺口**：未见「双 add 不增行」专测；`createChatActions` 与 session 双份实现需防漂移 |
| 消息 id 低熵 | `Date.now()` 碰撞 → 误 upsert 或历史真重复 | `useChatStream.ts` ~L647 `user-msg-goal-${Date.now()}-…`；~L730 `assistant-msg-${Date.now()}-…` |

### 4. 门闩对照（R0 视角 · 开放项）

| Round | 基线结论 |
|-------|----------|
| R1 | 主路径 clear-on-startIndex **已关**；需门闩确认测绿与无回退 |
| R2 | Workspace/Sidebar 写入侧 **已见** begin/end；需 leak 测 + 全消费者勾选；窗口仍双轨 class |
| R3 | `App` + `useWindowControls` 双监听 / 纯 class **仍在** |
| R4 | cardSnapshots、splice placeholder、假 tab、dockOverlay、无 `tab-dragging` **全仍在** |
| R5 | upsert **已在 store**；缺专测与 id 熵审计收口 |

### 5. 关键源文件速查（绝对路径）

- `C:\Software\conex\apps\crish-desktop\src\components\ChatMessageList.tsx`
- `C:\Software\conex\apps\crish-desktop\src\hooks\useVirtualScroll.ts`
- `C:\Software\conex\apps\crish-desktop\src\api\VirtualScrollManager.ts`
- `C:\Software\conex\apps\crish-desktop\src\components\Workspace.tsx`
- `C:\Software\conex\apps\crish-desktop\src\hooks\useTabDrag.ts`
- `C:\Software\conex\apps\crish-desktop\src\components\CardPanel.tsx`
- `C:\Software\conex\apps\crish-desktop\src\store\layoutAnimationStore.ts`
- `C:\Software\conex\apps\crish-desktop\src\hooks\useResizeFreeze.ts`
- `C:\Software\conex\apps\crish-desktop\src\App.tsx`
- `C:\Software\conex\apps\crish-desktop\src\hooks\useWindowControls.ts`
- `C:\Software\conex\apps\crish-desktop\src\store\sessionActions.ts`
- `C:\Software\conex\apps\crish-desktop\src\store\actions\chat.ts`
- `C:\Software\conex\apps\crish-desktop\src\hooks\useChatStream.ts`

## Agent 自报日志

### Orchestrator

- 已创建文档包：`docs/ui-jank-message-dnd-rootfix/`
- 编排原则：主会话只分配与验收，不写业务实现
- 首批并行派发（进行中）：
  - R0-Baseline — `019f89d7-9005-7701-b0ae-f9e32081908c`
  - R1-Core+Test — `019f89d7-9007-7411-bc23-e51c0b517a9c`
  - R5-Upsert+Test — `019f89d7-9009-7ff2-88e8-281992122098`
  - R2-Freeze 全家 — `019f89d7-9009-7ff2-88e8-28260394c01d`
- 门闩抽查（Orchestrator）：R1 clear 仅绑会话；R2 useResizeFreeze 订 store + Workspace beginLayoutInteraction；R5 addMessage upsert 存在
- 第二批并行派发：
  - R3-Bridge — `019f89ee-6764-7750-aa66-45f3b2effff2`
  - R4-Drag 全家 — `019f89ee-6765-7181-9cd6-7012c34a41c3`
- 待 R3/R4 后门闩：R6 总装 → R7 双审计 → 按 followup 开 R8+
- **终态（R8 P0 后）**：
  - R0–R6 门闩 pass；R7 双审计 Critical 0 + followup 落盘
  - R8 P0 三切片完成并代码锚点抽查 pass：`resolveWorkspaceHitTestRoot`、`useLayoutEffect` syncOrder、`MAX_FREEZE_MS`
  - 主因路径可宣称根治；P1/P2 与人工 UI 清单见 `audits/03-followup-plan.md`
  - Orchestrator 全程未写业务实现

### R1-Core + R1-Test（消息列表正确性）

- **状态**：实现完成，单测已跑
- **改动文件**：
  - `apps/crish-desktop/src/components/ChatMessageList.tsx`
    - 删除依赖 `messageWindow.startIndex` 的 `clearHeights` useEffect（错误窗口平移 clear）
    - `useLayoutEffect`：`activeSessionId` 变化时 `clearHeights()` 并重置 prepend 基线
    - 窗口/可见 ids 变化仅走 `useVirtualScroll` 已有 `syncOrder(ids)`，不再 clear
    - expand older / 窗口前移导致 prepend 时：`scrollTop += prependedHeight` 锚点补偿（对齐校验后）
  - `apps/crish-desktop/src/components/ChatMessageRow.tsx`
    - user/assistant 流式 `invalidateActual` 改为 rAF 合并（轻量，不大改渲染）
  - `apps/crish-desktop/src/api/VirtualScrollManager.test.ts`
    - 加强：多次 expand-older pan 后同 id 高度保留；`clear` 仅会话切换语义
- **契约自检**：
  - [x] 未在 `messageWindow.startIndex` 变化时 `clearHeights`
  - [x] 会话切换有 clear
  - [x] 窗口平移仅 syncOrder
- **验证**：
  ```text
  cd apps/crish-desktop
  npx vitest run src/api/VirtualScrollManager.test.ts tests/fuzz/virtual-scroll.test.ts
  ```
  （结果见本轮命令输出）
- **未改**（禁区）：Workspace / useTabDrag / 冻结 store；无 git commit/push

### R0-Baseline（A-QA · 基线盘点）

- **状态**：completed
- **范围**：只读盘点 + 更新本文件 Baseline；**未改业务源码**；**无 git commit**
- **必读已核**：`01-contract.md`、`00-master-multi-agent-roadmap.md`、本进度文件
- **五锚点结论**（详见 Baseline §1）：
  1. startIndex→clearHeights：**R1 后已关**（会话切换 clear）
  2. Workspace sash：`beginLayoutInteraction` + pointer capture **已接线**（R2 部分）
  3. cardSnapshots + Workspace placeholder splice + 假 tab + dockOverlay：**仍在**（R4）
  4. `startAnimation` 调用方：Sidebar/Workspace 经 helper；Tab 拖/窗口缩放 **仍 class 直写**
  5. addMessage 同 id：**sessionActions/chat 已 upsert**（R5 部分）；缺专测与 id 熵
- **测试入口**：见 Baseline §2；强调 `tests/fuzz/virtual-scroll.test.ts` 不在默认 vitest include
- **Before 基线表**：见 Baseline §3
- **R0 完成定义**：
  - [x] Baseline 小节填完整
  - [x] 状态总览 R0 → completed（文档 + 基线齐）
  - [x] 本自报小节已追加

### R5-Upsert+Test（A-Data / A-QA）

- **状态**：实现完成，单测已跑
- **完成时间**：2026-07-22
- **范围**：`apps/crish-desktop` 消息 append 幂等（**未改**虚拟滚动 UI / Workspace DnD / layoutAnimationStore；无 git commit/push）
- **实现**：
  1. **权威路径** `sessionActions.addMessage`：同 `id` **upsert**（`Object.assign` 就地合并，禁止静默双插）；镜像 `store/actions/chat.ts` 对齐
  2. **id 熵** `utils/generateMessageId`：`{role}-msg-{ts36}-{uuid8|rand}-{seq16}`；主路径接入：
     - `useChatStream`（用户发送 / 助手占位 / goal 续跑 / learn / doctor）
     - `ChatCard` 重生成补用户气泡
     - `useAgentStream` agent 时间线
  3. **双投递审计**：
     - `daemonChatBridge`：**无** `addMessage` / `messages.push`（不二次写入会话消息）
     - `useChatStream` 原 `setState` + 直 `messages.push`（用户/goal/learn/doctor）→ 改走 `store.addMessage`；助手占位注释说明无 bridge 双 push
     - `SessionSyncService` 引擎同步侧本已按 id upsert（未改）
  4. `appendSessionAgentMessage` 本已 upsert（保持）
- **测试**：
  - `src/store/sessionActions.test.ts`：`addMessage same id is upsert (no double append, stable ref)`
  - `src/utils/generateMessageId.test.ts`：前缀 + 同批唯一
  - 命令与结果：
    ```text
    cd apps/crish-desktop
    npx vitest run src/store/sessionActions.test.ts src/utils/generateMessageId.test.ts --coverage.enabled=false
    # → 2 files / 36 tests passed
    ```
- **契约自检（§4）**：
  - [x] `addMessage` 同 id upsert，禁止静默重复 append
  - [x] 消息 id 有足够熵（非纯 `Date.now()`）
  - [x] 相关单测绿
- **未做 / 边界**：未大范围重命名 store；`createChatActions` 仍无 layoutStore 挂载（与 session 双份，逻辑已对齐防漂移）
- **门闩**：待 Orchestrator 对照 `01-contract.md` §4 验收

### R2-Store + R2-Writers + R2-Consumers + R2-CSS（冻结协议统一）

- **状态**：实现完成；typecheck 绿；store 单测 5/5
- **完成时间**：2026-07-22
- **R2-Store**（`apps/crish-desktop/src/store/layoutAnimationStore.ts`）
  - 强化 `startAnimation` / `endAnimation`：重复 begin 校正 body；重复 end 幂等
  - type → 兼容 body class 映射写死：
    - `workspace-resizing` / `panel-split-resizing` → `resizing-active` + `is-resizing`
    - `tab-dragging` → `dragging-card`
    - 任意 active → `is-layout-frozen` + `data-layout-frozen`
  - **不**管理 `window-resizing`（留给 R3，避免误删 App 侧 class）
  - 导出：`beginLayoutInteraction` / `endLayoutInteraction` / `isLayoutFrozenNow`
  - 单测：`layoutAnimationStore.test.ts`（begin/end class、double-end、nested、catch-up）
- **R2-Writers**
  - `Workspace.tsx` 列/组 sash：`beginLayoutInteraction('workspace-resizing')` + `setPointerCapture`；`pointerup` / `pointercancel` / `lostpointercapture` 对称 end（`ended` 防重入）+ `releasePointerCapture`；保留拖中 DOM style、up 时 commit store
  - `Sidebar.tsx` 拖宽：接入 store（`workspace-resizing`，**不**破坏 `sidebar-transition` 260ms）；cancel/lostcapture 对称 end
- **R2-Consumers**
  - `useResizeFreeze`：订阅 `isLayoutFrozen`，解冻短 debounce；移除 MutationObserver 与独立 `window.resize`
  - `TerminalCard.xterm`：fit 改走 `useSuspendedResizeObserver`（冻结挂起 + catch-up）——**真实消费者已接线**
  - `ChatMessageList` / `FilesCard`：resize 路径以 `isLayoutFrozen` 为准
- **R2-CSS**
  - `shell-workspace.css` + `shell-dragdrop.css`：iframe/webview `pointer-events: none` 覆盖 `is-layout-frozen` / `resizing-active` / `window-resizing` / `dragging-card` / `is-resizing`
- **自检**
  - [x] 列/组拖走 store
  - [x] useResizeFreeze 订 store
  - [x] iframe 规则齐
  - [x] pointercancel / lostpointercapture 会 end
  - [x] 未改 useTabDrag 落点业务（仅 store 预留 `tab-dragging` class 映射）
  - [x] 未改 addMessage
  - [x] 未改虚拟滚动 clearHeights（R1）
- **验证**
  ```text
  npm run typecheck
  cd apps/crish-desktop && npx vitest run --coverage.enabled=false src/store/layoutAnimationStore.test.ts
  ```
  → typecheck OK；5 tests passed
- **交给后续**
  - R2-Leak-Test：cancel/卸载后 frozen 必 false（可扩组件级）
  - R3：`window-resizing` / App 双监听 → store pulse
  - R4：`useTabDrag` 改 `begin/end('tab-dragging')`（现仍 classList 兼容）
- **无 git commit/push**

### R3-Bridge + R3-Test（A-Window / A-QA · 窗口桥）

- **状态**：实现完成；单测 + typecheck 已跑
- **完成时间**：2026-07-22
- **范围**：`apps/crish-desktop` 窗口 resize 冻结 pulse 收敛；**未改** useTabDrag 落点、消息 store、VirtualScroll；**无 git commit/push**
- **类型约定（已文档化）**
  - 扩展 `LayoutAnimationType`：`'window-resizing'`（**不**复用 `workspace-resizing`，避免 Set 无引用计数时 sash 被误 end）
  - store 映射：`window-resizing` → body class `window-resizing`；任意 active → `is-layout-frozen`
  - `isWindowResizing` 派生 flag
  - 契约 `01-contract.md` §2 类型列表已同步
- **实现**
  1. **单一 bridge** `hooks/useWindowLayoutFreeze.ts`
     - `createWindowLayoutFreezeController`：可测 pulse（begin 一次 / 连续 resize 重置 debounce / 静止 end / dispose 对称 end）
     - `useWindowLayoutFreeze`：
       - 浏览器：`window.resize` → `beginLayoutInteraction('window-resizing')`
       - Tauri 2：`getCurrentWindow().onResized` → 同一 pulse（dynamic import + try/catch；**非 Tauri 不崩**）
       - **onMoved 不做**（契约 §6：标题栏纯移动 Web 常无持续事件；将来若接则仍走本 controller）
       - debounce end **120ms**
  2. **收敛双监听**
     - `App.tsx`：删除仅 `classList` 的 resize Effect → 调用 `useWindowLayoutFreeze()`
     - `useWindowControls.ts`：删除 resize classList 监听；仅保留 winCtl
  3. **R2 规则在 window pulse 时生效**
     - store `isLayoutFrozen=true` → `useResizeFreeze` / `useSuspendedResizeObserver` 等消费者挂起
     - body：`is-layout-frozen` + `window-resizing` → CSS iframe/webview `pointer-events: none`（R2-CSS 已覆盖）
- **测试**
  - `src/hooks/useWindowLayoutFreeze.test.ts`：单次 begin、burst 合并、debounce end、与 sash 并行不误 end、dispose 无永久 freeze
  - `src/store/layoutAnimationStore.test.ts`：补 `window-resizing` class / frozen 映射
  - 命令与结果：
    ```text
    # 须在 apps/crish-desktop（jsdom vitest.config）下跑
    cd apps/crish-desktop
    npx vitest run --coverage.enabled=false src/hooks/useWindowLayoutFreeze.test.ts src/store/layoutAnimationStore.test.ts
    # → 2 files / 10 tests passed
    # 仓库根：npm run typecheck → OK
    ```
- **自检**
  - [x] 单一窗口冻结入口（`useWindowLayoutFreeze`）
  - [x] App + useWindowControls 双 class-only 监听消除
  - [x] pulse 走 store begin/end，非仅 classList
  - [x] 非 Tauri fallback 安全（try/catch）
  - [x] 卸载 dispose → end，无永久 frozen
  - [x] 未改 useTabDrag / 消息 store / VirtualScroll
- **门闩**：待 Orchestrator 验收

### R4-Session + R4-Layout + R4-CardPanel + R4-DOM-Tab + R4-CSS + R4-Test（DragSession + 单一浮层）

- **状态**：实现完成；typecheck 绿；`useTabDrag` pure 35/35
- **完成时间**：2026-07-22
- **范围**：`apps/crish-desktop` Tab DnD 根治（契约 §3/§5）；**未改** ChatMessageList clearHeights（R1）/ addMessage（R5）；无 git commit/push
- **R4-Session（`hooks/useTabDrag.ts`）**
  - 拖开始：`beginLayoutInteraction('tab-dragging')`；结束/cancel/`lostpointercapture`：`endLayoutInteraction('tab-dragging')` 对称（`layoutInteractionActive` 防重入）
  - body `dragging-card` 由 store type 映射同步，**不再**业务侧 classList 直写
  - Hit-test：**每次 move** `collectLiveCardTargets` → 实时 `getBoundingClientRect` + `findCardSnapshotAtPoint`；废弃 pointerdown 静态 `cardSnapshots` 全程复用
  - 保留 pure `resolveTabDrop` / `canCommitTabDrop`（resolve 内无 DOM 写入）
  - 新增 pure：`cardTargetFromElementMeta` / `computeTabInsertLineGeometry` / `computeDropIndicatorBox` / `collectLiveCardTargets`
  - ghost `z-index: var(--z-drag-overlay)`（禁魔法 10000）
- **R4-DOM-Tab**
  - 移除往 tabsBar 插入假 `.card-tab.tab-placeholder-indicator`
  - 改为 body 上单一 fixed `.tab-insert-line` 竖线
- **R4-Layout（`components/Workspace.tsx`）**
  - 删除 `renderedColumns` 因 `dropPreview` splice `placeholderCol`/`placeholderGroup` 并改 ratio 的预览逻辑
  - 拖期 layout 树 = store 列/组结构（无 placeholder id）
  - 新增受控 `WorkspaceDropIndicator`：读 `dropPreview` + 实时 DOM 几何画 left/right/top/bottom/merge 浮层（`pointer-events: none`）
  - 废「仅 clear 不显示」的空 `#drop-indicator` 节点
- **R4-CardPanel**
  - 移除 `dockOverlayStyle` 及对应 DOM；保留 `draggedTab` 用于源 tab/组视觉态
- **R4-CSS**
  - `shell-dragdrop.css`：统一 `.drop-indicator` accent token；`.tab-insert-line` fixed；假 tab 强制隐藏
  - `shell-workspace.css`：停用 `.placeholder-card-group` / `::before`/`::after` 双分块与黑灰古董
  - `Workspace.module.css`：placeholder 类 no-op hide；`.dropIndicator` 对齐 accent
- **R4-Test**
  - 扩展：实时元数据 / insert 线几何 / drop indicator box / preview 无 placeholder id
  - 命令：
    ```text
    cd apps/crish-desktop
    npx vitest run --coverage.enabled=false src/hooks/useTabDrag.test.ts
    # → 1 file / 35 tests passed
    npm run typecheck  # (repo root) → OK
    ```
- **契约自检（§3/§5/§7）**
  - [x] 拖期无 placeholder 列/组进入 React 树
  - [x] 无 CardPanel dockOverlay 双轨
  - [x] 无 tab bar 假 tab
  - [x] `tab-dragging` 进 store（begin/end 对称）
  - [x] 实时几何 hit-test
  - [x] 相关单测绿
  - [x] 未动 clearHeights / addMessage
- **门闩**：待 Orchestrator 对照 `01-contract.md` §3/§5 验收

### R6-Integration + R6-Final-Review（A-QA / A-Review · 总装回归）

- **状态**：自动化 + 契约静态审计完成；**R6 门闩 pass**（产品功能未大改；未 git commit/push）
- **完成时间**：2026-07-22
- **范围**：只跑检查与写报告；**未重做 R1–R5 功能**；无大范围功能重写

#### 1. 自动化结果

| 项 | 命令 / 位置 | 结果 |
|----|-------------|------|
| typecheck | 仓库根 `npm run typecheck`（`tsc --noEmit -p apps/crish-desktop`） | **pass** |
| VirtualScrollManager | `apps/crish-desktop` 下 vitest | **11 pass** |
| fuzz virtual-scroll | 同上显式路径 `tests/fuzz/virtual-scroll.test.ts` | **5 pass** |
| useTabDrag | 同上 | **35 pass** |
| layoutAnimationStore | 同上 | **6 pass** |
| useWindowLayoutFreeze | 同上 | **4 pass** |
| sessionActions | 同上 | **34 pass** |
| generateMessageId | 同上 | **2 pass** |
| **合计** | 7 files | **97 pass / 0 fail** |

推荐命令（**必须**在 `apps/crish-desktop`，其 `vitest.config.ts` 为 `environment: 'jsdom'`）：

```text
cd apps/crish-desktop
npx vitest run --coverage.enabled=false ^
  src/api/VirtualScrollManager.test.ts ^
  tests/fuzz/virtual-scroll.test.ts ^
  src/hooks/useTabDrag.test.ts ^
  src/store/layoutAnimationStore.test.ts ^
  src/hooks/useWindowLayoutFreeze.test.ts ^
  src/store/sessionActions.test.ts ^
  src/utils/generateMessageId.test.ts
```

**已知边界（测试夹具环境，非产品回归）**：仓库根 `vitest.config.ts` 为 `environment: 'node'`，从根跑 `layoutAnimationStore` / `useWindowLayoutFreeze` 会因 `document is not defined` 红。R3/R2 自报已要求 desktop 路径；**不修业务**，记入 R7 可选项：根配置排除依赖 DOM 的 desktop hooks/store 测，或文档强制 cwd。

#### 2. 契约静态审计（grep / 读码）

| # | 检查项 | 结论 | 证据（路径 · 要点） |
|---|--------|------|---------------------|
| A | 无 `messageWindow.startIndex` → `clearHeights` | **pass** | `ChatMessageList.tsx`：`clearHeights()` 仅在 `activeSessionId` 变化分支（~L575–579）；deps 为 `[activeSessionId, visibleIds, …]`，**无** startIndex→clear Effect |
| B | `clearHeights` 仅会话切换 | **pass** | 全 `src` 业务调用点：仅 `ChatMessageList` 会话切换；`useVirtualScroll` 仅导出 API |
| C | Workspace 无 dropPreview splice placeholder 预览 | **pass** | `Workspace.tsx` `renderedColumns` ~L224–235：直接 `ws.columns.map`，注释禁止 splice；浮层 `WorkspaceDropIndicator` 只读 `dropPreview` |
| D | 无 `dockOverlayStyle` | **pass** | `CardPanel.tsx` 仅剩注释（~L241）；源码无 `dockOverlayStyle` 符号 |
| E | `useTabDrag` 有 begin/end `tab-dragging` | **pass** | begin ~L1300；`endTabLayoutInteraction` → end ~L1219–1222；`pointerup`/`pointercancel`/`lostpointercapture` 均 finish→end |
| F | `addMessage` 同 id upsert | **pass** | `sessionActions.ts` ~L411–418：`getMessageById` → `Object.assign` / else `push`；专测 `addMessage same id is upsert` |
| G | `useResizeFreeze` 订 `isLayoutFrozen` | **pass** | `useResizeFreeze.ts` L12：`useLayoutAnimationStore((s) => s.isLayoutFrozen)` |

**附加静态点（契约 §2–§5）**：

| 项 | 结论 | 备注 |
|----|------|------|
| 实时 hit-test | pass | `collectLiveCardTargets(document)` 于 move 热路径 ~L1371–1377；无 pointerdown 静态 `cardSnapshots` 全程复用 |
| 窗口桥单一入口 | pass | `App.tsx` `useWindowLayoutFreeze()`；`useWindowControls` 注释收敛，无 class-only 双监听 |
| 冻结写入侧 | pass | Workspace/Sidebar sash `beginLayoutInteraction('workspace-resizing')`；窗口 `window-resizing`；Tab `tab-dragging` |
| iframe `pointer-events` | pass | `shell-dragdrop.css` / `shell-workspace.css` 覆盖 `is-layout-frozen` / `resizing-active` / `window-resizing` / `dragging-card` |
| 假 tab 节点 | pass | 插入路径已删；防御清理 `.tab-placeholder-indicator`；CSS 强制 hide |
| ghost z-index | pass | `var(--z-drag-overlay)`，无魔法 10000 |

#### 3. 契约 §7 自检勾选

- [x] 未在 `messageWindow.startIndex` 变化时 `clearHeights`
- [x] 会话切换有 clear 或等价重置
- [x] 新交互冻结走 store begin/end，且 cancel 路径 end
- [x] 拖期无 placeholder 列/组进入 React 树（R4 完成后）
- [x] 相关单测绿（desktop jsdom 路径）

#### 4. 路线图手动 / 场景清单

| 场景（门闩意图） | 标记 | 说明 |
|------------------|------|------|
| R1：发送/expand older 无假重复主因路径关闭 | **pass**（代码+单测） | startIndex clear 已关；Manager pan 测绿。**需人工 UI** 目视发送/展开更早 |
| R2：交互冻结唯一源；无永久 frozen | **pass**（代码+store 测） | cancel/dispose 路径有测。**需人工 UI** 拖 sash / 缩放后确认无卡死 |
| R3：单一 window pulse | **pass** | controller 单测覆盖 burst/debounce/dispose |
| R4：指示器与落点一致；无双分块 | **pass**（代码+pure 测） | **需人工 UI** 多方向 drop / 暗色主题指示器 |
| R5：同 id 双 add 不增行 | **pass** | 专测绿 |
| 契约 §6 已知边界 | **已知边界** | 标题栏纯移动窗口；跨浏览器窗口 DnD — 不强制 |
| R6-Perf FPS/长任务 vs 基线 | **未做（可选）** | 本轮未采样；非门闩硬依赖 |

#### 5. R6 门闩表（总装）

| 门闩项 | 结果 |
|--------|------|
| typecheck | **pass** |
| 相关 vitest（7 文件 / 97） | **pass**（cwd=`apps/crish-desktop`） |
| 契约静态审计 A–G | **pass** |
| 契约 §7 勾选 | **pass** |
| 手动 UI 场景目视 | **需人工 UI**（不阻塞代码门闩） |
| R6-Perf | **skip / 可选** |
| **R6 总装门闩** | **pass** |

#### 6. 未通过 / 开放项 → R7 待审计

| 优先级 | 项 | 说明 |
|--------|----|------|
| Low | 根 vitest `node` vs desktop `jsdom` | 从 monorepo 根误跑会假红；文档或配置收口 |
| Low / 可选 | R6-Perf | FPS/长任务采样未做 |
| Manual | 人工 UI 清单 | 消息假重复观感、Tab 落点、sash 解冻、暗色 drop 样式 |
| Info | Baseline §3 历史表述 | Baseline 表仍写 R4「仍在」为 R0 盘点快照；以本 R6 静态审计为准（R4 已落地） |
| R7 | 全库只读审计 | 按路线图 `audits/01`–`03`；查残余 classList 直写、双份 `createChatActions` 漂移、漏网 clear 等 |

#### 7. 本轮改动

- **源码**：**无**（测试与 typecheck 均绿，无需修夹具）
- **文档**：本小节 + 状态总览 R1–R6 门闩更新
- **禁止遵守**：无 git commit/push；无 R1–R5 功能重写

---

### R7-Audit-List（A-Review 只读 · 消息列表/虚拟滚动/幂等）

- **状态**：审计完成；报告已落盘
- **完成时间**：2026-07-22
- **产出**：`docs/ui-jank-message-dnd-rootfix/audits/01-post-r6-list.md`
- **范围**：契约 §1/§4/§7 + R1 高度生命周期 + R5 upsert/id 熵；**未改业务代码**
- **结论摘要**：
  - **Critical：0**（无 startIndex→clear；权威 addMessage 无静默双插；bridge 无二次 push）
  - **High：2** — (H1) `useVirtualScroll` 的 `syncOrder` 在 `useEffect`，expand/窗变首帧 order 落后 `itemCount`；(H2) 缺 ChatMessageList/useVirtualScroll 接线级回归测
  - **Medium：7** — 宽变无 `invalidateAllActual`；流式 invalidate 仅 `msg.text`/无 heightTick；expand 补偿 fallback；clear 后 rAF setActual 回填；`createChatActions` 死镜像 + demo save 无 dedupe；子 agent id 低熵；移除消息不 `manager.delete`
  - **Low：5** — 浅合并语义、Baseline 文档滞后、vitest cwd、过滤仅 syncOrder、会话重置 expandedOlder（正向）
- **是否阻塞宣称根治**：
  - **不阻塞**「假重复主因路径根治」（错误 clear + 同 id 双插 + id 熵主路径已关）
  - **阻塞**「expand/窗变 100% 无跳动」类更强宣称（H1/M3）
- **建议 R8**：SyncOrder 改 layout 相；List 接线测；宽变 invalidate；流式 tick 桥；expand 二次补偿；死路径收口

---

### R8-List-SyncLayout（+ 尽量 R8-List-RegressionTests）

- **状态**：done（agent 自报）
- **完成时间**：2026-07-22
- **切片**：List 审计 H1（syncOrder layout 相）+ H2（接线/静态回归测，尽量）
- **范围**：仅 `useVirtualScroll` 时序 + 回归测；**未改** `addMessage` / DnD / ChatMessageList 业务逻辑
- **改动**：
  1. `apps/crish-desktop/src/hooks/useVirtualScroll.ts`：ids→`manager.syncOrder` 从 `useEffect` 升为 **`useLayoutEffect`**
     - 与 `itemCount` 在同一提交的 layout 相位对齐 order
     - 赶在 `ChatMessageList` expand 锚点补偿 layout effect 之前更新 order（同组件 hook 注册序）
     - `syncOrder` 对相同 ids 幂等 → StrictMode 双调用安全
  2. 新增 `apps/crish-desktop/src/hooks/useVirtualScroll.test.ts`：
     - hook：expand/pan 时 `syncOrder`、**不** `clear`、同 id 高度保留、`order.length === ids.length`
     - hook：重复 sync 幂等；clear 后新 ids 恢复
     - 静态：`useVirtualScroll.ts` 自动 sync 必须为 `useLayoutEffect([manager, ids])`，禁止回退 `useEffect`
     - 静态：`ChatMessageList.tsx` 无 `startIndex`+`clearHeights` 同 Effect / 同 deps；会话切换仍 `clearHeights`
- **未改**：`addMessage` / sessionActions；DnD / useTabDrag；`ChatMessageList` 业务 Effect 体（仅静态锁）
- **测试**：
  ```
  cd apps/crish-desktop
  npx vitest run src/hooks/useVirtualScroll.test.ts src/api/VirtualScrollManager.test.ts --coverage.enabled=false
  → 2 files / 16 tests passed
  ```
- **契约 §7 自检**：
  - [x] 未在 `messageWindow.startIndex` 变化时 `clearHeights`（静态测锁）
  - [x] 会话切换 clear 路径保留（静态测锁）
  - [x] 窗口平移 / expand 仅 syncOrder（hook 测）
  - [x] 相关单测绿
- **禁止遵守**：无 git commit/push
- **残留**（非本切片）：M1 宽变 invalidate、M3 expand fallback 二次补偿等仍见 `audits/01-post-r6-list.md`

---

### R8-Freeze-Hardening（A-Freeze · H2 try/finally + MAX_FREEZE_MS watchdog）

- **状态**：done（agent 自报）
- **完成时间**：2026-07-22
- **切片**：Freeze 审计 H2（sash commit 无 try/finally → 理论永久 frozen；store 无 watchdog）
- **契约**：`01-contract.md` §2 对称清理；**不**合并 `window-resizing` / `workspace-resizing`
- **改动**：
  1. `apps/crish-desktop/src/components/Workspace.tsx`
     - 列 sash `endResize`：commit（`resizeColumns`）包 `try`；`finally` 清内联宽 / `active` class + 双 rAF `endLayoutInteraction('workspace-resizing')` + `body.style.cursor = ''`
     - 组 sash 对称：`resizeGroups` + 清内联高 / cursor / end
     - `releasePointerCapture` 仍在 try 内嵌套 try/catch（capture 失败不阻断 finally）
  2. `apps/crish-desktop/src/components/Sidebar.tsx`
     - 侧栏拖宽 `handlePointerUp`：`applySidebarWidth` 包 `try`；`finally` 双 rAF `endLayoutInteraction('workspace-resizing')`
  3. `apps/crish-desktop/src/store/layoutAnimationStore.ts`
     - 导出 `MAX_FREEZE_MS = 30_000`
     - 按 **type** 独立 `armFreezeWatchdog` / `clearFreezeWatchdog`（`startAnimation` arm，含已在集合时刷新；`endAnimation` clear）
     - 超时：`console.warn` + `endAnimation(type)` force end；不跨类型误 end
  4. `apps/crish-desktop/src/store/layoutAnimationStore.test.ts`
     - 隔离：`workspace-resizing` end 不伤 `window-resizing`
     - watchdog 超时 force-end + warn；正常 end 取消 timer 无 warn
     - per-type 计时：workspace 先超时，window 仍 frozen
- **未改**：DnD 落点 / `useTabDrag` commit 序；`useWindowLayoutFreeze` 类型与 debounce
- **测试**：
  ```
  npx vitest run --environment jsdom \
    apps/crish-desktop/src/store/layoutAnimationStore.test.ts \
    apps/crish-desktop/src/hooks/useWindowLayoutFreeze.test.ts
  → 2 files / 14 tests passed
  ```
  （根 `vitest.config.ts` 默认 `node` 无 document；需 `--environment jsdom` 或 desktop 路径）
- **契约 §7 / 完成定义**：
  - [x] 新交互冻结走 store begin/end，且 cancel/commit 异常路径 end（finally）
  - [x] window-resizing ↔ workspace-resizing 类型隔离保留（测覆盖）
  - [x] finally 对称 + 测绿
  - [x] 本自报小节已追加
- **禁止遵守**：无 git commit/push；无大改 DnD 落点
- **残留**（非本切片）：Freeze M1 commit 仍在 frozen 窗、M3 move rAF、H1 跨 ws hit-test 等见 `audits/02-post-r6-freeze-drag.md`

---

### R8-Drag-WsScope（A-Drag · Freeze H1）

- **状态**：done（agent 自报）
- **完成时间**：2026-07-22
- **切片**：Freeze-Drag 审计 H1 — Tab hit-test 根为 `document`，多拆分工作区可串扰
- **范围**：`useTabDrag` hit-test 作用域 + pure helpers/测；**未改** commit 业务分支（merge/detach）、**未改** VirtualScroll clear、**未做** CommitOrder（M1）
- **改动**：
  1. `apps/crish-desktop/src/hooks/useTabDrag.ts`
     - 新增 pure：`workspaceHitTestRootSelector` / `resolveWorkspaceHitTestRoot` / `isPointInRect` / `resolveScopedCardHit` / `collectLiveCardTargetsForWorkspace`
     - `collectLiveCardTargets(root)`：**去掉**默认 `document`；调用方必须传入工作区根
     - move 热路径：`resolveWorkspaceHitTestRoot(wsId)` → `collectLiveCardTargets(wsRoot)` → `resolveScopedCardHit({ rootRect, targets, mouse })`
     - 根缺失 / 点在本 ws 外 / 无命中 → `lastDropType = null` + `safeSetDropPreview(null)`（跨 ws 不可 commit）
  2. `apps/crish-desktop/src/hooks/useTabDrag.test.ts`：R8-Drag-WsScope 专测（selector 转义、区外 null、仅扫本 ws targets、跨 ws → canCommit 拒绝）
- **测试**：
  ```
  npx vitest run src/hooks/useTabDrag.test.ts --coverage.enabled=false
  → 1 file / 41 tests passed
  ```
- **门闩对照**（`audits/03-followup-plan.md`）：
  - [x] `collectLiveCardTargets` 不再默认 `document` 全树
  - [x] hit-test 限 `[data-ws-id="${wsId}"]`
  - [x] 跨 ws 清空 preview / 禁 commit（`lastDropType=null` + `canCommitTabDrop(null)`）
  - [x] 相关单测绿
- **禁止遵守**：无 git commit/push；未改 VirtualScroll clear 逻辑；未大改 commit 业务
- **残留**（非本切片）：H2 冻结 watchdog/try-finally；M1 CommitOrder；M3 move rAF 等见 `audits/02-post-r6-freeze-drag.md`
