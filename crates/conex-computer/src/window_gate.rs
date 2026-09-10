//! 动作前检查器·桌面线(05 文档 §5.2):`WindowTargetGate` 实现共享层
//! `ActionTargetGate`——窗口白名单匹配 + 提权探测。
//!
//! 检查次序(05 §5.2):① 提权探测(目标进程提权 → `TargetDenialKind::Elevated`,
//! reason 携带 `tool.computer.elevated_window` 语义,04 §6.2 风险 R3)→
//! ② 白名单匹配(标题/进程;白名单为空 = 默认放行,04 §4 项 6)。
//! `ActionTarget::Url` 属浏览器线,桌面门禁返回「目标类型不适用」。
//!
//! 提权探测抽象 [`ElevationProbe`] 可注入(测试 mock / 引擎定制面);
//! 生产实现 [`TokenElevationProbe`] 走 Windows TokenElevation 令牌查询 +
//! Toolhelp 进程枚举(windows-sys,0.61)。仅标题目标(无进程名)无法定位进程,
//! 跳过提权探测(白名单匹配不受影响)。

use std::sync::Arc;

use conex_shared::gate::{ActionTarget, ActionTargetGate, TargetDenial, TargetDenialKind};

/// 白名单条目(标题 + 可选进程名;进程名可空 = 仅标题匹配,04 §4 白名单窗口)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WhitelistEntry {
    /// 窗口标题(精确匹配)
    pub title: String,
    /// 进程名(如 notepad.exe;None = 仅标题匹配)
    pub process: Option<String>,
}

impl WhitelistEntry {
    /// 构造白名单条目
    pub fn new(title: impl Into<String>, process: Option<String>) -> Self {
        Self {
            title: title.into(),
            process,
        }
    }
}

/// 提权探测抽象(测试注入 mock;生产 [`TokenElevationProbe`])
pub trait ElevationProbe: Send + Sync {
    /// 判定指定进程名是否以提权(管理员)令牌运行;进程名大小写不敏感。
    /// 探测失败(无权限/进程已退出)按未提权处理,不阻断白名单判定。
    fn is_elevated(&self, process: &str) -> bool;
}

/// 窗口目标门禁:提权探测 → 白名单匹配;空白名单默认放行。
///
/// 检查点在审批**之前**(04 §4.6 守卫次序),由桌面会话/工具层接线调用。
pub struct WindowTargetGate {
    whitelist: Vec<WhitelistEntry>,
    probe: Arc<dyn ElevationProbe>,
}

impl WindowTargetGate {
    /// 新建门禁(默认 TokenElevation 提权探测)
    pub fn new(whitelist: Vec<WhitelistEntry>) -> Self {
        Self {
            whitelist,
            probe: Arc::new(TokenElevationProbe),
        }
    }

    /// 注入自定义提权探测(测试 / 引擎定制面)
    pub fn with_probe(whitelist: Vec<WhitelistEntry>, probe: Arc<dyn ElevationProbe>) -> Self {
        Self { whitelist, probe }
    }

    /// 白名单(供审计/面板投影)
    pub fn whitelist(&self) -> &[WhitelistEntry] {
        &self.whitelist
    }

    /// 白名单匹配判定(纯函数,供单测与工具层复用):
    /// 条目标题精确匹配;条目进程名 None = 仅标题匹配,Some = 标题与进程都匹配。
    fn matches_whitelist(whitelist: &[WhitelistEntry], title: &str, process: Option<&str>) -> bool {
        whitelist.iter().any(|entry| {
            entry.title == title
                && match (&entry.process, process) {
                    (None, _) => true,
                    (Some(expected), Some(actual)) => expected == actual,
                    (Some(_), None) => false,
                }
        })
    }
}

impl ActionTargetGate for WindowTargetGate {
    fn check(&self, target: &ActionTarget) -> Result<(), TargetDenial> {
        match target {
            ActionTarget::Url(url) => Err(TargetDenial {
                kind: TargetDenialKind::Other,
                target: url.clone(),
                reason: "目标类型不适用:Url 属浏览器线,桌面门禁仅检查窗口目标".to_string(),
            }),
            ActionTarget::Window { title, process } => {
                let display = format!("{title} ({})", process.as_deref().unwrap_or("未知进程"));
                // ① 提权探测(仅给定进程名时可定位进程;仅标题目标跳过探测)
                if let Some(proc) = process.as_deref() {
                    if self.probe.is_elevated(proc) {
                        return Err(TargetDenial {
                            kind: TargetDenialKind::Elevated,
                            target: display,
                            // reason 携带 tool.computer.elevated_window 语义(05 §5.2)
                            reason: format!(
                                "目标窗口为提权进程 {proc},拒绝注入(tool.computer.elevated_window)"
                            ),
                        });
                    }
                }
                // ② 白名单匹配(空白名单 = 默认放行,04 §4 项 6)
                if self.whitelist.is_empty()
                    || Self::matches_whitelist(&self.whitelist, title, process.as_deref())
                {
                    return Ok(());
                }
                Err(TargetDenial {
                    kind: TargetDenialKind::Whitelist,
                    target: display,
                    reason: "目标窗口不在白名单".to_string(),
                })
            }
        }
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn get_process_name_by_pid(pid: u32) -> Option<String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut name = None;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                if entry.th32ProcessID == pid {
                    let exe_name = wide_to_string(&entry.szExeFile);
                    if !exe_name.is_empty() {
                        name = Some(exe_name);
                    }
                    break;
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        name
    }
}

/// 解析当前前台活动窗口目标（HWND/PID/真实 ExeName，Fail-Closed 提权探针）。
#[allow(unsafe_code)]
pub fn resolve_foreground_target() -> ActionTarget {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
        };

        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return ActionTarget::Window {
                title: "未知窗口".to_string(),
                process: None,
            };
        }

        let mut title_buf = [0u16; 512];
        let title_len = GetWindowTextW(hwnd, title_buf.as_mut_ptr(), title_buf.len() as i32);
        let title = if title_len > 0 {
            String::from_utf16_lossy(&title_buf[..title_len as usize])
        } else {
            "无标题窗口".to_string()
        };

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return ActionTarget::Window {
                title,
                process: None,
            };
        }

        let process_handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        let proc_name = if !process_handle.is_null() {
            let mut name_buf = [0u16; 1024];
            let mut size = name_buf.len() as u32;
            let name =
                if QueryFullProcessImageNameW(process_handle, 0, name_buf.as_mut_ptr(), &mut size)
                    != 0
                {
                    let full_path = String::from_utf16_lossy(&name_buf[..size as usize]);
                    std::path::Path::new(&full_path)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .map(|s| s.to_string())
                } else {
                    get_process_name_by_pid(pid)
                };
            CloseHandle(process_handle);
            name
        } else {
            // Fail-Closed: 无法以 LIMITED_INFORMATION 打开句柄，通过 ToolHelp 快照查找真实进程名
            get_process_name_by_pid(pid)
        };

        ActionTarget::Window {
            title,
            process: proc_name,
        }
    }
    #[cfg(not(windows))]
    ActionTarget::Window {
        title: "非 Windows 平台".to_string(),
        process: None,
    }
}

/// 提权探测生产实现(Windows TokenElevation):
/// Toolhelp 快照按进程名枚举(ToolHelp32),对同名进程逐个 OpenProcess 查询
/// TokenElevation 令牌;任一实例提权即判定提权(进程名匹配不分实例)。
#[cfg(windows)]
pub struct TokenElevationProbe;

#[cfg(windows)]
impl ElevationProbe for TokenElevationProbe {
    fn is_elevated(&self, process: &str) -> bool {
        is_any_process_elevated(process)
    }
}

/// 非 Windows 平台兜底:无 TokenElevation,恒判定未提权
#[cfg(not(windows))]
pub struct TokenElevationProbe;

#[cfg(not(windows))]
impl ElevationProbe for TokenElevationProbe {
    fn is_elevated(&self, _process: &str) -> bool {
        false
    }
}

/// 枚举进程名匹配并查询提权(进程名大小写不敏感;探测失败按未提权)
#[cfg(windows)]
#[allow(unsafe_code)]
pub fn is_any_process_elevated(process: &str) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            tracing::warn!("Toolhelp 进程快照创建失败,提权探测跳过");
            return false;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut elevated = false;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                if wide_to_string(&entry.szExeFile).eq_ignore_ascii_case(process) {
                    elevated = process_is_elevated(entry.th32ProcessID);
                    if elevated {
                        break;
                    }
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        elevated
    }
}

/// 单进程提权查询:OpenProcess → OpenProcessToken(TOKEN_QUERY) →
/// GetTokenInformation(TokenElevation);遵循 Fail-Closed 原则:遭遇 ACCESS_DENIED 或异常坚决判定提权
#[cfg(windows)]
#[allow(unsafe_code)]
pub fn process_is_elevated(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let process_handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process_handle.is_null() {
            // Fail-Closed 铁律：打开进程句柄失败（权限高于当前进程或受保护进程），坚决判定为提权
            return true;
        }

        let mut token_handle: *mut core::ffi::c_void = std::ptr::null_mut();
        if OpenProcessToken(process_handle, TOKEN_QUERY, &mut token_handle) == 0 {
            CloseHandle(process_handle);
            // Fail-Closed 铁律：打开进程令牌失败，坚决判定为提权
            return true;
        }

        let mut elevation: TOKEN_ELEVATION = std::mem::zeroed();
        let mut return_len: u32 = 0;
        let elevated = if GetTokenInformation(
            token_handle,
            TokenElevation,
            &mut elevation as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut return_len,
        ) != 0
        {
            elevation.TokenIsElevated != 0
        } else {
            // Fail-Closed：获取令牌信息失败亦判定为提权
            true
        };
        CloseHandle(token_handle);
        CloseHandle(process_handle);
        elevated
    }
}

/// 宽字符数组 → 字符串(NUL 截断;进程名 szExeFile 语义)
#[cfg(windows)]
fn wide_to_string(wide: &[u16]) -> String {
    let len = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
    String::from_utf16_lossy(&wide[..len])
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// mock 提权探测:指定提权进程集合 + 调用记录
    struct MockProbe {
        elevated: Vec<String>,
        calls: Mutex<Vec<String>>,
    }

    impl MockProbe {
        fn new(elevated: Vec<String>) -> Self {
            Self {
                elevated,
                calls: Mutex::new(Vec::new()),
            }
        }

        fn call_count(&self) -> usize {
            self.calls.lock().expect("调用记录锁损坏").len()
        }
    }

    impl ElevationProbe for MockProbe {
        fn is_elevated(&self, process: &str) -> bool {
            self.calls
                .lock()
                .expect("调用记录锁损坏")
                .push(process.to_string());
            self.elevated.iter().any(|e| e == process)
        }
    }

    fn target_win(title: &str, process: Option<&str>) -> ActionTarget {
        ActionTarget::Window {
            title: title.to_string(),
            process: process.map(|p| p.to_string()),
        }
    }

    fn gate(
        whitelist: Vec<WhitelistEntry>,
        elevated: Vec<String>,
    ) -> (WindowTargetGate, Arc<MockProbe>) {
        let probe = Arc::new(MockProbe::new(elevated));
        let gate = WindowTargetGate::with_probe(whitelist, probe.clone());
        (gate, probe)
    }

    #[test]
    fn whitelist_title_match_ok() {
        let (gate, _probe) = gate(vec![WhitelistEntry::new("记事本", None)], vec![]);
        assert!(gate
            .check(&target_win("记事本", Some("notepad.exe")))
            .is_ok());
    }

    #[test]
    fn whitelist_title_and_process_match_ok() {
        let (gate, _probe) = gate(
            vec![WhitelistEntry::new(
                "记事本",
                Some("notepad.exe".to_string()),
            )],
            vec![],
        );
        assert!(gate
            .check(&target_win("记事本", Some("notepad.exe")))
            .is_ok());
    }

    #[test]
    fn whitelist_process_mismatch_denied() {
        let (gate, _probe) = gate(
            vec![WhitelistEntry::new(
                "记事本",
                Some("notepad.exe".to_string()),
            )],
            vec![],
        );
        let err = gate
            .check(&target_win("记事本", Some("calc.exe")))
            .expect_err("应拒绝");
        assert_eq!(err.kind, TargetDenialKind::Whitelist);
        assert_eq!(err.target, "记事本 (calc.exe)");
    }

    #[test]
    fn whitelist_title_only_matches_any_process() {
        // 条目进程名 None = 仅标题匹配(04 §4 语义)
        let (gate, _probe) = gate(vec![WhitelistEntry::new("记事本", None)], vec![]);
        assert!(gate.check(&target_win("记事本", Some("calc.exe"))).is_ok());
        assert!(gate.check(&target_win("记事本", None)).is_ok());
    }

    #[test]
    fn whitelist_title_mismatch_denied() {
        let (gate, _probe) = gate(vec![WhitelistEntry::new("记事本", None)], vec![]);
        let err = gate.check(&target_win("计算器", None)).expect_err("应拒绝");
        assert_eq!(err.kind, TargetDenialKind::Whitelist);
        assert_eq!(err.target, "计算器 (未知进程)");
    }

    #[test]
    fn empty_whitelist_default_allows() {
        // 空白名单 = 默认放行(04 §4 项 6)
        let (gate, _probe) = gate(vec![], vec![]);
        assert!(gate.check(&target_win("任意窗口", None)).is_ok());
    }

    #[test]
    fn elevated_process_denied_with_code_semantics() {
        let (gate, probe) = gate(
            vec![WhitelistEntry::new("系统设置", None)],
            vec!["SystemSettings.exe".to_string()],
        );
        let err = gate
            .check(&target_win("系统设置", Some("SystemSettings.exe")))
            .expect_err("应拒绝");
        assert_eq!(err.kind, TargetDenialKind::Elevated);
        assert!(
            err.reason.contains("tool.computer.elevated_window"),
            "reason 应携带错误码语义: {}",
            err.reason
        );
        assert_eq!(probe.call_count(), 1);
    }

    #[test]
    fn elevation_takes_precedence_over_whitelist() {
        // 提权窗口即使命中白名单也拒绝(04 §6.2 风险 R3 红线)
        let (gate, _probe) = gate(
            vec![WhitelistEntry::new(
                "系统设置",
                Some("SystemSettings.exe".to_string()),
            )],
            vec!["SystemSettings.exe".to_string()],
        );
        let err = gate
            .check(&target_win("系统设置", Some("SystemSettings.exe")))
            .expect_err("提权窗口应拒绝");
        assert_eq!(err.kind, TargetDenialKind::Elevated);
    }

    #[test]
    fn non_elevated_and_whitelisted_ok() {
        let (gate, probe) = gate(
            vec![WhitelistEntry::new("记事本", None)],
            vec!["SystemSettings.exe".to_string()],
        );
        assert!(gate
            .check(&target_win("记事本", Some("notepad.exe")))
            .is_ok());
        // 探测被调用且返回未提权
        assert!(probe.call_count() >= 1);
    }

    #[test]
    fn url_target_returns_not_applicable() {
        let (gate, _probe) = gate(vec![WhitelistEntry::new("记事本", None)], vec![]);
        let err = gate
            .check(&ActionTarget::Url("https://example.com".to_string()))
            .expect_err("Url 目标应拒绝");
        assert_eq!(err.kind, TargetDenialKind::Other);
        assert_eq!(err.target, "https://example.com");
        assert!(err.reason.contains("不适用"));
    }

    #[test]
    fn title_only_target_skips_elevation_probe() {
        // 仅标题目标无法定位进程,跳过提权探测(白名单判定不受影响)
        let (gate, probe) = gate(vec![WhitelistEntry::new("记事本", None)], vec![]);
        assert!(gate.check(&target_win("记事本", None)).is_ok());
        assert_eq!(probe.call_count(), 0);
    }

    #[test]
    fn whitelist_matches_function_semantics() {
        let whitelist = vec![
            WhitelistEntry::new("记事本", None),
            WhitelistEntry::new("终端", Some("WindowsTerminal.exe".to_string())),
        ];
        assert!(WindowTargetGate::matches_whitelist(
            &whitelist,
            "记事本",
            None
        ));
        assert!(WindowTargetGate::matches_whitelist(
            &whitelist,
            "记事本",
            Some("calc.exe")
        ));
        assert!(WindowTargetGate::matches_whitelist(
            &whitelist,
            "终端",
            Some("WindowsTerminal.exe")
        ));
        assert!(!WindowTargetGate::matches_whitelist(
            &whitelist,
            "终端",
            Some("cmd.exe")
        ));
        assert!(!WindowTargetGate::matches_whitelist(
            &whitelist,
            "计算器",
            None
        ));
    }

    #[test]
    fn window_target_gate_is_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<WindowTargetGate>();
    }

    #[test]
    fn adversarial_computer_elevation_fail_closed() {
        #[cfg(windows)]
        {
            // System PID 4 (Fail-Closed ACCESS_DENIED)
            let is_elevated = process_is_elevated(4);
            assert!(
                is_elevated,
                "权限查询遭遇 ACCESS_DENIED 必须 Fail-Closed 判定为提权"
            );

            let target = resolve_foreground_target();
            match target {
                ActionTarget::Window { title, .. } => {
                    assert!(!title.is_empty(), "前台窗口标题不应为空");
                }
                _ => panic!("前台目标必须是 Window 类型"),
            }
        }
    }
}
