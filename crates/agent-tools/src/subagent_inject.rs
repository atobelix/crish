//! C2 子代理创建时间注入 + git 回退谨慎指引（I4-M4 落地）
//!
//! 04 文档 §2 C2 的落地（02 方案 M4）：子代理知道自己「创建于哪个时间点」，
//! 从而在 git 操作上保持谨慎。分层归属（04 C2）：
//! - 提示词协议层：指引文本与结构（本模块产出，固定片段可快照断言）；
//! - 引擎 Rust：started_at 注入与目标 ref 年代计算辅助字段（本模块提供纯
//!   函数；真实 git 年代查询（`git log -1 --format=%ct <ref>`）由引擎侧接线，
//!   对齐 revert.rs「不猜命令参数」契约）。
//!
//! 挂载约定（04 §4 互斥）：engine.rs build_context 主体归 C10（M1 立口、
//! M11 实装），本模块只读经 M1 注入点挂载——M1 冻结注入顺序（system →
//! skills → mcp → agent 定义，engine.rs `CONTEXT_INJECTION_ORDER`），
//! 挂载方式 = 经 `ContextInjector::push` 追加 `ContextInjection`：
//!
//! ```ignore
//! let mut injector = ContextInjector::new();
//! for (title, content) in subagent_session_injections(started_at_ms, threshold_hours) {
//!     injector.push(ContextInjection::new(
//!         ContextInjectionKind::System,
//!         title,
//!         content,
//!     ));
//! }
//! ```
//!
//! 动态字段（时间戳类）必须显式标记 `@dynamic`（M1 约定 2：不在 C10
//! 字节级一致断言范围内，01 报告 B4 第 1 条）。
//!
//! 续跑不刷新（C2 边界 2）：started_at 取 session_agents.started_at（首次
//! 创建时间），续跑 run 由引擎侧复用库值经 [resolve_started_at] 解析；
//! 本模块不触达 conex-db（agent-tools 是叶子 crate，对齐 revert_guard.rs
//! 接线约定——读写库在引擎侧完成，本模块只收 i64 时间戳纯值）。

use crate::revert::DEFAULT_REVERT_MAX_REF_AGE_HOURS;

/// `@dynamic` 标记（M1 约定）：时间戳类动态字段必须显式标记，
/// 不在 C10 字节级一致断言范围内（01 报告 B4 第 1 条）
pub const DYNAMIC_MARKER: &str = "@dynamic";

/// 默认 ref 年代阈值（小时）：24（04 C2「早于 24 小时」；与 C3 的
/// [crate::revert::DEFAULT_REVERT_MAX_REF_AGE_HOURS] 同值，消除双权威）
pub const DEFAULT_REF_AGE_THRESHOLD_HOURS: u64 = DEFAULT_REVERT_MAX_REF_AGE_HOURS;

/// started_at 注入段标题（M1 `ContextInjection.title` 使用；render 渲染为
/// `## 会话注入（started_at）`，快照断言锚点）
pub const STARTED_AT_SECTION_TITLE: &str = "会话注入（started_at）";
/// git 回退指引段标题（M1 `ContextInjection.title` 使用；render 渲染为
/// `## git 回退谨慎指引`，快照断言锚点）
pub const REVERT_CAUTION_TITLE: &str = "git 回退谨慎指引";

/// epoch ms → ISO8601（毫秒精度 UTC，`2026-07-31T08:00:00.000Z`；与
/// engine.rs now_iso_utc / session-loop hydrate.rs 同源的 Howard Hinnant
/// civil-from-days 手工换算，不引入 chrono 依赖；负值经 div_euclid /
/// rem_euclid 容错不 panic）
pub fn iso8601_from_epoch_ms(epoch_ms: i64) -> String {
    let secs = epoch_ms.div_euclid(1000);
    let millis = epoch_ms.rem_euclid(1000);
    let sec_of_day = secs.rem_euclid(86_400);
    let (hours, minutes, sec) = (sec_of_day / 3600, sec_of_day / 60 % 60, sec_of_day % 60);
    let (year, month, day) = civil_from_days(secs.div_euclid(86_400));
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{sec:02}.{millis:03}Z")
}

/// Unix 天数 → 公历年月日（Howard Hinnant 算法，与 session-loop / orchestrator
/// 同源；负天数经负商/余数语义容错）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

/// started_at 注入正文（不含标题行；`@dynamic` 标记 + ISO8601 + epoch ms +
/// 隔离边界声明）。
///
/// 注入内容是 C2 验收 1 的断言对象：系统提示词包含 started_at 且等于库内
/// session_agents.started_at（epoch ms 精确匹配 + ISO8601 可读形态双呈现）。
/// 挂载方经 `ContextInjection::new(kind, STARTED_AT_SECTION_TITLE, content)`
/// 挂载，标题由 M1 render 渲染为 `## {title}`。
pub fn started_at_section(started_at_ms: i64) -> String {
    let iso = iso8601_from_epoch_ms(started_at_ms);
    format!(
        "{DYNAMIC_MARKER}：时间戳字段，字节级一致断言豁免\n\
         - started_at（创建时间 ISO8601）：{iso}\n\
         - started_at（创建时间 epoch ms）：{started_at_ms}\n\
         - 该时间点是隔离边界的一部分：你创建于上述时间点；续跑（resume/fork 复用）\
         共享同一 started_at，不随会话推进刷新。"
    )
}

/// 续跑不刷新（C2 边界 2）：库中已存在（首次创建时间）→ 原值；
/// 新 spawn（库中无该子代理行）→ 生成当前时间（fallback）。
///
/// `existing` 非正数视为无效（数据损坏容错：不回退到历史坏值），走 fallback。
pub fn resolve_started_at(existing: Option<i64>, fallback_now_ms: i64) -> i64 {
    match existing {
        Some(v) if v > 0 => v,
        _ => fallback_now_ms,
    }
}

/// git 回退谨慎指引正文（不含标题行；提示词协议层固定片段，
/// 04 C2 验收 3 快照断言对象）。
///
/// 阈值参数化：文案结构固定，`{threshold_hours}` 数字随配置变化；命中
/// 「早于阈值」输出固定指引——单文件修复优先（git checkout -- <file> 级），
/// 整体回退仅在单文件修复失败后发起并走 C3 审批门禁。
/// 挂载方经 `ContextInjection::new(kind, REVERT_CAUTION_TITLE, content)`
/// 挂载。
pub fn git_revert_caution_section(threshold_hours: u64) -> String {
    format!(
        "- 你是子代理，创建于 started_at（见上，该时间点是隔离边界的一部分）；\n\
         - 执行 git 回退类操作前先自查目标状态年代：若目标 ref 的提交时间早于你的 \
         started_at 超过 {threshold_hours} 小时（判定阈值可配，默认 24 小时），\
         优先采用单文件修复（git checkout -- <file> 级别，在你的文件域内直接改文件），\
         不要整体回退；\n\
         - 只有单文件修复失败、且确需整体回退时，才发起整体回退——整体回退必须走\
         审批门禁（C3：大面积回退审批，审批人=user，full-access 不豁免），\
         未经审批不会执行；\n\
         - 回退被拒或超阈值时，请缩小回退范围或改用单文件修复。"
    )
}

/// 目标 ref 年代判定（C2 行为 2 的引擎侧辅助判定）：ref 提交时间是否
/// 早于 started_at 超过阈值（含等于，对齐 C3「≥ 触发」语义）。
///
/// 判定式：`started_at_ms - ref_commit_time_ms >= threshold_hours * 3_600_000`。
/// ref 提交时间晚于 started_at（时钟偏差 / 未来提交）时返回 false（不保守
/// 误判：宁可不提示，不误导子代理）。
pub fn ref_older_than_threshold(
    started_at_ms: i64,
    ref_commit_time_ms: i64,
    threshold_hours: u64,
) -> bool {
    let threshold_ms = (threshold_hours as i64).saturating_mul(3_600_000);
    started_at_ms.saturating_sub(ref_commit_time_ms) >= threshold_ms
}

/// 子代理会话注入项集合（M1 挂载点转录形状）：`(标题, 正文)` 列表，
/// 挂载方逐项 `ContextInjector::push(ContextInjection::new(kind, title, content))`。
///
/// - `started_at_ms = Some(ts)`：产出 started_at 段 + git 回退指引段两条；
/// - `None`（主 agent / 非子代理 run 上下文）：空列表——无注入时行为不变
///   （C2 只作用于子代理 run 上下文）。
pub fn subagent_session_injections(
    started_at_ms: Option<i64>,
    threshold_hours: u64,
) -> Vec<(String, String)> {
    let Some(started_at_ms) = started_at_ms else {
        return Vec::new();
    };
    vec![
        (
            STARTED_AT_SECTION_TITLE.to_string(),
            started_at_section(started_at_ms),
        ),
        (
            REVERT_CAUTION_TITLE.to_string(),
            git_revert_caution_section(threshold_hours),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 锚点：epoch ms → ISO8601（session-loop hydrate.rs 同源锚点：
    /// civil_from_days(20665) = 2026-07-31）
    const ANCHOR_MS: i64 = 1_785_456_000_000;

    /// ISO8601 换算对齐全仓同源锚点（含毫秒 / 零点 / 负值容错）
    #[test]
    fn iso8601_conversion_matches_known_anchors() {
        assert_eq!(
            iso8601_from_epoch_ms(ANCHOR_MS),
            "2026-07-31T00:00:00.000Z"
        );
        assert_eq!(
            iso8601_from_epoch_ms(ANCHOR_MS + 123),
            "2026-07-31T00:00:00.123Z"
        );
        assert_eq!(iso8601_from_epoch_ms(0), "1970-01-01T00:00:00.000Z");
        // 负 epoch（容错：div_euclid/rem_euclid 不 panic）
        assert_eq!(iso8601_from_epoch_ms(-1), "1969-12-31T23:59:59.999Z");
    }

    /// C2 验收 1（mock M1 render 形态）：按 `## {title}\n{content}` 拼接
    /// 后的 system prompt 含 started_at 且 ISO8601 等于库值换算
    /// （epoch ms 精确匹配）
    #[test]
    fn injected_system_prompt_contains_started_at_equal_to_db_value() {
        // 模拟 M1 ContextInjector::render：base 段置首 + `## {title}\n{content}`
        let base = "agent 定义\nskill 内容\nMCP 工具声明";
        let sections = subagent_session_injections(Some(ANCHOR_MS), DEFAULT_REF_AGE_THRESHOLD_HOURS);
        assert_eq!(sections.len(), 2);
        let rendered: Vec<String> = sections
            .iter()
            .map(|(title, content)| format!("## {title}\n{content}"))
            .collect();
        let system_prompt = format!("{base}\n\n{}", rendered.join("\n\n"));

        assert!(system_prompt.contains("## 会话注入（started_at）"));
        assert!(system_prompt.contains("2026-07-31T00:00:00.000Z"));
        assert!(system_prompt.contains(&ANCHOR_MS.to_string()));
        assert!(system_prompt.contains(DYNAMIC_MARKER));
        assert!(system_prompt.contains("隔离边界"));
        assert!(system_prompt.contains("## git 回退谨慎指引"));
        // 注入不吞 base 段（顺序保持：base 在前、会话注入在后）
        assert!(system_prompt.starts_with(base));
    }

    /// 续跑不刷新（C2 边界 2）：已存在库值 → 原值；同一库值两次构建字节一致
    #[test]
    fn resume_keeps_original_started_at_and_is_byte_stable() {
        let original = ANCHOR_MS;
        let later_now = 1_785_600_000_000;
        assert_eq!(resolve_started_at(Some(original), later_now), original);
        // 同一库值两次构建字节一致（快照断言面）
        assert_eq!(started_at_section(original), started_at_section(original));
        assert_eq!(
            subagent_session_injections(Some(original), 24),
            subagent_session_injections(Some(original), 24)
        );
        // 新 spawn：库中无值 → 生成当前时间
        assert_eq!(resolve_started_at(None, later_now), later_now);
        // 坏值容错：非正数视为无效，走生成（不回退历史坏值）
        assert_eq!(resolve_started_at(Some(0), later_now), later_now);
        assert_eq!(resolve_started_at(Some(-5), later_now), later_now);
    }

    /// 指引文本存在且固定（快照断言：两次构建字节一致 + 固定措辞命中；
    /// 阈值参数化：除数字外结构字节一致）
    #[test]
    fn git_caution_section_is_fixed_and_snapshotable() {
        let guidance = git_revert_caution_section(DEFAULT_REF_AGE_THRESHOLD_HOURS);
        // 固定措辞：单文件修复优先（git checkout -- <file> 级）、不整体回退、
        // 单文件修复失败才整体回退、整体回退走 C3 门禁
        assert!(guidance.contains("git checkout -- <file>"));
        assert!(guidance.contains("单文件修复"));
        assert!(guidance.contains("不要整体回退"));
        assert!(guidance.contains("单文件修复失败"));
        assert!(guidance.contains("审批门禁"));
        assert!(guidance.contains("C3"));
        assert!(guidance.contains("审批人=user"));
        assert!(guidance.contains("full-access 不豁免"));
        assert!(guidance.contains("超过 24 小时"));
        // 快照：两次构建字节一致
        assert_eq!(
            guidance,
            git_revert_caution_section(DEFAULT_REF_AGE_THRESHOLD_HOURS)
        );
        // 阈值参数化：结构固定、数字变化（「默认 24 小时」为固定默认值文案，
        // 不随阈值变化，比较时一并归一化）
        let guidance_48 = git_revert_caution_section(48);
        assert!(guidance_48.contains("超过 48 小时"));
        assert!(!guidance_48.contains("超过 24 小时"));
        let normalize = |s: String| {
            s.replace("超过 24 小时", "超过 {threshold} 小时")
                .replace("超过 48 小时", "超过 {threshold} 小时")
                .replace("默认 24 小时", "默认 {threshold} 小时")
        };
        assert_eq!(
            normalize(guidance),
            normalize(guidance_48),
            "除阈值数字外结构字节一致"
        );
    }

    /// 注入项集合：无 started_at → 空（无注入行为不变）；有值 → 两段齐全
    #[test]
    fn inject_sections_none_when_started_at_absent() {
        assert!(
            subagent_session_injections(None, DEFAULT_REF_AGE_THRESHOLD_HOURS).is_empty(),
            "主 agent / 非子代理上下文：无注入行为不变"
        );
        let sections = subagent_session_injections(Some(ANCHOR_MS), DEFAULT_REF_AGE_THRESHOLD_HOURS);
        assert_eq!(sections.len(), 2, "有 started_at 应注入两段");
        assert_eq!(sections[0].0, STARTED_AT_SECTION_TITLE);
        assert!(sections[0].1.contains(&ANCHOR_MS.to_string()));
        assert!(sections[0].1.contains("2026-07-31T00:00:00.000Z"));
        assert_eq!(sections[1].0, REVERT_CAUTION_TITLE);
        assert!(sections[1].1.contains("git checkout -- <file>"));
        assert!(sections[1].1.contains("单文件修复"));
    }

    /// ref 年代判定：早于阈值（含等于）→ true；未超过 / ref 晚于 started_at
    /// → false；阈值可配
    #[test]
    fn ref_age_threshold_judgement() {
        let started = ANCHOR_MS; // 2026-07-31T00:00:00Z
        let hour_ms = 3_600_000;
        // ref 恰好早 24 小时（含等于触发，对齐 C3「≥」语义）
        assert!(ref_older_than_threshold(started, started - 24 * hour_ms, 24));
        // ref 早 23 小时 → 不触发
        assert!(!ref_older_than_threshold(started, started - 23 * hour_ms, 24));
        // ref 早 48 小时 → 触发
        assert!(ref_older_than_threshold(started, started - 48 * hour_ms, 24));
        // ref 晚于 started_at（时钟偏差 / 未来提交）→ 不触发
        assert!(!ref_older_than_threshold(started, started + hour_ms, 24));
        // ref 恰等于 started_at → 不触发
        assert!(!ref_older_than_threshold(started, started, 24));
        // 阈值可配：默认 24 不触发，调小后触发
        assert!(!ref_older_than_threshold(started, started - 23 * hour_ms, 24));
        assert!(ref_older_than_threshold(started, started - 23 * hour_ms, 23));
    }
}
