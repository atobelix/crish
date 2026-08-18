# 03 — 行内 marks 源码可见性 UX（定界符 / Typora 感）

> **分册**：`docs/markdown-editor/ux-readiness/03-inline-marks-source-ux.md`  
> **日期**：2026-08-03  
> **读者**：产品拍板、U2 实现 agent、QA  
> **角色**：只读分析 + 策略冻结草案；**本轮不写运行时代码**  
> **决策挂钩**：[00-MASTER-READINESS.md](./00-MASTER-READINESS.md) §4.2 **D2** · [08-decision-log.md](./08-decision-log.md) **ux-D2**  
> **规格对照**：`feature-catalog/01` F-INL-* / §2.5 · `v3-complete/04-inline-marks-live.md`（历史 U3，部分与 catalog **冲突**）  
> **代码锚点**（reference IIFE）：  
> - `js/markdown-editor/inline/live-marks.js`  
> - `js/markdown-editor/inline/marks-model.js`  
> - `js/markdown-editor/inline/keymap-marks.js`  
> - `js/markdown-editor/util.js`（`inlineHtml` / `htmlToInlineMd`）  
> - `css/markdown-editor/inline-marks.css`（`.mdx-src-delim` 预留）  
> - `js/markdown-editor/editor.js`（`applyLiveMarks` / `MdxKeymapMarks` 接线）  
> **模块 owner**：`inline/*`（实现期禁止把策略堆回 `editor.js`）

---

## 0. 问题一句话

**W4 已把闭合 mark 折成语义 HTML（粗体/斜体/…），但闭合后定界符从视觉与可编辑 DOM 中消失。**  
用户聚焦/选中已格式化文本时 **看不到 `**` / `*` / `` ` `` / `~~` / `[]()`**，也无法像 Typora 那样用 Backspace 从边界「拆开」格式——这是「能跑」与「Markdown 原生好用」之间最大的行内体验债之一。

| 用户说法（H3） | 现状 |
|----------------|------|
| 聚焦时仍好看 | 部分达成：body 仍渲染 strong/em… |
| 需要时能看到 `**` / `#` | **未达成**：结构前缀 `##`/`*` 有 line-source；**行内定界符无邻域显源** |

---

## 1. 用户期望（Typora 对照）

### 1.1 产品定位回放

| 维度 | Conex 冻结方向 | 不是 |
|------|----------------|------|
| 底层 | Markdown / GFM 可往返 | 私有富文本为主 |
| 编辑 UX | 块级 + **行源码聚焦** | 整页 source-only / 纯 Notion 无源 |
| 行内 | 渲染为主 + **需要时见定界符** | 永远裸 MD 墙 / 永远零源码 |
| 格式入口 | 快捷键 + 源码手感 | 默认依赖 `mdx-sel-bar` |

证据：

- catalog 01 §0.2 / §0.4：文本块 **line-source**；正文 marks **可折叠渲染**，定界符在 **caret 邻近可显示**。  
- catalog 01 §2.5 表：Idle = 最终渲染；Line-source 正文默认仍渲染 marks，**定界符 as-you-type / 邻近策略见 F-INL**。  
- F-INL-BOLD Gold：「输入闭合 `**` 后内容变粗，**定界符折叠（caret 邻近可显）**」。  
- 00-MASTER D2：**推荐 A · Caret 邻域显源**。

### 1.2 Typora 行为（可感知对照）

> 目的是借「好用感觉」，不是逐像素抄实现。

| 场景 | Typora 大致体验 | Conex 目标采纳 |
|------|-----------------|----------------|
| 文档 idle | 全文实时渲染，无 `**` | **采纳** |
| 光标进入已加粗词 | 该处 `**…**` 以灰/淡定界符露出，内容仍粗 | **采纳（邻域）** |
| 光标在普通文本 | 远处 bold 仍只显示粗体，不露 `**` | **采纳** |
| 键入 `**hi**` 闭合瞬间 | 折叠为粗体，定界符收起（可再进邻域露出） | **采纳** |
| 未闭合 `**hi` | 源码可见，等待闭合 | **采纳** |
| 选中部分加粗范围 | 边界与选区协同；可删/改格式 | **采纳原则** |
| Ctrl+B | toggle 格式；视觉与源模型一致 | **采纳**（走 runs，非 execCommand） |
| 链接 | 锚文渲染；编辑时见 `[]()` 或专用 UI | **采纳变体**（见 §7） |

### 1.3 Notion 对照（刻意不抄的部分）

| Notion | Conex 立场 |
|--------|------------|
| 几乎永不显示 MD 定界符 | **否作默认**（违背 MD 原生；导出惊喜） |
| 强依赖选区工具条 | **默认关** sel-bar（F-CORE-08） |
| 私有属性/块类型为王 | 序列化真相仍是 MD |

### 1.4 与历史文档冲突（仲裁）

| 文档 | 表述 | 仲裁 |
|------|------|------|
| `v3-complete/04` U3 / §3.2 | 编辑态 **不显示** `**bold**` 源码 | **降级为历史草稿**；catalog 01 + ux-D2 优先 |
| catalog 01 F-INL Gold | 折叠 + **caret 邻近可显** | **权威产品方向** |
| 00 / 08 ux-D2 | 邻域显源推荐 A | **U2 默认**；关闭后写进 CROSSCUTTING |

**结论**：用户期望 = **「阅读精致 + 编辑时 Markdown 可触达」**，不是纯 WYSIWYG，也不是聚焦后整段变 raw。

---

## 2. 现状算法与失败模式

### 2.1 模块与数据流（现状）

```
[用户输入 / 粘贴 / Ctrl+B]
        │
        ▼
 editor.js  onEditInput / keydown
        │  (composing? → 跳过)
        ▼
 MdxLiveMarks.applyLiveMarks(editEl)          // live-marks.js
        │
        ├─ htmlToInlineMd(el)                 // util.js：DOM → MD 字符串
        ├─ MdxMarksModel.parseInline(md)      // 闭合 → run；未闭合留 text
        ├─ runsToEditHtml(runs)               // 闭合 → <strong>/<em>/…；**不插定界符**
        ├─ normalizeHtml 比较 → 可能 innerHTML 整换
        └─ getCaretMdOffset → setCaretMdOffset // MD 偏移含虚拟定界符长度
```

快捷键路径：

```
MdxKeymapMarks.toggleMarkOnSelection
  → MD 切片 toggleWrapMd / 插入 open+close
  → mdToEditHtml → innerHTML
  → setCaretMdOffset / trySelectMdRange
  → editor onEditInput 再 commit
```

读态（非编辑）：

```
MdxUtil.inlineHtml(text)  // 正则折 strong/em/code/a/…；与 marks-model 双路径
```

### 2.2 关键算法细节（有证据）

#### A. `parseInline`（`marks-model.js`）

- **仅闭合**定界符成为 mark run；未闭合的 `*` `` ` `` `~` `=` `+` `[` 留在 `type:'text'`。  
- 优先级：`` `code` `` → 链接 `[text](url)` → `**bold**` → `~~strike~~` → `==highlight==` → `++underline++` → `*italic*`。  
- 行内 marks **不跨 `\n`**（`findClose` 遇换行返回 -1）。  
- bold/italic 内侧贴空格则 **不** 折叠（防 `3 * 4 * 5`）。  
- 嵌套：bold 内可递归 parse；**扁平 runs**（非嵌套树）。  
- link label：**W4 当纯文本**，label 内 marks 不二次展开。

#### B. `runsToEditHtml`（折叠显示的根因）

闭合 mark 一律：

| run.type | DOM | 定界符是否出现在 DOM |
|----------|-----|----------------------|
| bold | `<strong>text</strong>` | **否** |
| italic | `<em>` | **否** |
| strike | `<del>` | **否** |
| code | `<code class="mdx-code">` | **否** |
| highlight | `<mark class="mdx-mark-hl">` | **否** |
| underline | `<u>` | **否** |
| link | `<a class="mdx-a" href=…>` | **否**（url 在属性） |
| text | 转义文本 | 原文（可含未闭合 `**`） |

→ **一旦闭合成功，用户在 contenteditable 里永远看不到 `**`。**

#### C. `applyLiveMarks`（live-marks.js）

1. `htmlToInlineMd` 把语义标签 **还原为带定界符的 MD**。  
2. 再 parse + `runsToEditHtml` **立刻再折掉定界符**。  
3. 若 HTML 规范化后有变化 → `editEl.innerHTML = next` **整块替换**。  
4. 用 **MD 语义偏移**（`delimLens` 给 strong 计 open=2 close=2 等）恢复 caret。

`delimLens` 要点（仅用于 caret 映射，**不渲染**）：

| 标签 | open | close |
|------|------|-------|
| strong/b | 2 | 2 |
| em/i | 1 | 1 |
| del/s | 2 | 2 |
| code | 1 | 1 |
| mark / u | 2 | 2 |
| a | 1 | 3 + href.length（`[text](url)`） |
| br | 0（计 1 个换行） |

#### D. 接线（editor.js）

- `input` 防抖后 `applyLiveMarks`（非 code 块、非 composition）。  
- `compositionend` 再调一次 `applyLiveMarks`。  
- `MdxKeymapMarks.handleKeydown` 处理 Ctrl/Cmd+B/I/E/U/Shift+S|X/H。  
- commit 仍走 `htmlToInlineMd` → `block.text`（runs 真相未完全切换）。

#### E. CSS 预留

`inline-marks.css` 已有 `.mdx-src-delim` 灰显规则，注释写「**若未来插入**」——**运行时从未生成该类节点**。

### 2.3 失败模式清单（用户可感知）

| ID | 失败模式 | 根因 | 严重度 |
|----|----------|------|--------|
| FM-1 | 聚焦已加粗文本，看不到 `**`，不知如何「取消粗体」除 Ctrl+B | `runsToEditHtml` 永不插 delim | **P0** |
| FM-2 | Backspace 在粗体词首只删字，不能「拆开」开定界符 | DOM 无定界符字符；无成对删除 API | **P0** |
| FM-3 | 选中半个 bold 范围再输入/改格式，边界不可见 | 无选区感知显源 | **P0** |
| FM-4 | 整段 `innerHTML` 替换 → caret 微跳 / 选区丢失 | `applyLiveMarks` 全量换 DOM | **P0–P1** |
| FM-5 | MD 偏移与视觉偏移双轨：`getCaretMdOffset` vs `getCaretOffset` | 语义映射只服务折叠路径 | **P1** |
| FM-6 | 链接只见锚文，不知 url；改字可能丢 href（依赖 `htmlToInlineMd` 读 a[href]） | link 无源模式/popover | **P0** |
| FM-7 | 读态 `inlineHtml` 与写态 `parseInline` **双解析器** 边界不一致 | 两套正则/扫描 | **P1** |
| FM-8 | bold 内嵌套后 `runsToEditHtml` 丢失外层 bold 包（内层非 text 时只 push 内层） | 扁平化过度简化 | **P1** |
| FM-9 | Ctrl+B 折叠选区时 `trySelectMdRange` 简化易失败 | 选区恢复弱 | **P1** |
| FM-10 | composition 中若误调 `innerHTML` 会断 IME | 主路径有 guard，但任何新显源逻辑须继承 | **P0 约束** |
| FM-11 | 未闭合定界符 **可见**（text 路径），闭合后突然消失 → 「闪一下」 | 无过渡/邻域策略 | **P1 UX** |
| FM-12 | 用户期望「像 Typora 改 `**`」但模型是「像 Notion 改样式」 | 产品文档 U3 vs catalog 摇摆 | **决策债** |
| FM-13 | `normalizeHtml` 压缩空白可能误判「无变化」跳过更新 | 空白敏感内容 | **P2** |
| FM-14 | 表格格内 / 列表 body 共用 applyLiveMarks，但无邻域策略时体验一致地「瞎」 | 表面多、策略零 | **P1** |

### 2.4 与「结构行源码」的不对齐

line-source 已对 **块结构前缀** 做 soft/hard 标记（`data-mdx-mark`：`##`、`*`、`>`…）：

- 失焦：圆点 / 标题样式，无源字符感。  
- 聚焦：灰源标记可点。

**行内 marks 没有对等的 soft/hard 定界符层**——这是本分册要补的「正文侧 line-source」。

---

## 3. 显示策略矩阵

> 行 = 交互态；列 = 视觉与可编辑性。  
> **推荐策略（D2-A）** 填「目标」列；「现状」列描述 W4 真实行为。

### 3.1 总矩阵

| 交互态 | 现状显示 | **目标（D2-A 邻域显源）** | 模型真相 |
|--------|----------|---------------------------|----------|
| **失焦 · 全文 idle** | `inlineHtml` 语义渲染，无定界符 | 同现状：精致阅读 | `block.text` / 未来 `runs` |
| **聚焦块 · caret 不在任何 mark 内** | 全部闭合 mark 仍折叠 HTML | **同**：远处 marks 保持渲染折叠；**不**整块变 raw | runs |
| **光标在 mark 内容内** | 仅样式，无 `**` | **露出该 mark 成对定界符（灰）** + 内容仍带样式 | runs + reveal 集合 |
| **光标紧贴 mark 边界（开/闭前一码点）** | 无 | **同 mark 定界符露出**（邻域含边界） | 同上 |
| **选中部分 mark（半选）** | 浏览器选中 strong 内文本 | **该 mark 定界符露出**；选区覆盖部分内容；格式命令按 model 区间 | range ∩ mark |
| **选中完整 mark + 两侧文本** | 样式混选 | 涉及 marks **全部** 可露出定界符，或仅两端（见 §4.3） | range |
| **选中跨多个 mark** | 多标签 DOM 选区 | **不要求**全部显源；命令走 model 切片；可选露出 range 内全部 delim | range |
| **未闭合定界符** | text 中可见源码 | **保持源码可见**（不假装 mark） | text run |
| **as-you-type 刚闭合** | 立即 `<strong>`，delim 消失 | 折叠渲染；若 caret 仍在内容/边界上则 **邻域立即 reveal**（可 0～1 帧） | runs |
| **IME composing** | 禁止 applyLiveMarks | **冻结** reveal/fold 切换；end 后一次 reconcile | draft DOM |
| **viewOnly** | 只读渲染 | 无显源 | — |
| **代码块 / fence 源** | 整段源 | 行内 marks **关闭** | 源字符串 |

### 3.2 各 mark 类型矩阵（编辑聚焦态）

| Mark | 定界符 | 失焦 | caret 在内容内 | 未闭合 | 备注 |
|------|--------|------|----------------|--------|------|
| bold | `**`…`**` | 粗 | 灰 `**` + 粗内容 | 源 | 序列化偏好 `**` 非 `__` |
| italic | `*`…`*` | 斜 | 灰 `*` | 源 | 行首 `* ` 归 promote，不进 italic |
| strike | `~~`…`~~` | 删线 | 灰 `~~` | 源 | |
| code | `` ` ``…`` ` `` | 等宽底 | 灰 `` ` ``；**内部不解析** | 源 | 优先最高 |
| highlight | `==`…`==` | mark 底 | 灰 `==` | 源 | P1 扩展；pure-gfm 可剥 |
| underline | `++`…`++` | u | 灰 `++` | 源 | P1；与 link 底边可辨 |
| link | `[` `](` url `)` | 锚文+样式 | **特例** §7 | 半写源可见 | 勿丢 href |
| image 行内 | `![alt](src)` | 视媒体策略 | 见 media 分册 | — | **本册不主责** |

### 3.3 结构前缀 vs 行内 delim（勿混）

| 种类 | 载体 | 模块 | 显隐 |
|------|------|------|------|
| 块结构源（`##`、列表 `*`、`>`） | `[data-mdx-mark]` soft/hard | `ui/line-source.js` | 聚焦块即结构可见 |
| 行内定界符（`**`…） | 建议 `.mdx-src-delim` / data 属性 | **`inline/*`** | **caret/选区邻域** |

两者可同时出现（例：聚焦标题行 → 灰 `##` + 正文内邻域 `**`），但 **生命周期与 owner 分离**。

---

## 4. 推荐：边界露出灰标记 vs 整段 raw

### 4.1 三选一（对齐 ux-D2）

| 方案 | 一句话 | 观感 | 实现成本 | 推荐 |
|------|--------|------|----------|------|
| **A. Caret 邻域显源** | 仅 caret/选区触及的 mark 露出灰定界符；其余折叠 | Typora 感；idle 精致 | 中高 | **默认** |
| B. 聚焦块全文 raw marks | 进编辑 → body 全是 `**x**` 字符串 | 丑；像半成品 | 低 | **否** |
| C. 永不显源 | 纯快捷键 WYSIWYG | Notion；MD 不可触达 | 低（现状接近 C） | **否作默认** |

### 4.2 为何否决 B / C

- **B**：与 catalog 金标准「未点任何块像导出预览；点中仍好看」冲突；长段落满屏 `**`/`*` 会制造视觉噪声与误触。  
- **C**：现状实质接近 C；用户无法确认「这是 Markdown 粗体」还是「浏览器 bold」；Backspace 拆格式直觉失效；与「Markdown 原生」定位冲突。  
- **A**：与结构 line-source 哲学一致——**需要时露出源，不需要时精致**。

### 4.3 方案 A 细则（U2 实现契约草案）

#### 4.3.1 Reveal 集合

```
reveal(markRun) 当且仅当：
  1) caret 落在该 run 的 [openStart, closeEnd] 语义区间内（含开闭定界符虚拟位），或
  2) 非折叠选区与该 run 语义区间相交，或
  3) as-you-type 未闭合的开放定界符（本就在 text 中，无需 reveal 标志）
```

- **邻域窗口**：默认 **当前 1 个 mark run**（00-MASTER：± 邻接可后续扩到相邻 delim；P0 不做整行连锁）。  
- **嵌套/相邻**：`**a*b*c**` 扁平后多 run 时，caret 在哪段 reveal 哪段；不做 CM 完美嵌套树。

#### 4.3.2 DOM 形态（推荐）

**优先：边界灰节点 + 内容语义标签**（非整段 raw）。

```html
<!-- 未 reveal -->
<strong>粗体词</strong>

<!-- reveal（caret 在词内） -->
<span class="mdx-src-delim" data-mdx-delim="bold-open" contenteditable="false">**</span><strong>粗体词</strong><span class="mdx-src-delim" data-mdx-delim="bold-close" contenteditable="false">**</span>
```

| 属性 | 选择 | 理由 |
|------|------|------|
| 样式 | 沿用 `.mdx-src-delim`：L2 灰、opacity ~0.7、font-weight 400 | CSS 已预留 |
| `contenteditable` | **推荐 `false`** | 避免半删一个 `*` 产生非法 MD；删除走「成对 API」 |
| 可选 `user-select` | 默认 `none`（与现 CSS 一致）或允许选中复制源 | P0：`none`；复制 MD 走序列化 |
| 等宽 | 可选 `font-family: mono` 仅 delim | 与结构 mark 视觉家族一致 |

**备选（不推荐 P0）**：整 mark 展开为纯文本 `**粗体词**` 再编——等于局部 B，caret 映射简单但会丢即时样式感。

#### 4.3.3 删除 / 编辑语义（成对 API）

| 用户动作 | 期望 |
|----------|------|
| caret 在内容中 Backspace 正常删字 | 不变 |
| caret 紧贴开 delim 之后，Backspace | **删除成对定界符** → 去掉 bold mark，保留文本 |
| caret 在闭 delim 之后，Backspace | 同上或先吃闭 delim 再成对（产品选一种，推荐 **一次成对**） |
| Delete 在开 delim 前 | 成对去除 |
| 选中灰 delim  alone | 成对去除 |
| 直接键入改 `**` 为 `*` | **P1**：若 delim 不可编辑，则不支持「手改定界符字符」；改 italic 用 Ctrl+I / 重包 |

> P0 明确：**灰 delim 不是自由文本编辑器**，是 **可见的格式手柄**。  
> 若未来要「真·改源码字符」，再开局部 raw 模式（决策另开），勿与邻域灰标混成半残。

#### 4.3.4 与 `htmlToInlineMd` / caret 映射

- **真相优先 runs**（中期）：`domToRuns` 直接读标签 + data-mdx-delim，避免「先串 MD 再 parse」丢精度。  
- **兼容期**：若仍 MD 往返，`htmlToInlineMd` 必须：  
  - 识别 `.mdx-src-delim` **不重复**输出定界符（标签已隐含 + delim 节点文本）；或  
  - delim 节点 `data-mdx-delim` 只作装饰，`nodeToInlineMd` **跳过** delim 文本。  
- `getCaretMdOffset` / `setCaretMdOffset`：  
  - reveal 时若 delim 在 DOM 中 **真实占位**，视觉偏移与 MD 偏移可对齐（优于现状「虚拟 open/close」）；  
  - 若 delim `contenteditable=false` 且不可放置 caret，映射须把「落在 delim 上」吸附到内容边界。

#### 4.3.5 刷新策略（防闪）

| 禁止 | 允许 |
|------|------|
| 每次 `selectionchange` 全 `innerHTML` 重挂 | 仅 **reveal 集合变化** 时 patch 受影响 mark 的两端节点 |
| composition 中切换 reveal | end 后一次 |
| 与 height-lock 打架的整块替换 | 最小 DOM patch；高度 lock 仍按块级 enter/leave |

性能预算（对齐 v3-04 §12，可略宽）：

| 操作 | P95 |
|------|-----|
| 无 reveal 变化的 input | ≤ 8ms |
| reveal 集合变化 patch | ≤ 12ms |
| applyLiveMarks 闭合折叠 | ≤ 12ms |

---

## 5. caret 稳定算法要求

### 5.1 不变量

1. **单一偏移坐标系（目标）**：块内 **MD 语义偏移** 或 **runs 平坦 UTF-16 偏移** 二选一为真相；DOM 只是投影。  
   - 现状：`getCaretMdOffset` 已走语义（含虚拟 delim 长度）——方向正确。  
   - 引入真实 `.mdx-src-delim` 后，必须 **重定义** `nodeMdLength`：delim 节点计 open/close 长度，且 **strong 不再双重计**。  
2. **折叠/显源不得改变语义 offset 处的「逻辑字符」**：用户感知的「我在 h 后面」在 reveal 前后应对同一 MD 位置。  
3. **IME**：`composing === true` 时禁止 `innerHTML` 整换、禁止 reveal 切换、禁止 leave 块。  
4. **选区非折叠**：格式化 / live fold 后尽量恢复 `[from,to)`；失败则折叠到 `to` 并记可测日志（开发态）。  
5. **原子节点**（file-chip / wiki / 未来 mention）：caret 映射跳过内部；不参与行内 delim reveal。

### 5.2 推荐算法步骤（实现纲要，非本轮代码）

```
onSelectionChange | afterInput | afterToggleMark:
  if composing: return
  md = domToMd or runs snapshot
  caret = getSemanticOffset(editEl)   // 统一 API
  revealSet = computeRevealSet(runs, caret, selectionRange)
  if revealSet equals lastRevealSet and no fold change: return
  patchDomReveal(editEl, runs, revealSet)  // 最小补丁
  setSemanticOffset(editEl, caret)         // 或 restore range
  lastRevealSet = revealSet
```

### 5.3 吸附规则

| 落点 | 吸附 |
|------|------|
| 命中 `contenteditable=false` 的 open delim | 内容首字符前 |
| 命中 close delim | 内容末字符后 |
| 命中 `<br>` | 行边界策略与现 live-marks 一致 |
| 空 strong | 不允许空 mark run；normalize 删空 |

### 5.4 与 height-lock / enterEdit

- enterEdit 初次 `mdToEditHtml`：**默认不 reveal**（caret 将 place 到末尾；若末尾落在 mark 内再 reveal）。  
- 点击命中加粗词中部进入：应 **先** place caret 到点击 offset，**再** reveal（避免先全 raw 再跳）。  
- leaveEdit：丢弃 reveal 装饰，读态纯 `inlineHtml`。

### 5.5 测试锚（caret）

| 用例 | 期望 |
|------|------|
| `a**b**c`，caret 在 b 中，reveal 后 offset 语义不变 | 仍指向 b 内同一码点 |
| 闭合 `**` 折叠后 caret 在内容后 | 不跳到块首/块尾 |
| IME 组字「你好」中途 | offset 不丢、无闪 |
| Ctrl+B 包裹选区 | 选区仍覆盖原字 |
| 连续左右移动穿过 mark 边界 | reveal 切换无「字跳动」（布局宽度变化可接受但应小：灰 `**` 窄） |

**布局抖动**：灰 `**` 插入会增加行宽 → 可能轻微 reflow。缓解：  
- delim 用窄字重/略小字号；  
- 或预留 padding（P1）；  
- **禁止**用绝对定位假字符导致点击错位。

---

## 6. 快捷键 Ctrl+B 与源显示协同

### 6.1 现状

`keymap-marks.js`：

| 快捷键 | mark |
|--------|------|
| Mod+B | bold |
| Mod+I | italic |
| Mod+Shift+S / Mod+Shift+X | strike |
| Mod+E | code |
| Mod+Shift+H | highlight |
| Mod+U | underline |

算法：`htmlToInlineMd` → 对选区 `toggleWrapMd` 或折叠处插入 `open+close` → `mdToEditHtml` → 设 caret/选区。

**问题**：toggle 后 DOM 立即无 delim → 用户看不出「刚加上的是 MD 粗体」；折叠插入 `****` 时 caret 夹在中间，随后 `applyLiveMarks` 可能把空内容规则与用户预期搅在一起（空 inner 不构成 mark）。

### 6.2 目标协同规则

| 场景 | 行为 |
|------|------|
| **有选区** toggle on | model 加 mark → DOM 带样式；**若选区仍在，reveal 该 mark 定界符**（可选 300–500ms 后若 caret 离开再收，P1） |
| **有选区** toggle off | 去 mark；无 delim |
| **无选区** Mod+B | 插入待填 mark 骨架：推荐 **插入空 bold 边界 + caret 在内容位**，并 **强制 reveal**；或插入 `****` 源直到用户输入闭合（二选一，推荐 **model 空 run + 灰 delim + caret 中**） |
| **与 as-you-type** | 共用 toggleMark / applyMark 内核；快捷键 **不**再走 execCommand |
| **beforeinput formatBold** | preventDefault → 同 toggle（v3-04 §5.4） |
| **跨块选区（U1 后）** | 命令作用 model 切片；**不**要求各块同时 reveal |
| **code 互斥** | 加 code 时 strip 其它 marks；reveal 仅 code delim |
| **undo** | toggle 独立 history 条；与 as-you-type 合并策略见 v3-04 §7 |

### 6.3 反模式

- 快捷键只 `execCommand('bold')` 出 `<b>`，再靠 `htmlToInlineMd` 猜 → **禁止主路径**。  
- 快捷键插入可见 `**` 源，但 `applyLiveMarks` 下一帧折掉且 caret 飞走 → **验收失败**。  
- 依赖 sel-bar 才能加粗 → **禁止**（F-CORE-08）。

### 6.4 Ctrl+K（链接）与本册

- 规格 F-INL-LINK：Ctrl+K / 轻量 popover。  
- **不**强制用邻域把整段 `](url)` 铺进正文（url 长时很吵）——见 §7。  
- keymap 现状 **无** Ctrl+K → U2/U4 补，但源显策略须预留。

---

## 7. 链接 / 图片行内特例

### 7.1 链接 `[text](url)`

| 态 | 显示 | 编辑 |
|----|------|------|
| 失焦 | 主题色锚文 + 底边；可配置是否可点跳转 | — |
| 聚焦 · caret 在锚文外 | 同渲染，不露源 | — |
| 聚焦 · caret 在锚文内 | **方案 L1（推荐）**：仍显示锚文样式 + **tooltip/小条显示 url**；灰标可只露 `[]` 或全文 `[](url)` 二选一 | 改字保留 href（DOM `a[href]` 或 runs） |
| 显式「编辑链接」 | Popover：text + url 字段（**非**整页 sel-bar） | 写回 runs |
| 未写完的 `[hi](ht` | 源码可见于 text | 不折叠 |
| 点击 | 编辑态默认 **preventDefault**（已有 `bindLinkGuard`）；Mod+点击可打开 | 保持 |

**为何链接特殊**：

- close 长度依赖 url（`delimLens` 已 `3+href.length`）——整段灰源会剧烈改变行宽与 caret。  
- url 常含 `?&` 等，塞进正文邻域噪声大。  
- 安全：`javascript:` 已在 `runsToEditHtml` / `inlineHtml` 降级；显源时也不得可执行。

**推荐冻结**：

1. P0：caret 在 link 内 → **不**默认展开完整 `](url)` 进 CE；用 `title`/轻量 chip 显示 url + 保留 `<a>`。  
2. P0：`htmlToInlineMd` / runs 保证改锚文不丢 href。  
3. P1：Ctrl+K / 双击链出口 popover 编辑 url。  
4. 若产品坚持 Typora 全源：仅 **popover 打开时** 或 **Alt+快捷键「显示链接源」** 局部 raw，不进默认邻域。

### 7.2 图片行内 `![alt](src)`

- 块级/媒体分册（catalog 04 / media）主责。  
- 行内若存在：编辑态倾向 **atom 节点**（不可把二进制塞进邻域源）；源编辑用单独 surface。  
- **本册验收不将行内图列为 P0**。

### 7.3 wiki / file chip

- `[[doc:]]` / `[[file:]]`：button atom；`inlineHtml` 已处理。  
- **不参与** `**` 邻域 reveal；内部不可 marks。

---

## 8. 与 as-you-type / 未闭合 / 双解析器

### 8.1 未闭合

保持现状哲学：**未闭合 = 源码字符在 text 中**，用户始终看见正在打的 `**`。

| 输入过程 | 显示 |
|----------|------|
| `**` | 两个源字符 |
| `**hi` | 源 |
| `**hi**` 闭合瞬间 | 折叠为 strong；若 caret 在 hi 上 → reveal 灰 `**` |

### 8.2 双解析器收敛（技术债）

| 路径 | 用途 |
|------|------|
| `util.inlineHtml` | 读态、部分 surface |
| `marks-model.parseInline` + `runsToEditHtml` | 编辑 live |

U2 要求：

- **金标准用例表** 两边同结果（bold/italic/code/link/strike/highlight/underline + 货币 `$` 与 math 分段）。  
- 中期只保留 **一条** parseInline；`inlineHtml` = `runsToReadHtml(parseInline(s))`。

### 8.3 空内容与非法

| 输入 | 行为 |
|------|------|
| `****` | 不构成 bold（parse 要求 inner 非空） |
| `** **` | 内侧空格 → 不折叠 |
| `` `` | 空 code 不折叠 |
| `[](url)` / `[t]()` | 不折叠 link |

---

## 9. 验收 15+ 条

> 勾选口径：人工剧本 + 自动化 harness（可挂 `tests/markdown-editor` / w4 harness）。  
> **全部 P0 为 U2 出口门禁**（与 00-MASTER U2 DoD 对齐）。

### 9.1 显示与邻域（P0）

1. [ ] **失焦**：`**粗体**` 只显示粗体，不可见 `**`。  
2. [ ] **聚焦块但 caret 在 plain**：远处粗体仍只显示样式，**不**整段 raw。  
3. [ ] **caret 移入粗体内容**：成对灰 `**` 出现，内容保持粗体。  
4. [ ] **caret 离开该 mark**：灰 `**` 消失，样式保留。  
5. [ ] **斜体 / 删除线 / 行内代码** 同 3–4 条行为（定界符分别为 `*`、`~~`、`` ` ``）。  
6. [ ] **未闭合** `**hi`：始终源码可见，不伪造成粗体。  
7. [ ] **闭合瞬间** `**hi**`：变为粗体；caret 仍在合理位置（内容内或闭后）。

### 9.2 编辑与快捷键（P0）

8. [ ] **Ctrl/Cmd+B** 对选区 toggle 粗体；序列化含 `**`；**不**调用 `document.execCommand('bold')` 作为主路径。  
9. [ ] **Ctrl/Cmd+I / Shift+S|X / E** 分别对 italic/strike/code 生效。  
10. [ ] **成对删除**：在 reveal 态对开/闭灰 delim 执行 Backspace（或文档化的删除手势）→ mark 移除、文本保留。  
11. [ ] **无选区 Ctrl+B**：可继续输入并得到 bold（骨架 + reveal 或等价），caret 不飞。  
12. [ ] **code 内** `*不*变斜体`；code 与 bold 互斥规则可测。

### 9.3 Caret / IME / 稳定（P0）

13. [ ] **reveal 切换**前后，同一逻辑字符上的 caret 语义 offset 不变（允许 1px 级布局差，不允许跳到行首/其它 mark）。  
14. [ ] **中文 IME** 组字全程：无 `innerHTML` 闪断、不丢字、不拆块；composition 中不切换 reveal。  
15. [ ] **compositionend** 后一次 reconcile：可折叠则折叠，可 reveal 则 reveal。

### 9.4 链接与往返（P0–P1）

16. [ ] **链接** `[文](https://example.com)` 失焦可辨；聚焦改锚文 **不丢** href。  
17. [ ] 编辑态单击链接 **不**默认导航；危险协议不可执行。  
18. [ ] **往返**：编辑后 `getMarkdown()` 再 set 回来，bold/italic/strike/code/link 语义保持。

### 9.5 边界与非目标（P1 可记债）

19. [ ] 表格单元格内邻域显源不破坏格选/导航（与 table selection 事件优先级表一致）。  
20. [ ] 列表 / 标题 line-source 下，结构灰标与行内灰 delim **同时**存在且可区分。  
21. [ ] `***` 三星号：P0 可文档化为分步；不得崩溃或乱序套娃。  
22. [ ] 高亮 `==` / 下划线 `++`：扩展开时行为与 bold 同构；严格 GFM 导出策略可测。  
23. [ ] **无默认 sel-bar** 仍能完成 8–12。  
24. [ ] 性能：中等段落（&lt;5k 字）输入 + reveal 切换不掉帧感知（对照 §4.3.5 预算）。  
25. [ ] **反例否决**：聚焦后整段 body 变成 raw `**…**` 墙（方案 B）不得标为 U2 完成。

---

## 10. 模块 owner：`inline/*`

### 10.1 目录职责（U2 落点）

| 模块 | 现状 | U2 应扩展 |
|------|------|-----------|
| `inline/marks-model.js` | parse / serialize / runsToEditHtml / toggleWrapMd | `runsToEditHtml(runs, { revealIds })`；normalize；互斥规则 |
| `inline/live-marks.js` | applyLiveMarks 全量 HTML；caret MD 映射 | reveal 集合；**最小 patch**；delim 感知 length；导出统一 offset API |
| `inline/keymap-marks.js` | 快捷键 toggle | 与 reveal 协同；beforeinput format*；Ctrl+K 预留 |
| （新）`inline/reveal-policy.js` 或并入 live-marks | 无 | `computeRevealSet(caret, range, runs)` 纯函数可单测 |
| （新）`inline/dom-bridge.js`（可迁 TS） | 逻辑散落 util | `domToRuns` / `runsToDom` / 跳过 delim 双计 |
| `util.js` | inlineHtml / htmlToInlineMd | 识别 `.mdx-src-delim`；逐步薄委托 marks-model |
| `css/.../inline-marks.css` | `.mdx-src-delim` 预留 | 对比度、暗色、与 link/u 可辨 |
| `editor.js` | 调用 applyLiveMarks / keymap | **只接线**；禁止新策略代码 |
| `ui/line-source.js` | 结构 mark | 不负责行内 delim |
| `ui/selection-toolbar.js` | execCommand 遗留 | 默认禁用；若启用须走 toggleMark |

### 10.2 禁止

- 在 `editor.js` 内复制一套 reveal 状态机。  
- 用 `document.execCommand` 冒充 mark。  
- 用整块 raw 字符串编辑冒充 D2-A 完成。  
- composition 中为了显源而重挂 DOM。  
- 上帝文件式「再加 500 行 live-marks 杂项」——超责就拆文件。

### 10.3 与 U 波次依赖

```
ux-D2 closed ──► U2 实现
U1a（块内 range）建议先于或并行：半选 mark 的 reveal 依赖可靠选区
U3 剪贴板：复制应输出 MD 定界符，不输出灰 delim 装饰 HTML
```

### 10.4 决策关闭检查表（供 08 回写）

关闭 ux-D2 时必须写死：

1. 选项 **A**（或明确替代）。  
2. delim 节点：`contenteditable=false` + 成对删除 **或** 可编辑源字符（二选一）。  
3. 链接：默认不展开完整 `](url)` **或** 展开（二选一；本文推荐不展开）。  
4. 无选区 Mod+B 的骨架行为。  
5. 与 v3-04 U3「永不显源」条文的 **作废声明**。

---

## 11. 证据索引（路径）

| 主题 | 路径 |
|------|------|
| live fold | `reference/chat-composer-component/js/markdown-editor/inline/live-marks.js` |
| parse/serialize/editHtml | `.../inline/marks-model.js` |
| 快捷键 | `.../inline/keymap-marks.js` |
| 读态 HTML / DOM→MD | `.../util.js`（`inlineHtml` / `htmlToInlineMd`） |
| 灰 delim CSS | `.../css/markdown-editor/inline-marks.css` |
| input/IME/keymap 接线 | `.../js/markdown-editor/editor.js` |
| F-INL 金标准 | `.../docs/markdown-editor/feature-catalog/01-core-blocks-and-line-source.md` § F-INL-* |
| 历史 as-you-type 算法 | `.../docs/markdown-editor/v3-complete/04-inline-marks-live.md` |
| 决策 D2 | `.../docs/markdown-editor/ux-readiness/00-MASTER-READINESS.md` §4.2 · `08-decision-log.md` §2 |

---

## 12. 总结（给调度）

| 项 | 内容 |
|----|------|
| **病根** | 闭合 mark 只存语义 DOM，**无定界符投影层**；策略文档一度写「永不显源」 |
| **药方** | **D2-A 邻域灰标记**（不是聚焦全文 raw） |
| **最大实现风险** | caret 映射在「虚拟 delim」与「真实 delim 节点」切换时双计/漏计；IME 重挂 |
| **owner** | `inline/*` |
| **门禁** | ux-D2 → `closed` 后 U2 开工；验收 §9 ≥ P0 全绿 |
| **本轮** | **仅文档**；无运行时改动 |

---

**文档结束（03）** · 上接 [00-MASTER](./00-MASTER-READINESS.md) · 决策 [08](./08-decision-log.md) · 流程摩擦见 [04](./04-user-workflows-and-friction.md)（落地后）
