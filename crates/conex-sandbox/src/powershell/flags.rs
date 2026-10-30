//! PowerShell 启动参数识别。

/// 识别编码命令开关。覆盖短名与前缀，排除执行策略开关。
pub fn is_ps_encoded_command_flag(arg: &str) -> bool {
    let lower = arg.to_lowercase();
    let stripped = if let Some(s) = lower.strip_prefix("--") {
        s
    } else if let Some(s) = lower.strip_prefix('-').or_else(|| lower.strip_prefix('/')) {
        s
    } else {
        return false;
    };
    let flag_name = stripped.split(['=', ':']).next().unwrap_or(stripped);
    if flag_name.is_empty() || flag_name.starts_with("ex") {
        return false;
    }
    if flag_name.starts_with("ec") {
        return true;
    }
    "encodedcommand".starts_with(flag_name)
}

/// 识别工作目录启动参数，包括短名与前缀。
pub fn is_ps_working_directory_flag(arg: &str) -> bool {
    let lower = arg.to_lowercase();
    let stripped = if let Some(s) = lower.strip_prefix("--") {
        s
    } else if let Some(s) = lower.strip_prefix('-').or_else(|| lower.strip_prefix('/')) {
        s
    } else {
        return false;
    };
    let flag_name = stripped.split(['=', ':']).next().unwrap_or(stripped);
    if flag_name.is_empty() {
        return false;
    }
    if flag_name == "wd" {
        return true;
    }
    "workingdirectory".starts_with(flag_name) && flag_name.starts_with("work")
}
