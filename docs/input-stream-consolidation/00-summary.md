# 00 · 汇总索引（统一输入流收敛战役 · 二十二份审计全部收齐）

> 更新：2026-08-16 · 批 1–4（六维/核心扩展撤回/前端专项/状态维度）+ 批 5（前端补位/参考深挖/对比分析）全部完成。
> 执行轮：R1–R9 全部完成（R9 收束轮 2026-08-16，HEAD=`2c2c7882`）；本文件为战役终版索引。
> 纪律：本索引为快速入口；证据回 analysis/ 各文档；结论以主控定夺（00-总方案 §3.1、00-核心逻辑模型草案）为准。

## 产出清单

| 文件                                    | 行数 | 摘要                                                                                                                                        |
| --------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 00-总方案框架.md                        | 148  | 概念模型（节点/时间线/来源/扩展点 A/B/C/D）/ 现状映射 + §3.1 修正 / 核心决策 / D1–D5 框架 / §2.4 撤回设计（已验证）                         |
| 00-核心逻辑模型草案.md                  | 160+ | 七不变量（含状态生命周期/编辑保护）/ 七步链核心 / 核心缝面 / 前端原则 / 扩展点 A–D / 架构方向 / 抽象纪律                                    |
| plans/00-详案任务书模板.md              | 40   | 详案五段式模板（做什么/删什么/依赖/文件域/验收）                                                                                            |
| plans/01-详案任务书-五维.md             | —    | D1–D5 详案任务书（草案，待用户确认后生效）                                                                                                  |
| analysis/01-统一时间线与消息类型审计.md | 161  | 7 层消息类型；LS 活动镜像层；append_session_messages 死层；事件流骨架成立                                                                   |
| analysis/02-注入文本化审计.md           | 202  | 状态切换零时间线通道；reasoning_effort 半连通；nudge 未接线；PendingMessageQueue 可复用                                                     |
| analysis/03-权限审查路径审计.md         | 141  | 前端/引擎两套发散分类；无 deny 绕过；「按工具类别分类」不存在；PermissionBehavior 死类型                                                    |
| analysis/04-展示投影层审计.md           | 210  | 渲染主路径 = timelineNormalizer；UserView 旁路（虚假对位修正）；折叠行半实现；官方图标缺失                                                  |
| analysis/05-插件边界审计.md             | 119  | 无统一插件运行时（≥4 条隔离路径）；ContributeViewRegistry 双实现死层；A/B/C 零承载                                                          |
| analysis/06-重复与死层横切审计.md       | 231  | 基线：波次命名 33 / 未接线 2,867 token·689 文件 / 无日期 fallback 71 / 被跟踪 db 6 / 多 app 重复 5 组 / 陪葬测试 8 核心 / >1500 行 38       |
| analysis/07-核心循环逻辑审计.md         | 197  | 七步链确认；复杂度主战场 = handlers/mod.rs 压缩编排 ~590 行内嵌；orchestrator/session.rs 命名纠正                                           |
| analysis/08-可扩展功能盘点.md           | 163  | 32 行功能盘点表；天然可插拔域清单；双队列收敛前置；C 双通道合一；D5 改 Rust 侧承载                                                          |
| analysis/09-扩展机制与核心解耦审计.md   | 209  | 核心认知/不可知缝面；两条反向依赖硬编码（主控亲验）；R1–R8 规则                                                                             |
| analysis/10-撤回截断能力现状审计.md     | 152  | 停 run 成熟可复用；trash.rs 为回滚底座（revert_guard 纠正）；timeline-truncate 零先例；移动端只追加反例                                     |
| analysis/11-前端组件架构审计.md         | 208  | 原子化基础设施已存在但门禁失败（Dialog/Menu）；上帝组件 2 个；样式 94% token 化；落地路径                                                   |
| analysis/12-前端状态与数据流架构审计.md | 208  | 上帝 store 实证；消息双份存储；storeAccess 三份；单一投影 store 收敛方向                                                                    |
| analysis/13-流式与增量状态审计.md       | 148  | text/thought 已完整事件化（增量+兜底）；tool-update 零 UI 消费 + 落库语义错位（Critical+Persist）；前端无统一节点状态维度                   |
| analysis/14-执行过程状态审计.md         | 160  | run 无进行中事件；审批挂起 = 状态节点范例模板；tool-update 死契约；pty 外部域；写文件不加进度事件（反过度设计）                             |
| analysis/15-编辑保护与状态一致性审计.md | 128  | CAS 真身 = CT-01（cas.rs 命名撞词）；dirtyRef 开环脏标；编辑会话事件（不可丢）+ 失效传播；双 follow_up 竞态残留                             |
| analysis/16-前端核心功能边界审计.md     | 138  | plugins 全树零 import 死代码；真实可插拔 = React.lazy + compositionRoot；Tiptap 可选增强（硬编码无回退）；sessionStore 为 facade（修正 12） |
| analysis/17-可定制体系审计.md           | 185  | 定制状态 = 配置/偏好投影（独立带不进 seq）；核心可定制面 4 项；主题已收敛单写端（538 token）；布局只改编排层                                |
| analysis/18-UI完整性保障审计.md         | 180  | 完整性不变量 ✅（错误边界 13+3、四态齐备、插件缺失不白屏）；缺口 P0 引擎崩溃无感知/孤儿 run、P1 markdown 空白体                             |
| analysis/19-多端与移动端定位审计.md     | 204  | mobile = 远端事件流消费者（投影模型近理想）；共享面极窄 → 投影原语收敛；workbench = 引擎宿主+调试壳                                         |
| analysis/20-pi核心设计模型审计.md       | 258  | Pi 三轨并存（Entry/LaneRecord/Snapshot）；validateRecordLog 拒腐；before_* 覆盖式扩展点；writer_leases；快照权威+revision                   |
| analysis/21-dsh核心设计模型审计.md      | 316  | 模型可见⟺已落日志硬不变量；declare-merge 三方扩展；stateVersion/restoreFloor 门禁；转录 vs 表面区分；折叠状态机+keyed slot                  |
| analysis/22-三软件对比分析与借鉴清单.md | 130+ | 四部分对比（未来/当前/DSH/Pi）+ 维度表回填 + 借鉴清单 10 项 + 模型层定夺 D1-D3 + 未考虑清单 M/E/P 14 项                                     |

## 收敛度量基线（Δ 起点，重测命令 `node scripts/check-convergence-metrics.mjs`）

| 指标                        | 基线                                                          |
| --------------------------- | ------------------------------------------------------------- |
| 未接线/临时标记             | 2,867 token / 689 文件                                        |
| 波次命名文件                | 33                                                            |
| 无日期 fallback（核心口径） | 71                                                            |
| 被 git 跟踪运行产物         | 6（apps/agent-workbench：sessions.db* ×3 + workspace.db* ×3） |
| 多 app 概念重复对           | 5 + desktop 内 storeAccess 三份                               |
| 陪葬测试候选                | 核心 8（宽口径约 20）                                         |
| >1500 行文件                | 38（生产 31 + 测试 7）                                        |
| 上帝组件（有效行口径）      | 2（InlineAgentPanel 621 / TiptapEditorField 477）             |
| 原子层门禁违规              | 2（Dialog/Menu）+ 测试面扫描缺口                              |

## 收敛度量终值（R9 收束实测，2026-08-16 · `node scripts/check-convergence-metrics.mjs`）

| 指标                        | 终值                                                                        |
| --------------------------- | --------------------------------------------------------------------------- |
| 未接线/临时标记（marker）   | **690 files / 2695 lines / 2857 tokens**（基线 689/2709 → 终值）            |
| 波次命名文件                | **0**（36 → 0，X1 R8：d8b60a7e/a7784898/c13de2ad/b7ba5159 + 补提 2f4df2f5） |
| 被 git 跟踪运行产物         | **0**（6 → 0，X1b 解禁 + .gitignore 锚定）                                  |
| 无日期 fallback（核心口径） | 60（fallbackCandidates 脚本口径）                                           |
| 巨文件 >1500 行             | 39 production / 12 test                                                     |
| 陪葬测试候选                | 18（graveTestCandidates）                                                   |
| 行数门禁（--all）           | 0 VIOLATION / 0 WARNING / 0 HARD BLOCK / 63 BASELINE（829 文件）            |
| 收敛硬闸（CI lint）         | hardGate true（trackedRuntimeArtifacts=0 + waveNamedFiles=0）               |

## 核心定夺（十二份审计的汇总结论）

1. **核心骨架已确认干净**：七步链 + dispatch_once 33 行；复杂度主战场 = handlers/mod.rs 压缩编排外置 + 两条反向依赖移出 + 三个缺缝面（compaction/cache_tracker/summary）。
2. **前端问题最大且已有解**：原子化基础设施存在但门禁失守（S0 清零）；上帝 store + 消息双份 + storeAccess 三份 → 单一投影 store。
3. **扩展承载面修正**：A/B/C/D 中 B/D 只能在 Rust 侧承载；TS 插件轨（B 轨/ContributePointRegistry）无宿主消费；天然可插拔域已存在（ToolRegistry/HookRegistry/Summarizer/SubagentSpawner/MCP），只差显式登记。
4. **撤回已验证**：停 run 复用、回滚走 trash.rs、timeline-truncate 新建、文本回填取节点、移动端只追加反例须收敛。

## 轮次交付摘要（R1–R9 · 执行轮）

| 轮次  | 交付（提交）                                                                           | 要点                                                                                                          |
| ----- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| R1-R2 | T1a/T1b/T2-1/T2-3/I1-α（67d40afc/167fb016/c8b68546 等）                                | 事件模型扩展、持久化轨剥 LS 镜像、append_session_messages 死层删除、队列归一（PendingMessageQueue canonical） |
| R3    | T2-2 部分/T3（15d38f54/018dad5c）                                                      | 前端类型单源化（HistoryMessage 派生/事件纯解包/blockText 单源）；LS 主体删除转收尾轮                          |
| R4    | C1a/C1b/C1c（40a2d879/d34d5832/1c20b8e4）                                              | 压缩编排外置（−645 行）、BackupMiddleware/RecoverySteering 默认实例清空、三缝面登记不抽象                     |
| R5    | T4/V1（01be2074/aaa68087）                                                             | componentAccess 整删、展示投影归一（UserView 旁路 1598 行删）、折叠单源                                       |
| R6    | R1/P1/I1-β（317d7c5a/5a459069/938820a4）                                               | 撤回六步链 + timeline-truncate、权限归一 fail-closed、context-state 产生器接线                                |
| R7    | E1/R2a/F1/R2b（96d1df60/e0100ebf/1894bda0/f09eb898）+ 收口                             | 插件轨 1347+896 行删、编辑会话抽象（dirtyRef 开环删）、F1 原子化、编辑失效传播四路接线                        |
| R8    | X1/T5/E2（d8b60a7e+a7784898+c13de2ad+b7ba5159/22ed68bf/732606be）                      | 波次命名 36→0、db 解禁 6→0、崩溃三态/孤儿收割/全局错误、扩展门面登记（A/B/C/D 承载面）                        |
| R9    | 遗留评估 b6aacec0 + X1 补提 2f4df2f5 + 插件轨终裁 25762dc1 + D0 修复 2c2c7882 + 收束轮 | E2 A/B 轨整包清零（51 文件 −12,036 行）、line-counts 基线登记、D0 终回填、收口报告                            |

> 提交链尾（HEAD=`2c2c7882`，分支 refactor/architecture）：`b7ba5159`(X1 三文件补提) → `b6aacec0`(R9 遗留评估) → `2f4df2f5`(X1 补提) → `25762dc1`(插件轨终裁删除) → `dbfeeac1`(R9 回填) → `2c2c7882`(D0 修复)。战役收束后改动留工作区由主控统一提交。

## 遗留转后续清单（R9 遗留评估终裁：结案 10 / 转后续 15 / 需用户决策 0）

- **T2-2 主体删除收尾轮**：Rust `upsert_session_entry` 命令 + manifest + 前端索引迁移 + LS 整删 + 回退文件删除 + 测试适配（D0 §1 三行）。
- **需求登记转后续**：M1/M4 剩余/M5、组件状态通用策略、通知状态机残项、UI 按钮行规则（E3/前端小战役候选）。
- **`AgentInputQueue` 结构收敛**：低优先结构轮（语义已归一）。
- **line-counts 拆分队列**：63 条基线拆分归 SR-06 结构轮（登记 ≠ 拆分完成）。
- **CDP 真跑 QA 轮**：真实 Tauri WebView2 冒烟（T5 §5 验收 1/2/5/6）。
- **mobile typecheck 基线 16 错**：修复归属待主控裁定。
- 详情：`execution/R9-收口报告.md` §3、`execution/R9-遗留评估.md` §9。

## 下一步（战役收束后）

战役已收束；后续为**遗留转后续清单**逐项派发（T2-2 收尾轮 / 前端小战役 / SR-06 结构轮 / QA 轮）+ 主控统一提交收束改动 + 全量回归快照存档。
