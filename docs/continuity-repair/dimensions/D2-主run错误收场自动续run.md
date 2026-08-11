# D2 — 主 run error 收场自动续 run(维度详细设计)

> 目录:docs/continuity-repair/dimensions/
> 日期:2026-08-11
> 定位:本文件为「任务连续性多Agent协同修复方案」维度文档轮中【维度 D2】的详细设计,细化到可直接指导实现的粒度。范围与裁决已冻结(00 总纲 §3 + 01 敲定方案),本文档是唯一权威的 D2 实现输入。
> 输入:00-总纲-维度设计.md(§3 D2、§4 同批约束、§5 护栏、§6 契约)、01-敲定方案.md(裁决 #8/#21、§3 接线时序、§4 红线)、proposals/02(§2-D、W5)、proposals/01(D2、决策 4)、reviews/selection-01(§3.3、分歧 4/9)、selection-02(§2.3/§2.4/§5.1)、selection-03(S5、评审护栏 5)。
> 代码基线:仓库当前 HEAD;行号以核对当日代码为准,如漂移以实际代码为真源。
> 引用统一为 `文件路径:行号`。

---

## 1. 维度目标与验收断言

### 1.1 目标

主 run(主 agent run)因 provider 瞬态错误耗尽 run 内重试(默认 3 次,stream_error.rs:81-95)以 `Error` 收场后,系统**自动拉起新一轮 run 继续任务**,而非悬挂等待用户手动重发。用户显式停止(Stopped/Aborted)、abort、user_touched 永不自动续。

**扩展接续(E1 断网自动接续·内容级续写,扩展定夺 E0 §三/R4)**:在 `Stop` 收场路径新增**续写 run 子分支**——部分保留断流(已产出内容 + 流中断,收场 reason=Stop、`RunOutcome.provider_error = None`)自动拉起续写 run(mode=`"content-resume"`),与 error 收场续 run(本维度既有,error-retry 域)构成「断网不丢任务」三级链的 run 间两级(① 传输级重连 → ② 内容级续写 → ③ 会话级续接);续写 run 自身 Error 收场**自然落入本维度 error 分支**(降级 ③)。排期在 D7(流中断标注)之后接线(§3.6、§8 D2-11)。

### 1.2 最低线(00 总纲 §3 D2,细化到测试写法)

00 总纲 §3 的 D2 验收断言(00-总纲-维度设计.md:76)细化如下,每一条对应 §5 测试策略中的具体测试:

| #   | 最低线断言                                      | 细化(测试写法)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 对应测试  |
| --- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| A1  | 模拟 3 次重试耗尽 → 自动拉起新 run 且上下文完整 | mock run 1 的 provider 每次调用均返回瞬态错误 → run 内 3 次重试耗尽 → `RunOutcome.reason == Error` 且 `provider_error = Some{retryable: true, retries: 3}` → `decide_idle_resume` 返回 `Some`(注入文本**锁定精确模板**「继续任务」——最小化注入,kind/retries 细节走 `provider-diagnostic` 事件 + 临时通知,不进对话)→ 拉起器被调用(断言 run 计数 +1、新 run 存在);上下文完整 = 新 run 的 history 参数回退 `SessionHistoryCache`(core_run_commands.rs:2718 收口已缓存),断言新 run 首轮对话含 run 1 的部分产出消息;**实现时需核证 `resolve_history_source` Cache 分支既有测试**(C8)   | T1/T2     |
| A2  | 第 4 次 error 停止自动续                        | 连续 4 次 error 收场(每次 run 内 3 次重试耗尽):前 3 次各自动续 run 一次(预算 0→3),第 4 次 `decide_idle_resume` 返回 `None`,留 `recovery-budget-denied` 事件,`recover_episodes` 键 count=3                                                                                                                                                                                                                                                                                                                                                                                         | T3        |
| A3  | 用户停止/abort 永不续                           | `reason == Stopped` / `reason == Aborted` / `abort_signal.is_aborted()` / `user_touched` 四组输入均返回 `None`(即使 provider_error retryable 且预算内)                                                                                                                                                                                                                                                                                                                                                                                                                            | T4        |
| A4  | 非 retryable 不续                               | `provider_error = Some{retryable: false}`(Auth/Quota 类)→ `None`;`provider_error = None`(非 PROVIDER_ERROR 的 error 收场)→ `None`                                                                                                                                                                                                                                                                                                                                                                                                                                                 | T5        |
| A5  | 指纹按唤醒源隔离                                | 同任务文本、source 分别为 `error-retry` 与 `user` → 指纹不同,预算计数互不消耗;`timer-<id1>` 与 `timer-<id2>` 指纹不同(供 D6 回归)                                                                                                                                                                                                                                                                                                                                                                                                                                                 | T6        |
| A6  | 熔断期不续                                      | D1 提供 `is_tripped` 判定为 true → error 分支拒绝(即使 retryable 且预算内)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | T7        |
| A7  | error 轮不计空转 streak                         | 连续 2 次 error 续 run 后空转计数不增;随后一次 Stop 收场三源全空 → 空转计数从 0 起步(而非继承 2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | T8        |
| A8  | 退避序列                                        | 延迟函数注入(`retry_delay` 注入点,测试直接驱动):第 1/2/3 次 error 续 run 前等待 ≥ 750/1500/3000ms(镜像 recovery.rs:116-118 常量),断言与注入方式绑定写死(不依赖 tokio pause,C4)                                                                                                                                                                                                                                                                                                                                                                                                    | T9        |
| A9  | error 续 run 走主 run idle 通道(说明性断言)     | error 续 run 拉起复用主 run idle 通道:`spawn_idle_resume_run` 以 subagent_config=None 拉起(core_run_commands.rs:2660-2661),不经过 spawn 守卫(spawn 守卫为子代理 run 面);嵌套禁令不变,12/5/1 不受影响(C12/P3-4)                                                                                                                                                                                                                                                                                                                                                                    | —(说明性) |
| A10 | 部分保留断流 → 自动续写 run 且无重复输出        | mock「发数据后断流」→ run 1 收场 reason=Stop、最后消息 metadata.providerErrorKind=network 且 providerErrorRetryable=true(纯文本消息)→ decide_idle_resume 返回 Some(注入文本**精确等于 E1 锁定模板**「上一轮生成中断(Network),请从断点继续完成,不要重复已输出的内容」)→ 拉起器 mock 计数 +1、新 run mode="content-resume";断言新 run 首轮对话含 run 1 部分文本(history 经 SessionHistoryCache 水合,不重复注入已产出文本;**前缀不变性**:已 commit 消息零改动、同一端点与缓存亲和头保持),且 run 2 首条 assistant 文本前 30 字符与 run 1 部分文本尾 30 字符**无重叠**(防重复前缀检测) | T13       |
| A11 | 续写失败 → 降级 error 续 run                    | run 2(续写 run)provider 每次调用均返回瞬态错误 → run 2 以 Error 收场(provider_error=Some{retryable:true})→ 自动拉起 run 3(mode="recovery-retry",注入文本 = D2 锁定模板「继续任务」)                                                                                                                                                                                                                                                                                                                                                                                               | T14       |

### 1.3 与敲定冲突声明

无与 01 敲定方案冲突处。一处**范围澄清**(非冲突):00 总纲 §3 D2 写「recovery.rs(预算复用,零改动)」,而 01 敲定方案裁决 #8 要求指纹含唤醒源类型(`fingerprint("main", 任务文本, 唤醒源类型)`)——现有 `fingerprint(subagent_id, task)` 为两参签名(recovery.rs:251-262),因此 **recovery.rs 需要新增三参指纹变体**(§3.3)。「零改动」精确含义 = `RecoveryBudget` 本体(can_recover/record_fork/to_json/from_json,recovery.rs:276-336)与 `recover_episodes` 键形状(recovery.rs:86)零改动;指纹是调用面构造,以裁决 #8 为准。

---

## 2. 现状基线(文件:行号)与缺口

### 2.1 现状事实

| 面                 | 现状                                                                                                                                                                                                                                                                                       | 证据                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| run 内瞬态重试     | 上限默认 3,计数每 run 归零,重试间无退避,耗尽 → `fatal_provider_error`                                                                                                                                                                                                                      | stream_error.rs:81-95、237-269;loop/mod.rs:281、672              |
| fatal 数据面       | `fatal_provider_error` 写 `state.terminal_error` 文案(:252)与 `runtime-error` 事件(retryable 透传,:257-262);**RunOutcome 无结构化错误字段**                                                                                                                                                | stream_error.rs:237-269;end.rs:99-125(字段清单无 provider_error) |
| 主 run 收口        | `drive_run_loop` produce 后提前捕获 Copy 字段(reason/turn_index/tool_call_count,:2710-2712),outcome 随后 move 进 `drive_outcome`(:2729-2733);收口前 `session_history.store`(:2718)                                                                                                         | core_run_commands.rs:2701-2733                                   |
| idle 续 run 硬条件 | `abort_signal.is_aborted() \|\| reason != Stop → 不续`(:2513),注释明确 Error/MaxTurns = 异常边界保守不续(:2493-2494);user_touched 不续(:2517-2519)                                                                                                                                         | core_run_commands.rs:2511-2519                                   |
| 三源判定           | 队列非空 / 活跃定时器 / enabled Cron(:2522-2555);空转护栏 `*entry > IDLE_RESUME_MAX_EMPTY_ROUNDS` 停(:2561-2582);drain 注入(:2585-2592)                                                                                                                                                    | core_run_commands.rs:2520-2593                                   |
| 拉起器             | `spawn_idle_resume_run`(RunTaskOptions 构造,mode 硬编码 `"idle-resume"`,:2651;经 `run_task_impl` 拉起)                                                                                                                                                                                     | core_run_commands.rs:2637-2671                                   |
| 预算资产           | `fingerprint(subagent_id, task)` FNV-1a(recovery.rs:251-262);`RecoveryBudget` 上限默认 3、can_recover/record_fork/to_json/from_json 宽容解析(recovery.rs:276-336);键 `recover_max_episodes`(:84)/`recover_episodes`(:86);超预算 → `recovery-budget-denied` 事件(:111)                      | recovery.rs:80-111、245-336                                      |
| 恢复条目资产       | `RECOVER_GROUP_PREFIX = "recovery-"`(:97);`steering_group_id`(:361-363);`build_steering_entry`(:378-387);队列 `replace_or_enqueue` 同分组去重(steering_queue.rs 既有语义,评审 selection-01:44 已核证 :199-215 区域);`SteeringInputEntry::steering` 受容量挤占保护(steering_queue.rs:78-83) | recovery.rs:95-97、360-387;steering_queue.rs:29-30、78-83        |
| 会话内串行         | 同会话同时仅一个活动 run(:3208-3216)——预算读-改-写无并发写风险                                                                                                                                                                                                                             | core_run_commands.rs:3208-3216                                   |
| 空转常量           | `IDLE_RESUME_MAX_EMPTY_ROUNDS`(core_run_commands.rs:2458;判定 `*entry > 3` 允许 3 次空转、第 4 次停,:2571)                                                                                                                                                                                 | core_run_commands.rs:2458、2571                                  |

### 2.2 缺口清单(与 00 总纲 §3 D2 逐条对应)

| #   | 缺口                                                                                              | 现状证据                                                         | 本维度闭合方式                                   |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| G-1 | `decide_idle_resume` 硬性排除 Error 收场:主 run 网络中断耗尽重试后任务悬挂                        | :2513 `reason != AgentEndReason::Stop → return None`             | §3 判定顺序:Error → retryable 分支               |
| G-2 | RunOutcome 无结构化 provider 错误数据面,收口无法判定 retryable                                    | end.rs:99-125;stream_error.rs:237-269 只写文案与事件             | 消费 D1 生产的 `RunOutcome.provider_error`(§3.5) |
| G-3 | 主 run 恢复预算未接线:recover_episodes 键仅有 C7 阶梯 3 fork 消费面(且生产未装配)                 | recovery.rs:57-62(F2-08 自述);RecoveryBudget 无主 run 指纹调用方 | §3.4 预算判定 + 消费(同键同池,指纹域隔离)        |
| G-4 | 无跨 run 退避:error 续 run 若不加退避,3 次重试连发风暴会在跨 run 层面复现(selection-02 评审 §2.4) | stream_error.rs:81-95 无退避;壳层无跨 run 等待                   | §3.4 退避 sleep(与 D1 同批,常量镜像)             |
| G-5 | 无恢复条目构造:队列写入侧只有 C7 阶梯 2 的 `build_steering_entry`(子代理域)                       | recovery.rs:378-387                                              | §3.4 主 run 恢复条目构造(复用 `recovery-` 前缀)  |
| G-6 | 拉起器 mode 硬编码 `"idle-resume"`,自动恢复类型不可观测(02 D9 要求 recovery-retry)                | core_run_commands.rs:2651                                        | §3.4 mode 参数化(共享接口,随 D5/D6 一并使用)     |

---

## 3. 改动设计

### 3.1 判定顺序伪代码(decide_idle_resume 改造,core_run_commands.rs:2505-2593)

```
async fn decide_idle_resume(
    state, active, reason, had_ai_output,
    provider_error: Option<&ProviderErrorSummary>,        // ← 新增入参(D1 数据面)
) -> Option<Vec<AgentMessage>> {
    // 1. 硬条件(保持,扩语义):abort 永不续(双保险)
    if active.abort_signal.is_aborted() { return None; }
    // 2. 用户消息到达后的收场不续 —— 对 Stop 与 Error 两路径均生效
    //    (01 敲定 §4 红线 2:user_touched 永不自动续)
    if active.user_touched.load(Ordering::SeqCst) { return None; }

    match reason {
        // ── 正常收场:原三源路径 + D5 goal_pending(同区接线,00 总纲 §4)──
        AgentEndReason::Stop => {
            // ── 续写子分支(E1 内容级续写,扩展定夺 E0 R4;排期在 D7 之后)──
            // 条件:最后一条 assistant 消息为纯文本(无 tool_calls)、文本非空,
            //   且 metadata 含 providerErrorKind ∈ 瞬态四类(rate-limit/server-error/
            //   timeout/network)与 providerErrorRetryable != false——即 D7 流中断标注,
            //   与 D1 熔断 S2 计数同数据源;熔断未触发(续写是自动动作,受熔断闸约束)
            if let Some(last) = last_assistant_text_message(outcome)
                && is_transient_kind(&last.metadata)          // D7 §3.7 标注
                && !state.circuit_breaker_is_tripped(&active.session_id).await
            {
                // 预算:独立指纹域 fingerprint_with_source("main", task, "content-resume"),
                //   上限 content_resume_max 默认 2(比 error-retry 的 3 更紧)
                let fp = fingerprint_with_source("main", &task, "content-resume");
                if consume_content_resume_episode(state, &active.session_id, &fp).await {
                    // 退避 + abort 复查(对齐 3f;预算在退避前消费)
                    let delay = backoff_for_attempt(state, &active.session_id).await;
                    state.sleep_resume_backoff(delay).await;
                    if active.abort_signal.is_aborted() { return None; }
                    // 注入锁定模板(E1 §3.2):「上一轮生成中断(<kind>),请从断点继续完成,
                    //   不要重复已输出的内容」;history 经 SessionHistoryCache 天然含
                    //   已产出前缀(收口 :2718 保真缓存 + resolve_history_source Cache 分支
                    //   水合),不重复注入已产出文本;前缀不变性(约束 B):续写/重试保持
                    //   对话前缀不变(已 commit 消息零改动)以提升 provider 前缀缓存命中,
                    //   同一端点与缓存亲和头保持
                    build_content_resume_entry(&active.run_id, &last_kind, now_ms())
                        |> queue.replace_or_enqueue;
                    return Some(drain_pending_to_inject_messages(&mut queue, &active.session_id));
                }
                // 预算超限 → 不续写,半截保留交用户(与 error 域预算耗尽同语义,域不挪用)
            }
            // 三源判定(:2522-2555 既有)+ D5 增 goal_pending 第四源
            // 空转护栏(:2561-2582 既有;goal 续轮按 03 护栏 3 语义,D5 侧计 stalled)
            // drain 注入(:2585-2592 既有)—— 保持不变,仅在此区并入 D5 分支
            ...既有逻辑...
        }
        // ── 主 run error 收场:本维度新分支 ──
        AgentEndReason::Error => {
            // 3a. 数据面:无结构化错误 / 非 retryable → 不续
            let Some(pe) = provider_error else { return None; };
            if !pe.retryable { return None; }
            // 3b. 熔断(D1 提供 is_tripped,provider_fail_streak 键)→ 不续
            if state.circuit_breaker_is_tripped(&active.session_id).await { return None; }
            // 3c. 任务文本提取(会话首条非 steering user 消息,回退链见 §3.3)
            let task = main_task_text(state, &active.session_id).await;
            // 3d. 指纹(裁决 #8):source = "error-retry"
            let fp = fingerprint_with_source("main", &task, "error-retry");
            // 3e. 预算消费:spawn_blocking 读-改-写 recover_episodes
            //     (RecoveryBudget 纯函数复用,零改动;F2-27)
            if !consume_main_episode(state, &active.session_id, &fp).await {
                // 超限:recovery-budget-denied 事件留痕(§3.4)+ 不续
                return None;
            }
            // 3f. 跨 run 退避(常量镜像 recovery.rs:116-118;延迟函数注入,测试直接驱动)
            let delay = backoff_for_attempt(state, &active.session_id).await;
            state.sleep_resume_backoff(delay).await;   // 经 state 注入点调用(默认 tokio sleep)
            if active.abort_signal.is_aborted() { return None; }   // 退避期 abort 复查
            // 3g. 恢复条目入队 → drain 注入 → 拉起(与任务书①一致);注入文本最小化
            //     「继续任务」(约束 C:kind/retries 走 provider-diagnostic 事件 +
            //     临时通知,不进对话、不给 AI 看到)
            build_main_resume_entry(&active.run_id, &pe, now_ms())
                |> queue.replace_or_enqueue;
            return Some(drain_pending_to_inject_messages(&mut queue, &active.session_id));
        }
        // ── 用户停止 / 其它:永不续(Stopped/Aborted/MaxTurns)──
        _ => return None,
    }
}
```

关键点:

1. **:2513 硬条件改造形态**:原 `if abort || reason != Stop { return None }` 拆为「abort 检查 + reason match」。显式区分三种语义(00 总纲 §6:140 契约要求)——Stop → 三源+goal_pending;Error → retryable 分支;Stopped/Aborted → 永不续。**MaxTurns 保持保守不续**(00 总纲 D2「不做什么」,core_run_commands.rs:2493-2494 注释语义不变)。
2. **error 分支不经过三源判定与空转护栏**:error 续 run 属「有真实任务输入」(敲定 #21),直接在 match 内返回,不落入 :2522-2582 路径——这是「不计空转 streak」的实现形态,也是「error 分支与 Stop 路径互不干扰」的结构保证。
3. **判定顺序**:abort → user_touched → retryable → 熔断 → 预算 → 退避 → 入队。预算在退避前消费(预算封顶保证退避最多 3 次);拉起失败不重复消费(条目滞留由 watcher/下轮收口兜底,§6.1)。
4. **退避期间 abort 复查**:sleep 醒来再查 abort(对齐 D1 abort 竞速语义,selection-01 分歧 9 裁决、04 §3-1)。
5. **续写子分支(E1)与 error 分支的关系**:续写 run 是新 run,它自己的收口走同一 decide_idle_resume 判定链——续写 run 以 Error 收场(provider_error retryable)→ **自然落入本分支 3a-3g(降级 ③)**,降级是天然发生的、无需显式跳转(E1 §3.5);续写子分支条件不满足(非瞬态 kind / 无 D7 标注 / 熔断触发 / 预算耗尽)→ 半截保留交用户,不触发任何自动动作。**非瞬态不续写**:kind ∈ {Auth/Quota/InvalidRequest/ContextLengthExceeded/PayloadTooLarge/Unknown/Aborted 等} → 走既有三源路径或保持现状。**数据源注记**:续写触发判定与 D1 熔断 S2 计数同一数据源(D7 流中断标注 metadata.providerErrorKind,复用 D1 §3.2.2 落点 2 的收口判定逻辑);排期在 D7 之后。

**信息分级注记(约束 C,横切 §3.1/§3.4/§5)**:

- 瞬态重试、自动重连进度与 error 续 run 的细节(kind/retries/退避进度)一律为**观测面**——走 `provider-diagnostic` 事件 + 临时通知(老虎机滚动式重连进度,如 1/6→2/6),**不进入对话上下文、不给 AI 看到**;仅「子 agent 失败类」信息注入对话(D3 面)。
- 因此 error 续 run 的对话注入文本保持**最小化「继续任务」**,不含任何诊断细节;诊断细节在 provider-diagnostic 事件载荷与临时通知面承载(消费面见 D8 §3.7.4)。

### 3.2 调用链数据面消费(drive_run_loop,core_run_commands.rs:2688-2913)

- **移动消费前提前提取**:`outcome` 在 :2729-2733 被 move 进 `drive_outcome`,因此 provider_error 必须在 :2710-2712(Copy 字段捕获同批)提取:新增一行 `let resume_provider_error = outcome.provider_error.clone();`(Option 小结构,clone 零风险;对齐 selection-02 §2.1 指出的「:2710-2712 同批提取」约束)。
- **传递**:idle 判定调用点 :2873-2879 增传 `resume_provider_error.as_ref()`。
- **签名**:`decide_idle_resume(state, active, reason, had_ai_output, provider_error: Option<&ProviderErrorSummary>)`。
- **子代理 run 不参与**:`active.subagent.is_none()` 守卫(:2872)保持——子代理恢复走 D3 阶梯,error 分支只服务主 run(02 D10)。
- **主 run idle 通道说明(C12/P3-4)**:error 续 run 的拉起复用**主 run idle 通道**——`spawn_idle_resume_run` 以 subagent_config=None 拉起(core_run_commands.rs:2660-2661),**不经过 spawn 守卫**(spawn 守卫是子代理 run 面,主 run idle 拉起不经其校验);嵌套禁令不变、12/5/1 不受影响。

### 3.3 指纹构造(裁决 #8)

**唤醒源常量**(D2 只消费 `error-retry`,其余供 D5/D6,集中定义建议放 recovery.rs 或壳层常量区,避免各维度各自字面量漂移):

```
pub const WAKE_SOURCE_USER: &str = "user";
pub const WAKE_SOURCE_ERROR_RETRY: &str = "error-retry";
pub const WAKE_SOURCE_CONTENT_RESUME: &str = "content-resume";  // E1 续写(扩展定夺 E0 R4,本维度 Stop 子分支消费)
// timer-<id> / cron-<id> 为动态拼接(D6);restore / goal 为静态(D6/D5)
```

> **注(W8 定夺 + 扩展落地)**:唤醒源枚举原为**前瞻设计**,预算实际仅 `error-retry` 域消费;扩展定夺(E0 §三/R4)落地后 **`content-resume` 域(续写 run)同步消费预算**——同键 `recover_episodes`、三参指纹、域互斥;restore/timer/cron/goal 源仍**不消费预算**(各自独立护栏)。

**指纹函数**(recovery.rs 新增,既有两参 `fingerprint` 保持不动——40+ 单测锁定其行为):

```rust
/// 带唤醒源类型的操作指纹(裁决 #8:同注入模板 = 同任务会混淆不同唤醒源,
/// selection-03 评审护栏 5)。source 参与哈希输入,与 task 字节间以 0x00 分隔。
pub fn fingerprint_with_source(subagent_id: &str, task: &str, source: &str) -> String {
    // 复用 fingerprint(:251-262)的 FNV-1a 循环,哈希输入追加
    // source 段(以分隔字节避免边界歧义)
}
```

隔离语义:同一任务经不同唤醒源是不同「任务事件」(selection-03 动态决策 6),`timer-<id1>` 与 `timer-<id2>` 互不共享预算。

**任务文本提取(动态决策,输入文档未覆盖处自决)**:

- 不能取「当前 run 首条 user 消息」——error 续 run 拉起的 run,其首条 user 消息是「继续任务」最小化注入文本(带 `{kind:"steering"}` 元数据,core_run_commands.rs:2622),直接取会让指纹从第二次起漂移到注入模板上(selection-03 评审护栏 5 指出的同类混淆)。
- 取法:会话历史 `SessionHistoryCache.get(session_id)`(core_run_commands.rs:706-713,收口时已缓存 :2718)中**第一条 role=user 且 metadata.kind != "steering" 的消息文本**(trim 非空);回退链:① 无缓存 → 当前 run 的 `outcome.messages` 首条非 steering user 消息;② 仍无 → 空串(指纹仍随 source 隔离,预算语义不破坏)。
- 与 lifecycle.rs:353-361 `derive_task` 同源语义(子代理行首条 user 消息),此处等价物 = 会话级首条真实用户消息。

### 3.4 恢复条目形状与预算/退避落地

**恢复条目**(对齐 `build_steering_entry` recovery.rs:378-387 的形状惯例):

```rust
fn build_main_resume_entry(run_id: &str, pe: &ProviderErrorSummary, now: u64) -> SteeringInputEntry {
    // 注入文本最小化「继续任务」(约束 C):kind/retries 等诊断细节不进对话,
    // 由同点发射的 provider-diagnostic 事件 + 临时通知承载(观测面)
    SteeringInputEntry {
        id: format!("recovery-main-{run_id}-{now}"),
        text: MAIN_RESUME_INJECT_TEXT.to_string(),   // C8 锁定精确模板「继续任务」(与断言一致,无 kind 细节)
        attachments: Vec::new(),
        enqueued_at: now,
        group_id: Some(format!("{RECOVER_GROUP_PREFIX}{run_id}")),   // "recovery-<run_id>"
        is_steering: true,   // 容量挤占受保护(steering_queue.rs:78-83)
    }
}
```

- group_id 复用 `recovery-` 前缀(00 总纲 §6 契约表:恢复条目前缀区分 recovery-/restore-/subagent-terminal-/timer-/task-wake)。与 C7 阶梯 2 的 `recovery-<subagent_run_id>` 前缀相同但 run_id 域不同(主 run_id vs 子代理 run_id),`replace_or_enqueue` 按完整 group_id 去重,天然不冲突(steering_queue.rs 既有语义)。
- 注入文本**最小化为「继续任务」**(约束 C:kind/retries 等诊断细节一律不进对话、不给 AI 看到——02 W5 模板原含 kind 细节「上一轮 provider 中断(<kind>),继续任务」(02-恢复机制选型总方案.md:248),本维度按约束 C 收窄为固定常量 `MAIN_RESUME_INJECT_TEXT = "继续任务"`;kind 人读化映射(stream_error.rs:305-321 `kind_str`)随 `provider-diagnostic` 事件载荷走观测面)。
- 同 run 重复判定(拉起失败后条目滞留、下一收口再判定)经 group_id 原位替换,不重复堆积。

**预算消费**(`consume_main_episode`,壳层 helper,RecoveryBudget 零改动):

```
async fn consume_main_episode(state, session_id, fp) -> bool {
    let result = spawn_blocking(move || {
        let raw = db.get_session_meta(session_id, RECOVER_EPISODES_KEY);          // recovery.rs:86
        let limit = db.get_session_meta(session_id, RECOVER_MAX_EPISODES_KEY)
                        .and_then(parse u32).unwrap_or(3);                        // recovery.rs:84,默认 3
        let mut budget = RecoveryBudget::from_json(raw.as_deref(), limit);        // 宽容解析 fail-open
        if !budget.can_recover(fp) { return false; }                              // 超限
        budget.record_fork(fp).ok();                                              // 计数 +1(复用,命名沿用)
        db.set_session_meta(RECOVER_EPISODES_KEY, budget.to_json());              // 写回同键同形状
        true
    }).await;
    if !result {
        // 发射载荷(W6 定夺):subagentRunId 为 Option<String>,双发射方语义 ——
        //   D2 主 run 侧发射 = None(主 run 无子代理域);D3 子代理侧 = Some(<subagent_run_id>)
        //   (sessionId 由事件信封携带,载荷不列)
        append_event(session_id, RECOVER_BUDGET_DENIED_EVENT,                       // recovery.rs:111
            json!({ "subagentRunId": None, "fingerprint": fp, "count": 3, "max": limit }));
        conex_types::denied_stats::global_denied_stats().record_recovery_budget_denied();  // recovery.rs:972-973
    }
    result
}
```

- 读-改-写安全性:会话内串行守卫(同会话单活动 run,core_run_commands.rs:3208-3216)保证同一时刻仅一个 run 收口写该会话预算键;与 D3 coordinator 的 persist_budget 写同键时指纹域互斥(子代理指纹 = 两参;主 run 指纹 = 三参),无键冲突。00 总纲 §6 契约表「RecoveryCoordinator 单写方」精确化为:**同键同形状,写方 = D3 子代理路径 + D2 主 run 路径,指纹域互斥 + 会话串行保证无并发写**(01 敲定方案 §2.1 已明确「D2 主 run 预算写入同键」,属裁决在先)。
- **直写后内存态口径(W5 定夺)**:D2 直写 recover_episodes 后**不刷新 RecoveryCoordinator 内存态**;观测侧(D8)与重启恢复均以 session_meta 键直读/读盘为准,无陈旧窗口问题。
- F2-27:读写走 `spawn_blocking`(01 敲定方案 §3 接线时序 5 的既有约束,同表覆盖「goal_state/provider_fail_streak 读写」,recover_episodes 同批纳入)。
- 消费语义与 C7 阶梯 1 的区别:**主 run error 续 run 每次 error 收场消费一次预算**(每次都是一次自动恢复动作,由「连续 error ≤3」验收倒推,00 总纲 D2 最低线 A2);C7 阶梯 1「重派不消费 Episode」(recovery.rs:13-14、02 方案 Y)是子代理同任务重试的语义,两者分域。
- **续写预算域(E1 扩展,扩展定夺 E0 R4)**:续写 run 消费**独立指纹域** `fingerprint_with_source("main", 任务文本, "content-resume")`,上限 `content_resume_max` 默认 **2**(比 error-retry 的 3 更紧——续写是「质量增强」而非「任务救急」,且每次续写都是完整请求,E1 §3.4);两域同键互斥、会话串行守卫下读-改-写安全;断流续写**不得挪用 error-retry 域**,error-retry 域也不为续写救场(职责独立,E1 §3.5)。消费时序:每次续写 run 拉起前消费一次(判定时消费,拉起失败不重复消费,条目滞留由 watcher 兜底,对齐本维度 D2-3 决策)。

**跨 run 退避**:

- 公式:`delay = min(RECOVERY_BASE_DELAY_MS << (attempt - 1), RECOVERY_MAX_DELAY_MS)`(750→1500→3000,attempt = 本次消费后的预算计数;镜像 recovery.rs:116-118,测试锁定同期望值防漂移,selection-01 分歧 1 附带裁决)。
- 落点:decide_idle_resume error 分支内(预算消费后、入队前);时钟策略**锁死为实现侧可注入延迟函数**(C4 定夺):`state` 上放 `retry_delay: Box<dyn Fn(u32) -> Duration>` 或等价注入点,测试直接驱动(不依赖 tokio pause,删除二选一表述)。
- 与 D1 退避的关系:D1 是 run 内瞬态重试退避(stream_error.rs),D2 是跨 run 续 run 退避(壳层),两层独立、常量共享、同批落地(00 总纲 §4:退避未接时 error 续 run 会在跨 run 层面复现「快速连打」风暴,selection-02 §2.4)。

**拉起器 mode 参数化**(共享接口):

`spawn_idle_resume_run` 增 `mode: &str` 参数(:2651 硬编码 `"idle-resume"` 改为入参):

- error 续 run → `"recovery-retry"`(02 D9:与 idle-resume 区分,前端可观测自动恢复类型);
- Stop 三源 → `"idle-resume"`(现状不变);
- D5 goal 续轮 → `"goal-continue"`(03 评审 §1.3 术语表:两 mode 语义不同分别保留)。

D2 落地时 mode 参数为一次性改造(三个调用点:D2 新调用 + 既有 :2895 launcher 通道),D5/D6 复用同一入口,不二次接线。

### 3.5 与 D5 分支的共存规则(:2513 区域一次改完,00 总纲 §4 同批约束)

| 规则                         | 内容                                                                                                                                                                                                              | 依据                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| R1 分支互斥                  | `reason == Stop` → D5 goal_pending 评估;`reason == Error` → D2 error 分支;Stopped/Aborted 两者皆不进入                                                                                                            | 00 总纲 §6:140                                                                            |
| R2 error 轮不计 goal stalled | goal_state.stalled_rounds 只由 D5 RoundAssessment 在 Stop 收场轮累加;error 收场轮不触碰 stalled_rounds、不触发 goal_pending(「错误收场不续轮」由 D2 分支独占负责)                                                 | 00 总纲 D5 验收(「错误收场不触发 goal_pending;error 轮不计 stalled」)、03 评审护栏 8 语义 |
| R3 注入文本不互混            | goal 续轮注入 goal 前缀 + nextSteps(D5);error 续 run 注入最小化文本「继续任务」(D2,约束 C,不含诊断细节);若会话同时有 goal_state 与 error 收场 → error 分支优先(具体事件上下文优先于持续背景目标,03 M8 注入优先级) | 03-评审报告 M8                                                                            |
| R4 空转护栏分场景            | error 分支不计数(真实任务输入,敲定 #21);goal 续轮无 AI 产出计空转且按 stalled 独立计数(03 护栏 3)                                                                                                                 | 01 敲定方案裁决 #21                                                                       |

D2 侧实现仅保证「error 分支独立返回、不触碰 goal_state 键」;R2 的 stalled 计数落点与实现归 D5(goal_state 唯一写方 = RoundAssessment,00 总纲 §6),本文件作为接口约束记录。

### 3.6 改动文件面清单

| 文件                                                      | 改动                                                                                                                                                                                                                                                                                                                                  | 同批约束                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `apps/agent-workbench/src-tauri/src/core_run_commands.rs` | decide_idle_resume error 分支 + 签名、drive_run_loop :2710-2712 提取与传递、spawn_idle_resume_run mode 参数、`consume_main_episode`/`main_task_text`/`build_main_resume_entry` helper、退避 sleep                                                                                                                                     | 与 D5 分支同区一次改完(:2513 区域);core_run_commands.rs 派单按文件互斥 |
| `crates/orchestrator/src/recovery.rs`                     | 新增 `fingerprint_with_source(subagent_id, task, source)`(既有两参保持);可选:唤醒源常量集中定义(含 `WAKE_SOURCE_CONTENT_RESUME`)                                                                                                                                                                                                      | 零改动面(预算机制不动),D2 单点                                         |
| D1 提供                                                   | `RunOutcome.provider_error`(end.rs/stream_error.rs,01 敲定 §2.3)、熔断 `is_tripped`(provider_fail_streak)                                                                                                                                                                                                                             | D1+D2 同批(stream_error.rs 单批改完,00 总纲 §4)                        |
| E1 续写分支(扩展定夺 E0 R4)                               | Stop 分支续写子分支 + `consume_content_resume_episode`/`build_content_resume_entry` helper + 拉起器 mode="content-resume"(与 error 分支同 decide_idle_resume 区一次改完,并入本维度派单批次);**排期在 D7(流中断标注)之后接线**——续写触发信号 = metadata.providerErrorKind(D7 §3.7),信号未落地前无法分类判定;与 D1 熔断 S2 计数同数据源 | 与 D2 error 分支同批(同文件互斥派单);D7 先决依赖                       |

---

## 4. 数据面

| 项                            | 方向       | 形状                                                                                                                                                                                                                                                                               | 属主                            |
| ----------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `RunOutcome.provider_error`   | D1→D2      | `Option<ProviderErrorSummary { kind, retryable, retry_after_ms, retries }>`;fatal_provider_error 填充;drive_run_loop :2710-2712 移动消费前 clone 提取                                                                                                                              | D1(01 敲定 §2.3)                |
| `recover_episodes` 键         | D2/D3 共用 | JSON 对象(指纹→计数),形状冻结(recovery.rs:86);主 run 指纹 = `fingerprint_with_source("main", 任务文本, "error-retry")`;**续写 run 指纹 = `fingerprint_with_source("main", 任务文本, "content-resume")`(E1 独立域,上限 `content_resume_max` 默认 2,§3.4)**;与子代理指纹(两参)域互斥 | D2 主 run 路径 / D3 coordinator |
| `recover_max_episodes` 键     | D2 读取    | u32,默认 3(recovery.rs:84);error 续 run 次数上限同源可配(`recover_max_episodes=1` 可单会话全局收紧,02 §2-D)                                                                                                                                                                        | D3(既有)                        |
| 恢复条目 group_id             | D2 写入    | `recovery-<主run_id>`(`RECOVER_GROUP_PREFIX` 复用,recovery.rs:97);is_steering=true;同 run replace_or_enqueue 去重                                                                                                                                                                  | D2                              |
| 事件                          | D2 使用    | 预算耗尽复用 `recovery-budget-denied`(recovery.rs:111)+ denied 月度统计(recovery.rs:972-973);**D2 不新增事件**(01 敲定 §2.2 事件表冻结,recovery-* ×5 随 D3 集中登记)                                                                                                               | D3 登记、D2 消费                |
| 熔断键 `provider_fail_streak` | D1→D2 读   | JSON(字段取 05:count/first_fail_at_ms/last_fail_at_ms/window_ms,01 敲定 §2.1);is_tripped 判定 D1 提供                                                                                                                                                                              | D1                              |

**不新增**:无新 session_meta 键、无新事件、无新命令、无新字段(除 D1 的 RunOutcome.provider_error 外)。RunFailureContext 还原(00 总纲 §6 契约表第 2 行)属 D2 壳层→D3 的接口,本维度不消费(RunFailureContext 是子代理路径,D3 装配)。(E1 续写扩展新增 `content_resume_enabled`/`content_resume_max` 键与拉起器 mode="content-resume" 值,属 E1 扩展登记面,归 final/00 数据面与 E0 R1,本维度不新增键。) 续写 run 的注入模板与 E1 锁定模板绑定(「上一轮生成中断(<kind>),请从断点继续完成,不要重复已输出的内容」,E1 §3.2);history 经 SessionHistoryCache 天然含已产出前缀,不重复注入;**前缀不变性(约束 B)**:续写/重试保持对话前缀不变(已 commit 消息零改动)以提升 provider 前缀缓存命中,同一端点与缓存亲和头保持。

---

## 5. 测试策略

### 5.1 单测(core_run_commands.rs 测试域 + 新 helper 测试)

| #   | 用例                                   | 断言                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | 3 次重试耗尽自动拉起                   | 构造 `reason=Error + provider_error Some{kind: Network, retryable: true, retries: 3}` → `decide_idle_resume` 返回 Some,注入文本**精确等于锁定模板**「继续任务」(C8;断言不含 kind 细节——kind/retries 走 provider-diagnostic 事件 + 临时通知,不进对话);拉起器 mock 计数 +1                                                                                                                                                                                                                                                                                              |
| T2  | 上下文完整                             | T1 场景:SessionHistoryCache 已存 run 1 消息(:2718)→ 新 run 装配 history 回退缓存,断言新 run 首轮对话含 run 1 部分产出(02 W5 验收①)                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| T3  | 第 4 次 error 停止                     | 预算 3 次消费后第 4 次 error → None;recover_episodes count=3;recovery-budget-denied 事件留痕(00 总纲 D2 最低线 A2)                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| T4  | 用户停止/abort 不续                    | Stopped / Aborted / abort_signal / user_touched 四组 → None(即使 retryable 且预算内)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| T5  | 非 retryable 不续                      | retryable=false(Auth)→ None;provider_error=None(非 PROVIDER_ERROR error)→ None                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| T6  | 指纹隔离                               | 同任务:source=error-retry 与 source=user 指纹串不同;预算互不消耗;timer-<a> 与 timer-<b> 指纹不同                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| T7  | 熔断不续                               | is_tripped=true(fake 判定器)→ None                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| T8  | 不计空转 streak                        | 连续 2 次 error 续 run 后 `resume_empty_streak` 无该会话条目或值为 0;随后 Stop 收场三源空 → 空转从 0 计起                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| T9  | 退避序列                               | 注入 `retry_delay: Box<dyn Fn(u32)->Duration>` 记录调用序列:第 1/2/3 次续 run 前注入点收到 delay ≥750/1500/3000ms;第 4 次 error(预算耗尽)注入点不被调用;断言与注入方式绑定写死(C4)                                                                                                                                                                                                                                                                                                                                                                                    |
| T10 | 预算可配                               | `recover_max_episodes=1` → 第 2 次 error 即停                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| T11 | 熔断期预算不消费                       | is_tripped → None 且 recover_episodes 不变(动作未发生不消费,02 选型 E 语义)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| T12 | 拉起失败不重复消费                     | 拉起器返回错误(仅告警)→ 预算已计 1 次,条目滞留队列;下一收口判定同 run 条目原位替换不堆积                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| T13 | 部分保留断流 → 续写 run(扩展 A10)      | 构造 `reason=Stop + 最后消息 metadata{providerErrorKind: network, providerErrorRetryable: true}`(纯文本、文本非空)→ decide_idle_resume 返回 Some,注入文本**精确等于 E1 锁定模板**「上一轮生成中断(Network),请从断点继续完成,不要重复已输出的内容」;拉起器 mock 计数 +1、mode="content-resume";上下文完整(history 回退 SessionHistoryCache 含 run 1 部分文本,首轮对话前缀匹配;**前缀不变性**:run 1 已 commit 消息零改动、同一端点与缓存亲和头保持)+ **防重复前缀检测**(run 2 首条 assistant 文本前 30 字符与 run 1 部分文本尾 30 字符无重叠);非瞬态 kind(auth)→ 不续写 | §3.1 Stop 子分支 |
| T14 | 续写失败 → 降级 error 续 run(扩展 A11) | 续写 run 2 的 provider 每次调用均返回瞬态错误 → run 2 error 收场(provider_error=Some{retryable:true})→ 自动拉起 run 3(mode="recovery-retry",注入文本 = D2 锁定模板「继续任务」);`content_resume_max=2` → 连续 3 次断流:前 2 次续写,第 3 次不续写(无新 run、留 recovery-budget-denied 事件)                                                                                                                                                                                                                                                                            | §3.4 续写预算域  |

### 5.2 集成测试

- **端到端续 run**:mock server 每轮 3 次瞬态失败 → run 1 error 收场 → 自动拉起 run 2(断言新 run 存在、最小化注入文本「继续任务」在会话消息流可见、history 续接;kind/retries 细节断言走 `provider-diagnostic` 事件 + 临时通知面,不进对话)→ 连续 4 轮后停止(recover_episodes=3)。
- **重启持久化**:预算落库后模拟重启 → 第 4 次 error 仍不续(预算不重放授权,recovery.rs:327-335 from_json 语义上移,对齐 02 W3 验收③)。
- **与 D3 并行**:子代理失败(阶梯 1 重派)与主 run error 续 run 同时发生时,两者预算计数互不消耗(指纹域隔离),recover_episodes 键读写无丢失(串行守卫下读-改-写)。
- **与 D5 并存**:会话带 goal_state,error 收场 → 走 error 分支(不触发 goal_pending),stalled_rounds 不变。

### 5.3 回归面

- recovery.rs 既有 40+ 单测 + 4 个集成测试文件(tests/recovery_ladder.rs、multi_agent.rs、kill_all.rs、crash_consistency.rs)全绿——两参 fingerprint 行为不变、RecoveryBudget 零改动;
- stream_error.rs / end.rs 既有测试(D1 同批改动后)全绿;
- markdown-editor 门禁(`npm test`)与 tests/e2e 5 个 markdown-editor 专项 spec 不受影响(本维度不触碰 reference/markdown-editor);
- 禁止 `--no-verify` 绕门禁(01 敲定 §4 红线 4)。

---

## 6. 风险与护栏

| 风险                               | 护栏                                                                                                                                                                                                                          | 依据                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 自动续 run 风暴                    | 四层叠加:① 预算 ≤3(指纹级,重启不重放);② 跨 run 退避 750/1500/3000(钳 8s);③ 熔断(会话级连续 6 次,is_tripped 闸本分支);④ 空转护栏(Stop 路径,error 分支独立)                                                                     | 00 总纲 §5 护栏 3/4/7;02 §4.1 五层                   |
| 续写风暴(反复断流反复续写,扩展 E1) | 续写次数上限默认 2(content-resume 域独立计数)+ 熔断闸 + 跨 run 退避 + 预算;续写失败自然降级 error 通道(续写 run 自身 Error 收场即入本维度 error 分支);非瞬态不续写;用户停止/abort/user_touched 永不自动续(硬条件在分支前检查) | E1 §3.4/§3.5;E0 §三                                  |
| 「快速连打」跨 run 复现            | 与 D1 同批落地:run 内退避(stream_error.rs)先吸收瞬时波动,error 收场到达本分支时已过 run 内 3 次重试 + 退避                                                                                                                    | 00 总纲 §4 同批约束;selection-02 §2.4                |
| token 成本                         | 失败尝试不记账(护栏 10);error 续 run 是完整新请求(engine.rs:443-456 全量重发),总消耗由预算(≤3)+ 退避 + 熔断封顶;预算耗尽即停,无无限烧费                                                                                       | 00 总纲 §5 护栏 10                                   |
| 重复副作用                         | ① error 收场轮已产出内容由三层 produced_content 镜像保护(不重试已产出);② 续 run = 基于完整对话的新请求,已执行工具不重跑(turn 顺序保证);③ recovery-retry mode run 装配时建议开启 ToolIdempotencyGuard(00 总纲 §5 护栏 9)       | 02 §4.2                                              |
| 队列挤占                           | 恢复条目 is_steering=true(容量挤占受保护,steering_queue.rs:78-83);group_id 去重防堆积;恢复条目合并注入上限 ≤16 条由 D6 合并 helper 统一执行(本维度单条透明)                                                                   | 00 总纲 §5 护栏 8;03 评审动态决策 5                  |
| 拉起失败                           | 仅告警不立即重试(与既有 idle 拉起失败语义一致,:2663-2670);条目滞留队列 → watcher(D6)或下轮收口拉起;预算已消费不重复消费                                                                                                       | core_run_commands.rs:2663-2670;00 总纲 §5 护栏 8     |
| 与用户竞争                         | user_touched/abort 硬条件在 error 分支前检查;退避期间 abort 复查(醒来不续);Stopped/Aborted 永不续                                                                                                                             | 01 敲定 §4 红线 2;04 §3-1 abort 竞速                 |
| 预算双写                           | 指纹域互斥(主 run 三参 vs 子代理两参)+ 会话串行守卫(单 run)保证读-改-写无并发;fail-open 宽容解析防坏键崩溃                                                                                                                    | recovery.rs:327-335;core_run_commands.rs:3208-3216   |
| 熔断盲区                           | 熔断计数语义(部分保留断流计入、成功清零时机)由 D1 按 03 评审 S2 补丁实现——本分支消费 is_tripped 结果即可,不自行计数                                                                                                           | 03 评审严重问题 3(S2)                                |
| 性能                               | 预算读-改-写与熔断判定走 spawn_blocking(F2-27);decide_idle_resume 内退避 sleep 不持有锁(锁不跨 await,AA-02 并发模型)                                                                                                          | 01 敲定 §3-5;core_run_commands.rs:2523-2526 既有模式 |

---

## 7. 与其他维度的接口(00 总纲 §6 契约表)

| 维度 | 接口                        | 方向       | 契约                                                                                                                                                                    |
| ---- | --------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | `RunOutcome.provider_error` | D1→D2      | kind/retryable/retry_after_ms/retries(01 敲定 §2.3);drive_run_loop :2710-2712 移动消费前提取(:2710-2712 同批)                                                           |
| D1   | 熔断状态                    | D1→D2      | `is_tripped(session_id)` 判定(provider_fail_streak 键,01 敲定 §2.1);D2 error 分支 3b 消费;同批落地,测试可注入 fake                                                      |
| D1   | 退避常量                    | D1↔D2      | 镜像 recovery.rs:116-119(750/8000),测试锁定同期望值防漂移                                                                                                               |
| D3   | recover_episodes 同键       | D2/D3 共用 | 形状冻结(recovery.rs:86);主 run 指纹三参 + 唤醒源,子代理指纹两参,域互斥;预算 denied 事件与月度统计复用;「单写方」契约精确化见 §3.4                                      |
| D5   | decide_idle_resume 同区     | D2/D5 并行 | :2513 区域一次改完(error 分支 + goal_pending 分支并存);R1-R4 共存规则(§3.5);error 轮不计 stalled 由 D5 RoundAssessment 保证                                             |
| D6   | 队列/拉起器                 | D2→D6      | 恢复条目入队共享 PendingMessageQueue;拉起失败滞留条目由 watcher 消费;mode 参数化供 watcher/restore 复用;合并注入上限 ≤16 条由 D6 执行                                   |
| D8   | 观测                        | D2→D8      | 无新事件;recovery-budget-denied/runtime-error 既有事件可观测;core_get_status 恢复域扩展(D8)可含主 run 自动续跑计数(mode=recovery-retry 可检索)                          |
| D7   | 流中断标注(续写触发信号)    | D7→D2(E1)  | metadata.providerErrorKind ∈ 瞬态四类 + providerErrorRetryable != false = 续写子分支触发信号,与 D1 熔断 S2 计数**同数据源**;E1 排期在 D7 之后(信号未落地前无法分类判定) |

**契约冲突**:无。**唯一实现时注意**:decide_idle_resume 的 reason 分派必须显式写清 Error→retryable 分支与 Stopped/Aborted 永不续的边界(00 总纲 §6:140 原样落地),防止把 Aborted 误放行。

---

## 8. 动态决策记录(输入文档未覆盖处的自决)

| #     | 问题                                                                       | 决策                                                                                                                                                                                                                             | 理由                                                                                                                              | 影响面                           |
| ----- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| D2-1  | 裁决 #8 要求三参指纹,而 recovery.rs「零改动」                              | recovery.rs 新增 `fingerprint_with_source(subagent_id, task, source)`,既有两参 `fingerprint` 保持(40+ 测试不动);「零改动」= RecoveryBudget 机制与键形状零改动,指纹属调用面构造                                                   | 敲定 #8 是更新裁决(唤醒源混淆修正,selection-03 评审护栏 5),00 总纲「零改动」表述取其预算本体语义;改签名会破坏既有测试面           | recovery.rs 单点新增函数         |
| D2-2  | 任务文本取「首条 user 消息」在 error 续 run 下会漂移(首条 user 变注入模板) | 取会话历史首条**非 steering 元数据** user 消息(SessionHistoryCache);回退链:当前 run messages 首条非 steering user 消息 → 空串                                                                                                    | selection-03 评审护栏 5 的同类混淆;derive_task(lifecycle.rs:353-361)语义的会话级等价物                                            | 指纹稳定性;main_task_text helper |
| D2-3  | 预算消费时机                                                               | 判定时消费(拉起前),拉起失败不重复消费;预算在退避前消费                                                                                                                                                                           | 预算 = 恢复动作计数,判定通过即动作成立;拉起失败是传输问题,条目滞留由 watcher 兜底,重复消费会把「连续 error ≤3」误算成「拉起失败」 | consume_main_episode 顺序;T12    |
| D2-4  | 跨 run 退避落点                                                            | decide_idle_resume error 分支内(经 state 注入点调用延迟函数 + abort 复查),常量镜像 recovery.rs:116-118,时钟策略**锁死为可注入延迟函数**(`retry_delay: Box<dyn Fn(u32)->Duration>`,测试直接驱动,C4)                               | 与 D1 退避(stream_error.rs)分域不冲突;放判定内语义完整(退避期用户 abort 不续);放拉起器内则判定与等待脱节                          | 判定顺序 3f;T9                   |
| D2-5  | 恢复条目 group_id                                                          | 复用 `recovery-<run_id>`(RECOVER_GROUP_PREFIX),与 C7 阶梯 2 同前缀不同 id 域                                                                                                                                                     | 00 总纲 §6 前缀表 recovery- 即恢复域;replace_or_enqueue 按完整 group_id 去重,无冲突;不新造前缀                                    | 条目形状                         |
| D2-6  | 拉起器 mode                                                                | `spawn_idle_resume_run` 增 mode 参数:error 续 run="recovery-retry"、Stop 三源="idle-resume"、goal 续轮="goal-continue"                                                                                                           | 02 D9(自动恢复类型可观测);D5/D6 共享入口一次改造,不二次接线                                                                       | 共享接口;D5/D6 复用              |
| D2-7  | 事件面                                                                     | D2 不新增事件,预算耗尽复用 `recovery-budget-denied` + denied 月度统计                                                                                                                                                            | 01 敲定 §2.2 事件表已冻结(41→47/49 不增项);主 run 恢复观测经既有事件 + D8 的 mode 检索                                            | 无新登记                         |
| D2-8  | error 分支与三源/空转护栏的关系                                            | error 分支在 reason match 内独立返回,不经过三源判定与空转计数                                                                                                                                                                    | 敲定 #21(error 续 run 属真实任务输入,不计 streak);结构上保证两路径互不误伤(02 W5 验收⑤)                                           | 判定顺序;T8                      |
| D2-9  | 熔断判定注入形态                                                           | CoreRunState 增 `circuit_breaker_is_tripped` 访问(直调 D1 模块或注入闭包),测试可注入 fake                                                                                                                                        | D1+D2 同批,模块面以 D1 落地为准;隔离 D2 测试                                                                                      | 判定 3b;T7                       |
| D2-10 | MaxTurns 是否顺带放开                                                      | 否,保持保守不续(:2493-2494 注释语义)                                                                                                                                                                                             | 00 总纲 D2「不做什么」明确;max-turns 续轮是 01 领域 P1-3 独立项,不在本维度                                                        | 无                               |
| D2-11 | 续写分支的排期与数据源(E1 扩展)                                            | Stop 分支续写子分支**排期在 D7(流中断标注)之后**接线;触发判定(最后消息 metadata.providerErrorKind 瞬态四类)与 D1 熔断 S2 计数**同一数据源、同一判定逻辑**(复用 D1 §3.2.2 落点 2 的收口判定);预算独立指纹域 content-resume 上限 2 | 信号未落地前只有裸文案(consume/mod.rs:340-342)无法分类判定;判定共用防语义分裂;续写是质量增强,预算比 error-retry 更紧              | §3.1 续写子分支、§3.4            |

---

## 附:关键证据索引

| 事实                                             | 位置                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| decide_idle_resume 硬条件/三源/空转/拉起器全貌   | core_run_commands.rs:2505-2593、2637-2671                          |
| drive_run_loop 收口链与 Copy 字段提前捕获        | core_run_commands.rs:2688-2913(:2701-2712、:2844-2852、:2872-2912) |
| 会话内串行守卫                                   | core_run_commands.rs:3208-3216                                     |
| SessionHistoryCache 读/写                        | core_run_commands.rs:706-713、724-738、2718                        |
| RunOutcome 无 provider_error 字段                | end.rs:99-125                                                      |
| fatal_provider_error 填充点(文案/事件 retryable) | stream_error.rs:237-269                                            |
| fingerprint / RecoveryBudget / 键 / 事件 / 常量  | recovery.rs:84-119、251-262、276-336、972-973                      |
| 阶梯 2 条目先例(分组/文案/形状)                  | recovery.rs:360-387;steering_queue.rs:29-30、78-83                 |
| 熔断键形状(01 敲定)                              | 01-敲定方案.md:49                                                  |
| 唤醒源指纹裁决与空转语义                         | 01-敲定方案.md:22(#8)、35(#21)                                     |

> 本文档为只读分析产出(唯一写面);未修改任何代码,无 git 操作。
