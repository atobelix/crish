# E3 — 主 agent 消息能力与上限 16 设计(extensions 增强项)

> 目录:docs/continuity-repair/extensions/
> 日期:2026-08-11
> 定位:本文件为「任务连续性能力集」的 **extensions 设计文档**,面向用户三项补充需求:① 主 agent 也可以发送消息(主 agent 主动消息注入能力);② 子 agent 可以向主 agent 汇报(汇报机制强化,不只终态通知);③ 子 agent 上限改为 16(现 12,含同父上限 5 的同步论证)。产出为三项能力的完整设计,后续由主控评审后融入正式方案(final/ 与 dimensions/)。
> 输入:final/00-正式实现规范.md(§3.1 自动继续通道、§3.5 子代理三决策路径、§5 红线 12/5/1)、02-定夺与修订指令.md(W3/W7 等)、dimensions/D3-C7恢复阶梯生产接线.md、D4-子代理恢复与关闭命令面.md、02-子Agent分配上限与调度模型.md、01-主agent会话循环与连续工作能力.md、05-Goal模式与主动结束后继续能力.md。
> 代码基线:仓库当前 HEAD;行号以核对当日代码为准,如漂移以实际代码为真源。
> 引用统一为 `文件路径:行号`。
> 冲突标注:与 00/02/D3/D4 冲突的内容显式标注「与正式规范冲突」并给理由,最终裁决权在主控。

---

## 0. 结论速览

1. **主 agent 主动消息注入**(需求 ①):现成的三个机制已覆盖大部分——运行中向子代理注入(`request_subagent_inject` L1 steer 环,control.rs:275-286,生产已接线 wait_channel.rs:457-473)、跨 run 向自己队列排消息(PendingMessageQueue + decide_idle_resume 消费)、run 内用户侧 L1 注入(core_run_commands.rs:3760-3793)。**缺口 = 主 agent 的工具面**——主 agent 在 run 内没有「发送消息」工具,注入能力只挂在 wait_subagents 的 inject 参数与用户 UI 上。设计:新增 `send_message` 工具(仅主 agent 工具集),目标三选:运行中子代理 / 自己会话(新 run 前)/ 自己会话(run 内),来源标记 `metadata.source="main-agent"` 与用户消息区分,权限护栏与 run_subagent/kill_subagent 同面。
2. **子 agent 汇报机制**(需求 ②):**subagent-event 事件通道已存在且前端已消费**(SubagentEventInfo kind=progress/message/tool,subagent_events.rs:71-82;前端 subagentHandlers.ts:45-59、131-144),但**生产零发射**——全仓 `SubagentEventEmitter::emit_event` 仅测试调用(subagent_events.rs:374-421;生产仅 emit_started :474 / emit_ended :589)。设计:**最小可行形态 = 汇报接线**——子代理 run 每轮收口后把新增消息经 emit_event 发射(progress=Delta 不落库、message/tool=Soft 尽力落库,背压分级现成),主 agent 经前端时间线 / wait 实时通道 / 工具查询可见;运行中汇报不写 steering 队列(不打断主 agent 编排),失败信息完整性走终态面(D1 provider_error + D3 阶梯 2 摘要)。
3. **上限 16**(需求 ③):`max_concurrent 12→16`、`max_siblings 5→16`(**必须同步**——所有子代理同父=主 agent,max_siblings=5 时「同时跑 16 个」在第 6 个就被拒;批量前瞻 spawn_many 预加也命中同父),`max_depth=1` 不变(嵌套禁令)。改动面 = subagent.rs:497-501 常量 + shared-types/subagent.ts:57-65 镜像 + 既有 12 上限测试 7 处数字修正 + 文档引用(AGENTS.md:23/48、D8 口径、00:18/158、D3/D4 断言)。flow_graph 预算自动跟随(flow_graph.rs:1004-1006 注释)。注意 00:84「合并注入 ≤16 条」是恢复条目数,与子代理上限 16 数字重合但语义不同,需加注防混淆。
4. **闭环**:失败上报(kind/retries/产出)→ 阶梯 1 自动重派 → 阶梯 2 主 agent 激活 → 主 agent 三决策路径(接管 / resume_subagent / kill_subagent+重派)→ 重派新 run 走 16/16/1 守卫。汇报机制补的是「运行中」的中间态可见性,三决策路径补的是「失败后」的行动面,两者拼接成完整闭环。
5. **数据面**:无新增事件(汇报复用 subagent-event)、无新增命令(工具面为主)、无新增 DB 键(来源标记走 metadata);对 D3/D4/D8/final 的修改集中在「上限数字」与「汇报接线」两处。

---

## 1. 主 agent 主动消息注入(需求 ①)

### 1.1 现状盘点:三条现成通道与一个缺口

| 通道 | 机制 | 现状 | 证据 |
|---|---|---|---|
| A. 主 agent 向运行中子代理注入 | `ControlBus::request_subagent_inject` → L1 steer 环(下一安全点,不打断流),reason 携带 `subagent_inject:<id>` | **已接线**,但入口只有两处:① wait_subagents 工具 inject 参数(wait_subagents.rs:600-607 schema、674-723 调用,SubagentWaitChannel::inject :552);② 生产 WaitChannel::inject(wait_channel.rs:457-473,经 ControlBusResolver 定位目标 run 总线 :99) | control.rs:275-286、95-108;wait_channel.rs:452-473 |
| B. 跨 run 向自己会话注入(新 run 前) | PendingMessageQueue 入队(steering 条目)→ 主 agent 下一 run 收口 decide_idle_resume 队列源消费 → drain_pending_to_inject_messages 批量转 user 消息(带 `{kind:"steering"}` 元数据) | **已接线**(唤醒源三源之一:子代理终态/定时器/Cron/watchdog 条目都走这条);但**主 agent 主动给自己排消息无工具入口**——只有系统事件写入队列 | steering_queue.rs:111-114、86-106;core_run_commands.rs:2505-2593、2603-2626 |
| C. run 内注入(自己或他人 run) | run-control 命令 `soft_inject`(L1,steer/followUp 分环,source="ui"),用户/UI 侧 | **已接线**(run_control 命令面,core_run_commands.rs:3760-3793:3784-3792 分环、3783 标记 user_touched);主 agent run 内自己给自己注入 = 工具调用结果文本,无需额外通道 | core_run_commands.rs:3760-3793;engine.rs:2337-2339、2415-2416、2494-2495(with_control_bus 装配) |

**缺口 G-M1**:主 agent 在 run 内(工具调用时)没有「发送消息」工具——注入能力被绑定在 wait_subagents 的 inject 参数(wait 上下文内才可用)与用户 UI 上。主 agent 想在**任意时刻**给运行中的子代理调整方向、或给自己的下一轮排一条消息,没有工具入口。这与 run_subagent / wait_subagents / kill_subagent(D4 新增)的工具面不对称。

### 1.2 能力面设计:send_message 工具(仅主 agent)

**工具名**:`send_message`(snake_case,与 run_subagent/wait_subagents/kill_subagent 同风格)。

**input_schema**(对齐工具面惯例,additionalProperties=false):

```json
{
  "type": "object",
  "properties": {
    "target": { "type": "string", "enum": ["subagent", "self"],
      "description": "消息目标:subagent = 运行中的子代理(经 L1 steer 环注入,不打断执行);self = 主 agent 自己(写入会话消息记录;run 结束前入 followUp 环,下一轮消费)" },
    "subagentId": { "type": "string",
      "description": "target=subagent 时必填:目标子代理 id(run_subagent 返回的 subagentId)" },
    "message": { "type": "string", "description": "消息文本(必填)" },
    "urgency": { "type": "string", "enum": ["steer", "follow_up"], "default": "follow_up",
      "description": "target=self 时有效:steer = 下一安全点注入(当前 run 继续);follow_up = 仅 run idle 注入(不打断当前 run)。target=subagent 时恒为 steer(与既有 request_subagent_inject 语义一致)" }
  },
  "required": ["target", "message"],
  "additionalProperties": false
}
```

**执行语义**(逐 target):

| target | 落地机制 | 语义 | 复用资产 |
|---|---|---|---|
| subagent | `ControlBusResolver::control_bus(subagentId)` 定位 → `request_subagent_inject(subagentId, message, Some("send_message_tool"))` | 与 wait 期间 inject 同通道同语义(L1 steer,reason `subagent_inject:<id>`);不打断子代理流;目标 run 不可达 → 结构化 InjectFailed(对齐 wait_channel.rs:457-462) | control.rs:275-286;wait_channel.rs:99、457-473 |
| self | ① 写入会话消息记录(user 角色文本消息,metadata `{source:"main-agent"}`);② 若当前 run 仍存活,经主 run 自己的 ControlBus `request_follow_up` 入 followUp 环(仅 idle promote 消费,不打断当前 run;core_run_commands.rs:650-654 逃逸监视注入先例);③ 若当前 run 已收口(工具调用在收口后被模型重放等边角),则经 PendingMessageQueue 入队 steering 条目(group_id=`main-agent-msg`,下一 run 收口 decide_idle_resume 消费) | 「主 agent 给自己留话」:新 run 前排队的语义 = PendingMessageQueue 队列条目;run 内语义 = followUp 环;消息留档 = 会话消息记录 | steering_queue.rs:147-156(replace_or_enqueue);core_run_commands.rs:2505-2593;input.rs:142-144(enqueue_follow_up) |

**执行器实现形态**(对齐 RunSubagentTool 模式 subagent.rs:841-963):

```rust
// crates/agent-tools/src/tools/send_message.rs(新)
pub struct SendMessageTool {
    def: ToolDefinition,
    /// 子代理注入通道(与 wait_subagents 共用 ControlBusResolver 契约面;
    /// None = 未接线 → common.unsupported)
    subagent_inject: Option<Arc<dyn SubagentInjectChannel>>,
    /// 主 agent 会话消息留档 + 入队通道(壳层实现;None = 未接线)
    self_message: Option<Arc<dyn MainAgentMessageChannel>>,
}
```

- 两个通道都未接线 → `common.unsupported`(与 run_subagent 未接线先例 subagent.rs:999-1004 一致);
- `subagentId` 缺失且 target=subagent → `invalid_input`;
- 工具结果信封:`{ target, delivered: true, ring: "steer"|"follow_up", messageId }`(对齐 wait_subagents 结果信封风格 wait_subagents.rs:745-766)。

**注册与剔除面**(复用 D4 kill_subagent 的同一套机制):

- `BuiltinToolConfig` 增两字段(子代理注入通道 / 主 agent 消息通道),`register_builtin_tools_with_config` 注册(mod.rs:70-96、119-184);
- **子代理剔除面**:引擎侧 filter 闭包(core_run_commands.rs:3236-3238)同时剔除 `run_subagent` / `kill_subagent`(D4)/ `send_message`——`send_message` 只属于主 agent 工具集,子代理无任何消息注入/留档能力(防「子代理伪装主 agent 发消息」);`filter_out_subagent_spawner` 本体扩展或另建 filter(D4 §8 D-4 决策同款:剔除决策权威位在引擎装配点);
- 装配时序:CoreRunState 实现两通道 trait,Arc 构造完成后经 finalize 注入(`finalize_subagent_kill` 先例 D4 §3.3,registry.rs:49-72 register_runtime 后置注册)。

### 1.3 来源标记:与用户消息的区别

| 面 | 用户消息 | 主 agent 发送(send_message) | 系统注入(steering/唤醒) |
|---|---|---|---|
| 角色 | user | user | user(经 into_user_message 转出,steering_queue.rs:89-106) |
| metadata | 无(kind 不存在) | `{source: "main-agent"}` | `{kind: "steering"}`(steering_queue.rs:90-94) |
| client_message_id | 前端生成 | None | None |
| user_touched 标记 | 有(L1 注入标记,core_run_commands.rs:3783) | **不标记**(主 agent 自己发消息不算「用户交互」,收口不因此抑制 idle 续 run) | 不标记 |
| 入口 | run_control soft_inject(ui source) | send_message 工具 | decide_idle_resume 队列消费 |

要点:① `source:"main-agent"` 与 `kind:"steering"` 可共存(主 agent 排队的消息同时带两标记,取并集);② **user_touched 语义是护栏关键**——用户消息到达会抑制 idle 续 run(core_run_commands.rs:2517-2519),主 agent 自发的消息若误标 user_touched 会导致「续 run 被自己抑制」,故 send_message 路径恒不触碰该标记;③ 前端消费面零改动(消息本就渲染 user 角色,时间线展示可由 source 标记增强样式,非本轮必须)。

### 1.4 权限与护栏

| # | 护栏 | 机制 | 证据 |
|---|---|---|---|
| 1 | 仅主 agent 可发送 | 工具注册表剔除面(同 run_subagent/kill_subagent);子代理调用 → tool.not_found | core_run_commands.rs:3236-3238;subagent.rs:653-659 |
| 2 | 注入不打断子代理执行 | 恒 L1 steer 环(无 L2/L3 意图);drain 优先级 force_cancel > cooperative_stop > soft_inject 不变 | control.rs:381-439 |
| 3 | 目标不可达结构化失败 | ControlBusResolver 返回 None → InjectFailed(不静默、不 panic) | wait_channel.rs:457-462 |
| 4 | 无自派发能力 | send_message 只注入文本,不携带任何 spawn/执行能力;子代理侧无此工具 | §1.2 剔除面 |
| 5 | 消息风暴防护 | followUp/steer 环为环形缓冲固定容量 1000(input.rs:18-19),超容量覆盖最旧;跨 run 队列容量 100 带 steering 挤占保护(steering_queue.rs:29-30、134-139) | input.rs:19;steering_queue.rs:29-30 |
| 6 | 不误标用户交互 | 不触碰 user_touched(§1.3) | core_run_commands.rs:3783 |

---

## 2. 子 agent 汇报机制(需求 ②)

### 2.1 现状盘点:事件通道现成、生产零发射

| 面 | 现状 | 证据 |
|---|---|---|
| 事件类型 | `subagent-event` 三事件之一,载荷 SubagentEventInfo { subagent_id, subagent_run_id, kind: progress/message/tool, payload } | subagent_events.rs:71-82;build_subagent_event :139-150 |
| 背压分级 | progress=Delta(不落库不阻塞 drive loop)、message/tool=Soft(尽力落库)——按 kind 分级现成 | subagent_events.rs:15-19 |
| 发射器 | `SubagentEventEmitter::emit_event`(唯一发射方,经 EventQueue 推送,会话内原子取号) | subagent_events.rs:164-203 |
| 前端消费 | onSubagentEvent / onSubagentEventGlobal → applySubagentEventToAgent(agent 时间线);per-run 面 + 全局兜底面双消费 | subagentHandlers.ts:45-59、131-144 |
| **生产发射** | **零**——全仓 `SubagentEventEmitter::emit_event` 仅测试域调用(subagent_events.rs:374-421);生产仅 emit_started(subagent_spawner.rs:474)与 emit_ended(:589) | grep 全仓仅测试命中 |
| 终态通知链 | 五步收口:记账释放 → 行终态 → subagent-ended(必达落库)→ wait 通道 feed → steering 通知(`subagent-terminal-<run_id>`) | subagent_spawner.rs:486-660(506-526、528-569、574-612、614-622、626-651) |
| 主 agent 可见面 | 终态:steering 条目 + subagent-ended 事件;运行中:**不可见**(子代理 run 的对话消息只在引擎内存缓存,无事件流) | core_run_commands.rs:2718(session_history.store) |

**缺口 G-R1**:子代理 run 运行中的进展(已完成的步骤、中间产出、需要主 agent 的决策点)对主 agent 完全不可见——主 agent 只能等终态(wait_subagents await-all / steering 唤醒 / watchdog 10 分钟兜底 watchdog.rs:1-16)。长任务(大调研、多文件实现)运行数分钟到数小时,主 agent 与用户全程盲等,「汇报」只存在终态通知这一条窄通道。

### 2.2 最小可行形态:汇报 = 子代理 run 增量消息 → subagent-event 事件

**核心思路**:汇报内容**不由模型自觉产生,而是引擎把子代理 run 已产出的消息增量转为事件**——与终态五步收口(subagent_spawner.rs:486-660)同源,只是提前到运行中。

| # | 汇报点 | 机制 | 背压 |
|---|---|---|---|
| 1 | 子代理 run 每轮收口后(turn 级) | drive_run_loop 子代理分支收口处(与主 run 收口链 core_run_commands.rs:2688-2913 同区):取本轮新增消息(assistant 文本摘要截断、工具调用摘要),经 `SubagentEventEmitter::emit_event(kind=progress)` 发射 | Delta(不落库,失败不阻塞) |
| 2 | 工具调用完成时(可选增强,不排期) | kind=tool 载荷携带工具名+摘要 | Soft |
| 3 | 子代理 run 收口(既有) | subagent-ended(终态,必达) | Critical |

**发射点归属**:事件归属父会话(SubagentEmitContext.session_id = parent_session_id,subagent_events.rs:41-48),前端全局消费者按信封 sessionId 路由(subagentHandlers.ts:81-83)。发射器复用 LocalDbStore 构造(与 subagent_spawner.rs:589 同款)。F2-27 纪律:emit 内部 EventQueue 同步 SQLite 面走 spawn_blocking(subagent_events.rs:196-203 现有实现形态,装配时确认)。

**汇报文本构造**:progress 载荷 = 该轮 assistant 文本块截断(如 500 字符,对齐 checkpoint 摘要截断语义 00 §3.6)+ 工具调用摘要(工具名/入参首行);结构化 `{ kind:"progress", payload: { round, summary, tools: [...] } }` 或透传原始文本块——**实施时取最小形态:直接透传本轮文本块**(前端 applySubagentEventToAgent 按 event 结构投影,subagentHandlers.ts:139-143,载荷形状以现有投影面兼容为准)。

### 2.3 汇报的消费面:主 agent 可见的三条路径

| 路径 | 机制 | 时机 |
|---|---|---|
| ① 前端时间线 | subagent-event 经 per-run / 全局路由投影到 agent 时间线(subagentHandlers.ts:45-59、131-144),用户与主 agent 观测 | 实时 |
| ② wait 实时返回 | wait_subagents 事件驱动等待消费 subagent-ended 流(wait_subagents.rs:378-459);progress 汇报经 EventStreamBroadcast 广播但 wait 名单外忽略——**不改变 wait 返回时机**(见 §2.5) | 事件到达 |
| ③ 工具查询(可选增强) | `subagent_status` / 汇报查询工具读取 events 表 progress 条目 | 主 agent 主动 |

**运行中汇报不写 steering 队列**(关键决策):steering 条目是「唤醒主 agent 开新一轮 run」的通道(decide_idle_resume 消费,core_run_commands.rs:2520-2528),运行中汇报若写队列,16 个子代理 × 每轮一条 = 唤醒风暴,且主 agent 可能正阻塞在长工具调用中无人收口(02-子Agent分配上限与调度模型.md:147 缺口 6 同款)。**汇报 = 观测面;唤醒 = 终态面**,两者职责分离。

### 2.4 失败上报信息完整性:与 D1 provider_error 的关系

「上报给主 agent,主 agent 继续分配」闭环中,失败汇报的信息完整性已由 D1/D2/D3 数据面覆盖,**本扩展不新造字段**:

| 信息 | 数据面 | 承载位置 | 证据 |
|---|---|---|---|
| 错误 kind | RunOutcome.provider_error.kind(D1 新增字段) | 终态通知文本(D2 注入模板「上一轮 provider 中断(<kind>),继续任务」)+ D3 阶梯 2 steering 摘要 | 00-正式实现规范.md:147;D2 §3.4 |
| 重试次数 | run 内 transient_retries + 跨 run 阶梯 1 计数(D3 §3.5 壳层 HashMap) | RunFailureContext.retries(阶梯 1 决策输入)+ 通知文本 | D3 §3.2.4、§3.5 |
| 已产出内容 | produced_content = outcome 存在 assistant 消息(D3 §3.2.1) | RunFailureContext.produced_content → ContentProduced 直上阶梯 2(防重复副作用) | D3 §3.2.1;recovery.rs:212-217 |
| 终态可见 | subagent-ended(必达)+ steering 双条目(recovery-<run_id> + subagent-terminal-<run_id> 共存,02 D2 裁定) | 主 agent 一次收到「失败通知 + 恢复激活指令」 | D3 §4.3;core_run_commands.rs:2603-2626 |

**运行中汇报不含失败信息**(运行中无失败);失败信息只在终态面(阶梯 1 重派成功时原 run 终态 failed reason=recovery-retry,D3 §3.2.3;阶梯 2 时通知主 agent)。**汇报与恢复的关系 = 时间轴互补**:运行中 progress 汇报(观测)→ 失败终态(信息完整)→ 主 agent 三决策(行动)。§2.2 的汇报接线补「观测」段,D3/D4 补「终态+行动」段。

### 2.5 wait 语义与汇报的关系

| 场景 | 汇报行为 | wait 行为 | 依据 |
|---|---|---|---|
| 主 agent await-all 等待中,子代理发 progress | progress 事件广播;前端时间线更新 | **不提前返回**(wait_for_terminal 只认 subagent-ended,名单外忽略、重复幂等) | wait_subagents.rs:378-459 |
| 主 agent timer/parallel-work 模式 | 同上 | 返回快照不含 progress(快照 = 状态行 + 产出清单) | wait_subagents.rs:46-58、727-744 |
| 子代理 run 收口 | subagent-ended(Critical)+ 终态五步;wait 通道 feed 立即唤醒 | 立即返回(事件驱动) | subagent_spawner.rs:614-622 |
| 汇报与 dispatch 声明 | 无交互(dispatch_* 键只管 wait 声明持久化,D4 §3.8) | 无交互 | D4 §3.8 |
| watchdog 兜底 | 与汇报无关(10 分钟无任何事件才触发) | watchdog.rs:1-16 | watchdog.rs:39-44 |

**结论:汇报是纯观测增量,wait 语义零改变**——await-all 的「等终态」语义、timer 的超时语义、watchdog 的失联兜底全部保持现状;汇报只在「主 agent 想提前看进展」时提供可见性(前端时间线 / 后续工具查询)。

---

## 3. 上限 16(需求 ③)

### 3.1 改动裁决:16/16/1

| 项 | 现值 | 目标值 | 裁决理由 |
|---|---|---|---|
| max_concurrent | 12 | **16** | 用户明确「同时跑 16 个子 agent」;12 是 T-D-06 对齐的旧值(subagent.rs:495-496 注释),「加几个上限也不难」= 常量修改 + 镜像 + 测试修正,无架构改动 |
| max_siblings | 5 | **16** | **必须同步,否则 16 并发不可达**:所有子代理都是主 agent(深度 0)的直接子代理,同父 = 主 run;max_siblings=5 时第 6 个同父子代理即被拒(判定序兄弟先于并发,subagent.rs:605-616)。「同时跑 16 个」在第 6 个就断了。批量前瞻 spawn_many 预加同样命中(siblings 预加 +16,subagent_spawner.rs:808-815)。原注释「兄弟并发应小于全局并发」(subagent.rs:494)在 16=16 下不违反(相等即非小于关系被打破,改注释口径为「同父上限 = 全局上限」) |
| max_depth | 1 | **1(不变)** | 嵌套禁令(用户裁决 REQ-D08 kill 项),「仅主 Agent 可派发」最终防线;16 个子代理全部深度 1,不受影响 |
| 批量前瞻 | 12 | 16 | spawn_many 前瞻预加按新常量自动生效,原子语义不变(subagent_spawner.rs:786-825) |
| flow_graph 预算 | 跟随默认值 | **自动跟随** | 预算默认值引用 DEFAULT_RECURSION_GUARD(flow_graph.rs:1004-1006 注释「max_concurrent 6→12 自动生效」同款),改常量即生效;flow_max_concurrent/flow_max_siblings meta 键可覆盖(flow_graph.rs:689-693、736-744) |

**注意**:00-正式实现规范.md:84「合并注入 ≤16 条」中的 16 是**重启恢复条目合并上限**,与子代理上限 16 数字重合但**语义不同**——修订文档时在 00:84 加注「该 16 为恢复条目数,与 DEFAULT_RECURSION_GUARD.max_concurrent 的 16 无关联」,防后续实现混淆。

### 3.2 改动面清单

#### 3.2.1 代码(引擎真值)

| 文件 | 改动 | 证据 |
|---|---|---|
| crates/agent-tools/src/tools/subagent.rs | `DEFAULT_RECURSION_GUARD` 常量 `max_siblings: 5→16`、`max_concurrent: 12→16`;模块注释同步(495-496 行注释「6→12」历史口径改「12→16,用户补充需求」) | subagent.rs:497-501 |

#### 3.2.2 代码(TS 镜像)

| 文件 | 改动 | 证据 |
|---|---|---|
| packages/shared-types/src/subagent.ts | `DEFAULT_RECURSION_GUARD` 镜像 maxSiblings: 5→16、maxConcurrent: 12→16;注释同步(「Rust 侧 DEFAULT_RECURSION_GUARD 为唯一权威默认值,两侧同值」:6) | subagent.ts:57-65 |

#### 3.2.3 代码(测试修正,既有 12 上限测试)

| 测试 | 现状断言 | 改为 | 证据 |
|---|---|---|---|
| guard_concurrent_exceeded_rejected | active_concurrent=13 → ConcurrentExceeded{current:13, max:12} | active_concurrent=17 → {current:17, max:16};文案断言同步 | subagent.rs:2153-2175 |
| default_guard_limits_terminal_values | max_siblings==5、max_concurrent==12 | max_siblings==16、max_concurrent==16;max_depth==1 不变 | subagent.rs:2178-2186 |
| guard_within_limits_allowed | 边界 active_siblings=5 / active_concurrent=12 通过 | 边界 16/16 通过;第 17 个拒绝 | subagent.rs:2189-2224 |
| guard_siblings_exceeded_rejected | active_siblings=6 → {current:6, max:5} | active_siblings=17 → {current:17, max:16} | subagent.rs:2129-2150 |
| guard_depth_exceeded_semantics_preserved | 自定义 config {max_siblings:5, max_concurrent:12}(与默认无关) | 可不动(自定义值);为口径一致建议改 16/16 | subagent.rs:2055-2058 |
| spawn_many_guard_rejection_concurrent_zero_run | 12 并发 + 批量 1 = 13 拒绝零 run;agents.len()==12 | 16 并发 + 批量 1 = 17 拒绝零 run;agents.len()==16 | subagent.rs:2990-3018 |
| spawn_many_guard_rejection_siblings_zero_run | 4 兄弟 + 批量 2 = 6 > 5 拒绝 | 16 兄弟 + 批量 2 = 18 > 16 拒绝 | subagent.rs:3021-3055 |
| spawn_many_boundary_concurrent_12_allowed | 9+3=12 通过;agents.len()==12 | 13+3=16 通过;agents.len()==16 | subagent.rs:3058-3093 |

#### 3.2.4 文档引用(全部 12/5 口径处)

| 文档 | 位置 | 改法 |
|---|---|---|
| AGENTS.md | :23、:48「一轮最多 12 个子 Agent」 | D8 口径替换文本同步为「同时运行(未终态)子 Agent ≤16、同父 ≤16、深度仅 1(引擎守卫真值 DEFAULT_RECURSION_GUARD:maxDepth=1/maxSiblings=16/maxConcurrent=16)」 |
| final/00-正式实现规范.md | :18(能力表「≤12、同父 ≤5」)、:110(阶梯 3「受 12/5/1 约束」)、:158(红线 1「12/5/1 递归守卫只增不减」) | 全部改 16/16/1;红线 1 语义保持「只增不减」(12→16 是增,符合红线精神,需主控在红线文本注明本次扩额依据 = 用户补充需求) |
| final/00 | :84「合并注入 ≤16 条」 | 加注「该 16 为恢复条目数,与守卫 max_concurrent 无关联」 |
| 00-总纲-维度设计.md | :78(D4 A1「同父 ≤5、全局 ≤12」)、:110(红线 1) | 改 16/16/1 |
| dimensions/D3 | :110(阶梯 3「受 12/5/1 约束」)、:331(T6「active_concurrent=12」)、:348(风险表「12/5/1」)、:173(§3.2.3「重派走 spawn 守卫(12/5/1)」) | 改 16/16/1 及测试数字 12→16 |
| dimensions/D4 | :31(A1「同父 ≤5、全局 ≤12 预算被计数」)、:445(T2「并发已满」) | 改 16/16/1 |
| 02-子Agent分配上限与调度模型.md | :11(结论「同时运行的子代理 ≤ 12(同父 ≤ 5)」)、:154(红线「12 并发上限」) | 改 16/16;「红线只增不减」口径保持 |
| reviews/ 三份评审 + selection 报告 | 12/5/1 引用(selection-02:97、352 等) | 历史评审文档不改(记录当时事实),但作为「评审输入」的验收断言被 final/D3/D4 修正后,主控在定稿轮统一复核 |
| .opencode/agent/build.md:10 | 「一轮 ≤12」 | **保留**(调度批次惯例,非引擎上限;与 D8 §3.5 对 00-总纲:146 的「保留不改」裁决同款) |

### 3.3 批量前瞻预加(spawn_many)与新上限的交互

- spawn_many 前瞻快照:active_siblings = 现计数 + N、active_concurrent = 全局计数 + N(subagent_spawner.rs:806-817),一次判定(subagent.rs:605-616);
- 新上限下:同父批量 ≤16 全通过、第 17 个整体拒绝零 run(原子语义不变);跨父场景 siblings 按父计数,concurrent 全局 16;
- **交互风险点**:主 agent「同时跑 16 个」若分两批(如 10+6),第一批 10 个 running,第二批 6 个 → siblings 10+6=16 通过(边界)、concurrent 同 16 通过;若第一批未完成时再加第 17 个 → 拒绝。语义自洽,无需额外代码。
- **flow 预算**:DAG 调度器预算同样跟随(flow_graph.rs:997-1019),`in_flight` 到 16 停等下一终态事件。

### 3.4 配额/资源影响

| 面 | 影响 | 评估 |
|---|---|---|
| 并发 run | 16 个子代理 run 并行 = 16 条独立 provider 流 + 16 个 session-loop 状态机 | 无硬性资源配额机制(performance-tier.ts 的 maxConcurrentRequests 为 TS 侧旧物,未与 Rust 引擎接线,不引用);建议文档化风险,暂不新增配额键(超冻结面)。如主控认为必要,可列 P2:`run_subagent` 工具路径固定默认值注释(subagent_spawner.rs:108-110)已预留「固定默认值」语义,后续可加 session_meta 覆盖键 |
| DB 写 | 16 个 run 的会话消息落库并发 | 既有 save_run_usage / session_history.store 已走 spawn_blocking 面(F2-27 纪律,00:165);汇报接线新增 emit_event 同样 spawn_blocking(subagent_events.rs:196-203 装配时确认) |
| steering 队列 | 16 个终态通知 + 16 个恢复条目(全失败场景) | 容量 100 带 steering 挤占保护(steering_queue.rs:29-30、134-139);D3 §4.3 双条目共存;极值场景(16 子代理同时失败)旧条目可能被挤——既有风险(selection-03 S3),非本扩展引入 |
| 熔断/重试 | 16 条流同时瞬态错误 | 会话级 provider_fail_streak 熔断(D1)+ 跨 run 预算(D3)按会话维度兜底,不按并发数放行 |
| explore 配额 | 16 个子代理均为探索类 | explore_quota 按会话计数(explore_quota.rs:8-9),不因上限提升改变 |

### 3.5 测试影响汇总

- 回归面:subagent.rs 测试域全部重跑(上限测试 7 处数字修正后全绿);spawn_many 原子性/零 run 断言不变量保持;
- flow_graph 测试:预算断言若显式写 12(flow_graph.rs 测试域)需同步(实施时 grep `max_concurrent`/`12` 于 flow_graph 测试域);
- 集成测试:recovery_ladder / multi_agent / kill_all 不涉及 12 数字(子代理数 <12),零改动;
- D3 T6 / D4 T2 的场景编排数字同步(12→16);
- 文档口径验收:D8 A6「仓库内无残留『一轮最多 12 个』表述」扩展为「无残留 ≤12/同父 ≤5 表述」。

---

## 4. 「失败上报 + 主 agent 继续分配」闭环

### 4.1 完整闭环图

```
子代理 run 运行中
  │  (§2.2 汇报接线:每轮收口 emit_event progress → 前端时间线,主 agent 观测)
  ▼
provider 瞬态错误 ×3 次(stream_error.rs:62-95)
  ▼
run 收口(drive_run_loop :2844 前,D3 §3.2)
  │  还原 RunFailureContext(11 字段,含 provider_error.kind/retries/produced_content/history)
  ▼
RecoveryCoordinator::on_subagent_run_failure(D3 §3.2.2,spawn_blocking)
  ├─ 阶梯 1 AutoRetry(瞬态 && 预算内 && 未产出):sleep 退避 → 原 run 覆写
  │    end_reason="recovery-retry" → spawn 新 run(mode=recovery-retry,受 16/16/1 守卫)
  │    → 成功:继续执行(汇报循环重启)
  │    → 失败:计数推满 → 重入 escalate
  └─ 阶梯 2 Escalate(超次/非瞬态/已产出/预算耗尽):steering 条目 group_id=recovery-<run_id>
       + recover_notifications 落库 + recovery-escalated/recovery-steering 事件(D3 §4.2)
  ▼
终态五步收口(subagent_spawner.rs:486-660)
  subagent-ended(Critical)+ wait feed + steering 条目 subagent-terminal-<run_id>
  → 双条目共存(D3 §4.3,02 D2 裁定,drain 时批量拼接为一条用户消息)
  ▼
主 agent 下一 run 收口 decide_idle_resume 队列源消费(§1.1 通道 B)
  → 收到「失败通知 + 恢复激活指令」(错误 kind/重试次数/已产出,§2.4)
  ▼
┌────────────────── 主 agent 三决策路径(00 §3.5)──────────────────┐
│ ① 接管继续:不重派,下一轮自行继续输出(决策自由,引擎无强制动作)     │
│ ② 重派恢复:resume_subagent 命令(kill-for-resume + fork 新 run,     │
│    三态上下文继承 + Episode 预算 + 幂等,D4 §3.5)                   │
│ ③ 关闭重来:kill_subagent(单目标 L3 强停 + 行归一 failed,D4 §3.2)   │
│    + run_subagent/resume 重派                                      │
└────────────────────────────────────────────────────────────────────┘
  ▼
重派新 run 走 SubagentSpawnerImpl::spawn 全流程(守卫快照 + check_guard + 死锁检查,
subagent_spawner.rs:743-773)——受 16/16/1 约束;旧 run 记账已释放(收口五步第一步,
:506-526)时序正确
```

### 4.2 主 agent 收到汇报后的标准响应路径(文档化约定,供 AGENTS.md/任务书旁注)

| 汇报类型 | 主 agent 标准响应 |
|---|---|
| 运行中 progress(观测) | 无强制动作;可在 wait 中经 inject 调整方向(send_message target=subagent 或 wait inject);不打断 |
| 终态 subagent-terminal + recovery-<run_id>(失败) | ① 评估错误 kind/重试次数/已产出 → 接管(任务简单/已产出可续)或 ② resume_subagent(任务未完、预算内)或 ③ kill_subagent+重派(目标不可恢复);决策记录进会话消息 |
| 阶梯 4 recover_needs_user | 转用户(D3 阶梯 4;主 agent 不做自动动作) |
| wait 返回(await-all 完成) | 汇总产出清单 → 规划下一步(既有语义) |

**闭环完整性声明**:汇报接线(§2)补「运行中观测」段,恢复阶梯(D3)补「失败自动处理」段,三决策路径(00 §3.5/D4)补「主 agent 行动」段——三段拼接后,从「子代理派发」到「失败后主 agent 继续分配」全程可观测、可决策、可执行,不再有盲等窗口。

---

## 5. 接线与数据面

### 5.1 新事件/命令/字段

| 面 | 新增 | 理由 |
|---|---|---|
| 事件 | **无新增**。汇报复用 subagent-event(kind=progress/message/tool,载荷/背压/前端消费全现成);失败信息复用 recovery-*(D3)+ subagent-ended(既有) | 事件登记 41→49 集中一次(final 00:164)不扩面;subagent-event 已登记在册(subagent_events.rs:1-29 注册表锁定) |
| 命令 | **无新增 Tauri 命令**。send_message 走工具面(主 agent 是引擎内主体,非 IPC 用户);用户侧注入已有 run_control soft_inject | 避免命令面条数再动(107/102/5,02 定夺 P1-1) |
| 工具 | send_message(新,§1.2)+ SubagentInjectChannel/MainAgentMessageChannel 两通道契约 | 工具面补齐 |
| DB 键 | 无新增 session_meta 键 | 汇报事件走 events 表;来源标记走消息 metadata |
| 字段 | 消息 metadata `{source:"main-agent"}`(可选加 `{kind:"steering"}` 并集);SubagentEventInfo 载荷形状不动(progress payload 透传文本块) | 零 schema 改动 |

### 5.2 对 D3/D4/D8/final 的修改点

| 文档 | 修改点 |
|---|---|
| final/00-正式实现规范.md | §1.1 能力表行 2(12/5/1 → 16/16/1);§3.3 阶梯 3 约束;§5 红线 1(数字+扩额依据注);§3.1 表格子代理通知行(加「运行中 progress 汇报经 subagent-event,终态才写 steering」);:84 加注双 16 区分 |
| dimensions/D3 | §3.2.2/3.2.3 守卫时序「12/5/1」→「16/16/1」;§5.2 T6 数字;§6 风险表 12/5/1;§3.2.4 装配表补「汇报接线点」(子代理收口处 emit_event,与 D3 触发点同区,文件域冲突注意) |
| dimensions/D4 | §1.2 A1 断言数字;§5.2 T2 数字;§6 R1 数字;§3.3 工具面段落补 send_message 与 kill_subagent 同面(剔除面扩展);§3.6「接管」文档化段落补 §2.4 信息面引用 |
| dimensions/D8 | §2.6/§3.5 口径替换文本(≤16/同父 ≤16);§1.2 A6 验收扩展(无残留 ≤12 表述);§3.1 事件登记表不加行(subagent-event 已登记,若登记表未含则补登记——实施时核对) |
| AGENTS.md | :23/:48 口径;「子 Agent 调度规则」节补 send_message/汇报纪律旁注(与「空返回无限重派纪律」并列) |
| 02-子Agent分配上限与调度模型.md | §1 结论与 §5 红线数字;§2.1 表 maxConcurrent 行注「12→16(用户补充需求)」 |

### 5.3 文件域冲突注意

- core_run_commands.rs 是 D1/D2/D3/D4/D5/D6 汇聚面(10278 行,00 总纲 §4),本扩展的汇报接线点(子代理 run 收口 emit_event)与 D3 触发点(:2844 前)同区——**派单必须与 D3 同批串行或并入 D3 任务书**,禁止单独排期;
- subagent.rs 是上限常量 + send_message 工具面 + 剔除面的交汇文件,与 D4(kill_subagent 工具同文件)冲突——上限常量改动与 D4 工具面合并为同一派单单元,或按文件互斥串行;
- subagent_events.rs 汇报接线(emit_event 生产调用)属新文件域,无既有维度占用,可独立派单。

---

## 6. 验收断言

### 6.1 主 agent 消息注入(需求 ①)

| # | 断言 | 落地机制 |
|---|---|---|
| I1 | 主 agent run 内调用 send_message(target=subagent, subagentId=S) → 目标子代理 run 的 ControlBus 收到恰 1 条 L1 steer 意图,reason=`subagent_inject:S`;子代理 run 无 L2/L3 意图(流不被打断);目标 run 不可达 → 结构化 InjectFailed | control.rs:275-286;wait_channel.rs:457-473(同通道断言先例 control.rs:641-667) |
| I2 | 主 agent run 内调用 send_message(target=self, message=M) → 会话消息记录新增 1 条 user 角色消息且 metadata.source="main-agent";当前 run 内不打断(followUp 环 pending,run 不因该消息提前收场);消息不计 user_touched(收口后 idle 续 run 判定不受抑制) | input.rs:142-144;core_run_commands.rs:3783(对照 user_touched) |
| I3 | 子代理 run 装配工具注册表调用 send_message → tool.not_found(剔除面);未接线通道 → common.unsupported;用户消息与 send_message 消息可区分(用户消息无 source 字段) | core_run_commands.rs:3236-3238;subagent.rs:653-659 |

### 6.2 子代理汇报(需求 ②)

| # | 断言 | 落地机制 |
|---|---|---|
| R1 | 子代理 run 运行中每轮收口后 → events 表出现 subagent-event(kind=progress)条目,载荷含该轮文本块摘要;子代理 run 存活期间可检索到多条(轮次递进) | subagent_events.rs:71-82、196-203(emit_event 生产接线) |
| R2 | 主 agent await-all 等待期间子代理产生 progress 汇报 → wait_for_terminal 不提前返回(名单外忽略);汇报不写入 steering 队列(queue 无新条目);前端 agent 时间线新增进度条目(applySubagentEventToAgent) | wait_subagents.rs:378-459;subagentHandlers.ts:131-144 |
| R3 | 子代理失败终态 → steering 条目(subagent-terminal-<run_id> + recovery-<run_id> 双条目)文本含错误 kind/重试次数/已产出标记(provider_error 数据面贯通 D1→D2/D3);终态后无新增 progress 汇报 | D3 §4.3;D2 注入模板;D3 §2.4 全表 |

### 6.3 上限 16(需求 ③)

| # | 断言 | 落地机制 |
|---|---|---|
| C1 | default_guard_limits_terminal_values:max_depth==1 / max_siblings==16 / max_concurrent==16;guard_concurrent_exceeded_rejected:active_concurrent=17 拒绝({current:17,max:16});guard_within_limits_allowed:边界 16/16 通过 | subagent.rs:2178-2186、2153-2175、2189-2224(修正后) |
| C2 | spawn_many 批量 16 个(同父)→ 全部成功落库 16 行;第 17 个(16+1)→ 整体拒绝零 run;同父 16 兄弟边界通过(16+2=18 拒绝) | subagent.rs:2990-3018、3021-3055、3058-3093(修正后) |
| C3 | flow_graph 预算跟随新默认值(in_flight=16 停等,17 不派);shared-types/subagent.ts 镜像 16/16/1 与 Rust 同值;文档无残留 ≤12/同父 ≤5 表述(grep 验收) | flow_graph.rs:997-1019;subagent.ts:57-65;D8 A6 扩展 |

### 6.4 既有测试修正(回归面)

- subagent.rs 测试域 7 处数字修正(§3.2.3 清单)后全绿;
- 门禁:`cargo test --workspace`(73 套件基线)+ 前端 typecheck + markdown-editor 门禁 + 5 专项 spec 不受影响(00 §1.2 验收 7);
- registry_drift / command_manifest 条数不变(无新事件/新命令登记);
- 禁止 --no-verify(00 §5 红线 4)。

---

## 7. 动态决策记录(输入文档未覆盖处的自决)

| # | 问题 | 决策 | 理由 | 影响面 |
|---|---|---|---|---|
| 1 | max_siblings 是否同步 16 | **同步 16** | 所有子代理同父=主 agent,5 上限下「16 并发」第 6 个即被拒;批量前瞻预加同样命中;16=16 不违反「兄弟应小于全局」精神(改注释口径) | §3.1;subagent.rs:497-501 |
| 2 | 运行中汇报是否写 steering 队列 | **不写** | steering 是唤醒通道(触发新 run),运行中汇报写队列 = 唤醒风暴;且主 agent 可能正阻塞长工具调用无人收口;汇报=观测面、唤醒=终态面 | §2.3;02-子Agent:147(缺口 6 同款) |
| 3 | 汇报事件是否新增独立类型 | **复用 subagent-event** | 类型/载荷/背压/前端消费全现成(subagent_events.rs:71-82、15-19;subagentHandlers.ts:45-59),新增 = 破坏「事件登记集中一次」纪律且重复造轮子 | §5.1;final 00:164 |
| 4 | send_message 走工具面还是命令面 | **工具面**;不新增 Tauri 命令 | 主 agent 是引擎内主体(工具调用),非 IPC 用户;命令面条数 107/102/5 已冻结(02 定夺 P1-1) | §1.2;§5.1 |
| 5 | send_message 是否标记 user_touched | **不标记** | 用户消息抑制 idle 续 run(core_run_commands.rs:2517-2519),主 agent 自发消息若误标则「续 run 被自己抑制」 | §1.3 |
| 6 | 汇报接线位置与 D3 触发点同区冲突 | **与 D3 同批串行或并入 D3 任务书** | core_run_commands.rs 同文件互斥派单纪律(00 总纲 §4);汇报发射点与 RunFailureContext 还原点相邻 | §5.3 |
| 7 | 00:84「合并注入 ≤16 条」与上限 16 数字重合 | **加注区分语义** | 前者是恢复条目合并上限,后者是并发上限;数字相同易被实现误读为同一常量 | §3.1;00:84 |
| 8 | 汇报文本截断长度 | 500 字符(对齐 checkpoint 摘要截断 00 §3.6) | 汇报是观测面,完整文本在前端 agent 时间线可查;事件载荷控制体积 | §2.2 |
| 9 | 16 并发资源配额是否新增键 | **不新增**(列 P2 可选:session_meta 覆盖键) | performance-tier 旧物未接线;超冻结面纪律(00 §5 数据面);documentation 风险即可 | §3.4 |
| 10 | subagent-event 已登记与否 | 实施时核对登记表;若 D8 §3.1 事件登记表未含 subagent-event,补登记(其注册表引用 subagent_events.rs:1-29 已存在) | 汇报接线依赖该事件的生产发射,登记是前置条件 | §5.2 D8 修改点 |

---

## 附:关键文件索引

| 文件 | 角色 |
|---|---|
| crates/agent-tools/src/tools/subagent.rs | DEFAULT_RECURSION_GUARD(497-501,改 16/16/1)/ filter_out_subagent_spawner(653-659,剔除面扩展)/ 上限测试域(2129-2224、2990-3093,数字修正) |
| packages/shared-types/src/subagent.ts | TS 镜像 DEFAULT_RECURSION_GUARD(57-65) |
| crates/agent-tools/src/tools/send_message.rs(新) | SendMessageTool + SubagentInjectChannel/MainAgentMessageChannel 契约 |
| crates/agent-tools/src/tools/mod.rs | BuiltinToolConfig 扩展 + 注册 |
| crates/orchestrator/src/subagent_events.rs | SubagentEventInfo(71-82)/ emit_event(196-203,汇报生产接线点) |
| apps/agent-workbench/src-tauri/src/core_run_commands.rs | 子代理 run 收口汇报发射点(:2844 前,与 D3 同批)/ 引擎侧 filter 闭包(3236-3238)/ decide_idle_resume(2505-2593) |
| apps/agent-workbench/src-tauri/src/subagent_spawner.rs | 守卫快照(743-764)/ spawn_many 前瞻(786-825)/ 终态五步(486-660) |
| apps/agent-workbench/src-tauri/src/wait_channel.rs | ControlBusResolver(99)/ inject(457-473) |
| crates/session-loop/src/control.rs | request_subagent_inject(275-286)/ L1 环语义(77-83) |
| crates/session-loop/src/input.rs | 三环输入队列(36-45、142-144) |
| crates/orchestrator/src/steering_queue.rs | PendingMessageQueue(111-114)/ steering 元数据(89-106) |
| apps/crish-desktop/src/api/chat-bridge/handlers/subagentHandlers.ts | 前端汇报消费面(45-59、131-144) |
| docs 口径面 | AGENTS.md:23/48、final/00:18/84/110/158、00-总纲:78/110、D3/D4/D8 各处 |

> 本文档为只读分析 + 单文档产出(唯一写面);未修改任何代码、未执行任何 git 操作。行号引用以核对当日代码为准,如漂移以实际代码为真源。
