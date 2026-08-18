# 01 — 全功能矩阵 vs 现状（v3-complete）

> **角色**：`mdx-v3-analyst-01` 功能矩阵分册。只读分析 + 规格深度文档，供实现 agent、产品验收、showcase 与排期使用。  
> **工作区证据根**：`C:\Software\conex\reference\chat-composer-component`  
> **硬约束**：见 [README.md](./README.md) **U1–U6**；冲突时以 U1–U6 为准。  
> **旧规格锚点**：`docs/markdown-editor/02-block-catalog.md`、`10-data-format.md`  
> **分析日期**：2026-08-02  
> **原则**：凡标注「可用/完成」必须能在现有 `js/markdown-editor/**` + `markdown-editor.html` 中复现；禁止臆造。

---

## 0. 文档导读

### 0.1 本册回答什么

1. 用户完整能力清单 **每一条** 当前处于何种状态。  
2. 与 U1–U6 的差距、与「空架子」指控的对应。  
3. 分期目标（v3.0 / v3.1 / v3.2 / later）与优先级 P0–P3。  
4. 演示页 **必须出现** 的样例块清单。  
5. 实施侧的 **block type / mark / API** 暗示（不写完整实现）。

### 0.2 状态枚举（强制统一）

| 状态 | 含义 | 验收直觉 |
|------|------|----------|
| **未做** | 无 schema 字段、无 parse、无 render、无 slash、无 UI | 用户完全感知不到 |
| **架子** | schema/注册表/注释预留了 type 或 props，但无渲染与往返闭环 | 代码能搜到名字，产品上仍是空 |
| **半成品** | 能点/能插/能部分往返，但关键体验残缺或违反 U2–U5 | 「有了，但不像产品」 |
| **可用** | 主路径可演示、可集成，缺 polish 或次要能力 | 日常编辑可依赖 |
| **完成** | 对照本册验收标准全绿，含 a11y/往返/动效门槛 | 可标 v3 Done |

### 0.3 优先级与目标版本

| 优先级 | 定义 | 默认目标版本 |
|--------|------|--------------|
| **P0** | U1–U6 或基础 MD 闭环；砍掉则演示失败 | **v3.0** |
| **P1** | 清单内一等能力；影响「像 Notion 的 MD」感知 | **v3.0–v3.1** |
| **P2** | 增强/科研/结构图；可后置但不从清单删除 | **v3.1–v3.2** |
| **P3** | 锦上添花、协作/版本/导入导出占位 | **later / 端口** |

版本语义（本册）：

| 版本 | 产品一句话 |
|------|------------|
| **v3.0** | 渲染态默认 + 代码块单击源码态 + 行内 marks 实时 + 表合并 + showcase 覆盖清单主路径 |
| **v3.1** | 媒体/公式/Mermaid/结构导航（TOC·双链·标签）可用 |
| **v3.2** | 表格高级（排序筛选拖列）+ 导入导出 + 科研附件 |
| **later** | 版本历史、实时协作、AI 真实现（端口在 v3.0 预埋） |

### 0.4 代码证据索引（实现真源）

| 模块 | 路径 | 职责现状 |
|------|------|----------|
| 公共 API | `js/markdown-editor/index.js` | `MarkdownEditor.mount/getMarkdown/setMarkdown/getDoc/setDoc/flush/destroy/focus` |
| 编辑内核 | `js/markdown-editor/editor.js` | 块渲染、编辑态切换、slash、DnD、表编辑、选区条挂载 |
| Schema | `js/markdown-editor/schema.js` | Doc v2；`BLOCK_TYPES` 含 **image/math/mermaid/embed 预留** |
| Model | `js/markdown-editor/model.js` | 扁平 `blocks[]`、undo/redo、update/insert/remove/move |
| Parse | `js/markdown-editor/parse.js` | MD→blocks：段/标题/列表/任务/引用/代码/表/callout/hr/file_chip |
| Serialize | `js/markdown-editor/serialize.js` | blocks→MD；**无 image/math/mermaid** 分支 |
| 行内 | `js/markdown-editor/util.js` | `inlineHtml` / `htmlToInlineMd`：粗斜删码链 + file/wiki 芯片 |
| 注册表 | `js/markdown-editor/registry.js` | **空架子**：无内置 register 调用 |
| 选区工具条 | `js/markdown-editor/ui/selection-toolbar.js` | B/I/S/`code`；execCommand |
| 表 chrome | `js/markdown-editor/ui/table-chrome.js` | + 行/列、右键插删/对齐 |
| 样式 | `css/markdown-editor/index.css`、`table.css` | 块壳/slash/表 chrome；**无高亮主题/公式/媒体** |
| 演示宿主 | `markdown-editor.html` | SAMPLE 极简产品说明，**未覆盖完整清单** |
| 往返测 | `tests/markdown-editor/roundtrip.test.js` | schema migrate + 基础 roundtrip（非 UI） |

### 0.5 Block type 真名对照（实现 vs 旧 catalog）

旧 `02-block-catalog.md` 使用树形 `bullet_list`/`list_item`；**现行代码是扁平模型**（`10-data-format.md` 冻结）：

| 现行 type id（以 schema 为准） | 旧 catalog 近似 | 实际渲染 |
|-------------------------------|-----------------|----------|
| `paragraph` | `paragraph` | 有 |
| `heading` + `level` | `heading` | 有（1–6 可 parse；slash 仅 1–3） |
| `bullet_item` | `bullet_list`+`list_item` | 有 |
| `ordered_item` | `ordered_list`+`list_item` | 有 |
| `task_item` | `task_list`+`task_item` | 有 |
| `quote` | `quote` | 有 |
| `code` | `code_block` | 有（半成品） |
| `table` + `cells`/`rows` | `table`/`row`/`cell` | 有（半成品→可用边界） |
| `divider` | `divider` | 有 |
| `callout` | `callout` | 有 |
| `file_chip` | `file_chip` | 有 |
| `image` | `image` | **架子 only** |
| `math` | `math_block` | **架子 only** |
| `mermaid` | （扩展） | **架子 only** |
| `embed` | `embed_link` | **架子 only** |

**实施约定（v3）**：继续以 **扁平 type 名** 为真源；旧 catalog 的容器型 id 仅作文档别名，禁止双轨序列化。

---

## 1. 总览矩阵

> 列说明：  
> - **用户清单项**：用户原话能力（可合并相近原子）  
> - **状态**：§0.2  
> - **P**：优先级  
> - **目标版本**  
> - **代码证据（摘要）**

### 1.1 基础 Markdown / 行内

| ID | 功能 | 状态 | P | 目标版本 | 代码证据摘要 |
|----|------|------|---|----------|--------------|
| B01 | 段落 `paragraph` | **可用** | P0 | v3.0 完成 polish | parse 合并行；editor 阅读/编辑；placeholder |
| B02 | 粗体 `**` / strong | **半成品** | P0 | v3.0 | 阅读 `inlineHtml`；编辑靠 toolbar execCommand；**非实时 Typora 态**；无 runs 持久化优先 |
| B03 | 斜体 `*` | **半成品** | P0 | v3.0 | 同 B02 |
| B04 | 删除线 `~~` | **半成品** | P0 | v3.0 | 同 B02；toolbar 有 S |
| B05 | 下划线 | **未做** | P1 | v3.0 | schema mark 文档有 `underline`；util **不解析** `<u>`/`++`；toolbar 无 |
| B06 | 高亮 `==t==` | **未做** | P1 | v3.0 | 10-data-format 有 mark；util **无** `==` |
| B07 | 行内代码 `` ` `` | **半成品** | P0 | v3.0 | 阅读有；toolbar wrap code；编辑态非实时渲染 |
| B08 | 链接 `[t](url)` | **半成品** | P0 | v3.0 | 阅读变 `<a>`；toolbar **无 link**；htmlToInlineMd 可回写 a |
| B09 | 标签 `#tag` | **未做** | P1 | v3.1 | 10-data-format 有 `tag` mark；代码无 |
| B10 | H1–H6 | **可用**（slash 半） | P0 | v3.0 | parse `#{1,6}`；slash **仅 h1–h3** |
| B11 | 标题锚点 / 自动 id | **未做** | P1 | v3.1 | 无 slug、无 `id` 属性 |
| B12 | TOC（目录） | **未做** | P1 | v3.1 | 无块、无侧栏、无自动生成 |
| B13 | 无序列表 | **可用** | P0 | v3.0 | `bullet_item` + indent Tab |
| B14 | 有序列表 | **可用** | P0 | v3.0 | `ordered_item`；序号 DOM 计算（非源 `1.` 忠实） |
| B15 | 多级列表 | **可用** | P0 | v3.0 | `indent` 0–6；Tab/Shift+Tab |
| B16 | Todo / 任务列表 | **可用** | P0 | v3.0 | `task_item` + checkbox |
| B17 | 引用 blockquote | **可用** | P0 | v3.0 | `quote`；单块多行 text |
| B18 | GitHub Alert callout | **可用** | P0 | v3.0 | `> [!NOTE]` 等 parse/serialize；五种 kind |
| B19 | 水平线 hr | **可用** | P0 | v3.0 | `divider`；`---` |

### 1.2 代码 / 公式 / 图

| ID | 功能 | 状态 | P | 目标版本 | 代码证据摘要 |
|----|------|------|---|----------|--------------|
| C01 | 多语言代码块 | **半成品** | P0 | v3.0 | `code` + `lang` 输入框；**无语法高亮** |
| C02 | 代码复制按钮 | **未做** | P1 | v3.0 | 无 copy UI |
| C03 | 行号 | **未做** | P1 | v3.0 | 无 |
| C04 | 行高亮（指定行） | **未做** | P2 | v3.1 | 无 meta `highlightLines` |
| C05 | 代码折叠（长块） | **未做** | P2 | v3.1 | 无 |
| C06 | **U2 代码交互**：未点=高亮预览；点击=源码编辑态（禁止双壳） | **半成品/违规风险** | P0 | v3.0 | 未点：`pre>code` 纯文本；点击：`textarea` + 上方 `lang` 输入 → **接近双壳**，且无高亮预览 |
| C07 | Mermaid | **架子** | P1 | v3.1 | schema `mermaid`；parse/render/serialize **无** |
| C08 | LaTeX 行内 | **未做** | P1 | v3.1 | 无 `$...$` mark |
| C09 | LaTeX 块 | **架子** | P1 | v3.1 | schema `math`；无实现 |
| C10 | Diff 块（`diff` / 增删高亮） | **未做** | P2 | v3.1 | 无 |

### 1.3 媒体

| ID | 功能 | 状态 | P | 目标版本 | 代码证据摘要 |
|----|------|------|---|----------|--------------|
| M01 | 图片块显示 | **架子** | P0 | v3.0 | schema `image`；parse **不认** `![]()`；serialize 无；editor 无 case |
| M02 | 拖拽/粘贴上传 | **未做** | P0 | v3.0 | API 文档有 `media.uploadImage` 设想；**index 未暴露** |
| M03 | 图片压缩 | **未做** | P2 | v3.2 | 无 |
| M04 | 标题/描述/标注（caption/alt） | **架子** | P1 | v3.0 | schema 有 `alt`/`caption`/`path` 字段工厂；无 UI |
| M05 | 图片放大预览 | **未做** | P1 | v3.1 | 无 lightbox |
| M06 | 视频 | **未做** | P2 | v3.2 | 无 type |
| M07 | 音频 | **未做** | P2 | v3.2 | 无 type |
| M08 | 附件（通用 file） | **半成品** | P1 | v3.1 | 仅有 `file_chip` 路径芯片；非二进制附件上传 |

### 1.4 表格

| ID | 功能 | 状态 | P | 目标版本 | 代码证据摘要 |
|----|------|------|---|----------|--------------|
| T01 | GFM 管道表 parse/serialize | **可用** | P0 | v3.0 | parse.js 表；serialize pipe |
| T02 | 结构化网格编辑（非整表 MD 源） | **可用** | P0 | v3.0 | contenteditable 单元格；符合 U4 方向 |
| T03 | 单元格内格式（粗斜链等） | **半成品** | P0 | v3.0 | 阅读 `inlineHtml`；**编辑态 `esc` 纯文本**；写回 strip 格式风险 |
| T04 | 加行/加列（圆形 +） | **可用** | P0 | v3.0 | table-chrome |
| T05 | 右键插删行/列、对齐 | **可用** | P0 | v3.0 | header/body 菜单 |
| T06 | 列对齐写入 MD `|:---|` | **半成品** | P1 | v3.0 | 内存有 `align`；**serialize 固定 `---` 未输出对齐** |
| T07 | **合并单元格**（U4 必须） | **未做** | P0 | v3.0 | 10-data-format 明确预留 rowspan/colspan 未实现；schema cloneCells 无字段 |
| T08 | 拖列重排 | **未做** | P2 | v3.2 | 无 |
| T09 | 排序 | **未做** | P2 | v3.2 | 无；且 **非 Notion DB**，仅文档表 UI 排序 |
| T10 | 筛选 | **未做** | P2 | v3.2 | 无 |
| T11 | 数据表属性：文本/数字/日期/标签/状态/人员/公式 | **明确不做为主** | — | — | 见 §8 非目标；可选「轻量列类型」P3 later |
| T12 | Tab 遍历 / 末格加行 | **可用** | P0 | v3.0 | onTableKeydown |

### 1.5 结构导航 / 知识

| ID | 功能 | 状态 | P | 目标版本 | 代码证据摘要 |
|----|------|------|---|----------|--------------|
| S01 | TOC 块或大纲 | **未做** | P1 | v3.1 | 无 |
| S02 | 面包屑 | **未做** | P2 | v3.2 | 宿主职责为主；编辑器可 emit 标题 |
| S03 | 双向链接 `[[title]]` | **半成品** | P1 | v3.1 | 仅 `[[doc:title]]` 渲染按钮；标准 `[[title]]` 未做；无反向索引 |
| S04 | 标签体系 | **未做** | P1 | v3.1 | 无 |
| S05 | Backlinks 面板 | **未做** | P2 | v3.2 | 需宿主图；编辑器只提供 hook |
| S06 | 文件引用 `[[file:path]]` | **可用** | P1 | v3.0 | 块级 + 行内 chip；`onOpenPath` |

### 1.6 编辑体验

| ID | 功能 | 状态 | P | 目标版本 | 代码证据摘要 |
|----|------|------|---|----------|--------------|
| E01 | Slash `/` 与 `、` | **可用** | P0 | v3.0 | maybeOpenSlash；命令表 13 项 |
| E02 | 快捷键（格式/块） | **半成品** | P0 | v3.0 | Ctrl+Z；Alt+↑↓；**无** Ctrl+B/I 绑定；无命令面板快捷键 |
| E03 | 块拖拽重排 | **可用** | P0 | v3.0 | 六点把手 pointer DnD |
| E04 | 块类型转换（段↔标题↔列表…） | **半成品** | P1 | v3.0 | slash 可改当前块 type；**无**专用「转换」菜单/Turn into |
| E05 | Command palette（全局） | **未做** | P1 | v3.1 | 仅块内 slash，无 Ctrl+K 全局 |
| E06 | 选区浮动工具条 | **可用** | P0 | v3.0 | selection-toolbar 四按钮 |
| E07 | **U3 文本块渲染态编辑** | **半成品** | P0 | v3.0 | 进入编辑后 `innerText` 裸源；非 Typora 实时 marks |
| E08 | viewOnly 查看态 | **可用** | P0 | v3.0 | `viewOnly` 拦截编辑键 |
| E09 | Undo/Redo | **可用** | P0 | v3.0 | model 历史栈 |
| E10 | IME / 中文输入 | **可用** | P0 | v3.0 | compositionstart/end 处理 |

### 1.7 AI 端口

| ID | 功能 | 状态 | P | 目标版本 | 代码证据摘要 |
|----|------|------|---|----------|--------------|
| A01 | 扩写/缩写/改写/翻译/润色 | **未做（端口）** | P1 | v3.0 端口 / later 实现 | 无 API surface |
| A02 | 总结 | **未做（端口）** | P1 | v3.0 端口 | 无 |
| A03 | 问答（基于当前文档） | **未做（端口）** | P2 | v3.1 端口 | 无 |
| A04 | Continue 续写 | **未做（端口）** | P1 | v3.0 端口 | 无 |
| A05 | Review 审阅批注 | **未做（端口）** | P2 | later | 无 |
| A06 | AI 不污染 Doc 核心 | **设计完成 / 代码未验** | P0 | v3.0 | 10-data-format 原则；需 `editor.ai` 插件槽验证 |

### 1.8 版本 / 导入导出 / 科研 / 协作

| ID | 功能 | 状态 | P | 目标版本 | 分期标注 |
|----|------|------|---|----------|----------|
| V01 | 本地版本历史 | **未做** | P3 | later | 宿主侧 snapshot；编辑器提供 `getDoc` |
| V02 | 导出 MD/HTML/PDF | **半成品** | P2 | v3.2 | 现仅 `getMarkdown`；演示页复制 MD |
| V03 | 导入 MD/DOCX 等 | **半成品** | P2 | v3.2 | 仅 `setMarkdown`；无 DOCX |
| V04 | 科研：引用/脚注/文献 | **未做** | P3 | later | 非 MD 定位核心 |
| V05 | 实时协作 OT/CRDT | **明确不做 v3** | — | later+ | 10-data-format 非目标 |
| V06 | 评论锚点 | **明确不做 v3** | — | later | 旧 catalog 非目标 |

### 1.9 明确不做（污染 MD 定位）

| ID | 功能 | 状态 | 理由 |
|----|------|------|------|
| X01 | 看板 Kanban | **不做** | 项目管理污染；非文档 |
| X02 | CRM | **不做** | 同上 |
| X03 | 日历/时间线视图 | **不做** | 同上 |
| X04 | Notion Database 全属性引擎 | **不做** | 表格保持文档表；见 §8 |
| X05 | 任意自定义 HTML 块 | **不做** | 安全禁令 |
| X06 | 页顶永久格式工具条 | **不做** | D16；选区条代替 |

### 1.10 矩阵统计（基于 §1.1–1.8 主行，不含 X*）

| 状态 | 约计条数 | 说明 |
|------|----------|------|
| 完成 | **0** | 对照 v3 验收无一条可称「完成」 |
| 可用 | ~22 | 基础块骨架可演示 |
| 半成品 | ~18 | 含行内、代码 U2、表、编辑体验 |
| 架子 | ~4 | image/math/mermaid/embed |
| 未做 | ~30+ | 媒体完善、结构、AI、合并、高亮等 |
| 端口/later | ~10 | AI/协作/版本 |

**总判**：当前产品是 **「可用的 MD 块编辑 demo 骨架」**，距离 U1「展示页覆盖完整清单」与 U2–U5 体验标准仍有 **结构性缺口**，而非小 polish。

---

## 2. 基础文本与行内 Marks

### 2.1 用户故事

| 角色 | 故事 | 价值 |
|------|------|------|
| 作者 | 像写 Word/Notion 一样看到 **粗体立刻变粗**，而不是满屏 `**` | U3 |
| 作者 | 用 `#标签` 与 `[[笔记]]` 织网 | 知识结构 |
| 读者 | 打开文档即见排版，不进编辑也美观 | U2 阅读默认 |

### 2.2 当前代码行为（证据）

**阅读态行内**（`util.js` `inlineHtml`）顺序：

1. HTML escape  
2. `` `code` ``  
3. `[[file:…]]` → button.chip  
4. `[[doc:title]]` → wiki button（**非**裸 `[[title]]`）  
5. `[text](url)` → `<a target=_blank rel=noopener>`  
6. `**bold**`、`*italic*`、`~~del~~`  

**明确缺失于阅读解析**：`==highlight==`、`<u>`/`++underline++`、`#tag`、标准 wikilink、嵌套复杂 mark 边界。

**编辑态**（`editor.js` `enterEdit` 文本块）：

```text
edit.innerText = block.text || '';
```

即：进入编辑后用户看到 **Markdown 源字符串或纯文本**，不是「渲染态内编辑」。  
选区工具条用 `document.execCommand` 注入 DOM 标签，再经 `htmlToInlineMd` 压回 `block.text` 字符串——**不写 `runs[]`**。

**schema** 虽支持 `runs`/`cloneRuns`，但 editor 主路径 `updateBlock({ text })` 会在 `setPlainText` 场景丢 runs；当前等于 **「text 里嵌 MD 记号」模型**，与 10-data-format「优先 runs」不一致。

### 2.3 验收标准（v3.0 P0 行内）

| AC ID | 标准 | 反例（失败） |
|-------|------|--------------|
| AC-B02-1 | 在 paragraph 输入 `**a**` 后失焦/防抖，阅读态见粗体 | 一直显示星号 |
| AC-B02-2 | 选中「你好」点 B，序列化含 `**你好**` 或等价 | 丢失或变成 HTML |
| AC-B02-3 | **编辑过程中**已生效 mark 以渲染态显示（U3） | 编辑时满屏 `**` |
| AC-B05-1 | 下划线可切换，pure-gfm 导出可降级 | 无入口 |
| AC-B06-1 | `==高亮==` 阅读有底色；编辑可切换 | 当普通字 |
| AC-B08-1 | 工具条或快捷键可加链接；禁止 `javascript:` | 只能手写 MD |
| AC-B09-1 | `#标签` 词边界识别，点击可检索（宿主 hook） | 无样式无 hook |

### 2.4 缺口与依赖

| 缺口 | 依赖分册/模块 |
|------|----------------|
| TextRun 真源 + 实时 mark 渲染 | `04-inline-marks-live.md`、`02-render-model.md` |
| underline/highlight/tag 解析与序列化 | parse 行内层（目前块级 parse 不拆 runs） |
| 快捷键 Ctrl+B/I/E/U | editor keydown + selection-toolbar 对齐 |
| 链接弹层 | UI 新组件 `link-popover` |

### 2.5 实施接口暗示

```ts
// marks（与 10-data-format 对齐，v3 落实）
type TextMark =
  | { type: 'bold' }
  | { type: 'italic' }
  | { type: 'strike' }
  | { type: 'underline' }
  | { type: 'code' }
  | { type: 'highlight'; color?: string }
  | { type: 'link'; href: string }
  | { type: 'wiki'; title: string }
  | { type: 'file'; path: string }
  | { type: 'tag'; name: string };

// API 暗示
editor.commands.toggleMark(type: TextMark['type'], attrs?: object): void;
editor.commands.setLink(href: string): void;
// 序列化
serializeInline(runs: TextRun[], mode: 'conex' | 'pure-gfm'): string;
```

### 2.6 标题 H1–H6 + 锚点 + TOC

#### 用户故事

作为长文作者，我希望 H1–H6 层级清晰，右侧/文首 TOC 可跳转，分享链接可锚到标题。

#### 现状

| 能力 | 状态 | 证据 |
|------|------|------|
| Parse H1–H6 | 可用 | `parse.js` `#{1,6}` |
| 渲染 h1–h6 class | 可用 | `mdx-h mdx-h{n}` |
| Slash H1–H3 | 可用 | SLASH_COMMANDS |
| Slash H4–H6 | **未做** | 命令表无 |
| 自动 anchor id | 未做 | 无 |
| TOC | 未做 | 无 `toc` type |

#### 验收

| AC | 标准 |
|----|------|
| AC-H1 | slash 可插入 H4–H6 或「转标题」选 level |
| AC-H2 | 标题 DOM 有稳定 `id`（slug）；重复标题后缀 `-2` |
| AC-H3 | TOC 块或侧栏列出 H1–H3（可配置深度），点击 smooth scroll |
| AC-H4 | TOC 不序列化错误为普通列表 unless 选择「物化 TOC」 |

#### 接口暗示

```ts
type BlockType = ... | 'toc';
// heading.meta.anchor?: string
// MountOptions.onOutlineChange?: (items: {id,level,text}[]) => void
```

---

## 3. 列表 / 引用 / Callout / 分割线

### 3.1 用户故事

- 写需求说明：有序步骤 + 无序要点 + 待办勾选。  
- 引用他人观点；用 GitHub Alert 强调风险。  
- 用分割线分节。

### 3.2 代码证据

| 类型 | Parse | Serialize | 编辑 | Slash |
|------|-------|-----------|------|-------|
| `bullet_item` | ✓ | `- ` | ✓ Tab indent | ✓ |
| `ordered_item` | ✓ | 固定 `1.` | ✓ 序号展示重算 | ✓ |
| `task_item` | ✓ `- [ ]` | ✓ | checkbox change | ✓ |
| `quote` | ✓ 连续 `>` | ✓ | contenteditable | ✓ |
| `callout` | ✓ `[!NOTE]` + `:::tip` | ✓ `[!KIND]` | 整块 text 编辑 | ✓ tip |
| `divider` | ✓ `---` | ✓ | 无文本；BS 删 | ✓ |

### 3.3 半成品点（真问题）

1. **有序序号**：源码全是 `1.`，阅读态用 DOM 重算——可接受，但跨非列表块重置逻辑需测边界。  
2. **Callout 结构**：title/body 挤在 `text` 用首行分割，不是子 blocks；嵌套列表在 callout 内能力弱。  
3. **Quote**：非容器 children，多段引用变成单块 `\n`，退出 quote 的「空段退出」行为弱于 Notion。  
4. **Callout kind 切换**：slash 只插 tip；无 UI 切换 NOTE/WARNING。  
5. **嵌套列表与 Enter**：空 item 是否提升为 paragraph——实现简陋，边界易烂。

### 3.4 验收标准

| AC | 标准 | 反例 |
|----|------|------|
| AC-L1 | Tab 增加 indent，序列化前导空格 2×indent | indent 丢 |
| AC-L2 | 勾选 task 立即 onChange MD 含 `[x]` | 仅 UI 勾选 |
| AC-L3 | `> [!WARNING]\n> 危险` 往返 kind 保留 | 变普通 quote |
| AC-L4 | 五种 callout 视觉可辨（色/标签） | 同一灰框 |
| AC-L5 | hr 不可打字；Backspace 删除块 | 变成段落 `---` 文本 |

### 3.5 接口暗示

```ts
// 保持扁平
{ type: 'task_item', checked: boolean, indent: number, text?, runs? }
{ type: 'callout', callout: 'note'|'tip'|'important'|'warning'|'caution', text?, runs? }
// v3 建议拆：
// calloutTitleRuns / calloutBody as children? — 若拆需 migrate
```

---

## 4. 代码块 / Mermaid / LaTeX / Diff

### 4.1 用户故事

作为技术写作者，我希望：

1. 未聚焦时看到 **高亮后的代码**（像 GitHub）；  
2. 点击代码块进入 **源码编辑**（单层，不上下双框）；  
3. 一键复制；可选行号；  
4. 能贴 Mermaid 流程图、LaTeX 公式、diff。

### 4.2 现状（对照 U2）

| U2 要求 | 现状 | 判定 |
|---------|------|------|
| 未聚焦 = 高亮预览 | `<pre><code>` **escape 纯文本**，无 highlighter | **未满足** |
| 点击 = 源码编辑态 | 变成 `textarea.mdx-code-edit` + 上方 `input.mdx-lang` | **半满足**；lang 输入构成「双控件壳」观感 |
| 禁止「上面预览 + 下面输入」 | 未同时显示 preview+textarea，但 **也没有预览高亮** | 规避了最差双壳，却掉进「编辑器 demo」 |

相关代码：`editor.js` `readContentHtml` case `code`；`enterEdit` code 分支。

### 4.3 功能拆分矩阵

| 子功能 | 状态 | P | 版本 | 备注 |
|--------|------|---|------|------|
| lang 属性往返 | 可用 | P0 | v3.0 | fence ` ```js ` |
| 语法高亮（多语言） | 未做 | P0 | v3.0 | 建议 Shiki/Prism 只读渲染 |
| 单击进编辑 / 失焦回预览 | 半成品 | P0 | v3.0 | 需去掉「预览框+输入框」任何变体 |
| 复制按钮 | 未做 | P1 | v3.0 | 阅读态 hover |
| 行号 | 未做 | P1 | v3.0 | CSS counters 或 gutter |
| 指定行高亮 | 未做 | P2 | v3.1 | fence meta `js {1,3-4}` |
| 长代码折叠 | 未做 | P2 | v3.1 | max-height + expand |
| Mermaid | 架子 | P1 | v3.1 | type `mermaid` 或 `code`+lang=mermaid 策略二选一 |
| LaTeX 块 | 架子 | P1 | v3.1 | type `math`；`$$` |
| LaTeX 行内 | 未做 | P1 | v3.1 | mark `math` |
| Diff | 未做 | P2 | v3.1 | lang=diff 或 type `diff` |

### 4.4 验收用例

| 用例 | 步骤 | 期望 |
|------|------|------|
| C-UC1 | 打开含 js 代码块文档 | 关键字着色；无 textarea |
| C-UC2 | 点击代码块 | 同一矩形内可编辑源码；可选顶部仅语言 chip，**不要**第二预览窗 |
| C-UC3 | 失焦 | 回到高亮；内容保存 |
| C-UC4 | 点复制 | 剪贴板为纯代码，不含 fence |
| C-UC5 | ` ```mermaid ` 或 mermaid 块 | 阅读态 SVG/图；错误时友好提示 |
| C-UC6 | `$$ E=mc^2 $$` | 公式渲染；点击编辑 LaTeX |
| C-UC7 | diff 块 | +/- 行红绿 |

### 4.5 反例

- 阅读态仍用灰色等宽墙 → 判 C01 失败。  
- 编辑态出现「上 pre 下 textarea」→ **U2 失败**。  
- 用 `innerHTML` 插用户代码 → 安全失败。

### 4.6 接口暗示

```ts
{ type: 'code', lang: string, text: string, meta?: {
  showLineNumbers?: boolean,
  highlightLines?: number[],
  collapsed?: boolean
}}
{ type: 'math', text: string /* latex */ }
{ type: 'mermaid', text: string }

// 渲染端口
MountOptions.highlightCode?: (code: string, lang: string) => string | HTMLElement;
MountOptions.renderMermaid?: (src: string) => Promise<HTMLElement>;
MountOptions.renderMath?: (latex: string, display: boolean) => HTMLElement;
```

---

## 5. 媒体（图 / 视频 / 音频 / 附件）

### 5.1 用户故事

粘贴截图即可入文；图片有说明文字；附件可点开；音视频可播——但仍是 **Markdown 文档**，不是网盘。

### 5.2 现状

| 项 | 证据 | 状态 |
|----|------|------|
| `BLOCK_TYPES.image` | schema.js | 架子 |
| `createBlock` 支持 path/alt/caption | schema.js | 架子字段 |
| parse `![alt](url)` | **不存在** | 未做 |
| serialize image | **不存在** | 未做 |
| editor case image | **不存在** | 未做 |
| slash insert.image | **不存在** | 未做 |
| media.uploadImage | 仅 10-data-format 文档 | 未做 |
| video/audio type | 无 | 未做 |
| file_chip | 有 | 可用（路径引用，非上传附件） |

### 5.3 分期做 / 不做

| 能力 | v3.0 | v3.1 | v3.2 | 不做 |
|------|------|------|------|------|
| 图片 parse/serialize/显示 | ✓ | | | |
| 粘贴/拖拽 + upload 端口 | ✓ | | | |
| alt/caption 编辑 | ✓ | | | |
| 标注（箭头/框） | | | 可选 | 默认可降级为 caption |
| 点击放大 | | ✓ | | |
| 客户端压缩 | | | ✓ | |
| 视频/音频块 | | | ✓ | |
| 附件上传二进制进 MD | | | 路径化 | 禁止 base64 巨文件进 MD |

### 5.4 验收

| AC | 标准 |
|----|------|
| AC-M1 | `![示意图](./a.png)` 往返不丢 |
| AC-M2 | 粘贴 png → 调用 `media.uploadImage` → 插入 image 块 |
| AC-M3 | 无 upload 时降级为本地 object URL 并提示不可持久 |
| AC-M4 | 危险协议 `javascript:` 拒绝 |
| AC-M5 | file_chip 点击触发 `onOpenPath` |

### 5.5 接口暗示

```ts
{ type: 'image', path: string /* src */, alt?: string, caption?: string, meta?: { width?: number } }
{ type: 'video', path: string, caption?: string }
{ type: 'audio', path: string, caption?: string }
// 附件可复用 file_chip 或
{ type: 'attachment', path: string, text?: string, meta?: { size?: number, mime?: string } }

interface MountOptions {
  media?: {
    uploadImage?: (file: File) => Promise<{ url: string; alt?: string }>;
    uploadFile?: (file: File) => Promise<{ path: string; label?: string }>;
  };
}
```

---

## 6. 表格（含 U4 / U5）

### 6.1 用户故事

- 作为 PM，在文档里改表格，不想像在 Excel 又不要掉进管道符地狱。  
- 合并表头单元格；单元格里可粗体。  
- 交互有「能用」的 hover +，不是摆设。

### 6.2 现状详细

#### 已具备（可用）

| 能力 | 实现位置 |
|------|----------|
| GFM 表解析 | parse.js |
| cells/rows 双轨同步 | schema createBlock / ensureTableShape |
| 网格 contenteditable | editor renderTableHtml(editable) |
| 底/侧圆形 + 加行加列 | table-chrome enhance |
| 右键：插列/删列/对齐/插行/删行/清空/复制 | handleTableContextAction |
| Tab 循环；末格加行 | onTableKeydown |
| 即时 model 同步 | cell input → tableSetCell |

#### 半成品

| 能力 | 问题 |
|------|------|
| 单元格格式 | 编辑用 `esc(text)`；阅读才 inlineHtml → **进格编辑丢渲染** |
| 列对齐 | 内存 align 有效；**serialize 未写 `:---`** |
| 历史粒度 | 每键 input `addToHistory:false`，结构变更才 true——可接受但需测 |
| 拖列/排序/筛选 | 无 |
| 合并 | **完全无**（U4 硬缺口） |

#### 架子/文档预留

```ts
// 10-data-format.md §3.3
// rowspan?: number; colspan?: number;  // 预留，禁止非 1x1 序列化
```

schema `cloneCells` 仅 `text/header/align`——**无合并字段**。

### 6.3 数据表属性（文本数字日期…）— 做与不做

| 属性类型 | 决策 | 理由 |
|----------|------|------|
| 纯文本单元格 | **做** | 文档表本体 |
| 单元格内 MD marks | **做**（P0） | U4 |
| 数字/日期 **显示格式** | **可选 P3** | 仅格式化，不建类型系统 |
| 标签/状态/人员/公式引擎 | **明确不做** | Notion DB 污染；用 callout/列表代替 |
| 看板视图/过滤视图持久化 | **不做** | X01–X04 |
| 列类型 schema 持久到 MD | **不做** | 无法优雅 GFM 往返 |

### 6.4 合并单元格规格要点（供 03 分册展开）

| 项 | v3 要求 |
|----|---------|
| 模型 | `cells[r][c] = { text, runs?, rowspan?, colspan?, align? }` |
| 锚格 | 仅左上角存文本；被覆盖格 `merged: true` 或省略 |
| MD 往返 | GFM 无原生合并 → Conex HTML 注释或扩展表语法；`pure-gfm` 拆格降级 |
| UI | 多选单元格 → 合并/取消；键盘 |
| 反例 | 只改 colspan 样式不改模型；或合并后 serialize 丢数据 |

### 6.5 验收标准

| AC | 标准 | 优先级 |
|----|------|--------|
| AC-T1 | 点击表进入网格，不出现整表 MD 源 | P0 U4 |
| AC-T2 | 单元格可粗体并往返 | P0 |
| AC-T3 | 合并 2×2 后阅读/编辑/序列化/再打开一致（conex 模式） | P0 U4 |
| AC-T4 | pure-gfm 导出不崩溃，合并降级策略有文档 | P0 |
| AC-T5 | + 按钮 hover 可见、可点、加完聚焦合理 | P0 U5 |
| AC-T6 | 对齐写入 MD 分隔行 | P1 |
| AC-T7 | 拖列/排序/筛选 | P2 v3.2 |

### 6.6 接口暗示

```ts
interface TableCell {
  text: string;
  runs?: TextRun[];
  header?: boolean;
  align?: 'left' | 'center' | 'right';
  rowspan?: number; // default 1
  colspan?: number; // default 1
}

// commands
editor.table.mergeSelection(): void;
editor.table.splitCell(r, c): void;
editor.table.insertRow(index): void;
// events
onTableChange?(blockId: string, table: TableBlock): void;
```

---

## 7. 结构：TOC / 面包屑 / 双链 / 标签 / Backlinks

### 7.1 矩阵

| 功能 | 状态 | P | 版本 | 编辑器职责 | 宿主职责 |
|------|------|---|------|------------|----------|
| TOC | 未做 | P1 | v3.1 | 生成 outline；可选 `toc` 块 | 侧栏挂载 |
| 面包屑 | 未做 | P2 | v3.2 | emit 当前标题 | 路由/文件树 |
| `[[wiki]]` | 半 | P1 | v3.1 | mark + 点击 | 解析标题→文档 |
| `#tag` | 未做 | P1 | v3.1 | mark | 全局标签索引 |
| backlinks | 未做 | P2 | v3.2 | 无 | 图数据库/索引 |
| `[[file:]]` | 可用 | P1 | v3.0 | chip | `onOpenPath` |

### 7.2 现状证据

- Wiki：仅 `[[doc:title]]`（util.js），点击 `onOpenDoc`。  
- 标准 Obsidian 风 `[[title]]`：**未实现**。  
- 无 backlink 查询 API。  
- 演示 SAMPLE **无** 双链样例。

### 7.3 验收

| AC | 标准 |
|----|------|
| AC-S1 | 输入 `[[产品愿景]]` 渲染为 wiki chip |
| AC-S2 | 点击触发 `onOpenDoc('产品愿景')` |
| AC-S3 | `#Q3规划` 渲染标签样式 |
| AC-S4 | `onOutlineChange` 在标题增删时更新 |
| AC-S5 | backlinks 面板由宿主实现；编辑器文档只要求 hook 稳定 |

### 7.4 接口暗示

```ts
MountOptions {
  onOpenDoc?: (title: string) => void;
  onOpenPath?: (path: string) => void;
  onOutlineChange?: (outline: OutlineItem[]) => void;
  onTagsChange?: (tags: string[]) => void;
}
// 宿主 backlinks
Host.getBacklinks(title: string): Promise<Backlink[]>
```

---

## 8. 编辑体验：Slash / 快捷键 / DnD / 转换 / Palette

### 8.1 Slash 命令现状表

现行 `SLASH_COMMANDS`（editor.js）：

| id | title | type | 备注 |
|----|-------|------|------|
| paragraph | 正文 | paragraph | |
| h1–h3 | 标题 | heading | **无 h4–h6** |
| bullet/ordered/task | 列表 | *_item | |
| quote | 引用 | quote | |
| code | 代码块 | code | |
| table | 表格 | table | 3×3 默认 |
| divider | 分割线 | divider | |
| callout | 高亮提示 | callout tip | |
| file | 文件引用 | file_chip | |

**缺失 slash（对照用户清单）**：image、math、mermaid、embed、toggle、H4–6、TOC、视频、AI 子命令…

**Registry**：`MdxRegistry.slashCommands()` 可扩展，但 **editor 未合并 registry 列表**（只吃内置数组）→ registry 对产品 **架子**。

### 8.2 快捷键现状

| 快捷键 | 行为 | 状态 |
|--------|------|------|
| `/` `、` | slash | 可用 |
| Esc | 关 slash → 退编辑 | 可用 |
| Enter | 拆块 | 可用 |
| Backspace 空块 | 合并上块 | 可用 |
| Tab / Shift+Tab | 列表 indent | 可用 |
| Alt+↑/↓ | 移块 | 可用 |
| Ctrl/Cmd+Z / Shift+Z | undo/redo | 可用 |
| Ctrl+B/I/… | 格式 | **未做**（浏览器默认可能部分生效于 contenteditable） |
| Ctrl+K | 链接或 palette | **未做** |
| Ctrl+\ | 演示页源码切换 | 宿主 html，非编辑器核心 |

### 8.3 DnD

| 项 | 状态 |
|----|------|
| 六点把手 | 可用 |
| 落点指示线 | 可用 |
| aria-live 宣布 | 有 announce |
| 拖拽预览幽灵 | 半（class dragging） |
| 嵌套容器内拖拽 | N/A（扁平模型） |

### 8.4 块转换

Slash 对 **当前空触发块** `updateBlock` 改 type → 可算弱「Turn into」。  
缺：

- 非空块上的转换菜单  
- 多选块转换  
- 列表 ↔ 段落批量

### 8.5 Command Palette

全局命令面板 **未做**。v3.1 建议：

```ts
// Ctrl+K
commands: [
  { id: 'export.md', ... },
  { id: 'ai.continue', ... },
  { id: 'turnInto.heading2', ... },
]
```

与 slash **共享注册表**，避免两套词条。

### 8.6 验收

| AC | 标准 |
|----|------|
| AC-E1 | 空段 `/表格` 过滤并插入 3 列表面 |
| AC-E2 | `、` 同等触发 |
| AC-E3 | IME 组合期不误开 slash |
| AC-E4 | 拖块后 getMarkdown 顺序正确 |
| AC-E5 | Ctrl+B 与工具条一致写 marks |
| AC-E6 | registry.register 的 slash **出现在面板** |

---

## 9. AI 增强层（仅端口）

### 9.1 原则（冻结）

- AI **不**写入特殊 block type 作为唯一真源；结果是普通 paragraph/…  
- 端口在 v3.0 定义；实现可 mock。  
- 失败可取消；不污染 undo 语义（一次 AI 插入 = 一笔历史）。

### 9.2 能力端口表

| 端口 id | 用户能力 | 输入 | 输出 | 版本 |
|---------|----------|------|------|------|
| `ai.expand` | 扩写 | 选区/块 | 替换或插入 | v3.0 端口 |
| `ai.shrink` | 缩写 | 同上 | 同上 | v3.0 |
| `ai.rewrite` | 改写 | 同上 | 同上 | v3.0 |
| `ai.translate` | 翻译 | 文本+lang | 文本 | v3.0 |
| `ai.polish` | 润色 | 文本 | 文本 | v3.0 |
| `ai.summarize` | 总结 | 全文/选区 | 新块 | v3.0 |
| `ai.continue` | 续写 | 光标上文 | 插入 | v3.0 |
| `ai.ask` | 问答 | 问题+doc | 回答块 | v3.1 |
| `ai.review` | 审阅 | 全文 | 建议列表（非强写 Doc） | later |

### 9.3 接口暗示

```ts
interface AiPort {
  complete(req: {
    action: 'expand' | 'shrink' | 'rewrite' | 'translate' | 'polish' | 'summarize' | 'continue' | 'ask' | 'review';
    selectionText?: string;
    blockIds?: string[];
    documentMarkdown: string;
    lang?: string;
    prompt?: string;
    signal?: AbortSignal;
  }): Promise<{ text?: string; blocks?: Block[]; notes?: string[] }>;
}

MountOptions {
  ai?: AiPort;
}

// UI：选区条「AI ▾」；slash「AI 续写」；均无 ai 时隐藏
```

### 9.4 验收（端口级）

| AC | 标准 |
|----|------|
| AC-A1 | 未注入 ai 时无报错、无空按钮残骸（或 disabled 提示） |
| AC-A2 | mock ai 返回文本可插入并 undo |
| AC-A3 | 进行中可 Abort |

---

## 10. 版本 / 导入导出 / 科研 / 协作（分期）

| 能力 | 分期 | 编辑器最小交付 | 宿主 |
|------|------|----------------|------|
| 复制/获取 MD | **现已有** | getMarkdown | 演示复制 |
| 导出 HTML | v3.2 | serializeHtml 可选 | 下载 |
| 导出 PDF | v3.2 | 无 | 打印/主软件 |
| 导入 MD | **现有** setMarkdown | 容错 parse | 文件打开 |
| 导入 DOCX | later | 无 | 转换器 |
| 版本历史 | later | getDoc 快照点 | 存储 |
| 脚注/文献 | later | 扩展 mark | 科研插件 |
| 协作 | later+ | 不做 OT | — |

---

## 11. 「演示页必须出现的样例块」清单（Showcase / U1）

> 目标：打开 `markdown-editor.html`（或 v3 showcase）**不靠口嗨** 看齐用户清单。  
> 当前 SAMPLE（产品设计说明）**严重不足**——仅：H1–H3、列表、任务、引用、js 代码、简单表、NOTE callout、hr、段落。

### 11.1 必选样例块（P0 展示）

| # | 样例 | 对应清单 | 建议 MD 骨架 |
|---|------|----------|--------------|
| 1 | 多级标题 H1–H6 | B10 | `#` … `######` |
| 2 | 段落 + 粗/斜/删/码/链 | B02–B08 | 一行内全 marks |
| 3 | 下划线 + 高亮 | B05–B06 | 实现后展示；未实现时 **占位 callout「待 v3」** 不可假装完成 |
| 4 | 无序/有序/多级/任务 | B13–B16 | 缩进 + 混合 |
| 5 | 引用 | B17 | `>` |
| 6 | 五种 Alert | B18 | NOTE/TIP/IMPORTANT/WARNING/CAUTION |
| 7 | 分割线 | B19 | `---` |
| 8 | 代码块 ≥2 语言 | C01 | js + python；**高亮后**可见差异 |
| 9 | 代码复制/行号（实现后） | C02–C03 | 同代码块 chrome |
| 10 | 表格（含合并演示） | T01–T07 | 合并表头「季度｜指标」 |
| 11 | 单元格内格式 | T03 | 格内 **粗体** |
| 12 | 文件芯片 | S06 | `[[file:src/app.ts]]` |
| 13 | 行内 file + wiki | S03 | `[[doc:架构]]` / `[[架构]]` |
| 14 | 标签 | B09 | `#v3 #markdown` |
| 15 | 图片 + caption | M01–M04 | 本地 fixtures 图 |
| 16 | Slash 引导空段 | E01 | 文末 placeholder 说明 |

### 11.2 P1 样例（v3.1 起必须进 showcase）

| # | 样例 | 清单 |
|---|------|------|
| 17 | TOC 区 | B12/S01 |
| 18 | Mermaid 流程图 | C07 |
| 19 | LaTeX 行内 + 块 | C08–C09 |
| 20 | Diff 块 | C10 |
| 21 | AI 端口 mock 按钮区（调试） | A* |
| 22 | 视频/音频占位 | M06–M07 |

### 11.3 明确不要出现在 showcase 的「假完成」

| 禁止 | 原因 |
|------|------|
| 用截图冒充可编辑合并表 | U1 要求真块 |
| 看板/日历插件块 | X01–X03 |
| 仅源码 textarea 整页 | 违反产品方向 |
| 无高亮却写「支持多语言高亮」文案 | 禁止文档与演示欺诈 |

### 11.4 Showcase 信息架构建议

```text
# Conex MDX v3 能力一览
## 1 基础排版
## 2 列表与任务
## 3 提示与引用
## 4 代码与公式
## 5 表格（含合并）
## 6 媒体与附件
## 7 结构与双链
## 8 编辑手势说明（slash / 拖拽 / 快捷键）
## 9 AI 端口（Mock）
## 10 非目标说明（短）
```

---

## 12. 与「空架子」指控的对应

> 指控典型话术：「能点不能用」「注册了没实现」「schema 有字段 UI 没有」。

### 12.1 真·空架子（有名无实）

| 符号 | 位置 | 为何是架子 |
|------|------|------------|
| `image` / `math` / `mermaid` / `embed` | schema `BLOCK_TYPES` | 无 parse/serialize/render/slash |
| `MdxRegistry` | registry.js | 无内置块注册；editor **不读** slashCommands |
| `blocks/*` 目录 | 路线图有、仓库 **无** js/blocks | 模块化未落地 |
| `runs` 优先 | schema + 10-data-format | editor 主路径只写 `text` |
| `media.uploadImage` | 仅文档 | mount options 未实现 |
| `align`→MD | block.align | serialize 忽略 |
| 演示文案「表格 + 可用」 | SAMPLE 表 | 无合并/无高级；**话术超前** |

### 12.2 真·半成品（有主路径但未达 U）

| 项 | 半在何处 | 用户可感知缺陷 |
|----|----------|----------------|
| 行内格式 | 阅读可、编辑裸、无实时 | 不像 Typora/Notion |
| 代码块 | 能写不能亮；textarea 编辑 | 不像成品代码块 |
| 选区工具条 | 仅 4 按钮；无链/下划/高亮 | 格式不全 |
| Callout | 能往返；kind 切换弱 | 高级感不足 |
| 表格 | 能编辑网格；无合并；格格式弱 | U4/U5 未达标 |
| Wiki | 仅 `doc:` 前缀 | 与用户直觉 `[[x]]` 不符 |
| Slash | 核心块有；媒体/公式无 | 清单覆盖不足 |
| 快捷键 | 有编辑骨架；格式键弱 | 效率低 |
| 有序列表 | 显示可用；源码序号不保真 | 可接受的半成品 |

### 12.3 真·可用（可集成依赖）

| 项 | 说明 |
|----|------|
| 扁平 Block 模型 + undo | model.js |
| MD 主往返（基础块） | parse/serialize + 测试 |
| 段落/标题/列表/任务/引用/hr | 主路径 |
| Callout GFM alert | 主路径 |
| 表增删行列对齐 UI | chrome |
| Slash `/` `、` | 主路径 |
| DnD 把手 | 主路径 |
| file_chip + onOpenPath | 主路径 |
| viewOnly | 主路径 |
| mount API | index.js |

### 12.4 指控应答话术（给评审）

> 不是「什么都没有」，而是 **M1–M4 级别的块编辑骨架已可演示**；v3 要打的是 **U2/U3 渲染编辑模型、U4 合并表、U1 清单覆盖、媒体与结构、AI 端口**。  
> schema 里的 image/math/mermaid **现在就是架子**——必须在矩阵里诚实标红，而不是当完成项讲。

---

## 13. 非目标与砍掉理由

| 非目标 | 理由 | 若强做的伤害 |
|--------|------|--------------|
| 看板/CRM/日历/项目管理 | 污染 Markdown 文档定位；与 Conex 文件/任务系统重叠 | 包体膨胀、序列化灾难 |
| Notion Database 属性引擎 | 文档表 ≠ 数据库；公式/人员列无 GFM 真源 | 锁死私有 JSON |
| 任意 HTML 块 | XSS；无法安全往返 | 安全事故 |
| 页顶永久格式栏 | D16 视觉原则；Notion 亦偏选区/slash | 演示页变「旧 Word」 |
| v3 实时协作 | 工程量超过本 reference 目标 | 拖死 v3.0 |
| 单元格计算引擎 | 同 DB | 偏离 MD |
| 图片 base64 默认进 MD | 文件巨大 | 仓库/对话流爆炸 |
| 与对话流 flow-* 样式耦合 | 迁移成本 | 无法 packages 化 |

**砍掉不等于永不做**：协作/版本进 later；轻量「列对齐/排序」可在 **文档表** 层做，不做属性类型系统。

---

## 14. 分块用户故事 × 验收 × 证据 × 缺口 × 依赖（总表）

> 大类压缩表；细项见各章。

| 大类 | 用户故事（一句话） | 关键验收 | 证据 | 缺口 | 依赖 |
|------|--------------------|------------|------|------|------|
| 基础块 | 写结构化说明 | 段标题列表任务引用 hr 往返 | parse/editor | H4 slash、嵌套 quote | 渲染模型 |
| 行内 | 所见即所得格式 | U3 实时 marks | util/toolbar | 高亮下划标签 runs | 04 分册 |
| 代码 | 高亮+单击编辑 | U2 | editor code 分支 | 高亮/复制/行号/去双壳感 | highlighter 端口 |
| 公式图 | 技术表达 | 公式 mermaid diff | schema 名 | 全实现 | KaTeX/Mermaid |
| 媒体 | 贴图即用 | 粘贴上传显示 | schema image | 全实现 | media 端口 |
| 表 | 网格+合并 | U4 U5 | table-chrome | 合并、格 runs、align MD | 03 分册 |
| 结构 | 大纲双链 | TOC/wiki/tag | 半 wiki | 多数未做 | 09 分册 |
| 编辑态 | 手不离键 | slash dnd 快捷键 | editor | palette、格式键、registry 合并 | 05 旧 slash 文 |
| AI | 增强不污染 | 端口 mock | 无 | 全端口 | 08-ai-ports |
| 集成 | 宿主无感 | mount API | index.js | TS 包、media/ai options | 07 迁移 |

---

## 15. 实施接口总表（Block / Mark / API）

### 15.1 BlockTypeId（v3 建议冻结集）

```ts
type BlockTypeId =
  // v3.0 必须闭环
  | 'paragraph'
  | 'heading'
  | 'bullet_item'
  | 'ordered_item'
  | 'task_item'
  | 'quote'
  | 'code'
  | 'table'
  | 'divider'
  | 'callout'
  | 'file_chip'
  | 'image'
  // v3.1
  | 'math'
  | 'mermaid'
  | 'toc'
  | 'embed'
  // v3.2
  | 'video'
  | 'audio'
  | 'attachment'
  // 明确不进入
  // | 'board' | 'database' | 'calendar'
  ;
```

### 15.2 公共 API 增量（相对现 index.js）

```ts
interface MarkdownEditorAPI {
  // 已有
  getMarkdown(): string;
  setMarkdown(md: string): void;
  getDoc(): Doc;
  setDoc(doc: Doc): void;
  flush(): void;
  focus(blockId?: string): void;
  destroy(): void;
  el: HTMLElement;
  // v3 增量
  getSelection(): EditorSelection | null;
  applyTransaction?(tr: Transaction): void;
  commands: {
    toggleMark(type: string, attrs?: object): void;
    insertBlock(type: BlockTypeId, props?: object): void;
    turnInto(type: BlockTypeId, props?: object): void;
    table: { mergeSelection(): void; splitCell(): void /* ... */ };
  };
  on?(event: 'change' | 'selection' | 'outline', cb: Function): () => void;
}

interface MountOptions {
  markdown?: string;
  doc?: Doc;
  viewOnly?: boolean;
  mode?: 'conex' | 'pure-gfm';
  autosaveMs?: number;
  onChange?: (md: string, doc: Doc) => void;
  onOpenPath?: (path: string) => void;
  onOpenDoc?: (title: string) => void;
  onOutlineChange?: (items: OutlineItem[]) => void;
  onSelectionChange?: (sel: EditorSelection | null) => void;
  media?: { uploadImage?: ...; uploadFile?: ... };
  ai?: AiPort;
  highlightCode?: ...;
  renderMath?: ...;
  renderMermaid?: ...;
  className?: string;
  placeholder?: string;
}
```

### 15.3 事件与宿主回调

| 回调 | 触发 | v3 |
|------|------|-----|
| onChange | debounce 编辑 | 已有 |
| onOpenPath | file chip | 已有 |
| onOpenDoc | wiki | 已有 |
| onOutlineChange | 标题变 | 新增 |
| onSelectionChange | 选区 | 新增 |
| ai.complete | 用户点 AI | 新增端口 |

### 15.4 CSS / DOM 契约提示

- 前缀坚持 `mdx-`。  
- 块：`data-block-id` `data-type` `data-state=reading|editing`（建议补 state，现多用 is-editing class）。  
- 代码阅读：`.mdx-code-block` + `.mdx-code-block__highlight`；编辑：同容器 `.is-editing`。  
- 表：保留 `.mdx-table-wrap`；合并格 `rowspan/colspan` 真属性。

---

## 16. 分期实施地图（功能视角）

### 16.1 v3.0（P0 为主，必须可验收 U1–U6 主路径）

| 工作包 | 功能 ID | DoD 摘要 |
|--------|---------|----------|
| WP-Render | E07, C06, B02–B08 | 渲染态编辑 + 代码单壳高亮 |
| WP-Marks | B05,B06, 工具条扩展 | 下划/高亮/链 |
| WP-Table-Merge | T07,T03,T06 | 合并 + 格格式 + align MD |
| WP-Image | M01,M02,M04 | 图块 + 粘贴端口 |
| WP-Slash-Expand | E01,B10 | H4–6、image、math 占位命令 |
| WP-Showcase | U1 | SAMPLE 覆盖 §11.1 |
| WP-AI-Port | A01–A04,A06 | 接口 + mock + 隐藏策略 |
| WP-Registry | E01,E06 | editor 合并 registry |

### 16.2 v3.1

| 工作包 | 功能 ID |
|--------|---------|
| WP-Math-Mermaid | C07–C09 |
| WP-Code-Chrome | C02–C05 |
| WP-Structure | B11,B12,S01,S03,S04 |
| WP-Diff | C10 |
| WP-Palette | E05 |
| WP-Media-View | M05 |

### 16.3 v3.2

| 工作包 | 功能 ID |
|--------|---------|
| WP-Table-Adv | T08–T10 |
| WP-AV | M06,M07 |
| WP-Export | V02,V03 |
| WP-Compress | M03 |

### 16.4 later

版本历史、协作、科研脚注、AI review 真实现、附件体系完善。

---

## 17. 风险与测试矩阵（摘要）

| 风险 | 影响 | 缓解 |
|------|------|------|
| 继续 text 嵌 MD 而非 runs | 实时 mark 做不稳 | v3 强制 runs 真源 |
| 合并单元格 GFM 不可逆 | 数据丢失 | conex 模式扩展 + pure-gfm 降级测试 |
| 高亮库体积 | 包太大 | 懒加载/宿主注入 highlightCode |
| 粘贴 HTML 脏数据 | XSS/混乱 marks | 消毒 + 白名单 |
| Registry 与内置 slash 双轨 | 命令丢失 | 单一合并函数 |
| Showcase 造假 | 验收失真 | §11.3 禁令 |

### 17.1 最低自动化测试清单

| 测试 | 现有 | v3 需要 |
|------|------|---------|
| parse/serialize 基础往返 | 有 roundtrip.test.js | 扩 image/math/callout/align/merge |
| migrate unknown type | 有 | 保留 |
| 合并单元格 migrate | 无 | 必须 |
| runs ↔ md | 无 | 必须 |
| pure-gfm 降级 | 无 | 必须 |
| UI 交互 e2e | 无 | showcase smoke |

---

## 18. 对照旧规格的 delta

| 主题 | 旧规格立场 | v3 矩阵立场 |
|------|------------|-------------|
| 合并单元格 | catalog v2；data-format 禁止非 1x1 | **U4 必须做** |
| 代码交互 | 未强调单壳 | **U2 冻结** |
| 行内实时 | 未强制 | **U3 冻结** |
| image | P2 | 提为 **P0 显示+粘贴**（完整标注可 P1） |
| 数据表属性 | 不做 DB | **维持不做** |
| AI | 原则不进 Doc | **端口分册** |
| 扁平 vs 树 | data-format 扁平胜出 | **确认扁平** |

---

## 19. 逐条对照「用户完整能力清单」（审计清单）

> 用用户原话维度打勾，便于评审签字。

### 19.1 基础

| 用户原话 | 状态 | 备注 |
|----------|------|------|
| 段落 | 可用 | |
| 粗/斜/删 | 半成品 | 缺实时 |
| 下划 | 未做 | |
| 高亮 | 未做 | |
| 行内码 | 半成品 | |
| 链接 | 半成品 | 缺创建 UI |
| 标签 | 未做 | |
| H1–H6 | 可用/slash 半 | |
| TOC | 未做 | |
| 锚点 | 未做 | |
| ul/ol/多级/todo | 可用 | |
| blockquote | 可用 | |
| GitHub alert | 可用 | |
| hr | 可用 | |

### 19.2 代码

| 用户原话 | 状态 |
|----------|------|
| 多语言高亮 | 未做（仅 lang 字段） |
| 复制 | 未做 |
| 行号 | 未做 |
| 行高亮 | 未做 |
| 折叠 | 未做 |
| Mermaid | 架子 |
| LaTeX 行内/块 | 未做/架子 |
| diff | 未做 |

### 19.3 媒体

| 用户原话 | 状态 |
|----------|------|
| 图 拖拽/粘贴/上传/压缩/标题/描述/标注/放大 | 基本未做；schema 字段架子 |
| 视频 | 未做 |
| 音频 | 未做 |
| 附件 | file_chip 半替代 |

### 19.4 表

| 用户原话 | 状态 |
|----------|------|
| MD 表 | 可用 |
| 增强编辑 拖列/排序/筛选 | 未做 |
| 合并 | 未做（硬缺口） |
| 格式 | 半成品 |
| 数据表属性全集 | **明确不做**（见 §6.3） |

### 19.5 结构

| 用户原话 | 状态 |
|----------|------|
| TOC | 未做 |
| 面包屑 | 未做 |
| 双向链接 | 半（doc: 前缀） |
| 标签 | 未做 |
| backlinks | 未做 |

### 19.6 编辑体验

| 用户原话 | 状态 |
|----------|------|
| slash | 可用 |
| 快捷键 | 半成品 |
| 块拖拽 | 可用 |
| 转换 | 半成品 |
| command palette | 未做 |

### 19.7 AI

| 用户原话 | 状态 |
|----------|------|
| 扩写缩写改写翻译润色 | 端口未做 |
| 总结 | 端口未做 |
| 问答 | 端口未做 |
| continue | 端口未做 |
| review | 端口未做 |

### 19.8 其它

| 用户原话 | 状态 |
|----------|------|
| 版本 | later |
| 导入导出 | 半（仅 MD 字符串） |
| 科研 | later |
| 协作 | 不做 v3 |
| 看板 CRM 日历项目 | **明确不做** |

---

## 20. 附录 A — 文件级责任（只读结论）

| 文件 | 行量级（约） | 对矩阵的含义 |
|------|--------------|--------------|
| editor.js | ~1600 | 上帝文件；块 UI 全在此 → v3 需拆 blocks/* |
| parse.js | ~250 | 块级 MD 语法边界清晰，无 image/math |
| serialize.js | ~140 | 对称缺口同 parse |
| schema.js | ~300 | 类型预留超前于实现 |
| util.js | ~150 | 行内能力上限 |
| selection-toolbar.js | ~260 | 格式入口窄 |
| table-chrome.js | ~250+ | 表交互上限（无合并） |
| registry.js | ~80 | 未接线 |
| markdown-editor.html SAMPLE | ~40 行 MD | U1 不合格 |

---

## 21. 附录 B — 验收用例库（可复制到 QA）

### B.1 冒烟（每次提交）

1. 打开演示页，文档非空且无控制台报错。  
2. 点击段落，输入中文，IME 正常。  
3. `/` 打开 slash，插入表格，+ 加一行。  
4. 拖动一块改变顺序，复制 MD 顺序正确。  
5. Ctrl+Z 撤销。  
6. viewOnly 挂载（若 demo 切换）不可编辑。

### B.2 U2 代码

1. 代码块初始无 textarea。  
2. 有语法着色（v3.0 DoD）。  
3. 点击后可改代码；无第二预览窗。  
4. 失焦恢复着色。

### B.3 U3 行内

1. 输入并确认 `**x**` 在编辑中即显示粗体（或等价实时）。  
2. 选区 B/I/S/code/highlight/underline/link 均可。

### B.4 U4 表

1. 永不进入整表 MD 源编辑。  
2. 合并/取消合并。  
3. 格内格式。  
4. 往返 conex 模式。

### B.5 U1 Showcase

1. §11.1 每一行在页面上 **可找到真块**。  
2. 未实现项不得用静态假图冒充。

---

## 22. 附录 C — 反例集（实现 agent 自检）

| 反例 | 为何失败 |
|------|----------|
| 把 image 写进 schema 就算完成 | 架子≠完成 |
| 代码块用「上方 highlight 下方 textarea」满足高亮 | 违反 U2 |
| 合并只用 CSS 隐藏线 | 无模型，复制/序列化错 |
| 标签用全文搜索 `#` 无词边界 | 误伤代码与链接 |
| AI 结果写成 `type:'ai_block'` 唯一真源 | 污染 Doc |
| showcase 用「功能矩阵表」一行字代替真 mermaid | 违反 U1 |
| 引入看板块「只是扩展」 | 违反非目标 |
| serialize 对齐不写回却宣称对齐完成 | 半成品冒充 |

---

## 23. 附录 D — 优先级 backlog（给 10-implementation-plan）

| 序 | 项 | P | 版本 | 依赖 |
|----|----|---|------|------|
| 1 | 行内 runs + 实时渲染 | P0 | v3.0 | 模型 |
| 2 | 代码高亮 + 单壳编辑 | P0 | v3.0 | 1 可并行 |
| 3 | 表格合并 | P0 | v3.0 | cells schema bump |
| 4 | 单元格 runs | P0 | v3.0 | 1,3 |
| 5 | 图片块 + 粘贴 | P0 | v3.0 | media 端口 |
| 6 | Showcase 重写 | P0 | v3.0 | 2–5 部分 |
| 7 | 下划/高亮/链接 UI | P1 | v3.0 | 1 |
| 8 | AI 端口 + mock | P1 | v3.0 | commands |
| 9 | align 进 MD | P1 | v3.0 | serialize |
| 10 | H4–H6 slash + registry 合并 | P1 | v3.0 | slash |
| 11 | TOC + 锚点 | P1 | v3.1 | outline |
| 12 | wiki/tag 完整 | P1 | v3.1 | marks |
| 13 | Mermaid/Math | P1 | v3.1 | 端口 |
| 14 | 代码复制/行号 | P1 | v3.0–3.1 | code chrome |
| 15 | Command palette | P1 | v3.1 | 命令注册表 |
| 16 | Diff | P2 | v3.1 | code |
| 17 | 拖列排序筛选 | P2 | v3.2 | table |
| 18 | 音视频 | P2 | v3.2 | media |
| 19 | 导出 HTML | P2 | v3.2 | serialize |
| 20 | 协作/版本真功能 | P3 | later | 宿主 |

---

## 24. 附录 E — 与 U1–U6 合规检查表

| 约束 | 合规？ | 说明 |
|------|--------|------|
| U1 展示覆盖清单 | **否** | SAMPLE 仅基础子集 |
| U2 代码交互 | **否** | 无高亮；编辑 textarea 形态需重做 |
| U3 文本渲染态编辑 | **否** | innerText 裸编 |
| U4 表网格+合并+格格式 | **部分** | 有网格；无合并；格格式弱 |
| U5 能用级交互 | **部分** | 表 + 与 slash 尚可；整体 polish 不足 |
| U6 文档充分 | **进行中** | 本册为矩阵分册 |

---

## 25. 本册结论 10 条

1. **定位**：当前实现是 **可用的扁平 Block + GFM 主路径 demo 骨架**，不是 v3「清单级完成品」；完成态条数为 **0**。  
2. **U1 失败主因**：`markdown-editor.html` SAMPLE 与 slash 集合远小于用户能力清单；媒体/公式/TOC/AI/合并均缺展示。  
3. **U2 失败主因**：代码块阅读无高亮，编辑切到 textarea+lang，未达到「单击源码态 / 未点高亮预览」的产品形态。  
4. **U3 失败主因**：文本块 `enterEdit` 使用 `innerText` 裸源；`runs` 与实时 marks 未成为主路径。  
5. **U4 最大硬缺口**：**合并单元格**在 data-format 仍为禁止/预留，代码零实现；单元格编辑态还剥离行内格式。  
6. **真架子清单**：`image`/`math`/`mermaid`/`embed` 仅 schema；`MdxRegistry` 未接线；`blocks/*` 目录缺失；`media`/`ai` 仅文档级想象。  
7. **真可用资产**：段/标题/列表/任务/引用/callout/hr/表增删/DnD/slash/file_chip/viewOnly/undo 与 `MarkdownEditor.mount` API——v3 应 **演进而非推倒**。  
8. **明确不做**：看板/CRM/日历/项目管理/Notion DB 属性引擎/任意 HTML/页顶格式栏/v3 协作——避免污染 MD 定位。  
9. **v3.0 最小胜利条件**：实时行内 + 代码单壳高亮 + 表合并与格格式 + 图片主路径 + AI **端口** + showcase 覆盖 §11.1；其余进 v3.1+。  
10. **实施真源 type 名** 以扁平 `paragraph|heading|bullet_item|ordered_item|task_item|quote|code|table|divider|callout|file_chip|image|math|mermaid|…` 为准；API 增量走 `commands`/`media`/`ai`/`highlightCode` 端口，便于迁 `packages/conex-mdx`。

---

## 26. 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| 0.1 | 2026-08-02 | 首版：基于 `js/markdown-editor/**` 与 `markdown-editor.html` 只读审计；对照 U1–U6 与用户完整清单 |

---

*本册结束。下接建议：`02-render-model.md`（U2/U3）、`03-table-advanced.md`（U4）、`06-showcase-demo.md`（U1 样例落地）、`08-ai-ports.md`（A*）。*
