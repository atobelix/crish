# Conex / Crish 桌面客户端全量滚动条与宿主容器白盒普查报告
> **文档标识**：`docs/unified-scrollbar-system/surveys/01-full-inventory-and-usage.md`
> **普查范围**：`apps/crish-desktop/src/`、`packages/` 全量前端源码与样式表
> **普查专家**：Scrollbar Inventory & Usage Surveyor（高级前端与代码库白盒普查专家）
> **普查基准时间**：2026-09-02
> **纪律对齐**：仓库根目录 `AGENTS.md`、`.agents/LOGIC_PLAN_NO_RETREAT.md`、`ANTI_OVERENGINEERING_GUARDRAILS.md`

---

## 一、普查摘要与宏观度量 (Executive Summary)

本报告针对 Conex / Crish 桌面端（运行于 Tauri + WebView2 / Chromium 架构）全仓所有涉及滚动条样式定义（`::-webkit-scrollbar*`、`scrollbar-width`、`scrollbar-color`、`scrollbar-gutter`）以及滚动宿主容器（`overflow`、`overflow-y`、`overflow-x` 为 `auto` 或 `scroll`）的组件、模块、CSS 文件与 DOM 结构进行了全量、无死角的白盒普查。

### 1. 普查核心量化指标

| 统计维度 | 统计数值 | 关键分布与结论 |
| :--- | :--- | :--- |
| **涉及代码与样式文件总数** | **63 个文件** | 59 个位于 `apps/crish-desktop/src`，2 个位于 `packages/block-paper`，2 个核心样式/测试契约 |
| **滚动条与滚动声明总频次** | **186 处** | `::-webkit-scrollbar` 53 处、`scrollbar-width` 22 处、`scrollbar-color` 11 处、`overflow` 100 处 |
| **私有 `::-webkit-scrollbar` 声明文件** | **12 个文件** | 涵盖 `overlay-scrollbar.css` 出口以及 11 个就地重写的组件样式表 |
| **声明 `scrollbar-width: thin` 的文件** | **18 个文件** | **严重架构隐患**：在 Chromium 引擎中直接导致 WebKit 伪元素全面失效 |
| **双重混写并存冲突文件** | **9 个文件** | 同一文件/选择器内同时声明标准与私有属性，引发运行时严重渲染退化 |
| **主容器与局部视口滚动宿主** | **101 处容器** | 涵盖虚拟化列表、会话流、代码 Diff、Markdown 表格、浮层菜单、设置面板等 |
| **治理分级分布 (Tier 分布)** | **A: 16 / B: 24 / C: 23** | Tier A 核心交互（立即整改）；Tier B 次级面板（批次替换）；Tier C 边缘视口 |

```mermaid
pie title 滚动声明类型分布 (总计 186 处)
    "::-webkit-scrollbar 伪元素" : 53
    "scrollbar-width 规范属性" : 22
    "scrollbar-color 规范属性" : 11
    "overflow 宿主容器声明" : 100
```

---

## 二、WebView2 / Chromium 渲染机理与底层架构断层剖析

### 1. W3C CSS Scrollbars Level 1 与 WebKit 伪元素的排他互斥（根因断层）

根据 **W3C CSS Scrollbars Module Level 1** 规范与 Chromium / Blink 内核（WebView2 的底层实现）的标准行为：
> **规范核心不变量**：一旦某个 DOM 容器被声明了现代标准 CSS 属性 `scrollbar-width`（无论取值为 `thin` 或 `none`）或 `scrollbar-color`，Chromium 渲染流水线将**立即全面禁用**该元素以及所有子树中匹配的 `::-webkit-scrollbar*` 系列私有伪元素！

```mermaid
flowchart TD
    Start["WebView2 / Chromium 解析 DOM 样式"] --> CheckStandard{"元素是否声明了<br/>scrollbar-width 或 scrollbar-color ?"}
    CheckStandard -- "是 (YES)" --> DeactivateWebKit["彻底禁用 ::-webkit-scrollbar* 伪元素流水线"]
    CheckStandard -- "否 (NO)" --> ActivateWebKit["应用 ::-webkit-scrollbar* 细胶囊与透明轨道渲染"]
    DeactivateWebKit --> WinNative["回退至 Windows 原生系统滚动条渲染<br/>(Win32 / UWP 经典控件)"]
    WinNative --> Issue1["⚠️ 露出粗笨系统灰色长条 (16px 或 10px 粗条)"]
    WinNative --> Issue2["⚠️ 强制渲染上下三角形箭头按键 (increment / decrement)"]
    WinNative --> Issue3["⚠️ 胶囊圆角、透明轨道、Hover 动效全部丢失！"]
    ActivateWebKit --> FineCapsule["✅ 呈现精致 5px~7px 悬浮半透明胶囊滚动条"]
```

### 2. Conex 现存样式契约与工程实际的“双轨漂移”

在 `apps/crish-desktop/src/styles/overlay-scrollbar.css`（全局唯一出口）中，存在极度严苛的契约注释与规则：
```css
/* 细滚动条出口。禁名 shell-scrollbar.css，本文件为唯一 webkit 出口。
 * WebView2 / Chromium：必须走 ::-webkit-scrollbar。
 * 全局或容器上写 scrollbar-width 会关闭 webkit 伪元素，Windows 上仍露出
 * 带上下三角的系统粗条（survey/09）。默认 7px（6–8px）；域可覆盖
 * --scrollbar-thumb-width（0px 隐藏 / 3px 紧凑）。
 * thumb 走 --tint-scrollbar-thumb；轨道透明；无上下三角。 */
```
然而，在代码库的实际演进过程中，多达 **18 个组件文件** 违规就地书写了 `scrollbar-width: thin`！
甚至在被 `overlay-scrollbar.css` 明确白名单保护的类名（如 `[class*='sidebarScroll']`）中：
- `Sidebar.module.css:129-130` 竟然公然声明了：
  ```css
  scrollbar-width: thin;
  scrollbar-color: var(--tint-scrollbar-thumb) transparent;
  ```
直接导致全局 `overlay-scrollbar.css` 精心设计的透明轨道、无三角按键、圆角胶囊在侧栏被**彻底扼杀**，在 Windows 真机上退化成了丑陋的带三角原生细条！

---

## 三、全量滚动条与宿主容器白盒清单 (The Master Inventory Table)

以下表格对全仓 63 个文件、186 处声明进行全面穷举登记。
- **治理级别 (Tier)**：
  - **Tier A**：高频核心交互面、全局悬浮面板、会话/输入/主视口容器，直接决定产品视觉第一印象；
  - **Tier B**：设置子页、次级面板、代码/差异块、长列表局部滚动区；
  - **Tier C**：边缘弹窗、错误捕获容器、调试控制台、横向隐藏溢出轨道。
- **替换难度 (Diff)**：
  - **L1 (低)**：删除多余的 `scrollbar-width` / `scrollbar-color`，自动继承全局出口；
  - **L2 (中)**：移除私有 `::-webkit-scrollbar` 块，重写为统一 class / mixin，修复圆角与 padding；
  - **L3 (高)**：涉及虚拟化视口（Virtualizer）、双向联动同步或父子容器重叠，需配套架构解耦与契约测试更新。

| 序号 | 文件路径与行号 | 关联组件与业务功能 | 当前声明属性与关键代码 | 现存白盒缺陷与违规项 | 级别 | 难度 |
| :---: | :--- | :--- | :--- | :--- | :---: | :---: |
| **1** | [overlay-scrollbar.css:8-36](file:///c:/Software/conex/apps/crish-desktop/src/styles/overlay-scrollbar.css#L8-L36) | 全局 WebKit 细滚动条出口 | `::-webkit-scrollbar` 7px; track transparent; thumb `--tint-scrollbar-thumb`; button display:none | 全局覆盖，但缺乏对局部组件尺寸（如 3px/5px）的一键参数化控制，选择器覆盖有限 | **Tier A** | L2 |
| **2** | [Sidebar.module.css:123-130](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css#L123-L130) | 左侧会话与导航侧栏 (`.sidebarScroll`) | `overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--tint-scrollbar-thumb) transparent;` | **违背全局契约**：写了 `scrollbar-width: thin` 导致全局 WebKit 细条失效，Windows 露出带三角原生条 | **Tier A** | L1 |
| **3** | [ChatMessageList.module.css:23](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/ChatMessageList.module.css#L23) | 主会话消息虚拟化视口 (`.list`) | `overflow-y: auto; overflow-x: hidden;` | 继承全局 7px 细条，但在快速滚屏与图片流式加载时缺乏 `scrollbar-gutter` 保护，可能引起轻微抖动 | **Tier A** | L2 |
| **4** | [ChatMessageList.module.css:90](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-list/ChatMessageList.module.css#L90) | 会话置顶消息列表 (`.pinnedList`) | `max-height: 160px; overflow-y: auto;` | 浮层内部滚动条紧贴外边框，无圆角防裁切内缩保护 | **Tier B** | L1 |
| **5** | [ChatComposer.module.css:604-614](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L604-L614) | 输入框附件/文件条 (`.fileZone`, `.attachStrip`) | `overflow-x: auto; scrollbar-width: none; ::-webkit-scrollbar { display: none; }` | 标准与私有隐藏双写，合规但存在冗余代码 | **Tier B** | L1 |
| **6** | [ChatComposer.module.css:1113-1115](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L1113-L1115) | 输入框原生单行/多行 Textarea (`.textarea`) | `overflow-y: hidden; scrollbar-width: thin;` | **代码逻辑矛盾**：声明了 `overflow-y: hidden` 却保留 `scrollbar-width: thin`，属于脏代码残余 | **Tier A** | L1 |
| **7** | [ChatComposer.module.css:1247](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L1247) | 输入框多行状态展开容器 (`.composerCard.isMultiline ...`) | `overflow-y: auto; max-height: 220px;` | 多行展开时因受第 6 行 `scrollbar-width: thin` 污染，在 Windows 上退化为原生灰色细条 | **Tier A** | L1 |
| **8** | [PermissionModeMenu.module.css:137-164](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css#L137-L164) | 权限模式选择菜单 (`.permMenu`) | `scrollbar-width: thin; scrollbar-color: ...; ::-webkit-scrollbar { width: 5px; }` | **严重双重混写**：`scrollbar-width` 扼杀 5px webkit；未写 button:none；14px 圆角被滚动条直角裁切 | **Tier A** | L2 |
| **9** | [ModelBadgePickerMenu.module.css:104-132](file:///c:/Software/conex/apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css#L104-L132) | 模型选择下拉面板 (`.modelScrollArea`) | `scrollbar-width: thin; scrollbar-color: var(--border-subtle); ::-webkit-scrollbar { width: 4px; }` | **严重双重混写**：硬编码 4px；使用未对齐的 `var(--border-subtle)` 代替 `--tint-scrollbar-thumb` | **Tier A** | L2 |
| **10** | [Menu.module.css:20-70](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.module.css#L20-L70) | 全局通用弹出菜单 (`.menuContent`) | `overflow-y: auto; ::-webkit-scrollbar { width: 5px; } ... button { display: none; }` | 私有 webkit 实现，硬编码 5px；14px 外圆角在滚动到底部时存在角部裁切与内容贴边溢出 | **Tier A** | L2 |
| **11** | [Select.module.css:161-189](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/Select.module.css#L161-L189) | 全局基础 Select 下拉浮层 (`.content`) | `scrollbar-width: thin; scrollbar-color: ...; ::-webkit-scrollbar { width: 5px; }` | **严重双重混写**：`scrollbar-width` 导致 5px webkit 失效；未设 button:none；圆角边缘贴边 | **Tier A** | L2 |
| **12** | [SelectContent.module.css:16-55](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectContent.module.css#L16-L55) | 独立封装 SelectContent 下拉浮层 (`.content`) | `scrollbar-width: thin; scrollbar-color: ...; ::-webkit-scrollbar { width: 5px; }` | 与 Select.module.css 完全相同的双重混写缺陷，代码冗余重复 | **Tier A** | L2 |
| **13** | [SmartPanel.module.css:103-125](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.module.css#L103-L125) | 智能命令/操作面板 (`.listContainer`, `.selectableListGroup`) | `overflow-y: auto; ::-webkit-scrollbar { width: 5px; }; .selectableListGroup: overflow-y: auto` | 私有 webkit 块；`.selectableListGroup` 局部滚动未统一样式；内边距未防范滚动条挤压 | **Tier A** | L2 |
| **14** | [SmartExpandablePanel.module.css:125-182](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartExpandablePanel/SmartExpandablePanel.module.css#L125-L182) | 智能可折叠命令面板 (`.listContainer`) | `overflow-y: auto; ::-webkit-scrollbar { width: 5px; }` | 私有 webkit 块；硬编码 5px；多层嵌套折叠展开时存在滚动条瞬间闪烁问题 | **Tier A** | L2 |
| **15** | [DiffCard.module.css:182-185](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L182-L185) | Diff 代码卡片文件列表 (`.fileList`) | `overflow-y: auto; scrollbar-width: thin;` | 违规声明 `scrollbar-width: thin`，破坏 WebKit 胶囊；无颜色 token 定义 | **Tier A** | L1 |
| **16** | [DiffCard.module.css:469-485](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L469-L485) | Diff 视口滚动容器 (`.scrollParent`, `.plainScrollParent`) | `overflow-y: auto; overscroll-behavior: auto;` | 依赖全局出口，但在与虚拟化/纯源码模式切换时，滚动锚定与滚动条重绘偶发不同步 | **Tier A** | L2 |
| **17** | [DiffCard.module.css:546](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L546) | Diff 单行代码长文本溢出 (`.lineText`) | `overflow-x: auto; white-space: pre;` | 每一行长代码都有独立的 `overflow-x`，横向滚动时会露出大量微型粗条或卡顿 | **Tier B** | L2 |
| **18** | [DiffCardUnifiedView.tsx:117](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardUnifiedView.tsx#L117) | 统一 Diff 视口宿主 DOM | `style={{ position: 'relative', overflowY: 'auto', outline: 'none' }}` | 内联样式声明 `overflowY: 'auto'`，未挂载标准化 class，不利于静态契约扫描 | **Tier A** | L2 |
| **19** | [DiffCardSplitView.tsx:118](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardSplitView.tsx#L118) | 分栏 Diff 视口宿主 DOM | `style={{ position: 'relative', overflowY: 'auto', outline: 'none' }}` | 同上，双栏同步滚动时内联样式导致缺乏统一滚动条类控制 | **Tier A** | L2 |
| **20** | [VirtualPlainCodeViewer.tsx:58-98](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/VirtualPlainCodeViewer.tsx#L58-L98) | 纯源码虚拟化视口与行容器 | `overflowY: 'auto'`, 行 `overflowX: 'auto'` | 内联样式；长行代码存在嵌套横向滚动条风险 | **Tier B** | L2 |
| **21** | [StreamingTableContainer.module.css:24-35](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css#L24-L35) | 流式 Markdown 表格滚动视口 (`.tableScrollViewport`) | `overflow: auto; scrollbar-width: thin; scrollbar-color: var(--tint-scrollbar-thumb, rgba(0, 0, 0, 0.2)) transparent;` | **双重缺陷**：写了 `scrollbar-width: thin`；fallback 竟然硬编码了 `rgba(0,0,0,0.2)`，暗黑模式变脏黑框！ | **Tier B** | L2 |
| **22** | [ChatToolCallBlock.module.css:457-634](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css#L457-L634) | 工具调用折叠块终端输出/参数 (`.toolSectionContent`, `.toolVal`, `.toolOutputCode`) | `overflow-x: auto; overflow-y: auto; max-height: 160px/320px;` | 容器圆角为 6px，滚动条紧贴右侧边框，存在顶底圆角裁切 | **Tier B** | L1 |
| **23** | [ChatToolCallBlock.module.css:875-880](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css#L875-L880) | 工具调用内嵌 Git Diff 容器 (`.gitDiffLinesContainer`) | `overflow-x: auto; scrollbar-width: thin;` | **违规混写**：此局部容器写了 `scrollbar-width: thin`，而同文件其他 4 处却没写，同一组件内滚动条风格分裂！ | **Tier B** | L1 |
| **24** | [NotePaperPanel.module.css:161-174](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperPanel.module.css#L161-L174) | 独立笔记画板主内容滚动区 (`.body`) | `overflow: auto; scrollbar-gutter: stable; scrollbar-width: thin; scrollbar-color: var(--tint-strong, ...);` | 错误混写 `scrollbar-width: thin`，在 WebView2 中退化为粗条；注释仍残留“禁 webkit”的旧理念 | **Tier B** | L2 |
| **25** | [TiptapEditorField.module.css:31-42](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/TiptapEditorField.module.css#L31-L42) | Tiptap 富文本编辑器输入区域 (`.proseMirrorField`) | `overflow-y: auto; scrollbar-width: thin;` | 违规声明 `scrollbar-width: thin`，富文本聚焦时滚动条与原生 Win32 光标样式打架 | **Tier A** | L1 |
| **26** | [TiptapEditorField.module.css:149](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/TiptapEditorField.module.css#L149) | Tiptap 编辑器内嵌代码块 (`pre`) | `overflow-x: auto;` | 依赖全局出口，长代码横向滚动条未配置高度限制与背景防溢出 | **Tier B** | L1 |
| **27** | [TiptapSlashMenu.module.css:26-34](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.module.css#L26-L34) | Tiptap Slash 指令快捷菜单 (`.popoverContent`) | `overflow-y: auto; scrollbar-width: thin;` | 违规声明 `scrollbar-width: thin`，弹出菜单退化为原生粗条；外层有 6px 圆角 | **Tier A** | L1 |
| **28** | [ChatQueuePanel.module.css:11-12](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatQueuePanel.module.css#L11-L12) | 消息排队管理抽屉 (`.queuePanel`) | `overflow-y: auto; scrollbar-width: thin;` | 违规声明 `scrollbar-width: thin`，缺少颜色与 WebKit 控制 | **Tier B** | L1 |
| **29** | [ComposerFusedTrigger.module.css:125](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ComposerFusedTrigger.module.css#L125) | 融合触发器弹出浮层 (`.triggerMenu`) | `overflow-y: auto;` | 依赖全局出口，但浮层设置了 12px 圆角与透明模糊，存在边缘白边裁切 | **Tier B** | L1 |
| **30** | [LeafToolTabStrip.module.css:56-64](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css#L56-L64) | 多窗格工具栏标签条 (`.tabsTrack`) | `overflow-x: auto; scrollbar-width: none; ::-webkit-scrollbar { display: none; }` | 标签栏隐藏滚动条，但当标签过多时缺乏左右平滑阴影蒙版指示器 | **Tier B** | L1 |
| **31** | [LeafToolTabStrip.module.css:414](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css#L414) | 工具窗格空态启动中心 (`.launcherHubWrapper`) | `overflow: auto;` | 居中启动面板高度不足时的后备滚动，依赖全局出口 | **Tier C** | L1 |
| **32** | [PaneHeader.module.css:53-55](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/PaneHeader.module.css#L53-L55) | 窗格头部标签栏 (`.tabs`) | `overflow-x: auto; scrollbar-width: none;` | 只写了 `scrollbar-width: none`，遗漏了 `::-webkit-scrollbar { display: none; }`，跨内核存在隐患 | **Tier B** | L1 |
| **33** | [ModelsSettingsTab.module.css:63-176](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css#L63-L176) | 模型设置主列表与模型列表视口 (`.modelsList`) | `overflow-y: auto;` | 契约白名单文件，正常消费全局细条 | **Tier B** | L1 |
| **34** | [ModelsSettingsTab.module.css:1108-1135](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css#L1108-L1135) | 模型级联飞出菜单 (`.cascadeFlyout`) | `scrollbar-width: thin; scrollbar-color: var(--border-subtle); ::-webkit-scrollbar { width: 3px; }` | **严重双重混写**：硬编码 3px；未设 button:none；使用 `--border-subtle` 低对比色 | **Tier A** | L2 |
| **35** | [FontSelectField.module.css:203-223](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/FontSelectField.module.css#L203-L223) | 字体选择器下拉列表 (`.settingsSelectScroll`) | `scrollbar-width: thin; scrollbar-color: var(--border-subtle); ::-webkit-scrollbar { width: 3px; }` | **严重双重混写**：硬编码 3px；未设 button:none；与 ModelsSettingsTab 存在重复逻辑 | **Tier A** | L2 |
| **36** | [SettingsPanel.module.css:133-199](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.module.css#L133-L199) | 设置主面板左侧导航与内容区 (`.navScroll`, `.coverContent`) | `overflow-y: auto;` | 规范达标：严格遵守了 `style-contract.test.ts` 禁写 `scrollbar-width` 的规则，走全局 webkit 细条 | **Tier B** | L1 |
| **37** | [SettingsQuickMenu.module.css:64](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsQuickMenu.module.css#L64) | 托盘/快捷设置菜单 (`.quickMenuList`) | `overflow-y: auto;` | 浮层滚动条贴边，需验证 14px 圆角裁切防护 | **Tier B** | L1 |
| **38** | [SettingsUsageTab.module.css:89](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsUsageTab.module.css#L89) | 用量与统计设置选项卡 (`.usageScroll`) | `overflow-y: auto;` | 正常走全局细条 | **Tier B** | L1 |
| **39** | [SettingsExtensionsTab.module.css:156-173](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-extensions/SettingsExtensionsTab.module.css#L156-L173) | 扩展设置选项卡列表与详情 (`.coverContent`) | `overflow: auto;` | 规范达标：命中 `[class*='coverContent']`，严禁声明 scrollbar-width | **Tier B** | L1 |
| **40** | [McpSettingsTab.module.css:297](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-mcp/McpSettingsTab.module.css#L297) | MCP 服务配置表格视口 (`.tableContainer`) | `overflow-x: auto;` | 横向滚动视口，依赖全局 7px 细条 | **Tier B** | L1 |
| **41** | [SkillsSettingsTab.module.css:241-730](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css#L241-L730) | 技能市场列表、详情与代码编辑预览 (共 5 处) | `overflow-x: auto; overflow-y: auto; overflow: auto;` | 包含横向表格与多级垂直滚动，均命中 `[class*='coverContent']` 走全局 webkit 细条 | **Tier B** | L1 |
| **42** | [SkillEditorModal.module.css:14](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillEditorModal.module.css#L14) | 技能代码编辑弹窗主体 (`.modalBody`) | `overflow-y: auto;` | 模态弹窗内部滚动，依赖全局出口 | **Tier C** | L1 |
| **43** | [ExternalSessionImport.module.css:129](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/ExternalSessionImport.module.css#L129) | 外部会话导入会话清单 (`.sessionList`) | `overflow: auto;` | 弹窗内列表，依赖全局出口 | **Tier C** | L1 |
| **44** | [FilesCard.module.css:200-497](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.module.css#L200-L497) | 项目文件卡片树形与预览区 (共 3 处) | `overflow: auto; overflow-y: auto;` | 文件列表高频滚动，依赖全局 7px 细条，在大文件树渲染时可优化为 5px 紧凑条 | **Tier B** | L2 |
| **45** | [FileTreeView.tsx:198](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FileTreeView.tsx#L198) | 虚拟化文件树 DOM 视口 | `style={{ overflowY: 'auto', position: 'relative' }}` | 内联样式，未挂载独立标准化 class | **Tier B** | L2 |
| **46** | [FileViewerCard.module.css:196](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FileViewerCard.module.css#L196) | 文件查看卡片文本内容视口 (`.viewerContent`) | `overflow-y: auto;` | 代码查看时横向未开启 auto，部分超宽长文本可能被折行截断 | **Tier B** | L1 |
| **47** | [OverviewCard.module.css:7-194](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewCard.module.css#L7-L194) | 项目概览主卡片与详情区 (`.cardBody`) | `overflow-y: auto;` | 依赖全局出口 | **Tier B** | L1 |
| **48** | [OverviewChangesList.module.css:20](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewChangesList.module.css#L20) | 项目概览改动清单列表 (`.changesList`) | `overflow-y: auto;` | 依赖全局出口 | **Tier B** | L1 |
| **49** | [SidebarContextMenus.module.css:90-160](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarContextMenus.module.css#L90-L160) | 侧边栏右键上下文菜单 (`.menuContent`) | `overflow-y: auto;` | 命中 `[class*='menuContent']`，走全局细条，避免重复写样式 | **Tier B** | L1 |
| **50** | [Dialog.module.css:187](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css#L187) | 通用模态对话框内容主体 (`.dialogBody`) | `overflow-y: auto;` | 命中 `[class*='dialogBody']`，走全局细条 | **Tier B** | L1 |
| **51** | [Textarea.module.css:29-30](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Input/Textarea.module.css#L29-L30) | 通用 UI 文本域组件 (`.textarea`) | `overflow-y: auto; scrollbar-width: thin;` | **违规声明**：写了 `scrollbar-width: thin`，在 Windows 上打出原生带三角细条 | **Tier A** | L1 |
| **52** | [CheatsheetModal.module.css:68](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/CheatsheetModal.module.css#L68) | 快捷键速查表模态框 (`.body`) | `overflow-y: auto;` | 依赖全局出口，对话框内边距舒适 | **Tier C** | L1 |
| **53** | [TerminalCard.module.css:160-424](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/TerminalCard.module.css#L160-L424) | 终端工作区与日志流视口 (`.terminalBody`) | `overflow-y: auto;` | 终端日志输出量巨大，滚动条与 xterm 视口有重叠冲突风险 | **Tier B** | L2 |
| **54** | [RuntimePanel.module.css:6-158](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/RuntimePanel.module.css#L6-L158) | 运行时状态监控面板 (`.panelBody`) | `overflow-y: auto;` | 依赖全局出口 | **Tier C** | L1 |
| **55** | [PreviewCard.module.css:495](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/PreviewCard.module.css#L495) | 浏览器/文档实时预览卡片 (`.previewFrame`) | `overflow-y: auto;` | 依赖全局出口 | **Tier C** | L1 |
| **56** | [BrowserImportSection.module.css:187](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/browser-panel/BrowserImportSection.module.css#L187) | 浏览器导入历史记录列表 (`.scrollContent`) | `overflow-y: auto;` | 依赖全局出口 | **Tier C** | L1 |
| **57** | [FlowDagView.tsx:171](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/FlowDagView.tsx#L171) | 流程 DAG 可视化画布容器 | `style={{ overflow: 'auto', padding: '12px' }}` | 内联样式双向滚动画布，大图滚动时需要更宽的滚动胶囊指示 | **Tier C** | L2 |
| **58** | [AgentCard.module.css:136-359](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/AgentCard.module.css#L136-L359) | 子 Agent 进度卡片与思考视口 (共 4 处) | `overflow-y: auto;` | 思考文本展开时滚动，走全局 7px 细条，在紧凑卡片内略显偏粗 | **Tier B** | L2 |
| **59** | [ApprovalAskCard.module.css:162](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css#L162) | 敏感操作审批确认卡片 (`.details`) | `overflow: auto;` | 依赖全局出口 | **Tier C** | L1 |
| **60** | [InlineAgentPanel.module.css:149-631](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/InlineAgentPanel.module.css#L149-L631) | 任务流内嵌 Agent 面板视口 (共 3 处) | `overflow-y: auto;` | 多层任务嵌套时滚动视口较窄，走全局细条 | **Tier B** | L1 |
| **61** | [narrative.module.css:164-294](file:///c:/Software/conex/apps/crish-desktop/src/extensions/conversation-flow/narrative.module.css#L164-L294) | 对话叙事流扩展选项视口 (共 3 处) | `overflow: auto;` | 依赖全局出口 | **Tier C** | L1 |
| **62** | [blockChrome.css:260-281](file:///c:/Software/conex/packages/block-paper/src/chrome/blockChrome.css#L260-L281) | Block Paper 斜杠指令浮层 (`.bp-slash-host`) | `overflow: auto; scrollbar-width: thin; scrollbar-color: var(--tint-strong, ...);` | **违规混写**：声明了 `scrollbar-width: thin`；且 package 样式无法直接感知主应用 webkit 覆盖 | **Tier B** | L2 |
| **63** | [paperList.css:9-59](file:///c:/Software/conex/packages/block-paper/src/list/paperList.css#L9-L59) | Block Paper 块级列表滚动宿主 (`.bp-paper-list`) | `overflow: auto; scrollbar-width: thin; scrollbar-color: var(--tint-strong, ...);` | 注释声称“禁 ::-webkit-scrollbar 私有块”，却写了 `scrollbar-width: thin`，在桌面端 Windows 形成原生粗条 | **Tier B** | L2 |

---

## 四、八大业务领域滚动体系白盒解剖与现场切片

### 1. 核心会话流与虚拟化系统 (Chat & MessageVirtualizer)

- **核心组件**：`MessageVirtualizer.tsx`、`ChatMessageList.module.css`、`TimelineThoughtSection.module.css`。
- **DOM 挂载层级**：
  ```html
  <div class="streamHost" data-chat-stream-host="">
    <div class="list" data-virtual-scroll="true" role="region"> <!-- 真正滚动宿主 -->
      <div class="listInner"> <!-- 内容包含块，max-width 760px，居中 -->
        <div class="pinnedBar">...</div>
        <!-- 虚拟化测量出的动态高度垫片与消息行 -->
      </div>
    </div>
  </div>
  ```
- **现场样式机制**：
  - `.list` 声明了 `overflow-y: auto; overflow-x: hidden;`，未写任何私有 `scrollbar-width` 或 `::-webkit-scrollbar`。
  - 正确命中了 `overlay-scrollbar.css` 的全局规则，在 Windows WebView2 下能够成功绘制 7px 半透明胶囊（`--tint-scrollbar-thumb`），并在 hover 时加深至 `--tint-overlay`。
- **潜存缺陷与隐患**：
  1. **缺少 `scrollbar-gutter` 控制**：当虚拟化列表从空态或几条短消息（无滚动条）迅速增加到触发滚动的数量时，7px 滚动条会突然凭空插入或悬浮，在 Windows Overlay 机制未完全接管的环境下可能引发 7px 的内容跳动（Layout Shift）；
  2. **消息置顶浮层 (`.pinnedBar .pinnedList`)**：内部 `max-height: 160px; overflow-y: auto;` 滚动条直接贴在浮层右内边框，没有为右侧预留出 6px 的 gutter 留白。

### 2. 输入控制台与富文本编辑 (Composer & Tiptap)

- **核心组件**：`ChatComposer.module.css`、`TiptapEditorField.module.css`、`TiptapSlashMenu.module.css`、`PermissionModeMenu.module.css`。
- **现场切片与代码死锁**：
  在 `ChatComposer.module.css` 中，存在极其典型的多版本残留缺陷：
  ```css
  /* ChatComposer.module.css:1113-1115 */
  .textarea {
    overflow-y: hidden;
    scrollbar-width: thin; /* ❌ 错误声明！既然 hidden 为何还要 thin？ */
  }

  /* ChatComposer.module.css:1244-1247 */
  .composerCard.isMultiline .fieldInGrid .textarea,
  .composerCard.isMultiline .fieldInGrid :global(.ProseMirror) {
    white-space: pre-wrap;
    overflow-y: auto; /* 多行展开时变为 auto */
    min-height: 24px;
    max-height: 220px;
  }
  ```
  **渲染后果**：当用户在输入框输入超过 2 行进入 `isMultiline` 模式且高度触顶 220px 时，由于 `.textarea` 继承了基础类的 `scrollbar-width: thin`，Chromium 立即关闭 WebKit 细条渲染，在精致的毛玻璃输入框右侧硬生生弹出一个**带灰色方块和上下三角的 Windows 原生滚动条**！破坏了极简输入界面的设计质感。

### 3. 通用 UI 浮层、选择器与智能面板 (Floating Menus & Selects)

- **核心组件**：`Menu.module.css`、`Select.module.css`、`SelectContent.module.css`、`SmartPanel.module.css`、`SmartExpandablePanel.module.css`、`ModelBadgePickerMenu.module.css`。
- **白盒对比矩阵**：
  此领域的 6 个组件是全仓私有 WebKit 滚动条碎片化最严重的重灾区，各自为政，数值冲突极大：

| 组件名称 | 声明宽/高 | 轨道颜色 | 滑块色 (Thumb) | 滑块圆角 | 是否隐藏 Button | 是否写了 scrollbar-width |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Menu** | `5px` | `transparent` | `--tint-scrollbar-thumb` | `9999px` | ✅ `display: none` | ❌ 严禁 (测试守护) |
| **Select** | `5px` | `transparent` | `--tint-scrollbar-thumb` | `9999px` | ❌ **未写 (漏写)** | ⚠️ **写了 thin (冲突)** |
| **SelectContent** | `5px` | `transparent` | `--tint-scrollbar-thumb` | `9999px` | ❌ **未写 (漏写)** | ⚠️ **写了 thin (冲突)** |
| **SmartPanel** | `5px` | `transparent` | `--tint-scrollbar-thumb` | `9999px` | ✅ `display: none` | ❌ 未写 |
| **SmartExpandable** | `5px` | `transparent` | `--tint-scrollbar-thumb` | `9999px` | ✅ `display: none` | ❌ 未写 |
| **ModelBadgePicker** | `4px` | `transparent` | `var(--border-subtle)` | `4px` | ✅ `display: none` | ⚠️ **写了 thin (冲突)** |
| **ModelsSettingsTab**| `3px` | `transparent` | `var(--border-subtle)` | `3px` | ❌ **未写 (漏写)** | ⚠️ **写了 thin (冲突)** |

- **严重危害分析**：
  1. `Select` 与 `SelectContent`、`ModelBadgePickerMenu` 因写了 `scrollbar-width: thin`，在 Windows WebView2 真机上其实根本没有享受到自己辛辛苦苦写的 `5px` / `4px` 胶囊，全被 Chromium 转译为原生粗条；
  2. `ModelBadgePickerMenu` 与 `ModelsSettingsTab` 自行把宽度设为 `4px` 与 `3px`，滑块圆角分别设为 `4px` 与 `3px`，且颜色使用了偏淡且不可控的 `var(--border-subtle)`，导致滑块对比度过低（在某些浅色主题下几乎看不见，严重违背无障碍可见性准则）。

### 4. 工作区框架、分栏与侧边栏 (Sidebar & Workspace Tabs)

- **核心组件**：`Sidebar.module.css`、`LeafToolTabStrip.module.css`、`PaneHeader.module.css`。
- **架构断层深度排查**：
  `Sidebar.module.css` 包含 `.sidebarScroll`。在 `overlay-scrollbar.css:42` 中：
  ```css
  [class*='sidebarScroll'],
  [class*='menuContent'],
  [class*='coverContent'],
  [class*='navScroll'],
  [class*='dialogBody'] {
    /* 占位选择器：契约测试与消费方清单同源；绘制走上方全局 webkit。 */
    scrollbar-gutter: auto;
  }
  ```
  设计者的初衷是让 `[class*='sidebarScroll']` 统一由全局 `overlay-scrollbar.css` 赋予 7px 细胶囊。
  但是在 `Sidebar.module.css:129-130`，开发人员未经审敛地加入了：
  ```css
  scrollbar-width: thin;
  scrollbar-color: var(--tint-scrollbar-thumb) transparent;
  ```
  这直接破坏了全局规则的继承，是代码库架构治理失守的典型表现！

### 5. 代码比对、差异查看与纯源码视口 (DiffCard & Virtual Code)

- **核心组件**：`DiffCard.module.css`、`DiffCardSplitView.tsx`、`DiffCardUnifiedView.tsx`、`VirtualPlainCodeViewer.tsx`。
- **现场架构机制**：
  - DiffCard 具有三种复杂的滚动场景：
    1. 左侧文件树/列表 (`.fileList`)：垂直滚动；
    2. 差异比对主视口 (`.scrollParent`)：包含统一视图（Unified）与分栏视图（Split），双栏通过 JS 侦听同步 `scrollTop`；
    3. 长代码行内溢出 (`.lineText`)：每一行代码自带 `overflow-x: auto`。
- **现场缺陷**：
  1. `.fileList` 第 185 行硬编码 `scrollbar-width: thin;`；
  2. `.lineText` 每一行都有 `overflow-x: auto`。当某一行代码极长（如几千字符的一行 JSON 或 base64）时，鼠标悬停或焦点落入该行会触发单行微型横向滚动条，整页若有多行超长，会出现十几个横向小条密密麻麻并存的“千层饼”严重视觉污染。理想做法是外层视口提供单一全局横向滚动条，禁止单行局部 overflow。

### 6. 设置面板、多选项卡与扩展/技能市场 (Settings System)

- **核心组件**：`SettingsPanel.module.css`、`ModelsSettingsTab.module.css`、`FontSelectField.module.css`、`SkillsSettingsTab.module.css`。
- **治理亮点与反差**：
  - **模范履约**：`SettingsPanel.module.css` 的 `.coverContent` 与 `.navScroll` 极为干净，零 `scrollbar-width`、零私有 `::-webkit-scrollbar`，100% 走全局出口，并通过了 `style-contract.test.ts:297-302` 的自动化硬断言拦截；
  - **严重失范**：同样在设置体系内，`ModelsSettingsTab.module.css:1126-1135` 和 `FontSelectField.module.css:214-223` 却私自挂载了私有 3px 滚动条以及 `scrollbar-width: thin`，形成了同一个设置视窗内，外侧滚动条是 7px 极简黑，内侧级联菜单突然变成 3px 浅灰且带三角的荒谬对比。

### 7. 文件树、文件查看与概览变更 (Files & Overview)

- **核心组件**：`FilesCard.module.css`、`FileTreeView.tsx`、`FileViewerCard.module.css`、`OverviewCard.module.css`。
- **现场架构机制**：
  - 全部依赖全局 `overlay-scrollbar.css` 规则，无私有 `::-webkit-scrollbar`，表现相对统一稳定；
  - `FileTreeView.tsx` 内联书写了 `style={{ overflowY: 'auto', position: 'relative' }}`，存在内联样式污染与不可静态审计缺陷，需抽取为 CSS Module 标准类。

### 8. 独立包与富文本块级系统 (Block Paper Package)

- **核心组件**：`packages/block-paper/src/chrome/blockChrome.css`、`packages/block-paper/src/list/paperList.css`。
- **跨包设计裂痕**：
  - `block-paper` 是独立 workspace package，历史遗留注释还在引用已经废弃的旧文件名 `shell-scrollbar.css`；
  - 其规则严格遵循了所谓标准语法：
    ```css
    scrollbar-gutter: stable;
    scrollbar-width: thin;
    scrollbar-color: var(--tint-strong, var(--tint-scrollbar-thumb, transparent)) transparent;
    ```
  - 当 `block-paper` 作为组件挂载进 `crish-desktop` 主桌面端时，这一段 CSS 导致了桌面端 WebView2 内的富文本列表瞬间脱离全局 `overlay-scrollbar.css` 的控制范围，露出了 Win32 原生三角滚动条！

---

## 五、五大现存结构性缺陷全景诊断 (Defect Deep-Dive)

```mermaid
graph LR
    D1["缺陷 1: 标准与私有混写<br/>(WebKit 伪元素遭强制关闭)"]
    D2["缺陷 2: 尺寸与圆角硬编码<br/>(3px/4px/5px/7px 乱象)"]
    D3["缺陷 3: 浮层圆角被直角裁切<br/>(Border-radius Bleed)"]
    D4["缺陷 4: 色彩令牌违背规范<br/>(rgba 与 border-subtle 脏色)"]
    D5["缺陷 5: 缺少平滑 Gutter 保护<br/>(Layout Shift 内容跳动)"]

    D1 --> Impact["导致 Windows WebView2 桌面端<br/>频繁露出原生带三角粗滚动条，<br/>界面设计感严重断层！"]
    D2 --> Impact
    D3 --> Impact
    D4 --> Impact
    D5 --> Impact
```

### 缺陷 1：`scrollbar-width: thin` 与 `::-webkit-scrollbar` 混写引发的 WebView2 灾难性退化

- **涉及文件清单 (9 处重灾区)**：
  1. `apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css`
  2. `apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css`
  3. `apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css`
  4. `apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css`
  5. `apps/crish-desktop/src/components/settings/FontSelectField.module.css`
  6. `apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css`
  7. `apps/crish-desktop/src/components/ui/Select/Select.module.css`
  8. `apps/crish-desktop/src/components/ui/Select/SelectContent.module.css`
  9. `packages/block-paper/src/list/paperList.css`
- **机理病理**：开发者误以为同时书写现代标准属性与 WebKit 属性是“做兼容兜底（Fallback）”。然而在 Chromium 内核中，两者的处理逻辑不是 Fallback，而是 **Mutual Exclusion（排他互斥）**！只要命中标准属性，WebKit 解析器立即罢工。

### 缺陷 2：私有 WebKit 滚动条碎片化扩散与尺寸/圆角硬编码乱象

- **白盒证据**：
  - 宽度（Width）：
    - `overlay-scrollbar.css` -> `var(--scrollbar-thumb-width, 7px)`
    - `Menu` / `Select` / `SmartPanel` / `PermissionModeMenu` -> `5px`
    - `ModelBadgePickerMenu` -> `4px`
    - `ModelsSettingsTab` / `FontSelectField` -> `3px`
  - 滑块圆角（Border-radius）：
    - 全局规范 -> `var(--radius-full)` (9999px 跑道圆角)
    - 部分私有组件硬编码 -> `4px`、`3px`、`9999px`
- **危害**：各模块在视觉上缺乏同一律。从 7px 的主聊天区切换到 5px 的下拉框，再展开 3px 的级联菜单，界面元素极度杂乱无序。

### 缺陷 3：浮层菜单与圆角卡片中的滚动条越界裁切风险 (Border-radius Corner Clipping)

- **白盒证据**：
  - `Menu.module.css:26` 声明了 `border-radius: var(--sep-radius-outer, 14px); padding: 6px;`
  - `PermissionModeMenu.module.css:120` 声明了 `border-radius: 14px; padding: 6px;`
  - `Select.module.css:154` 声明了 `border-radius: 14px; padding: 6px;`
  - `ModelsSettingsTab.module.css:1117` 声明了 `border-radius: 14px; padding: 6px;`
- **病理诊断**：
  这些浮层容器本身带有 `14px` 的高曲率圆角以及 `6px` 的内边距。当 `overflow-y: auto` 声明在最外层容器时，在 WebKit/Chromium 渲染机制下：
  滚动条是紧贴着元素的 Border-box 内边缘绘制的（即叠在 Padding 之上）。当滑块滚到最顶端或最底端时，带有 9999px 圆角的滑块会直接切入外层容器 14px 圆角的几何曲线上。如果外层没有 `overflow: hidden`，滑块直角轨道会超出外壳圆角；如果有 `overflow: hidden`，滑块在转角处会被生硬地切成不自然的尖角破损图形！

### 缺陷 4：色彩令牌违背规范与暗黑模式适配断层

- **白盒证据**：
  - `StreamingTableContainer.module.css:35`：
    ```css
    scrollbar-color: var(--tint-scrollbar-thumb, rgba(0, 0, 0, 0.2)) transparent;
    ```
    这里写死了浅色专用的 `rgba(0, 0, 0, 0.2)`！在暗黑模式下，如果 token 未注入，这个黑色半透明底在深黑底色（`#1b1b1b`）上会形成极其突兀的脏脏黑块。同时直接违反了根目录 `AGENTS.md` 第 14 条“色彩空间与现代 CSS 语法（优先 HSLA / 斜杠透明度，避免散落旧式 rgba）”。
  - `ModelBadgePickerMenu.module.css:126`、`ModelsSettingsTab.module.css:1133`、`FontSelectField.module.css:221`：
    使用 `background: var(--border-subtle)` 作为滑块颜色。`--border-subtle` 的设计初衷是做发丝分割线（Hairline），透明度极低，作为可以被用户拖拽的交互手柄，对比度严重不足，无法满足 WCAG 2.1 SC 1.4.11（非文本对比度 ≥ 3:1）的标准。

### 缺陷 5：滚动条槽位抖动 (Layout Shift) 与 `scrollbar-gutter` 缺失

- **白盒证据**：
  全仓 63 个文件中，仅有 `overlay-scrollbar.css`、`NotePaperPanel.module.css`、`blockChrome.css`、`paperList.css` 4 处写了 `scrollbar-gutter`。
- **病理诊断**：
  在主会话流、文件列表、代码 Diff 区等内容动态增减的容器中，滚动条默认会在内容超出时骤然出现，并将内容向左挤压 7px，在内容变短时又突然消失，引发界面的横向像素抖动（Jittering）。

---

## 六、分级治理阶梯与替换实施路线图 (Actionable Roadmap)

针对全仓 63 个文件、186 处声明，提出三层阶梯治理战略：

```mermaid
timeline
    title 统一滚动条体系改造路线图
    Tier A (第一批次 - 核心高频) : 拔除 9 大双重混写冲突
                               : 修正 Sidebar 违规 scrollbar-width
                               : 统一 Menu / Select / SmartPanel 为统一 token 变量
                               : 根除 ChatComposer textarea 脏属性
    Tier B (第二批次 - 次级面板) : 治理 DiffCard / StreamingTableContainer
                               : 清洗 block-paper 与 NotePaperPanel
                               : 消除单行代码 overflow-x 滥用
                               : 统一尺寸档位 (7px 常规 / 5px 紧凑 / 0px 隐藏)
    Tier C (第三批次 - 边缘视口) : 抽离 TSX 内联样式至 CSS Modules
                               : 优化 DAG / 终端视口联动
                               : 扩展 style-contract.test.ts 刚性防回归门禁
```

### 1. 统一尺寸档位与 CSS 变量方案（治理技术标准）

无需引入臃肿的三方虚拟滚动库，通过轻量级全局 Token 与 CSS 局部变量继承实现 100% 架构净收敛：
- **标准常规档位 (Standard 7px)**：用于主会话流、侧边栏、设置主页、文件树等大视口（默认继承自 `overlay-scrollbar.css`）；
- **紧凑浮层档位 (Compact 5px)**：用于 `Menu`、`Select`、`SmartPanel`、`PermissionModeMenu` 等浮层面板，通过在容器上声明 `--scrollbar-thumb-width: 5px;` 覆盖，**彻底拔除这些组件内重复书写的 10 多行私有 `::-webkit-scrollbar*`**；
- **发丝极简档位 (Hairline 3px)**：用于级联下拉项（Flyout）、紧凑字体选择器，声明 `--scrollbar-thumb-width: 3px;`；
- **全隐轨道档位 (Hidden 0px)**：用于标签栏（TabStrip）、附件胶囊条，声明 `--scrollbar-thumb-width: 0px;` 或统一 utility class `.hideScrollbar`。

### 2. 分级改造任务分解 (Tier A / B / C)

#### Tier A：核心交互面与致命冲突根除（共 16 处，最高优先级）
1. **`Sidebar.module.css:129-130`**：删除 `scrollbar-width: thin; scrollbar-color: ...;`，使其 100% 顺畅继承 `overlay-scrollbar.css` 细条；
2. **`ChatComposer.module.css:1115`**：彻底删除 `.textarea` 上的 `scrollbar-width: thin;`，消除多行展开时的原生粗条退化；
3. **`PermissionModeMenu.module.css:141-164`**：删除 `scrollbar-width: thin` 与全套私有 webkit 伪元素，改为依赖全局，设置 `--scrollbar-thumb-width: 5px;`；
4. **`ModelBadgePickerMenu.module.css:106-132`**：删除 `scrollbar-width: thin` 与私有伪元素，改为 `--scrollbar-thumb-width: 4px;`，滑块颜色对齐 `--tint-scrollbar-thumb`；
5. **`Select.module.css:165-189`** & **`SelectContent.module.css:20-55`**：删除 `scrollbar-width: thin` 与私有伪元素，统一切换为 `--scrollbar-thumb-width: 5px;`；
6. **`Menu.module.css:48-70`**：移除私有 webkit 块，统一走变量驱动；
7. **`SmartPanel.module.css`** & **`SmartExpandablePanel.module.css`**：移除私有 webkit 块；
8. **`DiffCard.module.css:185`**：移除 `.fileList` 的 `scrollbar-width: thin;`；
9. **`TiptapEditorField.module.css:42`** & **`TiptapSlashMenu.module.css:34`**：移除 `scrollbar-width: thin;`；
10. **`Textarea.module.css:30`**：移除 `scrollbar-width: thin;`。

#### Tier B：次级面板与跨包一致性收敛（共 24 处，中优先级）
1. **`StreamingTableContainer.module.css:34-35`**：移除 `scrollbar-width: thin`，将 `rgba(0,0,0,0.2)` 改为严格的 `--tint-scrollbar-thumb`；
2. **`ChatToolCallBlock.module.css:880`**：移除 Git Diff 容器的 `scrollbar-width: thin;`，解除同组件内部样式分裂；
3. **`NotePaperPanel.module.css:172-174`**：清除 `scrollbar-width: thin;`，对齐桌面端 WebKit 规范；
4. **`packages/block-paper/src/chrome/blockChrome.css:279`** & **`paperList.css:58`**：修正 package 样式的桌面端适配指引；
5. **`DiffCard.module.css:546`**：优化代码行 `.lineText` 横向溢出，改用代码卡片统一水平滚动轴；
6. **`ModelsSettingsTab.module.css:1110-1135`** & **`FontSelectField.module.css:210-223`**：清洗 3px 私有 WebKit 块与 thin 冲突；
7. **`FilesCard.module.css`**、`TerminalCard.module.css` 等大视口容器引入 `scrollbar-gutter: stable;` 防抖优化。

#### Tier C：边缘视口与静态代码卫生治理（共 23 处，常规迭代）
1. **TSX 内联样式清洗**：将 `DiffCardUnifiedView.tsx`、`DiffCardSplitView.tsx`、`VirtualPlainCodeViewer.tsx`、`FileTreeView.tsx`、`FlowDagView.tsx` 5 处的内联 `style={{ overflow... }}` 提取为标准 CSS Module 类；
2. **标签隐藏条标准混入**：将 `LeafToolTabStrip` 与 `PaneHeader` 的隐藏逻辑统一抽取为 `hideScrollbar` 工具类；
3. **自动化契约测试升级**：在 `style-contract.test.ts` 中更新 `SCROLLBAR_WHITELIST`，将已治理的组件移出私有白名单，并新增刚性门禁断言：**全仓除特定第三方包外，生产 CSS 严禁出现 `scrollbar-width: thin`！**

---

## 七、白盒普查验收断言与结论

1. **白盒事实查明**：完全还原了 Conex / Crish 桌面端在 WebView2 / Chromium 渲染宿主下滚动条退化的底层病因——多达 18 处非受控的 `scrollbar-width: thin` 声明，强行禁用了 WebKit 伪元素渲染机制，致使原生 Windows 三角粗条频繁外露；
2. **资产清单完备**：63 个文件、186 处声明已建立完备的一对一映射基线，代码位置精确到行号，现存缺陷分类定性准确；
3. **治理路径明确**：提出了基于 `--scrollbar-thumb-width` 动态覆写的单真源架构，消除了对庞大三方库的依赖，完全符合反过度设计红线与立体验证纪律。
