//! 纯函数：会话标识净化、日期前缀（civil-from-days 换算）与本地时区偏移（含 Windows FFI）

use std::time::SystemTime;

// ==================== 纯函数：会话标识净化与日期前缀 ====================

/// 会话标识净化：剥离 `\/:*?"<>|` 与控制字符（C0 + DEL），对齐
/// applyFileDiff.ts:55-61 的 PATH_CONTROL_OR_BAD 净化思路——会话标识将
/// 直接进入目录名，路径分隔符与控制字符必须剔除；其余字符（含中文、
/// 连字符等）保留。
pub fn sanitize_session_id(session_id: &str) -> String {
    session_id
        .chars()
        .filter(|c| {
            !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control()
        })
        .collect()
}

/// 日期前缀纯函数：epoch 时刻 + 本地时区偏移（分钟，本地 = UTC + 偏移）
/// → 零填充 `YYYY-MM-DD`（Howard Hinnant civil-from-days 换算，无 chrono
/// 依赖；负 epoch / 负偏移经 div_euclid / rem_euclid 容错不 panic）。
///
/// 固定时间注入：单测传固定 epoch + 固定偏移即可确定性断言（含跨日边界）。
pub fn format_date_prefix(now: SystemTime, utc_offset_minutes: i32) -> String {
    let epoch_secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let shifted = epoch_secs + i64::from(utc_offset_minutes) * 60;
    let (year, month, day) = civil_from_days(shifted.div_euclid(86_400));
    format!("{year:04}-{month:02}-{day:02}")
}

/// Unix 天数 → 公历年月日（Howard Hinnant 算法，与 subagent_inject.rs:86-97
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

/// 公历年月日 → Unix 天数（Howard Hinnant days_from_civil，civil_from_days
/// 的逆运算；供 Windows 本地时钟换算 epoch 秒——非 Windows 平台无消费
/// 方，豁免 dead_code 保持跨平台干净）
#[cfg_attr(not(windows), allow(dead_code))]
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = i64::from(if m > 2 { m - 3 } else { m + 9 });
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// 本地时区偏移（分钟；本地 = UTC + 偏移，正东负西）
///
/// Windows：GetLocalTime / GetSystemTime 同刻差值（含夏令时，OS 语义
/// 保证）；秒级截断至多 ±1 分钟采集误差——真实时区偏移均为 15 分钟
/// 整数倍，舍入到最近 15 分钟抗抖动。其余平台 std 无本地时区面，回退
/// 0（UTC），文档明示（项目以 win32 为主目标，非 Windows 平台日期为
/// UTC 口径，可接受并在接线文档声明）。
pub fn local_utc_offset_minutes() -> i32 {
    #[cfg(windows)]
    {
        let (local_secs, utc_secs) = win_time::local_and_utc_epoch_secs();
        let raw_minutes = (local_secs - utc_secs) / 60;
        // 最近 15 分钟取整（负偏移经 div_euclid 保证舍入方向一致）；
        // 真实偏移范围 ±14 小时，i64 → i32 无溢出风险
        ((raw_minutes + 7).div_euclid(15) * 15) as i32
    }
    #[cfg(not(windows))]
    {
        0
    }
}

/// Windows 本地时间 FFI（项目唯一 FFI 面）
///
/// 项目约束：无 chrono 依赖（Cargo.toml 冻结）、std 无本地时区换算——
/// 此处以 kernel32 两个极小函数取本地/UTC 时钟瞬间。unsafe_code 基线为
/// warn，本模块以 #[allow(unsafe_code)] 显式豁免并登记理由：Windows 平台
/// 本地时间的唯一可行 std 面，函数语义固定（无缓冲/无资源），布局为
/// 纯 POD 结构。
#[cfg(windows)]
mod win_time {
    /// SYSTEMTIME（kernel32）：8 个 WORD 按序，repr(C) 与 Windows 定义
    /// 一一对应（wYear/wMonth/wDayOfWeek/wDay/wHour/wMinute/wSecond/
    /// wMilliseconds）
    #[repr(C)]
    #[derive(Debug, Clone, Copy, Default)]
    struct SystemTime {
        year: u16,
        month: u16,
        day_of_week: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        milliseconds: u16,
    }

    impl SystemTime {
        /// 字段 → epoch 秒（忽略毫秒；仅供偏移差值计算，秒级精度足够）
        fn epoch_secs(&self) -> i64 {
            let days = super::days_from_civil(
                i64::from(self.year),
                u32::from(self.month),
                u32::from(self.day),
            );
            days * 86_400
                + i64::from(self.hour) * 3_600
                + i64::from(self.minute) * 60
                + i64::from(self.second)
        }
    }

    #[link(name = "kernel32")]
    extern "system" {
        /// 本地时间（OS 语义：系统时区与夏令时规则直接生效）
        fn GetLocalTime(lp_system_time: *mut SystemTime);
        /// UTC 时间（与 GetLocalTime 同刻采集）
        fn GetSystemTime(lp_system_time: *mut SystemTime);
    }

    /// 同刻采集（本地, UTC）epoch 秒
    #[allow(unsafe_code)] // 理由见模块头注：Windows 本地时间的唯一 std 面
    pub(super) fn local_and_utc_epoch_secs() -> (i64, i64) {
        let mut local = SystemTime::default();
        let mut utc = SystemTime::default();
        // SAFETY: GetLocalTime/GetSystemTime 恒成功（kernel32 文档无失败返回值），
        // 仅写入栈上 SystemTime POD（repr(C) 布局与 Win32 SYSTEMTIME 一一对应，
        // 见结构体注释）；无指针逃逸，调用后立即逐字段拷贝；结构体生命周期限于本函数
        unsafe {
            GetLocalTime(&mut local);
            GetSystemTime(&mut utc);
        }
        (local.epoch_secs(), utc.epoch_secs())
    }
}
