# 02 — 跨行多选 + 多行源码：架构分析

> **分册**：`docs/markdown-editor/ux-readiness/02-multi-block-selection-analysis.md`  
> **日期**：2026-08-03  
> **角色**：只读分析（**无代码实现**）  
> **读者**：调度者、实现 agent（U1 多选波次）、评审  
> **运行时真相**：`reference/chat-composer-component/js/markdown-editor/*`  
> **迁移目标**：`packages/conex-mdx`（`src/edit/selection/*` 等，禁止堆 `editor.js`）  
> **关联**：  
> - [ux-readiness/README.md](./README.md)  
> - [feature-catalog/01-core-blocks-and-line-source.md](../feature-catalog/01-core-blocks-and-line-source.md)  
> - [v3-complete/02-render-model.md](../v3-complete/02-render-model.md)  
> - [01-architecture.md](../01-architecture.md) · [v3-complete/11-no-god-file-charter.md](../v3-complete/11-no-god-file-charter.md)  
> - 实现：`editor.js` · `ui/line-source.js` · `model.js` · `serialize.js` · `table/selection.js`

---

## 0. 摘要（结论先行）

### 0.1 一句话

当前编辑器的跨行选区**从根本上不可用**：不是缺几个快捷键，而是 **「全局至多一块 `activeId` + 每块独立 contenteditable 岛 + 读态非可编辑 DOM」** 与 **「用户期望的文档流连续选区」** 结构冲突。

### 0.2 用户期望（本分析冻结）

| # | 期望 | 说明 |
|---|------|------|
| E1 | **跨行/跨块选区可用** | 鼠标拖选、Shift+方向键、Shift+Click 均可选中多个内容块 |
| E2 | **多选时全部显示 line-source** | 被选中的**每一**文本内容行同时展示结构前缀源码（`##` / `*` / `1.` / `>` 等）+ 正文源表面（按类型） |
| E3 | **复制/剪切得到真 MD** | 剪贴板是 GFM 友好 MD（含前缀），不是残缺的 `innerText` 或单块片段 |
| E4 | **删除/格式化/缩进可批量** | Backspace/Delete、Tab、粗斜等对选中区间有明确语义 |
| E5 | **不破坏单块编辑** | 单块点入、IME、demote/promote、height-lock 既有路径仍可用 |
| E6 | **不引入上帝文件** | 新逻辑进 `edit/selection/*`，`editor.js` 只接线 |

### 0.3 推荐结论（先给答案）

| 项 | 决定 |
|----|------|
| **推荐方案** | **C 混合（偏 B）**：日常单块仍 `single-edit`；一旦选区跨块 → 进入 `multi-source-selected`，**选中区间内所有「内容行」批量 paint line-source**，用 **应用层 `SelectionModel`（selectedIds + anchor/primary + 端点 offset）** 合成选区；浏览器 `Selection` 仅辅助块内 caret，不作为跨块真相 |
| **不推荐先上 A** | 连续整页 contenteditable 文档流（A）能天然跨行，但会推翻块调度、DnD、table chrome、height-lock、现有 registry，迁移成本与回归面过大 |
| **纯 B 可做** | 「多块同时 line-source + 合成 Selection」是正确的产品形态；实现上应拆状态机与 paint，而不是在 `enterEdit` 里 if 堆叠 |
| **与现有 `activeId`** | 演进为 `SelectionModel`：`primaryId` 兼容旧 `activeId` 语义；`selectedIds[]` 承载多选；过渡期双写再删 |

### 0.4 现状判词

| 维度 | 状态 |
|------|------|
| 单块 line-source | **方向正确、部分可用**（`MdxLineSource.renderEditSurface`） |
| 跨块选区 | **架构未设计** |
| 多选时多行源码 | **完全不存在** |
| 剪贴板跨块 | **无契约**（仅有表内 TSV / `getSelectionTextInEditor` 依赖浏览器选区） |
| 文档规格 | feature-catalog **INV-1 明文写死「至多一块 line-source」**——与 E2 冲突，**须修订** |

---

## 1. 问题根因（架构）

### 1.1 根因总表

| ID | 根因 | 证据位置 | 用户可见症状 |
|----|------|----------|--------------|
| R1 | **单 active 原语** | `editor.js`：`var activeId = null`；`enterEdit` 首行 `if (activeId && activeId !== id) exitEdit(true)` | 点 B 立刻销毁 A 的编辑表面；无法两行同时源码 |
| R2 | **点击路径无多选** | `onRootClick`：`if (id && id !== activeId) enterEdit(id)`；无 `shiftKey` / `metaKey` 分支 | Shift+Click 仍像普通切块 |
| R3 | **contenteditable 岛** | 仅 active 块挂 `[data-mdx-edit] contenteditable=true`；idle 块是只读精致 DOM | 浏览器无法把 `Selection` 跨岛延伸；拖选在块边界「断」 |
| R4 | **读态 DOM ≠ 源码文本** | idle：`readContentHtml` → h1/ul 渲染；源码标记不在 DOM | 即便硬拖选，`sel.toString()` 丢 `#`/`*` 前缀 |
| R5 | **reconcile 保护单 active** | `reconcile`：`else if (activeId !== blocks[i].id)` 才重绘非 active | 没有「选中集合免重建」；多 surface 会被 refresh 冲掉 |
| R6 | **model 无 Selection** | `model.js` 只有 Doc/History；无 `selectedIds` / anchor | 多选态无法成为事务与 undo 的一等公民 |
| R7 | **规格 INV-1 与产品 E2 冲突** | feature-catalog §2.2：任意时刻至多一块 line-source | 实现即使想做多源也会被文档否决 |
| R8 | **剪贴板依赖浏览器** | `getSelectionTextInEditor` → `window.getSelection().toString()` | 跨块复制空/残；AI rewrite 上下文也不完整 |
| R9 | **键盘路径单块** | `onEditKeydown` 全挂在当前 edit surface；无文档级 selection keydown | Shift+↓ 在块末尾无法扩展到下一块 |
| R10 | **`editor.js` 上帝文件** | 约 3k+ 行：render/enterEdit/table/slash/dnd/click 混装 | 再堆多选会不可维护；与 no-god-file 宪章冲突 |

### 1.2 控制流：单 active 闭环（现状）

```
用户 pointer/click 命中 .mdx-block
        │
        ▼
  onRootClick
        │  id !== activeId ?
        ▼
  enterEdit(id)
        │
        ├─ exitEdit(true)  ← 旧 active：commit → paint read → activeId=null
        ├─ activeId = id
        ├─ content.innerHTML = renderEditSurface / code fence / table …
        └─ focus + placeCaretEnd
```

**关键破坏点**：`enterEdit` 的「互斥 leave」在**产品正确**（单点编辑）时是对的，但在**拖选/Shift 扩展**时必须被旁路——否则选区每碰到下一块就被「切到单块编辑」。

### 1.3 为何浏览器原生选区救不了

| 条件 | 连续 contenteditable 文档 | 当前块岛模型 |
|------|---------------------------|--------------|
| 节点是否 contenteditable | 祖先常为 true | 仅 active 岛 true |
| 跨块 Range | 通常合法 | **非法/断裂**：中间 idle 节点不可编 |
| `Selection.toString()` | 接近文档文本 | 只含当前岛；或读态渲染文本无 MD 前缀 |
| 选区高亮 | 浏览器 `::selection` | 跨块需 **自绘** `.is-selected` / 合成 range |

因此：**跨块选区必须是应用层概念**；浏览器 Selection 最多在「单块 line-source 内」或「合成端点」上辅助。

### 1.4 与 line-source 模型的耦合

`ui/line-source.js` 提供的是 **块级** API：

| API | 作用 | 多选含义 |
|-----|------|----------|
| `toSourceLine(block)` | block → 源码字符串 | 复制/序列化可直接复用 |
| `renderEditSurface(block)` | 结构 mark + body CE | **多选时对每个 selected 文本块调用** |
| `renderCodeSourceSurface` | fence 源 | 代码块参与多选时的 paint |
| `readFromEditSurface` | surface → patch | leave / commit 每块独立 |
| `parseSourceLine` | 行前缀解析 | promote 仍单块 |

**不是根因**：line-source 模块本身。  
**是根因**：调度层只允许一个 surface 存活（R1 + R7）。

### 1.5 与 model 的边界

`model.js` 提供：

- `updateBlock` / `insertBlock` / `removeBlock` / `moveBlock` / `replaceBlocks`
- undo/redo 整 Doc 快照

**缺失**：

- 无 `Selection` / `selectedIds`
- 无 `removeBlocks(ids)` / `updateBlocks(ids, patch)` 批量 API（可在 controller 层用事务模拟）
- History 不知道「选区」——多选删除后 undo 可恢复 Doc，但 UI 选区通常不恢复（可接受 v1）

**结论**：Doc 层可暂时不动；**Selection 先挂在 EditorController 状态**，批量 mutation 用现有 API 组合 + 单次 history 边界（`replaceBlocks` 或 pushHistory 一次）。

### 1.6 与 feature-catalog / v3 渲染模型的冲突

| 文档断言 | 与 E2 |
|----------|-------|
| INV-1：≤1 块 focus-source/line-source | **冲突** — 多选要求 N 块同时 line-source |
| U3 / v3：文本 focus-render 像阅读 | **部分冲突** — 多选时用户明确要求源码前缀可见（更接近 Typora 选中多行） |
| 禁止 is-active 厚描边 | **兼容** — 多选用轻量 `.is-selected` 背景，不是厚边框 |
| height-lock 进出 focus | **需扩展** — 批量 enter multi-source 要批量 lock 或接受轻微跳动策略 |

**规格修订（实施前必须）**：

1. 将 INV-1 改为：  
   - `mode === single-edit` ⇒ ≤1 可编辑 caret 块；  
   - `mode === multi-source-selected` ⇒ **选中集合全部** line-source（可编辑性见 §8：v1 可只读源码展示 + 合成选区，caret 仅 primary）。  
2. 明确 **multi-source 不是「多块同时 IME 输入」**，而是 **多块同时源码呈现 + 选区操作**。

### 1.7 架构图：现状 vs 目标

**现状**

```
┌──────────────────────────────────────────┐
│ editor.js（上帝）                         │
│  activeId ──唯一──► enterEdit/exitEdit   │
│  click ──► enterEdit                      │
│  getSelection ──► window.getSelection()   │
│  model ── Doc only                        │
└──────────────────────────────────────────┘
```

**目标**

```
┌─ Controller（薄接线）─────────────────────┐
│  events → SelectionController / EditFSM   │
└───────┬───────────────────┬───────────────┘
        ▼                   ▼
 SelectionModel        SurfacePainter
 selectedIds[]         paintLineSource(ids)
 primaryId / anchor    paintRead(ids)
 range endpoints       heightLock batch
        │                   │
        ▼                   ▼
   Clipboard / Keys    line-source.js API
   serialize range     blocks/* surfaces
        │
        ▼
   DocumentModel（批量事务包装）
```

---

## 2. 用户场景剧本

> 格式：前置 → 操作 → **期望** → **现状** → 缺口编号

### 2.1 剧本 S1：复制跨段（核心）

| 步 | 内容 |
|----|------|
| 前置 | 文档含：`# 标题`、段落 `hello`、`* item`、代码块、再一段 |
| 操作 | 从标题正文中间拖到第三段中间；Ctrl+C；粘贴到外部编辑器 |
| **期望** | 剪贴板为连续 MD：含 `##`/`#` 前缀、`* ` 列表前缀、代码 fence；端点 offset 正确截断 |
| **现状** | 拖选在块边界中断；或只选中当前 active 内文本；`toString()` 无结构前缀 |
| 缺口 | R1–R4, R8 |

**验收锚点**：粘贴结果与 `serialize` 对该区间的投影一致（允许尾部换行规范化）。

### 2.2 剧本 S2：Shift + 方向键扩展

| 步 | 内容 |
|----|------|
| 前置 | caret 在段落 A 行末 |
| 操作 | 按住 Shift 连按 ↓ 两次 |
| **期望** | 选区从 A 扩展到 B、C；B/C 进入 line-source；主高亮覆盖区间 |
| **现状** | ↓ 可能只在单块 CE 内移动；块末无「跨块 extend」；无 multi paint |
| 缺口 | R3, R9 |

**细节规则建议**：

- Shift+↓ 在 **块内** 先走浏览器/自研 offset；到 body 末尾再 `extendToNextBlock()`。  
- 扩展时 **不** 触发 `exitEdit` 清表面；而是 `addToSelection(nextId)` + paint。  
- 释放 Shift 后单独点一下某处 → 折叠为 single-edit（见状态机）。

### 2.3 剧本 S3：鼠标拖选（dragging）

| 步 | 内容 |
|----|------|
| 前置 | 无选区；文档多块 |
| 操作 | pointerdown 在块 A 正文 → move 经过 B → pointerup 在 C |
| **期望** | mode=`dragging` 期间实时更新 `selectedIds` 与视觉；up 后 `multi-source-selected`；区间内全部 line-source |
| **现状** | pointerdown 可能 click→enterEdit；move 无选区逻辑；与 DnD 把手冲突需区分 |
| 缺口 | R2, R3；需与 `onHandlePointerDown` 隔离 |

**冲突矩阵**：

| 起点 | 行为 |
|------|------|
| `.mdx-handle` | **仅** DnD，清选区或不进 multi |
| `.mdx-block__content` 读态 | 开始 **文本/块拖选** |
| 已在 single-edit 的 body | 块内原生选区；移出块边界 → 升级 multi |
| 表格单元格 | 优先表内 `table/selection`；移出表 → 整表作单元（§7） |
| 代码 copy 按钮 | 不进选区（现状已拦截） |

### 2.4 剧本 S4：删除多段

| 步 | 内容 |
|----|------|
| 前置 | 已 multi-select 块 A..D（含部分端点 offset） |
| 操作 | Backspace 或 Delete |
| **期望** | 删除选中区间；一次 undo 恢复；caret 落到合并后合理位置；不留下空壳半标记 |
| **现状** | Backspace 只在 active 块 demote/merge-prev |
| 缺口 | 无 bulk delete 事务 |

**语义建议（v1）**：

1. 若选区覆盖 **整块**（从块首到块尾或整块 id 级）：`removeBlock` 链，两端 partial 截断。  
2. 若两端 partial：上块保留 `before`，下块保留 `after`，中间整块删除，可选合并两端为一段。  
3. **History**：一次 `pushHistory`（可用 `replaceBlocks` 快照）。  
4. 删除后 mode → `single-edit` 或 `idle` + caret 在上一残留块。

### 2.5 剧本 S5：格式化多段

| 步 | 内容 |
|----|------|
| 前置 | 多选 3 个段落 |
| 操作 | Ctrl+B；或 slash「转为引用」；或 Tab 缩进 |
| **期望** |  
| | - Ctrl+B：对每个块 **body** 包 `**`（或 runs mark），**不**包结构前缀  
| | - 转引用：每块 type→quote 或外包 `>`  
| | - Tab：list 类 indent+1；段落可转 list 或 noop（产品定） |
| **现状** | 快捷键只作用 active 块；无多选命令分发 |
| 缺口 | 命令总线缺 `target: selection` |

### 2.6 剧本 S6：Shift+Click 块锚点

| 步 | 内容 |
|----|------|
| 前置 | primary 在块 2 |
| 操作 | Shift+Click 块 7 |
| **期望** | selectedIds = 索引 [2..7]；全部 line-source；primary 可保留在 7 |
| **现状** | 等同普通 click → enterEdit(7)，块 2 回 read |
| 缺口 | R2 |

### 2.7 剧本 S7：全选

| 步 | 内容 |
|----|------|
| 操作 | Ctrl+A |
| **期望** | 第一次：当前块全选；第二次（可选）：全文；或直接全文（Notion 式双击 A 分级可后置） |
| **现状** | 浏览器只全选当前 CE 岛 |
| 缺口 | R3 |

**v1 建议**：Ctrl+A → 全文 `selectedIds = all` + multi-source；简单可测。

### 2.8 剧本 S8：多选中 Esc

| 操作 | Esc |
| **期望** | 清选区；全部回 read；mode=idle；不丢未提交编辑 |
| **现状** | Esc 仅 `exitEdit` 当前块 |

### 2.9 剧本 S9：多选中点击单块

| 操作 | 无修饰键 click 块 K |
| **期望** | 清 multi；enter single-edit(K) |
| **现状** | 已是类似行为，但无 multi 可清 |

### 2.10 剧本 S10：IME 与多选

| 操作 | 多选过程中触发中文输入 |
| **期望** | **禁止** 在 multi-source 下直接 composition 改多块；IME 仅 primary 单块；拖选中 composition 应 forceEnd 或忽略 extend |
| **现状** | IME 绑定单 active（方向正确） |
| 策略 | multi 态默认 **不** 接收字符输入（除快捷键）；字符键 → 可选「删除选区后插入」类 Word 行为（v2） |

### 2.11 剧本 S11：与 DnD 并存

| 操作 | 多选后拖把手 |
| **期望** | v1：把手仍拖 **单块**；或多选拖整集合（v2） |
| **现状** | 单块 DnD；`exitEdit` 后拖 |
| 建议 | v1 文档写明：多选不启用多块拖；把手 pointerdown **清除 multi 或仅拖 primary** |

### 2.12 剧本 S12：viewOnly 下选区

| 操作 | 只读宿主拖选复制 |
| **期望** | 允许只读选区 + 复制 MD；**不** line-source 编辑；可选轻量 `.is-selected` |
| **现状** | viewOnly 拦截修改键；复制允许；但跨块同样断 |
| 建议 | viewOnly 用 **只读合成选区**（不必进 multi-source 编辑表面），复制走 serialize |

---

## 3. 三种方案对比

### 3.1 方案 A — 连续 contenteditable 文档流

**形态**：整页（或大节）一个 contenteditable；块边界用语义节点/`data-block-id` 划分；浏览器原生跨行选区。

| 维度 | 评价 |
|------|------|
| 跨行选区 | ★★★★★ 原生 |
| 多行源码呈现 | ★★☆☆☆ 需在选中时改节点显示源码，易与 CE 打架 |
| 与现架构 | ★☆☆☆☆ 推翻块岛、reconcile、table 子编辑、DnD 边界 |
| IME | ★★★☆☆ 整页 CE 历史坑多，但可借鉴 |
| 表格/代码 | ★★☆☆☆ 表常需嵌套 CE 或 custom node，复杂 |
| 迁移成本 | 极高（近似换引擎：ProseMirror/TipTap/CodeMirror 级） |
| 风险 | 回归全部 W0–W10 波次 |

**适用**：绿场「Markdown 即文档流」编辑器；**不**适合当前「块 registry + 表面切换」资产。

**示意**

```
┌─ contenteditable=true ─────────────────────┐
│  <h2 data-id=1>…</h2>                       │
│  <p data-id=2>…</p>                         │
│  <pre data-id=3>…</pre>                     │
│  Selection 可跨节点 ─────────────────       │
└─────────────────────────────────────────────┘
```

### 3.2 方案 B — 多块同时 line-source + 合成 Selection

**形态**：保持块岛；`selectedIds` 内全部 paint line-source；应用层维护 anchor/focus 端点；自绘选区高亮；剪贴板/删除走 model。

| 维度 | 评价 |
|------|------|
| 跨行选区 | ★★★★☆ 需自研，但可控 |
| 多行源码呈现 | ★★★★★ **直接满足 E2** |
| 与现架构 | ★★★★☆ 复用 `line-source.js` / enter 表面逻辑 |
| IME | ★★★★☆ 仍限 primary 单块 |
| 表格/代码 | ★★★☆☆ 明确「整块单元」策略即可 |
| 迁移成本 | 中：新模块 + FSM + 修订 INV-1 |
| 风险 | 合成选区与真实 caret 不同步；批量 height-lock |

**示意**

```
块1 read          块1 line-source ─┐
块2 read    ──►   块2 line-source ─┼─ selectedIds
块3 read          块3 line-source ─┘
浏览器 Selection 可能只在 primary；
视觉条带由 .mdx-sel-overlay / ::highlight / 类名绘制
```

### 3.3 方案 C — 混合（推荐）

**形态**：

1. **单块编辑路径保留**（今天的 `enterEdit` 语义 → `single-edit`）。  
2. **一旦跨块**（拖选/Shift 扩展/Shift+Click/Ctrl+A）→ **升级**为 B 的 multi-source。  
3. **降级**：点击无修饰、Esc、开始输入（策略）、失焦 → 回 idle / single-edit。  
4. **可选加速**：viewOnly / 只读复制可不 paint 全量 line-source，只 serialize（性能开关）。

| 维度 | 评价 |
|------|------|
| 跨行选区 | ★★★★☆ |
| 多行源码 | ★★★★★（multi 态） |
| 单块体验 | ★★★★★ 不回退 |
| 与现架构 | ★★★★★ 渐进迁移 `activeId`→`primaryId` |
| 成本 | 中高但可分期 |
| 风险 | 状态机边界 bug；需强测试清单 |

### 3.4 对比矩阵（决策用）

| 判据 | A 文档流 | B 多源合成 | C 混合 |
|------|----------|------------|--------|
| 满足 E2 多行源码 | 难 | 易 | 易 |
| 保留块 DnD / slash | 难 | 易 | 易 |
| 保留 table chrome | 难 | 中 | 中 |
| 复用 line-source.js | 低 | 高 | 高 |
| 工程分期 | 差 | 中 | **好** |
| 长期可演进到 PM 等 | 已是 | 可适配 | 可适配 |
| **推荐** | 否（远期引擎重写另议） | 可 | **是** |

### 3.5 明确不选的伪方案

| 伪方案 | 为何否 |
|--------|--------|
| 拖选时临时 `contenteditable=true` 整 scroller | 与块 CE 嵌套、焦点、XSS、序列化全乱 |
| 只做「块级多选」（Notion 块高亮）不做行内 offset | 不满足「从标题中间到段中」复制 |
| 复制时从 model 猜选区但 UI 不显示 multi source | 违背 E2；用户不知道选了什么 |
| 继续在 `editor.js` 加 800 行 | 违反宪章与 README 硬政策 |

---

## 4. 推荐方案 + 状态机

### 4.1 推荐：方案 C（混合，实现内核同 B）

**产品一句话**：  
平时像现在一样点进一行改；一旦选中多行，**选中的行全部露出 Markdown 结构源码**，复制/删除/格式化按区间操作。

### 4.2 全局模式枚举

```ts
type EditorMode =
  | 'idle'                  // 无焦点编辑；可有 hover
  | 'single-edit'           // 恰一块可输入 surface（兼容今日 activeId）
  | 'multi-source-selected' // ≥1 块在选区；选中内容行均 line-source 呈现
  | 'dragging';              // 指针拖选进行中（mouseup → multi 或 collapse）
```

> 注：`multi-source-selected` 在「仅选中一块但非整块 caret 编辑、而是块级高亮」时也可使用；与 `single-edit` 的区别是 **有无 range/多 id 与是否允许直接输入**。

### 4.3 状态机（文本）

```
                    pointer on handle
  idle ──────────────────────────────────────► (DnD 子系统，非本 FSM)
    │
    │ click content / focusBlock
    ▼
 single-edit ◄──── Esc / blur outside ──── idle
    │   ▲
    │   │ click other (no mod) / clear multi
    │   │
    │   ├─ Shift+Arrow 跨出块边界
    │   ├─ Shift+Click 其它块
    │   ├─ 拖选 move 离开本块
    │   └─ Ctrl+A（全文策略）
    ▼
 multi-source-selected
    │   ▲
    │   └── dragging（pointermove 更新区间）
    │         ▲
    │         └── pointerdown+move
    │
    ├─ Esc / 空点击空白 ──► idle
    ├─ 无修饰 click 块 K ──► single-edit(K)
    ├─ Delete/Backspace ──► mutation ──► single-edit | idle
    └─ 格式命令 ──► 仍 multi 或 collapse（命令自定）
```

### 4.4 状态不变量

| ID | 不变量 |
|----|--------|
| I1 | `single-edit` ⇒ `selectedIds` 为空或仅 `[primaryId]`，且 primary 有输入 surface |
| I2 | `multi-source-selected` ⇒ `selectedIds.length ≥ 1`，且 **每个** 内容行块 UI ∈ line-source（或整块单元的 source 等价态） |
| I3 | `dragging` ⇒ 不 commit 中间态到 history；mouseup 再提交选区模型 |
| I4 | `composing === true` ⇒ 禁止 mode 切换到 multi / 禁止 leave primary |
| I5 | `viewOnly` ⇒ 禁止 single-edit 输入；允许只读选区子集 |
| I6 | 任意时刻 **至多一个** `primaryId` 接受 IME/字符输入 |
| I7 | `selectedIds` 在文档顺序上是 **连续区间**（v1 不支持多段不连续选区；Ctrl+Click 非连续列为 v2） |

### 4.5 转换表（核心）

| From | Event | To | 副作用 |
|------|-------|-----|--------|
| idle | click block | single-edit | paint source(id)；focus caret |
| single-edit | click other | single-edit | leave old；enter new |
| single-edit | Shift+Click other | multi | paint source(range)；合成选区 |
| single-edit | Shift+↓ past end | multi | add next；paint |
| single-edit | drag out | dragging→multi | |
| multi | Esc | idle | paint read(all selected)；clear |
| multi | click no-mod | single-edit | clear others；enter |
| multi | Delete | idle/single | bulk delete |
| * | pointer handle | * | 不进入 multi（或 clear） |
| * | composition | * | 锁 mode |

### 4.6 与「全部显示 line-source」的 paint 策略

**进入 multi 时**（`SurfacePainter.enterMulti(ids)`）：

1. 计算有序 `ids = selectedIds`。  
2. 对每个 id：  
   - 若已是 primary 且 surface 已在：保留 DOM，标 `.is-selected`。  
   - 否则：height-lock → `renderEditSurface` / code source / 特殊块策略 → 标 `.is-selected`。  
3. **输入性**：  
   - v1 推荐：非 primary 的 surface 设 `contenteditable=false`（仍显示源码），避免多焦点；primary 可 true 或也 false（纯选区态）。  
   - 用户明确要「看到源码」≠「每块都能打字」。  
4. 绘制合成选区：端点之间字符级高亮（可用 CSS `background` 分片或 overlay）。

**离开 multi**：

1. 对 `selectedIds` 中每个 id：`readFromEditSurface` 仅当曾可编辑且 dirty；否则直接 `readContentHtml` paint。  
2. 清 class；mode=idle/single。

### 4.7 primary vs 多 surface 可编辑性（拍板建议）

| 选项 | 描述 | 建议 |
|------|------|------|
| P-readonly-multi | multi 时全部 CE=false，只展示源码+选区 | **v1 默认**（稳、IME 简单） |
| P-primary-edit | multi 时仅 primary 可编 | v1.1 |
| P-all-edit | 所有 selected 可编 | **不推荐**（焦点/IME/ demote 灾难） |

---

## 5. 数据模型：`selectedIds[]`、`primaryId`、`anchor`

### 5.1 类型草案

```ts
/** 块内偏移：以 line-source 正文或整源字符串为坐标系（见 5.3） */
interface BlockCaret {
  blockId: string;
  /** 0..sourceLength；在 body 坐标系或 full-source 坐标系二选一，全局统一 */
  offset: number;
  affinity?: 'before' | 'after';
}

interface SelectionModel {
  mode: EditorMode;
  /** 文档顺序的选中块 id；v1 连续 */
  selectedIds: string[];
  /** 输入/键盘焦点块；兼容旧 activeId */
  primaryId: string | null;
  /** 锚点（Shift 扩展原点） */
  anchor: BlockCaret | null;
  /** 活动端（拖选/键盘移动的一端） */
  focus: BlockCaret | null;
  /** 是否折叠（caret only） */
  isCollapsed: boolean;
  /** 拖选会话 */
  drag?: {
    startY: number;
    origin: BlockCaret;
  } | null;
}
```

### 5.2 字段语义

| 字段 | 语义 | 旧对应 |
|------|------|--------|
| `primaryId` | 键盘焦点块；IME 宿主 | `activeId` |
| `selectedIds` | 多选集合（含 primary） | **无** |
| `anchor` | 选区固定端 | **无** |
| `focus` | 选区活动端 | 浏览器 focus offset 近似 |
| `isCollapsed` | anchor==focus 且同 offset | 单 caret |

### 5.3 偏移坐标系（必须写死）

多选复制需要稳定 offset。推荐 **Full Source Line 坐标**：

- 对文本块：`coord = MdxLineSource.toSourceLine(block)` 的 UTF-16 偏移（或 grapheme，实现选一种）。  
- 对 code/math：整 fence 字符串。  
- 对 table/image：v1 **整块原子**（offset 仅 0 或 len，不进单元格）。

端点截断算法：

```
copy(anchor, focus):
  normalize order → (start, end)
  for id in selectedIds:
    src = toSourceLine(block)
    if id === start.blockId && id === end.blockId:
      slice src[start.offset:end.offset]
    else if id === start.blockId:
      slice src[start.offset:]
    else if id === end.blockId:
      slice src[:end.offset]
    else:
      full src
  join with \n\n（列表项之间可用 \n，与 serialize 风格对齐）
```

**注意**：`toSourceLine` 与 `serialize.js` 的列表标记可能不一致（`*` vs `-`）。  
**契约**：剪贴板 **优先 `serialize` 单块函数**；offset 坐标系若用 toSourceLine，须保证与 serialize **同构**或提供 `sourceLineForClipboard(block)` 唯一函数。

### 5.4 连续性约束

v1：`selectedIds` = 文档索引 `[minIndex, maxIndex]` 闭区间全部 id。  
Shift+Click 块 2 与 7 ⇒ 自动包含 3..6。

### 5.5 与 History

| 操作 | 选区是否入 undo |
|------|-----------------|
| 仅改变选区 | 否 |
| 删除/格式化/粘贴 | 是（Doc）；undo 后选区默认 collapse 到变更点 |
| v2 | 可选 selection bookmark |

### 5.6 派生查询 API（模块导出）

```ts
// edit/selection/model.ts（目标名）
getSelectedBlocks(doc, sel): Block[]
getSourceSlice(doc, sel): string
isBlockSelected(sel, id): boolean
extendTo(sel, caret): SelectionModel
collapseTo(sel, caret): SelectionModel
rangeFromPointer(doc, layout, x, y): BlockCaret
```

---

## 6. 与现有 `activeId` 迁移路径

### 6.1 阶段 M0 — 观察与双写（不改行为）

| 步骤 | 内容 |
|------|------|
| M0.1 | 引入 `SelectionModel` 对象，内部 `primaryId = activeId` |
| M0.2 | 所有 `activeId = x` 改为 `setPrimary(x)` 同步旧变量 |
| M0.3 | `selectedIds` 恒为 primary ? [primary] : [] |
| M0.4 | 测试：现有 harness 全绿 |

### 6.2 阶段 M1 — 点击/键盘旁路

| 步骤 | 内容 |
|------|------|
| M1.1 | `onRootClick`：识别 shiftKey → `selectRange(anchor, target)` |
| M1.2 | 抽取 `leavePrimary` / `paintSource` 从 `enterEdit` 可复用 |
| M1.3 | 禁止 multi 路径调用「互斥 exit 掉仍在 selected 内的块」 |

### 6.3 阶段 M2 — 拖选 + 合成高亮

| 步骤 | 内容 |
|------|------|
| M2.1 | pointerdown/move/up 状态机 `dragging` |
| M2.2 | 自绘选区 |
| M2.3 | 批量 paint line-source |

### 6.4 阶段 M3 — 剪贴板与删除

| 步骤 | 内容 |
|------|------|
| M3.1 | copy/cut 拦截 → `getSourceSlice` |
| M3.2 | paste 替换选区 |
| M3.3 | bulk delete |

### 6.5 阶段 M4 — 收口

| 步骤 | 内容 |
|------|------|
| M4.1 | 删除裸 `activeId` 变量，仅 `selection.primaryId` |
| M4.2 | 修订 feature-catalog INV-1 |
| M4.3 | 从 `editor.js` 删除已迁移代码；行数下降 |

### 6.6 兼容映射表

| 旧 API / 变量 | 新 |
|---------------|-----|
| `activeId` | `selection.primaryId` |
| `enterEdit(id)` | `mode single-edit` + `paintSource([id])` + focus |
| `exitEdit(commit)` | `commitPrimary?` + `paintRead` + clear selection |
| `root.classList is-editing` | `is-editing` 当 single；`is-multiselect` 当 multi |
| `.is-active` | `.is-primary` + `.is-selected` |
| `getSelectionTextInEditor` | `selectionClipboard.getPlainAndMd()` |

### 6.7 风险控制：开关

```ts
features: {
  multiBlockSelection?: boolean; // 默认 false → 金丝雀；true 后开
}
```

关闭时：所有路径退回 M0 行为（仅 single-edit）。

---

## 7. 边界：table / code / image 是否参与跨选

### 7.1 决策总表（v1）

| 块类型 | 参与跨块选区 | multi 时呈现 | 选区粒度 | 复制内容 |
|--------|--------------|--------------|----------|----------|
| paragraph / heading / list* / task / quote / callout | **是** | line-source | 字符级 offset | `toSourceLine` / serialize |
| divider | **是** | 源 `---` 或只读条 | 整块原子 | `---` |
| code / mermaid | **是** | focus-source fence | **整块原子**（v1） | 完整 fence |
| math | **是** | `$$…$$` 源 | 整块原子 | dollarSource |
| table | **是（整表）** | 保持读态或简易源 | **整块原子** | GFM pipe table serialize |
| image | **是** | GFM `![]()` 源行 | 整块原子 | image 行 |
| file_chip / toc / embed | **是** | 读态 + selected 高亮 | 整块原子 | 约定序列化 / 占位 |
| 表**内**单元格 | **否（跨块）** | 表内 selection.js | 单元格 | TSV 路径独立 |

### 7.2 表格详细规则

| 场景 | 行为 |
|------|------|
| 选区仅在表内 | 沿用 `table/selection.js`；不升级文档 multi |
| 拖选从段落实进入表 | 表视为 **一个原子块** 加入 selectedIds |
| 拖选从表内拉出到段 | 结束表内选；整表进文档选区 |
| multi 含表时 Delete | 删除整表块 |
| multi 含表时 Ctrl+B | **忽略表** 或只处理文本块（命令过滤器） |

**理由**：表已有复杂合并/TSV；与文档字符选区混用会导致双重 Selection 控制器死锁。

### 7.3 代码块详细规则

| 场景 | 行为 |
|------|------|
| multi 含 code | 显示完整 fence 源（与单块 focus-source 一致） |
| offset | v1 不支持「只选代码中间行」跨块混合时的半 fence；整块全有或全无 |
| 将来 v2 | 允许 code 内 offset，复制时仍输出合法 fence（自动补围栏） |

### 7.4 图像

- 读态：图预览；multi：切到 `![]()` 源行（已有 image editHtml 路径）以便复制为 MD。  
- 若担心闪烁：multi 时保留预览 + `.is-selected`，复制仍从 model 序列化（**可接受的 E2 弱化**，须在验收标注）。

### 7.5 嵌套列表

列表是 **flat Block[] + indent**，不是 DOM 嵌套。  
跨选自然按数组序；复制时保留 indent 空格。  
**不**做「只选子树」特殊算法（indent 可视化足够）。

### 7.6 空块 / 唯一段

- 全选后删除 → 保留一个空 paragraph（对齐 `removeBlock` 最后一块策略）。  
- multi 只含一个空段 → Delete 同单块。

---

## 8. 键盘与剪贴板契约

### 8.1 键盘（文档级，`edit/selection/keymap.ts`）

| 按键 | idle | single-edit | multi-source | 备注 |
|------|------|-------------|--------------|------|
| ↑↓←→ | 可选 roving | 块内移动；边界可跨块移 caret（collapse） | 移动 **focus 端**（不按 Shift 则 collapse 到端点） | |
| Shift+↑↓←→ | — | 扩展选区；跨边界 → multi | 扩展 focus | |
| Shift+Click | — | multi | 重设 focus 端 | |
| Ctrl/Cmd+A | 全文 multi | 先块内全选；再按全文 multi | 保持全文 | v1 可直接全文 |
| Ctrl/Cmd+C | 若有只读选区则复制 | 块内或 multi 切片 | `getSourceSlice` → MD + text/plain | |
| Ctrl/Cmd+X | — | 剪切 | 切片 + bulk delete | |
| Ctrl/Cmd+V | — | 粘贴 | **替换**选区 | |
| Backspace/Delete | — | demote/merge | bulk delete | multi 不做 demote 阶梯 |
| Esc | — | leave | clear multi → idle | |
| Tab / Shift+Tab | — | indent | 批量 indent 文本/list | 表内仍单元格 |
| Ctrl/Cmd+B/I 等 | — | 单块 marks | 对每块 body 应用 | 跳过原子块 |
| Enter | — | split | v1：删除选区后 split 或 noop | 建议：先 delete 再 single Enter |
| 字符键 | — | 输入 | v1：ignore 或「删选区后 single 输入」 | 推荐 Word 模型 v1.1 |
| Ctrl/Cmd+Z | undo | undo | undo | 选区不恢复 |

### 8.2 与现有 `onEditKeydown` 的分工

| 层 | 职责 |
|----|------|
| **SelectionKeymap**（捕获阶段 root） | multi 态快捷键；Shift 扩展；Ctrl+A/C/X/V |
| **BlockKeydown**（surface） | demote、promote、slash、Enter split — **仅 single-edit** |
| **TableKeydown** | 单元格导航 — 表 focus 时优先 |

**规则**：`mode === multi` 时 surface keydown **停止** demote/split，改交给 SelectionKeymap。

### 8.3 剪贴板格式契约

| MIME | 内容 | 优先级 |
|------|------|--------|
| `text/plain` | MD 源切片（与 text/markdown 同或去 fence 策略统一） | 必须 |
| `text/markdown` | 同切片 | 尽量 |
| `text/html` | 可选：由 MD 轻转 HTML，便于贴 Word | P2 |
| 内部 `application/x-conex-mdx-blocks+json` | 块 JSON 数组 | P1 应用内粘贴保真 |

**Copy 算法**：

1. 若 `mode===multi` 或非折叠选区 → `getSourceSlice`。  
2. 若 single 且浏览器 sel 非空 → 可先尝试 CE 内切片，再 fallback model。  
3. 表内 only → TSV 模块。

**Paste 算法**：

1. 若 multi/非折叠 → 先 bulk delete 选区（一次 history 合并）。  
2. 解析 MD → `parse` 为 Block[] → `insertBlock` 序列。  
3. 若内部 JSON 可用 → 优先。  
4. 落点：primary 或删除后的索引。

### 8.4 与 AI 端口

`getSelectionTextInEditor` 应改为：

```ts
aiContext.selectionText = clipboard.getSourceSlice() || ''
```

避免 AI rewrite 只拿到半截渲染文本。

### 8.5 无障碍

| 项 | 契约 |
|----|------|
| `aria-multiselectable` | 在 `data-mdx-blocks` 容器 |
| `aria-selected` | 每块 |
| live region | 不每键宣布；仅 bulk delete「已删除 N 块」可选 |
| 焦点 | multi 时 focus 保留在 root 或 primary，避免丢失键盘 |

---

## 9. 验收清单（20+ 条）

> 实施后 QA 按条勾选；**失败即阻断**标 ★。

### 9.1 选区基础

| # | 条目 | 优先级 |
|---|------|--------|
| A01 ★ | 从块 A 中部拖到块 C 中部，出现连续选区视觉，A/B/C 均 line-source | P0 |
| A02 ★ | Shift+Click 从块 2 到块 5，selectedIds 含 2..5 且均 line-source | P0 |
| A03 ★ | Shift+↓ 在段末扩展到下一块 | P0 |
| A04 ★ | Ctrl+A 选中全部内容块 | P0 |
| A05 | Esc 清除 multi，全部回 read，无残留 `.is-selected` | P0 |
| A06 | 无修饰 click 单块 → single-edit，其它回 read | P0 |
| A07 | 折叠 caret 跨块方向键移动（不按 Shift）不残留 multi | P0 |
| A08 | 刷新/setMarkdown 后 selection 清空 | P1 |

### 9.2 源码呈现

| # | 条目 | 优先级 |
|---|------|--------|
| B01 ★ | multi 下标题显示灰色 `#`×level | P0 |
| B02 ★ | multi 下 bullet 显示 `*` 或 soft·策略与产品一致（建议 hard 源 `*`） | P0 |
| B03 ★ | multi 下 quote 显示 `>` | P0 |
| B04 | multi 下 code 显示完整 fence | P0 |
| B05 | 退出 multi 后结构前缀消失，读态恢复 | P0 |
| B06 | 批量 paint 无明显整页闪白；scrollTop 稳定 | P1 |
| B07 | 禁止多选时厚描边 is-active 复燃 | P0 |

### 9.3 剪贴板

| # | 条目 | 优先级 |
|---|------|--------|
| C01 ★ | 跨标题+段+列表复制，外部粘贴含 MD 前缀 | P0 |
| C02 ★ | 含代码块复制含 ``` 围栏 | P0 |
| C03 | 端点在标题中间时，复制切片 offset 正确 | P0 |
| C04 | Cut 后选区内容消失且一次 Ctrl+Z 恢复 | P0 |
| C05 | 应用内 copy/paste 保真（内部 JSON 或 MD） | P1 |
| C06 | viewOnly 可复制不可剪切 | P0 |

### 9.4 删除与格式

| # | 条目 | 优先级 |
|---|------|--------|
| D01 ★ | multi + Delete 删除区间，残留文档合法 | P0 |
| D02 ★ | 删光后仍至少一空段落 | P0 |
| D03 | multi + Tab 批量 indent list | P1 |
| D04 | multi + Ctrl+B 仅包裹正文 | P1 |
| D05 | 一次 undo 恢复 bulk delete | P0 |

### 9.5 边界块

| # | 条目 | 优先级 |
|---|------|--------|
| E01 ★ | 跨选含 table 时表作整块原子 | P0 |
| E02 | 表内框选不被文档 multi 打断 | P0 |
| E03 | 跨选含 image，复制为 `![]()` | P1 |
| E04 | divider 可被选中删除 | P1 |

### 9.6 冲突与稳定

| # | 条目 | 优先级 |
|---|------|--------|
| F01 ★ | 拖把手不触发文本 multi | P0 |
| F02 ★ | 中文 IME 组字中 Shift 扩展被抑制或安全 | P0 |
| F03 | slash 打开时不进入错误 multi | P1 |
| F04 | selectionToolbar 关闭时无回归；开启时 multi 隐藏或禁用 | P1 |
| F05 | 50–200 块文档拖选不掉帧到不可用（定性） | P1 |
| F06 | `features.multiBlockSelection=false` 行为与改前一致 | P0 |

### 9.7 工程

| # | 条目 | 优先级 |
|---|------|--------|
| G01 ★ | 新逻辑在 `edit/selection/*`，`editor.js` 净增可控（建议接线 ≤80 行） | P0 |
| G02 | 单测：SelectionModel extend/collapse/slice | P0 |
| G03 | harness：拖选/复制至少 1 条自动化 | P1 |
| G04 | feature-catalog INV-1 已修订 | P0 |

---

## 10. 模块拆分（禁止继续堆 `editor.js`）

### 10.1 目标路径（reference 与包对齐）

> reference 落地优先按模块文件；`packages/conex-mdx` 映射同构。

```
js/markdown-editor/   （现状）          packages/conex-mdx/src/（目标）
├── edit/
│   ├── selection/
│   │   ├── model.js                 edit/selection/model.ts
│   │   ├── controller.js            edit/selection/controller.ts
│   │   ├── pointer.js               edit/selection/pointer.ts
│   │   ├── keymap.js                edit/selection/keymap.ts
│   │   ├── paint-multi.js           edit/selection/paint-multi.ts
│   │   ├── clipboard.js             edit/selection/clipboard.ts
│   │   ├── bulk-commands.js         edit/selection/bulk-commands.ts
│   │   └── index.js                 edit/selection/index.ts
│   ├── height-lock.js               （已有）
│   ├── ime-guard.js                 （已有）
│   └── …
├── ui/line-source.js                edit/line-source.ts（已有映射）
├── editor.js                        editor/controller.ts（薄接线）
└── model.js                         model/*
```

### 10.2 模块职责

| 模块 | 职责 | 禁止 |
|------|------|------|
| `selection/model` | SelectionModel 纯函数：extend、normalize、slice ids | 碰 DOM |
| `selection/controller` | mode FSM；对接 model/doc；暴露 API | 具体 HTML 字符串 |
| `selection/pointer` | pointerdown/move/up；hitTest 块与 offset | 剪贴板 |
| `selection/keymap` | 文档级快捷键 | demote 阶梯细节 |
| `selection/paint-multi` | 批量 line-source / read；class；height-lock 批 | parse MD |
| `selection/clipboard` | copy/cut/paste 事件；MIME | UI 菜单 |
| `selection/bulk-commands` | delete/indent/toggleMark 多块 | 单块 Enter split |
| `line-source` | 单块源码 surface（已有） | 全局选区状态 |
| `editor.js` / controller | 注册监听、把事件交给 selection | 新业务分支膨胀 |

### 10.3 依赖方向

```
selection/model（纯）
    ↑
selection/controller ←→ DocumentModel
    ↑
pointer / keymap / clipboard / bulk-commands
    ↑
paint-multi → line-source / blocks/*
    ↑
editor controller（wiring only）
```

**禁止**：`line-source` import `selection`；`model.js` import DOM selection。

### 10.4 从 `editor.js` 迁出清单

| 现状片段 | 迁往 |
|----------|------|
| `var activeId` | selection model primaryId |
| `enterEdit` / `exitEdit` 中与焦点调度 | selection controller + paint |
| `onRootClick` 块切换 | pointer + controller |
| `getSelectionTextInEditor` | clipboard |
| 未来任何 multi if 枝 | **禁止**留在 editor.js |

`enterEdit` 内 **按类型 mount surface** 的大段（table/code/math）应已在 `blocks/*`；多选 paint 只调块模块，不复制 HTML 模板。

### 10.5 行数门（继承宪章）

| 文件 | 软顶 | 硬顶 |
|------|------|------|
| selection/model | 250 | 400 |
| selection/controller | 350 | 500 |
| selection/pointer | 300 | 450 |
| selection/keymap | 200 | 350 |
| selection/paint-multi | 300 | 450 |
| selection/clipboard | 250 | 400 |
| editor.js 接线增量 | +80 | +120（超出再拆） |

### 10.6 测试文件建议

```
tests/selection-model-harness.js
tests/selection-clipboard-harness.js
tests/w-multi-select-harness.js
```

---

## 11. 风险与回滚

### 11.1 风险登记

| ID | 风险 | 可能性 | 影响 | 缓解 |
|----|------|--------|------|------|
| K1 | 批量 line-source 导致大文档卡顿 | 中 | 高 | 仅 paint 视口内 + 缓冲；feature flag；原子块不切源 |
| K2 | 合成选区与系统 Selection 不一致导致复制空 | 中 | 高 | 强制拦截 copy 事件；测试 C01 |
| K3 | IME 与 mode 切换丢字 | 中 | 高 | composing 锁；复用 ImeGuard |
| K4 | 与 table selection 双控制器冲突 | 中 | 中 | 命中表内优先表；跨出升文档原子 |
| K5 | height-lock 批量失败 → 跳动 | 中 | 中 | 批 lock；或 multi 弱化 lock 验收 B06 |
| K6 | `toSourceLine` vs `serialize` 不一致 | 高 | 中 | 统一 clipboard 序列化入口 |
| K7 | 规格 INV-1 未改导致评审反复 | 高 | 低 | 本分析附带修订文案 |
| K8 | editor.js 继续膨胀 | 高 | 高 | PR 门禁：路径必须在 selection/* |
| K9 | 非连续多选用户预期（Ctrl+Click） | 低 | 低 | v1 不做；文档说明 |
| K10 | 可访问性：读屏读到多块 contenteditable | 中 | 中 | multi 非 primary CE=false |

### 11.2 回滚策略

| 层级 | 方法 |
|------|------|
| **运行时开关** | `features.multiBlockSelection=false` 立即回到单 active 路径 |
| **git** | selection/* 独立 commits；revert 不影响 demote/table |
| **双写期** | M0–M1 保留 `activeId` 变量，flag 关时不读 selectedIds |
| **数据** | 无持久化 schema 变更；Doc v2 不变 → **无迁移回滚** |
| **规格** | INV-1 修订用「mode 条件句」，可再收紧 |

### 11.3 渐进发布建议

1. **内部 flag 默认 off** 合入模块与单测。  
2. demo HTML 开 flag 手工跑 A/B/C 清单。  
3. 桌面 Nightly 开 flag。  
4. 默认 on；保留 flag 一版。  
5. 删 flag 与 `activeId` 别名。

### 11.4 明确非目标（防 scope creep）

| 非目标 | 归属 |
|--------|------|
| 非连续多选（Ctrl+Click 多段） | v2 |
| 协同 OT 选区 | 永不在本册 |
| 整页 A 方案引擎替换 | 独立 RFC |
| 多块同时 IME 输入 | 不做 |
| 多块 DnD | dnd 册 v2 |
| 选区浮动条依赖 | 仍默认关 |

---

## 12. 竞品对照（Typora / Obsidian Live Preview / Notion）

> 目的：校准「做到好用」的参照，**不是**逐像素抄袭。

### 12.1 Typora

| 点 | Typora | Conex 启示 |
|----|--------|------------|
| 模型 | 源码文档流 + 实时渲染；聚焦行源码感强 | **多行选中时源码可见** 与 Typora 一致 → 支撑 E2 |
| 跨行选区 | 原生连续 | 我们用合成补齐，视觉应对齐「一段灰蓝选区」 |
| 复制 | MD 源 | 必须 MD |
| 块把手/slash | 弱 | 我们保留 Notion 向块 UX |

### 12.2 Obsidian Live Preview

| 点 | Obsidian | Conex 启示 |
|----|----------|------------|
| 模型 | CM6 源码 + 装饰渲染；本质仍源文档 | 证明「渲染外观 + 源选区」可行，但他们有编辑器内核 |
| 选区 | 源坐标 | 我们 offset 应用层化 |
| wiki 等 | 强 | 扩展层，不挡多选 |

### 12.3 Notion

| 点 | Notion | Conex 启示 |
|----|--------|------------|
| 多选 | **块级** multi-select 强；行内跨块选区弱于源码编辑器 | 可学块高亮与批量操作；**不能**学「隐藏所有 MD」 |
| 拖选 | 易变成块选择 | 我们要 **字符级优先**，块原子仅特殊类型 |
| 删除/转类型 | 批量成熟 | bulk-commands 对齐 |

### 12.4 合成策略（Conex 定位）

```
阅读观感 ≈ Notion/GitHub
结构编辑 ≈ Typora 行源（单行 + 多行选中）
块操作   ≈ Notion slash/DnD
跨块选区 ≈ Typora/Obsidian 的「源连续」语义 + 自研 FSM
```

---

## 13. 与现有代码路径的对照附录

### 13.1 `editor.js` 关键片段（逻辑索引）

| 主题 | 行为摘要 |
|------|----------|
| 状态 | `activeId = null` 单槽 |
| `enterEdit` | 切 id 先 `exitEdit`；再按 type mount surface |
| `exitEdit` | commit → 清 active → paint read |
| `reconcile` | 跳过 active 重绘；无 selected 集合 |
| `onRootClick` | 命中块 → `enterEdit`；无 Shift |
| `getSelectionTextInEditor` | `window.getSelection().toString()` |
| 事件 | `click` + handle `pointerdown`；**无**文档级 selection pointermove |
| 销毁 | `destroy` 强清 active |

### 13.2 `line-source.js` 可复用点

- `toSourceLine` / `renderEditSurface` / `readFromEditSurface`  
- **不需**为多选重写 demote；demote 仍 single-edit only  

### 13.3 `model.js` 批量策略

- 短期：`replaceBlocks` 一次写回  
- 或循环 `removeBlock` 但 **先** `pushHistory` 一次（需扩 API `runTransaction(fn)`）  
- 建议后续加：

```ts
// 示意
model.transact(() => {
  // 多个 update/remove，只一次 history
});
```

### 13.4 规格修订草稿（实施 PR 应带）

**旧 INV-1**：

> 任意时刻至多一个块处于 line-source 或 focus-source-fence。

**新 INV-1**：

> - `single-edit`：至多一个块持有输入 caret 且为 line-source / focus-source。  
> - `multi-source-selected`：`selectedIds` 内所有内容块须处于 line-source（或类型规定的 source 等价态）；其中至多一个 `primaryId` 可接收 IME。  
> - `idle`：零个编辑 surface。

---

## 14. 实施波次建议（供 05 计划引用，非本文件实现）

| 波次 | 交付 | 依赖 |
|------|------|------|
| U1a | SelectionModel 纯函数 + 单测 + flag | 无 |
| U1b | paint-multi + Shift+Click | line-source |
| U1c | pointer 拖选 + 合成高亮 | U1b |
| U1d | clipboard + Delete | U1c |
| U1e | keymap 完善 + 规格修订 + 删 activeId | U1d |
| U1f | 性能：视口 paint + 长文测 | U1e |

---

## 15. 决策摘要（给调度者）

| 决策点 | 推荐 |
|--------|------|
| 方案 | **C 混合（内核 B）** |
| multi 时 CE | **非 primary 只读源码展示** |
| 偏移坐标 | **full source line** 统一 |
| 表/代码 | **整块原子** |
| 非连续选区 | **v1 不做** |
| activeId | **primaryId 兼容 → 删除** |
| 模块 | **`edit/selection/*`** |
| 开关 | **`features.multiBlockSelection`** |
| 规格 | **改 INV-1** |

---

## 16. 参考路径速查

| 路径 | 说明 |
|------|------|
| `reference/chat-composer-component/js/markdown-editor/editor.js` | 单 active、click、enter/exit |
| `reference/chat-composer-component/js/markdown-editor/ui/line-source.js` | 行源码 surface |
| `reference/chat-composer-component/js/markdown-editor/model.js` | Doc/History |
| `reference/chat-composer-component/js/markdown-editor/serialize.js` | 块 → MD |
| `reference/chat-composer-component/js/markdown-editor/table/selection.js` | 表内选区（边界） |
| `packages/conex-mdx/ARCHITECTURE.md` | 包模块所有权 |
| `docs/markdown-editor/feature-catalog/01-core-blocks-and-line-source.md` | INV-1 待修订 |
| `docs/markdown-editor/ux-readiness/README.md` | 本系列索引 |

---

## 17. 结语

跨行选区做不好，**不是**「再给 contenteditable 加一个 listener」能解决的问题；根因是 **单 active 块调度 + 岛式 DOM + 规格 INV-1** 与 **Typora 式多行源码多选** 的产品目标正面冲突。

推荐路径清晰：

1. 用 **SelectionModel** 取代裸 `activeId`；  
2. 用 **multi-source-selected** 满足「选中行全部 line-source」；  
3. 用 **合成选区 + 拦截剪贴板** 满足复制真 MD；  
4. 用 **`edit/selection/*` 拆分** 避免 `editor.js` 再度失控；  
5. 用 **feature flag** 保证可回滚。

本文件为 **分析与契约**；具体编码应另开实现任务，严格按 §10 路径落地，并完成 §9 验收清单。

---

*文档结束 · 无实现代码 · 2026-08-03*
