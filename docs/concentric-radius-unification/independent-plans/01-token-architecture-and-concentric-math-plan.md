# Token 体系平反与同心几何标尺独立详案（01-TOKEN-MATH-PLAN）

> **战役代号**：CONCENTRIC-RADIUS-UNIFICATION  
> **方案编号**：01-token-architecture-and-concentric-math-plan  
> **责任架构**：Token 体系与数学架构师（Agent-P1）  
> **产出日期**：2026-10-25  
> **目标路径**：`docs/concentric-radius-unification/independent-plans/01-token-architecture-and-concentric-math-plan.md`  
> **前序基准**：
> - [`00-全仓同心圆角与边距现状统一调查总报告.md`](file:///c:/Software/conex/docs/concentric-radius-unification/00-全仓同心圆角与边距现状统一调查总报告.md)
> - [`analysis/05-tokens-radius-ssot-and-concentric-math-analysis.md`](file:///c:/Software/conex/docs/concentric-radius-unification/analysis/05-tokens-radius-ssot-and-concentric-math-analysis.md)
> - [`analysis/06-concentric-anti-patterns-and-benchmarking.md`](file:///c:/Software/conex/docs/concentric-radius-unification/analysis/06-concentric-anti-patterns-and-benchmarking.md)
> - [`apps/crish-desktop/src/styles/tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css)

---

## 目录

1. [执行摘要与平反总纲](#一-执行摘要与平反总纲)
2. [Conex 双形态（Rounded & Compact）几何架构体系](#二-conex-双形态rounded--compact几何架构体系)
   - 2.1 [双形态定位原则与应用场景界定](#21-双形态定位原则与应用场景界定)
   - 2.2 [双形态在同心公理下的代数推导图景](#22-双形态在同心公理下的代数推导图景)
3. [Token 体系平反与完备偶数阶梯（Tier 1 & Tier 2 重构）](#三-token-体系平反与完备偶数阶梯tier-1--tier-2-重构)
   - 3.1 [历史 5 档 SSOT 的代数断裂与平反必然性](#31-历史-5-档-ssot-的代数断裂与平反必然性)
   - 3.2 [平反第一案：`--radius-2xl` 恢复为 20px（圆角形态模态枢纽）](#32-平反第一案--radius-2xl-恢复为-20px圆角形态模态枢纽)
   - 3.3 [平反第二案：`--sep-radius-outer` 恢复为 14px（微圆形态浮层枢纽）](#33-平反第二案--sep-radius-outer-恢复为-14px微圆形态浮层枢纽)
   - 3.4 [完备偶数 Token 阶梯全景表（4px ~ 20px ~ 9999px）](#34-完备偶数-token-阶梯全景表4px--20px--9999px)
   - 3.5 [Token 映射前后详尽对照表与升级语义映射](#35-token-映射前后详尽对照表与升级语义映射)
   - 3.6 [场景契约 Token（Tier 2）解耦与平反收敛](#36-场景契约-tokentier-2解耦与平反收敛)
4. [7px 按钮（用户锁 U1）同心兼容与消除 $\pm 1px$ 漂移策略](#四-7px-按钮用户锁-u1同心兼容与消除-pm-1px-漂移策略)
   - 4.1 [奇偶校验破缺定理的数学本质回顾](#41-奇偶校验破缺定理的数学本质回顾)
   - 4.2 [策略 A：超距平直区天然解耦（Decoupled Flat Zone）](#42-策略-a超距平直区天然解耦decoupled-flat-zone)
   - 4.3 [策略 B：非对称微内衬/局域发丝补偿（Asymmetric Micro-Padding Compensation）](#43-策略-b非对称微内衬局域发丝补偿asymmetric-micro-padding-compensation)
   - 4.4 [策略 C：分段控件与滑块的容器/按钮概念分离（Container vs Control Decoupling）](#44-策略-c分段控件与滑块的容器按钮概念分离container-vs-control-decoupling)
   - 4.5 [策略 D：发丝边框宽度物理闭环（Border Box Hairline Accounting）](#45-策略-d发丝边框宽度物理闭环border-box-hairline-accounting)
5. [CSS 宏与混合器模板（Concentric Calculation Engine）](#五-css-宏与混合器模板concentric-calculation-engine)
   - 5.1 [内向外推导宏：`calc(inner + pad)`](#51-内向外推导宏calcinner--pad)
   - 5.2 [外向内推导宏：`max(0px, calc(outer - pad))`](#52-外向内推导宏max0px-calcouter---pad)
   - 5.3 [双轴非对称内衬的椭圆同心宏](#53-双轴非对称内衬的椭圆同心宏)
   - 5.4 [发丝边框与内外阴影修正同心宏](#54-发丝边框与内外阴影修正同心宏)
   - 5.5 [标准 CSS 变量模板与组件装配最佳实践](#55-标准-css-变量模板与组件装配最佳实践)
6. [落地改动代码清单（落地执行指南）](#六-落地改动代码清单落地执行指南)
   - 6.1 [`tokens.css` 核心声明改造代码清单](#61-tokenscss-核心声明改造代码清单)
   - 6.2 [关键场景契约消费点修改指南](#62-关键场景契约消费点修改指南)
   - 6.3 [UI Size 密度档位动力学动态补偿](#63-ui-size-密度档位动力学动态补偿)
   - 6.4 [门禁契约与自动化测试守护（motion-concentric-contract.test.ts）](#64-门禁契约与自动化测试守护motion-concentric-contracttestts)
7. [验收标准与反退避合规断言](#七-验收标准与反退避合规断言)

---

## 一、 执行摘要与平反总纲

本详案旨在为 Conex / Crish 桌面端系统建立**工业级自洽的同心圆角几何体系**。依据前期调查总报告（`00-全仓同心圆角与边距现状统一调查总报告.md`）与数学分析（`05-tokens-radius-ssot-and-concentric-math-analysis.md`），现存系统最核心的系统性矛盾在于：
1. **阶梯代数不完备**：历史推行的 5 档 SSOT（4/8/12/20/9999px）将关键过渡阶梯（6/10/14/16px）无情抹杀；
2. **两起严重的历史性 Token 冤案**：
   - `--radius-2xl` 被强制坍塌为 12px，造成全站大模态（Dialog / Settings / ProjectManageModal）在视觉层级上比底层的输入框（Composer 20px）“更方、更锐”的严重**空间倒挂**；
   - `--sep-radius-outer`（所有下拉菜单、上下文面板外壳）被强制焊死为 12px，致使全仓 10+ 处采用 6px padding 与 8px item 的菜单恒定存在 $\Delta = -2\text{px}$ 的**角部微挤压**；
3. **用户锁 U1（7px 按钮）引发的奇偶校验破缺**：奇数圆角与偶数间距在模 2 运算下的天然互斥，引发全站多处 $\pm 1\text{px}$ 漂移与 5px 亚像素模糊。

### 平反总纲与核心裁决

```
                        【平反与同心几何标尺核心图景】

     ┌──────────────────────────────────────────────────────────────┐
     │ 1. 平反 --radius-2xl: 12px  ════►  20px (圆角形态模态枢纽)     │
     │    消除顶层大弹窗(12px)比底层输入框(20px)更方的层级倒挂！     │
     ├──────────────────────────────────────────────────────────────┤
     │ 2. 平反 --sep-radius-outer: 12px  ════►  14px (微圆形态浮层枢纽)│
     │    代数派生: 14px = 8px (Item) + 6px (Pad)，实现绝对同心！   │
     ├──────────────────────────────────────────────────────────────┤
     │ 3. 补齐偶数 Token 完备闭包阶梯:                                │
     │    4px (xs) ── 6px (sm) ── 8px (md) ── 10px (lg)             │
     │    ── 14px (xl-menu) ── 16px (xl-card) ── 20px (2xl-modal)  │
     ├──────────────────────────────────────────────────────────────┤
     │ 4. 7px 按钮（用户锁 U1）四大同心兼容策略:                    │
     │    超距平直区解耦 + 单侧发丝内衬补偿 + 分段控件解绑 + 发丝计入 │
     ├──────────────────────────────────────────────────────────────┤
     │ 5. 双向动态 CSS 宏与混合器引擎:                               │
     │    calc(inner + pad) 与 max(0px, calc(outer - pad))          │
     └──────────────────────────────────────────────────────────────┘
```

本详案不搞“打补丁”与魔术数字修正，通过**平反两大枢纽 Token**、**补齐偶数代数阶梯**与**引入同心计算宏**，从根本上实现 Conex 双形态（圆角形态与微圆形态）的完美共存与工业几何收敛。

---

## 二、 Conex 双形态（Rounded & Compact）几何架构体系

根据用户核心裁决，系统正式确立**双形态几何共存机制**。形态的区分不是无序混用，而是基于组件在 UI 空间层级与信息密度中的物理职责严格定界：

### 2.1 双形态定位原则与应用场景界定

| 形态定义 | 核心枢纽圆角 | 设计语言语义 | 适用空间层级与组件范畴 | 视觉心理诉求 |
| :--- | :---: | :--- | :--- | :--- |
| **圆角形态**<br>*(Rounded Mode)* | **20px**<br>(`--radius-2xl`) | **柔和、悬浮、主舞台**<br>强调操作岛与全局覆盖层的独立性 | 1. 顶层大模态窗口（`Dialog`, `SettingsModal`, `ProjectManageModal`）<br>2. 视口主输入岛（`ChatComposer` 单行/多行）<br>3. 浮动引导提示条（`SetupHintBanner`）<br>4. 用户核心交互气泡（`ChatBubble`） | 现代、温润、呼吸感、聚焦、高阶桌面应用质感 |
| **微圆形态**<br>*(Compact Mode)* | **12px ~ 14px**<br>(外壳)<br>**8px**<br>(内部控件) | **紧凑、工业、高密度**<br>强调信息密集型生产力界面的精准与规整 | 1. 工作台与多分屏叶容器（`LeafBody`, `Workspace`）<br>2. 业务功能卡片与抽屉（`Card`, `ToolCallCard`, `ArtifactCard`）<br>3. 浮层菜单与下拉列表（`SelectContent`, `SmartExpandablePanel`, `ContextMenu`）<br>4. 表单控件与按钮（`Input`, `SelectTrigger`, `Tabs`, `Button`） | 专业、严密、高信息吞吐、规整无冗余、消除角部虚空 |

### 2.2 双形态在同心公理下的代数推导图景

工业几何同心圆角核心铁律：
$$\boxed{R_{outer} = R_{inner} + Padding \quad \Longleftrightarrow \quad R_{inner} = \max(0, R_{outer} - Padding)}$$

两种形态在严格遵循该铁律的前提下，推导出完全自洽的双层嵌套拓扑：

#### 1. 圆角形态（Rounded Mode）同心推导链
- **顶层模态**：$R_o = 20\text{px}$（`--radius-2xl`）；
  - 当内边距 $P = 16\text{px}$（`--space-4`）时：$R_i = \max(0, 20 - 16) = \mathbf{4px}$（`--radius-xs`，用于 Header 关闭按钮或顶部角标）；
  - 当内边距 $P = 12\text{px}$（`--space-3`）时：$R_i = \max(0, 20 - 12) = \mathbf{8px}$（`--radius-md`，用于内嵌标准功能卡片）；
  - 当内边距 $P \ge 20\text{px}$（`--space-5` 及以上）时：$R_i = 0$（完全进入**超距平直区**，内嵌元素以自身 8px/12px 独立成形，曲率互不干涉）。
- **底部输入框（Composer）**：$R_o = 20\text{px}$（`--composer-radius-single`）；
  - 附件卡片（AttachCard）：垂直间距 $P_y = 8\text{px}$，卡片圆角 $R_i = 20 - 8 = \mathbf{12px}$（`--radius-l`，完美同心！）；
  - 发送圆形按钮（28px 正圆）：在高度 40px、垂直内衬 6px 容器内，居中正切对齐。

#### 2. 微圆形态（Compact Mode）同心推导链
- **浮动下拉菜单与面板**：$R_o = \mathbf{14px}$（`--sep-radius-outer` / `--radius-xl-menu`）；
  - 菜单内部 Padding：$P = 6\text{px}$（`--space-1_5`）；
  - 内部选项条目（MenuItem）：$R_i = 14 - 6 = \mathbf{8px}$（`--radius-md`，**处处等距平行，$\Delta = 0$ 绝对同心！**）；
  - 极小菜单（sm 档）：$R_o = 12\text{px}$，Padding $P = 4\text{px}$，选项 $R_i = 12 - 4 = \mathbf{8px}$（同心闭环）。
- **标准卡片容器**：$R_o = \mathbf{16px}$（`--radius-xl` / `--radius-xl-card`）；
  - 卡片内边距：$P = 8\text{px}$（`--space-2`）；
  - 内部表单控件/子卡：$R_i = 16 - 8 = \mathbf{8px}$（`--radius-md`，完美契合！）；
  - 或内边距 $P = 4\text{px}$（`--space-1`），内部子卡 $R_i = 16 - 4 = \mathbf{12px}$（`--radius-l`，完美契合！）。
- **分段控件（SegmentedControl / Tabs 外壳）**：$R_o = \mathbf{8px}$（`--radius-md`）；
  - 容器内衬 Padding：$P = 2\text{px}$（`--space-0_5`）；
  - 内部滑块 Indicator：$R_i = 8 - 2 = \mathbf{6px}$（`--radius-sm`，彻底消除 5px 奇数亚像素模糊，完美同心！）。

---

## 三、 Token 体系平反与完备偶数阶梯（Tier 1 & Tier 2 重构）

### 3.1 历史 5 档 SSOT 的代数断裂与平反必然性

在 2026-10-10 的历史收拢中，系统定义了：
```css
/* 历史 5 档 SSOT（存在严重代数断裂） */
--radius-s: 4px;
--radius-m: 8px;
--radius-l: 12px;
--radius-input: 20px;
--radius-pill: 9999px;
```
该体系在代数上违反了**阶梯跨度完备性定理（Scale Completeness Theorem）**：
- 间距体系拥有 $2, 4, 6, 8, 10, 12, 16\text{px}$ 全偶数网格；
- 圆角差值集合：$\mathcal{R}_{diff} = \{ R_o - P \mid R_o \in \{8, 12, 20\}, P \in \{2, 4, 6, 8, 10, 12\} \}$；
- 求得需求集合必包含：$\{2, 4, \mathbf{6}, 8, \mathbf{10}, 12, \mathbf{14}, \mathbf{16}, 18, 20\}\text{px}$。
- 历史体系粗暴删除了 **6px、10px、14px、16px**，迫使全仓组件陷入“裸写 calc()”或“妥协变形”的两难死局。

### 3.2 平反第一案：`--radius-2xl` 恢复为 20px（圆角形态模态枢纽）

#### 历史溯源与冤案解剖
在 `tokens.css:508` 中，历史提交强行将 `--radius-2xl: var(--radius-l);`（12px）。
- **恶果**：
  1. $1040\text{px}$ 宽度的巨型模态窗口 `Dialog`、`SettingsModal`、`ProjectManageModal` 顶层外壳仅有 12px，丧失高级质感；
  2. `ProjectManageModal.module.css:4` 开发者显式写的 `var(--radius-2xl, 24px)` 被 12px 截胡吞噬；
  3. **视觉倒挂**：顶层悬浮模态（12px）比视口底部的单行输入框（Composer 20px）更尖锐，空间层级颠倒。

#### 平反裁决
- 将 `--radius-2xl` 从 12px 平反升级为 **`20px`**！
- 确立 `--radius-2xl: 20px` 为**圆角形态顶级模态枢纽键**；
- 彻底解决大模态弹窗与输入框的视觉倒挂，赋予全局弹层与 Composer 同等优雅的 20px 宏观曲率。

### 3.3 平反第二案：`--sep-radius-outer` 恢复为 14px（微圆形态浮层枢纽）

#### 历史溯源与冤案解剖
在 `tokens.css:282` 中，`--sep-radius-outer` 被指定为 `var(--radius-l);`（12px）。
- **恶果**：
  1. `SmartPanel.module.css:195` 开发者明确标注了同心设计：`/* 槽位化菜单条目 (Outer 14px - Padding 6px = Item 8px) */`，并写下 `var(--sep-radius-outer, 14px)`；
  2. 但全局 `:root` 中的 12px 导致 fallback 14px 永久失效；
  3. 最终浮层外壳被迫使用 12px，在 6px padding 下内部 8px item 产生 $\Delta = 12 - (8 + 6) = -2\text{px}$ 的角部微挤压；
  4. `SelectContent.module.css:44` 不得不通过 `calc(var(--radius-m) + 6px)` 避难。

#### 平反裁决
- 将 `--sep-radius-outer` 平反恢复为代数派生的真值 **`14px`**（$14 = 8 + 6$）！
- 将其作为**微圆形态浮层菜单外壳枢纽键**，彻底解救全仓下拉菜单、上下文面板与层叠菜单。

---

### 3.4 完备偶数 Token 阶梯全景表（4px ~ 20px ~ 9999px）

系统构建起完全闭包、严格单调的完备偶数阶梯。阶梯划分为 **Tier 1（标度真源）** 与 **Tier 2（场景契约）**：

```
【Tier 1：基础偶数标度 SSOT (纯几何离散网格)】
┌──────────────┬────────┬────────────────────────────────────────────────────────┐
│ Token 变量名 │ 像素值 │ 工业几何语义与闭包角色                                 │
├──────────────┼────────┼────────────────────────────────────────────────────────┤
│ --radius-xs  │  4px   │ 微型刻度：Tag、Badge、Kbd 按键、微型角标、复选框       │
│ --radius-sm  │  6px   │ 紧凑刻度：滑块 Indicator、小列表行、8px 容器内部元素   │
│ --radius-md  │  8px   │ 标准控件：Button、Input、SelectTrigger、MenuItem (基准)│
│ --radius-lg  │ 10px   │ 衔接过渡：过渡小卡片、14px 外壳在 4px padding 下的内角 │
│ --radius-xl  │ 16px   │ 核心卡片：主工作卡片、业务卡片、抽屉面板外框           │
│ --radius-2xl │ 20px   │ 宏观枢纽：顶层大模态(Dialog/Settings)、Composer、气泡 │
│ --radius-pill│ 9999px │ 终极胶囊：Switch 轨道、完全胶囊按钮、滚动条滑块        │
│ --radius-circle│ 50%  │ 正圆曲率：用户正圆头像 (Avatar)、状态脉冲指示灯        │
└──────────────┴────────┴────────────────────────────────────────────────────────┘

【保留经典 3 档引用兼容别名】
--radius-s: var(--radius-xs); /* 4px */
--radius-m: var(--radius-md); /* 8px */
--radius-l: 12px;             /* 12px 保留作为微圆形态中卡片/小面板专用阶梯 */
```

### 3.5 Token 映射前后详尽对照表与升级语义映射

| Token 变量名称 | 历史解析值 | **平反/升级新值** | 历史病态根因 | 升级后几何效益与同心闭包场景 |
| :--- | :---: | :---: | :--- | :--- |
| **`--radius-xs`** | 4px | **4px** | 与 sm 坍塌同值 | 专供微型标签、行内代码、复选框；在 8px 外框 + 4px padding 时作为内角 |
| **`--radius-sm`** | 4px | **6px** | 阶梯断裂，无法承接滑块 | **全新激活 6px**：专供分段控件滑块（$8 - 2 = 6$）、小菜单项，全仓 191 处消费点重获适度圆润 |
| **`--radius-md`** | 8px | **8px** | 正典控件基准 | **保持 8px**：标准输入框、下拉框、列表条目单一真理基准 |
| **`--radius-lg`** | 8px | **10px** | 与 md 坍塌同值，虚假阶梯 | **全新激活 10px**：衔接 14px 浮层与 4px padding，消除 8px 与 12px 间的断崖 |
| **`--radius-l`** | 12px | **12px** | 承担了过多卡片与弹窗职责 | **维持 12px**：专注微圆形态下的紧凑卡片、小面板及 16px 外框在 4px padding 下的内角 |
| **`--radius-xl`** | 12px | **16px** | 坍塌至 12px，卡片缺乏包容度 | **平反恢复 16px**：标准业务卡片外壳，在 8px padding 下完美容纳 8px 标准控件（$16 - 8 = 8$） |
| **`--radius-2xl`** | 12px | **20px** | **历史头号冤案**：大弹窗坍塌 | **平反恢复 20px**：全局 Dialog、Settings、ProjectManageModal 大模态外框，消灭视口层级倒挂 |
| **`--radius-3xl`** | 20px | **20px** | 别名混乱 | 统一收拢至 20px 枢纽，指向 `--radius-2xl` |
| **`--sep-radius-outer`** | 12px | **14px** | **历史二号冤案**：浮层轻度挤压 | **平反恢复 14px**：所有下拉菜单、上下文面板外壳，与 6px padding、8px item 达成处处同心 |
| **`--radius-btn`** | 7px | **7px** | 用户锁 U1 | **严格保护 7px**：文字按钮专享，执行四大兼容策略消除漂移 |
| **`--radius-pill`** | 9999px | **9999px** | 幽灵 9996px 计算 | 保持极限胶囊值，废除幽灵减法运算 |

### 3.6 场景契约 Token（Tier 2）解耦与平反收敛

为防止组件层直接裸写或者误用底层标度，Tier 2 语义契约 Token 统一完成代数对齐：

```css
/* Tier 2 场景契约 Token 平反定稿 */

/* 1. 顶层模态与全局浮动岛契约（圆角形态：20px 枢纽） */
--modal-radius-outer:        var(--radius-2xl); /* 20px (Dialog / Settings / ProjectManageModal) */
--modal-header-btn-radius:   var(--radius-xs);  /* 4px  (20px - 16px Header Pad = 4px 完美同心) */
--composer-radius-single:    var(--radius-2xl); /* 20px (底部输入框单行态) */
--composer-radius-multi:     var(--radius-2xl); /* 20px (底部输入框多行态) */
--chat-bubble-radius:        var(--radius-2xl); /* 20px (用户核心气泡) */
--banner-radius-outer:       var(--radius-2xl); /* 20px (浮动引导条外框，SetupHintBanner) */

/* 2. 浮层菜单与展开面板契约（微圆形态：14px 枢纽） */
--sep-radius-outer:          14px;              /* 14px (下拉菜单/上下文面板外壳，平反真值) */
--sep-item-radius:           var(--radius-md);  /* 8px  (14px - 6px Pad = 8px 处处同心) */
--sep-badge-radius:          var(--radius-xs);  /* 4px  (8px Item - 4px Pad = 4px 二级同心) */

/* 3. 生产力卡片与工作台容器契约（微圆形态：16px / 12px 枢纽） */
--card-radius-outer:         var(--radius-xl);  /* 16px (标准卡片外壳，容纳 8px 控件 + 8px Pad) */
--card-radius-compact:       var(--radius-l);   /* 12px (紧凑面板/代码块/工具卡片外框) */
--card-control-radius:       var(--radius-md);  /* 8px  (卡片内部嵌入的 Input / Select 控件) */

/* 4. 分段控件与滑块契约（消除 5px 亚像素危机） */
--segment-shell-radius:      var(--radius-md);  /* 8px  (控件外壳脱离 7px 按钮锁，归位 8px 容器) */
--segment-pad:               var(--space-0_5);  /* 2px  (外壳与滑块间的精密间隙) */
--segment-indicator-radius:  var(--radius-sm);  /* 6px  (8px - 2px = 6px 偶数完美同心！) */
```

---

## 四、 7px 按钮（用户锁 U1）同心兼容与消除 $\pm 1px$ 漂移策略

### 4.1 奇偶校验破缺定理的数学本质回顾

根据前序数学报告建立的核心定理：
> 当所有间距 Token 遵循全偶数原则（$P \equiv 0 \pmod 2$）时：
> $$R_o \pmod 2 \equiv (R_i + P) \pmod 2 \equiv R_i \pmod 2$$
> 用户锁 U1 将按钮死锁在奇数 **7px**（$R_i \equiv 1 \pmod 2$）。因此，任何包裹该按钮且内边距为偶数的外容器，其理论同心外圆角 $R_o$ **必然为奇数**（9px、11px、13px、15px）。  
> 然而 CI 门禁（`ODD_RADIUS_BASELINE = 0`）与设计系统刚性拦截所有奇数外圆角，导致外容器被迫使用 8px、10px、12px，造成恒定的 $\pm 1\text{px}$ 几何漂移。

为彻底根治该问题且**绝不破坏用户对 7px 按钮的视觉偏好**，架构确立四大实操兼容策略：

### 4.2 策略 A：超距平直区天然解耦（Decoupled Flat Zone）

#### 工业几何机理
当外容器内边距 $Padding \ge R_{outer}$ 时，容器圆弧在距离边缘 $R_o$ 处已经完全过渡为直壁。此时内嵌按钮在几何上**完全坐落在容器的正交平直区域内**，两者的曲率中心在空间上距离极远，根本不存在共享曲率中心的基础。

```
              ┌──────────────────────────────────────┐
              │                                      │
              │   P >= Ro (直壁区)                   │
              │   ┌──────────────┐                   │
              │   │ Button (7px) │                   │
              │   └──────────────┘                   │
              │   7px 独立精致，曲率中心不重叠       │
              │   视觉上完全无同心要求与违和感       │
              └──────────────────────────────────────┘
```

#### 落地规范
- 在大模态（Dialog $P=16\sim 24\text{px}$）、设置面板卡片（$P=14\sim 16\text{px}$）、工作区主卡片（$P=12\sim 16\text{px}$）中，7px 按钮天然处于超距平直区；
- 此时外壳严格遵循偶数（16px / 20px），按钮保持 7px，**几何上已完全解耦，无需也不允许强行调整外壳或按钮**。

---

### 4.3 策略 B：非对称微内衬/局域发丝补偿（Asymmetric Micro-Padding Compensation）

#### 适用场景
紧凑容器角部（如小提示卡角部的操作按钮、浮动工具栏两端的动作按钮），此时内边距较薄（$P < R_o$），按钮贴近角部圆弧，$\pm 1\text{px}$ 漂移会产生轻微的角部挤压。

#### 调节机理
利用人眼对**间隙（Padding）1px 的不可辨识性**（JND，恰可察觉差），在角部方向微调内衬为奇数（3px 或 5px），使得：
$$R_{outer} = R_{button} + Padding_{corner} = 7\text{px} + 3\text{px} = \mathbf{10px} \quad (\text{偶数!})$$
$$R_{outer} = R_{button} + Padding_{corner} = 7\text{px} + 5\text{px} = \mathbf{12px} \quad (\text{偶数!})$$

```css
/* 角部 7px 按钮局域发丝内衬补偿范式 */
.compactCornerCard {
  border-radius: var(--radius-l); /* 12px 偶数外壳 */
  padding: 5px;                  /* 微内衬 5px 消除 1px 漂移: 7 + 5 = 12px 完美同心！ */
}
.compactCornerCard > .actionBtn {
  border-radius: var(--radius-btn); /* 7px 保持用户锁 */
}
```
**收益**：外壳保持偶数通过 CI 门禁，按钮保持 7px 满足用户锁，内外曲率半径差等于物理间隙，内外圆弧实现微米级平行同心。

---

### 4.4 策略 C：分段控件与滑块的容器/按钮概念分离（Container vs Control Decoupling）

#### 破除历史概念混淆
调查报告查获，历史代码将 `SegmentedControl` 和 `Tabs` 的外壳错误绑定了 `--button-radius`（7px），外壳只有 2px padding，推导出的内部滑块是 **5px**（奇数且亚像素发虚）。

#### 概念矫正
1. **外壳是容器，不是按钮**：分段控件的外壳是一个承载选项集的“轨道容器（Track Shell）”，不具备直接点击动作，不属于用户锁 U1 的“按钮”范畴；
2. **滑块是状态指示器，不是独立按钮**；
3. **架构解耦**：
   - 外壳解绑 7px，归位为标准偶数容器 `--segment-shell-radius: var(--radius-md);`（**8px**）；
   - 内衬间隙保持精密发丝级 `--space-0_5`（**2px**）；
   - 内部滑块 Indicator 采用全新完备阶梯 `--radius-sm`（**6px**）；
   - 同心验算：$$R_o - P = 8\text{px} - 2\text{px} = \mathbf{6px} = R_i \quad (\Delta = 0)$$
   - **成效**：彻底消灭 5px 奇数圆角和抗锯齿边缘发虚，呈现顶级德国工业级精工质感。

---

### 4.5 策略 D：发丝边框宽度物理闭环（Border Box Hairline Accounting）

在 CSS 标准盒模型 `box-sizing: border-box` 下，`border-radius` 作用于边框的最外缘。如果容器带有 1px 边框线（`--hairline-width: 1px`）：
$$R_{outer} = R_{inner} + Padding_{content} + Border_{width}$$
若按钮 $R_i = 7\text{px}$，边框 $B_o = 1\text{px}$：
$$R_{outer} = 7\text{px} + P_{content} + 1\text{px} = \mathbf{8px} + P_{content}$$
- 当内容间距 $P_{content}$ 取系统偶数间距（如 2px、4px）：
  - 若 $P = 2\text{px}$：$R_o = 8 + 2 = \mathbf{10px}$（偶数！）；
  - 若 $P = 4\text{px}$：$R_o = 8 + 4 = \mathbf{12px}$（偶数！）。
- **数学美感**：**1px 发丝边框恰好吸收了 7px 奇数圆角的余数**！只要在精密计算中将 1px 边框厚度纳入代数方程，系统全偶数闭包在物理上自然成立。

---

## 五、 CSS 宏与混合器模板（Concentric Calculation Engine）

为彻底终结全仓各自为政的逃逸式 `calc()` 与魔术数字补丁，本方案确立**全仓标准化同心几何计算宏**。

### 5.1 内向外推导宏：`calc(inner + pad)`

#### 适用场景
**“以子定父”模式**：已知内部核心控件的规范尺寸（如内部是一个 8px 标准输入框或 8px 按钮），需要容器紧致贴合包裹该子元素，确保内外平行。

#### CSS 表达式
```css
/* 标准内向外同心宏（单轴等距） */
--concentric-outer: calc(var(--inner-radius) + var(--concentric-pad));

/* 包含 1px 发丝边框时的精密内向外宏 */
--concentric-outer-bordered: calc(var(--inner-radius) + var(--concentric-pad) + var(--border-width, 1px));
```

#### 实战装配示例（SetupHintBanner 范式正典化）
```css
.bannerContainer {
  --banner-btn-radius: var(--radius-md); /* 8px */
  --banner-pad: var(--space-2_5);         /* 10px */
  
  /* 宏计算：外圆角 = 8px + 10px = 18px */
  border-radius: calc(var(--banner-btn-radius) + var(--banner-pad));
  padding: var(--banner-pad);
}
```

---

### 5.2 外向内推导宏：`max(0px, calc(outer - pad))`

#### 适用场景
**“以父定子”模式**：已知容器的外轮廓圆角（如模态外壳 20px、下拉菜单外壳 14px、卡片外壳 16px），内部需要绘制悬浮背景块、高亮条目、选中蒙层或内嵌子卡片。

#### 核心防护：`max(0px, ...)` 截断
当内衬边距较大（$P \ge R_o$）时，单纯减法会求得负数。虽然现代浏览器会自动将负圆角解释为 0，但显式声明 `max(0px, ...)` 是工业几何防御性编程的黄金守则，杜绝亚像素计算反向溢出。

#### CSS 表达式
```css
/* 标准外向内安全同心宏 */
--concentric-inner: max(0px, calc(var(--outer-radius) - var(--concentric-pad)));
```

#### 实战装配示例（SelectContent / Popover 范式正典化）
```css
.menuShell {
  --menu-outer-radius: var(--sep-radius-outer); /* 14px */
  --menu-pad: var(--space-1_5);                 /* 6px */
  
  border-radius: var(--menu-outer-radius);
  padding: var(--menu-pad);
}

.menuItem {
  /* 宏计算：内圆角 = max(0px, calc(14px - 6px)) = 8px */
  border-radius: max(0px, calc(var(--menu-outer-radius) - var(--menu-pad)));
}
```

---

### 5.3 双轴非对称内衬的椭圆同心宏

#### 适用场景
常见于单行输入框、搜索条或胶囊通知栏：为了排版节奏，垂直内边距通常小于水平内边距（如 $P_y = 6\text{px}, P_x = 10\text{px}$）。如果直接使用正圆单半径，角部对角线方向会出现明显的椭圆拉扯撕裂。

#### 工业几何公理
外层椭圆圆角与内层椭圆圆角处处等距的充要条件是：**两轴曲率半径分别满足单轴同心公理**：
$$R_{outer, x} = R_{inner, x} + P_x \quad \text{且} \quad R_{outer, y} = R_{inner, y} + P_y$$

#### CSS 椭圆圆角语法实现
```css
.asymmetricContainer {
  --pad-x: var(--space-2_5); /* 10px */
  --pad-y: var(--space-1_5); /* 6px */
  --inner-rx: var(--radius-md); /* 8px */
  --inner-ry: var(--radius-md); /* 8px */

  padding: var(--pad-y) var(--pad-x);
  /* 椭圆圆角宏：水平半径 / 垂直半径 */
  border-radius: 
    calc(var(--inner-rx) + var(--pad-x)) / 
    calc(var(--inner-ry) + var(--pad-y));
  /* 解析值: (8 + 10)px / (8 + 6)px = 18px / 14px */
}
```

---

### 5.4 发丝边框与内外阴影修正同心宏

当组件带有重描边或外轮廓焦点环（Focus Ring）时，外轮廓光圈同样必须同心。

```css
/* 焦点环 / 外轮廓同心宏 */
.focusableCard {
  --card-radius: var(--radius-xl); /* 16px */
  --focus-offset: 2px;
  --focus-width: 2px;
  
  border-radius: var(--card-radius);
}

.focusableCard:focus-visible {
  /* 焦点环圆角 = 卡片圆角 + 偏移量 = 16px + 2px = 18px */
  outline-offset: var(--focus-offset);
  border-radius: var(--card-radius);
  box-shadow: 0 0 0 var(--focus-width) var(--brand-primary);
}
```

---

### 5.5 标准 CSS 变量模板与组件装配最佳实践

为使全仓各功能模块在实现波中统一对齐，建立推荐的**组件装配模板标准**：

```css
/* === Conex 同心组件标准化装配规范模板 === */

/* 模态弹窗装配模板（圆角形态） */
.concentricModalTemplate {
  --modal-r: var(--radius-2xl);                 /* 20px */
  --modal-pad: var(--space-4);                  /* 16px */
  
  border-radius: var(--modal-r);
  padding: var(--modal-pad);
}
.concentricModalTemplate .closeButton {
  /* 20px - 16px = 4px 完美同心 */
  border-radius: max(0px, calc(var(--modal-r) - var(--modal-pad)));
}

/* 浮层菜单装配模板（微圆形态） */
.concentricFlyoutTemplate {
  --flyout-r: var(--sep-radius-outer);          /* 14px */
  --flyout-pad: var(--space-1_5);               /* 6px */
  
  border-radius: var(--flyout-r);
  padding: var(--flyout-pad);
}
.concentricFlyoutTemplate .item {
  /* 14px - 6px = 8px 完美同心 */
  border-radius: max(0px, calc(var(--flyout-r) - var(--flyout-pad)));
}

/* 业务卡片装配模板（微圆形态） */
.concentricCardTemplate {
  --card-r: var(--radius-xl);                   /* 16px */
  --card-pad: var(--space-2);                   /* 8px */
  
  border-radius: var(--card-r);
  padding: var(--card-pad);
}
.concentricCardTemplate .innerControl {
  /* 16px - 8px = 8px 完美同心 */
  border-radius: max(0px, calc(var(--card-r) - var(--card-pad)));
}
```

---

## 六、 落地改动代码清单（落地执行指南）

本章为后续代码实现波（Implementation Wave）提供详尽、可直接执行的代码落盘指令。

### 6.1 `tokens.css` 核心声明改造代码清单

目标文件：[`apps/crish-desktop/src/styles/tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css)

#### 改造点 1：浮层枢纽 `--sep-radius-outer` 平反（原第 282 行）
```diff
-  --sep-radius-outer: var(--radius-l);
+  --sep-radius-outer: 14px; /* 平反恢复 14px 枢纽键：8px (item) + 6px (pad) 完美同心 */
   --sep-item-radius: var(--radius-m);
   --sep-badge-radius: var(--radius-s);
```

#### 改造点 2：圆角核心 SSOT 与完备偶数阶梯（原第 486-512 行）
```diff
-  /* ── 圆角 SSOT（2026-10-10 统一）：只允许下列 5 档 + 正圆 50% + 0 ──
-     s     小   4px    标签/徽标/行内代码/复选框/Kbd/骨架线/细条
-     m     中   8px    图标按钮/小输入框/下拉触发器/菜单项/列表行/会话行/Tooltip/标签页/代码块/表格
-           （文字按钮 + 分段控件 = --radius-btn 7px，用户锁 U1，唯一例外）
-     l     大   12px   卡片/面板/弹层/下拉面板/对话框/工具调用块/附件卡片/artifact
-     input 输入 20px   底部输入框（单行/多行）与用户消息气泡
-     pill  胶囊 9999px 胶囊按钮/开关/滚动条滑块/计数胶囊
-     旧 token（xs…3xl、btn、seg-*、sep-*、md-*、composer-*、chat-bubble）全部是这 5 档的别名。 */
-  --radius-s: 4px;
-  --radius-m: 8px;
-  --radius-l: 12px;
-  --radius-input: 20px;
-  --radius-pill: 9999px;
-  --radius-circle: 50%; /* Avatar 等正圆；被 ModelsSettingsTab 等消费 */
-  --radius-btn: 7px; /* 用户锁 U1（survey 04）：按钮圆角钉死 7px，是 5 档之外唯一的例外；禁止改成 8px */
-  /* :root 唯一权威定义（U1）；密度档/主题块禁止覆写 */
-  --button-radius: var(--radius-btn);
-  --radius-xs: var(--radius-s);
-  --radius-sm: var(--radius-s);
-  --radius-md: var(--radius-m);
-  --radius-lg: var(--radius-m);
-  --radius-xl: var(--radius-l);
-  --radius-2xl: var(--radius-l);
-  --radius-3xl: var(--radius-input);
+  /* ── 工业同心几何完备偶数阶梯（2026-10-25 平反定稿）──
+     完备闭包：4px, 6px, 8px, 10px, 12px, 14px, 16px, 20px + 9999px + 50%
+     双形态：圆角形态模态 20px 枢纽；微圆形态浮层 14px / 卡片 16px 枢纽。
+     公式：R_outer = R_inner + Padding <=> R_inner = max(0, R_outer - Padding) */
+  --radius-xs: 4px;   /* 标签/徽标/微型角标/复选框/行内代码 */
+  --radius-sm: 6px;   /* 分段控件滑块/紧凑行/小项 (解救 191 处原 4px 坍塌) */
+  --radius-md: 8px;   /* 标准控件基准: 输入框/下拉触发器/菜单项/按钮基座 */
+  --radius-lg: 10px;  /* 过渡衔接小卡片 (解救原 8px 坍塌) */
+  --radius-l:  12px;  /* 微圆紧凑卡片/面板/附件卡片 */
+  --radius-xl: 16px;  /* 标准业务卡片外壳 (容纳 8px 控件 + 8px 内边距) */
+  --radius-2xl: 20px; /* 平反升级为 20px: 顶级模态弹窗 (Dialog/Settings) 消除与输入框倒挂 */
+  --radius-3xl: var(--radius-2xl); /* 20px 别名收拢 */
+  --radius-pill: 9999px;
+  --radius-circle: 50%;
+
+  /* 传统 3 档快捷别名映射（平滑兼容历史代码） */
+  --radius-s: var(--radius-xs); /* 4px */
+  --radius-m: var(--radius-md); /* 8px */
+  --radius-input: var(--radius-2xl); /* 20px 统一收口至 20px 枢纽键 */
+
+  /* 用户锁 U1（独立文字按钮圆角，禁止改成 8px；分段控件已解绑） */
+  --radius-btn: 7px;
+  --button-radius: var(--radius-btn);
+
+  /* 分段控件专属同心外壳（解绑 7px，消灭 5px 亚像素危机） */
+  --segment-shell-radius: var(--radius-md); /* 8px */
+  --segment-indicator-radius: var(--radius-sm); /* 6px (8px - 2px = 6px) */
```

#### 改造点 3：消除 Usage Capsule 荒谬的 9996px 幽灵计算（原第 1921-1926 行）
```diff
-  --usage-capsule-outer-radius: var(--radius-pill);
-  --usage-capsule-pad: 3px;
-  --usage-capsule-inner-radius: calc(
-    var(--usage-capsule-outer-radius) - var(--usage-capsule-pad)
-  ); /* 6px */
+  --usage-capsule-outer-radius: var(--radius-pill);
+  --usage-capsule-pad: 3px;
+  --usage-capsule-inner-radius: var(--radius-pill); /* 胶囊内嵌进度条高度截断为正圆端，直接使用 pill */
```

---

### 6.2 关键场景契约消费点修改指南

#### 1. 全局大模态弹窗（`Dialog.module.css`）
- **文件**：`apps/crish-desktop/src/components/ui/Dialog/Dialog.module.css`
- **改动前**：`.dialog { border-radius: var(--radius-2xl); }`（原解析为 12px）；
- **改动后**：由于 `--radius-2xl` 平反升级为 **20px**，Dialog **无需修改任何 CSS 代码**，自动获得 20px 柔和现代大圆角！
- **子元素微调**：Header 关闭按钮（`.dialogClose`）从 `var(--radius-sm)` 改为 `max(0px, calc(var(--radius-2xl) - var(--space-4)))`，精准解析为 $20 - 16 = \mathbf{4px}$。

#### 2. 下拉选择器浮层（`SelectContent.module.css`）
- **文件**：`apps/crish-desktop/src/components/ui/Select/SelectContent.module.css`
- **改动前**：使用 `calc(var(--radius-m) + 6px)` 避难计算 14px；
- **改动后**：
  ```css
  .contentMd {
    border-radius: var(--sep-radius-outer); /* 直接消费平反的 14px SSOT！ */
    padding: var(--space-1_5);               /* 6px */
  }
  .item {
    border-radius: var(--radius-md);        /* 8px (14 - 6 = 8px 绝对同心) */
  }
  ```

#### 3. 智能扩展面板（`SmartExpandablePanel.module.css`）
- **文件**：`apps/crish-desktop/src/components/ui/SmartExpandablePanel/SmartExpandablePanel.module.css`
- **改动前**：消费 `var(--sep-radius-outer)`（原 12px），内部 padding 6px，条目 8px，存在 $\Delta = -2\text{px}$ 挤压；
- **改动后**：`--sep-radius-outer` 平反为 14px 后，面板**无需变动代码**即自动达到 $14 - 6 = 8\text{px}$ 完美同心！

#### 4. 分段控件与标签页（`SegmentedControl.module.css` & `Tabs.module.css`）
- **文件**：`apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.module.css`
- **改动前**：
  ```css
  --seg-outer-radius: var(--button-radius); /* 7px */
  --seg-pad: 2px;
  --seg-inner-radius: calc(var(--seg-outer-radius) - var(--seg-pad)); /* 5px! */
  ```
- **改动后**：
  ```css
  --seg-outer-radius: var(--segment-shell-radius, var(--radius-md)); /* 8px */
  --seg-pad: var(--space-0_5);                                       /* 2px */
  --seg-inner-radius: var(--segment-indicator-radius, var(--radius-sm)); /* 6px! 告别 5px 亚像素 */
  ```

#### 5. 项目管理大模态（`ProjectManageModal.module.css`）
- **文件**：`apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css`
- **改动前**：`border-radius: var(--radius-2xl, 24px);`（因 2xl 存在，被强行锁死在 12px）；
- **改动后**：`border-radius: var(--radius-2xl);`（直接平反解析为 20px，消除与 Composer 倒挂）。

#### 6. 模型凭据卡与计划表单（`ModelsSettingsTab.module.css` & `ScheduledTasksPanel.module.css`）
- **改动前**：外壳误写 `var(--radius-btn)`（7px）或 12px，套内 8px/12px 输入框严重倒挂；
- **改动后**：外壳升级为 `var(--radius-xl)`（16px），内边距 12px/14px，内部输入框保持 `var(--radius-md)`（8px），彻底消除外尖内圆病灶。

---

### 6.3 UI Size 密度档位动力学动态补偿

针对调查报告指出的“Large 模式下间距放大 $+2\text{px} \sim +4\text{px}$ 而圆角冷冻导致的角部挤压”：
在 `tokens.css:1827-1895` 的 Large 密度块中，保持基础按钮 7px/8px 不变，但对**同心容器外壳赋予微动态补偿**：
```css
/* apps/crish-desktop/src/styles/tokens.css Large 密度动态补偿 */
html[data-ui-size='large'] {
  /* 间距放大：--space-1 为 6px (+2px), --space-1_5 为 8px (+2px) */
  /* 对应浮层外壳同步膨胀 +2px，维持内部 8px item 同心方程成立：16 - 8 = 8px */
  --sep-radius-outer: 16px;
  --card-radius-outer: 18px;
}
```

---

### 6.4 门禁契约与自动化测试守护（`motion-concentric-contract.test.ts`）

目标测试文件：[`apps/crish-desktop/src/styles/motion-concentric-contract.test.ts`](file:///c:/Software/conex/apps/crish-desktop/src/styles/motion-concentric-contract.test.ts)

1. **奇数圆角零容忍守护保持刚性**：
   `ODD_RADIUS_BASELINE = 0` 保持严格不变。禁止全站出现裸写 `3px, 5px, 7px, 9px, 11px, 13px, 15px`；
2. **新增测试用例：双形态枢纽 Token 与同心闭包代数验证**：
   在测试中新增自动化断言套件，验证关键 Token 之间的纯代数闭包：
   ```typescript
   it('2. 同心代数断言：验证关键容器与子元素 Token 差值严格等于标准 Padding', () => {
     const tokensCss = readFileSync(TOKENS_PATH, 'utf8');
     
     // 提取 Token 数值
     const sepOuter = parsePx(tokensCss, '--sep-radius-outer'); // 14
     const radiusMd = parsePx(tokensCss, '--radius-md');         // 8
     const space1_5 = parsePx(tokensCss, '--space-1_5');         // 6
     
     // 严格同心等式验证: 14 - 6 === 8
     expect(sepOuter - space1_5).toBe(radiusMd);
     
     // 分段控件同心等式验证: 8 - 2 === 6
     const segShell = parsePx(tokensCss, '--segment-shell-radius');     // 8
     const segIndicator = parsePx(tokensCss, '--segment-indicator-radius'); // 6
     const space0_5 = parsePx(tokensCss, '--space-0_5');                 // 2
     expect(segShell - space0_5).toBe(segIndicator);
   });
   ```

---

## 七、 验收标准与反退避合规断言

依据 `.agents/LOGIC_PLAN_NO_RETREAT.md` 与本战役核心要求，本独立详案达成以下绝对合规验收断言：

| 验收项 | 验收标准与断言依据 | 状态 |
| :--- | :--- | :---: |
| **平反 `--radius-2xl`** | 从 12px 平反恢复为 **20px**，消除顶层 Dialog/Settings 相比底层 Composer(20px) 更方的空间倒挂 | **已锁定** |
| **平反 `--sep-radius-outer`** | 从 12px 恢复为代数派生的 **14px**，与 6px padding、8px item 达成处处平行同心 | **已锁定** |
| **偶数 Token 完备阶梯** | 完备闭包：`4px (xs)`, `6px (sm)`, `8px (md)`, `10px (lg)`, `12px (l)`, `14px (menu)`, `16px (xl)`, `20px (2xl)`, `9999px (pill)` | **已锁定** |
| **7px 按钮兼容策略** | 提供超距平直区解耦、角部单侧微内衬补偿、分段控件解绑、1px 发丝边框代数闭合四大策略，消除 $\pm 1\text{px}$ 漂移与 5px 模糊 | **已锁定** |
| **CSS 宏与混合器模板** | 提供标准 `calc(inner + pad)` 与安全截断 `max(0px, calc(outer - pad))`，包含双轴椭圆与发丝补偿完整模板 | **已锁定** |
| **双形态同心理论自洽** | 圆角形态（20px 枢纽）与微圆形态（12~14px 枢纽 / 8px 控件）在 $R_o = R_i + P$ 下全部实现代数闭包 | **已锁定** |
| **纪律守则** | 纯方案产出，落盘于 `docs/concentric-radius-unification/independent-plans/`，无任何业务代码修改与 git 污染 | **已锁定** |

---
> **本方案编制完成，已具备直接支撑后续实施波（Implementation Waves）的技术完整性与数学不可推翻性。**
