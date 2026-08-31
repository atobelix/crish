# Conex / Crish 界面视觉与差异面板重构独立方案 03
# —— 差异面板容器到原子元素全链路重构落地方案

> **文档标识**：`docs/ui-style-refactor/independent-plans/03-diff-panel-layout-and-syntax-highlighting-plan.md`  
> **战役归属**：UI 视觉样式与差异面板重构战役（专项实施方案 03）  
> **架构专家**：差异面板全链路布局与语法高亮重构总架构师（Diff Panel Specialist）  
> **核心遵循**：
> - `docs/ui-style-refactor/00-定案-视觉样式与差异面板重构决策.md`（DEL-16 ~ DEL-23）
> - `docs/ui-style-refactor/audits/02-diff-panel-layout-and-style-audit.md`（BUG-01 ~ BUG-18）
> - `AGENTS.md` §13（输入框与焦点态 / 克制边框 ≤10% / 柔和对比度）、§14（现代色彩空间与语义 Tokens）
> - W3C WCAG 2.2 AA / AAA 工业级对比度基准、VS Code / GitHub Diff 双栏对齐规范

---

## 目录索引

1. [方案愿景与核心重构目标矩阵](#1-方案愿景与核心重构目标矩阵)
2. [【强制专节】本方案删除面与收敛清单（Deletion Surface）](#2-强制专节本方案删除面与收敛清单deletion-surface)
3. [五大核心技术架构与落地重构方案](#3-五大核心技术架构与落地重构方案)
   - [3.1 真实语法高亮与词法分段（Intraline）高亮全链路接通](#31-真实语法高亮与词法分段intraline高亮全链路接通)
   - [3.2 `<widget-diff>` Hunk 对偶配对与占位行对齐算法](#32-widget-diff-hunk-对偶配对与占位行对齐算法)
   - [3.3 容器弹性视口重构（消灭 380px 锁死与解除滚轮劫持）](#33-容器弹性视口重构消灭-380px-锁死与解除滚轮劫持)
   - [3.4 比对底板重塑与 WCAG AAA 色彩阶梯](#34-比对底板重塑与-wcag-aaa-色彩阶梯)
   - [3.5 折叠条尺寸对齐与 32px 紧凑工具栏 / Commit CTA 重塑](#35-折叠条尺寸对齐与-32px-紧凑工具栏--commit-cta-重塑)
4. [修改文件清单与 TSX / CSS 落地代码契约](#4-修改文件清单与-tsx--css-落地代码契约)
   - [4.1 契约 1：`tokens.css`（全局 `--diff-*` 设计变量体系）](#41-契约-1tokenscss全局---diff--设计变量体系)
   - [4.2 契约 2：`DiffCardUnifiedView.tsx`（真实高亮与词法合成器）](#42-契约-2diffcardunifiedviewtsx真实高亮与词法合成器)
   - [4.3 契约 3：`DiffCardSplitView.tsx`（真实高亮与分栏等高对齐）](#43-契约-3diffcardsplitviewtsx真实高亮与分栏等高对齐)
   - [4.4 契约 4：`VirtualPlainCodeViewer.tsx`（纯源码真实语法高亮与对齐）](#44-契约-4virtualplaincodeviewertsx纯源码真实语法高亮与对齐)
   - [4.5 契约 5：`WidgetDiff.tsx`（对偶配对器重构与语法高亮）](#45-契约-5widgetdifftsx对偶配对器重构与语法高亮)
   - [4.6 契约 6：`custom-tags.module.css`（占位行与 Token 收敛）](#46-契约-6custom-tagsmodulecss占位行与-token-收敛)
   - [4.7 契约 7：`DiffCard.module.css`（物理拔除死代码与弹性布局）](#47-契约-7diffcardmodulecss物理拔除死代码与弹性布局)
   - [4.8 契约 8：`DiffCardGitActions.tsx`（Commit CTA 视觉层级提升）](#48-契约-8diffcardgitactionstsxcommit-cta-视觉层级提升)
   - [4.9 契约 9：`DiffHeaderControls.tsx`（窄屏响应式与防截断）](#49-契约-9diffheadercontrolstsx窄屏响应式与防截断)
   - [4.10 契约 10：`ToolCallDiffPreview.tsx` & `ChatToolCallBlock.module.css`（Token 归一）](#410-契约-10toolcalldiffpreviewtsx--chattoolcallblockmodulecsstoken-归一)
5. [反退化自动化测试套件设计](#5-反退化自动化测试套件设计)
6. [四阶段实施 DAG 与全量战役验收断言](#6-四阶段实施-dag-与全量战役验收断言)

---

## 1. 方案愿景与核心重构目标矩阵

差异比对面板（Diff Panel）是 Conex / Crish 的核心生产力引擎。本方案依据定案决策总纲，全面清除历史技术债务，实现**从宏观弹性容器到微观代码 Token 词法高亮的全链路工业级重塑**：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                      差异比对面板全链路重构技术矩阵（Before vs After）                  │
├─────────────────┬───────────────────────────────┬──────────────────────────────────────┤
│ 核心技术领域     │ 现状缺陷诊断 (Before)         │ 终态架构契约 (After)                 │
├─────────────────┼───────────────────────────────┼──────────────────────────────────────┤
│ 1. 语法高亮体系 │ • highlightCode(..., 'diff')  │ • 基于 langFromFilename 推导真实语言  │
│                 │ • 100% 代码退化为灰黑纯文本   │ • 词法比对 (Intraline) 分段高亮保持  │
│                 │ • Plain 视图完全无语法高亮    │ • Plain / Unified / Split 100% 高亮  │
├─────────────────┼───────────────────────────────┼──────────────────────────────────────┤
│ 2. 分栏对齐算法 │ • <widget-diff> 双侧独立过滤  │ • 引入 Hunk 对偶配对器 + 空占位行    │
│                 │ • 左右行号与内容严重纵向错位  │ • 左右列绝对 1:1 等高对齐，无错位   │
├─────────────────┼───────────────────────────────┼──────────────────────────────────────┤
│ 3. 容器视口与滚动│ • .scrollParent 写死 380px     │ • 弹性自适应 (44px ~ min(520px, 60vh))│
│                 │ • 小 diff 空白大，大 diff 拥挤│ • 解除 overscroll-behavior 滚轮劫持   │
├─────────────────┼───────────────────────────────┼──────────────────────────────────────┤
│ 4. 底板与对比度 │ • .linesContainer #f4f5f7 脏灰│ • 纯白卡片底板 (--diff-bg-pane: #fff)│
│                 │ • Gutter 与代码区斑驳色差     │ • 增删色阶提升至 WCAG AAA (6.8/7.1)  │
├─────────────────┼───────────────────────────────┼──────────────────────────────────────┤
│ 5. 工具栏与交互 │ • 32px 工具栏窄屏按钮被截断   │ • 弹性收缩 + Container Query 响应式  │
│                 │ • 折叠条 22px 暴力削顶截断文字│ • 折叠条内边距重整，22px 垂直居中    │
│                 │ • Commit 按钮为幽灵低对比度   │ • 墨绿 Primary CTA + Ctrl+Enter 快捷 │
└─────────────────┴───────────────────────────────┴──────────────────────────────────────┘
```

---

## 2. 【强制专节】本方案删除面与收敛清单（Deletion Surface）

本专节严格对齐 `00-定案-视觉样式与差异面板重构决策.md` §二.3（DEL-16 ~ DEL-23），明确在实施阶段必须物理删除与彻底收敛的死层、硬编码和废弃逻辑：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                  差异面板专项删除面与物理拔除清单 (DEL-16 ~ DEL-23)                    │
├────────┬───────────────────────────────┬───────────────────────────────────────────────┤
│ 编号   │ 物理定位                      │ 物理删除 / 拔除操作具体内容                   │
├────────┼───────────────────────────────┼───────────────────────────────────────────────┤
│ DEL-16 │ DiffCard.module.css:757-766   │ 彻底删除 height: 380px; max-height: 380px;   │
│        │                               │ 固定高度锁死，替换为弹性 min/max-height       │
├────────┼───────────────────────────────┼───────────────────────────────────────────────┤
│ DEL-17 │ DiffCard.module.css:211, 760  │ 彻底删除 .fileList 与 .scrollParent 中的      │
│        │                               │ overscroll-behavior: contain 滚轮劫持声明     │
├────────┼───────────────────────────────┼───────────────────────────────────────────────┤
│ DEL-18 │ DiffCardUnifiedView.tsx:209   │ 彻底删除 highlightCode(..., 'diff') 伪传参，  │
│        │ DiffCardSplitView.tsx:208,228 │ 改为 langFromFilename(filePath) 真实语言注入  │
├────────┼───────────────────────────────┼───────────────────────────────────────────────┤
│ DEL-19 │ WidgetDiff.tsx:227-261        │ 彻底删除左侧 filter(!=add) 与右侧            │
│        │                               │ filter(!=delete) 的伪分栏双侧独立过滤错位逻辑 │
├────────┼───────────────────────────────┼───────────────────────────────────────────────┤
│ DEL-20 │ DiffCard.module.css:1076-1300 │ 彻底删除 300+ 行已废弃的单文件 Tab 页与独立  │
│        │ DiffCard.module.css:1399-1558 │ 详情工具栏死代码（如 .detailedTabPane 等）    │
├────────┼───────────────────────────────┼───────────────────────────────────────────────┤
│ DEL-21 │ DiffCard.module.css:691, 707  │ 彻底删除硬编码 rgba(0, 0, 0, 0.05) 与         │
│        │ DiffCard.module.css:1090,1311 │ rgba(0, 0, 0, 0.02) 降级色（暗色下为黑脏斑） │
├────────┼───────────────────────────────┼───────────────────────────────────────────────┤
│ DEL-22 │ DiffCard.module.css:775       │ 彻底删除 .linesContainer 的 background:       │
│        │                               │ var(--bg-primary)（#f4f5f7 脏灰底覆盖）       │
├────────┼───────────────────────────────┼───────────────────────────────────────────────┤
│ DEL-23 │ tokens.css:590                │ 彻底删除无任何组件消费的                      │
│        │                               │ --diff-gutter-width: 48px 僵尸 Token          │
└────────┴───────────────────────────────┴───────────────────────────────────────────────┘
```

---

## 3. 五大核心技术架构与落地重构方案

### 3.1 真实语法高亮与词法分段（Intraline）高亮全链路接通

#### 1. 根因与技术断层
`highlight.js` 的 `diff` 语言解析器仅匹配以 `+`、`-`、`@@`、`***` 开头的整行内容。当视图提取出纯净代码 `change.content`（已剥离前缀）并传入 `highlightCode(change.content, 'diff')` 时，highlight.js 因无法匹配任何标记而原样返回纯文本，导致面板中 100% 的 TypeScript、Rust、Python、CSS 代码丧失语法高亮。

#### 2. 真实语言推导（Language Detection Pipeline）
在查看器入口通过 `langFromFilename(filePath)` 动态获取语言代号：

```mermaid
graph LR
    Path[filePath: "src/store/user.ts"] --> Lang[langFromFilename -> 'typescript']
    Lang --> Unified[DiffCardUnifiedView]
    Lang --> Split[DiffCardSplitView]
    Lang --> Plain[VirtualPlainCodeViewer]
    Unified --> High[highlightCode(code, 'typescript')]
    Split --> High
    Plain --> High
```

#### 3. 词法分段（Intraline Diff）语法高亮合成器
当发生行内局部修改时，既要展示修改部分的高亮背景块（`.diffWordAdd` / `.diffWordDel`），又不能破坏整行的语法颜色：

```typescript
/**
 * 词法比对分段语法高亮渲染器
 * 保持 token 自身语法色彩的同时，对修改目标 token 施加背景高亮包裹
 */
export function renderHighlightedTokens(
  tokens: DiffWordToken[],
  targetType: 'added' | 'removed',
  lang: string
): React.ReactNode {
  return (
    <>
      {tokens.map((tok, i) => {
        const isTarget = tok.type === targetType;
        const highlightedHtml = highlightCode(tok.text, lang);
        if (isTarget) {
          return (
            <span
              key={i}
              className={targetType === 'added' ? styles.diffWordAdd : styles.diffWordDel}
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
            />
          );
        }
        return (
          <span
            key={i}
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        );
      })}
    </>
  );
}
```

---

### 3.2 `<widget-diff>` Hunk 对偶配对与占位行对齐算法

#### 1. 错位根因分析
旧实现直接对 `parsedLines` 进行双侧独立 `.filter()`，若左侧过滤掉了第 1 行（add），左侧第 1 个渲染槽位就会展示文件的第 2 行，与右侧第 1 行直接错开，产生灾难性的“左看前朝、右看当代”严重纵向漂移。

#### 2. 对偶配对算法设计（Dual Line-Pair Matcher）
将线性差异行切分为语义修改块（Modification Chunks），将修改块内的删除行与新增行逐对配对，多余行填充 `null` 占位槽：

```typescript
export interface SplitLinePair {
  left: ParsedDiffLine | null;
  right: ParsedDiffLine | null;
}

export function buildSplitLinePairs(lines: ParsedDiffLine[]): SplitLinePair[] {
  const pairs: SplitLinePair[] = [];
  let i = 0;

  while (i < lines.length) {
    const cur = lines[i];
    if (!cur) break;

    // 1. 上下文行与 Hunk Header：左右同行对齐
    if (cur.type === 'context') {
      pairs.push({ left: cur, right: cur });
      i++;
      continue;
    }

    // 2. 收集连续的变动块（Deletion 组与 Addition 组）
    const delGroup: ParsedDiffLine[] = [];
    const addGroup: ParsedDiffLine[] = [];

    while (i < lines.length && (lines[i].type === 'delete' || lines[i].type === 'add')) {
      if (lines[i].type === 'delete') {
        delGroup.push(lines[i]);
      } else {
        addGroup.push(lines[i]);
      }
      i++;
    }

    // 3. 对偶配对：取两组最大长度，短侧填充 null 占位行
    const maxLen = Math.max(delGroup.length, addGroup.length);
    for (let k = 0; k < maxLen; k++) {
      pairs.push({
        left: delGroup[k] || null,
        right: addGroup[k] || null,
      });
    }
  }

  return pairs;
}
```

#### 3. 渲染槽位视觉等高保障
在 CSS Grid 分栏下，当左侧或右侧为 `null` 时，渲染带有 `.diffLineEmpty` 类名的等高空行，确保左右行高 100% 绝对一致。

---

### 3.3 容器弹性视口重构（消灭 380px 锁死与解除滚轮劫持）

#### 1. 弹性视口契约
彻底废除写死的 `height: 380px`，定义由内容驱动的智能自适应尺寸：

$$\text{Height} = \text{clamp}(44\text{px}, \text{ContentHeight}, \min(520\text{px}, 60\text{vh}))$$

```css
.scrollParent {
  min-height: 44px; /* 容纳至少 2 行 */
  max-height: min(520px, 60vh);
  height: auto;
  overflow-y: auto;
  position: relative;
  background: var(--diff-bg-pane);
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  overscroll-behavior: auto; /* 解除滚轮劫持，允许外层自然滚动 */
}
```

#### 2. 解除滚轮劫持（Scroll Chain De-isolation）
将 `.fileList` 与 `.scrollParent` 中的 `overscroll-behavior: contain` 移除，恢复为 `overscroll-behavior: auto`。当用户在代码区域内部滚动到顶/底时，滚轮事件平滑传递至外部手风琴列表，彻底根除鼠标移入代码块即“卡死”的恶劣体验。

---

### 3.4 比对底板重塑与 WCAG AAA 色彩阶梯

#### 1. 纯白卡片底与清爽层级
彻底清除 `.linesContainer` 上的 `--bg-primary`（`#f4f5f7`）脏灰覆盖，建立以 `--bg-card`（`#ffffff`）为底座的标准层级：

```
[ 外层容器 (.panel) : --bg-card #ffffff ]
  └─ [ 手风琴条目 (.accordionItem) : 1px 细线 border-subtle ]
       └─ [ 视口容器 (.scrollParent) : --diff-bg-pane #ffffff ]
            └─ [ 行号槽 (.gutterNum) : --diff-gutter-bg (2.5% 柔和混入) ]
            └─ [ 代码区 (.lineText) : --diff-text-normal #111111 (纯黑高对比) ]
```

#### 2. WCAG AAA 达标色阶对照表

| 状态类型 | 属性 | Light 模式基准 | Dark 模式基准 | WCAG 对比度（Light） | WCAG 对比度（Dark） |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **底板** | `pane-bg` | `#ffffff`（纯白卡底） | `hsl(0 0% 10%)` | — | — |
| **Gutter**| `gutter-bg` | `color-mix(3% text, white)` | `hsl(0 0% 11%)` | — | — |
| **正常行**| `text-normal`| `hsl(0 0% 7%)`（#111111）| `hsl(0 0% 92%)` | **18.5:1 (AAA)** | **14.2:1 (AAA)** |
| **新增行**| `add-bg` | `hsl(142 60% 45% / 0.10)` | `hsl(142 50% 45% / 0.16)` | — | — |
| **新增字**| `add-fg` | `hsl(142 70% 24%)` | `hsl(142 75% 75%)` | **6.8:1 (AA/AAA)** | **8.5:1 (AAA)** |
| **新增词**| `add-word-bg`| `hsl(142 65% 42% / 0.28)` | `hsl(142 55% 45% / 0.38)` | — | — |
| **删除行**| `del-bg` | `hsl(0 75% 55% / 0.10)` | `hsl(0 70% 50% / 0.16)` | — | — |
| **删除字**| `del-fg` | `hsl(0 72% 38%)` | `hsl(0 85% 78%)` | **7.1:1 (AAA)** | **7.5:1 (AAA)** |
| **删除词**| `del-word-bg`| `hsl(0 75% 50% / 0.26)` | `hsl(0 75% 50% / 0.38)` | — | — |

---

### 3.5 折叠条尺寸对齐与 32px 紧凑工具栏 / Commit CTA 重塑

#### 1. 折叠条（`.collapseBar`）物理高度精准对齐
- 拔除行内 `maxHeight: 22px` 与 CSS 内边距 `padding: 8px 12px` 的物理冲突；
- 统一锁定单行高度 `22px`，内边距设置为 `0 12px`，文字垂直居中，彻底根除削顶截断。

#### 2. 32px 紧凑工具栏响应式治理
- 在容器宽度 $< 400\text{px}$ 时，下拉框最大宽度自动收缩至 `120px`；
- 确保右侧分栏切换、搜索、清空列表等操作按钮不被硬截断。

#### 3. Commit 面板行动点强化
- 提交按钮从幽灵态升级为醒目的 `variant="primary"` 墨绿色；
- 增加当提交信息为空且无暂存文件时的 `disabled` 防误触校验；
- 强化 `Ctrl+Enter` / `Cmd+Enter` 快捷键提交响应。

---

## 4. 修改文件清单与 TSX / CSS 落地代码契约

### 修改文件清单（Affected Files Manifest）

```
apps/crish-desktop/src/
├── styles/
│   └── tokens.css                                          [修改：更新 --diff-* 变量体系]
├── components/
│   ├── diff/
│   │   ├── DiffCardUnifiedView.tsx                         [重构：语言推导 + 词法高亮]
│   │   ├── DiffCardSplitView.tsx                           [重构：语言推导 + 词法高亮]
│   │   ├── VirtualPlainCodeViewer.tsx                      [重构：全量高亮 + 白底]
│   │   ├── DiffCard.module.css                             [重构：拔除死代码 + 弹性视口]
│   │   ├── DiffCardGitActions.tsx                          [重构：Commit CTA 升级]
│   │   └── DiffHeaderControls.tsx                          [优化：响应式防截断]
│   ├── custom-tags/
│   │   ├── WidgetDiff.tsx                                  [重构：对偶配对器 + 真实高亮]
│   │   └── custom-tags.module.css                          [修改：占位行 + Token 归一]
│   └── chat-tool-call/
│       ├── ToolCallDiffPreview.tsx                         [优化：Token 归一]
│       └── ChatToolCallBlock.module.css                    [修改：消灭硬编码]
```

---

### 4.1 契约 1：`tokens.css`（全局 `--diff-*` 设计变量体系）

```css
/* ==========================================================================
   Diff 比对面板标准 Design Tokens (Light 模式重构)
   ========================================================================== */
:root, html[data-theme='light'] {
  /* 基础底板与 Gutter (卡片白底基调) */
  --diff-bg-pane: var(--bg-card, #ffffff);
  --diff-bg-header: color-mix(in srgb, var(--text-primary) 3%, var(--bg-card));
  --diff-gutter-bg: color-mix(in srgb, var(--text-primary) 2.5%, var(--bg-card));
  --diff-gutter-fg: var(--text-tertiary, #696969);
  --diff-gutter-width-unified: 40px;
  --diff-gutter-width-split: 36px;
  --diff-gutter-marker-width: 20px;
  --diff-line-height: 22px;

  /* 增量行 (Addition) */
  --diff-add-bg: hsl(142 60% 45% / 0.10);
  --diff-add-border: hsl(142 70% 40% / 0.35);
  --diff-add-fg: hsl(142 70% 24%); /* 6.8:1 WCAG AA */
  --diff-add-word-bg: hsl(142 65% 42% / 0.28);
  --diff-add-gutter-bg: hsl(142 60% 45% / 0.16);
  --diff-add-gutter-fg: hsl(142 70% 28%);

  /* 删减行 (Deletion) */
  --diff-del-bg: hsl(0 75% 55% / 0.10);
  --diff-del-border: hsl(0 80% 55% / 0.35);
  --diff-del-fg: hsl(0 72% 38%);   /* 7.1:1 WCAG AAA */
  --diff-del-word-bg: hsl(0 75% 50% / 0.26);
  --diff-del-gutter-bg: hsl(0 75% 55% / 0.16);
  --diff-del-gutter-fg: hsl(0 72% 40%);

  /* 文本与边框 */
  --diff-text-normal: var(--text-primary, #111111);
  --diff-split-divider: var(--border-subtle);
  --diff-split-header-bg: color-mix(in srgb, var(--text-primary) 2%, var(--bg-card));
  --diff-split-header-fg: var(--text-secondary);
}

/* ==========================================================================
   Diff 比对面板标准 Design Tokens (Dark 模式重构)
   ========================================================================== */
html[data-theme='dark'] {
  --diff-bg-pane: hsl(0 0% 10%);
  --diff-bg-header: hsl(0 0% 12%);
  --diff-gutter-bg: hsl(0 0% 11%);
  --diff-gutter-fg: hsl(0 0% 55%);

  --diff-add-bg: hsl(142 50% 45% / 0.16);
  --diff-add-border: hsl(142 70% 45% / 0.45);
  --diff-add-fg: hsl(142 75% 75%); /* 8.5:1 WCAG AAA */
  --diff-add-word-bg: hsl(142 55% 45% / 0.38);
  --diff-add-gutter-bg: hsl(142 50% 45% / 0.22);
  --diff-add-gutter-fg: hsl(142 65% 75%);

  --diff-del-bg: hsl(0 70% 50% / 0.16);
  --diff-del-border: hsl(0 80% 55% / 0.45);
  --diff-del-fg: hsl(0 85% 78%);   /* 7.5:1 WCAG AAA */
  --diff-del-word-bg: hsl(0 75% 50% / 0.38);
  --diff-del-gutter-bg: hsl(0 70% 50% / 0.22);
  --diff-del-gutter-fg: hsl(0 80% 78%);

  --diff-text-normal: hsl(0 0% 92%);
  --diff-split-divider: hsl(0 0% 18%);
  --diff-split-header-bg: hsl(0 0% 9%);
  --diff-split-header-fg: hsl(0 0% 70%);
}
```

---

### 4.2 契约 2：`DiffCardUnifiedView.tsx`（真实高亮与词法合成器）

```tsx
import React, { useMemo } from 'react';
import * as Lucide from 'lucide-react';
import styles from './DiffCard.module.css';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { useVirtualScroll } from '../../hooks/useVirtualScroll';
import type { FileDiff } from '../../store/types';
import type { ChangeRenderItem, PlaceholderRenderItem } from './diffCardTypes';
import { highlightCode, langFromFilename } from '../../api/codeHighlight';
import {
  computeIntralinePair,
  type DiffWordToken,
} from '../../api/intralineDiff';

type UnifiedRenderItem = PlaceholderRenderItem | ChangeRenderItem;

function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '') || p;
}

function renderTokens(
  tokens: DiffWordToken[],
  targetType: 'added' | 'removed',
  fallbackText: string,
  lang: string
) {
  if (!tokens || tokens.length === 0) {
    return (
      <span
        dangerouslySetInnerHTML={{
          __html: highlightCode(fallbackText, lang),
        }}
      />
    );
  }
  return (
    <>
      {tokens.map((tok, i) => {
        const isTarget = tok.type === targetType;
        const highlightedHtml = highlightCode(tok.text, lang);
        if (isTarget) {
          return (
            <span
              key={i}
              className={
                targetType === 'added' ? styles.diffWordAdd : styles.diffWordDel
              }
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
            />
          );
        }
        return (
          <span
            key={i}
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        );
      })}
    </>
  );
}

interface DiffCardUnifiedViewProps {
  f: FileDiff;
  renderItems: UnifiedRenderItem[];
  onExpandBlock: (filePath: string, startIndex: number) => void;
}

export const DiffCardUnifiedView: React.FC<DiffCardUnifiedViewProps> = ({
  f,
  renderItems,
  onExpandBlock,
}) => {
  const totalItems = renderItems.length;
  const { containerRef, scrollTop, containerHeight, onScroll } =
    useVirtualScroll({
      itemCount: totalItems,
      heightOnly: true,
    });
  const rowHeight = 22;
  const totalHeight = totalItems * rowHeight;

  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - 15);
  const endIndex = Math.min(
    totalItems,
    Math.ceil((scrollTop + containerHeight) / rowHeight) + 15
  );

  const visibleItems = renderItems.slice(startIndex, endIndex);
  const offsetTop = startIndex * rowHeight;

  // 根据文件名动态推导语言高亮
  const codeLang = useMemo(() => langFromFilename(f.filePath), [f.filePath]);

  return (
    <AppErrorBoundary variant="compact" title="变更对比出错">
      <div
        ref={containerRef}
        className={styles.scrollParent}
        onScroll={onScroll}
        tabIndex={0}
        style={{ position: 'relative', overflowY: 'auto', outline: 'none' }}
      >
        <div
          style={{
            height: `${totalHeight}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          <div
            className={styles.linesContainer}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(${offsetTop}px)`,
              background: 'transparent',
            }}
            aria-label={`${basename(f.filePath)} 的变更内容`}
          >
            {visibleItems.map((item, localIdx) => {
              const globalIdx = startIndex + localIdx;
              if (item.isCollapsedPlaceholder) {
                return (
                  <div
                    key={`${f.filePath}-collapse-${item.startIndex}`}
                    className={styles.collapseBar}
                    onClick={() => onExpandBlock(f.filePath, item.startIndex)}
                  >
                    <Lucide.Maximize2
                      size={12}
                      className={styles.collapseIcon}
                    />
                    <span>展开其余 {item.count} 行代码...</span>
                  </div>
                );
              }
              const { change, oldLine, newLine, isHeader } = item.item;
              if (isHeader) return null;

              let lineClass = styles.lineNormal;
              let marker = ' ';
              let tokens: DiffWordToken[] | null = null;
              let targetType: 'added' | 'removed' = 'added';

              if (change.type === 'addition') {
                lineClass = styles.lineAddition;
                marker = '+';
                targetType = 'added';

                const prevItem =
                  globalIdx > 0 ? renderItems[globalIdx - 1] : null;
                if (
                  prevItem &&
                  !prevItem.isCollapsedPlaceholder &&
                  prevItem.item.change.type === 'deletion'
                ) {
                  const pairResult = computeIntralinePair(
                    prevItem.item.change.content,
                    change.content
                  );
                  tokens = pairResult.newTokens;
                }
              } else if (change.type === 'deletion') {
                lineClass = styles.lineDeletion;
                marker = '−';
                targetType = 'removed';

                const nextItem =
                  globalIdx + 1 < renderItems.length
                    ? renderItems[globalIdx + 1]
                    : null;
                if (
                  nextItem &&
                  !nextItem.isCollapsedPlaceholder &&
                  nextItem.item.change.type === 'addition'
                ) {
                  const pairResult = computeIntralinePair(
                    change.content,
                    nextItem.item.change.content
                  );
                  tokens = pairResult.oldTokens;
                }
              }

              const oldLineNum = oldLine !== undefined ? String(oldLine) : '';
              const newLineNum = newLine !== undefined ? String(newLine) : '';
              const stableKey = `${f.filePath}:${f.oldPath || ''}:${oldLineNum || 'del'}:${newLineNum || 'add'}:${globalIdx}`;

              return (
                <div
                  key={stableKey}
                  className={`${styles.line} ${lineClass}`}
                  style={{ minHeight: `${rowHeight}px` }}
                >
                  <div className={styles.gutterNum} data-num={oldLineNum}>
                    {oldLineNum}
                  </div>
                  <div className={styles.gutterNum} data-num={newLineNum}>
                    {newLineNum}
                  </div>
                  <div className={styles.gutterMarker}>{marker}</div>
                  <div className={styles.lineText}>
                    {tokens ? (
                      renderTokens(tokens, targetType, change.content, codeLang)
                    ) : (
                      <span
                        dangerouslySetInnerHTML={{
                          __html: highlightCode(change.content, codeLang),
                        }}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </AppErrorBoundary>
  );
};
```

---

### 4.3 契约 3：`DiffCardSplitView.tsx`（真实高亮与分栏等高对齐）

```tsx
import React, { useMemo } from 'react';
import * as Lucide from 'lucide-react';
import styles from './DiffCard.module.css';
import { AppErrorBoundary } from '../AppErrorBoundary';
import { useVirtualScroll } from '../../hooks/useVirtualScroll';
import type { FileDiff } from '../../store/types';
import type {
  SplitChangeRenderItem,
  PlaceholderRenderItem,
} from './diffCardTypes';
import { highlightCode, langFromFilename } from '../../api/codeHighlight';
import {
  computeIntralinePair,
  type DiffWordToken,
} from '../../api/intralineDiff';

type SplitRenderItem = PlaceholderRenderItem | SplitChangeRenderItem;

function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '') || p;
}

function renderTokens(
  tokens: DiffWordToken[],
  targetType: 'added' | 'removed',
  fallbackText: string,
  lang: string
) {
  if (!tokens || tokens.length === 0) {
    return (
      <span
        dangerouslySetInnerHTML={{
          __html: highlightCode(fallbackText, lang),
        }}
      />
    );
  }
  return (
    <>
      {tokens.map((tok, i) => {
        const isTarget = tok.type === targetType;
        const highlightedHtml = highlightCode(tok.text, lang);
        if (isTarget) {
          return (
            <span
              key={i}
              className={
                targetType === 'added' ? styles.diffWordAdd : styles.diffWordDel
              }
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
            />
          );
        }
        return (
          <span
            key={i}
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        );
      })}
    </>
  );
}

interface DiffCardSplitViewProps {
  f: FileDiff;
  renderItems: SplitRenderItem[];
  onExpandBlock: (filePath: string, startIndex: number) => void;
}

export const DiffCardSplitView: React.FC<DiffCardSplitViewProps> = ({
  f,
  renderItems,
  onExpandBlock,
}) => {
  const totalItems = renderItems.length;
  const { containerRef, scrollTop, containerHeight, onScroll } =
    useVirtualScroll({
      itemCount: totalItems,
      heightOnly: true,
    });
  const rowHeight = 22;
  const totalHeight = totalItems * rowHeight;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - 15);
  const endIndex = Math.min(
    totalItems,
    Math.ceil((scrollTop + containerHeight) / rowHeight) + 15
  );

  const visibleItems = renderItems.slice(startIndex, endIndex);
  const offsetTop = startIndex * rowHeight;

  const codeLang = useMemo(() => langFromFilename(f.filePath), [f.filePath]);

  return (
    <AppErrorBoundary variant="compact" title="变更对比出错">
      <div
        ref={containerRef}
        className={styles.scrollParent}
        onScroll={onScroll}
        tabIndex={0}
        style={{ position: 'relative', overflowY: 'auto', outline: 'none' }}
      >
        <div
          style={{
            height: `${totalHeight}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          <div
            className={styles.linesContainer}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(${offsetTop}px)`,
              background: 'transparent',
            }}
            aria-label={`${basename(f.filePath)} 的变更分栏内容`}
          >
            {visibleItems.map((item, localIdx) => {
              const idx = startIndex + localIdx;
              if (item.isCollapsedPlaceholder) {
                return (
                  <div
                    key={`${f.filePath}-collapse-${item.startIndex}`}
                    className={styles.collapseBar}
                    onClick={() => onExpandBlock(f.filePath, item.startIndex)}
                  >
                    <Lucide.Maximize2
                      size={12}
                      className={styles.collapseIcon}
                    />
                    <span>展开其余 {item.count} 行代码...</span>
                  </div>
                );
              }

              const { left, right } = item.pair;

              let leftClass = '';
              let leftMarker = ' ';
              let leftText = '';
              let leftNum = '';
              let isLeftDel = false;
              if (left) {
                if (left.change.type === 'deletion') {
                  leftClass = styles.lineDeletion ?? '';
                  leftMarker = '−';
                  isLeftDel = true;
                }
                leftText = left.change.content;
                leftNum = String(left.oldLine ?? '');
              }

              let rightClass = '';
              let rightMarker = ' ';
              let rightText = '';
              let rightNum = '';
              let isRightAdd = false;
              if (right) {
                if (right.change.type === 'addition') {
                  rightClass = styles.lineAddition ?? '';
                  rightMarker = '+';
                  isRightAdd = true;
                }
                rightText = right.change.content;
                rightNum = String(right.newLine ?? '');
              }

              let leftTokens: DiffWordToken[] | null = null;
              let rightTokens: DiffWordToken[] | null = null;
              if (isLeftDel && isRightAdd) {
                const pairResult = computeIntralinePair(leftText, rightText);
                leftTokens = pairResult.oldTokens;
                rightTokens = pairResult.newTokens;
              }

              const oldLine =
                left?.oldLine !== undefined ? String(left.oldLine) : '';
              const newLine =
                right?.newLine !== undefined ? String(right.newLine) : '';
              const stableKey = `${f.filePath}:${f.oldPath || ''}:${oldLine || 'del'}:${newLine || 'add'}:${idx}`;

              return (
                <div
                  key={stableKey}
                  className={styles.splitLine}
                  style={{ minHeight: `${rowHeight}px` }}
                >
                  <div
                    className={`${styles.splitColumn} ${leftClass}`}
                    style={{ padding: 0 }}
                  >
                    <div className={styles.gutterNum} data-num={leftNum}>
                      {leftNum}
                    </div>
                    <div className={styles.gutterMarker}>{leftMarker}</div>
                    <div className={styles.lineText}>
                      {left ? (
                        leftTokens ? (
                          renderTokens(leftTokens, 'removed', leftText, codeLang)
                        ) : (
                          <span
                            dangerouslySetInnerHTML={{
                              __html: highlightCode(leftText, codeLang),
                            }}
                          />
                        )
                      ) : null}
                    </div>
                  </div>
                  <div
                    className={`${styles.splitColumn} ${rightClass}`}
                    style={{ padding: 0 }}
                  >
                    <div className={styles.gutterNum} data-num={rightNum}>
                      {rightNum}
                    </div>
                    <div className={styles.gutterMarker}>{rightMarker}</div>
                    <div className={styles.lineText}>
                      {right ? (
                        rightTokens ? (
                          renderTokens(rightTokens, 'added', rightText, codeLang)
                        ) : (
                          <span
                            dangerouslySetInnerHTML={{
                              __html: highlightCode(rightText, codeLang),
                            }}
                          />
                        )
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </AppErrorBoundary>
  );
};
```

---

### 4.4 契约 4：`VirtualPlainCodeViewer.tsx`（纯源码真实语法高亮与对齐）

```tsx
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualScroll } from '../../hooks/useVirtualScroll';
import { highlightCode, langFromFilename } from '../../api/codeHighlight';
import styles from './DiffCard.module.css';

function basename(p: string): string {
  return p.replace(/^.*[\\/]/, '') || p;
}

interface VirtualPlainCodeViewerProps {
  content: string;
  filePath: string;
}

const FALLBACK_ROW_HEIGHT = 22;

export const VirtualPlainCodeViewer: React.FC<VirtualPlainCodeViewerProps> = React.memo(({ content, filePath }) => {
  const lines = useMemo(() => content.split('\n').map((line, idx) => ({
    num: idx + 1,
    content: line,
  })), [content]);

  const totalLines = lines.length;
  const { containerRef, scrollTop, containerHeight, onScroll } = useVirtualScroll({
    itemCount: totalLines,
    heightOnly: true,
  });

  const [rowHeight, setRowHeight] = useState(FALLBACK_ROW_HEIGHT);
  const firstLineRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = firstLineRef.current;
    if (!el) return;
    const measured = el.offsetHeight;
    if (measured > 0 && measured !== rowHeight) {
      setRowHeight(measured);
    }
  }, [content, rowHeight]);

  const totalHeight = totalLines * rowHeight;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - 15);
  const endIndex = Math.min(totalLines, Math.ceil((scrollTop + containerHeight) / rowHeight) + 15);
  const visibleLines = lines.slice(startIndex, endIndex);
  const offsetTop = startIndex * rowHeight;

  const codeLang = useMemo(() => langFromFilename(filePath), [filePath]);

  return (
    <div
      ref={containerRef}
      className={styles.scrollParent}
      onScroll={onScroll}
      tabIndex={0}
      style={{
        position: 'relative',
        overflowY: 'auto',
        outline: 'none',
        width: '100%',
        height: '100%',
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--diff-bg-pane)',
      }}
    >
      <div style={{ height: `${totalHeight}px`, width: '100%', position: 'relative', flex: 1 }}>
        <pre
          className={styles.linesContainer}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            transform: `translateY(${offsetTop}px)`,
            margin: 0,
            background: 'transparent',
          }}
          aria-label={`${basename(filePath)} 的源码`}
        >
          {visibleLines.map((l, idx) => (
            <div
              key={l.num}
              ref={idx === 0 ? firstLineRef : undefined}
              className={styles.line}
              style={{ minHeight: `${rowHeight}px`, gridTemplateColumns: '40px 1fr' }}
            >
              <div
                className={styles.gutterNum}
                data-num={l.num}
                style={{ width: '40px', minWidth: '40px', textAlign: 'right', paddingRight: '8px', boxSizing: 'border-box' }}
              >
                {l.num}
              </div>
              <div
                className={styles.lineText}
                style={{ whiteSpace: 'pre', overflowX: 'auto', minWidth: 0 }}
                dangerouslySetInnerHTML={{ __html: highlightCode(l.content, codeLang) }}
              />
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
});
```

---

### 4.5 契约 5：`WidgetDiff.tsx`（对偶配对器重构与语法高亮）

```tsx
import React, { useState, useMemo, type ReactNode } from 'react';
import styles from './custom-tags.module.css';
import { CustomTagErrorBoundary } from './CustomTagErrorBoundary';
import type { ExtraComponentProps } from './CustomTagRegistry';
import { Tooltip } from '../ui';
import { highlightCode, langFromFilename } from '../../api/codeHighlight';

export interface WidgetDiffProps extends ExtraComponentProps {
  from?: string;
  to?: string;
  mode?: 'unified' | 'split';
  title?: string;
  children?: ReactNode;
}

export interface ParsedDiffLine {
  type: 'add' | 'delete' | 'context';
  text: string;
  oldNum?: number;
  newNum?: number;
}

export interface SplitLinePair {
  left: ParsedDiffLine | null;
  right: ParsedDiffLine | null;
}

export function parseDiffText(rawText: string): ParsedDiffLine[] {
  const lines = rawText.split('\n');
  const result: ParsedDiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = line.match(/@@\s*-(\d+)(?:,\d+)?\s*\+(\d+)(?:,\d+)?\s*@@/);
      if (match) {
        oldLine = parseInt(match[1] ?? '1', 10);
        newLine = parseInt(match[2] ?? '1', 10);
      }
      result.push({ type: 'context', text: line });
      continue;
    }

    if (line.startsWith('+')) {
      result.push({
        type: 'add',
        text: line.slice(1),
        newNum: newLine++,
      });
    } else if (line.startsWith('-')) {
      result.push({
        type: 'delete',
        text: line.slice(1),
        oldNum: oldLine++,
      });
    } else {
      const content = line.startsWith(' ') ? line.slice(1) : line;
      result.push({
        type: 'context',
        text: content,
        oldNum: oldLine++,
        newNum: newLine++,
      });
    }
  }

  return result;
}

export function buildSplitLinePairs(lines: ParsedDiffLine[]): SplitLinePair[] {
  const pairs: SplitLinePair[] = [];
  let i = 0;

  while (i < lines.length) {
    const cur = lines[i];
    if (!cur) break;

    if (cur.type === 'context') {
      pairs.push({ left: cur, right: cur });
      i++;
      continue;
    }

    const delGroup: ParsedDiffLine[] = [];
    const addGroup: ParsedDiffLine[] = [];

    while (i < lines.length && (lines[i].type === 'delete' || lines[i].type === 'add')) {
      if (lines[i].type === 'delete') {
        delGroup.push(lines[i]);
      } else {
        addGroup.push(lines[i]);
      }
      i++;
    }

    const maxLen = Math.max(delGroup.length, addGroup.length);
    for (let k = 0; k < maxLen; k++) {
      pairs.push({
        left: delGroup[k] || null,
        right: addGroup[k] || null,
      });
    }
  }

  return pairs;
}

export const WidgetDiffInner: React.FC<WidgetDiffProps> = ({
  from,
  to,
  mode: initialMode = 'unified',
  title,
  isStreaming = false,
  children,
  onAgentAction,
  messageId,
}) => {
  const [viewMode, setViewMode] = useState<'unified' | 'split'>(initialMode);
  const [copied, setCopied] = useState(false);

  const rawDiffText = useMemo(() => {
    if (typeof children === 'string') return children;
    if (Array.isArray(children)) {
      return children.map((c) => (typeof c === 'string' ? c : '')).join('');
    }
    return '';
  }, [children]);

  const parsedLines = useMemo(() => parseDiffText(rawDiffText), [rawDiffText]);
  const splitPairs = useMemo(() => buildSplitLinePairs(parsedLines), [parsedLines]);

  const codeLang = useMemo(() => {
    const targetPath = to || from || '';
    return langFromFilename(targetPath);
  }, [to, from]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(rawDiffText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard fallback
    }
  };

  const handleAccept = () => {
    onAgentAction?.('accept_diff', { from, to, title, messageId });
  };

  const handleReject = () => {
    onAgentAction?.('reject_diff', { from, to, title, messageId });
  };

  const displayTitle = title || from || to || '代码审查比对';

  return (
    <div className={styles.widgetDiff} data-streaming={isStreaming ? 'true' : 'false'}>
      <div className={styles.cardHeader}>
        <div className={styles.cardTitleGroup}>
          {isStreaming ? (
            <Tooltip content="正在流式生成比对...">
              <span className={styles.statusRunning} aria-label="正在流式生成比对" />
            </Tooltip>
          ) : (
            <span aria-hidden="true">📄</span>
          )}
          <span className={styles.cardTitle}>{displayTitle}</span>
        </div>

        <div className={styles.cardActions}>
          <div className={styles.diffModeGroup}>
            <button
              type="button"
              className={`${styles.diffModeBtn} ${viewMode === 'unified' ? styles.active : ''}`}
              onClick={() => setViewMode('unified')}
            >
              Unified
            </button>
            <button
              type="button"
              className={`${styles.diffModeBtn} ${viewMode === 'split' ? styles.active : ''}`}
              onClick={() => setViewMode('split')}
            >
              Split
            </button>
          </div>

          <Tooltip content="复制 Diff 文本">
            <button
              type="button"
              className={styles.actionBtn}
              onClick={handleCopy}
            >
              {copied ? '已复制' : '复制'}
            </button>
          </Tooltip>

          {onAgentAction && (
            <>
              <Tooltip content="采纳本次代码变更">
                <button
                  type="button"
                  className={`${styles.actionBtn} ${styles.primary}`}
                  onClick={handleAccept}
                >
                  采纳
                </button>
              </Tooltip>
              <Tooltip content="拒绝本次代码变更">
                <button
                  type="button"
                  className={`${styles.actionBtn} ${styles.danger}`}
                  onClick={handleReject}
                >
                  拒绝
                </button>
              </Tooltip>
            </>
          )}
        </div>
      </div>

      <div className={styles.diffContainer}>
        {viewMode === 'unified' ? (
          <div>
            {parsedLines.map((line, idx) => {
              let lineClass = styles.diffLineContext;
              let prefix = ' ';
              if (line.type === 'add') {
                lineClass = styles.diffLineAdd;
                prefix = '+';
              } else if (line.type === 'delete') {
                lineClass = styles.diffLineDelete;
                prefix = '-';
              }

              return (
                <div key={idx} className={lineClass}>
                  <span className={styles.diffLineNum}>
                    {line.newNum ?? line.oldNum ?? ''}
                  </span>
                  <span className={styles.diffMarker}>{prefix}</span>
                  <span
                    className={styles.diffLineContent}
                    dangerouslySetInnerHTML={{
                      __html: highlightCode(line.text, codeLang),
                    }}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <div className={styles.diffSplitLayout}>
            <div className={styles.diffSplitHeaderRow}>
              <div className={styles.diffSplitColHeader}>Original ({from || 'Base'})</div>
              <div className={styles.diffSplitColHeader}>Modified ({to || 'Target'})</div>
            </div>
            {splitPairs.map((pair, idx) => {
              const { left, right } = pair;
              return (
                <div key={idx} className={styles.diffSplitLineRow}>
                  {/* 左侧 */}
                  <div
                    className={`${styles.diffSplitColCell} ${
                      !left
                        ? styles.diffLineEmpty
                        : left.type === 'delete'
                          ? styles.diffLineDelete
                          : styles.diffLineContext
                    }`}
                  >
                    <span className={styles.diffLineNum}>{left?.oldNum ?? ''}</span>
                    <span className={styles.diffMarker}>{left ? (left.type === 'delete' ? '-' : ' ') : ''}</span>
                    <span
                      className={styles.diffLineContent}
                      dangerouslySetInnerHTML={{
                        __html: left ? highlightCode(left.text, codeLang) : '',
                      }}
                    />
                  </div>

                  {/* 右侧 */}
                  <div
                    className={`${styles.diffSplitColCell} ${
                      !right
                        ? styles.diffLineEmpty
                        : right.type === 'add'
                          ? styles.diffLineAdd
                          : styles.diffLineContext
                    }`}
                  >
                    <span className={styles.diffLineNum}>{right?.newNum ?? ''}</span>
                    <span className={styles.diffMarker}>{right ? (right.type === 'add' ? '+' : ' ') : ''}</span>
                    <span
                      className={styles.diffLineContent}
                      dangerouslySetInnerHTML={{
                        __html: right ? highlightCode(right.text, codeLang) : '',
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export const WidgetDiff: React.FC<WidgetDiffProps> = (props) => (
  <CustomTagErrorBoundary tagName="widget-diff">
    <WidgetDiffInner {...props} />
  </CustomTagErrorBoundary>
);
```

---

### 4.6 契约 6：`custom-tags.module.css`（占位行与 Token 收敛）

```css
.diffContainer {
  font-family: var(--font-mono, 'JetBrains Mono', 'IBM Plex Mono', monospace);
  font-size: 0.78125rem;
  line-height: 1.45;
  overflow-x: auto;
  padding: 0.25rem 0;
  min-height: 44px;
  max-height: min(520px, 60vh);
  background: var(--diff-bg-pane, var(--bg-card));
  border-radius: var(--radius-md);
  overscroll-behavior: auto;
}

.diffLine {
  display: flex;
  align-items: center;
  padding: 0 0.5rem;
  min-height: 22px;
  white-space: pre;
}

.diffLineNum {
  width: 36px;
  flex-shrink: 0;
  color: var(--diff-gutter-fg, var(--text-tertiary));
  user-select: none;
  text-align: right;
  padding-right: 0.5rem;
  font-size: 11px;
}

.diffMarker {
  width: 14px;
  flex-shrink: 0;
  text-align: center;
  color: inherit;
  font-weight: 600;
  user-select: none;
}

.diffLineContent {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  color: var(--diff-text-normal, var(--text-primary));
}

.diffLineAdd {
  composes: diffLine;
  background: var(--diff-add-bg);
  color: var(--diff-add-fg);
}

.diffLineDelete {
  composes: diffLine;
  background: var(--diff-del-bg);
  color: var(--diff-del-fg);
}

.diffLineContext {
  composes: diffLine;
  color: var(--diff-text-normal, var(--text-primary));
}

.diffLineEmpty {
  composes: diffLine;
  background: color-mix(in srgb, var(--text-primary) 1.5%, transparent);
  user-select: none;
}

.diffSplitLayout {
  display: flex;
  flex-direction: column;
  width: 100%;
}

.diffSplitHeaderRow {
  display: grid;
  grid-template-columns: 1fr 1fr;
  border-bottom: 1px solid var(--diff-split-divider, var(--border-subtle));
}

.diffSplitColHeader {
  padding: 0.25rem 0.75rem;
  font-size: 0.71875rem;
  font-weight: 600;
  color: var(--diff-split-header-fg, var(--text-secondary));
  background: var(--diff-split-header-bg, var(--bg-secondary));
}

.diffSplitColHeader + .diffSplitColHeader {
  border-left: 1px solid var(--diff-split-divider, var(--border-subtle));
}

.diffSplitLineRow {
  display: grid;
  grid-template-columns: 1fr 1fr;
  min-width: 0;
}

.diffSplitColCell {
  display: flex;
  align-items: center;
  padding: 0 0.5rem;
  min-height: 22px;
  white-space: pre;
  min-width: 0;
}

.diffSplitColCell + .diffSplitColCell {
  border-left: 1px solid var(--diff-split-divider, var(--border-subtle));
}
```

---

### 4.7 契约 7：`DiffCard.module.css`（物理拔除死代码与弹性布局）

```css
/* ==========================================================================
   DiffCard.module.css —— 重构与死代码清剿版
   ========================================================================== */

.panel {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  height: 100%;
  min-height: 0;
  min-width: 0;
  width: 100%;
  overflow: hidden;
  background: var(--bg-card, #ffffff);
  container-type: inline-size;
  container-name: diff-panel;
  box-sizing: border-box;
}

/* 32px 紧凑工具栏与响应式 */
.compactHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 32px;
  min-height: 32px;
  max-height: 32px;
  padding: 0 8px;
  border-bottom: 1px solid var(--hairline, var(--border-subtle));
  background: var(--bg-card);
  gap: 6px;
  flex-shrink: 0;
  box-sizing: border-box;
}

.leftGroup {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 0 1 auto;
}

.sourceSegment {
  display: inline-flex;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  overflow: hidden;
  flex-shrink: 0;
}

.sourceTab {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  font-size: var(--font-size-xs);
  padding: 2px 8px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.sourceTab.activeTab {
  background: var(--tint-active);
  color: var(--text-primary);
  font-weight: var(--font-weight-medium);
}

.headerDivider {
  width: 1px;
  height: 14px;
  background: var(--border-subtle);
}

.contextSelector {
  min-width: 0;
  max-width: 180px;
  flex: 1 1 auto;
}

@container diff-panel (max-width: 400px) {
  .contextSelector {
    max-width: 120px;
  }
}

.rightGroup {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

/* 手风琴文件列表 */
.fileList {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overscroll-behavior: auto; /* 解除滚轮劫持 */
  flex: 1 1 auto;
}

.accordionItem {
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-card);
}

/* 弹性视口容器 (DEL-16: 移除 380px 锁死) */
.scrollParent {
  min-height: 44px;
  max-height: min(520px, 60vh);
  height: auto;
  overflow-y: auto;
  overscroll-behavior: auto; /* 解除滚轮劫持 */
  position: relative;
  background: var(--diff-bg-pane, #ffffff);
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
}

.linesContainer {
  display: flex;
  flex-direction: column;
  width: 100%;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  line-height: 1.5;
  background: var(--diff-bg-pane, #ffffff);
  user-select: text;
  box-sizing: border-box;
}

/* 单列统一视图 (Unified) 行网格 */
.line {
  display: grid;
  grid-template-columns: var(--diff-gutter-width-unified, 40px) var(--diff-gutter-width-unified, 40px) var(--diff-gutter-marker-width, 20px) 1fr;
  width: 100%;
  align-items: stretch;
  box-sizing: border-box;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  min-height: 22px;
}

.gutterNum {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  padding: 0 6px;
  color: var(--diff-gutter-fg, var(--text-tertiary));
  font-size: var(--font-size-xxs);
  user-select: none;
  opacity: 0.75;
  text-align: right;
  border-right: 1px solid var(--border-subtle);
  background: var(--diff-gutter-bg);
}

.gutterMarker {
  display: flex;
  justify-content: center;
  align-items: center;
  user-select: none;
  font-weight: 600;
  font-size: 11px;
  font-family: var(--font-mono);
}

.lineText {
  padding: 0 10px;
  white-space: pre;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--diff-text-normal, var(--text-primary));
  font-weight: var(--font-weight-code, 400);
  line-height: 22px;
}

.lineAddition {
  background: var(--diff-add-bg);
}
.lineAddition .gutterNum {
  background: var(--diff-add-gutter-bg);
  color: var(--diff-add-gutter-fg);
}
.lineAddition .gutterMarker {
  color: var(--diff-add-fg);
}

.lineDeletion {
  background: var(--diff-del-bg);
}
.lineDeletion .gutterNum {
  background: var(--diff-del-gutter-bg);
  color: var(--diff-del-gutter-fg);
}
.lineDeletion .gutterMarker {
  color: var(--diff-del-fg);
}

.lineNormal {
  color: var(--diff-text-normal, var(--text-primary));
}

/* 词法级行内修改高亮 */
.diffWordAdd {
  background: var(--diff-add-word-bg);
  border-radius: var(--radius-xs, 2px);
  padding: 0 1px;
}

.diffWordDel {
  background: var(--diff-del-word-bg);
  border-radius: var(--radius-xs, 2px);
  padding: 0 1px;
}

/* 分栏视图 (Split) 网格 */
.splitLine {
  display: grid;
  grid-template-columns: 1fr 1fr;
  border-bottom: 1px solid var(--diff-split-divider);
  min-width: 0;
}

.splitColumn {
  display: grid;
  grid-template-columns: var(--diff-gutter-width-split, 36px) var(--diff-gutter-marker-width, 20px) 1fr;
  align-items: stretch;
  font-size: var(--font-size-xs, 12px);
  font-family: var(--font-mono);
  line-height: 22px;
  min-width: 0;
}

.splitColumn:first-child {
  border-right: 1px solid var(--diff-split-divider);
}

/* 折叠条 (Collapse Bar) */
.collapseBar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  background-color: var(--diff-bg-header);
  color: var(--text-muted);
  font-size: var(--font-size-xs, 12px);
  height: 22px;
  min-height: 22px;
  max-height: 22px;
  padding: 0 12px;
  cursor: pointer;
  border-top: 1px solid var(--hairline, var(--border-subtle));
  border-bottom: 1px solid var(--hairline, var(--border-subtle));
  user-select: none;
  font-family: var(--font-sans);
  box-sizing: border-box;
}

.collapseBar:hover {
  background-color: var(--bg-hover);
  color: var(--text-primary);
}

.collapseIcon {
  opacity: 0.75;
}

/* Commit 面板 */
.commitPanel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-card);
  flex-shrink: 0;
  box-sizing: border-box;
}

.commitInput {
  height: 48px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--diff-bg-pane);
  padding: 8px 10px;
  font-size: var(--font-size-xs);
  font-family: inherit;
  color: var(--text-primary);
  resize: none;
  box-sizing: border-box;
}

.commitInput:focus {
  outline: none;
  border-color: var(--brand);
}

.commitActions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
```

---

### 4.8 契约 8：`DiffCardGitActions.tsx`（Commit CTA 视觉层级提升）

```tsx
<div className={styles.commitActions}>
  <Button
    type="button"
    variant="primary"
    size="sm"
    style={{ height: 28 }}
    disabled={commitLoading || pushLoading || (!commitMsg.trim() && stagedCount === 0)}
    onClick={onCommit}
    icon={<Lucide.GitCommit size={14} style={{ marginRight: 4 }} />}
  >
    {commitLoading
      ? '提交中…'
      : stagedCount > 0
        ? '提交已暂存'
        : '暂存并提交'}
  </Button>
  <Tooltip content="将本地提交推送至远程仓库">
    <Button
      type="button"
      variant="ghost"
      size="sm"
      style={{ height: 28 }}
      disabled={commitLoading || pushLoading}
      onClick={onPush}
      icon={<Lucide.CloudUpload size={14} style={{ marginRight: 4 }} />}
    >
      {pushLoading ? '推送中…' : '推送 (Push)'}
    </Button>
  </Tooltip>
</div>
```

---

## 5. 反退化自动化测试套件设计

### 测试矩阵与断言清单

```
apps/crish-desktop/src/components/diff/__tests__/
├── DiffHighlighting.test.tsx                               [断言：真实语言高亮与词法分段色彩]
├── WidgetDiffAlignment.test.tsx                            [断言：对偶配对与占位行 1:1 对齐]
└── DiffCardViewport.test.tsx                               [断言：弹性高度 44~520px 与滚轮穿透]
```

#### 关键测试断言示例：
1. **`DiffHighlighting.test.tsx`**：
   - 验证传入 `test.ts` 文件行时，生成的 HTML 包含 `<span class="hljs-keyword">const</span>`，断言 0 个纯文本降级；
   - 验证词法修改行包含 `.diffWordAdd` 且内部保留 `.hljs-*` 标签。
2. **`WidgetDiffAlignment.test.tsx`**：
   - 构造包含 3 个连续 deletion 与 1 个 addition 的 Hunk，断言 `buildSplitLinePairs` 产出 3 个 Pair，右侧前 1 个为 addition，后 2 个为 `null` 占位槽。

---

## 6. 四阶段实施 DAG 与全量战役验收断言

```
【阶段 0：死代码、固定高度与旧式 RGBA 物理拔除】
  ├── 1. 物理删除 DiffCard.module.css:757-766 380px 固定高度
  ├── 2. 物理删除 DiffCard.module.css 300+ 行废弃单文件 Tab 死样式 (DEL-20)
  ├── 3. 物理删除 tokens.css --diff-gutter-width: 48px 僵尸 Token (DEL-23)
  └── 4. 彻底消除 overscroll-behavior: contain 滚轮劫持 (DEL-17)
        │
        ▼ (阶段 0 门禁全绿)
【阶段 1：Token 体系与语法高亮全链路接通】
  ├── 1. tokens.css 注入 Light / Dark WCAG AAA 达标色阶
  ├── 2. DiffCardUnifiedView / SplitView / Plain 接入 langFromFilename 真实语言
  └── 3. 实现 renderHighlightedTokens 词法分段语法高亮合成器
        │
        ▼ (阶段 1 门禁全绿)
【阶段 2：<widget-diff> 对偶配对算法与弹性容器落地】
  ├── 1. 重写 WidgetDiff.tsx buildSplitLinePairs 对偶配对器与占位行
  ├── 2. DiffCard.module.css 弹性自适应视口 (min:44px, max:520px) 实施
  └── 3. 折叠条 .collapseBar 22px 尺寸与居中对齐修复
        │
        ▼ (阶段 2 门禁全绿)
【阶段 3：工具栏响应式治理与提交面板 CTA 强化】
  ├── 1. DiffHeaderControls 窄屏自适应收缩与防截断
  ├── 2. DiffCardGitActions Commit 按钮升级为 Primary 墨绿并加入空提交防御
  └── 3. ToolCallDiffPreview 与 ChatToolCallBlock.module.css Token 统一
        │
        ▼ (阶段 3 门禁全绿)
【阶段 4：自动化测试套件与全量端到端验收】
  ├── 1. npm run typecheck (0 错误) + npm run check:line-counts 通过
  ├── 2. Vitest 单测 100% PASS (对齐、高亮、弹性视口)
  └── 3. 视觉实测：纯白底板、语法色彩生动、左右分栏严丝合缝、滚动顺畅
```

---

### 全量战役验收断言（Exit Criteria）

1. **[断言 1] 真实语法高亮 100% 生效**：在 Unified、Split、Plain 以及 `<widget-diff>` 中，所有主流语言（TS/JS/Rust/Python/CSS/HTML）代码行均呈现完整的语法高亮，彻底废除 `highlightCode(..., 'diff')`；
2. **[断言 2] 分栏对齐绝对严密**：`<widget-diff>` 与 `DiffCardSplitView` 无论存在何种增删组合，左右行号与代码行必须严格对齐，空缺侧显示占位槽，错位率为 0；
3. **[断言 3] 弹性视口自适应**：1 行差异自适应收缩至 ~44px，长差异平滑展开至上限 520px，彻底消灭 380px 空白大框；
4. **[断言 4] 滚轮链畅通**：在手风琴列表中平滑滚动鼠标，穿过代码块时不发生卡死；
5. **[断言 5] 底板清爽与 WCAG AAA 达标**：浅色模式下差异卡片为纯白底板（`#ffffff`），新增文本对比度 $\ge 6.8:1$，删除文本对比度 $\ge 7.1:1$；
6. **[断言 6] 架构死层完全清剿**：`DiffCard.module.css` 拔除 300+ 行死代码，全局无 `--diff-gutter-width: 48px` 僵尸 Token。

---
_方案编制完成 · 归档于 `docs/ui-style-refactor/independent-plans/03-diff-panel-layout-and-syntax-highlighting-plan.md`_
