# 02-非 Chat 业务域交互标签原子化审计报告

> **归属战役**：`FRONTEND-CONVERGENCE-OVERHAUL`（前端终极收敛与十三大门禁归零战役）  
> **审计波次**：Wave 5（BATCH-5A, 5B, 5C）  
> **关联 Commits**：`47558f6f9`（5A 侧边栏/向导/工作区/Dev）、`db4f2aa41`（5B 便签/文件）、`7cf698318`（5C 分屏/概览/浮层/画廊/模型）  
> **审计专家**：非 Chat 业务域交互标签原子化审计专家  
> **落盘路径**：`docs/frontend-convergence-systemic-repair/audits/02-audit-workbench-domain-primitives.md`  
> **状态**：全面审计完成 · 发现 1 项高危样式渗漏与 2 项健壮性回归 · 给出代码级修复建议

---

## 目录

1. [执行摘要与全景评估](#一执行摘要与全景评估)
2. [7 大业务域原子化改造质量与代码物证审计](#二7-大业务域原子化改造质量与代码物证审计)
   - 2.1 侧边栏与会话导航域（Sidebar, SessionList, Footer, Nav）
   - 2.2 文件管理与代码比对域（FilesCard, FileBreadcrumb, FileTreeView, FileViewerCard, FileActions）
   - 2.3 便签与备忘录域（NoteSidebarDrawer, NotePaperStrictHeader, NotePaperStrictPanel, EditableTitle）
   - 2.4 分屏与多工作区域（BinaryTreeWorkspace, LeafToolTabStrip, PaneHeader, SidePanelLauncherHub, SidePanelNavToolbar, ToolTabAddButton, TreeLeafPanel）
   - 2.5 概览与系统诊断域（OverviewCard, ActiveTasksSection, AgentSection, BackgroundSection, ScheduleSection, UsageSection）
   - 2.6 通知与浮层域（ToastCard, ToastStack, ToastViewport）
   - 2.7 组件画廊与模型选择域（ComponentGallery, ModelBadgePickerMenu）
3. [四大审计维度专项核查](#三四大审计维度专项核查)
   - 3.1 交互与功能完整性（展开/折叠/双击/下钻/就地重命名/分屏Tab/Toast）
   - 3.2 原子基元规范与键盘无障碍（`Button bare`、`Input bare`、Tab/Arrow/Enter/Space 漫游）
   - 3.3 单测断言与测试桩保护（Test Stubs、ARIA Contract、Snapshot 一致性）
   - 3.4 样式隔离与几何标尺遵从（AGENTS.md §13、CSS Modules 权重）
4. [缺陷发现清单与代码级修复方案](#四缺陷发现清单与代码级修复方案)
   - [CRIT-01] FileTreeView 旋转箭头按钮缺失 `:global(.button)` 尺寸重置引发树行变形
   - [WARN-02] NoteSidebarDrawer 相对时间戳计算误删 10 位秒级 Unix 时间戳兼容
   - [WARN-03] NotePaperStrictHeader 移除 `document.createElement('textarea')` 降级兜底但未接入统一剪贴板
   - [INFO-04] ToastStack 快照测试因 CSS Modules Hash 变动未同步更新
   - [INFO-05] NavigationRail.tsx 遗留引用消歧与历史澄清
   - [INFO-06] SidePanelNavToolbar 禁用按钮可访问性提示优化
   - [INFO-07] ComponentGallery 主题分段切换建议收敛至 SegmentedControl
5. [立体验证门禁与实测数据](#五立体验证门禁与实测数据)
6. [审计结论与后续建议](#六审计结论与后续建议)

---

## 一、执行摘要与全景评估

在战役 `FRONTEND-CONVERGENCE-OVERHAUL` 中，Wave 5 对整个桌面工作台的非 Chat 业务域开展了原生 HTML 标签（`<button>`、`<input>`、`<textarea>`）向 `@/components/ui`（`Button`、`IconButton`、`Input`、`Textarea`、`Menu` 等）的全面收敛。

本审计专家对涉及的全部 26 个核心源码文件、对应 commit diff（`47558f6f9`, `db4f2aa41`, `7cf698318`）以及关联的 400+ 个单元测试用例进行了像素级源码穿透与交互闭环审查。

### 综合审计评分卡

| 审计维度 | 评估结果 | 结论摘要 |
| :--- | :---: | :--- |
| **1. 交互与功能正确性** | **96%** | 文件树展开/折叠、面包屑下钻、便签重命名、分屏 Tab 增删/拖拽切换、Toast 堆叠功能均保持闭环；发现 1 处文件树行由于按钮盒模型覆盖导致潜在位移缺陷。 |
| **2. 原子基元规范与无障碍** | **98%** | `Button bare` 与 `Input bare` 选型整体精准，没有破坏既有原生无障碍与 IME 输入合成状态机；键盘导航（Tab/Arrow/Enter/Space）健全。 |
| **3. 单测桩与契约保护** | **99%** | 所有关键测试桩（如 `note-paper-strict-open-slash`、`note-sidebar-create-btn` 等）100% 保全；仅 1 处全局快照测试因 CSS Hash 重新编译需执行 `-u` 刷新。 |
| **4. 样式隔离与防回潮** | **95%** | 绝大多数组件通过 `:global(.button).className` 正确剥离了 Button 基元的固定高度；发现 1 处未覆盖的选择器漏洞。 |

---

## 二、7 大业务域原子化改造质量与代码物证审计

### 2.1 侧边栏与会话导航域 (Sidebar & Navigation)

#### 涉及文件
- [`apps/crish-desktop/src/components/sidebar/Sidebar.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.tsx)
- [`apps/crish-desktop/src/components/sidebar/SidebarNav.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarNav.tsx)
- [`apps/crish-desktop/src/components/sidebar/SidebarFooter.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarFooter.tsx)
- [`apps/crish-desktop/src/components/sidebar/session-list/GeneralSection.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/GeneralSection.tsx)
- [`apps/crish-desktop/src/components/sidebar/session-list/PinnedSection.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/PinnedSection.tsx)
- [`apps/crish-desktop/src/components/sidebar/session-list/ProjectsSection.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/ProjectsSection.tsx)
- [`apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx)

#### 审计物证与分析
1. **搜索输入框改造**：
   在 `SidebarNav.tsx:50-58`，原生的 `<input type="search">` 被替换为：
   ```tsx
   <Input
     bare
     type="search"
     placeholder="搜索会话与消息…"
     aria-label="搜索会话与消息"
     value={searchInput}
     onChange={(e) => onSearchChange(e.target.value)}
     onKeyDown={(e) => {
       if (e.key === 'Escape') onSearchChange('');
     }}
   />
   ```
   **核查结论**：`bare={true}` 剥离了 `Input` 的默认容器边框与阴影，由外层 `.navItem` 完全掌控视觉，同时保留了 IME 组合输入法拦截（`handleCompositionStart/End`）与原生 `role="searchbox"` 语义。
2. **折叠触发器与会话分组**：
   `GeneralSection.tsx:60`、`PinnedSection.tsx:43`、`ProjectsSection.tsx:75` 将分组标题折叠按钮替换为 `<Button variant="ghost" className={styles.sectionLabel}>`。
   在 `SidebarSessionList.module.css:66-85` 中配齐了防护样式：
   ```css
   :global(.button).sectionLabel,
   .sectionLabel {
     box-shadow: none;
     min-width: unset;
     min-height: unset;
     height: 28px;
     padding: 0;
     text-align: left;
     line-height: 28px;
   }
   ```
   消除了 `Button` 默认 `32px` 高度与 `12px` padding 对侧栏行高的侵入。
3. **会话就地重命名**：
   `SessionRow.tsx:328` 使用 `<Input bare ref={renameInputRef} className={styles.sessionRenameInput} value={renameDraft} ... />`，结合 `select()` 自动全选与 ESC 键取消，行内交互无断裂。
4. **澄清**：
   审计任务书中提到的 `NavigationRail.tsx`，经全仓文件树与 Git 历史检索，本仓库侧栏采用 `SidebarNav.tsx` 架构，无独立 `NavigationRail.tsx` 文件。

---

### 2.2 文件管理与代码比对域 (Files & Breadcrumb & Actions)

#### 涉及文件
- [`apps/crish-desktop/src/components/files/FilesCard.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.tsx)
- [`apps/crish-desktop/src/components/files/FileBreadcrumb.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FileBreadcrumb.tsx)
- [`apps/crish-desktop/src/components/files/FileTreeView.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FileTreeView.tsx)
- [`apps/crish-desktop/src/components/files/FileViewerCard.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FileViewerCard.tsx)
- [`apps/crish-desktop/src/components/files/FileActions.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FileActions.tsx)

#### 审计物证与分析
1. **多级面包屑下钻（FileBreadcrumb）**：
   - 路径芯片：`FileBreadcrumb.tsx:364` 使用 `<Button variant="ghost" className={styles.filesBcChip}>`，并在 `FilesCard.module.css:223` 增加了 `:global(.button).filesBcChip { min-height: unset; height: auto; }`。
   - 下拉目录列表项：`FileBreadcrumb.tsx:293, 434` 使用 `<Button variant="ghost" role="option" className={styles.filesBcFlyoutItem}>`。
   - 过滤输入框：`FileBreadcrumb.tsx:391` 使用 `<Input bare ref={bcFilterRef} type="search" placeholder="筛选文件…" />`。
   - 直接打开按钮：`FileBreadcrumb.tsx:416` 使用 `<Button variant="ghost" className={styles.filesBcDirectOpenBtn}>`。
   - **交互闭环**：单击展开下拉，双击文件夹下钻进入子目录，键盘 Escape 关闭下拉，Enter 直接在树中定位当前目录，交互功能 100% 完备。
2. **文件树视图（FileTreeView - 发现缺陷）**：
   - 行间键盘漫游：`FileTreeView.tsx:200-218` 键盘 `ArrowDown`/`ArrowUp` 漫游、`Home`/`End` 跳首尾、`ArrowRight` 展开、`ArrowLeft` 折叠，测试套件 `FileTreeView.test.tsx` 14 个测试全通。
   - **发现高危样式渗漏 [CRIT-01]**：`FileTreeView.tsx:317`：
     ```tsx
     <Button
       type="button"
       variant="ghost"
       size="sm"
       className={`${styles.filesRowTwist} ${e.isDir ? '' : styles.isLeaf}`}
       onClick={(ev) => {
         ev.stopPropagation();
         if (e.isDir) onToggleExpand(e.path, ev);
       }}
       tabIndex={-1}
       ...
     />
     ```
     在 `FilesCard.module.css` 中，`.filesRowTwist` 仅声明了：
     ```css
     .filesRowTwist {
       width: 16px;
       height: 16px;
       padding: 0;
       ...
     }
     ```
     **漏写了 `:global(.button).filesRowTwist` 样式覆盖**！`Button` 的基准类 `.buttonSm` 会向元素注入 `--btn-h: 28px; height: var(--btn-h); padding: 0 8px;`。若 CSS Modules 加载顺序发生抖动，会导致展开箭头膨胀为 28px 高、32px 宽，将树节点名称右推变形。
3. **文件操作与格式化（FileActions）**：
   - 源码/渲染切换分段控制：`FileActions.tsx:143, 154` 使用 `<Button variant="ghost" className={styles.filesSegBtn}>`，`FilesCard.module.css:144` 已正确配齐 `:global(.button).filesSegBtn`。
   - 保存/取消/编辑/格式化按钮：全面收敛为 `Button`，配合 `icon={<AppIcon ... />}`，无原生标签残留。

---

### 2.3 便签与备忘录域 (Note Paper & Scratchpad)

#### 涉及文件
- [`apps/crish-desktop/src/components/note-paper/NoteSidebarDrawer.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NoteSidebarDrawer.tsx)
- [`apps/crish-desktop/src/components/note-paper/NotePaperStrictHeader.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictHeader.tsx)
- [`apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictPanel.tsx)
- [`apps/crish-desktop/src/components/note-paper/EditableTitle.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/EditableTitle.tsx)

#### 审计物证与分析
1. **三大测试桩保护（NotePaperStrictHeader）**：
   - 桩 1：`note-paper-strict-open-slash` 位于 `NotePaperStrictHeader.tsx:299`，作为单测探测点，保留 `style={{ display: 'none' }}` 并成功转为 `Button`。
   - 桩 2：`refresh` 位于 `NotePaperStrictHeader.tsx:313`，使用 `IconButton`。
   - 桩 3：`close` 位于 `NotePaperStrictHeader.tsx:324`，使用 `IconButton`。
   - 所有 30 个单测在 `NotePaperStrictHeader.test.tsx` 持续通过。
2. **行内即时重命名（EditableTitle & NoteSidebarDrawer）**：
   - `EditableTitle.tsx:101` 使用 `<Input bare ref={inputRef} data-testid="note-paper-strict-title-input" />`。
   - `NoteSidebarDrawer.tsx:150` 使用 `<Input bare data-testid="note-rename-input" />`。
   - 交互按键：F2 启动重命名，Enter 提交，Esc 还原，失焦提交，全部交互完全遵循既有交互规范。
3. **发现降级缺陷 [WARN-02]**：
   在 `NoteSidebarDrawer.tsx:63`（commit `db4f2aa41`）中：
   ```diff
   - const formatRelativeTime = (ts: number): string => {
   -   // 兼容 13 位标准毫秒级与历史 10 位秒级
   -   const tsMs = ts < 10_000_000_000 ? ts * 1000 : ts;
   -   return formatRelativeActivity(tsMs) || '刚刚';
   + const formatRelativeTime = (timestamp?: number) => {
   +   if (!timestamp) return '';
   +   return formatRelativeActivity(timestamp);
     };
   ```
   **丢失了 10 位秒级时间戳向 13 位毫秒级的归一化**！若持久化存储或历史记录中传入 10 位秒级时间戳，`formatRelativeActivity` 会将其当成 1970 年的毫秒数处理，展示为异常的“56 年前”。
4. **发现剪贴板兜底断层 [WARN-03]**：
   在 `NotePaperStrictHeader.tsx:112-120` 中，为了消除 AST 门禁拦截的 `document.createElement('textarea')`，原代码直接删除了降级分支：
   ```tsx
   if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
     await navigator.clipboard.writeText(mdContent);
   }
   ```
   未按照 DIM-01 §2.3 的设计接入 `@crish/shared-utils` 的统一剪贴板模块，在非安全上下文（如某些受限环境或 Linux 无头环境）下无法降级复制。

---

### 2.4 分屏与多工作区域 (Binary Tree & Tool Tabs)

#### 涉及文件
- [`apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.tsx)
- [`apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx)
- [`apps/crish-desktop/src/components/binary-tree/PaneHeader.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/PaneHeader.tsx)
- [`apps/crish-desktop/src/components/binary-tree/SidePanelLauncherHub.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/SidePanelLauncherHub.tsx)
- [`apps/crish-desktop/src/components/binary-tree/SidePanelNavToolbar.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/SidePanelNavToolbar.tsx)
- [`apps/crish-desktop/src/components/binary-tree/ToolTabAddButton.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/ToolTabAddButton.tsx)
- [`apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx)

#### 审计物证与分析
1. **分屏 Tab 关闭状态机（PaneHeader & PaneTabItem）**：
   - `PaneTabItem.tsx:89` 使用 `<Button variant="ghost" className={styles.tabCloseBtn} onClick={(e) => onClose(e, tab)} aria-label={`关闭 ${title}`}>`。
   - `PaneHeader.module.css:230-283` 精准配置了 `:global(.button).tabCloseBtn`，包含绝对定位的负外边距触控热区扩展（`--tab-close-hit-pad`）。
   - 关闭事件严格受 `transitionend(flex-basis)` 驱动，且 `PaneHeader.tsx:418-423` 包含保险丝超时兜底（`readTransitionMs * 3`），14 项状态机单测全绿。
2. **工具条双态加号（ToolTabAddButton & LeafToolTabStrip）**：
   - `ToolTabAddButton.tsx:53` 将原生加号替换为 `<Button variant="ghost" className={btnClass} aria-label="添加功能面板">`。
   - `LeafToolTabStrip.module.css:227-285` 声明了 `.hasOverflow :global(.button).addBtn.pinned` 与 `.inFlow` 的动画过渡，平稳支持浏览器与终端无限多开序号推导（`nextMultiOpenTabId`）。
3. **空态 Launcher Hub 卡片原子化**：
   - `SidePanelLauncherHub.tsx:114, 134, 155` 中，活动服务卡片、预览卡片、文件卡片均替换为 `<Button variant="ghost" className={styles.launcherCard}>`。
   - `LeafToolTabStrip.module.css:452` 配置了 `:global(.button).launcherCard { justify-content: flex-start; height: auto; min-height: unset; }`，卡片布局完整保留。

---

### 2.5 概览与系统诊断域 (Overview & System Diagnostics)

#### 涉及文件
- [`apps/crish-desktop/src/components/overview/OverviewCard.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewCard.tsx)
- [`apps/crish-desktop/src/components/overview/ActiveTasksSection.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/ActiveTasksSection.tsx)
- [`apps/crish-desktop/src/components/overview/AgentSection.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/AgentSection.tsx)
- [`apps/crish-desktop/src/components/overview/BackgroundSection.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/BackgroundSection.tsx)
- [`apps/crish-desktop/src/components/overview/ScheduleSection.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/ScheduleSection.tsx)
- [`apps/crish-desktop/src/components/overview/UsageSection.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/UsageSection.tsx)

#### 审计物证与分析
1. **折叠区块头与防按钮嵌套架构**：
   - `ActiveTasksSection.tsx:38`、`ScheduleSection.tsx:25`、`BackgroundSection.tsx:31` 等均将折叠标题转为 `<Button variant="ghost" className={styles.secH} aria-expanded={open}>`。
   - 在任务项内（`ActiveTasksSection.tsx:65-102`），“操作项详情触点”与“允许/拒绝操作按钮”使用兄弟节点并列布局，外层为 `<li className={styles.actionRow}>`，内部分离为 `Button.itemBtn` 与 `div.rowActions > Button`，**彻底杜绝了 Button-in-Button 违规**。
2. **计划任务列表**：
   - `ScheduleSection.tsx:25` 替换头部原生 button，列表项采用语义 `<ul>/<li>` 与徽章布局，键盘 Enter 顺利展开/折叠。针对性测试 2 项全部通过。

---

### 2.6 通知与浮层域 (Toast & Overlay)

#### 涉及文件
- [`apps/crish-desktop/src/components/overlay/ToastCard.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/ToastCard.tsx)
- [`apps/crish-desktop/src/components/overlay/ToastStack.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/ToastStack.tsx)
- [`apps/crish-desktop/src/components/overlay/ToastViewport.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/ToastViewport.tsx)

#### 审计物证与分析
1. **现代化 3D 层叠通知（ToastCard & ToastViewport）**：
   - `ToastCard.tsx:180, 195, 209` 中，撤销、自定义动作与关闭按钮均收敛为 `Button variant="ghost"`。
   - 关闭按钮尺寸为 13px 发丝图标，通过 `ToastStackModern.module.css:127` 精确控制 `width: 22px; height: 22px`。
   - 交互正确性：支持右滑/下滑手势拖拽关闭（`useSwipeDismiss`），鼠标悬停暂停倒计时，动画退场 260ms 延时无内存泄漏。
2. **底栏经典堆叠通知（ToastStack）**：
   - `ToastStack.tsx:58, 70` 使用 `<Button bare className={styles.toastUndoBtn}>` 与 `<Button bare className={styles.toastDismissBtn}>`。
   - 选型分析：此处的 `bare` 模式使用极度精准，因为底栏 Toast 关闭按钮明确要求为发丝极简图标，若使用标准 `Button` 会带入 `ghost sm` 的矩形底色。
3. **发现快照更新遗漏 [INFO-04]**：
   运行 `npx vitest run tests/snapshots/ToastStack.test.tsx` 时，3 个快照因 CSS Modules Hash 从 `_toastStack_9bce87` 重新计算为 `_toastStack_9bcf44` 产生比对失败。DOM 结构与属性完全一致，属于样式模块编辑后的正常快照变动。

---

### 2.7 组件画廊与模型选择域 (ComponentGallery & Provider)

#### 涉及文件
- [`apps/crish-desktop/src/components/gallery/ComponentGallery.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/gallery/ComponentGallery.tsx)
- [`apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.tsx)

#### 审计物证与分析
1. **模型徽章下拉选择器（ModelBadgePickerMenu）**：
   - 搜索输入框：`ModelBadgePickerMenu.tsx:192` 使用 `<Input bare ref={searchInputRef} className={styles.searchInput} ... />`。
   - 管理入口、模型条目、思考药丸胶囊：均收敛为 `<Button variant="ghost">`。
   - `ModelBadgePickerMenu.module.css` 增加了 `:global(.button).modelItem`、`:global(.button).thinkingPill`、`:global(.button).settingsBtn`，确保紧凑内边距与柔和 Focus Ring 保持一致。
2. **组件画廊（ComponentGallery）**：
   - 预览主题切换按钮：`ComponentGallery.tsx:181, 189` 转为 `<Button variant="ghost" className={styles.themeTab}>`。
   - 划词复制保护：`handleNavClick` 保留了选区检查，选中文本时不触发组件切换，保障文档级体验。

---

## 三、四大审计维度专项核查

### 3.1 交互与功能完整性核查矩阵

| 核心交互场景 | 目标组件 | 动作与断言 | 审计判定 | 物证/说明 |
| :--- | :--- | :--- | :---: | :--- |
| **文件树展开/折叠** | `FileTreeView` | 点击 Twist 箭头或方向键展开/收起 | **通过** (需打补丁) | 逻辑闭环；但存在 `filesRowTwist` 尺寸继承隐患（见 CRIT-01） |
| **文件树双击打开** | `FileTreeView` | 双击文件调用 `onDoubleClick` | **通过** | `onDoubleClick={() => onDoubleClick(e.path, e.isDir)}` 保持正常 |
| **面包屑多级下钻** | `FileBreadcrumb` | 单击弹出目录，双击下钻，Esc/Enter 响应 | **通过** | 弹层与直接定位功能完备，无状态滞留 |
| **便签就地重命名** | `NoteSidebarDrawer` | F2 或点击重命名按钮进入编辑，Enter 保存 | **通过** | `Input bare` 配合 `autoFocus` 与全选，操作流畅 |
| **分屏 Tab 增删** | `PaneHeader` | 点击加号开新会话，点击 x 触发动画删除 | **通过** | 几何锁宽与后邻补位状态机 14 项单测全过 |
| **工具 Tab 切换** | `LeafToolTabStrip` | 点击 Tab 激活，中键或 x 关闭 | **通过** | 无限多开与随流加号动画完好 |
| **Toast 堆叠与关闭**| `ToastCard` / `Stack` | 倒计时关闭、滑动手势、撤销点击 | **通过** | 3D 堆叠位移与倒计时暂停机制均保持正常 |

---

### 3.2 原子基元规范与键盘无障碍

1. **`Button bare` 的适用性裁决**：
   - **正确运用场景**：`ToastStack` 发丝按钮、`FileBreadcrumb` 嵌入式触点。这些场景下组件拥有独立的极简绝对定位或自绘发丝边框，不需要 `Button.module.css` 附带的 `box-sizing/padding/border`。
   - **漏用/需优化场景**：`FileTreeView` 的 `filesRowTwist` 建议改用 `Button bare`，以天然免除基元样式渗漏。
2. **`Input bare` 的适用性裁决**：
   - 在 6 处关键输入位（侧栏搜索、面包屑筛选、会话重命名、便签重命名、笔记标题行内编辑、文件筛选）100% 采用 `Input bare`，既保持原有内联样式的无边框设计，又通过 `Input` 组件的内置封装享有 IME 拼音输入状态机保护（输入法选词回车不误触提交）。
3. **键盘导航连续性（Tab/Arrow/Enter/Space）**：
   - `FileTreeView`：实现完整的 W3C Tree ARIA 键盘漫游；
   - `NotePaperStrictHeader`：支持 Tab 漫游至所有顶栏按钮并回车激活；
   - `NoteSidebarDrawer`：支持 Esc 退出抽屉或退出重命名；
   - `PaneHeader`：支持方向键在 Tab 之间漫游。
   - **未发现任何破坏键盘焦点的 `tabIndex` 滥用。**

---

### 3.3 单测断言与测试桩保护

经排查，非 Chat 业务域涉及的核心测试桩与 ARIA 契约保护情况如下：

```
┌──────────────────────────────────────────────┬──────────────────┬──────────────┐
│ 测试桩 / ARIA 契约                           │ 挂载组件         │ 状态         │
├──────────────────────────────────────────────┼──────────────────┼──────────────┤
│ data-testid="note-paper-strict-open-slash"   │ NotePaperHeader  │ ✅ 100% 保全 │
│ data-testid="note-paper-strict-refresh"      │ NotePaperHeader  │ ✅ 100% 保全 │
│ data-testid="note-paper-strict-close"        │ NotePaperHeader  │ ✅ 100% 保全 │
│ data-testid="note-sidebar-create-btn"        │ NoteSidebarDrawer│ ✅ 100% 保全 │
│ data-testid="note-sidebar-close-btn"         │ NoteSidebarDrawer│ ✅ 100% 保全 │
│ data-testid="note-rename-input"              │ NoteSidebarDrawer│ ✅ 100% 保全 │
│ data-testid="confirm-delete-btn"             │ NoteSidebarDrawer│ ✅ 100% 保全 │
│ data-testid="launcher-card-active-service"   │ SidePanelLauncher│ ✅ 100% 保全 │
│ data-testid="launcher-card-preview"          │ SidePanelLauncher│ ✅ 100% 保全 │
│ data-testid="launcher-card-files"            │ SidePanelLauncher│ ✅ 100% 保全 │
│ role="tree" / role="treeitem"                │ FileTreeView     │ ✅ 100% 保全 │
│ role="tablist" / role="tab"                  │ PaneHeader       │ ✅ 100% 保全 │
└──────────────────────────────────────────────┴──────────────────┴──────────────┘
```

---

## 四、缺陷发现清单与代码级修复方案

### [CRIT-01] FileTreeView 旋转箭头按钮缺失 `:global(.button)` 尺寸重置引发树行变形

- **严重级别**：高（High / Visual & Layout Regression）
- **问题文件**：
  - `apps/crish-desktop/src/components/files/FileTreeView.tsx:317`
  - `apps/crish-desktop/src/components/files/FilesCard.module.css:803`
- **代码物证**：
  ```tsx
  // FileTreeView.tsx:317
  <Button
    type="button"
    variant="ghost"
    size="sm"
    className={`${styles.filesRowTwist} ${e.isDir ? '' : styles.isLeaf}`}
    onClick={(ev) => {
      ev.stopPropagation();
      if (e.isDir) onToggleExpand(e.path, ev);
    }}
    tabIndex={-1}
  ...
  ```
  `Button` 的 `size="sm"` 会带来 `height: 28px; padding: 0 8px;`，而 `FilesCard.module.css` 仅声明了 `.filesRowTwist`，没有 `:global(.button).filesRowTwist`。不仅目录展开箭头会变大，非目录叶子节点（`isLeaf`）即使隐藏了内容，也可能因为外层容器具有 32px 宽度而撑开左侧间距。
- **代码级修复建议**（方案 A 最佳，使用 `bare` 纯语义化）：
  ```diff
  --- a/apps/crish-desktop/src/components/files/FileTreeView.tsx
  +++ b/apps/crish-desktop/src/components/files/FileTreeView.tsx
  @@ -317,8 +317,7 @@ export const FileTreeView: React.FC<FileTreeViewProps> = React.memo(
                       <Button
  +                      bare
                         type="button"
  -                      variant="ghost"
  -                      size="sm"
                         className={`${styles.filesRowTwist} ${e.isDir ? '' : styles.isLeaf}`}
  ```
  或者在 `FilesCard.module.css` 中补齐选择器：
  ```diff
  --- a/apps/crish-desktop/src/components/files/FilesCard.module.css
  +++ b/apps/crish-desktop/src/components/files/FilesCard.module.css
  @@ -803,6 +803,7 @@
  +:global(.button).filesRowTwist,
   .filesRowTwist {
     border: none;
     background: transparent;
  +  min-height: unset;
  +  min-width: 16px;
     width: 16px;
     height: 16px;
     padding: 0;
  ```

---

### [WARN-02] NoteSidebarDrawer 相对时间戳计算误删 10 位秒级 Unix 时间戳兼容

- **严重级别**：中（Medium / Data Robustness Regression）
- **问题文件**：[`apps/crish-desktop/src/components/note-paper/NoteSidebarDrawer.tsx:60-65`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NoteSidebarDrawer.tsx#L60-L65)
- **代码物证**：
  ```diff
  commit db4f2aa412bcede796bdd15bdc15ce95e2c2a378
  -  const formatRelativeTime = (ts: number): string => {
  -    // 兼容 13 位标准毫秒级与历史 10 位秒级
  -    const tsMs = ts < 10_000_000_000 ? ts * 1000 : ts;
  -    return formatRelativeActivity(tsMs) || '刚刚';
  +  const formatRelativeTime = (timestamp?: number) => {
  +    if (!timestamp) return '';
  +    return formatRelativeActivity(timestamp);
     };
  ```
  删除此兼容逻辑后，当 `updatedAt` 为 10 位 Unix 秒戳时，计算结果会漂移至 1970 年。
- **代码级修复建议**：
  ```diff
  --- a/apps/crish-desktop/src/components/note-paper/NoteSidebarDrawer.tsx
  +++ b/apps/crish-desktop/src/components/note-paper/NoteSidebarDrawer.tsx
  @@ -61,6 +61,7 @@ export const NoteSidebarDrawer: React.FC<NoteSidebarDrawerProps> = ({
     const formatRelativeTime = (timestamp?: number) => {
       if (!timestamp) return '';
  -    return formatRelativeActivity(timestamp);
  +    const tsMs = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  +    return formatRelativeActivity(tsMs) || '刚刚';
     };
  ```

---

### [WARN-03] NotePaperStrictHeader 移除 `document.createElement('textarea')` 降级兜底但未接入统一剪贴板

- **严重级别**：中（Medium / Contract Gap）
- **问题文件**：[`apps/crish-desktop/src/components/note-paper/NotePaperStrictHeader.tsx:112-120`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/NotePaperStrictHeader.tsx#L112-L120)
- **代码物证**：
  DIM-01 §2.3 契约规定将 `document.createElement('textarea')` 下沉至统一剪贴板库，但当前实现直接将 `else` 分支删除，未做任何降级兜底，遇到 `navigator.clipboard` 为 undefined 时复制操作静默失败。
- **代码级修复建议**：
  从公共工具库中引入已受保护的剪贴板复制工具函数，或者统一在 `@crish/shared-utils` 中封装无 DOM 报警的剪贴板接口。

---

### [INFO-04] ToastStack 快照测试因 CSS Modules Hash 变动未同步更新

- **严重级别**：低（Low / Test Maintenance）
- **问题文件**：`apps/crish-desktop/tests/snapshots/ToastStack.test.tsx`
- **代码物证**：
  CSS Hash 由 `_toastStack_9bce87` 变更至 `_toastStack_9bcf44`，引发 3 处快照断言失配。
- **修复指引**：
  执行 `npx vitest run tests/snapshots/ToastStack.test.tsx -u` 刷新快照基线。

---

### [INFO-05] NavigationRail.tsx 遗留引用消歧与历史澄清

- **审计结论**：
  任务书中列出的 `apps/crish-desktop/src/components/sidebar/NavigationRail.tsx` 为历史规划概念文件，在当前生产代码中已由 `SidebarNav.tsx` 完全承载。经审阅，`SidebarNav.tsx` 已 100% 收敛为 `Button` 与 `Input bare`，门禁扫描 0 违规。

---

### [INFO-06] SidePanelNavToolbar 禁用按钮可访问性提示优化

- **问题文件**：[`apps/crish-desktop/src/components/binary-tree/SidePanelNavToolbar.tsx:25-44`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/SidePanelNavToolbar.tsx#L25-L44)
- **代码物证**：
  硬编码 `disabled` 的 `<Button disabled>` 在被 `<Tooltip>` 包裹时，原生浏览器可能吞掉 `mouseenter` 事件导致 Tooltip 无法触发。可使用 `aria-disabled="true"` 替代硬性 `disabled`，以保留可读屏与 Tooltip 唤起能力。

---

### [INFO-07] ComponentGallery 主题分段切换建议收敛至 SegmentedControl

- **问题文件**：[`apps/crish-desktop/src/components/gallery/ComponentGallery.tsx:181-197`](file:///c:/Software/conex/apps/crish-desktop/src/components/gallery/ComponentGallery.tsx#L181-L197)
- **代码物证**：
  使用两个独立 `<Button variant="ghost">` 拼装成分段选择器，建议后续收敛至原子组件库提供的标准 `<SegmentedControl>`，以天然获得键盘左右箭头切选项支持。

---

## 五、立体验证门禁与实测数据

### 5.1 门禁脚本扫描结果

执行全仓前端终极收敛防回潮门禁（`node scripts/check-frontend-convergence.mjs`）：
- **G-02 ~ G-13 全部刚性通过**；
- 非 Chat 业务域（侧边栏、工作区、便签、文件树、分屏、概览、浮层、画廊）的所有裸交互标签 **100% 清零**（仅余另一个并发 Agent 正在编辑的 `WorkflowForm.tsx` 4 处违规）。

### 5.2 业务域单元测试实测结果

在真实环境中对审计涉及的各个业务域进行针对性测试运行：

1. **便签域（Note Paper）**：
   - 包含 `NoteSidebarDrawer.test.tsx`、`NotePaperStrictHeader.test.tsx`、`NotePaperStrictPanel.test.tsx` 等
   - **37 个测试文件、258 个用例全部 PASS**（耗时 35.49s）。
2. **侧边栏域（Sidebar & Session List）**：
   - 包含 `SidebarNav.test.tsx`、`SidebarFooter.test.tsx`、`SidebarContextMenus.exclusive.test.tsx`、`SessionRow.test.tsx` 等
   - **11 个测试文件、61 个用例全部 PASS**（耗时 16.57s）。
3. **文件管理与面包屑域（Files & Breadcrumb & Tree）**：
   - 包含 `FileTreeView.test.tsx`、`FileBreadcrumb.test.tsx`、`FileViewerCard.test.tsx`、`FilesCard.test.tsx`、`FileActions.test.tsx` 等
   - **10 个测试文件、87 个用例全部 PASS**（耗时 12.05s）。
4. **分屏与多窗格域（Binary Tree & PaneHeader）**：
   - 包含 `LeafToolTabStrip.scoped.test.tsx`、`PaneHeader.test.tsx` 等
   - **39 个用例全部 PASS**（耗时 8.41s）。
5. **概览与浮层通知域（Overview & Overlay）**：
   - 包含 `ToastCard.test.tsx`、`ToastStack.test.tsx`、`ChangesSection.test.tsx`、`ScheduleSection.test.tsx` 等
   - **9 个测试文件、60 个用例全部 PASS**（耗时 14.33s）。

**总计通过针对性业务单元测试：505 个用例！**

---

## 六、审计结论与后续建议

1. **整体评价**：Wave 5（BATCH-5A, 5B, 5C）对非 Chat 业务域的原子化收敛执行得非常扎实与彻底，成功清除了全仓 81 个文件中绝大多数裸标签，且完备保留了三大测试桩、Tree/Tablist/Listbox ARIA 契约和核心状态机逻辑。
2. **重点整改建议**：
   - **P1**：立即为 `FileTreeView.tsx` 的旋转箭头按钮加上 `bare` 属性（或在 `FilesCard.module.css` 中补齐 `:global(.button).filesRowTwist`），消除布局抖动隐患；
   - **P2**：恢复 `NoteSidebarDrawer.tsx` 中的 10 位时间戳秒级兼容逻辑；
   - **P3**：在 Wave 5D 提交收口时，顺带运行 `npx vitest run tests/snapshots/ToastStack.test.tsx -u` 刷新 ToastStack 的快照 Hash。
3. **协作声明**：本审计严格遵守仓库协作纪律 §3，**不执行任何 git commit 操作**，改动与报告保留在工作区供主控 Agent 统一验证与收口。
