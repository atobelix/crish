# A5 审计：壳层 Tauri 域（apps/agent-workbench/src-tauri）

> 任务：审计轮 Agent A-5（只读审查）。
> 范围：`apps/agent-workbench/src-tauri/src/`（engine.rs、core_run_commands.rs、core_query_commands.rs、session_commands.rs、background.rs、resource.rs、timers.rs、sched.rs、watchdog.rs、wait_channel.rs、subagent_spawner.rs、wakeup_summary.rs、workflow_commands.rs、outputs_config.rs、process.rs、pty/、perf/、fs_commands/、command_manifest.rs、main.rs、workspace.rs 等）。
> 对照基线：`审计准备-已知缺点与技术债汇总.md`（230 条，F1~F12 登记）与 `审计准备-测试可信度预检.md`（19 条）——已登记项不重复，仅对新发现与「已登记项的生产接线核实」登记。
> 方法：逐模块精读 + 全仓消费方/调用点反向搜索（rg 定位「装配了但无人消费」的断头路）。
> 日期：2026-08-05（本地）

## 结论速览

- **总体判断：壳层大部分模块质量高、接线自洽**——run 生命周期（run_task_impl / drive_run_loop）、后台任务（adopt/kill 两阶段、归档、采样、健康判定）、时间域（timers/sched 的 restore/补发/幂等）、子代理 spawner 全链、命令注册面与 manifest 一致性、安全面（unsafe 收敛于 process.rs Job FFI，均有 SAFETY 说明）均无实质问题。
- **但发现一条贯穿 workflow/cron 调度域的断头路链（高严重度）**：SchedulerRegistry 在生产装配后**无任何消费者**——三条接线点（`WorkflowBackend::set_registry` / `CoreRunState::set_cron_has_enabled` / 共享 steering 队列）全部停留在「冻结接口预编码 + `#[allow(dead_code)]`」状态，且 WorkflowCommandState 自建了与引擎**不同实例**的 PendingMessageQueue。生产环境 create-workflow 只落库、trigger 注入幽灵队列、Cron 到期触发永不发生、idle 续 run 的 Cron 源恒 false。这是典型的「AI 产出代码运行语义自洽但未接线」断头路。
- 另确认 1 条已登记项（A-07 comment_preservation_section）**仍未闭环**；1 条（A-27 workflow update 换调度）现状与登记一致。

## 分类发现表

### 新发现（未登记项）

| 编号 | 严重度 | 文件:行号 | 问题 | 证据 | 建议 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| A5-H01 | **高** | workflow_commands.rs:588-590；workflow_commands.rs:626-630；engine.rs:946-949；core_run_commands.rs:1282-1287 | **workflow/cron 调度域生产断头路链**：SchedulerRegistry 在生产装配后零消费者，Cron 调度引擎侧整体未激活（四处证据点见下表） | 见下 | 装配轮统一接线：`WorkflowCommandState` 复用引擎共享 steering 队列 + `set_registry` 在 main.rs setup 调用 + `set_cron_has_enabled` 注入 + `has_active` 转正 |
| A5-H01a | （并入 H01） | workflow_commands.rs:588-590 vs core_run_commands.rs:1232 | **队列双实例隔离**：`WorkflowCommandState::new` 自建 `PendingMessageQueue::new()`（main.rs:395-397 注入），而 drive_run_loop 消费的 `pending_queue` 来自 `engine.timer_steering_queue()`（core_run_commands.rs:1232 同实例）。全仓 PendingMessageQueue 使用清单中无 workflow→core 桥接 | `trigger()` 注入的 steering 条目（workflow_commands.rs:903-910）落入无人消费的队列；`trigger-workflow` 后无任何 run 被唤醒（TriggerResult.run_id/session_id 恒 None，:928-931 亦为旁证） | 装配轮改为注入引擎共享队列（同 `finalize_subagent_spawner` 的 `Arc::clone(&self.pending_queue)` 模式，core_run_commands.rs:1452） |
| A5-H01b | （并入 H01） | workflow_commands.rs:626-630 | **`set_registry` 生产零调用点**：注释自认「当前仅测试面消费——A3 装配收口后由装配点调用」；全仓调用仅测试 :1453 | registry 恒 None → `create`（:661）/`update`（:827）/`delete`（:866）的调度委托全走本地元数据退化路径（:702-743），真实 cron 调度永不注册；`list`（:752）快照刷新亦失效 | main.rs setup 或装配轮调用 `set_registry(engine.scheduler_registry())` |
| A5-H01c | （并入 H01） | engine.rs:752/826/946-949；sched.rs:517-525 | **装配产物无消费者**：`assemble_scheduler_registry` 装配的实例只挂在 `EngineHandle.scheduler_registry` 字段；访问器标 `#[allow(dead_code)]` 注明「A9：workflow 命令登记消费」但 workflow 从未调用；`SchedulerRegistry::has_active` 同样 dead_code（仅测试消费） | 编译期 `dead_code` 注解即断头路标记：组件装配了但没有任何生产路径触达 | 接线后移除三处 `#[allow(dead_code)]`（含 :907/912/933/946 同类） |
| A5-H02 | **高** | core_run_commands.rs:1270/1282-1287/1874-1886 | **`set_cron_has_enabled` 生产零调用点**：`cron_has_enabled` 恒 None（:1270），注入判定器仅测试（:5132）消费；`decide_idle_resume` 的 Cron 唤醒源（:1874-1886）恒 false | 「enabled Cron 任务保持待命」语义（T-CF-11 第 2 点）在生产缺失——run 收口后若队列空、无定时器，即休眠待用户，Cron 未到期期间不保持待命（定时器源已接线 :1234-1237，Cron 源未接线，两者不对称） | 装配轮注入 `SchedulerRegistry` 活跃判定器（对齐 timer_has_active 的构造先例 :1234） |
| A5-M01 | 中 | resource.rs:162-204；process.rs:523；background.rs:1096 | **Windows 资源采样跨任务污染（口径错误）**：daemon Job 为 app-wide 单例（process.rs:523），所有任务 assign 同一 Job（background.rs:1096），`sample_windows` 查询 Job 聚合累计值（TotalUserTime/TotalKernelTime/PeakJobMemoryUsed） | 每个任务的 `info.resource` 与 `.samples.jsonl` 记录的是**全 Job 所有后台任务的 CPU 总和与峰值 RSS**，非本任务进程树；多任务并行时数据互相污染，单任务展示失去意义（`sample_usage` 的 pid 入参在 Windows 侧被 `allow(unused_variables)` 忽略，resource.rs:140 佐证） | 改 per-process 口径（Job 内枚举进程 / 按 pid 走 GetProcessTimes+遍历）或文档明示「聚合口径」并停用单任务 resource 展示（诚实边界升级） |
| A5-M02 | 中 | sched.rs:621；workflow_commands.rs:906；timers.rs:665 vs wakeup_summary.rs:99/142 | **steering 摘要模板三处手工复刻 + `cron_fired_summary` 生产死代码**：sched/workflow/timers 各自内联复刻 §4.8 模板文案，未调用 `wakeup_summary::cron_fired_summary`（wakeup_summary.rs:142-143，生产零调用，仅测试消费）；sched.rs:24 注释承认「R-CF3 装配收口统一接入」未落地 | 文案漂移风险（如 cron 文案改版时三处同步）；`cron_fired_summary`/`wakeup_summary` 实际只被 subagent_spawner.rs:639 一处消费 | 三处改为调用 `cron_fired_summary`（与 timers 模板同源函数），消除复刻 |
| A5-M03 | 中 | core_run_commands.rs:1475-1488（vs main.rs 命令注册表） | **子代理生命周期命令面缺失**：`lifecycle_service`（kill_all / resume_subagent 服务面）标注「T-D-12 命令面消费」但全仓仅测试（:5896）调用；main.rs 注册表与 command_manifest 无 kill-all / resume-subagent 命令 | DAG 停止/恢复能力在壳层无命令入口（与 A-02 登记域邻接，属其补充证据；本项为「服务面已冻结、命令面缺失」的独立接线缺口） | 并入 A-02 处置域，后续战役补命令面 |
| A5-L01 | 低 | core_run_commands.rs:2644 | **格式异常残留**：`None => (...),            Some(config) => {` 两个 match arm 挤在同一行（缺换行）——功能正常，疑为 F12 批量注释编码事故修复后的残留 | 代码风格与文件其余部分不一致；rustfmt 未覆盖此行 | 顺手格式化 |
| A5-L02 | 低 | core_run_commands.rs:1234-1237 | **timer 活跃判定每次全表查询**：`timer_has_active` 判定器每次收口 poll `list_active()`（全表扫）；无计数镜像（A-12 已登记计数缺失，本项为其实现细节佐证，不另立） | 高频收口下多一次哈希表遍历，量级微小 | 与 A-12 一并处置（同步计数） |

### 已登记项的生产接线核实（非新编号）

| 编号 | 严重度 | 文件:行号 | 核实结论 | 证据 |
| :--- | :--- | :--- | :--- | :--- |
| A-07 核实 | 中 | core_run_commands.rs:2694-2730；engine.rs 全域 | **confirm：仍未闭环**。comment_preservation_section（agent-tools subagent_inject.rs:160，F5 交付）在子代理注入块中未挂载——注入段仅含角色约束 / started_at+git 回退（:2696-2705）/ 权限指引（:2706-2721）/ 产出目录（:2723-2730），`COMMENT_PRESERVATION_TITLE` 全仓无引用 | rg 证实；引擎侧与 run 装配侧均无调用点 | 补挂载（并入 F11 注入清单核对轮） |
| A-27 核实 | 低 | workflow_commands.rs:842-844 | **与登记一致**：update 换调度 = cancel + 重新注册，cron_id 可能变更且旧键残留孤儿（:843 注释自认） | 现状复核 | 维持 A-27 后续战役处置 |

## 分维度审计记录

### 1. 引擎装配（EngineHandle::new 装配面）

- **五模块 + spawner/wait/timer 装配正确**：TimerRegistry（pending=真实 PendingMessageQueue / events=缓冲适配 / store=内存适配，engine.rs:687-692）、WaitChannel（MemoryWaitStore + MemoryAgentSource + EventStreamBroadcast + NoopControlBusResolver，:715-722）、Watchdog（engine 级 session_id 空串，:732-739）、SchedulerRegistry（:752）、内置工具注册（BuiltinToolConfig 全字段显式注入，:761-775）。
- **失败降级语义一致**：`try_current()` 守卫跳过无 tokio runtime 上下文（:697-709、740-747、1091-1101），装配失败仅 warn 不阻塞（:776-784）。
- **无重复装配**：`new` 仅是 `new_with_spawner` 的 None 变体（:670-672），生产唯一入口 CoreRunState::new（core_run_commands.rs:1220-1231）。
- 缺口集中于「装配了但无消费者」：见 A5-H01c（scheduler_registry）、A5-H02（cron_has_enabled）、A-03 已登记（ControlBusResolver 生产 Noop）。

### 2. run 生命周期（core_run_commands）

- **run_task_impl 装配链完整**：restore 门禁（:2461-2465）→ 串行守卫（:2475-2482）→ 子代理工具集裁剪（fail-closed 白名单 + run_subagent 剔除，:2491-2511）→ 逃逸监视启动（:2596-2627）→ 子代理装配块（写路径沙箱/配额/注入段，:2629-2733）→ 历史水合（:2783-2797）→ context_injector（:2821）。
- **drive_run_loop 收口链完整**：缓存写回（:2046-2054）→ drive_outcome 错误防御性收口（:2063-2085）→ 缓冲桥 emit + message-delta 去重（:2090-2112）→ 逃逸监视 shutdown（:2122-2129）→ 终态移出 + 后台任务不级联杀（T-AB-19 契约，:2138-2146）→ 子代理终态收口先于 idle 判定（:2152-2160，保证 steering 条目入队后主 agent 收口可见）→ idle 续 run（:2180-2220，子代理 run 跳过自续——C-09 已修保留）。
- **opaque future 处理正确**：drive_run_loop 与 run_task_impl 经 trait object 拉起器（production_resume_launcher，:1242）与 ResumeLauncher 叶子类型切断类型递归（:2205-2210 注释详尽）。
- 疑问点：2644 行格式异常（A5-L01）；A-26 队列跨会话串扰已登记（drain_pending_to_inject_messages 按 session 归属缺失）——核实：core_run_commands.rs:1936-1956 确实无会话过滤，维持登记。

### 3. 后台任务（background.rs + process.rs）

- **adopt 链**：daemon Job 接线（best-effort 降级，:1094-1105）→ meta 初值写盘（:1134）→ 双流转发（落盘+预览+计数+checkpoint+提示检测，:1146-1168）→ 资源采样循环挂载（:1173-1185）→ 容量 FIFO 淘汰（:1202-1204）。
- **kill 两阶段**：终态短路（:1428-1439）→ 独占取 child（竞态按 AlreadyExited，:1441-1457）→ try_wait 省 5s（:1461-1483）→ 优雅（无 /F）→ 5s 窗口 → 强制（/F /T）→ 升级失败放回槽位（:1485-1544）。与已登记 C-16/B-28 平台限制一致。
- **归档/健康判定**：惰性清扫 + 归档循环双路径（:1213、:850）；judge_health 纯函数三态（resource.rs:80-92）+ SuspiciousDebounce 防抖（background.rs:2121）。
- **进程管理**：daemon Job 与 PTY Job 双实例隔离（process.rs:523/589），孤儿保护（KILL_ON_JOB_CLOSE）接线完整；句柄生命周期：OnceLock 内持有一个句柄 + 重复 init 关闭多余句柄（process.rs:531-540）。
- 问题：Windows 采样口径（A5-M01）、Unix kill -TERM 无升级（B-28 已登记）、I/O 恒 0（B-27 已登记）。

### 4. 时间域（timers.rs / sched.rs / watchdog.rs）

- **timers**：register 校验（1s~86400s，:326-330）→ 冲突约束（:348+）→ fire 任务 sleep_until（单调时钟）+ catch_unwind 兜底（:600-621）→ fire_timer 幂等三守卫（终态跳过/表移除/早退清理，:639-653）→ 事件 + steering + 落库（:654-673）。`expires_at_ms` 用墙钟、sleep 用单调时钟，系统休眠唤醒后立即到期触发（无迟到补偿，语义可接受）。
- **sched**：register 解析→next_fire→落库→spawn（:399-441）；cancel abort + enabled=false 落库（:445-465）；restore 序号推进 + 过期补发（:470-513）；fire 重建循环（:572-583）。
- **watchdog**：引擎级单实例（session_id 空串占位，D-14 已登记）；scan 判定（活跃定时器抑制→无 dispatch 不触发→idle 基准=max(分发,唤醒,上次触发)）健全（:233-272）；注入时钟测试（:331+，预检确认零 sleep 高可信）。
- 已登记接线缺口核实：A-08（timer 事件 EventBridge 真适配未接——events=AgentEventSink 缓冲适配，engine.rs:690 佐证）、A-12（active_timer_probe 恒 `|| 0`，engine.rs:737 佐证）均与登记一致。

### 5. 命令面（command_manifest / main.rs 注册）

- **一致性锁定**：main.rs:443-455 测试逐项比对 manifest registered=true 与 COMMAND_REGISTRY_NAMES；workflow 六条命令全 registered（command_manifest.rs:174-179）且已注册（main.rs:202-207）。
- 命令实现质量：workflow 命令体含入参 trim 校验、spawn_blocking 隔离（list/trigger，:1024/1084）、错误结构化映射（map_scheduler_err，:966-978）。错误形状统一 CoreError {kind, detail}（core_error.rs:1-34）。
- 断头路：workflow 命令「注册正常、语义未接线」（A5-H01）；kill-all/resume 命令面缺失（A5-M03）。

### 6. 配置面（outputs_config / TrashRootConfig）

- **outputs_config**：`{session_id}:output_dir` 键编码（:37-38）、覆盖优先级（会话级覆盖 > 全局 > 默认 .agent-outputs，:285-330）、工作区外拒绝（allowOutputsOutsideWorkspace 可覆盖但默认关，:13-14）、会话删除清理含防逃逸校验（session_meta 被篡改为工作区外路径拒绝清理，:692 测试佐证）。
- **TrashRootConfig**：注入优先 → 活动工作区 `.crish-trash` 兜底（core_run_commands.rs:3147-3160），与 agent-tools delete 工具兜底同根，恢复面板与删除工具落入同一回收站。
- 已登记：A-19（agentOutputsRoot 内存托管未持久化）核实未变。

### 7. 接线流畅性（跨模块联通）

- **已接通**：engine→CoreRunState（timer_steering_queue 同实例 :1232）；spawner 全链（launcher/db/terminal_stream/pending_queue 注入 :1443-1454）；子代理终态→wait 通道 feed→steering 通知（subagent_spawner.rs:496-660）；逃逸监视→审计桥→注入环（core_run_commands.rs:2597-2605）；wakeup_summary 被子代理通知消费（subagent_spawner.rs:639）。
- **断头路**：workflow 调度域（A5-H01/H02）；kill-all/resume 命令面（A5-M03）；cron_fired_summary 死代码（A5-M02）；reload 未接线（engine.rs:836 自认 G11a 遗留）。

### 8. 安全

- **unsafe 收敛**：全部集中在 process.rs Job Objects FFI（create/assign/OpenProcess/QueryInformationJobObject），每处 `#[allow(unsafe_code)]` + SAFETY 说明（process.rs:443-570、resource.rs:160-204）；JobHandle 的 Send/Sync 豁免有注释（:445-454）。
- **路径校验**：workspace.rs canonicalize + 前缀包含匹配（不可达根拒绝，P-02 关闭，:273-279）；fs_commands 拒绝越界/符号链接逃逸/大文件（测试覆盖 :199-308）；outputs_config 防逃逸。
- **命令注入面**：taskkill/kill 参数为 u32 数字（process.rs:347-371），无拼接注入；命令面无 shell 拼接。
- 无新安全问题。豁免面蔓延问题（D-04）核实：壳层豁免均带理由注释，维持登记。

## 最需修复 Top 5

1. **A5-H01 调度域断头路链**（高）：`WorkflowBackend::set_registry` + `EngineHandle::scheduler_registry()` 生产接线——workflow create/update/delete 接入真实 SchedulerRegistry，Cron 调度引擎侧激活；同时 `WorkflowCommandState` 的 steering 队列改注入引擎共享 `pending_queue`（对齐 finalize_subagent_spawner 模式）。这是「前端用户创建了调度但永远不会触发」的断头路。
2. **A5-H02 set_cron_has_enabled 生产接线**（高）：idle 续 run 的 Cron 唤醒源激活（对齐 timer_has_active 先例），使「enabled Cron 保持待命」语义在生产生效。
3. **A5-M01 Windows 采样口径**（中）：daemon Job 聚合值 ≠ 单任务数据——决定 per-process 口径或明示聚合边界停用单任务展示，避免前端误导。
4. **A-07 确认未闭环**（中）：comment_preservation_section 补挂载进子代理注入块（与 started_at/git 段同源函数 subagent_session_injections 或独立 push）。
5. **A5-M02 模板复刻消除**（低）：sched.rs:621 / workflow_commands.rs:906 / timers.rs:665 改调 `cron_fired_summary` / 统一摘要模板函数，消除三处文案漂移面（顺手可并入 H01 装配轮）。

## 回报要点

- **新发现条数**：7（高 2 域级条目 H01/H02，其中 H01 含 3 处证据点；中 3；低 2）+ 已登记核实 2（A-07 确认未闭环、A-27 现状一致）。
- **高严重度清单**：A5-H01（workflow/cron 调度域断头路链：set_registry 零调用 + 队列双实例 + scheduler_registry 零消费者）、A5-H02（set_cron_has_enabled 生产零调用，Cron 唤醒源恒 false）。
- **总评**：壳层工程质量总体高——run 生命周期/后台任务/时间域/子代理 spawner/安全面均扎实；核心问题集中在「装配面与消费面脱节」：引擎侧把组件装配齐全并预编码接线接口（allow(dead_code) 冻结），但生产装配点（main.rs setup）从未调用注入函数，形成 workflow/cron 调度域整域断头。此类断头路编译期不可见（dead_code 注解静音），建议后续装配轮以「移除 allow(dead_code) 为接线完成验收标准」。
- 文档路径：`docs/feature-gap-analysis/audit/A5-壳层Tauri域审计.md`。
- 未提交任何变更（只读任务）。
