# 单轨架构与接口契约交叉独立评审报告 (REVIEW-01)

> **战役名称**：差异面板与笔记面板系统性重构（Diff View & Note Panel Systematic Redesign）
> **评审阶段**：阶段三 · 方案交叉独立评审（Cross-Plan Independent Review）
> **专项编号**：REVIEW-01
> **评审角色**：架构单轨性与接口契约首席评审官（Chief Architecture & Contract Reviewer）
> **输入依赖**：
> - [`docs/diff-view-redesign/analysis/`](file:///c:/Software/conex/docs/diff-view-redesign/analysis/) 全量 8 份现场审计报告（AUDIT-01 至 AUDIT-08）
> - [`docs/diff-view-redesign/independent-plans/`](file:///c:/Software/conex/docs/diff-view-redesign/independent-plans/) 全量 7 份独立方案（PLAN-01 至 PLAN-07）
> **落盘路径**：`docs/diff-view-redesign/plan-reviews/01-architecture-and-contracts-review.md`
> **审查基准**：用户最高裁决（“系统性做，先考虑架构。以及避免双轨或者多轨、硬编码、功能伪实现、伪连通。项目中的代码应该是清晰的、单轨的、最先进的代码”）、[`.agents/LOGIC_PLAN_NO_RETREAT.md`](file:///c:/Software/conex/.agents/LOGIC_PLAN_NO_RETREAT.md)（反退避）、[`AGENTS.md`](file:///c:/Software/conex/AGENTS.md)（协作纪律）与 [`ANTI_OVERENGINEERING_GUARDRAILS.md`](file:///c:/Software/conex/ANTI_OVERENGINEERING_GUARDRAILS.md)。

---

## 1. 总体架构评审结论与单轨性裁决（Pass / Need-Fix）

### 1.1 总体评审裁决：【Need-Fix（必须修正关键断层后方可实施）】

经过对 7 份独立设计方案（PLAN-01 至 PLAN-07）的端到端推演、跨方案正交性比对、以及对真实源码（Rust 存储层、Tauri IPC 宏、桌面端状态机、CSS Modules）的现场穿透，评审结论裁定为 **Need-Fix**。

7 份方案在“痛点定性”、“问题诊断”和“削减死代码”的总体思路上高度符合用户指令，但在**跨方案接力集成、底层通信契约严密性、Windows 路径边缘边界、以及多状态并发竞争**上暴露了若干致命断层。如果直接按现有文档各自独立实施，将直接引发**“文件名超链接无法打开独立 Tab”、“右侧坞生成重复 Tab”、“SQLite 启动全量重置用户标题”、“Tauri 编译期一致性门禁红灯阻断”、以及“跨文档脏数据写串染”**等灾难性问题。

### 1.2 7 份独立方案交叉评审总评与评分矩阵

| 方案编号 | 方案主题 | 架构单轨性评分 (1-10) | 接口契约完备度 (1-10) | 伪实现/伪连通排查 | 核心裁决结论 |
| :--- | :--- | :---: | :---: | :--- | :--- |
| **PLAN-01** | 差异平直列表化与去圆角 | 7.0 | 6.5 | 存在将超链接误判为“噪点”并抹除的缺陷 | **Need-Fix**：整行大按钮破坏了文件名超链接 |
| **PLAN-02** | 拔除行内工具行 `_inlineHeader_` | 9.5 | 9.0 | 无伪实现，删除面彻底 | **Pass**：物理剔除干净，可作为解耦基座 |
| **PLAN-03** | 文件名超链接接线独立预览 Tab | 8.0 | 7.5 | 存在 Duplicate Tab 漏洞与 Windows 盘符大小写漏洞 | **Need-Fix**：路径归一化与 Tab 唯一键需加固 |
| **PLAN-04** | Hover 双重叠加与 Tokens 规范化 | 9.0 | 9.0 | 无伪实现，CSS 清理精准 | **Pass**：需与 PLAN-01 新类名对齐映射 |
| **PLAN-05** | 笔记 32px 紧凑顶栏重塑 | 7.5 | 7.0 | 与 PLAN-07 顶栏功能冲突 | **Need-Fix**：缺少多文档切换与侧栏开关设计 |
| **PLAN-06** | 拔除笔记底部漂移栏与 Footer | 9.5 | 9.0 | 无伪实现，彻底切断无用轮询 | **Pass**：状态感知需平滑下沉或收敛至顶栏 |
| **PLAN-07** | 多笔记综合管理体系 | 6.5 | 6.0 | 回收站功能伪实现；无条件 Backfill；Tauri 宏漏接 | **Need-Fix**：SQLite 幂等性与 IPC 注册需全面修正 |

---

### 1.3 四段式架构治理矩阵

#### 1. 【做什么（To-Do）】
1. **统一 DIFF 文件行正交 DOM 结构（强行收敛 PLAN-01 与 PLAN-03）**：
   - 彻底废除 PLAN-01 中将整行做成单一 `<button className={styles.fileRow}>` 的倒退设计；
   - 确立统一的容器 `div.fileRow`（32px 高度、直角、平铺），左侧挂载 `ChevronRight` 折叠展开按钮，中间挂载独立的 `<button className={styles.fileNameLinkBtn}>`（点击无损流转独立 Tab），右侧挂载空白折叠热区与 Git 快捷动作；
2. **修复 `openFileViewerInSession` 与 Tab 唯一性判断（修正 PLAN-03）**：
   - 在进入 Dock 树之前，以纯净的归一化绝对路径为 Canonical Tab ID，杜绝查询参数 `?mode=diff` 导致重复 Tab；
   - 实现 Windows 驱动器盘符大小写强行大写化（`c:` $\to$ `C:`），统一正斜杠并彻底净化 UNC 路径；
3. **加固 SQLite Migration v8 与数据升档安全（修正 PLAN-07）**：
   - 严禁每次启动无条件扫描更新文档标题，将 `backfill_legacy_doc_meta` 严格封口在 `v < 8` 的历史版本判定分支内；
   - 在全新库创建时直接建立包含完整 8 列的 `doc_meta` 表，杜绝“先建 3 列再连续 5 次 ALTER TABLE”的过渡态补丁；
4. **补齐 Tauri IPC 契约全链路（修正 PLAN-07）**：
   - 在 `main.rs` 的 `command_registry!` 宏中完整补齐 4 项映射；
   - 在 `command_manifest.rs` 登记并抬升总条数，同步更新前端 `commandManifest.ts` 快照，确保 `command-contract-drift` 门禁 100% 绿灯；
5. **构建多文档切换脏数据拦截与异步竞态防护（修正 PLAN-07）**：
   - 在 `useNoteDocumentManager` 状态机中引入 `beforeSwitch` 守卫，切换文档前强制触发当前文档的 `flushPendingEdits()` 与 `blur`；
   - 在 `useNoteHydrate` 中引入基于递增请求令牌（Request Token）的过期舍弃机制，彻底根除快速切换文档引发的乱序异步覆盖；
   - 在父级宿主中为面板挂载 `key={activeDocId}`，保证 React 实例级状态与虚拟列表视口干净重置。

#### 2. 【不做什么（Not-To-Do）】
1. **严禁破坏 Git 协作纪律**：任何审查与后续修正严禁执行 `git commit`、`git reset`、`git checkout` 或 `git restore`；改动严格留在工作区由主控统一收口；
2. **严禁和稀泥与妥协折中**：绝对禁止在方案评审中采取“先按 PLAN-01 搞个大 button，以后再加链接”或“回收站以后再做现在先画个假图标”的推诿态度；
3. **严禁双轨残留**：绝对禁止保留任何 `Strict` 与 `Skeleton` 并存的空态双宿主；绝对禁止在 Diff 内再自造简易对比弹窗。

#### 3. 【旧路径清单（Legacy Path Inventory）】

| 方案归属 | 遗留未被提及或处理不彻底的历史废弃接口/状态 | 现场代码位置 | 严重性与隐患 |
| :--- | :--- | :--- | :--- |
| **PLAN-01/03** | `.fileItem` 选择器及其在 `style-contract.test.ts` 中的存量断言 | `DiffCard.module.css:230`, `style-contract.test.ts:45` | 若只删 CSS 不改单测，CI 样式门禁将报红 |
| **PLAN-02** | `classifyFileDiff` 仍在 `DiffCardFileList.test.tsx` 存量用例中断言 | `DiffCardFileList.test.tsx:26-63` | 拔除行内 Accept 按钮后，测试用例若不重写将直接失败 |
| **PLAN-05/07** | `syntheticStrictDocId` (`strict-${wsId}`) 存量死逻辑 | `productStrictDoc.ts:34`, `NoteLeafHost.tsx:30` | 存量代码仍把单一合成 ID 当作主路径，未与多文档列表对齐 |
| **PLAN-06** | `enableMirrorDetectSchedule` 轮询定时器虽然设为 false 但 hook 仍在执行 | `NoteLeafHost.tsx:60-65` | 仍保留了无用调度器引用，需连根拔除 |
| **PLAN-07** | `recent_persisted_nonempty_doc_id` 旧查询接口 | `conex-workspace-store/src/lib.rs:249` | 已被 `list_documents` 覆盖，若不标记弃用将形成存储双轨 |

#### 4. 【自检删除面（Self-Inspection Deletion Surface）】

经审查，各方案存在多处“只删了调用方、没删定义方”的死代码断层：
1. **PLAN-02 遗漏**：在 `DiffCardFileList.tsx` 中删除了对 `classifyFileDiff` 的调用，但未评估上游 `api/applyFileDiff.ts` 是否存在仅为此行内工具条服务的专属函数；
2. **PLAN-05 遗漏**：重构顶栏后，`NotePaperPanel.module.css` 中的 `.badge` 样式虽然计划删除，但未检查 `apps/crish-desktop/src/components/workspace/` 下是否有模块仍在跨层逆向引用该样式；
3. **PLAN-06 隐患**：计划全量删除 `MirrorDriftStatusBar.tsx`，但未在 `NoteLeafHost.tsx` 的类型定义中同步移除 `mirrorDriftReport` 等整套相关类型导入，会导致 TypeScript 编译报错。

---

## 2. PLAN-02 与 PLAN-03：Diff 专注化与独立预览 Tab 契约审查

### 2.1 PLAN-01 与 PLAN-03 核心 DOM 拓扑冲突剖析

用户明确指示：
> “点击差异的那个超链接是直接打开一个新的标签，名称就是对应的文件名称，也是有一个顶部的工具栏，下面主区域就是这个文件的预览了...差异界面的每个文件改成列表就行了，去掉圆角。越简单越好。”

#### 致命挑刺：两份方案的 DOM 结构发生根本性排异！
- **PLAN-01 的做法**（参见 [`01-diff-flat-list-plan.md:247-253`](file:///c:/Software/conex/docs/diff-view-redesign/independent-plans/01-diff-flat-list-plan.md#L247-L253)）：
  ```tsx
  <div key={f.filePath} className={styles.fileNode} role="listitem">
    <button
      type="button"
      className={`${styles.fileRow} ${active ? styles.isActive : ''}`}
      onClick={() => onSetActiveDiffSource(active ? null : f)}
      aria-expanded={active}
    >
      <Lucide.ChevronRight ... />
      <span className={styles.statusBadge}>M</span>
      <div className={styles.pathWrap}>
        <span className={styles.fileName}>{name}</span>
        {dir && <span className={styles.dirPath}>{dir}</span>}
      </div>
      ...
    </button>
  ```
  PLAN-01 将整行包装为一个单一的 `<button className={styles.fileRow}>`。更令人震惊的是，在 PLAN-01 的 L794 表格中，明确将 `.fileNameLink:hover` 判定为“按钮内设链接下划线制造视觉噪点”并要求**直接删除**！
- **PLAN-03 的要求**（参见 [`03-file-viewer-integration-plan.md:237-253`](file:///c:/Software/conex/docs/diff-view-redesign/independent-plans/03-file-viewer-integration-plan.md#L237-L253)）：
  要求文件名具有可点击超链接属性，点击后在右侧独立标签页打开 `FileViewerCard`。
- **冲突后果**：
  若按 PLAN-01 实施，文件名只是一个普通的 `<span>`，用户点击文件名任何位置，由于冒泡均触发整行的 `onClick`，即**只会在内联展开/折叠 Diff 代码**，根本无法触发在右侧打开独立 Tab！若在 PLAN-01 的 `<button>` 内部塞入 PLAN-03 的超链接按钮，将直接违反 W3C 标准的“交互元素禁止嵌套（Interactive Content Cannot Be Nested）”铁律，引发严重的焦点陷阱与 React 控制台报警。

#### 首席评审官裁决收敛方案：
必须强行废黜 PLAN-01 将整行设为 `<button>` 的设计，采用**外层 `div.fileRow` + 三大正交交互子域**的拓扑结构：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────┐
│  div.fileRow (32px 直角贴边容器，仅负责布局与 hover 背景 var(--bg-hover))                      │
│                                                                                                │
│  ┌────────────┐ ┌────┐ ┌───────────────────────────┐ ┌───────────────┐ ┌─────────────────────┐ │
│  │ [>] Chevron│ │ M  │ │ 📄 Button.tsx (文件名按钮) │ │ src/ui/       │ │ +12 -3  [+][-][Undo]│ │
│  │ 点击内联展开│ │徽标│ │ 点击打开右侧独立预览 Tab  │ │ 路径(点击展开)│ │ 统计常驻   Git操作   │ │
│  └────────────┘ └────┘ └───────────────────────────┘ └───────────────┘ └─────────────────────┘ │
│    交互域 A (折叠)       交互域 B (独立预览 Tab 单轨)       交互域 A (折叠)      交互域 C (Git操作)   │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **行根容器**：`<div className={styles.fileRow} data-active={active}>`（直角、32px 高度）；
2. **交互域 A（展开/折叠）**：左侧独立 Chevron 按钮 `<button type="button" className={styles.chevronBtn} onClick={toggleExpand}>`，点击仅触发表内内联展开；右侧路径空白区域作为辅助折叠热区；
3. **交互域 B（独立预览单轨）**：文件名包裹在独立的语义化超链接按钮中：
   ```tsx
   <button
     type="button"
     className={styles.fileNameLinkBtn}
     onClick={(e) => {
       e.stopPropagation();
       openFileViewerInSession(f.filePath, 'diff');
     }}
   >
     {name}
   </button>
   ```
   点击时严格 `stopPropagation`，杜绝触发表内折叠；悬停时展示品牌色下划线（`--md-link-color`），完全满足用户诉求。

---

### 2.2 `openTool.ts` 中 `initialMode` 的修复严密性审查与 Duplicate Tab 漏洞

PLAN-03 敏锐地发现了 `openTool.ts:178` 中 `_initialMode` 被丢弃的 Bug，并提议将其拼接为 `file-viewer:${normalized}?mode=diff`。

#### 致命挑刺：引发重复 Tab 灾难（Duplicate Tab Bug）！
审查系统右侧坞标签栏管理核心逻辑 [`LeafToolTabStrip.tsx:113-116`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx#L113-L116) 与 [`openTool.ts:140-146`](file:///c:/Software/conex/apps/crish-desktop/src/store/workspace-shell/openTool.ts#L140-L146)：

```typescript
// openTool.ts
const openPanelIds = dock.openPanelIds.includes(mapped)
  ? dock.openPanelIds
  : [...dock.openPanelIds, mapped];
```

`openToolInLeaf` 使用严格的全等字符串判定（`includes(mapped)`）。推演真实用户交互场景：
1. 用户在文件树双击打开了 `src/App.tsx`，Dock 树中记账为：
   `openPanelIds: ['file-viewer:C:/Software/conex/src/App.tsx']`；
2. 用户随后在差异面板中点击了同一个文件 `src/App.tsx` 的超链接，PLAN-03 拼装的参数为：
   `mapped = 'file-viewer:C:/Software/conex/src/App.tsx?mode=diff'`；
3. **判定失败**：`includes('file-viewer:C:/Software/conex/src/App.tsx?mode=diff')` 为 `false`；
4. **结果**：`openPanelIds` 被追加为：
   `['file-viewer:C:/Software/conex/src/App.tsx', 'file-viewer:C:/Software/conex/src/App.tsx?mode=diff']`；
5. **灾难现场**：右侧 Tab 栏上赫然**出现了两个完全同名的 `App.tsx` 标签**！用户点击哪一个都会困惑，严重违背单轨架构原则！

#### 修复与加固契约：
Tab 的持久化 ID（Canonical Tab ID）**必须剥离易变的 Query String**，保持物理文件的单一真理：
1. **Canonical Tab ID** 必须死锁为 `file-viewer:${normalizedPath}`；
2. 在 `openToolInLeaf` 中，若已存在相同规范化路径的 Tab，则**直接激活（Focus）该 Tab**，并通过单独的状态或视图上下文通知内部更新模式，严禁仅因 query 不同而产生分裂 Tab；
3. 或者在 `openTool.ts` 中先扫描是否存在去 query 后的同源 Tab，若存在则更新其激活态。

---

### 2.3 `normalizeViewerFilePath` 在 Windows 环境下的路径归一化漏洞

PLAN-03 提出了 `normalizeViewerFilePath`（[`03-file-viewer-integration-plan.md:351-374`](file:///c:/Software/conex/docs/diff-view-redesign/independent-plans/03-file-viewer-integration-plan.md#L351-L374)），但评审官对其代码进行严格的代码推演后，发现了 3 处严重的 Windows 平台路径陷阱：

```typescript
// PLAN-03 的原始草案：
export function normalizeViewerFilePath(rawPath: string): string {
  const trimmed = (rawPath || '').trim().replace(/\\/g, '/');
  if (!trimmed) return '';
  const isAbsolute = /^[a-zA-Z]:\//.test(trimmed) || trimmed.startsWith('/');
  if (isAbsolute) {
    return cleanPathSegments(trimmed);
  }
  const ws = (getWorkspacePath() || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!ws) {
    return cleanPathSegments(trimmed);
  }
  return cleanPathSegments(`${ws}/${trimmed}`);
}
```

#### 致命漏洞分析：
1. **漏洞一：驱动器盘符大小写漂移（Case Sensitivity Mismatch）**：
   - Git 命令行输出的路径有时为小写盘符（如 `c:/software/conex/src/App.tsx`）；
   - 前端从 Tauri `getWorkspacePath()` 获取的盘符通常为大写（如 `C:/software/conex`）；
   - PLAN-03 仅仅做了正则匹配，未对盘符大小写做任何收敛！
   - 结果：`c:/software/...` 与 `C:/software/...` 在 JavaScript 的 `includes` 判定中互不相等，**依然产生重复 Tab**！
2. **漏洞二：前导 `./` 拼接导致脏路径**：
   - 某些工具调用返回的相对路径带有前导 `./`（如 `./src/main.ts`）；
   - PLAN-03 拼接后变成 `C:/workspace/./src/main.ts`；
   - 其后调用的 `cleanPathSegments` 仅执行了 `replace(/\/\.\//g, '/')`，对于开头的 `/./` 无法匹配消除，留存脏路径。
3. **漏洞三：破坏 Windows UNC 路径与 WSL 路径**：
   - PLAN-03 中使用了 `replace(/(?<!:)\/{2,}/g, '/')`；
   - 若用户在 WSL 环境或网络共享路径下工作，路径格式为 `//wsl.localhost/Ubuntu/...` 或 `//server/share/...`；
   - 负向后行断言会暴力将开头的 `//` 压成单个 `/`，直接将合法的 UNC 根路径破坏为 POSIX 根路径，导致文件读取 100% 报错（File Not Found）。

#### 首席评审官认证的纯逻辑路径归一化实现：
```typescript
/**
 * 严格符合 POSIX 与 Windows 规范的单轨路径归一化纯函数 (REVIEW-01 刚性标准)
 */
export function normalizeViewerFilePath(rawPath: string): string {
  if (!rawPath || typeof rawPath !== 'string') return '';
  let p = rawPath.trim().replace(/\\/g, '/');
  if (!p) return '';

  // 1. 保留 UNC 前缀（如 //server 或 //wsl.localhost）
  const isUnc = p.startsWith('//') && !p.startsWith('///');

  // 2. 清理多余连续斜杠（保护开头的 UNC 双斜杠）
  if (isUnc) {
    p = '//' + p.substring(2).replace(/\/+/g, '/');
  } else {
    p = p.replace(/\/+/g, '/');
  }

  // 3. 清除当前目录标记 /./ 与前导 ./
  p = p.replace(/^\.\//, '');
  p = p.replace(/\/\.\//g, '/');

  // 4. Windows 绝对路径：强制将驱动器盘符收敛为统一大写 (C:/...)
  if (/^[a-zA-Z]:\//.test(p)) {
    p = p.charAt(0).toUpperCase() + p.slice(1);
    return cleanTrailingSlash(p);
  }

  // 5. POSIX 或 UNC 绝对路径
  if (p.startsWith('/') || isUnc) {
    return cleanTrailingSlash(p);
  }

  // 6. 相对路径：结合工作区根目录合成绝对路径
  const ws = (getWorkspacePath() || '').trim().replace(/\\/g, '/');
  if (!ws) {
    return cleanTrailingSlash(p);
  }
  let normalizedWs = ws.replace(/\/+$/, '');
  if (/^[a-zA-Z]:\//.test(normalizedWs)) {
    normalizedWs = normalizedWs.charAt(0).toUpperCase() + normalizedWs.slice(1);
  }

  return cleanTrailingSlash(`${normalizedWs}/${p}`);
}

function cleanTrailingSlash(p: string): string {
  // 根路径（如 C:/ 或 /）保留斜杠，其余剥离尾部斜杠
  if (/^[a-zA-Z]:\/$/.test(p) || p === '/') return p;
  return p.replace(/\/+$/, '');
}
```

---

## 3. PLAN-07：多笔记 SQLite 迁移、Rust IPC 与状态机深度漏洞审查

### 3.1 SQLite Migration v8 的 SQL 幂等性与启动性能陷阱

审查 PLAN-07 中的 SQLite 迁移方案（[`07-note-multi-doc-management-plan.md:309-335, 869-918`](file:///c:/Software/conex/docs/diff-view-redesign/independent-plans/07-note-multi-doc-management-plan.md#L309-L335)）。

#### 致命挑刺：无条件回填（Unconditional Backfill）与性能灾难！
在 PLAN-07 的 L329 中，其代码编写如下：
```rust
pub fn migrate(conn: &Connection) -> Result<(), StoreError> {
    // ... ensure_column ...
    // ... create index ...

    // 执行存量历史数据无损升档（标题抽取与时间戳对齐）
    backfill_legacy_doc_meta(conn)?;

    // 登记 / 抬升 schema_version 至 v8
    // ...
}
```

而在 `backfill_legacy_doc_meta` 中：
```rust
// 查找所有 title 为空或默认空白的文档
let mut stmt = conn.prepare("SELECT doc_id FROM doc_meta WHERE length(trim(title)) = 0")?;
let doc_ids: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<Vec<_>, _>>()?;
for id in doc_ids {
    // 跨表查询 blocks 首行，截取并 UPDATE doc_meta SET title = ...
}
```

#### 严重隐患推演：
1. **违背用户意志（破坏空标题意图）**：
   用户在正常使用中，若有意将某篇笔记的标题清空（或输入了若干空格），下一次重新打开 Conex 时，由于 `migrate(conn)` 每次启动均被执行，`length(trim(title)) = 0` 再次被无情命中，用户的标题被系统强行篡改覆写为 `"未命名笔记"` 或 blocks 首行内容！这严重破坏了持久化的神圣性。
2. **启动性能降级（O(N) 循环阻塞启动主线程）**：
   若用户的存储库中积累了数百上千篇笔记与快照，每次启动桌面端都会执行一次全表扫描和遍历查询 blocks！
3. **升档逻辑未与版本号挂钩**：
   数据升档（Data Backfill）必须是**单向、一次性**的。既然已经引入了 `SCHEMA_VERSION = 8`，为什么不把回填逻辑放在 `current_version < 8` 的守卫条件之内？

#### 修正后的纯幂等 Migration 契约：
```rust
// 必须严格受控于版本抬升判断内
let current_version: i64 = conn
    .query_row("SELECT version FROM schema_version LIMIT 1", [], |r| r.get(0))
    .optional()?
    .unwrap_or(0);

if current_version < 8 {
    // 仅在从 v7 升级到 v8 时执行一次性数据回填，杜绝每次启动无条件扫表
    backfill_legacy_doc_meta(conn)?;
    conn.execute("UPDATE schema_version SET version = 8", [])?;
}
```
同时在全新的数据库建表语句中，直接将 `title TEXT NOT NULL DEFAULT ''`、`created_at INTEGER NOT NULL DEFAULT 0` 等完整列写入 `CREATE TABLE doc_meta`，新库安装直接为 v8，杜绝“先建 v1 结构再跑 5 次 ALTER TABLE”的过渡态杂音。

---

### 3.2 Rust 存储层与 Tauri `main.rs` IPC 注册的断层

PLAN-07 宣称在后端提供了 4 个命令：`note_document_list`, `note_document_create`, `note_document_rename`, `note_document_delete`。并在 3.3 节声称：
> “并在 `apps/agent-workbench/src-tauri/src/main.rs` 的 `tauri::generate_handler!` 宏列表中完成挂接。”

#### 致命挑刺：根本没有理解本仓库的编译期 IPC 宏机制！
现场核查代码 [`apps/agent-workbench/src-tauri/src/main.rs:142-152`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/main.rs#L142-L152)：
```rust
macro_rules! command_registry {
    ($(($name:literal, $path:path)),* $(,)?) => {
        pub(crate) const COMMAND_REGISTRY_NAMES: &[&str] = &[$($name),*];
        pub(crate) fn build_invoke_handler() -> Box<tauri::ipc::InvokeHandler<tauri::Wry>> {
            Box::new(tauri::generate_handler![$($path),*])
        }
    };
}
```
**仓库根本不允许开发者直接在 `tauri::generate_handler!` 里面手写函数！**
必须严格通过 `command_registry!` 宏进行二元组同源注册。更严重的是，本仓库具有刚性的 **T-F 06 通信契约铁律**：
- `COMMAND_REGISTRY_NAMES` 是编译期真源；
- `command_manifest.rs` 必须登记条目；
- `command_manifest.rs` 中的条目数量公式必须同步更新；
- 前端快照文件 `apps/crish-desktop/src/api/commandManifest.ts` **必须同步包含新命令字符串**！

若按 PLAN-07 的描述，前端快照与条目公式未更新，CI 中的 `command-contract-drift` 与 `manifest_registers_note_commands` 单元测试将立刻报红，根本无法合入！

此外，现有 `note_commands.rs` 是一个门面模块，PLAN-07 将 4 个命令实现写在子模块中，却未在 `note_commands.rs` 的 `pub use` 列表中导出，导致 `main.rs` 引用 `note_commands::note_document_list` 时直接触发 `rustc E0425 (cannot find function in module)` 编译失败。

---

### 3.3 多文档状态机 (`useNoteDocumentManager`) 内存泄漏、异步竞态与脏数据提交漏洞

审查 PLAN-07 中的前端状态机实现 [`useNoteDocumentManager.ts`](file:///c:/Software/conex/docs/diff-view-redesign/independent-plans/07-note-multi-doc-management-plan.md#L759-L850)：

```typescript
// PLAN-07 的切换文档逻辑：
const switchDoc = useCallback((docId: string) => {
  setActiveDocId(docId);
}, []);
```

#### 致命挑刺：三大运行时状态机缺陷！
1. **缺陷一：未保存脏数据静默丢失与跨文档写串染（Dirty Commit Race）**：
   - 场景：用户正在文档 A 中键入内容，输入框处于防抖（Debounce）等待提交或 IME 中文合成态；
   - 用户此时点击侧栏切换至文档 B，`switchDoc(docB)` 被立即触发，`activeDocId` 变为 `docB`；
   - **后果**：
     - 要么文档 A 尚未提交的文字随组件重新渲染被静默丢弃；
     - 要么防抖定时器触发，延迟的提交回调在闭包外层取到了新的上下文，将**属于文档 A 的正文提交到了文档 B 中**！造成毁灭性的数据污染。
2. **缺陷二：异步拉取乱序竞态（Out-of-order Hydrate Race）**：
   - 审查 [`useNoteHydrate.ts:100-122`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/useNoteHydrate.ts#L100-L122)：
     用户快速点击切换文档 A $\to$ B $\to$ C，前端发出 3 个异步 IPC 请求 `hydrate(A)`, `hydrate(B)`, `hydrate(C)`；
   - 若 `hydrate(C)` 耗时 10ms 先返回，界面渲染出 C；随后 `hydrate(B)` 耗时 50ms 迟滞返回，闭包内 `setProjection(outcome.projection)` 无差别执行，**文档 B 的正文强行覆盖了文档 C 的内容**！此时顶栏显示文档 C，正文却是文档 B！
3. **缺陷三：组件未重载导致焦点与虚拟列表滚动穿透**：
   - 若在父级渲染 `<NotePaperStrictPanel docId={activeDocId} />` 时没有显式添加 `key={activeDocId}`；
   - React 将复用组件 DOM 实例，内部 `useNotePaperStrictShell` 的 `snapshot.focusedBlockId` 残留；
   - 如果新文档恰好也有相同 ID 的块（例如历史生成的 `b_001`），焦点将异常激活；且原文档的垂直滚动条高度（`scrollTop`）将错误保留在新文档中。

#### 修复与状态机加固契约：
1. **强制引入 `flushPendingEdits` 守卫**：在 `switchDoc` 前，必须调用当前文档的持久化刷盘函数，确保内存草稿 100% 落盘；
2. **在 `useNoteHydrate` 中接入 Request Sequence Token**：
   ```typescript
   const requestSeqRef = useRef(0);
   const reload = useCallback(async () => {
     const seq = ++requestSeqRef.current;
     setStatus('loading');
     const outcome = await hydrateTransport.hydrate(docId);
     // 若当前请求序号已被更新的请求超越，则果断丢弃过期响应
     if (seq !== requestSeqRef.current) return;
     ...
   }, [docId]);
   ```
3. **在根面板显式绑定 `key={activeDocId}`**，利用 React 原生 Diff 规则实现编辑会话与滚动视口的彻底注销与纯净重挂载。

---

### 3.4 存量老笔记无损升档契约与 `doc_id` 不变性审查

存量笔记兼容性是本战役的生命线。PLAN-07 提出的原则“保持 `doc_id` 绝对不可变、兼容既有 `note:<docId>` 协议”方向完全正确。

评审官对此予以确认并通过，但强调补充一项刚性约束：
- 对于存量没有标题的历史笔记，提取首行文字作为 `title` 时，**字符截断必须基于 Unicode Grapheme Cluster（字符簇）**，严禁使用裸 `chars().take(30)` 截断中文字符或 Emoji，防止在 UTF-8 多字节序列中间截断引发乱码。

---

## 4. 伪连通、假实现与跨层通信漂移排查

### 4.1 PLAN-07 回收站机制的“伪实现”与契约断层审查

用户严厉告诫：“避免功能伪实现、伪连通。项目中的代码应该是清晰的、单轨的、最先进的代码。”

#### 现场确凿证据：
在 PLAN-07 的 4.3 节产品规划中，绘声绘色地设计了侧栏底部的回收站：
> “4. 底部归档与回收站：底部提供折叠式‘回收站’项，点击可查看已归档的旧笔记，支持恢复或物理硬删除。”

然而，在审查其 4.5 节给出的状态机核心实现代码 [`useNoteDocumentManager.ts`](file:///c:/Software/conex/docs/diff-view-redesign/independent-plans/07-note-multi-doc-management-plan.md#L765-L781) 时发现：
```typescript
// PLAN-07 的真实代码：
const refreshList = useCallback(async () => {
  try {
    const res = await noteDocumentList(false); // 固定写死 false (不包含归档文档)
    if (res.ok && res.documents) {
      setDocuments(res.documents);
      ...
```
**严重伪实现定性**：
1. 前端状态机中根本没有声明 `archivedDocuments` 数组；
2. 根本没有拉取已归档文档的逻辑；
3. 根本没有提供 `restoreDocument(docId)` 的恢复 API 和 IPC 接口；
4. 根本没有在侧栏提供展开回收站查看列表的状态切换！

这是一个典型的**“文档里画饼写了回收站，代码实现里完全没有接入”的伪实现与功能断层**！

#### 裁决收敛：
- **方案 A（完整实现）**：必须在 `useNoteDocumentManager` 中完整补充 `archivedDocuments` 状态，并在后端补充 `note_document_restore` IPC 命令；
- **方案 B（反过度设计砍项）**：若当前阶段暂不推出回收站复杂功能，则彻底从侧栏 UI 与方案中物理删除“回收站”项，删除时仅做“二次弹窗物理删除（或软删除不留 UI 入口）”，**坚决杜绝摆放一个点不开的假回收站图标欺骗用户**！

---

### 4.2 PLAN-05 与 PLAN-07 顶栏组件（`NotePaperStrictHeader`）的职责重叠与冲突

| 审查维度 | PLAN-05（32px 紧凑顶栏方案） | PLAN-07（多文档管理方案） | 冲突性质与后果 |
| :--- | :--- | :--- | :--- |
| **左侧布局** | 文档图标 + 内联标题编辑 + 保存状态微标 | 侧栏折叠开关 (`Toggle Sidebar`) + 标题内联编辑 + 快速切换下拉浮层 (`Dropdown Chevron`) | **严重冲突**：PLAN-05 遗漏了侧栏折叠按钮与快速切换下拉触点，直接实施会导致用户无法展开管理侧栏！ |
| **右侧按钮矩阵** | 字数统计 + 复制 MD + 导出 .md + 刷新 + 清空 + 关闭面板 | `+ 新建笔记` + 刷新 + 斜杠菜单 + 关闭面板 | **职责重叠**：顶栏放不下多达 8 个按钮（在分屏宽度 400px 时必换行崩溃）。 |
| **标题编辑态** | `EditableTitle`（单击/双击，ESC 取消） | `Inline Editable Title`（双击进入编辑） | 细节实现分叉，需合并为单一组件。 |

#### 首席评审官裁决收敛标准：
必须将两份方案的顶栏正交重构为单一真理组件 `NotePaperHeader`（32px）：
1. **左侧固定编排**：
   - `[≡ 侧栏开关]` (带 Tooltip `展开/折叠列表 Ctrl+\`)
   - `[📄 笔记图标]`
   - `[可编辑标题 (双击编辑，Enter 保存，Esc 取消)]`
   - `[▾ 快速切换最近文档下拉触点]`
2. **中间留白自适应**：
   - 柔和的保存状态微标（已保存 / 同步中）
3. **右侧生产力矩阵（精简为 5 个核心高频动作，其余下沉）**：
   - `[+ 新建]`（`size="sm"` 主按钮）
   - `[字数统计]`（等宽数字展示，Tooltip 展示明细）
   - `[··· 更多操作菜单]`（下拉包含：复制全文 Markdown、导出 .md 文件、安全清空内容）
   - `[刷新]`（重新投影）
   - `[关闭]`（关闭当前分屏标签）

通过将低频的“复制全文”、“导出”、“清空”收拢至 `···` 更多操作菜单，完美解决窄屏与分屏下的按钮拥挤与折行崩溃问题。

---

### 4.3 PLAN-06 底部清除与状态感知的单轨收敛

PLAN-06 提出彻底物理拔除笔记底部的两个灰色横条（`MirrorDriftStatusBar` 与 `footer`）。评审官对此完全赞同，这是提升笔记沉浸感的关键举措。

但需警惕**“过度切断导致的通信感知真空”**：
- 原 `MirrorDriftStatusBar` 虽然丑陋，但它承载了检测本地磁盘 Markdown 镜像是否被外部程序（如 VS Code / Obsidian）修改的功能（`mirror_drift`）。
- 切断无用的高频轮询后，如果用户确实在外部修改了文件，如何感知？
- **单轨收敛**：外部变更由既有的文件监视事件（File Watcher Event）单向被动推送，当发生冲突时，在顶栏标题右侧以柔和的琥珀色微标（`external drift`）进行提示，而不是在正文下方霸占一个 100px 的灰色横条。

---

### 4.4 PLAN-01 与 PLAN-04 的样式选择器脱节排查

- PLAN-04 的清剿清单（`04-hover-tokens-standardization-plan.md:80-88`）大量列出了针对 `.accordionItem`、`.accordionActive`、`.fileItem` 的样式修复；
- 而 PLAN-01 将这些类名全面重构为 `.flatFileList`、`.fileNode`、`.fileRow`；
- **排查结论**：在实施阶段，必须以 PLAN-01 提出的新类名为基准直接应用 PLAN-04 的 Single Layer of Hover Truth（SLoHT）原则，**严禁在旧选择器上修修补补后再被新选择器覆盖造成死代码残留**。

---

## 5. 架构改进红线与必修清单（Blocking Issues）

在进入阶段四（实施方案收敛与最终计划制定）之前，以下 6 项阻断级架构隐患（P0 Blocking Issues）必须作为必修项予以刚性采纳与纠正：

```
====================================================================================================
                        阶段三评审裁决：6 大阻断级架构隐患 (P0 Blocking Issues)
====================================================================================================
[BLOCK-01] 强行统一 DIFF 文件行正交 DOM 结构，废黜 PLAN-01 大 Button，解耦展开与文件名超链接；
[BLOCK-02] 加固 openFileViewerInSession，建立以归一化路径为唯一键的 Canonical Tab ID，杜绝 Duplicate Tab；
[BLOCK-03] 修复 normalizeViewerFilePath，强制收敛 Windows 驱动器盘符为统一大写，保护 UNC 路径；
[BLOCK-04] SQLite Migration v8 数据回填严格封口在 current_version < 8 内部，新库直接建全量表；
[BLOCK-05] 补齐 Tauri command_registry! 宏、command_manifest 与前端 commandManifest.ts 快照；
[BLOCK-06] 多文档状态机引入 beforeSwitch 脏数据落盘拦截与 useNoteHydrate 请求序号过期抛弃机制。
====================================================================================================
```

### 5.1 六大阻断级必修项明细表

#### 1. 【BLOCK-01】Diff 文件行正交 DOM 结构锁定
- **责任方案**：PLAN-01 / PLAN-02 / PLAN-03 联合收敛
- **必修要求**：在 `DiffCardFileList.tsx` 中，单行最外层为 `div.fileRow`（高度死锁 32px，直角，无内联边框）。Chevron 展开折叠按钮与文件名超链接按钮为兄弟节点，各自独立绑定 `onClick`，严禁外层嵌套 `button`。

#### 2. 【BLOCK-02】独立预览 Tab 唯一性与 Canonical ID 契约
- **责任方案**：PLAN-03 / `openTool.ts`
- **必修要求**：`dock.openPanelIds` 中 Tab 的存储标识必须为规范化的物理路径 `file-viewer:${normalizedPath}`。查询参数 `?mode=diff` 仅作为打开时的意图透传，不能作为 Tab 唯一键参与 `includes` 判定，彻底杜绝重复 Tab。

#### 3. 【BLOCK-03】Windows 路径归一化健壮性断言
- **责任方案**：PLAN-03 / `normalizeViewerPath.ts`
- **必修要求**：必须在 `normalizeViewerPath.ts` 单元测试中加入测试用例：
  - `c:/foo/bar.ts` $\to$ `C:/foo/bar.ts`（盘符统一大写）
  - `./src/main.ts` $\to$ `C:/workspace/src/main.ts`（消除前导 `./`）
  - `//wsl.localhost/Ubuntu/file.txt` $\to$ 保持 UNC 双斜杠不被压缩。

#### 4. 【BLOCK-04】SQLite 迁移纯幂等性与版本守卫
- **责任方案**：PLAN-07 / `crates/conex-workspace-store/src/migrate.rs`
- **必修要求**：`backfill_legacy_doc_meta` 必须移入 `if current_version < 8` 判定块中；全新数据库 `CREATE TABLE doc_meta` 必须原生包含全部 8 列。

#### 5. 【BLOCK-05】Tauri 命令宏注册与全链路 Manifest 一致性
- **责任方案**：PLAN-07 / `apps/agent-workbench/src-tauri/`
- **必修要求**：
  1. `main.rs` 使用 `command_registry![( "note_document_list", note_commands::note_document_list ), ...]`；
  2. `note_commands.rs` 门面增加对应函数的 `pub use` 导出；
  3. 同步更新 `command_manifest.rs` 与前端 `commandManifest.ts`，确保 `command-contract-drift` 门禁 100% 绿灯。

#### 6. 【BLOCK-06】多文档切换脏数据拦截与异步竞态消除
- **责任方案**：PLAN-07 / `useNoteDocumentManager.ts` / `useNoteHydrate.ts`
- **必修要求**：
  1. 切换文档前强制触发当前文档的保存/失焦；
  2. `useNoteHydrate` 使用递增 Token 丢弃乱序响应；
  3. 宿主渲染面板时显式绑定 `key={activeDocId}`。

---

### 5.2 实施执行守则（架构单轨性保证）

所有子 Agent 与后续执行步骤必须恪守：
1. **单一真理路径（SSOT）**：同一个功能只允许存在一条执行链路。右侧 Dock 是独立文件预览的唯一合法容器，`NoteLeafHost` 是笔记纸面的唯一合法挂载宿主；
2. **净代码削减（Net Negative LOC）**：本次重构必须伴随大面积死代码、死样式、死测试用例的物理删除，杜绝留下任何 `// TODO`、`display: none` 或伪实现补丁；
3. **立体验证（Full Stack Verification）**：重构完成后必须按顺序跑通：
   - `npm run typecheck`（TypeScript 静态检查零报错）
   - `npm run check:line-counts`（单文件行数严格达标）
   - `npx vitest run`（全量单元测试绿灯）
   - `cargo test --workspace`（Rust 内核测试绿灯）
   - `127.0.0.1:4000` Tauri MCP 真实应用现场验收。

---
*本独立评审报告编制完成，已确凿固定 6 大阻断级架构隐患，为阶段四总方案收敛提供权威基准。*
