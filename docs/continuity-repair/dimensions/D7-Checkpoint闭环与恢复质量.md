# D7 — checkpoint 机制面闭环与恢复质量(维度详细设计)

> 目录:docs/continuity-repair/dimensions/
> 日期:2026-08-11
> 定位:本文件为「任务连续性多Agent协同修复方案」维度文档轮中【维度 D7】的详细设计,细化到可直接指导实现的粒度。范围与裁决已冻结(00 总纲 §3 D7 + 01 敲定方案裁决 #13/#19 + 任务书范围①-⑤),本文档是唯一权威的 D7 实现输入。
> 输入:00-总纲-维度设计.md(§3 D7、§4 依赖、§5 护栏、§6 契约)、01-敲定方案.md(裁决 #13 水合 error 态、#19 history 注入、§2.3)、proposals/01(D7、决策 8、§4-E)、proposals/02(选型 C:history 注入)、proposals/04(§2.6、§3-5 流中断结构化标注)、proposals/05(§2.D 水合 error 态修复)、reviews/selection-01(§2 分歧 8、§3.3 D7)、selection-02(P-7、§1.1-6)、selection-03(M1 history 注入、M6 流中断标注)。
> 代码基线:仓库当前 HEAD;行号以核对当日代码为准,如漂移以实际代码为真源。
> 引用统一为 `文件路径:行号`。

---

## 1. 维度目标与验收断言

### 1.1 目标

把「checkpoint 优先恢复」从**提示词协议声明**(checkpoint.rs:16-21,靠 AI 自觉读历史)升级为**机制保证**:引擎在 run 收口采集结构化 checkpoint 写入会话树叶子、续 run 拉起器读取叶子载荷拼入注入文本、子代理 fork 的 Verbatim 场景把原 run 消息作为新 run history、错误消息语义完整化(流中断结构化标注 + 水合 error 态放行 + failed-turn 标记)四件事一次闭环。核心效果:中断/失败后的续 run「恢复质量」不依赖模型自觉,且失败回合的信息不再丢失。

### 1.2 最低线(00 总纲 §3 D7,细化到测试写法)

00 总纲 §3 的 D7 验收断言(00-总纲-维度设计.md:81)细化如下,每一条对应 §5 测试策略中的具体测试:

| #   | 最低线断言                                          | 细化(测试写法)                                                                                                                                                                                                                           | 对应测试 |
| --- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| A1  | 带 checkpoint 叶子会话续 run → 注入文本含检查点摘要 | 会话树叶子 payload 含有效 `CheckpointPayload`(target/summary/next)→ 收口命中 idle 续 run → `spawn_idle_resume_run` 构造的 `RunTaskOptions.prompt` 文本含「上次检查点」与 target/summary/next 内容                                        | T1/T2    |
| A2  | 损坏载荷 → 正常水合不阻断                           | 叶子 payload 的 `checkpoint` 键为不可解析 JSON → `read_leaf_checkpoint` 返回 `Corrupt`(session.rs:534-537)→ 注入文本不含摘要但含降级提示,run 照常拉起(不 panic、不阻断);采集侧对话含坏标记行 → 收口不中断、不写叶子                      | T3/T4    |
| A3  | error 态消息水合保留 + failed-turn 标记             | `HistoryMessage{status: "error"}` → `hydrate_one` 放行且 `metadata == {"kind":"failed-turn"}`;`status: "completed"`/无 status → 放行且 metadata 仍为 None(规则 4 保持);queued/processing/streaming/pending/空串 → 跳过(过滤语义其余不变) | T5       |
| A4  | 带 checkpoint 叶子会话续 run 的完整链路             | 收口采集:对话含 `CHECKPOINT:` 标记行 → 收口后 `state.sessions` 对应会话记录的叶子 payload 含 `checkpoint` 键(载荷字段保真);注入读面:同一会话下次 run 拉起时注入文本含摘要                                                                | T1/T6    |
| A5  | history 注入:Verbatim fork 后对话续接正确           | `decide_fork_context` 判定 Verbatim(recovery.rs:425-442)→ fork 新 run 的 `RunTaskOptions.history` = 原 run 消息(非 None);Summarized/New → history 仍 None;新 run 水合后对话含原 run 消息序列                                             | T7/T8    |
| A6  | 流中断结构化标注                                    | 已产出内容断流 → 消息 metadata 同时含 `providerError`(字符串,既有保持)+ `providerErrorKind`(kebab-case 分类)+ `providerErrorRetryable`(bool)                                                                                             | T9       |

### 1.3 与敲定冲突声明

1. **范围迁移一(已批准,02-定夺 B1)**:00 总纲 §3 的 D1 行「⑤ 流中断结构化标注(providerErrorKind)」(00-总纲-维度设计.md:75)与 D7 行「⑤ 错误消息语义完整化(04 结构化标注 + 水合 failed-turn 标记)」存在边界重叠。任务书 D7 范围④明确把「04 结构化标注」划入 D7,且 04 §2.6 标注的改动点在 `agent-provider/src/consume/mod.rs:308-347` 与 `crates/session-loop/src/stream.rs:439-481`(两处镜像)——这两个文件不在 00 总纲 D1 的关键文件清单(stream_error.rs/loop/end.rs/handlers/mod.rs/loop/mod.rs/engine.rs)内。**已批准:流中断标注的主体改动(consume/stream 两处镜像 + streaming.rs 透传 kind)确认归本维度;D1 已移交(只保留 `RunOutcome.provider_error` 数据面,stream_error.rs:237-269 fatal 填充)**,两者文件域不重叠。唯一交叉点:engine.rs `to_loop_event` 映射(04 §3-5 提及)与 D1 的 engine.rs 改动同文件,按 00 总纲 §4 同文件串行纪律处理(§7)。
2. **范围迁移二(显式标注,非冲突)**:00 总纲 §3 D8 行「④ 水合 error 态放行 + failed-turn 标记(本轮,非可选)」与 D7 行「⑤ 错误消息语义完整化(… + 水合 failed-turn 标记)」重叠。任务书 D7 范围④包含水合 error 态放行,且 00 总纲 §6 契约表「hydrate 标记 | D7→模型 | error 态保留 + metadata {kind:"failed-turn"};无 schema 改动 | D7」(00-总纲-维度设计.md:138)已把 hydrate 改动属主定为 D7。**本维度裁定:hydrate.rs 的放行+标记改造归 D7;D8 保留「观测面」职责(事件/UI/口径),不重复改 hydrate.rs**。
3. **契约扩展(已批准,02-定夺 W3)**:00 总纲 §6 冻结的 `RunFailureContext 还原 | D2 壳层→D3 | subagent_id/task/error_kind/retries/produced_content/from_leaf_id/inject_bytes/window_bytes`(00-总纲-维度设计.md:130)不含 history。裁决 #19(history 注入)落在 fork 路径(02 选型 C 原描述即「spawn 请求的 history: None 缺口」),而 fork 的上下文载体是 `RunFailureContext`(recovery.rs:757-780)→ 本维度**新增 `RunFailureContext.history: Option<Vec<HistoryMessage>>` 字段与 `SubagentSpawnRequest.history` 字段**(§3.4),属对契约表的 minor 扩展;RecoveryBudget/键形状零改动。理由:history 数据必须在 fork 决策处随 ctx 传递,不经 ctx 则需在 orchestrator 侧另建第二数据通道,违反「数据面集中」纪律。D3 §3.2.4 装配表与 D4 §3.5 prepare_resume 已同步补 history 字段(见 §3.4 注记)。

---

## 2. 现状基线(文件:行号)与缺口

### 2.1 现状事实

| 面                | 现状                                                                                                                                                                                                                                                                                                                             | 证据                                            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 载荷形状          | `CheckpointPayload{target, summary, timestamp?, completed[], files[], next[]}`,camelCase,缺省字段兼容                                                                                                                                                                                                                            | conex-types/src/checkpoint.rs:37-55             |
| 行标记            | `CHECKPOINT:` 主前缀 + `CONEX_CHECKPOINT` 别名(仅对象起始);`CHECKPOINT_PAYLOAD_KEY="checkpoint"`;信号常量 `checkpoint-present`/`checkpoint-corrupt`                                                                                                                                                                              | checkpoint.rs:18-28                             |
| 采集函数          | `parse_checkpoint_marker`(safe_point.rs:212-242,逐行扫描、空载荷行跳过、坏 JSON → Err「checkpoint.parse_failed」)+ `collect_checkpoint_from_messages`(safe_point.rs:255-278,倒序扫描、system 排除、工具输出文本参与、缺时间戳补当前时间);**生产零调用**——全仓库仅 orchestrator/tests/checkpoint.rs 与 safe_point.rs 自身测试引用 | 01-主agent会话循环:65;safe_point.rs:212-278     |
| 叶子读写          | `read_leaf_checkpoint`(session.rs:514-538,三态 Absent/Present/Corrupt,fail-open 不 panic)+ `set_leaf_checkpoint`(session.rs:545-574,只增改 `checkpoint` 键)+ `from_session_record`(session.rs:589-591)+ `SessionTree::new` 空树(session.rs:334-341)                                                                              | session.rs:514-574、589-591、334                |
| 提示词协议层      | `checkpoint_prompt_section`(checkpoint.rs:16-21)声明「存在 checkpoint 时优先恢复」「引擎采集只读不写」——**仅声明,无引擎保证**(恢复注入路径未接线)                                                                                                                                                                                | checkpoint.rs:16-21;01-主agent会话循环:G4/G5    |
| 会话树注册表      | `CoreRunState.sessions: Mutex<Vec<SessionRecord>>`(:1516-1517),run_restore 成功路径从快照水合(:2205-2208),快照保存时序列化(:2303);**运行期不新增会话记录**                                                                                                                                                                       | core_run_commands.rs:1516-1517、2205-2208、2303 |
| run 收口链        | produce(:2703)→ `session_history.store`(:2718,to_history_messages 全角色保真,**status 恒 "completed"** :938)→ drive_outcome(:2729-2733)→ 子代理收口(:2844-2852)→ decide_idle_resume(:2872-2912);防御路径 finalize_failed(:2754)                                                                                                  | core_run_commands.rs:2688-2913                  |
| 拉起器            | `spawn_idle_resume_run`(:2637-2671):inject 文本拼接(:2642-2646)→ `RunTaskOptions{prompt, mode:"idle-resume", history: None}`(:2657)→ run_task_impl                                                                                                                                                                               | core_run_commands.rs:2637-2671                  |
| 历史续接          | `resolve_history_source`(:1088-1096):前端 history 非空 → Frontend(hydrate_history);否则缓存 → Cache(cached_history_to_conversation);`SessionHistoryCache` 收口写入(:2718)                                                                                                                                                        | core_run_commands.rs:1088-1096、1537-1539、2718 |
| 水合过滤          | `hydrate.rs` 规则 1:仅 completed/无 status 放行(§3.2.3 规则表);`is_completed`(hydrate.rs:87-93)error 态跳过,注释「失败回合进上下文会污染后续模型判断,列为后续演进项」(:85-86);有测试锁定(:376-382)                                                                                                                               | hydrate.rs:9-10、83-93                          |
| 水合 metadata     | 规则 4:水合消息 `metadata = None`(usage 等不进 LLM 上下文);`AgentMessage.metadata: Option<Value>` 是自由 JSON 字段(无 schema 约束)                                                                                                                                                                                               | hydrate.rs:16、74-75;message.rs:43              |
| 流中断标注现状    | 已产出内容断流 → streaming 注入 `Stop{reason: Error}` → 消息 `metadata.providerError` 裸错误文案字符串(无分类信息);consume 侧 `build_message_metadata`(:308-347)与 session-loop `stream.rs` 镜像(:439-481)                                                                                                                       | proposals/04:183-190(04 §2.6)                   |
| fork 三态         | `decide_fork_context`(recovery.rs:425-442,≤24h + ≤80% → Verbatim/超限 Summarized/空 New);`fork_and_reassign`(:1031-1173)构造 `SubagentSpawnRequest{prompt: ctx.task, …}`(**无 history 字段**,:1115-1135)→ spawner.spawn;fork 新叶子 payload 由 `fork_node_payload(&record, &ctx.task)` 显式构造(:1089,不含 checkpoint 键)        | recovery.rs:399-442、1031-1173                  |
| spawner 缺口      | `spawn_unchecked` 构造 `RunTaskOptions{history: None, context_window: None}`(:364-365)——DEEPCHECK-06 §1 P0 确认;子代理 run 用独立会话 id `sub-sess-{depth}-{n}`(:289),其收口消息以该 id 为键写入 SessionHistoryCache                                                                                                             | subagent_spawner.rs:289、364-365;06-文档资产:83 |
| RunFailureContext | `recovery.rs:757-780`:subagent_id/subagent_run_id/task/error_kind/retries/retry_elapsed_ms/produced_content/from_leaf_id/started_at_ms/inject_bytes/window_bytes(**无 history**)                                                                                                                                                 | recovery.rs:757-780                             |
| resume 路径       | `lifecycle.rs resume`(:243-321)构造 RunFailureContext(:287-301);子代理行 `SessionMessage` 列表可从 `current.messages` 取(与 HistoryMessage 字段一一对应,history.rs 文档头)                                                                                                                                                       | lifecycle.rs:243-321;history.rs:16-22           |

### 2.2 缺口清单(与 00 总纲 §3 D7 逐条对应)

| #   | 缺口                                                                          | 现状证据                                                          | 本维度闭合方式          |
| --- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------- |
| G-1 | 采集无生产调用:checkpoint 只在提示词里承诺,引擎从不采集落库                   | safe_point.rs:255-278 仅测试调用                                  | §3.1 收口采集接线       |
| G-2 | 恢复注入未接线:「存在 checkpoint 时优先恢复」无引擎保证,续 run 靠 AI 自读历史 | checkpoint.rs:16-21;spawn_idle_resume_run 无任何 checkpoint 读取  | §3.2 拉起器注入摘要     |
| G-3 | 载荷损坏无生产降级路径(语义已有,无调用面)                                     | LeafCheckpointState::Corrupt(session.rs:534-537)无生产消费者      | §3.2/§3.5 双降级        |
| G-4 | 子代理 fork 的 history 缺口:新 run 恒单消息启动,Verbatim 场景无字节级继承     | subagent_spawner.rs:364-365;recovery.rs:1115-1135 无 history 字段 | §3.4 history 注入       |
| G-5 | 水合过滤 error 态:中断轮对话从重启水合序列消失,模型「失忆」                   | hydrate.rs:87-93;裁决 #13(01-敲定:27)                             | §3.6 放行 + failed-turn |
| G-6 | 流中断标注是裸字符串,无 kind/retryable,模型/用户无法感知中断原因              | proposals/04:183-190;consume/mod.rs:308-347                       | §3.7 结构化标注         |

---

## 3. 改动设计

### 3.1 收口采集接线(范围①)

**触发点**:`drive_run_loop` 正常收口路径,`session_history.store`(core_run_commands.rs:2718)之后、`drive_outcome`(core_run_commands.rs:2729,outcome 移动消费)之前——outcome.messages 仍在手,借用完成后即 move,顺序敏感。

**伪代码**:

```
// drive_run_loop 收口,插在 :2718 与 :2729 之间
state.session_history.store(&session_id, to_history_messages(&outcome));

// ── D7-① checkpoint 收口采集(M5B 接线)──
let checkpoint_result = {
    let msgs: Vec<&AgentMessage> = outcome.messages.iter().map(|m| m.as_ref()).collect();
    collect_checkpoint_from_messages(&msgs)          // safe_point.rs:255-278,纯函数
};
match checkpoint_result {
    Ok(Some(payload)) => write_leaf_checkpoint(&state, &session_id, payload),
    Ok(None)          => {}                          // 无标记行,现状
    Err(err)          => tracing::warn!(...),        // 对话内坏标记行:视为无 checkpoint,
}                                                     // 不写、不阻断(§3.5 采集侧降级)
```

**写面 helper `write_leaf_checkpoint`**(壳层新函数,与 read 共用 §3.2 的树访问器):

```
fn with_session_tree<R>(state: &CoreRunState, session_id: &str,
                        f: impl FnOnce(&mut SessionTree) -> R) -> Option<R> {
    // 基线路径(本维度自洽,不依赖 D3):state.sessions 锁内
    //   find(record.session_id == session_id) → SessionTree::from_session_record(record)
    //   → f(&mut tree) → tree.to_session_record() → 锁内原位替换该记录
    // 无该会话记录 / 无 current_leaf_id → None(跳过,§8 决策 2)
    // D3 的 session_trees 表落地后,此处可切换为共享实例(§8 决策 1)
}
```

写面语义:`with_session_tree` → 若 `current_leaf_id` 为 None → 跳过(无叶子无处落,§8 决策 2);否则 `tree.set_leaf_checkpoint(leaf_id, &payload)`(session.rs:545-574,只增改 `checkpoint` 键)→ `to_session_record` 回写 `state.sessions`。`set_leaf_checkpoint` 返回 NotFound/InvalidState 时 warn 不阻断(防御)。

**触发范围**:主会话 run(含 error 收场——error 轮的部分产出常含最新 checkpoint 行,正是恢复质量的关键场景)与子代理 run 共用同一收口;子代理会话(`sub-sess-*`)在 `state.sessions` 无记录 → 写面自动跳过,采集语义天然只落在有树会话(§8 决策 2)。

### 3.2 恢复注入(范围②)

**触发点**:`spawn_idle_resume_run`(core_run_commands.rs:2637-2671),inject 文本拼接(:2642-2646)之后、`RunTaskOptions` 构造之前。

**注入文本构造**:

```
// Present:正文追加「上次检查点」段
let checkpoint_section = format!(
    "\n\n[检查点摘要]\n上次检查点:目标「{target}」。\n已完成:{}。\n摘要:{}\n下一步:{}",
    completed.join("、")或"(无)",
    summary(截断 ≤500 字符,§8 决策 4),
    next.join("、")或"(无)",
);
// Absent:不追加(行为与现状一致)
// Corrupt:追加「(检查点损坏已忽略,按对话历史继续)」+ tracing::warn,不阻断拉起
```

读面:`with_session_tree` 只读闭包 → `read_leaf_checkpoint(None)`(session.rs:514-538,当前叶子)三态分发。**不 panic、不阻断**:三种状态都照常拉起 run,差异只在注入文本(00 总纲验收「无 checkpoint 行为不变」)。效果:checkpoint.rs:16-21 的「优先恢复」从提示词协议升级为机制保证——摘要进注入文本,与 D5 的 goal 前缀/nextSteps 注入共用注入通道(01 方案 §4-E:合并为「续 run 注入载荷」,最终拼装顺序由拉起器统一,§7)。

**阶段总结载荷(E2 F5,扩展定夺 E0 R7)**:checkpoint 载荷同时承载**阶段总结**——E2 F5 定义:对话长度达里程碑阈值(默认 40%/60%/80%,estimate/window 比例,可配 `compact_stage_ratios`)时,由 LLM 对当前完整对话产出结构化阶段总结(Schema V1 骨架 + tier 标记,如 `"stage-1"`;droppedIds 空数组;custom `range` 字段扩展);每阶梯对话生命周期内只触发一次。落载荷:

- 采集侧:`collect_checkpoint_from_messages`(safe_point.rs:255)兼容阶段总结文本(与 CHECKPOINT 标记行同采集通道),写面经同一 `set_leaf_checkpoint`(session.rs:545)落叶;
- 读侧:恢复/续跑时 `read_leaf_checkpoint`(session.rs:514)→ 注入系统提示词段——与 E2 F5「新上下文携带」合并落地(06 文档 P0-2「C1 恢复注入接线」,E2 §6.4);
- **素材继承链**:阶段总结是终结摘要的素材与继承链——每次阶段总结以最新阶段总结文本为 `existing` 迭代合并(compact_agent_messages T-07 链尾取数语义同构),终结摘要持续维护 goal/nextSteps → 贯通 05 文档 P1「nextSteps 续轮注入」(D5 goal 续轮数据源就绪);
- 注入长度护栏沿用 §8 决策 4(摘要截断 ≤500 字符);阶段总结 token 成本 = 每阶梯 1 次 LLM 调用,与压缩摘要同预算/并发/墙钟护栏(C14 隔离,全局 ≤2)。

### 3.3 叶子 checkpoint 访问器的线程与快照安全

- `state.sessions` 是 `std::sync::Mutex<Vec<SessionRecord>>`,读-改-写全程锁内完成(纯内存操作,无 await,符合 AA-02 锁不跨 await);与快照保存(同一 mutex,:2303)天然互斥,无并发写风险。
- checkpoint 数据随 SessionRecord 进快照(build_and_save_snapshot :2303 序列化 branches),重启经 run_restore 水合(:2205-2208)+ `from_session_record` 重建可读——**跨重启闭环**(05 数据面 #18「read_leaf_checkpoint 随会话树重建恢复」)。

### 3.4 history 注入(范围③,裁决 #19)

**目标**:Verbatim 场景把原 run 消息作为新 run 的 history,先于 Summarized 摘要(Summarized 的摘要注入明确后置——Summarizer 生产装配断链,02 选型 C)。

**同步注记(02-定夺 W3 已批准)**:D3 §3.2.4 装配表与 D4 §3.5 prepare_resume 已同步补 history 字段(数据源 = session_history.get(子代理会话)/row.messages→HistoryMessage 转换),与本维度的字段形状 `history: Option<Vec<HistoryMessage>>` 一致。

**数据流(三处改动)**:

```
① 装配:RunFailureContext 增 history 字段(recovery.rs:757-780)
    - D3 收口触发点(壳层):active.session_id 即子代理会话,
      state.session_history.get(&session_id)(:2718 已缓存原 run 消息)→ ctx.history
    - resume 路径(lifecycle.rs:287-301):row.messages(Vec<SessionMessage>)
      → HistoryMessage 转换(SessionMessage/HistoryMessage 字段一一对应,history.rs 文档头;
      新增 ~10 行转换 helper,放 lifecycle.rs 或 conex-types)
② 传递:fork_and_reassign(recovery.rs:1031-1173)把 ctx.history 透传进
    SubagentSpawnRequest(agent-tools/src/tools/subagent.rs,新增
    #[serde(default)] history: Option<Vec<HistoryMessage>>,~5-6 个构造点补 None/值:
    recovery.rs:1115、flow_graph.rs:1021、subagent_spawner.rs:930、
    core_run_commands.rs:8562/8736 等)
③ 装配:spawn_unchecked(subagent_spawner.rs:354-368)把 req.history 传入
    RunTaskOptions.history(:364 由恒 None 改为 req.history)
```

**注入条件**:仅 `context_mode == Verbatim`(decide_fork_context 判定,recovery.rs:425-442)且 history 非空时传递;Summarized/New → 保持 None(Summarized 摘要注入是后续项,不在此轮伪造)。history 经既有 `RunTaskOptions.history` → `resolve_history_source`(core_run_commands.rs:3615-3622)→ 前端路径 `hydrate_history`(含 D7 的 error 态放行改造,§3.6——原 run 的失败轮消息带 failed-turn 标记进上下文,与 ② 正链协同)→ `initial_conversation` 零拷贝水合(engine.rs:2361-2365)。

**边界声明**:本项只覆盖子代理 fork/resume 路径(裁决 #19 原文「spawner 的 history: None 缺口」);主 run 侧的 history 续接已由 SessionHistoryCache 兜底(D2 验收「上下文完整 = 新 run history 参数回退缓存」,core_run_commands.rs:2718),不属本项。

### 3.5 载荷损坏降级不阻断(范围⑤)

| 侧       | 损坏信号                                                                                              | 降级行为                                                                                          | 不变量                         |
| -------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------ |
| 采集侧   | `collect_checkpoint_from_messages` 返回 Err(safe_point.rs:235-238:对话含命中前缀但 JSON 解析失败的行) | 视为无 checkpoint:warn 留痕、**不写叶子、不阻断收口**(该标记行是模型输出噪音,不中止 run 生命周期) | 收口链零感知                   |
| 读侧     | `read_leaf_checkpoint` 返回 `Corrupt`(session.rs:534-537)                                             | 注入文本追加「(检查点损坏已忽略,按对话历史继续)」+ warn;**照常拉起 run**                          | 拉起器零阻断                   |
| 回退语义 | 采集失败/读取损坏后                                                                                   | 恢复质量回退到既有消息水合(§2.1 历史续接,resolve_history_source)                                  | 「回退最近完整消息」= 既有路径 |

「通知」语义:采集侧损坏 → warn + 注入侧 Corrupt 提示文本(注入文本是主 agent 可见的唯一注入通道);CHECKPOINT_CORRUPT_SIGNAL(checkpoint.rs:28)保留给 D8 的观测面(P2,事件/UI 展示)。

### 3.6 水合 error 态放行 + failed-turn 标记(范围④,裁决 #13)

**改动面**(hydrate.rs,约 15-30 行,05 §2.D 预算):

```
// is_completed(hydrate.rs:87-93)改造:放行集扩展为 None/"completed"/"error",
// 其余(queued/processing/streaming/pending/空串)仍跳过
fn status_kind(entry) -> StatusKind { Completed | Failed | Skipped }

// hydrate_one(hydrate.rs:54-81)改造:放行分支中,
//   Failed(entry.status == Some("error")) → metadata = Some(json!({"kind":"failed-turn"}))
//   Completed → metadata = None(规则 4 保持,hydrate.rs:74-75)
```

- 兼容性:旧数据无 status 字段 → Completed(放行,现状);error 态消息在 `AgentMessage.metadata` 注入标记后,wire 层 `to_chat_messages` 是否读 metadata 不影响正确性(标记语义是「模型可参考失败回合」,05 §2.D 论证:污染与否交模型判断,不再由引擎替模型做决定)。
- 规则 5 尾部 user 截断(hydrate.rs:294-299)独立于 status,不因放行扩展变化。
- **无 schema/事件改动**:metadata 是 AgentMessage 既有自由 JSON 字段(events.rs AgentMessage 注册表 fields 含 metadata);33-event-schema-changelog 不动。
- 既有测试 `hydrate.rs:376-382`(error 态过滤锁定)需改断言为本轮语义(§5 T5)。

### 3.7 流中断结构化标注(范围④,04 §2.6/§3-5)

**现状**:部分保留断流消息 `metadata.providerError` 是裸文案字符串,无分类信息(proposals/04:183-190)。

**改动**(约 40-60 行,04 预算):

| 位置                                                                      | 改动                                                                                                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| agent-provider/src/consume/mod.rs `build_message_metadata`(:308-347)      | 在 `providerError` 字符串之外新增 `metadata.providerErrorKind`(kebab-case 13 类)与 `metadata.providerErrorRetryable`(bool)两字段 |
| crates/session-loop/src/stream.rs `build_message_metadata`(:439-481,镜像) | 同左                                                                                                                             |
| session-loop `streaming.rs:122-126`                                       | `Stop{reason: Error}` 注入时透传 `classified.kind`(Stop 事件变体扩展 error_kind 字段,~15 行)                                     |
| engine.rs `to_loop_event` 映射(04 §3-5 提及)                              | kind 透传(与 D1 同文件,按同文件串行纪律派单)                                                                                     |

**边界**(§1.3):本项归 D7;D1 的 `RunOutcome.provider_error`(stream_error.rs:237-269)是「收场数据面」,本项是「消息 metadata 标注」,互补不重叠。既有测试 `text_then_error_stop_yields_message`(consume/mod.rs:425-434)扩展字段断言,不删改语义(04 §4.5:三条不变量原样保持)。

**两处互补关系**:流中断标注(本项)= 消息是正常 completed 状态、内容是「部分保留产出」,标注发生在运行时产出侧;failed-turn 标记(§3.6)= error 终态消息进入上下文时由水合注入。一个是「内容可用但中断」的标注,一个是「这一轮失败了」的标记,都无 schema 改动(selection-03 M6:04 标注 + 05 水合 D1 合并为「错误消息语义完整化」)。

**消费方扩展(E1 续写触发信号,扩展定夺 E0 R7)**:

- 流中断标注除供 D1 熔断 S2 计数(§3.2.2 落点 2)与 D8 观测外,**同时作为 E1 断网自动接续的续写 run 触发信号**:收场 reason=Stop 且最后一条 assistant 消息 metadata 含 `providerErrorKind ∈ 瞬态四类`(rate-limit/server-error/timeout/network)与 `providerErrorRetryable != false` → decide_idle_resume Stop 分支续写子分支消费(D2 接线,拉起 mode="content-resume",E1 内容级续写)。
- 续写判定与 D1 熔断 S2 计数**同一数据源、同一判定逻辑**(复用 D1 §3.2.2 落点 2 的收口判定);**排期依赖**:E1 排期在 D7 之后——标注未落地前信号只有裸文案(consume/mod.rs:340-342),无法分类判定。

---

## 4. 数据面

**冻结面(零新增键/事件/命令,对齐 00 总纲 §6):**

| 项                      | 形状                                                                                                                                                                                                                                                          | 状态                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 叶子 checkpoint payload | `CheckpointPayload`(camelCase,target/summary 必填),存 `SessionRecord.branches[].payload["checkpoint"]`(`CHECKPOINT_PAYLOAD_KEY`),随快照落库 + restore 水合;**同一载荷面承载 E2 F5 阶段总结文本(扩展定夺 E0 R7,Schema V1 骨架 + tier 标记,§3.2 阶段总结载荷)** | 已冻结,零改动(conex-types/src/checkpoint.rs:37-55);阶段总结复用载荷面,不新增键 |
| 消息 metadata 标记      | `providerErrorKind`/`providerErrorRetryable`(流中断标注)、`{kind:"failed-turn"}`(水合标记)——均为 AgentMessage.metadata 自由 JSON                                                                                                                              | 无 schema 改动(events.rs AgentMessage 注册表 metadata 字段既有)                |
| session_meta 键         | **无新增**(checkpoint 数据不占 session_meta 命名空间,00 总纲 §5-12 数据面纪律保持)                                                                                                                                                                            | —                                                                              |

**变更面(契约扩展,§1.3 已声明):**

| 项                             | 形状                                                        | 消费方                                           |
| ------------------------------ | ----------------------------------------------------------- | ------------------------------------------------ |
| `RunFailureContext.history`    | `Option<Vec<HistoryMessage>>`(recovery.rs:757-780 新增字段) | fork_and_reassign → SubagentSpawnRequest.history |
| `SubagentSpawnRequest.history` | `Option<Vec<HistoryMessage>>`,serde default(agent-tools)    | spawn_unchecked → RunTaskOptions.history         |

---

## 5. 测试策略

### 5.1 单测(壳层 + session-loop + orchestrator 现有测试域)

| #   | 测试                                   | 断言                                                                                                                                                                                                                             | 位置                                                                                                         |
| --- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| T1  | 采集接线:带 CHECKPOINT 行的对话收口    | 收口后 `state.sessions` 对应会话记录叶子 payload 含 `checkpoint` 键,target/summary 保真                                                                                                                                          | core_run_commands.rs 测试域(新建)                                                                            |
| T2  | 注入:Present 三态分发                  | 有有效 payload → `RunTaskOptions.prompt` 含「上次检查点」+ target/summary/next;Absent → 文本与现状一致;Corrupt → 含「检查点损坏已忽略」且 run 照常拉起                                                                           | core_run_commands.rs 测试域(新建)                                                                            |
| T3  | 采集侧损坏降级                         | 对话含坏标记行(命中前缀 + 坏 JSON)→ 收口完成不 panic、叶子 `checkpoint` 键不写入、无阻断                                                                                                                                         | core_run_commands.rs 测试域                                                                                  |
| T4  | 读侧损坏降级                           | payload 为不可解析值 → read_leaf_checkpoint = Corrupt(session.rs:534-537 既有测试可复用作读面回归);注入侧照常拉起                                                                                                                | orchestrator session.rs 既有测试 + 壳层                                                                      |
| T5  | 水合 error 态(改既有断言)              | error → 放行 + metadata `{"kind":"failed-turn"}`;completed/None → 放行无标记;queued/processing/pending/空串 → 跳过;尾部 user 截断不变                                                                                            | hydrate.rs 测试域(改造 :376-382 断言)                                                                        |
| T6  | 收口→注入全链路                        | 同一会话:run 1 收口写叶子 → run 2 经 spawn_idle_resume_run 拉起,prompt 含 run 1 的 checkpoint 摘要                                                                                                                               | core_run_commands.rs 集成域                                                                                  |
| T7  | history 注入:Verbatim                  | decide_fork_context = Verbatim 且 ctx.history 非空 → fork 新 run 的 RunTaskOptions.history = 原 run 消息序列(断言非 None 且首条 id 匹配)                                                                                         | recovery.rs 既有测试域 + 壳层 spawner 测试                                                                   |
| T8  | history 注入:Summarized/New/空         | Summarized/New 或 history 空 → RunTaskOptions.history 仍 None(不伪造摘要);新 run 水合后对话含原 run 消息(经 hydrate_history,含 error 态消息带 failed-turn 标记)                                                                  | 同上                                                                                                         |
| T9  | 流中断结构化标注                       | 部分保留断流 → 消息 metadata 含 providerError(字符串保持)+ providerErrorKind + providerErrorRetryable;既有 `text_then_error_stop_yields_message` 扩展断言不删改                                                                  | crates/session-loop/src/stream.rs:546(`text_then_error_stop_yields_message` 实测位置)、consume/mod.rs 测试域 |
| T10 | checkpoint 跨重启水合(集成,C10)        | 写叶子 → 快照 → 新实例 run_restore → 拉起 run 2 → `RunTaskOptions.prompt` 含 checkpoint 摘要(跨重启闭环,05 数据面 #18)                                                                                                           | orchestrator 集成域(跨重启)                                                                                  |
| T11 | 阶段总结落 checkpoint 载荷(E2 F5,扩展) | 对话含阶段总结文本(或里程碑 40%/60%/80% 触发写入)→ 收口后叶子 payload 含阶段总结内容(tier/range 保真);恢复/续跑注入含阶段总结段(≤500 字符截断);无阶段总结时降级现状(无 checkpoint 段)                                            | core_run_commands.rs 测试域 + E2 F5 断言联动                                                                 |
| T12 | 流中断标注的续写消费面(E1,扩展)        | 部分保留断流消息 metadata 含瞬态四类标注(providerErrorKind/providerErrorRetryable)→ 收口判定与 D1 熔断 S2 计数共用(同数据源);标注可作为 decide_idle_resume 续写子分支信号(D2 接线,主断言在 D2 T13);非瞬态 kind(auth)→ 不触发续写 | stream.rs/consume 测试域 + D2 联动                                                                           |

### 5.2 回归面

- `orchestrator/tests/checkpoint.rs`(采集侧既有断言)扩展为注入侧断言(06 文档 P0-2 验收锚点)。
- `recovery.rs` 40+ 单测 + 4 集成测试:history 字段新增不改变任何既有断言(纯 Optional 传递),全绿作为回归面(00 总纲 §5-13)。
- `cargo test --workspace`(73 套件基线)+ 前端 `npm run typecheck`;markdown-editor 门禁与 5 个专项 spec 不受影响(本维度不触碰 reference/ 与 tests/e2e)。
- 禁止 --no-verify:hydrate.rs 断言改动(现有测试 :376-382)必须同步更新,CI 门禁全绿为准。

### 5.3 验收断言 ↔ 测试映射

A1→T2、A2→T3/T4、A3→T5、A4→T1/T6/T10、A5→T7/T8、A6→T9;扩展:T11(E2 F5 阶段总结载荷)、T12(E1 续写信号消费面)。

---

## 6. 风险与护栏

| #   | 风险                                                             | 护栏                                                                                                                                                                                          | 依据                                           |
| --- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| R1  | 对话内模型噪音产生坏标记行,采集 Err 中断收口                     | 采集侧 Err 视为无 checkpoint:warn + 不写 + 不阻断(§3.5);`collect_checkpoint_from_messages` 是纯函数返回值,收口链零感知                                                                        | safe_point.rs:235-238;00 总纲 §5-12(fail-open) |
| R2  | 注入摘要超长稀释注意力/浪费 token                                | 摘要截断护栏(§8 决策 4,summary ≤500 字符);注入文本与队列条目同通道,D6 的合并上限(≤16 条)对 checkpoint 段同样适用(00 总纲 §5-8)                                                                | 00-总纲:116                                    |
| R3  | checkpoint 与 fork 继承的关系:fork 新叶子是否继承 checkpoint     | 新叶子 payload 由 `fork_node_payload` 显式构造(不含 checkpoint 键,recovery.rs:1089)——语义正确:fork 是显式重派,checkpoint 是自动恢复,互不干扰;源叶子 checkpoint 保持原样(下一轮自动恢复仍可用) | recovery.rs:1079-1098                          |
| R4  | 双路径语义统一:引擎缓存路径 vs 前端水合路径对 error 态不一致(G6) | 缓存路径本就全角色保真(to_history_messages status 恒 completed,:938);hydrate 放行 error 态后两路径在「error 态保留」上统一,失败回合不再从重启水合序列消失                                     | hydrate.rs:87-93;01-主agent:G6                 |
| R5  | failed-turn 标记污染模型判断(原始顾虑)                           | 放行+标记=「污染与否交模型判断」,不再由引擎替模型决定(裁决 #13);标记只对 error 态注入,正常消息 metadata 保持裁剪(规则 4)                                                                      | 01-敲定:27;05 §2.D                             |
| R6  | history 注入的重复副作用                                         | history 只是上下文数据(原 run 消息回放),不重放工具执行——工具执行与 provider 流互斥,turn 顺序保证(00 总纲 §5-9);fork 仍走 spawn 守卫受 12/5/1 约束,12/5/1 只增不减                             | 00-总纲:109                                    |
| R7  | 写面与快照并发                                                   | 树访问器全程持有 `state.sessions` std mutex(纯内存,无 await),与快照序列化同锁互斥                                                                                                             | core_run_commands.rs:2303                      |
| R8  | 无树会话(新会话/子代理会话)采集空转                              | 写面无记录/无叶子 → 跳过(Absent 语义),不建占位树(禁假接线,01-敲定 §4-6)                                                                                                                       | session.rs:334-341;01-敲定:94                  |
| R9  | 用户显式停止不触发本维度任何自动动作                             | 采集/注入都挂在既有收口与拉起器上,decide_idle_resume 的 Stopped/Aborted 永不续硬条件(:2513)不变,checkpoint 注入不改变判定                                                                     | core_run_commands.rs:2513                      |

---

## 7. 接口(与其它维度对接)

| 接口                       | 方向        | 契约                                                                                                                                                                                                          | 属主                                     |
| -------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 拉起器注入载体             | D6 → D7     | `spawn_idle_resume_run`(core_run_commands.rs:2637-2671)是 checkpoint 摘要的唯一注入载体;watcher 拉起的 run 免费获得摘要;D6 的恢复条目文本与 checkpoint 摘要同消息拼接                                         | D6 提供,本维度消费                       |
| history 续接               | D2 → D7     | error 续 run 的新 run 经同一拉起器 → checkpoint 摘要同样生效;上下文完整已由 SessionHistoryCache 兜底(:2718),D7 不重复造主 run history                                                                         | D2 验收,本维度免费获得                   |
| fork 路径 ctx              | D3 → D7     | 子代理收口触发点(壳层,:2844 前)构造 `RunFailureContext` 时填充 `history`(自 :2718 已缓存的会话历史);`SubagentSpawnRequest.history` 传递面归本维度                                                             | D3 装配 ctx,本维度定字段                 |
| 续轮注入合并               | D5 ↔ D7     | D5 的 goal 前缀/nextSteps 与本维度的 checkpoint 摘要同注入通道(01 方案 §4-E);最终拼装顺序(队列条目 → goal 前缀 → checkpoint 段)由拉起器统一,两维度各自只追加自己的一段                                        | D5/D7 分域追加                           |
| 观测                       | D7 → D8     | hydrate 改造(本维度做)后,前端失败回合展示与 failed-turn 渲染归 D8(UI 面,04 §2.6 P2 观测项);CHECKPOINT_PRESENT/CORRUPT 信号(checkpoint.rs:26-28)留作 D8 事件/展示面(P2,本轮不新增事件)                         | D8 消费                                  |
| 同文件串行                 | D7 ∩ D1/D3  | core_run_commands.rs 收口区(:2718/:2729/:2844)与 D3 同点、engine.rs `to_loop_event` 与 D1 同文件——按 00 总纲 §4 同文件互斥派单;stream.rs/consume/mod.rs 归本维度独有,无冲突                                   | 主控派单约束                             |
| checkpoint 载荷 = 阶段总结 | E2 → D7     | 阶段总结(E2 F5,40%/60%/80% 里程碑 LLM 产出)经采集/写面落 checkpoint 载荷(read/set_leaf_checkpoint,session.rs:514/545),恢复/续跑注入系统提示词段;与终结摘要(goal/nextSteps)形成素材继承链(贯通 05 P1 续轮注入) | E2 设计,D7 载荷面承载(§3.2 阶段总结载荷) |
| 续写触发信号               | D7 → D2(E1) | 流中断标注 metadata.providerErrorKind ∈ 瞬态四类 = E1 续写 run 触发信号(decide_idle_resume Stop 子分支消费,D2 接线);与 D1 熔断 S2 计数同数据源;E1 排期在 D7 之后                                              | D7 生产,E1/D2 消费(§3.7 消费方扩展)      |

---

## 8. 动态决策记录(输入文档未覆盖处的自决)

| #   | 问题                                                                                   | 决策                                                                                                                                                                                                                                                                          | 理由                                                                                                                                                                                     | 影响面             |
| --- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 1   | 采集/注入写面的会话树实例从哪来(00 总纲 D3 才装配 session_trees 表,D7 派单可能先于 D3) | **基线自洽路径:经 `state.sessions` 快照注册表临时重建**——`from_session_record`(session.rs:589)→ 读写 → `to_session_record` 回写;D3 的 session_trees 表落地后切换共享实例(同函数体,一行访问器差异)。**派单注记(02-定夺 M4)**:壳层面排 D3 之后;独立面(水合/标注/字段)不受此约束 | 消除对 D3 的隐藏依赖,保持 D7 可独立验收;重建成本 = 收口一次 O(树大小) 纯内存拷贝,频率极低可接受;复用冻结资产(read/set_leaf_checkpoint)不重复实现三态解析                                 | §3.1/§3.2 树访问器 |
| 2   | 无树/无叶子会话(新会话、子代理会话)的采集语义                                          | 写面无记录或无 current_leaf_id → **跳过**(Absent 语义),不建占位树                                                                                                                                                                                                             | 树的叶子是分支语义(C6 主写权),采集为 checkpoint 建叶子是侵入;无叶子时「无 checkpoint 行为不变」与现状一致;验收场景(带 checkpoint 叶子会话)由 fork 过/恢复过的会话构造                    | §3.1 触发范围      |
| 3   | 采集触发点:安全点采集 vs 收口采集                                                      | **收口采集一次**(produce 后、drive_outcome 前),finalize_failed 防御路径跳过并注释                                                                                                                                                                                             | 每 turn 安全点采集过频且安全点无 outcome 消息句柄;收口采集覆盖 error 收场(部分产出含最新 checkpoint 行,恢复质量关键);finalize_failed 是 drive 失败防御路径,消息未消费属极罕见,跳过可接受 | §3.1               |
| 4   | 注入摘要长度护栏                                                                       | summary 字段截断 **≤500 字符**(超长截断 + 省略号),completed/next 各 ≤5 项                                                                                                                                                                                                     | 注入文本过长稀释注意力且浪费 token;500 字符约为 2-3 句话,足够承载「已完成/下一步」要点                                                                                                   | §3.2               |
| 5   | 流中断标注的维度归属(00 总纲 D1/D7 双挂)                                               | **归 D7**(consume/stream/streaming 三文件全在本维度);engine.rs to_loop_event 与 D1 同文件串行                                                                                                                                                                                 | 任务书范围④明示;00 总纲 D1 关键文件不含 stream.rs/consume;D1 的 provider_error 数据面与标注互补不重叠                                                                                    | §1.3、§3.7         |
| 6   | `RunFailureContext.history` 是否破坏「recovery.rs 零改动」(00 总纲 D3 约束)            | 只加字段 + 透传,**RecoveryBudget/键形状/算法零改动**;字段是 Optional 传递,既有测试全绿                                                                                                                                                                                        | 裁决 #19 的落地载体绕不开 fork 请求构造点;「零改动」精确含义 = 算法与数据面冻结形状零改动,数据流扩展不违背                                                                               | §1.3、§3.4         |
| 7   | 采集侧损坏是否发事件                                                                   | 不发(本轮):warn + 注入侧提示文本;CHECKPOINT_CORRUPT_SIGNAL 留给 D8 观测面(P2)                                                                                                                                                                                                 | 采集损坏是低频噪音信号,发事件需新增事件类型与登记(六处改动面),与「无 schema 改动」约束冲突;注入侧提示已达成「通知」语义                                                                  | §3.5               |
| 8   | 子代理 fork 的 Summarized 摘要注入                                                     | **明确后置**(本轮只做 Verbatim 原始消息);Summarized 保持现状(task-only 注入)                                                                                                                                                                                                  | Summarizer 生产装配断链(02 选型 C);裁决 #19 原文「先于 Summarized 摘要」即定序                                                                                                           | §3.4               |
| 9   | hydrate 规则 4(metadata 裁剪)与 failed-turn 注入的关系                                 | 标记注入是**唯一例外**:仅 Failed 态注入,Completed/None 保持 metadata=None                                                                                                                                                                                                     | 避免把 usage 等运行期数据带进 LLM 上下文(规则 4 原意),同时满足裁决 #13                                                                                                                   | §3.6               |

---

## 附:关键文件索引(本次核对)

| 文件                                                                                                     | 角色                                                                      |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| crates/conex-types/src/checkpoint.rs                                                                     | 载荷形状/行标记/信号常量(已冻结)                                          |
| crates/session-loop/src/safe_point.rs:212-278                                                            | 采集纯函数(生产零调用,接线点)                                             |
| crates/session-loop/src/checkpoint.rs:16-21                                                              | 提示词协议段(升级为机制保证的对照源)                                      |
| crates/session-loop/src/hydrate.rs:54-93、294-299                                                        | 水合放行 + failed-turn 标记改造点                                         |
| crates/orchestrator/src/session.rs:334、514-574、589-591                                                 | 叶子 checkpoint 读写 + 树重建(冻结资产复用)                               |
| crates/orchestrator/src/recovery.rs:399-442、757-780、1031-1173                                          | fork 三态判定、RunFailureContext(增 history)、fork_and_reassign(透传)     |
| crates/orchestrator/src/lifecycle.rs:243-321、353-361                                                    | resume 路径 ctx 装配、derive_task(SessionMessage→HistoryMessage 转换同源) |
| apps/agent-workbench/src-tauri/src/core_run_commands.rs:1516-1517、2205-2208、2303、2637-2671、2688-2913 | 会话树注册表、拉起器注入点、收口采集点                                    |
| apps/agent-workbench/src-tauri/src/subagent_spawner.rs:289、354-368                                      | 子代理会话 id、RunTaskOptions.history 装配点                              |
| crates/agent-tools/src/tools/subagent.rs                                                                 | SubagentSpawnRequest(新增 history 字段)                                   |
| agent-provider/src/consume/mod.rs:308-347、425-434                                                       | 流中断结构化标注(镜像一)+ 既有测试扩展                                    |
| crates/session-loop/src/stream.rs:439-481、streaming.rs:122-126                                          | 流中断结构化标注(镜像二)+ Stop 透传 kind                                  |

> 本文档为只读分析产出(唯一写面);未修改任何代码、未执行任何 git 操作。行号以核对当日代码为准,如漂移以实际代码为真源。
