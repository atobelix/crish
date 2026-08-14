//! 唤醒摘要标准化（T-CF-12；02-CF 定时唤醒与工具方案 §4.8）
//!
//! 职责：
//! - [wakeup_summary]：事件 → 中文唤醒摘要模板映射，无状态纯函数
//!   （输入确定输出确定，便于单元测试）；
//! - 覆盖六类唤醒源：
//!   1. 子代理完成（SubagentEnded）→ 「子代理 <role>（<id>）已完成：<status>」；
//!   2. run 终态（RunTerminal）→ 「任务 <id> 已运行 <duration>，退出码 <code>」；
//!   3. 定时器到期（TimerFired）→ 「<prompt>（定时器 <id> 已到期）」；
//!   4. Cron 触发（CronFired）→ 「<prompt>（cron <id> 第 <n> 次触发）」
//!      ——变体由 T-CF-08 登记进 events.rs（cron_id / prompt / expression /
//!      iteration / fired_at_ms，背压 Critical），经 [cron_fired_summary]
//!      冻结模板；
//!   5. 后台任务完成（TaskCompleted，AB 方案事件）→
//!      「任务 <id> 已运行 <duration>，日志已累积 <lines> 行，最近输出 <ts>」；
//!   6. 恢复通知（orchestrator 既有 recovery 事件）→ 复用
//!      `steering_text`（recovery.rs:397-411），不重写——恢复类唤醒
//!      不经本模块，由 orchestrator 直接构造 steering 条目。
//! - 注入收口：摘要文本由 T-CF-11（idle 续 run）拼入 steering 条目
//!   text（与 prompt 并存），随续 run 批量送达；AI 无需手动查询即可
//!   知道发生了什么（REQ-C04 验收 3）。
//!
//! 文案风格对齐 `crates/orchestrator/src/recovery.rs:397-411`（steering_text）；
//! 时间/时长格式化遵循全仓 epoch 毫秒惯例（`tools/mod.rs:416-421`
//! epoch_millis；ISO8601 ↔ epoch 换算与 `core_run_commands.rs:669`
//! 同源算法，本模块本地实现以保持纯函数自足）。

// 临时过渡允许：本模块是纯函数库，消费方（A5 调度 / A8 idle 续 run）本轮
// 并行按冻结签名接线中，接线完成前整模块无调用点；接线落地即移除本
// 属性（不允许长期保留），届时 cron_fired_summary 的预留注释一并收口。
#![allow(dead_code)]

use conex_types::events::{AgentEvent, RunTerminalStatus, SubagentEndStatus};

/// 唤醒摘要上下文：事件本体之外、模板所需的动态信息。
///
/// 全部字段可选，缺失时对应模板片段降级省略，保证无状态纯函数
/// 永不 panic；字段语义与消费方（A5/A8 等）的注入契约冻结对齐。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SummaryCtx {
    /// run 开始时刻（epoch 毫秒）：RunTerminal 摘要「已运行 <duration>」
    /// 的时长基准（duration = 事件 timestamp − 本值；None = 省略时长片段）
    pub run_started_at_ms: Option<i64>,
    /// run 退出码：RunTerminal 摘要「退出码 <code>」填充（None = 消费方
    /// 未提供，降级为「已结束（<终态>）」）
    pub exit_code: Option<i32>,
    /// 最近一次输出时刻（epoch 毫秒）：后台任务完成摘要「最近输出 <ts>」
    /// 填充（None = 省略该片段；TaskCompleted 事件体无此字段）
    pub last_output_at_ms: Option<i64>,
    /// 子代理角色（展示标签）：SubagentEnded 事件无 role 字段，由消费方
    /// 从 SubagentStarted 声明或会话状态补充（None = 省略角色段，
    /// 摘要退化为「子代理 <id> 已完成：<status>」）
    pub subagent_role: Option<String>,
}

/// 事件 → 唤醒摘要模板映射（02-CF 方案 §4.8 冻结签名）。
///
/// 覆盖与回退：
/// - 五类事件走专属模板（SubagentEnded / RunTerminal / TimerFired /
///   TaskCompleted，CronFired 经 [cron_fired_summary]，登记落地后补 arm）；
/// - 其余事件 → 「收到事件 <type>」通用回退，不 panic；
/// - 恢复通知不在此映射（复用 orchestrator steering_text，见模块文档）。
pub fn wakeup_summary(event: &AgentEvent, ctx: &SummaryCtx) -> String {
    match event {
        // 子代理完成：模板「子代理 <role>（<id>）已完成：<status>」；
        // role 来自 ctx（事件无 role 字段），status 取中文状态词
        AgentEvent::SubagentEnded { subagent_id, status, .. } => {
            let role_part = match &ctx.subagent_role {
                Some(role) => format!("{role}（{subagent_id}）"),
                None => subagent_id.clone(),
            };
            let status_cn = match status {
                SubagentEndStatus::Completed => "成功",
                SubagentEndStatus::Failed => "失败",
                SubagentEndStatus::Cancelled => "取消",
            };
            format!("子代理 {role_part} 已完成：{status_cn}")
        }
        // run 终态：模板「任务 <id> 已运行 <duration>，退出码 <code>」；
        // 时长 = 事件时刻 − run 开始时刻（ctx），退出码缺省降级为
        // 「已结束（<终态>）」
        AgentEvent::RunTerminal { run_id, timestamp, terminal, .. } => {
            let mut segments = vec![format!("任务 {run_id}")];
            if let Some(started) = ctx.run_started_at_ms {
                let ended = iso8601_to_epoch_millis(timestamp);
                segments.push(format!(
                    "已运行 {}",
                    format_duration_ms(ended.saturating_sub(started))
                ));
            }
            match ctx.exit_code {
                Some(code) => segments.push(format!("退出码 {code}")),
                None => segments.push(format!("已结束（{}）", run_terminal_cn(terminal))),
            }
            segments.join("，")
        }
        // 定时器到期：模板「<prompt>（定时器 <id> 已到期）」
        AgentEvent::TimerFired { timer_id, prompt, .. } => {
            format!("{prompt}（定时器 {timer_id} 已到期）")
        }
        // 后台任务完成（AB 方案事件）：模板「任务 <id> 已运行 <duration>，
        // 日志已累积 <lines> 行，最近输出 <ts>」；「最近输出」时刻事件
        // 体无字段，由 ctx 提供（None = 省略该片段）
        AgentEvent::TaskCompleted {
            task_id,
            duration_ms,
            line_count,
            ..
        } => {
            let mut segments = vec![
                format!(
                    "任务 {task_id} 已运行 {}",
                    format_duration_ms(*duration_ms as i64)
                ),
                format!("日志已累积 {line_count} 行"),
            ];
            if let Some(ts) = ctx.last_output_at_ms {
                segments.push(format!("最近输出 {}", format_epoch_clock(ts)));
            }
            segments.join("，")
        }
        // Cron 触发：模板「<prompt>（cron <id> 第 <n> 次触发）」；
        // CronFired 变体由 T-CF-08 登记（events.rs:765，字段 cron_id /
        // prompt / expression / iteration / fired_at_ms，背压 Critical），
        // 转调 [cron_fired_summary] 冻结模板
        AgentEvent::CronFired {
            cron_id,
            prompt,
            iteration,
            ..
        } => cron_fired_summary(cron_id, prompt, *iteration),
        // 未覆盖事件 → 通用回退（不 panic）
        _ => format!("收到事件 {}", event.type_name()),
    }
}

/// CronFired 摘要模板：「<prompt>（cron <id> 第 <n> 次触发）」。
///
/// 事件变体由 T-CF-08 登记进 `AgentEvent`（events.rs），[wakeup_summary]
/// 的 `CronFired` arm 转调本函数——模板与签名冻结，A5/A7/A8 可按本契约
/// 编码消费。
pub fn cron_fired_summary(cron_id: &str, prompt: &str, iteration: u64) -> String {
    format!("{prompt}（cron {cron_id} 第 {iteration} 次触发）")
}

/// run 终态中文（Completed → 成功 / Cancelled → 取消 / Failed → 失败）
fn run_terminal_cn(terminal: &RunTerminalStatus) -> &'static str {
    match terminal {
        RunTerminalStatus::Completed => "成功",
        RunTerminalStatus::Cancelled => "取消",
        RunTerminalStatus::Failed => "失败",
    }
}

/// ISO8601 → epoch 毫秒（引擎统一格式 `YYYY-MM-DDTHH:MM:SS.mmmZ`；
/// 宽容解析：毫秒段可缺省，时区仅接受 Z，失败兜底 0；算法与
/// `core_run_commands.rs:669` 同源，本模块本地实现以保持纯函数自足）
fn iso8601_to_epoch_millis(iso: &str) -> i64 {
    let Some((date, rest)) = iso.split_once('T') else {
        return 0;
    };
    let mut parts = date.split('-');
    let (Some(year), Some(month), Some(day)) = (
        parts.next().and_then(|v| v.parse::<i64>().ok()),
        parts.next().and_then(|v| v.parse::<u32>().ok()),
        parts.next().and_then(|v| v.parse::<u32>().ok()),
    ) else {
        return 0;
    };
    let mut time = rest.split(':');
    let (Some(hour), Some(minute)) = (
        time.next().and_then(|v| v.parse::<i64>().ok()),
        time.next().and_then(|v| v.parse::<i64>().ok()),
    ) else {
        return 0;
    };
    let sec_rest = time.next().unwrap_or("0");
    let stripped = sec_rest.strip_suffix('Z').unwrap_or(sec_rest);
    let (sec, millis) = match stripped.split_once('.') {
        Some((s, ms)) => (
            s.parse::<i64>().unwrap_or(0),
            ms.parse::<i64>().unwrap_or(0),
        ),
        None => (stripped.parse::<i64>().unwrap_or(0), 0),
    };
    let days = days_from_civil(year, month, day);
    ((days * 86_400 + hour * 3600 + minute * 60 + sec) * 1000) + millis
}

/// 公历年月日 → Unix 天数（Howard Hinnant civil_from_days 的逆函数；
/// 与 `core_run_commands.rs:703` / session-loop hydrate.rs 同源算法）
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// 时长格式化（毫秒差 → 人读中文：「3 小时 2 分」/「2 分 30 秒」/
/// 「45 秒」/「500 毫秒」；负数按 0 处理，不 panic）
fn format_duration_ms(ms: i64) -> String {
    let ms = ms.max(0);
    if ms < 1_000 {
        return format!("{ms} 毫秒");
    }
    let total_secs = ms / 1_000;
    let hours = total_secs / 3_600;
    let minutes = total_secs % 3_600 / 60;
    let seconds = total_secs % 60;
    if hours > 0 {
        format!("{hours} 小时 {minutes} 分")
    } else if minutes > 0 {
        format!("{minutes} 分 {seconds} 秒")
    } else {
        format!("{seconds} 秒")
    }
}

/// epoch 毫秒 → UTC 时钟（`HH:MM:SS`；对齐全仓 epoch ms 惯例，
/// 仅取时分秒，供「最近输出 <ts>」等短时间戳展示）
fn format_epoch_clock(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (hours, minutes, seconds) = (secs / 3600 % 24, secs / 60 % 60, secs % 60);
    format!("{hours:02}:{minutes:02}:{seconds:02}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::events::{RunTerminalStatus, SubagentEndStatus};

    /// 构造摘要上下文（测试助手：字段按需填充，缺省 None）
    fn ctx(
        role: Option<&str>,
        started: Option<i64>,
        code: Option<i32>,
        last_output: Option<i64>,
    ) -> SummaryCtx {
        SummaryCtx {
            run_started_at_ms: started,
            exit_code: code,
            last_output_at_ms: last_output,
            subagent_role: role.map(str::to_string),
        }
    }

    /// 子代理完成事件（复用样例：status 可换）
    fn subagent_ended(status: SubagentEndStatus) -> AgentEvent {
        AgentEvent::SubagentEnded {
            session_id: "s-1".to_string(),
            subagent_id: "sa-1".to_string(),
            subagent_run_id: "run-sa-1".to_string(),
            status,
            summary: Some("已完成调研".to_string()),
            ended_at: "2024-01-01T00:00:00.000Z".to_string(),
            subagent_session_id: None,
        }
    }

    /// SubagentEnded → 摘要含角色、子代理 id 与完成状态（任务书断言）
    #[test]
    fn wakeup_summary_subagent_ended() {
        let event = subagent_ended(SubagentEndStatus::Completed);
        let summary = wakeup_summary(&event, &ctx(Some("分析"), None, None, None));
        assert!(summary.contains("分析"), "应含角色，实际：{summary}");
        assert!(summary.contains("sa-1"), "应含子代理 id，实际：{summary}");
        assert!(summary.contains("已完成"), "应含完成状态，实际：{summary}");
        assert!(summary.contains("成功"), "应含状态词，实际：{summary}");
    }

    /// 子代理角色缺失（消费方未提供）→ 降级为不含角色段，不 panic
    #[test]
    fn wakeup_summary_subagent_ended_without_role() {
        let event = subagent_ended(SubagentEndStatus::Failed);
        let summary = wakeup_summary(&event, &SummaryCtx::default());
        assert!(summary.contains("sa-1"), "应含子代理 id，实际：{summary}");
        assert!(summary.contains("失败"), "应含失败状态，实际：{summary}");
        assert!(!summary.contains("（"), "无角色时应省略括号段，实际：{summary}");
    }

    /// TimerFired → 摘要含 prompt 与 timer-id（任务书断言）
    #[test]
    fn wakeup_summary_timer_fired() {
        let event = AgentEvent::TimerFired {
            session_id: "s-1".to_string(),
            timer_id: "timer-1".to_string(),
            prompt: "请检查任务进度".to_string(),
            fired_at_ms: 1_704_067_200_000,
        };
        let summary = wakeup_summary(&event, &SummaryCtx::default());
        assert!(summary.contains("请检查任务进度"), "应含 prompt，实际：{summary}");
        assert!(summary.contains("timer-1"), "应含定时器 id，实际：{summary}");
        assert!(summary.contains("已到期"), "应含到期语义，实际：{summary}");
    }

    /// CronFired → 摘要含 prompt、cron id 与第 N 次触发（任务书断言；
    /// 变体字段对齐 T-CF-08 登记：cron_id / prompt / iteration / fired_at_ms）
    #[test]
    fn wakeup_summary_cron_fired() {
        let event = AgentEvent::CronFired {
            session_id: "s-1".to_string(),
            cron_id: "cron-1".to_string(),
            prompt: "每周一提醒".to_string(),
            expression: "0 9 * * 1".to_string(),
            iteration: 3,
            fired_at_ms: 1_704_067_200_000,
        };
        let summary = wakeup_summary(&event, &SummaryCtx::default());
        assert!(summary.contains("每周一提醒"), "应含 prompt，实际：{summary}");
        assert!(summary.contains("cron-1"), "应含 cron id，实际：{summary}");
        assert!(summary.contains("第 3 次触发"), "应含第 N 次触发，实际：{summary}");
    }

    /// RunTerminal（ctx 齐全）→ 含 run id、已运行时长与退出码
    #[test]
    fn wakeup_summary_run_terminal() {
        let event = AgentEvent::RunTerminal {
            session_id: "s-1".to_string(),
            run_id: "run-1".to_string(),
            timestamp: "2024-01-01T00:00:40.000Z".to_string(),
            terminal: RunTerminalStatus::Completed,
            error: None,
        };
        let summary = wakeup_summary(&event, &ctx(None, Some(1_704_067_200_000), Some(0), None));
        assert!(summary.contains("run-1"), "应含 run id，实际：{summary}");
        assert!(summary.contains("已运行 40 秒"), "应含时长，实际：{summary}");
        assert!(summary.contains("退出码 0"), "应含退出码，实际：{summary}");
    }

    /// RunTerminal（ctx 缺省）→ 降级为「已结束（<终态>）」，不含时长/退出码
    #[test]
    fn wakeup_summary_run_terminal_degraded() {
        let event = AgentEvent::RunTerminal {
            session_id: "s-1".to_string(),
            run_id: "run-2".to_string(),
            timestamp: "2024-01-01T00:00:00.000Z".to_string(),
            terminal: RunTerminalStatus::Failed,
            error: Some("超时".to_string()),
        };
        let summary = wakeup_summary(&event, &SummaryCtx::default());
        assert!(summary.contains("run-2"), "应含 run id，实际：{summary}");
        assert!(summary.contains("已结束（失败）"), "应降级为终态，实际：{summary}");
        assert!(!summary.contains("已运行"), "缺省不应含时长，实际：{summary}");
    }

    /// 后台任务完成 → 含任务 id、时长、累积行数与最近输出
    #[test]
    fn wakeup_summary_task_completed() {
        let event = AgentEvent::TaskCompleted {
            session_id: "s-1".to_string(),
            task_id: "task-1".to_string(),
            exit_code: 0,
            duration_ms: 150_000,
            line_count: 120,
        };
        let summary =
            wakeup_summary(&event, &ctx(None, None, None, Some(1_704_067_260_000)));
        assert!(summary.contains("task-1"), "应含任务 id，实际：{summary}");
        assert!(summary.contains("已运行 2 分 30 秒"), "应含时长，实际：{summary}");
        assert!(summary.contains("日志已累积 120 行"), "应含行数，实际：{summary}");
        assert!(summary.contains("最近输出 00:01:00"), "应含最近输出，实际：{summary}");
    }

    /// 后台任务完成（ctx 缺省）→ 省略「最近输出」片段，不 panic
    #[test]
    fn wakeup_summary_task_completed_without_last_output() {
        let event = AgentEvent::TaskCompleted {
            session_id: "s-1".to_string(),
            task_id: "task-2".to_string(),
            exit_code: 1,
            duration_ms: 45_000,
            line_count: 8,
        };
        let summary = wakeup_summary(&event, &SummaryCtx::default());
        assert!(summary.contains("task-2"), "应含任务 id，实际：{summary}");
        assert!(summary.contains("已运行 45 秒"), "应含时长，实际：{summary}");
        assert!(!summary.contains("最近输出"), "缺省不应含最近输出，实际：{summary}");
    }

    /// 未覆盖事件 → 通用回退「收到事件 <type>」，不 panic（任务书断言）
    #[test]
    fn wakeup_summary_unknown_event_fallback() {
        let event = AgentEvent::AgentStart {
            session_id: "s-1".to_string(),
            timestamp: "2024-01-01T00:00:00.000Z".to_string(),
        };
        let summary = wakeup_summary(&event, &SummaryCtx::default());
        assert_eq!(summary, "收到事件 agent-start");
    }

    /// 格式串错误防护：全部模板输出不得残留未插值占位符（<...>）
    #[test]
    fn wakeup_summary_no_uninterpolated_placeholders() {
        let subagent = subagent_ended(SubagentEndStatus::Cancelled);
        let timer = AgentEvent::TimerFired {
            session_id: "s-1".to_string(),
            timer_id: "timer-1".to_string(),
            prompt: "请检查任务进度".to_string(),
            fired_at_ms: 1_704_067_200_000,
        };
        let run = AgentEvent::RunTerminal {
            session_id: "s-1".to_string(),
            run_id: "run-1".to_string(),
            timestamp: "2024-01-01T00:00:40.000Z".to_string(),
            terminal: RunTerminalStatus::Completed,
            error: None,
        };
        let task = AgentEvent::TaskCompleted {
            session_id: "s-1".to_string(),
            task_id: "task-1".to_string(),
            exit_code: 0,
            duration_ms: 150_000,
            line_count: 120,
        };
        let start = AgentEvent::AgentStart {
            session_id: "s-1".to_string(),
            timestamp: "2024-01-01T00:00:00.000Z".to_string(),
        };
        let cron = AgentEvent::CronFired {
            session_id: "s-1".to_string(),
            cron_id: "cron-1".to_string(),
            prompt: "每周一提醒".to_string(),
            expression: "0 9 * * 1".to_string(),
            iteration: 3,
            fired_at_ms: 1_704_067_200_000,
        };
        let samples = vec![
            wakeup_summary(&subagent, &ctx(Some("分析"), None, None, None)),
            wakeup_summary(&subagent, &SummaryCtx::default()),
            wakeup_summary(&timer, &SummaryCtx::default()),
            wakeup_summary(&cron, &SummaryCtx::default()),
            cron_fired_summary("cron-1", "每周一提醒", 3),
            wakeup_summary(&run, &ctx(None, Some(1_704_067_200_000), Some(0), None)),
            wakeup_summary(&run, &SummaryCtx::default()),
            wakeup_summary(&task, &ctx(None, None, None, Some(1_704_067_260_000))),
            wakeup_summary(&task, &SummaryCtx::default()),
            wakeup_summary(&start, &SummaryCtx::default()),
        ];
        for summary in &samples {
            assert!(
                !summary.contains('<') && !summary.contains('>'),
                "残留未插值占位符：{summary}"
            );
        }
    }
}
