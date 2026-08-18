# 02 — 代码 / Diff / Mermaid / 公式 / 图解 — 功能金标准分册

> **分册角色**：`feature-catalog/02-code-math-diagram.md`  
> **权威级别**：本目录为功能与「做到最好」的新权威；冲突时覆盖 `../v3-complete/*` 与旧 `blocks/code.md` 中的交互描述。  
> **日期**：2026-08-02  
> **编码**：UTF-8  
> **读者**：产品验收、实现 agent（W2 代码单表面 / W7 Mermaid+公式）、Review agent  
> **关联**：  
> - [README.md](./README.md) F-CODE-* / F-MMD / F-MATH / F-CORE-06  
> - [00-master-index.md](./00-master-index.md) 波次 W2、W7  
> - [../v3-complete/README.md](../v3-complete/README.md) **U2** 硬约束  
> - [../v3-complete/02-render-model.md](../v3-complete/02-render-model.md) focus-source 模型  
> - [../blocks/code.md](../blocks/code.md) 旧块规格（MD 往返仍有效，交互以本册为准）  
> - [../06-extensions.md](../06-extensions.md) mermaid / math 语法预留  
> **本册范围**：围栏代码、语言清单、高亮、行号、折叠、复制、Diff、行高亮、语言自动检测、主题、安全；Mermaid（flowchart / sequence / ER / state / timeline / class）；KaTeX·MathJax 行内+块；ASCII 图；**禁止实现代码**，只冻结金标准。  
> **非本册**：表格、段落行内 marks、图片媒体、AI 改写端口（见 03/01/04/05）。

---

## 0. 文档导读

### 0.1 本册回答什么

1. 代码 / 数学 / 图解每一项能力在 **金标准** 下长什么样。  
2. **用户硬规则**如何落到 DOM 与状态机（失焦渲染 / 聚焦整段源码 / 单表面）。  
3. 点击代码片段时的精确行为。  
4. 与 Typora、Obsidian、GitHub、Carbon、Notion 的 **对标与超越点**。  
5. 每个 F-ID 的验收、动效、模块主人、依赖、反模式。  
6. W2 / W7 整波交付时 agent 不该争论的产品决策。

### 0.2 状态枚举（与 README 对齐）

| 状态 | 含义 |
|------|------|
| **缺失** | 无 schema / 无 parse / 无 UI |
| **半成品** | 主路径部分可用，但违反硬规则或边界烂 |
| **模型错误** | 能点但双壳 / 失焦无高亮 / 聚焦丢围栏 |
| **金标准** | 本册「做到最好」+ 验收全绿 |

现状（2026-08 参考实现，**不得反向定义产品**）：代码块多为 **半成品 / 模型错误风险**（textarea 双壳倾向、读态弱高亮）；Mermaid / Math **架子**。

### 0.3 优先级

| P | 含义 | 默认波次 |
|---|------|----------|
| **P0** | 砍掉则代码面失败；含单表面 + 高亮 + 复制 + 围栏往返 | **W2** |
| **P1** | 一等能力：语言选择、行号、主题、Mermaid 主图、公式 | **W2–W7** |
| **P2** | Diff、行高亮 meta、折叠、ASCII、语言自动检测增强 | **W7+** |
| **P3** | 科研级图、LSP、Carbon 导出图、完整 MathJax 全宏 | later |

### 0.4 F-ID 命名

| 前缀 | 域 |
|------|-----|
| `F-CODE-*` | 围栏代码块与通用 chrome |
| `F-DIFF-*` | Diff 语义块 / lang=diff |
| `F-MMD-*` | Mermaid |
| `F-MATH-*` | 行内/块公式 |
| `F-ASCII-*` | ASCII / 纯文本图 |
| `F-SEC-*` | 安全（XSS / 沙箱） |
| `F-THEME-*` | 高亮与图主题 |

---

## 1. 用户硬规则（冻结 · 高于一切局部 UX 偏好）

> 以下三条是 **U2 + F-CORE-06** 在本册的完整展开。任何实现、PR、demo 与之冲突 → **直接打回**，分数 ≤2。

### 1.1 规则 R1 — 未聚焦 = 渲染高亮

| 项 | 冻结内容 |
|----|----------|
| **触发** | 代码块 / Mermaid / 数学块 **不在** editing / focus-source 态 |
| **视觉** | 呈现 **最终阅读结果**：代码 = token 着色高亮；Mermaid = 矢量图；数学 = KaTeX/MathJax 排版 |
| **禁止** | 默认显示灰色 textarea、占位「点击编辑」、裸围栏源码作为主视图、半透明预览 |
| **等价物** | 导出 PDF / 阅读器 / GitHub 预览应「看起来一样精致」 |

### 1.2 规则 R2 — 聚焦 = 同一卡片内显示 **完整源码（含围栏）**

| 项 | 冻结内容 |
|----|----------|
| **触发** | 用户点击代码卡片 **正文区域**（非仅 header 的复制按钮）进入编辑 |
| **内容** | 单一可编辑表面显示 **含 fence 标记的完整 Markdown 源**，例如： |
| | ```ts |
| | const x = 1 |
| | ``` |
| **含义** | 第一行可见 ` ```ts `（或 ` ```typescript`），最后一行可见闭合 ` ``` `；中间为正文 |
| **模型** | **单表面（single surface）**：同一卡片、同一视觉壳；**不是**「上面高亮预览 + 下面 textarea」双壳 |
| **提交** | blur / Esc / 点到其他块 → 解析围栏 → 写回 `lang` + `text`（body）→ 立即回到 R1 渲染 |

### 1.3 规则 R3 — 禁止双壳与「假编辑器」

| 禁止 | 说明 |
|------|------|
| 预览框 + 输入框并列 | 经典「双壳」；Notion 部分实现接近此感，**Conex 明确否决** |
| 聚焦后仍叠一层半透明高亮 | 除非 token 层与 caret 层是 **同一 CE 表面** 且实现成本可控；v3.0 **默认纯文本源表面**，高亮只在失焦 |
| 外挂全屏 CodeMirror 当默认 | 文档内代码块不是 IDE；超大文件走 Files 面板 |
| 聚焦后去掉围栏只编 body | 用户明确要求 **看到含 \`\`\`lang 的源**；body-only 编辑可作为 **高级开关**（默认关） |

### 1.4 点击行为矩阵（代码片段 · 用户描述落地）

| 用户动作 | 预期 |
|----------|------|
| 文档滚动、光标在其他块 | 所有代码块保持 **高亮阅读态** |
| 单击代码块 **body**（pre 区） | 该块进入 focus-source；**同一卡片** morph 为源码表面；caret 落在点击对应行附近（能映射则映射，否则文首） |
| 单击 **语言标签**（失焦态） | **不**强制进源码；打开语言选择菜单（或进入源码并把 caret 放到 info string）— **推荐**：打开语言菜单，改完仍可保持阅读态并即时重高亮 |
| 单击 **复制按钮** | 只复制 **body 纯文本**（不含围栏）；不进入编辑；`aria-live`「已复制」 |
| 单击 **折叠 chevron** | 切换折叠；不进入编辑 |
| 双击行号栏 | 可选：选中该行（P2）；不强制 |
| 拖选阅读态代码文字 | 允许浏览器原生选区复制高亮后的纯文本；**不**因此进入编辑（避免误触）；若产品要「选中即编」必须可关 |
| 在源码态编辑 | 等宽、spellcheck off、Tab=缩进、Enter=换行不拆块 |
| Esc | 提交并退出源码 → 高亮渲染；若源非法（围栏不配对）→ 见 F-CODE-SRC 失败态 |
| Mod+Enter | 退出代码块，聚焦下一块或新建 paragraph |
| 点击块外 | 等同 blur 提交 |
| 点击 **另一块** | 当前块提交；新块按自身规则进入 |
| 行内 `` `code` `` 单击 | **不是**代码块；走行内 mark 规则（01 分册）；本册不把行内变成 fence |

### 1.5 与其它块类型的对比（避免模型串味）

| 块 | 未聚焦 | 聚焦 |
|----|--------|------|
| 段落 / 标题 | 渲染 | **focus-render**（格式生效，非整段裸 MD）— 见 01 |
| **代码 fence** | **高亮渲染** | **focus-source 含围栏整源** — 本册 |
| Mermaid | **图** | **源**（同代码单表面；lang 固定 mermaid） |
| 数学块 `$$` | **公式排版** | **源**（含 `$$` 定界） |
| 表格 | 网格 | 网格内编辑 — 见 03 |

---

## 2. 金标准对标（Gold Comparisons）

> 目的：Conex **不是抄一个**，而是在文档编辑器语境下 **组合各家最强点 + 修掉硬伤**。

### 2.1 对照总表

| 维度 | Typora | Obsidian | GitHub | Carbon | Notion | **Conex 目标** |
|------|--------|----------|--------|--------|--------|----------------|
| 默认视图 | 实时预览融合 | 可切换源/阅 | 纯渲染 | 导出美图 | 块卡片 | **渲染默认**（像 GH 精致度 + Typora 无硬切换） |
| 代码聚焦 | 可进源编辑 | 源模式整页或块插件 | 无编辑 | 整页可编 | 卡片内编辑，常见 **无围栏字面量** | **同卡含 \`\`\`lang 源** |
| 双壳风险 | 低（一体） | 中（模式切换） | N/A | N/A | **高**（预览感 vs 输入） | **零双壳**（硬规则） |
| 语法高亮 | 强 | 强（主题丰富） | 强 | 极强美学 | 中等 | **主流语言稳定 token** + 主题跟随编辑器 |
| 行号 | 有 | 插件/主题 | 有（部分） | 可选 | 弱 | **可选，默认开长块** |
| 复制 | 有 | 有 | 有 | 核心 | 有 | **一键 body；反馈动效** |
| Diff | 弱 | 插件 | PR diff 强 | 无 | 弱 | **lang=diff 语义红绿** |
| Mermaid | 有 | 一等公民 | 有 | 无 | 有限 | **失焦图聚焦源；六类图** |
| 公式 | 强 | 强 | 部分 | 无 | 中 | **$ / $$；失败显源** |
| 安全 | 本地为主 | 插件风险 | 服务端消毒 | 导出 | 云端 | **零 XSS；mermaid 沙箱** |
| 美学 | 出版感 | 可高度主题化 | 工程师干净 | **海报级** | 消费级卡片 | **干净卡片 + Carbon 级可选主题（非默认花哨）** |

### 2.2 向谁学、不学什么

| 来源 | 学 | 不学 |
|------|----|------|
| **Typora** | 无「预览/源码」大战；公式与代码一体感 | 整篇单一 contenteditable 巨石；难块级 DnD |
| **Obsidian** | Mermaid/公式一等；主题与 callout 气质 | 默认双模式心智；重插件才能补齐 |
| **GitHub** | fence 语义、语言 class、渲染可信、Alert | 无就地编辑；diff 是 PR 域不是文档块 |
| **Carbon** | 字体、padding、窗口 chrome、导出分享美学 | 作为 **默认** 文档内样式太重；依赖在线服务 |
| **Notion** | 块卡片、slash 插入、hover chrome 克制 | 代码块双壳感；MD 往返弱；围栏不是一等公民 |

### 2.3 Conex 差异化一句话

**Markdown 真源 + 块级卡片 + 失焦「GitHub 级渲染」+ 聚焦「可见完整 fence 源的单表面」+ 数学/图同一交互语法 + 安全默认锁定。**

---

## 3. 共享模型（所有 F-CODE / F-MMD / F-MATH 共用）

### 3.1 数据（扁平 Doc，对齐 10-data-format）

```ts
// 代码块（现行 type id: 'code'）
interface CodeBlock {
  id: string;
  type: 'code';
  props: {
    lang: string;           // '' = plaintext；规范化小写
    meta?: string;          // info string 剩余，如 {1,3-5} 或 highlight=
    showLineNumbers?: boolean; // UI 偏好，可进 sidecar 若 pure-gfm 不承载
    folded?: boolean;       // 会话态优先；持久化可选
    highlightLines?: number[] | string; // 规范化后 number[]
  };
  text: string;             // **仅 body**，不含围栏行；保留内部 \n
}

// Mermaid：推荐独立 type 'mermaid'（schema 已预留）或 code+lang=mermaid
// 数学块：type 'math'，props.latex / display
```

**源码态展示串**（虚拟，不必持久化整串）：

```
```{lang}{? meta}
{text}
```
```

解析提交时：用 fence tokenizer 从 surface 抽取 lang/meta/text；失败策略见 F-CODE-SRC。

### 3.2 BlockUiState（代码族）

| 状态 | 可见层 | caret |
|------|--------|-------|
| `idle` | 高亮 / 图 / 公式 | 无 |
| `hover` | 同上 + 极淡 chrome（复制/语言） | 无 |
| `focus-source` | **仅**源表面（含围栏） | 有 |
| `error` | 失败卡片 + 「显示源码」 | 可选 |
| `viewOnly` | 同 idle，无进入编辑 | 无 |

**互斥**：`highlight-layer` 与 `source-layer` **不得同时 `visibility` 给用户看到**。允许 DOM 双节点预挂载，但 CSS/aria **互斥**。

### 3.3 Markdown 映射总原则

| 能力 | 序列化 | pure-gfm 降级 |
|------|--------|----------------|
| 代码 | \`\`\`lang\nbody\n\`\`\` | 原生 |
| 波浪围栏输入 | 解析接受；**写出统一 \`\`\`** | 兼容 |
| meta 行高亮 | info string 或 HTML 注释 sidecar | 丢 meta 仍保留 body |
| Mermaid | \`\`\`mermaid\n… | 当代码块 |
| 数学块 | \`\`\`\n monoline $$ 或 `$$\n…\n$$` | 当段落或代码 |
| 行内数学 | `$...$` | 纯文本 |

### 3.4 模块主人（默认路径，08 分册可改名）

| 区域 | 路径（目标） | 禁止堆入 |
|------|--------------|----------|
| 代码块 UI 状态机 | `blocks/code/` 或 `js/markdown-editor/blocks/code.js` | `editor.js` 上帝逻辑 |
| 高亮 | `render/code-highlight.ts`（或 `ui/code-highlight.js`） | 业务 editor 内联 Prism 全量 |
| 复制 / chrome | `blocks/code/chrome.ts` | |
| Diff 着色 | `render/diff-highlight.ts` | |
| Mermaid | `blocks/mermaid/` + 动态 `import('mermaid')` | 首包 |
| Math | `blocks/math/` + 动态 KaTeX | 首包 |
| 消毒 | `security/sanitize.ts` | 各处手写 replace |
| 主题 token | `css/markdown-editor/code-theme.css` | 组件内硬编码色 |

---

## 4. 功能条目（F-ID 全文）

> 模板字段（强制）：**Priority · Category · MD mapping · Status · 做到最好 · Acceptance · Motion · Module owner · Dependencies · Anti-patterns**

---

### F-CODE-FENCE — 围栏代码块解析与往返

| 字段 | 内容 |
|------|------|
| **Priority** | P0 |
| **Category** | 代码 · 解析/序列化 |
| **MD mapping** | 开闭 \`\`\` 或 ~~~；info 首 token → `lang`；body 原样；写出统一反引号围栏 |
| **Status** | 半成品（有 parse/serialize 骨架，边界与源码态展示未金标准） |
| **做到最好** | ① 支持 0–3 空格缩进围栏。② body 含 \`\`\` 时自动升级围栏长度（最长 run +1）。③ 未闭合围栏读到 EOF 仍生成块，serialize 补闭合。④ `lang` sanitize：`[A-Za-z0-9_+#.-]+`，异常清空。⑤ 空块为 \`\`\`\n\n\`\`\`。⑥ 不把 4 空格缩进代码作为主路径（可 parse 升级为 fence）。⑦ 与 GFM 一致：info string 其余进 `meta`。 |
| **Acceptance** | A1 往返 `ts` 多行保留。A2 body 含 \`\`\` 时围栏加长且再打开 body 正确。A3 ~~~js 读入写出 \`\`\`js。A4 畸形 lang 被清空不炸。A5 空块不丢。 |
| **Motion** | 无；纯数据 |
| **Module owner** | `parse.js` / `serialize.js` 中 code 分支；单测 `tests/.../code-fence` |
| **Dependencies** | schema `code`；无 UI 依赖 |
| **Anti-patterns** | 用 regex 一次吃全文导致灾难回溯；serialize 丢最后换行导致粘连下段；把 lang 写进 body |

---

### F-CODE-SRC — 聚焦单表面完整源码（硬规则核心）

| 字段 | 内容 |
|------|------|
| **Priority** | P0 |
| **Category** | 代码 · 交互模型 |
| **MD mapping** | 源表面 = 可序列化的完整 fence 文档片段；提交后拆回 lang+text |
| **Status** | 半成品 / 模型错误风险（textarea + 外置 lang 输入 ≈ 双壳） |
| **做到最好** | **① 失焦**：仅高亮层（F-CODE-HL）。**② 聚焦**：同一 `.mdx-code` 卡片内，高亮层 `hidden`，源表面 `visible`；源文本 **必须含** 起始围栏行（\`\`\`lang 与可选 meta）、body、闭合围栏。**③ 不是** 第二张卡片、不是弹层全屏编辑器（可提供「扩大编辑」P3）。**④ lang 输入框不得作为与 body 分离的第二编辑壳**；语言要么在源首行改，要么用阅读态菜单改 props 后重渲。**⑤** caret 映射：从点击 Y 坐标估算行；失败则 0。**⑥** 提交解析：合法 → 更新 model；首行非 fence → 整段当 body、lang 保持旧或 plaintext，并 toast「未检测到围栏，已按正文保存」可撤销。**⑦** IME composition 中不提交、不 morph。**⑧** 高度：源表面 min-height 接近原高亮块，**禁止**整页跳动（F-CORE-03）。 |
| **Acceptance** | A1 点击 body → 可见 \`\`\` 与 lang。A2 无上方预览+下方输入并列。A3 改 lang 于首行，blur 后高亮语言变。A4 Esc 回渲染。A5 中文 IME 组字不丢字。A6 大块（500 行）进入编辑不卡死主线程 >100ms 首帧目标（可降级）。A7 Review 截图：双壳 = 失败。 |
| **Motion** | 高亮⇄源：**同卡 cross-fade ≤150ms** 或即时切换；`prefers-reduced-motion` → 0ms。禁止整卡 scale 弹跳。 |
| **Module owner** | `blocks/code/state-machine` + surface 组件 |
| **Dependencies** | F-CODE-FENCE、F-CODE-HL、F-CORE-03、F-CORE-06 |
| **Anti-patterns** | 双壳；聚焦后只显示 body；用 `window.prompt` 改语言；`innerHTML` 塞用户源码；blur 时 `confirm` 打断 |

---

### F-CODE-HL — 语法高亮（阅读态）

| 字段 | 内容 |
|------|------|
| **Priority** | P0 |
| **Category** | 代码 · 渲染 |
| **MD mapping** | 无新语法；`lang` → highlighter grammar |
| **Status** | 半成品（轻量/无） |
| **做到最好** | ① 阅读态对 body 做 **token 级**着色（span 带 `mdx-token--keyword|string|comment|...`）。② **禁止**在 focus-source 用高亮 span 抢 caret（v3.0）。③ 未知 lang → plaintext，仍等宽。④ 超大 body（如 >100k 字符或 >3000 行）**降级**纯文本或仅前 N 行高亮 + 「已截断高亮」提示。⑤ Worker 可选：主线程预算，超时降级。⑥ 与主题 F-THEME-CODE 共用 CSS 变量。⑦ 高亮 HTML **必须**先 escape 文本再包 span（F-SEC-XSS）。 |
| **Acceptance** | A1 js/ts/python/rust/go/json/css/html/md 抽样着色正确。A2 `lang=""` 无报错。A3 恶意 body `</code><script>` 不执行。A4 进出编辑 20 次无泄漏/错色。 |
| **Motion** | 首次高亮可淡入 token 色 80ms；主题切换整卡 recolor 无闪白。 |
| **Module owner** | `render/code-highlight` |
| **Dependencies** | F-CODE-FENCE、F-SEC-XSS、F-THEME-CODE |
| **Anti-patterns** | 编辑态 Prism 直接 contenteditable；把 `highlight.js` 全语言打进首包；用 `innerHTML = userText` |

---

### F-CODE-LANG — 语言标签、列表与切换

| 字段 | 内容 |
|------|------|
| **Priority** | P1（展示 P0；完整列表与记忆 P1） |
| **Category** | 代码 · chrome |
| **MD mapping** | info string 第一 token |
| **Status** | 半成品（常有粗糙 input） |
| **做到最好** | ① 阅读态 header 显示友好名（`TypeScript`）与短 id（`ts`）策略统一：UI 显示短 id 小写，tooltip 全名。② 点击语言 → **菜单**：搜索 + 常用置顶 + 完整列表（见 §5）。③ 选中后即时重高亮，**可不进源码态**。④ 源码态改首行 lang 与菜单双向同步。⑤ 空 lang 显示 `text` 或 `plain`。⑥ 用户最近 5 种语言记忆（local / 宿主 storage 端口）。⑦ slash `/code` 可带语言参数。 |
| **Acceptance** | A1 菜单可选 python → serialize \`\`\`python。A2 搜索 `ts` 命中 typescript/ts。A3 未知自定义 lang 仍保留字符串（若通过 sanitize）。A4 键盘：语言按钮 Enter 开菜单，方向键选择。 |
| **Motion** | 菜单 120ms fade+slide；选择后标签数字微更新。 |
| **Module owner** | `blocks/code/lang-menu` |
| **Dependencies** | F-CODE-FENCE、F-CODE-HL、§5 语言表 |
| **Anti-patterns** | 永远弹系统 prompt；强制用户记 Prism 别名；菜单遮挡复制按钮不可达 |

---

### F-CODE-COPY — 一键复制

| 字段 | 内容 |
|------|------|
| **Priority** | P0 |
| **Category** | 代码 · chrome |
| **MD mapping** | 无；复制 **body** 非围栏 |
| **Status** | 缺失 / 半成品 |
| **做到最好** | ① 阅读态与源码态均可复制。② 默认复制 **纯 body**（工程师粘贴到 IDE 不需要围栏）。③ 可选二次操作「复制为 Markdown 围栏」（高级菜单）。④ `navigator.clipboard.writeText`；失败降级 `execCommand` 或 toast 失败。⑤ 按钮图标 + 文案切换「复制」→「已复制」1.2s。⑥ 不抢块焦点（点击复制 **不** 进入 focus-source）。⑦ a11y：`aria-label="复制代码"`。 |
| **Acceptance** | A1 复制内容无 \`\`\`。A2 多行保留 `\n`。A3 点击后不出现源码态。A4 权限拒绝时有失败提示。 |
| **Motion** | 图标 check 弹性 200ms；`aria-live` polite。 |
| **Module owner** | `blocks/code/chrome` |
| **Dependencies** | 无硬依赖；与 F-CODE-SRC 焦点隔离 |
| **Anti-patterns** | 复制整卡 HTML；复制后 focus 进 textarea；无障碍只有颜色变化 |

---

### F-CODE-LINES — 行号

| 字段 | 内容 |
|------|------|
| **Priority** | P1 |
| **Category** | 代码 · 阅读增强 |
| **MD mapping** | 默认 **不** 写入 MD（避免污染）；偏好可 sidecar / 文档 settings |
| **Status** | 缺失 |
| **做到最好** | ① 阅读态左侧行号 gutter，等宽对齐。② 默认：行数 ≥20 或用户开「始终行号」时显示；短块可关。③ 行号不进入剪贴板复制 body。④ 换行软折行时行号按 **逻辑行** 不按视觉行（与 GH 一致）。⑤ 源码态：可显示虚拟行号（含围栏行计为 1…n）或隐藏 gutter 以免与编辑偏移混淆——**推荐源码态显示**，围栏行号暗色。⑥ 点击行号 → 选中该逻辑行（P2 可做）。 |
| **Acceptance** | A1 10 行代码显示 1..10。A2 复制无行号数字。A3 折行不重复计号。A4 主题暗色下行号对比度 ≥ WCAG AA。 |
| **Motion** | 无强制；折叠展开时 gutter 高度动画跟随 |
| **Module owner** | `blocks/code/gutter` + CSS |
| **Dependencies** | F-CODE-HL 布局 |
| **Anti-patterns** | 行号写进 serialize body；用绝对定位错位滚动 |

---

### F-CODE-FOLD — 长代码折叠

| 字段 | 内容 |
|------|------|
| **Priority** | P1–P2 |
| **Category** | 代码 · chrome |
| **MD mapping** | 不进 MD；`folded` 会话态 |
| **Status** | 缺失 |
| **做到最好** | ① 行数 > N（默认 40）自动提供折叠。② 折叠后显示前 8 行 + 渐隐 + 「展开全部 · N 行」。③ 折叠中仍可复制 **全文** body。④ 进入 focus-source **自动展开**。⑤ 用户手动折叠偏好可记在 session。⑥ 不影响 model.text。 |
| **Acceptance** | A1 50 行默认可折。A2 展开后滚动位置不丢关键上下文。A3 折叠态点击 body 非「展开按钮」→ 进源码并展开。 |
| **Motion** | 展开 height 插值 ≤200ms；reduced-motion 则瞬时。 |
| **Module owner** | `blocks/code/fold` |
| **Dependencies** | F-CODE-HL、F-CODE-SRC |
| **Anti-patterns** | 折叠删除 model 行；折叠后无法复制全文 |

---

### F-CODE-META-HL — 指定行高亮（meta）

| 字段 | 内容 |
|------|------|
| **Priority** | P2 |
| **Category** | 代码 · 阅读增强 |
| **MD mapping** | 推荐支持常见形态之一（实现锁定一种 + 兼容解析）：\`\`\`ts {2,5-7}\` 或 \`\`\`ts highlight=2,5-7\`；写出与读入一致 |
| **Status** | 缺失 |
| **做到最好** | ① 阅读态对应逻辑行背景强调（左边条 + 底色）。② 与主题协调，非荧光污染。③ 源码态可在 info string 编辑。④ 非法范围忽略并 console/dev 警告。⑤ serialize 稳定，不因 UI 重排改写。 |
| **Acceptance** | A1 `{1,3-4}` 三行高亮。A2 往返 meta 保留。A3 超界行不崩溃。 |
| **Motion** | 无 |
| **Module owner** | parse meta + `render/code-highlight` 行装饰 |
| **Dependencies** | F-CODE-FENCE、F-CODE-LINES（可选） |
| **Anti-patterns** | 用 HTML 注释散落 body；高亮色无暗色主题 |

---

### F-CODE-DETECT — 语言自动检测

| 字段 | 内容 |
|------|------|
| **Priority** | P2 |
| **Category** | 代码 · 智能 |
| **MD mapping** | 仅在 `lang==''` 时建议；用户确认后写入 lang |
| **Status** | 缺失 |
| **做到最好** | ① 粘贴大段代码或 blur 空 lang 时，轻量启发（扩展名提示、shebang、关键字特征）建议语言。② **不**静默改 lang 造成惊喜；显示「识别为 TypeScript？应用」。③ 可关。④ 误判成本低：一键改回。⑤ 不调用联网 API（默认）。 |
| **Acceptance** | A1 `<?php` 建议 php。A2 用户点否不写 lang。A3 已有 lang 不覆盖。 |
| **Motion** | 建议 chip 滑入 120ms |
| **Module owner** | `blocks/code/detect` |
| **Dependencies** | F-CODE-LANG |
| **Anti-patterns** | 静默改写；把检测当安全边界 |

---

### F-CODE-INLINE — 行内代码 mark

| 字段 | 内容 |
|------|------|
| **Priority** | P0 |
| **Category** | 行内 · 与 01 分册交界 |
| **MD mapping** | `` `code` ``；内容含 \` 时加长定界 |
| **Status** | 半成品 |
| **做到最好** | ① 阅读与 focus-render 等宽芯片。② **单击不**打开代码块编辑器。③ 与 F-CODE-* 块级模型隔离。④ 本册仅声明边界；细节验收在 01。 |
| **Acceptance** | 见 01；本册 A1：行内 code 点击不触发 fence 源码态 |
| **Motion** | 随 01 |
| **Module owner** | inline marks |
| **Dependencies** | F-INL-* |
| **Anti-patterns** | 行内升级为 code 块的隐式魔法（除非 slash/命令显式） |

---

### F-CODE-A11Y — 代码块无障碍

| 字段 | 内容 |
|------|------|
| **Priority** | P0 |
| **Category** | 代码 · a11y |
| **MD mapping** | 无 |
| **Status** | 半成品 |
| **做到最好** | ① `pre/code` 语义保留。② 块 `aria-label`含语言：「代码块 TypeScript」。③ 源表面 `role="textbox"` + `aria-multiline="true"`。④ 复制/语言/折叠均键盘可达。⑤ 高亮不靠色盲敌对唯一通道（token 仍靠色，但结构不丢）。⑥ `spellcheck=false`。 |
| **Acceptance** | A1 Tab 序：块把手 → 语言 → 复制 → 源表面。A2 屏幕阅读器能读语言。 |
| **Motion** | 遵循 reduced-motion |
| **Module owner** | chrome + surface |
| **Dependencies** | 各 F-CODE-* |
| **Anti-patterns** | 只有 div 堆砌；按钮无名称 |

---

### F-DIFF-BLOCK — Diff 语义高亮

| 字段 | 内容 |
|------|------|
| **Priority** | P1–P2 |
| **Category** | Diff |
| **MD mapping** | \`\`\`diff 或 \`\`\`patch；body 为 unified diff 或 `+/-/ ` 行前缀 |
| **Status** | 缺失 |
| **做到最好** | ① 阅读态：以 `+` 开头行绿底，`-` 红底，`@@` 元信息淡色，` ` 上下文默认。② 不依赖完整 patch 解析器 v1；行首规则即可。③ 源码态同 F-CODE-SRC（含 \`\`\`diff）。④ 复制 body 保留 `+/-`。⑤ 与主题协调（暗色不刺眼）。⑥ 可选 word-level diff P3。 |
| **Acceptance** | A1 样例 unified diff 红绿正确。A2 非 diff lang 不误用规则。A3 往返保留。 |
| **Motion** | 无 |
| **Module owner** | `render/diff-highlight` |
| **Dependencies** | F-CODE-SRC、F-CODE-HL |
| **Anti-patterns** | 用浏览器 spell 提示当 diff；红绿色盲无符号前缀（保留 +/- 字符） |

---

### F-DIFF-NOTE — 文档内「变更说明」块（可选别名）

| 字段 | 内容 |
|------|------|
| **Priority** | P3 |
| **Category** | Diff |
| **MD mapping** | 同 code diff；或 callout+diff 组合 |
| **Status** | 缺失 |
| **做到最好** | 不单独发明非 MD 语法；优先 F-DIFF-BLOCK。若产品要「变更卡片」标题，用 callout 包 diff fence。 |
| **Acceptance** | 不阻塞 W2 |
| **Motion** | — |
| **Module owner** | 产品可选 |
| **Dependencies** | F-DIFF-BLOCK、callout |
| **Anti-patterns** | 专有 XML 块导致 pure-gfm 全毁 |

---

### F-MMD-CORE — Mermaid 核心（失焦图 / 聚焦源）

| 字段 | 内容 |
|------|------|
| **Priority** | P1 |
| **Category** | Mermaid |
| **MD mapping** | \`\`\`mermaid\n…\n\`\`\`；type=`mermaid` 或 `code`+lang |
| **Status** | 架子 |
| **做到最好** | ① **未聚焦**：官方 mermaid 渲染 SVG/画布，居中、可横向滚动。② **聚焦**：与代码 **同一交互语法** — 单表面完整源（含 \`\`\`mermaid）。③ 动态 `import()`，feature flag 可关。④ 渲染失败 → error 卡片 + 源码预览 + 重试。⑤ 主题跟随亮暗（F-THEME-MMD）。⑥ 安全：见 F-SEC-MMD。⑦ serialize 永远是标准 fence，无专有 XML。⑧ 尺寸变化不导致整页狂跳（固定 min-height 策略）。 |
| **Acceptance** | A1 flowchart 样例失焦为图。A2 点击后见 \`\`\`mermaid。A3 语法错误友好。A4 flag 关闭时当普通代码高亮。A5 往返稳定。 |
| **Motion** | 图→源 cross-fade；图首次出现 fade-in 150ms |
| **Module owner** | `blocks/mermaid/` |
| **Dependencies** | F-CODE-SRC 交互模式复用、F-SEC-MMD、动态加载 |
| **Anti-patterns** | 双壳；`eval` 源码；同步加载 mermaid 进首包；失败空白 |

---

### F-MMD-FLOW — Flowchart

| 字段 | 内容 |
|------|------|
| **Priority** | P1 |
| **Category** | Mermaid · 图种 |
| **MD mapping** | `flowchart` / `graph` TD|LR|… |
| **Status** | 架子 |
| **做到最好** | 支持 showcase 常用节点/边/subgraph；文档示例可复制。复杂动画图表 P3。 |
| **Acceptance** | A1 LR 与 TD 各一。A2 中文节点标签渲染不乱码。 |
| **Motion** | 随 F-MMD-CORE |
| **Module owner** | mermaid 库 + 样例 |
| **Dependencies** | F-MMD-CORE |
| **Anti-patterns** | 只测英文 |

---

### F-MMD-SEQ — Sequence

| 字段 | 内容 |
|------|------|
| **Priority** | P1 |
| **Category** | Mermaid · 图种 |
| **MD mapping** | `sequenceDiagram` |
| **Status** | 架子 |
| **做到最好** | 参与者、消息、Note、loop/alt 基础；宽图横向滚动。 |
| **Acceptance** | A1 三参与者消息样例。A2 源码往返。 |
| **Motion** | 随 CORE |
| **Module owner** | 同 CORE |
| **Dependencies** | F-MMD-CORE |
| **Anti-patterns** | 溢出裁切无滚动 |

---

### F-MMD-ER — ER 图

| 字段 | 内容 |
|------|------|
| **Priority** | P1 |
| **Category** | Mermaid · 图种 |
| **MD mapping** | `erDiagram` |
| **Status** | 架子 |
| **做到最好** | 实体属性与关系标签清晰；暗色主题可读。 |
| **Acceptance** | A1 两实体关系样例渲染。 |
| **Motion** | 随 CORE |
| **Module owner** | 同 CORE |
| **Dependencies** | F-MMD-CORE |
| **Anti-patterns** | 关系线对比度不足 |

---

### F-MMD-STATE — State 图

| 字段 | 内容 |
|------|------|
| **Priority** | P1 |
| **Category** | Mermaid · 图种 |
| **MD mapping** | `stateDiagram-v2`（优先 v2） |
| **Status** | 架子 |
| **做到最好** | 复合状态基础支持；失败时提示版本关键字。 |
| **Acceptance** | A1 简单状态机样例。 |
| **Motion** | 随 CORE |
| **Module owner** | 同 CORE |
| **Dependencies** | F-MMD-CORE |
| **Anti-patterns** | 只认旧 `stateDiagram` 又不提示 |

---

### F-MMD-TIME — Timeline

| 字段 | 内容 |
|------|------|
| **Priority** | P2 |
| **Category** | Mermaid · 图种 |
| **MD mapping** | `timeline` |
| **Status** | 架子 |
| **做到最好** | 时间轴标题与事件；长轴可滚。 |
| **Acceptance** | A1 三年份事件样例。 |
| **Motion** | 随 CORE |
| **Module owner** | 同 CORE |
| **Dependencies** | F-MMD-CORE |
| **Anti-patterns** | 移动端完全不可读且无提示 |

---

### F-MMD-CLASS — Class 图

| 字段 | 内容 |
|------|------|
| **Priority** | P2 |
| **Category** | Mermaid · 图种 |
| **MD mapping** | `classDiagram` |
| **Status** | 架子 |
| **做到最好** | 类、成员、继承关系；showcase 给 UML 风格例。 |
| **Acceptance** | A1 双类继承样例。 |
| **Motion** | 随 CORE |
| **Module owner** | 同 CORE |
| **Dependencies** | F-MMD-CORE |
| **Anti-patterns** | 与 flowchart 语法混淆无错误提示 |

---

### F-MMD-MORE — 其它 Mermaid 图种（pie/gantt/git 等）

| 字段 | 内容 |
|------|------|
| **Priority** | P3 |
| **Category** | Mermaid |
| **MD mapping** | 各图种关键字 |
| **Status** | 架子 |
| **做到最好** | 不屏蔽；能渲染则渲染，不能则失败态源码。showcase 不强制全覆盖。 |
| **Acceptance** | A1 未知图种不白屏。 |
| **Motion** | — |
| **Module owner** | CORE |
| **Dependencies** | F-MMD-CORE |
| **Anti-patterns** | 白名单过严导致 pie 直接当 code 且无说明 |

---

### F-MATH-INLINE — 行内公式 `$...$`

| 字段 | 内容 |
|------|------|
| **Priority** | P1 |
| **Category** | 数学 |
| **MD mapping** | `$E=mc^2$`；内侧贴邻非空格；货币歧义策略见下 |
| **Status** | 缺失 |
| **做到最好** | ① 阅读/focus-render：KaTeX（默认）渲染。② 聚焦文本块时：策略对齐 01 — **公式原子**点击可进入「源片段编辑」或扩展为可见 `$...$`（产品锁定：**原子选中后显示源**，不整段裸 MD）。③ 货币 `$`：要求开闭 `$` 内侧无空格，且拒绝跨多段；`\$` 转义。④ 失败：红底源文 + tooltip 错误。⑤ 与 `$$` 块不冲突。 |
| **Acceptance** | A1 `$a_b$` 渲染。A2 `价格 $3 到 $5` 不误判（按策略）。A3 往返。A4 XSS：`$\html{...}$` 默认关闭 html 扩展。 |
| **Motion** | 渲染替换无闪烁；错误态 shake 可选 0 |
| **Module owner** | `blocks/math/inline` + inline tokenizer |
| **Dependencies** | F-SEC-MATH、动态 KaTeX、01 marks |
| **Anti-patterns** | MathJax 全量首包；开启 `\html` 默认 |

---

### F-MATH-BLOCK — 块级公式 `$$`

| 字段 | 内容 |
|------|------|
| **Priority** | P1 |
| **Category** | 数学 |
| **MD mapping** | 独占行 `$$\n...\n$$`；或 type=`math` |
| **Status** | 架子 |
| **做到最好** | ① 失焦：居中 display 公式。② 聚焦：**单表面**显示含 `$$` 定界的源（与代码哲学一致）。③ KaTeX displayMode。④ 失败态同图。⑤ slash `/math`。⑥ 序列化稳定换行。 |
| **Acceptance** | A1 多行矩阵样例。A2 点击见 `$$`。A3 无双壳。A4 空公式 placeholder「输入 LaTeX」。 |
| **Motion** | 同 F-CODE-SRC 级别克制 |
| **Module owner** | `blocks/math/` |
| **Dependencies** | F-SEC-MATH、F-MATH-ENGINE |
| **Anti-patterns** | textarea 底下再挂预览双壳；用图片导出当唯一手段 |

---

### F-MATH-ENGINE — KaTeX / MathJax 策略

| 字段 | 内容 |
|------|------|
| **Priority** | P1 |
| **Category** | 数学 · 引擎 |
| **MD mapping** | 无 |
| **Status** | 缺失 |
| **做到最好** | ① **默认 KaTeX**（快、包小、适合文档）。② MathJax 作 **可选端口**（宿主注入 `math.render`），用于宏/化学等 KaTeX 不足场景。③ 统一接口：`renderToString(latex, {display})` → 安全 HTML。④ 缓存同一 latex 结果。⑤ 加载中 skeleton。 |
| **Acceptance** | A1 默认 KaTeX 路径无 MathJax 网络请求。A2 注入端口可替换。 |
| **Motion** | skeleton pulse 可关 |
| **Module owner** | `render/math-engine` |
| **Dependencies** | 动态 import |
| **Anti-patterns** | 两套引擎同时默认；全局污染 `window.MathJax` 无隔离 |

---

### F-ASCII-DIAG — ASCII / 纯文本图

| 字段 | 内容 |
|------|------|
| **Priority** | P2 |
| **Category** | 图解 |
| **MD mapping** | \`\`\` 或 \`\`\`text\` / \`\`\`ascii\`；body 等宽预排 |
| **Status** | 缺失（可用 plaintext code 凑合） |
| **做到最好** | ① 阅读态：等宽、保留空格、不折叠空白、可选浅网格背景。② **不做**强制 box-drawing 美化到 SVG（P3 可选用）。③ 聚焦同 F-CODE-SRC。④ 中文全角对齐文档说明「可能不齐」。⑤ 与 Mermaid 并存，不抢 `graph` 关键字于 ascii。 |
| **Acceptance** | A1 经典 ASCII art 空格不丢。A2 复制保持。 |
| **Motion** | 无 |
| **Module owner** | code plaintext 变体 CSS |
| **Dependencies** | F-CODE-SRC |
| **Anti-patterns** | `white-space: normal` 毁掉图；自动 trim 每行 |

---

### F-THEME-CODE — 代码高亮主题

| 字段 | 内容 |
|------|------|
| **Priority** | P1 |
| **Category** | 主题 |
| **MD mapping** | 无 |
| **Status** | 缺失 |
| **做到最好** | ① 跟随编辑器 light/dark。② CSS 变量：`--mdx-token-keyword` 等。③ 可选 1–2 套命名主题（如 `conex-dim` / `conex-bright`），非 Carbon 彩虹默认。④ 宿主可覆盖变量。⑤ 打印样式：背景变白、字黑。 |
| **Acceptance** | A1 切暗色 token 全更新。A2 对比度抽检。 |
| **Motion** | 主题切换 150ms 内完成无闪白 |
| **Module owner** | `css/.../code-theme.css` |
| **Dependencies** | 全局 visual tokens（06/07） |
| **Anti-patterns** | 组件内写死 `#ff0`；每语言一主题文件打爆 |

---

### F-THEME-MMD — Mermaid 主题

| 字段 | 内容 |
|------|------|
| **Priority** | P1 |
| **Category** | 主题 |
| **MD mapping** | 无 |
| **Status** | 缺失 |
| **做到最好** | mermaid `theme` / `themeVariables` 映射自 Conex CSS 变量；暗色可读。 |
| **Acceptance** | A1 暗色边线可见。 |
| **Motion** | 主题切换可重渲一次 |
| **Module owner** | `blocks/mermaid/theme` |
| **Dependencies** | F-MMD-CORE |
| **Anti-patterns** | 固定 mermaid default 亮色在暗页 |

---

### F-SEC-XSS — 通用 XSS 防护（代码 HTML）

| 字段 | 内容 |
|------|------|
| **Priority** | P0 |
| **Category** | 安全 |
| **MD mapping** | 用户 MD 永不直接当 HTML |
| **Status** | 必须金标准 |
| **做到最好** | ① 一切用户文本进 DOM 默认 `textContent` 或 escape。② 高亮器只在 escape 后插入 token span。③ 禁止 MD 内原始 HTML 默认开启（GFM HTML 默认关或白名单极严）。④ 复制不走 HTML 富文本漏洞路径。⑤ CSP 友好：无 inline handler。⑥ 单元测试攻击向量表（见 §7）。 |
| **Acceptance** | A1 `<script>alert(1)</script>` 在 code body 只显示文本。A2 `"><img onerror=...>` 不高亮成可执行。A3 DOMPurify 或等价用于 **引擎输出**（KaTeX 信任策略见 F-SEC-MATH）。 |
| **Motion** | 无 |
| **Module owner** | `security/sanitize` |
| **Dependencies** | 全渲染管线 |
| **Anti-patterns** | `innerHTML = md`；正则「去掉 script」当安全 |

---

### F-SEC-MMD — Mermaid 沙箱与资源

| 字段 | 内容 |
|------|------|
| **Priority** | P0（随 Mermaid 启） |
| **Category** | 安全 |
| **MD mapping** | 无 |
| **Status** | 缺失 |
| **做到最好** | ① 使用官方 API，`securityLevel: 'strict'`（或等价最严）。② 禁 click 危险行为、禁 `eval`。③ 超大源拒绝渲染（字符/节点预算）。④ 渲染超时 kill。⑤ 错误不泄露栈给外部页面。 |
| **Acceptance** | A1 恶意 mermaid 样本不执行 JS。A2 超大图进入失败态。 |
| **Motion** | 无 |
| **Module owner** | `blocks/mermaid/secure-render` |
| **Dependencies** | F-MMD-CORE |
| **Anti-patterns** | `securityLevel: 'loose'` 默认；iframe 不隔离 cookie |

---

### F-SEC-MATH — 公式引擎安全

| 字段 | 内容 |
|------|------|
| **Priority** | P0（随公式启） |
| **Category** | 安全 |
| **MD mapping** | 无 |
| **Status** | 缺失 |
| **做到最好** | ① KaTeX `throwOnError` 可控；`trust` 默认 false。② 关闭 `\html`/`\url` 危险扩展除非宿主显式开。③ 输出 HTML 经消毒或仅用 KaTeX 信任路径。 |
| **Acceptance** | A1 恶意 latex 不执行脚本。A2 错误可展示源。 |
| **Motion** | 无 |
| **Module owner** | `render/math-engine` |
| **Dependencies** | F-MATH-ENGINE |
| **Anti-patterns** | 开启 trust 全局 true |

---

### F-CODE-PERF — 性能预算

| 字段 | 内容 |
|------|------|
| **Priority** | P1 |
| **Category** | 工程 |
| **MD mapping** | 无 |
| **Status** | 未定义 |
| **做到最好** | ① 单块 body 软限 1MB 字符。② 高亮 >50ms 降级。③ 多 Mermaid 块视口外懒渲染。④ 源码态大文件使用 textarea / plaintext CE，不做行装饰。⑤ 进入编辑不整文档 `innerHTML`。 |
| **Acceptance** | A1 100 代码块文档滚动可交互。A2 打开 2000 行单块不永久冻住。 |
| **Motion** | 懒渲染出现时可 fade |
| **Module owner** | 各 render + editor 编排 |
| **Dependencies** | F-CODE-HL、F-MMD-CORE |
| **Anti-patterns** | 每次按键全量 Prism 全文档 |

---

### F-CODE-SLASH — Slash / 插入入口

| 字段 | 内容 |
|------|------|
| **Priority** | P0 |
| **Category** | 入口 |
| **MD mapping** | 插入空 fence 或 math/mermaid 模板 |
| **Status** | 半成品 |
| **做到最好** | `/code` `/mermaid` `/math` `/diff`；插入后进入合适态（code 可直接源码态便于输入）。中文搜索别名：「代码」「公式」「时序图」。 |
| **Acceptance** | A1 slash 插入 code 得空围栏可编。A2 撤销一次去掉块。 |
| **Motion** | 插入块高度动画轻量 |
| **Module owner** | slash 注册表 + blocks |
| **Dependencies** | 05 slash 分册 |
| **Anti-patterns** | 插入后焦点丢失 |

---

### F-CODE-PASTE — 粘贴行为

| 字段 | 内容 |
|------|------|
| **Priority** | P0 |
| **Category** | 代码 · 编辑 |
| **MD mapping** | 粘贴进源表面 = 纯文本 |
| **Status** | 半成品 |
| **做到最好** | ① 源码态粘贴：纯文本，保留 `\n` 与缩进。② 文档级粘贴整段 fence → 解析为 code 块。③ 从 IDE 粘贴不引入 HTML 高亮 span。④ 超大粘贴确认（可选）。 |
| **Acceptance** | A1 粘贴三行缩进保留。A2 HTML 剪贴板不注入标签。 |
| **Motion** | 无 |
| **Module owner** | paste pipeline |
| **Dependencies** | F-CODE-SRC、F-SEC-XSS |
| **Anti-patterns** | `paste` 默认 `innerHTML` |

---

### F-CODE-INDENT — Tab 与缩进

| 字段 | 内容 |
|------|------|
| **Priority** | P0 |
| **Category** | 代码 · 编辑 |
| **MD mapping** | body 空格/Tab 原样序列化 |
| **Status** | 半成品 |
| **做到最好** | Tab 插入 2 空格（可配置 2/4）；Shift+Tab 减缩进；不焦点逃逸到浏览器。硬 Tab 字符可保留若用户粘贴。 |
| **Acceptance** | A1 Tab 不离开块。A2 多行选中批量缩进 P1。 |
| **Motion** | 无 |
| **Module owner** | source surface keymap |
| **Dependencies** | F-CODE-SRC |
| **Anti-patterns** | Tab 切焦点 |

---

### F-CODE-EXIT — 退出与键盘

| 字段 | 内容 |
|------|------|
| **Priority** | P0 |
| **Category** | 代码 · 编辑 |
| **MD mapping** | 无 |
| **Status** | 半成品 |
| **做到最好** | Esc 提交退出；Mod+Enter 出块；空块头 Backspace 删块策略与 01 一致；方向键在边界不「粘死」。 |
| **Acceptance** | A1 Esc 回高亮。A2 Mod+Enter 建/聚段落。 |
| **Motion** | 退出切换同 F-CODE-SRC |
| **Module owner** | state-machine |
| **Dependencies** | F-CODE-SRC |
| **Anti-patterns** | Esc 清空内容 |

---

## 5. 语言列表（F-CODE-LANG 附录）

### 5.1 一等语言（P0 高亮必测）

| id | 显示名 | 别名 |
|----|--------|------|
| `text` | Plain Text | `plain` `plaintext` `txt` |
| `markdown` | Markdown | `md` |
| `javascript` | JavaScript | `js` `jsx` `mjs` `cjs` |
| `typescript` | TypeScript | `ts` `tsx` |
| `json` | JSON | `jsonc` |
| `html` | HTML | `htm` `xml` `svg` |
| `css` | CSS | `scss` `less` |
| `python` | Python | `py` |
| `rust` | Rust | `rs` |
| `go` | Go | `golang` |
| `java` | Java | |
| `c` | C | |
| `cpp` | C++ | `c++` `cxx` |
| `csharp` | C# | `cs` |
| `ruby` | Ruby | `rb` |
| `php` | PHP | |
| `shell` | Shell | `bash` `sh` `zsh` |
| `sql` | SQL | |
| `yaml` | YAML | `yml` |
| `toml` | TOML | |
| `diff` | Diff | `patch` |
| `mermaid` | Mermaid | （若走 code 类型） |

### 5.2 扩展语言（P1 高亮尽力）

`kotlin` `swift` `dart` `scala` `r` `matlab` `lua` `perl` `powershell` `dockerfile` `nginx` `graphql` `vue` `svelte` `solidity` `haskell` `elixir` `erlang` `clojure` `lisp` `fortran` `assembly` `wasm` `protobuf` `cmake` `makefile` `ini` `properties` `csv` `http` `regex` `latex`

### 5.3 规范化规则

1. 输入别名 → 规范 id（表内左列）。  
2. serialize 用 **规范 id** 或用户原短名（锁定：**短别名优先** `ts` 而非 `typescript`，与 GH 常见习惯一致——实现二选一写进 serialize 单测；**推荐短名**）。  
3. 未知 id：保留小写 sanitize 后字符串，高亮 plaintext。

---

## 6. Showcase 必收录样例（U1）

演示文档必须可见并可点：

1. TypeScript 代码块（短）— 高亮 + 复制 + 点进围栏源。  
2. 长 Python 块 — 行号 + 折叠。  
3. `diff` 块 — 红绿。  
4. 行高亮 meta 一例（若 P2 已做，否则注释「预告」）。  
5. Mermaid flowchart + sequence（最少两种）。  
6. ER 或 state 其一。  
7. 行内 `$a^2+b^2=c^2$` + 块级 `$$` 矩阵。  
8. ASCII 图（`text`）。  
9. 故意错误 mermaid / latex 各一 — 展示失败态。  
10. 空代码块 placeholder。

---

## 7. 安全攻击向量清单（验收用）

| # | 向量 | 期望 |
|---|------|------|
| S1 | body `</code><script>alert(1)</script>` | 纯文本 |
| S2 | lang 为 `"><img onerror=alert(1)>` | sanitize 掉 |
| S3 | mermaid 内 javascript 点击链 | strict 下不可执行 |
| S4 | latex `\html{<img onerror=...>}` | 默认不渲染 HTML |
| S5 | 粘贴 HTML 剪贴板进代码 | 变纯文本 |
| S6 | data URL 在 mermaid | 拒绝或消毒 |
| S7 | 超长 5MB fence | 拒渲染/截断提示，不 OOM 崩页 |

---

## 8. 动效汇总（本册）

| 场景 | 时长 | 备注 |
|------|------|------|
| 高亮⇄源码 | 0–150ms | reduced=0 |
| 复制成功 | 200ms 图标 | live region |
| 折叠展开 | ≤200ms height | |
| 语言菜单 | 120ms | |
| Mermaid 首次出现 | 150ms fade | 懒加载后 |
| 公式错误 | 可选 0 | 不弹窗 |

统一：`prefers-reduced-motion: reduce` 关闭非必要动画。详见 06 分册；本册不发明第二套运动体系。

---

## 9. 依赖与波次映射

```
W1 行源码模型（通用块调度）
 └─► W2 代码单表面
       F-CODE-FENCE
       F-CODE-HL
       F-CODE-SRC    ← 硬规则核心
       F-CODE-COPY
       F-CODE-LANG（最小）
       F-CODE-A11Y / PASTE / INDENT / EXIT / SLASH
       F-SEC-XSS
       F-DIFF-BLOCK（可并行 P1）
       F-CODE-LINES / FOLD（可 W2 尾或 W7）
 └─► W7 Mermaid + 公式
       F-MMD-* + F-SEC-MMD + F-THEME-MMD
       F-MATH-* + F-SEC-MATH + F-MATH-ENGINE
       F-ASCII-DIAG
       F-CODE-META-HL / DETECT
       F-THEME-CODE 完善
```

**规则**：W2 未通过 F-CODE-SRC 金标准验收（双壳=0 分），禁止开 W7 花活。

---

## 10. 模块所有权矩阵（防上帝文件）

| 文件/目录 | 允许拥有的 F-ID | 禁止 |
|-----------|-----------------|------|
| `blocks/code/*` | F-CODE-SRC/LANG/COPY/LINES/FOLD/INDENT/EXIT | mermaid 渲染细节 |
| `render/code-highlight` | F-CODE-HL、参与 META-HL | 解析 MD |
| `render/diff-highlight` | F-DIFF-* | |
| `blocks/mermaid/*` | F-MMD-*、F-SEC-MMD 调用 | 改 paragraph |
| `blocks/math/*` | F-MATH-* | |
| `security/sanitize` | F-SEC-XSS | UI |
| `parse`/`serialize` | F-CODE-FENCE 数据面 | DOM |
| `editor.js` / 编排 | 只调度 enter/exit | 高亮实现、mermaid 主题 |

单文件业务逻辑 >400 行必须拆（08 分册）。

---

## 11. Review 打分表（本册专用）

| F-ID 组 | 5 分条件摘要 |
|---------|----------------|
| F-CODE-SRC | 截图无双壳；源含围栏；blur 回高亮 |
| F-CODE-HL | 主流语言正确；恶意串不执行 |
| F-CODE-COPY | body only；不进编辑 |
| F-DIFF-BLOCK | +/- 可辨 |
| F-MMD-CORE | 图/源切换；失败态 |
| F-MATH-* | $/$$；安全关 html |
| F-SEC-* | §7 向量全过 |

波次出口：该面所有 **P0 ≥4 分**，且无 0–2 分项。

---

## 12. 反模式总表（黑名单）

1. **双壳编辑**：预览 + textarea 同时可见。  
2. **聚焦丢围栏**：用户看不到 \`\`\`lang。  
3. **失焦无高亮**：灰纯文本冒充完成。  
4. **整页源码模式**当默认。  
5. **首包塞进** Prism 全语言 + mermaid + MathJax。  
6. **innerHTML 用户串**。  
7. **mermaid loose 安全级**。  
8. **静默自动改 lang**。  
9. **行号/折叠写进 MD body**。  
10. **激活行厚描边**（违反 F-CORE-10）。  
11. **复制带围栏却不说明**。  
12. **IME 组字时重渲**。  
13. **点击复制却 enterEdit**。  
14. **公式 trust/html 默认开**。  
15. **用上帝 `editor.js` 实现全部高亮**。

---

## 13. 与旧文档差异（显式覆盖）

| 旧说辞 | 本册 |
|--------|------|
| `blocks/code.md`：编辑态 textarea，阅读可高亮；lang 小菜单 | **源表面必须含围栏**；lang 菜单可保留但 **不得构成第二编辑壳** |
| 架构文：大块禁行内高亮 | 仍成立；指 **编辑态** |
| v3-complete C06：半成品 | 本册给 **金标准定义** 作为 W2 DoD |
| mermaid 作 code_block 或独立 type | **允许 type=mermaid**；serialize 仍 fence；交互同代码 |

---

## 14. 实现备注（给 agent · 非代码）

### 14.1 推荐 DOM 草图（互斥层）

```html
<div class="mdx-block mdx-block--code" data-block-id="…" data-state="idle|source">
  <div class="mdx-code">
    <div class="mdx-code__header" data-cx-no-source-toggle>
      <button type="button" class="mdx-code__lang">ts</button>
      <button type="button" class="mdx-code__copy">复制</button>
    </div>
    <!-- 互斥：idle 可见 -->
    <pre class="mdx-code__pre mdx-code__layer--highlight" hidden? >
      <code class="language-ts">…token spans…</code>
    </pre>
    <!-- 互斥：source 可见；值为完整 fence 文本 -->
    <pre class="mdx-code__surface mdx-code__layer--source"
         contenteditable="plaintext-only"
         spellcheck="false"
         role="textbox"
         aria-multiline="true"
         hidden? >```ts
const x = 1
```</pre>
  </div>
</div>
```

说明：可用 `textarea` 替代 CE **仅当** 仍满足单表面且无第二预览；header 控件点击不触发 source toggle。

### 14.2 提交解析伪流程

1. 读 surface 纯文本。  
2. fence tokenize → lang, meta, body。  
3. 校验 sanitize。  
4. `model.updateBlock({ props.lang, props.meta, text: body })`。  
5. state → idle；异步高亮。  
6. 失败 → 保留 surface 或降级策略 + toast + 可撤销。

### 14.3 Mermaid / Math 同构

- 高亮层替换为 **图/公式层**。  
- 源层同样带定界（\`\`\`mermaid 或 `$$`）。  
- 安全包装在 render 前。

---

## 15. 验收清单（可打印）

### 15.1 W2 出口（代码面）

- [ ] 未点击：代码块语法高亮，像阅读器  
- [ ] 点击 body：同卡出现完整 \`\`\`lang 源，无双壳  
- [ ] Esc / 失焦：回到高亮，内容往返正确  
- [ ] 复制：仅 body，不进编辑  
- [ ] 语言可改，serialize 正确  
- [ ] Tab/Enter/IME 行为正确  
- [ ] XSS 样本 S1–S2、S5 通过  
- [ ] 无激活厚描边；高度不跳  
- [ ] diff 样例（若本波含）红绿可读  
- [ ] 模块未堆进上帝文件  

### 15.2 W7 出口（图公式）

- [ ] Mermaid 六类中至少 flow+seq+（ER|state|class|timeline 之二）  
- [ ] 失焦图、聚焦源、失败态  
- [ ] F-SEC-MMD 样本通过  
- [ ] 行内+块公式渲染与源切换  
- [ ] F-SEC-MATH 通过  
- [ ] ASCII 空格保留  
- [ ] 懒加载：首包体积不恶化超预算（宿主指标）  

---

## 16. F-ID 速查表

| ID | 标题 | P |
|----|------|---|
| F-CODE-FENCE | 围栏解析往返 | P0 |
| F-CODE-SRC | 单表面完整源码 | P0 |
| F-CODE-HL | 语法高亮 | P0 |
| F-CODE-LANG | 语言列表与切换 | P1 |
| F-CODE-COPY | 复制 | P0 |
| F-CODE-LINES | 行号 | P1 |
| F-CODE-FOLD | 折叠 | P1–P2 |
| F-CODE-META-HL | 指定行高亮 | P2 |
| F-CODE-DETECT | 语言自动检测 | P2 |
| F-CODE-INLINE | 行内 code 边界 | P0 |
| F-CODE-A11Y | 无障碍 | P0 |
| F-CODE-PERF | 性能预算 | P1 |
| F-CODE-SLASH | 插入入口 | P0 |
| F-CODE-PASTE | 粘贴 | P0 |
| F-CODE-INDENT | 缩进 | P0 |
| F-CODE-EXIT | 退出键盘 | P0 |
| F-DIFF-BLOCK | Diff 高亮 | P1–P2 |
| F-DIFF-NOTE | 变更说明可选 | P3 |
| F-MMD-CORE | Mermaid 核心 | P1 |
| F-MMD-FLOW | Flowchart | P1 |
| F-MMD-SEQ | Sequence | P1 |
| F-MMD-ER | ER | P1 |
| F-MMD-STATE | State | P1 |
| F-MMD-TIME | Timeline | P2 |
| F-MMD-CLASS | Class | P2 |
| F-MMD-MORE | 其它图种 | P3 |
| F-MATH-INLINE | 行内公式 | P1 |
| F-MATH-BLOCK | 块公式 | P1 |
| F-MATH-ENGINE | KaTeX/MathJax 策略 | P1 |
| F-ASCII-DIAG | ASCII 图 | P2 |
| F-THEME-CODE | 代码主题 | P1 |
| F-THEME-MMD | Mermaid 主题 | P1 |
| F-SEC-XSS | XSS | P0 |
| F-SEC-MMD | Mermaid 安全 | P0 |
| F-SEC-MATH | 公式安全 | P0 |

**合计**：35 个 F-ID（含交界与工程项）。

---

## 17. 开放决策（已建议默认 · 可产品一票否决）

| # | 议题 | 默认 |
|---|------|------|
| D1 | serialize lang 短名 vs 全名 | **短名** `ts` |
| D2 | mermaid 独立 type vs code+lang | **独立 type=`mermaid`**，serialize 仍 fence |
| D3 | 源码态用 textarea vs plaintext-only CE | **plaintext-only 优先**；大块可降级 textarea，仍单表面 |
| D4 | 阅读态拖选是否 enterEdit | **否** |
| D5 | 默认行号阈值 | **≥20 行显示** |
| D6 | 默认折叠阈值 | **≥40 行提供** |
| D7 | 数学引擎 | **KaTeX 默认**，MathJax 端口 |
| D8 | 行高亮 meta 语法 | **`{1,3-5}` 优先**，兼容 `highlight=` |
| D9 | 复制默认是否带围栏 | **不带**；高级可带 |
| D10 | Carbon 风格导出图 | **P3**，非默认 chrome |

---

## 18. 结语

本册把 Conex 代码/数学/图解面的 **金标准** 写成可验收合同：

- **未聚焦** = 高亮 / 图 / 公式（出版级阅读）。  
- **聚焦** = **同一卡片**上的 **完整 fence（或 $$）源码**，不是双壳。  
- **安全默认锁定**，主题跟随，模块可拆，波次可整面交付。  

实现 agent：没有对应 F-ID 与验收项 **不得开工**。  
Review agent：双壳或失焦无高亮 → **直接 ≤2 分打回**。

— 02-code-math-diagram.md 完 —
