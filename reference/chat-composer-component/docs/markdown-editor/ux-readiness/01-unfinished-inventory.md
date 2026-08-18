# 未完成与半成品总盘点

> **日期**：2026-08-03  
> **物理路径**：`reference/chat-composer-component/docs/markdown-editor/ux-readiness/01-unfinished-inventory.md`  
> **角色**：调度 / Review / 产品验收的「诚实现状表」  
> **权威关系**：本文件优先于 feature-catalog `00-master-index` 中「W* done」乐观标注；与 [00-MASTER-READINESS](./00-MASTER-READINESS.md)、[08-decision-log](./08-decision-log.md) 配套  
> **禁令**：本文 **不写实现代码**；评分以 **用户可感知好用** 为准，不是 harness 绿灯  
> **实现真源**：`js/markdown-editor/*`（vanilla IIFE）；`packages/conex-mdx` 仅为 W10 stub

---

## 0. 结论摘要（一页纸）

### 0.1 一句话

**W0–W10 能力面骨架已铺完（规格厚、模块目录在、主路径大多能点），但几乎没有任何一面达到 feature-catalog 定义的「金标准 5 分」；用户侧仍是「有壳、能改、不好用」。最大结构性锁是单块 `activeId` 模型，它直接导致跨行多选失败、多行源码不可用、批量格式像玩具。**

### 0.2 三层诚实分层

| 层 | 状态 | 含义 |
|----|------|------|
| **规格层 W0** | ✅ 厚 | `feature-catalog` 01–08 ≈ 8.3k 行金标准合同；可指挥验收 |
| **骨架层 W1–W10** | ⚠ shipped skeleton / partial gold | 模块拆出、主路径能跑、部分 harness；**≠ 好用出口** |
| **好用层 U1–U6** | ❌ 未开工 | 跨选 / 行内源策略 / 日常流程摩擦 / 剪贴板·撤销 — 见 00-MASTER |

### 0.3 用户 7 条反馈 → 盘点结论

| # | 用户反馈 | 盘点结论 | 严重度 |
|---|----------|----------|--------|
| 1 | 跨行多选坏了（block-per-row） | **真模型债**：仅 `activeId: BlockId\|null`；拖选途经块会 leave 拆 DOM | **P0** |
| 2 | 多选行应显示源码 | **真缺失 + 依赖 #1**：无 multi-block line-source 会话 | **P0** |
| 3 | 行内粗体等源码标记不好见 | **真半成品**：`runsToEditHtml` 只渲 `<strong>`，定界符策略未拍板（ux-D2） | **P0** |
| 4 | 功能有了但不「好用」 | **系统性**：骨架 3 分级，边界/流程/选区未产品化 | **P0** |
| 5 | AI 必须宿主薄端口、运行时无 mock | **政策已落地**：`ai/ports.js` 无 complete → `no-ai-port`；须持续守门 | **守门** |
| 6 | 命令面板关不掉（部分已修） | **半成品→近可用**：`closePalette` 强制收 DOM；边界仍需回归 | **P1** |
| 7 | 样例数据可 agent；库内禁 mock | **政策清晰**；showcase 质量与 sample 流程仍弱 | **P1** |

### 0.4 分数总览（0–5，合成 2026-08-03）

| 波次 | 能力面 | catalog 标注 | **诚实分** | 标签 |
|------|--------|--------------|------------|------|
| W0 | 规格冻结 | done | **5** | 合同级 |
| W1 | 行源码模型 | done (verify) | **3** | shipped skeleton |
| W2 | 代码单表面 | done (verify) | **3–4** | partial gold |
| W3 | 表格专业面 | done (verify) | **3** | shipped skeleton |
| W4 | 行内 marks | done | **2–3** | partial / 策略未冻 |
| W5 | 列表/标题降级 | done | **3** | shipped skeleton |
| W6 | 媒体+结构 | done | **2–3** | thin main path |
| W7 | Mermaid+公式 | done | **3** | thin peer render |
| W8 | AI 薄端口 + 命令面板 | done (thin) | **4 政策 / 3 面板** | thin OK |
| W9 | 动效基线 | done (baseline) | **3** | baseline only |
| W10 | TS 包脚手架 | scaffold | **1** | stub only |

**金标准出口定义（catalog §6）**：面内所有 P0 F-ID ≥4 且无 0–2。  
**诚实结论**：**0 个 W1–W10 面满足金标准出口**；W0 规格除外。

### 0.5 下一刀切在哪（摘要，详见 §6）

1. **关 ux-D1** → U1 跨块选区（不修则一切「好用」是刷漆）  
2. **关 ux-D2** → U2 行内定界符可见  
3. **日常 15 流程 + 粘贴/撤销**（U2–U3）  
4. **拆 editor.js 上帝文件**（每 U 出口强制）  
5. **明确不做**：AI 重做、Notion DB、整页双模式、引擎换 ProseMirror（本轮）

---

## 1. 波次 W0–W10 完成度评分（0–5）与证据

> 评分口径（对齐 feature-catalog `00-master-index` §6）：  
> **0** 无 · **1** 壳/假按钮 · **2** 主路径能点但模型错 · **3** 主路径对、边界烂 · **4** 边界好、缺动效/a11y · **5** 分册「做到最好」全满足  
> 标签：`contract` / `shipped skeleton` / `partial gold` / `thin` / `stub`

### 1.1 W0 — 规格冻结 · **5 / contract**

| 项 | 内容 |
|----|------|
| **catalog** | done（2026-08-02） |
| **证据** | `feature-catalog/01`–`08` + README + AI-HOST-POLICY；约 8.3k+ 行 |
| **达成** | 每面有 F-ID、做到最好、验收、模块主人；波次依赖图清晰 |
| **缺口** | 与实现脱节：catalog 写「done」后实现仍 partial；需本 inventory 与 U 波次纠偏 |
| **诚实分** | **5**（作为规格合同） |

### 1.2 W1 — 行源码渲染模型 · **3 / shipped skeleton**

| 项 | 内容 |
|----|------|
| **catalog** | done (verify) |
| **模块** | `ui/line-source.js`、`edit/height-lock.js`、`edit/ime-guard.js`、`edit/demotion.js`、`edit/promote.js`；编排仍在 `editor.js` |
| **主路径能跑** | 聚焦标题见灰 `##`；列表 soft `·` / hard `*`；段落 placeholder；`enterEdit`/`exitEdit` |
| **关键证据** | `line-source.js`：`toSourceLine` / `parseSourceLine` / `renderEditSurface`；`editor.js:178` `var activeId = null`；`enterEdit` 先 `exitEdit` 旧块 |
| **harness** | `tests/w1-line-source-harness.js` + `markdown-editor-w1-test.html` |
| **未达金标准** | ① 任意时刻仅一块可编辑 → 跨行选复制失败 ② 高度锁边界（标题/代码/表进出）仍跳 ③ F-CORE-10 激活样式未必全清 ④ 与「多行同时显源」需求冲突 |
| **诚实分** | **3**（主路径对；架构锁死好用） |

**F-CORE 子项快照（相对实现，非规格自报）：**

| F-ID | 诚实 | 说明 |
|------|------|------|
| F-CORE-01 失焦渲染 | 3 | `readContentHtml` 有；精致度/一致性不足 |
| F-CORE-02 聚焦行源 | 3 | 结构前缀有；行内定界符无；跨块无 |
| F-CORE-03 高度锁 | 3 | `height-lock` + lock/unlock；边界跳 |
| F-CORE-04 退格阶梯 | 3 | demotion 模块在；嵌套/合并边界烂 |
| F-CORE-05 列表 * | 3 | soft/hard 有；与跨选/IME 交叉未验 |
| F-CORE-06 代码单表面 | →W2 | — |
| F-CORE-07 表网格 | →W3 | 本册仅「不整表变 pipe」 |
| F-CORE-08 无 sel-bar | 4 | 默认不挂；`selectionToolbar:true` 可选 |
| F-CORE-09 IME | 3 | ime-guard + composition 监听；leave 竞态残留 |
| F-CORE-10 无厚描边 | 3 | 政策有；CSS/`is-active` 仍需审计 |

### 1.3 W2 — 代码单表面 · **3–4 / partial gold**

| 项 | 内容 |
|----|------|
| **catalog** | done (verify) |
| **模块** | `blocks/code-read.js`、`blocks/code-edit.js`、`ui/code-highlight.js`、`ui/code-chrome.js`；`line-source.renderCodeSourceSurface` |
| **主路径** | 失焦轻量高亮；聚焦同卡完整 fence；复制按钮 |
| **harness** | `w2-code-surface-harness.js` |
| **未满** | Diff / 折叠 / 行号 / 语言记忆与自动猜 / 超大文件性能 / 高度锁与 fence 切换跳动 |
| **诚实分** | **3–4**（主路径接近 gold；增值面未做） |

### 1.4 W3 — 表格专业面 · **3 / shipped skeleton**

| 项 | 内容 |
|----|------|
| **catalog** | done (verify) |
| **模块** | `table/selection.js`、`merge.js`、`context-menu.js`、`clipboard-tsv.js`、`ui/table-chrome.js` |
| **主路径** | 网格编辑、框选格、合并拆分、悬停 +、右键、align 序列化、TSV 部分 |
| **关键** | 表多选是 **单元格** 级，**不是**文档跨块多选；与用户「跨行」投诉不是同一问题 |
| **未满** | 列宽持久化、排序筛选、GFM 合并导出策略、格内完整 marks、a11y、跨表选 |
| **诚实分** | **3** |

### 1.5 W4 — 行内 marks 实时 · **2–3 / partial（策略债）**

| 项 | 内容 |
|----|------|
| **catalog** | done |
| **模块** | `inline/marks-model.js`、`live-marks.js`、`keymap-marks.js`；CSS `inline-marks.css` |
| **主路径** | as-you-type 闭合 → `<strong>` 等；`htmlToInlineMd` 往返；Ctrl+B 等快捷键路径 |
| **致命缺口** | `runsToEditHtml`（`marks-model.js` ~275–317）**只输出语义标签，不输出灰 `**` 定界符**；CSS 预留了 `.mdx-src-delim`（「若未来插入」）— **未来未到** |
| **决策** | ux-D2 recommended：Caret 邻域显源；**未 closed** |
| **诚实分** | **2–3**（能粗体，不像 Typora 源；模型未错到 2，但体验接近半成品） |

### 1.6 W5 — 列表/标题降级完备 · **3 / shipped skeleton**

| 项 | 内容 |
|----|------|
| **catalog** | done |
| **模块** | `edit/demotion.js`、`edit/promote.js`；`w5-demotion-harness.js` |
| **主路径** | `*`/`#`/`>`/`1.` 提升；空正文退格阶梯；任务列表 |
| **未满** | 跨块合并、深层嵌套、有序重编号边界、与 live-marks/IME 交叉 |
| **诚实分** | **3** |

### 1.7 W6 — 媒体+结构 · **2–3 / thin main path**

| 项 | 内容 |
|----|------|
| **catalog** | done |
| **模块** | `blocks/image.js`、`blocks/toc.js`、`media/drop-paste.js`；util 内 wiki 片段；schema 有 `callout`/`file_chip`/`embed` |
| **主路径** | 图片 parse/read/源码行；粘贴拖放（无 upload 端口则 blob）；TOC `@[toc]`；`[[doc:]]` 按钮片段 |
| **真架子残留** | `embed` 等 schema 名在、闭环弱；附件芯片/反链/灯箱/题注完整度不足；错误态与上传进度 |
| **诚实分** | **2–3** |

### 1.8 W7 — Mermaid+公式 · **3 / thin peer render**

| 项 | 内容 |
|----|------|
| **catalog** | done |
| **模块** | `blocks/math.js`、`blocks/mermaid.js`；可选 CDN peer |
| **主路径** | 失焦尝试渲染 / 聚焦 `$$` 或 ````mermaid` 源；单表面意图正确 |
| **harness** | `w7-math-mermaid-harness.js` |
| **未满** | 大图高度锁、语法错误 UI、行内 `$` 完备性、无 peer 时降级文案、XSS 边界审计 |
| **诚实分** | **3** |

### 1.9 W8 — AI 端口（薄）+ 命令面板 · **政策 4 / 面板 3**

| 项 | 内容 |
|----|------|
| **catalog** | done (thin) |
| **AI 模块** | `ai/ports.js`（normalize / complete / consumeComplete）、`ai/actions.js`（summarize/rewrite/continue/expand/translate + ghost 流） |
| **政策证据** | `ai:true` **不**启用；无 complete → `{ ok:false, reason:'no-ai-port' }`；与 `AI-HOST-POLICY.md` 一致 |
| **命令面板** | `ui/command-palette.js`：Ctrl/Cmd+P、模糊过滤、Esc/遮罩关闭；`closePalette` 注释写明防「关不掉」强制收 DOM |
| **未满** | 宿主未接 complete 时 AI 不可用（正确）；写回撤销粒度；面板与 slash 命令重复/焦点陷阱边界；viewOnly 命令子集 |
| **诚实分** | **AI 壳 4（薄端口做对了）**；**面板 3**（可用，非金标准） |

### 1.10 W9 — 动效基线 · **3 / baseline**

| 项 | 内容 |
|----|------|
| **catalog** | done (baseline) |
| **模块** | `edit/motion.js` + `css/markdown-editor/motion.css` tokens |
| **达成** | `prefers-reduced-motion`；enter/leave class helpers；时长 token |
| **未满** | catalog 06 A01–A40 全集；slash/表+/工具条微交互打磨；60fps 证明 |
| **诚实分** | **3** |

### 1.11 W10 — TS 包脚手架 · **1 / stub**

| 项 | 内容 |
|----|------|
| **catalog** | scaffold |
| **证据** | monorepo `packages/conex-mdx/`：`src/index.ts` 的 `mount`/`parse`/`serialize` **全部 throw**；类型 + README/MIGRATION/ARCHITECTURE |
| **诚实分** | **1**（壳有类型，无运行时） |
| **是否阻塞好用** | **否**（好用先在 reference 做；迁移并行） |

### 1.12 波次评分总表（可复制）

| 波次 | 诚实分 | 标签 | 好用阻塞？ |
|------|--------|------|------------|
| W0 | 5 | contract | 否 |
| W1 | 3 | shipped skeleton | **是（activeId）** |
| W2 | 3–4 | partial gold | 弱 |
| W3 | 3 | shipped skeleton | 弱（表内） |
| W4 | 2–3 | partial + D2 债 | **是** |
| W5 | 3 | shipped skeleton | 中 |
| W6 | 2–3 | thin | 中 |
| W7 | 3 | thin | 弱 |
| W8 | 3–4 | thin policy OK | 否（宿主责任） |
| W9 | 3 | baseline | 否 |
| W10 | 1 | stub | 否（工程后置） |

---

## 2. 真半成品清单（有壳不好用）

> 判定标准（README §4）：**只做 UI 壳 / 主路径能点但体验错 / 边界烂** = 半成品，不算交付。  
> 每项：**现状证据路径** · **用户可感知问题** · **P0/P1/P2**

### 2.1 P0 — 阻塞「能日用」

#### HP-01 跨行 / 跨块文本多选（架构锁）

| 字段 | 内容 |
|------|------|
| **证据** | `editor.js:178` `var activeId = null`；`enterEdit`（~1410）：`if (activeId && activeId !== id) exitEdit(true)`；规格 01 §2.2「任意时刻至多一个 line-source」；表多选 `table/selection.js` 仅单元格 |
| **用户感知** | 从一段拖到下一段：选区坍塌、块闪回读态、复制只得一块碎片；感觉「不是正经编辑器」 |
| **根因** | block-per-row + 单 active 编辑表面；**无** model 层 `Selection { caret \| range \| block-multi }` |
| **决策** | [08 ux-D1](./08-decision-log.md) recommended（A 分期）；**未 closed** |
| **严重度** | **P0** |
| **关联** | 00-MASTER H1；分册 02-multi-block-selection-analysis |

#### HP-02 多选行应显示源码 — 无会话模型

| 字段 | 内容 |
|------|------|
| **证据** | `renderEditSurface` 仅对 `enterEdit` 的单块生效；无 `selectedIds` / multi line-source paint |
| **用户感知** | 即便能多选，选中的标题/列表也不会像 Typora 那样批量露 `#`/`*`；「看不见源」 |
| **依赖** | HP-01；策略上「选区非空时是否 enter 源」需随 D1 冻结 |
| **严重度** | **P0** |

#### HP-03 行内 bold 等不显示源码标记

| 字段 | 内容 |
|------|------|
| **证据** | `inline/marks-model.js` `runsToEditHtml`：bold → `<strong>` 无 `**`；`css/.../inline-marks.css:79`「可选：若未来插入 `.mdx-src-delim`」；`live-marks.applyLiveMarks` 折叠为标签 |
| **用户感知** | 点进有粗体的句子：只见粗体，不见 `**`；改边界、半删定界符困难；「不是 Markdown 编辑器感」 |
| **决策** | ux-D2 Caret 邻域显源（推荐）；未 closed |
| **严重度** | **P0** |

#### HP-04 日常写作流程「能点不好用」

| 字段 | 内容 |
|------|------|
| **证据** | catalog 大量 F-ID status=partial（01 分册 §F-CORE）；harness 测主路径不测 15 条剧本；00-MASTER H9 |
| **用户感知** | 建标题、进出列表、空块 Enter、slash 后焦点、粘贴一段网页 → 偶发卡顿/丢结构/光标飞 |
| **严重度** | **P0**（体验债集合，非单 bug） |

#### HP-05 高度锁定 / 切块跳动（边界）

| 字段 | 内容 |
|------|------|
| **证据** | `edit/height-lock.js` + `editor.js` lock/unlock 在 enterEdit；代码/表/图/math 分支 DOM 替换幅度大 |
| **用户感知** | 快速点上下块或进出代码 fence，文档「抽一下」 |
| **严重度** | **P0**（F-CORE-03；与信任感强相关） |

#### HP-06 IME 中文组字边界

| 字段 | 内容 |
|------|------|
| **证据** | `edit/ime-guard.js`；editor composition 标志；leave/promote/demote/live-marks 多处 `isComposingNow` 门闩，覆盖不全风险 |
| **用户感知** | 拼音中途切块/回车 → 丢字、拆块、光标跳 |
| **严重度** | **P0**（中文用户硬门槛） |

### 2.2 P1 — 日用质量

#### HP-07 剪贴板 HTML / 富文本粘贴

| 字段 | 内容 |
|------|------|
| **证据** | 粘贴路径分散；ux-D3 recommended（MD 优先，HTML→MD 消毒）；无统一 `clipboard` 模块主人 |
| **用户感知** | 从 Word/浏览器粘贴带脏 span、丢列表层级、或整段变纯文本 |
| **严重度** | **P1** |

#### HP-08 撤销/重做粒度不直觉

| 字段 | 内容 |
|------|------|
| **证据** | `model.js`：整 Doc 快照栈 `pushHistory`；输入路径大量 `addToHistory: false` + 定时 emit；无 mergeKey 产品化 |
| **用户感知** | Ctrl+Z 一次跳太多或跳太碎；AI 插入与打字混栈 |
| **严重度** | **P1** |

#### HP-09 命令面板关闭/焦点（部分已修）

| 字段 | 内容 |
|------|------|
| **证据** | `ui/command-palette.js` `closePalette`（~145）：强制 `hidden` + 去 `is-open`；Esc 全局 capture；遮罩 mousedown；注释「关不掉」 |
| **用户感知** | 历史：Esc 无效、标志与 DOM 不同步；现状：主路径应可关；仍需测：执行命令后焦点、嵌套 dialog、与 slash 同时开 |
| **严重度** | **P1**（回归项，非重做） |

#### HP-10 表格「能用」未满「好用」

| 字段 | 内容 |
|------|------|
| **证据** | W3 模块齐；harness w3；列宽/TSV 边界/合并导出/格内 marks 弱 |
| **用户感知** | 能改格、能合并；复杂表、从 Excel 往返、键盘流仍磕 |
| **严重度** | **P1** |

#### HP-11 代码块增值面

| 字段 | 内容 |
|------|------|
| **证据** | 单表面主路径有；Diff/fold/lang 记忆 catalog 标 P1 未做满 |
| **用户感知** | 日常代码 OK；专业码农场景弱 |
| **严重度** | **P1** |

#### HP-12 媒体/TOC/wiki 薄实现

| 字段 | 内容 |
|------|------|
| **证据** | image/toc/drop-paste 有；wiki 主要在 `util.inlineHtml`；file_chip/embed 弱；上传无端口 blob |
| **用户感知** | 能插图、有目录；附件/双链/灯箱/失败态像 demo |
| **严重度** | **P1** |

#### HP-13 选区工具条历史路径残留

| 字段 | 内容 |
|------|------|
| **证据** | `ui/selection-toolbar.js` 仍在；默认 `selectionToolbar` false（F-CORE-08）；`editor.js:3145+` 可选挂载 |
| **用户感知** | 若宿主误开 → 与「无核心 sel-bar」冲突；核心路径依赖快捷键但快捷键/源可见不足（HP-03） |
| **严重度** | **P1**（默认关则风险可控） |

### 2.3 P2 — 完善面

#### HP-14 Mermaid/公式错误与大图

| 字段 | 内容 |
|------|------|
| **证据** | blocks/math.js、mermaid.js；peer CDN 可选 |
| **用户感知** | 语法错时丑/静默；大图撑布局 |
| **严重度** | **P2** |

#### HP-15 动效全集未做

| 字段 | 内容 |
|------|------|
| **证据** | motion baseline only |
| **用户感知** | 不糙也不「高级」 |
| **严重度** | **P2** |

#### HP-16 Registry 未充分驱动 slash/render

| 字段 | 内容 |
|------|------|
| **证据** | `registry.js` 存在；slash 列表仍大量硬编码于 `slash-menu.js` / editor |
| **用户感知** | 扩展新块类型需改多处；半插件化 |
| **严重度** | **P2**（工程） |

#### HP-17 Showcase / 样本文档质量

| 字段 | 内容 |
|------|------|
| **证据** | `markdown-editor.html` 等 demo；政策要求 sample agent 真 MD；覆盖完整清单仍弱（v3 U1 指控历史） |
| **用户感知** | 演示页像玩具或不全 |
| **严重度** | **P2**（验收与营销） |

---

## 3. 真缺失清单

> **缺失** = 无可用主路径 / 仅 schema 名 / 仅文档 / stub throw。

### 3.1 架构与交互（P0–P1）

| ID | 缺失项 | 证据 | 优先级 |
|----|--------|------|--------|
| M-01 | Model 层跨块 Selection 状态机 | 仅 `activeId`；无 `anchor/focus` Point | **P0** |
| M-02 | `sliceDoc(doc, selection) → {md,text,html?}` | 无纯函数模块 | **P0** |
| M-03 | 块级 multi 视觉（`mdx-block--selected` 产品化） | 无统一选中层 | **P0** |
| M-04 | 拖选过程中禁止 leave 拆 DOM 的会话 | enter/leave 与 pointer 未解耦 | **P0** |
| M-05 | 行内定界符 DOM（`.mdx-src-delim` 运行时插入） | CSS 预留，JS 未生成 | **P0** |
| M-06 | Caret 邻域显源算法 | ux-D2 仅文档 | **P0** |
| M-07 | 统一剪贴板策略模块 | ux-D3 未落地代码 | **P1** |
| M-08 | History mergeKey / 事务标注 | 仅整文档快照 | **P1** |
| M-09 | 查找替换 | 无 | **P2** |
| M-10 | 版本历史 UI（快照 diff 回滚） | catalog F-HIST P2；无实现 | **P2** |

### 3.2 块与扩展

| ID | 缺失项 | 证据 | 优先级 |
|----|--------|------|--------|
| M-11 | `embed` 块闭环 | schema 有 type；parse/render 弱或无 | **P2** |
| M-12 | 音视频块 | catalog F-VID/AUD P2 | **P2** |
| M-13 | 附件芯片完整协议 | file_chip schema；交互端口薄 | **P1–P2** |
| M-14 | `#tag` 标签 | catalog P2 | **P2** |
| M-15 | 代码 Diff 语义 | F-CODE-DIFF P1 | **P1** |
| M-16 | 代码折叠/行号 | F-CODE-FOLD P1 | **P2** |
| M-17 | 表排序筛选 | F-TBL-SORT P2 | **P2** |
| M-18 | 表列宽拖持久化完整策略 | F-TBL-RESIZE P1 | **P1** |
| M-19 | PDF/Word/LaTeX 导出 | F-IO 宿主适配；编辑器侧中间层薄 | **P2** |
| M-20 | 实时协作 / OT / CRDT | F-COL **P3 明确后置** | **P3** |

### 3.3 工程与包

| ID | 缺失项 | 证据 | 优先级 |
|----|--------|------|--------|
| M-21 | `@conex/mdx` 真 mount/parse/serialize | `packages/conex-mdx/src/index.ts` throw | **P1 工程**（不挡 U1 好用） |
| M-22 | editor-controller 薄编排拆分 | charter 目标；`editor.js` ~3200+ 行仍上帝 | **P0 工程** |
| M-23 | W4/W6/W8/W9 自动化 harness | 仅有 w1/w2/w3/w5/w7 | **P1** |
| M-24 | 跨块选区 / 行内 delim 验收脚本 | 无 | **P0**（U1/U2 DoD） |
| M-25 | CI 行数门禁（单文件 ≤400 业务） | 文档有，CI 未见强制 | **P1** |

### 3.4 宿主集成（库外但影响「好用」判定）

| ID | 缺失项 | 说明 | 优先级 |
|----|--------|------|--------|
| M-26 | Conex 主软件注入 `ai.complete` | 无端口则 AI 入口正确隐藏；**真 AI 不在编辑器范围** | 宿主 P1 |
| M-27 | `uploadImage` / `resolveUrl` / `onOpenDoc` | 端口形状有；宿主未接则 blob/空操作 | 宿主 P1 |
| M-28 | Desktop 消费 `@conex/mdx` | 现应仍挂 reference | 宿主 W10+ |

---

## 4. 工程债务

### 4.1 `editor.js` 上帝文件

| 维度 | 现状 |
|------|------|
| **体量** | `js/markdown-editor/editor.js` **约 3236 行**（文件头至 `window.MdxEditor`） |
| **职责堆叠** | 读渲染、enter/exit 全类型分支、表 mutation、slash、DnD 把手、AI 接线、命令面板命令表、选区工具条、media bind、viewOnly 拦截、键盘… |
| **宪章** | `v3-complete/11-no-god-file-charter.md`：**禁止继续堆**；只允许删减/接线；新逻辑进模块 |
| **catalog** | 08 包模块 + 00：单文件业务 ≤400 行；`editor.js` 只保留编排 |
| **现实** | W1–W8 已拆出不少模块，但 **编排+大段逻辑仍在 editor.js**；每次「再加一点」仍进此文件 |
| **风险** | 多 agent 冲突；回归成本高；U1 Selection 若再堆入 → 不可维护 |
| **债务动作（不写实现）** | U 波次强制：`edit/selection/*`、`edit/enter-exit`、`commands/*` 新目录；editor 只 `createEditor` 接线 |

### 4.2 模块地图（已有 vs 债）

**已相对健康的切片（可继续加厚，勿回流 editor）：**

```
ai/ports.js, ai/actions.js
blocks/{code-read,code-edit,image,math,mermaid,text-read,toc}.js
edit/{demotion,height-lock,ime-guard,motion,promote}.js
inline/{keymap-marks,live-marks,marks-model}.js
media/drop-paste.js
table/{clipboard-tsv,context-menu,merge,selection}.js
ui/{code-chrome,code-highlight,command-palette,line-source,slash-menu,table-chrome,selection-toolbar}.js
schema.js, model.js, parse.js, serialize.js, registry.js, util.js, index.js
```

**明确缺失/过薄的切片（宪章已点名）：**

| 目标路径（心智） | 现状 |
|------------------|------|
| `edit/selection/*` | **无** → U1 |
| `edit/enter-exit.js` | 逻辑在 editor `enterEdit`/`exitEdit` |
| `edit/clipboard/*` | **无** 统一主人 |
| `render/read-view.js` | 读 HTML 仍大量在 editor `readContentHtml` |
| `ui/dnd.js` | DnD 在 editor 把手路径 |
| `editor-controller.js` | **无**；createEditor 即上帝 |

### 4.3 测试覆盖

| 类型 | 现状 | 缺口 |
|------|------|------|
| **Node 往返** | `tests/markdown-editor/roundtrip.test.js`（schema/parse/serialize/table 纯函数） | 不覆盖 DOM 编辑 |
| **DOM harness** | w1 行源、w2 代码、w3 表、w5 降级、w7 math/mermaid | **无 w4 marks、无 w6 媒体、无 w8 AI/面板、无 w9 动效** |
| **跨块选区** | **0** | U1 门禁测试 |
| **行内 delim** | **0** | U2 门禁测试 |
| **IME 剧本** | 弱 | 需人工/专用 harness |
| **命令面板关闭** | 无自动化 | 回归「关不掉」 |
| **视觉/ E2E** | 无 playwright 基线 | P2 |
| **包测试** | conex-mdx 无运行时可测 | stub 阶段可接受 |

### 4.4 脚本加载顺序债务

`index.js` 头部注释固定顺序（W1–W8）：

```
util → code-highlight → schema → model → parse → serialize → registry
→ line-source → slash-menu
→ height-lock → ime-guard → demotion → promote → motion
→ text-read → code-read → code-edit → mermaid → math → image → toc → drop-paste
→ table/* → table-chrome → code-chrome
→ ai/ports → ai/actions → command-palette
→ (optional) selection-toolbar
→ editor.js → index.js
+ optional peers: katex, mermaid CDN
```

| 风险 | 说明 |
|------|------|
| **顺序脆弱** | 漏脚本 → `MdxEditor core missing` 或功能静默降级（`if (LineSrc())` 分支） |
| **全局 window 前缀** | `Mdx*` 污染；多实例纪律靠约定 |
| **demo HTML 多入口** | w1–w3/w5/w7 与主 `markdown-editor.html` 需各自对齐顺序 |
| **迁移出路** | W10 ESM 单入口消解顺序债；**当前未完成** |

### 4.5 双栈与文档债

| 项 | 说明 |
|----|------|
| **reference IIFE vs packages/conex-mdx** | 真能力仅 reference；包 stub；desktop 勿误用 mount |
| **v3-complete vs feature-catalog** | catalog 新权威；v3 算法草稿；冲突以 catalog + **ux-readiness** 为准 |
| **W done vs U 未开工** | 00-MASTER 已声明 U 可推翻 W 金标准出口；本 inventory 落实重打分 |
| **中文编码** | Agents 约定 UTF-8 无 BOM；PowerShell 重定向风险 |

### 4.6 安全与端口债（简）

| 项 | 状态 |
|----|------|
| AI mock | **禁止且实现已守** |
| 图片 src 协议白名单 | image.js `isSafeSrc` 有 |
| 链接 javascript: | marks-model 编辑态降级 `#` |
| AI 写回消毒 | 政策有；与粘贴同路径完整度待验 |
| XSS 全矩阵 | 未系统审计 |

---

## 5. 与「好用」的差距（非功能点凑齐）

> 本节回答：为什么 catalog 勾了很多、用户仍说不好用。

### 5.1 功能点 ≠ 产品完成

| 维度 | 骨架交付（W） | 好用交付（U） |
|------|---------------|---------------|
| 单元 | 单块主路径 | 跨块连续写作 15 分钟不卡 |
| 测试 | harness 点绿 | 真实剧本 + 边界 + IME |
| 模型 | 块类型齐全 | **选区模型**一等公民 |
| 视觉 | 有渲染 | 源/渲策略符合 Typora 预期 |
| 政策 | AI 薄端口 | 宿主接上后动作可撤销、可取消、可预期 |
| 工程 | 有目录 | 无上帝文件、可并行 agent |

### 5.2 用户可感知差距地图

```
用户期望（Typora 行源 + Notion 块感）
        │
        ▼
┌───────────────────┐     ┌────────────────────────────┐
│ 单块聚焦：大致有   │ ──► │ 跨块拖选：基本没有（P0 锁）  │
│ 代码单表面：大致有 │     │ 多行显源：没有               │
│ 表网格：大致有     │     │ 行内 ** 可见：没有（D2）     │
│ slash/DnD：有      │     │ 粘贴干净：弱                 │
│ AI 入口：政策正确  │     │ 撤销粒度：弱                 │
└───────────────────┘     └────────────────────────────┘
        │
        ▼
  感知：「半成品 / 能点 / 不像专业编辑器」
```

### 5.3 「好用」成功判据（与 00-MASTER §9 对齐，验收用）

实现方达到下列才可宣称「好用就绪」子集（完整 10 条见 00）：

1. **跨段拖选**复制得到连续 MD，过程中块不闪回 read  
2. **块 multi** 批量删除/变列表可用  
3. 聚焦编辑时 **结构前缀** 可见且不跳  
4. 行内 mark **需要时**可见定界符（D2 策略）  
5. as-you-type `**` `*` `` ` `` `~~` 稳定 + IME 不烂  
6. 中文组字全程不丢字不跳块  
7. 代码无双壳；表保持网格  
8. 无端口时无 AI 菜单；有端口时可 Abort + 一条 undo  
9. 命令面板稳定开闭  
10. 新逻辑不进 editor.js 堆（行数不继续涨）

**当前对照**：1–2 **失败**；3 **部分**；4 **失败**；5 **部分**；6 **风险**；7 **主路径过**；8 **政策过**；9 **近过**；10 **失败**。

### 5.4 摩擦类型学（非新功能）

| 摩擦类型 | 例子 | 修复层 |
|----------|------|--------|
| **模型摩擦** | 选不了跨行 | Selection 状态机 |
| **策略摩擦** | 粗体看不见 `**` | D2 冻结 + 渲染 |
| **生命周期摩擦** | 拖选时 DOM 被拆 | enter/leave 与 pointer 解耦 |
| **粒度摩擦** | 撤销整页跳 | history merge |
| **消毒摩擦** | 粘贴脏 HTML | clipboard 策略 |
| **信任摩擦** | 布局跳、IME 丢字 | height-lock / ime 边界 |
| **发现摩擦** | 命令/ slash 重复弱提示 | 面板文案与键盘图 |
| **工程摩擦** | 改不动、易回归 | 拆上帝文件 |

### 5.5 与 v3 executive-gap 的继承关系

`v3-complete/00-executive-gap.md`（2026-08-02）曾写：**0 项可标完成**；指控空架子/双壳/表无合并等。  

**之后 W 波次已消化一部分**：

- 文本不再普遍 `innerText=裸 MD`（line-source 表面）  
- 代码单表面方向落地  
- 表合并/框选落地  
- AI mock 政策收紧（历史「Mock 端口 v3.0」作废 → AI-HOST-POLICY）  

**仍继承的核心指控**：

- 「能点不能用」  
- 展示覆盖不全  
- 动效弱  
- **编辑模型未到金标准**（现升级为：activeId 锁 + 行内源策略）

---

## 6. 建议下一波优先级（只排序，不写实现）

> 与 00-MASTER U1–U6 对齐；此处给 **调度排序** 与 **门禁**。

### 6.1 总序（强制依赖）

```
关 ux-D1 ──► U1 跨块选区 / multi / 复制切片
                │
关 ux-D2 ──► U2 行内定界符 + 日常流程摩擦清零（可与 U1 后半重叠讨论）
                │
关 ux-D3 ──► U3 剪贴板 + 撤销粒度
                │
             U4 表/代码/图/公式残留打磨
                │
             U5 showcase 真样本 + harness 补全
                │
             U6（可选并行）包迁移加深 / 查找 / a11y 满
```

**全程并行守门**：AI 无 mock · 不堆 editor.js · 中文 IME 回归 · F-CORE-08 无默认 sel-bar

### 6.2 优先级列表（P0 → P2）

| 序 | 项 | 波次 | 门禁 | 说明 |
|----|-----|------|------|------|
| 1 | **关闭 ux-D1**（Selection 模型拍板） | 决策 | 产品确认 | 无决策不写 U1 |
| 2 | **U1a** block-multi + 单块 range + 复制删除 | U1 | D1 closed | 地板 |
| 3 | **U1b** 跨块 range + sliceDoc | U1 | U1a DoD | 好用判据 #1 |
| 4 | **关闭 ux-D2** | 决策 | 产品确认 | |
| 5 | **U2** 行内 delim 邻域显源 + as-you-type 稳 | U2 | D2 closed | HP-03 |
| 6 | **U2** IME / 高度锁 / 15 流程摩擦 | U2 | 与 5 同波 | HP-04/05/06 |
| 7 | **关闭 ux-D3** + **U3** 粘贴 | U3 | D3 | HP-07 |
| 8 | **U3** 撤销 mergeKey 产品化 | U3 | | HP-08 |
| 9 | **U4** 表/代码残留（TSV 边界、列宽、lang、错误态） | U4 | | HP-10/11 |
| 10 | **U4** 媒体/wiki/callout 主路径加厚 | U4 | | HP-12 |
| 11 | **命令面板回归套件** | 随时 | | HP-09 |
| 12 | **拆 editor.js**（每 U 出口行数不增） | 全程 | charter | §4.1 |
| 13 | **harness 补 W4/W6/W8 + U1/U2** | U1–U5 | | §4.3 |
| 14 | **U5** sample agent 真长文 showcase | U5 | | HP-17 |
| 15 | **W10** 包迁移阶段 B–C（parse/serialize 先迁） | 并行 | 不挡 U1 | M-21 |
| 16 | 查找替换 / 历史 UI / 协作 | 后置 | | M-09/10/20 |
| 17 | 动效满配 A01–A40 | 后置 | | HP-15 |

### 6.3 明确「先不做实现、先做决策」的三项

1. **ux-D1** 多选模型（A 分期 vs C 仅块 multi）  
2. **ux-D2** 行内源可见（邻域 vs 整块 raw — raw 已否）  
3. **ux-D3** 粘贴 HTML 优先级  

### 6.4 调度口令（给 orchestrator）

- 一轮 ≤12 agent；**U1 编码前 D1 必须 closed**  
- 同文件串行：`editor.js` 只允许「接线 PR」，业务进新目录  
- Review 对照本 inventory §2–§3 与 00 成功判据，**禁止**用「W done」抵好用验收  
- AI：只审 `ports.js` 无 mock 回归；宿主 complete 在 apps 侧

---

## 7. 明确不做（本轮 / 产品边界）

> 写死以免 agent 扩张范围。与 feature-catalog、AI-HOST-POLICY、00-MASTER 一致。

### 7.1 产品永不 / 非目标

| 项 | 理由 |
|----|------|
| **Notion Database / 看板 / CRM / 属性引擎** | 编辑器定位：MD 原生 + 块 UX；DB 是另一产品 |
| **整页「预览 ‖ 源码」硬双模式** | cross-D3；行/块级行源码 |
| **以 `mdx-sel-bar` 为核心格式路径** | F-CORE-08；可选扩展仅 |
| **代码双壳**（上高亮下 textarea） | U2/F-CORE-06 禁止 |
| **编辑器内置 LLM / mock complete / 假摘要** | AI-HOST-POLICY；样例用真 MD 文件 |
| **OT/CRDT 实时协作（v 当前）** | F-COL P3 |
| **把 React/ProseMirror 塞进核心本轮重写** | 内核保持无框架；换引擎单独立项 |

### 7.2 本轮 U 波次明确不做

| 项 | 说明 |
|----|------|
| **AI 能力重做 / 新动作大全** | 薄端口 + 现有 5 action 足够；真智能在宿主 |
| **AI 页顶常驻大条** | 入口 = slash / 面板 / 可选快捷键 |
| **完整 PDF/Word 导出引擎** | 宿主适配器 |
| **音视频块精品** | P2 后置 |
| **表排序筛选、代码 Diff 精品** | 不挡 U1–U3 |
| **动效满配秀** | baseline 已够；打磨后置 |
| **packages/conex-mdx 一次迁完** | 脚手架可并行；**不**作为好用门禁 |
| **为 demo 在库内写 mock AI** | 永远禁止 |
| **继续向 editor.js 堆 U1 Selection 三千行** | 必须新模块 |

### 7.3 允许但不算「编辑器完成」的事

| 项 | 说明 |
|----|------|
| sample-data agent 写 `samples/*.md` / demo 字符串 | 真 GFM + 扩展语法 |
| 宿主注入 complete / uploadImage / onOpenDoc | 集成工作 |
| reference 继续作实验室 | 直至包可 mount |
| 可选 `selectionToolbar:true` | 非默认、非核心 |

### 7.4 政策守门检查表（每 PR）

- [ ] 未新增 `ai/ports` mock 分支或 `【Mock` 文案  
- [ ] 未默认挂载 `mdx-sel-bar`  
- [ ] 未引入代码双壳  
- [ ] `editor.js` 行数未无故增加业务（或同步拆出）  
- [ ] 中文注释/文档 UTF-8  
- [ ] 新 F-ID 有模块主人路径  

---

## 附录 A — 目录与文件证据索引

| 路径 | 用途 |
|------|------|
| `docs/markdown-editor/feature-catalog/00-master-index.md` | W 波次官方标注（乐观） |
| `docs/markdown-editor/feature-catalog/README.md` | F-ID 鸟瞰 + 金标准判据 |
| `docs/markdown-editor/feature-catalog/AI-HOST-POLICY.md` | AI 运行时 vs 样本 |
| `docs/markdown-editor/feature-catalog/01-*.md` | 行源码金标准与 partial 自陈 |
| `docs/markdown-editor/v3-complete/00-executive-gap.md` | 历史总差距 |
| `docs/markdown-editor/v3-complete/11-no-god-file-charter.md` | 上帝文件禁令 |
| `docs/markdown-editor/ux-readiness/00-MASTER-READINESS.md` | 好用总纲 U1–U6 |
| `docs/markdown-editor/ux-readiness/08-decision-log.md` | ux-D1/D2/D3 |
| `js/markdown-editor/editor.js` | ~3236 行编排上帝文件；`activeId` |
| `js/markdown-editor/ui/line-source.js` | 行源表面 |
| `js/markdown-editor/inline/marks-model.js` | runs；无 delim HTML |
| `js/markdown-editor/inline/live-marks.js` | as-you-type |
| `js/markdown-editor/ai/ports.js` | 薄端口无 mock |
| `js/markdown-editor/ui/command-palette.js` | 关闭修复 |
| `js/markdown-editor/tests/w*-*harness.js` | 骨架验收 |
| `packages/conex-mdx/src/index.ts` | W10 stub throw |
| `css/markdown-editor/inline-marks.css` | `.mdx-src-delim` 预留 |

## 附录 B — 半成品 / 缺失 ID 速查

| 严重度 | 半成品 HP | 缺失 M |
|--------|-----------|--------|
| P0 | HP-01…06 | M-01…06, M-22, M-24 |
| P1 | HP-07…13 | M-07…08, M-13, M-15, M-18, M-21, M-23, M-25–27 |
| P2 | HP-14…17 | M-09…12, M-14, M-16–17, M-19 |
| P3 | — | M-20 协作 |

## 附录 C — 与 catalog「done」话术对照（对外沟通）

| 对外可说 | 不可说 |
|----------|--------|
| 「W1–W9 骨架已落地，可演示主路径」 | 「Markdown 编辑器已做完」 |
| 「AI 仅宿主端口，无内置假模型」 | 「AI 写作已就绪」（宿主未接时） |
| 「表支持合并与框选」 | 「表格专业软件级」 |
| 「行源码模型已接入」 | 「跨行选择与 Typora 一致」 |
| 「正在 U1 解决选区架构债」 | 「只差 CSS 打磨」 |

## 附录 D — Changelog

| 日期 | 变更 |
|------|------|
| 2026-08-03 | 初版：W0–W10 诚实重打分；HP/M 清单；工程债；好用差距；优先级；明确不做 |

---

**结束语**：本盘点的核心诚实句——**骨架波次可以叫 shipped skeleton / partial gold / thin / stub，不能叫金标准完成。** 下一刀是 **ux-D1 → U1 选区**，不是再堆功能点。
