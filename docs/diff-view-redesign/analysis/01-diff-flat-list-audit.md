# 差异面板平直列表化与去圆角架构审计报告 (AUDIT-01)

> **战役名称**：差异面板与笔记面板系统性重构  
> **阶段与编号**：阶段一：前置代码现场深度审计 / AUDIT-01  
> **审计对象**：
> - [`DiffCardFileList.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx)（文件列表与单文件手风琴渲染器）
> - [`DiffCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css)（差异面板样式体系）
> - [`DiffCard.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.tsx)（顶层状态编排与容器组装层）  
> **审计基准**：用户最高裁决（平直列表化、去圆角、移除内部工具行、清理硬编码统一 Token）

---

## 1. 现场代码深度现状与问题清单（含精确行号引用）

通过对当前差异面板文件列表实现的逐行精读，发现当前代码严重背离了专业开发者工具（如 VS Code、GitKraken、Cursor、Sublime Merge）的高密度、低视觉噪点设计准则，充斥着残余的“卡片手风琴（Card Accordion）”隐喻、嵌套圆角外框以及过度设计带来的繁琐工具条。具体现场问题清单如下：

### 1.1 卡片手风琴外壳与圆角嵌套（视觉割裂与严重空间浪费）

1. **列表外层留白与卡片外框悬浮**：
   - [`DiffCard.module.css:176-177`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L176-L177)：`.fileList` 声明了 `gap: var(--space-2, 8px);` 与 `padding: var(--space-3, 10px);`。这导致整个文件列表与侧边栏两边脱离，四周被掏空出 10px 边距，每个文件项之间被生硬地拉开 8px 间距，使得文件列表呈现为一张张散落的“浮动卡片”，而不是连续紧凑的列表。
   - [`DiffCard.module.css:827`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L827)：在 Git 分组容器中，`.groupItemsContainer` 同样设置了 `gap: var(--space-2, 8px);`，加剧了卡片孤岛效应。
2. **多重圆角与激活态独立描边**：
   - [`DiffCard.module.css:192-202`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L192-L202)：`.accordionItem` 被赋予了 `border: 1px solid transparent;` 与 `border-radius: var(--radius-md, 6px);`，即使在折叠状态下也是一个带有 6px 圆角的胶囊块。
   - [`DiffCard.module.css:208-222`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L208-L222)：当条目激活（`.accordionActive`）时，边框变为 `border: 1px solid var(--border-subtle);`，圆角更是加大至 `border-radius: var(--radius-lg);`（8px），悬停时还要执行 `border-color: color-mix(...)` 加深计算。
   - **现场表现危害**：当变更文件数量达到 10 个以上时，屏幕上充斥着数十个圆角矩形框，视觉噪音极大；当展开某文件查看 Diff 时，代码比对视口被硬生生塞进一个 8px 圆角的悬浮卡片框内部，上下左右与列表严重割裂，完全丧失了现代 IDE 单轨平铺的流畅感。

### 1.2 单文件内部展开工具行（过度设计与认知过载）

在审查中发现，当前单文件展开时，在文件头和代码比对区之间插入了一整排复杂的工具栏：
- [`DiffCardFileList.tsx:219-328`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx#L219-L328)：在 `.inlineBody` 内部渲染了庞大的 `.inlineHeader` 工具行。
- [`DiffCardFileList.tsx:220-238`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx#L220-L238)：内嵌了一个名为“对比维度”的 `<Select size="sm">` 下拉选择器（`compareOptions`），包含“Git 工作区改动”、“AI 汇总改动”、“第 N 轮 AI 修改”、“当前源码全文 (无 Diff)”。**这与顶层工具栏 `DiffHeaderControls` 的全局会话/回合选择器严重功能重叠**。
- [`DiffCardFileList.tsx:240-327`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx#L240-L327)：内嵌了多达 6 个独立的图标按钮：
  1. `Lucide.ExternalLink`：在默认编辑器中打开该文件（调用 `openPathDefault`）
  2. `Lucide.FileDiff`：复制标准 Git Patch（调用 `formatGitPatch`）
  3. `Lucide.Copy`：复制最新文件源码（调用 `onCopyCode`）
  4. `Lucide.FileCode`：复制完整绝对路径（调用 `navigator.clipboard.writeText`）
  5. `actionDivider`（分割线）
  6. `Lucide.Check`：接受并写入磁盘（`onAcceptFile`）
  7. `Lucide.X`：从列表拒绝（`onRejectFile`）
- **现场表现危害**：用户明确裁决：“*去掉每个文件列表里面的顶部工具行，越简单越好，现在功能多了用户反而不知道怎么用了。*” 展开一个文件就会横向塞入 7 个小控件，占用 36px 垂直高度；若同时展开多个文件，每个文件都带着一模一样的重复工具行，极度拥挤杂乱，彻底击垮了界面的简洁可用性。

### 1.3 悬浮操作覆盖文件增删统计（视觉跳动与遮挡）

- [`DiffCard.module.css:311-314`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L311-L314)：
  ```css
  .accordionHeaderRow:hover .fileStat,
  .accordionHeaderRow:focus-within .fileStat {
    opacity: 0;
  }
  ```
- [`DiffCard.module.css:316-338`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L316-L338)：`.hoverActions` 使用绝对定位 `position: absolute; right: 12px; top: 50%; transform: translateY(-50%);`，并在 hover 时将 `opacity` 从 0 变为 1。
- **现场表现危害**：为了在仅有的行内塞下暂存（`+`）、取消暂存（`-`）、放弃修改（`Undo`）按钮，系统粗暴地在鼠标划过时把文件修改统计（`+N -M`）直接抹去（`opacity: 0`）。这种用覆盖抹除替代结构化排版的做法导致鼠标在列表移动时数字忽隐忽现，引发强烈的视觉闪烁跳动，反人机工效。

### 1.4 样式硬编码与 Token 体系脱节

现场代码中存在大量未经抽象的硬编码颜色、尺寸与行内样式：
- **颜色硬编码兜底**：
  - `DiffCard.module.css:14, 29, 169, 845`：`background: var(--bg-card, #ffffff);`（裸写纯白 `#ffffff`）。
  - `DiffCard.module.css:446, 462, 476, 730`：`background: var(--diff-bg-pane, #ffffff);`（裸写纯白 `#ffffff`）。
  - `DiffCard.module.css:140-142`：`var(--accent-red, #ef4444)`（多处裸写十六进制色彩兜底）。
- **字号与尺寸硬编码**：
  - `DiffCard.module.css:248`：`font-size: var(--font-size-sm, 13px);`。
  - `DiffCard.module.css:392, 592, 615, 669, 703, 786, 815`：七处出现 `font-size: var(--font-size-xs, 12px);`。
  - `DiffCard.module.css:513`：直接裸写 `font-size: 11px;`（未走 `var(--font-size-xxs)`）。
  - `DiffCard.module.css:754`：`font-size: var(--font-size-xxs, 11px);`。
  - `DiffCard.module.css:399`：裸写 `width: 140px; min-width: 120px;`。
- **TSX 行内样式裸写**：
  - [`DiffCardFileList.tsx:358, 386`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx#L358)：`<Lucide.MinusCircle style={{ marginRight: 3 }} />`、`<Lucide.PlusCircle style={{ marginRight: 3 }} />`。
  - [`DiffCard.tsx:328`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.tsx#L328)：`style={{ flexShrink: 0, marginTop: 1 }}`。
  - [`DiffCard.tsx:370, 405`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.tsx#L370)：`style={{ opacity: 0.3 }}`、`style={{ opacity: 0.45 }}`。
  - [`DiffCodeViewer.tsx:56`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCodeViewer.tsx#L56)：`style={{ padding: '16px 10px' }}`。

### 1.5 缺失专业 IDE 文件列表关键特征

- **缺失状态标记（Git Status Badge）**：只有数字 `+N -M`，缺少直观的 `M`（Modified / 修改）、`A`（Added / 新增）、`D`（Deleted / 删除）、`R`（Renamed / 重命名）语义标签。
- **缺少折叠展开图标（Chevron）**：文件项左侧没有展开/折叠指示箭头，用户无法一眼辨识条目当前的开闭状态。
- **路径与文件名无分级**：全路径与文件名混同在单个 text-overflow 容器中，未能像主流编辑器那样实现“文件名突出加粗、目录路径弱化淡出”的视觉层次。

---

## 2. 平直列表（Flat List）单轨架构模型与 DOM 重构设计

### 2.1 核心设计哲学：从“手风琴卡片岛”到“纯粹平直单轨”

全面彻底废弃 `.accordionItem` 卡片外壳，建立无圆角、无外框、无间距的平直列表。所有条目如同代码行一般紧密排列，条目之间仅通过 `1px solid var(--border-subtle)` 底部分割线界定边界；展开代码区直接嵌在当前条目正下方，成为列表天然的纵向扩展部分。

```
旧卡片手风琴模式（现存，视觉噪点大、层层包裹）：
┌─────────────────────────────────────────────────────────┐
│ .fileList (padding: 10px, gap: 8px)                     │
│  ┌───────────────────────────────────────────────────┐  │
│  │ .accordionItem (border-radius: 6px, border: 1px)  │  │
│  │   [file.ts +10 -2]  [Hover: + - Undo 盖住数字]     │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────┐  │
│  │ .accordionItem.accordionActive (radius: 8px, 独立框)│  │
│  │   [main.tsx +5 -1]                                │  │
│  │   ┌─────────────────────────────────────────────┐ │  │
│  │   │ .inlineHeader (工具行: 下拉 + 6个按钮) 36px │ │  │
│  │   ├─────────────────────────────────────────────┤ │  │
│  │   │ DiffCodeViewer (被卡片框包裹的代码)         │ │  │
│  │   └─────────────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘

新平直单轨模式（重构目标，专业平铺、零圆角、零冗余）：
┌─────────────────────────────────────────────────────────┐
│ .flatFileList (padding: 0, gap: 0, 全宽贴边)            │
│ ├─ [>] [M]  Button.tsx (src/components/ui/)   +12 -3    │ (32px)
│ ├─ [v] [A]  FlatList.tsx (src/components/diff/) +84     │ (32px, 激活态)
│ │  ┌─────────────────────────────────────────────────┐  │
│ │  │ DiffCodeViewer (直接贴合，无工具行，无内缩)     │  │
│ │  └─────────────────────────────────────────────────┘  │
│ ├─ [>] [D]  LegacyCard.module.css (src/styles/)   -120  │ (32px)
│ └─ 1px solid var(--border-subtle) 底部分割线贯通        │
└─────────────────────────────────────────────────────────┘
```

### 2.2 DOM 节点重构映射表 (Before vs After)

| 节点层级 | 现有实现 (Legacy) | 平直重构方案 (Flat List Target) | 改造目的与收益 |
| :--- | :--- | :--- | :--- |
| **容器根** | `<div className={styles.fileList}>` (带 10px 内边距与 8px 间距) | `<div className={styles.flatFileList} role="list" aria-label="变更文件列表">` | 边距全面归零，与外层侧边栏边界无缝拉通 |
| **Git 分组头** | `.gitGroupHeader` + inline styles | `.groupHeader` (高度 28px，底边线，吸顶粘滞) | 紧凑沉浸分组，移除行内样式 |
| **文件节点包装**| `<div className={styles.accordionItem}>` (圆角卡片) | `<div className={styles.fileNode}>` (物理列表节点，无边框无圆角) | 彻底消除外层独立卡片和 6px/8px 圆角 |
| **文件交互行** | `<button className={styles.fileItem}>` 被包裹在 row 中 | `<button className={styles.fileRow} aria-expanded={active}>` | 原生语义，32px 紧凑高度，完整键盘焦点与无障碍 |
| **折叠指示器** | 无 | `<Lucide.ChevronRight className={styles.chevronIcon} />` | 明确提示展开与折叠状态，顺时针 90° 平滑旋转 |
| **状态 Tag** | 无 | `<span className={`${styles.statusBadge} ${styles[status]}`}>M</span>` | 清晰区分 Modified(M)/Added(A)/Deleted(D) |
| **路径呈现** | 仅显示 basename，hover 时全路径在 Tooltip | `<div className={styles.filePath}><span className={styles.fileName}>name</span><span className={styles.dirPath}>dir/</span></div>` | 视觉层级清晰，名称显眼，路径辅助弱化 |
| **文件统计** | `.fileStat`（hover 时被强制 opacity: 0） | `.fileStat`（常驻右侧，等宽对齐，绝不隐藏） | 杜绝视觉跳动，数据常驻可见 |
| **文件快捷操作**| `.hoverActions`（绝对定位覆盖统计） | `.rowActions`（与统计并列排布，常态隐藏，hover 柔和浮现） | 布局物理隔离，互不重叠打架 |
| **单文件工具行**| `.inlineHeader` (内嵌对比维度下拉 + 6 个操作按钮) | **【彻底删除】** | 斩断一切认知杂音与空间浪费，极简纯粹 |
| **代码比对区** | `.inlineBody` (包裹在卡片内) | `<div className={styles.diffPane}>` (直接挂在 `fileRow` 底部，无框贴合) | 代码区全宽平铺，与主列表完全对齐 |

### 2.3 组件属性接口（DiffCardFileListProps）精简方案

由于彻底移除了展开条目内的 `.inlineHeader` 工具行，以下仅由该工具行消费的冗余 Props 与依赖可以直接从 `DiffCardFileList` 的组件契约中剔除：

```typescript
// 待删除的死属性（不再需要层层透传）:
- getFileCompareMode: (filePath: string) => CompareMode;
- onChangeCompareMode: (filePath: string, mode: CompareMode) => void;
- onAcceptFile: (f: FileDiff) => void;
- onRejectFile: (f: FileDiff) => void;
- onCopyCode: (filePath: string) => void;

// 待删除的死导入:
- classifyFileDiff
- openPathDefault
- formatGitPatch
- useToast
- Select
- IconButton (保留 Button 用于快捷暂存)
```

**精简后的极简属性契约**：
```typescript
interface DiffCardFileListProps {
  files: FileDiff[];
  sourceMode: DiffSourceMode;
  current: FileDiff | null;
  applyBusy: boolean;
  stagingPaths: Record<string, boolean>;
  aiTurns: Array<{
    msg: { id: string; timestamp: number };
    index: number;
    files: FileDiff[];
  }>;
  onSetActiveDiffSource: (diff: FileDiff | null) => void;
  onStageFile: (filePath: string) => void;
  onUnstageFile: (filePath: string) => void;
  onDiscardChanges: (filePath: string) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  renderInlineDiffContent: (f: FileDiff) => React.ReactNode;
  getFileDiffData?: (f: FileDiff) => FileDiff | null;
}
```

---

## 3. 几何规格与视觉对齐断言（高度、padding、分割线、展开贴合）

为了确保平直列表具备媲美专业级桌面 IDE 的像素级品质，必须在 CSS 规范中锁定以下硬性几何断言：

```
平直列表文件行（32px 高度几何剖面）：
┌────────────────────────────────────────────────────────────────────────┐
│ [>]   [M]   DiffCardFileList.tsx  apps/.../components/diff/   +42 −18  │  height: 32px
└────────────────────────────────────────────────────────────────────────┘
  │      │    │                     │                            │
 14px   16px  var(--text-primary)   var(--text-tertiary)        Mono
Chevron Badge 13px Medium           11px Regular                11px
```

### 3.1 容器与外壳几何断言

- **外层容器（`.flatFileList`）**：
  - `padding: 0;`（严禁出现任何 `10px` 或 `8px` 的 outer gutter 留白）。
  - `gap: 0;`（严禁容器级别 `gap: 8px`）。
  - `width: 100%; max-width: 100%; box-sizing: border-box;`。
  - `background: var(--bg-card);`。
  - `border-right: none;`。

### 3.2 平直文件行（`.fileRow`）几何断言

- **高度约束**：
  - `height: 32px; min-height: 32px; max-height: 32px;` 严格死锁 32px。
  - `box-sizing: border-box;`。
- **内边距与对齐**：
  - `padding: 0 12px;`（左侧 12px 起步，与面板顶栏图标视觉垂线严格对齐）。
- **底部分割线**：
  - `border-bottom: 1px solid var(--border-subtle);`（严格使用 `--border-subtle`，严禁裸写浅灰 `#eee` 或过深边框）。
  - `border-top: none; border-left: none; border-right: none;`。
- **圆角彻底归零**：
  - `border-radius: 0 !important;`（杜绝任何 `var(--radius-md)`、`6px`、`8px` 回潮）。
- **交互状态机色彩**：
  - 默认态：`background: transparent;`。
  - 悬停态（Hover）：`background: var(--bg-hover);`（`color-mix(in srgb, var(--text-primary) 2.5%, transparent)`）。
  - 激活态（Active/Expanded）：`background: var(--bg-active);` 并配备左侧 2px 蓝色强调条（`box-shadow: inset 2px 0 0 var(--accent-blue, #2563eb);`），无外凸边框。

### 3.3 行内子元素精密排版

1. **展开箭头（`.expandChevron`）**：
   - 尺寸：`14px x 14px`，居中对齐。
   - 色彩：`var(--text-tertiary)`，hover 时 `var(--text-secondary)`。
   - 动画：`transition: transform var(--transition-fast);`，激活时旋转 90 度（`transform: rotate(90deg);`）。
   - 间距：右侧 `margin-right: 6px;`。
2. **状态徽章（`.statusBadge`）**：
   - 尺寸：`16px x 16px`，字号 `10px`，字重 `600`，等宽字体。
   - 边框与背景：
     - `M` (Modified)：文字 `var(--diff-mod-fg, #d97706)`，背景 `color-mix(in srgb, var(--diff-mod-fg, #d97706) 12%, transparent)`。
     - `A` (Added)：文字 `var(--diff-add-fg, #10b981)`，背景 `color-mix(in srgb, var(--diff-add-fg, #10b981) 12%, transparent)`。
     - `D` (Deleted)：文字 `var(--diff-del-fg, #ef4444)`，背景 `color-mix(in srgb, var(--diff-del-fg, #ef4444) 12%, transparent)`。
     - `R` (Renamed)：文字 `var(--diff-ren-fg, #8b5cf6)`，背景 `color-mix(in srgb, var(--diff-ren-fg, #8b5cf6) 12%, transparent)`。
   - 圆角：微圆角 `border-radius: var(--radius-xs, 2px);`（纯粹内嵌标签，不影响列表平直结构）。
   - 间距：右侧 `margin-right: 8px;`。
3. **文件名与路径容器（`.pathWrap`）**：
   - `display: flex; align-items: baseline; min-width: 0; flex: 1 1 auto; overflow: hidden;`。
   - **文件名（`.fileName`）**：
     - `font-size: var(--font-size-xs, 12px); font-weight: var(--font-weight-medium, 500);`。
     - `color: var(--text-primary);`。
     - `white-space: nowrap; flex-shrink: 0;`。
   - **目录路径（`.dirPath`）**：
     - `font-size: var(--font-size-xxs, 11px); font-weight: 400;`。
     - `color: var(--text-tertiary);`。
     - `margin-left: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto;`。
4. **增删统计（`.fileStat`）**：
   - `font-family: var(--font-mono); font-size: var(--font-size-xxs, 11px); font-variant-numeric: tabular-nums;`。
   - 绿色增加：`color: var(--diff-add-fg);`，红色删除：`color: var(--diff-del-fg);`。
   - 常驻显示，严禁因为 hover 被设置为 `opacity: 0`。
5. **快捷动作组（`.rowActions`）**：
   - 宽度固定收敛在右侧（约 48px），采用 Flex 并排；按钮尺寸 `20px x 20px`。
   - 在未 hover 时，可保持完全透明或按需展示；hover 时背景为动作组提供微渐变底板，保证统计与按钮清晰共存。

### 3.4 展开比对区（`.diffPane`）贴合断言

- **贴合机制**：
  - 位于当前 `.fileRow` 正下方。
  - 外层外边距：`margin: 0;`。
  - 外层内边距：`padding: 0;`。
  - 底部分割线：`border-bottom: 1px solid var(--border-subtle);`。
  - 彻底拔除 `.inlineHeader`，使代码对比视口（`.scrollParent`）的第一行代码与上方文件标题行之间只有一条极细的 1px hairline，达到浑然一体的嵌合效果。

---

## 4. 旧路径与死层清退清单（逐项列出可删除的选择器与属性）

### 4.1 `DiffCard.module.css` 待删除选择器与属性清单

| 所在行范围 | 废弃 CSS 选择器 / 规则块 | 废弃属性细节 | 废弃根因说明 |
| :--- | :--- | :--- | :--- |
| **L176-177** | `.fileList` 容器边距 | `gap: var(--space-2, 8px);`<br>`padding: var(--space-3, 10px);` | 导致文件列表卡片化的间隙与边缘掏空，平直化必须清零 |
| **L192-206** | `.accordionItem` 及其 hover | `border: 1px solid transparent;`<br>`border-radius: var(--radius-md, 6px);`<br>`overflow: hidden;` | 手风琴独立卡片容器与 6px 圆角，彻底清退 |
| **L208-222** | `.accordionActive` 及其 hover | `border: 1px solid var(--border-subtle);`<br>`border-radius: var(--radius-lg);`<br>`border-color: color-mix(...)` | 激活态独立矩形外框与 8px 圆角，彻底清退 |
| **L223-228** | `.accordionHeaderRow` | `position: relative; display: flex;` | 旧手风琴行容器，被 `.fileRow` 替代 |
| **L230-263** | `.accordionItem :global(.fileItem)`<br>`.accordionItem .fileItem` 及其 hover / isActive | `border-radius: 0;`<br>`padding: 8px 12px;`<br>`background-color: var(--bg-active);` | 冗余特异性选择器，被平直无嵌套的 `.fileRow` 替代 |
| **L277-282** | `.fileNameLink:hover` | `text-decoration: underline;`<br>`color: var(--accent-blue);` | 整行已是 button，单设链接下划线制造视觉干扰 |
| **L311-314** | `.accordionHeaderRow:hover .fileStat` | `opacity: 0;` | **暴力隐藏反模式**：hover 时遮蔽修改统计数据，彻底抹除 |
| **L316-338** | `.hoverActions` (绝对定位模式) | `position: absolute; right: 12px; top: 50%; transform: translateY(-50%);` | 绝对定位覆盖排版，改为 Flex 紧凑并列 |
| **L340-365** | `.hoverActBtn` 及其微圆角 | `border-radius: var(--radius-xs);` | 旧手风琴行内按钮，并入标准原子按钮规范 |
| **L367-372** | `.inlineBody` | `display: flex; flex-direction: column;` | 被贴合的 `.diffPane` 替代 |
| **L374-383** | `.inlineHeader` (内部工具行) | `display: flex; align-items: center; padding: 4px 10px; border-bottom: 1px solid ...` | **用户明令裁决移除的工具行容器**，彻底清退 |
| **L385-396** | `.compareSelectorWrap`<br>`.selectLabel` | `font-size: var(--font-size-xs, 12px); color: var(--text-secondary);` | 内部对比维度下拉容器，功能与顶栏重叠，彻底清退 |
| **L398-401** | `.inlineCompareSelect` | `width: 140px; min-width: 120px;` | 内部对比维度下拉框，彻底清退 |
| **L403-407** | `.inlineActions` | `display: flex; align-items: center; gap: var(--space-1);` | 内部 6 个操作按钮的容器，彻底清退 |
| **L409-430** | `.inlineIconBtn` | `width: 28px; height: 28px; border-radius: var(--radius-sm, 4px);` | 内部操作图标按钮，彻底清退 |
| **L432-436** | `.actionDivider` | `width: 1px; height: 14px; background-color: var(--border-subtle);` | 内部工具栏分割线，彻底清退 |
| **L820** | `.groupEmptyHint` | `border-radius: var(--radius-md);` | 提示框圆角，平直化归零为 0 |
| **L827** | `.groupItemsContainer` | `gap: var(--space-2, 8px);` | Git 分组内卡片间距，彻底归零为 0 |

### 4.2 `DiffCardFileList.tsx` 待删除代码面清单

1. **废弃逻辑与计算状态**：
   - 移除 `compareOptions` 计算与组合（[`L119-136`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx#L119-L136)）。
   - 移除 `acceptLabel` 动态生成逻辑（[`L115-117`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx#L115-L117)）。
   - 移除常量：`UNSTAGE_LABEL`, `STAGE_LABEL`, `DISCARD_LABEL`, `REJECT_LABEL` 中仅用于单文件工具条的常量（[`L31-35`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx#L31-L35)）。
2. **废弃 JSX 渲染树**：
   - 彻底删除整个 `{active && <div className={styles.inlineBody}><div className={styles.inlineHeader}>...</div></div>}` 结构块（[`L217-332`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx#L217-L332)）。
   - 仅保留 `{active && <div className={styles.diffPane}>{renderInlineDiffContent(f)}</div>}`。
3. **废弃外部 API 引入**：
   - [`L4`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx#L4)：移除 `Select`、`IconButton` 引用。
   - [`L5`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx#L5)：移除 `classifyFileDiff` 引用。
   - [`L6`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx#L6)：移除 `openPathDefault` 引用。
   - [`L12`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx#L12)：移除 `formatGitPatch` 引用。
   - [`L13`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx#L13)：移除 `useToast` 引用。

---

## 5. 净负产出评估与后续重构风险防范

### 5.1 净负产出量化评估（以代码精简为荣）

本次审计设计的平直单轨架构方案，是一次极具代表性的“架构减重与净收敛”行动：

- **`DiffCardFileList.tsx`**：
  - 当前代码量：`408 行`
  - 待清退工具栏 JSX 与冗余状态计算：`~170 行`
  - 待精简接口与导入：`~25 行`
  - 重构后平直列表结构：预计 `~210 行`
  - **预计净负产出：-198 行（精简幅度达 48.5%）**
- **`DiffCard.module.css`**：
  - 当前代码量：`893 行`
  - 待清退卡片手风琴样式（`.accordionItem`, `.accordionActive`, `.inlineHeader`, `.inlineActions` 等）：`~145 行`
  - 新增平直列表几何规约（`.flatFileList`, `.fileRow`, `.statusBadge`, `.diffPane` 等）：预计 `~45 行`
  - **预计净负产出：-100 行**
- **整体工程净负产出**：
  - 核心文件代码**净减少约 300 行**，消除 14 个冗余 CSS 类名与 6 个行内样式，DOM 层级从 6 层压平至 3 层。

### 5.2 既有测试用例契约与回归风险防范

在梳理测试资产时，识别出以下强相关测试用例，重构执行期必须严格防范破损并按规范平稳迁移：

1. **样式契约测试门禁（[`style-contract.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/style-contract.test.ts)）**：
   - [`style-contract.test.ts:515-526`](file:///c:/Software/conex/apps/crish-desktop/src/styles/style-contract.test.ts#L515-L526) 明确对 CSS 字符串进行了刚性正则匹配：
     ```typescript
     expect(css).toContain('.accordionHeaderRow:hover .hoverActions');
     expect(css).toContain('.accordionHeaderRow:focus-within .hoverActions');
     expect(css).toContain('.accordionHeaderRow:focus-within .fileStat');
     ```
   - **风险防范策略**：
     - 若直接重命名 `.accordionHeaderRow` 为 `.fileRow`，将直接破坏此断言。
     - **解决方案**：在重构时，将平直列表行类名定为 `.fileRow` 的同时，在 CSS 中保留 `.accordionHeaderRow` 联合选择器（例如 `.fileRow, .accordionHeaderRow`）作为平滑过渡兼容，或者在同一个重构提交批次中受控更新测试断言，确保 CI 门禁持续 100% 绿灯。
   - [`style-contract.test.ts:528-535`](file:///c:/Software/conex/apps/crish-desktop/src/styles/style-contract.test.ts#L528-L535) 对 `role="list"`、`aria-label="变更文件列表"` 以及禁用 `role="listbox"` / `role="option"` 的断言：
     - 平直列表完全继承 `role="list"` 语义，该项断言将天然保持通过。
2. **列表单元测试（[`DiffCardFileList.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.test.tsx)）**：
   - `it('should disable Accept button for provisional diff')`（依赖已删除的工具栏接受按钮）。
   - `it('renders inline compare Select with explicit size="sm" preventing overflow')`（依赖已删除的对比维度下拉）。
   - `it('renders targetDiff additions and deletions when getFileDiffData is provided')`（文件行增删统计断言，平直列表继续保留）。
   - **风险防范策略**：
     - 前两个用例系针对已被废弃的 `.inlineHeader` 工具栏而写，在执行阶段需同步将这部分逻辑迁移到对应的单元（例如全局接受或顶栏维度测试）或安全废弃，避免脏测试阻断流水线。
3. **性能测试（[`DiffCard.perf.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.perf.test.tsx)）**：
   - 压测 3500+ 行的大文件解析与虚拟滚动。
   - 平直列表化彻底去除了外层 6px/8px 圆角的重绘图层与嵌套 DOM，将显著降低浏览器 Composite 与 Layout 压力，使大列表交互与展开耗时进一步收敛。

### 5.3 结论与后续阶段交接建议

本审计报告（AUDIT-01）已确立差异面板平直列表化的完整拓扑设计与几何规范：
- 物理形态：**单轨、平铺、去圆角（0px）、全宽贴合、1px 底部分割线**。
- 功能形态：**彻底拔除单文件展开内部工具行，认知极简化，空间利用率最大化**。
- Token 规范：**拔除裸写 `#ffffff` 与尺寸，统一对齐 `--border-subtle`、`--bg-hover`、`--bg-active`、`--text-primary` 等权威单一真源**。
- 该审计结论可直接指导下一阶段方案设计与重构实施。
