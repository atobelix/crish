//! 红线唯一来源。
//!
//! 规则模块只产出 [`ClassSignal`]：删除形态报告目标形态，危险模块报告反射/环境
//! 拼接，间接执行报告内层红线。只有本模块能把信号落成 [`CommandClass::Redline`]。
//! 包裹升级、PS 编码载荷、删除红线与整体优先级也都收口在这里。

use super::delete_shape::is_root_target;
use super::read_only::extract_path_targets;
use super::{CommandClass, Semantics, Segment};

/// 显式红线命令：确定性毁灭目标。
const REDLINE_COMMANDS: &[&str] = &[
    "mkfs",
    "mkfs.ext2",
    "mkfs.ext3",
    "mkfs.ext4",
    "mkfs.xfs",
    "mkfs.btrfs",
    "format-volume",
    "clear-disk",
    "format",
    "dd",
    "stop-computer",
    "restart-computer",
];

/// 规则模块产出的分类信号。红线与否由 [`resolve`] 统一裁决。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ClassSignal {
    /// 反射启动 / 动态程序集加载。
    Reflection,
    /// 内层命令行出现确定性毁灭命令。
    NestedRedline,
    /// 编码载荷无法解码。
    UndecodablePayload,
    /// 包裹或间接递归超过硬上限。
    DepthExceeded,
    /// 显式红线命令（mkfs / dd / format-volume 等）。
    ListedCommand,
    /// 对根或系统核心路径的递归/强制删除。
    RootDestructiveDelete,
    /// 普通删除形态（走回收站，不是红线）。
    DeleteShape,
    /// 环境变量拼接出的危险形态。
    EnvironmentInterpolation,
}

/// 信号落成命令分类。唯一构造 [`CommandClass::Redline`] 的位置。
pub(crate) fn resolve(signal: ClassSignal) -> CommandClass {
    match signal {
        ClassSignal::DeleteShape => CommandClass::DeleteShape,
        ClassSignal::EnvironmentInterpolation => CommandClass::Dangerous,
        ClassSignal::Reflection
        | ClassSignal::NestedRedline
        | ClassSignal::UndecodablePayload
        | ClassSignal::DepthExceeded
        | ClassSignal::ListedCommand
        | ClassSignal::RootDestructiveDelete => CommandClass::Redline,
    }
}

/// 显式红线命令信号。调用方用 [`resolve`] 落分类。
pub(crate) fn listed_command(cmd: &str) -> Option<ClassSignal> {
    REDLINE_COMMANDS
        .contains(&cmd)
        .then_some(ClassSignal::ListedCommand)
}

/// 确定性毁灭的语义结果（递归超限、编码载荷不可解）。
pub(crate) fn deterministic_semantics(signal: ClassSignal) -> Semantics {
    Semantics {
        segments: Vec::new(),
        overall: resolve(signal),
        delete_targets: Vec::new(),
        git_revert_forms: Vec::new(),
        has_indirect_delete: false,
        decoded_payload: None,
    }
}

/// 任一段红线或整体红线。
pub(crate) fn is_redline(semantics: &Semantics) -> bool {
    semantics.overall == CommandClass::Redline
        || semantics
            .segments
            .iter()
            .any(|segment| segment.class == CommandClass::Redline)
}

/// 包裹内容回升。红线、删除形态、危险三者向外冒泡。
pub(crate) fn upgrade_wrapped(class: CommandClass) -> Option<CommandClass> {
    match class {
        CommandClass::Redline => Some(CommandClass::Redline),
        CommandClass::DeleteShape => Some(CommandClass::DeleteShape),
        CommandClass::Dangerous => Some(CommandClass::Dangerous),
        _ => None,
    }
}

/// 任一段红线则整体红线；否则危险高于回退，回退高于删除，删除高于间接。
pub(crate) fn overall(segments: &[Segment]) -> CommandClass {
    let mut has_dangerous = false;
    let mut has_revert = false;
    let mut has_delete = false;
    let mut has_indirect = false;
    for segment in segments {
        match segment.class {
            CommandClass::Redline => return CommandClass::Redline,
            CommandClass::Dangerous => has_dangerous = true,
            CommandClass::GitRevertShape => has_revert = true,
            CommandClass::DeleteShape => has_delete = true,
            CommandClass::Indirect => has_indirect = true,
            CommandClass::Normal => {}
        }
    }
    if has_dangerous {
        CommandClass::Dangerous
    } else if has_revert {
        CommandClass::GitRevertShape
    } else if has_delete {
        CommandClass::DeleteShape
    } else if has_indirect {
        CommandClass::Indirect
    } else {
        CommandClass::Normal
    }
}

/// 删除红线的拒绝理由。目标取自统一拆参后的参数；转义空白并进同一 token 时
/// （`rm -rf\ /` → `-rf /`）按空白再取一次根目标，不依赖第二分词器。
pub(crate) fn inspect_redline_denial(seg: &Segment) -> Option<&'static str> {
    let cmd = seg.program.as_str();
    let expanded = expand_flag_glued_targets(&seg.args);
    if cmd == "rm" && expanded.iter().any(|arg| arg == "--no-preserve-root") {
        return Some("系统毁灭性操作已被安全策略严格阻断（Redline）：禁止使用 --no-preserve-root");
    }
    if matches!(cmd, "rm" | "del" | "erase" | "rd" | "rmdir" | "remove-item") {
        let has_recursive = expanded.iter().any(|arg| {
            arg == "-r"
                || arg == "-R"
                || arg == "--recursive"
                || arg == "-rf"
                || arg == "-fr"
                || arg.eq_ignore_ascii_case("/s")
                || arg.eq_ignore_ascii_case("-recurse")
                || (arg.starts_with('-')
                    && arg.len() > 1
                    && arg[1..].chars().any(|ch| ch == 'r' || ch == 'R'))
        });
        let mut targets = extract_path_targets(&expanded);
        targets.extend(embedded_root_targets(&seg.args));
        if has_recursive || matches!(cmd, "del" | "erase" | "rd" | "rmdir") {
            for target in &targets {
                if is_critical_system_target(target) {
                    return Some(
                        "系统毁灭性操作已被安全策略严格阻断（Redline）：禁止对根目录或系统核心路径执行破坏性删除",
                    );
                }
            }
        }
    }
    if cmd == "format"
        && expanded.iter().any(|arg| {
            let lower = arg.to_ascii_lowercase();
            lower.starts_with("c:")
                || lower.starts_with("/c:")
                || lower.len() == 2 && lower.ends_with(':')
        })
    {
        return Some("系统毁灭性操作已被安全策略严格阻断（Redline）：禁止格式化系统磁盘");
    }
    if matches!(cmd, "format-volume" | "clear-disk") {
        return Some("系统毁灭性操作已被安全策略严格阻断（Redline）：禁止格式化卷或清空磁盘");
    }
    if cmd.starts_with("mkfs") {
        return Some("系统毁灭性操作已被安全策略严格阻断（Redline）：禁止在设备上创建文件系统");
    }
    if cmd == "dd" {
        let writes_to_raw_dev = expanded.iter().any(|arg| {
            let lower = arg.to_ascii_lowercase();
            lower.starts_with("of=/dev/sd")
                || lower.starts_with("of=/dev/nvme")
                || lower.starts_with("of=/dev/vd")
                || lower.starts_with("of=/dev/disk")
        });
        if writes_to_raw_dev {
            return Some(
                "系统毁灭性操作已被安全策略严格阻断（Redline）：禁止使用 dd 直接写入磁盘块设备",
            );
        }
    }
    if cmd == "stop-computer" {
        return Some("系统毁灭性操作已被安全策略严格阻断（Redline）：禁止执行系统关机命令");
    }
    if cmd == "restart-computer"
        && expanded
            .iter()
            .any(|arg| arg.eq_ignore_ascii_case("-force"))
    {
        return Some("系统毁灭性操作已被安全策略严格阻断（Redline）：禁止强制重启系统");
    }
    None
}

/// 开关被转义空白粘上目标时拆回开关和目标。
/// 普通路径里的空格保持原样，避免把带空格的路径拆碎。
fn expand_flag_glued_targets(args: &[String]) -> Vec<String> {
    let mut expanded = Vec::new();
    for arg in args {
        if arg.starts_with('-') && arg.split_whitespace().nth(1).is_some() {
            for part in arg.split_whitespace() {
                expanded.push(part.to_string());
            }
        } else {
            expanded.push(arg.clone());
        }
    }
    expanded
}

/// 参数内含空白（转义空白被并入同一 token）时，取出其中的根目标/根通配。
/// 只认根，不拆普通带空格路径，避免把 `C:\my dir` 误判成两个目标。
fn embedded_root_targets(args: &[String]) -> Vec<String> {
    let mut targets = Vec::new();
    for arg in args {
        if !arg.chars().any(char::is_whitespace) {
            continue;
        }
        for part in arg.split_whitespace() {
            if is_root_target(part) {
                targets.push(part.to_string());
            }
        }
    }
    targets
}

pub(crate) fn is_critical_system_target(target: &str) -> bool {
    let trimmed = target.trim().trim_matches(['"', '\'']);
    if trimmed == "/" || trimmed == "/*" || trimmed == "*" {
        return true;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.len() >= 2 && lower.as_bytes()[0].is_ascii_alphabetic() && lower.as_bytes()[1] == b':'
    {
        if lower.len() == 2 {
            return true;
        }
        if lower.as_bytes()[2] == b'\\' || lower.as_bytes()[2] == b'/' {
            let rest = &lower[3..];
            if rest.is_empty() || rest == "*" || rest == "\\*" || rest == "/*" {
                return true;
            }
        } else if lower.as_bytes()[2] == b'*' {
            return true;
        }
    }
    let unix_critical = [
        "/etc", "/etc/*", "/usr", "/usr/*", "/bin", "/bin/*", "/boot", "/boot/*", "/dev", "/dev/*",
        "/lib", "/lib/*", "/root", "/root/*", "/sys", "/sys/*", "/var", "/var/*",
    ];
    for crit in unix_critical {
        if lower == crit || lower.starts_with(&format!("{}/", crit.trim_end_matches("/*"))) {
            return true;
        }
    }
    lower.starts_with("c:\\windows")
        || lower.starts_with("c:/windows")
        || lower.starts_with("c:\\program files")
        || lower.starts_with("c:/program files")
}
