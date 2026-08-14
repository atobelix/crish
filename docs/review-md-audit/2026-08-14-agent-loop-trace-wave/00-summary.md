# 00 · 战役汇总索引 —— 2026-08-14 agent-loop-trace-wave

> 战役目标：agent 循环过程的全链路可追溯性与原子化观测——「任何一个动作是否都有完整、连贯、单一的全链条记录，能否从任意节点回溯整条链、能否对每个原子动作单独观测」。
> 审计方式：内部代码审计（只针对本项目，不参考外部软件）。
> 状态：第一轮 10 维度检查全部完成（2026-08-14）。

## 检查产出清单

| #   | 文件                           | 标题                      | 行数 | 摘要（核心判定）                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------ | ------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 01-事件覆盖完整性.md           | 事件覆盖完整性            | 167  | 主链（run→turn→message→tool）可追溯，但「每个动作都有事件」不达标：checkpoint/tool-input-repaired 为契约死事件（无生产发射点）；摘要后台任务是事件流黑洞（仅日志）；孤儿 turn-start（中断路径无 turn-end）；steering/熔断/控制总线/长度阶梯全部无声；工具批 calls 恒空 Vec；hook 结果不可辨。                                                                                                                                                                                                 |
| 2   | 02-run生命周期与事件归属.md    | run 生命周期与事件归属    | 214  | **按 run 追溯不畅通（结构性最大缺口）**：信封 runId 只在广播时构造，落库永远只写事件体（events.rs:189）→ events 表无 run_id 列、payload 无 runId → 按 run 过滤的查询只能命中 run-terminal 一条；被打断 run 无 run-terminal（自定义 run-interrupted 且读侧静默丢弃）；终态后仍有事件落库（审计排空/子代理收尾/goal 续轮）；approval-requested 双发（实时 None + 收口落库后重发）；timer/cron 宣称落库实际零落库；subagent-started/ended 只落库不广播。                                         |
| 3   | 03-子代理链路追溯.md           | 子代理链路追溯            | 151  | 子代理有独立 run+会话（sub-run-{depth}-{n}/sub-sess-{depth}-{n}）走完整 session-loop，内部半段可追溯；但 **parent_tool_call_id 全线恒 None**（三个 spawn 构造点全部硬编码）→ 无法从 SubagentStarted 反查父工具调用；subagent-event 的 message/tool 类从未发射（唯一 progress 补发且 Delta 不落库）；started/ended 只落库不广播；子会话映射无显式存储；resume_subagent 恒失败（path_json 生产无写方）；timeoutMs 死参数；非 Completed 全归一 Failed（Cancelled 生产不可达）。                  |
| 4   | 04-工具调用原子化观测.md       | 工具调用原子化观测        | 161  | 工具级原子观测「基础达标，实时与细节不达标」：start/end 配对完整性良好；但失败路径 duration_ms 恒为 0；事件时间戳是翻译时刻非执行时刻（批后一次性翻译）；工具域事件无实时轨（随 run 收口一次性广播）；tool-input-repaired 死事件；requires_approval 重试首次 attempt 无留痕；ToolContext 无 tool_call_id 字段（安全审计无法关联工具调用）；批清单 calls 恒空。                                                                                                                                |
| 5   | 05-持久化与查询路径.md         | 持久化与查询路径          | 205  | 持久化链路能支撑「会话级按 sequence 回溯」，**不能支撑「按 run 回溯」与「从库还原完整信封」**：payload 是裸事件体；timer/cron/task 事件从不落库；run-interrupted/recovery-* 无顶层 type 标签 → parse_envelopes 静默丢弃（库里躺着读不出）；读侧信封字段丢失（无 sequence/runId 与契约不符）；查询无性能护栏（O(n) 全量读出+serde）；终态矛盾窗口（run-terminal 落库成功但 update_run_status 失败）；event_class 与 event_backpressure 双重分类漂移；崩溃中途半条消息不可复原。                |
| 6   | 06-日志层与崩溃恢复.md         | 日志层与崩溃恢复          | 275  | 日志-事件双通道不能统一追溯：**span 上下文不确定性丢失**（全仓仅 2 处手动 span、0 处 #[instrument]，tokio 线程迁移即丢上下文）；无共享 trace id；orchestrator 全 crate 仅 8 处 tracing（recovery 阶梯 1-4 零日志）；crash 文件无 backtrace/无活跃 run 上下文/无最后 N 条日志；cleanup_logs 未接线（死代码）；恢复链无 resumed-by 字段；无日志侧回归测试。                                                                                                                                     |
| 7   | 07-前端消费与观测面.md         | 前端消费与观测面          | 207  | 前端双面隔离设计完备，但「用户视角全链路可观测程度」中低：**eventParser.normalizer-drift 测试 3 failed/8 passed**（Rust 注册表 49 类 vs TS 绑定 41 类，recovery-_/goal-_ 8 类解析即丢弃）；continuityHandlers 是未接线死代码；UI 无 run 级时间线/日志面板（turn/agent/batch/steering/恢复等全部显式空实现）；live 路径无 sequence 游标；无增量补事件机制（engineCursor 仅索引）；子代理历史不可重放（依赖前端快照非引擎回放）；运行期观测 store 全内存（审计/缓存/timer 重开即丢）。          |
| 8   | 08-恢复重试与steering可追溯.md | 恢复/重试/steering 可追溯 | 212  | 写面（事件落库）基本完备，**读面断裂**：子代理侧 recovery-* 5 类事件 body-only payload（无 type 标签）直写 events 表 → 前端读取面 parse 失败静默丢弃（D8 设计的合成 fallback 只有文档没有实现）；阶梯 1 每次重试无事件（重派新 run 与原 run 无结构化关联）；RuntimeInterventionRequired 的 choices 无消费方（用户选择无记录）；阶梯 2 acknowledge 无事件；goal-continuation-decided 语义漂移（action 恒 continue）；nudge 入队无持久留痕。反例标杆：steering-budget-exhausted 诊断事件。      |
| 9   | 09-时序并发与性能观测.md       | 时序并发与性能观测        | 186  | 会话级 sequence 全局总序是最大资产，但：持久化事件流无 run 归属（并发下无法重建单 run 有序时间线）；事件时间戳双源异质（ISO 毫秒 vs created_at 秒精度）；**用户输入零留痕**（RingBuffer 容量 1000 覆盖最旧静默丢弃，save_pending_input 生产零调用）；message-start/end 与 provider 请求发出点无时间戳；turn 级 token 明细缺失（runs 表无 model 列）；任务域 7 事件全部不落库；两套背压分级口径不一致。                                                                                        |
| 10  | 10-安全审计与红线.md           | 安全审计与红线            | 167  | 「高危操作全链路可追责」有条件成立：**tool_call_id 结构性断链**（ToolContext 无 call_id 字段，工具侧 security-audit 恒 None）；「放行后执行」零审计（approved 后命令/git-revert 放行无审计，GitRevert 枚举无发射点）；非 run 上下文审计不落库（task/trash/remote 只广播，重启即失）；部分失败路径无审计（shell 多目标删除后置失败 → 前置已移回收站无记录）；decision 语义错位三处；ApprovalResolved 无 reason 字段；审计面板纯内存（上限 20 条，会话重载即空）；审批拒绝/权限模式拒绝无审计。 |

## 跨维度共性结论（多份报告交叉印证）

1. **结构性第一大缺口：持久化丢 runId**（02/03/05/09 四份独立确认）——信封只在广播时构造，events 表无 run_id 列、payload 无 runId → 按 run 追溯、并发归属、单 run 时间线重建全部断裂。
2. **结构性第二大缺口：读侧解析静默丢弃**（02/05/08）——run-interrupted 与 recovery-* 以 body-only/非标准 payload 落库，parse_envelopes 失败静默跳过 → 库里躺着、任何事件 API 读不出。
3. **横向断链：parent_tool_call_id 与 tool_call_id 全线未接线**（03/04/10）——子代理反查父工具调用、安全审计反查工具调用均断。
4. **「有契约无发射」的死事件**（01/04/08）：checkpoint-created/restored、tool-input-repaired、GitRevert、recovery 合成 fallback。
5. **只落库不广播 / 只广播不落库的不对称**（02/03/05/09）：subagent-started/ended 只落库；timer/cron/task 只广播（宣称落库未实现）；delta 双轨语义分叉。
6. **无共享 trace id、日志与事件无统一关联键**（06，全仓 grep 零命中）。
7. **前端解析漂移已红灯**（07：normalizer-drift 测试 3 failed/8 passed）——49 类 vs 41 类绑定。

## 下一步（流程）

1. 派 agent 阅读既有计划 `docs/review-md-audit/2026-08-13-wave/`（独立方案/维度详案/执行方案），评估可复用点与本轮发现的映射关系。
2. 主控综合全部输入建立整体计划文档（维度划分 + 逻辑递进）。
3. 多 Agent 评审 → 修订定稿 → 执行轮次。
