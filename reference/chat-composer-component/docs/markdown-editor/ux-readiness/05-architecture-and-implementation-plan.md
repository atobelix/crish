# 05 — 架构与实施计划（UX Readiness）

> **角色**：架构 + 实施规格（**仅文档**，不含应用代码）  
> **日期**：2026-08-03  
> **读者**：调度者、实现 Agent、评审 Agent、Desktop 集成  
> **系列**：本目录 [README](./README.md) → 建议读序 00→05  
> **权威冲突仲裁**：用户可感知好用 > 本目录 > `feature-catalog` > `v3-complete` > 现状代码  
> **硬政策**：  
> 1. 运行时 **禁止 mock AI / 假数据**（见 [AI-HOST-POLICY.md](../feature-catalog/AI-HOST-POLICY.md)）  
> 2. AI **仅**宿主薄端口（`complete` / 类型面 `AiPort`）  
> 3. **禁止**继续膨胀 `editor.js`（现状 **~3237 行**）  
> 4. 目标落点：`packages/conex-mdx`（脚手架已存在）+ reference 模块化过渡  

---

## 0. 执行摘要（先读这段）

### 0.1 一句话

**在保留「block-per-row」渲染骨架的前提下，引入独立的 Selection 会话层与多块行源显示，把 `editor.js` 上帝文件按职责切开，并按 U1→U6 把「功能有了」补成「日常好用」；AI 永远只做宿主端口转发。**

### 0.2 最大架构债（必须先解）

| 债 | 现状 | 后果 | 本计划对策 |
|----|------|------|------------|
| **单块焦点 vs 跨行选择** | `activeId: string \| null` 一次只编辑一块；浏览器原生选区可跨 DOM 但 **模型不认** | 无法多块删除/复制/加粗/转类型；跨行「源码预览」无从谈起 | **U1**：`SelectionModel`（anchor/focus）+ `MultiSourceView` |
| **`editor.js` god file** | ~3237 行：render / enter-exit / table / dnd / keymap / AI 接线全堆 | 并行 Agent 冲突、回归面不可控、无法过行数门 | 先切片抽出纯函数与会话模块，再迁 `packages/conex-mdx` |
| **行源码粒度** | `ui/line-source.js` 按 **单块** `toSourceLine`；多段引用/列表跨行体验残 | 选中 3 段时看不到连贯 MD 源 | U1 多行源 + U2 行内 mark 源策略 |
| **剪贴板** | 部分路径 `insertText` / 无结构化 paste 管线 | Word/浏览器粘贴丢结构 | U3 `edit/clipboard/*` |
| **双源风险** | reference 运行时 + `packages/conex-mdx` stub | 新功能进错地方 | U6 工程波：新逻辑只进已拆模块路径或包 |

### 0.3 推荐首波（冻结）

| 项 | 决策 |
|----|------|
| **首波 ID** | **U1** |
| **范围** | **跨块多选（multi-block selection）+ 多行源码显示（multi-line source display）** |
| **不做** | 表合并增强、媒体闭环、包 bulk 迁移、AI 模型、默认选区工具条 |
| **为何先做** | 几乎所有后续 UX（复制/删除/转类型/AI 选区上下文/行内源可见）都以「选区是一等模型」为前提；再堆单块 polish 会返工 |

### 0.4 与 W0–W10 的关系

| 层级 | 含义 |
|------|------|
| **W0–W10** | feature-catalog 能力面骨架波次（多数标 done/verify，**不等于**日常好用） |
| **U1–U6** | **UX Readiness** 补齐波次：在骨架之上修架构债与摩擦 |
| 关系 | U 波 **不推翻** W 成果；U 波发现冲突时以用户可感知为准，并回写 `08-decision-log` |

### 0.5 成功判据（整轮 UX Readiness 出口）

1. 用户可 **Shift/拖选跨多个文本块**，选区高亮稳定；Delete 一次删多块；Copy 得连贯 MD。  
2. 多选时侧/顶可出现 **多行 MD 源只读或轻编辑预览**（策略见 §1.3），不破坏单块 line-source。  
3. `editor.js` **不再增长**；业务新代码落在 `edit/*` `selection/*` `clipboard/*` 或 `packages/conex-mdx/src/**`。  
4. 粘贴 HTML/MD/plain 主路径有测试；表与媒体残差有明确 U4/U5 出口。  
5. AI 无端口时 **零假输出**；有端口时仅转发。  
6. 无 runtime mock。  

---

## 1. 目标架构（编辑会话 / 选择 / 行源码 / 渲染分层）

### 1.1 分层总图

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Host（Desktop / Workbench / FilePreview / reference demo）               │
│  存盘 · 主题 · 真 AI 网关 · 上传 · onOpenPath/onOpenDoc                    │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ 薄 Adapter：mount / ports / destroy
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Public Surface（@conex/mdx 或 window.MarkdownEditor）                     │
│  mount · parse · serialize · get/set Markdown/Doc · focus · destroy      │
└───────────────────────────────┬─────────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ EditorController（薄协调 ≤500 行硬顶）                                    │
│  事件路由 · viewOnly · 事务提交入口 · 插件生命周期                          │
└───┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────────┘
    ▼          ▼          ▼          ▼          ▼          ▼
 EditSession  Selection  Model     Render     Edit/UI    Ports
 (焦点会话)   (选区模型)  History   Read/Morph LineSource AI/Media
    │          │          │          │          │          │
    └──────────┴──── Doc 真相仅在 Model；DOM 是投影 ─────────┘
```

| 层 | 职责 | 禁止 |
|----|------|------|
| Host | 真能力注入 | 改 block DOM、绕过 model |
| Public | 稳定符号 | 泄漏内部路径 |
| Controller | 路由与协调 | MD 语法细节、表算法、AI HTTP |
| EditSession | 单块 enter/leave、IME、height-lock | 多块选区算法 |
| Selection | 跨块/块内选区真相 | 直接写 `block.text` |
| Model | Doc + history | 碰 DOM、发网络 |
| Render | idle 精致投影 | 在 render 里 commit |
| Edit/UI | line-source、slash、table chrome | 内置 mock AI |
| Ports | 接口 + 规范化 | 假 complete 输出 |

### 1.2 编辑会话（EditSession）

#### 1.2.1 问题

现状 `activeId` 混用了三种概念：

1. **键盘焦点块**（caret 所在）  
2. **行源码编辑表面**（line-source / focus-source）  
3. **「选中」语义**（用户以为选了整块，实际只是 is-active 描边）

U1 起必须拆开。

#### 1.2.2 目标类型（规格级，非实现代码）

```
EditSession = {
  mode: 'idle' | 'line-source' | 'focus-source' | 'table-cell' | 'chrome'
  blockId: BlockId | null          // 至多一块处于「源码/编辑表面」
  composing: boolean               // IME
  heightLockPx: number | null
  surfaceKind: 'text-body' | 'code-fence' | 'math-dollar' | 'table-cell' | null
}

// 全局不变量
INV-ES-1  EditSession.blockId 非空 ⇒ 该块 DOM 存在 edit surface
INV-ES-2  任意时刻 line-source ∪ focus-source 块数 ≤ 1
INV-ES-3  composition 中禁止 leave / multi-block 破坏性操作（可排队 pending）
INV-ES-4  viewOnly ⇒ 禁止进入 line-source / focus-source（只读控件除外）
```

#### 1.2.3 与 Selection 的关系

| 场景 | EditSession | Selection |
|------|-------------|-----------|
| 单击段落放置 caret | 进入 line-source（该块） | collapsed，anchor=focus=该块内 offset |
| 拖选跨 3 段 | **leave** 当前 edit（commit）或保持读态 | range 跨 3 block |
| 多选后按字符键 | 可选：替换选区为新段（U1 后半 / U3） | 清空为 collapsed |
| 表内框选 | table-cell 或 chrome | TableSelection 子系统（U4） |

**关键决策（推荐默认，写入 08-decision-log 可推翻）**：

- **D-SEL-01**：当 `Selection` 变为 **非 collapsed 且跨 >1 块** 时，强制 `EditSession.leave(commit=true)`，进入 **「多选读态」**。  
- **D-SEL-02**：多选态 **不** 同时打开单块 line-source（避免双真相）。  
- **D-SEL-03**：多选态下展示 **MultiSourceView**（见 §1.4），默认 **只读**；双击某块再进入该块 line-source 并折叠多选。

### 1.3 选择模型（Selection）— 调和 block-per-row

#### 1.3.1 矛盾陈述

| 模型 | 优点 | 缺点 |
|------|------|------|
| **Block-per-row**（现状） | reconcile 便宜；块 chrome（把手/DnD）清晰；与 Notion 块 UX 对齐 | 原生 `contenteditable` 跨行选区语义破碎；无「连续文档选区」API |
| **整页 contenteditable** | 跨行选天然 | 破坏块调度、IME/表/代码单表面难控、与现架构冲突 |

**结论**：**保留 block-per-row 作为 DOM 投影与调度单位**；在其之上建立 **文档坐标选区（Document Selection）**，用自定义高亮层或块级 `aria`/`class` 表达，而不是指望浏览器跨 contenteditable 根的选区。

#### 1.3.2 文档坐标

```
Point = {
  blockId: BlockId
  // 块内偏移：文本块以 UTF-16 / 源码字符串 index（策略 U1 冻结为「源码串 index」）
  offset: number
}

// 规范化：anchor 可在 focus 之后；range 逻辑始终 from ≤ to（文档序）
Range = { anchor: Point, focus: Point }

SelectionModel = {
  ranges: Range[]          // U1 只支持 1 个 range；多 range 后置
  affinity: 'upstream' | 'downstream' | null
  origin: 'pointer' | 'keyboard' | 'api' | 'restore'
}
```

**块序**：`model.getBlocks()` 数组序 = 文档序。  
**跨块 range 语义**：

- `from = min(anchor, focus)`，`to = max(...)`（按块 index + offset）  
- **覆盖块集合** `coveredBlocks = blocks[i0..i1]`  
- 首块：从 `from.offset` 到块末；中间块：整块；尾块：从 0 到 `to.offset`  
- **结构块**（divider / toc / 只读 image 视策略）：U1 默认整块原子选中（offset 忽略或 0..1）

#### 1.3.3 偏移坐标系（U1 冻结）

| 块类型 | offset 空间 | 说明 |
|--------|-------------|------|
| paragraph / heading / list* / quote / callout / task | **line-source 串**（`toSourceLine`）或 **body 串** | U1 推荐：**body 文本 index**（不含 `## ` 前缀），前缀由结构选中策略处理 |
| code / mermaid / math | fence 内 body 或完整 fence 源 | 与 focus-source 一致 |
| table | U1 **整表原子**；格内选区归 TableSelection（U4） |
| divider / file_chip / image | 原子 0\|1 |

**D-SEL-04（推荐）**：U1 文本块 offset = **body plain/MD cache**（`block.text`）index，**不含**结构前缀。整块选中 = 覆盖该 blockId 且 offsets 覆盖 [0, len]。结构前缀删除走 demote API，不靠选区切 `#`。

#### 1.3.4 输入映射

| 用户动作 | Selection 更新 | EditSession |
|----------|----------------|-------------|
| 单击块 body | collapsed at hit | enter line-source |
| Shift+Click 另一块 | 扩展 range 到该块 hit | leave 若跨块 |
| 拖选 | pointermove 更新 focus | 跨块则 leave |
| Shift+↓/↑ | 按块步进扩展 | 同上 |
| Ctrl/Cmd+A | 全文档 range | leave |
| Esc | collapsed 到 focus 块首或保持 | 退出 multi / leave |
| 点击把手 | 整块选中（原子） | leave |

#### 1.3.5 视觉表达（block-per-row 友好）

不依赖单一浏览器 Range 跨根：

1. **块级高亮**：`mdx-block--sel-full | --sel-head | --sel-tail | --sel-mid`  
2. **块内片段**：首尾块用 overlay 或 `::selection` 限制在 surface 内（U1 可用简化：首尾也整块高亮，P1 再精细）  
3. **D-SEL-05（U1 可接受降级）**：跨块时 **整块着色**，块内部分选仅在 **单块 range** 时精确到字符  

验收时诚实标注：U1 出口允许「跨块整块高亮」；字符级跨块精修标 P1。

#### 1.3.6 对 model 的写操作（选区命令）

| 命令 | 语义 |
|------|------|
| `deleteSelection` | 删 covered；合并首尾残片为至多一块；一次 history |
| `copySelection` | 序列化为 MD（+ 可选 HTML） |
| `cutSelection` | copy + delete |
| `applyBlockType` | 对 covered 文本块批量转换（U1 可只做 delete/copy） |
| `getMarkdownSnippet` | AI / 面板上下文 |

### 1.4 行源码分层（Line Source）

#### 1.4.1 三层源码体验

| 层 | 名称 | 触发 | 可编辑 | 模块 |
|----|------|------|--------|------|
| L0 | **Read render** | 默认 idle | 否 | `render/read-view` |
| L1 | **单块 Line Source** | 焦点进入文本/代码块 | 是 | `edit/line-source`、`edit/code-source` |
| L2 | **多行 Multi Source** | 跨块 Selection | U1 默认只读；P1 可编辑 | `edit/multi-source-view` |

#### 1.4.2 L1 不变量（继承 catalog 01）

1. 未聚焦 = 精致渲染。  
2. 聚焦文本 = 结构前缀灰显 + body；**非**整段强制裸 MD 唯一呈现（与 marks 策略 U2 协同）。  
3. 代码 = 单表面完整 fence；禁双壳。  
4. 高度 lock；无厚描边 is-active。  
5. 全局至多一块 L1。

#### 1.4.3 L2 Multi Source（U1 核心交付）

**目的**：用户跨选 2+ 块时，能看到 **连贯 Markdown 源**（Typora 选中预览感），并作为 copy/AI 的真相预览。

```
MultiSourceView = {
  visible: boolean
  blockIds: BlockId[]           // 文档序
  markdown: string              // serialize(slice(doc, range)) 或逐块 toSourceLine 拼接
  mode: 'readonly-panel' | 'readonly-inline'
  placement: 'floating-dock' | 'side-peek' | 'replace-selection-chrome'
}
```

**推荐默认（D-SRC-01）**：

- `readonly-panel`：编辑器底部或选区上方 **轻量 dock**（不挡 caret 主区）  
- 内容 = 对 covered 块调用现有 `serialize` 子集或 `toSourceLine` join `\n\n`  
- **不**把多块合成一个 contenteditable 上帝表面（避免二次 god）  
- 关闭条件：选区 collapsed、Esc、开始单块编辑  

**多行源码拼接规则**：

| 块 | 拼接 |
|----|------|
| 相邻 paragraph | `text` + `\n\n` |
| heading | `toSourceLine` |
| list 连续项 | 单行 `toSourceLine` + `\n`（保持列表粘连） |
| code | 完整 fence |
| table | GFM pipe 序列化 |
| divider | `---` |

#### 1.4.4 与「行内 marks 源可见」（U2）边界

- **U1** 只保证 **块级/多块** 源字符串可见（L2 + 现有 L1 结构前缀）。  
- **U2** 处理 body 内 `**`/`*`/`` ` `` 定界符在焦点下的显示策略（折叠 vs 灰显定界符）。  
- U1 **不**重写 live-marks 算法。

### 1.5 渲染分层（Render Pipeline）

```
Doc (Model)
  │
  ▼
BlockRegistry.resolve(type)
  │
  ├─► paintRead(block)     → DOM 投影（idle/hover）
  ├─► paintLineSource(...) → L1 surface
  ├─► paintFocusSource(...)→ 代码/公式源
  └─► applySelectionChrome(selection) → 选区 class / overlay（无 model 写）
```

| 原则 | 说明 |
|------|------|
| P-Render-1 | 热路径 **禁止** `root.innerHTML = render(all)`；用 `reconcile` 脏块 |
| P-Render-2 | `data-block-id` 稳定；状态切换 morph |
| P-Render-3 | Selection chrome **纯投影**，不进 history |
| P-Render-4 | MultiSourceView 是 chrome，不是第 N 个 block |
| P-Render-5 | viewOnly 共用 read paint |

### 1.6 数据流（读 / 写 / 选）

```
指针/键盘
   │
   ├─► SelectionController.update(...)
   │         │
   │         ├─► 若跨块：EditSession.leave → MultiSourceView.open
   │         └─► 若单块 collapsed：可 EditSession.enter
   │
   ├─► EditSession.input/composition
   │         │
   │         └─► commit → Model.transaction → onChange → reconcile 脏块
   │
   └─► ClipboardController
             └─► pure parse/serialize helpers → Model.transaction
```

### 1.7 AI 端口在架构中的位置

```
UI（slash / command palette / 未来选区动作）
   │ 仅当 ports.enabled
   ▼
ai/ports.normalize(options.ai)
   │ complete(req) → Promise<string> | AsyncIterable<string>
   ▼
Host AI Gateway（包外）
```

| 规则 | 内容 |
|------|------|
| R-AI-1 | 无 `complete` ⇒ UI 隐藏 AI 项；`runAi` → `no-ai-port` |
| R-AI-2 | **禁止** `ai: true` 启用假模型 |
| R-AI-3 | `req.selection` / `documentMd` 来自 **Selection + serialize**，不造假 |
| R-AI-4 | 样本文档由 sample agent 写真实 MD，不进 `ai/ports` |
| R-AI-5 | `packages/conex-mdx` 类型面可继续 `AiPort` 细方法；运行时 reference 以 `complete` 为准，迁移期 **适配归一**（见 U6） |

### 1.8 包与 reference 双轨（过渡架构）

```
[现在]
reference/js/markdown-editor/*   ← 唯一可跑运行时（含 editor.js）
packages/conex-mdx               ← types + stub mount

[U1–U5 过渡]
reference：按模块文件落地 UX（禁止堆 editor.js）
packages/conex-mdx：可先迁纯函数（parse 切片 / selection 纯逻辑）

[U6 / MIGRATION C–E]
运行时权威 → packages/conex-mdx
reference → 薄 demo 消费包
```

---

## 2. 模块地图（目标目录树，每文件职责与行数预算）

### 2.1 原则

- 行数门：默认 ≤400；软顶 500；硬顶 600；controller 硬顶 500。  
- `index` / public re-export ≤120。  
- 新文件优先落 **reference 已拆目录** 镜像名，便于迁包。  
- 目标树同时给出 **reference 过渡路径** 与 **packages/conex-mdx 目标路径**。

### 2.2 packages/conex-mdx 目标树（摘要；细节对齐 ARCHITECTURE.md + catalog 08）

```
packages/conex-mdx/
├── src/
│   ├── index.ts (≤120) · types.ts → types/{doc,selection,editor,ports}.ts
│   ├── schema/ · model/ · parse/ · serialize/     # 各文件软顶 300–450，硬顶见 §2.1
│   ├── inline/ · registry/ · blocks/*            # 每块一文件 ≤400
│   ├── editor/
│   │   ├── create-editor.ts · controller.ts(硬顶500)
│   │   ├── edit-session.ts · selection-model.ts · selection-controller.ts  # ★U1
│   │   ├── keymap.ts · ime.ts · reconcile.ts · dnd.ts · slash.ts
│   ├── render/  read-view · selection-chrome · code-read
│   ├── edit/    enter-exit · line-source · multi-source-view★U1
│   │            · demote · promote · code-source
│   │            · clipboard/{from-plain,from-html,to-md,sanitize}  # ★U3
│   ├── ui/ · motion/ · extensions/ · ai/ports.ts(无模型) · util/ · compat/iife.ts
├── styles/  … + selection.css + multi-source.css  # ★U1
└── tests/   unit · harness · fixtures · property
```

### 2.3 reference 过渡树（U1 立即写入的路径）

在包 bulk 迁完前，**允许**在 reference 落地同名职责文件（IIFE 前缀 `Mdx*`），**禁止**扩 `editor.js` 逻辑体量。

```
reference/chat-composer-component/js/markdown-editor/
├── editor.js                    # 只删减/接线；目标 ≤800 行薄壳（分阶段）
├── selection/
│   ├── model.js                 # Point/Range/规范化/coveredBlocks  ★U1
│   ├── controller.js            # pointer/keyboard                   ★U1
│   └── chrome.js                # class/overlay                      ★U1
├── edit/
│   ├── demotion.js              # 已有
│   ├── height-lock.js           # 已有
│   ├── ime-guard.js             # 已有
│   ├── motion.js                # 已有
│   ├── promote.js               # 已有
│   ├── multi-source-view.js     # ★U1 新建
│   └── clipboard/               # ★U3
│       ├── from-plain.js
│       ├── from-html.js
│       ├── to-md.js
│       └── sanitize.js
├── ui/
│   ├── line-source.js           # 已有；U1 只读依赖 toSourceLine
│   └── …
├── inline/                      # U2
├── table/                       # U4
├── media/                       # U5
├── ai/ports.js                  # 保持薄；无 mock
└── tests/
    ├── u1-selection-harness.js  # ★U1
    └── …
```

### 2.4 每文件职责速查表（关键子集）

| 文件 | 职责 | 预算 | 波次 |
|------|------|------|------|
| `selection/model.js` | 纯：比较点、规范化 range、covered 块、snippet 切片描述 | ≤400 | U1 |
| `selection/controller.js` | 监听 pointer/key，更新 model，通知 chrome/session | ≤450 | U1 |
| `selection/chrome.js` | DOM class / 简化高亮 | ≤300 | U1 |
| `edit/multi-source-view.js` | L2 面板 mount/update/destroy | ≤350 | U1 |
| `edit/enter-exit`（从 editor 抽） | 单块 enter/leave | ≤400 | U1 末/并行 |
| `edit/clipboard/*` | 粘贴管线纯函数 + 入口 | 各 ≤400 | U3 |
| `inline/live-marks.js` | as-you-type | ≤400 | U2 |
| `table/*` | 框选/合并/TSV | 已有+增强 | U4 |
| `media/*` | drop-paste / image | 已有+增强 | U5 |
| `editor.js` / `controller.ts` | 接线 only | →≤500 | 全程 |
| `ai/ports.js` | normalize + consume | ≤250 | 维持 |

### 2.5 所有权 ID（与 ARCHITECTURE.md 对齐并扩展）

| ID | glob（reference 或 package） | U 波主用 |
|----|------------------------------|----------|
| O-Sel | `selection/**`、`src/editor/selection-*.ts`、`render/selection-chrome.ts` | U1 |
| O-Edit | `edit/**`、`src/edit/**` | U1/U2/U3 |
| O-Inline | `inline/**`、`src/inline/**` | U2 |
| O-Clip | `edit/clipboard/**` | U3 |
| O-Table | `table/**`、`ui/table-*.js` | U4 |
| O-Media | `media/**`、`blocks/image*` | U5 |
| O-Editor | `editor.js`、`src/editor/controller.ts` | 串行接线 |
| O-Model | `model.js`、`src/model/**` | 事务 API |
| O-Parse | `parse.js`/`serialize.js` | U3/U6 |
| O-AI | `ai/**`、`src/ai/**` | 政策看守 |
| O-Style | `css/markdown-editor/**`、`styles/**` | 各波样式 |
| O-Test | `tests/**`、`packages/conex-mdx/tests/**` | 各波 |
| O-Pkg | `packages/conex-mdx/**` | U6 |
| O-Host | `apps/**` 适配器 | U6 末 |

**冲突文件**：`editor.js`、`src/types.ts`、`registry` — 每轮 **单一 writer**。

---

## 3. 从 editor.js 拆分迁移顺序

### 3.1 现状快照

| 项 | 值 |
|----|----|
| 路径 | `reference/.../js/markdown-editor/editor.js` |
| 行数 | **~3237**（`createEditor` 闭包内聚万物） |
| 已外提（好消息） | line-source、demotion、promote、ime-guard、height-lock、table/*、blocks/*、ai/*、media/drop-paste、inline/*、ui/* |
| 仍内聚 | activeId 会话、readContentHtml 大分支、enterEdit/exitEdit、commitActiveFromDom、reconcile/fullRender、DnD、大量 keydown、选区工具条/AI/命令面板接线 |

### 3.2 拆分原则

1. **先测后搬**：搬出的模块必须有纯函数单测或 harness 钩子。  
2. **先纯后脏**：无 DOM 的 selection model / clipboard parse 优先。  
3. **接线保留在 editor**：`createEditor` 只 `bind` 与 `dispatch`。  
4. **禁止边搬边加功能**（U 波功能进新文件，不进搬家 PR）。  
5. **行数单调不增**：每个 PR 对 `editor.js` 净删行。  

### 3.3 迁移阶段（与 U 波交织）

```
S0  基线：统计函数清单 + 依赖图（本文 §3.4）
S1  抽出 Selection 纯模型 + chrome（U1）—— editor 只调 API
S2  抽出 MultiSourceView（U1）
S3  抽出 enter/exit/commit 到 edit/enter-exit.js（U1 收尾或 U2 前）
S4  抽出 readContentHtml 分支 → render/read-view + blocks（并行可做）
S5  抽出 keymap 表 → editor/keymap.js
S6  抽出 DnD → editor/dnd.js（已相对独立）
S7  clipboard 管线（U3）从不进 editor 核心
S8  controller 瘦身达标后，原样 TS 迁 packages（U6 / MIGRATION C）
```

### 3.4 editor.js 逻辑域清单（拆分靶心）

| 域 | 约略职责（函数簇） | 目标模块 | 优先级 |
|----|-------------------|----------|--------|
| D1 会话 | `activeId`、`enterEdit`、`exitEdit`、`commitActiveFromDom` | `edit/enter-exit` + `edit-session` | P0 |
| D2 渲染 | `readContentHtml`、`buildBlockEl`、`patchBlock`、`reconcile`、`fullRender` | `render/*` + `reconcile` | P0 |
| D3 选区 | `getSelectionTextInEditor`、未来跨块 | `selection/*` | **U1 P0** |
| D4 表 | `renderTableHtml`、`applyTableMutation`、`handleTableContextAction` | 已有 table + 继续外提 | U4 |
| D5 代码 | `renderCodeReadHtml`、`renderCodeSourceHtml`、`bindCodeCardChrome` | `blocks/code*` + `edit/code-source` | 已部分 |
| D6 键位 | `onEditKeydown`、表 keydown | `keymap` + demotion/promote | P1 |
| D7 DnD | pointer capture 移动块 | `editor/dnd` | P2 |
| D8 插件接线 | slash、selToolbar、cmdPalette、AI | controller 薄接线 | 维持 |
| D9 媒体 | `insertImageBlocks` | media + model tx | U5 |
| D10 公共 API | return handle | `create-editor` / index | U6 |

### 3.5 推荐 PR 切片（每片可评审）

| PR | 净效果 | 验收 |
|----|--------|------|
| PR-S1 | +`selection/model.js`；editor 用其算 snippet | 单测 coveredBlocks |
| PR-S2 | +controller/chrome；跨块 class | harness U1 |
| PR-S3 | +multi-source-view；多选显示 MD | 手工剧本 MS-01 |
| PR-S4 | enter/exit 外提；editor 删 ≥300 行 | 回归 line-source harness |
| PR-S5 | readContentHtml 外提 | 视觉 idle 不回退 |
| PR-S6 | keymap 外提 | 键盘剧本 |
| PR-S7 | editor ≤1200 行 | 行数门 |
| PR-S8 | editor ≤800 或迁 controller.ts | U6 |

### 3.6 迁包映射（与 MIGRATION.md 一致）

| reference | packages/conex-mdx |
|-----------|-------------------|
| `selection/*.js` | `src/editor/selection-*.ts` + `src/types/selection.ts` |
| `edit/multi-source-view.js` | `src/edit/multi-source-view.ts` |
| `edit/clipboard/*` | `src/edit/clipboard/*` |
| `edit/enter-exit.js` | `src/edit/enter-exit.ts` |
| `editor.js` 残壳 | `src/editor/controller.ts` + `create-editor.ts` |
| `ai/ports.js` | `src/ai/ports.ts`（仍无模型） |

### 3.7 反模式（拆分期）

| 禁止 | 原因 |
|------|------|
| 把 3237 行复制成 `editor.ts` | 转移 god file |
| 在搬家 PR 实现 U4 表合并 | 冲突面爆炸 |
| selection 写 `block.text` | 绕过 transaction |
| multi-source 可编辑且不经 model | 双真相 |
| 为演示在 ports 返回「【摘要】」 | 违 AI-HOST-POLICY |

---

## 4. UX 补齐实施波次 U1–U6

> 每波：**入口条件** / **范围** / **非范围** / **模块** / **出口验收** / **回滚点**  
> 调度原则：U1 未出口，不启动 U3+ 大功能（U2 可与 U1 尾重叠若文件不冲突）。

### 4.0 波次总览

| 波次 | 主题 | 用户可感知价值 | 依赖 |
|------|------|----------------|------|
| **U1** | 跨块多选 + 多行源码显示 | 像正常编辑器一样选/删/拷多段 | 现有 model/serialize/line-source |
| **U2** | 行内源 / marks UX | 焦点下格式直觉；`**` 策略一致 | U1 选区（单块精确）；catalog 01/04 |
| **U3** | 粘贴 / 剪贴板 / 撤销粒度 | 从外部贴入不碎 | U1 snippet；parse |
| **U4** | 表专业残差 | 框选/合并/TSV/对齐可靠 | table/* 已有骨架 |
| **U5** | 媒体与结构残差 | 图/附件/TOC/wiki 主路径不尬 | media ports |
| **U6** | 工程化与迁包 | 无 god、可测、可进 Desktop | U1–U3 API 稳定 |

```
U1 选区+多行源 ──┬─► U2 行内源/marks
                 ├─► U3 剪贴板
                 └─► U4 表（可与 U3 并行，文件隔离）
                          │
                          ▼
                       U5 媒体
                          │
                          ▼
                       U6 工程/包（纯函数可提前迁）
```

---

### 4.1 U1 — 跨块多选 + 多行源码显示（**首波，推荐立即启动**）

#### 4.1.1 入口条件

| # | 条件 |
|---|------|
| E1 | model 可 `getBlocks` / `update` / history |
| E2 | `serialize` / `toSourceLine` 可用 |
| E3 | 单块 line-source 主路径可点可编（允许 partial） |
| E4 | 本计划与 AI-HOST-POLICY 已读 |
| E5 | `editor.js` 冻结「只减不增」纪律获调度确认 |

#### 4.1.2 范围（In）

1. `SelectionModel` 单 range；文档序 covered 块。  
2. 指针拖选 / Shift+Click / Shift+方向（块级步进最低配）。  
3. 选区 chrome（整块级高亮可接受）。  
4. `Delete`/`Backspace` 删除多块选区（一次 undo）。  
5. `Copy` → `text/plain` MD snippet（HTML 可选 P1）。  
6. `MultiSourceView` 只读展示多行源。  
7. 与 EditSession 协同：跨块时 leave。  
8. harness + 纯函数测试。  
9. CSS：`selection.css` / multi-source 样式。  

#### 4.1.3 非范围（Out）

- 字符级跨块精确高亮  
- 多 range（不连续选区）  
- 表内单元格框选增强（归 U4）  
- 行内 marks 定界符策略（U2）  
- 结构化 paste（U3）  
- AI 动作扩容  
- 默认 selection-toolbar  
- 迁包 bulk  

#### 4.1.4 模块与文件所有权

| Agent 槽位 | 所有权 | 写入 |
|------------|--------|------|
| U1-A | O-Sel model | `selection/model.js`（+ 单测） |
| U1-B | O-Sel controller | `selection/controller.js` |
| U1-C | O-Sel chrome + O-Style | `selection/chrome.js` + CSS |
| U1-D | O-Edit multi-source | `edit/multi-source-view.js` + CSS |
| U1-E | O-Editor 接线 | `editor.js` **仅** import/bind/删冲突旧逻辑 |
| U1-F | O-Test | `tests/u1-selection-harness.js` |
| U1-G | O-Model 只读+必要 API | 若缺 `removeBlocks(ids)` 则最小扩展 `model.js` |
| U1-H | Review | 对照本节出口；不写业务 |

> 并行上限 8；**U1-E 与任何人改 editor.js 串行**。

#### 4.1.5 算法要点（规格）

**规范化**

```
compare(p1,p2):
  i1 = index(p1.blockId); i2 = index(p2.blockId)
  if i1 != i2 return i1 - i2
  return p1.offset - p2.offset

normalize(range):
  if compare(anchor,focus) <= 0 return {from:anchor,to:focus,…}
  else return {from:focus,to:anchor,…}
```

**删除**

```
deleteSelection(range):
  blocks = covered(range)
  if blocks empty return
  head = sliceBefore(first, from.offset)
  tail = sliceAfter(last, to.offset)
  // 中间块整删
  // 合并 head+tail 文本策略：同类型可拼；否则两段
  one history entry
```

**Copy MD**

```
markdown = joinSource(covered, range)
// 优先 serialize 子文档；fallback toSourceLine
clipboard.writeText(markdown)
```

#### 4.1.6 出口验收（全部勾选才算 U1 Done）

| ID | 验收项 |
|----|--------|
| U1-X1 | 拖选跨 ≥3 段落：三块出现选中样式 |
| U1-X2 | Shift+Click 扩展/收缩符合文档序 |
| U1-X3 | Delete 后三块消失（或合并为残片）；一次 Ctrl+Z 恢复 |
| U1-X4 | Copy 后粘贴到外部文本编辑器为合理 MD（标题/列表可辨） |
| U1-X5 | 多选时 MultiSourceView 显示与 copy 一致的多行源 |
| U1-X6 | Esc 或单击外部：取消多选并关闭 MultiSourceView |
| U1-X7 | 多选态下不出现第二块 line-source |
| U1-X8 | IME 组字中不启动破坏性跨块删除（或组字结束再应用） |
| U1-X9 | viewOnly 下不可多选删除 |
| U1-X10 | `editor.js` 本波净行数 ≤0（新增逻辑在新文件） |
| U1-X11 | harness 自动项 ≥5 条绿 |
| U1-X12 | 无 AI mock；无运行时假数据 |

#### 4.1.7 回滚点

- 特性旗标 `features.multiSelect !== false` 默认 true；出问题可 `false` 回到仅单块。  
- MultiSourceView 可独立关 `features.multiSourceView`。

---

### 4.2 U2 — 行内源码与 Marks UX

#### 4.2.1 入口条件

| # | 条件 |
|---|------|
| E1 | U1 出口（至少 U1-X1/X6/X7）或调度书面豁免 |
| E2 | `inline/live-marks.js`、`marks-model.js` 可读 |
| E3 | 明确 D-MARK 决策（见 08-decision-log；缺省用下表推荐） |

#### 4.2.2 推荐决策（可被 08 覆盖）

| ID | 推荐 |
|----|------|
| D-MARK-01 | 焦点 body：**渲染 marks**；定界符默认折叠；可选「显示源标记」修饰键 |
| D-MARK-02 | 禁止回到 `innerText = raw MD` 作为默认 |
| D-MARK-03 | 选区工具条保持 **默认关闭** |
| D-MARK-04 | Ctrl+B/I 走 marks-model，不依赖 execCommand 长期 |

#### 4.2.3 范围

- 焦点下 bold/italic/strike/code/link 视觉与源一致性  
- as-you-type 闭合折叠（IME 跳过）  
- 单块选区 toggle mark  
- 与 line-source 结构前缀共存（前缀灰、body marks）  
- 文档化边界用例  

#### 4.2.4 非范围

- 协同 OT  
- 自定义 mark 插件市场  
- 跨块 toggle mark（可 P1：对每块 body 全选应用）  

#### 4.2.5 出口验收

| ID | 验收项 |
|----|--------|
| U2-X1 | 含 `**x**` 的段点击后 x 为粗体，不是字面星号（默认策略） |
| U2-X2 | 键入 `**ab**` 后 ab 粗体，serialize 保留标记 |
| U2-X3 | 中文 IME 组字不折叠、不丢字 |
| U2-X4 | Ctrl+B 切换选区粗体 |
| U2-X5 | 无默认 mdx-sel-bar |
| U2-X6 | 结构前缀 `##` 仍符合 line-source 灰显契约 |
| U2-X7 | 新逻辑不进 editor.js 堆叠 |

---

### 4.3 U3 — 粘贴、剪贴板、撤销粒度

#### 4.3.1 入口条件

- U1 copy snippet 可用  
- parse/serialize 主路径稳定  
- sanitize 方案选定（简易白名单即可）  

#### 4.3.2 范围

| 能力 | 说明 |
|------|------|
| 复制 | plain=MD；html=语义（P0 plain，P1 html） |
| 粘贴 plain | 断行→块启发式 |
| 粘贴 MD | 标题/列表/代码/表识别 |
| 粘贴 HTML | 清洗 + 转 blocks/runs |
| 代码块内粘贴 | 字面插入 |
| 大文本 | 100KB 策略（截断或分片） |
| Undo | 整次粘贴一步 |

模块：`edit/clipboard/*`（纯函数优先）。

#### 4.3.3 非范围

- Word 样式 100% 保真  
- 图片二进制粘贴完整上传（依赖宿主 `uploadImage`，无端口则占位块）  

#### 4.3.4 出口验收

| ID | 验收项 |
|----|--------|
| U3-X1 | 粘贴 `## Hello` → heading 块 |
| U3-X2 | 粘贴 `* a\n* b` → 列表项 |
| U3-X3 | 粘贴 HTML `<strong>` → bold mark |
| U3-X4 | 危险 HTML 无 script 执行 |
| U3-X5 | 代码 focus-source 内粘贴保持字面 |
| U3-X6 | 一次 undo 撤整贴 |
| U3-X7 | 无「浏览器默认+自处理」双份插入 |
| U3-X8 | fixtures ≥10 往返/粘贴用例绿 |

---

### 4.4 U4 — 表格式表面残差

#### 4.4.1 入口条件

- `table/selection.js`、`merge.js`、`clipboard-tsv.js`、`ui/table-chrome.js` 存在  
- 与 U1 块级选区：**表原子** 策略已实现（点表 = 整表或进表内模式）  

#### 4.4.2 范围

- 框选稳定 + Shift 扩展  
- 合并/拆分与 undo  
- TSV 复制粘贴  
- align 序列化不丢  
- 右键菜单分面板可用  
- 与块级 Selection 互斥（进表内则 clear 跨块 range）  

#### 4.4.3 非范围

- Excel 全公式  
- 数据透视  

#### 4.4.4 出口验收

| ID | 验收项 |
|----|--------|
| U4-X1 | 框选 2×2 合并；JSON 保 rowspan/colspan |
| U4-X2 | 拆分恢复 |
| U4-X3 | TSV 往返 |
| U4-X4 | align 导出 GFM 正确 |
| U4-X5 | w3-table-harness 扩展绿 |
| U4-X6 | 不破坏 U1 跨段选 |

---

### 4.5 U5 — 媒体与结构残差

#### 4.5.1 入口条件

- `blocks/image.js`、`media/drop-paste.js`、TOC/wiki 部分路径  
- 宿主端口契约：`uploadImage` / `onOpenPath` / `onOpenDoc`  

#### 4.5.2 范围

- 图片：读态渲染、失败占位、edit 源/`![]()`  
- 拖放文件 → 有端口上传 / 无端口本地占位策略文档化  
- file_chip 打开路径  
- wiki-link 点击  
- TOC 跳转  
- callout 与 quote 行源一致  

#### 4.5.3 非范围

- 视频转码  
- 图床实现  
- Database  

#### 4.5.4 出口验收

| ID | 验收项 |
|----|--------|
| U5-X1 | 样例 MD 含图可渲染或明确占位 |
| U5-X2 | 无 upload 端口时不假装上传成功 |
| U5-X3 | TOC 点击滚到标题 |
| U5-X4 | wiki/file 回调触发 |
| U5-X5 | 不引入 mock AI |

---

### 4.6 U6 — 工程化、拆包、Desktop 预备

#### 4.6.1 入口条件

- U1–U3 主 API 行为稳定（选区/粘贴/会话）  
- `packages/conex-mdx` 脚手架在  
- 行数门与所有权再确认  

#### 4.6.2 范围

| 项 | 说明 |
|----|------|
| 阶段 B | schema/model/parse/serialize/inline 迁 TS |
| 阶段 C | controller 拆分迁入；styles 迁 |
| 双轨缩短 | reference 改消费或薄 re-export |
| 测试 | vitest unit + harness 迁包 |
| AI 类型归一 | `complete` 与 `AiPort` 适配层 |
| CI | typecheck 包；行数检查脚本（可选） |

#### 4.6.3 非范围

- 完整 React 包装库  
- 协同后端  
- 插件商店  

#### 4.6.4 出口验收

| ID | 验收项 |
|----|--------|
| U6-X1 | `import { mount } from '@conex/mdx'` 可编辑段落（非 stub）或书面阶段出口 |
| U6-X2 | 无新 god file；controller ≤500 |
| U6-X3 | 公共 exports 冻结表 |
| U6-X4 | AI 仍无 mock |
| U6-X5 | Desktop 适配器清单可执行（薄） |
| U6-X6 | MIGRATION 检查表 B/C 主项勾选 |

---

### 4.7 波次优先级与砍刀

若资源不足：

| 保留 | 可砍/延后 |
|------|-----------|
| U1 全出口 | U1 字符级高亮 |
| U2 默认 marks 渲染 + IME | 修饰键显示定界符 |
| U3 plain+MD 粘贴 | HTML 高保真 |
| U4 合并+TSV | 列宽拖拽 |
| U5 图+TOC | 音视频 |
| U6 纯函数迁包 | IIFE 兼容花活 |

---

## 5. 依赖图

### 5.1 波次依赖

```
                    ┌──────────────┐
                    │ 现有 W1–W10  │
                    │ 骨架运行时   │
                    └──────┬───────┘
                           │
                           ▼
                    ┌──────────────┐
                    │     U1       │
                    │ 选区+多行源  │
                    └──────┬───────┘
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         ┌────────┐  ┌────────┐  ┌────────┐
         │   U2   │  │   U3   │  │   U4   │
         │ 行内源 │  │ 剪贴板 │  │  表    │
         └───┬────┘  └───┬────┘  └───┬────┘
             │           │           │
             └───────────┼───────────┘
                         ▼
                   ┌──────────┐
                   │    U5    │
                   │  媒体    │
                   └────┬─────┘
                        ▼
                   ┌──────────┐
                   │    U6    │
                   │ 工程/包  │
                   └──────────┘
```

说明：U4 与 U3 **文件隔离**时可并行；二者都依赖 U1 的「选区互斥」约定。

### 5.2 模块依赖（目标态）

```
types.selection ← selection-model ← selection-controller ← controller
types.doc ← model ← transaction
line-source ← multi-source-view（只读 toSourceLine/serialize）
clipboard ← parse/serialize + sanitize
inline ← marks-model ← dom-bridge
table-selection ← table-chrome ← controller（互斥 selection）
ai/ports ← controller（可选）
render/selection-chrome ← selection-model（只读）
```

### 5.3 禁止依赖边

```
multi-source-view ──✗──► model 内部字段直写
clipboard ──✗──► ui/slash
parse ──✗──► editor/controller
blocks ──✗──► ai/ports
ai/ports ──✗──► 任何「生成假文案」模块
host ──✗──► src/editor/ime 深路径
```

### 5.4 与 AI-HOST-POLICY 依赖

```
任何 UI AI 入口 ──requires──► ports.enabled === true
ports.enabled ──requires──► typeof complete === 'function'
complete ──implemented by──► Host only
samples/*.md ──authored by──► sample agent（非 runtime）
```

### 5.5 数据依赖（选区 snippet）

```
SelectionModel
    → coveredBlocks
        → serialize / toSourceLine
            → clipboard copy
            → MultiSourceView.markdown
            → AiContext.markdownSnippet（若有端口）
```

---

## 6. Agent 拆分表（每波 ≤12，文件所有权不冲突）

### 6.1 通用规则

1. 一轮 ≤12 Agent。  
2. 同文件 **串行**；`editor.js` 永远单 writer。  
3. Review Agent 只读+写报告，不改生产路径。  
4. 发现任务书未覆盖问题 → 上报调度，不擅自扩 scope。  
5. 中文注释；提交 `feat(mdx-u1): …` 风格。  

### 6.2 U1 Agent 表（推荐 8）

| ID | 角色 | 写入路径 | 只读依赖 | 交付 |
|----|------|----------|----------|------|
| U1-A | Selection 纯模型 | `js/.../selection/model.js`、unit 测试 | model 块序、types | compare/normalize/covered/snippet 描述 |
| U1-B | Selection 控制器 | `selection/controller.js` | model.js、EditSession API | pointer/key 绑定说明 |
| U1-C | Chrome + CSS | `selection/chrome.js`、`css/.../selection.css` | model 订阅 | 整块高亮 class |
| U1-D | MultiSourceView | `edit/multi-source-view.js`、CSS | line-source、serialize | dock UI |
| U1-E | Editor 接线 | `editor.js`（仅接线） | A–D 公共 API | 删除内联临时选区逻辑 |
| U1-F | Model 最小 API | `model.js` 若需要 | — | `removeBlockRange` 或等价 |
| U1-G | Harness | `tests/u1-*.js` | 全部 | 自动验收 |
| U1-H | Review | `ux-readiness` 报告段 | 全部 | 打分 / 打回 |

**冲突矩阵**：A∥B∥C∥D∥F∥G 可并行；**E 等 A+B+D API 冻结后**；H 最后。

### 6.3 U2 Agent 表（≤7）

| ID | 角色 | 写入 |
|----|------|------|
| U2-A | marks-model / toggle | `inline/*` |
| U2-B | live-marks + IME 门 | `inline/live-marks.js`、ime-guard 协作 |
| U2-C | enter 路径 body 填充 | `edit/enter-exit` 或 line-source |
| U2-D | CSS marks | styles |
| U2-E | Keymap Ctrl+B/I | keymap 模块 |
| U2-F | Test | harness |
| U2-G | Review | 报告 |

禁止与 U1-E 同时改 `editor.js`。

### 6.4 U3 Agent 表（≤8）

| ID | 角色 | 写入 |
|----|------|------|
| U3-A | from-plain | `edit/clipboard/from-plain.js` |
| U3-B | from-html + sanitize | `from-html.js` `sanitize.js` |
| U3-C | to-md copy | `to-md.js` |
| U3-D | paste 入口接线 | 薄模块 + editor 单 writer |
| U3-E | fixtures | `tests/fixtures/paste/*` |
| U3-F | 代码块字面粘贴 | blocks/code-edit 协作 |
| U3-G | Test harness | |
| U3-H | Review | |

### 6.5 U4 Agent 表（≤6）

| ID | 写入 |
|----|------|
| U4-A | `table/selection.js` 增强 |
| U4-B | `table/merge.js` + schema |
| U4-C | TSV clipboard |
| U4-D | table-chrome / context-menu |
| U4-E | serialize align |
| U4-F | harness + review |

与 U3 并行时：**禁止** U3-D 与 U4 同时碰 editor.js → 合并窗口由调度排。

### 6.6 U5 Agent 表（≤6）

| ID | 写入 |
|----|------|
| U5-A | image read/edit |
| U5-B | drop-paste + upload 端口 |
| U5-C | toc / wiki / file_chip |
| U5-D | callout 行源一致性 |
| U5-E | CSS |
| U5-F | test + review |

### 6.7 U6 Agent 表（≤10）

| ID | 角色 | 写入 |
|----|------|------|
| U6-A | 迁 schema/model | `packages/conex-mdx/src/schema|model` |
| U6-B | 迁 parse/serialize | `src/parse|serialize` |
| U6-C | 迁 selection 纯逻辑 | `src/editor/selection-model.ts` |
| U6-D | 迁 clipboard 纯函数 | `src/edit/clipboard` |
| U6-E | controller + mount | `src/editor/*` `index.ts` |
| U6-F | styles | `styles/**` |
| U6-G | compat iife | `src/compat` |
| U6-H | vitest 迁移 | `tests/**` |
| U6-I | AI ports 类型归一 | `src/ai` + types |
| U6-J | Review + MIGRATION 勾选 | docs |

**U6-E 单写 controller**；A–D 先合。

### 6.8 调度口令模板

```
派单 U1：
  输入：05-architecture §4.1、§1.2–1.4、AI-HOST-POLICY
  产出：selection/*、multi-source-view、u1 harness、editor 接线净删
  验收：U1-X1…X12
  冲突：editor.js 仅 U1-E
  禁止：mock AI、扩 scope 到 U3 粘贴
```

---

## 7. 测试策略（纯函数 / DOM harness / 手工剧本）

### 7.1 三层金字塔

```
        ╱╲
       ╱手╲          手工剧本（IME/跨浏览器/观感）
      ╱工戏╲
     ╱──────╲
    ╱ DOM    ╲       harness（jsdom 或真实浏览器脚本）
   ╱ harness  ╲
  ╱────────────╲
 ╱  纯函数 unit  ╲   selection/clipboard/parse 无 DOM
╱────────────────╲
```

| 层 | 工具 | 占比目标 | 强制 |
|----|------|----------|------|
| 纯函数 | node / vitest | 50%+ 新逻辑 | U1 model、U3 clipboard |
| Harness | 现有 w* + u* 脚本 | 30% | 每波出口 |
| 手工 | 清单勾选 | 20% | IME、拖选手感 |

### 7.2 纯函数用例清单（U1 最低）

| 用例 ID | 输入 | 期望 |
|---------|------|------|
| PF-SEL-01 | anchor 块2 offset0，focus 块0 offset3 | normalize 后 from 在前 |
| PF-SEL-02 | 三块全文 range | covered 长度 3 |
| PF-SEL-03 | 单块 mid-range | covered 1；snippet 为子串 |
| PF-SEL-04 | 空文档 | range 安全 |
| PF-SEL-05 | 含 divider 原子 | covered 含 divider id |
| PF-SNP-01 | heading+para | snippet 含 `#` 与空行策略 |
| PF-SNP-02 | 两 list item | 粘连 `\n` 非 `\n\n` 过度空行（按规则表） |
| PF-DEL-01 | 删中间块 | 首尾保留 |
| PF-DEL-02 | 删头偏 offset | head 残片正确 |

### 7.3 DOM Harness（U1）

文件建议：`js/markdown-editor/tests/u1-selection-harness.js`

| 用例 | 步骤 | 断言 |
|------|------|------|
| H-U1-01 | mount 三段 → 模拟 range | class `--sel-*` 数量 |
| H-U1-02 | deleteSelection | blocks.length |
| H-U1-03 | copy 拦截 | 写出 MD 字符串匹配 |
| H-U1-04 | multi-source visible | dock 文本 |
| H-U1-05 | 进入多选后再 click 单块 | session line-source；dock 关 |
| H-U1-06 | viewOnly | 删除被拒 |

沿用模式：参考 `w1-line-source-harness.js` 的断言风格。

### 7.4 手工剧本（关键）

#### 剧本 MS-01 跨段编辑日

1. 打开含 1 标题 + 5 段 + 1 列表 + 1 代码的样例（真实 MD，非 mock）。  
2. 拖选第 2–4 段 → 观察高亮与 MultiSourceView。  
3. Ctrl+C → 外部记事本粘贴 → 人读 MD 可接受。  
4. Delete → 文档变短 → Ctrl+Z → 恢复。  
5. 单击第 1 段 → 进入 line-source；多选 chrome 消失。  
6. 中文输入「你好」组字中不要点选其他块（或验证不崩溃）。  

#### 剧本 MS-02 IME

1. 中文输入法组字半成品时 Shift+↓。  
2. 期望：不提交乱码；不删半字；可结束组字后再生效。  

#### 剧本 MS-03 无 AI 回归

1. 不注入 `ai.complete`。  
2. slash/面板无 AI 项。  
3. 不出现「【Mock」类字符串。  

#### 剧本 MS-04 粘贴（U3）

1. 从 GitHub 复制 README 片段粘贴。  
2. 从浏览器复制加粗句粘贴。  
3. 代码块内粘贴 HTML 源码字面。  

#### 剧本 MS-05 表（U4）

1. 框选合并 → undo → redo。  
2. TSV 往返 Excel。  

### 7.5 回归门禁（每波合并前）

| 门禁 | 命令/动作 | 适用 |
|------|-----------|------|
| 旧 harness | w1/w2/w3/w5/w7 | 每波 |
| 新 harness | u* | 该波 |
| 行数 | `editor.js` 不增 | 每波 |
| AI 政策 | grep mock 摘要串 | 每波 |
| 类型（U6） | `tsc -p packages/conex-mdx` | U6 |

### 7.6 禁止的测试债务

- 用 mock AI 断言「有输出就算过」。  
- 只测 happy path 单段。  
- harness 依赖全页 innerHTML 快照且不可读。  
- 测试里复制一套 parse 实现。  

---

## 8. 风险登记册

| ID | 风险 | 可能性 | 影响 | 缓解 | 残留 |
|----|------|--------|------|------|------|
| R1 | 浏览器跨 contenteditable 选区不可靠 | 高 | 高 | 自建 SelectionModel + 整块高亮降级 | 字符级跨块延后 |
| R2 | editor.js 接线冲突 | 高 | 高 | 单 writer；功能进新文件 | 进度串行 |
| R3 | leave/commit 与多选竞态丢字 | 中 | 高 | 先 commit 再改 selection；IME 门闩 | 需 harness |
| R4 | MultiSource 与 serialize 空行不一致 | 中 | 中 | 单一 join 实现；copy 复用 | 列表粘连调参 |
| R5 | 删除多块破坏 list 编号/indent | 中 | 中 | 删除后 normalizeList 可选；U1 简化 | 编号漂移 |
| R6 | 表内选区与块选区双系统打架 | 中 | 高 | 互斥模式机；进表 clear 块选 | U4 重点测 |
| R7 | 双轨 reference/package 漂移 | 高 | 高 | U6 前新逻辑模块化；禁止扩 god | dual 期纪律 |
| R8 | 粘贴 XSS | 中 | 高 | sanitize 白名单；禁 script/on* | 持续审计 |
| R9 | 大文档拖选卡顿 | 中 | 中 | covered 计算 O(n)；n 大时 rAF 节流 chrome | 虚拟列表后置 |
| R10 | 有人再次加 mock AI | 中 | 高 | AI-HOST-POLICY + grep CI + code review | 政策 |
| R11 | height-lock 与多选 chrome 布局抖 | 中 | 中 | MultiSource dock 不改块高 | 动效 U 外 |
| R12 | undo 粒度过碎/过大 | 中 | 中 | 多块删/整贴 一事务 | 输入 debounce 另策 |
| R13 | Desktop 过早依赖 stub mount | 中 | 高 | README 警告；U6 前用 reference | 集成文档 |
| R14 | 行源 L1/L2 用户困惑 | 中 | 中 | L2 只读 + 文案「选区源码」；Esc 退出 | 可用研 |
| R15 | Agent 超 12 或抢文件 | 中 | 中 | 本表硬顶；调度合并 | — |
| R16 | focus ring 政策回潮厚描边 | 低 | 中 | CSS review；禁 is-active 厚边 | — |
| R17 | 迁 TS 时行为微差 | 中 | 高 | fixtures 黄金 MD；先纯函数 | — |
| R18 | complete 与 AiPort 多形状 | 中 | 中 | U6 适配层 normalize | 类型文档 |

### 8.1 风险触发升级

- R1/R3 导致丢字 → **停 U2+**，只修会话。  
- R10 发现 mock → **立即回滚** 该 PR。  
- R7 出现双实现修同一 bug → 调度强制单路径。  

---

## 9. 明确非目标

| 非目标 | 说明 |
|--------|------|
| N1 整页单一 contenteditable 重写 | 推翻 block-per-row，成本不可接受 |
| N2 Notion Database / CRM / 看板 | 产品定位外 |
| N3 编辑器内置 LLM / mock complete | 违 AI-HOST-POLICY |
| N4 默认挂载选区格式条 | catalog 冻结默认关 |
| N5 代码块双壳（高亮+textarea 并列可见） | 永久禁止 |
| N6 激活行厚描边/强底色 | 视觉政策 |
| N7 协同 OT/CRDT / 多人光标 | 后置 |
| N8 插件市场 / 第三方扩展商店 | 后置 |
| N9 本计划内实现 Desktop 全量集成 UI | 仅 U6 清单与薄适配 |
| N10 本计划内写应用业务代码 | **本文只出规格** |
| N11 把 3237 行整体复制进 package | 违 no-god-file |
| N12 视频转码、图床后端、权限系统 | 宿主职责 |
| N13 100% Word 粘贴保真 | U3 只做「可用+安全」 |
| N14 不连续多 range 选区 | U1 后 |
| N15 虚拟滚动大文档 | 性能后置；先正确 |
| N16 以 demo HTML 内联业务顶替模块 | 宪章禁止 |
| N17 运行时依赖假样例生成器 | 样本外置真实 MD |
| N18 在 U1 同时做表合并+粘贴+迁包 | 波次混乱 |

---

## 10. U1 实施附录（状态机 / API / CSS / 派单）

### 10.1 状态机（Selection × EditSession）

```
[idle, collapsed] ──click──► [line-source, collapsed]
                                    │ drag/Shift 跨块
                                    ▼
                            leave+commit → [idle, multi-range]
                                    │ Delete / Copy / MultiSource
                                    ▼
                            [idle, collapsed] ；Esc 同归
```

### 10.2 模块 API 草约（非 npm public）

| 模块 | 方法 |
|------|------|
| SelectionModel | `get/set/clear/extendTo` · `coveredBlockIds` · `isMultiBlock` · `toMarkdownSnippet` |
| SelectionController | `attach/detach` |
| SelectionChrome | `sync(snapshot)` |
| MultiSourceView | `open/update/close` |
| EditSession | `enter/leave` · `isComposing` |

Public Handle 可选后置：`getSelectionMarkdown()`。  
多块 copy/AI 上下文走 **Model snippet**；浏览器 `getSelection` 仅单块 fallback。

### 10.3 CSS 类 / History / a11y / 性能

| 类名 | 含义 |
|------|------|
| `mdx-block--sel-full` | 整块在选区中 |
| `mdx-editor--has-multi-sel` | 根标记 |
| `mdx-multi-source` / `__pre` | dock 与预格式源码 |

- History：多块删/cut = **1** 条；选区扩展与 dock 开关 = 0。  
- a11y：dock `role="region"` `aria-label="选区 Markdown 源码"`；可选节流 `aria-live`。  
- 性能：covered O(跨度)；chrome `rAF`；snippet 宜 pointerup 或 debounce 50–100ms。  
- **禁止**用厚 `is-active` 描边表达选区。

### 10.4 决策默认（待 08-decision-log 确认）

| ID | 默认 |
|----|------|
| D-SEL-01 | 跨块多选时 leave 单块编辑 |
| D-SEL-05 | U1 跨块整块高亮（字符级 P1） |
| D-SRC-01 | MultiSource **只读** dock |
| D-CLIP-01 | copy 先 plain MD |
| D-AI-01 | 严格 `complete`；`AiPort` 适配映射 |
| D-FLAG-01 | `multiSelect` 默认开 |

### 10.5 里程碑量级（非承诺）

U1: 5–10 人日 · U2: 4–8 · U3: 5–10 · U4: 4–8 · U5: 3–6 · U6 mount 可用: 10–20。U3∥U4 可在 U1 后叠。

### 10.6 索引与调度检查

| 资源 | 路径 |
|------|------|
| 本文件 | `ux-readiness/05-architecture-and-implementation-plan.md` |
| AI 政策 | `feature-catalog/AI-HOST-POLICY.md` |
| 行源 / 包 | `feature-catalog/01-*.md` · `08-package-modules.md` |
| 宪章 / 包 | `v3-complete/11-no-god-file-charter.md` · `packages/conex-mdx/*` |
| 运行时 | `js/markdown-editor/editor.js`（~3237）· `ui/line-source.js` · `ai/ports.js` |

开 U1 前：[ ] 确认 D-SEL/D-SRC 默认 [ ] 指定 editor 唯一 writer [ ] 真实样例 MD [ ] 冻结 Out [ ] 无 mock / 不堆 god file。

### 10.7 结语

把 **选区** 提升为与块焦点平级的真相；用 **MultiSource** 补 block-per-row 跨行源缺口；**拆 god file**；**AI 仅宿主端口**。  
**立即执行 U1**（multi-block selection + multi-line source display）。U1 未出口不做粘贴大管线 / 表深改 / bulk 迁包。

---

## 附录 A — editor.js 域 → 目标

| 现状 | 目标 |
|------|------|
| `activeId` / enter·exit / commit | EditSession + `edit/enter-exit` |
| `readContentHtml` / reconcile | `render/*` + `reconcile` |
| `getSelectionTextInEditor` | SelectionModel snippet |
| keydown 巨石 / DnD | `keymap` · `editor/dnd` |
| table / AI·palette 尾部 | table/* · controller 薄接线 |

## 附录 B — U1 任务卡（派单）

| 卡 | 目标 | 验收 | 纪律 |
|----|------|------|------|
| U1-A | 无 DOM 选区模型 | PF-SEL-01…05 | 不改 editor.js |
| U1-B | 指针/键盘控制器 | 拖选·Shift+Click | 依赖 A |
| U1-C | chrome + CSS | U1-X1 | 无厚描边 |
| U1-D | MultiSource 只读 | U1-X5 | 依赖 snippet |
| U1-E | editor 接线·删·拷 | U1-X3/4/7/10 | **净删** editor 行 |
| U1-F | model 多块事务 | 一次 undo | 最小 API |
| U1-G | harness | H-U1-01…06 | — |
| U1-H | Review | U1-X1…X12 | 只读+报告 |

## 附录 C — 术语 / 失败 / 开放问题

| 术语 | 含义 |
|------|------|
| block-per-row | 每块一行 DOM 投影 |
| EditSession / SelectionModel | 单块编辑会话 / 文档坐标选区 |
| L1 / L2 | 单块行源 / 多块 MultiSource |
| covered / reconcile / ports / harness | 覆盖块 / 脏块补丁 / 宿主插槽 / 半自动验收 |

| 现象 | 先查 |
|------|------|
| 拖选无高亮 | chrome 订阅 |
| undo 不回 | history 事务 |
| 双 line-source | D-SEL-01 leave |
| copy 空 | 应用 Model snippet |
| Mock 文案 | 违政策 → 回滚 |

| Q | U1 默认 |
|---|--------|
| 字符级跨块高亮 | 不做（P1） |
| MultiSource 可编辑 | 否 |
| offset 空间 | `block.text` |
| complete vs AiPort | 适配并存（U6） |

W* 骨架（done/verify）≠ 好用；U 波补 UX，不回退双壳/mock AI。安全：粘贴去 script/on*；无密钥进包。

---

| 日期 | 变更 |
|------|------|
| 2026-08-03 | 初版：架构、模块地图、editor 拆分、U1–U6、依赖、Agent、测试、风险、非目标；**U1=跨块多选+多行源** |

**文档结束。** 调度按附录 B 派 U1-A…H；实现禁止扩大 `editor.js`、禁止 mock AI。
