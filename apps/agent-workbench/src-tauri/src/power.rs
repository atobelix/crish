// 跨平台系统唤醒锁模块（Keep-Awake）。
// 命令错误统一为 CoreError（IPC 面唯一协议）。

// G11a 备注：keep-awake 为 PE-03 已定「删除注册、实现与测试保留」的预留面——
// workbench_set_keep_awake 当前无 UI/TUI 消费方（登记被 PE-03 移除），
// platform::set_keep_awake 为跨平台实现层（macOS IOKit / Linux DBus 实现
// 在途），整模块 dead_code 静音待接线。
#![allow(dead_code)]

use conex_types::CoreError;

#[cfg(target_os = "windows")]
mod platform {
    // 豁免 unsafe_code：SetThreadExecutionState 是 Windows FFI 调用，
    // 仅传入布尔型 flags 常量组合，无指针参数、无内存所有权转移
    // （SAFETY：返回值 0 表示失败，已显式检查；ESTABLISH 与 CLEAR
    // 语义由调用方 enabled 决定，本函数内不保留任何跨调用状态）。
    #[allow(unsafe_code)]
    pub fn set_keep_awake(enabled: bool) -> Result<(), String> {
        let flags = if enabled {
            windows_sys::Win32::System::Power::ES_CONTINUOUS
                | windows_sys::Win32::System::Power::ES_SYSTEM_REQUIRED
                | windows_sys::Win32::System::Power::ES_DISPLAY_REQUIRED
        } else {
            windows_sys::Win32::System::Power::ES_CONTINUOUS
        };
        let ret = unsafe { windows_sys::Win32::System::Power::SetThreadExecutionState(flags) };
        if ret == 0 {
            Err("SetThreadExecutionState failed".into())
        } else {
            Ok(())
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    pub fn set_keep_awake(enabled: bool) -> Result<(), String> {
        if enabled {
            // TODO: 使用 IOKit IOPMAssertionCreateWithName 实现
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    pub fn set_keep_awake(enabled: bool) -> Result<(), String> {
        if enabled {
            // TODO: 使用 DBus Inhibit / systemd-inhibit 实现
        }
        Ok(())
    }
}

#[tauri::command]
pub fn workbench_set_keep_awake(enabled: bool) -> Result<(), CoreError> {
    platform::set_keep_awake(enabled).map_err(CoreError::Internal)
}
