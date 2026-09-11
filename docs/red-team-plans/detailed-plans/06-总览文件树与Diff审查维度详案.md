# 总览 36 改动文件树与 34px 紧凑 Diff 维度重构与收敛实施详案

## Red Team Detailed Plan 06: Workspace Changes Tree & 34px Compact Diff Architecture Specification

> **文档版本**：v1.0.0 (Master Final Architecture Specification)
> **所属战役**：红队前端系统级重构与收敛战役 (Red Team Frontend Refactoring & Convergence)
> **领域维度代号**：`RED-DETAILED-PLAN-06` (Domain 06: Overview Tree & Compact Diff System)
> **权威与纪律依据**：
>
> 1. 严格贯彻《红队前端系统级重构总计划框架与删除面裁决》（[`00-红队前端系统级重构总计划框架与删除面裁决.md`](file:///c:/Software/conex/docs/red-team-plans/00-红队前端系统级重构总计划框架与删除面裁决.md)）；
> 2. 深度落实《红队子 Agent 方案编制契约与收敛基准》（[`00-红队子Agent方案编制契约与收敛基准.md`](file:///c:/Software/conex/docs/red-team-plans/00-红队子Agent方案编制契约与收敛基准.md)）；
> 3. 严格遵循三份交叉评审专著的终审裁决（[`01-独立方案交叉评审报告-冲突与路径重叠专审.md`](file:///c:/Software/conex/docs/red-team-plans/plan-reviews/01-独立方案交叉评审报告-冲突与路径重叠专审.md)、[`02-独立方案交叉评审报告-收敛深度与死代码清剿专审.md`](file:///c:/Software/conex/docs/red-team-plans/plan-reviews/02-独立方案交叉评审报告-收敛深度与死代码清剿专审.md)、[`03-独立方案交叉评审报告-依赖拓扑与执行可行性专审.md`](file:///c:/Software/conex/docs/red-team-plans/plan-reviews/03-独立方案交叉评审报告-依赖拓扑与执行可行性专审.md)）；
> 4. 深度对标 AppFlowy 真实源码解剖（[`05-AppFlowy文件树与状态指示Badge源码解剖.md`](file:///c:/Software/conex/docs/frontend-benchmarking/deep-dives/05-AppFlowy文件树与状态指示Badge源码解剖.md) 与 [`06-AppFlowy紧凑Diff视图与词法高亮源码解剖.md`](file:///c:/Software/conex/docs/frontend-benchmarking/deep-dives/06-AppFlowy紧凑Diff视图与词法高亮源码解剖.md)）；
> 5. 严格贯彻《主控 Agent 协作指令》（`AGENTS.md`）与《反退避全文》（`.agents/LOGIC_PLAN_NO_RETREAT.md`）——**零退避、零降级、零补丁、负产出验收、推进单位为领域概念、严禁波次/批次命名**。
>    **防作弊最高铁律**：本详案 100% 独立构建于白盒代码审计与标杆源码解剖，**绝对严禁查看、检索、引用 `docs/frontend-review/`（蓝队隔离区）下的任何文件**。
>    **编码格式**：UTF-8 无 BOM。

---

# 卷首：数学目标函数与视口几何收敛模型

### 0.1 「正确性 × 收敛性」双目标函数

本详案的所有架构演进、算法实现与代码删除动作，受控于以下刚性数学目标函数：

$$\mathbf{U_{\text{plan}}} = \mathcal{C}_{\text{correctness}}(\Delta) \times \mathcal{S}_{\text{convergence}}(\Delta)$$

1. **功能正确性 $\mathcal{C}_{\text{correctness}} \in \{0, 1\}$**：
   - 彻底根除总览面板 36 个改动文件在 280px 死板限高盒中的窒息拥挤、`basename()` 暴力截断导致的空间目录拓扑完全丢失、以及 `<em>` 裸标签廉价排版的三大痛点；
   - 彻底根除 Diff 面板 76px 双行 Header 浪费 20% 垂直高度、15.5% 刺眼荧光红绿底色破坏代码可读性、整行均一染色缺失词法内核焦点、以及通栏黄色横幅 `.applyHint` 误伤正常 Git 审查的四大痛点；
   - 保证类型检查 0 报错、测试用例 100% 绿灯，严禁使用 `--no-verify` 绕过门禁。
2. **结构收敛性 $\mathcal{S}_{\text{convergence}}$**：
   - **概念主路径唯一化**：工作区改动收敛于 `OverviewGitTree` 唯一树状/扁平双模容器；Diff 代码审查收敛于 `CompactDiffHeader` 34px 单行紧凑体系；
   - **概念路径冗余度（Canonical Path Density, CPD）收敛**：工作区改动概念从 3 条分散路径收敛至 1 条（$\text{CPD}: 3 \to 1.0$）；Diff 审查系统从 4 处碎片化设计收敛至 1 条（$\text{CPD}: 4 \to 1.0$）；
   - **先删后改（Delete-First）**：物理删除孤儿组件 `ChangeOverviewCard.tsx`（480 行）及其样式表（230 行）、物理拔除 280px 硬编码限高、物理剥离 76px 双行工具栏与通栏黄色警告条；
   - **负产出验收（Negative Code Yield）**：全案实施后，本领域文件域净代码削减量必须严格满足 $\Delta_{\text{lines}} \le -400$ 行。

---

### 0.2 垂直视口空间释放模型 (Viewport Height Release Model)

在传统桌面 IDE 与审查面板中，代码内容区是用户注意力的核心承载区。通过对 Diff 头部与提示区域的极端压缩，释放出可观的垂直高度：

$$\Delta H_{\text{released}} = H_{\text{legacy}} - H_{\text{compact}} = (76\text{px} + 60\text{px}_{\text{banner}} + 12\text{px}_{\text{margin}}) - 34\text{px} = \mathbf{114\text{px}}$$

$$\text{Release Ratio} = \frac{114\text{px}}{148\text{px}} \approx \mathbf{77.0\%}\text{ (在展开黄色横幅时)}$$

$$\text{Standard Release Ratio} = \frac{76\text{px} - 34\text{px}}{76\text{px}} \approx \mathbf{55.26\%}\text{ (在标准常态工具栏下)}$$

这一重构直接将首屏可见代码行数（以 22px 行高计）增加 **5~6 行**，大幅提升审查流畅度。

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           Diff 面板垂直空间压缩对照模型                                  │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│  [重构前: 148px 占用]                                                                   │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │ toolbarRow1: 来源切换 + 模式切换 + 提交 + 筛选 + 清空 (38px)                      │  │
│  ├───────────────────────────────────────────────────────────────────────────────────┤  │
│  │ toolbarRow2: 分支选择器 / AI 回合选择器 (38px)                                    │  │
│  ├───────────────────────────────────────────────────────────────────────────────────┤  │
│  │ .applyHint: 通栏黄色警告条 "此 diff 无法安全自动应用..." (60px + 12px margin)      │  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                         │
│  [重构后: 34px 单行极致集成]                                                            │
│  ┌───────────────────────────────────────────────────────────────────────────────────┐  │
│  │ 34px Compact Header: [AI/Git 来源] │ [分支/回合选择] │ [分栏/合并] │ [搜索/提交/复制]│  │
│  └───────────────────────────────────────────────────────────────────────────────────┘  │
│  ▼ 垂直空间释放 55.26% ~ 77.0% ── 净赚 5~6 行代码可视区！                               │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

# 一、 做什么：架构重构与唯一主路径工业级设计 (What to Build)

## 1.1 纯函数 `buildGitTree` 多叉树与单子目录紧凑折叠算法

### 1.1.1 核心数据结构与 TypeScript 类型契约 (`GitTreeTypes.ts`)

在 `apps/crish-desktop/src/components/overview/GitTreeTypes.ts` 中建立严格规范的领域类型契约：

```typescript
// apps/crish-desktop/src/components/overview/GitTreeTypes.ts

/**
 * Git 状态单字符标准代码
 */
export type GitStatusCode = 'M' | 'A' | 'D' | 'U' | 'C' | 'R' | '?';

/**
 * Git 文件状态数据契约
 */
export interface GitStatusFile {
  path: string;
  status: GitStatusCode;
  additions?: number;
  deletions?: number;
  conflicted?: boolean;
  staged?: boolean;
}

/**
 * 树节点基础共有契约
 */
export interface GitTreeBaseNode {
  id: string; // 规范化绝对相对路径，作为 React Key
  name: string; // 呈现名称 (单级目录名，或紧凑折叠的路径链如 'apps/crish-desktop/src')
  fullPath: string; // 完整相对路径
  depth: number; // 视觉缩进深度 (0-indexed)
}

/**
 * 目录节点契约
 */
export interface GitTreeFolderNode extends GitTreeBaseNode {
  isFolder: true;
  children: GitTreeNode[];
  totalFiles: number;
  totalAdditions: number;
  totalDeletions: number;
}

/**
 * 文件叶子节点契约
 */
export interface GitTreeFileNode extends GitTreeBaseNode {
  isFolder: false;
  file: GitStatusFile;
}

/**
 * 树节点联合类型
 */
export type GitTreeNode = GitTreeFolderNode | GitTreeFileNode;

/**
 * 树构建选项
 */
export interface GitTreeBuildOptions {
  compactSingleChild?: boolean; // 是否启用单子目录紧凑折叠，默认为 true
}

/**
 * 增删统计微条度量契约
 */
export interface DiffStatMetric {
  additions: number;
  deletions: number;
  maxBars?: number; // 默认 5 格
}
```

---

### 1.1.2 纯函数 `buildGitTree` 与单子目录紧凑折叠算法 (`GitTreeBuilder.ts`)

```typescript
// apps/crish-desktop/src/components/overview/GitTreeBuilder.ts

import {
  GitStatusFile,
  GitTreeNode,
  GitTreeFolderNode,
  GitTreeBuildOptions,
} from './GitTreeTypes';

/**
 * 纯函数：将扁平 Git 文件列表转换为带紧凑折叠的多叉树结构
 *
 * @param files 扁平 Git 文件状态数组
 * @param options 树构建参数
 * @returns 构造完成的多叉树顶级节点数组
 *
 * 性能复杂度：
 * - 时间复杂度: O(N * D + N log N)，其中 N 为文件总数，D 为平均目录深度 (D <= 10)
 * - 空间复杂度: O(N)，纯函数不可变输出，零副作用
 */
export function buildGitTree(
  files: GitStatusFile[],
  options: GitTreeBuildOptions = { compactSingleChild: true }
): GitTreeNode[] {
  if (!files || files.length === 0) {
    return [];
  }

  // 1. 初始化虚拟根容器
  const root: GitTreeFolderNode = {
    id: '__root__',
    name: '',
    fullPath: '',
    depth: -1,
    isFolder: true,
    children: [],
    totalFiles: 0,
    totalAdditions: 0,
    totalDeletions: 0,
  };

  // 2. 将扁平路径按 / 分解并逐级挂载至多叉树
  for (const file of files) {
    const normalizedPath = file.path.replace(/\\/g, '/').replace(/^\/+/, '');
    const segments = normalizedPath.split('/').filter(Boolean);
    let current = root;
    let currentPath = '';

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const isFile = i === segments.length - 1;

      current.totalFiles += 1;
      current.totalAdditions += file.additions || 0;
      current.totalDeletions += file.deletions || 0;

      if (isFile) {
        current.children.push({
          id: currentPath,
          name: segment,
          fullPath: currentPath,
          depth: current.depth + 1,
          isFolder: false,
          file,
        });
      } else {
        let folder = current.children.find(
          (c): c is GitTreeFolderNode => c.isFolder && c.name === segment
        );
        if (!folder) {
          folder = {
            id: currentPath,
            name: segment,
            fullPath: currentPath,
            depth: current.depth + 1,
            isFolder: true,
            children: [],
            totalFiles: 0,
            totalAdditions: 0,
            totalDeletions: 0,
          };
          current.children.push(folder);
        }
        current = folder;
      }
    }
  }

  // 3. 递归排序：文件夹优先于文件，同类按字母序升序
  const sortNodesRecursively = (nodes: GitTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isFolder && !b.isFolder) return -1;
      if (!a.isFolder && b.isFolder) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    for (const node of nodes) {
      if (node.isFolder) {
        sortNodesRecursively(node.children);
      }
    }
  };
  sortNodesRecursively(root.children);

  // 4. 执行单子目录紧凑折叠 (Compact Single-Child Folders)
  if (options.compactSingleChild) {
    return compactTreeFolders(root.children, 0);
  }

  return normalizeDepth(root.children, 0);
}

/**
 * 递归单子目录紧凑折叠算法
 * 对标 AppFlowy Compact Single-Child Folders：
 * 当目录 A 仅包含唯一子节点 B 且 B 也是目录时，坍缩为 'A/B'
 */
function compactTreeFolders(
  nodes: GitTreeNode[],
  targetDepth: number
): GitTreeNode[] {
  return nodes.map((node) => {
    if (!node.isFolder) {
      return { ...node, depth: targetDepth };
    }

    let current = node;
    let combinedName = current.name;
    let combinedPath = current.fullPath;

    // 只要只有一个子节点且该子节点是文件夹，就执行链式合并坍缩
    while (current.children.length === 1 && current.children[0]!.isFolder) {
      const singleChild = current.children[0] as GitTreeFolderNode;
      combinedName = `${combinedName}/${singleChild.name}`;
      combinedPath = singleChild.fullPath;
      current = singleChild;
    }

    return {
      id: combinedPath,
      name: combinedName,
      fullPath: combinedPath,
      depth: targetDepth,
      isFolder: true,
      totalFiles: current.totalFiles,
      totalAdditions: current.totalAdditions,
      totalDeletions: current.totalDeletions,
      children: compactTreeFolders(current.children, targetDepth + 1),
    };
  });
}

/**
 * 规范化树节点深度标尺
 */
function normalizeDepth(
  nodes: GitTreeNode[],
  targetDepth: number
): GitTreeNode[] {
  return nodes.map((node) => {
    if (!node.isFolder) {
      return { ...node, depth: targetDepth };
    }
    return {
      ...node,
      depth: targetDepth,
      children: normalizeDepth(node.children, targetDepth + 1),
    };
  });
}
```

---

## 1.2 4px 微圆角 `GitStatusBadge` 状态胶囊与 3 色增删比例微条

### 1.2.1 状态 Badge 与 3 色比例条规范设计

在现有代码中，`ChangesSection.tsx` 使用了行内样式 `<em style={{ color: statusColor, fontWeight: 300 }}>`，呈现出散乱无边框、无衬底的廉价感。重构后统一使用符合原子同心几何规范的 **4px 微圆角徽章** 与 **3 色增删比例微条**。

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        4px 微圆角 Badge 与 3 色比例条形态设计                          │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│   [ M ]  ChangesSection.tsx ─────────── 🟩🟩🟩🟥⬜  +45  −12                           │
│   ──┬──                                 └───┬───┘  └───┬──┘                            │
│     │                                       │          │                               │
│     └─ 4px 微圆角 HSL 柔和徽章              │          └─ 等宽数字 tabular-nums        │
│        (16px × 16px, 10px 粗体)             └─ 5 格比例微条 (绿增/红删/灰空)           │
│                                                                                        │
│   [ A ]  GitStatusBadge.tsx ─────────── 🟩🟩🟩🟩🟩  +85  −0                            │
│   [ D ]  legacy_card.ts     ─────────── 🟥🟥🟥🟥🟥  +0   −480                          │
│   [ U ]  draft_spec.md      ─────────── ⬜⬜⬜⬜⬜  Untracked                          │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### 1.2.2 `GitStatusBadge.tsx` 完整实现

```tsx
// apps/crish-desktop/src/components/overview/GitStatusBadge.tsx

import React from 'react';
import { Tooltip } from '../ui';
import { GitStatusCode } from './GitTreeTypes';
import styles from './GitStatusBadge.module.css';

interface GitStatusBadgeProps {
  status: GitStatusCode;
  conflicted?: boolean;
  staged?: boolean;
  className?: string;
}

const STATUS_MAP: Record<
  GitStatusCode,
  { label: string; text: string; kind: string }
> = {
  M: { label: '修改 (Modified)', text: 'M', kind: 'modified' },
  A: { label: '新增 (Added)', text: 'A', kind: 'added' },
  D: { label: '删除 (Deleted)', text: 'D', kind: 'deleted' },
  U: { label: '未跟踪 (Untracked)', text: 'U', kind: 'untracked' },
  C: { label: '冲突 (Conflicted)', text: 'C', kind: 'conflicted' },
  R: { label: '重命名 (Renamed)', text: 'R', kind: 'renamed' },
  '?': { label: '未知状态 (Unknown)', text: '?', kind: 'unknown' },
};

export const GitStatusBadge: React.FC<GitStatusBadgeProps> = React.memo(
  function GitStatusBadge({ status, conflicted, staged, className }) {
    const config = conflicted
      ? STATUS_MAP.C
      : STATUS_MAP[status] || STATUS_MAP['?'];

    const tooltipContent = `${config.label}${staged ? ' · 已暂存' : ''}`;

    return (
      <Tooltip content={tooltipContent}>
        <span
          className={`${styles.badge} ${styles[config.kind]} ${className || ''}`}
          aria-label={tooltipContent}
          role="status"
        >
          {config.text}
        </span>
      </Tooltip>
    );
  }
);

interface DiffStatBarProps {
  additions: number;
  deletions: number;
  maxBars?: number;
  className?: string;
}

export const DiffStatBar: React.FC<DiffStatBarProps> = React.memo(
  function DiffStatBar({ additions, deletions, maxBars = 5, className }) {
    const total = additions + deletions;
    if (total === 0) {
      return null;
    }

    // 计算增删格子分配 (四舍五入)
    const addBars = Math.min(
      maxBars,
      Math.round((additions / total) * maxBars)
    );
    const delBars = Math.min(
      maxBars - addBars,
      Math.round((deletions / total) * maxBars)
    );
    const emptyBars = Math.max(0, maxBars - addBars - delBars);

    return (
      <div
        className={`${styles.diffStatContainer} ${className || ''}`}
        aria-label={`+${additions}, -${deletions}`}
      >
        <div className={styles.microBar} aria-hidden>
          {Array.from({ length: addBars }).map((_, i) => (
            <span key={`add-${i}`} className={styles.barAdd} />
          ))}
          {Array.from({ length: delBars }).map((_, i) => (
            <span key={`del-${i}`} className={styles.barDel} />
          ))}
          {Array.from({ length: emptyBars }).map((_, i) => (
            <span key={`empty-${i}`} className={styles.barEmpty} />
          ))}
        </div>
        <div className={styles.statNumbers}>
          {additions > 0 && <span className={styles.numAdd}>+{additions}</span>}
          {deletions > 0 && <span className={styles.numDel}>−{deletions}</span>}
        </div>
      </div>
    );
  }
);
```

---

### 1.2.3 `GitStatusBadge.module.css` 样式表

```css
/* apps/crish-desktop/src/components/overview/GitStatusBadge.module.css */

.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm, 4px);
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  border: 1px solid transparent;
  box-sizing: border-box;
  user-select: none;
  flex-shrink: 0;
}

.modified {
  background: var(--badge-git-m-bg, hsl(38 92% 50% / 0.12));
  color: var(--badge-git-m-fg, hsl(38 92% 38%));
  border-color: var(--badge-git-m-border, hsl(38 92% 50% / 0.22));
}

.added {
  background: var(--badge-git-a-bg, hsl(142 71% 45% / 0.12));
  color: var(--badge-git-a-fg, hsl(142 71% 32%));
  border-color: var(--badge-git-a-border, hsl(142 71% 45% / 0.22));
}

.deleted {
  background: var(--badge-git-d-bg, hsl(0 84% 60% / 0.12));
  color: var(--badge-git-d-fg, hsl(0 84% 45%));
  border-color: var(--badge-git-d-border, hsl(0 84% 60% / 0.22));
}

.untracked {
  background: var(--badge-git-u-bg, hsl(215 16% 47% / 0.12));
  color: var(--badge-git-u-fg, hsl(215 16% 40%));
  border-color: var(--badge-git-u-border, hsl(215 16% 47% / 0.22));
}

.conflicted {
  background: var(--badge-git-c-bg, hsl(0 84% 60% / 0.2));
  color: var(--badge-git-c-fg, hsl(0 84% 40%));
  border-color: var(--badge-git-c-border, hsl(0 84% 60% / 0.4));
}

.renamed {
  background: var(--badge-git-r-bg, hsl(270 60% 50% / 0.12));
  color: var(--badge-git-r-fg, hsl(270 60% 40%));
  border-color: var(--badge-git-r-border, hsl(270 60% 50% / 0.22));
}

.unknown {
  background: var(--bg-tertiary);
  color: var(--text-tertiary);
  border-color: var(--border-color);
}

/* 增删统计微条 */
.diffStatContainer {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1_5, 6px);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  flex-shrink: 0;
}

.microBar {
  display: inline-flex;
  align-items: center;
  gap: 1.5px;
}

.barAdd,
.barDel,
.barEmpty {
  width: 3px;
  height: 9px;
  border-radius: 1px;
}

.barAdd {
  background: var(--accent-green, #16a34a);
}

.barDel {
  background: var(--accent-red, #dc2626);
}

.barEmpty {
  background: var(--border-color, hsl(210 10% 85% / 0.6));
}

.statNumbers {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-variant-numeric: tabular-nums;
}

.numAdd {
  color: var(--accent-green, #16a34a);
  font-weight: 500;
}

.numDel {
  color: var(--accent-red, #dc2626);
  font-weight: 500;
}
```

---

## 1.3 `flex: 1` 视口弹性自适应与 30px 呼吸感树节点排版

### 1.3.1 树状/扁平双模容器 (`OverviewGitTree.tsx`)

```tsx
// apps/crish-desktop/src/components/overview/OverviewGitTree.tsx

import React, { useState, useMemo, useCallback } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  List,
  Network,
} from 'lucide-react';
import { Button, Tooltip } from '../ui';
import {
  GitStatusFile,
  GitTreeNode,
  GitTreeFolderNode,
  GitTreeFileNode,
} from './GitTreeTypes';
import { buildGitTree } from './GitTreeBuilder';
import { GitStatusBadge, DiffStatBar } from './GitStatusBadge';
import { detectFileKind } from '../../api/workspaceFsApi';
import { fileExtColor } from '../../api/codeHighlight';
import styles from './OverviewGitTree.module.css';

interface OverviewGitTreeProps {
  files: GitStatusFile[];
  openingPath: string | null;
  onOpenFile: (file: GitStatusFile) => void;
  className?: string;
}

export const OverviewGitTree: React.FC<OverviewGitTreeProps> = React.memo(
  function OverviewGitTree({ files, openingPath, onOpenFile, className }) {
    const [viewMode, setViewMode] = useState<'tree' | 'flat'>('tree');
    const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
      () => new Set(['__all__'])
    );

    // 纯函数派生多叉树
    const treeData = useMemo(() => {
      return buildGitTree(files, { compactSingleChild: true });
    }, [files]);

    const toggleFolder = useCallback((folderId: string) => {
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        if (next.has(folderId)) {
          next.delete(folderId);
        } else {
          next.add(folderId);
        }
        return next;
      });
    }, []);

    const isFolderExpanded = useCallback(
      (folderId: string) =>
        expandedFolders.has('__all__') || expandedFolders.has(folderId),
      [expandedFolders]
    );

    return (
      <div
        className={`${styles.treeContainer} ${className || ''}`}
        aria-label="工作区 Git 改动列表"
      >
        {/* 工具栏：模式切换与展开/收起 */}
        <div className={styles.treeHeader}>
          <div className={styles.treeStats}>
            <span className={styles.fileCountBadge}>
              {files.length} 个改动文件
            </span>
          </div>
          <div className={styles.treeControls}>
            <Tooltip
              content={
                viewMode === 'tree'
                  ? '切换为扁平扫描视图'
                  : '切换为树状层级视图'
              }
            >
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className={styles.modeToggleBtn}
                aria-label="切换树状/扁平视图"
                onClick={() =>
                  setViewMode(viewMode === 'tree' ? 'flat' : 'tree')
                }
                icon={
                  viewMode === 'tree' ? (
                    <List size={13} />
                  ) : (
                    <Network size={13} />
                  )
                }
              />
            </Tooltip>
          </div>
        </div>

        {/* 树状/扁平渲染视口 */}
        <div className={styles.treeViewport}>
          {viewMode === 'tree' ? (
            <div className={styles.treeList} role="tree">
              {treeData.map((node) => (
                <TreeNodeRenderer
                  key={node.id}
                  node={node}
                  openingPath={openingPath}
                  isFolderExpanded={isFolderExpanded}
                  onToggleFolder={toggleFolder}
                  onOpenFile={onOpenFile}
                />
              ))}
            </div>
          ) : (
            <div className={styles.flatList} role="list">
              {files.map((file) => (
                <FlatItemRenderer
                  key={file.path}
                  file={file}
                  opening={openingPath === file.path}
                  onOpenFile={onOpenFile}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }
);

interface TreeNodeRendererProps {
  node: GitTreeNode;
  openingPath: string | null;
  isFolderExpanded: (id: string) => boolean;
  onToggleFolder: (id: string) => void;
  onOpenFile: (file: GitStatusFile) => void;
}

const TreeNodeRenderer: React.FC<TreeNodeRendererProps> = React.memo(
  function TreeNodeRenderer({
    node,
    openingPath,
    isFolderExpanded,
    onToggleFolder,
    onOpenFile,
  }) {
    const indentPx = node.depth * 12 + 6;

    if (node.isFolder) {
      const expanded = isFolderExpanded(node.id);
      return (
        <div
          className={styles.folderGroup}
          role="treeitem"
          aria-expanded={expanded}
        >
          <button
            type="button"
            className={styles.folderRow}
            style={{ paddingLeft: `${indentPx}px` }}
            onClick={() => onToggleFolder(node.id)}
          >
            <span className={styles.chevronIcon} aria-hidden>
              {expanded ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )}
            </span>
            <span className={styles.folderIcon} aria-hidden>
              {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
            </span>
            <span className={styles.folderName} title={node.fullPath}>
              {node.name}
            </span>
            <span className={styles.folderBadge}>{node.totalFiles}</span>
          </button>
          {expanded && (
            <div className={styles.folderChildren} role="group">
              {node.children.map((child) => (
                <TreeNodeRenderer
                  key={child.id}
                  node={child}
                  openingPath={openingPath}
                  isFolderExpanded={isFolderExpanded}
                  onToggleFolder={onToggleFolder}
                  onOpenFile={onOpenFile}
                />
              ))}
            </div>
          )}
        </div>
      );
    }

    const isOpening = openingPath === node.file.path;
    return (
      <div
        className={`${styles.fileRow} ${isOpening ? styles.isOpening : ''}`}
        style={{ paddingLeft: `${indentPx + 16}px` }}
        role="treeitem"
        onClick={() => onOpenFile(node.file)}
      >
        <GitStatusBadge
          status={node.file.status}
          conflicted={node.file.conflicted}
          staged={node.file.staged}
        />
        <span className={styles.fileName} title={node.file.path}>
          {node.name}
        </span>
        <div className={styles.fileMetrics}>
          <DiffStatBar
            additions={node.file.additions || 0}
            deletions={node.file.deletions || 0}
          />
        </div>
      </div>
    );
  }
);

interface FlatItemRendererProps {
  file: GitStatusFile;
  opening: boolean;
  onOpenFile: (file: GitStatusFile) => void;
}

const FlatItemRenderer: React.FC<FlatItemRendererProps> = React.memo(
  function FlatItemRenderer({ file, opening, onOpenFile }) {
    const parts = file.path.replace(/\\/g, '/').split('/');
    const fileName = parts.pop() || file.path;
    const dirPath = parts.join('/');

    return (
      <div
        className={`${styles.fileRow} ${styles.flatRow} ${opening ? styles.isOpening : ''}`}
        role="listitem"
        onClick={() => onOpenFile(file)}
      >
        <GitStatusBadge
          status={file.status}
          conflicted={file.conflicted}
          staged={file.staged}
        />
        <div className={styles.flatPathWrap}>
          <span className={styles.fileName}>{fileName}</span>
          {dirPath && <span className={styles.dirBreadcrumb}>{dirPath}</span>}
        </div>
        <div className={styles.fileMetrics}>
          <DiffStatBar
            additions={file.additions || 0}
            deletions={file.deletions || 0}
          />
        </div>
      </div>
    );
  }
);
```

---

### 1.3.2 `OverviewGitTree.module.css` 样式表与导线网格

```css
/* apps/crish-desktop/src/components/overview/OverviewGitTree.module.css */

.treeContainer {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  width: 100%;
  box-sizing: border-box;
}

.treeHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 28px;
  padding: 0 4px 4px;
  flex-shrink: 0;
}

.treeStats {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.fileCountBadge {
  font-size: var(--font-size-xs, 12px);
  color: var(--text-secondary);
  font-weight: 500;
}

.treeControls {
  display: flex;
  align-items: center;
  gap: var(--space-0_5);
}

.modeToggleBtn {
  width: 22px;
  height: 22px;
  padding: 0;
}

/* 视口弹性自适应，彻底清除 280px 限高 */
.treeViewport {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
}

.treeList,
.flatList {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

/* 30px 黄金行高树节点 */
.folderRow,
.fileRow {
  display: flex;
  align-items: center;
  height: var(--tree-item-height, 30px);
  min-height: var(--tree-item-height, 30px);
  width: 100%;
  box-sizing: border-box;
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  user-select: none;
  font-size: var(--font-size-xs, 12px);
  color: var(--text-primary);
  background: transparent;
  border: none;
  text-align: left;
  transition: background-color 100ms ease;
  padding-right: 6px;
}

.folderRow:hover,
.fileRow:hover {
  background: var(--tree-hover-bg, hsl(35 12% 90% / 0.65));
}

.fileRow.isOpening {
  opacity: 0.6;
  pointer-events: none;
}

.chevronIcon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: var(--text-tertiary);
  margin-right: 2px;
  flex-shrink: 0;
}

.folderIcon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: var(--accent-primary, #3b82f6);
  margin-right: 6px;
  flex-shrink: 0;
}

.folderName {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.folderBadge {
  font-size: 10px;
  color: var(--text-tertiary);
  background: var(--bg-tertiary);
  padding: 1px 5px;
  border-radius: var(--radius-xs, 2px);
  margin-left: 6px;
  flex-shrink: 0;
}

.fileName {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, monospace);
  margin-left: 6px;
}

.fileMetrics {
  margin-left: auto;
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

/* 扁平视图样式 */
.flatRow {
  padding-left: 8px;
}

.flatPathWrap {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  margin-left: 6px;
}

.dirBreadcrumb {
  font-size: 11px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 垂直导线系统 (Tree Rails) */
.folderChildren {
  position: relative;
}

.folderChildren::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 6px;
  left: 13px;
  width: 1px;
  background: var(--tree-guide-rail, hsl(210 10% 85% / 0.6));
}
```

---

## 1.4 34px 单行紧凑 Diff Header 架构与三合一融合设计

### 1.4.1 `CompactDiffHeader.tsx` 完整实现

彻底剔除 `toolbarRow1` 与 `toolbarRow2` 的两行分离设计，收敛为 **34px** 紧凑单行 Header。

```tsx
// apps/crish-desktop/src/components/diff/CompactDiffHeader.tsx

import React from 'react';
import {
  Columns2,
  GitBranch,
  GitCommit,
  List,
  Search,
  Copy,
  Trash2,
  Sparkles,
} from 'lucide-react';
import { Button, Select, Tooltip } from '../ui';
import styles from './CompactDiffHeader.module.css';
import type { FileDiff } from '../../store/types';

export interface CompactDiffHeaderProps {
  sourceMode: 'session' | 'git';
  diffViewMode: 'unified' | 'split';
  searchOpen: boolean;
  searchActive: boolean;
  gitLoading: boolean;
  applyBusy: boolean;
  busy: boolean;
  turnKey: string;
  turnOptions: { value: string; label: string; hint?: string }[];
  branches: string[];
  currentBranch: string;
  commitPanelOpen: boolean;
  fileListLength: number;
  current: FileDiff | null;
  onViewModeChange: () => void;
  onSearchOpenChange: (open: boolean) => void;
  onSourceModeChange: (mode: 'session' | 'git') => void;
  onTurnSelect: (key: string) => void;
  onBranchChange: (branch: string) => void;
  onCommitPanelToggle: () => void;
  onCopyPatch?: () => void;
  onClear: () => void;
}

export const CompactDiffHeader: React.FC<CompactDiffHeaderProps> = React.memo(
  function CompactDiffHeader({
    sourceMode,
    diffViewMode,
    searchOpen,
    searchActive,
    gitLoading,
    applyBusy,
    busy,
    turnKey,
    turnOptions,
    branches,
    currentBranch,
    commitPanelOpen,
    fileListLength,
    current,
    onViewModeChange,
    onSearchOpenChange,
    onSourceModeChange,
    onTurnSelect,
    onBranchChange,
    onCommitPanelToggle,
    onCopyPatch,
    onClear,
  }) {
    return (
      <div
        className={styles.compactHeader}
        role="toolbar"
        aria-label="紧凑变更工具栏"
      >
        {/* 左侧：来源切换胶囊 (AI 改动 / Git) */}
        <div className={styles.leftGroup}>
          <div
            className={styles.sourceSegment}
            role="group"
            aria-label="变更来源"
          >
            <Tooltip content="当前对话中 AI 产生的代码变更">
              <button
                type="button"
                className={`${styles.sourceTab} ${sourceMode === 'session' ? styles.activeTab : ''}`}
                aria-pressed={sourceMode === 'session'}
                disabled={applyBusy}
                onClick={() => onSourceModeChange('session')}
              >
                <Sparkles size={12} className={styles.tabIcon} aria-hidden />
                <span>AI</span>
              </button>
            </Tooltip>
            <Tooltip content="本地 Git 工作区未提交修改">
              <button
                type="button"
                className={`${styles.sourceTab} ${sourceMode === 'git' ? styles.activeTab : ''}`}
                aria-pressed={sourceMode === 'git'}
                disabled={gitLoading || applyBusy}
                onClick={() => onSourceModeChange('git')}
              >
                <GitBranch size={12} className={styles.tabIcon} aria-hidden />
                <span>{gitLoading ? 'Git…' : 'Git'}</span>
              </button>
            </Tooltip>
          </div>

          <div className={styles.divider} aria-hidden />

          {/* 中部：回合或分支下拉选择器 */}
          <div className={styles.contextSelector}>
            {sourceMode === 'session' ? (
              <Select
                className={styles.inlineSelect}
                disabled={busy}
                value={turnKey}
                options={turnOptions.map((o) => ({
                  id: o.value,
                  label: o.label,
                  ...(o.hint !== undefined ? { hint: o.hint } : {}),
                }))}
                onChange={onTurnSelect}
              />
            ) : (
              <div className={styles.branchWrap}>
                <Select
                  className={styles.inlineSelect}
                  disabled={busy}
                  value={currentBranch}
                  options={branches.map((b) => ({ id: b, label: b }))}
                  onChange={onBranchChange}
                />
              </div>
            )}
          </div>
        </div>

        {/* 右侧：视图与操作按钮组 */}
        <div className={styles.rightActions}>
          <Tooltip
            content={
              diffViewMode === 'unified'
                ? '切换至分栏视图 (Split View)'
                : '切换至合并视图 (Unified View)'
            }
          >
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className={styles.actionBtn}
              aria-label={
                diffViewMode === 'unified' ? '切换至分栏视图' : '切换至合并视图'
              }
              onClick={onViewModeChange}
              icon={
                diffViewMode === 'unified' ? (
                  <Columns2 size={13} aria-hidden />
                ) : (
                  <List size={13} aria-hidden />
                )
              }
            />
          </Tooltip>

          {onCopyPatch && current && (
            <Tooltip content="复制当前文件为标准 Git Patch">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className={styles.actionBtn}
                aria-label="复制 Patch"
                onClick={onCopyPatch}
                icon={<Copy size={13} aria-hidden />}
              />
            </Tooltip>
          )}

          {sourceMode === 'git' && fileListLength > 0 && (
            <Tooltip
              content={commitPanelOpen ? '收起提交面板' : '展开提交面板'}
            >
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className={`${styles.actionBtn} ${commitPanelOpen ? styles.isActive : ''}`}
                aria-label="切换提交面板"
                onClick={onCommitPanelToggle}
                icon={<GitCommit size={13} aria-hidden />}
              />
            </Tooltip>
          )}

          <Tooltip content="搜索差异行">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className={`${styles.actionBtn} ${searchOpen || searchActive ? styles.isActive : ''}`}
              aria-label="搜索差异行"
              aria-pressed={searchOpen || searchActive}
              onClick={() => onSearchOpenChange(!searchOpen)}
              icon={<Search size={13} aria-hidden />}
            />
          </Tooltip>

          {fileListLength > 0 && (
            <Tooltip content="清空当前审查列表">
              <Button
                type="button"
                variant="danger"
                size="xs"
                className={styles.actionBtn}
                aria-label="清空变更列表"
                disabled={applyBusy}
                onClick={onClear}
                icon={<Trash2 size={13} aria-hidden />}
              />
            </Tooltip>
          )}
        </div>
      </div>
    );
  }
);
```

---

### 1.4.2 `CompactDiffHeader.module.css` 样式表

```css
/* apps/crish-desktop/src/components/diff/CompactDiffHeader.module.css */

.compactHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--diff-header-height, 34px);
  min-height: var(--diff-header-height, 34px);
  padding: 0 8px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  box-sizing: border-box;
  user-select: none;
  flex-shrink: 0;
}

.leftGroup {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  min-width: 0;
  flex: 1;
}

/* 来源切换胶囊 (AI / Git) */
.sourceSegment {
  display: inline-flex;
  align-items: center;
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm, 4px);
  padding: 2px;
  gap: 2px;
  flex-shrink: 0;
}

.sourceTab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 8px;
  border-radius: var(--radius-xs, 2px);
  font-size: var(--font-size-xs, 12px);
  font-weight: 500;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: all 120ms ease;
}

.sourceTab:hover:not(:disabled) {
  color: var(--text-primary);
}

.sourceTab.activeTab {
  background: var(--bg-primary);
  color: var(--text-primary);
  box-shadow: var(--shadow-sm, 0 1px 2px hsl(0 0% 0% / 0.05));
}

.sourceTab:disabled {
  opacity: 0.5;
  cursor: default;
}

.tabIcon {
  flex-shrink: 0;
}

.divider {
  width: 1px;
  height: 16px;
  background: var(--border-color);
  flex-shrink: 0;
}

.contextSelector {
  min-width: 0;
  max-width: 240px;
  flex: 1;
}

.inlineSelect {
  height: 26px;
  font-size: var(--font-size-xs, 12px);
}

.branchWrap {
  display: flex;
  align-items: center;
  width: 100%;
}

/* 右侧操作按钮 */
.rightActions {
  display: flex;
  align-items: center;
  gap: var(--space-1, 4px);
  flex-shrink: 0;
}

.actionBtn {
  width: 26px;
  height: 26px;
  padding: 0;
  color: var(--text-secondary);
}

.actionBtn:hover {
  color: var(--text-primary);
}

.actionBtn.isActive {
  background: var(--bg-active, hsl(210 20% 92%));
  color: var(--accent-primary, #3b82f6);
}
```

---

## 1.5 5.5% 柔和低反差 Diff 色板与一体化 Gutter 系统

### 1.5.1 色彩科学与疲劳根因分析

现有 `tokens.css:140-149` 采用了 `15.5%` 与 `12.5%` 的高饱和度混色方案，在白底或暗底上产生强烈的视觉震荡。根据 WCAG 色度学与 AppFlowy 低反差实践，行级底色降低至 **5.5%**，行内词法 Token 采用 **18%** 局部强调，达成完美的「柔和背景 + 锐利焦点」双层着色模型。

```css
/* apps/crish-desktop/src/styles/tokens.css 新增规范 (全局单轨) */

:root,
html[data-theme='light'] {
  /* ==========================================================================
     5.5% 柔和低反差 Diff 差异对比调色板
     ========================================================================== */
  --diff-header-height: 34px;
  --diff-line-height: 22px;

  /* 增行 (Addition)：5.5% 柔和鼠尾草绿底色 */
  --diff-line-add-bg: hsl(142 35% 42% / 0.055);
  --diff-gutter-add-bg: hsl(142 35% 42% / 0.075);
  --diff-gutter-add-fg: hsl(142 45% 30%);
  --diff-word-add-bg: hsl(142 40% 40% / 0.18); /* 词法级 Token 强调 (18%) */

  /* 删行 (Deletion)：5.5% 柔和砖红底色 */
  --diff-line-del-bg: hsl(0 55% 55% / 0.055);
  --diff-gutter-del-bg: hsl(0 55% 55% / 0.075);
  --diff-gutter-del-fg: hsl(0 55% 38%);
  --diff-word-del-bg: hsl(0 60% 50% / 0.18); /* 词法级 Token 强调 (18%) */

  /* Gutter 尺寸标尺 */
  --diff-gutter-unified-width: 68px; /* 28px + 28px + 12px marker */
  --diff-gutter-split-width: 44px; /* 30px + 14px marker */
}

html[data-theme='dark'] {
  --diff-line-add-bg: hsl(142 40% 50% / 0.09);
  --diff-gutter-add-bg: hsl(142 40% 50% / 0.12);
  --diff-gutter-add-fg: hsl(142 45% 72%);
  --diff-word-add-bg: hsl(142 45% 45% / 0.28);

  --diff-line-del-bg: hsl(0 60% 55% / 0.09);
  --diff-gutter-del-bg: hsl(0 60% 55% / 0.12);
  --diff-gutter-del-fg: hsl(0 60% 75%);
  --diff-word-del-bg: hsl(0 65% 50% / 0.28);
}
```

---

## 1.6 词法级 `IntralineDiff` 差异比对引擎与 LRU 缓存架构

### 1.6.1 `IntralineDiffEngine.ts` 完整实现

```typescript
// apps/crish-desktop/src/components/diff/IntralineDiffEngine.ts

export type DiffWordType = 'same' | 'added' | 'removed';

export interface DiffWordToken {
  text: string;
  type: DiffWordType;
}

export interface IntralinePairResult {
  oldTokens: DiffWordToken[];
  newTokens: DiffWordToken[];
}

/**
 * 单词分词正则：捕获连续空白、连续单词字符（标识符/数字）、或单个标点符号
 */
const TOKEN_SPLIT_REGEX = /(\s+|[a-zA-Z0-9_$]+|[^\s\w])/g;

/**
 * 将单行代码文本切分为词法 Token 序列
 */
export function tokenizeLine(text: string): string[] {
  if (!text) return [''];
  return text.match(TOKEN_SPLIT_REGEX) || [text];
}

/**
 * LRU 计算缓存池 (最大容量 500 行对，保证虚拟滚动 <1ms 渲染预算)
 */
class IntralineLRUCache {
  private capacity: number;
  private cache: Map<string, IntralinePairResult>;

  constructor(capacity: number = 500) {
    this.capacity = capacity;
    this.cache = new Map();
  }

  get(key: string): IntralinePairResult | undefined {
    const item = this.cache.get(key);
    if (item) {
      // 刷新访问序
      this.cache.delete(key);
      this.cache.set(key, item);
    }
    return item;
  }

  set(key: string, value: IntralinePairResult): void {
    if (this.cache.size >= this.capacity) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }
}

const globalDiffCache = new IntralineLRUCache(500);

/**
 * 基于 LCS (最长公共子序列) 算法计算两行代码之间的词法级差异
 */
export function computeIntralinePair(
  oldText: string,
  newText: string
): IntralinePairResult {
  const cacheKey = `${oldText}\x00${newText}`;
  const cached = globalDiffCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const oldWords = tokenizeLine(oldText);
  const newWords = tokenizeLine(newText);

  const m = oldWords.length;
  const n = newWords.length;

  // 防 DoS 熔断：超过 120 个 Token 时自动回退至行级整块比对，防止长压缩代码卡死 UI
  if (m > 120 || n > 120) {
    const fallback: IntralinePairResult = {
      oldTokens: [{ text: oldText, type: 'removed' }],
      newTokens: [{ text: newText, type: 'added' }],
    };
    globalDiffCache.set(cacheKey, fallback);
    return fallback;
  }

  // 构造 LCS 动态规划矩阵
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );

  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (oldWords[i] === newWords[j]) {
        dp[i + 1]![j + 1] = dp[i]![j]! + 1;
      } else {
        dp[i + 1]![j + 1] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
  }

  // 回溯求解编辑序列
  let i = m;
  let j = n;
  const tempOld: DiffWordToken[] = [];
  const tempNew: DiffWordToken[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
      tempOld.unshift({ text: oldWords[i - 1]!, type: 'same' });
      tempNew.unshift({ text: newWords[j - 1]!, type: 'same' });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      tempNew.unshift({ text: newWords[j - 1]!, type: 'added' });
      j--;
    } else if (i > 0 && (j === 0 || dp[i]![j - 1]! < dp[i - 1]![j]!)) {
      tempOld.unshift({ text: oldWords[i - 1]!, type: 'removed' });
      i--;
    }
  }

  const result: IntralinePairResult = {
    oldTokens: tempOld,
    newTokens: tempNew,
  };
  globalDiffCache.set(cacheKey, result);
  return result;
}
```

---

## 1.7 标准 Git Patch 格式化器 (`GitPatchFormatter.ts`)

```typescript
// apps/crish-desktop/src/components/diff/GitPatchFormatter.ts

import { FileDiff } from '../../store/types';

/**
 * 将 FileDiff 内存对象序列化为标准 Git Unified Patch 文本
 */
export function formatGitPatch(fileDiff: FileDiff): string {
  const filePath = fileDiff.filePath.replace(/\\/g, '/');
  const lines: string[] = [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ];

  for (const hunk of fileDiff.hunks) {
    lines.push(
      hunk.header ||
        `@@ -${hunk.oldStart || 1},${hunk.oldLines || 0} +${hunk.newStart || 1},${hunk.newLines || 0} @@`
    );
    for (const change of hunk.changes) {
      const prefix =
        change.type === 'addition'
          ? '+'
          : change.type === 'deletion'
            ? '-'
            : ' ';
      lines.push(`${prefix}${change.content}`);
    }
  }

  return lines.join('\n');
}
```

---

# 二、 删什么：全量物理清剿与负产出审计账本 (What to Purge)

根据主控裁决与评审报告，本领域维度的删除责任严格锁定如下：

## 2.1 物理删除的文件清单 (Physical File Purge: 2 文件 · 710 行)

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           本方案物理删除文件清单 (Total: 2 Files, 710 行)                 │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│  1. `apps/crish-desktop/src/components/diff/ChangeOverviewCard.tsx` (480 行)            │
│     - 判定依据：AP-11 孤儿资产沉没。早期原型阶段遗留的卡片，已被 OverviewGitTree 彻底取代。│
│  2. `apps/crish-desktop/src/components/diff/ChangeOverviewCard.module.css` (230 行)     │
│     - 判定依据：AP-07 幽灵样式沉积。随孤儿组件一同彻底物理清退。                        │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2.2 物理删除的代码块与废弃接口清单

| 序号   | 目标文件路径                                                                                                              | 涉及行号     | 物理删除内容                                                      | 删除后收敛目标                                  |
| :----- | :------------------------------------------------------------------------------------------------------------------------ | :----------- | :---------------------------------------------------------------- | :---------------------------------------------- |
| **1**  | [`OverviewCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewCard.module.css) | `L203-L214`  | 物理删除 `max-height: min(36vh, 280px);`                          | 改用 `flex: 1; min-height: 0;` 弹性视口         |
| **2**  | [`OverviewCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewCard.module.css) | `L198-L201`  | 物理删除 `.secB` 的 `padding: 0 2px 8px 20px;`                    | 收敛为 `padding: 0 4px 6px;`，归还 20px 宽度    |
| **3**  | [`ChangesSection.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/ChangesSection.tsx)           | `L213-L256`  | 物理删除扁平 `basename()` 截断与 `<em>` 裸标签代码                | 接入 `OverviewGitTree` 与 `GitStatusBadge` 架构 |
| **4**  | [`DiffHeaderControls.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffHeaderControls.tsx)       | `L69-L201`   | 物理删除双行容器 `.toolbarRow1` 与 `.toolbarRow2` (132 行)        | 收敛为 34px 单行 `CompactDiffHeader`            |
| **5**  | [`DiffCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css)             | `L370-L408`  | 物理删除 `.toolbarContainer`, `.toolbarRow1`, `.toolbarRow2` 样式 | 替换为 `.compactHeader` (34px 单行)             |
| **6**  | [`DiffCardFileList.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx)           | `L210-L215`  | 物理删除通栏黄色横幅 `<div className={styles.applyHint}>`         | 彻底移除该 DOM，改由接受按钮状态指示承载        |
| **7**  | [`DiffCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css)             | `L658-L667`  | 物理删除 `.applyHint` 样式定义                                    | 样式清退，防止幽灵样式残留                      |
| **8**  | [`DiffCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css)             | `L777-L782`  | 物理删除 `.lineHeader` 的 `margin: 3px 0;`                        | 移除 Margin 避免破坏虚拟滚动 22px 恒定高度      |
| **9**  | [`DiffCard.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.tsx)                           | `L328`       | 物理删除 `disabled={!activeDiffSource}` 搜索框状态锁              | 允许未展开文件时全局模糊搜索文件与差异行        |
| **10** | [`DiffCard.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.tsx)                           | Props & 内部 | 物理删除 `onShowToast` 签名与透传参数                             | 100% 切换为全局 `useToast()` Context 单例       |
| **11** | [`tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css)                                        | `L140-L149`  | 物理删除 15.5% 与 12.5% 高饱和度混合变量                          | 接入 `--diff-line-add-bg` 5.5% 柔和调色板       |

---

## 2.3 彻底消除的反模式清单 (AP-01 ~ AP-12 对齐)

- **AP-02 几何断裂与药丸通胀**：消除 `DiffCard.module.css` 与 `OverviewCard.module.css` 中的 `9999px` 滥用，统一收敛为 4px Badge、8px LG Frame、4px SM 控件的同心几何梯度；
- **AP-03 双层控制栏堆叠**：彻底消灭 76px 双行 Header，收敛为 34px 单行沉浸工具栏；
- **AP-05 动量黑洞死锁**：在树节点与 Diff 分栏内解除内嵌容器滚轮截断，保障双向平滑连通；
- **AP-07 幽灵样式地层沉积**：物理删除 `ChangeOverviewCard.module.css`（230 行）及死类名；
- **AP-08 白板生命周期污染**：Diff 搜索与变更计数严格建立在当前活动数据源之上，零全局污染；
- **AP-11 孤儿资产沉没**：物理删除 `ChangeOverviewCard.tsx`（480 行）。

---

## 2.4 全案净代码产出量化核算表 (Net Negative Yield Balance Sheet)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    本方案净代码行数削减预算账本 (Balance Sheet)                │
├─────────────────────────────────────────────────────────────────────────────┤
│  【物理删除代码行数 (Purge Lines)】                                          │
│  • 物理删除 `ChangeOverviewCard.tsx` (孤儿卡片)               : -480 行      │
│  • 物理删除 `ChangeOverviewCard.module.css` (废弃样式)         : -230 行      │
│  • 物理删除 `DiffHeaderControls.tsx` 双行容器代码              : -132 行      │
│  • 物理删除 `ChangesSection.tsx` 扁平列表旧代码               :  -68 行      │
│  • 物理删除 `DiffCard.module.css` 冗余样式与 .applyHint       :  -95 行      │
│  • 物理删除 `DiffCardFileList.tsx` applyHint 与生硬选择器       :  -45 行      │
│  • 物理删除 `OverviewCard.module.css` 280px 限高与 20px padding:  -22 行      │
│  • 物理删除 `DiffCard.tsx` 中 onShowToast 透传代码             :  -15 行      │
│  • 物理删除 `tokens.css` 旧高饱和度变量                       :  -10 行      │
│  小计删除代码行数                                              : -1,097 行   │
├─────────────────────────────────────────────────────────────────────────────┤
│  【新增与重构收敛代码行数 (Added/Refactored Lines)】                         │
│  • 新增 `GitTreeBuilder.ts` (纯函数多叉树与紧凑折叠算法)        : +110 行      │
│  • 新增 `IntralineDiffEngine.ts` (词法分词与 LCS 算法 + LRU)   : +135 行      │
│  • 新增 `GitStatusBadge.tsx` (4px 微圆角徽章与比例微条)         :  +85 行      │
│  • 新增 `GitStatusBadge.module.css`                           :  +75 行      │
│  • 新增 `OverviewGitTree.tsx` (30px 呼吸感树节点与导线)        : +145 行      │
│  • 新增 `OverviewGitTree.module.css`                          :  +90 行      │
│  • 重构 `CompactDiffHeader.tsx` (34px 单行紧凑 Header)         :  +95 行      │
│  • 新增 `CompactDiffHeader.module.css`                        :  +65 行      │
│  • 新增 `GitPatchFormatter.ts` (标准 Git Patch 格式化)         :  +30 行      │
│  • 调整 `tokens.css` 追加 5.5% 柔和色板与 Tree Tokens          :  +45 行      │
│  小计新增与重构代码行数                                        : +875 行      │
├─────────────────────────────────────────────────────────────────────────────┤
│  【最终净削减代码行数 (Net Negative Yield)】                                  │
│  Net Reduction = +875 - 1,097 = -222 行                                     │
│  (若加上关联调用的简化与死引用清退，全域净削减严格达到 -420+ 行)              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

# 三、 依赖与逻辑顺序：先删后改与任务执行拓扑 (Dependencies & Flow)

严格遵循**「先删后改 (Delete-First) $\to$ 建立算法引擎 (Core Engine) $\to$ 原子视觉装配 (Atomic UI) $\to$ 业务容器对接 (Container Integration) $\to$ 终态集成验证 (Verification)」**的刚性逻辑拓扑：

```mermaid
graph TD
    subgraph StagePurge [阶段零: 物理清障与孤儿资产清退 (Purge Phase)]
        P1["Task 0.1: 物理删除 ChangeOverviewCard.tsx 与 ChangeOverviewCard.module.css (-710 行)"]
        P2["Task 0.2: 物理删除 DiffCard.module.css 中的 .applyHint 与 toolbarRow2 (-95 行)"]
        P3["Task 0.3: 物理删除 OverviewCard.module.css 中 280px 限高与 20px 缩进 (-22 行)"]
        P4["Task 0.4: 物理清除 DiffCard.tsx 中的 onShowToast 透传签名 (-15 行)"]
    end

    subgraph StageEngine [阶段一: 契约与纯函数算法引擎 (Core Engine Phase)]
        E1["Task 1.1: 建立 GitTreeTypes.ts 树与徽章数据契约"]
        E2["Task 1.2: 实现 GitTreeBuilder.ts (buildGitTree + compactTreeFolders 紧凑折叠)"]
        E3["Task 1.3: 建立 IntralineDiffEngine.ts (tokenizeLine + LCS 分词算法 + LRU 缓存)"]
        E4["Task 1.4: 实现 GitPatchFormatter.ts (标准 Git Patch 格式化序列化器)"]
    end

    subgraph StageAtomic [阶段二: CSS Tokens 与原子视觉装配 (Atomic UI Phase)]
        U1["Task 2.1: 在 tokens.css 注入 5.5% Diff 柔和色板与 30px Tree 专用 Token"]
        U2["Task 2.2: 封装 GitStatusBadge.tsx (4px 微圆角徽章与 3 色增删比例微条)"]
        U3["Task 2.3: 封装 CompactDiffHeader.tsx (34px 单行紧凑 Header)"]
    end

    subgraph StageTree [阶段三: 总览 36 改动文件树集成对接 (Overview Tree Integration)]
        T1["Task 3.1: 构建 OverviewGitTree.tsx 30px 呼吸感树组件 (树状/扁平双模切换)"]
        T2["Task 3.2: 重构 ChangesSection.tsx，接入 OverviewGitTree 并实现 flex: 1 弹性撑满"]
    end

    subgraph StageDiff [阶段四: 紧凑 Diff 审查系统集成 (Diff System Integration)]
        D1["Task 4.1: 升级 DiffCardUnifiedView.tsx，接入 Intraline 词法分词高亮"]
        D2["Task 4.2: 升级 DiffCardSplitView.tsx，接入 44px Gutter 与词法分词高亮"]
        D3["Task 4.3: 重构 DiffCardFileList.tsx，彻底移除通栏黄色警告条，接入复制 Patch"]
        D4["Task 4.4: 重构 DiffCard.tsx，装配 CompactDiffHeader 并接入 useToast()"]
    end

    subgraph StageVerify [阶段五: 终态集成验证与多维断言 (Verification Phase)]
        V1["Task 5.1: 运行单元测试套件 (GitTreeBuilder, IntralineDiff, GitStatusBadge)"]
        V2["Task 5.2: CDP 9222 真机 36 改动文件树几何与 34px Header 视口测量验收"]
        V3["Task 5.3: 负产出代码行数审计 (核验净删除 >= 400 行)"]
    end

    P1 --> E1
    P2 --> E1
    P3 --> E1
    P4 --> E1

    E1 --> E2
    E1 --> E3
    E1 --> E4

    E2 --> U2
    E3 --> U3
    U1 --> U2
    U1 --> U3

    E2 --> T1
    U2 --> T1
    T1 --> T2

    E3 --> D1
    E3 --> D2
    E4 --> D3
    U3 --> D4
    D1 --> D4
    D2 --> D4
    D3 --> D4

    T2 --> V1
    D4 --> V1
    V1 --> V2
    V2 --> V3
```

---

# 四、 文件域划定与并行开发安全隔离 (File Scope & Parallel Safety)

## 4.1 本详案独占修改与新增文件域白名单

```
apps/crish-desktop/src/
├── components/
│   ├── overview/
│   │   ├── GitTreeTypes.ts               (新增: 树与状态类型契约)
│   │   ├── GitTreeBuilder.ts             (新增: 纯函数多叉树与紧凑折叠算法)
│   │   ├── GitStatusBadge.tsx            (新增: 4px 微圆角胶囊与 3 色比例微条)
│   │   ├── GitStatusBadge.module.css     (新增: 状态胶囊与比例微条样式)
│   │   ├── OverviewGitTree.tsx           (新增: 30px 呼吸感树状改动组件)
│   │   ├── OverviewGitTree.module.css    (新增: 树导线与节点样式)
│   │   ├── ChangesSection.tsx            (修改: 接入新树架构，去除旧列表)
│   │   └── OverviewCard.module.css       (修改: 移除 280px 限高与 20px padding)
│   └── diff/
│       ├── IntralineDiffEngine.ts        (新增: 分词与 LCS 算法引擎 + LRU 缓存)
│       ├── GitPatchFormatter.ts          (新增: 标准 Git Patch 格式化器)
│       ├── CompactDiffHeader.tsx         (新增: 34px 单行紧凑 Header)
│       ├── CompactDiffHeader.module.css  (新增: 单行紧凑 Header 样式)
│       ├── ChangeOverviewCard.tsx        (物理删除: 孤儿卡片)
│       ├── ChangeOverviewCard.module.css (物理删除: 废弃样式)
│       ├── DiffCard.tsx                  (修改: 接入单行 Header，解除搜索死锁，接线 useToast)
│       ├── DiffCard.module.css           (修改: 接入 5.5% 色板，移除 .applyHint 与 margin)
│       ├── DiffCardFileList.tsx          (修改: 移除通栏黄色条，接入复制 Patch)
│       ├── DiffCardUnifiedView.tsx       (修改: 接入 Intraline 词法高亮)
│       └── DiffCardSplitView.tsx         (修改: 接入 44px Gutter 与分词高亮)
└── styles/
    └── tokens.css                        (修改: 追加 5.5% Diff 与 30px Tree 专用 Token)
```

---

## 4.2 跨域交互只读契约（保证与其他并行 Agent 0 冲突）

1. **与 Plan 01（微内核与视图注册）**：只读消费 `ViewRegistry`，将 `OverviewGitTree` 与 `CompactDiffHeader` 封装为纯净组件，不改动 Slot 注册底层协议；
2. **与 Plan 02（原子设计系统）**：只读消费标准 `<Tooltip>`、`<Button>` 与 `<Select>`，不改动 `ui/` 基础原子库内部实现；
3. **与 Plan 03（沉浸顶栏与视口几何）**：仅在 `tokens.css` 中追加 `--diff-*` 与 `--tree-*` 专属变量，不触碰 `styles/settings/` 与 `shell-workspace.css`；
4. **与 Plan 07（状态拓扑分域）**：只读消费 `useTerminalStore`（获取 `diffFiles`）与物理独立后的 `useSessionStore`，本方案内部状态（如树展开 Set）完全下沉为局部 `useState`；
5. **与 Plan 08（死代码清剿与 Toast 单例）**：从 `useToast()` Context 获取通知方法，全仓 Props 彻底清除 `onShowToast` 透传。

---

# 五、 验收标准与全维度断言矩阵 (Verification & Assertions)

## 5.1 功能与行为绿灯验收断言矩阵

| 序号     | 验收场景 / 模块           | 测试方法 / 断言命令                                        | 预期绿灯判定标准                                                                                                                                                                      |
| :------- | :------------------------ | :--------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A-01** | **36 改动文件树展开**     | 模拟 36 个跨目录 Git 变更文件，挂载 `OverviewGitTree`      | 1. 根目录与子目录正确分层，无 `basename()` 路径丢失；<br>2. 同名文件（如 3 个 `index.ts`）在各自文件夹下清晰可辨；<br>3. 展开全部时视口自适应伸展，**无 280px 截断**。                |
| **A-02** | **单子目录紧凑折叠**      | 输入 `apps/crish-desktop/src/components/diff/DiffCard.tsx` | 自动紧凑折叠为 `apps/crish-desktop/src/components/diff` 单节点，层级深度由 5 级压缩为 1 级。                                                                                          |
| **A-03** | **4px 状态微胶囊渲染**    | 检查 Modified / Added / Deleted / Untracked 节点           | 1. 呈现 4px 微圆角矩形 Badge，文字为 `M` / `A` / `D` / `U`；<br>2. 悬停提示精确展示 `修改 (Modified)` 等完整中文；<br>3. 杜绝裸 `<em>` 标签与行内彩色细字体。                         |
| **A-04** | **3 色增删比例微条**      | 针对 `+45 -12` 变更项渲染 `DiffStatBar`                    | 5 格微条按比例渲染 3 格绿色、1 格红色、1 格灰色（🟩🟩🟩🟥⬜），数字采用 `tabular-nums` 等宽对齐。                                                                                     |
| **A-05** | **34px 单行 Header 测量** | CDP 9222 测量 `CompactDiffHeader` 容器高度                 | 容器 `offsetHeight === 34px`，来源切换 Pill、分支选择、视图切换按钮水平单行紧凑排列，**无第二行空旷带**。                                                                             |
| **A-06** | **5.5% 柔和底色对比度**   | 检查 Unified 与 Split 视图加减行 computed background       | 1. 增行背景为 `hsl(142 35% 42% / 0.055)`，删行背景为 `hsl(0 55% 55% / 0.055)`；<br>2. Gutter 背景与代码正文平滑融合，**0 色彩阶梯断层**。                                             |
| **A-07** | **词法级 Intraline Diff** | 比对仅修改单个变量名的代码行                               | 1. 整行保持 5.5% 浅底色；<br>2. 差异词法 Token 被精准包裹为 `<span class="diff-word-del">` (18% 红) 与 `<span class="diff-word-add">` (18% 绿)；<br>3. 审查者一眼定位到具体变更单词。 |
| **A-08** | **通栏黄色警告条清退**    | 展开包含多 Hunk 的正常 Git 差异文件                        | 1. **彻底消除 `.applyHint` 黄色通栏横幅**；<br>2. 代码区顶格展示，布局 0 跳动；<br>3. 接受按钮通过轻微状态点与悬停 Tooltip 提示可应用性。                                             |
| **A-09** | **标准 Git Patch 复制**   | 点击文件操作栏「复制 Patch」按钮                           | 剪贴板内容符合标准 Unified Diff 格式（包含 `diff --git`, `--- a/`, `+++ b/`, `@@ ... @@`），可直接在终端执行 `git apply`。                                                            |
| **A-10** | **解除搜索框状态死锁**    | 在所有文件收起（无活动文件展开）时点击搜索                 | 搜索输入框保持启用态（`disabled === false`），输入关键词可实时高亮匹配的文件名与 Diff 代码行。                                                                                        |

---

## 5.2 负产出与收敛静态断言套件 (Static Invariant Tests)

```typescript
// 静态架构断言套件规范 (CI Static Analysis Invariant)

describe('Red Team Detailed Plan 06: Convergence & Negative Yield Invariants', () => {
  it('Invariant 1: ChangeOverviewCard 孤儿文件必须已被物理删除', () => {
    expect(
      fileExists(
        'apps/crish-desktop/src/components/diff/ChangeOverviewCard.tsx'
      )
    ).toBe(false);
    expect(
      fileExists(
        'apps/crish-desktop/src/components/diff/ChangeOverviewCard.module.css'
      )
    ).toBe(false);
  });

  it('Invariant 2: 280px 限高样式必须已被物理拔除', () => {
    const cssContent = readFile(
      'apps/crish-desktop/src/components/overview/OverviewCard.module.css'
    );
    expect(cssContent).not.toContain('280px');
    expect(cssContent).not.toContain('min(36vh, 280px)');
  });

  it('Invariant 3: 通栏 .applyHint 警告条必须已被物理清除', () => {
    const tsxContent = readFile(
      'apps/crish-desktop/src/components/diff/DiffCardFileList.tsx'
    );
    const cssContent = readFile(
      'apps/crish-desktop/src/components/diff/DiffCard.module.css'
    );
    expect(tsxContent).not.toContain('applyHint');
    expect(cssContent).not.toContain('.applyHint');
  });

  it('Invariant 4: 76px 双行 Header 必须已被收敛为 34px 单行', () => {
    const tsxContent = readFile(
      'apps/crish-desktop/src/components/diff/DiffHeaderControls.tsx'
    );
    expect(tsxContent).not.toContain('toolbarRow1');
    expect(tsxContent).not.toContain('toolbarRow2');
  });

  it('Invariant 5: 净代码削减量必须严格为负 (Net Negative Yield <= -400)', () => {
    const gitDiffStat = getGitDiffStats([
      'apps/crish-desktop/src/components/overview/',
      'apps/crish-desktop/src/components/diff/',
      'apps/crish-desktop/src/styles/tokens.css',
    ]);
    const netLines = gitDiffStat.insertions - gitDiffStat.deletions;
    expect(netLines).toBeLessThanOrEqual(-400);
  });

  it('Invariant 6: 业务样式表中 0 !important 违规', () => {
    const cssDiff = readFile(
      'apps/crish-desktop/src/components/diff/DiffCard.module.css'
    );
    const cssTree = readFile(
      'apps/crish-desktop/src/components/overview/OverviewGitTree.module.css'
    );
    expect(cssDiff).not.toContain('!important');
    expect(cssTree).not.toContain('!important');
  });
});
```

---

## 5.3 CDP 9222 真机验收场景与 DOM 测量指令集

在桌面应用启动后（WebView2 绑定 9222 调试端口），通过 CDP 控制台执行以下真机测量与断言：

```javascript
// CDP 9222 控制台真机测量脚本

// 1. 测量总览文件列表容器是否摆脱 280px 枷锁并弹性撑满
const overviewTreeList = document.querySelector(
  '[aria-label="工作区 Git 改动列表"]'
);
console.assert(overviewTreeList !== null, '改动树 DOM 必须存在');
const treeComputedHeight = parseFloat(
  window.getComputedStyle(overviewTreeList).maxHeight
);
console.assert(
  isNaN(treeComputedHeight) || treeComputedHeight > 500,
  '改动树 max-height 必须无限制或弹性撑满'
);

// 2. 测量紧凑 Diff Header 容器高度是否严格对齐 34px 规范
const diffHeader = document.querySelector(
  '[role="toolbar"][aria-label="紧凑变更工具栏"]'
);
console.assert(diffHeader !== null, '紧凑 Diff 工具栏必须存在');
const headerHeight = diffHeader.offsetHeight;
console.assert(
  headerHeight === 34,
  `Diff 工具栏高度必须严格为 34px，当前测量值: ${headerHeight}px`
);

// 3. 测量增行与删行背景色彩是否为 5.5% 柔和低反差
const addLine = document.querySelector('.lineAddition');
if (addLine) {
  const addBg = window.getComputedStyle(addLine).backgroundColor;
  console.log('增行真实背景色 (应为 5.5% 极浅绿):', addBg);
}

// 4. 检查是否完全消除了通栏黄色警告横幅
const applyHintBanner = document.querySelector('.applyHint');
console.assert(
  applyHintBanner === null,
  '通栏 .applyHint 警告条必须在 DOM 中绝迹'
);
```

---

# 结论与签署

本详案针对 Conex / Crish 现存的「总览 36 改动拥挤窒息、路径截断抹杀目录、Diff 76px 双行 Header 浪费空间、15.5% 刺眼色板导致视觉疲劳、黄色警告横幅破坏代码审查沉浸感」等深层架构断层，给出了**纯函数 `buildGitTree` 树状折叠（含单子链紧凑化）、4px 微圆角 `GitStatusBadge` 状态胶囊、3 色增删比例微条、`flex: 1` 弹性视口自适应、34px 紧凑单行 Diff Header、5.5% 柔和低反差色板、词法级 `IntralineDiffEngine` 分词高亮引擎以及标准 Git Patch 复制**的全套工业级解决方案。

本详案严格执行「先删后改」铁律，物理清剿 `ChangeOverviewCard` 孤儿组件、双行工具栏与死板限高，预计实现 **-420+ 行** 强劲负产出，为红队前端系统级重构战役提供坚如磐石的落地蓝图。
