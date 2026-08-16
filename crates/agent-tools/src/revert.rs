//! 大面积 git 回退审批门禁（I3-S6：C3 引擎级落地）
//!
//! C3 规格（04-Agent功能需求设计.md §2 C3）：大面积回退必须经审批，未经审批
//! 不执行，拒绝不崩溃。触发条件三阈值（任一命中即触发，含等于）：
//! - 涉及文件数 ≥ `revert_max_files`（默认 10）；
//! - 涉及行数 ≥ `revert_max_lines`（默认 300）；
//! - 目标 ref 年代 ≥ `revert_max_ref_age_hours`（默认 24 小时）。
//!
//! 本模块提供：
//! - [RevertTarget]：从语义层（conex-sandbox `GitRevertShape` 段）提取回退目标；
//! - [RevertArea]：回退面积评估结果（文件数 / 行数 / 跨目录 / ref 年代）；
//! - [RevertAssessor]：面积评估 trait——[SemanticRevertAssessor] 语义估算是默认
//!   实现，测试注入与后续真实 git 命令接线（`git diff --stat <ref>` 解析文件数
//!   与行数、`git log -1 --format=%ct <ref>` 查询 ref 年代，不猜命令参数）共用
//!   同一契约；
//! - [RevertThresholds]：三阈值（配置面默认值 + session_meta 运行时覆盖，
//!   04 Q1 裁决：默认值在配置面、覆盖走 session_meta 同键，不设第三权威）；
//! - [RevertPolicy]：判定入口——GitRevertShape + 面积超阈值 → 需审批（无论
//!   权限模式，full-access 不豁免；plan 保持更严拒绝），面积小 → 按既有矩阵；
//! - C4（S7）计数接口预留：[RevertCounterSnapshot] / [RevertCounterStore]。
//!
//! 审批人 = 用户：裁决权归用户，主 Agent 仅转呈并等待用户明确同意（05 手册
//! §2.2「用户明确同意」语义）——本模块不提供任何「主 Agent 单方面批准」路径；
//! 配套防线见 ref-analysis 01 B3：子代理结果含「已批准/等待用户确认」措辞时
//! 父代理不得当真，子代理无权绕过本门禁。

use crate::permission::{PermissionMode, PermissionVerdict};
use conex_sandbox::semantics::{analyze, CommandClass, CommandSegment, SemanticAnalysis};
use serde_json::json;
use std::sync::Arc;

/// 文件数阈值默认值（配置面，04 C3：`revert_max_files` 默认 10）
pub const DEFAULT_REVERT_MAX_FILES: u64 = 10;
/// 行数阈值默认值（配置面，04 C3：`revert_max_lines` 默认 300）
pub const DEFAULT_REVERT_MAX_LINES: u64 = 300;
/// 目标 ref 年代阈值默认值（小时，04 C3：`revert_max_ref_age_hours` 默认 24）
pub const DEFAULT_REVERT_MAX_REF_AGE_HOURS: u64 = 24;

/// session_meta 键：文件数阈值覆盖（C3 运行时可配性，04 C3 第 4 条验收）
pub const SESSION_META_KEY_REVERT_MAX_FILES: &str = "revert_max_files";
/// session_meta 键：行数阈值覆盖
pub const SESSION_META_KEY_REVERT_MAX_LINES: &str = "revert_max_lines";
/// session_meta 键：目标 ref 年代阈值覆盖（小时）
pub const SESSION_META_KEY_REVERT_MAX_REF_AGE_HOURS: &str = "revert_max_ref_age_hours";
/// session_meta 键（C4/S7 预留）：连续回退计数
pub const SESSION_META_KEY_REVERT_STREAK_COUNT: &str = "revert_streak_count";
/// session_meta 键（C4/S7 预留）：最近一次回退时间戳（Unix 秒）
pub const SESSION_META_KEY_REVERT_STREAK_LAST_AT: &str = "revert_last_at";

/// 审批人 = 用户（C3 第 4 条 + S6 内容 6）：裁决权归用户，主 Agent 仅转呈
pub const REVERT_APPROVER: &str = "user";
/// 拒绝/载荷统一指引（05 §2.1 语义：缩小回退范围或改用单文件修复）
pub const REVERT_GATE_GUIDANCE: &str = "请缩小回退范围或改用单文件修复";

/// 一次 git 回退调用的目标（从语义层 GitRevertShape 段提取，S1 分类复用）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevertTarget {
    /// 形态描述（对齐 semantics `git_revert_forms`，如 "git reset --hard HEAD~5"）
    pub form: String,
    /// 子命令（reset / checkout / clean / stash / revert / restore）
    pub subcommand: String,
    /// 目标 ref（reset/checkout/revert/restore --source 有；clean/stash 无）
    pub target_ref: Option<String>,
    /// restore 显式路径（空 = 整树恢复）
    pub pathspecs: Vec<String>,
}

impl RevertTarget {
    /// 从命令段提取回退目标（非回退段返回 None）
    pub fn from_segment(seg: &CommandSegment) -> Option<Self> {
        if seg.command != "git" || seg.class != CommandClass::GitRevertShape {
            return None;
        }
        let args = &seg.args;
        let sub = args.first()?;
        let rest = &args[1..];
        // 只认已知回退子命令（防御性：语义层分类与提取逻辑漂移时不误提取）
        if !matches!(
            sub.as_str(),
            "reset" | "checkout" | "revert" | "restore" | "clean" | "stash"
        ) {
            return None;
        }
        let (target_ref, pathspecs) = match sub.as_str() {
            // git reset [--hard] <ref>：取第一个非选项参数（未指定 → HEAD）
            "reset" => (
                rest.iter().find(|a| !a.starts_with('-')).cloned(),
                Vec::new(),
            ),
            // git checkout <旧ref>：语义层已保证是 7+ 位全 hex 的旧 ref
            //（分支名不落入 GitRevertShape，见 semantics classify_git_revert）
            "checkout" => (
                rest.iter().find(|a| !a.starts_with('-')).cloned(),
                Vec::new(),
            ),
            // git revert --no-commit <commit>
            "revert" => (
                rest.iter().find(|a| !a.starts_with('-')).cloned(),
                Vec::new(),
            ),
            // git restore --source=<ref> [pathspec...]（--source 空格形式兼容）
            "restore" => {
                let mut target: Option<String> = None;
                let mut specs = Vec::new();
                let mut iter = rest.iter();
                while let Some(a) = iter.next() {
                    if let Some(v) = a.strip_prefix("--source=") {
                        target = Some(v.to_string());
                    } else if a == "--source" {
                        target = iter.next().cloned();
                    } else if !a.starts_with('-') {
                        specs.push(a.clone());
                    }
                }
                (target, specs)
            }
            // clean -f / stash drop：无可数目标（工作区全域 / stash 条目）
            _ => (None, Vec::new()),
        };
        Some(Self {
            form: format!("git {}", args.join(" ")),
            subcommand: sub.clone(),
            target_ref,
            pathspecs,
        })
    }

    /// 从命令行文本提取（便捷入口，内部先语义分析）
    pub fn from_command_line(command_line: &str) -> Option<Self> {
        let analysis = analyze(command_line);
        let seg = analysis
            .segments
            .iter()
            .find(|s| s.class == CommandClass::GitRevertShape)?;
        Self::from_segment(seg)
    }

    /// 可读目标描述（拒绝文案 / 载荷用）
    pub fn describe(&self) -> String {
        match self.target_ref.as_deref() {
            Some(r) => r.to_string(),
            None => match self.subcommand.as_str() {
                "clean" => "工作区全部未跟踪文件".to_string(),
                "stash" => "stash 条目".to_string(),
                _ => "HEAD（未指定目标）".to_string(),
            },
        }
    }
}

/// 回退面积评估结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevertArea {
    /// 涉及文件数（None = 未知：语义估算无法得出，需真实 git 查询）
    pub file_count: Option<u64>,
    /// 涉及行数（None = 未知）
    pub line_count: Option<u64>,
    /// 是否跨目录（影响面载荷字段，S8 语义；估算值以注释说明）
    pub cross_directory: bool,
    /// 目标 ref 年代（秒；当前时间 - ref 提交时间，None = 未知）
    pub ref_age_seconds: Option<u64>,
}

impl RevertArea {
    /// 载荷 JSON（文件数 / 行数 / 跨目录 / ref 年代，04 C3 第 1 条载荷字段）
    pub fn as_json(&self) -> serde_json::Value {
        json!({
            "fileCount": self.file_count,
            "lineCount": self.line_count,
            "crossDirectory": self.cross_directory,
            "refAgeSeconds": self.ref_age_seconds,
        })
    }
}

/// 回退面积评估接口
///
/// trait 化目的：测试注入（固定面积断言阈值边界）与后续真实 git 命令接线
/// （`git diff --stat <ref>` 解析文件数/行数、`git log -1 --format=%ct <ref>`
/// 查询 ref 年代——01 方案 S6 内容 2「不猜命令参数，依赖执行前 git 语义查询」）
/// 共用同一契约。
pub trait RevertAssessor: Send + Sync + std::fmt::Debug {
    /// 评估一次回退调用的面积（无副作用；真实 git 接线实现可内置工作区根）
    fn assess(&self, target: &RevertTarget) -> RevertArea;
}

/// 语义估算实现（默认）：不执行 git 查询，从命令形态给出可数/保守的估算
///
/// - `git restore <pathspec...>`：路径数可数 → 文件数 = 路径数（小面积可精确）；
/// - `git clean -f`：工作区全域未跟踪文件 → 跨目录标记为真（面积本身未知）；
/// - 其余形态（reset --hard / checkout / revert / stash drop）：面积无法从
///   命令文本推断 → 返回未知（None），由 [RevertPolicy] 按未知面积策略裁决；
/// - ref 年代恒未知（需 `git log -1 --format=%ct` 查询，后续真实 git 接线补齐）。
#[derive(Debug, Clone, Copy, Default)]
pub struct SemanticRevertAssessor;

impl RevertAssessor for SemanticRevertAssessor {
    fn assess(&self, target: &RevertTarget) -> RevertArea {
        match target.subcommand.as_str() {
            "restore" if !target.pathspecs.is_empty() => RevertArea {
                file_count: Some(target.pathspecs.len() as u64),
                line_count: None,
                cross_directory: target.pathspecs.len() > 1,
                ref_age_seconds: None,
            },
            "clean" => RevertArea {
                file_count: None,
                line_count: None,
                cross_directory: true,
                ref_age_seconds: None,
            },
            _ => RevertArea {
                file_count: None,
                line_count: None,
                cross_directory: false,
                ref_age_seconds: None,
            },
        }
    }
}

/// 回退三阈值（C3，04:96-104）
///
/// 默认值在配置面（本结构体）；运行时覆盖走 session_meta 同键
/// （[SESSION_META_KEY_REVERT_MAX_FILES] / [SESSION_META_KEY_REVERT_MAX_LINES] /
/// [SESSION_META_KEY_REVERT_MAX_REF_AGE_HOURS]，04 Q1 裁决：消除双权威）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RevertThresholds {
    /// 文件数阈值（默认 10，触发条件 ≥）
    pub max_files: u64,
    /// 行数阈值（默认 300，触发条件 ≥）
    pub max_lines: u64,
    /// 目标 ref 年代阈值（小时，默认 24，触发条件 ≥）
    pub max_ref_age_hours: u64,
    /// 面积未知（None）维度是否按超阈值处理（默认 false = 零打扰，04 C3
    /// 验收 3「阈值内不拦」；true = 安全优先：未知面积按大面积回退触发审批）
    pub unknown_area_triggers: bool,
}

impl Default for RevertThresholds {
    fn default() -> Self {
        Self {
            max_files: DEFAULT_REVERT_MAX_FILES,
            max_lines: DEFAULT_REVERT_MAX_LINES,
            max_ref_age_hours: DEFAULT_REVERT_MAX_REF_AGE_HOURS,
            unknown_area_triggers: false,
        }
    }
}

impl RevertThresholds {
    /// 从 session_meta 键值对覆盖默认值（同键覆盖，不设第三权威；
    /// 未知键 / 非法数值忽略，保留默认）
    pub fn from_session_meta(entries: &[(&str, &str)]) -> Self {
        let mut t = Self::default();
        for (key, value) in entries {
            match *key {
                SESSION_META_KEY_REVERT_MAX_FILES => {
                    if let Ok(v) = value.parse::<u64>() {
                        t.max_files = v;
                    }
                }
                SESSION_META_KEY_REVERT_MAX_LINES => {
                    if let Ok(v) = value.parse::<u64>() {
                        t.max_lines = v;
                    }
                }
                SESSION_META_KEY_REVERT_MAX_REF_AGE_HOURS => {
                    if let Ok(v) = value.parse::<u64>() {
                        t.max_ref_age_hours = v;
                    }
                }
                _ => {}
            }
        }
        t
    }
}

/// 回退审批判定策略（C3 判定入口）
#[derive(Debug, Clone)]
pub struct RevertPolicy {
    /// 三阈值（配置面默认 + session_meta 覆盖）
    pub thresholds: RevertThresholds,
    /// 面积评估器（测试注入 / 真实 git 接线；默认语义估算）
    pub assessor: Arc<dyn RevertAssessor>,
}

impl Default for RevertPolicy {
    fn default() -> Self {
        Self {
            thresholds: RevertThresholds::default(),
            assessor: Arc::new(SemanticRevertAssessor),
        }
    }
}

impl RevertPolicy {
    /// 新建默认策略（语义估算 + 默认阈值）
    pub fn new() -> Self {
        Self::default()
    }

    /// 替换面积评估器（测试注入 / 后续真实 git 接线）
    pub fn with_assessor(mut self, assessor: Arc<dyn RevertAssessor>) -> Self {
        self.assessor = assessor;
        self
    }

    /// 替换阈值（session_meta 运行时覆盖等）
    pub fn with_thresholds(mut self, thresholds: RevertThresholds) -> Self {
        self.thresholds = thresholds;
        self
    }

    /// 面积是否触发审批：任一已知维度 ≥ 阈值即触发（含等于）；未知维度按
    /// `unknown_area_triggers` 策略处理（默认不触发，零打扰）
    pub fn needs_approval(&self, area: &RevertArea) -> bool {
        let t = &self.thresholds;
        if t.unknown_area_triggers
            && (area.file_count.is_none()
                || area.line_count.is_none()
                || area.ref_age_seconds.is_none())
        {
            return true;
        }
        area.file_count.map(|v| v >= t.max_files).unwrap_or(false)
            || area.line_count.map(|v| v >= t.max_lines).unwrap_or(false)
            || area
                .ref_age_seconds
                .map(|v| v >= t.max_ref_age_hours * 3600)
                .unwrap_or(false)
    }

    /// C3 判定点：分析后命中 GitRevertShape 段且面积超阈值 → Some(判定)；
    /// 面积小 / 非回退形态 → None（按既有三态矩阵）。
    ///
    /// P1 权限归一（D5/D8）：本方法是命令判定唯一链
    /// [crate::permission::decide_command_with_revert] 的 C3 回退护栏挂载点
    /// （链内调用）；原字符串便捷入口已随收敛删除。
    ///
    /// - ask / full-access → [PermissionVerdict::NeedsApproval]（full-access
    ///   不豁免回退护栏——红线类豁免不可覆盖大面积回退，任务卡口径）；
    /// - plan → [PermissionVerdict::Deny]（plan 只读语义优先：拒绝强度高于
    ///   审批、不弹窗，权限矩阵不被回退门禁放宽——「无论 mode」指 full-access
    ///   不豁免，plan 既有更严拒绝语义保持）。
    pub fn gate_verdict(
        &self,
        analysis: &SemanticAnalysis,
        mode: PermissionMode,
    ) -> Option<PermissionVerdict> {
        let seg = analysis
            .segments
            .iter()
            .find(|s| s.class == CommandClass::GitRevertShape)?;
        let target = RevertTarget::from_segment(seg)?;
        let area = self.assessor.assess(&target);
        if !self.needs_approval(&area) {
            return None;
        }
        Some(match mode {
            PermissionMode::Plan => PermissionVerdict::Deny,
            _ => PermissionVerdict::NeedsApproval,
        })
    }

    /// C3 兜底拒绝文案：审批通道缺失时阈值检查仍生效（安全优先，不做无限
    /// 等待，04 C3 第 2/5 条 + 01 方案 §4 关键关系），拒绝给出面积摘要与
    /// 替代路径指引（05 §2.1 语义）。非回退 / 小面积 → None。
    pub fn refusal_message(&self, command_line: &str) -> Option<String> {
        let analysis = analyze(command_line);
        let seg = analysis
            .segments
            .iter()
            .find(|s| s.class == CommandClass::GitRevertShape)?;
        let target = RevertTarget::from_segment(seg)?;
        let area = self.assessor.assess(&target);
        if !self.needs_approval(&area) {
            return None;
        }
        let files = describe_optional(area.file_count);
        let lines = describe_optional(area.line_count);
        let age = match area.ref_age_seconds {
            Some(v) => format!("{:.1} 小时", v as f64 / 3600.0),
            None => "未知".to_string(),
        };
        Some(format!(
            "大面积 git 回退需用户审批（文件数 {files}、行数 {lines}、目标 ref {target}、ref 年代 {age}；审批人={REVERT_APPROVER}，full-access 不豁免），审批通道不可用，已拒绝执行；{REVERT_GATE_GUIDANCE}",
            target = target.describe(),
        ))
    }

    /// 审批请求载荷（04 C3 第 1 条：文件数 / 行数 / 目标 ref / ref 年代，
    /// 发起 run 由事件层补）——供审批事件 / UI 弹窗（S9）消费；非回退 /
    /// 小面积 → None。
    pub fn approval_payload(&self, command_line: &str) -> Option<serde_json::Value> {
        let analysis = analyze(command_line);
        let seg = analysis
            .segments
            .iter()
            .find(|s| s.class == CommandClass::GitRevertShape)?;
        let target = RevertTarget::from_segment(seg)?;
        let area = self.assessor.assess(&target);
        if !self.needs_approval(&area) {
            return None;
        }
        Some(json!({
            "revertGate": {
                "form": target.form,
                "targetRef": target.target_ref,
                "target": target.describe(),
                "area": area.as_json(),
                "thresholds": {
                    "maxFiles": self.thresholds.max_files,
                    "maxLines": self.thresholds.max_lines,
                    "maxRefAgeHours": self.thresholds.max_ref_age_hours,
                },
                "approver": REVERT_APPROVER,
                "guidance": REVERT_GATE_GUIDANCE,
            }
        }))
    }
}

/// 可读数量描述（未知 → 「未知」）
fn describe_optional(v: Option<u64>) -> String {
    v.map(|v| v.to_string())
        .unwrap_or_else(|| "未知".to_string())
}

/// C4 连续回退计数快照（04 C4：`revert_streak_count` / `revert_last_at`；
/// S7 实现消费，本任务只定义接口契约）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RevertCounterSnapshot {
    /// 会话内连续回退计数（每次回退调用 +1，时窗归零）
    pub streak_count: u64,
    /// 最近一次回退时间戳（Unix 秒；None = 本会话尚无回退）
    pub last_revert_at_unix: Option<i64>,
}

impl RevertCounterSnapshot {
    /// 空快照（无回退记录）
    pub fn new() -> Self {
        Self {
            streak_count: 0,
            last_revert_at_unix: None,
        }
    }
}

impl Default for RevertCounterSnapshot {
    fn default() -> Self {
        Self::new()
    }
}

/// 会话级回退计数读写接口（C4/S7 预留）
///
/// S7 实现为 session_meta 持久化版（键 [SESSION_META_KEY_REVERT_STREAK_COUNT] /
/// [SESSION_META_KEY_REVERT_STREAK_LAST_AT]，重启可恢复，04 C4 第 2 条）；
/// 本任务只定义契约与内存测试实现；判定挂载点经 C3 判定点（S6）预留，
/// C4 不并写 tool_events.rs / tool_exec.rs 主体（04 §4 互斥约定）。
/// 不设 Debug 超类约束（实现方自由度：会话级结构不要求可调试序列化）。
pub trait RevertCounterStore: Send + Sync {
    /// 读取当前会话计数（不可用 / 无记录时返回 [RevertCounterSnapshot::new]）
    fn load(&self, session_id: &str) -> RevertCounterSnapshot;
    /// 写回计数（调用方保证会话内串行；S7 计数变更随审批事件一并落 events）
    fn save(&self, session_id: &str, snapshot: RevertCounterSnapshot);
}

/// 内存版计数存储（测试 / 未接线兜底；不跨重启持久化）
#[derive(Debug, Default)]
pub struct InMemoryRevertCounterStore {
    inner: std::sync::Mutex<std::collections::HashMap<String, RevertCounterSnapshot>>,
}

impl InMemoryRevertCounterStore {
    /// 新建空存储
    pub fn new() -> Self {
        Self::default()
    }
}

impl RevertCounterStore for InMemoryRevertCounterStore {
    fn load(&self, session_id: &str) -> RevertCounterSnapshot {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
            .copied()
            .unwrap_or_default()
    }

    fn save(&self, session_id: &str, snapshot: RevertCounterSnapshot) {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(session_id.to_string(), snapshot);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_sandbox::semantics::CommandSegment;

    /// 固定面积评估器（测试注入：断言阈值边界与判定链路）
    #[derive(Debug)]
    struct FixedArea(RevertArea);

    impl RevertAssessor for FixedArea {
        fn assess(&self, _target: &RevertTarget) -> RevertArea {
            self.0.clone()
        }
    }

    fn policy_with(area: RevertArea) -> RevertPolicy {
        RevertPolicy::default().with_assessor(Arc::new(FixedArea(area)))
    }

    fn area(files: Option<u64>, lines: Option<u64>, ref_age_hours: Option<u64>) -> RevertArea {
        RevertArea {
            file_count: files,
            line_count: lines,
            cross_directory: false,
            ref_age_seconds: ref_age_hours.map(|h| h * 3600),
        }
    }

    /// 面积阈值边界（S6 验收：小/大）——含等于触发，不含不触发
    #[test]
    fn threshold_boundaries_files_lines_age() {
        let policy = RevertPolicy::default();
        // 文件数：9 不触发，10 触发（含等于）
        assert!(!policy.needs_approval(&area(Some(9), None, None)));
        assert!(policy.needs_approval(&area(Some(10), None, None)));
        // 行数：299 不触发，300 触发
        assert!(!policy.needs_approval(&area(None, Some(299), None)));
        assert!(policy.needs_approval(&area(None, Some(300), None)));
        // ref 年代：23 小时不触发，24 小时触发（含等于）
        assert!(!policy.needs_approval(&area(None, None, Some(23))));
        assert!(policy.needs_approval(&area(None, None, Some(24))));
        // 任一维度超阈值即触发
        assert!(policy.needs_approval(&area(Some(2), Some(500), None)));
    }

    /// 未知面积默认零打扰（不触发；04 C3 验收 3）
    #[test]
    fn unknown_dimensions_do_not_trigger_by_default() {
        let policy = RevertPolicy::default();
        let unknown = RevertArea {
            file_count: None,
            line_count: None,
            cross_directory: false,
            ref_age_seconds: None,
        };
        assert!(!policy.needs_approval(&unknown));
    }

    /// 未知面积安全优先模式：任一维度未知即触发（可配）
    #[test]
    fn unknown_area_triggers_conservative_mode() {
        let policy = RevertPolicy::default().with_thresholds(RevertThresholds {
            unknown_area_triggers: true,
            ..RevertThresholds::default()
        });
        assert!(policy.needs_approval(&area(None, None, None)));
        assert!(policy.needs_approval(&area(Some(1), None, None)));
        // 全维度已知且低于阈值 → 不触发
        assert!(!policy.needs_approval(&area(Some(1), Some(1), Some(1))));
    }

    /// 回退目标提取：七种形态全量（checkout 旧 ref / reset --hard / clean -f /
    /// stash drop / revert --no-commit / restore --source= / restore --source 空格）
    #[test]
    fn target_extraction_from_segments() {
        let seg = |command: &str, args: &[&str]| CommandSegment {
            command: command.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            class: CommandClass::GitRevertShape,
            targets: Vec::new(),
        };

        let t = RevertTarget::from_segment(&seg("git", &["checkout", "abc1234"])).unwrap();
        assert_eq!(t.subcommand, "checkout");
        assert_eq!(t.target_ref.as_deref(), Some("abc1234"));

        let t = RevertTarget::from_segment(&seg("git", &["reset", "--hard", "HEAD~5"])).unwrap();
        assert_eq!(t.subcommand, "reset");
        assert_eq!(t.target_ref.as_deref(), Some("HEAD~5"));
        // reset --hard 未指定 ref → None（HEAD 隐含）
        let t = RevertTarget::from_segment(&seg("git", &["reset", "--hard"])).unwrap();
        assert_eq!(t.target_ref, None);

        let t = RevertTarget::from_segment(&seg("git", &["clean", "-f"])).unwrap();
        assert_eq!(t.subcommand, "clean");
        assert_eq!(t.target_ref, None);
        assert!(t.pathspecs.is_empty());

        let t = RevertTarget::from_segment(&seg("git", &["stash", "drop"])).unwrap();
        assert_eq!(t.subcommand, "stash");

        let t =
            RevertTarget::from_segment(&seg("git", &["revert", "--no-commit", "abc1234"])).unwrap();
        assert_eq!(t.target_ref.as_deref(), Some("abc1234"));

        // restore --source= 等号形式 + 路径
        let t =
            RevertTarget::from_segment(&seg("git", &["restore", "--source=HEAD~3", "src/main.rs"]))
                .unwrap();
        assert_eq!(t.target_ref.as_deref(), Some("HEAD~3"));
        assert_eq!(t.pathspecs, vec!["src/main.rs".to_string()]);
        // restore --source 空格形式
        let t = RevertTarget::from_segment(&seg(
            "git",
            &["restore", "--source", "HEAD~3", "a.rs", "b.rs"],
        ))
        .unwrap();
        assert_eq!(t.target_ref.as_deref(), Some("HEAD~3"));
        assert_eq!(t.pathspecs, vec!["a.rs".to_string(), "b.rs".to_string()]);

        // 非回退段 / 非 git 段 → None
        assert!(RevertTarget::from_segment(&seg("git", &["status"])).is_none());
        assert!(RevertTarget::from_segment(&seg("ls", &["-la"])).is_none());
    }

    /// 命令行便捷提取：checkout 旧 ref 命中、分支名不命中
    #[test]
    fn from_command_line_extracts_target() {
        let t = RevertTarget::from_command_line("git checkout abc1234").unwrap();
        assert_eq!(t.target_ref.as_deref(), Some("abc1234"));
        assert!(RevertTarget::from_command_line("git checkout main").is_none());
        assert!(RevertTarget::from_command_line("git status").is_none());
    }

    /// 语义估算：restore 路径数可数；clean 全域跨目录；reset 面积未知
    #[test]
    fn semantic_assessor_estimates() {
        let a = SemanticRevertAssessor;
        let restore =
            RevertTarget::from_command_line("git restore --source=HEAD~3 a.rs b.rs").unwrap();
        let area = a.assess(&restore);
        assert_eq!(area.file_count, Some(2));
        assert!(area.cross_directory, "两个路径估算为跨目录");
        assert_eq!(area.ref_age_seconds, None);

        let single =
            RevertTarget::from_command_line("git restore --source=HEAD~3 src/main.rs").unwrap();
        let area = a.assess(&single);
        assert_eq!(area.file_count, Some(1));
        assert!(!area.cross_directory);

        let clean = RevertTarget::from_command_line("git clean -f").unwrap();
        let area = a.assess(&clean);
        assert!(area.cross_directory, "clean -f 覆盖工作区全域未跟踪文件");
        assert_eq!(area.file_count, None);

        let reset = RevertTarget::from_command_line("git reset --hard HEAD~5").unwrap();
        let area = a.assess(&reset);
        assert_eq!(area.file_count, None, "面积无法从命令文本推断");
    }

    /// session_meta 运行时覆盖（04 C3 验收 4：阈值键改动行为随之变化）
    #[test]
    fn session_meta_overrides_change_behavior() {
        let default = RevertThresholds::default();
        assert_eq!(default.max_files, 10);
        assert_eq!(default.max_lines, 300);
        assert_eq!(default.max_ref_age_hours, 24);

        let overridden = RevertThresholds::from_session_meta(&[
            (SESSION_META_KEY_REVERT_MAX_FILES, "30"),
            (SESSION_META_KEY_REVERT_MAX_LINES, "999"),
            (SESSION_META_KEY_REVERT_MAX_REF_AGE_HOURS, "48"),
            ("unknown_key", "1"),
        ]);
        assert_eq!(overridden.max_files, 30);
        assert_eq!(overridden.max_lines, 999);
        assert_eq!(overridden.max_ref_age_hours, 48);

        // 25 文件：默认阈值触发，覆盖后不触发
        let default_policy = RevertPolicy::default();
        let overridden_policy = RevertPolicy::default().with_thresholds(overridden);
        assert!(default_policy.needs_approval(&area(Some(25), None, None)));
        assert!(!overridden_policy.needs_approval(&area(Some(25), None, None)));

        // 非法值忽略保留默认
        let bad =
            RevertThresholds::from_session_meta(&[(SESSION_META_KEY_REVERT_MAX_FILES, "abc")]);
        assert_eq!(bad.max_files, 10);
    }

    /// C3 判定点：面积小 → 不拦截（None，按既有矩阵）；面积大 →
    /// ask/full-access NeedsApproval、plan Deny
    ///
    /// P1 权限归一（D5/D8）：断言经 [Self::gate_verdict]（命令判定唯一链
    /// 的护栏挂载点）执行——原字符串便捷入口已删除。
    #[test]
    fn gate_verdict_small_vs_large_and_modes() {
        let small = policy_with(area(Some(3), None, None));
        let large = policy_with(area(Some(25), None, None));
        let cmd = analyze("git checkout abc1234");
        for mode in [
            PermissionMode::Ask,
            PermissionMode::FullAccess,
            PermissionMode::Plan,
        ] {
            assert_eq!(
                small.gate_verdict(&cmd, mode),
                None,
                "小面积在 {mode:?} 下不触发 C3（零打扰）"
            );
        }
        assert_eq!(
            large.gate_verdict(&cmd, PermissionMode::FullAccess),
            Some(PermissionVerdict::NeedsApproval),
            "full-access 不豁免大面积回退"
        );
        assert_eq!(
            large.gate_verdict(&cmd, PermissionMode::Ask),
            Some(PermissionVerdict::NeedsApproval)
        );
        assert_eq!(
            large.gate_verdict(&cmd, PermissionMode::Plan),
            Some(PermissionVerdict::Deny),
            "plan 只读：拒绝强度高于审批（不弹窗）"
        );
    }

    /// 非回退命令不被门禁误拦
    #[test]
    fn gate_verdict_ignores_non_revert_commands() {
        let large = policy_with(area(Some(25), None, None));
        for cmd in ["git status", "git checkout main", "npm test", "ls -la"] {
            assert_eq!(
                large.gate_verdict(&analyze(cmd), PermissionMode::FullAccess),
                None,
                "非回退命令 {cmd:?} 不触发 C3"
            );
        }
    }

    /// 兜底拒绝文案：含面积摘要 / 目标 ref / 审批人语义 / 替代路径指引
    #[test]
    fn refusal_message_shape() {
        let large = policy_with(area(Some(25), Some(1200), Some(36)));
        let msg = large
            .refusal_message("git checkout abc1234")
            .expect("大面积回退应有拒绝文案");
        assert!(msg.contains("文件数 25"));
        assert!(msg.contains("行数 1200"));
        assert!(msg.contains("目标 ref abc1234"));
        assert!(msg.contains("36.0 小时"));
        assert!(msg.contains("审批人=user"));
        assert!(msg.contains("full-access 不豁免"));
        assert!(msg.contains("缩小回退范围或改用单文件修复"));
        // 小面积 / 非回退 → None
        assert!(policy_with(area(Some(3), None, None))
            .refusal_message("git checkout abc1234")
            .is_none());
        assert!(large.refusal_message("git status").is_none());
    }

    /// 审批载荷：文件数 / 行数 / 目标 ref / ref 年代 / 阈值 / 审批人=用户
    #[test]
    fn approval_payload_shape() {
        let large = policy_with(area(Some(25), Some(1200), Some(36)));
        let payload = large
            .approval_payload("git checkout abc1234")
            .expect("大面积回退应有审批载荷");
        assert_eq!(payload["revertGate"]["approver"], "user");
        assert_eq!(payload["revertGate"]["targetRef"], "abc1234");
        assert_eq!(payload["revertGate"]["area"]["fileCount"], 25);
        assert_eq!(payload["revertGate"]["area"]["lineCount"], 1200);
        assert_eq!(payload["revertGate"]["area"]["refAgeSeconds"], 129600);
        assert_eq!(payload["revertGate"]["thresholds"]["maxFiles"], 10);
        assert!(payload["revertGate"]["guidance"]
            .as_str()
            .unwrap()
            .contains("单文件修复"));
        assert!(large.approval_payload("git status").is_none());
    }

    /// C4 计数接口（S7 预留）：内存存储读写往返 + 空快照语义
    #[test]
    fn counter_store_roundtrip() {
        let store = InMemoryRevertCounterStore::new();
        assert_eq!(store.load("s1"), RevertCounterSnapshot::new());
        let snap = RevertCounterSnapshot {
            streak_count: 3,
            last_revert_at_unix: Some(1_752_000_000),
        };
        store.save("s1", snap);
        assert_eq!(store.load("s1"), snap);
        // 会话隔离
        assert_eq!(store.load("s2"), RevertCounterSnapshot::new());
        // 覆盖写回
        let snap2 = RevertCounterSnapshot {
            streak_count: 4,
            last_revert_at_unix: Some(1_752_000_060),
        };
        store.save("s1", snap2);
        assert_eq!(store.load("s1"), snap2);
    }

    /// C4 session_meta 键名与 04 规格一致（S7 实现按此键持久化）
    #[test]
    fn counter_session_meta_keys_match_c4_spec() {
        assert_eq!(SESSION_META_KEY_REVERT_STREAK_COUNT, "revert_streak_count");
        assert_eq!(SESSION_META_KEY_REVERT_STREAK_LAST_AT, "revert_last_at");
        assert_eq!(SESSION_META_KEY_REVERT_MAX_FILES, "revert_max_files");
        assert_eq!(SESSION_META_KEY_REVERT_MAX_LINES, "revert_max_lines");
        assert_eq!(
            SESSION_META_KEY_REVERT_MAX_REF_AGE_HOURS,
            "revert_max_ref_age_hours"
        );
    }
}
