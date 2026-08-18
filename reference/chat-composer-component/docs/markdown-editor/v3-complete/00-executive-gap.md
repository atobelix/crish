# 00 — 总差距与优先级（Executive Gap）

> **合成日期**：2026-08-02  
> **输入分册**：01–09（合计约 **9.3k 行**）  
> **用户指控对齐**：「空架子 / 半 demo / 功能弱 / 代码双壳 / 编辑裸源 / 表无合并 / 展示不全 / 缺动效」

---

## 1. 一句话结论

当前 `js/markdown-editor` 是 **可用的块编辑骨架**，不是完整产品：主路径（段/标题/列表/表增删/slash/DnD）能跑，但 **U2/U3 渲染模型、U1 展示覆盖、U4 表合并、实时 marks、媒体/公式/Mermaid、动效** 均未达标。**0 项**可标「完成」。

---

## 2. 硬约束达成度

| ID | 约束 | 现状 | 目标版本 |
|----|------|------|----------|
| U1 | 展示页覆盖完整清单 | SAMPLE 玩具级 | v3.0 |
| U2 | 代码：读高亮 / 点源码 / 禁双壳 | 读无高亮；edit=textarea 可收敛为单表面 | v3.0 |
| U3 | 文本编辑仍像渲染；语法实时生效 | `enterEdit` 用 `innerText=裸 MD` | v3.0 |
| U4 | 表网格编辑 + 合并 + 强功能 | 无 merge；格内无 marks；serialize 丢 align | v3.0–3.1 |
| U5 | 动效微交互 | 极弱 | v3.0 基线 + v3.1 满 |
| U6 | 文档+易迁移 | 本目录 9k+ 行规格；TS 包见 07 | 并行 |

---

## 3. 「真半成品 / 真架子」清单（摘自 01）

### 真半成品（有但体验错）

| 项 | 证据 |
|----|------|
| 文本编辑 | `enterEdit` → `innerText = block.text` |
| 代码块 | 读态无高亮；编辑替换为 textarea 观感像「另一个框」 |
| 行内格式 | 读态 `inlineHtml`；工具条 execCommand；无 as-you-type |
| 表格 | +/右键有；无合并、无框选、align 序列化丢、格内纯文本 |
| wiki | 仅 `[[doc:]]` 片段 |
| Registry | 存在但未驱动 slash/render |

### 真架子（名字在 schema）

`image` / `math` / `mermaid` / `embed` — 无 parse/render 闭环。  
`media` / `ai` 端口 — 仅文档。

---

## 4. 分册索引与职责

| 册 | 行量级 | 实施时必读 |
|----|--------|------------|
| [01-feature-matrix](./01-feature-matrix.md) | ~1.4k | 功能状态与 P0 清单 |
| [02-render-model](./02-render-model.md) | ~2.4k | **U2/U3 状态机与算法** |
| [03-table-advanced](./03-table-advanced.md) | ~1.3k | **合并与表 API** |
| [04-inline-marks-live](./04-inline-marks-live.md) | ~0.7k | 实时 marks / 弃用 execCommand |
| [05-motion-system](./05-motion-system.md) | ~0.5k | A01–A27 动效 |
| [06-showcase-demo](./06-showcase-demo.md) | ~0.8k | 展示页 SAMPLE 全文 |
| [07-package-migration](./07-package-migration.md) | ~0.7k | `packages/conex-mdx` TS |
| [08-ai-ports](./08-ai-ports.md) | ~0.7k | AI 端口 |
| [09-media-structure](./09-media-structure.md) | ~0.8k | 媒体/TOC/双链 |
| [10-implementation-plan](./10-implementation-plan.md) | 本轮合成 | **执行入口** |

---

## 5. v3.0 必须交付（砍了演示失败）

1. 文本 focus-render：编辑 DOM 为 **已渲染 HTML**，提交 `htmlToInlineMd` / runs  
2. 代码：读态高亮 + **互斥**源码层（单卡片）  
3. as-you-type 至少 `**` `*` `` ` `` `~~`（04）  
4. 表：`rowspan/colspan` 合并/拆分 + 框选 + align 序列化  
5. showcase 长文覆盖清单主路径（06）  
6. 动效基线：slash / 工具条 / 表 + / 块切换（05 子集）  
7. 兼容 API 不破：`MarkdownEditor.mount`  

---

## 6. 明确后置（不挡 v3.0）

- Mermaid/KaTeX 真渲染（可先 fence 占位高亮）  
- 视频/音频块、上传真后端  
- Database 属性引擎  
- 协同 / 版本树  
- AI 真模型（Mock 端口 v3.0）  

---

## 7. 迁移策略（U6）

- **短期**：继续 vanilla 于 `js/markdown-editor`，模块边界对齐 07 目录名  
- **中期**：抽出 `packages/conex-mdx`（TS），reference 变薄适配层  
- 主软件只接 `mount` + CSS + 可选 `media`/`ai` ports  

详见 [10-implementation-plan](./10-implementation-plan.md)。
