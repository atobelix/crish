# 设置界面直接编辑 YAML 配置与外部直达交互方案

> **战役工作区**：`docs/model-capability/`  
> **文档归属**：`docs/model-capability/analysis/03-设置界面YAML编辑与直达交互方案.md`  
> **针对背景**：深度响应用户批评——*“不是设置界面能有直接编辑yaml文件的选项吗，怎么没有，是你都还没做吗”*  
> **方案定位**：Conex / Crish 设置界面与模型配置体系核心产品交互与工程落地详案  
> **核心目标**：穿透现有设置界面的导航架构、弹窗系统（`Dialog`）、代码高亮组件（`highlight.js`）与主机打开器能力（`host_openers`），设计一套兼具**内置代码编辑器（语法高亮/实时校验/错误直达）**与**系统外部编辑器调起（VS Code/Cursor/Zed/记事本/系统关联项）**，并打通**双向实时热重载（Hot-Reloading）与容灾持久化**的完整产品级交互方案。

---

## 一、用户痛点根因与架构现状诊断（Root Cause Analysis）

### 1.1 用户批评的本质与开发者心智解剖
用户批评反映了两个深层次的产品体验断层：
1. **表单 UI 的局限性与高阶开发者的认知错位**：
   - 现有的“设置 · 模型”页面（[`ModelsSettingsTab.tsx:181`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.tsx#L181)）完全依赖图形化卡片、下拉框与输入表单。
   - 当开发者需要批量配置思考档位（`thinking_tiers`）、微调上下文窗口（`contextWindow`）、批量维护数十个模型别名、迁移已有配置或复制粘贴供应商参数时，图形表单的操作链路冗长且低效。
   - 开发者期望如同主流现代 AI 工具（如 Claude Desktop、Cursor、Aider、OpenCode 等）一样，拥有明确的 **“Edit in YAML”** 或 **“Open Config”** 入口。
2. **“承诺未兑现”的挫败感**：
   - 在系统演进文档（如 [`00-统一模型能力与动态演进方案-总纲.md:58`](file:///c:/Software/conex/docs/model-capability/00-%E7%BB%9F%E4%B8%80%E6%A8%A1%E5%9E%8B%E8%83%BD%E5%8A%9B%E4%B8%8E%E5%8A%A8%E6%80%81%E6%BC%94%E8%BF%9B%E6%96%B9%E6%A1%88-%E6%80%BB%E7%BA%B2.md#L58)）中，系统规划了外部配置文件加载能力；
   - 然而在前端设置界面中，**完全没有暴露任何查看、编辑、打开 YAML 配置文件的交互入口**。用户进入设置后，找不到任何直达 YAML 的按钮，因而产生“怎么没有，是你都还没做吗”的严厉批评。

---

### 1.2 设置界面现有导航与交互布局断层

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ SettingsPanel (Dialog variant="fullscreen")                                            │
│ ┌───────────────────────┬────────────────────────────────────────────────────────────┐ │
│ │ SettingsSidebar       │ ModelsSettingsTab (SettingsPage)                           │ │
│ │ - 搜索设置 (input)    │ ┌────────────────────────────────────────────────────────┐ │ │
│ │ - 个人: 账户/外观...  │ │ PageHead: title="模型" | meta=<AddProviderMenu> (缺失!)  │ │ │
│ │ - 智能: 模型/用量...  │ ├────────────────────────────────────────────────────────┤ │ │
│ │ - 工作: 规则/定时...  │ │ Section 1: 默认模型 (ModelsCascadeSelect)              │ │ │
│ │                       │ ├────────────────────────────────────────────────────────┤ │ │
│ │ (侧边栏缺少全局配置入口)│ │ Section 2: ModelProfileList ⏐ ModelConfigEditor         │ │ │
│ │                       │ │ - ProfileHeader (仅重命名/启停/删除)                    │ │ │
│ │                       │ │ - ModelListHeader (仅检查连通/自动获取/手填，无YAML)     │ │ │
│ └───────────────────────┴────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **设置顶栏元操作区（Header Meta）能力单薄**：
   - [`ModelsSettingsTab.tsx:169-178`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.tsx#L169-L178) 中，`meta` 区域仅渲染了一个 `<AddProviderMenu>`（仅提供 OpenAI/Anthropic 格式及预设供应商的新增）。
   - 页面顶栏右上角的黄金操作位留白巨大，却没有任何关于“编辑配置文件”、“打开 YAML”的动作按钮。
2. **模型详情卡片上下文缺失直达出口**：
   - [`ProfileHeader.tsx:42-224`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ProfileHeader.tsx#L42-L224) 仅有标题重命名、启停开关与删除按钮；
   - [`ModelListHeader.tsx:32-138`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelListHeader.tsx#L32-L138) 仅有连通性检查（Wifi）、自动获取（RefreshCw）、搜索框与手动添加（Plus）。
   - 用户面对当前选中的供应商及其下数十个模型，无法“一键转到该供应商的 YAML 配置代码块”。
3. **设置侧边栏导航未暴露配置通道**：
   - [`SettingsSidebar.tsx:71-203`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsSidebar.tsx#L71-L203) 的搜索仅匹配 Tab 元数据（[`settingsTabsMeta.ts:120`](file:///c:/Software/conex/apps/crish-desktop/src/components/settingsTabsMeta.ts#L120)）。输入“yaml”、“配置文件”、“config”等关键词时，如果标签未定义该别名，将直接显示“无匹配项”，进一步加剧了用户的困惑。

---

### 1.3 弹窗系统（Dialog/Modal）基座契约与现状评估

1. **统一弹窗基座已成熟（`components/ui/Dialog/Dialog.tsx`）**：
   - 经过重构，[`Dialog.tsx:79-230`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.tsx#L79-L230) 已具备工业级弹窗能力：
     - 内置私有 `FocusTrap`、焦点自动还原（`useRestoreFocus`）、进入/退场动画（`useAnimatedPresence`）；
     - 支持无障碍属性：`role="dialog"`、`aria-labelledby`、`aria-describedby`、`aria-modal="true"`；
     - 支持尺寸档位 `size="sm" | "md" | "lg"`，以及覆盖层样式注入 `classNames={{ panel, overlay }}`；
     - 支持 Esc 拦截钩子（`onEscapeKeyDown`）与 backdrop 点击保护。
2. **现有弹窗编辑器过于原始（`RulesEditorDialog.tsx`）**：
   - 查看现有规则编辑弹窗 [`RulesEditorDialog.tsx:71-82`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/RulesEditorDialog.tsx#L71-L82)：仅使用原生 HTML `<textarea>`，无语法高亮、无行号、无缩进辅助、无格式校验，对于层级敏感、缩进严格的 YAML 配置文件来说完全无法满足工程要求。

---

### 1.4 代码高亮与前端编辑资产现状

1. **现有高亮引擎已就绪（`api/codeHighlight.ts`）**：
   - [`codeHighlight.ts:24, 63-64`](file:///c:/Software/conex/apps/crish-desktop/src/api/codeHighlight.ts#L24) 中，`highlight.js` 已经内置注册了 `yaml` 与 `yml` 语言包；
   - [`codeHighlight.ts:131-154`](file:///c:/Software/conex/apps/crish-desktop/src/api/codeHighlight.ts#L131-L154) 提供了同步的 `highlightCode(code, 'yaml')` 接口，并挂载了 LRU 内存缓存（`LruCache`）；
   - 现有系统已定义完整的代码高亮 CSS 变量系统（`--code-keyword`, `--code-string`, `--code-number`, `--code-comment` 等）。
2. **依赖包资产约束**：
   - 查阅 [`apps/crish-desktop/package.json`](file:///c:/Software/conex/apps/crish-desktop/package.json)，前端项目并未引入沉重的 Monaco Editor（VS Code 内核，打包后超 30MB），也没有引入 CodeMirror。
   - **反过度设计红线约束**：严禁为了一个设置配置弹窗盲目引入 Monaco Editor 等超重型依赖（违反 `ANTI_OVERENGINEERING_GUARDRAILS.md`）。应当利用现有 `highlight.js` 与双层同步滚动容器，或轻量级编辑器架构构建高响应、低内存、带行号与错误指示器的专用 YAML 编辑器。

---

### 1.5 主机打开器（Host Openers）能力分析与关键架构瓶颈

1. **前端 API 已经具备打开能力（`api/hostOpenersApi.ts`）**：
   - [`hostOpenersApi.ts:64`](file:///c:/Software/conex/apps/crish-desktop/src/api/hostOpenersApi.ts#L64)：`listHostOpeners()` 可动态扫描已安装的外部工具；
   - [`hostOpenersApi.ts:96`](file:///c:/Software/conex/apps/crish-desktop/src/api/hostOpenersApi.ts#L96)：`openWithHostOpener(openerId, filePath)` 可使用指定编辑器打开；
   - [`hostOpenersApi.ts:110`](file:///c:/Software/conex/apps/crish-desktop/src/api/hostOpenersApi.ts#L110)：`openPathDefault(filePath)` 可调用操作系统默认关联应用打开；
   - 候选编辑器涵盖：VS Code (`vscode`)、Cursor (`cursor`)、Zed (`zed`)、Windsurf (`windsurf`)、Trae (`trae`)、系统文件管理器 (`system-file-manager`) 以及 Windows 开始菜单扫描发现的应用（`lnk:*`）。
2. **【核心架构瓶颈发现】后端工作区根目录硬性拦截**：
   - 深入审查 Rust 壳层实现 [`apps/agent-workbench/src-tauri/src/host_openers/execute.rs:91-93`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/host_openers/execute.rs#L91-L93) 与 [`resolve.rs:107-119`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/host_openers/resolve.rs#L107-L119)：
     ```rust
     let workspace = crate::host_paths::workspace_root(&app_dir);
     let roots = [workspace.as_path()];
     let resolved_target = resolve_open_target_for_roots(&target, &roots).map_err(to_core_error)?;
     ```
   - 若目标路径不在 `workspace` 根目录下，`resolve_open_target_for_roots` 会强制阻断并报错：
     `"Host open target path must stay inside the Workbench workspace root."`（`host-open-target-outside-workspace`）。
   - **致命问题**：用户全局模型配置文件位于 `~/.conex/models.yaml`（跨工作区共享），位于用户 Home 目录，**直接调用 `openWithHostOpener` 会被 Rust 门禁硬拦截拒绝**！
   - **加固要求**：必须在 `resolve_open_target_for_roots` 中将配置目录（`config_dir()` / `~/.conex`）纳入合法白名单根目录集合（详见第四章）。

---

## 二、交互入口与系统导航拓扑设计（Navigation & Entry Architecture）

为彻底解决用户“找不到入口”的痛点，设计**三级黄金触达拓扑**，确保用户在任何心智路径下均能在 1 步之内触达 YAML 配置。

```
                                  用户意图: “我要看 / 改 YAML”
                                               │
             ┌─────────────────────────────────┼─────────────────────────────────┐
             ▼                                 ▼                                 ▼
   【一级入口：模型页顶栏】           【二级入口：服务商/模型卡片】          【三级入口：全局侧栏与快捷键】
  SettingsPage Header Meta             ProfileHeader / ModelListHeader         SettingsSidebar / Hotkey
             │                                 │                                 │
     [配置 (YAML) ▼]                   [查看 YAML 片段]                     - 侧栏搜索 "yaml" 命中
  ┌──────────┴──────────┐                      │                            - 侧栏底栏 [配置文件直达]
  │                     │                      │                            - 全局快捷键 Ctrl+Alt+,
  ▼                     ▼                      ▼                                 │
[内置编辑器弹窗]     [外部编辑器调起]    [定位到特定 Provider/Model]                     │
(Dialog 全屏/高亮)    (VS Code/Notepad)        │                                         │
  │                     │                      └──────────────────┬──────────────────────┘
  └─────────────────────┴─────────────────────────────────────────┘
```

### 2.1 一级黄金入口：模型设置页顶栏快捷操作区（Split Button / Action Group）

在 [`ModelsSettingsTab.tsx:181`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.tsx#L181) 的 `headerMeta` 区域，将原有的单一 `<AddProviderMenu>` 扩展为组合工具栏（Action Group）：

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  模型                                [ 配置文件 (YAML) ▾ ]  [+ 添加服务商 ▾] │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **视觉呈现**：
  - 左侧为 **“配置文件 (YAML)”** 组合下拉按钮（采用 `@/components/ui/Button` 样式，`variant="secondary"`，配带有代码高亮意味的 `Lucide.FileCode2` 或 `Lucide.Settings2` 图标）；
  - 右侧保留原有 **“添加服务商”**（`variant="primary"`）。
- **点击交互行为**：
  - 点击左侧主体文字：立即呼出 **内置 YAML 代码编辑器弹窗**，载入当前生效的 `models.yaml`；
  - 点击右侧下拉箭头（`ChevronDown`）：展开 **“打开方式与直达”** 菜单面板。

---

### 2.2 二级场景入口：服务商/模型详情上下文操作

当用户在左侧选择特定供应商（如 `custom-openai`）或浏览右侧模型列表时：
1. **供应商头部（`ProfileHeader.tsx`）**：
   - 在已启用按钮旁增加 `Lucide.Code` 图标按钮（Tooltip: `“在 YAML 中编辑此服务商配置”`）；
   - 点击后呼出内置 YAML 编辑器，光标与视图**自动聚焦并平滑滚动到该供应商对应的 YAML 块**。
2. **模型列表头部（`ModelListHeader.tsx`）**：
   - 在搜索框与自动获取按钮旁，增加 `“以 YAML 批量管理”` 链接文字或轻量图标按钮；
   - 降低用户逐个点击表单编辑数十个模型的疲劳感。

---

### 2.3 三级全局入口：设置侧边栏搜索优化与快捷导航

1. **Tab 别名检索贯通（`settingsTabsMeta.ts`）**：
   - 在 `TAB_META` 中的 `models` 标签（[`settingsTabsMeta.ts:120-134`](file:///c:/Software/conex/apps/crish-desktop/src/components/settingsTabsMeta.ts#L120-L134)）补全别名：
     ```typescript
     keywords: [
       '模型', '供应商', '密钥', 'API', 'llm', 'model', 'provider',
       'yaml', 'yml', '配置文件', 'config', 'models.yaml', '直编', '代码'
     ]
     ```
   - 用户在侧栏搜索框（[`SettingsSidebar.tsx:106`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsSidebar.tsx#L106)）输入 `yaml` 或 `配置` 时，光标直达“模型”分类，回车即选定。
2. **侧栏底栏增加“配置目录与文件”快速直达**：
   - 在 [`SidebarFooter.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarFooter.tsx) 或侧栏快捷区增加轻量链接：`“配置目录 (~/.conex)”`，点击直接调用操作系统文件管理器打开该目录。
3. **全局快捷键联动**：
   - 在设置面板内绑定快捷键：`Ctrl+E`（Windows/Linux）或 `Cmd+E`（macOS），在模型页直接触发 YAML 弹窗。

---

### 2.4 外部编辑器直达下拉菜单（Dropdown Menu）设计

点击 `配置文件 (YAML) ▾` 展开的菜单规范：

```
┌──────────────────────────────────────────────┐
│ 配置文件 (models.yaml)                        │
├──────────────────────────────────────────────┤
│ ❐  内置编辑器打开 (Ctrl+E)                   │
├──────────────────────────────────────────────┤
│ 外部编辑器调起                                │
│   Visual Studio Code                        │
│ 󰨞  Cursor                                    │
│ 󰅩  Zed                                       │
│ 📝 Windows 记事本 (Notepad)                   │
│ ↗  系统默认程序打开 (Default App)             │
├──────────────────────────────────────────────┤
│ 📁 在文件资源管理器中定位                      │
│ 📋 复制完整绝对路径                           │
└──────────────────────────────────────────────┘
```

- **动态嗅探状态**：利用 [`hostOpenersApi.ts:listOpenOptionsForFile`](file:///c:/Software/conex/apps/crish-desktop/src/api/hostOpenersApi.ts#L142)，只渲染本机真实检测到的编辑器，若未检测到特定 IDE 则展示“Windows 记事本”与“系统默认关联”，杜绝展示不可用的幽灵菜单项。

---

## 三、内置代码编辑器弹窗交互设计（Built-in YAML Code Editor Modal）

针对无需打开外部臃肿 IDE、希望在 Conex 内快速修改几个参数的场景，设计一套轻量、高响应、具备语法安全防护的内置代码编辑器。

### 3.1 弹窗形态与分层规格

基于系统统一基座 [`components/ui/Dialog/Dialog.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Dialog/Dialog.tsx) 构建：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ [Lucide.FileCode2] 编辑模型能力配置 (models.yaml)                    [已同步●]  [⤢] [✕] │
│ 路径: ~/.conex/models.yaml                                                             │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ [格式化] [恢复默认模版] [重载磁盘] ⏐ 搜索: [      ] (Ctrl+F) ⏐ 外部打开 ▾               │
├──────┬─────────────────────────────────────────────────────────────────────────────────┤
│ 001  │ version: 1                                                                      │
│ 002  │                                                                                 │
│ 003  │ models:                                                                         │
│ 004  │   - model: sensenova-6.8-flash-lite                                             │
│ 005  │     vendor: sensenova                                                           │
│ 006  │     thinkingFormat: thinking_budget                                             │
│ 007  │     thinkingTiers:                                                              │
│ 008  │       low: 1024                                                                 │
│ 009  │       medium: 4096                                                              │
│ 010  │       high: 16384                                                               │
│ ...  │                                                                                 │
├──────┴─────────────────────────────────────────────────────────────────────────────────┤
│ ⚠ 第 14 行: 缩进错误，YAML 映射值不允许使用制表符 (Tab)，请使用 2 个空格                │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ [Schema 校验通过: 18 个模型就绪] ⏐ 第 8 行, 第 12 列            [取消 (Esc)] [保存并热重载]│
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- **尺寸规格**：`variant="modal"`, `size="lg"`, 宽度设为 `min(960px, 92vw)`，高度固定 `82vh`，确保左右两侧代码不因挤压频繁折行；
- **层级管理**：设置弹窗已处全屏层，YAML 编辑器作为子弹窗，层级设为 `--z-modal-nested: 1100`，高于设置主面板；
- **无障碍保障**：
  - `role="dialog"`；
  - `aria-label="模型 YAML 配置文件编辑器"`；
  - 自动将初始焦点（`initialFocusRef`）赋予编辑器文本输入层。

---

### 3.2 高性能双层同步代码编辑器架构（轻量化零依赖实现）

为避免引入数百 KB 的第三方重型库，采用业界经典的**双层无缝重叠架构（Synchronized Dual-Layer Editor）**：

```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│ 外层容器: position: relative; font-family: var(--font-mono, JetBrains Mono, monospace)│
│                                                                                       │
│ ┌────────────────────────┐  ┌───────────────────────────────────────────────────────┐ │
│ │ 行号栏 (Gutter)        │  │ 背景层: <pre><code dangerouslySetInnerHTML=highlight> │ │
│ │ position: sticky; left:0│  │ - 负责高亮颜色渲染、分词颜色、错误波浪线下划线标记    │ │
│ │ 渲染当前可见行号 1..N  │  │ - pointer-events: none; user-select: none;          │ │
│ │ 错误行标红背景高亮     │  ├───────────────────────────────────────────────────────┤ │
│ │                        │  │ 前景层: <textarea spellcheck=false>                    │ │
│ │                        │  │ - 负责捕获用户真实输入、光标选区、键盘事件、输入法    │ │
│ │                        │  │ - color: transparent; caret-color: var(--text-primary)│ │
│ │                        │  │ - 严格对齐 padding, line-height, font-size, letter-sp │ │
│ └────────────────────────┘  └───────────────────────────────────────────────────────┘ │
│                                                                                       │
│ 事件联动: onScroll 监听器保持背景 <pre> 与行号栏 <gutter> 与 <textarea> 像素级同步滚动 │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

#### 关键 CSS 像素对齐不变量
1. 字体必须使用等宽字体：`font-family: var(--font-mono, 'JetBrains Mono', 'Fira Code', Consolas, monospace)`；
2. 文本区域与高亮层共享完全一致的盒模型参数：
   - `line-height: 20px;`（避免使用无单位行高产生子像素四舍五入偏差）；
   - `padding: 12px 16px;`；
   - `tab-size: 2;`；
   - `white-space: pre;`（禁用软折行，避免折行高度计算不一致导致的光标错位）。

---

### 3.3 编码辅助与键盘漫游体验

在 `<textarea>` 包装层注入高阶编码辅助钩子：
1. **智能 Tab 缩进处理**：
   - 监听 `onKeyDown` 中的 `Tab` 键：
     - 单行未选中：阻止默认焦点跳转（`e.preventDefault()`），在当前光标处插入 **2 个标准空格**；
     - 多行选中：按下 `Tab` 将选中的所有行统一向右缩进 2 空格；按下 `Shift+Tab` 统一向左反缩进 2 空格；
   - **绝对禁止插入 `\t`**：YAML 规范严禁在缩进中使用制表符，系统在输入阶段刚性规避。
2. **括号与成对符号自动闭合**：
   - 输入 `'`、`"`、`[`、`{` 时，自动闭合右半部分，并将光标置于中间；
   - 连续输入右符号或在成对符号内按 `Backspace` 时，成对删除。
3. **快捷操作体系**：
   - `Ctrl+S` / `Cmd+S`：触发格式验证并持久化热重载；
   - `Ctrl+F` / `Cmd+F`：激活弹窗内置轻量文本搜索栏；
   - `Ctrl+Z` / `Ctrl+Y`：支持完整的撤销重做栈；
   - `Esc`：若内容被修改（`isDirty === true`），拦截关闭并弹出防丢失确认框；若无修改则安全退出。

---

### 3.4 实时语法校验与行号列号精确定位

配置编辑最怕“改坏了不知道错在哪”。系统提供**毫秒级客户端解析诊断**：

1. **解析管线（Client-side Parser Guard）**：
   - 编辑器内容变动时防抖 150ms，调用轻量 YAML 解析引擎（如 `yaml` npm 包 AST 或基于 Rust WebAssembly / IPC 的快速嗅探）；
   - 提取异常对象中的物理位置：
     ```typescript
     interface YamlDiagnostic {
       line: number;      // 1-indexed
       column: number;    // 1-indexed
       message: string;   // 友好中文解释
       severity: 'error' | 'warning';
     }
     ```
2. **三位一体视觉错误反馈**：
   - **Gutter 标记**：出错行号背景呈现半透明红底（`rgba(239, 68, 68, 0.2)`），并在行号旁渲染红点图标；
   - **代码层波浪线**：背景层在对应列号区域渲染红色波浪线下划线；
   - **底栏错误横幅（Error Banner）**：
     - 在弹窗底栏直接展示：`“⚠ 第 14 行, 第 5 列: 映射键值缺失冒号或缩进不匹配”`；
     - 悬停或点击错误横幅：**光标自动跳转到该行该列**，并将其滚动到编辑器中央可视区域。
3. **硬性保存阻断**：
   - 只要存在语法级错误，右下角 **“保存并热重载”** 按钮禁用（`disabled={hasSyntaxError}`），且 Tooltip 提示具体原因，杜绝将残缺配置刷盘污染运行时。

---

### 3.5 Schema 语义校验与智能防呆

在 YAML 语法正确的基础上，进一步执行业务逻辑约束校验：
1. **`thinkingFormat` 枚举守卫**：
   - 只能为 `reasoning_effort` | `thinking_budget` | `thinking_level` | `null`；若填入其他字符串（如 `thinking_tier`），提示警告；
2. **预算范围守卫**：
   - 若 `thinkingFormat === 'thinking_budget'`，检查 `thinkingBudgetDefault` 必须 ≤ `thinkingBudgetMax`；
   - 且最大预算不得超过 `1000000`（防超大数值导致内存溢出）；
3. **版本唯一性校验**：
   - 检查 `models` 数组中是否存在重复的 `model` 标识，若存在同名键则标记警告。

---

### 3.6 脏状态管理与防丢失保护（Unsaved Changes Guard）

1. **基准哈希对比**：
   - 弹窗载入文件内容时，记录原始文本快照 `originalHash`；
   - 用户编辑时计算实时文本哈希，不等时置 `isDirty = true`；
   - 弹窗标题显示脏状态小圆点（`● 有未保存修改`）；
2. **退出拦截流程**：
   - 当用户按 `Esc`、点击右上角 `✕` 或点击 Backdrop 时：
     - 若 `isDirty === false`：直接无缝退出；
     - 若 `isDirty === true`：拦截退出，弹出二级确认对话框（`ConfirmDialog`）：
       - 标题：“放弃未保存的修改？”；
       - 内容：“你对 models.yaml 的修改尚未保存，退出后更改将丢失。”；
       - 动作：`[继续编辑]`（取消） / `[放弃更改退出]`（确认）。

---

## 四、系统外部编辑器调起与权限拓扑方案（Host Openers Integration）

许多资深开发者更偏爱自己高度定制的 VS Code / Cursor 环境（附带自身的主题、Vim 键绑定、YAML 插件等）。系统必须提供无缝拉起外部 IDE 的能力。

### 4.1 现有 `host_openers` 架构断层修复（白名单路径突破）

如第一章 1.5 节所述，现有 Rust 端的路径安全检查将目标强行限制在工作区根目录内。必须对白名单检查逻辑进行合理解耦与扩充。

#### 现存代码瓶颈（`apps/agent-workbench/src-tauri/src/host_openers/execute.rs:91-93`）
```rust
// 现状：仅以 workspace_root 为单一合法根目录
let workspace = crate::host_paths::workspace_root(&app_dir);
let roots = [workspace.as_path()];
let resolved_target = resolve_open_target_for_roots(&target, &roots).map_err(to_core_error)?;
```

#### 架构扩展方案（配置目录特许白名单）
在 `apps/agent-workbench/src-tauri/src/host_openers/execute.rs` 中，将合法根目录扩展为**双根体系（Dual-Roots System）**：
1. **工作区根（Workspace Root）**：`<workspace_root>`（支持项目私有配置 `<workspace>/.conex/models.yaml`）；
2. **系统配置根（System Config Root）**：用户主目录配置路径 `~/.conex` 与 AppData 路径 `config_dir()`。

```rust
// 修复后设计：允许工作区与用户配置目录并存
let workspace = crate::host_paths::workspace_root(&app_dir);
let user_config_dir = crate::config::persistence::config_dir();
let user_home_conex = dirs::home_dir().map(|h| h.join(".conex")).unwrap_or_default();

let mut allowed_roots = vec![workspace.as_path(), user_config_dir.as_path()];
if user_home_conex.exists() {
    allowed_roots.push(user_home_conex.as_path());
}

let resolved_target = resolve_open_target_for_roots(&target, &allowed_roots).map_err(to_core_error)?;
```

- **安全边界不变量**：
  - 路径依旧执行严苛的 `path.canonicalize()`（防符号链接绕过与 `..` 相对路径穿越）；
  - 路径依旧必须经过 `CommandGatekeeper` 门禁（防元字符注入如 `&`, `|`, `^` 等）。
  - 仅开放特定的配置目录白名单，绝不将系统权限无序放大到整个磁盘。

---

### 4.2 外部编辑器嗅探与优先级排序算法

前端调用 [`hostOpenersApi.ts:listOpenOptionsForFile(modelsYamlPath)`](file:///c:/Software/conex/apps/crish-desktop/src/api/hostOpenersApi.ts#L142) 获取系统可用列表，按以下策略排序与加权：

```
1. 开发者常用 IDE (Weight: 100)
   ├── Visual Studio Code (`vscode`)
   ├── Cursor (`cursor`)
   ├── Zed (`zed`)
   ├── Windsurf (`windsurf`)
   └── Trae (`trae`)
2. 系统原生轻量编辑器 (Weight: 50)
   └── Windows 记事本 / macOS TextEdit / Linux gedit
3. 兜底打开方式 (Weight: 10)
   ├── 系统默认关联程序 (`openPathDefault`)
   └── 资源管理器定位 (`system-file-manager`)
```

- **图标与名称渲染**：
  - 各应用展示清晰的品牌图标与版本名称；
  - 若检测到当前运行在 Windows 环境，自动识别微软官方 `Code.exe` 或 `notepad.exe` 路径。

---

### 4.3 Windows 记事本（Notepad）的直接与精准调起

在某些干净开发机或虚拟机上，用户可能尚未安装 VS Code，此时必须保障 **系统记事本（Notepad）** 的一等公民调起地位：
1. **调起实现机制**：
   - 记事本属于系统内置应用，在 Windows 下位于 `C:\Windows\System32\notepad.exe`；
   - 在 [`apps/agent-workbench/src-tauri/src/host_openers/discovery.rs`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/host_openers/discovery.rs) 中，在 `editor_candidates` 中加入：
     ```rust
     OpenerCandidate {
         id: "system-notepad",
         display_name: "Notepad (记事本)",
         kind: HostOpenerKind::Editor,
         commands: &["notepad.exe", "notepad"],
         known_paths: first_env_path(env_var, &["WINDIR", "SystemRoot"])
             .map(|root| vec![root.join("System32").join("notepad.exe"), root.join("notepad.exe")])
             .unwrap_or_default(),
     }
     ```
2. **调起安全**：
   - 执行参数直接传入 `&[canonical_file_path]`；
   - 避免经过 `cmd.exe /c start` 造成的命令注入，直接通过 Rust `Command::new("notepad.exe").arg(path).spawn()` 拉起。

---

### 4.4 操作系统文件管理器定位（Reveal in File Explorer）

除了直接调起编辑器外，菜单提供 **“在文件资源管理器中定位”**：
- Windows: `explorer.exe /select,"C:\Users\username\.conex\models.yaml"`；
- macOS: `open -R "/Users/username/.conex/models.yaml"`；
- Linux: `dbus-send` 或 `xdg-open` 所在目录；
- 使得用户能够直观看到配置文件所在位置，便于备份、版本控制或分享给团队成员。

---

## 五、实时热重载反馈与持久化双向流动管线（Hot Reload & Persistence Pipeline）

配置修改后，**绝对不需要用户重启客户端**。系统必须具备端到端的实时热更新与双向冲突处理机制。

### 5.1 双向流动架构总览

```
                      ┌─────────────────────────────────┐
                      │    外部编辑器 (VS Code/Notepad)  │
                      └────────────────┬────────────────┘
                                       │ 1. 外部保存 (OS File Write)
                                       ▼
 ┌───────────────────────────────────────────────────────────────────────────────┐
 │                               文件系统真实源                                   │
 │                         ~/.conex/models.yaml                                  │
 └─────────────┬───────────────────────────────────────────────────▲─────────────┘
               │ 2. notify Watcher (防抖 200ms)                     │ 4. 原子写入 (.tmp -> rename)
               ▼                                                   │
 ┌────────────────────────────────────────────────────────┐        │
 │              Rust 热重载引擎 (hot_reload.rs)           │        │
 │  - 指数退避重试 (解决 Windows 独占锁与 0 字节截断)      │        │
 │  - SHA-256 内容指纹比对 (消除重复更新与回音循环)       │        │
 │  - 语法/Schema 容灾校验 (错误隔离，不 panic，不破损旧表)│        │
 │  - 原子指针替换 ArcSwap / Arc<RwLock<ModelCatalog>>    │        │
 └─────────────────────────────┬──────────────────────────┘        │
                               │ 3. Tauri 事件广播                  │
                               │    `catalog:reloaded {version}`   │
                               ▼                                   │
 ┌────────────────────────────────────────────────────────┐        │
 │                 前端响应与呈现层 (React)                │        │
 │                                                        │        │
 │  ┌─────────────────────────┐  ┌──────────────────────┐ │        │
 │  │ Settings UI (模型列表)  │  │ 内置 YAML 代码编辑器 │ │        │
 │  │ - 静默刷新选项卡与档位  │  │ - 若干净: 自动同步   │─┼────────┘
 │  │ - Toast 状态提示        │  │ - 若有脏改动: 冲突横幅│ │ (内建编辑器保存)
 │  └─────────────────────────┘  └──────────────────────┘ │
 └────────────────────────────────────────────────────────┘
```

---

### 5.2 链路 A：内建编辑器保存流程（Internal Save Pipeline）

1. **前端本地预校验**：
   - 用户在弹窗点击 **“保存并热重载”**（或按 `Ctrl+S`）；
   - 前端同步运行 YAML 语法与 Schema 校验；若失败，立刻在界面标红定位，**不发起 IPC 请求**。
2. **Tauri IPC 原子写**：
   - 校验通过后，调用前端 API `saveModelCatalogYaml(content)`；
   - 经 IPC 调用 Rust 后端命令 `workbench_save_models_yaml`；
   - 后端写入机制：采用**原子写两阶段提交**（对齐 [`persistence.rs:65-80`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/config/persistence.rs#L65-L80) 的 tmp + rename 原则）：
     ```rust
     let tmp_path = target_path.with_extension("yaml.tmp");
     std::fs::write(&tmp_path, content)?;
     std::fs::rename(&tmp_path, &target_path)?;
     ```
3. **记录本端写入指纹（Self-Write Fingerprint Suppression）**：
   - 后端在写入时，将计算出的 `SHA-256(content)` 登记到 `last_internal_write_hash`；
   - 随后的文件系统 watcher 探测到 Modify 事件时，对比哈希若一致，**静默忽略**，避免无谓的重复反序列化与回音震荡（Echo Loop）。
4. **即时回馈**：
   - 弹窗保存按钮转为绿色勾选状态：`“✔ 已保存并热重载 (18 个模型)”`，持续 1.5 秒后恢复；
   - 背景中的模型列表页面无缝重刷。

---

### 5.3 链路 B：外部编辑器修改检测流程（External Edit Pipeline）

1. **文件监听与 Windows 独占锁穿透**：
   - 基于 `notify::RecommendedWatcher` 监听目录；
   - 实施红方加固裁决（[`01-红蓝对抗与系统性改进审计.md:47-70`](file:///c:/Software/conex/docs/model-capability/analysis/01-%E7%BA%A2%E8%93%9D%E5%AF%B9%E6%8A%97%E4%B8%8E%E7%B3%BB%E7%BB%9F%E6%80%A7%E6%94%B9%E8%BF%9B%E5%AE%A1%E8%AE%A1.md#L47-L70)）：针对 Windows 平台 VS Code 原地清空（Truncate）引发的 `ERROR_SHARING_VIOLATION (0x20)` 与 0 字节截断读问题，引入**带抖动的指数退避重试**：
     ```rust
     // 10ms -> 20ms -> 40ms -> 80ms -> 160ms (最多 5 次)
     // 确保等待外部编辑器完成 FlushFileBuffers
     ```
2. **原子替换与版本推进**：
   - 解析成功的有效配置在锁外完成全量构建；
   - 获取 `ModelCatalog` 写锁，在 1ms 内完成指针替换，`version += 1` 并立即释放写锁，确保零并发阻塞。
3. **前端多维响应**：
   - 后端通过 Tauri Event 发送 `catalog:reloaded`；
   - 全局各消费端（`thinkingGear.ts`、Composer 胶囊、设置页列表）自动重新拉取，保持单真理源（SSOT）。

---

### 5.4 外部修改与内建编辑器的冲突消解协议（3-Way State Reconciliation）

当用户**在外部 VS Code 正在编辑保存**，同时**Conex 内置 YAML 弹窗正处于打开状态**时，必须有确定性的冲突消解逻辑：

```
                              检测到磁盘文件变更 (外部修改)
                                            │
                             内置 YAML 弹窗是否打开？
                                     ┌──────┴──────┐
                                    是             否
                                     │              │
                           弹窗当前是否有未保存改动？   直接触发全局静默更新
                            (isDirty === true ?)
                              ┌──────┴──────┐
                             否             是
                              │              │
                     【自动平滑拉取】   【呼出冲突横幅 (Conflict Banner)】
                     弹窗内代码原地刷新    - 严禁盲目覆盖用户输入
                     Toast: "已同步最新"   - 提供横向对比选择:
                                           [保留我的修改] / [载入磁盘版本]
```

- **冲突横幅设计**：
  在弹窗顶部浮动显眼警示卡片：
  *“外部编辑器已修改此文件。当前编辑器存在未保存内容。请选择：[保留当前编辑] 或 [使用磁盘最新内容]”*。
  彻底消除开发者代码被后台悄悄冲掉的恐惧。

---

### 5.5 容灾降级机制（Fail-Safe & Graceful Degradation）

外部修改很可能产生手滑错误（如少了一个空格导致 YAML 缩进崩溃）。
1. **旧快照铁律（Last Known Good - LKG）**：
   - 外部 YAML 解析失败时，**绝对禁止清空或污染当前内存 Catalog**；
   - 核心引擎保持现存快照继续提供会话推理能力；
2. **非侵入式告警**：
   - 触发 `catalog:config_error { path, line, column, error }`；
   - 在设置页面顶部及状态栏右下角展示带有黄色感叹号的轻量徽标：
     `“⚠ 外部 models.yaml 语法有误 (第 12 行)，已保留上一次有效配置”`；
   - 点击该告警，直接呼出内置编辑器并自动滚动到第 12 行帮助用户快速修正。

---

## 六、YAML 配置文件规范契约（Configuration Contracts）

### 6.1 配置文件定位与层级

统一遵循规范：
- **全局用户配置**：`~/.conex/models.yaml`（开发者全局首选，多工作区共享）；
- **工作区项目配置**：`<workspace_root>/.conex/models.yaml`（团队代码库入库配置，覆盖全局同名模型）；
- **后向兼容**：若用户目录存在历史 `models.json`，系统自动探测并支持一键迁移/导出为 YAML。

---

### 6.2 `models.yaml` 终极规范范本

```yaml
# ==============================================================================
# Conex / Crish - 模型能力与通用思考参数配置文件
# 规范版本: v3.0
# 说明: 修改本文件保存后，客户端将实时热重载生效，无需重启应用。
# ==============================================================================

version: 1

# ------------------------------------------------------------------------------
# 1. 默认与全局偏好
# ------------------------------------------------------------------------------
defaults:
  thinkingLevel: "Medium"          # 默认新建会话思考等级: Off | Minimal | Low | Medium | High | X-High
  temperature: 0.7

# ------------------------------------------------------------------------------
# 2. 模型能力与思考参数覆盖列表
# ------------------------------------------------------------------------------
models:
  # 示例 1: 商汤日日新 (SenseNova 6.8 Flash Lite) - Token 预算模式
  - model: "sensenova-6.8-flash-lite"
    vendor: "sensenova"
    displayName: "SenseNova 6.8 Flash"
    contextWindow: 262144
    maxOutputTokens: 16384
    # 思考形态: thinking_budget (整数 Token)
    thinkingFormat: "thinking_budget"
    thinkingBudgetDefault: 2048
    thinkingBudgetMax: 32768
    thinkingTiers:
      minimal: 512
      low: 1024
      medium: 4096
      high: 16384

  # 示例 2: 开发者私有微调模型 (Muse Spark 1.3 Contributor) - 字符串档位模式
  - model: "muse-spark-1.3-contributor"
    vendor: "muse"
    displayName: "Muse Spark 1.3"
    contextWindow: 131072
    maxOutputTokens: 8192
    # 思考形态: reasoning_effort (low / medium / high)
    thinkingFormat: "reasoning_effort"
    thinkingTiers:
      low: "low"
      medium: "medium"
      high: "high"

  # 示例 3: 谷歌 Gemini 3.8 Flash - 高性能超长上下文
  - model: "gemini-3.8-flash"
    vendor: "google"
    displayName: "Gemini 3.8 Flash"
    contextWindow: 1048576
    maxOutputTokens: 65536
    thinkingFormat: "thinking_budget"
    thinkingBudgetDefault: 4096
    thinkingBudgetMax: 65536
    thinkingTiers:
      minimal: 1024
      low: 2048
      medium: 8192
      high: 32768
      x-high: 65536

  # 示例 4: 传统快速模型 - 无思考能力
  - model: "gpt-4o-mini"
    vendor: "openai"
    displayName: "GPT-4o Mini"
    contextWindow: 128000
    maxOutputTokens: 16384
    thinkingFormat: null           # 无思考参数，前端将自动收拢思考胶囊

  # 示例 5: DeepSeek R1 - 强推理模型 (固定深度思考)
  - model: "deepseek-reasoner"
    vendor: "deepseek"
    displayName: "DeepSeek R1"
    contextWindow: 65536
    maxOutputTokens: 8192
    thinkingFormat: "reasoning_effort"
    thinkingTiers:
      default: "high"
```

---

### 6.3 `providers.yaml` 服务商解耦方案与 DPAPI 契约

为兼顾灵活性与安全性，服务商配置与敏感密钥做解耦设计：
1. **非敏感参数入 YAML**（`~/.conex/providers.yaml`）：
   ```yaml
   version: 1
   providers:
     - id: "custom-deepseek"
       name: "DeepSeek 官方"
       baseUrl: "https://api.deepseek.com/v1"
       endpoint: "chat-completions"
       stream: true
       apiKeyEnv: "DEEPSEEK_API_KEY"   # 优先引用环境变量
   ```
2. **敏感密钥安全落槽（DPAPI）**：
   - 严禁直接将明文 API Key 强求用户写在 YAML 中（避免版本控制意外泄漏）；
   - 用户仍可在设置 UI 的密码框输入，由 Rust 存入 `secrets/{id}.dpapi`；
   - YAML 中提供 `apiKeyEnv` 选项，开发者可在系统环境变量或 `.env` 中声明，无缝兼顾 CI/CD 与多环境切换。

---

## 七、立体验证与验收测试矩阵（Verification & Quality Assurance）

按照 `AGENTS.md` §7.1 立体验证纪律，本方案实施必须满足以下验收断言：

### 7.1 单元测试与语法诊断断言（Unit Tests）

| 测试用例 ID | 测试目标 | 输入条件 | 预期断言 |
| :--- | :--- | :--- | :--- |
| **UT-YAML-01** | YAML 缩进 Tab 拦截 | 包含 `\t` 缩进的文本 | 校验引擎报告 `SyntaxError`，精准标记行号，保存按钮被刚性禁用 |
| **UT-YAML-02** | 行列坐标计算准确性 | 在第 14 行第 8 列制造冒号缺失 | 错误指示器聚焦于 line: 14, col: 8，红波浪线精准定位 |
| **UT-YAML-03** | 脏状态状态机切换 | 编辑器键入字符后又撤销还原 | `isDirty` 正确在 `false -> true -> false` 状态间无延迟转移 |
| **UT-YAML-04** | 思考档位 Schema 约束 | `thinkingFormat: "unknown_tier"` | 产生警告诊断，提示可选枚举值，不阻断合法字段生效 |
| **UT-YAML-05** | YAML <-> JSON 双向保真 | 标准 models 数据往返转换 | 关键字段 `thinkingTiers`、`contextWindow` 无精度丢失或命名漂移 |

---

### 7.2 主机打开器与白名单突破集成测试（Integration Tests）

| 测试用例 ID | 测试目标 | 输入条件 | 预期断言 |
| :--- | :--- | :--- | :--- |
| **IT-OPEN-01** | 用户配置目录合法放行 | 调用 `openWithHostOpener("vscode", "~/.conex/models.yaml")` | Rust 后端放行，VS Code 正常拉起该文件，零 PermissionDenied |
| **IT-OPEN-02** | 越界敏感路径硬拦截 | 试图传参 `C:\Windows\System32\cmd.exe` | 触发门禁拦截，抛出 `host-open-target-outside-workspace` |
| **IT-OPEN-03** | 元字符注入防御 | 路径包含 `models.yaml & calc.exe` | 被 `CommandGatekeeper` 拦截，抛出 `PermissionDenied` |
| **IT-OPEN-04** | Windows 记事本调起 | 选用 `system-notepad` 打开目标 | `notepad.exe` 进程启动，无命令行二次解释弹窗 |
| **IT-OPEN-05** | 默认程序 ShellExecuteW | 调用 `openPathDefault(modelsYamlPath)` | 经 Windows API `ShellExecuteW` 打开，返回 ok: true |

---

### 7.3 并发写与热重载现场验收测试（E2E / Stress Tests）

| 测试用例 ID | 测试目标 | 执行操作 | 预期断言 |
| :--- | :--- | :--- | :--- |
| **E2E-RELOAD-01**| 外部 VS Code 保存热更 | VS Code 中修改 `thinkingBudgetDefault: 8192` 并保存 | 200ms 内触发 `catalog:reloaded`，UI 思考档位无刷新更新 |
| **E2E-RELOAD-02**| Windows 独占锁截断容错 | 模拟编辑器保存瞬间产生 0 字节阶段读（Sharing Violation）| Rust 指数退避重试成功，无 panic，无 0 字节反序列化报错 |
| **E2E-RELOAD-03**| 坏配置隔离与软着陆 | 外部文件故意删除闭合引号保存 | 内存 Catalog 保持完好，前端展示黄色弱告警，当前会话零崩溃 |
| **E2E-RELOAD-04**| 内建编辑与外部并发修改 | 弹窗正输入时，外部文件被修改 | 弹窗弹出冲突解决横幅，不静默冲掉用户输入的未落盘内容 |
| **E2E-RELOAD-05**| 回音循环抑制 | 内建编辑器点击保存并热重载 | 文件落盘后，SHA-256 判定为本端发起，不再触发二次重复加载循环 |

---

### 7.4 UI 无障碍与键盘漫游测试

- **Focus Trap**：弹窗打开后，键盘 `Tab` 漫游严格在弹窗内各操作按钮与编辑器之间循环，绝对无法穿透到被覆盖的设置背景页；
- **Esc 阶梯返回**：
  1. 若搜索栏激活，先清空搜索栏；
  2. 若处于代码编辑未修改态，直接关闭代码弹窗，焦点归还给触发按钮（`useRestoreFocus`）；
  3. 若有未保存内容，激活确认弹窗，`Esc` 取消退出，回车确认放弃。

---

## 八、总结与实施里程碑（Implementation Roadmap）

本方案彻底厘清了用户批评的技术根因，穿透了前端设置页、弹窗、代码高亮组件与 Rust 壳层宿主能力：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                   四阶段落地里程碑                                     │
├─────────────────┬─────────────────┬──────────────────┬─────────────────────────────────┤
│ Phase 1: 权限解耦│ Phase 2: 交互入口│ Phase 3: 内置编辑 │ Phase 4: 热更协同               │
│ (Rust 壳层)     │ (React 设置页)  │ (Dialog 弹窗)    │ (端到端收网)                    │
├─────────────────┼─────────────────┼──────────────────┼─────────────────────────────────┤
│ - execute.rs 扩充│ - ModelsSettings│ - 双层同步容器   │ - notify watcher 接入           │
│   双根白名单    │   增加 YAML 组合 │ - highlight.js   │ - 指数退避防争用               │
│ - discovery.rs  │   下拉按钮       │   yaml 高亮集成   │ - SHA-256 抑震荡                │
│   补齐 notepad  │ - 侧栏搜索别名补齐│ - 行号与错误定位 │ - 冲突横幅与 LKG 容灾降级       │
└─────────────────┴─────────────────┴──────────────────┴─────────────────────────────────┘
```

通过此方案的实施，用户不仅能获得**直达 `models.yaml` 的清晰按钮**，更能享受在**内置轻量编辑器秒开**与**一键调起 VS Code / 记事本**之间的自由切换，彻底化解用户的负面评价，将 Conex 的模型能力配置体验拉升至现代专业开发者工具的第一梯队。
