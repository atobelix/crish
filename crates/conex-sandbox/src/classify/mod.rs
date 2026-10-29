//! 命令分类。语义六类与智能裁决共用这一套规则，不再各写一份。
//!
//! 同一层命令行只拆一次：`analyze_depth` 产出 [`Segment`]（含分类与目标），
//! 智能裁决直接消费这份结果。递归包裹与间接执行属于内层命令行，按层重新解析。

pub(crate) mod dangerous;
pub(crate) mod delete_shape;
pub(crate) mod git;
pub(crate) mod indirect;
pub(crate) mod read_only;
pub(crate) mod redline;

#[cfg(test)]
mod semantics_tests_a;
#[cfg(test)]
mod semantics_tests_b;
#[cfg(test)]
mod semantics_tests_c;
#[cfg(test)]
mod smart_tests_a;
#[cfg(test)]
mod smart_tests_b;

use delete_shape::{classify_delete_command, extract_delete_targets, is_delete_command};
use delete_shape::normalize_command;
use git::classify_git_revert;
use indirect::{analyze_inner, is_indirect_command};
use redline::{overall, resolve, upgrade_wrapped, ClassSignal};

use crate::lex::{extract_wrapped_content, split_command_args_normalized, split_segments};
use serde::{Deserialize, Serialize};

/// 包裹递归深度上限。达到该深度时整段判为危险。
pub(crate) const MAX_RECURSION_DEPTH: usize = 5;
/// 包裹内容与红线递归的硬上限。超过即按确定性毁灭处理。
pub(crate) const MAX_WRAP_DEPTH: usize = 16;

/// 唯一命令段。语义分类与智能裁决共用同一份字段，不再各自拆参。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Segment {
    pub raw: String,
    pub program: String,
    pub args: Vec<String>,
    pub class: CommandClass,
    pub targets: Vec<String>,
}

/// 命令分类。六类的优先级在红线模块收口。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CommandClass {
    /// 普通命令。
    #[default]
    Normal,
    /// 确定性毁灭目标。
    Redline,
    /// 常规危险形态，需要审批。
    Dangerous,
    /// 删除形态，走删除接管。
    DeleteShape,
    /// 版本库回退形态。
    GitRevertShape,
    /// 间接执行。
    Indirect,
}

/// 一次语义分析的全部产物。内部结构，对外只经 [`crate::assess`] 暴露。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Semantics {
    pub segments: Vec<Segment>,
    pub overall: CommandClass,
    pub delete_targets: Vec<String>,
    pub git_revert_forms: Vec<String>,
    pub has_indirect_delete: bool,
    pub decoded_payload: Option<String>,
}

/// 智能裁决的三态载荷。拒绝优先于审批。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SmartDecision {
    pub deny_reason: Option<&'static str>,
    pub approval: Option<ApprovalReason>,
    pub pure_read_only: bool,
}

/// 需要审批的原因。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "category", content = "details")]
pub enum ApprovalReason {
    /// 破坏性删除。
    DestructiveDelete { targets: Vec<String> },
    /// 版本库历史改写或强推。
    GitHistoryRewrite { operation: String },
    /// 提权。
    PrivilegeEscalation { command: String },
    /// 远程脚本管道进解释器。
    RemotePipeExecution { pipeline: String },
    /// 向外发布包。
    PackagePublish { registry: String },
    /// 无法确定的写副作用。
    UnsafeSideEffect { command: String },
}

impl ApprovalReason {
    /// 审批卡片与审计日志共用的简短说明。
    pub fn summary(&self) -> String {
        match self {
            Self::DestructiveDelete { targets } => {
                if targets.is_empty() {
                    "破坏性删除".to_string()
                } else {
                    format!("破坏性删除：{}", targets.join("、"))
                }
            }
            Self::GitHistoryRewrite { operation } => format!("Git 历史重写或强推：{operation}"),
            Self::PrivilegeEscalation { command } => format!("系统提权：{command}"),
            Self::RemotePipeExecution { pipeline } => format!("远程脚本管道执行：{pipeline}"),
            Self::PackagePublish { registry } => format!("向外发布包：{registry}"),
            Self::UnsafeSideEffect { command } => format!("包含不确定写副作用的命令：{command}"),
        }
    }
}

/// 语义分析入口。唯一拆段点；智能裁决复用返回的段。
pub(crate) fn classify_semantics(command_line: &str) -> Semantics {
    analyze_depth(command_line, 0)
}

pub(crate) fn analyze_depth(command_line: &str, depth: usize) -> Semantics {
    if depth > MAX_WRAP_DEPTH {
        return redline::deterministic_semantics(ClassSignal::DepthExceeded);
    }
    let raw_segments = split_segments(command_line);
    let mut segments = Vec::new();
    let mut delete_targets = Vec::new();
    let mut git_revert_forms = Vec::new();
    let mut has_indirect_delete = false;
    let mut decoded_payload = None;

    for raw in raw_segments {
        let (command, args) = split_command_args_normalized(&raw);
        let program = normalize_command(&command);
        // 间接执行的内层是独立命令行，按层重新解析；本段的 program/args 只拆这一次。
        let inner = if is_indirect_command(&program) {
            analyze_inner(&program, &args, depth + 1)
        } else {
            None
        };
        let class = classify_depth(&program, &args, &raw, depth, inner.as_ref());
        let mut segment = Segment {
            raw,
            program,
            args,
            class,
            targets: Vec::new(),
        };
        if let Some(inner) = &inner {
            if inner.decoded_payload.is_some() && decoded_payload.is_none() {
                decoded_payload = inner.decoded_payload.clone();
            }
            if inner.overall == CommandClass::DeleteShape || inner.has_indirect_delete {
                has_indirect_delete = true;
            }
            for target in &inner.delete_targets {
                if !delete_targets.contains(target) {
                    delete_targets.push(target.clone());
                }
            }
        }
        if is_delete_command(&segment.program) {
            segment.targets = extract_delete_targets(&segment.program, &segment.args);
            for target in &segment.targets {
                if !delete_targets.contains(target) {
                    delete_targets.push(target.clone());
                }
            }
        }
        if segment.program == "git" {
            if let Some(form) = classify_git_revert(&segment.args) {
                segment.class = CommandClass::GitRevertShape;
                if !git_revert_forms.contains(&form) {
                    git_revert_forms.push(form);
                }
            }
        }
        segments.push(segment);
    }

    Semantics {
        overall: overall(&segments),
        segments,
        delete_targets,
        git_revert_forms,
        has_indirect_delete,
        decoded_payload,
    }
}

/// 单段的分类。内层分析结果由调用方传入，避免对同一段二次拆参。
fn classify_depth(
    program: &str,
    args: &[String],
    segment_raw: &str,
    depth: usize,
    inner: Option<&Semantics>,
) -> CommandClass {
    if depth <= MAX_WRAP_DEPTH && !is_indirect_command(program) {
        for inner_line in extract_wrapped_content(segment_raw) {
            let inner_class = analyze_depth(&inner_line, depth + 1).overall;
            if let Some(upgraded) = upgrade_wrapped(inner_class) {
                return upgraded;
            }
        }
    }
    if !is_indirect_command(program) {
        let ast_class = dangerous::analyze_segment_ast(program, args, depth);
        if ast_class == CommandClass::Redline || ast_class == CommandClass::Dangerous {
            return ast_class;
        }
    }
    if is_indirect_command(program) {
        if let Some(inner) = inner {
            if inner.overall == CommandClass::Redline {
                return resolve(ClassSignal::NestedRedline);
            }
            if inner.overall == CommandClass::Dangerous {
                return CommandClass::Dangerous;
            }
            if inner.overall == CommandClass::GitRevertShape
                || inner.overall == CommandClass::DeleteShape
                || inner.has_indirect_delete
                || !inner.segments.is_empty()
            {
                return CommandClass::Indirect;
            }
        }
    }
    if let Some(signal) = classify_delete_command(program, args) {
        return resolve(signal);
    }
    if program == "git" {
        if args.first().map(String::as_str) == Some("rm") {
            return CommandClass::DeleteShape;
        }
        if classify_git_revert(args).is_some() {
            return CommandClass::GitRevertShape;
        }
        return CommandClass::Normal;
    }
    if let Some(signal) = redline::listed_command(program) {
        return resolve(signal);
    }
    if dangerous::is_dangerous_command(program) {
        return CommandClass::Dangerous;
    }
    if program == "curl" || program == "wget" {
        return CommandClass::Dangerous;
    }
    if let Some(class) = dangerous::scan_ps_command_tokens(program, args) {
        return class;
    }
    CommandClass::Normal
}

pub(crate) fn dangerous_fallback() -> Semantics {
    Semantics {
        segments: Vec::new(),
        overall: CommandClass::Dangerous,
        delete_targets: Vec::new(),
        git_revert_forms: Vec::new(),
        has_indirect_delete: false,
        decoded_payload: None,
    }
}

pub(crate) fn empty_normal() -> Semantics {
    Semantics {
        segments: Vec::new(),
        overall: CommandClass::Normal,
        delete_targets: Vec::new(),
        git_revert_forms: Vec::new(),
        has_indirect_delete: false,
        decoded_payload: None,
    }
}
