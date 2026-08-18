# 06 — 剪贴板 · 撤销 · 查找（UX 就绪分析）

> **日期**：2026-08-03  
> **角色**：只读分析分册（U3 主题）；**不写运行时代码**  
> **物理路径**：`reference/chat-composer-component/docs/markdown-editor/ux-readiness/06-clipboard-undo-find.md`  
> **逻辑路径**：`docs/markdown-editor/ux-readiness/06-clipboard-undo-find.md`  
> **依赖决策**：[08-decision-log](./08-decision-log.md) **ux-D1**（跨块选区）、**ux-D3**（粘贴 HTML 策略）  
> **规格锚点**：`feature-catalog/01` F-CLIP · `03-line-renderer` §11–12 · `model.js` History · `media/drop-paste.js` · `table/clipboard-tsv.js` · `serialize.js` / `parse.js`

---

## 0. 结论先行

| 维度 | 现状（诚实） | 好用目标 | 阻塞 |
|------|--------------|----------|------|
| **跨块复制 → 纯 MD** | ❌ 无选区序列化；浏览器原生选区跨块常坍塌 | 选区 → `text/plain` 为 GFM MD；可选 HTML | **ux-D1** 选区模型 |
| **多块剪切 / 删除** | ❌ 无 `block-multi`；仅单块 Backspace/Delete/降级 | 多选后 Cut=复制+删除；Delete 整段删除 | ux-D1 + 命令总线 |
| **粘贴 MD / plain / HTML** | ⚠ 仅有图片粘贴 + 表 TSV + 代码/公式强制 plain；**无** 通用 paste pipeline | 三态探测 + 消毒 + 整贴一步 undo | **ux-D3** + `edit/clipboard/` |
| **Undo 粒度** | ⚠ 有栈（100 层 cloneDoc）；**无 mergeKey**；打字多为 leave 才入栈 | 打字合并、结构独立、粘贴/slash 一步 | model History 产品化 |
| **查找 / 替换** | ❌ 无 | **默认宿主拥有**；编辑器只提供定位/高亮端口 | U5/U6 后置，非 U3 阻塞 |

**一句话**：剪贴板与撤销是「功率用户缺口」的核心面；表/代码/图片局部通路已有，**文档级** copy/cut/paste 与可预期 undo **尚未产品化**。U3 必须在 D1（至少 U1a 块多选 + 块内 range）落地后开工，否则复制出的只是浏览器碰巧选中的 HTML 碎片。

---

## 1. 代码与规格现状盘点

### 1.1 History（`model.js`）

| 项 | 实现 | 证据 |
|----|------|------|
| 栈结构 | `undoStack` / `redoStack`，整份 `cloneDoc(doc)` 快照 | `model.js`：`snapshot` / `pushHistory` |
| 上限 | `MAX_HIST = 100`，超出 `shift` 丢最旧 | 同上 |
| 入栈开关 | `addToHistory !== false` 默认入栈；`silentHistory` 用于 `setDoc` | `updateBlock` / `insertBlock` / `removeBlock` / `moveBlock` / `setDoc` |
| undo/redo | 弹出快照替换 `doc`，emit `'undo'`/`'redo'` | `model.undo` / `model.redo` |
| **缺失** | 无 `mergeKey`、无时间窗合并、无选区一并恢复、无 inverse step 列表 | 规格 `CROSSCUTTING` / `01-architecture` 写过 Transaction，**运行时未实现** |

**编辑器接线**：

- `Ctrl/Cmd+Z`：`exitEdit(false)` → `model.undo()` / Shift → `redo()` → `fullRender()`（`editor.js` undo 分支）。
- 命令面板：`edit:undo` / `edit:redo`（hint Ctrl+Z / Ctrl+Y）。
- **注意**：键盘路径 **未** 单独绑 `Ctrl+Y`（仅 Shift+Z）；与 palette hint 不完全一致。
- 打字热路径：`scheduleCommit` / line-source 更新多用 `{ addToHistory: false }`；结构变更（promote / demote / Enter 拆块 / merge-prev / move / slash / 图片插入首块）多用 `true`。
- `commitActiveFromDom` 在 exit 时对 math/code 等 `addToHistory: true` → **一次离开编辑 ≈ 一次大快照**，中间键入常被浏览器原生 undo 与 model 栈「双轨」困扰。

### 1.2 复制 / 剪切现状

| 场景 | 有无拦截 | 写出格式 | 评价 |
|------|----------|----------|------|
| 块内文本（contenteditable） | 无 root 级 `copy`/`cut` 监听 | 浏览器默认（常为 HTML + plain，**非 MD**） | 跨块失败；marks 不可控 |
| 代码块「复制」按钮 | 有 | **body 纯文本**（不含 fence） | 符合 F-CODE-COPY；**不是**文档 MD 复制 |
| 表格多格选 | `table-chrome` `onCopy` | **TSV** `text/plain` | 正确局部行为；非块级 MD |
| 表格右键 copy-text / copy-tsv | `handleTableContextAction` | 单格文本或 TSV | 可用 |
| 块级多选 | 无 | — | 锁在 activeId |
| 跨块字符 range | 无 | — | 见 00 / ux-D1 |
| 内部 MIME `application/x-conex-blocks+json` | 规格有、代码无 | — | 往返保真未做 |
| Cut | 无专门路径 | — | 浏览器 cut 只伤当前 surface |

`serialize.js` 已具备 **整文档 / 块序列** → GFM MD（列表紧邻 `\n`，其它块 `\n\n`；表 expand-blank）。**缺的是** `serializeSelection(sel, doc)`：从选区切出 Block[] 或 inline 片段再调用 `serialize` / `serializeBlock`。

### 1.3 粘贴现状

| 入口 | 行为 | 文件 |
|------|------|------|
| 根节点图片 paste/drop | 取 `clipboardData.files` / items → `uploadImage` 或 object URL → `insertBlock` 图片；**多图时仅首块 `addToHistory: true`** | `media/drop-paste.js` + `editor.js` `insertImageBlocks` |
| 代码编辑表面 | `preventDefault` + **仅** `text/plain` 字面插入 | `blocks/code-edit.js` |
| 公式表面 | 同 plain | `blocks/math.js` |
| 表格 | 若像 TSV（含 `\t` 或 `\n`）→ `applyTsv`；一步改表 | `table-chrome` + `clipboard-tsv` |
| **段落 / 标题 / 列表 line-source** | **无** 自定义 paste | 浏览器默认 HTML 注入 CE 风险 |
| HTML 消毒 → 块 | 无 | 规格 `03` §11 / F-CLIP 要求有 |
| MD 识别 `##` / 列表 / fence | 无 paste 路径；仅 `setMarkdown` / 初始 `parse` | `parse.js` 能力闲置 |

**规格已写、实现未接**（`03-line-renderer` §11）：

1. 可选内部 JSON  
2. `detectPasteKind(html, plain)` → markdown | html | plain  
3. `insertFromMarkdown` / `insertFromHtml(sanitize)` / `insertPlainText`  
4. 安全：白名单、禁 script/on*、禁 `javascript:`  

与 **ux-D3 推荐 A** 一致：MD 优先 → HTML 消毒转块 → plain 分块/前缀启发。

### 1.4 查找 / 替换

- 代码与 catalog：**无** in-editor Find UI、无 `Mod+F` 绑定（`ux/keyboard-map.md` 未列 Find）。  
- F-INL-MARK 明确 **禁止**「用浏览器 Find 高亮冒充」行内高亮。  
- 宿主（Notebook / workbench）若需要全文检索，更接近 **文档列表 / 会话检索**，不是块编辑器第一职责。

---

## 2. 跨块复制 → 纯 Markdown

### 2.1 目标语义

用户从块 A 中部拖到块 C 中部（或把手多选 A–C）后 **Copy**：

| MIME | 内容 | 优先级 |
|------|------|--------|
| `text/plain` | **主格式**：选区对应 **GFM Markdown**（与 `serialize` 语义一致） | 对外默认 |
| `text/html`（可选） | 阅读态语义 HTML（strong/em/列表/表），无脏 style | 贴 Word/邮件 |
| 内部 JSON（可选） | 块切片 + runs，保真 merge/表结构 | 本编辑器内粘贴 |

**纯 MD 原则**：贴到 VS Code / GitHub / 聊天框时，用户应得到可再 parse 的源码，而不是 CE 吐出的带 `<div>` 的碎片。

### 2.2 选区 → 序列化算法（产品层，非代码）

依赖 **ux-D1** 的 Selection：

| `kind` | 切片规则 |
|--------|----------|
| `caret` | 默认 **不** 复制整块（与常见编辑器一致）；可选「无选区时复制当前块」产品开关，默认关 |
| 块内 `range` | 文本块：取 offset 区间 plain/runs；保留落在区间内的 marks 定界符或等价 MD；结构块（code/math）若选区未盖满，仍按「选中文本」出 plain，不拆 fence 半截 |
| `block-multi` | 有序 `ids` → 每块完整 `serializeBlock` → 列表紧邻规则与 `serialize` 一致 |
| 跨块 `range` | 首块：从 anchor offset 到块末；中间块：整块；尾块：从块首到 focus offset；再按块类型拼接 |
| 表内格选 | **不走** 文档 MD 路径；保持 TSV（已实现） |

**部分块边界**：

- 列表项只选中后半句：导出为 **无 marker 的续行文本** 或降为段落片段（推荐：**片段 plain/MD 行内**，不伪造 `- ` 前缀）。  
- 仅选中代码块中间几行：导出 **无 fence 的代码文本**（与「复制按钮 = body」一致）；整块选中才带 ` ```lang `。  
- 图片/分割线/TOC：仅在块被完整包含时导出对应 MD 记号。

### 2.3 与浏览器协作

- root 捕获 `copy`：`preventDefault` 后 `clipboardData.setData`。  
- 若权限 API `navigator.clipboard.write` 可用，可写多 MIME；fallback 仅 plain。  
- **禁止** 依赖「用户碰巧拖蓝了多个 contenteditable」——D1 未落地前跨块 copy **不得** 标验收通过。

### 2.4 缺口与依赖

| 缺口 | 依赖 |
|------|------|
| 无 `sliceDoc(doc, selection)` | ux-D1 + 纯函数模块 `edit/clipboard/to-md` |
| 无 root copy 监听 | U3 接线，**禁止**堆进 `editor.js` 上帝路径 |
| marks 与源码可见策略 | ux-D2：复制出的 MD 以 **model runs/text** 为准，不以瞬时 DOM 定界符显隐为准 |

---

## 3. 剪切 / 删除多块

### 3.1 目标

| 操作 | 语义 | History |
|------|------|---------|
| **Delete / Backspace**（`block-multi` 或非坍缩 `range`） | 删除选中内容；跨块 range 删后合并首尾文本块（若两端皆可合并类型）；空文档保留一个空 paragraph | **一步** undo 恢复选区前文档 |
| **Cut** | Copy（§2）+ Delete；剪贴板已有 MD 后再删 | **一步**（不要 copy 与 delete 分两栈） |
| 单块内 range | 删字符 / 代以粘贴替换 | 遵循 §4 打字合并策略 |
| 表格格选 | 清空选中格（已有/可对齐 context menu），非删整表块 | 一步 |

### 3.2 现状摩擦

- 仅 **单块** `activeId`：Backspace 在空块走 demote / merge-prev；无法「一次删三段」。  
- 无 Cut 快捷键产品路径；用户只能依赖浏览器对当前 CE 的 cut。  
- `removeBlock` 在只剩一块时清空为 paragraph（合理）；多选删除需 **批量** `replaceBlocks` 或事务，避免中间态多次 emit。

### 3.3 推荐命令形状（规格层）

```
commands:
  clipboard.copy
  clipboard.cut
  clipboard.paste
  selection.delete   # Backspace/Delete 在非 caret 时
```

- 全部读 `runtime.selection`，写 `model` + 单一 history 步。  
- viewOnly：允许 copy，禁止 cut/delete/paste 突变（与现 viewOnly 键策略一致方向）。

### 3.4 与 DnD / slash 的边界

- 拖块重排：已有 `moveBlock` + 一步 history；**不是** clipboard。  
- Slash 插入：一步 history（规格 05）；勿与 paste 管道混用同一 debounce key。

---

## 4. 粘贴策略：MD / plain / HTML

### 4.1 优先级（对齐 ux-D3 选项 A，推荐默认）

由高到低：

1. **内部保真**（若有）：`application/x-conex-blocks+json` 或约定前缀 → 直接 Block[] 插入。  
2. **`text/markdown` / `text/x-markdown`**（部分宿主会写）。  
3. **图片文件**（现有 `MdxMediaDropPaste`）：有 image file 时优先插图（已实现）；与文本并存时：**有图则走图**（当前行为），纯文本不进此分支。  
4. **`text/html`**：仅当「富语义」且 plain **不像** MD 主导时 → 消毒 → 块；否则让位 plain/MD。  
5. **`text/plain`**：  
   - `looksLikeMarkdown`（`#` / fence / 列表 / 表格行 / 常见 marks）→ `parse(md)` 得 Block[]；  
   - 否则按换行/空行启发式：单行插入 caret；多段拆块。

### 4.2 分表面策略

| 表面 | 策略 |
|------|------|
| **段落 / 标题 / 列表 / quote / callout** line-source | 完整 pipeline；有选区先删选区再插 |
| **代码 / 公式 focus-source** | **强制 plain 字面**（已实现，保留）；不解析 MD、不插 HTML |
| **表格单元格** | 像 TSV → 网格粘贴（已实现）；单行无 tab → 当前格纯文本 |
| **viewOnly** | 忽略粘贴 |
| **IME composition 中** | 不抢 paste（极端）；若发生则 compositionend 后再规范化 |

### 4.3 HTML 消毒底线（关闭 D3 时冻结）

- 禁止：`script` / `iframe` / `object` / `form` / 内联 `on*` / `javascript:` / `data:text/html`。  
- 允许映射：`p` `h1–h6` `ul/ol/li` `pre/code` `blockquote` `table/tr/td/th` `a[href]` `img[src]` `strong/b` `em/i` `s/del` `br` `hr`。  
- `style` / `class` **丢弃**（不进模型）。  
- 链接在只读渲染层 `rel="noopener noreferrer"`。  
- 超大粘贴（建议阈值如 100KB plain）：可截断 + 提示，**不得**卡死主线程（F-CLIP P1，U3 可先硬截断）。

### 4.4 插入位置与块分裂

| 剪贴板形态 | 插入语义 |
|------------|----------|
| 无换行 plain | caret 处插入文本 |
| 多段 MD / 多块 | 当前文本块在 caret **分裂**（before | after），中间插入 parse 出的块；一步 history |
| 粘贴时 `block-multi` | 先删多选块，再在原最小 index 处插入 |
| 空段落 + 粘贴结构块 | 可替换空段落，避免残留空 p |

复用 **`parse.js` + `serialize` 往返** 作为 MD 路径的真源；HTML 路径产出 Block[] 后同样经 schema `createBlock` 归一化。

### 4.5 模块归属（防上帝文件）

| 模块 | 职责 |
|------|------|
| `edit/clipboard/detect.js` | MIME / looksLikeMarkdown / looksLikeTsv |
| `edit/clipboard/from-plain.js` | plain → 文本插入或 parse |
| `edit/clipboard/from-html.js` | sanitize + html→blocks |
| `edit/clipboard/to-md.js` | selection → clipboard payload |
| `edit/clipboard/paste-pipeline.js` | 编排 + 单 history 步 |
| 既有 `media/drop-paste.js` | 仅文件/图片；文本交给 pipeline |
| 既有 `table/clipboard-tsv.js` | 表局部；pipeline 在「焦点在表内」时委托 |

**反模式**：在 `editor.js` 再写 500 行 paste；只 `preventDefault` 后 `insertText` 丢结构。

---

## 5. Undo 栈粒度

### 5.1 现状问题（用户可感知）

| 现象 | 原因 |
|------|------|
| 打了很长一段，undo 一次没了 / 或几乎不掉字 | 键入 `addToHistory: false`，真正入栈多在 **exitEdit / 结构操作**；与浏览器 contenteditable 原生 undo **双轨** |
| 粘贴（若未来）与输入搅在一起 | 无 mergeKey，无法声明「此事务独立」 |
| undo 后 caret/选区丢失 | 快照只有 `doc`，无 selection |
| 连续单元格编辑可能一步或碎步 | 表 input 常用 `addToHistory: false`，exit/mutation 才 true |
| 多图粘贴 | 仅 `i===0` 入栈，整组可一次 undo（**好模式**，应推广到多块粘贴） |

### 5.2 目标粒度策略

| 操作类 | 期望 undo 步 | merge 规则 |
|--------|--------------|------------|
| 连续打字 / 删除字符（同块、无结构变化） | 合并为 1 步（时间窗，如 400–800ms，或直到 caret 跳出块） | `mergeKey: 'type:'+blockId` |
| IME 组字 | composition 期间 **不** 入栈；end 后与 type 合并 | 与 ime-guard 一致 |
| Enter 拆块 / Backspace 合并 / promote / demote | **独立** 1 步 | 禁止与 type 合并 |
| Slash / 命令面板插入 | 1 步（打开前状态 → 结果） | 独立 |
| 粘贴（任意多块） | **整贴 1 步** | 独立 |
| 拖拽 / Alt+↑↓ 移块 | 1 步 | 独立 |
| 表：TSV 粘贴、增删行列、合并单元格 | 各 1 步 | 独立 |
| 表：同格连续输入 | 合并 | `mergeKey: 'cell:'+id+':'+r+':'+c` |
| setMarkdown / 外部 setDoc | `silentHistory` 清栈或重置基线（现有 setMarkdown 注释「clear history baseline」方向正确，需产品确认是否 `undoStack.length=0`） | — |

### 5.3 History API 演进（规格，非本轮实现）

相对当前「整文档 clone」：

1. **短期（U3 可接受）**：保留 cloneDoc 快照；补上 **mergeKey + 时间窗**：同 key 且在窗内则 **替换** 栈顶快照而非 push（注意：push 前快照是「变更前」，合并时应在首次 push 后后续 update 用 `addToHistory: false` 或「pop 再 push 前态」——产品验收以「连续输入一次 Ctrl+Z 回到输入前」为准）。  
2. **中期**：快照附带 `selection`；undo/redo 后恢复 caret。  
3. **长期**（可选）：inverse steps，减内存；非 U3 门禁。

`MAX_HIST = 100` 对整文档 clone 在大笔记下偏贵；U3 不强制改，但大粘贴后应避免无意义的中间快照。

### 5.4 与「浏览器原生 undo」的关系

- 自定义 copy/paste/结构操作已 `preventDefault` 时，应 **以 model 栈为准**。  
- 纯 CE 打字未 prevent 时，浏览器也有栈 → **推荐** 在 line-source 输入路径统一走 model（或 beforeinput 拦截），避免用户连按 Ctrl+Z 先撤 DOM 再撤 model 的错乱。  
- 这是 U3 质量项，验收须含「仅 model 栈可感知」的手工剧本。

---

## 6. 查找 / 替换：编辑器还是宿主？

### 6.1 建议结论（产品默认）

| 能力 | 归属 | 理由 |
|------|------|------|
| **会话 / 文件 / 多笔记搜索** | **宿主** | 超出单文档 Block 编辑器；与 workbench 检索一致 |
| **当前文档内查找（Ctrl+F）** | **P2，默认可宿主-owned** | 浏览器原生 Find 对「阅读态多块 DOM」部分可用，但与折叠 marks、虚拟化冲突 |
| **文档内替换** | **更后置**；若做必须走 model（非 DOM 改字） | 否则破坏 runs/块边界 |
| **编辑器最小端口（可选）** | `scrollToBlock` / `highlightRanges(transient)` / `getPlainTextIndex()` | 宿主 UI 调端口；**高亮层**与 marks 分层（勿复用 mark 样式） |

### 6.2 为何 U3 不把 Find 当阻塞

- 00-MASTER 已标 Find 为 P2 / U5–U6 可谈。  
- 功率用户「复制粘贴 + 撤销」日用频率远高于「文内替换」。  
- 在 **无跨块选区** 时做替换，错误地改 DOM 会制造比没有 Find 更严重的数据损坏。

### 6.3 若未来做 in-editor Find 的底线

1. 在 **serialize 后的逻辑 MD / plain 索引** 上找，映射回 `(blockId, offset)`。  
2. 替换 = transaction 改 model，一步可 undo。  
3. 不调用 `window.find` 冒充产品功能。  
4. 快捷键与宿主冲突时：**宿主优先**注册，编辑器 focus 时再抢（集成合同另定）。

---

## 7. 与相邻主题的边界

| 主题 | 边界 |
|------|------|
| **02 多块选区** | 本册 **消费** Selection；不发明第二套选区 |
| **03 行内源码** | 复制以 model 为准；粘贴 MD 后的 marks 显隐跟 D2 |
| **04 用户流程** | 「从网页粘贴一篇」「误删三段 undo」列入日常剧本 |
| **07 表/代码残留** | 表 TSV、代码 plain paste **保持**；本册统一「焦点在特殊表面时委托」 |
| **F-CODE-COPY** | 按钮复制 body ≠ 文档 copy；勿合并成一个 API 误用 |

---

## 8. 验收标准（Acceptance criteria）

> 全部为 **用户可感知 / 可自动化 harness** 条目。U3 出口以本节为准；勾选前须 ux-D1（至少 U1a）与 ux-D3 为 `closed` 或实现声明的分期地板。

### 8.1 复制 → 纯 MD

- [ ] **A1** 块内选中含 `**粗**` 的文本，Copy → `text/plain` 含 MD 定界符或等价可 parse 形式；贴到外部 textarea 可见源码而非仅「粗」的富文本丢失。  
- [ ] **A2** `block-multi` 选中标题 + 段落 + 列表，Copy → plain 为可 `parse` 的 MD；`parse(serialize(slice))` 语义块类型一致（id 可变）。  
- [ ] **A3** 跨块 range（U1b）从段中到下段中，Copy → 首尾为片段、中间整块，无幽灵空块。  
- [ ] **A4** 整块选中代码块 Copy → 含 fence + lang；块内部分行 → 无 fence 的代码文本。  
- [ ] **A5** 表格多格 Copy 仍为 TSV（回归，不因文档 copy 回归破坏）。  
- [ ] **A6** 代码「复制」按钮仍只复制 body（回归 F-CODE-COPY）。

### 8.2 剪切 / 多块删除

- [ ] **B1** `block-multi` 三块，Delete → 三块消失，仅一步 Ctrl+Z 全部恢复。  
- [ ] **B2** Cut 同上，剪贴板为 MD，原文删除，一步 undo 恢复文档（剪贴板可不变）。  
- [ ] **B3** 跨块 range Delete 后首尾文本正确拼接或分块策略与文档一致，无残留空 marker。  
- [ ] **B4** 删至空文档 → 仍有一个空 paragraph，可继续输入。  
- [ ] **B5** viewOnly 下 Cut/Delete 无效，Copy 仍可用（若产品允许只读复制）。

### 8.3 粘贴

- [ ] **C1** 粘贴 `## Hello` → 标题块，非带 `##` 的段落（或按 D3 冻结的等价策略）。  
- [ ] **C2** 粘贴 `- a\n- b` → 两个 bullet（或紧列表），undo 一次全撤。  
- [ ] **C3** 粘贴 fenced code → code 块 + lang。  
- [ ] **C4** 从网页复制列表的 HTML → 无 `style`/`script`，结构为列表块；危险标签被剥。  
- [ ] **C5** plain 与「像 MD 的 plain」优先于脏 HTML（D3 启发式）。  
- [ ] **C6** 代码块内粘贴 HTML 源 → 字面 plain，不出现高亮 span 残留。  
- [ ] **C7** 表内粘贴 TSV → 网格填充（回归）；一步 undo。  
- [ ] **C8** 粘贴图片（有/无 upload 端口）→ 图片块；失败有 onError，不抛未捕获。  
- [ ] **C9** 无双份插入（浏览器默认 + 自处理各贴一次）。  
- [ ] **C10** 100KB 级 plain 不永久卡死（截断或分片策略可接受，须有说明）。

### 8.4 Undo 粒度

- [ ] **D1** 同段连续输入 ≥20 字，停顿超过合并窗后，**一次** undo 回到该段输入前（或合并窗策略文档化且可预期）。  
- [ ] **D2** Enter 拆块后一次 undo 恢复单块。  
- [ ] **D3** 粘贴多块一次 undo 全无。  
- [ ] **D4** slash 转标题一次 undo 回段落。  
- [ ] **D5** 连续 undo/redo 对称，不丢块、不出现空 doc。  
- [ ] **D6** IME 组字中途 undo 不拆半个拼音（组字结束前不入栈）。  
- [ ] **D7** 移块 / 拖拽一步可撤销。

### 8.5 查找（非 U3 门禁，记录预期）

- [ ] **E1** U3 **不** 要求 in-editor Find UI。  
- [ ] **E2** 若宿主提供查找：编辑器 focus 时不错误 `preventDefault` 掉宿主 Ctrl+F（集成合同）。  
- [ ] **E3** 未来 in-editor 替换必须 model 事务 + 可 undo（设计约束，非本波实现）。

### 8.6 工程门禁

- [ ] **F1** 新逻辑在 `edit/clipboard/*`（及 model mergeKey），**禁止** 显著膨胀 `editor.js`。  
- [ ] **F2** 纯函数切片/探测可单测；HTML XSS 负例夹具。  
- [ ] **F3** 无 mock AI；粘贴管道不引入假网络。  
- [ ] **F4** 与 00 成功判据 **#6**（粘贴）、**#1/#2**（跨选复制）交叉勾选。

---

## 9. U3 实施切片建议（仅计划，不动代码）

| 序 | 切片 | 前置 | 交付物 |
|----|------|------|--------|
| U3.0 | 关闭 ux-D3；确认 D1 地板（U1a 至少） | 决策 log | 书面策略 |
| U3.1 | `to-md` + root `copy`（block-multi + 块内 range） | U1a | A1/A2/A6 |
| U3.2 | `selection.delete` + `cut` | U3.1 | B1/B2 |
| U3.3 | `paste-pipeline` plain+MD（复用 parse） | U3.0 | C1–C3/C9 |
| U3.4 | HTML sanitize → blocks | U3.3 | C4/C5 |
| U3.5 | History mergeKey + 粘贴/结构独立 | 可与 U3.3 并行 | D1–D7 |
| U3.6 | 跨块 range 复制（U1b） | U1b | A3 |
| — | Find | 不纳入 U3 | E1 |

---

## 10. 风险与诚实边界

| 风险 | 说明 |
|------|------|
| D1 未关就做 copy | 只能「当前 CE 内」假好用，跨块必翻车 |
| 双轨 undo | 不统一输入路径则 D1–D7 不稳定 |
| HTML 转换永远有损 | 验收写「语义近似」而非像素级 Word |
| 整文档 clone × 100 | 大文档内存；U3 可接受，需知悉 |
| 本分析基于 2026-08-03 树 | `editor.js` / `model.js` 若后续大改，以代码为准回写本节 |

---

## 11. 参考索引

| 资源 | 用途 |
|------|------|
| `js/markdown-editor/model.js` | History 真源 |
| `js/markdown-editor/serialize.js` / `parse.js` | MD 往返 |
| `js/markdown-editor/media/drop-paste.js` | 图片粘贴 |
| `js/markdown-editor/table/clipboard-tsv.js` | 表 TSV |
| `js/markdown-editor/blocks/code-edit.js` | 代码 plain paste |
| `docs/.../feature-catalog/01` **F-CLIP** | 金标准条目 |
| `docs/.../03-line-renderer.md` §11–12 | 早期 paste/copy 设计 |
| `ux-readiness/00-MASTER-READINESS.md` | H4/H8、U3 |
| `ux-readiness/08-decision-log.md` | ux-D1 / ux-D3 |

---

## 12. 修订

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-08-03 | 初版：现状盘点 + 策略 + 验收；无代码 |
