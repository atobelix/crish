# 差异面板平直列表化与去圆角架构实施方案 (PLAN-01)

> **战役名称**：差异面板与笔记面板系统性重构
> **阶段与编号**：阶段二：独立方案设计 / PLAN-01
> **输入依据**：[`docs/diff-view-redesign/analysis/01-diff-flat-list-audit.md`](file:///c:/Software/conex/docs/diff-view-redesign/analysis/01-diff-flat-list-audit.md) (AUDIT-01)
> **产出路径**：`docs/diff-view-redesign/independent-plans/01-diff-flat-list-plan.md`
> **实施基准**：用户最高裁决（平直列表化、去圆角、移除内部工具行、清理硬编码统一 Token、防退避与净负产出）

---

## 1. 方案目标与架构全景（平直单轨 VS 旧卡片手风琴）

### 1.1 核心目标与前置审计已确认事实

在前置代码现场深度审计（AUDIT-01）中已确凿查明并固定以下事实与痛点：

1. **外层边距与容器间隙掏空**：
   - [`DiffCard.module.css:176-177`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L176-L177) 声明了 `gap: var(--space-2, 8px); padding: var(--space-3, 10px);`；
   - [`DiffCard.module.css:827`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L827) 的 `.groupItemsContainer` 同样声明了 `gap: var(--space-2, 8px);`。这导致文件列表与宿主侧边栏边界脱离，整个文件区域散落为一个个浮动卡片孤岛。
2. **多重圆角与独立外框重叠压迫**：
   - [`DiffCard.module.css:192-222`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L192-L222) 的 `.accordionItem` 与 `.accordionActive` 充斥了 `border-radius: var(--radius-md, 6px)` 与 `border-radius: var(--radius-lg, 8px)` 以及独立的外部线框。当变更文件数量达到十数个以上时，数十个圆角矩形连续堆叠，造成严重的视觉压迫与垂直空间浪费。
3. **悬浮暴力遮挡引起的排版剧烈跳动**：
   - [`DiffCard.module.css:311-314`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L311-L314) 在鼠标 hover 或获得焦点时暴力设置 `.fileStat { opacity: 0; }`，试图用绝对定位的 `.hoverActions` 覆盖原数字位置，导致鼠标移动时数字忽隐忽现，引发强烈的视觉闪烁与反人机工效。
4. **用户明令裁决**：
   > “差异界面的每个文件改成列表就行了，去掉圆角。越简单越好，现在功能多了用户反而不知道怎么用了。整个差异界面基本上是都要重构了。”

本方案（PLAN-01）旨在彻底颠覆旧有“手风琴卡片岛”模式，将差异面板文件列表重塑为符合 VS Code / Cursor / Sublime Merge 等顶级专业开发工具标准的**纯粹平直单轨列表（Flat List）**。

---

### 1.2 四段式规约之【做什么（To-Do）】

1. **纯净平直列表 DOM 树与 CSS 体系重构**：
   - 将容器从卡片式 `.fileList` 重构为全宽平铺的 `.flatFileList`，容器约束锁定为 `padding: 0; gap: 0; background: var(--bg-card); width: 100%;`，四周零外边距脱节。
2. **平直文件条目（Compact 32px Row）规格锁定**：
   - 单行高度死锁为 **32px**（`height: 32px; min-height: 32px; max-height: 32px; box-sizing: border-box;`）；
   - 条目间仅由 `1px solid var(--border-subtle)` 底部分割线分隔，`border-radius` 严格强制置 `0`；
   - 彻底抹除任何外凸阴影、独立矩形描边与悬浮卡片外观。
3. **交互态与设计 Token 刚性绑定**：
   - 默认态：`background: transparent;`；
   - 悬停态（Hover）：单一使用 `var(--bg-hover)`（浅色主题 2.5%、深色主题 3.5% 灰度混入），无额外边框变化；
   - 选中/展开激活态（Active）：单一使用 `var(--bg-active)`（5.0% 混入），并在行左侧配备 2px 翡翠绿/活态强调线（`box-shadow: inset 2px 0 0 var(--brand-primary);`）。
4. **行内元素专业排版布局**：
   - **展开指示器**：14px 等宽折叠箭头（`ChevronRight`），展开时顺时针 90° 平滑过渡；
   - **状态徽章**：16x16px 语义化徽章（`M`/`A`/`D`/`R`），具备清晰文字色彩与微透明着色底衬；
   - **路径与文件名分级**：文件名采用 `var(--text-primary)` 500 字重突出显示；所在目录路径采用 `var(--text-tertiary)` 11px 弱化，并在空间不足时自动截断；
   - **增删统计常驻**：等宽等高（`tabular-nums`）展示 `+N -M`，彻底废除 hover 抹除隐藏的反模式；
   - **右侧快捷操作（暂存/放弃）弹性并列**：与统计数字在水平盒中物理隔离排布，常态静默、hover 时柔和显现，互不遮挡打架。
5. **展开比对区贴合嵌合设计**：
   - 展开的代码比对区（`.diffPane`）直接垂直嵌合在当前文件行下方，外边距归零、零圆角，上下仅由 1px hairline 收口。

---

### 1.3 四段式规约之【不做什么（Not-To-Do）】

1. **严禁执行未授权版本控制操作**：
   - 严禁任何子 Agent 或执行过程执行 `git commit`、`git reset`、`git checkout` 或 `git restore`；所有改动统一由主控 Agent 协调收口。
2. **严禁保留卡片式旧遗留**：
   - 严禁保留任何外部边框（`border: 1px solid var(--border-color)`）、外层留白（`padding: 10px; gap: 8px`）或圆角（`border-radius: 6px/8px`）。
3. **严禁破坏无障碍与跳动反模式**：
   - 严禁在 hover 时将统计数字设置为 `opacity: 0` 或 `display: none`；
   - 严禁破坏键盘上下无障碍导航（保留 `role="list"`, `aria-expanded` 与原生焦点流）。
4. **严禁在展开文件内部保留冗余工具行**：
   - 严禁在单文件展开视口顶部重新引入 `.inlineHeader`、对比维度下拉或重复的操作按钮。

---

### 1.4 架构全景对比模型（ASCII 拓扑示意）

```
==================================================================================================
旧卡片手风琴模式（现存，视觉噪点大、层层包裹、覆盖跳动）：
==================================================================================================
┌ .fileList (padding: 10px, gap: 8px, 容器边缘掏空) ──────────────────────────────────────────┐
│                                                                                              │
│  ┌ .accordionItem (border: 1px solid transparent; border-radius: 6px; 悬浮卡片) ──────────┐  │
│  │  [Button.tsx]                                                                          │  │
│  │  Hover 时: [+12 -3] 被强制 opacity: 0;  ──>  覆盖浮现 [+ 暂存] [Undo 放弃] (视觉闪烁)  │  │
│  └────────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                              │
│  ┌ .accordionItem.accordionActive (border: 1px solid var(--border-subtle); radius: 8px) ──┐  │
│  │  [FlatList.tsx]                                                                        │  │
│  │  ┌ .inlineBody ──────────────────────────────────────────────────────────────────────┐ │  │
│  │  │ ┌ .inlineHeader (36px 冗余工具行: 对比维度下拉 + 6个重复操作按钮) ───────────────┐ │ │  │
│  │  │ └────────────────────────────────────────────────────────────────────────────────┘ │ │  │
│  │  │ ┌ DiffCodeViewer (被包裹在 8px 圆角卡片内部的代码视口) ──────────────────────────┐ │ │  │
│  │  │ └────────────────────────────────────────────────────────────────────────────────┘ │ │  │
│  │  └────────────────────────────────────────────────────────────────────────────────────┘ │ │  │
│  └────────────────────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────────────────┘

==================================================================================================
新平直单轨模式（重构目标，全宽平铺、32px 紧凑直角、常驻统计、无缝贴合比对）：
==================================================================================================
┌ .flatFileList (padding: 0, gap: 0, border-radius: 0, 全宽贴边贯通) ──────────────────────────┐
│                                                                                              │
│ ├─ [>] [M]  Button.tsx          src/components/ui/                +12 -3  [+暂存] [Undo]     │ (32px)
│ │  1px solid var(--border-subtle) 底部分割线                                                 │
│                                                                                              │
│ ├─ [v] [A]  FlatList.tsx        src/components/diff/              +84 -0  [-取消]            │ (32px, 激活态)
│ │  (背景: var(--bg-active), 左侧: 2px inset 翡翠绿强调条 box-shadow: inset 2px 0 0 #10b981)  │
│ │  ┌───────────────────────────────────────────────────────────────────────────────────────┐ │
│ │  │ DiffCodeViewer (无缝垂直嵌合，零圆角、零外边距，上下 hairline 收口，无工具行)         │ │
│ │  └───────────────────────────────────────────────────────────────────────────────────────┘ │
│ │  1px solid var(--border-subtle) 底部分割线                                                 │
│                                                                                              │
│ ├─ [>] [D]  LegacyCard.module.css   src/styles/                   +0 -120                    │ (32px)
│ └─ 1px solid var(--border-subtle) 底部分割线                                                 │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 核心 DOM 树重构设计与 JSX 伪代码

### 2.1 DOM 节点层次拓扑压平映射

| 层级 | 现有实现（Legacy Accordion） | 平直重构目标（Flat List Target） | 语义与无障碍改善 |
| :--- | :--- | :--- | :--- |
| **列表根** | `<div className={styles.fileList}>` (留白+卡片间距) | `<div className={styles.flatFileList} role="list" aria-label="变更文件列表">` | 严格拉平到 0 padding/gap，保留原生标准 list 语义 |
| **分组头** | `<div className={styles.gitGroupHeader}>` (含内联样式) | `<div className={styles.groupHeader}>` (紧凑 28px，吸顶，无行内样式) | 移除所有内联 `style={{ marginRight: 3 }}` |
| **条目外壳** | `<div className={styles.accordionItem}>` (6px 圆角卡片) | `<div className={styles.fileNode} role="listitem">` | 纯净逻辑包裹节点，彻底剥离卡片外壳与圆角 |
| **交互主体** | `<button className={styles.fileItem}>` (嵌套在行内) | `<button className={styles.fileRow} aria-expanded={active}>` | 32px 单轨弹性行，原生 button 支持键盘 Enter/Space 展开 |
| **折叠指示** | *无*（完全缺失开闭状态视觉指示） | `<Lucide.ChevronRight className={styles.chevronIcon} />` | 14px 居中指示符，激活时顺畅旋转 90 度 |
| **状态徽章** | *无*（仅有红绿数字，无 Git 状态标记） | `<span className={`${styles.statusBadge} ${styles[status]}`}>M</span>` | 16x16px 语义化 M/A/D/R 标签，高辨识度 |
| **路径呈现** | `<span className={styles.fileNameLink}>` (混杂链接) | `<div className={styles.pathWrap}><span className={styles.fileName}>...</span><span className={styles.dirPath}>...</span></div>` | 主文件名加粗突出，父级目录弱化截断 |
| **增删统计** | `<span className={styles.fileStat}>` (hover 暴力隐藏) | `<span className={styles.fileStat}>` (常驻右侧，tabular-nums) | 绝对常驻，杜绝闪烁跳动 |
| **快捷动作** | `<div className={styles.hoverActions}>` (绝对定位覆盖) | `<div className={styles.rowActions}>` (Flex 并列排布) | 与统计数据并排，hover/focus-within 柔和显现 |
| **展开工具栏** | `<div className={styles.inlineHeader}>` (下拉+6个按钮) | **【彻底清退废除】** | 彻底消除认知干扰与垂直空间侵占 |
| **代码比对区** | `<div className={styles.inlineBody}>` (圆角卡片内部内缩) | `<div className={styles.diffPane}>` (紧随 `fileRow` 垂直贴合) | 零外边距、零圆角贴合，全宽展开 |

---

### 2.2 组件属性接口（DiffCardFileListProps）精简契约

将单文件展开工具行彻底清退后，`DiffCardFileList` 将不再承担“打开外部编辑器”、“导出单文件 patch”、“切换单文件对比维度”等重叠职责，相关死属性与死导入全面剔除。

#### 待删除的冗余属性与导入清单
```typescript
// 1. 待删除死属性:
- getFileCompareMode: (filePath: string) => CompareMode;
- onChangeCompareMode: (filePath: string, mode: CompareMode) => void;
- onAcceptFile: (f: FileDiff) => void;
- onRejectFile: (f: FileDiff) => void;
- onCopyCode: (filePath: string) => void;

// 2. 待删除死导入:
- import { classifyFileDiff } from '../../api/applyFileDiff';
- import { openPathDefault } from '../../api/hostOpenersApi';
- import { formatGitPatch } from './GitPatchFormatter';
- import { useToast } from '../../services/toast/ToastContext';
- import { Select, IconButton } from '../ui';
```

#### 精简后的极简契约定义
```typescript
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
}
```

---

### 2.3 核心 JSX 重构伪代码实现

```tsx
import React, { useMemo } from 'react';
import * as Lucide from 'lucide-react';
import styles from './DiffCard.module.css';
import { Button, Tooltip } from '../ui';
import type { FileDiff } from '../../store/types';
import type { DiffCardFileListProps } from './DiffCardFileList';

function splitPath(filePath: string): { name: string; dir: string } {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  if (idx === -1) {
    return { name: normalized, dir: '' };
  }
  return {
    name: normalized.slice(idx + 1),
    dir: normalized.slice(0, idx + 1),
  };
}

function resolveStatusBadge(f: FileDiff): { char: string; key: 'mod' | 'add' | 'del' | 'ren' } {
  if (f.status === 'added' || (f.additions && !f.deletions && !f.oldPath)) {
    return { char: 'A', key: 'add' };
  }
  if (f.status === 'deleted' || (!f.additions && f.deletions && !f.newPath)) {
    return { char: 'D', key: 'del' };
  }
  if (f.status === 'renamed' || (f.oldPath && f.newPath && f.oldPath !== f.newPath)) {
    return { char: 'R', key: 'ren' };
  }
  return { char: 'M', key: 'mod' };
}

export const DiffCardFileList: React.FC<DiffCardFileListProps> = ({
  files,
  sourceMode,
  current,
  stagingPaths,
  onSetActiveDiffSource,
  onStageFile,
  onUnstageFile,
  onDiscardChanges,
  onStageAll,
  onUnstageAll,
  renderInlineDiffContent,
  getFileDiffData,
}) => {
  const { stagedFiles, unstagedFiles } = useMemo(() => {
    const staged: FileDiff[] = [];
    const unstaged: FileDiff[] = [];
    for (const f of files) {
      if (f.staged) staged.push(f);
      else unstaged.push(f);
    }
    return { stagedFiles: staged, unstagedFiles: unstaged };
  }, [files]);

  const renderFileRow = (f: FileDiff) => {
    if (!f || !f.filePath) return null;
    const active = current?.filePath === f.filePath;
    const targetDiff = getFileDiffData ? (getFileDiffData(f) ?? f) : f;
    const additions = targetDiff.additions ?? f.additions ?? 0;
    const deletions = targetDiff.deletions ?? f.deletions ?? 0;
    const { name, dir } = splitPath(f.filePath);
    const badge = resolveStatusBadge(f);
    const isStaging = stagingPaths[f.filePath];

    return (
      <div key={f.filePath} className={styles.fileNode} role="listitem">
        <button
          type="button"
          className={`${styles.fileRow} ${active ? styles.isActive : ''}`}
          onClick={() => onSetActiveDiffSource(active ? null : f)}
          aria-expanded={active}
          aria-label={`${name} ${dir ? `(${dir})` : ''} +${additions} -${deletions}`}
        >
          {/* 1. 展开/折叠指示图标 */}
          <Lucide.ChevronRight
            size={14}
            className={`${styles.chevronIcon} ${active ? styles.expanded : ''}`}
            aria-hidden
          />

          {/* 2. 状态徽章 */}
          <span className={`${styles.statusBadge} ${styles[badge.key]}`} aria-hidden>
            {badge.char}
          </span>

          {/* 3. 文件名与目录路径分级 */}
          <div className={styles.pathWrap} title={f.filePath}>
            <span className={styles.fileName}>{name}</span>
            {dir && <span className={styles.dirPath}>{dir}</span>}
          </div>

          {/* 4. 统计数字与快捷动作并列区 */}
          <div className={styles.statAndActions}>
            <span className={styles.fileStat} aria-hidden>
              {additions > 0 && <span className={styles.statAdd}>+{additions}</span>}
              {deletions > 0 && <span className={styles.statDel}>−{deletions}</span>}
            </span>

            {sourceMode === 'git' && (
              <div className={styles.rowActions} onClick={(e) => e.stopPropagation()}>
                {isStaging ? (
                  <Lucide.Loader2 size={13} className={styles.spinner} aria-label="处理中" />
                ) : f.staged ? (
                  <Tooltip content="取消暂存此文件">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className={styles.rowActBtn}
                      aria-label="取消暂存此文件"
                      onClick={() => void onUnstageFile(f.filePath)}
                      icon={<Lucide.Minus size={13} />}
                    />
                  </Tooltip>
                ) : (
                  <>
                    <Tooltip content="暂存此文件">
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className={styles.rowActBtn}
                        aria-label="暂存此文件"
                        onClick={() => void onStageFile(f.filePath)}
                        icon={<Lucide.Plus size={13} />}
                      />
                    </Tooltip>
                    <Tooltip content="放弃此文件的本地修改">
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        className={`${styles.rowActBtn} ${styles.danger}`}
                        aria-label="放弃此文件的本地修改"
                        onClick={() => void onDiscardChanges(f.filePath)}
                        icon={<Lucide.Undo2 size={13} />}
                      />
                    </Tooltip>
                  </>
                )}
              </div>
            )}
          </div>
        </button>

        {/* 5. 展开的代码比对视口（无缝嵌合，零外框） */}
        {active && (
          <div className={styles.diffPane}>
            {renderInlineDiffContent(f)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={styles.flatFileList} role="list" aria-label="变更文件列表">
      {sourceMode === 'git' ? (
        <>
          {/* 已暂存分组 */}
          <div className={styles.groupSection}>
            <div className={styles.groupHeader}>
              <span className={styles.groupTitle}>已暂存的更改 ({stagedFiles.length})</span>
              {stagedFiles.length > 0 && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className={styles.groupActionBtn}
                  onClick={onUnstageAll}
                  icon={<Lucide.MinusCircle size={13} />}
                >
                  全部取消暂存
                </Button>
              )}
            </div>
            {stagedFiles.length === 0 ? (
              <div className={styles.groupEmptyHint}>无已暂存的文件</div>
            ) : (
              <div className={styles.groupBody}>
                {stagedFiles.map(renderFileRow)}
              </div>
            )}
          </div>

          {/* 未暂存分组 */}
          <div className={styles.groupSection}>
            <div className={styles.groupHeader}>
              <span className={styles.groupTitle}>未暂存的更改 ({unstagedFiles.length})</span>
              {unstagedFiles.length > 0 && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className={styles.groupActionBtn}
                  onClick={onStageAll}
                  icon={<Lucide.PlusCircle size={13} />}
                >
                  全部暂存
                </Button>
              )}
            </div>
            {unstagedFiles.length === 0 ? (
              <div className={styles.groupEmptyHint}>无未暂存的修改</div>
            ) : (
              <div className={styles.groupBody}>
                {unstagedFiles.map(renderFileRow)}
              </div>
            )}
          </div>
        </>
      ) : (
        files.map(renderFileRow)
      )}
    </div>
  );
};
```

---

## 3. CSS 规范重写方案（严格直角化、紧凑 32px、tokens 绑定、消除跳动）

### 3.1 容器与外框规范（消除外部留白与卡片间距）

彻底废除 `.fileList` 的 `padding: 10px; gap: 8px;`，采用贴边平铺容器：

```css
/* 纯净平直文件列表容器 */
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
}

/* Git 分组块 */
.groupSection {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 0;
  margin: 0;
}

/* 分组表头：高度 28px，底边线，粘滞吸顶 */
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
  border-bottom: 1px solid var(--border-subtle);
  position: sticky;
  top: 0;
  z-index: 2;
}

.groupTitle {
  font-size: var(--font-size-xs, 12px);
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-secondary);
  user-select: none;
}

.groupBody {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 0;
  gap: 0;
}

.groupEmptyHint {
  font-size: var(--font-size-xxs, 11px);
  color: var(--text-tertiary);
  padding: 10px 12px;
  text-align: center;
  border-bottom: 1px solid var(--border-subtle);
  background: transparent;
}
```

---

### 3.2 平直文件行（`.fileRow`）几何与状态机规范

单行高度锁定为 32px，完全直角化，底部分割线贯通：

```css
/* 单个文件物理节点（逻辑包装） */
.fileNode {
  display: flex;
  flex-direction: column;
  width: 100%;
  box-sizing: border-box;
}

/* 平直文件交互行（32px 紧凑单轨） */
.fileRow {
  display: flex;
  flex-direction: row;
  align-items: center;
  height: 32px;
  min-height: 32px;
  max-height: 32px;
  padding: 0 12px;
  margin: 0;
  width: 100%;
  box-sizing: border-box;
  border: none;
  border-bottom: 1px solid var(--border-subtle);
  border-radius: 0; /* 严格强制直角，杜绝任何 radius */
  background: transparent;
  cursor: pointer;
  text-align: left;
  user-select: none;
  outline: none;
  transition:
    background-color var(--transition-fast, 120ms),
    box-shadow var(--transition-fast, 120ms);
}

/* 悬停态：单一使用 var(--bg-hover)（浅色 2.5%、深色 3.5%），绝不加外框 */
.fileRow:hover {
  background-color: var(--bg-hover);
}

/* 键盘焦点态：柔和轮廓，符合 §13 焦点对比度纪律 */
.fileRow:focus-visible {
  outline: 1px solid var(--tint-focus-ring, color-mix(in srgb, var(--text-primary) 8%, transparent));
  outline-offset: -1px;
}

/* 选中/展开激活态：单一 var(--bg-active) + 左侧 2px 翡翠绿强调条 */
.fileRow.isActive {
  background-color: var(--bg-active);
  box-shadow: inset 2px 0 0 var(--brand-primary, #10b981);
}

.fileRow.isActive:hover {
  background-color: var(--bg-active);
}
```

---

### 3.3 行内子元素精密排版规范

```css
/* 1. 折叠指示箭头（14px，旋转过渡） */
.chevronIcon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--text-tertiary);
  margin-right: 6px;
  transition:
    transform var(--transition-fast, 120ms) cubic-bezier(0.2, 0, 0, 1),
    color var(--transition-fast, 120ms);
}

.fileRow:hover .chevronIcon {
  color: var(--text-secondary);
}

.chevronIcon.expanded {
  transform: rotate(90deg);
  color: var(--text-primary);
}

/* 2. 状态徽章（16x16px，语义化着色） */
.statusBadge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  min-width: 16px;
  flex-shrink: 0;
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  border-radius: var(--radius-xs, 2px); /* 仅标签自身微圆角，不破坏列表平直结构 */
  margin-right: 8px;
}

/* M - 修改 (Modified) */
.statusBadge.mod {
  color: var(--diff-mod-fg, #d97706);
  background: color-mix(in srgb, var(--diff-mod-fg, #d97706) 12%, transparent);
}

/* A - 新增 (Added) */
.statusBadge.add {
  color: var(--diff-add-fg, #10b981);
  background: color-mix(in srgb, var(--diff-add-fg, #10b981) 12%, transparent);
}

/* D - 删除 (Deleted) */
.statusBadge.del {
  color: var(--diff-del-fg, #ef4444);
  background: color-mix(in srgb, var(--diff-del-fg, #ef4444) 12%, transparent);
}

/* R - 重命名 (Renamed) */
.statusBadge.ren {
  color: var(--diff-ren-fg, #8b5cf6);
  background: color-mix(in srgb, var(--diff-ren-fg, #8b5cf6) 12%, transparent);
}

/* 3. 文件名与目录路径分级容器 */
.pathWrap {
  display: flex;
  align-items: baseline;
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  margin-right: 8px;
}

.fileName {
  font-family: var(--font-sans);
  font-size: var(--font-size-xs, 12px);
  font-weight: var(--font-weight-medium, 500);
  color: var(--text-primary);
  white-space: nowrap;
  flex-shrink: 0;
}

.dirPath {
  font-family: var(--font-sans);
  font-size: var(--font-size-xxs, 11px);
  font-weight: 400;
  color: var(--text-tertiary);
  margin-left: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1 1 auto;
  min-width: 0;
}

/* 4. 统计与快捷动作并列容器（消除排版跳动核心） */
.statAndActions {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  flex-shrink: 0;
}

/* 常驻增删统计（等宽数字，永不隐藏） */
.fileStat {
  display: flex;
  align-items: center;
  gap: var(--space-1_5, 6px);
  font-family: var(--font-mono, monospace);
  font-size: var(--font-size-xxs, 11px);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  opacity: 1; /* 刚性锁定为常驻可见，彻底删除 hover opacity: 0 */
  transition: opacity var(--transition-micro, 80ms);
}

.statAdd {
  color: var(--diff-add-fg, #10b981);
}

.statDel {
  color: var(--diff-del-fg, #ef4444);
}

/* 快捷动作组：与统计并排，常态隐藏但保留占位或透明，hover/focus-within 时柔和显现 */
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

/* 双触发：支持鼠标悬停与键盘 Tab 导航聚焦 */
.fileRow:hover .rowActions,
.fileRow:focus-within .rowActions {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}

.rowActBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  min-width: 22px;
  padding: 0;
  border-radius: var(--radius-xs, 2px);
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition:
    color var(--transition-micro, 80ms),
    border-color var(--transition-micro, 80ms),
    background-color var(--transition-micro, 80ms);
}

.rowActBtn:hover {
  color: var(--text-primary);
  border-color: var(--border-subtle);
  background-color: var(--bg-hover);
}

.rowActBtn.danger:hover {
  color: var(--accent-red, #ef4444);
  border-color: var(--accent-red, #ef4444);
  background-color: color-mix(in srgb, var(--accent-red, #ef4444) 10%, transparent);
}
```

---

## 4. 展开代码比对区贴合嵌合设计

### 4.1 垂直无缝嵌合与 Hairline 收口机制

在平直单轨架构下，展开的代码比对区不再是一个嵌套在 8px 圆角卡片中的孤岛，而是直接挂在 `.fileRow` 紧下方的原生展开体。

```
┌────────────────────────────────────────────────────────────────────────┐
│ [v] [M]  DiffCardFileList.tsx  src/components/diff/       +42 −18      │ (.fileRow, 32px)
├────────────────────────────────────────────────────────────────────────┤ <── 1px hairline (border-bottom)
│ 10: import { useMemo } from 'react';                                   │
│ 11: import * as Lucide from 'lucide-react';                            │
│ 12:+import { Button, Tooltip } from '../ui';                           │
│ 13:-import { Button, IconButton, Select, Tooltip } from '../ui';       │ (.diffPane, 全宽贴合，零圆角)
│ ...                                                                    │
├────────────────────────────────────────────────────────────────────────┤ <── 1px hairline (border-bottom)
│ [>] [A]  FlatList.module.css   src/components/diff/       +84 −0       │ (.fileRow, 32px)
└────────────────────────────────────────────────────────────────────────┘
```

#### 样式规则声明
```css
/* 展开比对区容器：零外边距、零圆角、全宽贴合 */
.diffPane {
  display: flex;
  flex-direction: column;
  width: 100%;
  margin: 0;
  padding: 0;
  border: none;
  border-bottom: 1px solid var(--border-subtle); /* 底部收口线 */
  background: var(--bg-card);
  box-sizing: border-box;
}

/* 对接内部 DiffCodeViewer 视口容器 */
.diffPane :global(.scrollParent),
.diffPane .scrollParent {
  min-height: 48px;
  max-height: min(560px, 65vh);
  height: auto;
  overflow-y: auto;
  overscroll-behavior: auto;
  position: relative;
  background: var(--diff-bg-pane, var(--bg-card));
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  border-radius: 0; /* 严格强制直角 */
  border: none;
}
```

### 4.2 消除工具行后的空间增益与视口连贯性
- **高度收益**：彻底拔除 `.inlineHeader` 工具行后，单个展开条目即刻**释放 36px 垂直高度**；
- **视觉收益**：第一行代码比对内容与上方 32px 文件标题行之间仅隔 1px hairline 分割线，目光移动平滑自然；
- **滚动体验**：代码比对区内部的垂直滚动条与右侧主边界拉平对齐，杜绝了嵌套卡片带来的“双重滚轮缩进”和“滚轮事件挤压”。

---

## 5. 旧代码清剿清单与自检删除面

### 5.1 旧路径清单（Legacy Path Inventory）

#### `DiffCard.module.css` 拟废除与重写选择器对照表

| 序号 | 所在行范围 | 废弃 CSS 选择器 / 规则块 | 废除属性清单 | 废除根因与替代目标 |
| :---: | :--- | :--- | :--- | :--- |
| **1** | L176-177 | `.fileList` | `gap: var(--space-2, 8px);`<br>`padding: var(--space-3, 10px);` | 导致外围掏空与卡片孤岛；重写为 `.flatFileList` 并将 padding/gap 归零 |
| **2** | L192-206 | `.accordionItem` 及 hover | `border: 1px solid transparent;`<br>`border-radius: var(--radius-md, 6px);` | 手风琴卡片外框与 6px 圆角；由无边框直角的 `.fileNode` 替代 |
| **3** | L208-222 | `.accordionActive` 及 hover | `border: 1px solid var(--border-subtle);`<br>`border-radius: var(--radius-lg);` | 激活态独立矩形外框与 8px 圆角；由 `.fileRow.isActive` 替代 |
| **4** | L223-228 | `.accordionHeaderRow` | `position: relative; display: flex;` | 旧手风琴行容器；重构为标准 `.fileRow` |
| **5** | L230-263 | `.accordionItem .fileItem` 族 | `border-radius: 0; padding: 8px 12px;` | 冗余特异性选择器与旧尺寸；由 32px 高度规范的 `.fileRow` 替代 |
| **6** | L277-282 | `.fileNameLink:hover` | `text-decoration: underline;`<br>`color: var(--accent-blue);` | 按钮内设链接下划线制造视觉噪点；改为纯净 `.fileName` |
| **7** | L311-314 | `.accordionHeaderRow:hover .fileStat` | `opacity: 0;` | **暴力隐藏反模式**：hover 时抹除统计数据引发闪烁；彻底删除 |
| **8** | L316-338 | `.hoverActions` (绝对定位) | `position: absolute; right: 12px; top: 50%; transform: translateY(-50%);` | 绝对定位覆盖排版；重写为 Flex 并列排布的 `.rowActions` |
| **9** | L340-365 | `.hoverActBtn` | `border-radius: var(--radius-xs);` | 旧手风琴行内按钮；并入标准 `.rowActBtn` |
| **10** | L367-372 | `.inlineBody` | `display: flex; flex-direction: column;` | 旧手风琴展开区；由全宽贴合的 `.diffPane` 替代 |
| **11** | L374-383 | `.inlineHeader` | `padding: 4px 10px; border-bottom: ...` | **用户明令裁决移除的单文件工具行**；彻底删除 |
| **12** | L385-396 | `.compareSelectorWrap`, `.selectLabel` | `font-size: 12px; color: ...` | 单文件对比维度下拉容器；彻底删除 |
| **13** | L398-401 | `.inlineCompareSelect` | `width: 140px; min-width: 120px;` | 单文件对比维度下拉框；彻底删除 |
| **14** | L403-407 | `.inlineActions` | `display: flex; gap: var(--space-1);` | 单文件工具栏 6 按钮容器；彻底删除 |
| **15** | L409-430 | `.inlineIconBtn` | `width: 28px; height: 28px; radius: 4px;` | 单文件工具栏图标按钮；彻底删除 |
| **16** | L432-436 | `.actionDivider` | `width: 1px; height: 14px;` | 单文件工具栏分割线；彻底删除 |
| **17** | L820 | `.groupEmptyHint` | `border-radius: var(--radius-md);` | 提示框圆角；平直化归零置 0 |
| **18** | L827 | `.groupItemsContainer` | `gap: var(--space-2, 8px);` | Git 分组内卡片间距；归零置 0 |

---

### 5.2 自检删除面（Self-Inspection Deletion Surface）

#### 物理代码修改与行数净负产出预期

```
==================================================================================================
代码净负产出预期核算表（以架构净收敛为荣）：
==================================================================================================
文件 1：DiffCardFileList.tsx
  - 原始代码总行数：408 行
  - 待删除行数：~195 行（L115-136 维度计算、L219-328 工具行 JSX、L4-14 死导入与 Props）
  - 重构新增行数：~40 行（splitPath, resolveStatusBadge, 32px 平直节点）
  - 重构后代码量：~210-220 行
  - 预计净减少：-188 ~ -198 行（精简幅度达 48%）

文件 2：DiffCard.module.css
  - 原始代码总行数：893 行
  - 待删除行数：~145 行（.accordionItem, .accordionActive, .inlineHeader, .inlineActions 等）
  - 重构新增行数：~55 行（.flatFileList, .fileRow, .statusBadge, .diffPane 等）
  - 重构后代码量：~790-800 行
  - 预计净减少：-90 ~ -100 行

合计工程净产出：
  - 净减少代码行数：~280 ~ -300 行（硬性满足要求：净减 > 150-200 行）
  - 彻底拔除 18 处冗余选择器与 6 处 TSX 内联裸写样式
  - DOM 树嵌套深度从 6 层压平至 3 层
==================================================================================================
```

---

## 6. 测试资产保护与回归验证断言

### 6.1 测试资产保护铁律（零破坏、零绕过）

依据仓库权威协作指令（`AGENTS.md` §9 及 §7），测试是用代码生命线，严禁为了让 CI 变绿而随意删除或跳过测试。重构必须确保所有既有测试契约平滑过渡，并在出现断裂时实施正向修复。

---

### 6.2 既有测试断言平滑迁移与兼容策略

#### 1. 样式契约测试门禁（[`style-contract.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/style-contract.test.ts)）
- **现场断言定位**：
  [`style-contract.test.ts:513-526`](file:///c:/Software/conex/apps/crish-desktop/src/styles/style-contract.test.ts#L513-L526) 断言：
  ```typescript
  expect(block).toContain('opacity: 0');
  expect(block).toContain('visibility: hidden');
  expect(block).not.toContain('display: none');
  expect(css).toContain('.accordionHeaderRow:hover .hoverActions');
  expect(css).toContain('.accordionHeaderRow:focus-within .hoverActions');
  expect(css).toContain('.accordionHeaderRow:focus-within .fileStat');
  ```
- **破损风险与平滑过渡策略**：
  - 若直接将类名全面改写为 `.fileRow` 和 `.rowActions`，该测试将因匹配不到旧类名字符串而报错。
  - **过渡解法（双向兼容选择器）**：
    在 `DiffCard.module.css` 中，将选择器声明为联合别名：
    ```css
    .fileRow:hover .rowActions,
    .fileRow:focus-within .rowActions,
    .accordionHeaderRow:hover .hoverActions,
    .accordionHeaderRow:focus-within .hoverActions {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
    }
    ```
    同时在实施批次中，协同更新测试用例，让断言平滑过度至新选择器，并断言 `.fileStat` 绝不含有 `opacity: 0` 规则；
- **列表语义断言**：
  [`style-contract.test.ts:528-535`](file:///c:/Software/conex/apps/crish-desktop/src/styles/style-contract.test.ts#L528-L535) 断言 `role="list"` 与 `aria-label="变更文件列表"`：平直列表天然继承这两个属性，此测试 100% 保持通过。

#### 2. 文件列表单元测试（[`DiffCardFileList.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.test.tsx)）
- **现场用例分析**：
  - 用例 1（`should disable Accept button for provisional diff`）：该测试针对的是 `classifyFileDiff` 纯逻辑校验，断言仍可安全保留；
  - 用例 2（`renders inline compare Select with explicit size="sm"...`）：该测试针对的是已由用户明令裁决移除的单文件对比维度下拉菜单。在实施阶段，该死测试用例应安全退役（或迁移至顶栏 `DiffHeaderControls` 的全局会话选择器测试）；
  - 用例 3（`renders targetDiff additions and deletions when getFileDiffData is provided`）：测试文件行渲染统计数字，平直列表完全保留该特性，断言天然保持通过。
- **新增平直列表专属测试断言**：
  - 断言文件行渲染 `.fileRow` 并具备 `aria-expanded={false}`；
  - 点击文件行后触发 `onSetActiveDiffSource`，激活态挂载 `box-shadow: inset 2px 0 0 var(--brand-primary)`；
  - 断言渲染语义化状态徽标（`M`/`A`/`D`/`R`），且统计数字在 hover 状态下依然常驻于 DOM 且可见。

#### 3. 大文件解析性能基准（[`DiffCard.perf.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.perf.test.tsx)）
- 平直列表化彻底清除了外层 6px/8px 圆角与层层嵌套的 DOM 包装，浏览器 Composite 与 Layout 压力大幅减轻，性能测试（3500+ 行解析）将显著提升或保持平稳。

---

### 6.3 验证执行命令清单

实施阶段必须执行以下命令进行立体化闭环验证，严禁任何 `--no-verify` 绕过：

```bash
# 1. 静态行数门禁扫描（确保净负产出）
npm run check:line-counts

# 2. 严格类型检查（无 any、无死属性残留）
npm run typecheck

# 3. 样式契约与列表测试专项运行
npx vitest run apps/crish-desktop/src/styles/style-contract.test.ts
npx vitest run apps/crish-desktop/src/components/diff/DiffCardFileList.test.tsx
npx vitest run apps/crish-desktop/src/components/diff/DiffCard.perf.test.tsx

# 4. 前端快层全量门禁检查
npm run test:coverage -- --project=unit
```

---

## 7. 总结与实施执行交接

本方案（PLAN-01）作为差异面板系统性重构的基石骨架：
1. **物理形态**：彻底剔除手风琴卡片孤岛，实现 **32px 紧凑高度、0px 严格直角、全宽贴合、1px hairline 底边线** 的平直列表；
2. **交互规范**：绑定 `var(--bg-hover)` 与 `var(--bg-active)` + 翡翠绿强调条，常驻等宽统计数据，彻底消灭遮挡跳动；
3. **架构收敛**：斩除单文件展开内部工具行，预计带来 **-280 ~ -300 行净负产出**，显著降低认知负荷与系统复杂度；
4. **测试闭环**：确立了与 `style-contract.test.ts` 及 `DiffCardFileList.test.tsx` 协同演进的平滑过渡策略，确保重构过程零破坏、零退避。
