//! C2 子代理创建时间注入 + git 回退谨慎指引（I4-M4 落地）
//!
//! 04 文档 §2 C2 的落地（02 方案 M4）：子代理知道自己「创建于哪个时间点」，
//! 从而在 git 操作上保持谨慎。分层归属（04 C2）：
//! - 提示词协议层：指引文本与结构（本模块产出，固定片段可快照断言）；
//! - 引擎 Rust：started_at 注入与目标 ref 年代计算辅助字段（本模块提供纯
//!   函数；真实 git 年代查询（`git log -1 --format=%ct <ref>`）由引擎侧接线，
//!   对齐 revert.rs「不猜命令参数」契约）。
//!
//! 挂载约定（04 §4 互斥）：run 装配在 `conex-run/src/run/run_launch.rs`
//! 的 run-task 路径经 M1 注入点挂载；M1 冻结注入顺序（system → skills →
//! mcp → agent 定义）由 `conex-run::context_injection::CONTEXT_INJECTION_ORDER` 定义，
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
//!
//! F5 EG 追加（REQ-E03 提示词面）：[comment_preservation_section] 固定注入段，
//! 约束替换时 replacement_content 完整承载原注释行——与 C2 注入同构，挂载
//! 点在 `conex-run` 的 run-task 装配路径（M1 注入点，本模块只提供固定片段）。
//!
//! F10 EG 追加（REQ-G01 文档工作区）：[output_dir_section] 参数化注入段，
//! 主控确定产出目录后通知 AI（「工作目录路径在创建后通知 AI」），与 C2 /
//! REQ-E03 注入同构；挂载点在 `conex-run` 的 run-task 装配路径（主 agent
//! 系统提示词与子代理注入面，主控已确定产出目录时 spawn 注入），本模块
//! 只提供注入函数与快照断言。

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
pub const STARTED_AT_SECTION_TITLE_EN: &str = "Session Injection (started_at)";
/// git 回退指引段标题（M1 `ContextInjection.title` 使用；render 渲染为
/// `## git 回退谨慎指引`，快照断言锚点）
pub const REVERT_CAUTION_TITLE: &str = "git 回退谨慎指引";
pub const REVERT_CAUTION_TITLE_EN: &str = "Git Revert Caution Guideline";
/// 注释保留规范段标题（M1 `ContextInjection.title` 使用；render 渲染为
/// `## 注释保留规范`，快照断言锚点）
pub const COMMENT_PRESERVATION_TITLE: &str = "注释保留规范";
pub const COMMENT_PRESERVATION_TITLE_EN: &str = "Comment Preservation Guideline";
/// 权限申请指引段标题（T-D-14 权限传递层；M1 `ContextInjection.title`
/// 使用；render 渲染为 `## 权限申请指引`，快照断言锚点）
pub const PERMISSION_RELAY_TITLE: &str = "权限申请指引";
pub const PERMISSION_RELAY_TITLE_EN: &str = "Permission Request Guideline";
/// 文档产出目录注入段标题（T-EG-09 REQ-G01 通知 AI；M1
/// `ContextInjection.title` 使用；render 渲染为 `## 文档产出目录`，
/// 快照断言锚点）
pub const OUTPUT_DIR_SECTION_TITLE: &str = "文档产出目录";
pub const OUTPUT_DIR_SECTION_TITLE_EN: &str = "Document Output Directory";

/// epoch ms → ISO8601（毫秒精度 UTC，`2026-07-31T08:00:00.000Z`；与
/// `conex-run::engine_provider::now_iso_utc` / session-loop hydrate.rs 同源的 Howard Hinnant
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
/// started_at 注入正文（不含标题行；`@dynamic` 标记 + ISO8601 + epoch ms +
/// 隔离边界声明）。支持可选 locale 语言适配（en 时输出英文）。
///
/// 注入内容是 C2 验收 1 的断言对象：系统提示词包含 started_at 且等于库内
/// session_agents.started_at（epoch ms 精确匹配 + ISO8601 可读形态双呈现）。
/// 挂载方经 `ContextInjection::new(kind, STARTED_AT_SECTION_TITLE, content)`
/// 挂载，标题由 M1 render 渲染为 `## {title}`。
pub fn started_at_section_with_locale(started_at_ms: i64, locale: Option<&str>) -> String {
    let is_en = locale.is_some_and(|l| l.to_ascii_lowercase().starts_with("en"));
    let iso = iso8601_from_epoch_ms(started_at_ms);
    if is_en {
        format!(
            "{DYNAMIC_MARKER}: Timestamp field, exempt from byte-level consistency assertion\n\
             - started_at (ISO8601 creation time): {iso}\n\
             - started_at (epoch ms creation time): {started_at_ms}\n\
             - This timestamp is part of the isolation boundary: you were created at the time above. Resumed runs (resume/fork reuse) share the same started_at and are not refreshed as the session progresses."
        )
    } else {
        format!(
            "{DYNAMIC_MARKER}：时间戳字段，字节级一致断言豁免\n\
             - started_at（创建时间 ISO8601）：{iso}\n\
             - started_at（创建时间 epoch ms）：{started_at_ms}\n\
             - 该时间点是隔离边界的一部分：你创建于上述时间点；续跑（resume/fork 复用）\
             共享同一 started_at，不随会话推进刷新。"
        )
    }
}

pub fn started_at_section(started_at_ms: i64) -> String {
    started_at_section_with_locale(started_at_ms, None)
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
/// 04 C2 验收 3 快照断言对象）。支持可选 locale 语言适配（en 时输出英文）。
///
/// 阈值参数化：文案结构固定，`{threshold_hours}` 数字随配置变化；命中
/// 「早于阈值」输出固定指引——单文件修复优先（git checkout -- <file> 级），
/// 整体回退仅在单文件修复失败后发起并走 C3 审批门禁。
/// 挂载方经 `ContextInjection::new(kind, REVERT_CAUTION_TITLE, content)`
/// 挂载。
pub fn git_revert_caution_section_with_locale(
    threshold_hours: u64,
    locale: Option<&str>,
) -> String {
    let is_en = locale.is_some_and(|l| l.to_ascii_lowercase().starts_with("en"));
    if is_en {
        format!(
            "- You are a subagent created at started_at (see above; this timestamp is part of the isolation boundary);\n\
             - Before executing git revert operations, check the target ref age: if the commit timestamp of the target ref is older than your started_at by more than {threshold_hours} hours (configurable threshold, default 24 hours), prioritize single-file repairs (git checkout -- <file> level within your file domain), and avoid overall revert;\n\
             - Only initiate an overall revert when single-file repair fails and a full revert is strictly necessary. Overall revert must go through approval gating (C3: large-scale revert approval, approver=user; not silent under Ask/Smart, Full mode exempt) and will not be executed without approval;\n\
             - When revert is rejected or exceeds threshold, narrow the revert scope or switch to single-file repair."
        )
    } else {
        format!(
            "- 你是子代理，创建于 started_at（见上，该时间点是隔离边界的一部分）；\n\
             - 执行 git 回退类操作前先自查目标状态年代：若目标 ref 的提交时间早于你的 \
             started_at 超过 {threshold_hours} 小时（判定阈值可配，默认 24 小时），\
             优先采用单文件修复（git checkout -- <file> 级别，在你的文件域内直接改文件），\
             不要整体回退；\n\
             - 只有单文件修复失败、且确需整体回退时，才发起整体回退——整体回退必须走\
             审批门禁（C3：大面积回退审批，审批人=user；Ask/Smart 下不可静默执行，Full 模式除外），\
             未经审批不会执行；\n\
             - 回退被拒或超阈值时，请缩小回退范围或改用单文件修复。"
        )
    }
}

pub fn git_revert_caution_section(threshold_hours: u64) -> String {
    git_revert_caution_section_with_locale(threshold_hours, None)
}

/// 注释保留规范注入段正文（不含标题行；REQ-E03 提示词面落地，提示词协议层
/// 固定片段，快照断言对象）。
///
/// 约束核心（04 方案 1.4 保险二）：替换时 `replacement_content` 必须完整
/// 承载目标区间内的原注释行，防止生成替换内容时遗漏原文注释；与本次修改
/// 无关的注释与文档字符串（Rustdoc/JSDoc/行内注释）不得被删除、修改或
/// 移位。机制面由 E01 精确匹配工具天然保证（未被 target_content 覆盖的
/// 内容不动），本段为提示词协议层补充约束。
/// 挂载方经 `ContextInjection::new(kind, COMMENT_PRESERVATION_TITLE, content)`
/// 挂载。
pub fn comment_preservation_section() -> String {
    "- 替换时，replacement_content 必须完整承载目标区间内的原注释行\
     （Rustdoc/JSDoc/行内注释）；\n\
     - 不得删除、修改、移位与本次修改无关的注释与文档字符串\
     （Rustdoc/JSDoc/行内注释）；\n\
     - 生成 replacement_content 时如无必要，不得改写注释内容。"
        .to_string()
}

/// 权限申请指引注入段正文（不含标题行；T-D-14 权限传递层，提示词协议层
/// 固定片段，快照断言对象）。
///
/// 文案语义（调研-权限传递层.md §2.6 / 03-D方案.md §3.14 拒绝路径节）：
/// 子代理使用系统分配的默认权限（无需申请）；确需超出默认权限时发起申请
/// 并说明理由；申请由主 agent 审批（批准继续 / 拒绝后按理由调整）；不反复
/// 相同理由重复申请、被拒后先回报主 agent 沟通。
///
/// 参数化：`task_type`（六枚举，如 implementation）与 `boundary`（一句话
/// 边界，如「可读写工作区 + 常用构建/测试命令」）为动态字段（T-D-07 默认
/// 集注册表值，spawn 时装配）；均缺省时产出纯通用段（主 agent 不配也能
/// 派，不显式声明任务类型时子代理仍收到申请纪律）。结构固定可快照断言。
/// 挂载方经 `ContextInjection::new(kind, PERMISSION_RELAY_TITLE, content)`
/// 挂载（F11 T-D-13 引擎 spawn 装配路径接入）。
pub fn permission_relay_section(task_type: Option<&str>, boundary: Option<&str>) -> String {
    let scope = match (task_type, boundary) {
        (Some(task_type), Some(boundary)) => {
            format!("你的任务类型为「{task_type}」，默认权限边界：{boundary}。\n")
        }
        (Some(task_type), None) => format!("你的任务类型为「{task_type}」。\n"),
        _ => String::new(),
    };
    format!(
        "{scope}你执行任务时使用系统分配的默认权限（按任务类型自动配置，无需你申请）。\n\
         当任务确需超出默认权限的操作（写默认范围外的路径、执行命令、调用 MCP 工具等）时：\n\
         - 不要自己假设已获得授权，也不要绕过工具边界；\n\
         - 发起权限申请并说明理由（需要什么、做什么、影响什么）；\n\
         - 申请由主 agent 审批：批准后继续执行，拒绝后按拒绝理由调整做法；\n\
         - 不要反复用相同理由重复申请，被拒后先回报主 agent 沟通。"
    )
}

/// 权限申请指引注入项（M1 挂载形状）：返回 `(标题, 正文)`，挂载方
/// `ContextInjector::push(ContextInjection::new(kind, title, content))`。
/// T-D-13 引擎 spawn 装配路径按需调用（子代理 run 才挂载）。
pub fn permission_relay_injection(
    task_type: Option<&str>,
    boundary: Option<&str>,
) -> (String, String) {
    (
        PERMISSION_RELAY_TITLE.to_string(),
        permission_relay_section(task_type, boundary),
    )
}

/// 文档产出目录注入段正文（不含标题行；REQ-G01「工作目录路径在创建后
/// 通知 AI」提示词面落地，提示词协议层固定片段，快照断言对象）。
///
/// 语义（REQ-agent-engine-capabilities.md REQ-G01 / 04 方案 T-EG-09）：
/// 主控确定产出目录后通知 AI——本次会话文档产出默认写入该目录；用户
/// 指定路径优先；目录首次写入时自动创建（惰性，无需手动建目录）。
///
/// 参数化：`path` 为产出目录路径（resolve_output_dir 返回值，G-A1 域），
/// 动态字段；文案结构固定，仅路径片段随调用变化，可快照断言（对齐
/// explore_quota credential_section / git_revert_caution_section 参数化
/// 先例）。
/// 挂载方经 `ContextInjection::new(kind, OUTPUT_DIR_SECTION_TITLE, content)`
/// 挂载（F11 T-D-13 引擎 spawn 装配路径接入；主控已确定产出目录时注入，
/// 主 agent 系统提示词与子代理注入面同构）。
pub fn output_dir_section(path: &str) -> String {
    format!(
        "- 本次会话的文档产出目录为 `{path}`（首次写入时自动创建）；\n\
         - 用户指定路径优先：若用户已另行指定产出路径，以用户指定为准；\n\
         - 后续文档产出默认写入该目录。"
    )
}

/// 文档产出目录注入项（M1 挂载形状）：返回 `(标题, 正文)`，挂载方
/// `ContextInjector::push(ContextInjection::new(kind, title, content))`。
/// 主控已确定产出目录时按需调用（主 agent 系统提示词与子代理注入面
/// 同构挂载点；F11 T-D-13 spawn 装配接入）。
pub fn output_dir_injection(path: &str) -> (String, String) {
    (
        OUTPUT_DIR_SECTION_TITLE.to_string(),
        output_dir_section(path),
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
/// 支持可选 locale 语言适配（en 时输出英文）。
///
/// - `started_at_ms = Some(ts)`：产出 started_at 段 + git 回退指引段两条；
/// - `None`（主 agent / 非子代理 run 上下文）：空列表——无注入时行为不变
///   （C2 只作用于子代理 run 上下文）。
pub fn subagent_session_injections_with_locale(
    started_at_ms: Option<i64>,
    threshold_hours: u64,
    locale: Option<&str>,
) -> Vec<(String, String)> {
    let Some(started_at_ms) = started_at_ms else {
        return Vec::new();
    };
    let is_en = locale.is_some_and(|l| l.to_ascii_lowercase().starts_with("en"));
    let title_started = if is_en {
        STARTED_AT_SECTION_TITLE_EN
    } else {
        STARTED_AT_SECTION_TITLE
    };
    let title_revert = if is_en {
        REVERT_CAUTION_TITLE_EN
    } else {
        REVERT_CAUTION_TITLE
    };
    vec![
        (
            title_started.to_string(),
            started_at_section_with_locale(started_at_ms, locale),
        ),
        (
            title_revert.to_string(),
            git_revert_caution_section_with_locale(threshold_hours, locale),
        ),
    ]
}

pub fn subagent_session_injections(
    started_at_ms: Option<i64>,
    threshold_hours: u64,
) -> Vec<(String, String)> {
    subagent_session_injections_with_locale(started_at_ms, threshold_hours, None)
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
        assert_eq!(iso8601_from_epoch_ms(ANCHOR_MS), "2026-07-31T00:00:00.000Z");
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
        let sections =
            subagent_session_injections(Some(ANCHOR_MS), DEFAULT_REF_AGE_THRESHOLD_HOURS);
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

    #[test]
    fn injected_system_prompt_english_locale() {
        let sections = subagent_session_injections_with_locale(
            Some(ANCHOR_MS),
            DEFAULT_REF_AGE_THRESHOLD_HOURS,
            Some("en"),
        );
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].0, STARTED_AT_SECTION_TITLE_EN);
        assert!(sections[0].1.contains("ISO8601 creation time"));
        assert!(sections[0]
            .1
            .contains("This timestamp is part of the isolation boundary"));
        assert_eq!(sections[1].0, REVERT_CAUTION_TITLE_EN);
        assert!(sections[1]
            .1
            .contains("You are a subagent created at started_at"));
        assert!(sections[1].1.contains("git checkout -- <file>"));
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
        assert!(guidance.contains("Ask/Smart 下不可静默执行"));
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

    /// REQ-E03 提示词面（04 方案 1.4 保险二）：注释保留段固定结构 + 固定
    /// 文案（快照断言：两次构建字节一致 + 核心约束关键词命中）
    #[test]
    fn comment_preservation_section_is_fixed_and_snapshotable() {
        let section = comment_preservation_section();
        // 核心约束关键词：完整承载原注释行 / 不得删除修改移位 / 如无必要不改写
        assert!(section.contains("replacement_content"));
        assert!(section.contains("完整承载"));
        assert!(section.contains("原注释行"));
        assert!(section.contains("不得删除、修改、移位"));
        assert!(section.contains("与本次修改无关的注释与文档字符串"));
        assert!(section.contains("Rustdoc/JSDoc/行内注释"));
        assert!(section.contains("如无必要"));
        assert!(section.contains("不得改写注释内容"));
        // 快照：无参数、两次构建字节一致（对齐 explore_quota credential_section 模式）
        assert_eq!(
            section,
            comment_preservation_section(),
            "固定注入段两次构建字节一致"
        );
        // 标题锚点固定（M1 render 渲染为 `## 注释保留规范`）
        assert_eq!(COMMENT_PRESERVATION_TITLE, "注释保留规范");
    }

    /// 注入项集合：无 started_at → 空（无注入行为不变）；有值 → 两段齐全
    #[test]
    fn inject_sections_none_when_started_at_absent() {
        assert!(
            subagent_session_injections(None, DEFAULT_REF_AGE_THRESHOLD_HOURS).is_empty(),
            "主 agent / 非子代理上下文：无注入行为不变"
        );
        let sections =
            subagent_session_injections(Some(ANCHOR_MS), DEFAULT_REF_AGE_THRESHOLD_HOURS);
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
        assert!(ref_older_than_threshold(
            started,
            started - 24 * hour_ms,
            24
        ));
        // ref 早 23 小时 → 不触发
        assert!(!ref_older_than_threshold(
            started,
            started - 23 * hour_ms,
            24
        ));
        // ref 早 48 小时 → 触发
        assert!(ref_older_than_threshold(
            started,
            started - 48 * hour_ms,
            24
        ));
        // ref 晚于 started_at（时钟偏差 / 未来提交）→ 不触发
        assert!(!ref_older_than_threshold(started, started + hour_ms, 24));
        // ref 恰等于 started_at → 不触发
        assert!(!ref_older_than_threshold(started, started, 24));
        // 阈值可配：默认 24 不触发，调小后触发
        assert!(!ref_older_than_threshold(
            started,
            started - 23 * hour_ms,
            24
        ));
        assert!(ref_older_than_threshold(
            started,
            started - 23 * hour_ms,
            23
        ));
    }

    // ── T-D-14 权限传递层：权限申请指引段 ──

    /// 段固定结构（快照断言面，对齐 explore_quota credential_section /
    /// comment_preservation_section 模式）：通用段（无参数）两次构建字节
    /// 一致 + 核心纪律关键词命中（系统默认权限 / 超出默认权限申请 /
    /// 主 agent 审批 / 说明理由 / 不反复申请 / 被拒回报）
    #[test]
    fn permission_relay_section_is_fixed_and_snapshotable() {
        let section = permission_relay_section(None, None);
        // 核心纪律：系统默认权限（无需申请）、超出默认才申请、
        // 申请由主 agent 审批、说明理由、不反复申请、被拒先回报
        assert!(section.contains("系统分配的默认权限"));
        assert!(section.contains("无需你申请"));
        assert!(section.contains("超出默认权限"));
        assert!(section.contains("发起权限申请并说明理由"));
        assert!(section.contains("需要什么、做什么、影响什么"));
        assert!(section.contains("主 agent 审批"));
        assert!(section.contains("批准后继续执行"));
        assert!(section.contains("拒绝后按拒绝理由调整做法"));
        assert!(section.contains("不要反复用相同理由重复申请"));
        assert!(section.contains("被拒后先回报主 agent 沟通"));
        assert!(section.contains("不要自己假设已获得授权"));
        assert!(section.contains("不要绕过工具边界"));
        // 快照：无参数、两次构建字节一致
        assert_eq!(section, permission_relay_section(None, None));
        // 标题锚点固定（M1 render 渲染为 `## 权限申请指引`）
        assert_eq!(PERMISSION_RELAY_TITLE, "权限申请指引");
        // 注入项形状：标题 + 正文
        let (title, content) = permission_relay_injection(None, None);
        assert_eq!(title, PERMISSION_RELAY_TITLE);
        assert_eq!(content, section);
    }

    /// 参数化：task_type 与边界一句话注入首行（动态字段），结构其余
    /// 字节一致（除参数行外固定）
    #[test]
    fn permission_relay_section_parameterized_scope_line() {
        let generic = permission_relay_section(None, None);
        let typed = permission_relay_section(
            Some("implementation"),
            Some("可读写工作区 + 常用构建/测试命令"),
        );
        assert!(typed.contains("你的任务类型为「implementation」"));
        assert!(typed.contains("默认权限边界：可读写工作区 + 常用构建/测试命令"));
        assert!(!generic.contains("你的任务类型为"));
        // 仅 task_type（无边界）→ 只有任务类型行
        let typed_only = permission_relay_section(Some("analysis"), None);
        assert!(typed_only.contains("你的任务类型为「analysis」。"));
        assert!(!typed_only.contains("默认权限边界"));
        // 结构归一化后字节一致（参数行之外固定）
        let normalize = |s: String| {
            s.split('\n')
                .filter(|l| !l.contains("你的任务类型为"))
                .collect::<Vec<_>>()
                .join("\n")
        };
        assert_eq!(normalize(generic), normalize(typed.clone()));
        // 同一参数两次构建字节一致（快照断言面）
        assert_eq!(
            typed,
            permission_relay_section(
                Some("implementation"),
                Some("可读写工作区 + 常用构建/测试命令")
            )
        );
    }

    /// 主 agent / 未声明任务类型：通用段（不显式声明任务类型时子代理
    /// 仍收到申请纪律——主 agent 不配也能派）
    #[test]
    fn permission_relay_section_defaults_to_generic() {
        let generic = permission_relay_section(None, None);
        assert!(!generic.contains("任务类型为"));
        assert!(generic.starts_with("你执行任务时使用系统分配的默认权限"));
    }

    // ── T-EG-09 产出目录注入段（REQ-G01 通知 AI）──

    /// 段固定结构（快照断言面，对齐 explore_quota.rs:587-606 credential_section
    /// / comment_preservation_section 模式）：路径参数化——同一路径两次构建
    /// 字节一致 + 核心文案关键词命中（目录路径 / 首次写入自动创建 /
    /// 用户指定优先 / 后续默认写入）+ 除路径外结构字节一致
    #[test]
    fn output_dir_section_is_fixed_and_snapshotable() {
        let path = "C:\\work\\proj\\.agent-outputs\\2026-08-05-sess-1";
        let section = output_dir_section(path);
        // 核心文案：目录路径通知 / 惰性创建 / 用户指定优先 / 默认写入
        assert!(section.contains("文档产出目录"));
        assert!(section.contains(path));
        assert!(section.contains("首次写入时自动创建"));
        assert!(section.contains("用户指定路径优先"));
        assert!(section.contains("默认写入该目录"));
        // 快照：同一路径两次构建字节一致
        assert_eq!(
            section,
            output_dir_section(path),
            "同一路径两次构建字节一致"
        );
        // 参数化：换路径仅路径片段变化，除路径外结构字节一致
        let other_path = "C:\\work\\proj\\.agent-outputs\\2026-08-06-sess-2";
        let other = output_dir_section(other_path);
        assert!(other.contains(other_path));
        assert!(!other.contains(path));
        let normalize = |s: String| s.replace(path, "{path}").replace(other_path, "{path}");
        assert_eq!(
            normalize(section.clone()),
            normalize(other),
            "除路径外结构字节一致"
        );
        // 标题锚点固定（M1 render 渲染为 `## 文档产出目录`）
        assert_eq!(OUTPUT_DIR_SECTION_TITLE, "文档产出目录");
        // 注入项形状：标题 + 正文
        let (title, content) = output_dir_injection(path);
        assert_eq!(title, OUTPUT_DIR_SECTION_TITLE);
        assert_eq!(content, section);
    }
}
