//! 循环配置面（SR-06c · 拆分 · ≠ EL）：SessionLoopOptions（恢复阶梯上限 /
//! 钩子 / 预算 / 压缩 / 摘要调度 / 装配面）+ Default + RetryBackoffConfig；
//! 自 loop/mod.rs 拆出，经父模 re-export（crate::r#loop::SessionLoopOptions
//! 路径不 break）。

use std::sync::Arc;

use agent_tools::backup::BackupMiddleware;
use agent_tools::context::ExploreDocsQuotaContext;
use agent_tools::middleware::ToolMiddleware;
use agent_tools::note_backend::NoteBackendHandle;
use agent_tools::write_paths::WritePathRegistry;
use conex_compaction::{CompactionPolicy, Summarizer};
use conex_types::context::ContextBudget;

use crate::cache_tracker::CacheTrackingConfig;
use crate::escape_watch::EscapeWatchConfig;

use super::{RecoveryHook, TurnEndHook};
/// 循环配置（恢复阶梯上限 / 钩子；缺省值对齐 01 §2.5-2.6 与 §3.3）
#[derive(Clone)]
pub struct SessionLoopOptions {
    /// 瞬态 provider 错误重试上限（默认 3，01 §2.5 步骤 2）
    pub transient_retry_limit: u32,
    /// 瞬态重试退避配置（D1 §3.1.4 R6）：None = 现状立即重试（向后兼容）；
    /// Some = 退避 + Retry-After + 60s 总预算生效（None 字段回落常量
    /// 750/8000/60000）。壳层经 session_meta 键 `provider_retry_backoff_ms`
    /// 装配（仿 summary_dispatch META_KEY_SUMMARY_BACKOFF_MS 先例）。
    pub retry_backoff: Option<RetryBackoffConfig>,
    /// 会话级熔断计数当前值（D1 §3.2：壳层装配时读 `provider_fail_streak`
    /// 键 count 字段注入；None = 未配置熔断闸（默认，向后兼容）；
    /// Some(n) = transient_retry 入口闸——n ≥ [PROVIDER_FAIL_THRESHOLD]
    /// 时跳过 run 内重试直接 fatal（规则 C1）。计数与清零由壳层收口
    /// （S2 收口判定 + spawn_blocking 写键），内核只读注入值（02 §2-E）。
    pub provider_fail_streak: Option<u32>,
    /// length 阶梯升级上限（默认 2：8192→16384→32768）
    pub length_upgrade_limit: u32,
    /// continue nudge 上限（默认 1，01 §2.6 步骤 1）
    pub continue_nudge_limit: u32,
    /// preparing-turn / empty-response 的 steering 评估开关（默认 true，
    /// 01 §2.3 期望语义：干预性 steering 可配置关闭；false 时跳过策略
    /// 评估，empty-response 直接 stop + 诊断收场，见 T06.2.1 接线）
    pub steering_enabled: bool,
    /// lifecycle turn.end 钩子（stop 建议；与 shouldStopAfterTurn 合并时
    /// 以此为准，01 遗留问题 3）
    pub turn_end_hook: Option<Arc<dyn TurnEndHook>>,
    /// shouldStopAfterTurn 兼容层（无 turn_end_hook 时生效；01 遗留问题 3）。
    /// 生产暂无注入方，属「兼容层仅测试/编排注入用」面（T06.4.1 评审标注）
    pub should_stop_after_turn: Option<Arc<dyn TurnEndHook>>,
    /// catch 兜底恢复钩子（缺省：abort 信号 → Abort，否则 error）
    pub recovery_hook: Option<Arc<dyn RecoveryHook>>,
    /// 工具执行工作目录（ToolExecCtx 透传）
    pub cwd: Option<String>,
    /// 本次 run 的 assistant 消息客户端幂等键（03 §5.3-4：message-end 的
    /// clientMessageId 与 run-task 下发值一致，供前端 pickStableMessageId
    /// 命中本地 stream placeholder；None = 不标注，向后兼容）
    pub assistant_client_message_id: Option<String>,
    /// 工具幂等开关（默认 false，行为不变；T06.4.1 Q14 接线）。开启后
    /// AgentSessionLoop 创建 [agent_tools::idempotency::ToolIdempotencyGuard]
    /// 并注入工具执行器——同域（run_id+session_id）同参工具去重，失败不
    /// 记录、成功才落键；跨 run 生效（域与 run/session 绑定）。
    pub idempotency_enabled: bool,
    /// 工具中间件链（[agent_tools::middleware::ToolMiddleware]；审批通过后、
    /// 执行前生效，优先级语义见 tool_exec.rs 模块头注与
    /// docs/multi-agent-repair/06-tool-middleware-hook-接线决策.md）。
    /// with_options 派生同步到工具执行器。
    pub tool_middleware: Vec<Arc<dyn ToolMiddleware>>,
    /// 插件钩子注册表（[crate::hooks::HookRegistry]；turn.end /
    /// tool.pre / tool.post 广播）。with_options 派生同步到工具执行器
    /// （tool.pre / tool.post）与 turn-complete handler（turn.end）。
    pub hooks: Option<Arc<crate::hooks::HookRegistry>>,
    /// 系统提示词（P1 阶段 2：system prompt 主路径透传，B1 四层通路第二层）。
    /// 属于请求静态前缀的一部分，run 内不可变（B3 纪律：构造后整轮复用，
    /// 任何 handler 不得在 run 中途改写）；None = 不发送 system 消息，
    /// 向后兼容。壳层在装配 options 时经 build_system_prompt 规范化后存入。
    pub system_prompt: Option<String>,
    /// 预算配置（P4 阶段 2-2 / §3.3.2）：None = 不启用 max_tokens 钳制与
    /// 预检压缩（向后兼容现状）；Some = 发请求前估算上下文占用
    /// （C9 口径 input_total，usage 优先 + 启发式兜底），max_tokens 钳到
    /// window - estimate - safety。窗口元数据真源为 P3 模型目录
    /// （context_window_for），P3 未接线前由壳层经前端参数注入。
    pub context_budget: Option<ContextBudget>,
    /// 压缩策略（P4 阶段 3-2 / §3.4.2）：None = 无自动压缩（向后兼容现状）；
    /// Some = prepare_turn 阈值预检触发（estimate ≥ window - reserve）时
    /// 同步压缩。字段默认对齐 P4 §3.4.2（keep_recent_tokens 20000 /
    /// min_recent_turns 2 / max_summary_tokens 1024 / tool_pair_protection）。
    pub compaction_policy: Option<CompactionPolicy>,
    /// L2 LLM 摘要器（P4 §3.4.4，可选注入）：None = L1 静态占位符。
    /// C14 摘要请求缓存隔离（独立前缀域、无断点、无会话亲和键）由
    /// 摘要器实现方（壳层）保证——本 trait 边界只接收丢弃消息与既有摘要，
    /// 不携带任何会话/缓存亲和参数；失败降级 L1 占位符不阻塞主对话。
    pub summarizer: Option<Arc<dyn Summarizer>>,
    /// 单 run 自动压缩上限（默认 1，对齐 Reasonix compactStuck 防每轮
    /// 重写前缀，P4 §3.4.6）：**仅约束预检 / 用户消息边界 / 分阶段触发**
    /// （LoopState.compactions_this_run，E2 F2 层 2 裁决后溢出阶梯绕开
    /// 本计数——溢出自有 compression_retries 防死循环），0 = 禁用自动压缩。
    pub max_auto_compactions_per_run: u32,
    /// 溢出压缩重试上限（E2 F2 层 2 / D1 §3.5.1，默认 2）：溢出致命路径
    /// （ContextLengthExceeded 用尽 length 阶梯 / PayloadTooLarge 直入）的
    /// 压缩重试次数上限，替代常量 [MAX_OVERFLOW_COMPRESSION_RETRIES]；
    /// 0 = 溢出不压缩直接 fatal。壳层经 session_meta 键
    /// `compact_overflow_retries` 装配覆盖。
    pub compact_overflow_retries: u32,
    /// 压缩 LLM 强制门（E2 F1，默认 true）：压缩触发必须携带 Summarizer
    /// （LLM 摘要强制，禁止「纯丢弃式」线性压缩）。true = 无 Summarizer /
    /// 摘要失败时——预检/用户消息边界/manual 路径不压缩、等待 LLM 可用
    /// （发 runtime-intervention-required 事件），溢出致命路径默认直接
    /// fatal（文案含「LLM 不可用」）；false = 显式允许 stub 降级豁免
    /// （与 [Self::compact_allow_stub_fallback] 键面合一，E2 §7.1）。
    /// 壳层经 session_meta 键 `compact_require_llm` 装配覆盖。
    pub compact_require_llm: bool,
    /// 溢出 stub 豁免开关（E2 F1 L3，默认 false）：溢出致命路径在
    /// Summarizer 缺失/摘要失败时允许临时中性 stub（stub 非永驻——
    /// 后台补摘要成功自动替换，块升级 committed），替代默认直接 fatal；
    /// 与 [Self::compact_require_llm] = false 键面合一（任一放行即豁免）。
    /// 壳层经 session_meta 键 `compact_allow_stub_fallback` 装配覆盖。
    pub compact_allow_stub_fallback: bool,
    /// 分阶段总结里程碑阶梯（E2 F5，session_meta 键 `compact_stage_ratios`，
    /// 默认 [crate::r#loop::stage_summary::DEFAULT_COMPACT_STAGE_RATIOS] =
    /// [0.4, 0.6, 0.8]）：estimate/window 比例达某里程碑 → run 收口评估
    /// 触发阶段总结（tier="stage-N"，每阶梯对话生命周期内只触发一次）。
    /// None = 显式禁用分阶段总结（消费方经 [Self::stage_ratios] 判定）；
    /// Some(空数组) 同 None。解析辅助：
    /// [crate::r#loop::stage_summary::stage_ratios_from_session_meta]
    /// （宽容 fail-open，壳层后续批次装配覆盖）。**触发点/注入点在
    /// core_run_commands.rs（F4 完成后接线），本字段为配置面。**
    pub compact_stage_ratios: Option<Vec<f64>>,
    /// 缓存跟踪配置（P5 S2 / T-36）：None = 不构造 CacheStatsTracker
    /// （无缓存测量，行为与现状一致）；Some = run 起始在 LoopState 构造 /
    /// 复位跟踪器（fresh run），run 内跨 turn 维护签名基线并聚合
    /// RunCacheStats（收口移交 RunOutcome.cache_stats）。provider / model /
    /// TTL 由壳层装配（engine 侧 SessionLoopProducer 构造，T-40 接线点；
    /// TTL 走 P3 cache_ttl_for_provider_model 查询，0 = 未知）。
    pub cache_tracking: Option<CacheTrackingConfig>,
    /// 写路径互斥注册表（I4-M3，总接线点 T-EG-06）：装配于
    /// [Self::with_options]——显式注入优先，缺省按工作区根新建（会话级，
    /// 与 workspace_root 同源）；经 tool_ctx 注入工具执行面（写类工具
    /// 声明互斥）。**装配时同时注入逃逸监视判定器**：经
    /// [crate::escape_watch::EscapeWatchConfig::with_detector] 挂载
    /// [crate::undeclared_detector::RegistryBackedDetector]，与工具执行
    /// 共享同一注册表实例（T-ESC-03 交接点，escape_watch.rs:17-24）。
    /// None = 由装配面按工作区根新建（非禁用）。
    pub write_claims: Option<Arc<WritePathRegistry>>,
    /// 探索类文档配额上下文（I6-M11 C5，总接线点 T-EG-06）：经 tool_ctx
    /// 注入工具执行面（read-only 子代理写文档配额检查，配额按会话计数）。
    /// None = 主 agent 不受配额约束（04 C5「主 agent 自身不消耗」；
    /// 子代理 run 的配额上下文由 spawner 装配，本字段承载主循环装配面）。
    pub explore_docs_quota: Option<ExploreDocsQuotaContext>,
    /// 产出目录解析服务（G01，T-EG-08）：resolve_output_dir 工具后端。
    /// None = 装配期按工作区根自动装配 [OutputWorkspace]（InMemory store，
    /// 会话内幂等；生产持久化后端由壳层注入 session_meta store——F11）。
    pub output_dir: Option<Arc<dyn agent_tools::tools::output_dir::OutputDirResolver>>,
    /// 父 run 归属（T-D-14 权限传递层，总接线点 T-EG-06）：经 tool_ctx
    /// 透传工具执行面——审批请求据此判定来源（子代理 run → 裁决者 =
    /// 主 agent；主 agent run → 裁决者 = 用户）。None = 主 agent run /
    /// 无父 run（现状）；子代理 run 的父 run 归属由 spawner（T-D-13）装配。
    pub parent_run_id: Option<String>,
    /// 逃逸监视装配配置（T-ESC-03 P3 装配面）：None = 不启用逃逸监视
    /// （现状行为）。装配上下文透传——壳层 run 起停钩子消费：run 开始
    /// 经 [crate::escape_watch::spawn_escape_watch] 启动监视并 spawn 消费
    /// 任务（聚合 → 审计发射 + 主 agent 注入），run 收口经
    /// [crate::escape_watch::EscapeWatchHandle::shutdown] 停止并 flush 剩余
    /// 事件；LoopState 不消费本字段（消费循环由壳层 spawn，见
    /// REQ-逃逸追踪分析 §3.5.1）。
    pub escape_watch: Option<EscapeWatchConfig>,
    /// 摘要后台调度配置（T-33，00-plan §6.4 R-F 异步面）：None = 生产缺省
    /// （退避 1s/3s/9s ±20% jitter、单次墙钟 [LOOP_SUMMARY_MAX_WALL_MS]、
    /// episode attempts 上限 [MAX_SUMMARY_ATTEMPTS] 含同步）；测试可注入
    /// 快速退避序列 + jitter=0.0（确定性断言）。session_meta 可配键
    /// （compact_summary_backoff_ms / compact_summary_wall_ms）属轮次 6
    /// 配置面（T-44），本层只消费结构体配置。**E2 F2 层 1 低功耗护栏**
    /// （跨 episode 累计上限 + 观察窗口）不在此结构——见
    /// [Self::compact_summary_max_attempts] / [Self::compact_summary_retry_window_ms]。
    pub summary_dispatch: Option<crate::r#loop::summary_dispatch::SummaryDispatchConfig>,
    /// 摘要窗口内累计尝试护栏（E2 F2 层 1 低功耗模式，session_meta 键
    /// `compact_summary_max_attempts`，默认 [crate::r#loop::summary_dispatch::DEFAULT_RETRY_GUARD_MAX_ATTEMPTS]）。
    /// 废除 retired 永驻后，被动触发（用户消息边界 F3 / 新 run 装配 /
    /// 下一次压缩）可反复重新触发摘要——本字段约束**观察窗口内跨 episode
    /// 的累计尝试次数**（含同步那次），达上限停止重试，窗口过期重置后
    /// 可再试（[crate::r#loop::summary_dispatch::SummaryRetryGate]）。
    /// 与 [Self::summary_dispatch] 的 `max_attempts`（单 episode 主动退避
    /// 上限 4）区分：后者约束一次 spawn 的退避循环，本字段约束窗口内
    /// 全部 episode 的累计成本。装配：`with_options` 派生到 run 级调度器
    /// （[crate::r#loop::summary_dispatch::SummaryDispatch::set_retry_guard]）；
    /// **壳层经 session_meta 装配由后续批次接线**（本字段默认 8 = 设计
    /// 默认，未装配即生效）。
    pub compact_summary_max_attempts: u32,
    /// 摘要低功耗观察窗口（E2 F2 层 1，session_meta 键
    /// `compact_summary_retry_window_ms`，默认
    /// [crate::r#loop::summary_dispatch::DEFAULT_RETRY_GUARD_WINDOW_MS] =
    /// 30min）：窗口内 0 次被动触发 → 尝试计数重置（重新累计），窗口
    /// 过期后无论触发与否计数从零开始。与
    /// [Self::compact_summary_max_attempts] 成对消费（[SummaryRetryGate]）；
    /// 壳层经 session_meta 装配由后续批次接线。
    pub compact_summary_retry_window_ms: u64,
    /// 会话级摘要协调器（T-42，00-plan §6.5 R-I）：由壳层经注册表
    /// （[crate::r#loop::summary_coordinator::SessionSummaryCoordinatorRegistry]）
    /// 按会话装配注入——跨 run 单飞 + 全局并发上限（≤2）+ 任务跨 run
    /// 存活（run 收口不摧毁）。None = 回退 run 级 [SummaryDispatch]
    /// （轮次 4 语义，向后兼容测试 / 纯 session-loop 用法）。
    pub summary_coordinator:
        Option<Arc<crate::r#loop::summary_coordinator::SessionSummaryCoordinator>>,
    /// L1 占位符回退开关（T-44，session_meta 键 `compact_l1_placeholder`）：
    /// true = 保留旧 L1 占位符语义；false / None = 新中性 stub（默认）。
    /// **V1 决策（启动级配置）**：引擎侧（conex-compaction 轮次 1）已删除
    /// AgentMessage 面 L1 改为 stub（R-E），运行时双态切换需引擎支持；
    /// 本字段 V1 只透传文档化、不改变行为，预留给 V2（见 T-44 决策注释）。
    pub compact_l1_placeholder: Option<bool>,
    /// 笔记后端（Round6 / W4-E）：经 `with_options` 注入 `tool_ctx.note_backend`，
    /// 再在 `tool_exec` 组装 `ToolContext` 时透传。None = 未接线（工具
    /// `note_backend_unwired`）；Some = `conex-note-runtime::NoteRuntime::open`
    /// 等实现。允许 Option 透传 None，字段必须存在且可注入。
    pub note_backend: Option<NoteBackendHandle>,
}

impl Default for SessionLoopOptions {
    fn default() -> Self {
        Self {
            transient_retry_limit: 3,
            // D1：退避与熔断配置位缺省 None = 现状立即重试 / 熔断不启用
            //（向后兼容；壳层装配时经 session_meta 键注入）
            retry_backoff: None,
            provider_fail_streak: None,
            length_upgrade_limit: 2,
            continue_nudge_limit: 1,
            steering_enabled: true,
            turn_end_hook: None,
            should_stop_after_turn: None,
            recovery_hook: None,
            cwd: None,
            assistant_client_message_id: None,
            idempotency_enabled: false,
            // T-EG-06（总接线点）：默认中间件链 = 写前自动备份（S10b）——
            // BackupMiddleware::with_defaults(None)，trash_root=None 执行期
            // 回退工作区 `.crish-trash`（与删除工具兜底同源）。壳层装配
            // 时可在 options 侧整体替换（如 core_run_commands.rs）。
            tool_middleware: vec![Arc::new(BackupMiddleware::with_defaults(None))
                as Arc<dyn ToolMiddleware>],
            hooks: None,
            system_prompt: None,
            // P4 阶段 2-2/3-2：预算与压缩配置全部缺省 None/1——未配置即现状
            // 行为（不钳制、不预检、无自动压缩，向后兼容）
            context_budget: None,
            compaction_policy: None,
            summarizer: None,
            max_auto_compactions_per_run: 1,
            // E2（上下文压缩增强）：溢出重试上限 2（替代常量 1，默认值
            // 与 stream_error.rs 常量单源）、LLM 强制默认开、stub 豁免
            // 默认关——与 D1 §4.4 配置项汇总默认一致；壳层经 session_meta
            // 键（compact_overflow_retries / compact_require_llm /
            // compact_allow_stub_fallback）装配覆盖
            compact_overflow_retries:
                crate::r#loop::handlers::stream_error::MAX_OVERFLOW_COMPRESSION_RETRIES,
            compact_require_llm: true,
            compact_allow_stub_fallback: false,
            // E2 F5（分阶段总结）：里程碑阶梯默认 [0.4, 0.6, 0.8]（设计
            // 默认，E2 §7.1；壳层经 session_meta 键 compact_stage_ratios
            // 装配覆盖由后续批次接线；None = 显式禁用）
            compact_stage_ratios: Some(
                crate::r#loop::stage_summary::DEFAULT_COMPACT_STAGE_RATIOS.to_vec(),
            ),
            // P5 S2 / T-36：缓存测量缺省关闭（未配置即现状行为）
            cache_tracking: None,
            // T-EG-06：注册表与配额上下文缺省 None——with_options 装配块
            // 负责按工作区根新建注册表并注入 ESC 判定器；配额 None =
            // 主 agent 不受配额约束（04 C5「主 agent 自身不消耗」）
            write_claims: None,
            explore_docs_quota: None,
            // T-EG-08：产出目录解析器缺省 None——with_options 装配块自动
            // 装配 OutputWorkspace（InMemory store，工作区根同源）
            output_dir: None,
            // T-D-14：父 run 归属缺省 None = 主 agent run（审批裁决者 =
            // 用户，现状行为；子代理 spawner 装配时显式注入）
            parent_run_id: None,
            // T-ESC-03：逃逸监视缺省关闭（未配置即现状行为）
            escape_watch: None,
            // T-33：摘要后台调度缺省生产参数（退避 1s/3s/9s、墙钟 60s、
            // episode attempts 4 含同步；测试经 options 注入快速参数）
            summary_dispatch: None,
            // E2 F2 层 1（低功耗模式）：窗口内累计尝试护栏默认 8 /
            // 观察窗口默认 30min（设计默认；壳层经 session_meta 两新键
            // 装配覆盖由后续批次接线）
            compact_summary_max_attempts:
                crate::r#loop::summary_dispatch::DEFAULT_RETRY_GUARD_MAX_ATTEMPTS,
            compact_summary_retry_window_ms:
                crate::r#loop::summary_dispatch::DEFAULT_RETRY_GUARD_WINDOW_MS,
            // T-42：会话级协调器缺省 None = 回退 run 级 dispatch（轮次 4
            // 语义；壳层装配面经注册表注入）
            summary_coordinator: None,
            // T-44：L1 回退开关缺省 None = 新中性 stub（默认；V1 启动级
            // 配置，引擎不支持动态双态 → 仅文档化预留 V2）
            compact_l1_placeholder: None,
            // Round6 / W4-E：笔记后端缺省 None = 未接线（工具 note_backend_unwired）；
            // 壳层 / engine 经 options 注入 StoreNoteBackend
            note_backend: None,
        }
    }
}

impl SessionLoopOptions {
    /// 分阶段总结里程碑阶梯访问面（E2 F5）：None / 空数组 = 禁用（消费方
    /// 跳过里程碑评估）；Some(非空) = 启用并返回升序阶梯。默认值
    /// [crate::r#loop::stage_summary::DEFAULT_COMPACT_STAGE_RATIOS]
    /// 由 [Default] 装配（[0.4, 0.6, 0.8]），壳层显式注入 None 可禁用。
    pub fn stage_ratios(&self) -> Option<&[f64]> {
        self.compact_stage_ratios
            .as_deref()
            .filter(|ratios| !ratios.is_empty())
    }
}

/// 瞬态重试退避配置（D1 §3.1.4，镜像 agent-provider retry.rs RetryPolicy /
/// orchestrator recovery.rs RecoveryRetryPolicy 常量：750/8000/60000）
///
/// None 字段回落常量：base_ms → [RETRY_BACKOFF_BASE_MS]（750）、
/// max_ms → [RETRY_MAX_DELAY_MS]（8000）、total_budget_ms →
/// [RETRY_TOTAL_BUDGET_MS]（60000）。[SessionLoopOptions::retry_backoff]
/// 为 None 时不生效（现状立即重试）；Some(RetryBackoffConfig::default())
/// 即启用默认 750/8000/60000 全量语义（Default = 全 None = 常量回落）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RetryBackoffConfig {
    /// 首次退避基数（默认 750ms；None 回落常量）
    pub base_ms: Option<u64>,
    /// 单次等待上限（5xx/Timeout/Network 类默认 8s；429 分支不受本上限
    /// 约束——放行到 5min，由预算闸兜底；None 回落常量）
    pub max_ms: Option<u64>,
    /// 总重试预算（默认 60s；elapsed >= 预算停止重试，严格小于；None 回落常量）
    pub total_budget_ms: Option<u64>,
}
