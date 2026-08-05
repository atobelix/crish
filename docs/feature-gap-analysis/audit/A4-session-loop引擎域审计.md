# 审计报告：session-loop 引擎装配 / 执行 / 权限域（Agent A-4）

> 产出：Agent A-4（只读审计轮）
> 日期：2026-08-05（本地）
> 范围：`crates/session-loop/src/`（tool_exec.rs、loop/mod.rs、loop/handlers/、approval.rs、approval_router.rs、tool_events.rs、escape_watch.rs、undeclared_detector.rs、executing_tools.rs、control.rs、steering/、safe_point.rs、hooks.rs、testing/、input.rs、hydrate.rs、checkpoint.rs 等）＋ 接线侧核验（apps/agent-workbench/src-tauri 的 core_run_commands.rs / engine.rs / wait_channel.rs）。
> 方法：逐文件精读 + 接线链反向追踪（spawn 时序、config 捕获、总线可达性）+ 全仓消费方 grep 核验。已登记项（`审计准备-已知缺点与技术债汇总.md` 230 条）不重复登记，仅核对。
> 属性：只读，未修改任何源码；产出本文档（UTF-8 无 BOM，全中文）。

## 结论速览

- **新发现 13 条**：高 2 / 中 6 / 低 5。
- **两条高严重度均为「假闭环 / 孤儿接线」类**：① 逃逸监视判定器注入在生产链路断裂（C-36 登记的闭环实为假闭环）；② run 控制总线与 abort 信号被孤儿化——L1/L2/L3 运行中控制、kill_all L3 投递、逃逸主 agent 注入全部落空，运行中 run 无任何外部终止路径。
- **总评**：session-loop 内核（状态机/执行器/handler/审批纯函数）质量高、测试密；主要问题集中在**壳层与内核的装配交界处**——两处都是「两端各自闭环、中间没有接通」的结构性断裂，且均无端到端测试覆盖（印证预检盲区 E-07）。

---

## 一、新发现分类表

### 高严重度

| # | 文件:行号 | 问题 | 建议 |
| :--- | :--- | :--- | :--- |
| H1 | core_run_commands.rs:2597-2606、2741；engine.rs:1795；loop/mod.rs:409-413、523-525；escape_watch.rs:375-411 | **逃逸监视判定器生产接线断裂（C-36 假闭环）**。壳层在 run 装配**之前**（core_run_commands.rs:2606）就 `spawn_escape_watch(root, config.clone())`，此时 config 未挂 detector（:2599-2605 只 `with_injector`）；消费任务 `consume_loop` 在 spawn 时把 config **整体 move 进任务**（escape_watch.rs:356-366），后续 detector 读取恒为捕获值（:385-391 `unwrap_or(false)`）。而 `with_detector` 注入发生在更晚的 `with_options`（loop/mod.rs:409-413），只作用于 `SessionLoopOptions.escape_watch` 副本；该副本唯一读取方 `escape_watch_config()`（loop/mod.rs:523-525）**全仓生产零调用**（仅 loop/mod.rs:1199 测试）。→ 生产运行中 `RegistryBackedDetector` 永不生效，工具声明覆盖的写路径全部按「未声明」上报：审计噪音 + 主 agent 注入刷屏；`审计准备-已知缺点与技术债汇总` C-36「F7 E-A3 判定器注入已闭环」登记不实，E-A3 冒烟测试（loop/mod.rs:1105）只验证了 options 副本 | 改在 spawn 前完成判定器注入：壳层装配 `EscapeWatchConfig` 时直接 `with_detector`（注册表须与会话执行同源），或在 `AgentSessionLoop` 暴露 spawn 入口统一生命周期；补「spawn 时序 + 判定器生效」端到端用例 |
| H2 | handlers/mod.rs:142-143；loop/mod.rs:507-515、383-505；core_run_commands.rs:2596、2840-2841、2855、2930-2967、1751-1754、446-455；wait_channel.rs:265 | **run 控制总线 / abort 信号孤儿化：运行中 L1/L2/L3 控制、kill_all 强停、逃逸主 agent 注入全部失效，且运行中 run 无任何外部终止路径**。LoopState 自建内部总线与信号（handlers/mod.rs:142-143），`AgentSessionLoop` 的 with_* 装配面（mod.rs:383-505）**没有**控制总线 / abort 信号注入 API（`control_bus()`/`abort_signal()` 只是内部实例的 getter，:513-515/:507-510，生产无人调用）。壳层另建 `control_bus`（core_run_commands.rs:2596）与 `AbortSignal::new()`（:2841）存入 ActiveRun；`core_run_control` L1/L2/L3（:2930-2967）、ForceCancelSink kill_all L3（:1751-1754）、逃逸 `ControlBusInjector`（:2605、:446-455）全部写入该孤儿总线/信号——loop 的 `check_control` 永不消费（全仓 grep 无 ActiveRun.control_bus 的 drain 消费方）。`force_cancel` 只置位 ActiveRun.abort_signal（loop 不可见）；`spawn(drive_run_loop)` 未保存 JoinHandle（:2855），任务也无法 abort → 运行中 run 只能等自然收场或进程退出。测试面仅断言 side effect（如 core_run_commands.rs:5045-5125 只查 user_touched/abort_signal 置位），无「loop 实际反应」的端到端断言（印证 E-07） | 内核补装配面：`with_control_bus` / `with_abort_signal`（或将 ActiveRun 实例整体注入 loop）；壳层接线后在 produce 前注入；补一条「TestProvider 栅栏 + L3 强停 → run 立即 aborted」端到端用例；顺带登记 `control_bus()`/`abort_signal()` getter 生产零消费 |

### 中严重度

| # | 文件:行号 | 问题 | 建议 |
| :--- | :--- | :--- | :--- |
| M1 | executing_tools.rs:61-73；tool_exec.rs:271-286 | **工具调用并发分区被忽略：真实 run 路径全部工具强制 `Parallel` + `Internal`**（executing_tools.rs:71），工具定义声明的并发语义（Sequential/Exclusive）永不参与；`execute_batch` 的分组逻辑（tool_exec.rs:271-286）只依赖入参 concurrency。后果：模型同批发出两个同路径写工具调用时并行执行，`WritePathRegistry` 冲突（agent-tools write_paths.rs:309-339 `tool.write_path_conflict`）报错喂回模型，而非按 Sequential 顺序执行（注释自认「真实并发分区语义见 B3.5 验收」，属历史遗留） | 按注册表工具定义补并发分区（定义可扩展 concurrency 声明或引入内部分类表）；或至少把同批同路径写调用降级顺序执行 |
| M2 | escape_watch.rs:395-402、50-51 | **逃逸时间窗限流非真实定时器**：时间窗检查只在 `rx.recv()` 返回**下一条事件时**才执行（:395-402）；孤立低频事件（单条事件后再无后续）在 run 收口前静默，最长可整 run 不报——与模块声明「低频事件不长时间静默，实时性粒度 = 时间窗」（:50-51）矛盾（收口 flush 只兜底 run 结束，不兜底 run 中途） | 消费循环增加独立 tick（`tokio::select!` 双路：事件 / 周期 tick），或文档降级声明为「事件驱动 + 收口兜底」 |
| M3 | safe_point.rs:43-75；loop/mod.rs:547-580 | **AbortSignal 无 reset、run() 不重置**：同一 `AgentSessionLoop` 复用时（测试续接路径、编排层复用形态），上一 run 触发过的 abort 信号使下一 run 在首个安全点立即 aborted（check_control 优先读信号，safe_point.rs:126-130）；control_bus 残留的 L3 意图同理跨 run 生效。生产每 run 重建 loop 不受影响，但该语义既无 reset API 也无文档化护栏 | run() 起始重置 abort_signal（或文档化「loop 一次性使用」契约并加断言）；补复用场景回归测试 |
| M4 | loop/mod.rs:547-553；engine.rs:134-146；core_run_commands.rs:2029 | **run span 的 run_id 字段 = 用户消息 id 而非 run id**：`run()` 的 span 取 `input.id`（loop/mod.rs:551），而 `user_message()` 的 id 是 `user-<毫秒>-<序号>`（engine.rs:136），与 `AgentSessionLoop::new` 的 run_id（tool_ctx.run_id、审批/幂等域）不同源；外层 drive_run_loop 的 `run` span（core_run_commands.rs:2029）同字段名嵌套 → 日志归因字段冲突/覆盖 | run span 改用构造时 run_id；用户消息 id 与 run_id 的关系在文档标注 |
| M5 | core_run_commands.rs:208-215、3497；approval_router.rs:112-118 | **审批死锁防护分支生产未接线**：`with_deadlock_detector` 带 `#[cfg_attr(not(test), allow(dead_code))]`（:208），全仓仅测试调用（:3497）——`route_approval_guarded` 的「裁决者 wait 中 → 转用户」分支（approval_router.rs:112-118）生产不可达；C-42 死锁时序评审结论（approval_router.rs:30-37「转用户打破 120s 空等」）依赖的 detector 注入槽未落地，子代理在主 agent wait 期间仍 120s 空等 Expired | 按 F11 T-D-13 遗留补 wait 态信号源接线（orchestrator 子代理跟踪器 → detector）；未接线期间文档标注降级语义 |
| M6 | tool_exec.rs:745-748；tool_exec.rs:73-99；agent-tools background_task.rs:121-126 | **引擎 run 内 background_task 恒 `common.unsupported`**：ToolContext 构造硬编码 `background: None, log_root: None`（tool_exec.rs:745-748），且 `ToolExecCtx`（:73-99）无 background/log_root 字段——壳层 background.rs 任务注册表不存在任何注入通道（agent-tools background_task.rs:121-126 未接线即报 unsupported）。与 A-01（shell stdin）同域但独立：引擎真实 run 里后台任务工具族整体不可用 | ToolExecCtx 增 background/log_root 字段 + with_options 装配面；壳层把 BackgroundTaskRegistry 适配为 manager 注入（与 A-01 一并排期） |

### 低严重度

| # | 文件:行号 | 问题 | 建议 |
| :--- | :--- | :--- | :--- |
| L1 | tool_exec.rs:798-804 vs hooks.rs:569-575 | **「执行前守门者」超时口径分裂**：middleware `before_execute` 超时 → Block（fail-closed，tool_exec.rs:798-804）；hook `tool.pre` 超时 → 放行（fail-open，kimi 语义，hooks.rs:569-575）。同为执行前拦截，失败语义相反（已文档化，但口径矛盾） | 评审统一守门者超时语义；或至少在接线决策文档明示差异理由 |
| L2 | tool_exec.rs:1285-1296 | **plan 模式策略拒绝复用 `UserDenied` 码**：`denied_result` 用 `ToolErrorKind::UserDenied` + `user denied by {mode} mode` 文案表达策略拒绝（:1285-1296）——错误码 `tool.user_denied` 会让审计/前端误读为「用户拒绝」 | 新增 `PermissionDenied` 类（或复用 ApprovalRequired 之外语义清晰的码），拒绝文案区分来源 |
| L3 | escape_watch.rs:291-298、301-308 | **监视句柄收口无超时 + Drop 不等待任务**：`shutdown()` await task 无超时（sink 阻塞会挂起 run 收口）；`Drop` 仅 take watcher 不 await（:301-308），消费任务 detached 存活至通道关闭（短暂 run 外窗口，emit 可能落在 run 收口后） | shutdown 加超时兜底；Drop 路径保持现状但文档化「收口后短暂 emit 窗口」 |
| L4 | tool_exec.rs:937-955 vs 1000-1010 | **幂等去重路径 tool.post 载荷与正常路径不对称**：去重命中广播 `ToolPost` 时 duration=0 且跳过 middleware `on_result` 改写链（:937-955）；正常路径广播改写后输出（:1000-1010）。hook 消费方无法区分「真执行 0ms」与「去重未执行」 | ToolPost 载荷加 `deduplicated` 标志位（或文档化对称性约定） |
| L5 | checkpoint.rs:16-21；safe_point.rs:255-278 | **C1 检查点链路生产未挂载**：`checkpoint_prompt_section()` 与 `collect_checkpoint_from_messages()` 全仓生产零调用（仅定义 + 测试；checkpoint.rs 头注自认「先实现内容本身，供后续接线复用」）——提示词段未拼入 build_context、采集函数无安全点消费方（M5B 接线缺失） | 核对 M5 任务卡接线清单：提示词段挂载 build_context + 采集点接入 run 收口（会话树叶子 payload） |

---

## 二、审计维度逐项说明（含已登记核对）

| 维度 | 结论 | 关键证据 |
| :--- | :--- | :--- |
| 1 执行器 | execute_batch 语义自洽（fatalOnError 排除清单 tool_events.rs:130-157、abort-aware 竞速 tool_exec.rs:878-890、cancel-siblings 混排事件对完整 tool_exec.rs:1314-1347）；ToolContext 构造缺 background/log_root（M6）；ToolExecCtx 8 字段确认 D-01 膨胀 | tool_exec.rs:252-510 |
| 2 装配面 | with_options 四线装配（注册表/配额/中间件/判定器）链内正确，但判定器注入目标错误（H1）；output_dir 自动 InMemory 装配确认 A-15（loop/mod.rs:420-429，壳层 options 无 output_dir 注入，core_run_commands.rs:2741-2756 仅 write_claims/parent_run_id） | loop/mod.rs:383-459 |
| 3 权限传递 | 路由纯函数正确（approval_router.rs 全覆盖测试）；requester 透传完整（run_id/reason 至事件与 gate，executing_tools.rs:245-263）；task_type 恒 None 确认 A-30；死锁防护分支生产未接线（M5）；120s 常量确认 F-13 | approval_router.rs:88-179 |
| 4 逃逸监视 | 聚合/限流/判定器逻辑正确且测试密；判定器生产断裂（H1）；时间窗非定时器（M2）；shutdown/Drop 收口小缺陷（L3）；has_destructive 计算后丢弃确认 A-06（impact_for 未携带） | escape_watch.rs:211-277、419-454 |
| 5 事件与唤醒 | ToolEvent → AgentEvent 翻译完整（executing_tools.rs:200-300）；steering 注入/预注入短路/预算计数单一源正确（steering/mod.rs:213-336）；idle 续 run 空转护栏在壳层（core_run_commands.rs:1837-1925，3 次上限，确认 D-32 已落地）；续 run 判定器注入不全（cron 判定器 None 降级，core_run_commands.rs:1874-1886，确认 A-08/A-25 邻接） | loop/handlers/streaming.rs:38-225 |
| 6 并发安全 | 锁均为块级作用域、不跨 await（check_control handlers/mod.rs:515-550、ControlBusInjector core_run_commands.rs:448-454、ApprovalGateImpl pending 锁 :321-327）；std Mutex 使用规范；JoinHandle 管理问题集中在壳层（H2：drive_run_loop 无句柄）；escape watch task 有 shutdown 收口 | 各锁点 |
| 7 接线流畅性 | producer→run→收口→事件桥链路联通（engine.rs:1751-1830）；断点两处：H1（spawn 时序）、H2（孤儿总线）；运行语义整体自洽，但「运行中可控性」实际缺失是最大灵魂缺陷 | engine.rs:1784-1811 |

---

## 三、最需修复 5 条

1. **H2 孤儿控制总线**：L1/L2/L3 控制、kill_all、逃逸注入全失效 + 无终止路径——运行中会话不可控，安全与体验双重缺口；且无端到端测试（E-07 印证）。
2. **H1 逃逸判定器假闭环**：C-36 闭环登记不实，生产全量工具写被误报未声明（审计噪音 + 注入刷屏），与安全基线 31-security-baseline 目标相悖。
3. **M6 background_task 恒 unsupported**：后台任务工具族在真实 run 不可用，与 A-01 同域遗留，功能面直接缺口。
4. **M5 审批死锁防护未接线**：C-42 评审承诺的「转用户打破 120s 空等」分支生产不可达。
5. **M1 并发分区被忽略**：写工具并行冲突报错而非顺序执行，直接影响模型工具编排可靠性。

---

## 四、统计与回报要点

- **新发现 13 条**：高 2（H1/H2）/ 中 6（M1-M6）/ 低 5（L1-L5）。
- **高严重度清单**：H1（逃逸判定器生产接线断裂，C-36 假闭环）；H2（run 控制总线/abort 信号孤儿化，运行中 run 无终止路径）。
- **已登记项核对**：D-01（ToolExecCtx 膨胀）、A-15（output_dir InMemory）、A-30（task_type 恒 None）、F-13（120s 可配未落）、A-06（has_destructive 未携带）、D-32（空转护栏已落地）、A-08/A-25（续 run 判定器缺 cron 注入）均与代码一致；C-36 与 H1 冲突，建议更正登记。
- **总评**：session-loop 内核实现质量高、测试覆盖面密（执行器事件对、审批透传、聚合限流均有字节级断言），「灵魂」层面的主要缺失不在内核而在壳层装配交界——两条高严重度均为「两端各自闭环、中间未接通」的结构性断裂，且测试面只验证了各端自身（options 副本 / side effect），无人验证通链。建议后续战役优先补「装配时序端到端」用例，并把 run 控制面接线作为 D-02 可达性课题的第一优先级落地。
- 文档路径：`docs/feature-gap-analysis/audit/A4-session-loop引擎域审计.md`。
- 未提交任何变更（只读任务）。
