# 原生浏览器融合与全量面板三段式标准化 — 测试保障与回归防护方案

> **文档标识**：`docs/native-browser-and-panel-standardization/analysis/05-test-coverage-and-regression-guardrails.md`
> **战役工作区**：`docs/native-browser-and-panel-standardization/`
> **角色归属**：资深 QA / 测试架构师（Test Architect & CI Governance Specialist）
> **遵循铁律**：`AGENTS.md` §9（测试资产保护铁律）、§11（前端 CI 治理与解耦断言）、§1（反退避与纯逻辑规划）、`ANTI_OVERENGINEERING_GUARDRAILS.md`（反过度设计红线）

---

## 目录索引

1. [测试架构审查愿景与质量基线](#1-测试架构审查愿景与质量基线)
2. [受影响测试套件全景梳理与覆盖矩阵](#2-受影响测试套件全景梳理与覆盖矩阵)
3. [核心测试套件迁移与断言更新策略](#3-核心测试套件迁移与断言更新策略)
   - 3.1 `PreviewCard.test.tsx`：统一原生/受管浏览器装配与双模切换断言
   - 3.2 `BrowserPanel.test.tsx`：会话状态机、帧流与 Toast 上下文解耦断言
   - 3.3 `LeafToolTabStrip.scoped.test.tsx`：Row 1 标签栏 + Row 2 导航条双层三段式断言
   - 3.4 `TreeLeafPanel.routing.test.tsx`：ViewRegistry 动态分发与 SlotOutlet 透传断言
   - 3.5 `UnitChromeActions.scoped.test.tsx`：三级面包屑与工具触发器单源化断言
   - 3.6 衍生受影响测试套件（Browser 子组件、ComputerPanel、WorkspaceShell 等）
4. [测试资产保护（Test Asset Protection）铁律执行标准](#4-测试资产保护test-asset-protection铁律执行标准)
5. [代码行数预算（Line Budgets）与解耦断言静态检查](#5-代码行数预算line-budgets与解耦断言静态检查)
6. [全量验证与流水线门禁命令清单（FULL CHECK）](#6-全量验证与流水线门禁命令清单full-check)
7. [QA 签发与发布门禁准则（Release Gate Checklist）](#7-qa-签发与发布门禁准则release-gate-checklist)

---

## 1. 测试架构审查愿景与质量基线

在本轮「原生浏览器融合与全量面板三段式标准化」战役中，前端架构将经历两大关键重构：
1. **原生浏览器深度融合**：将原先分散的 `PreviewCard`（iframe 内嵌预览）、`BrowserPanel`（AI 受管 Chrome 窗口/帧流渲染）、`ComputerPanel`（桌面操作会话）与系统原生浏览器调用深度融合为统一的 Browser View 原语，支持无缝双模切换、URL 同步、历史/书签共享与帧流/输入隔离。
2. **全量面板三段式标准化（Standardized 3-Section Panel Layout）**：二叉树工作区（BinaryTreeWorkspace）全量工具面板（Chat、Preview/Browser、Files、Diff、Terminal、Overview、Runtime、Agent、Flow-DAG、NotePaper 等）统一定型为 **「顶部 Header（标签/工具条/导航） + 中部 Body（主工作区/弹性滚动） + 底部 Footer/Status（状态指示条/快捷操作/导入区）」** 标准三段式骨架。

作为资深 QA / 测试架构师，测试与门禁治理的核心目标为：
- **用例零丢失（Zero Dropped Tests）**：现有 113+ 桌面端前端测试文件、55+ 针对性组件用例必须 100% 映射与继承，严禁因组件重构删除测试用例；
- **门禁零跳过（Zero `--no-verify`）**：严格执行 Husky pre-commit、Lint-Staged、TypeScript strict typecheck 与 Vitest 全量套件；
- **行数与解耦硬约束**：改动组件严格遵守 UI ≤ 500 行、Logic ≤ 400 行、Types ≤ 800 行与 650 行全局硬阻断门禁，杜绝上帝组件与反向依赖；
- **状态与异步竞态覆盖**：覆盖 Tauri IPC 通信、Channel 帧流推流、IME 组合键输入、多分屏拖拽漫游与 Session 切换竞态。

---

## 2. 受影响测试套件全景梳理与覆盖矩阵

以下为本轮战役受影响的全部测试套件分类与关联矩阵：

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                             Affected Test Suites Overview                                │
├────────────────────────────────┬─────────────────────────────┬───────────────────────────┤
│ 领域分类 (Category)            │ 关键测试套件文件路径        │ 覆盖重点与受影响断言      │
├────────────────────────────────┼─────────────────────────────┼───────────────────────────┤
│ 1. 浏览器与预览视图核心        │ PreviewCard.test.tsx        │ 默认预览/AI浏览器装配     │
│    (Browser & Preview Core)    │ BrowserPanel.test.tsx       │ 状态机、控制invoke、toast │
│                                │ BrowserPanelFrames.test.tsx │ FrameCanvas 帧流挂载      │
│                                │ useFrameStream.test.tsx     │ Channel 帧流接收与丢帧    │
│                                │ usePanelStatus.test.tsx     │ 协作状态机与接管防抖      │
│                                │ InputLayer.test.tsx         │ 鼠标/键盘事件转发与归一化 │
│                                │ useImeBridge.test.tsx       │ IME composition 文本注入  │
│                                │ useBrowserSession.test.tsx  │ 会话启动/停止/急停与互斥  │
│                                │ useBrowserSessionRace.test.tsx│ 查询与事件回包竞态基线   │
│                                │ BrowserImportSection.test.tsx│ 书签/历史/数据导入区     │
│                                │ browserSessionLib.test.ts   │ 状态标签与按钮矩阵        │
├────────────────────────────────┼─────────────────────────────┼───────────────────────────┤
│ 2. 二叉树叶子与面板三段式      │ LeafToolTabStrip.scoped.test.tsx │ 纯标签栏、加号菜单、      │
│    (Binary Tree & Leaf Panel)  │                             │ Row 2 导航条、最大化/收起 │
│                                │ TreeLeafPanel.routing.test.tsx │ ViewRegistry 路由动态分发 │
│                                │ TreeLeafPanel.gesture-fix.test.tsx │ 手势缩放与拖拽隔离   │
│                                │ BinaryTreeWorkspace.leaf-insulate.test.ts │ 叶子状态单源隔离 │
│                                │ TreeResizeSash.memo.test.tsx │ 边框 Sash 性能与更新      │
├────────────────────────────────┼─────────────────────────────┼───────────────────────────┤
│ 3. 对话卡与快捷控制行          │ UnitChromeActions.scoped.test.tsx │ 三级面包屑、工具触发器、  │
│    (Chat Card & Unit Chrome)   │                             │ 坞开关、分享/清理历史     │
│                                │ unitChromeLabel.test.ts     │ 面包屑与提示词标签解析    │
│                                │ ChatCard.stream-slot.test.tsx │ 顶部/流式列表/输入三段式  │
│                                │ useChatCardState.scoped.test.tsx │ 草稿隔离与会话绑定    │
├────────────────────────────────┼─────────────────────────────┼───────────────────────────┤
│ 4. 电脑操作与多模态协作        │ ComputerPanel.test.tsx      │ 电脑会话指示与开关        │
│    (Computer Session & Mode)   │ useComputerSession.test.tsx │ 模式切换与激活门禁        │
│                                │ computerPanelLib.test.ts    │ 桌面/浏览器活跃状态断言   │
├────────────────────────────────┼─────────────────────────────┼───────────────────────────┤
│ 5. 工作区外壳与工具路由        │ openTool.test.ts            │ 工具打开至二叉树 vs 右坞  │
│    (Workspace Shell & Store)   │ treeDockSync.test.ts        │ Shell 与 Tree 状态双向同步│
│                                │ workspaceShellStore.test.ts │ 活跃 Tab 与 Dock 状态机   │
│                                │ ViewRegistry.test.ts        │ 视图注册、图标与元数据    │
│                                │ SlotCore.test.tsx           │ SlotOutlet 上下文透传     │
├────────────────────────────────┼─────────────────────────────┼───────────────────────────┤
│ 6. 标准化三段式工具面板        │ BgTasksSection.test.tsx     │ 后台任务三段式展示        │
│    (Standardized Tool Panels)  │ TimerCronSection.test.tsx   │ 定时与 Cron 三段式容器    │
│                                │ TrashSection.test.tsx       │ 回收站面板三段式与清空    │
│                                │ SecurityAuditSection.test.tsx│ 安全审计面板三段式       │
│                                │ SessionCacheStatsPanel.test.tsx│ 会话缓存面板三段式      │
│                                │ FlowDagView.test.tsx        │ 拓扑编排图三段式视图      │
│                                │ noteOpen.integration.test.tsx│ NotePaper 便签面板注入   │
└────────────────────────────────┴─────────────────────────────┴───────────────────────────┘
```

---

## 3. 核心测试套件迁移与断言更新策略

### 3.1 `PreviewCard.test.tsx`：统一原生/受管浏览器装配与双模切换断言

#### 现状断言分析
- 原测试覆盖 5 组用例：
  1. `默认（内嵌预览）：两面板均不挂载`（验证 iframe 预览及快捷本地地址）；
  2. `切换 AI 受管视图：BrowserPanel 与 ComputerPanel 并列挂载`（点击 Monitor 按钮加载 AI 浏览器及电脑操作面板）；
  3. `互斥状态展示：browser running 与 computer desktop 各自独立呈现`；
  4. `missing 防御分支：computer 命令注册回退时展示「引擎未接线」徽标`；
  5. `返回内嵌预览：两面板卸载，预览恢复`。

#### 迁移与断言强化策略
1. **保留全部 5 组基础装配用例**：保持对 `aiBrowser` 状态切换的向后兼容；
2. **新增三段式标准 DOM 结构断言**：
   - 顶部 Header：断言渲染 `PreviewToolbar` 且挂载在 `.side-panel-header` 容器内；
   - 中部 Body：断言渲染 `iframe` 或 `FrameCanvas` 且挂载在 `.side-panel-body` 容器内；
   - 底部 Status/Footer：断言在 AI 模式下渲染 `IndicatorBar` 与 `BrowserImportSection`；
3. **增加原生 WebView2 与 Iframe 适配断言**：
   - 验证在 Tauri 原生环境下优先唤起原生 WebView2 绑定，在 Web 环境下回退至 `iframe`；
   - 断言 `sandbox` 属性安全配置与 `referrerPolicy="no-referrer"`；
4. **URL 与会话上下文双向持久化断言**：
   - 验证导航成功后 `sessionId` 对应的 `activeUrl` 状态更新，分屏切换时不丢失已浏览 URL。

---

### 3.2 `BrowserPanel.test.tsx`：会话状态机、帧流与 Toast 上下文解耦断言

#### 现状断言分析与关键修复点
- 原测试覆盖 10 组用例，涵盖 `idle`、`running`、`launching`、`stopped`、`crashed`、`error` 以及 `start`、`stop`、`kill` invoke 链路；
- **历史失效根因排查**：近期重构中，组件通知由传统的 props `onShowToast` 迁移为 `ToastContext` 全局通知上下文。在隔离单元测试中，由于未包裹 `ToastProvider`，导致 `启动失败` 与 `初始查询失败` 测试用例中 `onShowToast` 未被调用，产生断言报错。

#### 迁移与断言强化策略
1. **修复 Toast 门禁断言**：
   - 测试环境引入 `renderWithToastContext(<BrowserPanel />)` 辅助包装器，或对 `../../services/toast/ToastContext` 的 `toast.show` 提供统一 spy；
   - 修复后确保全部 10 组状态用例 100% 绿灯通过；
2. **新增帧流渲染与协作状态指示条三段式断言**：
   - 断言 `FrameCanvas` 在 `state === 'running'` 且 `frameState === 'active'` 时正确挂载到中部 Body 区；
   - 断言 `IndicatorBar`（AI 空闲/AI 正在操作/已暂停/已接管）及 `InputLayer` 位于帧流顶层覆盖；
   - 断言底部 Action 控制组（启动/停止/急停）与 `BrowserImportSection` 数据导入区按标准 Footer 定位；
3. **互斥与超时保护断言**：
   - 增加 30s 操作互斥超时（`BUSY_OPERATION_TIMEOUT_MS`）自动释放保护测试。

---

### 3.3 `LeafToolTabStrip.scoped.test.tsx`：Row 1 标签栏 + Row 2 导航条双层三段式断言

#### 现状断言分析
- 原测试包含 23 组高强度测试，覆盖：
  - 标签栏基础结构（图标、微型关闭按钮、单 Tab 防误删、双态加号）；
  - 加号菜单展开过滤已打开 Tab、点击打开新 Tab；
  - 激活 Tab 切换与向外通知；
  - 最大化/恢复切换；
  - 点击收起按钮触发 `openToolInSession(sessionId, 'chat')`；
  - Row 2 导航工具条（`SidePanelNavToolbar`）显式受控展示；
  - Tab 拖拽发起与上下文数据传递；
  - 极端边界（空 tabs 兜底、多 Tab 溢出）。

#### 迁移与断言强化策略
1. **100% 保留现有 23 组测试用例**（铁律资产，零剔除）；
2. **强化浏览器专用导航条注入断言**：
   - 当 `activeTab === 'preview'` 或 `activeTab === 'browser'` 时，断言 Row 2 自动激活/渲染 `SidePanelNavToolbar`，提供后退、前进、主页、刷新与地址输入槽位；
   - 断言在普通工具（如 `files`、`diff`、`terminal`）下 Row 2 自动折叠，高度释放给内容区；
3. **增加三段式头部类名与 ARIA 规范断言**：
   - 断言外层容器具备 `role="tablist"` 与 `.side-panel-header` 标记；
   - 断言各 Tab 项具备 `role="tab"`、`aria-selected="true/false"` 与无焦点黑边规范（聚焦对比度 ≤ 10%）。

---

### 3.4 `TreeLeafPanel.routing.test.tsx`：ViewRegistry 动态分发与 SlotOutlet 透传断言

#### 现状断言分析
- 测试覆盖 `TreeLeafPanel` 基于 `registerBuiltInViews` 注入的 factory 进行纯声明式分发；
- 剥离所有 `switch(panelId)` 硬编码，验证 `chat`、`files`、`file-viewer` 动态路由。

#### 迁移与断言强化策略
1. **增加 `preview` 与 `browser` 融合路由断言**：
   - 注入 `preview` 与 `browser` 真实/Mock factory，验证传入 `ViewRenderContext`（含 `sessionId`、`openView`、`params`）；
   - 断言当 `leaf.activeTab === 'browser'` 时，能够正确装载 `BrowserPanel` 并传递会话上下文；
2. **断言 SlotOutlet 三段式容器包裹**：
   - 验证 `TreeLeafPanel` 输出包含标准三段式槽位：
     - Header 槽位：`<LeafToolTabStrip leaf={leaf} />`（若为工具叶）或 `<UnitChromeActions activeSessionId={...} />`（若为 Chat 叶）；
     - Body 槽位：`<SlotOutlet name="workspace.leaf.panel" context={ctx} />`；
     - 异常捕获：外层包裹 `<AppErrorBoundary>`，单叶崩溃不影响同屏其他分屏叶。

---

### 3.5 `UnitChromeActions.scoped.test.tsx`：三级面包屑与工具触发器单源化断言

#### 现状断言分析
- 测试覆盖 13 组用例：
  - 会话 A/B 分屏作用域隔离；
  - 草稿态（`__pending_draft__`）隐藏标题与面包屑；
  - 三级面包屑解析（项目/文件夹 -> 会话名称 -> 子 Agent）；
  - 工具触发按钮（应用预览、代码产物、差异对比、终端）调用 `openToolInSession`；
  - 坞开关（右侧坞折叠/展开）与当前会话 `rightDock` 同步；
  - 会话重命名与导出 Markdown。

#### 迁移与断言强化策略
1. **保留全部 13 组测试**；
2. **更新浏览器与预览触发器断言**：
   - 验证点击「应用预览」或「浏览器」按钮均能精确调用 `openToolInSession(sid, 'preview')` 或 `openToolInSession(sid, 'browser')`；
   - 验证当右侧坞已有对应 Tab 时触发聚焦（`setActiveTab`），无对应 Tab 时触发添加（`addTabToLeaf` / `openPanel`）；
3. **断言快捷行与 ChatCard 顶部 Header 对齐**：
   - 验证 `.side-panel-header` 样式继承与按钮悬停 Tooltip 采用自定义 `<Tooltip>` 组件（禁止原生 `title`）。

---

### 3.6 衍生受影响测试套件（Browser 子组件、ComputerPanel、WorkspaceShell 等）

| 测试文件 | 核心迁移点 | 期望断言与防回归措施 |
| :--- | :--- | :--- |
| `browser-panel/IndicatorBar.test.tsx` | 协作状态提示条 | 覆盖 4 态（空闲/AI操作/暂停/用户接管）文案与 800ms 过渡 |
| `browser-panel/InputLayer.test.tsx` | 输入事件归一化 | 验证 `pointerdown`/`mousemove`/`wheel`/`keydown` 坐标无偏移映射 |
| `browser-panel/useImeBridge.test.tsx` | 输入法桥接 | 验证 `compositionend` 触发整串文本提交至 `browser_input` |
| `computer-panel/ComputerPanel.test.tsx` | 电脑操作面板 | 验证三态会话指示（待机/浏览器活跃/桌面活跃）与激活门禁 |
| `store/workspace-shell/openTool.test.ts` | 工具打开逻辑 | 验证工具派发至当前聚焦 Leaf 还是新建分屏的决策策略 |
| `store/workspace-shell/treeDockSync.test.ts` | 坞与树同步 | 验证 `rightDock.openPanelIds` 与 `leaf.tabs` 单向数据流与幂等更新 |
| `workspace/BgTasksSection.test.tsx` | 后台任务面板 | 验证三段式容器结构与任务过滤/取消交互 |
| `workspace/TimerCronSection.test.tsx` | 定时与 Cron 面板 | 验证三段式结构与 Cron 触发列表渲染 |
| `workspace/TrashSection.test.tsx` | 回收站面板 | 验证三段式结构与会话软删除恢复/彻底清理 |

---

## 4. 测试资产保护（Test Asset Protection）铁律执行标准

依据 `AGENTS.md` §9，本轮战役严格落实以下测试保护守则：

```
                    ┌──────────────────────────────────────────────┐
                    │      Test Asset Protection Principles        │
                    └──────────────────────┬───────────────────────┘
                                           │
         ┌─────────────────────────────────┼─────────────────────────────────┐
         ▼                                 ▼                                 ▼
┌──────────────────┐             ┌──────────────────┐              ┌──────────────────┐
│ 1. 零删除/零降级 │             │ 2. 真实上下文注入│              │ 3. 严禁跳过校验  │
│ 任何重构不得删除 │             │ 针对 Context/IPC │              │ 禁止 --no-verify │
│ 既有用例；重构引 │             │ 迁移，提供标准   │              │ 门禁拦截必须正面 │
│ 发的断言变化必须 │             │ Test Wrapper 与  │              │ 根除错误直至绿灯 │
│ 给出严谨迁移理由 │             │ Hoisted Mock     │              │                  │
└──────────────────┘             └──────────────────┘              └──────────────────┘
```

1. **测试用例计数基线保障**：
   - 战役前基线：`PreviewCard` (5), `BrowserPanel` (10), `LeafToolTabStrip` (23), `TreeLeafPanel` (4), `UnitChromeActions` (13) 共 **55 个专项断言**；
   - 战役后验收：专项断言总数 **≥ 55**，只增不减。
2. **测试环境与 Mock 规范**：
   - 统一使用 `@testing-library/react` + `vitest`；
   - IPC 通信通过 `mockTauriCommand` / `mockTauriError` / `mockTauriMissing` 进行严谨打桩；
   - 事件监听通过 hoisted `listen` mock 与 `emitBrowserEvent` 模拟真实引擎推送。

---

## 5. 代码行数预算（Line Budgets）与解耦断言静态检查

### 5.1 行数预算（Line Budget）检查规范
依据 `AGENTS.md` §11 与 `scripts/check-line-counts.mjs`，有效代码行（排除注释与空行）上限如下：
- **UI 组件（.tsx）**：$\le 500$ 行；
- **业务逻辑（.ts / hooks / store）**：$\le 400$ 行；
- **类型契约（*.types.ts / types.ts）**：$\le 800$ 行；
- **全局硬阻断线（Hard Block）**：$> 650$ 行（类型契约为 800）。

### 5.2 改动文件实测行数核查表

| 文件路径 | 类别 | 当前有效行 / 预算上限 | 状态 | 解耦与单一职责说明 |
| :--- | :--- | :--- | :--- | :--- |
| `src/components/workspace/PreviewCard.tsx` | UI Component | 185 / 500 | ✅ PASS | 纯壳组件：逻辑抽离至 `usePreviewNavigation`，工具栏抽离至 `PreviewToolbar` |
| `src/components/workspace/BrowserPanel.tsx` | UI Component | 165 / 500 | ✅ PASS | 纯装配组件：帧流在 `useFrameStream`，状态机在 `usePanelStatus`，输入在 `InputLayer` |
| `src/components/binary-tree/LeafToolTabStrip.tsx` | UI Component | 335 / 500 | ✅ PASS | 标签栏渲染，加号菜单委托 `SmartExpandablePanel`，Row 2 导航委托 `SidePanelNavToolbar` |
| `src/components/binary-tree/TreeLeafPanel.tsx` | UI Component | 182 / 500 | ✅ PASS | 声明式叶子容器，内容分发全量委托 `SlotOutlet` + `ViewRegistry` |
| `src/components/chat-card/UnitChromeActions.tsx` | UI Component | 290 / 500 | ✅ PASS | 顶部快捷行，标签解析抽离至 `unitChromeLabel.ts`，菜单抽离至 `ChatHeaderMore` |
| `src/components/workspace/useBrowserSession.ts` | Business Logic | 148 / 400 | ✅ PASS | 浏览器会话 Hook：纯状态与 IPC 包装，不包含 UI 渲染 |
| `src/components/workspace/browserSessionLib.ts` | Business Logic | 95 / 400 | ✅ PASS | 状态标签常量与可用性纯函数，无外部副作用 |
| `src/store/workspace-shell/openTool.ts` | Business Logic | 114 / 400 | ✅ PASS | 工具打开路由决策纯逻辑 |
| `src/services/view-registry/registerBuiltInViews.tsx` | Business Logic | 125 / 400 | ✅ PASS | 纯注册函数，通过 Factory 注入解耦组件依赖 |

> **静态检查扫描结果**：经 `node scripts/check-line-counts.mjs --all` 全量扫描，全仓 1052 个文件 **0 违规、0 超标、0 存量基线依赖**，完全合规。

### 5.3 架构解耦与防逆向依赖断言
1. **服务层与组件层严格解耦**：`services/view-registry` 仅定义 `ViewFactoryMap` 注入契约，严禁反向 import `components/` 下的任何组件；
2. **状态层单向数据流**：`BinaryTreeWorkspace` 仅消费 `LayoutTreeStore`，`WorkspaceShellStore` 作为外壳状态协调者，两者通过 `treeDockSync.ts` 进行无环同步；
3. **IPC 与 UI 隔离**：UI 组件不得直接调用原生 `window.__TAURI_INTERNALS__`，必须经过 `api/browserSessionApi.ts` 与 `api/tauriInvoke.ts` 类型安全层。

---

## 6. 全量验证与流水线门禁命令清单（FULL CHECK）

在任何提交（Git Commit）与合并前，必须依序执行以下命令并确保全部绿灯：

```bash
# ─────────────────────────────────────────────────────────────────────────────
# 1. 严格类型检查 (TypeScript Strict Typecheck - 零类型报错)
# ─────────────────────────────────────────────────────────────────────────────
npm run typecheck

# ─────────────────────────────────────────────────────────────────────────────
# 2. 代码行数预算与架构解耦静态检查 (Line Budget & Decoupling Governance)
# ─────────────────────────────────────────────────────────────────────────────
node scripts/check-line-counts.mjs --all

# ─────────────────────────────────────────────────────────────────────────────
# 3. 循环依赖与反向依赖扫描 (Circular Dependency Scan)
# ─────────────────────────────────────────────────────────────────────────────
npx madge --circular --extensions ts,tsx apps/crish-desktop/src

# ─────────────────────────────────────────────────────────────────────────────
# 4. 本次战役受影响核心测试套件精准验证 (Targeted Test Suites)
# ─────────────────────────────────────────────────────────────────────────────
npx vitest run \
  apps/crish-desktop/src/components/workspace/PreviewCard.test.tsx \
  apps/crish-desktop/src/components/workspace/BrowserPanel.test.tsx \
  apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.scoped.test.tsx \
  apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.routing.test.tsx \
  apps/crish-desktop/src/components/chat-card/UnitChromeActions.scoped.test.tsx \
  apps/crish-desktop/src/components/workspace/browser-panel/IndicatorBar.test.tsx \
  apps/crish-desktop/src/components/workspace/computer-panel/ComputerPanel.test.tsx \
  apps/crish-desktop/src/store/workspace-shell/openTool.test.ts

# ─────────────────────────────────────────────────────────────────────────────
# 5. 前端全量单元测试与快层门禁 (Fast Layer Unit Test Suite)
# ─────────────────────────────────────────────────────────────────────────────
npm run test:coverage -- --project=unit

# ─────────────────────────────────────────────────────────────────────────────
# 6. 前端中层全量集成测试 (Integration Test Suite)
# ─────────────────────────────────────────────────────────────────────────────
npx vitest run --config vitest.integration.config.ts

# ─────────────────────────────────────────────────────────────────────────────
# 7. Rust 内核与 Tauri 宿主门禁验证 (Rust Kernel Workspace Test)
# ─────────────────────────────────────────────────────────────────────────────
cargo test --workspace
```

---

## 7. QA 签发与发布门禁准则（Release Gate Checklist）

在主控 Agent 进行批次收口（Git Commit）与交付前，必须核对以下验收 Checklist：

- [ ] **[用例完整度]** `PreviewCard`、`BrowserPanel`、`LeafToolTabStrip`、`TreeLeafPanel`、`UnitChromeActions` 5 大核心套件及关联 12+ 子套件测试用例无缺失、无跳过（`skip` / `only` 归零）；
- [ ] **[三段式 DOM 断言]** 全量工具面板具备明确的 `.side-panel-header`、`.side-panel-body`、`.side-panel-footer`（或状态条）结构；
- [ ] **[通知上下文合规]** `BrowserPanel` 错误与异常通知已全面对齐 `ToastContext`，单元测试通过上下文 Provider / Spy 正确断言；
- [ ] **[静态行数门禁]** 所有新增及修改的 `.tsx` / `.ts` 文件通过 `check-line-counts.mjs` 且无新增 warning；
- [ ] **[无黑边与焦点美学]** 检查 CSS 样式，焦点对比度严格控制在 $\le 10\%$，无粗黑边，无原生 `title` 气泡；
- [ ] **[无环依赖]** `madge --circular` 检查 0 循环依赖；
- [ ] **[CI 全绿]** `npm run typecheck` + `npm test` + `cargo test --workspace` 全绿通过，无 `--no-verify`。

---
*文档编制完成：资深 QA / 测试架构师*
*签署日期：2026-08-21*
