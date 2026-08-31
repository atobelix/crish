# “代码产物”/文件管理器根目录绑定错误与面包屑弹出面板透明失效严苛审计报告

> **报告版本**：v1.0.0  
> **审计日期**：2026-08-30  
> **审计责任域**：工作区文件系统架构、视图注册中心（ViewRegistry）、项目状态机（ProjectStore/WorkspaceStore）、面包屑导航与浮层层叠上下文（Stacking Context）  
> **用户诉求与核心审计指令**：
> 1. **Tab 标题命名与语义混乱**：用户强烈反馈：“*代码产物这又是什么玩意，不就是文件管理器吗*”；排查为何工作区 Tab 显示为“代码产物”，而不是统一的“文件”或“文件管理器”；
> 2. **项目根目录绑定错误（为什么显示 `--version`）**：用户反馈：“*而且现在就算我点击了带有路径的项目，这里显示的还是不是当前项目的根目录下的目录呢*”（截图显示根目录居然为 `--version` / `.agent-outputs` 等！）；追踪为什么文件树列出的不是用户当前项目的真实工作区根目录（如 `c:/Software/conex`），而是错误地列出了未知路径或 `--version` 参数；
> 3. **面包屑弹出面板透明与无法操作**：用户反馈：“*点击上面的面包屑导航，显示的面板我也不知道是哪里的，而且里面的东西无法执行任何操作，以及这个展开面板也是透明的*”；检查 `FileBreadcrumb` 弹出的浮层样式（是否有未定义 z-index 导致穿透、背景色失效）、为何点击条目无法执行操作、为何定位与内容脱节。
>
> **核心审计范围**：
> - [`apps/crish-desktop/src/components/files/FilesCard.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.tsx) & [`FilesCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.module.css)
> - [`apps/crish-desktop/src/components/files/FileBreadcrumb.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FileBreadcrumb.tsx)
> - [`apps/crish-desktop/src/components/files/FileTreeView.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FileTreeView.tsx)
> - [`apps/crish-desktop/src/components/files/hooks/useFileNavigation.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/hooks/useFileNavigation.ts)
> - [`apps/crish-desktop/src/components/files/hooks/useFilePreview.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/hooks/useFilePreview.ts)
> - [`apps/crish-desktop/src/api/workspaceFsApi.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/workspaceFsApi.ts) & [`projectStore.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/projectStore.ts)
> - [`apps/crish-desktop/src/services/view-registry/registerBuiltInViews.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/services/view-registry/registerBuiltInViews.tsx)
> - [`apps/crish-desktop/src/components/binary-tree/SidePanelLauncherHub.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/SidePanelLauncherHub.tsx)
> - [`apps/crish-desktop/src/components/chat-card/UnitChromeActions.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/UnitChromeActions.tsx) & [`unitChromeTools.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/unitChromeTools.ts)
> - [`apps/crish-desktop/src/components/sidebar/session-list/ProjectsSection.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/ProjectsSection.tsx)
> - [`apps/crish-desktop/src/styles/z-index.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/z-index.css) & [`tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css)

---

## 目录

1. [执行摘要与审计结论](#1-执行摘要与审计结论)
2. [Tab 标题命名与“代码产物”概念错位深度审查](#2-tab-标题命名与代码产物概念错位深度审查)
   - 2.1 [命名混乱证据链与多源割裂](#21-命名混乱证据链与多源割裂)
   - 2.2 [“代码产物” vs “文件管理器”的语义错位根因](#22-代码产物-vs-文件管理器的语义错位根因)
3. [项目根目录绑定机制与“`--version` 首项”深度排查](#3-项目根目录绑定机制与--version-首项深度排查)
   - 3.1 [物理目录真实状态与“首项误解”还原](#31-物理目录真实状态与首项误解还原)
   - 3.2 [致命缺陷：树组件缺失项目根容器（Root Container）Header](#32-致命缺陷树组件缺失项目根容器root-container-header)
   - 3.3 [面包屑根芯片过度抽象化（“项目”二字失真）](#33-面包屑根芯片过度抽象化项目二字失真)
   - 3.4 [侧边栏项目点击与工作区绑定状态机脱节（点击文件夹不激活 cwd）](#34-侧边栏项目点击与工作区绑定状态机脱节点击文件夹不激活-cwd)
4. [面包屑弹出面板透明、操作失效与定位脱节深度审查](#4-面包屑弹出面板透明操作失效与定位脱节深度审查)
   - 4.1 [严重 CSS 缺陷：未定义的 `--z-breadcrumb` 与 `--z-card-footer`](#41-严重-css-缺陷未定义的---z-breadcrumb-与---z-card-footer)
   - 4.2 [操作失效根因：点击子目录导致 Flyout 瞬灭卸载（React 渲染条件失步）](#42-操作失效根因点击子目录导致-flyout-瞬灭卸载react-渲染条件失步)
   - 4.3 [非 Portal 挂载与容器剪裁（Boundary Clipping）](#43-非-portal-挂载与容器剪裁boundary-clipping)
   - 4.4 [无根浮层与路径脱节（“显示的面板我也不知道是哪里的”）](#44-无根浮层与路径脱节显示的面板我也不知道是哪里的)
5. [现代化文件管理器与面包屑弹层重构方案设计](#5-现代化文件管理器与面包屑弹层重构方案设计)
   - 5.1 [概念与文案单一真源（SSOT）归一方案](#51-概念与文案单一真源ssot归一方案)
   - 5.2 [文件树“项目根头部”与隐藏文件过滤策略](#52-文件树项目根头部与隐藏文件过滤策略)
   - 5.3 [项目切换与全局 cwd 双向响应式联动闭环](#53-项目切换与全局-cwd-双向响应式联动闭环)
   - 5.4 [基于 Radix Popover / Floating Portal 的面包屑多级下钻浮层](#54-基于-radix-popover--floating-portal-的面包屑多级下钻浮层)
6. [数据流、DOM 结构与样式改造全景清单](#6-数据流dom-结构与样式改造全景清单)
   - 6.1 [视图注册与顶部动作栏改造清单](#61-视图注册与顶部动作栏改造清单)
   - 6.2 [面包屑浮层状态机与 DOM 重构前后对比](#62-面包屑浮层状态机与-dom-重构前后对比)
   - 6.3 [CSS Module 补全与 z-index 规范化清单](#63-css-module-补全与-z-index-规范化清单)
7. [实施清单与回归断言防线](#7-实施清单与回归断言防线)

---

## 1. 执行摘要与审计结论

在对 Conex / Crish 桌面端“文件管理器/代码产物”模块及其上下游链路进行全量深层审计后，我们确认用户提出的三大问题均有**确凿的代码缺陷、架构设计割裂及样式层叠断裂证据**。

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│               Conex / Crish “代码产物” / 文件管理器三维缺陷全景图                       │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  [1. 命名割裂]                                                                         │
│  registerBuiltInViews: title='代码产物' (Icon: FileCode)   <-- 🚨 违背“文件管理器”实质 │
│  unitChromeTools:      label='打开文件' (Icon: FolderTree) <-- 🚨 称呼各异             │
│  SidePanelLauncher:    '代码产物与文件'                    <-- 🚨 概念杂交             │
│                                                                                        │
│  [2. 根目录与树呈现缺陷]                                                               │
│  c:/Software/conex 下存在孤儿物理目录 "--version" + ".agent-outputs"                   │
│  FileTreeView 缺失项目根 Header (conex) -> 扁平排序首行渲染 "--version"               │
│  FileBreadcrumb 根节点硬编码为 "项目" -> 用户误以为系统将 CLI 参数 "--version" 绑定为根│
│  ProjectsSection 点击项目条目仅折叠 UI，未调用 openProject 激活工作区路径               │
│                                                                                        │
│  [3. 面包屑 Flyout 坍塌]                                                               │
│  FilesCard.module.css: z-index: var(--z-breadcrumb); <-- 🚨 变量未定义 (回落 auto)     │
│  filesBar:             z-index: var(--z-card-footer); <-- 🚨 变量未定义 (回落 auto)     │
│  FileBreadcrumb.tsx:   flyOpen = (bcFlyout.path === b.path)                            │
│                        点击子目录触发 openBcFlyout(ent.path) -> b.path 匹配失效 -> 瞬灭│
│                        未接入 Radix Portal -> 挂在 140px max-width 节点下遭截断        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 核心审计结论：
1. **命名与语义严重脱节**：系统将一个**全功能本地工作区文件浏览器**（包含完整目录树浏览、多格式文件预览、文本/代码行级内联编辑、Git 状态标记、外部应用拉起、新建与删除）命名为“代码产物”，图标使用单文件图标 `FileCode`，严重违背业界通识，误导用户将其与只读会话输出产物（如 Claude Artifacts）混淆。必须全面归一为**“文件”**（Tab 标题 / 快捷图标）与**“文件管理器”**（完整面板名称），图标统一为 `FolderTree`。
2. **“`--version` 根目录”误会的双重根因**：
   - 本地工作区 `c:/Software/conex` 根目录下确实存在一个名为 `--version` 的物理目录（开发期工具或 CLI 命令失误生成），且包含 `.agent-outputs`、`.agent-runtime` 等内部运行期目录；
   - `FileTreeView` **完全没有像 VS Code 或专业 IDE 那样在树顶部渲染一个项目根容器 Header**（如 `📁 conex  c:/Software/conex`），而是直接把子条目作为第一层展开；
   - `FileBreadcrumb` 将根目录抽象为模糊的“项目”二字，没有展示真实文件夹名。当用户看到第一行赫然写着 `--version` 时，必然得出“系统把 `--version` 参数当成了根目录绑定”的错误直觉。
   - `ProjectsSection.tsx` 中点击项目行只触发展开折叠，未调用 `openProject`，导致工作区路径无法即时绑定。
3. **面包屑浮层透明穿透与点击失效的致命代码缺陷**：
   - **样式穿透与透明**：`FilesCard.module.css` 中的 `var(--z-breadcrumb)` 和 `var(--z-card-footer)` 在全工程中根本**未定义**，导致 z-index 失效回落为 `auto`，浮层被下层 `FileTreeView` / 编辑器及合成层遮挡或半透明混合；
   - **交互彻底瘫痪（瞬灭）**：`FileBreadcrumb.tsx` 依靠 `flyOpen = bcFlyout?.path === b.path` 控制浮层挂载。当用户在浮层中点击子目录时，`bcFlyout.path` 变为子目录路径，而子目录并不在当前的 `breadcrumbs` 面包屑数组中，导致 `flyOpen` 立即变为 `false`，浮层在点击瞬间被 React 强制卸载销毁，造成“里面无法执行任何操作”的假死现象；
   - **缺乏 Portal 与路径指引**：浮层未挂载至 Portal，受限于父级容器 `max-width: 140px`，且弹层头部没有任何当前物理路径指引，导致用户“不知道是哪里的面板”。

---

## 2. Tab 标题命名与“代码产物”概念错位深度审查

### 2.1 命名混乱证据链与多源割裂

在代码库中检索文件管理器相关的视图注册与入口组件，存在严重的同物异名与概念杂交现象：

| 模块 / 文件路径 | 当前代码命名 | 图标 (Icon) | 预期规范命名 | 缺陷性质 |
| :--- | :--- | :--- | :--- | :--- |
| [`registerBuiltInViews.tsx:101`](file:///c:/Software/conex/apps/crish-desktop/src/services/view-registry/registerBuiltInViews.tsx#L101) | `title: '代码产物'` (注释: `// 5. 文件管理器 (Tool)`) | `FileCode` (单代码文件图标) | `title: '文件'` / `文件管理器` (Icon: `FolderTree`) | 🚨 视图注册中心单真源失真，注释与代码冲突 |
| [`SidePanelLauncherHub.tsx:49`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/SidePanelLauncherHub.tsx#L49) | `launcherCardTitle: '代码产物与文件'` | `FileCode` | `launcherCardTitle: '文件'` | 🚨 左右摇摆的杂交命名，加剧认知负担 |
| [`UnitChromeActions.tsx:362`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/UnitChromeActions.tsx#L362) | `aria-label="打开代码产物与文件"` / `topQuickArtifactsBtn` | `FileCode` | `aria-label="打开文件"` / `topQuickFilesBtn` | 🚨 DOM 测试 ID 与可访问性文本错位 |
| [`unitChromeTools.ts:22`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/unitChromeTools.ts#L22) | `label: '打开文件'` | `FolderTree` (正确) | `label: '打开文件'` (保持一致) | ⚠️ 与 ViewRegistry 的“代码产物”不一致 |
| [`layoutSerializer.test.ts:48`](file:///c:/Software/conex/apps/crish-desktop/src/utils/layoutSerializer.test.ts#L48) | `cards: [{ id: 'files', title: '文件' }]` | - | `title: '文件'` | ⚠️ 单测断言为“文件”，运行时却为“代码产物” |

#### 代码证据 1：[`registerBuiltInViews.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/services/view-registry/registerBuiltInViews.tsx#L98-L105)
```typescript
  // 5. 文件管理器 (Tool)  <-- 注释清晰写着文件管理器
  viewRegistry.registerView({
    id: 'files',
    title: '代码产物',     // <-- 🚨 注册的 Tab 标题却是“代码产物”！
    icon: FileCode,         // <-- 🚨 图标使用了 FileCode 而非文件夹图标
    category: 'tool',
    component: factories['files']?.() ?? fallbackComponent,
  });
```

#### 代码证据 2：[`SidePanelLauncherHub.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/SidePanelLauncherHub.tsx#L48-L53)
```tsx
  <span className={`${styles.launcherCardTitle} launcher-card-title`}>
    代码产物与文件  {/* 🚨 强行将两个概念缝合 */}
  </span>
  <span className={styles.launcherCardDesc}>
    浏览会话生成的文件、差异与产物 {/* 🚨 描述严重缩小了功能范畴，让人以为只是输出产物 */}
  </span>
```

### 2.2 “代码产物” vs “文件管理器”的语义错位根因

1. **历史遗留与概念剽窃**：
   - 早期版本可能设想只展示当前 Agent 生成的 diff/patch 或临时 outputs（受 Claude 3.5 Artifacts 概念影响）；
   - 但后续演进中，[`FilesCard.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.tsx) 接入了 `workspaceFsApi`（`listDirectory`, `readTextFile`, `writeTextFile`, `openPathDefault`）、Git 状态指示（`gitStatusMap`）、双栏预览/编辑器（`FileTreeView` + `FilePreview` / `FileEditor`）；
   - 它已经实质上成为了**工作区的全功能文件管理器（File Explorer）**，涵盖了项目内任意源码、文档、配置、图片的读写操作，而绝非仅仅是“AI 输出的代码产物”。
2. **用户认知阻抗**：
   - 用户打开 Tab 期望看到的是类似 VS Code Explorer 的“文件树/文件管理器”；
   - 界面上方却挂着“代码产物”，用户潜意识会产生怀疑：“*为什么我的项目源码被叫做代码产物？*”、“*难道这里只能看 AI 吐出来的文件，我看不到自己写的文件吗？*”；
   - 一旦文件树首行显示了 `.agent-outputs` 或 `--version`，用户更加坐实了这种错觉，误认为这是某个内部产物输出管道的专属面板。

---

## 3. 项目根目录绑定机制与“`--version` 首项”深度排查

### 3.1 物理目录真实状态与“首项误解”还原

用户截图反映：“*即使我点击了带有路径的项目，这里显示的还是不是当前项目的根目录下的目录呢。（显示 `--version` / `.agent-outputs` 等）*”。

我们通过本地文件系统工具对当前项目根目录 `c:/Software/conex` 执行 `list_dir`，排查结果如下：

```
c:/Software/conex/ (物理根目录扫描结果)
├── --version/              <-- [物理目录] 真实存在！(isDir: true)
├── .agent-outputs/         <-- [物理目录] 运行期 Agent 产出根 (isDir: true)
├── .agent-runtime/         <-- [物理目录] 运行期内部数据 (isDir: true)
├── .agent-tmp-agents...    <-- [物理文件] 临时文件
├── .agents/                <-- [物理目录]
├── .cargo/                 <-- [物理目录]
├── .git/                   <-- [物理目录]
├── AGENTS.md               <-- [物理文件]
├── apps/                   <-- [业务源码目录]
├── crates/                 <-- [业务源码目录]
└── packages/               <-- [业务源码目录]
```

#### 根因剖析：
1. **真实物理目录污染**：
   - 在项目历史上，某些测试脚本、构建脚本或终端命令在执行诸如 `mkdir --version` 或将命令参数错位传入路径参数时，在 `c:/Software/conex` 根目录下物理创建了一个名为 `--version` 的真实文件夹。
2. **ASCII 排序导致置顶**：
   - 在 ASCII 字符集中，`-` (ASCII 45) 和 `.` (ASCII 46) 排在数字和英文字母之前；
   - `listDirectory` 与 `useFileNavigation` 按照文件名标准字母排序，未对以 `-` 或 `.` 开头的隐藏/异常目录做默认折叠或过滤，导致 `--version` 赫然成为整个文件列表的**第 1 项**，`.agent-outputs` 成为第 2 项。

### 3.2 致命缺陷：树组件缺失项目根容器（Root Container）Header

专业 IDE（如 VS Code、Cursor、WebStorm）的文件资源管理器树结构如下：

```
▼ 📁 CONEX  c:/Software/conex          <-- [权威项目根 Header]
  ▶ 📁 apps
  ▶ 📁 crates
  ▶ 📁 docs
  ▶ 📁 packages
    📄 AGENTS.md
    📄 package.json
```

然而，查看 [`FileTreeView.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FileTreeView.tsx#L238-L337)：

```tsx
// FileTreeView.tsx:238
{visibleItems.map((e, index) => {
  // 🚨 缺陷：直接将 root 下的直接子条目平铺渲染为 depth: 0 / aria-level: 1！
  // 根本没有渲染带有“项目名 (如 conex) + 根路径”的树顶根节点！
  return (
    <div
      key={e.path}
      className={styles.filesRow}
      style={{ paddingLeft: 4 + e.depth * 10 }}
      role="treeitem"
      aria-level={e.depth + 1}
    >
      ...
      <span className={styles.filesRowName}>{e.name}</span>
    </div>
  );
})}
```

#### 视觉误导链条：
- 树的顶部没有 `📁 conex` 这个根节点；
- 列表第一行直接就是 `📁 --version`；
- 用户一眼看过去，会理所当然地把第一行的 `--version` 当作当前文件树的“根”，进而愤怒地得出结论：“*为什么我选的项目根目录变成了 `--version`？是不是系统把我之前敲的 `--version` 参数当作目录名了？*”

### 3.3 面包屑根芯片过度抽象化（“项目”二字失真）

查看 [`FileBreadcrumb.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FileBreadcrumb.tsx#L88-L111)：

```typescript
// FileBreadcrumb.tsx:95
const items: BreadcrumbItem[] = [{ label: '项目', path: root }]; // 🚨 硬编码 label: '项目'
if (rel && rel !== '.') {
  let acc = root;
  for (const part of rel.replace(/\\/g, '/').split('/').filter(Boolean)) {
    acc = joinLocal(acc, part);
    items.push({ label: part, path: acc });
  }
}
```

- 面包屑最左侧的芯片被硬编码为 **“项目”** 两个中文字，而不是当前项目文件夹的真实名称（如 `conex`）或绝对路径（`c:/Software/conex`）；
- 用户从面包屑上也完全得不到“我当前处于 `conex` 根目录下”的确认感。

### 3.4 侧边栏项目点击与工作区绑定状态机脱节（点击文件夹不激活 cwd）

查看 [`ProjectsSection.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/ProjectsSection.tsx#L129-L163)：

```tsx
// ProjectsSection.tsx:129
<button
  type="button"
  className={styles.folderHeader}
  aria-expanded={open}
  onClick={() => {
    onToggleProjectCollapsed(p.id); // 🚨 仅切换折叠态，并未调用 openProject(p.id)！
  }}
>
  <Folder size={16} />
  <span className={styles.folderName}>{p.name}</span>
</button>
<Tooltip content="在此项目新建对话">
  <Button
    onClick={(e) => {
      e.stopPropagation();
      openProject(p.id); // 🚨 只有点击这个细小的右侧新建按钮，才会真正 openProject 并写入 localStorage！
      ...
    }}
  />
</Tooltip>
```

#### 状态机脱节漏洞：
1. 用户在侧边栏的项目列表中，点击项目名称或文件夹图标，心理预期是“**切换并选中该项目作为当前活动项目**”；
2. 但代码实现中，点击整行仅触发了 UI 上的折叠/展开（`onToggleProjectCollapsed`），**完全没有调用 `openProject(p.id)`**；
3. 结果是：`localStorage.getItem('crish_workspace')` 并没有更新为该项目的路径，`window.dispatchEvent(new CustomEvent('crish-project-changed'))` 也没有触发；
4. 用户看着侧边栏以为自己已经选中了新项目，切换到文件管理器一看，内容依然停留在上一个项目或历史根目录下，加剧了“根目录绑定错误”的感知。

---

## 4. 面包屑弹出面板透明、操作失效与定位脱节深度审查

用户反馈：“*点击上面的面包屑导航，显示的面板我也不知道是哪里的，而且里面的东西无法执行任何操作，以及这个展开面板也是透明的。*”

### 4.1 严重 CSS 缺陷：未定义的 `--z-breadcrumb` 与 `--z-card-footer`

查看 [`FilesCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.module.css#L50-L335)：

```css
/* FilesCard.module.css:50 */
.filesBar {
  ...
  z-index: var(--z-card-footer); /* 🚨 未定义！ */
}

/* FilesCard.module.css:98 */
.filesCrumbs {
  ...
  z-index: var(--z-card-footer); /* 🚨 未定义！ */
}

/* FilesCard.module.css:331 */
.filesBcFlyout {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: var(--z-breadcrumb);  /* 🚨 未定义！ */
  width: min(320px, 70vw);
  max-height: min(52vh, 400px);
  display: flex;
  flex-direction: column;
  padding: var(--space-2);
  border-radius: var(--radius-2xl);
  border: 1px solid var(--border-subtle);
  background: var(--bg-elevated, var(--bg-primary));
  box-shadow: var(--shadow-lg, 0 12px 28px rgba(0, 0, 0, 0.1));
  white-space: normal;
}
```

再查看全系统权威 z-index 定义文件 [`styles/z-index.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/z-index.css#L1-L28)：

```css
:root {
  --z-base: 0;
  --z-dock: 10;
  --z-sticky: var(--z-dock);
  --z-chrome: 100;
  --z-sidebar: var(--z-chrome);
  --z-resizer: var(--z-chrome);
  --z-dropdown: 300;
  --z-popover: 500;
  --z-drawer: var(--z-popover);
  --z-modal: 1000;
  --z-toast: var(--z-modal);
  --z-tooltip: 9000;
  /* 🚨 根本没有任何 --z-breadcrumb 或 --z-card-footer！ */
}
```

#### 层叠上下文破坏机制：
1. 当 CSS 属性 `z-index: var(--z-breadcrumb)` 遇到未声明的变量时，该声明无效，回落为 **`z-index: auto`**；
2. `.filesBar` 与 `.filesCrumbs` 的 `z-index: var(--z-card-footer)` 同样回落为 **`z-index: auto`**；
3. 下方的 `FileTreeView`（内含虚拟滚动容器、绝对定位行、Sticky 错误横条 `z-index: var(--z-pinned-bar)`）以及右侧的 `FilePreview`（内含 iframe / Markdown / 代码高亮）在 DOM 顺序上紧随其后；
4. 缺少有效 `z-index` 的 `.filesBcFlyout` 在渲染层级上与下方的滚动树、文字、边框产生严重的**层叠穿透**。当用户看到弹层下的文字和背景透过弹层显露出来时，直观感受就是“**这个展开面板也是透明的**”，且鼠标点击经常被下层更高层叠优先级的 DOM 截获。

### 4.2 操作失效根因：点击子目录导致 Flyout 瞬灭卸载（React 渲染条件失步）

这是导致用户反馈“*里面的东西无法执行任何操作*”的核心 Bug！

#### 代码追踪：
在 [`FileBreadcrumb.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FileBreadcrumb.tsx#L196-L235)：

```tsx
// FileBreadcrumb.tsx:196
breadcrumbs.map((b, i) => {
  const canNav = !b.isFile;
  // 🚨 条件 1：只有当遍历到的面包屑项 b.path 与当前 bcFlyout.path 严格相等时，才渲染浮层！
  const flyOpen = bcFlyout?.path === b.path;

  return (
    <span className={styles.filesBcSeg} key={`${b.path}-${i}`}>
      <button
        onClick={(e) => {
          bcTriggerRef.current = e.currentTarget;
          void openBcFlyout(b.path, b.label); // 打开某一层面包屑的浮层
        }}
      >
        {b.label}
      </button>

      {flyOpen && bcFlyout ? (
        <div className={styles.filesBcFlyout} role="listbox">
          ...
          {bcFlyoutFiltered.map((ent) => (
            <button
              key={ent.path}
              onClick={() => {
                if (ent.isDir) {
                  // 🚨 致命逻辑：用户点击了浮层列表中的一个子文件夹！
                  void openBcFlyout(ent.path, ent.name); // 1. 将 bcFlyout.path 改为 ent.path
                  void onRefresh(ent.path);              // 2. 异步刷新
                } else {
                  ...
                }
              }}
            >
              {ent.name}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
})
```

#### 致命时序推导：
```
1. 初始状态：cwd = 'c:/Software/conex'，breadcrumbs = [{ label: '项目', path: 'c:/Software/conex' }]
2. 用户点击面包屑上的 "项目" -> openBcFlyout('c:/Software/conex', '项目')
   -> bcFlyout.path = 'c:/Software/conex'
   -> 面包屑第 0 项的 b.path === bcFlyout.path (true) -> 浮层顺利挂载渲染！
3. 浮层内列出了子文件夹: apps, crates, docs...
4. 用户在浮层中点击子文件夹 "apps"：
   -> 触发 onClick -> 执行 openBcFlyout('c:/Software/conex/apps', 'apps')
   -> React 状态更新：bcFlyout.path 变成了 'c:/Software/conex/apps'
5. 组件重新渲染：
   -> 此时 breadcrumbs 依赖 cwd，而 cwd 尚未完成切换更新（仍在第 1 步）；
   -> 重新遍历 breadcrumbs：
      - 第 0 项: b.path = 'c:/Software/conex' !== 'c:/Software/conex/apps' (false)
      - breadcrumbs 数组里根本没有 'c:/Software/conex/apps' 这一项！
   -> 结果：flyOpen 对所有面包屑项全部判定为 FALSE！
6. React 在这一帧立即将 .filesBcFlyout 完全卸载（Unmount）！
7. 浮层瞬间关闭蒸发，用户什么操作都还没完成，就看到弹窗闪退！
```

这就是用户反馈“**里面的东西无法执行任何操作**”的铁证！只要点击任意子文件夹，浮层就因为状态机失步而被直接销毁。

### 4.3 非 Portal 挂载与容器剪裁（Boundary Clipping）

- `FileBreadcrumb.tsx` 没有使用全局浮层规范（Radix UI Popover 或 FloatingPortal）；
- 而是直接将 `.filesBcFlyout` 作为 `<span className={styles.filesBcSeg}>` 的 `position: absolute` 子节点；
- 查看 `.filesBcSeg` 样式（[`FilesCard.module.css:101`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.module.css#L101)）：
  ```css
  .filesBcSeg {
    position: relative;
    display: inline-flex;
    align-items: center;
    max-width: 140px; /* 🚨 强行限制最大宽度 140px */
  }
  ```
- 弹层作为其子元素，当计算 `width: min(320px, 70vw)` 并向左/向右展开时，在卡片较窄或分屏（Split Pane）容器中极易触发水平溢出截断，且无法感知视口边缘做自动翻转（Flip / Collision Detection）。

### 4.4 无根浮层与路径脱节（“显示的面板我也不知道是哪里的”）

1. 弹层内部没有展示当前所浏览目录的**完整路径面包屑**或**物理绝对路径**；
2. 搜索框上方没有任何标题，弹层底部只有一个生硬的“打开此目录”按钮；
3. 用户从一个抽象的“项目”点开，看到里面弹出一个孤立的小框，既不知道这个框对应磁盘哪个深度，点击后又频繁闪退，体验完全失控。

---

## 5. 现代化文件管理器与面包屑弹层重构方案设计

为彻底根治上述三类缺陷，提出系统化架构整改方案：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│               现代化文件管理器（FilesCard）与面包屑浮层整改架构方案                     │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  [1. 命名与图标单源化]                                                                 │
│  - ViewRegistry ID: 'files' -> title: '文件' (Icon: FolderTree)                        │
│  - Launcher Hub: '文件管理器' / 描述: '浏览项目工作区目录树、编辑与代码预览'            │
│  - Chrome Action Tooltip: '打开文件管理器' (Icon: FolderTree)                          │
│                                                                                        │
│  [2. 树根容器与物理目录净化]                                                           │
│  - 根目录物理清理: 执行 trash 删除孤儿 `--version` 目录                                │
│  - FileTreeView: 引入顶层 [📁 项目名 (conex) / 绝对路径] 根 Header 容器                │
│  - 隐藏文件过滤开关: 默认过滤 `.agent-outputs`, `.agent-runtime`, `node_modules` 等     │
│  - ProjectsSection: 点击项目整行立即触发 openProject(id)，实时同步 active workspace    │
│                                                                                        │
│  [3. 现代化面包屑 Popover]                                                             │
│  - 迁移至 Radix UI Popover.Root + Portal，挂载至全局顶层，设置 z-index: var(--z-popover)│
│  - 纯色不透明背景: background: var(--bg-elevated, #ffffff)，加深阴影与毛玻璃边框      │
│  - 独立下钻状态栈: useReducer / useState 管理 currentFlyoutPath，不与 breadcrumbs 强耦 │
│  - 支持浮层内多级下钻导航 (Drill-down) 与返回上级，带当前路径明确指示                  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 5.1 概念与文案单一真源（SSOT）归一方案

1. **Tab 与面板标题**：
   - 全局 Tool ID：`files`；
   - 视图注册中心标题：`title: '文件'`；
   - 完整面板标题 / 工具提示：`'文件管理器'`；
   - 移除所有“代码产物”命名，与会话输出彻底解耦。
2. **图标统一**：
   - 统一使用 `FolderTree`（`lucide-react`），替代不恰当的 `FileCode`。

### 5.2 文件树“项目根头部”与隐藏文件过滤策略

1. **树根 Header 显式展示**：
   - 在 `FileTreeView` 的虚拟滚动列表最上方，渲染一个常驻的 Project Root Header：
     ```tsx
     <div className={styles.filesTreeRootHeader}>
       <FolderGit2 size={15} className={styles.filesTreeRootIcon} />
       <span className={styles.filesTreeRootName}>{projectName || '工作区'}</span>
       <span className={styles.filesTreeRootPath} title={rootPath}>{rootPath}</span>
     </div>
     ```
   - 用户一眼即可明确知道当前整个树所锚定的项目与物理路径。
2. **内置忽略规则（Ignore Rules）与切换开关**：
   - 默认折叠/隐藏 `.agent-outputs`, `.agent-runtime`, `.git`, `.turbo` 等噪音目录；
   - 在工具栏增加“显示/隐藏运行期与隐藏文件”切换按钮。

### 5.3 项目切换与全局 cwd 双向响应式联动闭环

1. **修复 `ProjectsSection.tsx` 点击行逻辑**：
   - 点击项目行时，同时触发 `openProject(p.id)` 和 `onToggleProjectCollapsed(p.id)`；
   - 确保 `localStorage.setItem('crish_workspace', target.path)` 与 `window.dispatchEvent('crish-project-changed')` 立即发出。
2. **`useFileNavigation.ts` 健全监听**：
   - 当收到 `crish-project-changed` 事件时，立即重置 `cwd = newRoot`，清空展开项并重新加载目录树，确保视图与活动项目绝对同步。

### 5.4 基于 Radix Popover / Floating Portal 的面包屑多级下钻浮层

1. **解耦 Breadcrumbs 渲染与浮层挂载点**：
   - 使用 Radix UI `<Popover.Root>` + `<Popover.Portal>` + `<Popover.Content>`；
   - 浮层渲染在 `document.body` 下，彻底脱离父级 `140px` 限制；
   - 赋予 `z-index: var(--z-popover, 500)`，确保位于所有卡片、编辑器与滚动层之上。
2. **浮层内部自闭环导航状态（Drill-Down State）**：
   - 在浮层组件内部维护独立的 `browsingPath` 状态栈；
   - 点击浮层内的子目录时，仅更新浮层内部的 `browsingPath` 并加载其子项，浮层**不关闭**；
   - 浮层顶部提供返回上一级按钮及当前完整相对路径指示；
   - 只有当用户双击目录、点击“跳转到此目录”按钮或点击某个文件时，才关闭浮层并通知宿主切换 `cwd` / 打开文件。

---

## 6. 数据流、DOM 结构与样式改造全景清单

### 6.1 视图注册与顶部动作栏改造清单

#### 1. [`registerBuiltInViews.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/services/view-registry/registerBuiltInViews.tsx)
```diff
- import { Globe, LayoutDashboard, FileCode, GitBranch, PlayCircle, Bot, Workflow } from 'lucide-react';
+ import { Globe, LayoutDashboard, FolderTree, GitBranch, PlayCircle, Bot, Workflow } from 'lucide-react';

  // 5. 文件管理器 (Tool)
  viewRegistry.registerView({
    id: 'files',
-   title: '代码产物',
-   icon: FileCode,
+   title: '文件',
+   icon: FolderTree,
    category: 'tool',
    component: factories['files']?.() ?? fallbackComponent,
  });
```

#### 2. [`SidePanelLauncherHub.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/SidePanelLauncherHub.tsx)
```diff
- import { Globe, FileCode } from 'lucide-react';
+ import { Globe, FolderTree } from 'lucide-react';

  <button
    type="button"
    className={`${styles.launcherCard} side-panel-launcher-card`}
    onClick={() => onOpenPanel('files')}
    data-testid="launcher-card-files"
  >
    <div className={`${styles.launcherCardIconBox} launcher-card-icon-box`}>
-     <FileCode size={16} strokeWidth={1.8} />
+     <FolderTree size={16} strokeWidth={1.8} />
    </div>
    <div className={styles.launcherCardText}>
      <span className={`${styles.launcherCardTitle} launcher-card-title`}>
-       代码产物与文件
+       文件管理器
      </span>
      <span className={styles.launcherCardDesc}>
-       浏览会话生成的文件、差异与产物
+       浏览项目工作区目录树、编辑与代码预览
      </span>
    </div>
  </button>
```

#### 3. [`UnitChromeActions.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/UnitChromeActions.tsx)
```diff
- import { Globe, FileCode } from 'lucide-react';
+ import { Globe, FolderTree } from 'lucide-react';

- {/* 按钮 2: 代码产物与文件 (📄 FileCode) */}
- <Tooltip content="打开代码产物与文件" side={UNIT_CHROME_TOOL_TIP_SIDE}>
+ {/* 按钮 2: 文件管理器 (📁 FolderTree) */}
+ <Tooltip content="打开文件管理器" side={UNIT_CHROME_TOOL_TIP_SIDE}>
    <button
      type="button"
-     id="topQuickArtifactsBtn"
-     className={`${styles.topActionBtn} top-action-btn`}
-     data-testid="top-quick-artifacts-btn"
-     data-active={isArtifactsActive ? 'true' : 'false'}
-     aria-label="打开代码产物与文件"
-     onClick={handleOpenArtifacts}
+     id="topQuickFilesBtn"
+     className={`${styles.topActionBtn} top-action-btn`}
+     data-testid="top-quick-files-btn"
+     data-active={isFilesActive ? 'true' : 'false'}
+     aria-label="打开文件管理器"
+     onClick={handleOpenFiles}
    >
-     <FileCode size={14} strokeWidth={1.8} aria-hidden="true" />
+     <FolderTree size={14} strokeWidth={1.8} aria-hidden="true" />
    </button>
  </Tooltip>
```

---

### 6.2 面包屑浮层状态机与 DOM 重构前后对比

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        面包屑 Popover 重构前后 DOM 架构对比                             │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  [改造前：内联嵌套，受限裁剪，点击瞬灭]                                                │
│  <div class="filesCrumbs">                                                             │
│    <span class="filesBcSeg" style="max-width: 140px;">                                 │
│      <button>项目</button>                                                             │
│      <!-- 🚨 嵌套在 span 内部，z-index: auto，受 140px 限制 -->                        │
│      <div class="filesBcFlyout" style="position: absolute;">                           │
│        <button onClick="openBcFlyout(apps)">apps</button>                              │
│        <!-- 🚨 点击后 bcFlyout.path 变更为 apps，匹配失效，整个 div 瞬间 unmount -->   │
│      </div>                                                                            │
│    </span>                                                                             │
│  </div>                                                                                │
│                                                                                        │
│  [改造后：Radix Portal 挂载，多级下钻状态机，高层叠不透明底板]                         │
│  <div class="filesCrumbs">                                                             │
│    <Popover.Root open={isOpen} onOpenChange={setIsOpen}>                               │
│      <Popover.Trigger asChild>                                                         │
│        <button class="filesBcChip">conex</button>                                      │
│      </Popover.Trigger>                                                                │
│      <Popover.Portal>                                                                  │
│        <Popover.Content class="filesBcPopoverContent" z-index: var(--z-popover)>       │
│          <div class="filesBcNavHeader">                                                │
│            <button onClick="navUp()">⬅ 上级</button>                                   │
│            <span>当前: apps/crish-desktop</span>                                       │
│          </div>                                                                        │
│          <div class="filesBcList">                                                     │
│            <!-- 点击子目录仅切换内部 navPath，保持 Popover 常开 -->                     │
│            <button onClick="drillDown(dir)">src/</button>                              │
│          </div>                                                                        │
│        </Popover.Content>                                                              │
│      </Popover.Portal>                                                                 │
│    </Popover.Root>                                                                     │
│  </div>                                                                                │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### 6.3 CSS Module 补全与 z-index 规范化清单

#### 1. [`styles/z-index.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/z-index.css)
```diff
  /* Level 4: 浮层、卡片气泡与上下文菜单 */
  --z-popover: 500;
  --z-drawer: var(--z-popover);
+ --z-breadcrumb: var(--z-popover); /* 补齐面包屑浮层 token */
+ --z-card-footer: var(--z-dock);   /* 补齐卡片工具栏与底部操作栏 token */
```

#### 2. [`FilesCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.module.css)
```diff
  .filesBcFlyout {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
-   z-index: var(--z-breadcrumb);
+   z-index: var(--z-popover, 500);
    width: min(320px, 70vw);
    max-height: min(52vh, 400px);
    display: flex;
    flex-direction: column;
    padding: var(--space-2);
    border-radius: var(--radius-2xl);
    border: 1px solid var(--border-subtle);
-   background: var(--bg-elevated, var(--bg-primary));
+   background: var(--bg-elevated, #ffffff); /* 强制纯色不透明兜底 */
+   backdrop-filter: blur(12px);
    box-shadow: var(--shadow-lg, 0 12px 28px rgba(0, 0, 0, 0.1));
    white-space: normal;
  }
```

---

## 7. 实施清单与回归断言防线

### 7.1 分步实施路线图

- [ ] **步骤 1：命名与概念全面修正**
  - 在 [`registerBuiltInViews.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/services/view-registry/registerBuiltInViews.tsx) 中将 `id: 'files'` 的标题修改为 `'文件'`，图标替换为 `FolderTree`；
  - 在 [`SidePanelLauncherHub.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/SidePanelLauncherHub.tsx) 中将文案修改为 `'文件管理器'`，图标替换为 `FolderTree`；
  - 在 [`UnitChromeActions.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/UnitChromeActions.tsx) 中同步更新按钮文案、图标与 testId。
- [ ] **步骤 2：项目根目录与绑定机制加固**
  - 清理本地项目根下误创建的物理目录 `--version`；
  - 在 [`FileTreeView.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FileTreeView.tsx) 树顶端引入 **Project Root Header**，明确显示当前绑定的项目名称与物理全路径；
  - 在 [`FileBreadcrumb.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FileBreadcrumb.tsx) 中将根芯片的 label 从硬编码 `'项目'` 升级为当前项目文件夹的实际名称（如 `conex`）；
  - 在 [`ProjectsSection.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/ProjectsSection.tsx) 中修复点击项目整行自动触发 `openProject(p.id)` 逻辑。
- [ ] **步骤 3：面包屑 Popover 重构与样式修复**
  - 在 [`styles/z-index.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/z-index.css) 中补全 `--z-breadcrumb` 与 `--z-card-footer` 变量；
  - 将 `FileBreadcrumb.tsx` 弹层改造为基于 Radix UI Popover Portal 挂载的独立下钻浮层组件；
  - 修复点击子文件夹导致 `bcFlyout.path` 与 `breadcrumbs` 判定不符而瞬灭的致命 Bug；
  - 为浮层配置不透明背景 `--bg-elevated` 与毛玻璃投影。

### 7.2 回归断言与验收防线（Acceptance Criteria）

1. **Tab 与入口语义断言**：
   - 启动桌面端，右侧工具栏与 Tab 列表中不再出现任何“代码产物”字样，全部呈现为“文件”或“文件管理器”，图标为规范的 `FolderTree`；
2. **根目录清晰度断言**：
   - 无论何时打开文件树，顶部首行均有清晰的项目根节点提示（如 `📁 conex`），不会将根目录下的首个子文件误导为树的根节点；
   - 侧边栏点击任意项目，文件管理器立即响应式切换至对应项目的工作区路径并刷新目录；
3. **面包屑弹层与交互断言**：
   - 点击面包屑各级节点，弹出的浮层具有坚实的不透明底色（`--bg-elevated`），不被任何底层树或编辑器内容穿透；
   - 在浮层内点击子文件夹，浮层平滑下钻展示子级内容，**绝不瞬灭闪退**；
   - 浮层顶部清晰指示当前下钻路径，点击底部“打开此目录”或双击条目可精确导航至对应路径。
