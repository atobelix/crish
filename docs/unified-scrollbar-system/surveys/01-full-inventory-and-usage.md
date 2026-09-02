# 01 · 全仓滚动条与容器清单白盒普查报告

> **战役工作区**：`docs/unified-scrollbar-system/`  
> **制定角色**：全仓滚动条普查专家与主控协同（Scrollbar Inventory & Usage Surveyor）  
> **普查时间**：2026-09-02  
> **普查目标**：对 Conex / Crish 桌面客户端（`apps/crish-desktop/src/`、`packages/` 等）所有显式写有 `::-webkit-scrollbar`、`scrollbar-width`、`scrollbar-color`、`overflow-y: auto/scroll` 的宿主容器进行端到端极度详尽的白盒普查与替换难度评估。

---

## 一、普查全景概览

经过对全仓 CSS Modules、全局样式表与测试文件的逐行白盒检索，统计数据如下：

- **私有 `::-webkit-scrollbar` 声明处**：**11 处组件**（共 40+ 条伪元素规则）；
- **`scrollbar-width: thin` 隐患处**：**16 处容器**（直接诱发 Chromium 关闭 WebKit 伪元素、回退 Win32 灰色粗方块的致命毒点）；
- **`scrollbar-width: none` 隐藏处**：**3 处容器**（`LeafToolTabStrip`、`PaneHeader`、`ChatComposer` 附件区，属于 Tier C 纯净通道）；
- **全局唯一 WebKit 出口**：`src/styles/overlay-scrollbar.css`（规范单一出口）；
- **现存最大视觉与交互断层**：
  1. 激活态颜色手写 `var(--text-primary) 30%`，在纸温底板上测出高达 **31.4%** 的死黑膏药；
  2. 宽度缺乏分级 Token，大量手写 `4px`、`5px`、`7px` 硬编码像素；
  3. 缺乏端点护栏，滑块滚到两端时被容器圆角截断（Corner Clipping）或越界溢出。

---

## 二、全仓滚动条宿主容器详尽清册（Inventory Table）

| 编号 | 文件路径与行号 | 所属组件与业务功能 | 当前声明的样式属性 | 现存具体问题与缺陷 | 改造建议与替换难度 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **01** | `apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css:106-135` | **模型选择器下拉菜单** (`ModelBadgePickerMenu`) | `width: 4px;`，声明了 `scrollbar-width: thin` 与 `::-webkit-scrollbar*`，button 上声明了隐藏 | 截图原型出处。违规混写 `scrollbar-width: thin`，hover 为 30% 深黑，无端点护栏 | **Tier B**：收敛为 `<ScrollArea size="xs" showButtons>`。难度：中 |
| **02** | `apps/crish-desktop/src/components/sidebar/Sidebar.module.css:129` | **左侧栏主滚动容器** (`.sidebarScroll`) | 声明了 `scrollbar-width: thin;`，依赖 `overlay-scrollbar.css` | 声明了 `scrollbar-width: thin` 破坏了 WebKit 稳定性 | **Tier A/Mode 2**：清除 thin，改挂 `.scrollArea .scrollAreaSm`。难度：低 |
| **03** | `apps/crish-desktop/src/components/chat-message-list/MessageVirtualizer.tsx` | **主聊天流虚拟滚动视口** (`MessageVirtualizer`) | 纯原生 `overflow-y: auto`，依赖 `overlay-scrollbar.css` | 激活态测得 31.4% 深黑，滚动条宽度固定为 7px | **Tier A/Mode 2**：保持原生视口，吃全局 Token。严禁包 DOM！难度：低 |
| **04** | `apps/crish-desktop/src/components/ui/Menu/Menu.module.css:48-66` | **全局通用 Menu 浮层** (`Menu`) | 私有 `::-webkit-scrollbar`，`width: 5px;`，button 显式写了 `display: none` | 私有硬编码像素，缺少 Token 绑定 | **Tier B**：清除私有伪元素，改挂 `data-scrollbar="sm"` 或 `<ScrollArea>`。难度：低 |
| **05** | `apps/crish-desktop/src/components/ui/Select/Select.module.css:165-187` | **通用 Select 下拉菜单** (`Select`) | 同时写了 `scrollbar-width: thin;` 和私有 `::-webkit-scrollbar`，`width: 5px;` | 严重互斥冲突！在 WebView2 下容易露出系统原生三角 | **Tier B**：清除 thin 与私有伪元素，挂载 `data-scrollbar="sm"`。难度：低 |
| **06** | `apps/crish-desktop/src/components/ui/Select/SelectContent.module.css:20,39-53` | **SelectContent 独立浮层** (`SelectContent`) | 同时写了 `scrollbar-width: thin;` 和私有 `::-webkit-scrollbar`，`width: 5px;` | 同上，存在私有硬编码与冲突 | **Tier B**：清除 thin，绑定标准 Token。难度：低 |
| **07** | `apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.module.css:107-116` | **SmartPanel 折叠面板** (`SmartPanel`) | 私有 `::-webkit-scrollbar { width: 5px; height: 5px; }`，手写 thumb 色 | 硬编码 5px，手写透明度，未收敛至全局 Token | **Tier B**：改用 Token 或 `data-scrollbar="sm"`。难度：低 |
| **08** | `apps/crish-desktop/src/components/ui/SmartExpandablePanel/SmartExpandablePanel.module.css:130-148` | **SmartExpandablePanel 面板** (`SmartExpandablePanel`) | 私有 `::-webkit-scrollbar { width: 5px; }`，写了 button 隐藏 | 硬编码 5px，存在代码重复 | **Tier B**：清除私有伪元素，挂载统一属性。难度：低 |
| **09** | `apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css:141-165` | **权限模式选择弹出菜单** (`PermissionModeMenu`) | 同时声明了 `scrollbar-width: thin;` 和私有 `::-webkit-scrollbar { width: 4px; }` | 冲突互斥，硬编码 4px | **Tier B**：清除 thin 与私有规则，挂载 `data-scrollbar="xs"`。难度：低 |
| **10** | `apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css:607,612,1115` | **输入框附件区与文件区** (`ChatComposer`) | 横向附件区写了 `scrollbar-width: none`，垂直区写了 `scrollbar-width: thin` | 垂直区 thin 违规，横向区未标准化 | **Tier C/Tier B**：横向保持 none，垂直区收敛。难度：低 |
| **11** | `apps/crish-desktop/src/components/chat-composer/ChatQueuePanel.module.css:12` | **输入队列面板** (`ChatQueuePanel`) | 仅写了 `scrollbar-width: thin;` | 在 Windows WebView2 上直接失去 WebKit 细条美化 | **Tier B**：清除 thin，吃全局 7px 细条。难度：低 |
| **12** | `apps/crish-desktop/src/components/chat-composer/TiptapEditorField.module.css:42` | **富文本输入框** (`TiptapEditorField`) | 仅写了 `scrollbar-width: thin;` | 同上，破坏 WebKit 出口 | **Tier B**：清除 thin。难度：低 |
| **13** | `apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.module.css:34` | **斜杠命令自动补全菜单** (`TiptapSlashMenu`) | 仅写了 `scrollbar-width: thin;` | 浮层菜单缺少美化，易触发原生丑条 | **Tier B**：清除 thin，挂载 `data-scrollbar="sm"`。难度：低 |
| **14** | `apps/crish-desktop/src/components/chat-message-row/StreamingTableContainer.module.css:34` | **流式 Markdown 表格容器** (`StreamingTableContainer`) | 写了 `scrollbar-width: thin;` | 横向宽表格滚动在 Windows 上露出系统灰色条 | **Tier A/Mode 2**：清除 thin，挂载 `scrollArea scrollAreaMd`。难度：低 |
| **15** | `apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css:880` | **工具调用折叠块代码/输出区** (`ChatToolCallBlock`) | 写了 `scrollbar-width: thin;` | 同上，应保持温润琥珀色 | **Tier A/Mode 2**：清除 thin。难度：低 |
| **16** | `apps/crish-desktop/src/components/diff/DiffCard.module.css:185` | **代码 Diff 卡片对比视口** (`DiffCard`) | 写了 `scrollbar-width: thin;` | 高频代码对比区，应保持 120fps 顺滑 | **Tier A/Mode 2**：清除 thin，走全局出口。难度：低 |
| **17** | `apps/crish-desktop/src/components/note-paper/NotePaperPanel.module.css:172` | **笔记便签面板** (`NotePaperPanel`) | 写了 `scrollbar-width: thin;` | 影响纸温阅读感 | **Tier B**：清除 thin。难度：低 |
| **18** | `apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css:1110,1126-1135` | **模型设置页级联下拉** (`ModelsSettingsTab`) | 同时声明了 `scrollbar-width: thin;` 和私有 `::-webkit-scrollbar`，`width: 5px;` | 互斥冲突，私有硬编码 | **Tier B**：清除 thin 与私有规则，采用 `<ScrollArea size="sm">`。难度：低 |
| **19** | `apps/crish-desktop/src/components/settings/FontSelectField.module.css:210,214-222` | **字体选择下拉列表** (`FontSelectField`) | 同时写了 `scrollbar-width: thin;` 和私有 `::-webkit-scrollbar`，`width: 6px;` | 互斥冲突，硬编码 6px | **Tier B**：收敛至标准 Token。难度：低 |
| **20** | `apps/crish-desktop/src/components/ui/Input/Textarea.module.css:30` | **通用多行文本框** (`Textarea`) | 写了 `scrollbar-width: thin;` | 破坏统一出口 | **Tier B**：清除 thin。难度：低 |
| **21** | `apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css:60,63` | **窗格工具标签条** (`LeafToolTabStrip`) | `scrollbar-width: none;` 与 `::-webkit-scrollbar { display: none }` | 保持纯净水平滑移（Tier C） | **Tier C**：维持双重隐藏。难度：零 |
| **22** | `apps/crish-desktop/src/components/binary-tree/PaneHeader.module.css:55` | **顶栏 TabStrip 滚动条** (`PaneHeader`) | `scrollbar-width: none;` | 保持纯净水平滑移（Tier C） | **Tier C**：维持隐藏。难度：零 |

---

## 三、核心发现与净收敛路线

1. **头号清除目标：16 处 `scrollbar-width: thin`**：
   - 彻底将这 16 处的 `scrollbar-width: thin` 连根拔除，解除 Chromium 121+ 杀死 WebKit 伪元素样式的系统性风险；
2. **第二清除目标：11 处私有 `::-webkit-scrollbar` 块**：
   - 将所有私有的 `width: 4px/5px/6px` 清退，统一替换为标准数据属性 `[data-scrollbar="xs|sm|md|lg"]` 或挂载统一类名；
3. **单一出口强化：重构 `src/styles/overlay-scrollbar.css`**：
   - 注入子代理 3 制定的完整 Token（8.2% 起始、20.2% 激活、12% 差值、暖橙注入）；
   - 注入子代理 2 制定的 WebKit 原生上下圆角三角箭头机制；
   - 导出子代理 4 制定的 Mode 2 纯 CSS 工具类（`.scrollArea*`）；
4. **组件出口建立：落地 `apps/crish-desktop/src/components/ui/ScrollArea/`**：
   - 落地子代理 4 制定的 `<ScrollArea>` 原子组件，专供弹窗、下拉、模型菜单等高频视口。
