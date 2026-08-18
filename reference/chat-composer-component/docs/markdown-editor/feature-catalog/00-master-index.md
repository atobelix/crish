# 00 — 总索引、依赖图、整波交付计划

> 与 [README](./README.md) 配套。分册 agent 完成后在此回填完整 F-ID 列表。  
> **策略**：功能扩展先想透 → 清单 + 金标准 → 再按波次多 agent 实现（禁止每次做一点）。

---

## 1. 文档权威顺序

1. 本目录 `feature-catalog/*`（功能与金标准）  
2. `../v3-complete/*`（历史差距与算法草稿，冲突时以本目录为准）  
3. `js/markdown-editor/*`（现状实现，不得反向定义产品）

---

## 2. 能力面（Capability Surfaces）— 整波交付单位

不要按「改一个 CSS」排期，按**能力面**排期：

| 波次 | 能力面 | 分册 | 完成定义（全部金标准验收过） |
|------|--------|------|------------------------------|
| **W0** | 规格冻结 | 00–08 全文 | 每 F-ID 有「做到最好」+ 验收 + 模块主人 | **done** |
| **W1** | 行源码渲染模型 | 01 + 06 防跳 | F-CORE-01…10 + 基础块聚焦源码正确 | **done (verify)** |
| **W2** | 代码单表面 | 02 | 失焦高亮 / 聚焦完整围栏源 / 无双壳 | **done (verify)** |
| **W3** | 表格专业面 | 03 | 多选+合并+悬停++右键分面板+对齐序列化 | **done (verify)** |
| **W4** | 行内 marks 实时 | 01/04 | 输入即渲染、聚焦可见标记、无 sel-bar | **done** |
| **W5** | 列表/标题降级完备 | 01 | `*` 阶梯、H 退格阶梯、IME | **done** |
| **W6** | 媒体+结构 | 04 | 图/附件/TOC/wiki/callout 主路径 | **done** |
| **W7** | Mermaid+公式 | 02 | 失焦渲染聚焦源 | **done** |
| **W8** | AI 端口（薄）+ 命令面板 | 05 / AI-HOST-POLICY | 仅宿主 complete，**无 mock** | **done (thin)** |
| **W9** | 动效基线 | 06 | tokens + reduced-motion | **done (baseline)** |
| **W10** | TS 包脚手架 | 08 | `packages/conex-mdx` | **scaffold** |

**规则**：W1 未金标准验收，禁止开 W6+ 花活。

---

## 3. 依赖图（简化）

```
W0 规格
 └─► W1 行源码模型 ──┬─► W2 代码单表面
                     ├─► W4 行内 marks
                     ├─► W5 列表标题降级
                     └─► W3 表格 ──► (合并导出策略 ∈ 07 Layer D)
                              │
                              ▼
                     W6 媒体结构 ──► W7 图公式
                              │
                              ▼
                     W8 AI/IO ──► W9 动效打磨
                              │
                              ▼
                     W10 包迁移（可与 W6+ 部分并行，但 API 以 W1 稳定为准）
```

---

## 4. 分册回填检查表（W0 已完成 2026-08-02）

| 分册 | 状态 | 约行数 | F-ID 规模 | 要点 |
|------|------|--------|-----------|------|
| [01 core](./01-core-blocks-and-line-source.md) | **done** | ~1696 | ~35 | Typora 行源码、退格阶梯、列表 `*`、无 sel-bar |
| [02 code](./02-code-math-diagram.md) | **done** | ~932 | ~35 | 单表面源码、高亮、Mermaid/公式、XSS |
| [03 tables](./03-tables.md) | **done** | ~1180 | ~38 | 多选、合并、悬停 +、TSV、导出 |
| [04 media](./04-media-structure.md) | **done** | ~1058 | ~35 | 图/附件/TOC/双链/callout/科研块 |
| [05 ai-io](./05-ai-export-collab.md) | **done** | ~957 | ~70 | AI 端口、IO、历史、协作 P3、Ctrl+P |
| [06 motion](./06-motion-ux-stability.md) | **done** | ~658 | A01–A40 | 零跳动、无丑框、60fps |
| [07 extension](./07-markdown-extension-model.md) | **done** | ~954 | 100+ | Layer A–E、注册表、兼容矩阵 |
| [08 package](./08-package-modules.md) | **done** | ~698 | 工程项 | `@conex/mdx`、无上帝文件、迁移表 |
| README + 00 | **done** | ~210 | 摘要 | 总表 + 波次 |

**合计约 8.3k+ 行**规格（不含历史 v3-complete）。

调度已完成：

1. 行数与 F-ID 规模已统计  
2. ID 命名空间按分册前缀隔离（F-CORE / F-CODE / F-T / F-M / F-A / F-IO / F-EXT…）  
3. README §3 仍为鸟瞰；细节以分册为准  
4. 下一波实现 prompt 见 §8  

---

## 5. 实现时 Agent 拆分模板（每波 ≤12）

```
Agent-Spec   : 只读本波 F-ID，写验收脚本清单（不写业务大文件）
Agent-Model  : schema/model/parse/serialize 切片
Agent-Block* : 每类块一个目录 blocks/<type>/
Agent-Chrome : 表/ slash / context menu 独立 ui/*
Agent-CSS    : tokens + 该面样式，禁改无关
Agent-Test   : 往返 + 交互契约
Agent-Review : 对照「做到最好」打分，不通过打回
```

**上帝文件禁令**：单文件 >400 行业务逻辑必须拆；`editor.js` 只保留编排。

---

## 6. 金标准打分（Review agent 用）

| 分 | 含义 |
|----|------|
| 0 | 无 |
| 1 | 壳 / 假按钮 |
| 2 | 主路径能点但模型错 |
| 3 | 主路径对，边界烂 |
| 4 | 边界好，缺动效/a11y |
| 5 | 分册「做到最好」全满足 |

波次出口：**该面所有 P0 的 F-ID ≥4，且无 0–2**。

---

## 7. 本轮交付结论

**W0 规格冻结已完成。**  
本轮只做「功能扩展思考 + 全量清单 + 每项做到最好」，**不写业务半吊子代码**。

权威入口：

- 鸟瞰：[README.md](./README.md)  
- 波次与依赖：本文  
- 金标准正文：01–08 分册  

---

## 8. 下一波实现（W1）— 可直接派发的 Agent 包

**能力面**：行源码渲染模型（F-CORE-01…10 + 基础块）  
**必读**：01 全文 + 06 §4–5（零跳动 / 无丑框）+ 07 Layer A  
**禁令**：不碰表合并花活、不恢复 mdx-sel-bar、不堆 `editor.js`、单文件业务 ≤400 行  

| Agent | 职责 | 允许写路径（示意） |
|-------|------|-------------------|
| W1-A | 行源码状态机 + height lock | `edit/line-source/*`, `edit/focus-session/*` |
| W1-B | 退格降级阶梯 + IME | `edit/keymap/*`, `edit/ime/*` |
| W1-C | 标题块 H1–H6 源码聚焦 | `blocks/heading/*` |
| W1-D | 段落 + 行内 marks 基线 | `blocks/paragraph/*`, `inline/*` |
| W1-E | 列表 `*` / 有序 / 任务 | `blocks/list/*`, `blocks/task/*` |
| W1-F | 引用 + HR + slash 接线 | `blocks/quote/*`, `blocks/divider/*`, `ui/slash/*` |
| W1-G | CSS tokens：无激活描边、源码态样式 | `css/markdown-editor/*` |
| W1-H | 验收：往返 + 聚焦源可见 + 不跳 | `tests/*` 或 demo harness |
| W1-R | Review：对照 01 验收打 0–5 分 | 只读 |

出口：该面所有 P0 **≥4 分** 才开 W2（代码单表面）。

用户若说「按清单开干」，调度从 **W1 九宫格** 起 ≤12 agent 并行。
