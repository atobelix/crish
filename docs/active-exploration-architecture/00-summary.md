# Agent 主动探查架构收敛战役 — 文档与产出索引

> **战役定位**：彻底废弃「被动后台逃逸监视与旁路注入」死层，收敛并确立「Agent 按需主动探查上下文」为唯一合法范式，从根源根除 `sess-1786855835905` 死循环自激雪崩故障。
> **基准不变量**：收敛先于增强、净负产出（净删除 $\ge 1000$ 行）、禁止私留死层、1 Turn = 1 Message。

---

## 一、 总方案与架构定案

| 文件路径                                                                     | 标题 / 职责            | 状态     | 核心内容摘要                                                                                              |
| :--------------------------------------------------------------------------- | :--------------------- | :------- | :-------------------------------------------------------------------------------------------------------- |
| [`00-总方案-Agent主动探查架构收敛.md`](./00-总方案-Agent主动探查架构收敛.md) | 主控战役总方案（定案） | **定案** | 确立 4 个执行维度，统一裁决执行主基线，规定「先删后改」严格执行时序与负产出度量表（预计净删 ~1,830 行）。 |

---

## 二、 独立方案矩阵（6 份）

| 编号   | 文件路径                                                                                                                             | 标题                                             | 责任 Agent           | 评审结论                                                                                                               |
| :----- | :----------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------- | :------------------- | :--------------------------------------------------------------------------------------------------------------------- |
| **01** | [`independent-plans/01-escape-watch-removal-plan.md`](./independent-plans/01-escape-watch-removal-plan.md)                           | 逃逸监视死层物理剔除与装配解绑详案               | Agent 1 (`85462c8f`) | **【采纳为执行基线】** 物理删除 `escape_watch.rs` 与 `undeclared_detector.rs`（-1091 行），全面解绑内核与壳层。        |
| **02** | [`independent-plans/02-control-bus-followup-purification-plan.md`](./independent-plans/02-control-bus-followup-purification-plan.md) | ControlBus 队列治理与 Follow-Up 语义纯化方案     | Agent 2 (`ae2ff0a0`) | **【修正后采纳】** 移除 `ControlBusInjector`，确立 `FollowUpSource` 强类型白名单，对齐方案 01 彻底删除监视器。         |
| **03** | [`independent-plans/03-active-exploration-toolchain-plan.md`](./independent-plans/03-active-exploration-toolchain-plan.md)           | Agent 主动探查工具链健壮性与 PowerShell 防护方案 | Agent 3 (`cdef6ccc`) | **【完整采纳】** 确立主动结构化工具优先，外壳优先 `pwsh7`，`try-catch [ParseException]` 捕获与自愈提示，杜绝黑盒重写。 |
| **04** | [`independent-plans/04-session-messages-turn-isolation-plan.md`](./independent-plans/04-session-messages-turn-isolation-plan.md)     | 会话消息存储与事件分轮次隔离治理方案             | Agent 4 (`0d417fb1`) | **【完整采纳】** 击穿 Message Smashing，废除 `join('\n\n')`，确立 1 Turn = 1 SessionMessage 独立实体与增量落盘。       |
| **05** | [`independent-plans/05-test-suite-cleanup-and-regression-plan.md`](./independent-plans/05-test-suite-cleanup-and-regression-plan.md) | 测试资产审查与陪葬测试清洗方案                   | Agent 5 (`3dd6916e`) | **【采纳为测试基线】** 清洗 26+ 个死层陪葬测试（-485 行），严格保护 18 个锁测试与沙箱测试，新增零被动注入回归套件。    |
| **06** | [`independent-plans/06-architecture-contract-convergence-plan.md`](./independent-plans/06-architecture-contract-convergence-plan.md) | 全局架构与跨语言契约收敛详案                     | Agent 6 (`bdeee036`) | **【裁决纠偏】** 吸收其 `SessionLoopOptions` 契约清理，废弃其企图在壳层保留监视器的主张，全面服从方案 01。             |

---

## 三、 评审报告矩阵（2 份）

| 编号   | 文件路径                                                                                                   | 标题                       | 评审 Agent          | 核心评审结论                                                                                        |
| :----- | :--------------------------------------------------------------------------------------------------------- | :------------------------- | :------------------ | :-------------------------------------------------------------------------------------------------- |
| **R1** | [`plan-reviews/01-dimension-cross-review.md`](./plan-reviews/01-dimension-cross-review.md)                 | 维度交叉审查与冲突识别报告 | 评审 1 (`984cf812`) | 解决 4 大交叉冲突，确立方案 01/05 为唯一合法基线，驳回方案 06 壳层保留监视器提议。                  |
| **R2** | [`plan-reviews/02-negative-yield-and-risk-review.md`](./plan-reviews/02-negative-yield-and-risk-review.md) | 负产出与死层删除审查报告   | 评审 2 (`df37151c`) | 精确核算全仓毛删除 1,948 行、新增 220 行、**净删除 -1,728 行**（达成率 172.8%），严防死层借尸还魂。 |
