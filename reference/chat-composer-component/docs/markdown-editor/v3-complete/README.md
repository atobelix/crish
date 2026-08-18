# Markdown 编辑器 v3 — 完整化规格库

> **目的**：从「半 demo 架子」升级为 **可迁移、可集成、功能填满** 的 Markdown 原生 + Notion 类体验 + AI 端口编辑系统。  
> **读者**：实现 agent、主软件适配、产品验收。  
> **原则**：Markdown 是底层；Block 是体验；渲染态默认；源码态按需（代码块整块 / 单元格内联）。  
> **语言策略**：实现向 **TypeScript 包**（`packages/conex-mdx`）收敛，降低迁 desktop 成本；reference 可先 dual 或一次性迁 TS。

---

## 0. 用户硬约束（本轮冻结）

| ID | 约束 |
|----|------|
| U1 | **展示页必须覆盖**用户给出的完整能力清单（基础 MD / 代码 / 媒体 / 表 / 结构 / 编辑体验 / AI 槽 / 导入导出占位），不是几个玩具块 |
| U2 | **未聚焦 = 正常渲染**；代码块未点 = 高亮预览；**点击代码块 = 源码编辑态**（禁止「上面预览框 + 下面输入框」双壳） |
| U3 | **其它文本块**编辑时仍以渲染态为主：语法生效区域显示为格式化结果（Typora/Notion 向），不是整行裸 MD 源 |
| U4 | **表格**编辑保持结构化网格（不整表 MD 源）；单元格内支持格式；**合并单元格**必须做 |
| U5 | 表格与全局功能从「能点」升级到「能用」；动效与微交互完整 |
| U6 | 文档充分（维度分册，总长可数千～上万行）；代码易迁移 |

---

## 1. 分册地图

| 册 | 文件 | 维度 |
|----|------|------|
| 00 | [00-executive-gap.md](./00-executive-gap.md) | 总差距与优先级 |
| 01 | [01-feature-matrix.md](./01-feature-matrix.md) | 全功能矩阵 vs 现状 |
| 02 | [02-render-model.md](./02-render-model.md) | 渲染/编辑模型、代码块、实时 marks |
| 03 | [03-table-advanced.md](./03-table-advanced.md) | 表格全能力含合并 |
| 04 | [04-inline-marks-live.md](./04-inline-marks-live.md) | 行内语法实时生效 |
| 05 | [05-motion-system.md](./05-motion-system.md) | 动效与微交互 |
| 06 | [06-showcase-demo.md](./06-showcase-demo.md) | 演示页内容与信息架构 |
| 07 | [07-package-migration.md](./07-package-migration.md) | TS 包结构与迁移 |
| 08 | [08-ai-ports.md](./08-ai-ports.md) | AI 增强层端口 |
| 09 | [09-media-structure.md](./09-media-structure.md) | 媒体/结构/目录/双链 |
| 10 | [10-implementation-plan.md](./10-implementation-plan.md) | 实施 DAG 与 DoD |

分析 agent 产出写入上表；合成后由 orchestrator 写 00 与 10。

---

## 2. 与旧文档关系

- `10-data-format.md` / `11-system-architecture.md` 仍有效；**v3 在其上升级**（尤其表格合并、TextRun 实时、代码块模式）。  
- 冲突时以 **本目录 U1–U6 + 各分册冻结节** 为准，并回写 CROSSCUTTING。

---

## 3. 状态

| 项 | 状态 |
|----|------|
| 多维分析 | ✅ 五路 agent |
| 分册文档 | ✅ 约 **9.3k+** 行（00–10） |
| Wave 1 实施 | 进行中（U2/U3/U1/U4 部分已合入 reference） |

### Wave 1 已合入（reference）

- 文本 focus-render：编辑填 `inlineHtml`，非裸 MD  
- 代码：读态轻量高亮 + 点击同卡源码（`ui/code-highlight.js`）  
- 实时 marks 轻量 `applyLiveMarks`  
- 表：`tableMerge` / `tableSplit` + 拖选 + 右键合并  
- showcase SAMPLE 扩为完整能力活文档  

### 仍待 Wave 1–2

- marks 选区恢复 / 完整 04 算法  
- 表 TSV、列宽、GFM 合并导出策略完善  
- Mermaid/KaTeX 真渲染、媒体块、AI mock UI  
- `packages/conex-mdx` TS 抽取（见 07） |
