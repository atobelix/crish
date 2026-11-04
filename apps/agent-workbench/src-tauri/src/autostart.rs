//! 开机自启（托盘完整档，2026-11-03）：HKCU Run 键手写注册表同步。
//!
//! # 裁定与口径
//!
//! - **不用 tauri-plugin-autostart**（设计裁定）：自启只需 HKCU
//!   `Software\Microsoft\Windows\CurrentVersion\Run` 一个值，手写
//!   windows-sys 注册表调用即可，不引新插件面。
//! - 值名固定 `Crish`，值内容 = 当前 exe 绝对路径**恒带双引号**
//!   （路径含空格时 Run 键解析不截断）。
//! - **设置即真相**：偏好 `autostart_enabled` 变更即时同步（prefs 钩子
//!   调 [sync_to_preference]），应用启动再对账一次——开：键缺失或
//!   路径过期（exe 搬家）→ 重写；关：键残留**且值指向本 exe** 才删
//!   （同名值若被改指向别的程序，不是我们的残留，不动）。
//! - 非 Windows 平台为诚实 no-op（读恒 None、写删恒 Ok）：自启是
//!   Windows 验收平台口径，macOS LaunchAgent / Linux XDG autostart
//!   待补（与 power.rs 平台层同款登记）。

use std::path::Path;

/// HKCU 自启键路径（相对 HKEY_CURRENT_USER）
pub const RUN_KEY_PATH: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/// Run 键值名（产品名，与托盘 tooltip / 菜单文案同名）
pub const RUN_VALUE_NAME: &str = "Crish";

/// 自启命令值构造：exe 绝对路径恒带双引号（空格路径防截断）
pub fn autostart_command(exe_path: &Path) -> String {
    format!("\"{}\"", exe_path.to_string_lossy())
}

/// 从 Run 值中取出目标程序路径：带引号取引号内段，未带引号取首个
/// 空白分隔段（兼容历史/外部写法的带参形态）
fn value_target_path(value: &str) -> &str {
    let trimmed = value.trim();
    if let Some(rest) = trimmed.strip_prefix('"') {
        match rest.find('"') {
            Some(end) => &rest[..end],
            None => rest,
        }
    } else {
        trimmed.split_whitespace().next().unwrap_or("")
    }
}

/// Run 值是否指向给定 exe 文件名（路径段大小写不敏感比较——
/// 「指向本 exe」的判定口径：文件名相同即同程序，目录可不同，
/// 覆盖 exe 搬家后旧路径残留的删除场景）
pub fn value_points_to_exe(value: &str, exe_file_name: &str) -> bool {
    let target = value_target_path(value);
    let name = target
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or("")
        .trim_matches('"');
    !name.is_empty() && name.eq_ignore_ascii_case(exe_file_name)
}

/// 对账裁决（纯函数，单测锁定）：偏好 × 当前注册表值 → 应执行动作
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReconcileAction {
    /// 写入（或重写）为期望命令值
    Write(String),
    /// 删除残留值
    Delete,
    /// 已与偏好一致（含「关且无残留 / 残留不归我们」）
    UpToDate,
}

/// 对账裁决：见模块头口径（开→不一致即写；关→仅删指向本 exe 的残留）
pub fn reconcile_action(
    enabled: bool,
    current: Option<&str>,
    exe_path: &Path,
) -> ReconcileAction {
    if enabled {
        let desired = autostart_command(exe_path);
        match current {
            Some(value) if value == desired => ReconcileAction::UpToDate,
            _ => ReconcileAction::Write(desired),
        }
    } else {
        let file_name = exe_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        match current {
            Some(value) if !file_name.is_empty() && value_points_to_exe(value, &file_name) => {
                ReconcileAction::Delete
            }
            _ => ReconcileAction::UpToDate,
        }
    }
}

/// 把注册表 Run 值同步到偏好（prefs 变更钩子与 setup 启动对账共用
/// 唯一实现）：读当前值 → 裁决 → 执行；返回实际执行的动作供日志。
pub fn sync_to_preference(enabled: bool) -> Result<ReconcileAction, String> {
    let exe_path = std::env::current_exe().map_err(|error| format!("current_exe: {error}"))?;
    let current = platform::read_run_value();
    let action = reconcile_action(enabled, current.as_deref(), &exe_path);
    match &action {
        ReconcileAction::Write(command) => platform::write_run_value(command)?,
        ReconcileAction::Delete => platform::delete_run_value()?,
        ReconcileAction::UpToDate => {}
    }
    Ok(action)
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{RUN_KEY_PATH, RUN_VALUE_NAME};

    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW,
        RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE,
        REG_EXPAND_SZ, REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    /// UTF-16 + NUL 终止（Win32 宽字符串入参形态）
    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// 读 Run 值（键/值不存在或类型非字符串 → None；对账据此裁决，
    /// 读失败方向安全：开→触发重写，关→不误删）
    // 豁免 unsafe_code：注册表 FFI 仅传宽字符串指针与定长缓冲，
    // 句柄在本函数内开闭配平（SAFETY：hkey 仅在打开成功后使用且
    // 恒 RegCloseKey；缓冲按注册表回填的字节数截断解码）。
    #[allow(unsafe_code)]
    pub fn read_run_value() -> Option<String> {
        unsafe {
            let path = wide(RUN_KEY_PATH);
            let mut hkey: HKEY = std::ptr::null_mut();
            if RegOpenKeyExW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                0,
                KEY_QUERY_VALUE,
                &mut hkey,
            ) != ERROR_SUCCESS
            {
                return None;
            }
            let name = wide(RUN_VALUE_NAME);
            let mut value_type: u32 = 0;
            let mut byte_len: u32 = 0;
            let probe = RegQueryValueExW(
                hkey,
                name.as_ptr(),
                std::ptr::null(),
                &mut value_type,
                std::ptr::null_mut(),
                &mut byte_len,
            );
            let result = if probe == ERROR_SUCCESS
                && (value_type == REG_SZ || value_type == REG_EXPAND_SZ)
                && byte_len >= 2
            {
                let mut buffer = vec![0u8; byte_len as usize];
                let read = RegQueryValueExW(
                    hkey,
                    name.as_ptr(),
                    std::ptr::null(),
                    &mut value_type,
                    buffer.as_mut_ptr(),
                    &mut byte_len,
                );
                if read == ERROR_SUCCESS {
                    let words: Vec<u16> = buffer[..byte_len as usize]
                        .chunks_exact(2)
                        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                        .collect();
                    Some(
                        String::from_utf16_lossy(&words)
                            .trim_end_matches('\0')
                            .to_string(),
                    )
                } else {
                    None
                }
            } else {
                None
            };
            let _ = RegCloseKey(hkey);
            result
        }
    }

    /// 写 Run 值（键不存在则创建；REG_SZ，内容含 NUL 终止）
    #[allow(unsafe_code)]
    pub fn write_run_value(command: &str) -> Result<(), String> {
        unsafe {
            let path = wide(RUN_KEY_PATH);
            let mut hkey: HKEY = std::ptr::null_mut();
            let created = RegCreateKeyExW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                0,
                std::ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                std::ptr::null(),
                &mut hkey,
                std::ptr::null_mut(),
            );
            if created != ERROR_SUCCESS {
                return Err(format!("RegCreateKeyExW failed: rc={created}"));
            }
            let name = wide(RUN_VALUE_NAME);
            let data: Vec<u16> = wide(command);
            let byte_len = (data.len() * std::mem::size_of::<u16>()) as u32;
            let written = RegSetValueExW(
                hkey,
                name.as_ptr(),
                0,
                REG_SZ,
                data.as_ptr() as *const u8,
                byte_len,
            );
            let _ = RegCloseKey(hkey);
            if written != ERROR_SUCCESS {
                return Err(format!("RegSetValueExW failed: rc={written}"));
            }
            Ok(())
        }
    }

    /// 删 Run 值（键/值不存在视为已达目标态，幂等 Ok）
    #[allow(unsafe_code)]
    pub fn delete_run_value() -> Result<(), String> {
        unsafe {
            let path = wide(RUN_KEY_PATH);
            let mut hkey: HKEY = std::ptr::null_mut();
            let opened = RegOpenKeyExW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                0,
                KEY_SET_VALUE,
                &mut hkey,
            );
            if opened == ERROR_FILE_NOT_FOUND {
                return Ok(());
            }
            if opened != ERROR_SUCCESS {
                return Err(format!("RegOpenKeyExW failed: rc={opened}"));
            }
            let name = wide(RUN_VALUE_NAME);
            let deleted = RegDeleteValueW(hkey, name.as_ptr());
            let _ = RegCloseKey(hkey);
            if deleted != ERROR_SUCCESS && deleted != ERROR_FILE_NOT_FOUND {
                return Err(format!("RegDeleteValueW failed: rc={deleted}"));
            }
            Ok(())
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    /// 非 Windows：自启未实现（诚实 no-op；见模块头登记）
    pub fn read_run_value() -> Option<String> {
        None
    }

    pub fn write_run_value(_command: &str) -> Result<(), String> {
        // TODO: macOS LaunchAgent / Linux XDG autostart 待补
        Ok(())
    }

    pub fn delete_run_value() -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn exe() -> PathBuf {
        PathBuf::from("C:\\Program Files\\Crish\\crish-agent-workbench.exe")
    }

    #[test]
    fn command_is_always_quoted() {
        assert_eq!(
            autostart_command(&exe()),
            "\"C:\\Program Files\\Crish\\crish-agent-workbench.exe\""
        );
        // 无空格路径同样带引号（口径统一，对账比较才稳定）
        assert_eq!(
            autostart_command(Path::new("D:\\apps\\crish.exe")),
            "\"D:\\apps\\crish.exe\""
        );
    }

    #[test]
    fn points_to_exe_matches_by_file_name() {
        let name = "crish-agent-workbench.exe";
        assert!(value_points_to_exe("\"C:\\a b\\crish-agent-workbench.exe\"", name));
        assert!(value_points_to_exe("C:\\old\\CRISH-AGENT-WORKBENCH.EXE", name));
        // exe 搬家：目录不同、文件名同 → 仍判 ours（关偏好时可删残留）
        assert!(value_points_to_exe("\"D:\\moved\\crish-agent-workbench.exe\"", name));
        // 带参形态取首段判定
        assert!(value_points_to_exe(
            "\"C:\\a\\crish-agent-workbench.exe\" --flag",
            name
        ));
        assert!(!value_points_to_exe("\"C:\\a\\other.exe\"", name));
        assert!(!value_points_to_exe("", name));
        assert!(!value_points_to_exe("\"C:\\a\\crish-agent-workbench.exe.bak\"", name));
    }

    #[test]
    fn reconcile_enabled_writes_unless_exact_match() {
        let desired = autostart_command(&exe());
        assert_eq!(
            reconcile_action(true, None, &exe()),
            ReconcileAction::Write(desired.clone())
        );
        assert_eq!(
            reconcile_action(true, Some(&desired), &exe()),
            ReconcileAction::UpToDate
        );
        // 路径过期（exe 搬家）→ 重写为当前路径
        assert_eq!(
            reconcile_action(true, Some("\"C:\\old\\crish-agent-workbench.exe\""), &exe()),
            ReconcileAction::Write(desired)
        );
    }

    #[test]
    fn reconcile_disabled_deletes_only_our_residue() {
        assert_eq!(reconcile_action(false, None, &exe()), ReconcileAction::UpToDate);
        assert_eq!(
            reconcile_action(false, Some("\"D:\\old\\crish-agent-workbench.exe\""), &exe()),
            ReconcileAction::Delete
        );
        // 同值名被改指向别的程序：不是我们的残留，不动
        assert_eq!(
            reconcile_action(false, Some("\"C:\\tools\\other.exe\""), &exe()),
            ReconcileAction::UpToDate
        );
    }
}
