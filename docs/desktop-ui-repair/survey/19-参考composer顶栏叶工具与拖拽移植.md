# 19 · 参考 composer / 顶栏 / 叶工具与拖拽移植

> 战役：`docs/desktop-ui-repair/`
> 性质：只梳理如何把用户自己调过的参考模块移植进**现产品**。不改产品源码、不提交、不写实现、不派子代理、不生成 AI 假图。
> 用户锁（盖过旧「不要抄金标假壳」）：`C:\Software\conex\reference\chat-composer-component\index.html` 里下列模块是精心设计，**要评估如何移植**。主壳仍是 BinaryTree + 叶槽；对话默认线性；`conversation-flow` 插件默认 OFF，仍须能挂。
> **禁止搬**：`demo-data.js`、假侧栏会话、假窗控（`winMinimizeBtn` / `winMaximizeBtn` / `winCloseBtn` 只 `console.log`）、假右坞空态文案（「Create apps with Build Mode」）、演示五步 IPC 剧本、`FlowTimelineRail` 竖轨、权限条 5 分钟老虎机倒计时。
> 问题同权：下列条目不分 P0/P1，不按「好修/难修 / 先 MVP」砍。

本文件依据：参考 `index.html` + `css/composer.css` + `css/flow/{plan,permission-bar,scrubber}.css` + `js/{composer-core,popovers}.js` + `js/components/{FlowScrubber,FlowMount,PermissionBar}.js` + `DESIGN_SYSTEM.md`；现产品 `AppTopBar` / `GlobalSessionTabBar` / `UnitChromeActions` / `TreeLeafPanel` / `ChatComposer*` / `ChatComposerWrapper` / `conversation-flow` 扩展。未连 `127.0.0.1:9222` 复拍；未打开参考 HTML 做像素量测。实现阶段须 WebView2 对像素。

---

## 0. 结论先行

1. **参考的「主对话快捷功能行」不是现产品的 `UnitChromeActions` 图标簇。** 参考 `chat-top-header` 是贴在对话流上的 38px 渐隐覆盖层：左上面包屑（项目 / 会话 / 子 Agent），右侧 **永远在的 28px 固定钮**（更多、分享），另有一枚 **无论右坞开合都不卸载** 的 `top-side-panel-btn`。现产品把「打开总览/文件/差异/终端/笔记」整簇塞进叶 chrome，空会话还 `data-canvas-quiet` 半隐，坞展开时连「展开右坞」钮都卸载——这正是用户点名不对的地方。survey/15 里「空画布静默簇」已被本锁盖过。
2. **`_toolbarActions_10cfr_1 _leafToolHeader_1hohd_175` 整行错在盒模型，不只是贴边。** 两个 class 叠在同一节点上：`.leafToolHeader` 是叶上 `width:100%` 弹性兄弟，有消息时占一整行把 `leafBody` 往下挤；空会话又改成绝对定位半透明叠层。参考根本没有这条「工具通栏」。
3. **`composer-wrapper` 要全面移植结构，不是给现 `ChatComposer` 换皮。** 参考是一张卡片：上沿浮层（权限条 → 计划条负边距嵌入）+ 附件在输入上 + 单行网格（加号 | 输入 | 盾形权限 | 融合模型/思考 | 语音 | 绿圆发送）。现产品是「大输入盒内塞发送 + 更窄悬挂底栏」两截，权限条/计划条走另一套 ribbon / 插件槽，附件在输入下。
4. **`flow-scrubber-wrapper` 不是竖轨，是对话叶滚动条左侧的无轨刻度。** 默认线性对话也有用户气泡，应挂在**默认壳**（chat 叶），插件 ON 只丰富刻度元数据。`DESIGN_SYSTEM.md` 要求按消息高度映射；参考 JS 目前仍是等高校刻度——移植要按规范做完整效果，不要把等高校当最终。
5. **用户说调了很久的「拖拽」主要不是 composer 高度手柄。** 参考没有 composer 高度 drag handle。调过的是：单行↔多行容量引擎、文件拖入遮罩、侧栏/右坞/二叉树分割条（6px 命中 + 品牌绿 2px 线）、标签拖入分屏（4px 阈值、1/3 滞后、150px 指示条）、scrubber 刻度 hitbox 与滚轮穿透。产品已有对应骨架，缺的是参考里那套常量与手感，不是从零做拖拽。
6. **`_topBar_59jbx_9 app-top-bar` 对照的是密度 / 加号 / 会话名位置，不是假窗控。** 参考会话 Tab + 加号在叶顶 `tree-pane-header`（页底色、26px 胶囊、加号紧贴末枚 Tab）；窗控是透明浮层。产品把会话 Tab、侧栏开关、帮助、真窗控全塞进占流 36px 且带 `--bg-secondary` 底 + 0.5px 底边的 `AppTopBar`。会话名还和侧栏双源（见 survey/15）。假 min/max/close 不搬；密度与加号位置要搬。

---

## 1. 两棵真树（移植坐标，不是愿望）

### 1.1 参考（`index.html` 静态 + `popovers.js` `WorkspaceSplitRenderer` 运行后）

```
.chat-app-layout
  aside.chat-left-sidebar          ← 演示壳，不搬
  .layout-resizer-sidebar          ← 手感可搬，绑产品已有侧栏宽
  .app-workspace-container
    header.workspace-top-bar       ← 36px 透明浮层，只放假窗控（不搬窗控）
    main.workspace-content-body
      #binaryTreeWorkspaceContainer
        .tree-leaf-pane
          .tree-pane-header        ← 36px：会话 Tab + .top-bar-new-tab-btn
          .tree-pane-content
            .chat-main-pane
              header.chat-top-header     ← 本锁 ①：面包屑 + 固定右钮
              .chat-stream-container
              .composer-wrapper          ← 本锁 ③
            .layout-resizer-panel
            .chat-side-panel             ← 假 Build Mode 文案不搬；真工具坞已有
          button.top-side-panel-btn      ← 绝对定位，开合都不卸载
        .tree-split-resizer              ← 本锁 ⑤ 分栏
      （body 上另挂 .flow-scrubber-wrapper / tooltip）  ← 本锁 ④
```

`chat-top-header` 在 `index.html:221-257`。`composer-wrapper` 在 `:267-418`。`workspace-top-bar` 在 `:206-213`（只有 min/max/close）。会话 Tab 条是 JS 动态插进 `.tree-pane-header`（`popovers.js:1502-1555`），不是静态 HTML 的 `app-top-bar`。

### 1.2 现产品

```
AppTopBar.topBar.app-top-bar       ← 本锁 ⑥：占流 36px
  rail: 侧栏开关
  main: GlobalSessionTabBar（caption）+ 加号
  spacer
  trail: 帮助 + WindowControls（真窗控，保留）
BinaryTreeWorkspace
  TreeLeafPanel.leaf
    UnitChromeActions.toolbarActions.leafToolHeader   ← 本锁 ①②
    .leafBody
      ChatCard
        .chatDocFlow  → ChatEmptyState | SlotOutlet workspace.chat.stream
        ChatComposerWrapper.chatFooter
          ChatStatusRibbons（计划/目标 slim ribbon、ApprovalDock…）
          SlotOutlet workspace.chat.composerAbove     ← 插件 ON 才挂 PermissionBar
          ChatComposer.composerWrapper
```

`conversation-flow`：`activate.ts:42-44` `shouldActivateOfficialConversationFlow()` 默认 `officialOverride ?? false`；`main.tsx:138-140` 仅真才 `activateConversationFlow()`。激活后占 `workspace.chat.stream` + `workspace.chat.composerAbove` 两个 single 槽。关插件时 stream 回落 `ChatMessageList`，composerAbove 为 `null`。

### 1.3 旧战役口径被本锁盖过的部分

| 旧口径 | 出处 | 本锁 |
| --- | --- | --- |
| 不要搬演示壳的计划底栏 / scrubber | `docs/chat-composer-plugin/survey/07`、`06` | **要评估移植**；不搬 demo-data / 假壳，搬结构与手感 |
| 空会话叶工具半隐 `data-canvas-quiet` | survey/15 §4、`unitChromeLabel.ts:78-90` | **不对**。右侧按钮固定，与右坞是否展开无关 |
| 计划 Hub 类名不得出现在 conversation-flow 扩展目录 | `narrative.source.test.ts:83-95` S8 | Hub 进**默认壳** composer 上沿，不进插件目录；插件只喂真实步骤 |
| 插件源码锁禁 `--brand` / 绿勾 | 同文件 CSS 锁 | 发送圆用产品已有 `--accent` / brand token，不把参考硬编码 `#10b981` 写进插件 CSS |

---

## 2. 可移植清单（模块 → 现文件域 → 冲突/依赖 → 壳或插件）

> 「全面移植」= 结构、密度、开合、拖拽常量都要到；不是皮肤近似。数据源换产品真会话 / 真审批 / 真计划，禁止演示剧本。

| # | 参考模块 | 要搬进产品的效果 | 现文件域 | 冲突 / 依赖 | 默认壳还是插件 |
| --- | --- | --- | --- | --- | --- |
| 1 | `chat-top-header`（`index.html:221-257`，`composer.css:1393-1559`） | 38px sticky 渐隐覆盖层；左：项目/会话/子 Agent 面包屑；右：更多、分享 **固定 28px 钮**；不随右坞开合显隐、不半透明 | 新对话叶 chrome（建议替换 `UnitChromeActions` 在 chat 叶上的职责），挂点 `TreeLeafPanel.tsx:193-198`；面包屑数据：`sessionTitle.ts` / 项目 store / 子 Agent 计数；更多菜单对齐 `ChatHeaderMore.tsx` + 参考 `topMoreMenu`（置顶 / 移到项目 / 删除） | 与 `UnitChromeActions` 整簇抢同一视觉位；与 survey/15「quiet 簇」对打（本锁胜）；`ChatHeaderMore` 现挂在工具簇里要挪到 header 右；子 Agent 胶囊可在插件 ON 时用 `SubagentBlock` 数据丰富，关插件也要能显示计数 | **默认壳**（chat 叶）。插件只给第三段面包屑加活点/人数 |
| 1b | `top-side-panel-btn`（`popovers.js:1610-1632`，`composer.css:1817-1844`） | 叶右上 28px 坞开关，**开合都不卸载**，仅 `.active` 换底 | `UnitChromeActions.tsx:217-241` 现 `rightDockCollapsed &&` 才渲染；应改为恒渲染 | 与右坞 `LeafToolTabStrip` 收起钮职责重叠——chat 叶用这一枚，工具叶仍用自己的 strip；不要两枚叠在同一角 | **默认壳** |
| 1c | 右坞内工具导航（`side-panel-nav-group`，`popovers.js:1578-1587`） | 「总览 / 文件 / …」属于**坞头**，不属于对话顶行 | `UNIT_TOOL_PANELS`（`UnitChromeActions.tsx:35-65`）+ 工具叶 `LeafToolTabStrip.tsx` | 现把坞内工具按钮画在对话叶 chrome 上；搬完对话顶行后这些钮进坞头，禁止继续躺在空画布 | **默认壳**（坞 / 工具叶） |
| 2 | `_toolbarActions` + `_leafToolHeader` 整行 | **取消** chat 叶这条 100% 宽工具行与 quiet 叠层；改成 1 的覆盖层 | `UnitChromeActions.module.css:1-29`；`BinaryTreeWorkspace.module.css:88-109`；`TreeLeafPanel.tsx:195-197` `className={styles.leafToolHeader}` | 测试锁：`UnitChromeActions.scoped.test.tsx`「空画布静默」、`BinaryTreeWorkspace.leaf-insulate.test.ts` quiet CSS、`TreeLeafPanel.routing.test.tsx` `data-canvas-quiet=true`、`unitChrome-open-note.source.test.ts` chat 叶仍挂 UnitChromeActions。实现时改测试跟效果，不留 quiet 当验收 | **默认壳**（删错行，不是插件） |
| 3 | `composer-wrapper` 整棵 | 见 §5 子表：权限条、计划条、单卡片、附件在上、单行网格、发送圆、拖放遮罩、与 stream 左右 0.05px 对齐 | `ChatComposer.tsx` / `ChatComposer.module.css` / `ChatComposerWrapper.tsx` / `ChatCard.module.css` `.chatFooter` `.chatCol` / `TiptapComposerField.tsx` / `ComposerAttachmentBar.tsx` / `ComposerFusedTrigger.tsx` / `PermissionModeMenu.tsx` / `ComposerDropHost.tsx` / `ComposerInlineTag.tsx` | 与现「输入盒 + 悬挂底栏」盒模型对打；与 `ChatStatusRibbons` / `PlanGoalRibbons` / `ApprovalDock` 叠床；`--chat-col-max: 760` vs 参考 720；空态焦点 5% 混色（RL-01）须保留；发送/停止 L2/L3 不能丢 | **默认壳**。插件只填上沿槽 |
| 3a | `#permissionBarHost` / `.flow-permission-bar` | 上沿冷静两行条：摘要+风险+还有 N；命令行；允许/拒绝。宽 `calc(100% - 36px)`、`margin-left: 18px`，叠在计划条之上 | 现：插件 `PermissionBar.tsx` + `permissionBar.module.css`（仅 composerAbove 槽）；关插件走 `ApprovalDock`（滚动定位，不是审批条） | **禁止**搬 `PermissionBar.js:71-148` 的 `slot-timer` / 300s 老虎机（插件 `narrative.source.test.ts:76-81` 已锁）。关插件时默认壳也要能挂同一结构（槽 fallback 不再是 `null` 就消失） | **默认壳结构 + 槽内容**。`workspace.chat.composerAbove` 关插件也要有壳层实现；插件 ON 替换为同一视觉的 enrichment（风险文案等），不是另一套皮 |
| 3b | `.plan-progress-bar` | 输入卡片上沿嵌入式 Hub：折叠单行（模式徽章、2/5、滚轮当前步、时长、编辑/暂停/停止）；展开步骤抽屉；`margin-bottom: -10px` 插入 composer 上沿 | 现：`PlanGoalRibbons.tsx` slim 条；流内 `PlanRoot.tsx` 一行「任务已启动」；`DynamicChipBar` / `PlanDrawer` | S8 禁插件目录出现 `plan-progress-bar` 等类名、禁演示五步文案（`host.plan.test.tsx` `DEMO_SNIPS`）。**类名与皮进壳层 CSS**，数据走 `sessionProgressApi` / `permissionMode`，无步骤则不 `active`。计划模式**不**自动 `activateConversationFlow` | **默认壳**。插件 ON 可把真实步骤投影进同一 Hub，关插件 Hub 仍可用权限「计划」+ session progress |
| 3c | `.composer-container` + `.input-main-layout` | 单卡片 14/22px 圆角；无文件时单行胶囊；有换行/溢出/附件切多行网格；加号圆 32px；权限默认 **icon-only 盾**；融合模型\|思考；语音圆；发送圆空时 width:0，有内容弹到 32px | `ChatComposer.tsx:335-447` 现序：队列 → 输入（内含发送）→ 附件 → 悬挂 footer（+ / 权限丸 / 撤回 \| 融合）；`TiptapComposerField.tsx:350-445` 发送在输入行右侧 `CornerDownLeft` + `variant=primary` | survey/12 已记底栏叠开/四击，本文件不重复开合，但结构移植后触发器位置变了，互斥组仍要接到新 DOM。撤回是产品多出来的能力，**保留**，放进 `action-left` 或更多菜单，不因为参考没有就删。语音钮参考有、产品无——要做入口，不能砍 | **默认壳** |
| 3d | `.file-zone` / `.file-card` / `.rich-inline-tag` | 附件横滑卡在**输入上方**；类型图标；中键删除；行内 chip 可点预览 | `ComposerAttachmentBar.tsx` 现挂在输入**下方**；`ComposerInlineTag.tsx` 已有 mention chip；`css/file-cards.css` 参考皮 | 预览走现 `openFileInPanel`，不搬 `preview-modal` 假壳。图标可继续 Lucide，不要 innerHTML 参考 SVG 字典 | **默认壳** |
| 4 | `.flow-scrubber-wrapper` | 贴 chat 叶滚动条左侧的无轨刻度；滚轮穿透；hover 拉开 gap；active 加长；左侧自定义 tooltip（禁原生 `title`） | **产品零实现**。滚动容器：`ChatCard` `.chatDocFlow` / 消息虚拟列表。参考 `FlowScrubber.js` + `css/flow/scrubber.css` | 旧插件调研写「不要做 scrubber」——**本锁盖过**。禁 `FlowTimelineRail`。虚拟列表必须按块高度映射（`DESIGN_SYSTEM.md:36-40`），不要抄参考 JS 的等高校。右坞打开时 `right` 要跟叶滚动条走，不能 `position:fixed` 对 `100vw`（参考 `has-side-panel` 那套 50% 计算在 BinaryTree 里会漂） | **默认壳**（chat 叶）。插件 ON 可把 tick 标题换成 purpose / 时间，关插件用用户气泡 snippet |
| 5 | 拖拽全集（见 §7） | 单行容量引擎、DnD 计数遮罩、侧栏/坞/sash 绿线、Tab 分屏指示、中键删卡 | `composer-core.js` / `popovers.js` DragController；产品：`ComposerDropHost.tsx`、`useTreeResize.ts`、`TreeResizeSash.tsx`、`SessionTabDragContext.tsx`、`useTreeDrag.ts`、`DropZoneOverlay`、侧栏宽 | 产品已有骨架。缺参考常量与绿线皮。composer **无**高度手柄——不要发明一条。Tab 拖 4px 阈值两边已对齐 | **默认壳**（布局引擎）。scrubber 不是拖动条 |
| 6 | `_topBar` / `.app-top-bar` / `.workspace-top-bar` + `.tree-pane-header` | 36px 密度；26px 会话胶囊；加号 26px 紧贴末 Tab；会话名在胶囊里（真名）；条背景跟画布而不是 `--bg-secondary` 加底边。窗控保持产品 `WindowControls` | `AppTopBar.tsx` + `AppTopBar.module.css`；`GlobalSessionTabBar.tsx` + `.module.css`；标题权威 `sessionTitle.ts`（survey/15） | 不要把会话 Tab 再复制进每个 leaf header（`BinaryTreeWorkspace.tsx:9` 已定「叶内不再第三套标题行」）——全局条留在 `AppTopBar`，**会话名同时出现在 chat-top-header 面包屑**。不要搬假窗控。`AppTopBar.module.css:77-100` `.addBtn` 未使用，加号已在 TabStrip trailing | **默认壳** |

---

## 3. `chat-top-header`：主对话快捷功能行

### 3.1 参考结构（要搬）

`index.html:221-257`：

- 整条 `position: sticky; top: 0; height: 38px; margin-bottom: -38px`（`composer.css:1393-1419`）——**不占文档流高度**，盖在 stream 顶部。
- `pointer-events: none`，只有 `.chat-top-left` / `.chat-top-actions` 恢复 `auto`。
- 背景是向下溶进画布的线性渐隐，不是 `--card-header-bg` 通栏。
- 左：`.top-breadcrumbs` 三级——项目（次要色、max 110px）`/` 会话（主色、max 140px）`/` 子 Agent 按钮（5px 绿点 + 「N 个运行中」+ chevron）。
- 右：`.chat-top-actions` `height: 28px; gap: 4px; margin-right: 36px`。每钮 `.top-action-btn` 28×28、圆角 6px、透明底。`#topMoreBtn` 三点、`#topShareBtn` 链接。

更多菜单（`index.html:843-863`）：置顶、移动到项目（级联）、删除聊天。产品 `ChatHeaderMore.tsx:27-58` 已有置顶 / 导出 Markdown / 清空记录——**缺「移动到项目」**；删除 vs 清空不是同一动作。分享钮参考只把图标染品牌绿 1.2s（`popovers.js:1033-1040`），产品无分享入口。移植时按钮位置与常驻是锁；动作接真能力（复制会话链接 / 导出），禁止只做变色空钮，也禁止因为「还没有分享协议」把钮拿掉。

### 3.2 现产品为什么不对

`TreeLeafPanel.tsx:193-198` chat 叶挂 `UnitChromeActions` + `className={styles.leafToolHeader}`。

`UnitChromeActions.tsx:169-242`：

- 工具组：总览 / 文件 / 差异 / 终端 / 笔记 + `ChatHeaderMore`。
- **仅当** `rightDockCollapsed` 才追加分割线 + 「展开右侧工具栏」。坞一开，这枚钮从 DOM 消失。
- `data-canvas-quiet={canvasQuiet}`：无会话 / 草稿 / 零消息为 true（`unitChromeLabel.ts:82-90`）。

`UnitChromeActions.module.css:8-28` quiet 态：`opacity: 0.28`，`pointer-events: none` 后再给内部组 `auto`，hover 才 1。`BinaryTreeWorkspace.module.css:100-109` 再绝对定位到右上。

用户锁原文：**右侧按钮应是固定按钮，无论右侧面板是否展开。** 对应参考的 `.chat-top-actions` + `.top-side-panel-btn`，不是 quiet 簇，也不是「坞开了就把开关卸掉」。

有消息时 `.leafToolHeader`（`BinaryTreeWorkspace.module.css:88-98`）`width:100%; justify-content:flex-end; flex:0 0 auto`——这是叶 flex 的**第一行**，会占掉一块垂直空间。参考用负 margin 覆盖，stream 从顶画到 composer，header 只是蒙层。这就是「整行样式有问题」。

survey/15:215 曾写 leafToolHeader「没有 `justify-content: flex-end`」——**已过时**。现码有 flex-end，测试 `BinaryTreeWorkspace.leaf-insulate.test.ts` 还钉死它。问题从「左贴」变成「右贴但仍是通栏行 / 半隐叠层」，本锁要的是覆盖层固定钮。

### 3.3 坞开关的参考位置

`composer.css:1817-1824`：`.tree-leaf-pane > .top-side-panel-btn` `position:absolute; top:41px; right:10px; z-index:110`。41px = 叶顶 Tab 条 36px + 5px，所以它落在 **chat-top-header 行的右端**，不是工具簇里可卸载的最后一枚。

产品没有 per-leaf `tree-pane-header`（会话 Tab 在窗口顶栏），因此这枚钮应进 `chat-top-header` 的 `.chat-top-actions` 最右，恒在。`margin-right: 36px` 在参考里是给假窗控留空；产品窗控在 `AppTopBar` trail，**不要**为假窗控留 36px，只为滚动条 / scrubber / 本钮自己留 gap。

### 3.4 面包屑数据（默认壳就能挂）

| 段 | 参考演示字 | 产品真源 | 空态 |
| --- | --- | --- | --- |
| 项目 | `conex-core` | `resolveUnitChromeLabel` 已写项目名（`unitChromeLabel.ts:17-56`）但**没挂到现 chrome** | 无项目显示「对话」或空，不发明假项目 |
| 会话 | `重构 IPC 缓冲通道` | `sessionListDisplayTitle` / `EMPTY_SESSION_TITLE = '新会话'` | 「新会话」，禁止「未命名会话」（survey/15） |
| 子 Agent | `2 个运行中` | 会话 agents / 后台任务计数（`ChatStatusRibbons` 已有 background task 轮询） | 0 个则第三段不渲染或灰态，不写死 2 |

插件 ON：第三段可展开 `agentRuntimePopover` 同类面板（`index.html:876+`），用现 `InlineAgentPanel` / 子 Agent 列表，不搬演示 4 个假 Agent。

---

## 4. `_toolbarActions` + `_leafToolHeader` 整行

哈希对应：

- `_toolbarActions_10cfr_1` → `UnitChromeActions.module.css` `.toolbarActions`
- `_leafToolHeader_1hohd_175` → `BinaryTreeWorkspace.module.css` `.leafToolHeader`

同一 DOM：`className={`${styles.toolbarActions}${className ? ` ${className}` : ''}`}`（`UnitChromeActions.tsx:171`）且父传入 `styles.leafToolHeader`。

问题（同权，都要解）：

1. **职责错位。** 对话快捷行被做成「打开 X 工具」广告条。参考里打开文件/代码在右坞 header，不在对话顶。
2. **有消息时占行。** 100% 宽 flex 兄弟，把欢迎面 / 消息列表顶下去一块，和 sticky 负 margin 覆盖相反。
3. **空消息半隐。** `data-canvas-quiet` + opacity 0.28 + 绝对定位。用户要固定钮。
4. **坞开卸载开关。** `rightDockCollapsed &&`（`UnitChromeActions.tsx:217`）。
5. **Tooltip 仍能在空画布落字。** survey/15 的「打开文件」胶囊；`UNIT_CHROME_TOOL_TIP_SIDE = 'left'` 只是减灾。顶行改固定 icon-only 后 Tip 仍走战役 I2 单例，不能靠 quiet 藏。
6. **`ChatHeaderMore` 被困在工具簇。** 更多属于对话顶行右侧，不是文件/终端旁边的第六枚。
7. **测试把 quiet 当成正确。** 实现波必须改测试跟新效果，不能为保绿留下 quiet。

工具叶 `LeafToolTabStrip` **不是**本条对象。本条只改 chat 叶。工具叶多 tab 时的 strip 仍是坞/工具叶 chrome。

---

## 5. `composer-wrapper` 全面移植

### 5.1 参考盒树（`index.html:267-418`，`composer.css:574-990`）

```
.composer-wrapper          sticky bottom; max-width:720; padding-bottom:16px; flex column; gap:0
  .composer-float-zone     row-gap:6px；:empty { display:none }
    #permissionBarHost.flow-permission-host
    .plan-progress-bar     无 active 则 display:none；active 时 width calc(100%-36px)、ml 18px、mb -10px 插入卡片
  .composer-container      单卡片；无 .is-multiline 时圆角 22px 胶囊
    .file-zone             空则隐藏；有卡则多行 gap 6px
    .input-main-layout     grid
      单行:  left-ctrl | text | perm | actions
      多行:  text 占满；下一行 left-ctrl | perm | . | actions
    .drag-drop-overlay
```

`composer-core.js:50-108` 切行引擎（用户调过的高度逻辑）：

- 发送圆：有文本 / 文件 / 行内 tag 才 `.active`（width 0→32、opacity、scale 弹簧）。
- 单行容量：`layoutW - (leftW + permW + rightW + 18)`，与 `measureTextWidth(cleanText)` 比；显式 `\n` 或有文件也切多行。
- 删除到能单行时**立刻**去掉 `.is-multiline`（注释写「100% 对称」）。
- 输入 `max-height: 220px`（约 10 行）后内部滚动（`composer.css:650-668`）。
- **没有**拖拽改 composer 高度的 handle。

对齐门：`ci-scroll-twitch-detector.js:523-552` 要求 wrapper 与 `.chat-stream-inner` 左右差 `< 0.05px`。`syncComposerHorizontalAlignment` 在 `composer-core.js:331` 已是空操作——对齐靠 sticky + 同一 max-width，不是 JS 补像素。

### 5.2 现产品盒树

`ChatComposer.tsx:335-447`：

```
ComposerDropHost.composerWrapper
  ChatQueuePanel
  TiptapComposerField.container     ← 输入 + 右侧发送/停止（盒内）
  ComposerAttachmentBar             ← 输入下方
  hidden file input
  .footerActions                    ← 更窄悬挂条：+ / PermissionModeMenu / 撤回 | ComposerFusedTrigger
```

`ChatComposerWrapper.tsx:100-126`：footer 里先 `ChatStatusRibbons`，再 `SlotOutlet composerAbove`（默认 `fallback={null}`），再 composer。关插件 = 上沿没有权限条，审批走 `ApprovalDock`（`ApprovalDock.tsx:1-8` 是「滚动去找卡」，不是冷静条）。

`ChatCard.module.css:41-60`：`.chatCol` max 760（宽屏 840）+ 左右 20px；`.chatFooter` `padding: 10px 0 6px` + `--chat-footer-fade` 渐隐。参考 wrapper `max-width: 720`、底 16px、卡片与 stream 同宽。

`ChatComposer.module.css:1-26` 输入容器默认 `min-height: 2 行`、圆角 20px、padding 10px 14px——**永远多行盒**，没有单行胶囊态。`.footerActions:394-408` 另做 `width: calc(100% - 32px)` 悬挂小矩形，和参考「控件在同一张卡片的 grid 里」相反。

发送：`TiptapComposerField.tsx:429-441` `variant=primary` + `CornerDownLeft`，空内容时 `sendCircle` 仍占位（CSS `:not(:disabled)` 给满尺寸，`ChatComposer.module.css:270-277`）。参考空内容 width:0、不占位。图标是上箭头（`index.html:406-408` polyline 向上），不是回车折角。

权限：参考默认 `.pure-mode-text-btn.icon-only` 盾 28px 圆（`index.html:392-395`，文字 span 被 CSS 藏掉）；产品是文字药丸「需确认 / …」（survey/12）。颜色变体 class `perm-full` 等在参考 `composer.css:844-848`。

融合触发：参考 `.fused-model-thinking-btn` 一行「Claude 3.7 Sonnet | High」（演示名不搬）。产品 `ComposerFusedTrigger.tsx` 已是左模型右思考，禁止写死 Claude 3.7——**结构可留，皮要跟参考胶囊密度（高 28、无 chevron 也成立）**。现思考钮带 `ChevronDown`。

加号：参考 `.icon-btn-plus` 32 圆、实心 `--bg-surface`。产品 `Button ghost sm` 继承点击 scale（战役 I1 另收）。位置：参考在卡片内左；产品在悬挂条左。

语音：参考 `.action-circle-btn` 波形图标。产品 composer **零语音入口**。锁效果：要有这一枚圆钮（接现有或新的语音输入），不能因「还没接引擎」删掉。

撤回：参考无。产品有 `onRetract`。保留能力，放进 `action-left`（加号旁）或更多菜单，不占发送圆的位置。

### 5.3 权限条

参考 CSS `css/flow/permission-bar.css`：两行、暖色 4.5% mix 底、12px 圆角、宽与计划条同公式（`calc(100% - 36px)` + `margin-left: 18px`），和 composer 卡片形成「上沿略缩进、下沿插入」的叠层。

参考 JS `PermissionBar.js` 另有 5 分钟 per-digit slot machine——**明确不搬**（用户旧锁 + `narrative.source.test.ts:76-81`）。产品 `PermissionBar.tsx` 已是冷静版（首条 + 还有 N + 双确认），缺的是：

- 关插件时 `composerAbove` fallback 为 null，条消失，退回 `ApprovalDock`；
- 视觉未对齐参考的缩进叠层与两行网格；
- 风险徽章（低/中/高）参考有、产品无。

移植：壳层 `composer-float-zone` 永远在；无 pending 则 host `:empty { display:none }`。插件 ON 替换内容，不换槽位。

### 5.4 计划条

参考 `css/flow/plan.css:146-169` `.plan-progress-bar.active` 才显示。折叠行 `.plan-collapsed` 高 44px（含 8px 底垫补偿 -10px dock）。展开用 CSS grid `0fr`→`1fr`，不是 JS 测高。

交互 `composer-core.js:260-321`：展开/暂停图标切换/时长 tick。步骤点击被用户关掉（注释「Action Removed」）——移植时步骤点击是否滚动到对应消息要产品自己接，**不要**把演示「点了没反应」当规范。

现 `PlanGoalRibbons` 是独立 slim 条 + 批准勾，不嵌入 composer 上沿，也没有 2/5 滚轮、时长、暂停/停止。流内 `PlanRoot` 是「任务已启动 · title」一行，测试明确 `querySelector('.plan-progress-bar')` 必须为 null——那是**流内**禁 Hub，不是禁 composer 上沿。

数据：`resolveSessionProgressItems` / `computeChecklistProgress`（`ChatStatusRibbons.tsx` 已 import）是真源。无步骤：条不 `active`。演示五步文案（`摸清 crates/session-loop` 等）禁止入库。

暂停/停止：产品已有 L2 cooperative_stop / L3 force_cancel（`TiptapComposerField`）。计划条右侧停止应走同一引擎路径，不要第二套。

### 5.5 附件与行内 tag

参考附件在卡片**顶部**，空 `file-zone` `display:none`，有文件是切多行的条件之一。产品附件在输入下、悬挂条之上，单行胶囊永远不会出现。

中键删除：`composer-core.js:237-255`。产品未做。要搬。

行内 chip：参考 `.rich-inline-tag` 可点 `locateOrPreviewFile`。产品 `ComposerInlineTag.tsx` 已走 `openFileInPanel`。皮（高度 22、icon box）应对齐 `file-cards.css` / 参考 chip，不换预览架构。

拖放：参考计数器 + 全卡片 overlay「松开鼠标，添加文件到对话」。产品 `ComposerDropHost` 已有深度计数 +「放到这里添加附件」。文案与 inset 虚线 vs 参考实卡遮罩是皮差，逻辑可复用。

---

## 6. `flow-scrubber-wrapper`

### 6.1 参考行为

`css/flow/scrubber.css`：

- wrapper `position:fixed; top:0; bottom:0; right:14px; width:20px; z-index:50; pointer-events:none`。14px = 12px 滚动条 + 2px 缝，**零重叠**。
- 右坞开：`right: calc(50% + 14px)`；侧栏+右坞：`calc((100vw - 240px) / 2 + 14px)`。这套 vw 公式在产品 BinaryTree（叶宽不是 50%、侧栏不是 240）**不能原样搬**，否则刻度会钉在窗口上而不是叶滚动条上。
- 刻度默认 8×2px、`--text-tertiary`；`.is-active` 宽 16；scrubber hover 宽 16、active 24；直 hover 32。gap 8→12。
- `::before` hitbox：上下 -8px、左 -20px、**right:0 严禁侵入滚动条**。
- wrapper `wheel` 把 delta 转给 scroller（`FlowScrubber.js:54-60`），无刻度空白区不拦截滚轮。

`FlowScrubber.js`：找 `.flow-msg--user, .chat-message.user`；`IntersectionObserver` 切 `is-active`；click `scrollIntoView({behavior:'smooth', block:'center'})`；tooltip 用 `getBoundingClientRect` 贴 tick。时间字段读 `window.DemoData`——**不搬**。

**不是拖动 scrub。** 没有 pointer 拖轨迹。用户说的 drag 在分栏/Tab，不在这条。

### 6.2 规范 vs 参考 JS 的缺口（移植要补满，不许用等高校凑）

`DESIGN_SYSTEM.md:36-40`：无轨；刻度高度按真实消息块 `heightPercent` 映射。现 `FlowScrubber.js` 用 flex column + 等高校 + gap，**没做高度映射**。产品有消息虚拟列表，必须按块高度通知（旧规格说的 VSM 高度契约）做完整 minimap，不能把演示等高校当完成。

### 6.3 挂在哪、何时出现

- **默认壳。** 线性 `ChatMessageList` 也有用户消息。关插件没有刻度 = 效果被砍。
- 插件 ON：tick 可用 purpose 标题 / 投影时间，selector 兼容叙事节点，但 **DOM 仍挂在 chat 叶滚动条旁**，不进插件包当第二套。
- 空会话：无用户气泡则 wrapper `:empty` / 不渲染刻度，不要留一条空柱。
- 定位：`position:absolute` 相对 **chat 叶 scroller**（或 sticky 在叶内），跟叶宽、右坞 sash、BinaryTree 分屏走。禁止 `fixed` + `100vw`。
- Tooltip：自定义组件，战役 I2 单例；参考自绘 `flow-scrubber__tooltip` 可当视觉，但要进产品 Tooltip 门户，禁止再发明一套残影。

与 `FlowTimelineRail`：那是流内竖轨，S8 / SPEC 仍禁。scrubber 是滚动条旁刻度，不是轨。

---

## 7. 拖拽逻辑（参考 JS 里真正调过的常量）

没有 composer 高度拖动手柄。高度 = 单行容量引擎 + `max-height: 220px`。下面每条都要进产品，不能「先用原生 resize」。

### 7.1 单行 ↔ 多行（composer「高度」）

| 常量 / 规则 | 参考 | 产品现状 |
| --- | --- | --- |
| 单行高度 | 输入 24px line-height，容器胶囊 22px 圆角 | 最少 2 行（`--composer-min-lines: 2`） |
| 切多行条件 | 显式换行 **或** 无文件时文本宽 ≥ `layoutW-(left+perm+right+18)` **或** 有附件 | 无切行，永远多行盒 |
| 切回单行 | 对称、删到能放下立刻回 | 无 |
| 封顶 | 220px 后内部滚 | `--composer-max-lines: 10` + `field-sizing: content` |
| 发送占位 | 空：width 0；有内容弹簧到 32 | 空也占 `--control-height` |

文件域：`composer-core.js:50-108` → `ChatComposer` + `TiptapComposerField` + `ChatComposer.module.css`。依赖：附件上移之后「有文件 ⇒ 多行」才成立。

### 7.2 文件拖入

参考：`dragCounter` 防 flicker；overlay `display:flex/none`（`popovers.js:605-639`）。产品 `ComposerDropHost.tsx:27-69` 已是深度计数。差：遮罩视觉、文案、是否盖住 float-zone（权限/计划条）。要盖整张 `composer-wrapper`（含上沿条），不要只盖输入盒。

### 7.3 侧栏宽

参考：`mousedown` 计 `startWidth`；`<120` 折叠；展开钳 `[160, 480]`；双击重置 240；拖时 `is-dragging` 出 2px 品牌绿（`popovers.js:1805-1866`，`composer.css:1562-1598`）。产品侧栏默认 260（`layout.ts:2`）。手感（6px 命中、绿线、双击重置、拖过阈值折叠）要齐，宽度区间可沿产品 token，不要把演示 240 当唯一真值。

### 7.4 右坞宽

参考：`deltaX = startX - clientX`（从右往左加宽）；钳 `[200, leafWidth*0.7]`；CSS 变量 `--panel-width`；绿线（`popovers.js:1636-1667`）。产品坞宽走 BinaryTree 叶分割 `splitRatio`。要把「绿线 + 双击 0.5 + 拖时禁用过渡」接到 `TreeResizeSash` / 坞 sash，不能只改 store。

### 7.5 二叉树 sash

参考：`pointerdown` + `setPointerCapture`；水平/垂直；ratio 钳 **`[0.12, 0.88]`**；双击 0.5；6px 条、1px 线、hover/active 2px 品牌绿（`popovers.js:1713-1761`，`composer.css:1714-1771`）。产品 `clampSplitRatio` 是 **`[0.1, 0.9]`**（`layout-tree/types.ts:98-105`）；`useTreeResize.ts` 已 live CSS、up 才 commit、Esc 取消——骨架对。缺：绿线皮、双击重置、钳值是否改成 0.12/0.88（参考手感；改钳是效果锁不是「约一下」）。

### 7.6 会话 Tab 拖到分屏

参考 `DragController`（`popovers.js:1214-1457`）：

- 阈值：`|dx|+|dy| < 4` 仍算点击（产品 `SessionTabDragContext.tsx:41` `DRAG_THRESHOLD_PX = 4`，用 hypot——接近，要统一是 L1 还是 L2）。
- 源 Tab `.is-dragging { opacity:0 }`，指示条 150×26 显示标题，条内其余 Tab `translateX(150+4)` 让位，transition `180ms cubic-bezier(.2,0,0,1)`。
- 插入指数：命中 Tab 内按 **dx 方向 1/3 滞后**（往右过左 1/3 才后插，往左过右 1/3 才前插）。
- 落到叶面：左右上下 **25% 边缘** 分 region，中间 center 合并；指示条 120ms 几何动画 + 品牌绿 18% 底（`.tree-drop-indicator`）。

产品：`SessionTabDragContext` 自绘 ghost pill（暗色 `#1e1e2e` 硬编码，和参考绿指示条不是同一语言）；`useTreeDrag` + `DropZoneOverlay` 做叶面分区。缺：条内让位动画、1/3 滞后、150px 占位宽、指示条与 Tab 同高 26px。这些都是「调了很久」的部分，要搬全。

### 7.7 中键删附件 / chip

`composer-core.js:237-255`。产品无。要搬，含 `file-card`、行内 tag、skill chip。

### 7.8 不要当成拖拽的东西

- scrubber：点击 + hover，不拖轨迹。
- markdown 编辑器块拖 / 表格框选：另一参考子系统，本战役对话壳不搬。
- `NotebookPanel` 拖：产物笔记，不是 composer。
- 参考 `WorkspaceSplitRenderer` 整树 innerHTML 重建 + clone `#chatMainPane`：产品已有真 BinaryTree，**禁止**把演示 renderer 当布局引擎搬进来。只搬手感常量。

---

## 8. `_topBar_59jbx_9 app-top-bar`

### 8.1 参考「顶部行」实际是两层

| 层 | 参考 | 搬什么 | 不搬什么 |
| --- | --- | --- | --- |
| 窗口浮层 | `.workspace-top-bar` 36px 透明、`pointer-events:none`，只 trail 放假 min/max/close（`composer.css:94-148`，`index.html:206-213`） | 密度 36px；trail 不占内容；关闭悬停红 `#e81123` 若产品窗控还没有 | 假窗控按钮本身；`console.log` 实现 |
| 会话行 | JS 插入的 `.tree-pane-header` 36px、页底色、底部分割 1px、26px Tab 固定宽 150（min 120 max 180）、加号 `.top-bar-new-tab-btn` 26px 紧跟末 Tab（`composer.css:1677-1700,169-191,298-318`） | 26px 胶囊密度；加号尺寸/位置；条背景跟画布；真会话名 | 每叶再做一条 Tab（与全局条重复）；演示标题 |

产品 `AppTopBar.tsx:101-176` 把两层合成一层占流 header：

- `.topBar`：`--header-height: 36px`、`background: var(--bg-secondary)`、`border-bottom: 0.5px solid var(--border-color)`（`AppTopBar.module.css:5-20`）。参考浮层无底、无 secondary 填色。
- rail 宽度跟侧栏走，还 `-16px` 负边距「消除视错觉」（`AppTopBar.tsx:114`）。
- 会话 Tab 在 `main`，加号在 `GlobalSessionTabBar` `slots.trailing`（`GlobalSessionTabBar.tsx:335-356`），**已经在末 Tab 旁**——位置对，密度：`.tabAdd` 用 `--global-tab-h: 26px`（`.module.css:335-343`）接近参考；图标是 `MessageSquarePlus` 16px，参考是简单 13px 十字。
- Tab：`flex: 1 1 0`、min 32 / max 180（`.module.css:21-22,133-134`）——参考是 **flex: 0 0 150** 固定胶囊，不会被挤成 32px 钉。多会话时产品名被挤没，这是「会话名位置」问题的一半；另一半是壳层写成「未命名会话」（survey/15，本维不重复展开，只声明顶栏必须消费 `sessionListDisplayTitle`）。
- `spacer` 弹性拖区；`addBtn` CSS 写了 24px 但 **JSX 未用**。
- trail：帮助（参考顶栏没有）+ 真 `WindowControls`。帮助可留，但不要因此把加号挤离 Tab。

### 8.2 会话名出现两次不是重复事故

参考：Tab 条上有名，`chat-top-header` 面包屑再有名。产品只应：

1. `AppTopBar` 胶囊 = 真名（修 survey/15 幽灵字）；
2. chat 叶面包屑第二段 = 同一真名。

不要在叶上再做第三套 Tab。`BinaryTreeWorkspace.tsx:6-9` 这条「叶内不再第三套标题行」仍然成立——搬的是面包屑，不是 `UnitSessionTabStrip` 复活。

### 8.3 加号

参考 `top-bar-new-tab-btn`：26×26、透明、无边、十字 SVG，click `store.addTab`。产品：`openNewDraftTab` + `emitUiEvent('open-chat')`（`GlobalSessionTabBar.tsx:237-244`）——**动作已经是草稿路径，对**。要齐的是视觉密度（简单十字 vs MessageSquarePlus）和「永远贴在最后一枚胶囊右边、不被 trail 挤掉」。

---

## 9. 问题清单（同权）

结构

- S1 chat 叶 chrome 是工具广告行，不是 `chat-top-header` 覆盖层。
- S2 `leafToolHeader` 有消息时占 flex 行，空消息时 quiet 叠层，两种都不是 sticky 负 margin。
- S3 右坞开关随 `collapsed` 卸载。
- S4 「打开 X」钮在对话顶行，应在坞头。
- S5 composer 是「大盒 + 悬挂底栏」两截，不是单卡片 grid。
- S6 附件在输入下，导致参考的单行胶囊态不可能出现。
- S7 发送在输入盒内，空状态仍占位；参考空则 width 0。
- S8 权限条/计划条不在 `composer-wrapper` 上沿叠层；关插件权限条消失。
- S9 计划是 slim ribbon + 流内一行，不是嵌入式 Hub。
- S10 无 scrubber。
- S11 `AppTopBar` 用 secondary 底 + 底边占流，会话胶囊被 flex 挤到 32px。
- S12 面包屑整级缺失（项目名函数写了没挂）。

连通

- C1 `ChatHeaderMore` 困在工具簇；缺「移动到项目」；分享无入口。
- C2 `composerAbove` fallback null：关插件不能挂权限条结构。
- C3 计划 Hub 若误放进 `extensions/conversation-flow/` 会撞 S8 源码锁。
- C4 计划停止/暂停未接到 L2/L3。
- C5 语音钮无接线。
- C6 scrubber 必须跟虚拟列表高度契约，不能 IO + 等高校交差。
- C7 scrubber `fixed`+vw 在 BinaryTree 分屏会漂，必须相对叶 scroller。
- C8 Tab 拖指示条 / 1/3 滞后 / 条内让位未接。
- C9 sash 绿线、双击 0.5、钳 0.12–0.88 未齐。
- C10 顶栏标题不走 `sessionListDisplayTitle`（survey/15）。
- C11 单行容量引擎不存在，参考切行条件无法发生。
- C12 中键删卡无。

契约 / 测试（实现时改测试跟效果，不留旧锁挡移植）

- T1 `UnitChromeActions.scoped.test.tsx` 钉 `data-canvas-quiet`。
- T2 `BinaryTreeWorkspace.leaf-insulate.test.ts` 钉 quiet 选择器 + leafToolHeader flex-end。
- T3 `TreeLeafPanel.routing.test.tsx` 期望 quiet=`true`。
- T4 `narrative.source.test.ts` S8 禁插件目录 Hub 类名 / 演示五步 / `FlowTimelineRail`。
- T5 `host.plan.test.tsx` 流内不得出现 `.plan-progress-bar`（上沿 Hub 不在这个断言范围，但类名不要出现在 host 流内）。
- T6 `activate.ts` 默认关必须保持；计划模式不得自动开插件。
- T7 权限条禁 `slot-timer` / `secondsLeft`。
- T8 `ci-scroll-twitch-detector` 0.05px 对齐要在产品有等价断言（stream 列 vs composer 列）。

体验 / 皮（每条都是完整效果，不是「有空再调」）

- V1 顶行 28px 固定钮、6px 圆角、渐隐遮罩。
- V2 权限默认盾形 icon-only，不是字丸（字丸开合问题见 survey/12，结构仍要换成参考网格位）。
- V3 发送绿圆弹簧，空隐实显；图标向上。
- V4 计划条 -10px dock + 44px 折叠行 + 滚轮步骤。
- V5 权限/计划条相对卡片缩进 18px。
- V6 加号 32 圆在卡片内，不是悬挂条 ghost。
- V7 语音圆钮。
- V8 单行胶囊 22px 圆角 vs 多行同半径（参考两者都 22）。
- V9 scrubber 刻度宽度阶梯 8/16/24/32、gap 8/12、tooltip 左浮。
- V10 分割条 1px→2px 品牌绿。
- V11 Tab 26×150 胶囊，加号 26 十字贴末 Tab。
- V12 `AppTopBar` 去 secondary 填色/底边或改成与画布一体，避免「灰条压着对话」。
- V13 拖放遮罩盖整 wrapper。
- V14 行内 chip / 文件卡入口动画（参考 `animate-entrance`），产品可保留克制弹簧但不要点击果冻（战役 I1）。
- V15 composer focus 边框混入 ≤ 约 10%，空态 ≤ 5%（已有 RL-01，移植网格时不得加绿光环；参考 `composer-container:focus-within` 明确去绿边）。

---

## 10. 推荐装配（仍是调研，不是实现）

在 BinaryTree + 叶槽约束下，一条不降效果的装配：

```
AppTopBar（默认壳）
  侧栏开关 | 真名胶囊 Tab + 26px 十字加号 | 拖区 | 帮助 + 真窗控
chat 叶
  ChatTopHeader（默认壳，覆盖层）
    面包屑（项目 / 会话 / 子 Agent） | 更多 | 分享 | 坞开关（恒在）
  stream（默认 ChatMessageList；插件 ON 换 ConversationFlowHost，仍线性）
  FlowScrubber（默认壳，绝对定位在叶 scroller 右内）
  composer-wrapper（默认壳）
    float-zone: PermissionHost（槽，关插件也有冷静条） → PlanHub（session progress）
    composer-container: file-zone → grid(加号, 输入, 盾, 融合, 语音, 发送圆)
工具叶 / 右坞头
  原 UNIT_TOOL_PANELS + LeafToolTabStrip
```

插件默认 OFF：header 第三段用壳层计数；stream 线性；composerAbove 用壳层 PermissionHost；PlanHub 用权限模式 + progress。插件 ON：同一挂点换 enrichment，不另起皮、不自动因计划模式开启。

---

## 11. 诚实边界

做了什么：读透参考 `index.html` 目标 class、相关 CSS/JS（含 `popovers.js` 拖拽与分屏、`composer-core.js` 切行、`FlowScrubber.js`、`PermissionBar.js`、`FlowMount.js` 插 host）、现产品顶栏/叶 chrome/composer/conversation-flow 装配与锁测试；对照旧战役「不要搬演示壳」与 survey/15 quiet 簇，按本锁改口。

没做：改产品源码；git；9222 真机复拍；打开参考 HTML 像素量测；实现；第二份文档。

不确定（实现前用 WebView2 钉）：

- 真机当前 `data-canvas-quiet` 是否仍 0.28（源码是）；survey/15 图是否仍是左贴（源码已 flex-end）。
- 分享的真动作（复制链接 vs 导出）产品协议未在本维读完。
- 虚拟列表高度通知是否已有现成 API 给 scrubber 用（旧规格提到，本维未把 VSM 源码逐行对完）。

额外发现：

- `AppTopBar.module.css` `.addBtn` 死代码。
- 参考 `composer.css:348-354` Tab close 规则重复、像编码修复残留。
- `PermissionBar.js` 老虎机与产品插件锁冲突——移植权限条只取 CSS 结构。
- `DESIGN_SYSTEM.md` scrubber 高度映射与 `FlowScrubber.js` 等高校不一致，产品要按规范补满。
- 旧 `docs/chat-composer-plugin/survey/*` 把 scrubber/计划底栏列为「不要做」——被本用户锁盖过，主控合并总案时不要再引用那些禁令砍本表。

对主控：本文件是本维唯一产出。实现切片建议按清单 # 拆（header 行、composer 盒树、上沿条、scrubber、拖拽常量、顶栏密度）但仍是**同权问题**，不要把 scrubber/语音/分享标成 P2 丢掉。冲突请示点只有：S8 类名放壳层是否同意；sash 钳 0.12–0.88 vs 现 0.1–0.9 取参考手感。
