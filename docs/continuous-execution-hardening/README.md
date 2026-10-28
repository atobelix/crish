# 全天候自主 Agent 连续运行与健壮性改造战役 (Continuous Execution Hardening)

> **战役使命**：彻底消除导致 Agent 被迫暂停、假死、审批阻塞或异常终止的全链路系统缺陷，实现真正 24/7 全天候连续自主运行。
> **工程铁律**：**严禁打补丁，严禁硬编码；合理抽象，面向未来；坚决删除历史包袱代码，系统性重构；减少不必要的兼容，最好是不兼容；一次性彻底解决。**

---

## 战役三轮流程设计 (Three-Round Hardening Workflow)

- **第一轮：系统方案生成 (Plan Generation)**
  - 数量：7 个子 Agent（封顶 8 个，独立领域、互不重叠）；
  - 产出目录：`docs/continuous-execution-hardening/plans/`；
  - 目标：各核心子系统系统性重构详案，给出明确的数据结构抽象、状态机流转、接口契约及要删除的历史包袱清单。
- **第二轮：跨维度方案交叉评审 (Plan Review)**
  - 数量：3 个子 Agent（赋予写权限，为第三轮改进做准备）；
  - 产出目录：`docs/continuous-execution-hardening/plan-reviews/`；
  - 目标：从架构一致性、死锁与竞态、性能与资源治理三大维度进行魔鬼用例与极限压力审查。
- **第三轮：方案综合改进与落地对齐 (Plan Improvement & Convergence)**
  - 责任主体：延续第二轮的 3 个子 Agent；
  - 产出目录：`docs/continuous-execution-hardening/plan-improvements/`；
  - 目标：根据评审意见就地修改改进方案，收口至全局落地实施详案。

---

## 第一轮：方案生成矩阵 (Round 1: Plan Generation Matrix)

| 编号 | 方案模块 | 核心重构范围 | 责任 Agent | 产出路径 |
|:---|:---|:---|:---|:---|
| **P-01** | **权限模式与安全抽象** | 废弃字符串比较，建立强类型权限上下文；FullAccess 一等公民化；消除 Legacy 审批陷阱；Redline 统一结构化拦截。 | Architect-1 | [`01-permission-system-redesign.md`](./plans/01-permission-system-redesign.md) |
| **P-02** | **无人值守审批策略引擎** | 废除 120s 刚性超时报错；构建多维超时策略引擎（Allow/Deny/Degrade）；补齐死锁检测；双锁合并与对账。 | Architect-2 | [`02-approval-policy-engine.md`](./plans/02-approval-policy-engine.md) |
| **P-03** | **前端交互与审批生命周期** | 前端时钟源与服务端绝对时间戳对齐；三阶段进度条与双语义徽标；消除僵尸卡片死锁；休眠断连对账。 | Architect-3 | [`03-frontend-approval-lifecycle.md`](./plans/03-frontend-approval-lifecycle.md) |
| **P-04** | **核心会话循环与状态机** | 重构 turn_complete 决断阶梯；引入 LivenessGuard 活性守门与自驱心跳；解耦 64 轮死刑；生产环境装配异常自愈阶梯。 | Architect-4 | [`04-session-loop-state-machine.md`](./plans/04-session-loop-state-machine.md) |
| **P-05** | **长程上下文与金字塔摘要** | 拔除单 Run 1 次压缩限制；建立中性 Stub 零崩溃降级；实现分层摘要金字塔聚拢；固定槽位实现 100% KV Cache 命中。 | Architect-5 | [`05-context-compaction-pyramid.md`](./plans/05-context-compaction-pyramid.md) |
| **P-06** | **全天候自主驱动与心跳** | 消除单 Run 限制，建立跨 Episode 连续续跑引擎；修复 WakeWatcher 空消息与 Poison-Pill 队列清除；建立未决事件死信队列。 | Architect-6 | [`06-autonomous-drive-engine.md`](./plans/06-autonomous-drive-engine.md) |
| **P-07** | **弹性容灾与系统资源看门狗** | 动态放宽重试预算（对齐 300s+ Retry-After）；细粒度三态断路器主动唤醒；Windows 父进程探针防孤儿逃逸；内存 O(1) 滑动窗口。 | Architect-7 | [`07-resilience-and-resource-watchdog.md`](./plans/07-resilience-and-resource-watchdog.md) |

---

## 战役工作区结构规范

```text
docs/continuous-execution-hardening/
├── README.md                              # 本战役导航索引与流水线规范
├── 00-continuous-execution-master-plan.md    # 战役总纲方案
├── analysis/                              # 第一阶段：6 大专项深度审查报告
│   ├── 01-frontend-and-interaction.md
│   ├── 02-approval-gate-and-timeout.md
│   ├── 03-full-access-and-permissions.md
│   ├── 04-session-loop-and-state-machine.md
│   ├── 05-context-growth-and-compaction.md
│   └── 06-autonomous-drive-and-resilience.md
├── plans/                                 # 第一轮：7 大子系统系统性重构方案
│   ├── 01-permission-system-redesign.md
│   ├── 02-approval-policy-engine.md
│   ├── 03-frontend-approval-lifecycle.md
│   ├── 04-session-loop-state-machine.md
│   ├── 05-context-compaction-pyramid.md
│   ├── 06-autonomous-drive-engine.md
│   └── 07-resilience-and-resource-watchdog.md
├── plan-reviews/                          # 第二轮：3 大维度交叉评审报告
└── plan-improvements/                     # 第三轮：3 大综合改进详案
```
