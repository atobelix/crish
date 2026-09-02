# Conex / Crish 统一滚动条体系与 ScrollArea 高频组件战役 · 方案全景汇总索引

> **战役工作区**：`docs/unified-scrollbar-system/`  
> **总调度主控**：Antigravity Main Agent  
> **归档时间**：2026-09-02  
> **纪律遵循**：`docs/agent-roles/prompts/主控-全流程调度-v3.md`、`AGENTS.md`、`ANTI_OVERENGINEERING_GUARDRAILS.md`

---

## 一、战役方案产出资产清单（清单表）

| 相对路径 | 文档标题 | 行数 | 字节数 | 核心摘要与职责 |
| :--- | :--- | :---: | :---: | :--- |
| [`00-master-plan.md`](file:///c:/Software/conex/docs/unified-scrollbar-system/00-master-plan.md) | 战役最终维度定案与架构总纲 | 215 | 12.8 KB | 确立 6 大核心收敛维度、每个维度的删除面（Deletions Surface）、用户三大最高裁决与先删后改依赖次序。 |
| [`surveys/01-full-inventory-and-usage.md`](file:///c:/Software/conex/docs/unified-scrollbar-system/surveys/01-full-inventory-and-usage.md) | 全仓滚动条与宿主容器白盒普查报告 | 425 | 48.8 KB | 全量排查 63 个文件、186 处声明，捕获 18 处 `thin` 地雷与 11 处私有 WebKit 割据模块。 |
| [`independent-plans/02-arrow-buttons-and-engine-mechanism.md`](file:///c:/Software/conex/docs/unified-scrollbar-system/independent-plans/02-arrow-buttons-and-engine-mechanism.md) | 带上下圆角三角箭头的现代滚动条机制逆向与引擎选型 | 613 | 40.1 KB | 深入 Chromium Blink 内核 `CustomScrollbarTheme::TrackRect` 护栏算法，论证 8px 按钮防滑块越界与圆角截断机理。 |
| [`independent-plans/03-design-token-architecture.md`](file:///c:/Software/conex/docs/unified-scrollbar-system/independent-plans/03-design-token-architecture.md) | 统一滚动条设计系统 Token 体系与色彩物理学规范 | 734 | 39.6 KB | 纸温底板与色彩物理学推导，确立二元灰度（未激活 8.2% vs 激活 20.2%，差值 12%）与四级宽度 Token。 |
| [`independent-plans/04-scroll-area-component-plan.md`](file:///c:/Software/conex/docs/unified-scrollbar-system/independent-plans/04-scroll-area-component-plan.md) | 《ScrollArea》统一通用滚动条组件架构详案 | 1333 | 61.1 KB | 双轨架构设计，五大代数极限不变量定理证明，20Hz 脉冲微调步进动力学。 |
| [`audits/05-boundary-and-devil-audit.md`](file:///c:/Software/conex/docs/unified-scrollbar-system/audits/05-boundary-and-devil-audit.md) | 跨平台渲染防御、极端边界与魔鬼审计报告 | 686 | 43.1 KB | 审计出十大核心毒点，确立 Tier A/B/C 分级架构与 14px 圆角数学 Inset 防护方程。 |
| [`dimension-proposals/01-proposal-convergence.md`](file:///c:/Software/conex/docs/unified-scrollbar-system/dimension-proposals/01-proposal-convergence.md) | 战役维度建议详案（收敛与删除面视角） | 693 | 47.2 KB | 从“先删后改”角度梳理 5 大冲突路径，建议 6 大维度并为每个维度划定删除面。 |
| [`dimension-proposals/02-proposal-component.md`](file:///c:/Software/conex/docs/unified-scrollbar-system/dimension-proposals/02-proposal-component.md) | 战役维度建议详案（组件化与消费契约视角） | 538 | 47.7 KB | 梳理 Mode 1 与 Mode 2 落地次序，确立虚拟滚动零 DOM 包装隔离边界。 |
| [`dimension-proposals/03-proposal-rendering.md`](file:///c:/Software/conex/docs/unified-scrollbar-system/dimension-proposals/03-proposal-rendering.md) | 渲染防御与立体验证维度划分提案 | 773 | 60.0 KB | 深入攻防 Blink 互斥、14px 圆角断头台切角数学避让与高 DPI 晶格对齐。 |
| [`detailed-plans/01-plan-token-system.md`](file:///c:/Software/conex/docs/unified-scrollbar-system/detailed-plans/01-plan-token-system.md) | 维度 1：token-system 独立实现详案 | 674 | 45.4 KB | `tokens.css` 单一真理源，二元灰度绝对死锁（8.2% vs 20.2%），四级宽度 Token，删除面清单。 |
| [`detailed-plans/02-plan-purge-debts.md`](file:///c:/Software/conex/docs/unified-scrollbar-system/detailed-plans/02-plan-purge-debts.md) | 维度 2：purge-debts 独立实现详案 | 999 | 53.8 KB | 穷举式清除 18 处 `scrollbar-width: thin` 与 11 处私有 WebKit 块，代码净删除 208 行。 |
| [`detailed-plans/03-plan-engine-core.md`](file:///c:/Software/conex/docs/unified-scrollbar-system/detailed-plans/03-plan-engine-core.md) | 维度 3：engine-core 独立实现详案（已修订） | 985 | 66.1 KB | 重塑 `overlay-scrollbar.css` 唯一出口，裁剪未消费死层，发布 Mode 2 纯 CSS 工具类矩阵。 |
| [`detailed-plans/04-plan-scroll-area.md`](file:///c:/Software/conex/docs/unified-scrollbar-system/detailed-plans/04-plan-scroll-area.md) | 维度 4：scroll-area 独立实现详案（已修订） | 1792 | 95.6 KB | 落地 UI 原子组件，滑块绝对定位 `top`，Pointer Capture 拖拽引擎，圆角 Inset 避让与退化紧凑态。 |
| [`detailed-plans/05-plan-migrate-views.md`](file:///c:/Software/conex/docs/unified-scrollbar-system/detailed-plans/05-plan-migrate-views.md) | 维度 5：migrate-views 独立实现详案（已修订） | 1215 | 63.4 KB | 全仓 18+ 业务视口改造，消除嵌套双滚动条，保持虚拟列表 DOM 增量为 0，清洗 5 处 TSX 内联样式。 |
| [`detailed-plans/06-plan-gate-ratchet.md`](file:///c:/Software/conex/docs/unified-scrollbar-system/detailed-plans/06-plan-gate-ratchet.md) | 维度 6：gate-ratchet 独立实现详案（已修订） | 1083 | 68.4 KB | 彻底去白名单化，全仓禁 thin/禁非 auto color，重塑 `parseDarkness` 算法，跨包覆盖 `block-paper`。 |
| [`plan-reviews/01-review-architecture.md`](file:///c:/Software/conex/docs/unified-scrollbar-system/plan-reviews/01-review-architecture.md) | 架构收敛与路径重叠独立评审报告 | 732 | 48.0 KB | 捕获 WebKit 原生按钮与 DOM 按钮重叠死层、xs 按钮霸王条款与外部测试地雷，给出定夺裁决。 |
| [`plan-reviews/02-review-contracts.md`](file:///c:/Software/conex/docs/unified-scrollbar-system/plan-reviews/02-review-contracts.md) | 工程契约与物理渲染独立评审报告 | 542 | 36.0 KB | 捕获滑块 `translateY` 百分比脱靶 Bug、下限百分比混淆 Bug 与尖锐 SVG 缺陷，给出物理级修正。 |
| [`plan-reviews/03-review-crossplatform.md`](file:///c:/Software/conex/docs/unified-scrollbar-system/plan-reviews/03-review-crossplatform.md) | 跨平台与魔鬼边界独立评审报告 | 426 | 34.7 KB | 捕获门禁漏检 `scrollbar-color`、嵌套双滚动条与 `parseDarkness` 正则缺陷，给出 M01-M05 指令。 |

**战役全案总规模**：18 份深度架构与实施详案，累计 **13,874 行**，总计 **759 KB** 纯白盒代码级技术沉淀。

---

## 二、用户三大最高定案铁律全面对齐证明

### 1. 严格二元灰度绝对死锁（绝无第三种 Hover 灰）
- **未激活态（Inactive / Idle）**：实测物理灰度严格稳定在 **8.2% 左右**（`hsl(35 8% 91.8%)` 混入 8% 暖橙 `var(--accent-orange)`，通道差 $\Delta(R-B) = +4$）；
- **激活态（Active，Hover 与 Active 严格同色同值）**：实测物理灰度从当前过深的 31.4% 彻底下调至 **20.2% 左右**；
- **差值死锁**：激活态与未激活态之间保持严格的 **约 12.0% 增量阶梯**；
- **全案合流**：全仓所有 CSS、TypeScript 契约与门禁测试中，彻底废除 `--scrollbar-thumb-hover`，`:hover` 与 `:active` 在选择器层合并统一消费 `--scrollbar-thumb-active`！

### 2. 四级 Token 宽度体系（严禁硬编码像素）
- `--scrollbar-width-xs: 4px`（超细：模型选择浮层、代码补全 Popover）；
- `--scrollbar-width-sm: 5px`（紧凑：侧栏、二级下拉、抽屉面板）；
- `--scrollbar-width-md: 7px`（标准系统默认 SSOT：聊天流、正文编辑器、设置页）；
- `--scrollbar-width-lg: 9px`（宽屏大视口：宽屏双栏对比、超长 DiffCard、海量日志）；
- 严禁在业务 CSS 与 TSX 中裸写任何像素值。

### 3. 上下圆角三角箭头端点物理护栏（防滑块越界与圆角截断）
- 在 `<ScrollArea>` 中落地三段式物理隔离轨道布局，代数证明极限位置恒有 2px 净空，滑块绝不侵入按钮；
- 结合 `calculateSafeAreaInset(radius, margin)` 动态几何避让，彻底根除 14px 浮层圆角的断头台切角（Corner Clipping Free）；
- 装配 20Hz 脉冲微调步进引擎（40px/250ms/50ms 连发自动刹车）与 Pointer Capture 滑块鼠标拖拽引擎。

---

## 三、后续执行路线图（先删后改，6 大波次）

```
┌────────────────────────────────────────────────────────────────────────┐
│ 波次 1: 维度 1 (token-system) —— 注入二元灰度与四级宽度 Token 基底     │
├────────────────────────────────────────────────────────────────────────┤
│ 波次 2: 维度 2 (purge-debts) —— 解绑前置测试 + 物理拔除 18 处 thin 地雷│
├────────────────────────────────────────────────────────────────────────┤
│ 波次 3: 维度 3 (engine-core) —— 重塑 overlay-scrollbar 唯一出口与类名  │
├────────────────────────────────────────────────────────────────────────┤
│ 波次 4: 维度 4 (scroll-area) —— 落地 UI 原子组件与 10 组单元测试       │
├────────────────────────────────────────────────────────────────────────┤
│ 波次 5: 维度 5 (migrate-views) —— 全仓 18+ 视口分级改造与 TSX 清洗    │
├────────────────────────────────────────────────────────────────────────┤
│ 波次 6: 维度 6 (gate-ratchet) —— 彻底粉碎白名单，闭合负向刚性门禁      │
└────────────────────────────────────────────────────────────────────────┘
```
