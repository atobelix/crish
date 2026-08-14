//! 超限恢复阶梯面（01 §2.6 length 阶梯 + P4 §3.5 溢出压缩阶梯 + 溢出常量）——
//! SR-06c · 拆分 · ≠ EL：自 stream_error.rs 拆出，公共面经父模 re-export。

use conex_compaction::CompactionEngine;
use conex_types::response::ClassifiedStreamError;
use conex_types::session::AgentSessionEvent as E;
use conex_types::tool::{ContextCompressionReason, ContextCompressionTrigger};

use super::fatal::fatal_provider_error;
use super::super::{
    apply_compaction, compaction_shape_ok, dispatch, CompactionTriggerInfo, HandlerOutcome,
    LoopState,
};
use super::super::streaming::streaming_aborted;
use super::super::super::LoopError;
/// 溢出压缩阶梯重试上限（E2 F2 层 2 / D1 §3.5.1：1→2，替代 pi
/// `_overflowRecoveryAttempted` 单次语义——压缩后仍超限时重试第二次是
/// 真实恢复：第二次重试前 keep_recent_tokens 阶梯下调（20K→12K→8K，
/// DEEPCHECK-11 §8 机制化），请求体真实变化，不再是对同一超限体的
/// 无效重放）。**默认值**——运行时以
/// [SessionLoopOptions::compact_overflow_retries] 为准（壳层经
/// session_meta 键 `compact_overflow_retries` 装配覆盖；0 = 溢出不压缩
/// 直接 fatal）
pub(crate) const MAX_OVERFLOW_COMPRESSION_RETRIES: u32 = 2;

/// 溢出重试时保留预算阶梯下调（D1 §3.5.1 / E2 §3.1，DEEPCHECK-11 §8
/// 建议的机制化）：第一次压缩用配置 keep_recent_tokens（默认 20K），
/// 第二次起逐级下调 12K→8K，优先尝试更小保留预算；对配置值取 min
/// （阶梯是「下调」方向，永不放大配置预算）。数组长度 = 阶梯深度，
/// 超出（配置上限 > 阶梯深度）按末档持续下调。
pub(crate) const OVERFLOW_KEEP_RECENT_STAIRCASE: [usize; 3] = [20_000, 12_000, 8_000];

/// length 阶梯升级次数上限（01 §2.6 步骤 1：8192→16384→32768，上限 2 次；
/// 配置 [SessionLoopOptions::length_upgrade_limit] 超过本上限按上限计——
/// F2-01：配置放大（如 30）不得让 max_tokens 继续翻倍，19 次后
/// 8192×2^19 溢出 u32::MAX（debug panic / release 回绕成小值退化））
pub(crate) const MAX_LENGTH_UPGRADES: u32 = 2;

/// length 恢复阶梯：max_tokens 翻倍升级（8192→16384→32768，上限 2 次）；
/// 用尽后接压缩阶梯（P4 §3.5）——输入超限维度，对齐 pi「溢出 → 压缩 →
/// 重试一次」
pub(crate) async fn length_ladder(state: &mut LoopState, classified: &ClassifiedStreamError) -> Result<HandlerOutcome, LoopError> {
    // Q40（T09.9）：每级决策前查 abort——已取消不再发起 length 升级重试
    if state.abort_signal.is_aborted() {
        return streaming_aborted(state);
    }
    let limit = state.options.length_upgrade_limit.min(MAX_LENGTH_UPGRADES);
    if state.length_upgrades < limit {
        state.length_upgrades += 1;
        let max_tokens_before = state.max_tokens;
        // F2-01：saturating 翻倍（阶梯上限 2 使常规路径封顶 32768；
        // saturating 为防御纵深——内部计数异常时永不溢出回绕）
        state.max_tokens = state.max_tokens.saturating_mul(2);
        // 01 §3.3 ②：length 升级时重置 steering 计数（EV-03：reset 前后
        // 计数进 steering-evaluated 事件）
        super::super::emit_steering_reset_event(state, "length-escalation");
        // length 阶梯无退避等待（立即升级重进 provider 循环，delay=0）；
        // EV-03：provider-diagnostic kind=length-escalation（attempt/
        // maxTokens 前后值随载荷）
        super::retry::emit_length_escalation_diagnostic(
            state,
            state.length_upgrades,
            limit,
            max_tokens_before,
            state.max_tokens,
        );
        dispatch(state, E::NoProgressContinue)?;
        return Ok(HandlerOutcome::continue_run());
    }
    // length 阶梯用尽 → 压缩阶梯（P4 §3.5：压缩对话后重试一次，
    // compression_retries 上限 1；仍超限才 fatal）
    compression_ladder(state, classified).await
}

/// 溢出压缩阶梯（E2 F2 层 2 / D1 §3.5，对齐 pi `_overflowRecoveryAttempted`
/// 防死循环 + DEEPCHECK-11 §7 建议①②的机制化）：
/// 压缩对话 + 重试（[SessionLoopOptions::compact_overflow_retries] 上限，
/// 默认 2）。
///
/// 入口：
/// - [ContextLengthExceeded]：length_ladder 用尽后进入（输入超限维度）；
/// - [PayloadTooLarge]：直接进入（物理载荷超限，压缩是真实恢复——请求体
///   经压缩后真实变化，重试不再是「假恢复」）。
///
/// 触发条件（全部满足才压缩，不满足直接 fatal）：
/// 1. 预算与压缩策略均已配置（None = 向后兼容现状——T06.2.2 的
///    PayloadTooLarge 直接 fatal 语义即此缺省路径）；
/// 2. `compression_retries < compact_overflow_retries`（溢出自有计数防
///    「压缩→仍超→再压缩」死循环——**绕开预检共享计数**，
///    [SessionLoopOptions::max_auto_compactions_per_run] 仅约束预检/
///    用户消息边界/分阶段触发，预检不再饿死溢出恢复，DEEPCHECK-11 §7
///    冲突 1）；
/// 3. 第二次重试前 keep_recent_tokens 阶梯下调（20K→12K→8K，min 配置值，
///    优先更小保留预算）。
///
/// LLM 摘要强制（E2 F1 L3）：默认以 [StubPolicy::LlmRequired] 调用引擎——
/// 无 Summarizer / 摘要失败（plan.llm_unavailable）→ **不落 stub 直接
/// fatal**（显式失败不静默丢语义，fatal 文案含「LLM 不可用」）；
/// [SessionLoopOptions::compact_allow_stub_fallback] = true 或
/// [SessionLoopOptions::compact_require_llm] = false 时允许临时 stub
/// 降级（豁免路径，stub 非永驻——后台补摘要成功自动替换）。
///
/// 压缩动作复用 [apply_compaction]（trigger/reason=Overflow，事件广播 +
/// 时间戳护栏 + 单 run 计数）；目标预算 = window - reserve（与预检同一
/// 口径）。无合法切割点 / 无可丢内容（plan.dropped_ids 为空）时**不重试**
/// ——请求体未变，重试必再超（对齐 T06.2.2 删除假恢复的裁决）→ 直接 fatal。
pub(crate) async fn compression_ladder(
    state: &mut LoopState,
    classified: &ClassifiedStreamError,
) -> Result<HandlerOutcome, LoopError> {
    // Q40（T09.9）：每级决策前查 abort——已取消不再发起压缩重试
    if state.abort_signal.is_aborted() {
        return streaming_aborted(state);
    }
    // 条件 2：溢出重试上限（可配；0 = 溢出不压缩直接 fatal）
    let overflow_limit = state.options.compact_overflow_retries;
    if state.compression_retries >= overflow_limit {
        return fatal_provider_error(state, classified);
    }
    // 条件 1：预算与压缩策略缺省（None，向后兼容现状）
    let Some(budget) = state.budget else {
        return fatal_provider_error(state, classified);
    };
    let Some(mut policy) = state.compaction_policy.clone() else {
        return fatal_provider_error(state, classified);
    };
    // 条件 3：第二次起 keep_recent_tokens 阶梯下调（D1 §3.5.1 机制化；
    // min(配置值, 阶梯值)——阶梯是下调方向，永不放大配置预算）
    if let Some(stair) = OVERFLOW_KEEP_RECENT_STAIRCASE.get(state.compression_retries as usize) {
        policy.keep_recent_tokens = policy.keep_recent_tokens.min(*stair);
    }
    // 目标预算 = window - reserve（与预检触发同一口径，P4 §3.4.1 触发点 2）
    let budget_tokens = budget.context_window.saturating_sub(budget.reserve_tokens);
    let engine = CompactionEngine::new(0);
    // E2 F1 L3：LLM 摘要强制——豁免（compact_allow_stub_fallback /
    // !compact_require_llm 任一放行）→ StubAllowed 降级 stub；默认
    // LlmRequired → 无 Summarizer/摘要失败不落 stub、标记 llm_unavailable
    let stub_policy = if state.options.compact_allow_stub_fallback
        || !state.options.compact_require_llm
    {
        conex_compaction::compaction::StubPolicy::StubAllowed
    } else {
        conex_compaction::compaction::StubPolicy::LlmRequired
    };
    let mut plan = engine.compact_agent_messages_with_stub_policy(
        &state.conversation,
        budget_tokens as usize,
        &policy,
        state.summarizer.as_deref(),
        stub_policy,
    );
    if plan.llm_unavailable {
        // E2 F1 L3：LLM 摘要不可用（无 Summarizer / 同步失败）且无豁免 →
        // 不落 stub、不重试（对话未变，重试必再超）→ 直接 fatal，
        // 文案含「LLM 不可用」（compression_fatal_note 附注分支）
        tracing::warn!(
            session_id = %state.machine.context().session_id,
            "溢出压缩因 LLM 摘要不可用而未压缩（默认 fatal；compact_allow_stub_fallback=true 可豁免为临时 stub）"
        );
        state.overflow_llm_unavailable = true;
        return fatal_provider_error(state, classified);
    }
    if plan.dropped_ids.is_empty() {
        // 无合法切割点 / 无可丢内容：不重试（请求体未变，重试必再超）
        return fatal_provider_error(state, classified);
    }
    // T-36 引擎兜底（评审 02 P1-7）：压缩产物的协议形状护栏——无 system
    // 且链后首条非 user → 若 cut 落在 assistant 上，尝试更紧凑保留预算收敛至 user 头部
    if !compaction_shape_ok(&plan.messages) {
        if let Some(first_non_summary_idx) = plan.messages.iter().position(|m| {
            m.role != conex_types::message::AgentMessageRole::System
                && !m.id.starts_with("compacted-summary")
        }) {
            if plan.messages[first_non_summary_idx].role != conex_types::message::AgentMessageRole::User {
                let non_user_tokens = conex_compaction::count_agent_message_tokens(
                    &plan.messages[first_non_summary_idx],
                );
                let tighter_keep = policy.keep_recent_tokens.saturating_sub(non_user_tokens);
                let mut tighter_policy = policy.clone();
                tighter_policy.keep_recent_tokens = tighter_keep;
                let tighter_plan = engine.compact_agent_messages_with_stub_policy(
                    &state.conversation,
                    budget_tokens as usize,
                    &tighter_policy,
                    state.summarizer.as_deref(),
                    stub_policy,
                );
                if compaction_shape_ok(&tighter_plan.messages) && !tighter_plan.dropped_ids.is_empty() {
                    plan = tighter_plan;
                }
            }
        }
    }
    if !compaction_shape_ok(&plan.messages) {
        tracing::warn!(
            session_id = %state.machine.context().session_id,
            "溢出压缩产物协议形状违规（无 system 且链后首条非 user）→ 跳过压缩（T-36 护栏）"
        );
        return fatal_provider_error(state, classified);
    }
    // 应用压缩（Overflow 触发；压缩是唯一前缀重写点 I1，事件广播 +
    // 时间戳护栏 + 单 run 计数在 apply_compaction 内完成）
    let info = CompactionTriggerInfo {
        trigger: ContextCompressionTrigger::Overflow,
        reason: ContextCompressionReason::Overflow,
    };
    apply_compaction(state, &plan, &info, Some(u64::from(budget_tokens))).await;
    state.compression_retries += 1;
    // T-35 注入卫生（debug 面）：压缩替换对话后复检——压缩是唯一前缀
    // 重写点，链消息与保留区不得携带时间线注入（注入只允许在对话末尾
    // user 消息）
    crate::r#loop::handlers::assert_timeline_injection_hygiene(&state.conversation);
    // 重试：NO_PROGRESS_CONTINUE 重进 provider 循环（对话已替换，
    // 下一次 build_request 携带压缩后序列 = 真实恢复）
    dispatch(state, E::NoProgressContinue)?;
    Ok(HandlerOutcome::continue_run())
}

// payload 假恢复阶梯已在 T06.2.2 / AA-01 Q05 删除：原实现只递增计数后
// NO_PROGRESS_CONTINUE 重进 provider 循环——请求体与 max_tokens 完全不变，
// 第二次必然再次 PayloadTooLarge，属「假恢复」。P4 §3.5（T-34）以**真实
// 压缩阶梯**恢复：压缩对话（请求体真实变化）后重试一次，受
// [MAX_OVERFLOW_COMPRESSION_RETRIES] 约束——不恢复旧的计数式假恢复。
