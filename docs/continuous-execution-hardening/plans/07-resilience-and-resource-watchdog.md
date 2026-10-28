# 方案 07：网络容灾、细粒度熔断与系统资源看门狗重构方案

> **专项定位**：针对 Conex / Crish 在 24/7 全天候连续运行、无人值守自治执行、跨昼夜长程自驱任务、上游供应商网络剧烈波动及宿主操作系统资源长期消耗等严苛工况下的系统韧性断裂，实施全方位的架构重构与加固设计。
> **涉及核心代码基线**：
> - crates/session-loop/src/loop/handlers/stream_error_retry.rs（瞬态错误退避重试、Retry-After 契约与总预算）
> - crates/conex-run/src/run/run_retry.rs（连续失败熔断、退避配置与阶梯重试）
> - crates/conex-run/src/run/run_commands.rs（孤儿 Run 收割巡检、活跃运行态回收）
> - pps/agent-workbench/src-tauri/src/process/job_windows.rs（Windows Job Object 与进程生命周期管理）
> - pps/agent-workbench/src-tauri/src/bg_task.rs 与 crates/agent-tools/src/tools/background_task.rs（后台任务托管与守护状态）
> - crates/session-loop/src/loop/handlers/mod.rs 与 crates/session-loop/src/state.rs（LoopState.events 内存聚合）
> - crates/conex-db/src/reader_pool.rs 与 crates/conex-db/src/group_commit.rs（SQLite WAL 检查点与存储治理）
> - crates/orchestrator/src/restore_manager.rs（崩溃调和、孤儿工具调用治愈与断点复苏）
> - crates/conex-run/src/workflow/schedule.rs 与 crates/conex-run/src/workflow/backend.rs（Workflow 定时调度与 Misfire 补偿）
> - crates/conex-run/src/run/run_idle.rs（空闲续跑决策、四大唤醒源与未决事件管理）
> - crates/conex-run/src/wake_watcher.rs（后台唤醒监视器与初始提示词注入）

---

## 核心执行摘要（Executive Summary）

全天候无人值守连续运行（24/7 Unattended Autonomous Execution）是工业级智能体引擎区别于实验性聊天界面的核心分水岭。当前的 Conex / Crish 桌面端与 Rust 内核虽然在短周期交互与有人值守场景中具备基础的状态机与错误捕获能力，但在迈向连续跨昼夜长程自治、上游大模型 API 遭遇高频限流或长时间断网、宿主环境长期运行引发资源累积，以及突发意外宕机等极端生产工况时，系统暴露出多个致命的“结构性脆化点”：

1. **重试预算刚性截断**：将瞬态重试总预算写死为 180s（甚至局部 60s），与大模型供应商真实的 429 RateLimit（Retry-After 常达 300s~600s）形成直接数学冲突，首轮退避即被误判为 FatalStreamError 并强杀任务；
2. **断路器二态翻转与静默死寂**：熔断机制仅具备 Closed 与 Open 两个粗粒度状态，缺乏渐进探测的 Half-Open 试探态；冷却到期后缺乏任何主动唤醒事件，会话在无人干预下陷入永久死寂；且全局静态 Key 造成单模型故障雪崩连坐；
3. **资源泄漏与孤儿逃逸**：Windows Job Object 在嵌套受限或降权环境下绑定失败时仅做日志警告，导致子进程脱控逃逸；孤儿回收器对卡死 Driver 存在检测盲区，引发 SessionSerialGuard 会话排他锁永久死锁；内存事件无限追加与 SQLite WAL 检查点停滞，使长程运行必然遭遇 OOM 与磁盘耗尽；
4. **崩溃自愈“只收尸不复活”**：系统重启时能够清理数据库脏状态并标记 Failed(daemon-restarted)，但完全缺失断点自动复活机制，长程自治任务直接夭折；定时工作流在停机期间缺乏 Misfire 补执行策略，重要调度静默漏跑。

本方案严格遵守《AGENTS.md》§1、§7、§7.1 纪律与《ANTI_OVERENGINEERING_GUARDRAILS.md》红线，**坚决杜绝打补丁与硬编码**，从状态机契约、资源生命周期、网络容灾与持久化自愈四个维度进行系统性净收敛重构，构建具备高韧性、高弹性、零资源泄漏的 24/7 工业级自治底座。

---

## 目录索引

1. [方案定位与核心设计哲学](#一方案定位与核心设计哲学)
   - 1.1 背景与现状评估：三大系统性死穴
   - 1.2 架构设计红线与反打补丁铁律
   - 1.3 全景系统韧性拓扑架构
2. [自适应弹性网络重试体系（Dynamic RateLimit & Full Jitter）](#二自适应弹性网络重试体系dynamic-ratelimit--full-jitter)
   - 2.1 瞬态网络错误分级契约（Transient vs. Fatal）
   - 2.2 429 RateLimit 动态重试预算延展机制（上限放宽至 600s）
   - 2.3 异步非阻塞休眠与 Tokio Worker 资源让渡机制
   - 2.4 全随机抖动指数退避算法（Full Jitter Backoff）
   - 2.5 核心契约改动与调用流转图
3. [细粒度三态断路器与主动唤醒事件总线（Tri-State Circuit Breaker）](#三细粒度三态断路器与主动唤醒事件总线tri-state-circuit-breaker)
   - 3.1 现状缺陷剖析：二态缺乏 Half-Open、静默死寂与全局 Key 污染
   - 3.2 三态断路器有限状态机设计（Closed / Open / Half-Open）
   - 3.3 (session, provider, model) 三元组严格隔离命名空间
   - 3.4 冷却期满主动唤醒机制（打破静默死寂）
   - 3.5 Half-Open 金丝雀单飞探针机制（Canary Probing）
   - 3.6 核心数据结构与持久化契约
4. [长期运行系统级资源治理与看门狗体系（Resource Watchdog System）](#四长期运行系统级资源治理与看门狗体系resource-watchdog-system)
   - 4.1 Windows 父进程探针防孤儿逃逸看门狗（Parent-Death Watchdog）
   - 4.2 卡死 Driver 挂起超时看门狗（Driver Hang Watchdog，120s 强制剥离）
   - 4.3 内存事件 O(1) 滑动窗口截断机制（Bounded Event Queue）
   - 4.4 SQLite WAL 主动检查点截断与冷热分区分表
   - 4.5 后台长程任务日志分卷轮转器（Size-Based Rolling Logger）
5. [崩溃自愈引擎与工作流补偿机制（Crash Recovery & Self-Healing Engine）](#五崩溃自愈引擎与工作流补偿机制crash-recovery--self-healing-engine)
   - 5.1 现状分析：基于 SQLite events SSOT 的“安全收尸”局限性
   - 5.2 声明式崩溃断点自动复活编排器（Resurrection Orchestrator）
   - 5.3 崩溃复活与自愈全景流程图（Mermaid）
   - 5.4 工作流 Misfire 执行补偿引擎（Workflow Misfire Engine）
   - 5.5 声明式常驻后台服务守护器（Daemon Supervisor）
6. [自驱动事件调度与队列防丢加固（Autonomous Drive Pipeline）](#六自驱动事件调度与队列防丢加固autonomous-drive-pipeline)
   - 6.1 废除 Poison-pill 毒丸清理：未决事件死信/延迟队列隔离
   - 6.2 WakeWatcher 预装载唤醒直注机制（Prompt Preloading）
   - 6.3 消除 Empty-Inject Round 反模式：纯净挂起（Pure Suspend）
   - 6.4 解耦 Goal 模式硬编码上限：进展检测与滑动租约续订
7. [待删除代码与废弃机制清单（Deprecated & Removed Code Inventory）](#七待删除代码与废弃机制清单deprecated--removed-code-inventory)
8. [模块变更与文件契约矩阵（Implementation Matrix）](#八模块变更与文件契约矩阵implementation-matrix)
9. [立体验证与自动化门禁断言设计（Verification & Quality Gates）](#九立体验证与自动化门禁断言设计verification--quality-gates)

---

## 一、方案定位与核心设计哲学

### 1.1 背景与现状评估：三大系统性死穴

在对 Conex / Crish 代码库的深度审查中（参见 docs/continuous-execution-hardening/analysis/06-autonomous-drive-and-resilience.md），系统在长周期自治执行场景下存在三大系统性死穴：

`
+---------------------------------------------------------------------------------------------------+
|                                  三大系统性死穴与脆化链条                                         |
+---------------------------------------------------------------------------------------------------+
|  [死穴 1：网络与熔断死锁]                                                                         |
|  供应商 429 Retry-After (300s) > 硬编码总预算 (180s) ----> 误杀 FatalStreamError                 |
|  连续失败触发熔断 ----> 冷却 300s 过去 ----> 无唤醒事件总线 ----> 系统永久死寂 (Silent Death)     |
|  全局静态 Key provider_fail_streak ----> 单模型故障 ----> 连坐备选模型与全会话                  |
+---------------------------------------------------------------------------------------------------+
|  [死穴 2：资源失控与排他锁冻结]                                                                   |
|  Windows Job Object 嵌套失败 ----> 仅 warn 降级 ----> 宿主退出子进程孤儿逃逸                      |
|  底层 Driver 死锁/挂起 ----> driver_finished() == false ----> 孤儿回收器巡检盲区                 |
|  ----> SessionSerialGuard 永久锁死 ----> 会话新任务全面拒绝                                       |
|  LoopState.events 内存无限追加 ----> 24h 内存从 50MB 暴增至数 GB ----> OOM 被 OS 强制 SIGKILL     |
+---------------------------------------------------------------------------------------------------+
|  [死穴 3：异常宕机断裂]                                                                           |
|  系统重启 ----> RestoreManager 安全收尸 (Failed: daemon-restarted) ----> 无断点复活机制           |
|  ----> 长程自驱任务彻底死亡，需人工重新派发                                                       |
|  停机期间错过 Cron 定时时刻 ----> 重新计算下次时间推到明天 ----> 调度静默漏跑 (Silent Miss)       |
+---------------------------------------------------------------------------------------------------+
`

### 1.2 架构设计红线与反打补丁铁律

为根除上述隐患，本重构方案恪守以下五大不可突破的技术铁律：

1. **绝对禁止局部 if-else 补丁与魔术数字**：
   - 严禁在发生错误处临时添加 	hread::sleep、修改局部局部超时变量或写死特定供应商的特例判断。
   - 所有网络退避、熔断控制、进程看门狗必须抽象为独立可测试的数学状态机与资源守卫类。
2. **单一真实事实源（Single Source of Truth, SSOT）原则**：
   - 会话状态、断路器状态、常驻服务声明、未消费事件必须严格依托 SQLite 底层持久化，内存仅作为性能优化的只读视图或受控滑动窗口。
   - 严禁出现“内存认为运行中、数据库认为失败”或“内存清空、事件实际丢失”的状态撕裂。
3. **状态机完全闭环与对称性**：
   - 任何进入“挂起/等待/阻塞/熔断”的状态，**必须具备明确的超时退出路径和主动事件唤醒通道**，彻底消除无通知的“静默死寂”。
   - 任何获取的系统资源（进程、文件句柄、排他互斥锁），必须具备租约时限（Lease）与心跳看门狗强制剥离机制，杜绝永久霸占。
4. **资源有界化（Bounded Resources, (1)$ Complexity）**：
   - 运行态内存占用、队列长度、日志文件大小必须在编译期与架构层有数学上界的严格约束。
   - 无论任务无人值守运行 2 小时、24 小时还是 30 天，核心引擎的内存与磁盘开销必须被锁死在常数区间内。
5. **立体验证硬门禁**：
   - 方案设计必须包含针对极端网络混沌（丢包、长时间限流、惊群）、进程强制杀灭（kill -9）、父进程暴毙的穷举测试与现场自动化断言，禁止脱离现场凭空推断。

### 1.3 全景系统韧性拓扑架构

加固重构后的 Conex / Crish 弹性容灾与看门狗整体架构如下：

`mermaid
flowchart TD
    subgraph NetworkResilience [网络弹性与容灾子系统]
        N1[HTTP / SSE 响应] --> N2{Status Code?}
        N2 -- 200 OK --> N3[正常消费 / 清零失败计数]
        N2 -- 429 RateLimit --> N4[解析 Retry-After 头]
        N4 --> N5[动态延展预算至 min 600s]
        N5 --> N6[Full Jitter 指数退避]
        N6 --> N7{等待时间 > 10s?}
        N7 -- 是 --> N8[挂起让渡 Tokio Worker / 注册定时器]
        N7 -- 否 --> N9[tokio::time::sleep 带 Abort 监听]
        N2 -- 5xx / Network Timeout --> N10[瞬态错误退避重试]
        N10 --> N11{连续失败达到阈值 6 次?}
        N11 -- 否 --> N6
        N11 -- 是 --> N12[触发三态断路器: Closed -> Open]
    end

    subgraph CircuitBreakerSubsystem [细粒度三态断路器]
        N12 --> CB1[命名空间隔离: cb:session:provider:model]
        CB1 --> CB2[自动注册 300s 冷却定时器]
        CB2 --> CB3[上抛 CircuitBrokenError / 进入单模型冷却挂起]
        CB2 -. 300s 冷却到期 .-> CB4[向 SteeringQueue 注入 CooldownExpired 事件]
        CB4 --> CB5[状态转移: Open -> Half-Open]
        CB5 --> CB6[放行单一 Canary 金丝雀探针]
        CB6 -- 探针成功 --> CB7[状态重置: Half-Open -> Closed / 恢复流量]
        CB6 -- 探针失败 --> CB8[弹回 Open / 冷却惩罚翻倍]
    end

    subgraph ResourceWatchdogs [长期运行系统级看门狗]
        W1[子进程创建] --> W2{Job Object 绑定成功?}
        W2 -- 成功 --> W3[Job 句柄持有]
        W2 -- 失败/受限 --> W4[拉起 Parent-Death Watchdog 线程]
        W4 --> W5[OpenProcess(SYNCHRONIZE, parent_pid) 监听]
        W5 -. 父进程意外死亡 .-> W6[级联强制树杀 terminate_process_tree]

        D1[后台 Driver 运行] --> D2[定期上报活跃心跳 last_heartbeat_ms]
        D3[reap_orphan_runs_round] --> D4{driver_finished == true?}
        D4 -- 是 --> D5[标准孤儿收割]
        D4 -- 否 --> D6{now - last_heartbeat > 120s?}
        D6 -- 超时卡死 --> D7[强行调用 driver.abort() 剥离卡死任务]
        D7 --> D8[强制释放 SessionSerialGuard 会话锁 / 状态置 Failed]

        M1[流式事件到达] --> M2[BoundedEventQueue(容量 64) 滑动更新]
        M2 --> M3[全量事件同步写入 SQLite events SSOT 表]

        DB1[后台维护定时器] --> DB2[每小时执行 PRAGMA wal_checkpoint(TRUNCATE)]
        DB2 --> DB3[物理截断 .db-wal / 避免磁盘膨胀]

        L1[后台进程日志输出] --> L2[RollingFileWriter(单卷 10MB)]
        L2 --> L3[超限滚动切割 / 保留 3 卷备份 / 淘汰老文件]
    end

    subgraph CrashRecovery [崩溃自愈与工作流补偿]
        C1[引擎启动初始化] --> C2[RestoreManager: 扫描未终态 Runs]
        C2 --> C3[状态收敛标记为 Failed(daemon-restarted)]
        C3 --> C4[Resurrection Orchestrator: 检查 auto_resume / Goal]
        C4 -- 具备续跑条件 --> C5[从 SQLite 提取最近 Snapshot 与事件尾]
        C5 --> C6[生成 RunResumptionEvent 注入 SteeringQueue]
        C6 --> C7[调度器重新拉起恢复 Episode 续跑]

        SCH1[工作流定时调度] --> SCH2[开机对比 last_executed_ms 与 now]
        SCH2 --> SCH3{停机期间是否错过 Cron?}
        SCH3 -- 命中错过 --> SCH4{评估 MisfirePolicy}
        SCH4 -- FireImmediately --> SCH5[立即补发执行一次]
        SCH4 -- RunOnceIfWithin --> SCH6[容忍窗口内补发 / 超窗跳过]
        SCH4 -- SkipMissed --> SCH7[静默跳过对齐下一周期]

        DS1[常驻服务启动] --> DS2[查询 daemon_registrations 期望状态]
        DS2 --> DS3[DaemonSupervisor 声明式重新拉起常驻进程]
    end
`

---

## 二、自适应弹性网络重试体系（Dynamic RateLimit & Full Jitter）

### 2.1 瞬态网络错误分级契约（Transient vs. Fatal）

在与大语言模型供应商通信的过程中，网络故障与 HTTP 异常必须具备精确、确定性的语义分类，严禁将所有错误混为一谈。分类契约定义于 conex_types::error::ProviderErrorKind：

`
ust
// 错误分级契约定义
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = snake_case)]
pub enum ProviderErrorKind {
    /// 瞬态限流：上游触发 RPM / TPM / 额度并发限制（HTTP 429），可退避重试
    RateLimit,
    /// 瞬态网关错误：上游代理或网关抖动（HTTP 502, 503, 504），可退避重试
    GatewayTransient,
    /// 瞬态网络超时：TCP 连接超时、TLS 握手超时、读超时，可退避重试
    NetworkTimeout,
    /// 瞬态连接重置：Client ECONNRESET、Broken Pipe、连接被对端关闭，可退避重试
    ConnectionReset,
    /// 致命认证失败：API Key 错误、权限不足、账号封禁（HTTP 401, 403），绝对不可重试
    AuthenticationFatal,
    /// 致命参数错误：Prompt 超长导致上下文溢出、Schema 不合法（HTTP 400），不可重试
    InvalidRequestFatal,
    /// 致命模型不存在：指定 Model 弃用或无权限访问（HTTP 404），不可重试
    ModelNotFoundFatal,
    /// 致命资源配额耗尽：账户欠费、月度账单用尽（HTTP 402 / QuotaExceeded），不可重试
    QuotaExhaustedFatal,
}

impl ProviderErrorKind {
    /// 判断是否属于可自动恢复的瞬态错误
    pub fn is_transient(&self) -> bool {
        matches!(
            self,
            ProviderErrorKind::RateLimit
                | ProviderErrorKind::GatewayTransient
                | ProviderErrorKind::NetworkTimeout
                | ProviderErrorKind::ConnectionReset
        )
    }
}
`

### 2.2 429 RateLimit 动态重试预算延展机制

#### 根因剖析与数学冲突
在 crates/session-loop/src/loop/handlers/stream_error_retry.rs 的既有实现中：
- 硬编码了默认总预算 RETRY_TOTAL_BUDGET_MS = 60_000（或部分配置为 180,000ms）；
- 当上游供应商返回标准 HTTP 429 响应并附带 Retry-After: 300 时，计算出的单次等待为 300,000ms；
- 代码在首轮直接校验 lapsed_ms + wait > total_budget（
#### 动态预算延展模型
为了消除上述硬编码截断，设计**基于 Retry-After 的动态弹性预算延展契约（Dynamic Budget Elastic Expansion）**：

T_{	ext{effective\_budget}} = \max\left(T_{	ext{configured\_budget}},\, \min\left(T_{	ext{max\_elastic\_cap}},\, T_{	ext{retry\_after}} + T_{	ext{safety\_margin}}ight)ight)

参数基线定义：
- {	ext{configured\_budget}}$：配置的基础预算，默认 \,000	ext{ ms}$（3 分钟）；
- {	ext{safety\_margin}}$：安全缓冲余量，固定为 \,000	ext{ ms}$（30 秒），用于吸收网络延迟与连接建立耗时；
- {	ext{max\_elastic\_cap}}$：动态延展绝对上限，放宽至 \,000	ext{ ms}$（10 分钟）；
- 当上游无明确 Retry-After 时，预算维持 {	ext{configured\_budget}}$。

`
ust
// crates/session-loop/src/loop/handlers/stream_error_retry.rs 重构算法

pub const DEFAULT_TOTAL_BUDGET_MS: u64 = 180_000;      // 基础预算 3 分钟
pub const MAX_ELASTIC_BUDGET_CAP_MS: u64 = 600_000;    // 动态弹性上限 10 分钟 (600s)
pub const RATE_LIMIT_SAFETY_MARGIN_MS: u64 = 30_000;   // 弹性裕量 30 秒

/// 计算动态自适应重试等待时长与有效预算
pub fn calculate_elastic_retry_delay(
    kind: ProviderErrorKind,
    attempt: u32,
    retry_after_ms: Option<u64>,
    elapsed_ms: u64,
    base_budget_ms: u64,
) -> Option<Duration> {
    // 1. 动态评估当前错误下的有效总预算
    let effective_budget_ms = match (kind, retry_after_ms) {
        (ProviderErrorKind::RateLimit, Some(after_ms)) => {
            let expanded = after_ms.saturating_add(RATE_LIMIT_SAFETY_MARGIN_MS);
            base_budget_ms.max(expanded).min(MAX_ELASTIC_BUDGET_CAP_MS)
        }
        _ => base_budget_ms,
    };

    // 2. 严格预算守卫：已耗时超过有效总预算时停止重试，直接抛出 Fatal
    if elapsed_ms >= effective_budget_ms {
        return None;
    }
    let remaining_budget_ms = effective_budget_ms - elapsed_ms;

    // 3. 计算推荐等待时长（429 优先对齐 Retry-After；其它错误使用 Full Jitter 退避）
    let wait_ms = match (kind, retry_after_ms) {
        (ProviderErrorKind::RateLimit, Some(after_ms)) => {
            // 在上游要求的 Retry-After 基础上加入 0~2000ms 随机抖动，避免同批次请求再次同步撞墙
            let jitter = fastrand::u64(0..=2000);
            after_ms.saturating_add(jitter)
        }
        _ => calculate_full_jitter_backoff(attempt, RETRY_BACKOFF_BASE_MS, RETRY_MAX_DELAY_MS),
    };

    // 4. 等待时长不得超过剩余预算
    let final_wait_ms = wait_ms.min(remaining_budget_ms);
    Some(Duration::from_millis(final_wait_ms))
}
`

### 2.3 异步非阻塞休眠与 Tokio Worker 资源让渡机制

长程 429 等待时间可能长达数十秒甚至几百秒。若在 Tokio Worker 线程中直接执行无差别的局部异步阻塞，虽然不会堵死 OS 线程，但在长任务高并发场景下，长周期的持有会造成 Task 队列停滞与资源不可控。

为此引入**分级休眠与让渡策略**：
1. **短等待（$\le 10	ext{s}$）**：使用 	okio::select! 结合 state.abort_signal.wait_aborted() 进行高优先级响应休眠；
2. **长等待（$> 10	ext{s}$）**：
   - 会话状态机发射 ProviderDiagnosticPhase::SuspendedForRateLimit 诊断事件，向前端与可观测层明确标注挂起原因与预期恢复倒计时；
   - 让出当前执行上下文，将唤醒句柄委托给轻量级定时调度器；
   - 监听系统级强停信号（AbortSignal），支持用户在 5 分钟漫长等待期间随时主动中断或切换模型，杜绝“点击取消无反应”。

`
ust
// 异步让渡等待逻辑
if delay > Duration::from_secs(10) {
    tracing::info!(
        session_id = %state.machine.context().session_id,
        wait_secs = delay.as_secs(),
        进入长程 RateLimit 弹性挂起等待，释放计算槽位
    );
    emit_rate_limit_suspension_event(state, delay, classified.retry_after_ms);
}

tokio::select! {
    biased;
    _ = state.abort_signal.wait_aborted() => {
        tracing::info!(长程重试等待被用户 Abort 信号主动中断);
        return streaming_aborted(state);
    }
    _ = tokio::time::sleep(delay) => {
        tracing::debug!(弹性重试等待到期，重新唤醒执行上下文);
    }
}
`

### 2.4 全随机抖动指数退避算法（Full Jitter Backoff）

#### 惊群效应（Thundering Herd）数学穿透
原有的确定性退避公式  = \min(M, B 	imes 2^{	ext{attempt}-1})$，在局域网断网恢复或上游网关重启瞬间，所有失败的任务将在几乎完全重合的时间点发起二次请求，形成破坏性的请求脉冲。

重构采用 AWS 架构验证的 **Full Jitter（全随机抖动）** 算法：

T_{	ext{ceiling}} = \min(M,\, B 	imes 2^{	ext{attempt}-1})
t = 	ext{rand\_uniform}(0,\, T_{	ext{ceiling}})

-  = 750	ext{ ms}$（基础退避时长）
-  = 8\,000	ext{ ms}$（单次非 429 瞬态错误等待上限）
- 全随机抖动确保在宏观上，所有重试请求在 $[0, T_{	ext{ceiling}}]$ 区间内呈现严格的均匀分布，方差最大化，彻底消除惊群峰值。

`
ust
/// 计算带有 Full Jitter 的指数退避时长
pub fn calculate_full_jitter_backoff(attempt: u32, base_ms: u64, max_ms: u64) -> u64 {
    let exponent = (attempt.max(1) - 1).min(30); // 防溢出上限 30
    let ceiling = (base_ms.saturating_mul(1u64 << exponent)).min(max_ms);
    if ceiling == 0 {
        return 0;
    }
    // 0 到 ceiling 均匀随机分布
    fastrand::u64(0..=ceiling)
}
`

### 2.5 核心契约改动与调用流转图

`mermaid
sequenceDiagram
    autonumber
    participant Engine as Session-Loop (stream_error_retry)
    participant Provider as Model Provider API
    participant Watchdog as Cooldown & Timer Watchdog
    participant UI as Desktop UI / Diagnostic Sink

    Engine->>Provider: 发送流式生成请求
    Provider-->>Engine: 返回 HTTP 429 (Retry-After: 300)
    Engine->>Engine: 解析错误分类 -> RateLimit (Retry-After: 300s)
    Engine->>Engine: 动态延展预算: min(600s, 300s + 30s) = 330s
    Engine->>Engine: 计算 Full Jitter 等待: 300s + rand(0..2s)
    Engine->>UI: 发射 ProviderDiagnostic(phase=Retry, delay=301s, remainingBudget=330s)
    Engine->>Watchdog: 注册 301s 挂起定时器 (绑定 AbortSignal)
    
    alt 用户中途点击强停
        UI->>Engine: 触发 AbortSignal
        Watchdog-->>Engine: 竞速响应 Abort
        Engine->>UI: 发射 RunAborted，立即干净退出
    else 正常等待到期
        Watchdog-->>Engine: 定时器 Tick 唤醒
        Engine->>Engine: transient_retries 计数递增
        Engine->>Provider: 发起第二次重试请求 (Canary)
        Provider-->>Engine: 返回 200 OK 流式分块
        Engine->>UI: 清除重试告警，流式正常推进
    end
`

---

## 三、细粒度三态断路器与主动唤醒事件总线（Tri-State Circuit Breaker）

### 3.1 现状缺陷剖析：二态缺乏 Half-Open、静默死寂与全局 Key 污染

在 crates/conex-run/src/run/run_retry.rs:24-77, 409-474 的既有实现中，断路器机制存在严重违背工业级韧性原则的三大架构毒点：

#### 毒点 1：二态粗暴翻转，缺乏 Half-Open 流量试探
现存系统仅有 Closed（闭合放行）和 Open（断路阻断）两个二元状态。连续失败 6 次进入 Open 后，系统在冷却期（300s）内直接拒绝所有请求；冷却期一过，系统在没有任何流量防护的情况下全量开放（直接回到 Closed）。若上游网络仍在抖动，积压的请求瞬间并发涌入，再次被打崩进入新的 5 分钟冷却，造成系统剧烈抖动与震荡。

#### 毒点 2：冷却期满后的“静默死寂”（Silent Death 漏洞）
当断路器进入 Open 状态时，当前运行态被判定为无法续跑而退出，**但系统没有向定时器或调度器注册任何主动到期事件**。
5 分钟过去后，断路器内部逻辑上虽然已经“冷却”，但系统内没有任何活跃线程或事件源知道该去拉起会话！整个无人值守任务陷入物理死寂，只有在数小时或数天后人类用户在前端手动敲击键盘输入新文本时，会话才有可能重新触发检查。对于 24/7 全天候自治场景，这意味着自主推进链条永久死亡。

#### 毒点 3：全局静态 Key 跨模型、跨会话雪崩连带
在现存代码中：
`
ust
// crates/conex-run/src/run/run_retry.rs:431-440
let streak_key = "provider_fail_streak";
let raw = db.get_session_meta(PROVIDER_FAIL_STREAK_KEY).ok().flatten();
`
该 Key 是一个全库单例的无命名空间键！它既不带 session_id，也不带具体的 provider_id 或 model。
一旦某一个特定云端模型因为欠费或临时故障连续报错 6 次触发熔断：
- 全局的 provider_fail_streak 被锁定；
- 随后即便系统拉起其他正常会话或不同任务时；
- 由于共用了无隔离的全局 Key，**所有健康模型与正常会话全部被连坐拒止**！

### 3.2 三态断路器有限状态机设计（Closed / Open / Half-Open）

为根治上述缺陷，本方案将熔断器重构为标准的**细粒度自适应三态有限状态机（Tri-State FSM）**：

`
+---------------------------------------------------------------------------------------------------+
|                            生产级细粒度三态断路器状态机状态流转图                                 |
+---------------------------------------------------------------------------------------------------+
|                                                                                                   |
|             +-------------------------------------------------------------+                       |
|             |                                                             |                       |
|             v  Canary Probe 成功 (重置失败计数为 0)                       |                       |
|       +-----------+                                                 +-----+-----+                 |
|  +--> |  Closed   | ------------- 连续失败达到阈值 (6 次) --------> |   Open    |                 |
|  |    | (全量放行)|                                                 | (全量阻断)| <-------------+ |
|  |    +-----------+                                                 +-----------+               | |
|  |                                                                        |                     | |
|  |                                                                        | 300s 冷却定时器到期 | |
|  |                                                                        | (主动投递唤醒事件)  | |
|  |                                                                        v                     | |
|  |                                                                  +-----------+               | |
|  +----------------------------------------------------------------- | Half-Open | --------------+ |
|                     Canary Probe 成功                               | (探针试探)|  Canary 探针失败|
|                     (平滑恢复为 Closed)                             +-----------+  (冷却惩罚翻倍) |
|                                                                                                   |
+---------------------------------------------------------------------------------------------------+
`

#### Mermaid 状态机图表
`mermaid
stateDiagram-v2
    [*] --> Closed: 系统启动 / 初始健康态

    state Closed {
        [*] --> Healthy
        Healthy --> FailureRecorded: 单次瞬态错误发生 (count + 1)
        FailureRecorded --> Healthy: 请求成功 (count 归零)
    }

    Closed --> Open: 连续瞬态失败 >= 阈值 (6 次)
[原子注册 300s 冷却定时器
向会话广播 CircuitTripped 诊断]

    state Open {
        [*] --> Quarantined
        Quarantined --> Quarantined: 拦截一切请求 (返回 CircuitBroken 错误)
引导调度层执行备用 Model 故障转移
    }

    Open --> HalfOpen: 300s 冷却定时器到期
[主动向 SteeringQueue 注入 CircuitBreakerCooldownExpired
唤醒会话并释放单一 Canary 许可]

    state HalfOpen {
        [*] --> CanaryProbing
        CanaryProbing --> CanaryProbing: 仅放行单一探针请求
并发其余请求排队等待结果
    }

    HalfOpen --> Closed: 金丝雀探针请求成功 200 OK
[清除失败计数与惩罚窗口
广播 CircuitRestored 恢复事件]
    HalfOpen --> Open: 金丝雀探针请求再次失败
[弹回 Open / 冷却窗口指数倍增: 300s -> 600s -> 1200s (上限 1800s)
重新注册新冷却定时器]
`

#### 状态转移精准数学矩阵表
| 现态 (State) | 触发事件 (Event) | 转移条件 (Guard) | 次态 (Next State) | 动作与副作用 (Actions & Side Effects) |
| :--- | :--- | :--- | :--- | :--- |
| **Closed** | 请求成功 (Success) | - | **Closed** | ail_count = 0，保持健康态 |
| **Closed** | 瞬态失败 (TransientFail) | ail_count + 1 < Threshold (6) | **Closed** | ail_count += 1，记录最近失败时间戳 |
| **Closed** | 瞬态失败 (TransientFail) | ail_count + 1 >= Threshold (6) | **Open** | 1. 状态翻转为 Open；<br>2. 记录 	rip_at_ms = now；<br>3. 注册 300s 冷却定时器任务；<br>4. 发射 CircuitTripped 事件 |
| **Open** | 任意请求尝试 (Request) | 
ow - trip_at < cooldown_ms | **Open** | 立即拦截并返回 Err(CircuitBroken)；不消耗 Token；不产生网络 I/O |
| **Open** | 冷却到期定时器 (TimerExpired) | 
ow - trip_at >= cooldown_ms | **Half-Open** | 1. 状态翻转为 Half-Open；<br>2. 分配 1 个 Canary 试探 Permit；<br>3. 向 SteeringQueue 注入唤醒事件打破死寂 |
| **Half-Open** | 并发请求到达 (Request) | Canary Permit 已被占用 | **Half-Open** | 挂起排队或阻断，仅等待金丝雀结果 |
| **Half-Open** | 金丝雀请求成功 (CanarySuccess) | - | **Closed** | 1. 状态重置为 Closed；<br>2. ail_count = 0，cooldown_ms = 300s；<br>3. 发射 CircuitRestored 事件 |
| **Half-Open** | 金丝雀请求失败 (CanaryFail) | - | **Open** | 1. 立即弹回 Open；<br>2. cooldown_ms = min(1800s, cooldown_ms * 2)；<br>3. 重新注册翻倍延时的冷却定时器 |

---

### 3.3 (session, provider, model) 三元组严格隔离命名空间

为彻底杜绝不同模型与会话之间的级联雪崩污染，断路器的存储与检索 Key 严格采用**结构化三元组命名空间（Tri-Tuple Namespace）**：

K_{	ext{cb}} = 	ext{format!}\Big(	ext{cb:\{session\_id\}:\{provider\_id\}:\{model\}}\Big)

- session_id：会话唯一标识符（隔离不同业务会话）；支持全局共享模式时使用 __global__；
- provider_id：服务商标识符（如 openai、nthropic、deepseek、ollama）；
- model：具体的模型 ID（如 claude-3-5-sonnet-20241022、deepseek-chat、qwen2.5-coder）。

#### 命名空间隔离收益 (严格遵守《反过度设计红线》禁令 4：严禁后台自动换模)
依据《ANTI_OVERENGINEERING_GUARDRAILS.md》禁令 4，系统**严禁在后台无感知切换至其他模型（彻底废弃 DynamicModelRouter 与 Failover）**。用户在 UI 选定了什么模型，请求就固定使用该模型。
三元组隔离的核心收益在于**防止不同会话与不同任务之间的跨会话连坐**：
1. 会话 A 的模型连续报错熔断，仅键 `cb:session_A:openai:gpt-4o` 进入冷却；
2. 其他会话不受该会话冷却干扰；
3. 会话 A 内部进入该模型的纯净挂起冷却等待，300s 到期后由系统定时器反向唤醒，继续在**当前选定模型**上执行退避重试，绝不擅自换模！

---

### 3.4 冷却期满主动唤醒机制（打破静默死寂）

打破冷却期满“静默死寂”的核心在于**反向反应式通知（Reactive Wakeup Injection）**：

1. **原子注册定时器**：
   当状态转移至 Open 的瞬间，CircuitBreakerManager 原子性地向内核定时调度中心（TimerRegistry）提交一个非持久/自愈型一次性定时任务：
   - 定时时长：cooldown_ms（默认 300,000ms）；
   - 目标主体：(session_id, provider_id, model)；
   - 触发提示词 / Payload：[System Event: CircuitBreakerCooldownExpired]。
2. **到期注入事件总线**：
   300 秒冷却时间到达后，内核定时器触发：
   - 熔断状态机被原子置为 HalfOpen；
   - 调度器构建一个结构化唤醒事件条目 SteeringInputEntry：
     `
ust
     let entry = SteeringInputEntry {
         session_id: session_id.clone(),
         source: circuit_breaker.to_string(),
         payload: format!(
             【系统自愈唤醒】模型 {provider_id}:{model} 熔断冷却期已过，进入 Half-Open 试探态，正在恢复自主执行。
         ),
         created_at_ms: now_ms(),
     };
     state.pending_queue.lock().unwrap().enqueue(entry);
     `
3. **唤醒调度与自驱接续**：
   - WakeWatcher 在后台监视器检测到 pending_queue 出现了就绪的系统事件；
   - 守卫校验通过后，自动拉起新的 Run，开始执行 Canary 探针测试；
   - **全链路实现 100% 反应式自愈，无需任何人工点击干预！**

---

### 3.5 Half-Open 金丝雀单飞探针机制（Canary Probing）

在 Half-Open 状态下，为了防止成百上千个并发请求在冷却解除后瞬间冲垮尚未完全稳定的服务提供商，必须实现**绝对原子性的金丝雀单飞控制（Canary Probe Lock）**：

`
ust
// Canary 探针许可流转
pub enum CanaryPermitOutcome {
    /// 获得金丝雀探针执行许可（仅允许一个请求）
    ProceedCanary,
    /// 状态仍处于 Open 或 Canary 探针已被他人占用，请求应被快速拦截或排队
    RejectedWaitCanary,
    /// 状态处于 Closed，完全放行
    ProceedNormal,
}

impl TriStateCircuitBreaker {
    /// 尝试获取执行许可
    pub fn try_acquire_permit(&mut self, now_ms: u64) -> CanaryPermitOutcome {
        match self.state {
            CircuitStateKind::Closed => CanaryPermitOutcome::ProceedNormal,
            CircuitStateKind::Open => {
                if now_ms.saturating_sub(self.trip_at_ms) >= self.current_cooldown_ms {
                    // 冷却到期：原子转移至 HalfOpen 并发放唯一探针
                    self.state = CircuitStateKind::HalfOpen;
                    self.canary_in_flight = true;
                    tracing::info!(key = %self.namespace_key, 断路器冷却到期，转移至 Half-Open 并派发 Canary 探针);
                    CanaryPermitOutcome::ProceedCanary
                } else {
                    CanaryPermitOutcome::RejectedWaitCanary
                }
            }
            CircuitStateKind::HalfOpen => {
                if !self.canary_in_flight {
                    self.canary_in_flight = true;
                    CanaryPermitOutcome::ProceedCanary
                } else {
                    // 已有 Canary 探针在途中，并发请求排队或拦截，避免击穿
                    CanaryPermitOutcome::RejectedWaitCanary
                }
            }
        }
    }
}
`

---

### 3.6 核心数据结构与持久化契约

在 crates/conex-run/src/run/run_retry.rs 中重写断路器核心类型体系：

`
ust
use serde::{Deserialize, Serialize};

/// 断路器三大物理状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = snake_case)]
pub enum CircuitStateKind {
    /// 闭合态：健康正常工作
    Closed,
    /// 打开态：熔断阻断，全量拦截
    Open,
    /// 半开态：试探探测中
    HalfOpen,
}

/// 细粒度三态断路器状态记录
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CircuitBreakerRecord {
    /// 三元组命名空间键: cb:{session_id}:{provider_id}:{model}
    pub namespace_key: String,
    /// 当前状态类型
    pub state: CircuitStateKind,
    /// 连续瞬态失败计数
    pub fail_streak: u32,
    /// 本轮首次失败时间戳 (epoch ms)
    pub first_fail_at_ms: u64,
    /// 最近一次失败时间戳 (epoch ms)
    pub last_fail_at_ms: u64,
    /// 熔断触发时间戳 (若处于 Open/HalfOpen)
    pub trip_at_ms: u64,
    /// 当前生效的冷却窗口时长 (ms)，支持指数翻倍 (300s -> 600s -> 1200s)
    pub current_cooldown_ms: u64,
    /// 半开态下是否存在正在飞行的金丝雀探针
    pub canary_in_flight: bool,
}

impl CircuitBreakerRecord {
    pub fn new_closed(namespace_key: String) -> Self {
        Self {
            namespace_key,
            state: CircuitStateKind::Closed,
            fail_streak: 0,
            first_fail_at_ms: 0,
            last_fail_at_ms: 0,
            trip_at_ms: 0,
            current_cooldown_ms: 300_000, // 初始 5 分钟
            canary_in_flight: false,
        }
    }

    /// 序列化存储至 SQLite session_meta
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    /// 从数据库 JSON 解析，失败时宽容 fail-open 恢复为 Closed
    pub fn from_json(key: &str, raw: Option<&str>) -> Self {
        raw.and_then(|s| serde_json::from_str::<CircuitBreakerRecord>(s).ok())
            .unwrap_or_else(|| Self::new_closed(key.to_string()))
    }
}
`

---

## 四、长期运行系统级资源治理与看门狗体系（Resource Watchdog System）

全天候无人值守运行对系统资源的苛刻要求，不仅在于逻辑正确，更在于**无论跨昼夜运行多久，系统资源消耗必须被锁定在确定的有界常数内（(1)$ Bound）**。针对孤儿进程逃逸、卡死调度器锁死、内存无界膨胀、WAL 检查点停滞以及日志爆盘五大现实威胁，本方案设计了多层防御看门狗体系。

`
+---------------------------------------------------------------------------------------------------+
|                            多层防逃逸与长期运行资源治理看门狗矩阵                                 |
+---------------------------------------------------------------------------------------------------+
|  [层级 1：OS 进程防孤儿] Windows Parent-Death Watchdog                                            |
|  - 探针句柄: OpenProcess(SYNCHRONIZE, FALSE, parent_pid)                                          |
|  - 响应速度: 内核信号唤醒 < 50ms                                                                  |
|  - 动作: 递归级联 terminate_process_tree，确保宿主崩溃子进程零逃逸                                |
+---------------------------------------------------------------------------------------------------+
|  [层级 2：Driver 挂起看门狗] Driver Hang Watchdog                                                 |
|  - 心跳源: ActiveRun.last_heartbeat_ms 原子记录 (Turn/Event/Tool)                                 |
|  - 超时阈值: RUN_HANG_TIMEOUT_MS = 120,000ms (120 秒)                                             |
|  - 动作: driver.abort() 强行打断 Future，强制释放 SessionSerialGuard，破除会话调度死锁            |
+---------------------------------------------------------------------------------------------------+
|  [层级 3：运行时内存治理] BoundedEventQueue (容量 64)                                             |
|  - 内存占用: 锁定常数级 O(1)，淘汰事件由 SQLite events SSOT 承载                                  |
|  - 访问路径: 前端历史浏览走 IPC 分页懒加载，内存零泄漏                                            |
+---------------------------------------------------------------------------------------------------+
|  [层级 4：存储持久化治理] SQLite Active WAL Truncator                                             |
|  - 触发策略: 每 1 小时或 WAL > 20MB 时主动执行 PRAGMA wal_checkpoint(TRUNCATE)                    |
|  - 收益: 彻底消除 Checkpoint Starvation，WAL 文件大小维持在受控区间                               |
+---------------------------------------------------------------------------------------------------+
|  [层级 5：磁盘写入治理] Size-Based Rolling Logger                                                 |
|  - 分卷规格: 单卷 10MB，保留 3 卷历史 (.log.1, .log.2, .log.3)                                    |
|  - 淘汰策略: 基于物理字节严格计数，写满自动淘汰，杜绝磁盘爆满                                     |
+---------------------------------------------------------------------------------------------------+
`

---

### 4.1 Windows 父进程探针防孤儿逃逸看门狗（Parent-Death Watchdog）

#### 逃逸机理与现状分析
在 pps/agent-workbench/src-tauri/src/process/job_windows.rs:59-68 中，系统尝试调用 Windows API AssignProcessToJobObject。但在诸多生产场景下：
1. 宿主程序运行在 CI 容器、IDE 终端、远程桌面会话或已经具备 Job 限制的受限环境中；
2. 如果宿主 Job 未开启 JOB_OBJECT_LIMIT_BREAKAWAY_OK，Windows 严禁嵌套创建子 Job，API 直接返回 ERROR_ACCESS_DENIED；
3. **现状缺陷**：代码仅打印 warn!("assign daemon task to job failed; 孤儿保护降级")，随后放行子进程启动！
4. **后果**：宿主程序被意外杀掉或崩溃后，子进程（如消耗 100% CPU 的构建脚本或 Python 爬虫）在后台无限脱轨运行。

#### 工业级防孤儿双防线架构设计 (彻底剔除父进程内监控线程)
原方案中在宿主父进程内启动线程监控自身 PID 的做法存在严重常识错误（父进程被 SIGKILL 瞬间监控线程连带消亡）。重构确立**内核级 Job Object 与独立子进程 Wrapper 双防线**：

1. **第一防线：Windows 原生 Job Object 铁壁 (95% 场景)**：
   在派生子进程时传入 `CREATE_SUSPENDED`，创建 Job Object 并配置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，将进程挂入 Job 后再 `ResumeThread`。Windows 内核确保父进程句柄关闭瞬间内核自动强杀整棵子进程树，实现 0 逃逸。
2. **第二防线：嵌套受限环境独立子进程 Wrapper 探针**：
   若遇 `ERROR_ACCESS_DENIED`（CI 或已在受限 Job 中），通过独立极简进程 `conex-process-guard.exe` 作为中间 Supervisor 启动子进程；Wrapper 独立持有父进程句柄并在独立进程边界内等待信号，父进程暴毙立即由 Wrapper 递归强杀子进程树并自裁。

---

### 4.2 卡死 Driver 挂起超时看门狗（Driver Hang Watchdog，120s 强制剥离）

#### 会话排他锁死锁盲区穿透
在 crates/conex-run/src/run/run_commands.rs:887 中：
`
ust
for (run_id, active) in candidates {
    if !active.driver_finished() {
        // 驱动任务仍在跑：清零去抖，不收割
        state.orphan_debounce.lock().unwrap().remove(&run_id);
        continue;
    }
    // ...
}
`
**致命死锁场景**：
- 底层 Driver 在执行网络读取、调用外部工具进程、等待无超时 Channel 或陷入不可控死循环时，driver_finished() **永远返回 alse**；
- 孤儿回收器由于 !active.driver_finished() 的拦截，永远无法介入回收；
- 该僵死 Run 永久持有着底层的 SessionSerialGuard 会话排他串行锁；
- 此后该会话中发起的一切操作、定时工作流触发与 WakeWatcher 反应式唤醒，全部被 session_busy 逻辑拦截拒止，会话永久死锁！

#### 挂起超时强制剥离机制
在 ActiveRun 中注入原子心跳，并在回收巡检中加入 **120 秒挂起超时断言（Driver Hang Watchdog）**：

`
ust
// 1. 在 ActiveRun 引入原子心跳
pub struct ActiveRun {
    // ...
    pub last_heartbeat_ms: std::sync::atomic::AtomicU64,
    pub driver_join_handle: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl ActiveRun {
    /// 驱动循环每推进一个 Turn、消费一次事件或执行工具时刷新心跳
    pub fn touch_heartbeat(&self) {
        self.last_heartbeat_ms.store(
            conex_shared::time::now_millis() as u64,
            std::sync::atomic::Ordering::Relaxed,
        );
    }
}

// 2. 在 reap_orphan_runs_round 中接入挂起看门狗判定 (解除 120s 误杀 600s 弹性重试)
pub const RUN_HANG_TIMEOUT_MS: u64 = 120_000; // 120 秒无心跳判定为卡死挂起

pub async fn reap_orphan_runs_round(state: &Arc<CoreRunState>) {
    let now = conex_shared::time::now_millis() as u64;
    let candidates = state.active_runs.lock().unwrap().clone();

    for (run_id, active) in candidates {
        let is_finished = active.driver_finished();
        let last_beat = active.last_heartbeat_ms.load(std::sync::atomic::Ordering::Relaxed);
        let suspended_until = active.suspended_until_ms();

        // 核心加固：动态租约判定与看门狗豁免
        let is_hung = if let Some(until_ms) = suspended_until {
            if now < until_ms {
                // 处于合法挂起租约期内（如正在等待 300s 的 429 Retry-After）：
                // 看门狗绝对放行，严禁误杀！
                false
            } else {
                // 挂起租约已到期，但 Driver 超过 120s 仍未唤醒恢复心跳：判定为真正的卡死挂起
                now.saturating_sub(until_ms) > RUN_HANG_TIMEOUT_MS
            }
        } else {
            // 常规活跃态：超过 120 秒无心跳，判定为卡死挂起
            !is_finished && (now.saturating_sub(last_beat) > RUN_HANG_TIMEOUT_MS)
        };

        if !is_finished && !is_hung {
            continue;
        }

        if is_hung {
            tracing::error!(
                run_id = %run_id,
                session_id = %active.session_id,
                idle_secs = (now - last_beat) / 1000,
                "[WATCHDOG ALARM] 检测到 Driver 卡死挂起超过容限！强制执行 Future 打断与排他锁剥离"
            );
            if let Ok(mut guard) = active.driver_join_handle.lock() {
                if let Some(handle) = guard.take() {
                    handle.abort();
                }
            }
            active.abort_signal.abort();
            active.control_bus.lock().unwrap().force_cancel("driver_hung_watchdog_timeout");
        }

        finalize_orphan_run(state, &active).await;
        
        state.pending_queue.lock().unwrap().enqueue(SteeringInputEntry {
            session_id: active.session_id.clone(),
            source: "watchdog".to_string(),
            payload: "【系统自愈通知】前序运行任务因超过 120s 未响应被看门狗安全终止，排他锁已释放，会话恢复就绪。".to_string(),
            created_at_ms: now,
        });
    }
}
`

---

### 4.3 事件持久化完整性与真源内存治理 (撤销 BoundedEventQueue 暴力截断)

经源码实证，`LoopState.events: Vec<AgentEvent>` 是单 Run 内部的累加器，在 Run 结束时全部通过 `std::mem::take` 转交 `orchestrator::drive_outcome` 持久化至 SQLite `events` 表。
**坚决撤销对 `LoopState.events` 强加 64 容量截断的设计**（防止丢弃单 Run 早期 `AgentStart`、`TurnStart`、`ToolCall` 造成持久化事实破坏）。

真正的跨昼夜长程内存治理聚焦于：
1. **跨 Run 会话历史 LRU 缓存 (`SessionHistoryCache`)**：常驻内存限制最多 16 个活跃会话，超限走 SQLite 按需水合；
2. **极端单 Run 超大回合增量流式刷盘**：在 `turn_complete` 边界支持已成对闭环事件增量刷盘；
3. **前端分页懒加载**：历史浏览走 IPC 分页，内存开销常数级锁定。

---

### 4.4 SQLite WAL 主动检查点截断与冷热分区分表

#### Checkpoint Starvation 隐患
SQLite 在 WAL 模式下默认在 WAL 达到 1000 页时尝试被动检查点。然而在无人值守全天候运行环境下，ReaderPool（8 连接）可能经常执行长耗时检索，只要存在一个未提交的读事务跨越了 WAL 检查点边界，被动检查点便无法将数据回写主库并截断 WAL，导致 .db-wal 文件膨胀数 GB，读写性能断崖式下跌。

#### 主动维护协程（Active WAL Truncator）
在后台注册周期性存储治理任务（每 1 小时或当 .db-wal 物理大小超过 20MB 时触发）：

`
ust
// crates/conex-db/src/maintenance.rs

pub async fn execute_wal_maintenance(db: &LocalDb) -> Result<(), DbFailure> {
    let wal_path = db.path().with_extension("db-wal");
    let wal_size = std::fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);

    // 当 WAL 文件超过 20MB 或定时触发时
    if wal_size > 20 * 1024 * 1024 {
        tracing::info!(wal_size_mb = wal_size / (1024 * 1024), "执行 SQLite WAL 主动截断检查点");
        
        // 使用 TRUNCATE 模式：将 WAL 帧全部同步回主库并将 .db-wal 物理截断为 0 字节
        let conn = db.writer_connection().lock().await;
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|e| DbFailure::new(DbFailureKind::Io, format!("wal_checkpoint failed: {e}")))?;
    }
    Ok(())
}
`

#### 冷热数据留存归档策略（Retention Policy）
- 对已处于终态（Completed / Cancelled / Failed）超过 30 天的非活跃会话，将其在 vents 表中的记录批量转储至 vents_archive 归档表；
- 主表建立 idx_events_session_seq (session_id, sequence) 复合索引，保持主库轻盈高效。

---

### 4.5 后台长程任务日志分卷轮转器（Size-Based Rolling Logger）

后台任务（ackground_task）常运行持续数天的守护进程或高频日志工具。现存 g_log.rs 仅每 512 行检查一次，且 Windows 下读者文件占用容易造成重命名冲突。

重构引入**基于严格字节上限的分卷轮转写入器 RollingFileWriter**：

`
ust
// apps/agent-workbench/src-tauri/src/process/rolling_log.rs

pub const LOG_ROLLING_MAX_BYTES: u64 = 10 * 1024 * 1024; // 单卷 10MB
pub const LOG_MAX_BACKUP_INDEX: u32 = 3;                  // 保留 3 卷历史备份 (.log.1, .log.2, .log.3)

pub struct RollingFileWriter {
    base_path: std::path::PathBuf,
    current_file: std::fs::File,
    current_bytes: u64,
}

impl RollingFileWriter {
    pub fn write_line(&mut self, line: &[u8]) -> std::io::Result<()> {
        let incoming = line.len() as u64;
        if self.current_bytes + incoming > LOG_ROLLING_MAX_BYTES {
            self.roll_over()?;
        }
        self.current_file.write_all(line)?;
        self.current_bytes += incoming;
        Ok(())
    }

    /// 执行分卷轮转：.log.2 -> .log.3, .log.1 -> .log.2, .log -> .log.1
    fn roll_over(&mut self) -> std::io::Result<()> {
        self.current_file.flush()?;
        drop(&self.current_file); // 显式释放当前文件句柄，避免 Windows 占用阻碍 rename

        for i in (1..=LOG_MAX_BACKUP_INDEX).rev() {
            let src = if i == 1 {
                self.base_path.clone()
            } else {
                self.base_path.with_extension(format!("log.{}", i - 1))
            };
            let dst = self.base_path.with_extension(format!("log.{}", i));
            if src.exists() {
                let _ = std::fs::rename(&src, &dst); // 容错重命名
            }
        }

        // 重新创建崭新的 .log 文件
        self.current_file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&self.base_path)?;
        self.current_bytes = 0;
        Ok(())
    }
}
`
- 单个后台任务物理磁盘占用上限被刚性锁死为：	ext{MB} 	imes (1 + 3) = 40	ext{MB}$；
- 无论后台进程吐出多少千兆字节日志，物理存储永不耗尽。

---

## 五、崩溃自愈引擎与工作流补偿机制（Crash Recovery & Self-Healing Engine）

### 5.1 现状分析：基于 SQLite events SSOT 的“安全收尸”局限性

在 crates/orchestrator/src/restore_manager.rs:1-250 中，现有架构已经建立了基于 SQLite vents 单一事实真理（SSOT）的崩溃收敛逻辑：
1. 扫描崩溃前处于 Running 或 Starting 状态的所有未决 Run；
2. 为悬挂在途的工具调用补齐合成的 ToolCallFailed(reason: "daemon-restarted") 事件，确保状态机对称闭合；
3. 将未闭合的 Run 状态更新为 Failed(INTERRUPTED_ERROR)，释放资源。

**致命局限性**：
现存设计高度定位于**“安全收尸”（Safe Burial）**——它能防止数据库产生脏数据，但**完全缺失“死后复活”能力**！
对于无人值守运行的长程自驱任务（如持续数小时的代码库重构、批量分析、全天候巡检），一旦宿主经历 Windows 自动更新重启、偶发断电或 OOM 崩溃，系统重启后直接将任务判为永久死刑，必须等待人类重新手动下发指令。

---

### 5.2 声明式崩溃断点自动复活编排器（Resurrection Orchestrator）

为实现真正意义上的无人值守连续运转，本方案引入**声明式崩溃断点自动复活编排器（Resurrection Orchestrator）**：

`
+---------------------------------------------------------------------------------------------------+
|                            崩溃断点复活与自愈 Episode 推进闭环                                    |
+---------------------------------------------------------------------------------------------------+
|  [宿主崩溃与冷启动]                                                                               |
|  RestoreManager 调和完成 ----> 识别具备 auto_resume=true 或未完成 Goal 的长任务                   |
|                                     |                                                             |
|                                     v                                                             |
|  [检查点与断点重构]                                                                               |
|  从 SQLite 提取最近一次 Snapshot + 交互断点 + 崩溃前最终工具产出摘要                              |
|                                     |                                                             |
|                                     v                                                             |
|  [复活指令注入]                                                                                   |
|  合成 RunResumptionEvent ----> 原子压入 SteeringQueue                                             |
|                                     |                                                             |
|                                     v                                                             |
|  [自驱续跑 Episode]                                                                               |
|  调度器拉起新 Run ----> 注入完整复活 Prompt: "【系统断点自愈续跑】检测到任务意外中断..."          |
|  ----> 模型在首回合直接感知中断点，无缝接续既定目标继续推进！                                     |
+---------------------------------------------------------------------------------------------------+
`

#### 核心复活调度契约
在 crates/orchestrator/src/resurrection.rs 中实现复活协调器：

`
ust
pub struct ResurrectionOrchestrator {
    db: Arc<LocalDb>,
    queue: Arc<Mutex<SteeringQueue>>,
}

impl ResurrectionOrchestrator {
    /// 扫描并复活被打断的长程自治任务
    pub async fn auto_resurrect_interrupted_runs(&self) -> Result<usize, RestoreError> {
        let interrupted_runs = self.db.find_interrupted_resumable_runs().await?;
        let mut resurrected_count = 0;

        for run in interrupted_runs {
            tracing::info!(
                run_id = %run.run_id,
                session_id = %run.session_id,
                "[RESURRECTION ENGINE] 发现异常中断的自治任务，准备执行断点自愈续跑"
            );

            // 1. 提取该任务在中断前的最后状态上下文与有效检查点
            let checkpoint = self.db.get_last_valid_checkpoint(&run.session_id).await?;
            let last_goal = self.db.get_active_goal_context(&run.session_id).await?;

            // 2. 构建结构化复活自愈提示词
            let resumption_prompt = format!(
                "【系统断点自愈通知】系统经历意外重启，检测到前序长程任务被中断。\n\
                 - 原始任务目标: {}\n\
                 - 中断前已完成轮次: {}\n\
                 - 最近检查点状态: {}\n\
                 系统已自动恢复上下文与未决事件，请核对当前环境并继续推进未完成目标。",
                last_goal.unwrap_or_else(|| "持续自治任务".to_string()),
                checkpoint.turn_index,
                checkpoint.summary.unwrap_or_else(|| "已记录最新状态".to_string())
            );

            // 3. 将复活事件原子注入会话队列
            let entry = SteeringInputEntry {
                session_id: run.session_id.clone(),
                source: "resurrection_engine".to_string(),
                payload: resumption_prompt,
                created_at_ms: conex_shared::time::now_millis() as u64,
            };
            self.queue.lock().unwrap().enqueue(entry);
            resurrected_count += 1;
        }

        Ok(resurrected_count)
    }
}
`

---

### 5.3 崩溃复活与自愈全景流程图（Mermaid）

`mermaid
sequenceDiagram
    autonumber
    participant Host as OS / Host Environment
    participant Boot as Engine Bootstrap (main.rs)
    participant Restore as RestoreManager
    participant Resurrect as Resurrection Orchestrator
    participant Queue as SteeringQueue
    participant Watcher as WakeWatcher
    participant LLM as Model Provider

    Host->>Boot: 进程冷启动 / 宕机后重新拉起
    Boot->>Restore: 执行 restore() 调和
    Restore->>Restore: 扫描未闭环 Runs (状态为 Running)
    Restore->>Restore: 补齐 ToolCallFailed(daemon-restarted)
    Restore->>Restore: 状态单向收敛更新为 Failed(daemon-restarted)
    
    Boot->>Resurrect: 执行 auto_resurrect_interrupted_runs()
    Resurrect->>Resurrect: 查询具备 auto_resume=true 的中断 Run
    Resurrect->>Resurrect: 提取最后 Checkpoint、未完成 Goal 与事件尾
    Resurrect->>Queue: 注入 RunResumptionEvent (携带断点提示词)
    
    Watcher->>Queue: 周期轮询检测到 SteeringQueue 有未消费唤醒事件
    Watcher->>Boot: 触发 launcher.launch(initial_messages=[ResumptionPrompt])
    Boot->>LLM: 启动新 Episode 首轮请求 (携带断点上下文)
    LLM-->>Boot: 输出分析并继续调用后续工具，长程任务无缝接续推进！
`

---

### 5.4 工作流 Misfire 执行补偿引擎（Workflow Misfire Engine）

#### 停机错过调度（Silent Miss）漏洞剖析
在现存 crates/conex-run/src/workflow/schedule.rs 中：
- 定时器调度完全基于内存 Tick；
- 若用户配置了每天凌晨 03:00 执行数据备份的 Cron 任务（- 宿主机在 02:30 维护关机并在 03:30 重新开机；
- 现有代码在 03:30 启动时计算 schedule.next_trigger_after(current_boot_time)，直接将下次执行时间推到**次日 03:00**；
- 03:00 的任务在没有任何日志告警或补发的情况下被**静默漏执行**！

#### Misfire 策略体系设计
在 WorkflowScheduleWire 与数据模型中引入工业级标准的 **Misfire 处理策略枚举**：

`
ust
// crates/conex-run/src/workflow/schedule.rs

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = camelCase)]
pub enum MisfirePolicy {
    /// 立即补发执行一次（默认）：开机时检测到错过，立即补发一轮执行，随后按原周期继续
    FireImmediately,
    /// 静默跳过：不补发，直接对齐下一个自然周期
    SkipMissed,
    /// 容忍窗口内补发：若当前时间距原触发时间在指定容忍时长（如 2 小时）内，则补发；超窗则跳过
    RunOnceIfWithinMinutes { tolerance_minutes: u64 },
}
`

#### 启动对账与补发执行逻辑
在工作流调度器启动初始化阶段，执行 Misfire 对账扫描：

`
ust
// crates/conex-run/src/workflow/backend.rs

pub async fn reconcile_workflow_misfires(&self) -> Result<usize, WorkflowError> {
    let now = conex_shared::time::now_millis() as u64;
    let workflows = self.store.list_active_workflows().await?;
    let mut compensated_count = 0;

    for wf in workflows {
        let Some(last_run_ms) = wf.last_executed_at_ms else {
            continue;
        };
        // 计算从 last_run_ms 到 now 之间理论上应当触发的时刻
        if let Some(expected_trigger_ms) = wf.schedule.find_due_trigger_between(last_run_ms, now) {
            let should_fire = match wf.misfire_policy {
                MisfirePolicy::FireImmediately => true,
                MisfirePolicy::SkipMissed => false,
                MisfirePolicy::RunOnceIfWithinMinutes { tolerance_minutes } => {
                    let window_ms = tolerance_minutes * 60_000;
                    now.saturating_sub(expected_trigger_ms) <= window_ms
                }
            };

            if should_fire {
                tracing::warn!(
                    workflow_id = %wf.id,
                    expected_at = expected_trigger_ms,
                    now_ms = now,
                    [WORKFLOW MISFIRE] 补偿触发因停机错过的定时工作流任务
                );
                self.trigger_workflow_manually(&wf.id, misfire_compensation).await?;
                compensated_count += 1;
            }
        }
    }

    Ok(compensated_count)
}
`

---

### 5.5 声明式常驻后台服务守护器（Daemon Supervisor）

针对后台长程任务中声明的 is_daemon = true 服务（如本地 Mock 服务、代码监控工具、日志转发代理）：
1. 在 SQLite 新增持久化元数据表 daemon_registrations；
2. 记录项包含：	ask_id、command、cwd、nv_vars、uto_respawn（异常退出是否重启）；
3. 宿主冷启动时，由 DaemonSupervisor 读取注册表并比对当前 OS 进程列表；
4. 缺失的常驻进程由守护器以期望状态（Desired State）声明式重新拉起并绑定 Job Object / 看门狗，确保智能体依赖的支撑环境跨重启持续可用。

---

## 六、自驱动事件调度与队列防丢加固（Autonomous Drive Pipeline）

### 6.1 废除 Poison-pill 毒丸清理：未决事件死信/延迟队列隔离

#### 致命漏洞穿透
在 crates/conex-run/src/run/run_idle.rs:1664：
`
ust
if !user_stopped_at_terminal {
    let purged = queue.clear_for_before(&session_id, terminal_ms);
}
`
该逻辑原本旨在清理无意义的残留空消息，但由于无差别地使用了 clear_for_before：
- 当一个 Run 遭遇临时网络错误或熔断退出时，排队中的**合法后台任务完成通知（Task Completed）与定时器唤醒事件被直接物理抹除**！
- 后台任务成功完成了，但系统把通知当毒丸倒掉了，自主推进链条永久断裂。

#### 死信与延迟队列隔离重构
彻底废除 clear_for_before，新增 quarantine_or_defer 隔离机制：

`
ust
// crates/orchestrator/src/steering_queue.rs

impl SteeringQueue {
    /// 废除物理清空！改用安全封存至未决事件区（Quarantine Store）
    pub fn quarantine_or_defer(&mut self, session_id: &str, terminal_ms: u64) -> usize {
        let mut quarantined = 0;
        if let Some(entries) = self.sessions.get_mut(session_id) {
            // 分流：仅剔除纯文本且无唤醒源标识的无意义空消息；
            // 带有 source=task-*、source=timer-*、source=circuit_breaker 的关键系统事件绝对不丢！
            entries.retain(|entry| {
                let is_critical_event = entry.source.starts_with(task-)
                    || entry.source.starts_with(timer-)
                    || entry.source.starts_with(circuit_breaker)
                    || entry.source.starts_with(workflow-);

                if !is_critical_event && entry.created_at_ms <= terminal_ms {
                    quarantined += 1;
                    false // 淘汰非关键旧条目
                } else {
                    true  // 关键业务事件 100% 保留！
                }
            });
        }
        quarantined
    }
}
`

---

### 6.2 WakeWatcher 预装载唤醒直注机制（Prompt Preloading）

#### 现状缺陷
在 crates/conex-run/src/wake_watcher.rs:347 与 crates/conex-run/src/run/run_retry.rs:369 中：
`
ust
idle_resume::spawn_idle_resume_run(state, sid, idle-resume, Vec::new()).await;
`
WakeWatcher 检测到了事件并拉起新 Run，但传递的初始提示词竟然是**空数组 Vec::new()**！
导致新 Run 在第 1 回合模型推理中完全看不到排队的事件内容，只能空耗一轮 Token 甚至输出空白。

#### 预装载唤醒直注实现
在拉起新 Run 之前，先原子 drain 队列中就绪的事件，格式化为合成上下文消息直注首轮 Prompt：

`
ust
// 预装载直注逻辑
// 预装载唤醒预占逻辑 (二阶段事务性租约，防止网络中断时事件丢失)
let (ticket, ready_entries) = match state.pending_queue.lock().unwrap().reserve_batch(&session_id, 8, std::time::Duration::from_secs(60)) {
    Some(res) => res,
    None => return,
};

let initial_messages = if !ready_entries.is_empty() {
    let mut combined_text = String::from("【系统自驱动反应式唤醒】检测到以下后台异步事件已就绪：\n");
    for (idx, entry) in ready_entries.iter().enumerate() {
        combined_text.push_str(&format!("{}. [{}] {}\n", idx + 1, entry.source, entry.payload));
    }
    vec![AgentMessage::user(combined_text)]
} else {
    Vec::new()
};

// 携带预占载荷拉起 Run；连接推进首 Turn 后 commit_batch，若异常退出则自动 rollback!
let outcome = idle_resume::spawn_idle_resume_run(state, sid, "idle-resume", initial_messages).await;
if outcome.is_ok() {
    state.pending_queue.lock().unwrap().commit_batch(&ticket);
} else {
    state.pending_queue.lock().unwrap().rollback_batch(&ticket);
}
`

---

### 6.3 消除 Empty-Inject Round 反模式：纯净挂起（Pure Suspend）

在 crates/conex-run/src/run/run_idle.rs:86-258 的 decide_idle_resume 中：
- 若后台命令仍在运行（has_running_commands == true），但当前队列尚无任何已完成的产出；
- **重构规则**：严禁注入空 Prompt 或合成虚假的“等待中”模型调用；
- 状态机严格返回 IdleResumeDecision::Suspend，将计算线程与 GPU/Token 消耗归零；
- 会话处于纯净挂起等待态，直至后台任务真正产生退出事件并触发 Reactive Wakeup。

---

### 6.4 解耦 Goal 模式硬编码上限：进展检测与滑动租约续订

在 Goal 多步执行引擎中：
- 废除硬编码 GOAL_DEFAULT_MAX_ROUNDS = 12 与 GOAL_DEFAULT_STALLED_ROUNDS = 2；
- 配置项支持 max_rounds = 0 代表无上限连续自治模式；
- 引入**外部产出语义进展检测器（Semantic Progress Detector）**：
  只要智能体在最近轮次中产生了实质性的物理变更（如成功修改了代码文件、执行了测试命令并获得新输出、通过了门禁校验），系统自动为该 Goal 滑动续订 10 轮预算租约（Lease Renewal），支持跨昼夜无限续航。

---

## 七、待删除代码与废弃机制清单（Deprecated & Removed Code Inventory）

根据《AGENTS.md》§7「严禁打补丁」与净收敛原则，重构必须对既有代码中的硬编码、毒丸方法与缺陷分支进行物理删除与清退：

| 所在文件与行号 | 待删除/废弃的代码元素 | 废弃原因与危害说明 | 替代收敛方案 |
| :--- | :--- | :--- | :--- |
| crates/session-loop/src/loop/handlers/stream_error_retry.rs:24 | RETRY_RATE_LIMIT_MAX_DELAY_MS = 5 * 60_000 硬编码常量 | 刚性写死 5 分钟上限，无法吸收 600s 级别的高峰限流 | 替换为可延展配置 MAX_ELASTIC_BUDGET_CAP_MS = 600_000 |
| crates/session-loop/src/loop/handlers/stream_error_retry.rs:27 | RETRY_TOTAL_BUDGET_MS = 60_000 (或 180s) 刚性预算常量 | 与 300s Retry-After 发生硬冲突，首轮退避即误杀抛 Fatal | 替换为动态弹性对齐函数 calculate_elastic_retry_delay |
| crates/session-loop/src/loop/handlers/stream_error_retry.rs:55-57 | if elapsed_ms >= total_budget { return None; } 刚性阻断逻辑 | 在遇到 429 时未动态考虑 Retry-After 延展导致误杀 | 重构为动态评估 ffective_budget 后校验 |
| crates/conex-run/src/run/run_retry.rs:15 | PROVIDER_FAIL_STREAK_KEY 全局无隔离 Key | 全库共享单一键，单模型故障连座全会话与备用模型 | 替换为三元组隔离命名空间 cb:{session}:{provider}:{model} |
| crates/conex-run/src/run/run_retry.rs:24-77 | ProviderFailStreak 二态结构体 | 仅具备 count/window，缺乏 Half-Open 状态与 Canary 标记 | 替换为 CircuitBreakerRecord 与三态状态机 |
| crates/conex-run/src/run/run_commands.rs:887-895 | if !active.driver_finished() { continue; } 孤儿检测前置拦截 | 忽视 Driver 卡死/死锁情况，形成会话排他锁永久死锁盲区 | 引入 is_hung 120s 超时检测并在超时后强制 abort 剥离 |
| crates/conex-run/src/run/run_idle.rs:1664-1671 | queue.clear_for_before(&session_id, terminal_ms) 毒丸清空代码 | Run 非正常收尾时将排队的合法任务完成通知一网打尽抹除 | 替换为分类隔离保留方法 quarantine_or_defer |
| crates/conex-run/src/wake_watcher.rs:347 | 传递 Vec::new() 启动新 Run 的反模式调用 | 唤醒拉起却传空提示词，模型首回合无法感知后台就绪事件 | 改造为预先 drain_batch 并直注合成上下文消息 |
| pps/agent-workbench/src-tauri/src/process/job_windows.rs:59-68 | Job 绑定失败仅打 warn! 并继续放行的降级逻辑 | 嵌套受限或降权环境下子进程完全逃逸失控 | 引入 spawn_parent_death_watchdog 线程内核级监听强杀 |
| crates/session-loop/src/state.rs:80 | pub(crate) events: Vec<AgentEvent> 无界内存追加字段 | 24/7 长程运行数千回合事件无限堆积导致宿主 OOM 崩溃 | 改造为固定容量为 64 的 BoundedEventQueue<AgentEvent> |

---

## 八、模块变更与文件契约矩阵（Implementation Matrix）

### 8.1 涉及文件与契约变更一览

| 模块 / 文件路径 | 变更类型 | 核心改动契约与结构体定义 | 预期收益与防护目标 |
| :--- | :--- | :--- | :--- |
| crates/session-loop/src/loop/handlers/stream_error_retry.rs | 重构 | 新增 calculate_elastic_retry_delay；引入 Full Jitter；上限放宽至 600s | 消除 429 误杀；消除网络恢复瞬间的惊群效应 |
| crates/conex-run/src/run/run_retry.rs | 重构 | 实现 TriStateCircuitBreaker；引入三元组键；冷却到期注册唤醒事件 | 消除二态震荡；打破静默死寂；消除跨模型级联瘫痪 |
| crates/conex-run/src/run/run_commands.rs | 修复 | 
eap_orphan_runs_round 增加 120s 挂起判定并调用 driver.abort() | 根治卡死 Driver 导致的 SessionSerialGuard 死锁 |
| pps/agent-workbench/src-tauri/src/process/parent_watchdog.rs | 新增 | spawn_parent_death_watchdog 监听 OpenProcess(SYNCHRONIZE) | 根治 Windows 嵌套受限环境下的孤儿进程逃逸 |
| crates/session-loop/src/state.rs | 重构 | LoopState.events 采用 BoundedEventQueue（容量 64） | 内存开销从 (N)$ 降至 (1)$，消除长程 OOM |
| crates/conex-db/src/maintenance.rs | 增强 | 增加定时主动 PRAGMA wal_checkpoint(TRUNCATE) 维护任务 | 消除 WAL 检查点停滞膨胀，保障磁盘空间可控 |
| pps/agent-workbench/src-tauri/src/process/rolling_log.rs | 新增 | RollingFileWriter 实现 10MB 分卷与 3 卷备份滚动 | 防止后台长程任务无节制写入日志导致磁盘被写满 |
| crates/orchestrator/src/resurrection.rs | 新增 | ResurrectionOrchestrator 扫描中断任务并生成断点续跑 Episode | 实现宿主意外崩溃重启后的全自动无人值守续跑 |
| crates/conex-run/src/workflow/schedule.rs | 增强 | WorkflowScheduleWire 增加 MisfirePolicy（补偿、跳过、窗口） | 解决系统停机维护期间定时工作流静默漏跑问题 |
| crates/conex-run/src/run/run_idle.rs | 修复 | 废除 clear_for_before；改用 quarantine_or_defer；消除空注入 | 保护合法唤醒事件零丢失；Token 浪费降为 0 |
| crates/conex-run/src/wake_watcher.rs | 修复 | 	ick 触发时先 drain 队列唤醒事件直注 initial_messages | 彻底解决首轮空跑问题，唤醒后立即推进业务 |

---

## 九、立体验证与自动化门禁断言设计（Verification & Quality Gates）

遵循《AGENTS.md》§7.1 立体验证纪律，本方案设计三层互锁的刚性验收门禁：

`
+---------------------------------------------------------------------------------------------------+
|                            三层互锁立体验证与质量保障流水线                                       |
+---------------------------------------------------------------------------------------------------+
|  [Layer 1: 纯逻辑穷举单元测试]                                                                    |
|  U-01 (RateLimit 弹性延展)  U-02 (三态断路器状态转移)  U-03 (Canary 探针单飞锁)                   |
|  U-04 (死信事件隔离防丢)    U-05 (Misfire 补执行对账)  U-06 (Full Jitter 方差分布)                |
+---------------------------------------------------------------------------------------------------+
|  [Layer 2: 极端系统与网络混沌注入]                                                                |
|  C-01 (上游 429 300s 脉冲注入)  C-02 (主备模型 Failover 隔离)  C-03 (kill -9 宿主暴毙孤儿防逃逸)    |
|  C-04 (Driver 死锁 120s 超时强行剥离)                                                             |
+---------------------------------------------------------------------------------------------------+
|  [Layer 3: 真实环境 24/7 浸泡压力门禁]                                                            |
|  E-01 (连续 24 小时无人值守 RSS 内存增幅 <= 15%)                                                  |
|  E-02 (单任务 100GB 日志压力下物理磁盘占用 <= 40MB)                                               |
|  E-03 (随机断电式重启后 10 秒内自动复活中断 Episode 并顺利完结 Goal)                              |
+---------------------------------------------------------------------------------------------------+
`

### 9.1 核心逻辑单元测试断言（Unit Assertions）

- **断言 U-01（RateLimit 弹性扩张）**：
  构造模拟返回 Retry-After: 300 的错误，断言 calculate_elastic_retry_delay 返回的有效预算扩展至 	ext{s}$，单次等待为 	ext{s} + 	ext{jitter}$，绝对不返回 None（不抛 FatalStreamError）。
- **断言 U-02（三态断路器状态转移与主动唤醒）**：
  连续注入 6 次瞬态失败，断言状态转移至 Open；断言调度器中成功注册延时为 	ext{s}$ 的唤醒定时器；推进模拟时钟 	ext{s}$，断言定时器触发并向 SteeringQueue 注入 CircuitBreakerCooldownExpired，断路器自动翻转为 HalfOpen。
- **断言 U-03（Canary 金丝雀探针互斥）**：
  在 HalfOpen 状态下并发发起 10 个请求，断言仅有 1 个请求获得 ProceedCanary 许可，其余 9 个被 RejectedWaitCanary 拦截。
- **断言 U-04（未决事件隔离防丢）**：
  在一个 Run 非正常退出时向队列注入 3 个后台任务完成通知，断言调用 quarantine_or_defer 后，所有任务完成通知被 100% 保留，零事件物理丢失。
- **断言 U-05（Misfire 补偿策略校验）**：
  模拟宿主在工作流触发点前后停机 2 小时，断言 FireImmediately 策略开机立即补发一次，SkipMissed 策略静默跳过。
- **断言 U-06（Full Jitter 均匀分布）**：
  执行 10,000 次退避计算，断言输出时长在 $[0, T_{	ext{ceiling}}]$ 内满足均匀分布卡方检验（ > 0.05$）。

### 9.2 极端系统与网络混沌注入测试（Chaos Injection Tests）

- **测试 C-01（上游持续 429 混沌）**：
  持续拦截 API 并返回 HTTP 429 Retry-After: 120，验证系统进入长程挂起让渡，Tokio Worker 线程无卡顿，UI 正确渲染 120 秒倒计时进度条，到期自动满血重连。
- **测试 C-02（跨会话命名空间隔离验证，严格禁止自动换模）**：
  会话 A 中的 openai:gpt-4o 连续失败触发冷却挂起；立即在会话 B 中发起同一模型或独立会话请求，断言会话 B 请求独立不受会话 A 熔断连坐；同时断言系统严禁在后台自动切换至其他模型（遵循禁令 4）。
- **测试 C-03（宿主 kill -9 孤儿防逃逸）**：
  通过后台任务拉起一个持续执行的 Python 密集计算进程；在宿主未正常退出的情况下，直接通过操作系统命令 	askkill /F /PID <workbench_pid> 强制击杀宿主；断言在 100ms 内，Python 子进程及其衍生子进程被 Parent-Death Watchdog 彻底物理清除。
- **测试 C-04（Driver 卡死超时强行释放）**：
  故意在 Driver 内部构造一个永不返回的无超时 Channel 阻塞，断言在 120 秒后，
eap_orphan_runs_round 成功打断该 Future，回收 SessionSerialGuard，会话恢复就绪，后续新任务可正常拉起。

### 9.3 真实环境 24/7 浸泡压力门禁（24/7 Soak & Endurance Gate）

在真实操作系统（Windows 11 / Server 2022）中部署完整桌面版与内核，启动跨昼夜 24 小时无人值守自治巡检长任务：
- **门禁 E-01（内存常数界限守门）**：
  连续高频运行 24 小时（派发超过 3,000 个 Turn），Rust 核心引擎进程 RSS 物理内存从初始 65MB 增长后，稳定在 $\le 95	ext{MB}$，增幅 $\le 15\%$，无任何内存泄漏。
- **门禁 E-02（磁盘物理存储有界守门）**：
  后台任务持续以 1MB/s 的速率写入日志（累计写入超过 100GB），断言磁盘上该任务占用的日志文件总物理大小严格受控在 $\le 40	ext{MB}$（1 卷当前 + 3 卷备份）。
- **门禁 E-03（崩溃自愈断点复活现场验收）**：
  在一个跨阶段的长程 Goal 执行至第 4 阶段时，通过断电/强制关进程模拟操作系统崩溃；重启软件后，断言系统在 10 秒内自动检测并生成恢复 Episode，模型首回合提示词准确包含前 3 阶段完成成果，任务在无人介入下自动推进至第 5 阶段并顺利宣告胜利！
