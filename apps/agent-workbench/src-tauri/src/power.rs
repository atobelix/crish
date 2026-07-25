// 跨平台系统唤醒锁模块（Keep-Awake）
#[cfg(target_os = "windows")]
mod platform {
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
pub fn workbench_set_keep_awake(enabled: bool) -> Result<(), String> {
    platform::set_keep_awake(enabled)
}
