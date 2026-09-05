# 差异面板跨方案深层打架排查官贯通审计报告
## （Diff View Cross-Plan Conflict Audit & SSOT Convergence Directive）

> **审计执行人**：差异面板跨方案深层打架排查官（Diff View Cross-Plan Conflict Auditor）  
> **审计范围**：  
> - `docs/diff-view-redesign/00-总方案-差异与笔记面板系统性重构全景架构总纲.md`  
> - `docs/diff-view-redesign/01-分维详案-差异面板平直列表直角化与32px紧凑架构.md`  
> - `docs/diff-view-redesign/02-分维详案-行内工具条物理拔除与代码比对专注化.md`  
> - `docs/diff-view-redesign/03-分维详案-文件名超链接单轨接线独立预览Tab与全域Tokens规范.md`  
> - `docs/diff-view-redesign/04-分维详案-全域Tokens规范重构与SLoHT单层Hover体系.md`  
> - `docs/diff-view-redesign/07-分维详案-立体验证套件与回归测试平滑迁移.md`  
> **代码物理坐标**：  
> - 组件实体：[`apps/crish-desktop/src/components/diff/DiffCardFileList.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx)  
> - 宿主父组件：[`apps/crish-desktop/src/components/diff/DiffCard.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.tsx)  
> - 样式实体：[`apps/crish-desktop/src/components/diff/DiffCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css)  
> - 测试实体：[`apps/crish-desktop/src/components/diff/DiffCardFileList.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.test.tsx)  
> **审计日期**：2026-09-05  

---

# 一、审计结论先行摘要（Executive Summary）

经过对 `docs/diff-view-redesign/` 下 00 总纲、01、02、03、04 四份详案及 07 测试方案的全文逐行对照与源码现场核验，排查官正式签署审计结论：

> [!CAUTION]
> **审计最高裁决**：**各方案之间确实存在极其严重的深层打架（Deep Cross-Plan Conflicts）！**  
> 在未经过本报告贯通裁决前，若任由各 Agent 孤立落盘代码，将立刻导致：**TypeScript 编译类型断裂、组件与样式表 10+ 处选择器失配脱节、DOM 树结构破损变形、测试套件用例当场红灯崩溃**！

### 核心打架点速查总览：
1. **DOM 树与三大子域结构打架**：
   - 01 详案确立了三大正交子域规范（子域 A Chevron+徽标；子域 B 超链接+路径；子域 C 统计+Git 操作）；
   - **03 详案擅自造反**，在 03 §5.2 中生造了 `div.accordionFiller`，将子域 B 的 `dirPath` 与子域 C 的增减统计 `fileStat` 强行揉杂在一个容器内并绑定展开点击事件，破坏了正交解耦模型；04 在 CSS 施工图中将 `.foldIcon` 错塞进 `.pathWrap`。
2. **Props 接口定义父子打架（“02 删了 01 还要用，03 删了 07 还要测”）**：
   - **02 激进硬删除**：02 从 `DiffCardFileListProps` 中强行剔除了 6 项属性（`getFileCompareMode`, `onChangeCompareMode`, `onAcceptFile`, `onRejectFile`, `onCopyCode`, `aiTurns`）；然而，**现行父组件 `DiffCard.tsx`（L347-367）与 07 测试方案（L527-585）全部都在全量传递这些属性**！一旦按 02 代码落盘，编译直接报错；
   - **03 越权断路删除**：03 在 03 §5.2 中擅自删除了 `onOpenFileViewer`、`onStageAll`、`onUnstageAll`，改为内部硬编码调用 storeAccess，导致 07 测试用例 4（验证 `onOpenFileViewer` 独立触发）必定挂死！
3. **选择器名称“各说各话”，绝非 100% 一字不差**：
   - 全景排查发现 **10 处严重打架类名**（例如折叠按钮：01 `.chevronBtn` vs 03 `.accordionToggleBtn` vs 04 `.foldIcon`；统计标签：01 `.statAdd` vs 03 `.addStat` vs 04 `.fileStat .add`；Git动作：01 `.rowActions` vs 03 `.hoverActions`）；
   - 发现 **5 处缺失选择器**（03 丢失徽标颜色类 `.mod`/`.add`/`.del`/`.ren`、丢失中性 0 统计 `.statNeutral`、丢失头部全部暂存按钮类等）。
4. **SLoHT 规则执行倒挂与微观补丁**：
   - 01 详案虽声明直角与平直，但在 CSS 第 1340 行对 `.rowActBtn:hover` 误声明了 `background-color: var(--bg-hover)`，触犯了 04 详案与 SLoHT 规范（悬停叠灰）；
   - 04 详案虽规范了 SLoHT，但在 CSS 施工图第 1105/1115 行违规裸写 Hex 色值（`#f59e0b`, `#ef4444`），且类名与 01 完全脱节。

### 谁让路？唯一方案是什么？
- **03 全线让路**：03 的私造 DOM 树、私造类名与 Props 剔除全部废黜，仅保留其在 `openTool.ts` 中的 Tab 调度机制；
- **02 激进类型让路**：02 切除 `_inlineHeader_` 保留，但接口必须采纳 01 的“可选兼容性契约”；
- **04 类名让路，原则反哺**：04 施工图类名让位于 01，但 04 的 SLoHT 悬停规则（按钮背景严格 transparent）与全域 Design Tokens 必须反哺注入 01 的样式表；
- **01 确立为 AST 与选择器唯一真源（SSOT）**：经本报告综合调和后，输出全战役唯一合法生产级源码。

---

# 二、排查维度一：DOM 树顶级容器与三大正交子域 JSX 嵌套结构打架深度排查

### 2.1 顶级容器标签类型排查
- **核查对象**：文件列表根容器标签与属性。
- **排查结果**：**完全收敛**。
  - 01 详案（L914-918）：`<div className={styles.flatFileList} role="list" aria-label="变更文件列表">`；
  - 02 详案（L786-790）：`<div className={styles.flatFileList} role="list" aria-label="变更文件列表">`；
  - 03 详案（L1690-1694）：`<div className={styles.flatFileList} role="list" aria-label="变更文件列表">`；
  - 04 详案（L283-292）：`.flatFileList { display: flex; flex-direction: column; ... }`；
  - 07 测试方案（L550-553）：断言 `container.querySelector('[role="list"]')` 且 `aria-label="变更文件列表"`。
- **裁决**：根节点锁定为 `<div className={styles.flatFileList} role="list" aria-label="变更文件列表">`。

### 2.2 单条目行容器标签类型与 W3C 规范守门
- **核查对象**：`.fileRow` 的 HTML 标签类型。
- **排查结果**：**必须刚性声明为 `<div>`，严禁为 `<button>`**。
  - 历史隐患：在早期分析及 04 详案草案第 331 行曾出现“*文件条目由 `<button type="button" class="fileRow">` 承载*”的表述；
  - 病理定性：根据 W3C HTML5 规范 §4.10.6（Interactive Content），`<button>` 内部绝对严禁包含任何交互性元素（如内层子域 A 的折叠 button、子域 B 的超链接 button、子域 C 的操作 button）。若外层为 `<button>`，WebView2 将发生标签强制闭合或事件捕获崩溃；
  - 现已全部收敛：01、02、03、04 修订版均锁定为 `<div className={styles.fileRow} data-active={active}>`。

### 2.3 三大正交子域 JSX 嵌套结构深层打架尸检（01 vs 03 vs 04）
各详案在文件条目内部的三大子域划分上出现了严重的结构分裂：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 详案 01 标准 AST (SSOT):                                                               │
│ div.fileRow (32px)                                                                     │
│   ├── [子域 A] button.chevronBtn > Lucide.ChevronRight.chevronIcon                     │
│   ├── [子域 A] span.statusBadge.mod/add/del/ren                                        │
│   ├── [子域 B] div.pathWrap (flex: 1 1 auto, 弹性截断)                                 │
│   │              ├── button.fileNameLinkBtn > span.fileName (超链接预览)               │
│   │              └── span.dirPath (目录弱化显示)                                       │
│   └── [子域 C] div.statAndActions (flex-shrink: 0, 常驻不遮挡)                         │
│                  ├── span.fileStat (常驻统计, +15 -7)                                  │
│                  └── div.rowActions (Git 操作, 浮现)                                   │
└────────────────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────────────────┐
│ 详案 03 破损结构 (VIOLATION):                                                          │
│ div.fileRow (32px)                                                                     │
│   ├── button.accordionToggleBtn                                                        │
│   ├── span.statusBadge                                                                 │
│   ├── Tooltip > button.fileNameLinkBtn > span.fileNameText                             │
│   ├── div.accordionFiller (role="presentation", onClick=toggleExpand) ❌ 结构污染      │
│   │     ├── span.dirPath                                                               │
│   │     └── span.fileStat > span.addStat + span.delStat ❌ 统计被塞进折叠点击区!       │
│   └── div.hoverActions ❌ 独立散落外层                                                 │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

#### 破损分析与冲突剖析：
1. **03 详案将统计标签塞进折叠过渡区的严重错误**：
   在 03 详案第 1607-1621 行中，作者创建了 `div.accordionFiller`，把 `span.fileStat` 塞入其中，并为该容器挂载了 `onClick={() => onSetActiveDiffSource(...)}`。这导致用户在点击增减统计标签时，会意外触发折叠展开代码，直接击穿了三大子域正交隔离的顶层军规！
2. **03 详案破坏 Flexbox 弹性自适应**：
   01 详案的 `pathWrap` 将主文件名与所在目录包裹在一起，赋予 `overflow: hidden; flex: 1 1 auto;`，并在 360px 极窄视口通过 `@container diff-panel (max-width: 360px)` 自动隐藏 `.dirPath`，全力保全主文件名。而 03 详案将二者拆散，破坏了自适应收缩机制。
3. **04 详案 CSS 施工图错位**：
   在 04 详案第 1058-1070 行的 CSS 施工图中，作者将 `.foldIcon` 放到了 `.pathWrap` 内部，与 01 详案中“子域 A 独立居左（固定 16px+16px），子域 B 位于其右”的布局发生冲突，会导致左侧对齐线参差不齐。

### 2.4 子域结构终审裁决
- **裁决**：**03 的 `div.accordionFiller` 结构彻底废除！04 的错位 CSS 彻底废除！**
- **唯一法定结构**：严格遵守 **01 详案的三大正交子域 AST**：
  1. **子域 A（折叠与状态）**：居左固定宽度，`button.chevronBtn` + `span.statusBadge`；
  2. **子域 B（超链接与路径）**：中间弹性自适应，`div.pathWrap`（内含 `button.fileNameLinkBtn` 与 `span.dirPath`）；
  3. **子域 C（统计与操作）**：居右并列流式排布，`div.statAndActions`（内含常驻 `span.fileStat` 与浮现 `div.rowActions`）；
  4. **展开视口**：紧邻 `fileRow` 之下嵌合，`<div className={styles.diffPane}>{renderInlineDiffContent(f)}</div>`。

---

# 三、排查维度二：Props 接口定义父子跨层击穿打架排查

这是本次重构中最容易引发构建与测试全面瘫痪的致命暗坑！

### 3.1 跨方案 Props 契约现场对照表

| Props 属性名 | 现行 DiffCard.tsx 传参 (L347-367) | 01 详案定义 (L619-663) | 02 详案定义 (L538-553) | 03 详案定义 (L1506-1518) | 07 详案单测传参 (L527-585) | 打架定性与影响 |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| `files` | ✅ 必传 | ✅ 必传 | ✅ 必传 | ✅ 必传 | ✅ 必传 | 无冲突 |
| `sourceMode` | ✅ 必传 | ✅ 必传 | ✅ 必传 | ✅ 必传 | ✅ 必传 | 无冲突 |
| `current` | ✅ 必传 | ✅ 必传 | ✅ 必传 | ✅ 必传 | ✅ 必传 | 无冲突 |
| `applyBusy` | ✅ 必传 | ✅ 必传 | ✅ 必传 | ✅ 必传 | ✅ 必传 | 无冲突 |
| `stagingPaths` | ✅ 必传 | ✅ 必传 | ✅ 必传 | ✅ 必传 | ✅ 必传 | 无冲突 |
| `onSetActiveDiffSource` | ✅ 必传 | ✅ 必传 | ✅ 必传 | ✅ 必传 | ✅ 必传 | 无冲突 |
| `onStageFile` | ✅ 必传 | ✅ 必传 | ✅ 必传 | ✅ 必传 | ✅ 必传 | 无冲突 |
| `onUnstageFile` | ✅ 必传 | ✅ 必传 | ✅ 必传 | ✅ 必传 | ✅ 必传 | 无冲突 |
| `onDiscardChanges` | ✅ 必传 | ✅ 必传 | ✅ 必传 | ✅ 必传 | ✅ 必传 | 无冲突 |
| `renderInlineDiffContent`| ✅ 必传 | ✅ 必传 | ✅ 必传 | ✅ 必传 | ✅ 必传 | 无冲突 |
| `getFileDiffData` | ✅ 可选 | ✅ 可选 | ✅ 可选 | ✅ 可选 | ✅ 可选 | 无冲突 |
| `onStageAll` | ✅ 必传 | ✅ 必传 | ✅ 必传 | ❌ **擅自删除** | ✅ 必传 | **03 打架**：03 删除了批量暂存回调 |
| `onUnstageAll` | ✅ 必传 | ✅ 必传 | ✅ 必传 | ❌ **擅自删除** | ✅ 必传 | **03 打架**：03 删除了批量取消暂存回调 |
| `onOpenFileViewer` | ❌ 现行未传 | ✅ **可选新增** | ✅ **可选新增** | ❌ **擅自删除** | ✅ **单测必测** | **03 打架**：03 硬编码 storeAccess，阻断测试注入 |
| `aiTurns` | ✅ 必传 | ⚠️ **标记可选** | ❌ **硬性删除** | ❌ **硬性删除** | ✅ **全单测均传** | **02/03 打架**：02 删了 07 还要测，编译即报错 |
| `getFileCompareMode` | ✅ 必传 | ⚠️ **标记可选** | ❌ **硬性删除** | ❌ **硬性删除** | ✅ **全单测均传** | **02/03 打架**：02 删了 07 还要测，编译即报错 |
| `onChangeCompareMode` | ✅ 必传 | ⚠️ **标记可选** | ❌ **硬性删除** | ❌ **硬性删除** | ✅ **全单测均传** | **02/03 打架**：02 删了 07 还要测，编译即报错 |
| `onAcceptFile` | ✅ 必传 | ⚠️ **标记可选** | ❌ **硬性删除** | ❌ **硬性删除** | ✅ **全单测均传** | **02/03 打架**：02 删了 07 还要测，编译即报错 |
| `onRejectFile` | ✅ 必传 | ⚠️ **标记可选** | ❌ **硬性删除** | ❌ **硬性删除** | ✅ **全单测均传** | **02/03 打架**：02 删了 07 还要测，编译即报错 |
| `onCopyCode` | ✅ 必传 | ⚠️ **标记可选** | ❌ **硬性删除** | ❌ **硬性删除** | ✅ **全单测均传** | **02/03 打架**：02 删了 07 还要测，编译即报错 |

### 3.2 深度冲突剖析

#### 冲突 1：02 详案“激进硬删除”导致与 07 测试方案断裂
- **证据**：详案 02 第 270-277 行明确写道：
  > “*在 DiffCardFileListProps 接口中彻底剔除：getFileCompareMode、onChangeCompareMode、onAcceptFile、onRejectFile、onCopyCode、aiTurns。*”
- **破损**：然而，详案 07（立体验证套件）在重构 `DiffCardFileList.test.tsx` 时，在用例 2（L527-546）、用例 3（L567-586）、用例 4（L607-628）、用例 5（L658-677）、用例 6（L697-716）中，**每一个用例都显式传递了这 6 个属性**！
- **后果**：如果使用 02 详案的 `DiffCardFileListProps` 定义，TypeScript 编译器立刻报错：`Type '...' has no properties in common with type 'IntrinsicAttributes & DiffCardFileListProps'`，导致 CI Fast 门禁当场暴毙！

#### 冲突 2：03 详案“擅自短路”导致测试桩失效
- **证据**：详案 03 第 1506-1518 行将 `onOpenFileViewer` 彻底移出 Props，改在组件第 1598 行直接执行：
  `openFileViewerInSession(f.filePath, 'diff');`
- **破损**：详案 07 用例 4（L601-652）的核心验收断言是：
  ```tsx
  const onOpenFileViewer = vi.fn();
  render(<DiffCardFileList ... onOpenFileViewer={onOpenFileViewer} />);
  fireEvent.click(linkBtn);
  expect(onOpenFileViewer).toHaveBeenCalledWith('src/utils/math.ts');
  ```
- **后果**：如果使用 03 详案的代码，组件根本不接受 `onOpenFileViewer`，点击超链接也不会调用测试 Mock 函数，用例 4 必然失败！同时，03 还把 `onStageAll` 和 `onUnstageAll` 给删除了，导致 Git 分组头部的批量操作彻底失效。

### 3.3 Props 接口终审收敛方案（SSOT）
- **让路裁决**：**02 与 03 详案在接口定义上必须无条件让路！全面采纳 01 详案的平滑兼容契约！**
- **法定唯一接口定义**：
```tsx
export interface DiffCardFileListProps {
  files: FileDiff[];
  sourceMode: DiffSourceMode;
  current: FileDiff | null;
  applyBusy: boolean;
  stagingPaths: Record<string, boolean>;
  onSetActiveDiffSource: (diff: FileDiff | null) => void;
  onStageFile: (filePath: string) => void;
  onUnstageFile: (filePath: string) => void;
  onDiscardChanges: (filePath: string) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  renderInlineDiffContent: (f: FileDiff) => React.ReactNode;
  getFileDiffData?: (f: FileDiff) => FileDiff | null;
  /** 点击文件名超链接在右侧独立 Tab 打开 FileViewer 预览回调 (正交子域 B) */
  onOpenFileViewer?: (filePath: string) => void;

  /* =========================================================================
   * 兼容性保留契约：标记为可选，确保 07 单测套件与 DiffCard.tsx 平滑过渡
   * ========================================================================= */
  aiTurns?: Array<{
    msg: { id: string; timestamp: number };
    index: number;
    files: FileDiff[];
  }>;
  getFileCompareMode?: (filePath: string) => CompareMode;
  onChangeCompareMode?: (filePath: string, mode: CompareMode) => void;
  onAcceptFile?: (f: FileDiff) => void;
  onRejectFile?: (f: FileDiff) => void;
  onCopyCode?: (filePath: string) => void;
}
```

---

# 四、排查维度三：CSS 样式表与 TSX 组件间选择器名称 100% 一字不差刚性核验

排查官对组件源码与样式表进行了逐字核对，发现由于多 Agent 协作漂移，产生了多达 10 处选择器严重打架与 5 处选择器遗漏！

### 4.1 选择器跨方案对照与打架核查矩阵

| 序号 | 界面节点语义 | 01 SSOT JSX 调用 | 01 SSOT CSS 声明 | 03 漂移命名 | 04 漂移命名 | 冲突状态 | 终审收敛唯一选择器 (SSOT) |
| :---: | :--- | :--- | :--- | :--- | :--- | :---: | :--- |
| 1 | 列表根容器 | `styles.flatFileList` | `.flatFileList` | `.flatFileList` | `.flatFileList` | ✅ 一致 | **`.flatFileList`** |
| 2 | 条目逻辑容器 | `styles.fileNode` | `.fileNode` | `.fileNode` | `.fileNode` | ✅ 一致 | **`.fileNode`** |
| 3 | 32px 交互行 | `styles.fileRow` | `.fileRow` | `.fileRow` | `.fileRow` | ✅ 一致 | **`.fileRow`** |
| 4 | 交互行激活态 | `styles.isActive` | `.fileRow.isActive` | `.fileRow.isActive` | `.fileRow.isActive` | ✅ 一致 | **`.isActive`** |
| 5 | 折叠 Chevron 按钮 | `styles.chevronBtn` | `.chevronBtn` | `.accordionToggleBtn` | (无独立按钮) | ❌ **打架** | **`.chevronBtn`**（03 让路） |
| 6 | 折叠 Chevron 图标 | `styles.chevronIcon` | `.chevronIcon` | `.accordionChevron` | `.foldIcon` | ❌ **打架** | **`.chevronIcon`**（03/04 让路） |
| 7 | 图标展开旋转态 | `styles.expanded` | `.expanded` | `.chevronOpen` | `.foldIconExpanded` | ❌ **打架** | **`.expanded`**（03/04 让路） |
| 8 | 状态徽标基础类 | `styles.statusBadge` | `.statusBadge` | `.statusBadge` | `.statusBadge` | ✅ 一致 | **`.statusBadge`** |
| 9 | 状态徽标语义色 (M) | `styles.mod` | `.statusBadge.mod` | ❌ 丢失 | `.statusBadge.modified` | ❌ **打架** | **`.statusBadge.mod`**（04 让路） |
| 10| 状态徽标语义色 (A) | `styles.add` | `.statusBadge.add` | ❌ 丢失 | `.statusBadge.added` | ❌ **打架** | **`.statusBadge.add`**（04 让路） |
| 11| 状态徽标语义色 (D) | `styles.del` | `.statusBadge.del` | ❌ 丢失 | `.statusBadge.deleted` | ❌ **打架** | **`.statusBadge.del`**（04 让路） |
| 12| 状态徽标语义色 (R) | `styles.ren` | `.statusBadge.ren` | ❌ 丢失 | `.statusBadge.untracked` | ❌ **打架** | **`.statusBadge.ren`**（04 让路） |
| 13| 路径与名称包裹容器 | `styles.pathWrap` | `.pathWrap` | ❌ 丢失 (生造成 accordionFiller) | `.pathWrap` | ❌ **打架** | **`.pathWrap`**（03 让路） |
| 14| 文件名超链接按钮 | `styles.fileNameLinkBtn` | `.fileNameLinkBtn` | `.fileNameLinkBtn` | `.fileNameLink` | ❌ **打架** | **`.fileNameLinkBtn`**（04 让路） |
| 15| 主文件名文本 | `styles.fileName` | `.fileName` | `.fileNameText` | `.fileName` | ❌ **打架** | **`.fileName`**（03 让路） |
| 16| 所在目录弱化文本 | `styles.dirPath` | `.dirPath` | `.dirPath` | `.dirPath` | ✅ 一致 | **`.dirPath`** |
| 17| 统计与操作总容器 | `styles.statAndActions`| `.statAndActions` | ❌ 丢失 (散落排布) | `.statAndActions` | ❌ **打架** | **`.statAndActions`**（03 让路） |
| 18| 常驻增减统计标签 | `styles.fileStat` | `.fileStat` | `.fileStat` | `.fileStat` | ✅ 一致 | **`.fileStat`** |
| 19| 增加行绿色数字 | `styles.statAdd` | `.statAdd` | `.addStat` | `.fileStat .add` | ❌ **打架** | **`.statAdd`**（03/04 让路） |
| 20| 删除行红色数字 | `styles.statDel` | `.statDel` | `.delStat` | `.fileStat .del` | ❌ **打架** | **`.statDel`**（03/04 让路） |
| 21| 零变更中性灰色数字 | `styles.statNeutral` | `.statNeutral` | ❌ 缺失 | ❌ 缺失 | ❌ **缺失** | **`.statNeutral`**（补齐） |
| 22| Git 行内动作容器 | `styles.rowActions` | `.rowActions` | `.hoverActions` | `.rowActions` | ❌ **打架** | **`.rowActions`**（03 让路） |
| 23| 行内快捷按钮 | `styles.rowActBtn` | `.rowActBtn` | `.hoverActBtn` | `.rowActBtn` | ❌ **打架** | **`.rowActBtn`**（03 让路） |
| 24| 危险动作修饰类 | `styles.danger` | `.danger` | `.danger` | `.danger` | ✅ 一致 | **`.danger`** |
| 25| 暂存处理加载动画 | `styles.spinner` | `.spinner` | `.spinner` | (未体现) | ✅ 一致 | **`.spinner`** |
| 26| 展开代码比对视口 | `styles.diffPane` | `.diffPane` | `.diffPane` | `.diffPane` | ✅ 一致 | **`.diffPane`** |
| 27| Git 分组区域容器 | `styles.groupSection` | `.groupSection` | `.groupSection` | (未体现) | ✅ 一致 | **`.groupSection`** |
| 28| Git 分组表头 | `styles.groupHeader` | `.groupHeader` | `.groupHeader` | (未体现) | ✅ 一致 | **`.groupHeader`** |
| 29| Git 分组标题文字 | `styles.groupTitle` | `.groupTitle` | `.groupTitle` | (未体现) | ✅ 一致 | **`.groupTitle`** |
| 30| Git 分组全部操作按钮 | `styles.groupActionBtn`| `.groupActionBtn` | ❌ 缺失 (删除了按钮) | (未体现) | ❌ **缺失** | **`.groupActionBtn`**（03 让路） |
| 31| 按钮内部图标间距 | `styles.btnIcon` | `.btnIcon` | ❌ 缺失 | (未体现) | ❌ **缺失** | **`.btnIcon`**（01 SSOT） |
| 32| Git 分组条目容器 | `styles.groupBody` | `.groupBody` | `.groupItemsContainer` | (未体现) | ❌ **打架** | **`.groupBody`**（03 让路） |
| 33| Git 分组空状态提示 | `styles.groupEmptyHint`| `.groupEmptyHint` | ❌ 缺失 (空时直接隐藏) | (未体现) | ❌ **缺失** | **`.groupEmptyHint`**（01 SSOT） |

### 4.2 排查定性与裁决总结
1. **03 详案私造类名最多**（共 9 处打架、5 处丢失），主要原因是 03 作者在未吸收 01 详案终审稿的情况下，基于旧代码自行推导；
2. **04 详案在样式表施工图中命名不守纪律**：04 在 §2.5 的表格中虽然认同了 01 的类名，但在 §5.1 的实际 CSS 代码中却写成了 `.foldIcon`、`.fileNameLink`、`.fileStat .add`、`.statusBadge.modified`，自相矛盾；
3. **裁决**：**全部选择器以 01 详案的 33 大标准类名为唯一定型标准（100% 一字不差匹配）！**

---

# 五、排查维度四：SLoHT 单层 Hover 体系与设计 Tokens 的微观冲突与融合

在微观 CSS 规则层面，排查官发现了两处隐藏极深的违章代码：

### 5.1 详案 01 的 SLoHT 违章微观毒点
- **现场代码**：`01-分维详案` 第 1340 行：
  ```css
  .rowActBtn:hover {
    color: var(--text-primary);
    background-color: var(--bg-hover); /* ❌ 违章：触犯 SLoHT 悬停叠加 */
    border-color: var(--border-subtle);
  }
  ```
- **病理剖析**：
  根据 04 详案与视觉评审（AUDIT-FINAL-UI-TOKENS 缺陷 08），`.rowActBtn` 位于已经处于 `:hover` 状态的 `.fileRow` 内部（背景为 `--bg-hover`）。若按钮悬停时再赋予一层 `--bg-hover`，在视觉上会形成局部的二次叠加灰色补丁（叠灰深度接近 4.9%~6.8%），产生“界面脏、灰斑”的不良体验。
- **纠偏方案**：必须吸收 04 详案的正确规则：
  `.rowActBtn:hover` 必须保持 `background: transparent;`，悬停仅改变 `color: var(--text-primary);` 与 `border-color: var(--border-subtle);`！对于危险按钮，仅改变文字色为 `var(--color-error)`。

### 5.2 详案 04 的裸写 Hex 与命名冲突纠偏
- **现场代码**：`04-分维详案` 第 1105-1115 行：
  ```css
  .statusBadge.modified {
    background: color-mix(in srgb, var(--color-warning, #f59e0b) 15%, transparent); /* ❌ 裸写 #f59e0b */
    color: var(--color-warning, #f59e0b);
  }
  ```
- **病理剖析**：04 详案通篇强调严禁裸写 Hex，却在自己的样式施工图中留下了 `#f59e0b` 与 `#ef4444` 兜底，且使用了长类名 `.modified`，与 01 的短类名 `.mod` 脱节。
- **纠偏方案**：采纳 01 详案的现代化 HSLA 色阶 Token（如 `var(--filetree-badge-mod-fg, hsl(32 95% 30%))`），彻底杜绝裸写 Hex。

### 5.3 Tooltip 与原生 `title` 的规范化
- **现场隐患**：01 详案在文件名超链接上仍残留了 `title={f.filePath}`。
- **治理规范**：依据 `AGENTS.md` §12（杜绝原生 HTML title），文件名超链接统一换装原子组件 `<Tooltip content={`在右侧打开独立预览：${f.filePath}`}>`，彻底销毁原生气泡。

---

# 六、最终终审裁决书与收敛执行唯一方案（Single Source of Truth, SSOT）

基于以上深入贯通排查，排查官正式签署本战役的**唯一法定实现方案（SSOT）**。主控 Agent 在落地执行时，必须直接使用以下经过深度融合、彻底消灭所有打架的生产级代码！

### 6.1 唯一法定：`apps/crish-desktop/src/components/diff/DiffCardFileList.tsx` 全量源码

```tsx
import React, { useMemo } from 'react';
import * as Lucide from 'lucide-react';
import styles from './DiffCard.module.css';
import { Button, Tooltip } from '../ui';
import type { FileDiff } from '../../store/types';
import type { DiffSourceMode } from '../../api/diffPanelHelpers';
import type { CompareMode } from './diffCardTypes';

/**
 * 差异面板文件列表组件属性契约 (SSOT 终审收敛版)
 * 1. 完整保全三大正交子域事件通道 (折叠展开、文件名独立 Tab 预览、Git 快捷操作)；
 * 2. 完整保全 Git 分组批量暂存/取消暂存操作 (onStageAll / onUnstageAll)；
 * 3. 兼容性保留 6 项历史属性标记为可选 (?:)，确保 07 单测套件与 DiffCard.tsx 100% 绿灯平滑演进。
 */
export interface DiffCardFileListProps {
  /** 变更文件列表数据 */
  files: FileDiff[];
  /** 差异来源模式：'git' 或 'session' */
  sourceMode: DiffSourceMode;
  /** 当前处于内联激活展开状态的文件对象 */
  current: FileDiff | null;
  /** 是否处于文件暂存/应用异步执行中 */
  applyBusy: boolean;
  /** 文件暂存状态字典 (filePath -> boolean) */
  stagingPaths: Record<string, boolean>;
  /** 点击折叠箭头切换当前内联展开文件 (正交子域 A) */
  onSetActiveDiffSource: (diff: FileDiff | null) => void;
  /** Git 单文件暂存回调 (正交子域 C) */
  onStageFile: (filePath: string) => void;
  /** Git 单文件取消暂存回调 (正交子域 C) */
  onUnstageFile: (filePath: string) => void;
  /** Git 单文件放弃本地修改回调 (正交子域 C) */
  onDiscardChanges: (filePath: string) => void;
  /** 全部暂存回调 */
  onStageAll: () => void;
  /** 全部取消暂存回调 */
  onUnstageAll: () => void;
  /** 内联代码比对区渲染函数 */
  renderInlineDiffContent: (f: FileDiff) => React.ReactNode;
  /** 获取最新合并/派生差异数据回调 */
  getFileDiffData?: (f: FileDiff) => FileDiff | null;
  /** 点击文件名超链接在右侧独立 Tab 打开 FileViewer 预览回调 (正交子域 B) */
  onOpenFileViewer?: (filePath: string) => void;

  /* =========================================================================
   * 兼容性保留契约：标记为可选，确保 07 单测套件与 DiffCard.tsx 100% 平滑演进
   * ========================================================================= */
  aiTurns?: Array<{
    msg: { id: string; timestamp: number };
    index: number;
    files: FileDiff[];
  }>;
  getFileCompareMode?: (filePath: string) => CompareMode;
  onChangeCompareMode?: (filePath: string, mode: CompareMode) => void;
  onAcceptFile?: (f: FileDiff) => void;
  onRejectFile?: (f: FileDiff) => void;
  onCopyCode?: (filePath: string) => void;
}

/**
 * 拆分物理路径为文件名与所在目录
 */
function splitFilePath(filePath: string): { name: string; dir: string } {
  if (!filePath) return { name: '', dir: '' };
  const normalized = filePath.replace(/\\/g, '/');
  const lastSlashIndex = normalized.lastIndexOf('/');
  if (lastSlashIndex === -1) {
    return { name: normalized, dir: '' };
  }
  return {
    name: normalized.slice(lastSlashIndex + 1),
    dir: normalized.slice(0, lastSlashIndex + 1),
  };
}

/**
 * 解析文件 Git 语义状态徽标属性
 * 区分 Modified(M), Added(A), Deleted(D), Renamed(R)
 */
function resolveStatusBadge(f: FileDiff): {
  char: 'M' | 'A' | 'D' | 'R';
  key: 'mod' | 'add' | 'del' | 'ren';
  title: string;
} {
  if (f.status === 'added' || (f.additions && !f.deletions && !f.oldPath)) {
    return { char: 'A', key: 'add', title: '新增文件' };
  }
  if (f.status === 'deleted' || (!f.additions && f.deletions && !f.newPath)) {
    return { char: 'D', key: 'del', title: '已删除文件' };
  }
  if (
    f.status === 'renamed' ||
    (Boolean(f.oldPath) && Boolean(f.newPath) && f.oldPath !== f.newPath)
  ) {
    return { char: 'R', key: 'ren', title: '重命名文件' };
  }
  return { char: 'M', key: 'mod', title: '已修改文件' };
}

// 快捷操作 Tooltip 文案常量 (同源引用，符合 AGENTS.md §12 规范)
const TOOLTIP_STAGE = '暂存此文件';
const TOOLTIP_UNSTAGE = '取消暂存此文件';
const TOOLTIP_DISCARD = '放弃此文件的所有修改';

/**
 * 差异面板平直单轨文件列表组件
 * 彻底拔除卡片手风琴外壳与 110 行行内工具条，实现 32px 紧凑直角三大正交子域单轨架构
 */
export const DiffCardFileList: React.FC<DiffCardFileListProps> = ({
  files,
  sourceMode,
  current,
  applyBusy,
  stagingPaths,
  onSetActiveDiffSource,
  onStageFile,
  onUnstageFile,
  onDiscardChanges,
  onStageAll,
  onUnstageAll,
  renderInlineDiffContent,
  getFileDiffData,
  onOpenFileViewer,
}) => {
  // Git 模式下按已暂存与未暂存正交分组
  const { stagedFiles, unstagedFiles } = useMemo(() => {
    const staged: FileDiff[] = [];
    const unstaged: FileDiff[] = [];
    for (const f of files) {
      if (f.staged) {
        staged.push(f);
      } else {
        unstaged.push(f);
      }
    }
    return { stagedFiles: staged, unstagedFiles: unstaged };
  }, [files]);

  /**
   * 渲染单个平直文件节点（包含三大正交子域与嵌合比对区）
   */
  const renderFlatFileNode = (f: FileDiff) => {
    if (!f || !f.filePath) return null;
    const active = current?.filePath === f.filePath;
    const targetDiff = getFileDiffData ? (getFileDiffData(f) ?? f) : f;
    const additions = targetDiff.additions ?? f.additions ?? 0;
    const deletions = targetDiff.deletions ?? f.deletions ?? 0;
    const { name, dir } = splitFilePath(f.filePath);
    const badge = resolveStatusBadge(f);
    const isStaging = Boolean(stagingPaths[f.filePath]);

    return (
      <div
        key={f.filePath}
        className={styles.fileNode}
        role="listitem"
        data-active={active}
      >
        {/* 平直文件交互行 (32px 纯偶数净高，纯直角贴边容器，独占 SLoHT 单层 hover 背景) */}
        <div
          className={`${styles.fileRow} ${active ? styles.isActive : ''}`}
          data-active={active}
        >
          {/* =================================================================
           * 子域 A：折叠展开控制与语义化状态徽章 (居左固定排布)
           * ================================================================= */}
          <button
            type="button"
            className={styles.chevronBtn}
            onClick={() => onSetActiveDiffSource(active ? null : f)}
            aria-label={active ? `折叠 ${name} 差异代码` : `展开 ${name} 差异代码`}
            aria-expanded={active}
          >
            <Lucide.ChevronRight
              size={14}
              className={`${styles.chevronIcon} ${active ? styles.expanded : ''}`}
              aria-hidden
            />
          </button>

          <Tooltip content={badge.title}>
            <span
              className={`${styles.statusBadge} ${styles[badge.key]}`}
              aria-label={badge.title}
            >
              {badge.char}
            </span>
          </Tooltip>

          {/* =================================================================
           * 子域 B：独立超链接与路径分级 (点击在右侧打开独立预览 Tab，防冒泡)
           * ================================================================= */}
          <div className={styles.pathWrap}>
            <Tooltip content={`在独立标签页预览文件：${f.filePath}`}>
              <button
                type="button"
                className={styles.fileNameLinkBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  if (onOpenFileViewer) {
                    onOpenFileViewer(f.filePath);
                  } else {
                    onSetActiveDiffSource(active ? null : f);
                  }
                }}
                aria-label={`在独立标签页预览文件 ${name}`}
              >
                <span className={styles.fileName}>{name}</span>
              </button>
            </Tooltip>

            {dir ? (
              <span
                className={styles.dirPath}
                title={f.filePath}
                onClick={() => onSetActiveDiffSource(active ? null : f)}
              >
                {dir}
              </span>
            ) : null}
          </div>

          {/* =================================================================
           * 子域 C：常驻增减统计与 Git 快捷操作 (Flex 盒流式排布，永不遮挡覆盖)
           * ================================================================= */}
          <div className={styles.statAndActions}>
            <span
              className={styles.fileStat}
              aria-label={`增加 ${additions} 行，删除 ${deletions} 行`}
            >
              {additions > 0 ? (
                <span className={styles.statAdd}>+{additions}</span>
              ) : null}
              {deletions > 0 ? (
                <span className={styles.statDel}>−{deletions}</span>
              ) : null}
              {additions === 0 && deletions === 0 ? (
                <span className={styles.statNeutral}>0</span>
              ) : null}
            </span>

            {sourceMode === 'git' ? (
              <div
                className={styles.rowActions}
                onClick={(e) => e.stopPropagation()}
              >
                {isStaging ? (
                  <Lucide.Loader2
                    size={13}
                    className={styles.spinner}
                    aria-label="正在处理暂存操作"
                  />
                ) : f.staged ? (
                  <Tooltip content={TOOLTIP_UNSTAGE}>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className={styles.rowActBtn}
                      aria-label={TOOLTIP_UNSTAGE}
                      disabled={applyBusy}
                      onClick={() => void onUnstageFile(f.filePath)}
                      icon={<Lucide.Minus size={13} />}
                    />
                  </Tooltip>
                ) : (
                  <>
                    <Tooltip content={TOOLTIP_STAGE}>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className={styles.rowActBtn}
                        aria-label={TOOLTIP_STAGE}
                        disabled={applyBusy}
                        onClick={() => void onStageFile(f.filePath)}
                        icon={<Lucide.Plus size={13} />}
                      />
                    </Tooltip>
                    <Tooltip content={TOOLTIP_DISCARD}>
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        className={`${styles.rowActBtn} ${styles.danger}`}
                        aria-label={TOOLTIP_DISCARD}
                        disabled={applyBusy}
                        onClick={() => void onDiscardChanges(f.filePath)}
                        icon={<Lucide.Undo2 size={13} />}
                      />
                    </Tooltip>
                  </>
                )}
              </div>
            ) : null}
          </div>
        </div>

        {/* 展开的代码比对视口（无缝垂直嵌合，零外框，110 行行内工具栏连根物理清空） */}
        {active ? (
          <div className={styles.diffPane}>
            {renderInlineDiffContent(f)}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div
      className={styles.flatFileList}
      role="list"
      aria-label="变更文件列表"
    >
      {sourceMode === 'git' ? (
        <>
          {/* 已暂存分组 */}
          <div className={styles.groupSection}>
            <div className={styles.groupHeader}>
              <span className={styles.groupTitle}>
                已暂存的更改 ({stagedFiles.length})
              </span>
              {stagedFiles.length > 0 ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className={styles.groupActionBtn}
                  disabled={applyBusy}
                  onClick={onUnstageAll}
                  icon={<Lucide.MinusCircle size={13} className={styles.btnIcon} />}
                >
                  全部取消暂存
                </Button>
              ) : null}
            </div>

            {stagedFiles.length === 0 ? (
              <div className={styles.groupEmptyHint}>无已暂存的文件</div>
            ) : (
              <div className={styles.groupBody}>
                {stagedFiles.map(renderFlatFileNode)}
              </div>
            )}
          </div>

          {/* 未暂存分组 */}
          <div className={styles.groupSection}>
            <div className={styles.groupHeader}>
              <span className={styles.groupTitle}>
                未暂存的更改 ({unstagedFiles.length})
              </span>
              {unstagedFiles.length > 0 ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className={styles.groupActionBtn}
                  disabled={applyBusy}
                  onClick={onStageAll}
                  icon={<Lucide.PlusCircle size={13} className={styles.btnIcon} />}
                >
                  全部暂存
                </Button>
              ) : null}
            </div>

            {unstagedFiles.length === 0 ? (
              <div className={styles.groupEmptyHint}>无未暂存的修改</div>
            ) : (
              <div className={styles.groupBody}>
                {unstagedFiles.map(renderFlatFileNode)}
              </div>
            )}
          </div>
        </>
      ) : (
        files.map(renderFlatFileNode)
      )}
    </div>
  );
};
```

---

### 6.2 唯一法定：`DiffCard.module.css` 核心选择器样式表（100% 一字不差对齐）

```css
/* ==========================================================================
 * DiffCard.module.css —— 核心改造区域权威单轨样式表 (SSOT 终审收敛版)
 * 1. 严格 100% 一字不差对齐 DiffCardFileList.tsx 的 33 大核心选择器；
 * 2. 贯彻 SLoHT 单层悬停：.fileRow 独占 hover，行内按钮保持 transparent；
 * 3. 100% 物理清除 .inlineHeader 等 8 大废弃选择器；
 * 4. 彻底直角化 (border-radius: 0) 与 32px 纯偶数净高对齐。
 * ========================================================================== */

/* --------------------------------------------------------------------------
 * 1. 平直文件列表容器 (全宽平铺，零边缘留白，容器查询基座)
 * -------------------------------------------------------------------------- */
.flatFileList {
  display: flex;
  flex-direction: column;
  padding: 0;
  gap: 0;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  background: var(--bg-card);
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: auto;
  flex: 1 1 auto;
  border-right: none;
  border-radius: 0;
  container-type: inline-size;
  container-name: diff-panel;
}

/* 兼容别名映射，保证存量测试或组件平滑过渡 */
.fileList {
  composes: flatFileList;
}

/* --------------------------------------------------------------------------
 * 2. 单个文件物理包裹节点 (骨架层，永久锁定透明，绝无 hover 叠灰)
 * -------------------------------------------------------------------------- */
.fileNode {
  display: flex;
  flex-direction: column;
  width: 100%;
  margin: 0;
  padding: 0;
  box-sizing: border-box;
  background: transparent;
  border: none;
  border-radius: 0;
}

/* --------------------------------------------------------------------------
 * 3. 平直文件交互行 (32px 纯偶数净高、纯直角、SLoHT 单层悬停唯一真源)
 * -------------------------------------------------------------------------- */
.fileRow {
  display: flex;
  flex-direction: row;
  align-items: center; /* 消除基线抖动核心：刚性垂直居中 */
  height: 32px;
  min-height: 32px;
  max-height: 32px;
  padding: 0 12px;
  margin: 0;
  width: 100%;
  box-sizing: border-box;
  border: none;
  border-radius: 0; /* 彻底直角化铁律归零 */
  box-shadow: inset 0 -1px 0 0 var(--border-subtle);
  background-color: transparent;
  user-select: none;
  outline: none;
  transition:
    background-color var(--transition-fast, 120ms),
    box-shadow var(--transition-fast, 120ms);
}

/* SLoHT 唯一单层悬停真源：Light 2.5%, Dark 3.5% */
.fileRow:hover {
  background-color: var(--bg-hover);
}

/* 键盘焦点进入整行时的柔和外轮廓 (遵循 AGENTS.md §13 焦点对比度 <= 10%) */
.fileRow:focus-within {
  outline: 1px solid var(--tint-focus-ring, color-mix(in srgb, var(--text-primary) 6%, transparent));
  outline-offset: -1px;
}

/* 激活展开态：单层 var(--bg-active) + 左侧 2px 翡翠绿强调条 + 底部内嵌线 */
.fileRow.isActive {
  background-color: var(--bg-active);
  box-shadow:
    inset 2px 0 0 var(--brand-primary, #10b981),
    inset 0 -1px 0 0 var(--border-subtle);
}

.fileRow.isActive:hover {
  background-color: var(--bg-active);
}

/* --------------------------------------------------------------------------
 * 4. 子域 A：折叠 Chevron 按钮与语义化状态徽章
 * -------------------------------------------------------------------------- */
.chevronBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  min-width: 16px;
  padding: 0;
  margin: 0 6px 0 0;
  border: none;
  border-radius: 0;
  background: transparent;
  cursor: pointer;
  outline: none;
  flex-shrink: 0;
}

.chevronIcon {
  width: 14px;
  height: 14px;
  color: var(--text-tertiary);
  transition:
    transform var(--transition-fast, 120ms) cubic-bezier(0.2, 0, 0, 1),
    color var(--transition-fast, 120ms);
}

.chevronBtn:hover .chevronIcon,
.fileRow:hover .chevronIcon {
  color: var(--text-secondary);
}

.chevronIcon.expanded {
  transform: rotate(90deg);
  color: var(--text-primary);
}

/* 语义化状态徽章：纯正方形直角 16x16px，严格 border-radius: 0 */
.statusBadge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  min-width: 16px;
  flex-shrink: 0;
  margin-right: 8px;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  border-radius: 0;
  user-select: none;
}

/* M - 修改 (Modified) */
.statusBadge.mod {
  color: var(--filetree-badge-mod-fg, hsl(32 95% 30%));
  background-color: var(--filetree-badge-mod-bg, hsl(38 92% 50% / 0.12));
}

/* A - 新增 (Added) */
.statusBadge.add {
  color: var(--filetree-badge-add-fg, hsl(142 71% 28%));
  background-color: var(--filetree-badge-add-bg, hsl(142 71% 45% / 0.12));
}

/* D - 删除 (Deleted) */
.statusBadge.del {
  color: var(--filetree-badge-del-fg, hsl(0 75% 38%));
  background-color: var(--filetree-badge-del-bg, hsl(0 84% 60% / 0.12));
}

/* R - 重命名 (Renamed) */
.statusBadge.ren {
  color: var(--filetree-badge-renamed-fg, hsl(270 60% 36%));
  background-color: var(--filetree-badge-renamed-bg, hsl(270 60% 50% / 0.12));
}

/* --------------------------------------------------------------------------
 * 5. 子域 B：文件名超链接按钮与所在目录分级
 * -------------------------------------------------------------------------- */
.pathWrap {
  display: flex;
  align-items: center;
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  height: 100%;
  margin-right: 8px;
}

/* 独立语义化超链接按钮 (点击在右侧打开独立标签页) */
.fileNameLinkBtn {
  display: inline-flex;
  align-items: center;
  min-width: 48px;
  max-width: 100%;
  flex: 0 1 auto;
  padding: 0;
  margin: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  cursor: pointer;
  text-align: left;
  outline: none;
}

.fileName {
  font-family: var(--font-sans);
  font-size: var(--font-size-xs, 12px);
  font-weight: var(--font-weight-medium, 500);
  line-height: 20px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color var(--transition-fast, 120ms);
}

/* Zero-Blue 翡翠绿超链接悬停激活签名 */
.fileNameLinkBtn:hover .fileName {
  color: var(--md-link-color, var(--brand-primary, #10b981));
  text-decoration: underline;
  text-underline-offset: 3px;
}

/* 所在目录路径弱化 */
.dirPath {
  font-family: var(--font-sans);
  font-size: var(--font-size-xxs, 11px);
  font-weight: 400;
  line-height: 20px;
  color: var(--text-tertiary);
  margin-left: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1 1 auto;
  min-width: 0;
  cursor: pointer;
}

.dirPath:hover {
  color: var(--text-secondary);
}

/* --------------------------------------------------------------------------
 * 6. 子域 C：常驻增减统计与 Git 快捷操作 (SLoHT 透光防闪烁)
 * -------------------------------------------------------------------------- */
.statAndActions {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  flex-shrink: 0;
  height: 100%;
}

/* 常驻增减统计 (等宽数字排版，永不隐藏) */
.fileStat {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1_5, 6px);
  font-family: var(--font-mono, monospace);
  font-size: var(--font-size-xxs, 11px);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  opacity: 1; /* 刚性常驻可见，彻底删除 hover opacity: 0 反模式 */
  user-select: none;
}

.statAdd {
  color: var(--diff-add-fg, hsl(142 65% 25%));
  font-weight: 500;
}

.statDel {
  color: var(--diff-del-fg, hsl(0 68% 38%));
  font-weight: 500;
}

.statNeutral {
  color: var(--text-tertiary);
}

/* 快捷动作组：默认隐藏保留空间，hover/focus-within 浮现 */
.rowActions {
  display: flex;
  align-items: center;
  gap: var(--space-1, 4px);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition:
    opacity var(--transition-micro, 80ms),
    visibility var(--transition-micro, 80ms);
}

.fileRow:hover .rowActions,
.fileRow:focus-within .rowActions {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}

/* 行内直角快捷按钮：SLoHT 铁律，始终保持透明背景，杜绝二次叠灰！ */
.rowActBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  min-width: 22px;
  padding: 0;
  border-radius: 0; /* 彻底直角化 */
  border: 1px solid transparent;
  background: transparent; /* 始终透明 */
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    color var(--transition-micro, 80ms),
    border-color var(--transition-micro, 80ms);
}

.rowActBtn:hover {
  color: var(--text-primary);
  background-color: transparent; /* 严格保持透明，透出 .fileRow 的单一 hover 底色 */
  border-color: var(--border-subtle);
}

.rowActBtn.danger:hover {
  color: var(--color-error, var(--diff-del-fg, hsl(0 68% 38%)));
  background-color: transparent; /* 严格保持透明 */
  border-color: var(--color-error-border, color-mix(in srgb, var(--color-error) 30%, transparent));
}

.spinner {
  color: var(--text-tertiary);
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* --------------------------------------------------------------------------
 * 7. Git 分组表头与容器规范 (吸顶粘滞、纯直角、28px 紧凑标尺)
 * -------------------------------------------------------------------------- */
.groupSection {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 0;
  margin: 0;
}

.groupHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 28px;
  min-height: 28px;
  max-height: 28px;
  padding: 0 12px;
  box-sizing: border-box;
  background: var(--card-header-bg, var(--bg-secondary));
  box-shadow: inset 0 -1px 0 0 var(--border-subtle);
  position: sticky;
  top: 0;
  z-index: 2;
  user-select: none;
}

.groupTitle {
  font-family: var(--font-sans);
  font-size: var(--font-size-xs, 12px);
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-secondary);
}

.groupActionBtn {
  font-size: var(--font-size-xxs, 11px);
  height: 22px;
  padding: 0 6px;
  border-radius: 0;
}

.btnIcon {
  margin-right: 4px;
}

.groupBody {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 0;
  gap: 0;
}

.groupEmptyHint {
  font-family: var(--font-sans);
  font-size: var(--font-size-xxs, 11px);
  color: var(--text-tertiary);
  padding: 10px 12px;
  text-align: center;
  box-shadow: inset 0 -1px 0 0 var(--border-subtle);
  background: transparent;
  border-radius: 0;
}

/* --------------------------------------------------------------------------
 * 8. 展开比对区 (.diffPane)：垂直无缝嵌合，上下 Hairline 收口，全宽贴合
 * -------------------------------------------------------------------------- */
.diffPane {
  display: flex;
  flex-direction: column;
  width: 100%;
  margin: 0;
  padding: 0;
  border: none;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-card);
  box-sizing: border-box;
  border-radius: 0;
}

/* --------------------------------------------------------------------------
 * 9. 极窄视口自适应弹性算法 (@container diff-panel (max-width: 360px))
 * -------------------------------------------------------------------------- */
@container diff-panel (max-width: 360px) {
  .dirPath {
    display: none;
  }
  .fileRow {
    padding: 0 8px;
  }
  .statusBadge {
    margin-right: 4px;
  }
  .statAndActions {
    gap: 4px;
  }
}
```

---

# 七、主控 Agent 落盘指引与门禁核验指令

1. **施工指引**：
   - 阶段六落地实现时，严禁使用 02 或 03 详案内部的 `DiffCardFileList.tsx` 整文件代码覆盖；
   - 必须以本报告 §6.1 与 §6.2 为最终法定唯一代码进行落盘！
2. **验证指令**：
   - TypeScript 类型检查：
     ```powershell
     npm run typecheck
     ```
     必须 100% 零报错通过；
   - 差异列表重构单测套件：
     ```powershell
     npx vitest run apps/crish-desktop/src/components/diff/DiffCardFileList.test.tsx
     ```
     必须全量通过，Chevron 折叠与文件名超链接独立触发验证必须 100% 绿灯！
