# 文件名超链接单轨接线独立文件预览面板实施方案 (PLAN-03)

> **专项方案编号**：PLAN-03
> **战役名称**：差异面板与笔记面板系统性重构 —— 阶段二：独立方案设计
> **任务标题**：文件名超链接单轨接线至右侧独立文件预览面板 (FileViewerCard) 独立方案
> **输入依赖**：[`docs/diff-view-redesign/analysis/03-file-viewer-tab-integration-audit.md`](file:///c:/Software/conex/docs/diff-view-redesign/analysis/03-file-viewer-tab-integration-audit.md)
> **产出落盘路径**：`docs/diff-view-redesign/independent-plans/03-file-viewer-integration-plan.md`
> **方案状态**：设计锁定（待主控评审与实施执行）
> **关联核心文件**：
> - [`apps/crish-desktop/src/components/diff/DiffCardFileList.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx)（头部行 DOM 正交解耦与文件名超链接改造）
> - [`apps/crish-desktop/src/components/diff/DiffCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css)（超链接与折叠指示器样式 Tokens 契约）
> - [`apps/crish-desktop/src/store/workspace-shell/openTool.ts`](file:///c:/Software/conex/apps/crish-desktop/src/store/workspace-shell/openTool.ts)（`openFileViewerInSession` 修复与路径归一化）
> - [`apps/crish-desktop/src/store/storeAccess.ts`](file:///c:/Software/conex/apps/crish-desktop/src/store/storeAccess.ts)（统一动作/读面导出守门）
> - [`apps/crish-desktop/src/components/files/FileViewerCard.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FileViewerCard.tsx)（独立文件预览宿主与全规格工具栏）
> - [`apps/crish-desktop/src/services/view-registry/ViewRegistry.ts`](file:///c:/Software/conex/apps/crish-desktop/src/services/view-registry/ViewRegistry.ts)（`file-viewer:` 动态 URI 解析）

---

## 1. 方案目标与单轨真理路径架构（SSOT）

### 1.1 背景与用户核心指示

在前期深度代码审计（AUDIT-03）中查明：
1. 系统右侧工具坞（`RightToolDock` / `LeafToolTabStrip`）中内置的独立文件预览面板 [`FileViewerCard.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FileViewerCard.tsx) 具备极其专业且成熟的头部工具栏（宿主外部 IDE 下拉选择、复制代码、复制绝对路径、操作系统资源管理器高亮、应用文件树定位、模式切换）与大文件虚拟滚动源码着色渲染能力；
2. 但在 `DiffCardFileList.tsx:142-160` 中，文件名节点被错误包裹在整个展开折叠按钮内部，点击只会展开表内 Diff 代码，无法在右侧打开独立预览面板；
3. 用户明确要求：
   > *“点击差异的那个超链接是直接打开一个新的标签，名称就是对应的文件名称，也是有一个顶部的工具栏，下面主区域就是这个文件的预览了...系统性做，先考虑架构。以及避免双轨或者多轨、硬编码、功能伪实现、伪连通。项目中的代码应该是清晰的、单轨的、最先进的代码。”*

### 1.2 单轨真理路径（Single Source of Truth, SSOT）原则

为彻底落实用户的指示，确立以下硬性架构不变量：
1. **全局唯一合法预览宿主**：系统的右侧多标签坞（`LeafToolTabStrip` / `file-viewer:${filePath}`）是预览文件源码的**唯一法定容器**。严禁在 Diff 面板内自行弹出 modal 弹窗、侧滑抽屉或浮层，彻底杜绝任何形式的双轨实现；
2. **全局唯一点火函数**：差异面板触发文件预览必须经由 `openFileViewerInSession(absolutePath, 'diff')`，严禁各组件自行拼接未经验证的 Dock 树私有操作；
3. **真实文件系统与 IPC 打通**：预览面板读取的是真实落盘磁盘文件（经 Tauri 后端 `workbench_read_file_content`），非内存残缺切片或 `console.log` 伪连通；
4. **正交职责清晰划分**：
   - **差异面板（DiffCard）**：专注展现代码行级增删改比对与工作区暂存操作；
   - **独立预览面板（FileViewerCard）**：独享完整视口，专注展示全量源码、外部工具联动与文件定位。

### 1.3 端到端单轨调度架构流转图

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant Link as DiffCardFileList 超链接
    participant Facade as storeAccess / openTool
    participant TreeStore as useLayoutTreeStore
    participant TabStrip as LeafToolTabStrip (标签栏)
    participant Registry as ViewRegistry (URI解析)
    participant Viewer as FileViewerCard (独立面板)
    participant Backend as Tauri Rust IPC (fs_commands)

    User->>Link: 点击文件名超链接 (e.stopPropagation)
    Link->>Facade: openFileViewerInSession(absolutePath, 'diff')
    Facade->>Facade: normalizeViewerFilePath(path) 规范化绝对路径
    Facade->>TreeStore: openToolInLeaf(activeLeafId, "file-viewer:" + path + "?mode=diff")
    Note over TreeStore: 若标签已存在则激活，不存在则追加；展开坞(collapsed=false)
    TreeStore-->>TabStrip: 布局树状态变更触发重渲染
    TabStrip->>Registry: getTitle("file-viewer:...") 提取 basename 渲染 Tab 标题
    TabStrip->>Registry: getIcon("file-viewer:...") 提取 FileCode 图标
    TreeStore-->>Viewer: 挂载 <FileViewerCard filePath={path} initialMode="diff" />
    Viewer->>Backend: readTextFile(filePath)
    Backend-->>Viewer: 返回真实文件文本内容
    Viewer-->>User: 渲染完整专业工具栏 + 差异/源码高亮视图
```

---

## 2. openFileViewerInSession 链路修复与参数对齐（含 initialMode Bug 修复）

### 2.1 历史缺陷与根因剖析

在当前代码 [`apps/crish-desktop/src/store/workspace-shell/openTool.ts:176-183`](file:///c:/Software/conex/apps/crish-desktop/src/store/workspace-shell/openTool.ts#L176-L183) 中：
```typescript
/** 文件查看器：panelId 进 dock.openPanelIds。禁止 splitLeaf */
export function openFileViewerInSession(
  filePath: string,
  _initialMode: 'plain' | 'diff' = 'plain'
): void {
  const activeId = useLayoutTreeStore.getState().activeLeafId;
  if (!activeId) return;
  openToolInLeaf(activeId, `file-viewer:${filePath}`);
}
```
**根因查明**：
1. 形参 `_initialMode` 被带前导下划线，并在内部第 182 行被静默丢弃，拼接 URI 时完全遗漏了模式参数；
2. 而下游的 [`ViewRegistry.ts:39-41`](file:///c:/Software/conex/apps/crish-desktop/src/services/view-registry/ViewRegistry.ts#L39-L41) 早已完备实现了查询参数解析：
   ```typescript
   const searchParams = new URLSearchParams(queryStr);
   const modeParam = searchParams.get('mode') || searchParams.get('initialMode');
   const initialMode = modeParam === 'diff' ? 'diff' : 'plain';
   ```
3. 上游丢弃参数导致 `FileViewerCard` 打开时始终落入默认的 `plain`（完整源码）模式，无法响应差异场景下的 `diff`（仅看变更）初始诉求。

### 2.2 修复方案与工程实现

#### A. 修复 `openFileViewerInSession` 实现
在 `openTool.ts` 中实现路径标准化与查询参数动态追加，并增强多会话分屏时的 `leafId` 兜底解析：

```typescript
// apps/crish-desktop/src/store/workspace-shell/openTool.ts

import { normalizeViewerFilePath } from './normalizeViewerPath';
import { resolveLeafIdForSession } from './treeSessionQuery';

/**
 * 在当前会话所属叶节点的右侧坞中打开/聚焦独立文件预览面板。
 *
 * 单轨真理路径守门：
 * 1. 严格经过 normalizeViewerFilePath 标准化，杜绝路径漂移产生重复 Tab；
 * 2. 连通 initialMode 参数，当为 diff 时自动携带 ?mode=diff；
 * 3. 健壮性兜底：若 activeLeafId 为空，回落根据 activeSessionId 解析 targetLeafId。
 */
export function openFileViewerInSession(
  filePath: string,
  initialMode: 'plain' | 'diff' = 'plain'
): void {
  const store = useLayoutTreeStore.getState();
  let targetLeafId = store.activeLeafId;
  if (!targetLeafId) {
    const activeSessionId = useSessionStore.getState().activeSessionId;
    if (activeSessionId) {
      targetLeafId = resolveLeafIdForSession(activeSessionId);
    }
  }
  if (!targetLeafId) return;

  const normalized = normalizeViewerFilePath(filePath);
  if (!normalized) return;

  const query = initialMode === 'diff' ? '?mode=diff' : '';
  const panelId = `file-viewer:${normalized}${query}`;

  openToolInLeaf(targetLeafId, panelId);
}
```

#### B. 统一门面导出（`storeAccess.ts`）
依据前端架构解耦契约（T14 依赖规则：UI 组件禁止深度跨越私有目录，一律经 `storeAccess` 统一访问）：
在 [`apps/crish-desktop/src/store/storeAccess.ts:268-276`](file:///c:/Software/conex/apps/crish-desktop/src/store/storeAccess.ts#L268-L276) 中追加 `openFileViewerInSession` 导出：

```typescript
export {
  useWorkspaceShellStore,
  selectActiveTabSessionId,
  createDefaultDock,
  openToolInSession,
  openToolInLeaf,
  openToolInActiveTab,
  openFileViewerInSession, // <- 显式公共导出
  updateLeafDock,
  collapseActiveTabRightDock,
} from './workspace-shell';
```

---

## 3. 头部行三大正交交互域 DOM 解耦与 JSX 伪代码

### 3.1 既有 DOM 结构混乱病灶分析

现有代码 [`DiffCardFileList.tsx:142-160`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx#L142-L160) 的结构为：
```tsx
<div className={styles.accordionHeaderRow}>
  <Tooltip content={f.filePath}>
    <button
      id={itemId}
      type="button"
      className={`${styles.fileItem} ${active ? styles.isActive : ''}`}
      onClick={() => onSetActiveDiffSource(active ? null : f)}
      aria-label={`${basename(f.filePath)} +${additions} −${deletions}`}
    >
      <span className={styles.fileNameLink}>
        {basename(f.filePath)}
      </span>
      <span className={styles.fileStat} aria-hidden>...</span>
    </button>
  </Tooltip>
  ...
</div>
```
- **核心病灶**：
  1. 整行被一个名为 `fileItem` 的 `<button>` 占满；
  2. 文件名 `.fileNameLink` 虚有超链接样式，但只是普通的 `<span>`，点击冒泡至外层按钮触发折叠，造成视觉假象；
  3. 缺乏显式手风琴折叠箭头（Chevron），用户无法预知其展开行为；
  4. 若在外层 `<button>` 内部塞入 `<a>` 或 `<button>`，将触发 W3C 标准的“交互元素禁止嵌套”（Interactive Content Cannot Be Nested）违法，引发焦点陷阱与 React 告警。

### 3.2 三大正交交互域设计

必须将行内解耦为三个物理隔离、事件互不干扰的交互域：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│  .accordionHeaderRow (整行容器，支持平直紧凑布局)                                         │
│                                                                                        │
│  ┌───────────┐  ┌─────────────────────────┐  ┌───────────────────┐  ┌───────────────┐  │
│  │ [>] Chevron│  │  📄 FileViewer 超链接    │  │  空白点击承载区   │  │  [+][-][Undo] │  │
│  │ 展开/折叠   │  │  点击打开右侧独立 Tab   │  │  点击触发表内展开  │  │  Git 暂存/放弃│  │
│  └───────────┘  └─────────────────────────┘  └───────────────────┘  └───────────────┘  │
│    交互域 A               交互域 B                    交互域 A             交互域 C     │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

| 交互域 | 元素与定位 | 交互意图 | 事件与冒泡处理 |
| :--- | :--- | :--- | :--- |
| **交互域 A（内联折叠展开）** | 左侧 `Chevron` 展开按钮 + 行中空白填充承载区 | 展开/收起该文件在 Diff 面板内的内联比对代码块 | 触发 `onSetActiveDiffSource(active ? null : f)`，展开时 Chevron 顺时针旋转 90 度 |
| **交互域 B（独立文件预览单轨）** | 中间独立按钮 `.fileNameLinkBtn` | 点击在右侧工具栏直接开辟或聚焦对应的独立文件预览面板 | 触发 `e.stopPropagation()` 阻断冒泡，严格调用 `openFileViewerInSession(absolutePath, 'diff')` |
| **交互域 C（Git 工作区动作）** | 右侧 `.hoverActions` 悬浮按钮组 | 暂存文件、取消暂存、放弃修改 | 触发 `e.stopPropagation()` 阻断冒泡，调用 Git 对应原子动作 |

### 3.3 重构后纯净 JSX 代码实现

在 [`DiffCardFileList.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx) 中的完整落地实现：

```tsx
// DiffCardFileList.tsx (头部行重构)

<div
  className={`${styles.accordionHeaderRow} ${active ? styles.accordionActive : ''}`}
  data-active={active ? 'true' : 'false'}
>
  {/* ── 交互域 A (左侧): 显式手风琴折叠展开 Chevron 按钮 ── */}
  <button
    type="button"
    className={styles.accordionToggleBtn}
    onClick={() => onSetActiveDiffSource(active ? null : f)}
    aria-expanded={active}
    aria-controls={`diff-body-${itemId}`}
    aria-label={`${active ? '折叠' : '展开'} ${basename(f.filePath)} 差异代码`}
  >
    <Lucide.ChevronRight
      size={14}
      className={`${styles.accordionChevron} ${active ? styles.chevronOpen : ''}`}
      aria-hidden
    />
  </button>

  {/* ── 交互域 B (中间): 单轨独立文件预览超链接按钮 ── */}
  <Tooltip content={`在右侧打开独立预览：${f.filePath}`}>
    <button
      id={itemId}
      type="button"
      className={styles.fileNameLinkBtn}
      onClick={(e) => {
        e.stopPropagation();
        openFileViewerInSession(absolutePath, 'diff');
      }}
      aria-label={`独立预览文件 ${basename(f.filePath)}`}
    >
      <span className={styles.fileNameText}>
        {basename(f.filePath)}
      </span>
    </button>
  </Tooltip>

  {/* ── 交互域 A (中间至右侧): 统计标签与空白过渡点击区 ── */}
  <div
    className={styles.accordionFiller}
    onClick={() => onSetActiveDiffSource(active ? null : f)}
    role="presentation"
  >
    <span className={styles.fileStat} aria-hidden>
      <span className="add">+{additions}</span>
      <span className="del">−{deletions}</span>
    </span>
  </div>

  {/* ── 交互域 C (右侧): Git 悬浮操作区 ── */}
  {sourceMode === 'git' && (
    <div className={styles.hoverActions}>
      {stagingPaths[f.filePath] ? (
        <Lucide.Loader2 size={13} className={styles.spinner} />
      ) : f.staged ? (
        <Tooltip content={UNSTAGE_LABEL}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className={styles.hoverActBtn}
            aria-label={UNSTAGE_LABEL}
            onClick={(e) => {
              e.stopPropagation();
              void onUnstageFile(f.filePath);
            }}
            icon={<Lucide.Minus size={13} />}
          />
        </Tooltip>
      ) : (
        <>
          <Tooltip content={STAGE_LABEL}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className={styles.hoverActBtn}
              aria-label={STAGE_LABEL}
              onClick={(e) => {
                e.stopPropagation();
                void onStageFile(f.filePath);
              }}
              icon={<Lucide.Plus size={13} />}
            />
          </Tooltip>
          <Tooltip content={DISCARD_LABEL}>
            <Button
              type="button"
              variant="danger"
              size="sm"
              className={`${styles.hoverActBtn} ${styles.danger}`}
              aria-label={DISCARD_LABEL}
              onClick={(e) => {
                e.stopPropagation();
                void onDiscardChanges(f.filePath);
              }}
              icon={<Lucide.Undo2 size={13} />}
            />
          </Tooltip>
        </>
      )}
    </div>
  )}
</div>
```

---

## 4. 路径规范化 (normalizeViewerFilePath) 与多 Tab 幂等防重设计

### 4.1 路径漂移与重复 Tab 根因审计

- **现状**：
  - Git 变更流中的路径多为仓库相对路径（如 `apps/crish-desktop/src/main.tsx`）；
  - 工具调用或 Session 模式下的路径可能为绝对路径（如 `C:/Software/conex/apps/crish-desktop/src/main.tsx` 或带有 Windows 反斜杠 `\`）；
  - `openToolInLeaf` 中采用严格字符串包含断言：`dock.openPanelIds.includes(mapped)`；
- **危害**：
  若不经过绝对归一化，同一物理文件将以相对路径和绝对路径创建两个完全相同但不同 ID 的 Tab，造成用户困惑与内存浪费。

### 4.2 路径规范化算法设计

新建纯逻辑模块 `apps/crish-desktop/src/store/workspace-shell/normalizeViewerPath.ts`：

```typescript
import { getWorkspacePath } from '../../api/workspaceFsApi';

/**
 * 统一规范化文件预览路径：
 * 1. 统一反斜杠转为 POSIX 正斜杠；
 * 2. 消除冗余 ./、重复斜杠及尾部斜杠；
 * 3. 若为相对路径，基于当前工作区路径解析为绝对路径；
 * 4. 确保在 openToolInLeaf 中具有唯一确定的 Tab ID，杜绝重复 Tab。
 */
export function normalizeViewerFilePath(rawPath: string): string {
  const trimmed = (rawPath || '').trim().replace(/\\/g, '/');
  if (!trimmed) return '';

  // 检测 Windows 盘符 (C:/...) 或 POSIX 根绝对路径 (/...)
  const isAbsolute = /^[a-zA-Z]:\//.test(trimmed) || trimmed.startsWith('/');
  if (isAbsolute) {
    return cleanPathSegments(trimmed);
  }

  // 相对路径：结合工作区路径
  const ws = (getWorkspacePath() || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!ws) {
    return cleanPathSegments(trimmed);
  }

  return cleanPathSegments(`${ws}/${trimmed}`);
}

function cleanPathSegments(path: string): string {
  // 消除 /./ 与重复 //
  return path.replace(/\/\.\//g, '/').replace(/(?<!:)\/{2,}/g, '/');
}
```

### 4.3 幂等防重与激活策略

在 `openToolInLeaf` 中现有的去重与激活逻辑已非常成熟：
```typescript
const openPanelIds = dock.openPanelIds.includes(mapped)
  ? dock.openPanelIds
  : [...dock.openPanelIds, mapped];

updateLeafDock(id, {
  collapsed: false,
  openPanelIds,
  activePanelId: mapped,
});
```
- 当用户再次点击相同文件的超链接时：
  1. `openPanelIds.includes(mapped)` 命中为 `true`，不会在数组末尾追加新 Tab；
  2. `activePanelId` 强制更新为当前 `mapped`，右侧标签页自动高亮聚焦该 Tab；
  3. `collapsed: false` 确保即使此前右侧坞处于折叠状态，也会被立即平滑展开；
  4. 达成完全的幂等防重与流畅激活。

---

## 5. CSS 交互反馈与 Design Tokens 绑定（cursor, hover, focus-visible）

### 5.1 视觉合规铁律对齐

严格遵循仓库全局指令 `AGENTS.md`：
- **§12（Tooltip）**：始终使用自定义 `<Tooltip>` 组件，禁止原生 HTML `title`；
- **§13（输入框与焦点态）**：默认不要重阴影；禁止粗、深、实心黑边；相对基线，灰色加深混入文本色不超过约 10%（上限 `color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%)`）；常规元素优先 3%–6% 混入以保持柔软；
- **§14（现代色彩空间）**：优先使用 HSLA 或斜杠透明度语法（如 `hsl(var(--accent-blue-h) ... / 0.4)` 或 `color-mix`）。

### 5.2 精确 CSS Token 契约实现

在 [`apps/crish-desktop/src/components/diff/DiffCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css) 中更新与追加：

```css
/* ==========================================================================
   PLAN-03: 文件名超链接与正交折叠样式契约
   ========================================================================== */

.accordionHeaderRow {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  height: 36px;
  padding: 0 8px 0 4px;
  box-sizing: border-box;
  background: transparent;
  border-radius: var(--radius-sm, 6px);
  transition: background-color var(--transition-fast, 120ms ease);
}

.accordionHeaderRow:hover {
  background-color: var(--bg-hover, hsl(0 0% 50% / 0.06));
}

/* 1. 折叠指示器 Chevron 按钮 */
.accordionToggleBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  margin-right: 4px;
  border: none;
  border-radius: var(--radius-xs, 4px);
  background: transparent;
  color: var(--text-tertiary, hsl(0 0% 50%));
  cursor: pointer;
  flex-shrink: 0;
  transition: color var(--transition-fast), background-color var(--transition-fast);
}

.accordionToggleBtn:hover {
  color: var(--text-primary);
  background-color: var(--bg-active, hsl(0 0% 50% / 0.1));
}

.accordionChevron {
  transition: transform var(--transition-fast, 150ms) cubic-bezier(0.4, 0, 0.2, 1);
  transform: rotate(0deg);
}

.chevronOpen {
  transform: rotate(90deg);
}

/* 2. 单轨文件名超链接按钮 */
.fileNameLinkBtn {
  display: inline-flex;
  align-items: center;
  border: none;
  background: transparent;
  padding: 2px 6px;
  margin: 0;
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: var(--font-size-sm, 13px);
  font-weight: var(--font-weight-medium, 500);
  cursor: pointer;
  border-radius: var(--radius-xs, 4px);
  max-width: fit-content;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-decoration: none;
  transition: color var(--transition-fast), text-decoration-color var(--transition-fast);
}

.fileNameLinkBtn:hover {
  color: var(--accent-blue, hsl(210 100% 56%));
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-thickness: 1px;
}

.fileNameText {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 3. 焦点态规范：坚决贯彻 §13，采用柔软半透明 Outline，杜绝粗黑实边 */
.fileNameLinkBtn:focus-visible,
.accordionToggleBtn:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent-blue, #3b82f6) 40%, transparent);
  outline-offset: 1px;
}

/* 4. 空白填充承载区（扩展手风琴折叠热区） */
.accordionFiller {
  flex: 1 1 auto;
  min-width: 16px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  cursor: pointer;
  padding-right: 8px;
}

.fileStat {
  font-size: var(--font-size-xxs, 11px);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  display: flex;
  gap: var(--space-2, 6px);
  flex-shrink: 0;
  align-items: center;
}
```

---

## 6. 端到端连通性与回归断言

### 6.1 四段式落地审查清单

#### 1.【做什么（To-Do）】
- [x] 在 `DiffCardFileList.tsx` 中将整行混杂的 `<button className={styles.fileItem}>` 解耦为三大正交域：左侧 Chevron 折叠按钮 + 中间单轨文件名超链接按钮 + 右侧空白过渡折叠热区与 Git 动作区；
- [x] 在 `openTool.ts` 中修复 `openFileViewerInSession`，接入 `initialMode` 参数并实现动态 `?mode=diff` 查询拼接；
- [x] 新增并接入 `normalizeViewerFilePath` 纯逻辑函数，在进入 Dock 树前确保绝对路径唯一化，杜绝多 Tab 漂移；
- [x] 在 `storeAccess.ts` 显式导出 `openFileViewerInSession`，守住前端分层架构；
- [x] 规范化 CSS Tokens 契约，落实柔软 focus 轮廓与下划线链接悬浮反馈；
- [x] 补充隔离单元测试断言。

#### 2.【不做什么（Not-To-Do）】
- [x] **严禁执行任何 git commit / reset / checkout / restore**（严守多 Agent 纪律，代码仅留在工作区由主控收口）；
- [x] **严禁搞双轨实现**：DiffCard 内部绝不自行渲染弹窗（Modal）或侧边抽屉展示源码，右侧 Tab 系统为全局唯一合法宿主；
- [x] **严禁伪连通**：禁止 `console.log` 空壳实现，必须端到端拉通至 Rust IPC 真实落盘读取。

#### 3.【旧路径清单（Legacy Path Inventory）】
- `DiffCardFileList.tsx:142-160`：整行作为单个 button 并混淆超链接与折叠的旧结构；
- `DiffCard.module.css:230-263`：原绑死在整行上的旧 `.fileItem` 选择器；
- `openTool.ts:176`：带下划线被遗弃的 `_initialMode` 入参。

#### 4.【自检删除面（Self-Inspection Deletion Surface）】
- 清理 `DiffCardFileListProps` 中与文件查看器冗余的私有透传函数（配合 PLAN-02 清除 `onCopyCode`）；
- 清理 `DiffCard.module.css` 中的废弃旧样式；
- 移除所有临时内联调试代码。

### 6.2 自动化测试与断言用例设计

#### A. `apps/crish-desktop/src/store/workspace-shell/openTool.test.ts` 扩充
```typescript
describe('openFileViewerInSession (PLAN-03)', () => {
  it('应当正确规范化路径并拼装 ?mode=diff 查询参数', () => {
    const leafId = 'leaf-test-1';
    setupMockLeaf(leafId);

    openFileViewerInSession('apps/crish-desktop/src/main.tsx', 'diff');

    const leaf = getLeafById(leafId);
    const expectedPrefix = 'file-viewer:';
    const activePanel = leaf.dock.activePanelId;

    expect(activePanel).toContain(expectedPrefix);
    expect(activePanel).toContain('apps/crish-desktop/src/main.tsx');
    expect(activePanel).toContain('?mode=diff');
    expect(leaf.dock.collapsed).toBe(false);
  });

  it('重复调用相同文件时保持 Tab 幂等，不重复追加', () => {
    const leafId = 'leaf-test-1';
    setupMockLeaf(leafId);

    openFileViewerInSession('src/App.tsx');
    openFileViewerInSession('src/App.tsx');

    const leaf = getLeafById(leafId);
    const tabs = leaf.dock.openPanelIds.filter((id) => id.includes('src/App.tsx'));
    expect(tabs.length).toBe(1);
  });
});
```

#### B. `apps/crish-desktop/src/components/diff/DiffCardFileList.test.tsx` 隔离断言
```typescript
describe('DiffCardFileList 正交交互域解耦 (PLAN-03)', () => {
  it('点击文件名超链接应当仅触发 openFileViewerInSession，绝不触发表内折叠', async () => {
    const onSetActiveDiffSource = vi.fn();
    const openViewerSpy = vi.spyOn(openToolModule, 'openFileViewerInSession');

    render(
      <DiffCardFileList
        files={[mockFileDiff]}
        onSetActiveDiffSource={onSetActiveDiffSource}
        // ...其他必要 props
      />
    );

    const linkBtn = screen.getByRole('button', { name: /独立预览文件/i });
    fireEvent.click(linkBtn);

    expect(openViewerSpy).toHaveBeenCalledWith(expect.stringContaining('test.ts'), 'diff');
    expect(onSetActiveDiffSource).not.toHaveBeenCalled();
  });

  it('点击 Chevron 箭头或空白区仅触发表内折叠展开，不触发独立文件预览', async () => {
    const onSetActiveDiffSource = vi.fn();
    const openViewerSpy = vi.spyOn(openToolModule, 'openFileViewerInSession');

    render(
      <DiffCardFileList
        files={[mockFileDiff]}
        onSetActiveDiffSource={onSetActiveDiffSource}
      />
    );

    const toggleBtn = screen.getByRole('button', { name: /展开.*差异代码/i });
    fireEvent.click(toggleBtn);

    expect(onSetActiveDiffSource).toHaveBeenCalled();
    expect(openViewerSpy).not.toHaveBeenCalled();
  });
});
```

---
*方案规划完毕，待主控统一审查与收敛。*
