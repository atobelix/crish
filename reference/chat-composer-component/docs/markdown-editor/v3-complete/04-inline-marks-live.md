# 04 — 行内实时格式（Inline Marks Live）

> **分册**：v3-complete / 04  
> **读者**：实现 agent、桌面集成、QA  
> **依赖**：[01-architecture.md](../01-architecture.md)、[03-line-renderer.md](../03-line-renderer.md)、[10-data-format.md](../10-data-format.md)、reference `js/markdown-editor/*`  
> **产品约束**：U3 — 文本块编辑时以**渲染态为主**（Typora/Notion 向），不是整行裸 MD 源；定界符在闭合后应消失并留下样式。

---

## 0. 目标与非目标

### 0.1 目标

| ID | 目标 |
|----|------|
| IM-1 | 用户键入 `**` / `*` / `~~` / `` ` `` / `==` / 链接语法时，**闭合瞬间**折叠为真实样式（bold / italic / strike / code / highlight / link） |
| IM-2 | 模型真相为 **`TextRun[]` + `InlineMark[]`**（扁平 runs，不嵌套树）；序列化为 GFM/扩展 MD |
| IM-3 | 中文 **IME composition** 期间绝不折叠、不整块 `innerHTML` 重挂、不拆块 |
| IM-4 | Undo/Redo 以**块级 history** 为准；组字整段压 **一条** undo；连续输入可 merge |
| IM-5 | 与 **selection-toolbar** 双向一致：工具条 toggle 写 marks；marks 折叠后工具条能反映 active 状态 |
| IM-6 | **弃用** 对 `document.execCommand` 的长期依赖，给出可落地迁移路径 |
| IM-7 | 单元/集成测试矩阵可回归；桌面 WebView（Tauri/Chromium）可验收 |

### 0.2 非目标

- 完整协同 OT/CRDT 行内合并  
- 嵌套 mark 树（`**a *b* c**` 以相邻 run 拆分为准，不做 DOM 树深度递归模型）  
- 代码块内部的 MD marks（代码块永远是源码表面）  
- 跨块选区的「跨块统一加粗」完整产品化（v3 可先单块；多块为 P1 扩展）

### 0.3 与现状差距（reference 快照）

| 能力 | 现状（`reference/.../js/markdown-editor`） | v3 目标 |
|------|---------------------------------------------|---------|
| 阅读态 inline 渲染 | `MdxUtil.inlineHtml`：`` `code` `` / `**` / `*` / `~~` / 链接 / 芯片 | 保持并增强 `==highlight==` |
| 编辑态 model | 多数块仍以 `block.text` 字符串为主；`runs` 在 schema 已支持 | **编辑真相切到 `runs`**；`text` 作派生/兼容 |
| 工具条 | `selection-toolbar.js` 用 `execCommand('bold'|'italic'|'strikeThrough')` + `wrapSelectionTag('code')` | 改为 **toggleMark on runs**，DOM 受控 patch |
| Markdown-as-you-type | 未系统实现 | 状态机 + 边界检测 |
| IME | editor 有 `composing` 标志 | 硬约束冻结（见 §6） |
| History | `MdxModel` 文档快照 undo 栈 | 与 composition / mergeKey 对齐 |

---

## 1. 数据模型：TextRun 与 InlineMark

### 1.1 冻结类型（对齐 architecture / data-format）

```ts
/** 行内标记：扁平；重叠区间拆成相邻 run */
type InlineMark =
  | { type: 'bold' }
  | { type: 'italic' }
  | { type: 'code' }
  | { type: 'strike' }
  | { type: 'highlight' }                 // ==text== ，v3 新增一等公民
  | { type: 'link'; href: string; title?: string }
  | { type: 'mention'; id: string; label: string } // 扩展 atom，见 06
  | { type: string; [k: string]: unknown };        // 未来扩展槽

interface TextRun {
  text: string;           // 非空优先；空 run 仅允许作为 caret 占位过渡
  marks?: InlineMark[];   // 同一 run 上可叠加互不冲突的 marks
}

/** 兼容层：块上仍可有 text；读模型时优先 runs */
interface Block {
  id: string;
  type: string;
  indent: number;
  text?: string;          // 派生缓存：serializeInline(runs)
  runs?: TextRun[];       // 真相（段落/标题/列表/引用/callout 正文）
  props?: Record<string, unknown>;
}
```

### 1.2 不变量

1. **非重叠**：任意字符偏移只属于一个 run。  
2. **合并**：相邻 run 若 `marks` 集合相等（深比较 type + link.href 等），应在 commit 后 `normalizeRuns` 合并。  
3. **code 独占**：带 `code` mark 的 run **禁止**再带 bold/italic/strike/highlight（粘贴/折叠时 strip）。  
4. **offset 单位**：UTF-16 code unit（与 `String` / DOM Selection 一致）；emoji 与中文按 JS 索引，不按 grapheme 打断 mark 边界。  
5. **原子节点**：`mention` / file-chip 等可建模为 **长度为 1 的特殊 run** 或块级 atom；行内折叠规则不对其内部扫描。

### 1.3 `text` ↔ `runs` 双写策略（迁移期）

| 阶段 | 读 | 写 |
|------|----|----|
| v3-M1 | 若有 `runs` 用 runs；否则 `parseInline(text)` | 更新 runs，并 `text = serializeInline(runs)` |
| v3-M2 | 仅 runs | 仅 runs；serialize 时再算 text |
| 兼容 API | `getMarkdown()` 始终 serialize | `setMarkdown` → parse → runs |

`schema.cloneRuns` / `createBlock` 已具备 `marks` 深拷贝；实现层禁止 `JSON.parse(JSON.stringify(block))` 丢失原型扩展字段以外的副作用即可。

---

## 2. 语法边界检测（Markdown-as-you-type）

### 2.1 总流程

```
beforeinput / input（非 composing）
  → 从 EditSession 读 plain 或 runs 草稿
  → detectClosingDelimiter(caretOffset)
  → 若命中：
      1) 计算 [open, close) 内容区间
      2) applyMarkToRange(runs, mark, openContent, closeContent)
      3) 删除定界符字符
      4) normalizeRuns
      5) patch DOM（最小替换）+ restoreCaret
      6) Transaction update（addToHistory: true，mergeKey 可选）
  → 否则：普通输入 commit
```

**禁止**：每次 keystroke 全文档 GFM parse。  
**范围**：仅当前聚焦块的 **纯文本线性扫描**（或 runs 展平字符串 + 映射表）。

### 2.2 定界符表

| 语法 | 开 | 闭 | Mark | 优先级 | 触发时机 |
|------|----|----|------|--------|----------|
| 粗体 | `**` | `**` | `bold` | 高于单 `*` | 输入闭合 `**` 的第二个 `*` 之后（`input`） |
| 斜体 | `*` | `*` | `italic` | 低于 `**` | 闭合 `*` 且两侧不成 `**` |
| 删除线 | `~~` | `~~` | `strike` | 中 | 闭合 `~~` |
| 高亮 | `==` | `==` | `highlight` | 中 | 闭合 `==`（Conex 扩展；pure-gfm 导出可降级为原文或 strip） |
| 行内代码 | `` ` `` | `` ` `` | `code` | **最高**（先扫） | 闭合 backtick；内容禁止再解析 |
| 链接 | `[` | `](url)` | `link` | 特殊 | 输入 `)` 且能匹配 `[label](url)` |
| 自动链接 | — | — | `link` | 低 | 可选：空格后识别 `https://…`（P1） |

### 2.3 边界规则（防误伤）

#### 2.3.1 粗体 `**…**`

- 开定界符后至少一个非空字符才允许闭合。  
- 闭合时 caret 必须紧贴闭定界符之后（或闭定界符刚被插入）。  
- **跨码点**：`**` 视为两个 `*` 字符，扫描用索引 i,i+1。  
- **与斜体**：若文本为 `***x***`，优先按 CommonMark 启发：最外 `**` 为 bold，内层 `*` 为 italic；v3 简化实现可 **禁止三星号一键折叠**，要求用户分步（文档化），P1 再对齐 CM。

#### 2.3.2 斜体 `*…*`

- 开 `*` 左右不能是第二个 `*` 的一部分（即不在 `**` 内当斜体开）。  
- 闭 `*` 右侧若是 `*`，交给 bold 规则。  
- **中文友好**：允许 `*中文*`（开闭内侧可紧贴 CJK，不要求 CM 的 unicode punctuation 严格规则）；**禁止** `* 空格开头` 与 `空格结尾 *` 折叠（避免 `3 * 4 * 5` 误伤）。  
- 下划线 `_italic_`：**v3 默认不启用 as-you-type**（中文输入法与标识符冲突多）；解析器读入仍可识别 GFM `_`；工具条 italic 不依赖 `_`。

#### 2.3.3 删除线 `~~…~~` 与高亮 `==…==`

- 与 `**` 相同双字符规则。  
- 内容可含单 `~` 或 `=`。  
- 高亮 DOM：`<mark class="mdx-mark">`；CSS 用极淡底，禁止荧光黄高饱和。

#### 2.3.4 行内代码 `` `…` ``

- **最先扫描**；闭 backtick 后内容不再二次 marks。  
- 多 backtick 围栏（`` ``code`with`tick`` ``）：v3 as-you-type **仅单 backtick**；多 backtick 留给粘贴/读入 parse。  
- 折叠后 DOM：`<code class="mdx-code">`；caret 落在 code 后。

#### 2.3.5 链接 `[label](url)`

- 状态机：见 `]` 后期待 `(`；见 `)` 完成。  
- `url` trim；允许 `<>` 包裹形式可选。  
- **空 label / 空 url** 不折叠。  
- 折叠结果：run.text = label；mark = `{ type:'link', href }`。  
- DOM：`<a class="mdx-a" href="..." rel="noopener noreferrer">`；编辑态可 `contenteditable` 内嵌，点击默认 **不导航**（`click` preventDefault + 修饰键/工具条「打开」才跳）。

#### 2.3.6 不触发的上下文

| 上下文 | 行为 |
|--------|------|
| `composing === true` | 全部 as-you-type **关闭** |
| 代码块 edit surface | 关闭 |
| 行内已在 `code` mark 内 | 内部不再折叠 |
| 选区非折叠（有选中文本）时键入 | 走默认替换；不在中间半截折叠 |
| `viewOnly` | 无编辑表面 |

### 2.4 扫描算法（推荐）

```ts
type DetectHit =
  | { kind: 'wrap'; mark: InlineMark; openStart: number; contentStart: number; contentEnd: number; closeEnd: number }
  | null;

/**
 * plain: 当前块展平文本（含尚未折叠的定界符）
 * caret: 闭合后的 caret 偏移（通常 plain.length 或插入点）
 */
function detectClosingDelimiter(plain: string, caret: number): DetectHit {
  // 1. 仅当 caret 处刚完成闭定界符时继续
  // 2. 从 caret 向左匹配 close token
  // 3. 在 open..close 之间找最近合法 open（同 token，不跨 \n 对 paragraph 单行策略；
  //    多行 paragraph 允许跨 \n 的 bold？→ v3 决策：marks 不跨 \n，遇 \n 中止）
  // 4. code 优先：若 close 是 `，只找 code open
  // 5. 返回 hit
}
```

**展平映射**：`runsToPlain(runs) → { plain, map: number[] }`，`map[i]` 为 plain 偏移 i 对应的 runIndex；折叠后写回 `plainToRuns`。

### 2.5 键盘快捷键（与 as-you-type 并列）

| 快捷键 | 动作 |
|--------|------|
| `Mod+B` | toggle `bold` on selection |
| `Mod+I` | toggle `italic` |
| `Mod+Shift+S` 或 `Mod+Shift+X` | toggle `strike`（平台一致表见 keyboard-map） |
| `Mod+E` | toggle `code` |
| `Mod+Shift+H` | toggle `highlight`（可选） |
| `Mod+K` | 链接：有选区则包 link（弹轻量 URL 输入）；无选区插入 `[](url)` 骨架或打开 popover |

快捷键路径 **直接改 runs**，不经定界符插入再折叠。

---

## 3. DOM 与编辑表面策略

### 3.1 阅读态

- `inlineHtml` / `runsToHtml`：输出语义标签  
  - bold → `<strong>`  
  - italic → `<em>`  
  - strike → `<del>`  
  - code → `<code class="mdx-code">`  
  - highlight → `<mark class="mdx-mark">`  
  - link → `<a class="mdx-a">`  
- 转义顺序：先 escape 文本，再包标签（防 XSS）；href 做 `sanitizeUrl`（禁 `javascript:`）。

### 3.2 编辑态（受控 marks DOM）

**决策（U3）**：编辑态显示 **已折叠样式**，不显示 `**bold**` 源码（源码感仅「复制为 Markdown」）。

```
.mdx-block.is-editing
  └─ [data-mdx-edit][contenteditable=true]
        ├─ #text | <strong> | <em> | <del> | <code> | <mark> | <a>
```

| 操作 | DOM | Model |
|------|-----|-------|
| 普通插入 | 浏览器默认插入文本节点 | input 后 `domToRuns` |
| as-you-type 折叠 | 删除定界符文本 + wrap 内容 | 写 marks |
| 工具条 toggle | 对选区 wrap/unwrap | toggleMark |
| composition | **不**重挂 innerHTML | end 后一次 `domToRuns` |

### 3.3 `domToRuns` / `runsToDom`

- `domToRuns`：对齐现有 `htmlToInlineMd` 思路，但输出 **runs 而非 MD 字符串**（避免二次 parse 丢精度）。  
  - `B/STRONG` → bold  
  - `I/EM` → italic  
  - `S/STRIKE/DEL` → strike  
  - `CODE` → code  
  - `MARK` → highlight  
  - `A[href]` → link  
  - `BR` → `\n` 文本  
- `runsToDom`：用于 enterEdit 初次填充与折叠后 patch。  
- **最小 patch**：比较旧 runs 与新 runs 的 LCS/前缀后缀相同段，只替换中间 DOM，降低 caret 抖动。

### 3.4 Caret 保存 / 恢复

```ts
interface CaretSnapshot {
  blockId: string;
  offset: number; // 块内 plain 偏移
}

function getCaretOffset(editEl: HTMLElement): number;
function setCaretOffset(editEl: HTMLElement, offset: number): void;
```

折叠定界符后：新 offset = 原 content 起点 + contentLen（落在样式文本之后），**不**落在 mark 标签外莫名空白。

实现注意：

- 使用 `Selection` + 遍历 text nodes 累计长度。  
- 跳过 `contenteditable=false` 的 atom（芯片）。  
- 与 `selectionchange` 防抖共享同一套 offset 映射。

---

## 4. 与 selection-toolbar 的关系

### 4.1 现状

`ui/selection-toolbar.js`：

- 非空选区时显示在选区上方；`mousedown` preventDefault 保选区。  
- `applyCommand`：`execCommand` / `wrapSelectionTag`。  
- editor `onSelCommand`：再用 `htmlToInlineMd` 写回 `block.text`。

### 4.2 v3 目标契约

```ts
interface SelectionToolbarHost {
  /** 当前选区是否在编辑器内且非折叠 */
  getTextSelection(): { blockId: string; from: number; to: number } | null;
  /** 查询选区 marks 交集（全部 run 都有才 active） */
  queryActiveMarks(): Set<InlineMark['type']>;
  /** 切换 mark */
  toggleMark(type: InlineMark['type'], attrs?: { href?: string }): void;
  /** 是否 composing / viewOnly */
  canFormat(): boolean;
}
```

| 行为 | 规则 |
|------|------|
| 显示 | 非折叠选区 + 在 `[data-mdx-edit]` 内 + 非 viewOnly + 非 composing |
| 位置 | 选区 bounding rect 上方 8px；不够则下方；夹在 root 内（沿用现逻辑） |
| Active 态 | 按钮 `aria-pressed` + `.is-active`：选区 marks 全覆盖该 type |
| 点击 | `toggleMark`；**禁止**依赖 execCommand 的 browser undo 栈 |
| 与 as-you-type | 共用 `toggleMark` / `applyMark` 内核 |
| 扩展按钮 | v3 可加 highlight、link；仍禁止页顶永久格式栏（D16） |

### 4.3 时序

```
selectionchange → rAF sync toolbar position + active
user click Bold
  → mousedown preventDefault（保选区）
  → click → host.toggleMark('bold')
  → model Transaction
  → patch DOM + restore selection（仍选中原 range，标记已变）
  → toolbar.sync active
```

---

## 5. execCommand 弃用路径

### 5.1 为何弃用

| 问题 | 影响 |
|------|------|
| 规范废弃，Chromium 仍可用但不保证 | 长期桌面 WebView 风险 |
| 产生 `<b>`/`<font>`/乱七八糟嵌套 | `domToRuns` 脆弱 |
| Undo 进 **浏览器** 栈，与 `MdxModel` 双栈 | Ctrl+Z 行为分裂 |
| 无法表达 highlight / 自定义 mark | 产品扩展卡死 |
| 跨 shadow DOM / 部分 CE 行为差 | 集成不确定性 |

### 5.2 迁移阶段

| 阶段 | 行为 | 退出标准 |
|------|------|----------|
| **P0 现状** | toolbar → execCommand；model 事后 `htmlToInlineMd` | 演示可用 |
| **P1 双写** | `toggleMark` 写 runs + 同步 CE DOM；execCommand 仅 fallback 开关 `features.legacyExecCommand` | 单测 toggle 不依赖 execCommand |
| **P2 默认自研** | 默认关闭 execCommand；`beforeinput` formatBold 等 `preventDefault` 后走 toggleMark | 手动回归 toolbar + 快捷键 |
| **P3 删除** | 移除 execCommand 分支与 feature flag | 代码无 `execCommand(` |

### 5.3 `toggleMark` 算法（核心）

```ts
function toggleMark(
  runs: TextRun[],
  from: number,
  to: number,
  mark: InlineMark
): TextRun[] {
  // 1. split runs at from/to
  // 2. 若 [from,to) 全部已带 mark → 全部 remove
  // 3. 否则全部 add（code 则 strip 其它 marks）
  // 4. normalizeRuns（合并相邻同 marks）
  // 5. return
}
```

DOM 侧：`surroundContents` 仅作可选优化；失败时 **整段 runsToDom 替换 + setCaret**，保证正确性优先。

### 5.4 与 `beforeinput` format 类型

现代 Chromium 对 Ctrl+B 可能发 `beforeinput`：`inputType = formatBold`。

```ts
editEl.addEventListener('beforeinput', (e: InputEvent) => {
  if (composing) return;
  const map: Record<string, InlineMark['type']> = {
    formatBold: 'bold',
    formatItalic: 'italic',
    formatStrikeThrough: 'strike',
    // formatUnderline: 忽略或 map 自定义
  };
  const t = map[e.inputType];
  if (t) {
    e.preventDefault();
    toggleMarkOnSelection(t);
  }
});
```

这样即使系统菜单触发 format，也不走 execCommand。

---

## 6. IME（中文输入）硬约束

### 6.1 状态机

```
idle ──compositionstart──► composing
composing ──compositionupdate──► composing（仅浏览器预览）
composing ──compositionend──► commit ──► idle
任意 ──blur during composition──► pendingLeave；end 后再 leaveEdit
```

### 6.2 禁止清单（composing === true）

| 禁止 | 原因 |
|------|------|
| as-you-type 折叠 | 组字中间字符非最终 |
| `innerHTML` 整表替换 / `textContent` 整清 | 断 IME 会话 |
| leaveEdit / enterEdit / 跨块方向键拆并 | 丢候选 |
| 打开 slash 并 focus 面板 | 抢焦点 |
| pushHistory 逐字 | undo 碎片 |
| toolbar 显示并 apply | 选区不稳 |
| autosave flush 强制读中间态为最终 | 脏数据 |

### 6.3 允许清单

| 允许 | 说明 |
|------|------|
| 浏览器默认 composition 下划线 | 不干预 |
| `compositionupdate` 更新本地 draft 字符串（可选，不进 model 最终） | 调试 |
| `compositionend` 一次 `domToRuns` + `updateBlock` + **单条 history** | 必须 |
| end 后 `maybeApplyAutoMark` | 最终文本再折叠 |
| end 后处理 `pendingLeave` / slash 检测 | 对齐 03 |

### 6.4 事件伪代码

```ts
let composing = false;
let compositionOriginSnapshot: Doc | null = null;

surface.addEventListener('compositionstart', () => {
  composing = true;
  compositionOriginSnapshot = model.snapshot(); // 或 block 级
  pauseSlash();
  hideSelectionToolbar();
});

surface.addEventListener('compositionend', () => {
  composing = false;
  const runs = domToRuns(surface);
  model.updateBlock(id, { runs, text: serializeInline(runs) }, {
    addToHistory: true,
    reason: 'ime',
    // 理想：用 origin→end 合成一条，而非 start 时已 push
  });
  maybeApplyAutoMark(id);
  resumeSlashDetect();
  flushPendingLeave();
});
```

History 推荐：composition 期间 `addToHistory: false` 的中间 update **全部不写**；仅 end 写一次。若实现只在 end 读 DOM，则 start 无需 snapshot。

### 6.5 平台注记

| 环境 | 注意 |
|------|------|
| Chromium / Edge / Tauri WebView2 | composition 事件完整；主目标 |
| Safari | blur 时可能强制 end；测 pendingLeave |
| 搜狗/微软拼音 | 候选栏上屏后才 end；勿在 update 折叠 |
| 日文/韩文 | 同 composition 模型，复用规则 |

---

## 7. Undo / Redo

### 7.1 单一真相：文档级快照栈

现有 `MdxModel`：

- `undoStack` / `redoStack`，上限 100  
- `pushHistory` 在 `updateBlock` / `insert` / … 默认触发  

v3 增强 meta（对齐 architecture Transaction）：

```ts
interface HistoryMeta {
  addToHistory?: boolean;      // default true
  mergeKey?: string;           // 如 `type:${blockId}`
  mergeWindowMs?: number;      // default 400
  source?: 'input' | 'ime' | 'toolbar' | 'paste' | 'api' | 'may';
}
```

### 7.2 合并策略

| 来源 | mergeKey | 行为 |
|------|----------|------|
| 连续英数输入同一块 | `type:${id}` | 时间窗内合并为一条 undo |
| IME 整次 composition | `ime:${id}:${seq}` | **一条**，不与前后英数误合并 |
| toolbar toggleMark | `mark:${id}` 或 null | **立即独立一条**（用户期望一次撤销掉格式） |
| as-you-type 折叠 | 与触发它的输入同条或紧随一条 | 推荐：折叠与最后输入 **同一 merge 窗** 或显式一条 `may` |
| 结构性 Enter/删块 | null | 永不与输入合并 |

### 7.3 禁止双栈

- **不要**依赖 `document.execCommand('undo')`。  
- 宿主 Ctrl+Z：`keydown` 捕获 → `model.undo()` → 重渲脏块 + 恢复 selection（若快照含 selection；否则 focus 原块末尾）。  
- 浏览器默认 undo 在 CE 上可能仍触发：对 edit surface `beforeinput` `historyUndo`/`historyRedo` **preventDefault** 并转交 model。

### 7.4 折叠与 undo 用户预期

用户输入 `**hi**`：

1. 期望一次 Ctrl+Z → 回到折叠前带定界符？还是去掉整个 hi？  
2. **产品决策（冻结）**：as-you-type 折叠与其触发键 **合并为一条**；Ctrl+Z 一次恢复为折叠前文本（含定界符）或恢复到折叠前 runs。  
3. 再 Ctrl+Z 按 merge 窗回退更多输入。

---

## 8. 粘贴与外源 HTML

### 8.1 优先级

1. `text/markdown` 或看起来像 MD 的 plain → `parseInline` / 块级 paste 管线  
2. `text/html` → 白名单标签 → runs（b/strong/i/em/del/code/a/mark）  
3. plain → 单 run 无 marks  

### 8.2 清洗

- 剥 `style`/`class`（除 mdx 认识的）  
- `a[href]` sanitize  
- 禁止 `script`、事件属性  
- 表格单元格内粘贴：仅 inline，不插入块级 table

### 8.3 粘贴后

- `normalizeRuns`  
- **不**立即对整段跑 as-you-type（避免粘贴 `**a**` 被二次处理）；plain 中的定界符保留，由用户编辑或显式「解析粘贴」；**例外**：若产品要「粘贴 MD 即渲染」，在 paste 路径直接 `parseInline`，不经 as-you-type 状态机。

---

## 9. pure-gfm 与扩展降级

| Mark | GFM | pure-gfm 导出 |
|------|-----|----------------|
| bold/italic/strike/code/link | 是 | 原样 |
| highlight `==` | 否 | `meta.pureGfm` 时 → 纯文本或 `**` 降级（配置项 `highlightFallback: 'strip' \| 'bold'`） |
| mention | 否 | 标签文本或扩展语法 |

---

## 10. 模块划分（实现落点）

建议在 TS 包（见 07）中：

```
packages/conex-mdx/src/
  inline/
    types.ts           # TextRun, InlineMark
    parse-inline.ts    # MD string → runs
    serialize-inline.ts
    normalize.ts
    toggle-mark.ts
    detect-delimiter.ts  # as-you-type
    dom-bridge.ts        # domToRuns / runsToDom / caret
  ui/
    selection-toolbar.ts
```

Reference vanilla 可先加 `js/markdown-editor/inline/*.js` 再迁 TS。

---

## 11. 与块类型矩阵

| 块类型 | 实时 marks | as-you-type | 工具条 |
|--------|------------|-------------|--------|
| paragraph | ✅ | ✅ | ✅ |
| heading | ✅ | ✅ | ✅ |
| bullet/ordered/task item | ✅ | ✅ | ✅ |
| quote | ✅ | ✅ | ✅ |
| callout 正文 | ✅ | ✅ | ✅ |
| table cell | ✅（单元格内） | 可选关闭 `\|` 冲突敏感时 | ✅ |
| code | ❌ | ❌ | ❌ |
| divider / image / file_chip | ❌ | ❌ | ❌ |
| math / mermaid | ❌ 源码态 | ❌ | ❌ |

---

## 12. 性能预算

| 操作 | 预算（P95） |
|------|-------------|
| 单字符 input + 无折叠 | ≤ 8ms |
| 折叠检测 + DOM patch | ≤ 12ms |
| toggleMark 中等选区（<5k chars） | ≤ 16ms |
| compositionend commit | ≤ 16ms |

手段：仅脏块；runs normalize O(n)；禁止全文档 serialize on each key（autosave debounce 300–500ms）。

---

## 13. 测试计划

### 13.1 单元：`parseInline` / `serializeInline`

| 用例 | 输入 | 期望 |
|------|------|------|
| bold | `a**b**c` | runs: a / b+bold / c |
| italic vs bold | `**a*b*c**` | 文档化实际策略；快照锁定 |
| code 优先 | `` a`b*c`d `` | `*` 不进 italic |
| strike | `~~x~~` | del |
| highlight | `==y==` | highlight mark |
| link | `[t](https://e.com)` | link href |
| 往返 | serialize(parse(s)) | 语义相等（允许 `*`/`_` 归一） |

### 13.2 单元：`toggleMark`

| 用例 | 期望 |
|------|------|
| 无 mark 选区加 bold | 中间 run 带 bold |
| 已全 bold 再 toggle | 去掉 bold |
| 半选 | split 三 run |
| code 覆盖 | 去掉 bold/italic |
| normalize 合并 | 相邻同 mark 合并 |

### 13.3 单元：`detectClosingDelimiter`

| 输入 plain + caret | hit |
|--------------------|-----|
| `**hi**\|` | bold on hi |
| `*hi*\|` | italic |
| `~~hi~~\|` | strike |
| `==hi==\|` | highlight |
| `` `hi`\| `` | code |
| `[hi](u)\|` | link |
| `**hi*\|` | null |
| `a * b *\|` | null（空格规则） |
| 含 `\n` 跨行 `**` | null（v3） |

### 13.4 集成：IME

```js
// 伪测试
fire(surface, 'compositionstart');
// 模拟插入临时文本
assert(model 未多条 history);
fire(surface, 'compositionend');
assert(block.runs 含「你好」);
assert(undoStack 增量 === 1);
```

### 13.5 集成：toolbar

- 选中单词 → 点 B → DOM strong + runs bold + Ctrl+Z 恢复  
- mousedown 工具条不丢选区  
- viewOnly 不显示  

### 13.6 集成：execCommand 关闭

- flag off 时 Ctrl+B 仍生效（beforeinput/快捷键）  
- 无 `document.execCommand` 调用（spy）

### 13.7 往返与 golden

- 扩展现有 `tests/markdown-editor/roundtrip.test.js` 的 `inline marks` 用例  
- 增加 highlight、嵌套拆分 golden 文件

### 13.8 手工验收清单（中文桌面）

- [ ] 微软拼音输入「连接器」组字中无闪烁、无丢字  
- [ ] 输入 `**粗体**` 闭合后立即变粗、定界符消失  
- [ ] `*斜体*` 与 `**粗体**` 连续使用不串味  
- [ ] `` `code` `` 内 `*不*解析`  
- [ ] `~~删~~`、`==高亮==`  
- [ ] 选区工具条加粗与键盘 Mod+B 一致  
- [ ] Ctrl+Z 撤销折叠符合 §7.4  
- [ ] 表格单元格内加粗可序列化  
- [ ] 粘贴 Word HTML 不炸、无脚本  

---

## 14. 验收标准（DoD）

1. 段落中 as-you-type 六类语法（含 highlight、链接）行为稳定。  
2. IME 零回归（对照 03 中文验收）。  
3. selection-toolbar 与 runs 同源，无 execCommand 默认路径。  
4. undo 单栈，无浏览器/模型双栈打架。  
5. `getMarkdown()` 含正确 GFM 定界符；再 `setMarkdown` 往返语义保持。  
6. 本文测试矩阵 P0 全绿。

---

## 15. 开放问题（记录，不阻塞 P0）

| ID | 问题 | 倾向 |
|----|------|------|
| Q1 | `***` 三星号 CM 全兼容 | P1；P0 分步 |
| Q2 | `_italic_` as-you-type | 默认关 |
| Q3 | 跨块选区统一 marks | P1 |
| Q4 | highlight 的 pure-gfm 默认 | strip |
| Q5 | 链接编辑 popover UI | 随 06 showcase |

---

## 16. 参考实现锚点（仓库内）

| 路径 | 角色 |
|------|------|
| `js/markdown-editor/util.js` | `inlineHtml` / `htmlToInlineMd` — 迁 `dom-bridge` 前身 |
| `js/markdown-editor/ui/selection-toolbar.js` | 工具条 UI + 旧 execCommand |
| `js/markdown-editor/editor.js` | `textFromEditEl`、`onSelCommand`、`composing` |
| `js/markdown-editor/schema.js` | `cloneRuns` / Doc v2 |
| `js/markdown-editor/model.js` | undo 栈 |
| `docs/markdown-editor/03-line-renderer.md` §5–6 | 策略原文 |
| `docs/markdown-editor/01-architecture.md` § TextRun / IME | 类型与事务 |

---

**文档结束（04）** · 实施勾选见 [10-implementation-plan.md](./10-implementation-plan.md)（合成后）。
