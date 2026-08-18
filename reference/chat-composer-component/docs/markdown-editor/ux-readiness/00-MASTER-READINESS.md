# Markdown 编辑器「好用」就绪总纲（2026-08-03）

> **角色**：合成总纲（可独立阅读）+ 与 01–07 分册的合并契约  
> **目录**：`docs/markdown-editor/ux-readiness/`（物理路径：`reference/chat-composer-component/docs/markdown-editor/ux-readiness/`）  
> **权威**：本目录优先于 feature-catalog 中「W* done」的乐观标注；与规格冲突时以 **用户可感知好用** 为准  
> **禁令**：本轮文档 **不写运行时代码**；实现须等决策拍板 + U 波次开工

---

## 0. 读本文件的方式

| 读者 | 读什么 |
|------|--------|
| 产品 / 验收 | §1 一句话 + §2 对照表 + §9 成功判据 10 条 |
| 架构 / 拍板 | §4 跨选决策 + [08-decision-log](./08-decision-log.md) |
| 调度 | §5 U1→U6 + §7 调度口令 |
| 实现 agent | 本文件 §5 对应波次 → 再读 01–07 本职分册；**禁止**扫全部再开写 |
| 合成 / 合并 | §10 分册合并协议（01–07 落地后回填） |

**与 feature-catalog 的关系**：W0–W10 是「能力面骨架波次」；本目录 U1–U6 是「从能跑到好用」波次。两者编号无关；**U 波次可推翻 W 的 done 标注**。

---

## 1. 一句话现状

**功能面 W1–W10 骨架已铺**（行源码 / 代码单表面 / 表 chrome / 行内 marks / 降级 / 媒体·公式·Mermaid 薄实现 / AI 端口薄 / 动效基线 / `packages/conex-mdx` 脚手架），**但受单块 `activeId: BlockId | null` 模型束缚**，跨行选择、多行源码编辑、行内源码策略、剪贴板与日常 15 条流程仍 **未达好用金标准**——用户感知仍是「能点能改的半成品」，不是 Typora 行源 + Notion 块感的合成体。

### 1.1 证据锚点（代码 / 规格）

| 现象 | 证据 |
|------|------|
| 全局仅一块可编辑 | `editor.js`：`var activeId = null`；`enterEdit` 先对旧 id `exitEdit` |
| 规格也写死单 active | `feature-catalog/01` §2.2 / §4.1：`activeId: BlockId \| null`；「任意时刻至多一个块 line-source」 |
| 表多选是 **格** 级，不是 **块** 级 | `table/selection.js` 服务于单元格；不覆盖段落跨块选区 |
| 上帝文件未拆净 | `js/markdown-editor/editor.js` 仍承担编排 + 大量输入/slash/切块路径（~3k 行量级） |
| 包迁移仅脚手架 | `packages/conex-mdx`：`mount` 仍为占位，真能力在 reference IIFE |

### 1.2 诚实分层

```
┌─────────────────────────────────────────────────────────┐
│ 规格层 W0：feature-catalog 8 册 ≈ 金标准合同（大量已写）   │
├─────────────────────────────────────────────────────────┤
│ 骨架层 W1–W10：模块目录 + 主路径能跑 + harness 可点       │
├─────────────────────────────────────────────────────────┤
│ 好用层 U1–U6：★ 本目录目标 — 跨选 / 行内源 / 流程摩擦清零 │
└─────────────────────────────────────────────────────────┘
```

「波次 done」≠「用户说好用」。本总纲默认：**骨架 done 可保留，金标准出口重开。**

---

## 2. 已交付 vs 未达金标准

> 评分口径对齐 feature-catalog §6：0 无 · 1 壳 · 2 模型错 · 3 主路径 · 4 边界好 · 5 金标准。  
> 下表是 **合成层快照（2026-08-03）**；细节与 F-ID 以 [01-unfinished-inventory](./01-unfinished-inventory.md) 落地后为准。  
> 状态符号：✅ 骨架可用 · ⚠ 半成品/边界烂 · ❌ 缺失或模型债 · 🔒 受 activeId 架构锁死

| 能力面 | W 标注 | 用户可感知 | 骨架分 | 好用分 | 锁因 / 缺口 |
|--------|--------|------------|--------|--------|-------------|
| 行源码 enter/leave | W1 done (verify) | 点块能进编辑、能切块 | 3–4 | 2–3 | 仅单块；跨块选复制失败 🔒 |
| 高度锁定 / 不跳 | W1 + W9 | 多数切块可接受 | 3 | 3 | 标题/代码/表进出仍有跳 ⚠ |
| 退格降级阶梯 | W5 done | 空列表/标题大致能降 | 3–4 | 3 | 跨块合并、嵌套边界 ⚠ |
| 代码单表面 | W2 done (verify) | 聚焦见 fence、失焦高亮 | 4 | 3–4 | 多语言/复制/折叠/Diff 未满 |
| 表格网格 + 合并 | W3 done (verify) | 可改格、部分 chrome | 3–4 | 2–3 | 跨表与跨块选、TSV 边界、a11y |
| 行内 marks 实时 | W4 done | 读态可见；as-you-type 不稳 | 3 | 2 | **定界符策略未拍板** → 见 D2 |
| 列表 `*` soft/hard | W1/W5 | 主路径有 | 3 | 3 | 与跨选/IME 交叉 ⚠ |
| 媒体 / TOC / wiki | W6 done | 主路径薄 | 2–3 | 2 | 上传端口、错误态、拖放 ⚠ |
| Mermaid / 公式 | W7 done | 失焦渲染聚焦源薄 | 3 | 2–3 | 大图高度锁、错误展示 |
| AI 端口 | W8 thin | 无 complete 则无入口 | 4（政策） | n/a | **禁止 mock**；宿主未接则不可用 |
| 动效基线 | W9 baseline | reduced-motion 有 | 3 | 3 | 非 P0 阻塞 |
| TS 包脚手架 | W10 scaffold | 不可生产挂载 | 1 | 0 | 迁移非本轮好用阻塞 |
| **跨块多选** | （规格弱） | **几乎不能用** | 0–1 | 0 | **activeId 单选模型** 🔒 |
| **多行源码（同块多段 / 连续块）** | 与上耦合 | **不能像编辑器一样拖选** | 1 | 0 | 需 Selection 模型 D1 🔒 |
| 剪贴板 HTML/MD | 部分 | 粘贴脏、丢结构 | 2 | 1–2 | 见 D3 + 分册 06 |
| 撤销/重做粒度 | 部分 | 有时整块跳、难预期 | 2–3 | 2 | history mergeKey 未产品化 |
| 查找替换 | 缺失 | 无 | 0 | 0 | U5/U6 后置可谈 |
| 上帝文件治理 | 08 charter | 仍膨胀 | 2 | — | U 波次强制拆 `edit/*` |

### 2.1 金标准「未达」的共性根因（优先修根，不刷漆）

1. **Selection 维度缺失**：只有 `activeId`，没有 `anchor/focus` 块范围、没有跨块字符 offset 映射。  
2. **编辑表面与选区生命周期绑死**：`enterEdit` = 唯一可键入表面；拖选跨块时 DOM 在 leave 中被拆掉。  
3. **行内源码政策未冻结**：marks 何时显示 `**`、caret 邻域策略与「全文像渲染」冲突。  
4. **剪贴板三态未产品化**：text/plain · text/html · text/markdown 优先级与消毒。  
5. **流程摩擦未当 P0**：见分册 04 的 15 条日常路径；骨架测试过主路径，未过真实写作剧本。

---

## 3. 用户最新硬需求映射

> 下列为「好用」层必须响应用户的硬需求（综合产品对话、feature-catalog 成功判据、v3 gap）。  
> 映射列指向本目录分册与决策 ID。

| # | 用户硬需求（可感知表述） | 为何现在做不到 | 映射 | 目标波次 |
|---|--------------------------|----------------|------|----------|
| H1 | 像 Word/Typora 一样 **拖选跨多段**，复制粘贴不碎 | 单 `activeId`，无块范围选区 | 02 + D1 | **U1** |
| H2 | 选中多段后 **统一删除 / 加粗 / 变列表** | 无 multi-block command bus | 02 + 05 | U1–U2 |
| H3 | 聚焦时仍 **好看**，但需要时能看到 `**` / `#` | 行内定界符策略摇摆 | 03 + D2 | **U2** |
| H4 | 从浏览器/Word **粘贴**不带一堆脏样式，结构还在 | HTML 粘贴未定优先级 | 06 + D3 | U3 |
| H5 | 中文 IME 组字 **不丢字、不跳块** | composition 与 leave 竞态残留 | 01/04 + 既有 ime-guard | U2 回归 |
| H6 | 代码块 **不要双壳**；点进去就是完整 fence | W2 主路径有，边界与复制体验 | 07 | U4 |
| H7 | 表格保持 **网格** 编辑，不要整表变 `\|` 源码墙 | 模型对，跨选/快捷键摩擦 | 07 | U4 |
| H8 | 撤销粒度符合直觉（打字合并、结构变更独立） | history 未产品化 | 06 | U3 |
| H9 | 日常 15 条写作流程无卡点（建标题、列表进出、空块、slash…） | 骨架过、剧本未过 | 04 | **U2–U3** |
| H10 | **无假 AI**；没接模型就不出现 AI 菜单 | 政策已有，须持续守门 | §8 + AI-HOST-POLICY | 全程 |
| H11 | 实现不堆 `editor.js`，可维护 | charter 在，执行松 | 05 | 每 U 出口 |
| H12 | 展示/验收用 **真 MD 样本**，不靠 mock 文案 | sample agent 政策 | §8 | U5 展示 |

### 3.1 优先级切割（产品语言）

| 等级 | 含义 | 包含 |
|------|------|------|
| **P0 阻塞好用** | 不做则用户拒绝日用 | H1 跨选、H3 行内源政策落地、H5 IME、H9 核心流程 |
| **P1 日用质量** | 做了才像专业编辑器 | H2 多段命令、H4 粘贴、H8 撤销 |
| **P2 面完善** | 不挡主路径 | H6/H7 残留、查找、协同、包迁移 |

---

## 4. 核心架构决策待拍板（跨选方案）

> **完整模板、选项利弊、推荐默认 → [08-decision-log.md](./08-decision-log.md)**  
> 此处只给调度用的摘要。 **U1 编码前必须关闭 D1**；**U2 前关闭 D2**；**U3 前关闭 D3**。

### 4.1 D1 — 多选 / 跨块选区模型（最大架构债）

**问题**：`activeId: BlockId | null` 无法表达：

- 块 A 中部 → 块 C 中部的字符选区  
- 整块多选（点把手 + Shift）后批量删除/移动  
- 跨块复制为连续 Markdown  

**方案族（详见 02 + 08）**

| 方案 | 一句话 | 推荐 |
|------|--------|------|
| **A. 扩展 Selection 状态机** | `sel = { kind:'caret'\|'range'\|'block-multi', anchor, focus }`；`activeId` 降为「主编辑表面」派生量 | **推荐默认** |
| B. 原生 DOM 跨块 contenteditable 根 | 整文档一个 CE，放弃 per-block surface | 否（与块模型/行源码冲突大） |
| C. 只做块级 multi，不做跨字符 | `selectedIds: BlockId[]`，字符选仅块内 | 可作 **U1 分期地板**，U1.5 再升 A |

**推荐默认（待确认）**：**D1 = A，分期落地**  

1. U1a：`block-multi` + 块内 `range`（修复制/删除）  
2. U1b：跨块 `range`（anchor 块 offset + focus 块 offset）  
3. `activeId` = range 坍缩时的 focus 块；range 非空时 **可暂不 enter 源码态**（只高亮选区）

**不变量（拍板后写入 CROSSCUTTING）**

- 任意时刻至多 **一个** 可键入的 line-source 表面（保留）；但 **选区** 可跨多块。  
- Leave 不得在 `pointerup` 完成选区前触发。  
- 序列化选区 → 剪贴板必须走 model 切片，不靠 `window.getSelection` 裸 HTML。

### 4.2 D2 — 行内源码（定界符）可见策略

| 方案 | 一句话 | 推荐 |
|------|--------|------|
| **A. Caret 邻域显源** | 仅 caret 所在 mark 及相邻 N 字符显示 `**` 等；其余折叠渲染 | **推荐默认**（Typora 感） |
| B. 聚焦块内全文显源 | 整块 body 显示 raw marks | 简单但丑，否 |
| C. 永不显源，只快捷键 | 纯 Notion | 否（违背 MD 原生） |

**推荐默认**：**D2 = A**；邻域窗口 1 个 mark run；IME composition 期间冻结显隐切换。

### 4.3 D3 — 粘贴 HTML 策略

| 方案 | 一句话 | 推荐 |
|------|--------|------|
| **A. MD 优先，HTML 降级** | 若有 `text/markdown` 用它；否则 HTML→MD 消毒转换；最后 plain | **推荐默认** |
| B. 只收 plain | 最安全最伤结构 | 否作默认 |
| C. 保留富文本 HTML 进模型 | 模型爆炸 | 禁止 |

**推荐默认**：**D3 = A**；白名单标签；style/class 丢弃；表格走 TSV/简单 table 管线。

### 4.4 决策关闭门禁

```
D1 关闭 → 允许 U1 实现 agent 开工
D2 关闭 → 允许 U2 行内源 agent 开工
D3 关闭 → 允许 U3 剪贴板 agent 开工
未关闭而写代码 → 调度打回
```

---

## 5. 实施总序 U1 → U6

> 与 W 波次正交。每波 **出口** = 用户剧本 + 自动化 harness + 无新上帝文件。  
> 细节模块拆分以 [05-architecture-and-implementation-plan](./05-architecture-and-implementation-plan.md) 为准（落地后合并进下表「模块主人」列）。

```
U1 跨块选区地基 ──► U2 行内源 + 流程摩擦 ──► U3 剪贴板/撤销
         │                    │                      │
         └──── 可部分并行 ─────┴── U4 表/代码/图残留 ──┘
                                              │
                                              ▼
                                    U5 展示样本 + 回归全集
                                              │
                                              ▼
                                    U6 打磨 / a11y / 包边界（非阻塞日用）
```

### 5.1 U1 — 跨块选区与多行源码地基（**最大**）

| 项 | 内容 |
|----|------|
| **目标** | 关闭 D1 后的 Selection 模型可运行；跨块复制/删除/Shift 块选可用 |
| **必读** | 本文件 §4.1、[02](./02-multi-block-selection-analysis.md)、[08](./08-decision-log.md) D1、01 catalog §2 |
| **允许写** | `edit/selection/*`、`edit/clipboard-range/*`、`edit/enter-exit` 适配、CSS 选区高亮；**禁止**新堆 editor.js 业务 |
| **DoD** | ① 块 A 中→B 中拖选复制得连续 MD ② Shift+点把手多选整块删除 ③ 选区存在时切块不丢选（明确产品规则） ④ 单测/harness 覆盖 range 切片 ⑤ `activeId` 与 sel 状态机文档化 |
| **依赖** | D1 关闭 |
| **预估 agent** | U1-A 状态机类型 · U1-B DOM 映射 · U1-C 复制切片 · U1-D 删除/替换 · U1-E 块 multi · U1-F CSS/a11y · U1-T 测试 · U1-R Review |

### 5.2 U2 — 行内源码策略 + 日常流程摩擦清零

| 项 | 内容 |
|----|------|
| **目标** | D2 落地；H3/H5/H9：marks 邻域显源 + IME 稳 + 15 条流程 P0 全绿 |
| **必读** | [03](./03-inline-marks-source-ux.md)、[04](./04-user-workflows-and-friction.md)、F-INL-*、ime-guard |
| **允许写** | `inline/*`、`edit/ime/*`、blocks 文本类、keymap；不碰表合并花活 |
| **DoD** | ① `**x**` as-you-type 生效 ② caret 邻域见定界符、离开折叠 ③ 中文组字剧本通过 ④ 分册 04 中 P0 流程全勾 ⑤ 无默认 sel-bar |
| **依赖** | D2；U1a 至少可用（避免选区与 marks 再次互撕） |

### 5.3 U3 — 剪贴板 / 撤销 / 查找预备

| 项 | 内容 |
|----|------|
| **目标** | D3 落地；粘贴干净；撤销可预期；查找 API 可后置 |
| **必读** | [06](./06-clipboard-undo-find.md) |
| **DoD** | ① 浏览器复制 HTML 粘贴 → 合理 MD 块 ② plain 保留换行 ③ 跨块 copy 与 U1 切片一致 ④ undo 打字合并、结构变更独立步 ⑤ 无 HTML 直灌 XSS |
| **依赖** | D3；U1 复制切片 |

### 5.4 U4 — 格式面残留（表 / 代码 / 图 / 公式）

| 项 | 内容 |
|----|------|
| **目标** | 不挡日用的残留拉到 ≥4 分；不重开 W 大花活 |
| **必读** | [07](./07-format-surfaces-residual.md)、feature-catalog 02/03/04 |
| **DoD** | ① 代码无双壳回归 ② 表框选与 U1 块选不互相吞事件 ③ 公式/Mermaid 错误态可读 ④ 高度锁与大块兼容 |
| **依赖** | U1 事件优先级表 |

### 5.5 U5 — 真样本 + 全量回归剧本

| 项 | 内容 |
|----|------|
| **目标** | 展示页 / harness 用 **真实 MD**；用户 10 条成功判据可演示 |
| **政策** | sample agent 写 `samples/*.md`；**禁止** runtime mock AI 文案 |
| **DoD** | ① 长文样本覆盖块类型 ② 自动化 roundtrip ③ 人工 10 条剧本录像或 checklist 全绿 |

### 5.6 U6 — 打磨 / a11y / 迁移边界

| 项 | 内容 |
|----|------|
| **目标** | reduced-motion、键盘闭环、`packages/conex-mdx` 真迁移不阻塞日用可后置 |
| **DoD** | 键盘-only 核心路径；a11y 抽检；editor.js 行数下降趋势；迁移表有主 |

### 5.7 明确不做（本就绪周期）

- Notion Database / 看板 / CRM  
- 真协同 OT/CRDT  
- 编辑器内置假模型  
- 恢复核心路径 `mdx-sel-bar`  
- 整页 raw MD 双模式硬切换  
- 为跨选改成「整文档单一 contenteditable 上帝根」却无迁移方案（即否决裸 B 方案）

---

## 6. 文档地图（01–07）与合并说明

| 文件 | 职责 | 合成时如何用 |
|------|------|----------------|
| [00-MASTER-READINESS.md](./00-MASTER-READINESS.md) | **本文件**：总优先级、决策摘要、U 序、调度 | 权威入口；冲突时先改本文件再改分册 |
| [01-unfinished-inventory.md](./01-unfinished-inventory.md) | 未完成/半成品总表（F-ID × 分数） | 回填 §2 分数；标 🔒 架构债 |
| [02-multi-block-selection-analysis.md](./02-multi-block-selection-analysis.md) | 跨行多选 + 多行源码方案深潜 | 回填 §4.1；实现伪代码与 DOM 契约以 02 为准 |
| [03-inline-marks-source-ux.md](./03-inline-marks-source-ux.md) | 行内 `**` 等源码可见 | 回填 D2 细节与 F-INL 验收 |
| [04-user-workflows-and-friction.md](./04-user-workflows-and-friction.md) | 15 条日常流程摩擦 | U2/U3 DoD 剧本源 |
| [05-architecture-and-implementation-plan.md](./05-architecture-and-implementation-plan.md) | 模块拆分 + agent 包 | 调度派单以 05 的文件所有权为准 |
| [06-clipboard-undo-find.md](./06-clipboard-undo-find.md) | 剪贴板 / 撤销 / 查找 | U3 合同 |
| [07-format-surfaces-residual.md](./07-format-surfaces-residual.md) | 表/代码/图/公式残留 | U4 合同 |
| [08-decision-log.md](./08-decision-log.md) | 开放决策 + 推荐默认 | 拍板后改 status=closed |

### 6.1 并行分册落地后的合并协议（给调度 / 合成）

01–07 由并行 agent 写出后，**不要改写本总纲叙事**，按下列顺序 **回填**：

1. **读 01**：用其分数表替换本文件 §2 中「合成层快照」行；保留根因 §2.1。  
2. **读 02**：若推荐方案 ≠ 本文件 D1 默认，**升级 08 为 conflict**，开产品确认，禁止默默改默认。  
3. **读 03/06**：同步 D2/D3 选项表到 08；验收列表链到 U2/U3 DoD。  
4. **读 04**：把 15 条流程标 P0/P1 并链到 U2 出口清单。  
5. **读 05**：用其 agent 文件所有权表 **替换** §7 派单表中的路径通配。  
6. **读 07**：确认 U4 范围不膨胀进 W 级新功能。  
7. **改本文件头部日期与「合并修订」段**（见文末 Changelog）。  
8. **README 状态** 改为「分析完成 · 待 D1 确认 · 可派 U1」。

**冲突仲裁顺序**

```
用户当面指示
  > 本目录 ux-readiness（好用优先）
    > 08-decision-log 已关闭决策
      > 00-MASTER
        > 01–07 分册正文
          > feature-catalog（金标准细节）
            > v3-complete（历史草稿）
              > js/markdown-editor 现状（不得反向定义产品）
```

---

## 7. 调度口令（确认后开 agent）

### 7.1 开干前置清单（全部勾选才能派 U1 编码）

- [ ] 用户确认 **D1** 方案（推荐 A 分期）— 见 08  
- [ ] 用户知悉 **D2/D3** 推荐默认（可与 U1 并行确认，但 U2/U3 前必须关）  
- [ ] 01–07 分册已合并回填本总纲 §2/§5（或明确「以总纲草稿派单，分册后补」）  
- [ ] 指定 **code owner** 路径：新逻辑只进 `edit/selection` 等，不进上帝文件  
- [ ] 约定回归：`tests/markdown-editor/*` + 手工 10 条（§9）

### 7.2 口令模板（复制即派）

```
【任务】Markdown 编辑器 UX 就绪 · {U1|U2|U3|U4|U5|U6}-{子号}
【必读】
  1. docs/markdown-editor/ux-readiness/00-MASTER-READINESS.md §5 本波
  2. docs/markdown-editor/ux-readiness/08-decision-log.md（仅 closed 决策）
  3. 本波分册：{02|03|04|05|06|07}
  4. feature-catalog 对应 F-ID（只读验收，不扩 scope）
【允许写路径】（以 05 分册所有权表为准，示例）
  reference/chat-composer-component/js/markdown-editor/edit/**
  reference/chat-composer-component/js/markdown-editor/inline/**
  reference/chat-composer-component/css/markdown-editor/**
  reference/chat-composer-component/tests/markdown-editor/**
【禁止】
  - runtime mock AI / 假 complete
  - 恢复核心 mdx-sel-bar
  - 整页双模式硬切换
  - 无 D1 关闭就改 selection 模型
  - 继续堆 editor.js 业务（>400 行增量必须拆文件）
【DoD】见 00-MASTER §5.x 本波 DoD + 用户 10 条中相关项
【产出】代码 + harness + 在 01 inventory 回填分数
```

### 7.3 建议并行度（≤12）

| 波次 | 最大并行 | 串行点 |
|------|----------|--------|
| U1 | 6–8 | selection 类型定义必须先合入 |
| U2 | 6 | marks 与 IME 勿两人同改同一 surface 文件 |
| U3 | 4 | 依赖 U1 切片 API |
| U4 | 4–6 | 事件优先级表先冻结 |
| U5 | 2–3 | 样本与回归可并行 |
| U6 | 2–4 | 不与 U1 抢同一文件 |

### 7.4 一句话调度指令（给人）

> **「确认 D1=A 分期后，按 ux-readiness U1 开干；好用优先于 W-done 标注；禁止 mock AI；禁止堆 editor.js。」**

---

## 8. AI / 样本政策重申

完整正文：[`../feature-catalog/AI-HOST-POLICY.md`](../feature-catalog/AI-HOST-POLICY.md)

| 层 | 允许 | 禁止 |
|----|------|------|
| **运行时** `js/markdown-editor/**` | 转发 `options.ai.complete`；无端口则隐藏 AI 入口 | 内置 mock complete、假摘要、假改写 |
| **样本文档** | 独立 sample agent 写真实 `samples/*.md` | 把 Mock 文案写进库逻辑 |
| **宿主 Conex** | 真 AI 网关注入 complete | 依赖编辑器内假模型 |

U 波次 **任何** AI 相关 UI 必须遵守：未注入 `complete` → 无菜单项。Review agent 发现 mock 字符串 → **一票否决出口**。

---

## 9. 成功判据（用户可感知 10 条）

> 全部通过 ⇒ 可宣称「从骨架到好用」本周期达标。  
> 任一条失败 ⇒ 对应 U 波次未完成，不得开庆祝式的 W 标注升级。

| # | 判据 | 主要波次 |
|---|------|----------|
| 1 | **跨段拖选**：从第 1 段中部拖到第 3 段中部，高亮连续，复制到外部编辑器为通顺 Markdown | U1 |
| 2 | **整块多选**：Shift+点块把手选中 3 块，Backspace 一次删除，undo 恢复 | U1 |
| 3 | **行源不跳**：点击标题出现灰色 `##`，下方段落位移 ≤2px | U2（回归 W1） |
| 4 | **行内源感**：输入 `**粗体**` 立即加粗；光标在词内可见/可感定界策略符合 D2；离开后像渲染 | U2 |
| 5 | **中文 IME**：拼音组字过程中不切块、不丢字、不乱 promote | U2 |
| 6 | **粘贴**：从网页复制一段带标题/列表的内容，粘贴后结构合理、无满屏 inline style | U3 |
| 7 | **代码单表面**：失焦高亮、聚焦同一卡片完整 fence，无「上彩下灰」双壳 | U4 |
| 8 | **表格网格**：编辑单元格不进入整表 pipe 源码墙；与块选事件不打架 | U4 |
| 9 | **日常流**：空文档 → `/` 插标题 → 列表进出 → 任务勾选 → 分割线，无卡死无幽灵块 | U2–U3 |
| 10 | **无假 AI / 无丑框**：无 complete 时无 AI 项；无默认选区条；无激活行厚描边 | 全程 |

### 9.1 验收执行建议

- **自动**：range 切片单测、roundtrip、粘贴夹具、ime harness  
- **人工**：按上表 1–10 在 showcase 长样本上走一遍，勾 [01 inventory](./01-unfinished-inventory.md)  
- **否决项**：mock AI、双壳回归、editor.js 单 PR +500 行业务无拆分

---

## 10. 与既有文档的指针（避免重复劳动）

| 主题 | 权威 |
|------|------|
| 行源码状态机 / demote / promote | `feature-catalog/01-core-blocks-and-line-source.md` |
| 代码/公式/Mermaid 金标准 | `feature-catalog/02-code-math-diagram.md` |
| 表格 | `feature-catalog/03-tables.md` |
| AI 端口政策 | `feature-catalog/AI-HOST-POLICY.md` |
| 交叉冻结（旧 D1–D18 编号） | `../CROSSCUTTING.md`（**注意**：旧 D1=扁平 Block[]，与本目录 **D1 多选模型** 不同号；引用时写全名） |
| 包迁移 | `feature-catalog/08-package-modules.md`、`packages/conex-mdx` |
| 历史差距叙事 | `../v3-complete/00-executive-gap.md`（算法草稿，冲突以 catalog + 本目录为准） |

**编号消歧**：`CROSSCUTTING` 的 D1–D18 是 **2026-08 设计轮冻结**；本目录 `08-decision-log` 的 D1–D3 是 **2026-08-03 好用就绪开放决策**。全文引用写作：`ux-D1` / `cross-D1` 或写标题全称。

---

## 11. Changelog（合成）

| 日期 | 变更 |
|------|------|
| 2026-08-03 | 初版总纲：现状、对照表、硬需求、D1–D3 摘要、U1–U6、调度口令、10 条成功判据、分册合并协议 |
| （待填） | 01–07 并行分册合并回填 |
| （待填） | D1/D2/D3 关闭后更新 §4 与派单状态 |

---

## 12. 下一步（给人类调度者的三行）

1. **今天**：读 §1–§4 + 08，确认或修改 D1（跨选）默认。  
2. **确认后**：按 §7.2 派 U1 agent（先类型与状态机，再 DOM）。  
3. **01–07 到齐**：执行 §6.1 合并协议，刷新 §2 分数与 README 状态行。
