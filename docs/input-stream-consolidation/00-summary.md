# 00 · 汇总索引（统一输入流收敛战役 · 十五份审计全部收齐）

> 更新：2026-08-16 · 批 1（六维）+ 批 2（核心/扩展/撤回）+ 批 3（前端专项）+ 批 4（状态维度）全部完成。
> 纪律：本索引为快速入口；证据回 analysis/ 各文档；结论以主控定夺（00-总方案 §3.1、00-核心逻辑模型草案）为准。

## 产出清单

| 文件                                    | 行数 | 摘要                                                                                                                                  |
| --------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 00-总方案框架.md                        | 148  | 概念模型（节点/时间线/来源/扩展点 A/B/C/D）/ 现状映射 + §3.1 修正 / 核心决策 / D1–D5 框架 / §2.4 撤回设计（已验证）                   |
| 00-核心逻辑模型草案.md                  | 160+ | 七不变量（含状态生命周期/编辑保护）/ 七步链核心 / 核心缝面 / 前端原则 / 扩展点 A–D / 架构方向 / 抽象纪律                              |
| plans/00-详案任务书模板.md              | 40   | 详案五段式模板（做什么/删什么/依赖/文件域/验收）                                                                                      |
| plans/01-详案任务书-五维.md             | —    | D1–D5 详案任务书（草案，待用户确认后生效）                                                                                            |
| analysis/01-统一时间线与消息类型审计.md | 161  | 7 层消息类型；LS 活动镜像层；append_session_messages 死层；事件流骨架成立                                                             |
| analysis/02-注入文本化审计.md           | 202  | 状态切换零时间线通道；reasoning_effort 半连通；nudge 未接线；PendingMessageQueue 可复用                                               |
| analysis/03-权限审查路径审计.md         | 141  | 前端/引擎两套发散分类；无 deny 绕过；「按工具类别分类」不存在；PermissionBehavior 死类型                                              |
| analysis/04-展示投影层审计.md           | 210  | 渲染主路径 = timelineNormalizer；UserView 旁路（虚假对位修正）；折叠行半实现；官方图标缺失                                            |
| analysis/05-插件边界审计.md             | 119  | 无统一插件运行时（≥4 条隔离路径）；ContributeViewRegistry 双实现死层；A/B/C 零承载                                                    |
| analysis/06-重复与死层横切审计.md       | 231  | 基线：波次命名 33 / 未接线 2,867 token·689 文件 / 无日期 fallback 71 / 被跟踪 db 6 / 多 app 重复 5 组 / 陪葬测试 8 核心 / >1500 行 38 |
| analysis/07-核心循环逻辑审计.md         | 197  | 七步链确认；复杂度主战场 = handlers/mod.rs 压缩编排 ~590 行内嵌；orchestrator/session.rs 命名纠正                                     |
| analysis/08-可扩展功能盘点.md           | 163  | 32 行功能盘点表；天然可插拔域清单；双队列收敛前置；C 双通道合一；D5 改 Rust 侧承载                                                    |
| analysis/09-扩展机制与核心解耦审计.md   | 209  | 核心认知/不可知缝面；两条反向依赖硬编码（主控亲验）；R1–R8 规则                                                                       |
| analysis/10-撤回截断能力现状审计.md     | 152  | 停 run 成熟可复用；trash.rs 为回滚底座（revert_guard 纠正）；timeline-truncate 零先例；移动端只追加反例                               |
| analysis/11-前端组件架构审计.md         | 208  | 原子化基础设施已存在但门禁失败（Dialog/Menu）；上帝组件 2 个；样式 94% token 化；落地路径                                             |
| analysis/12-前端状态与数据流架构审计.md | 208  | 上帝 store 实证；消息双份存储；storeAccess 三份；单一投影 store 收敛方向                                                              |
| analysis/13-流式与增量状态审计.md       | 148  | text/thought 已完整事件化（增量+兜底）；tool-update 零 UI 消费 + 落库语义错位（Critical+Persist）；前端无统一节点状态维度             |
| analysis/14-执行过程状态审计.md         | 160  | run 无进行中事件；审批挂起 = 状态节点范例模板；tool-update 死契约；pty 外部域；写文件不加进度事件（反过度设计）                       |
| analysis/15-编辑保护与状态一致性审计.md | 128  | CAS 真身 = CT-01（cas.rs 命名撞词）；dirtyRef 开环脏标；编辑会话事件（不可丢）+ 失效传播；双 follow_up 竞态残留                       |

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

## 核心定夺（十二份审计的汇总结论）

1. **核心骨架已确认干净**：七步链 + dispatch_once 33 行；复杂度主战场 = handlers/mod.rs 压缩编排外置 + 两条反向依赖移出 + 三个缺缝面（compaction/cache_tracker/summary）。
2. **前端问题最大且已有解**：原子化基础设施存在但门禁失守（S0 清零）；上帝 store + 消息双份 + storeAccess 三份 → 单一投影 store。
3. **扩展承载面修正**：A/B/C/D 中 B/D 只能在 Rust 侧承载；TS 插件轨（B 轨/ContributePointRegistry）无宿主消费；天然可插拔域已存在（ToolRegistry/HookRegistry/Summarizer/SubagentSpawner/MCP），只差显式登记。
4. **撤回已验证**：停 run 复用、回滚走 trash.rs、timeline-truncate 新建、文本回填取节点、移动端只追加反例须收敛。

## 下一步

用户确认决策点（核心模型 §6 / 详案任务书开头）→ 执行轮 D1 → D3 → D2 → D4 → D5，每轮含删除动作并回填本表 Δ。
