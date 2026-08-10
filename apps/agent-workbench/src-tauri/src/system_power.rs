//! 桌面睡眠/唤醒的服务恢复（多端互通 R1-09 缺口 G-1）
//!
//! Z0 总纲 §3.4 G-1 规格：「监听 Suspend/Resume → 重绑端口 + mDNS 重广播 +
//! 已有 WS 踢重连」。本模块负责**监听面与恢复动作的纯逻辑**；真实重绑
//! （重建 [crate::server::ServerInstance]）由 main.rs 装配闭包注入
//! （[run_resume_recovery] 的 rebind 参数）。
//!
//! # 监听方案选型（任务书二选一：(a) PowerSettingRegisterNotification
//! #（GUID_SYSTEM_POWER_STATUS）回调线程；(b) 30s 轮询 GetSystemPowerStatus）
//!
//! 采用 (a) 家族的**事件回调**形态，但注册 **PowerRegisterSuspendResumeNotification**
//! 而非 PowerSettingRegisterNotification(GUID_SYSTEM_POWER_STATUS)，理由：
//!
//! 1. **事件语义精确（效果完整度）**：GUID_SYSTEM_POWER_STATUS 只在电源状态
//!    （AC/电池/电量/充电）变化时通知；AC 供电台式机睡眠/唤醒时电源状态
//!    不变 → 恢复链路漏触发。PowerRegisterSuspendResumeNotification 是
//!    Windows 8+ 专为 Suspend/Resume 设计的通知：进入睡眠必收
//!    PBT_APMSUSPEND，唤醒必收 PBT_APMRESUMEAUTOMATIC（或
//!    PBT_APMRESUMESUSPEND）——与 G-1「监听 Suspend/Resume」逐字对齐；
//! 2. **机制等价零成本（结构干净）**：两个 API 同属 Win32_System_Power
//!    （powrprof.dll），同为 DEVICE_NOTIFY_CALLBACK 回调线程形态 +
//!    HPOWERNOTIFY 注册句柄；windows-sys 0.61 已声明 Win32_System_Power
//!    feature（single_instance.rs / pairing.rs windows_ip_enum 同款先例），
//!    零新依赖，且 0.61.2 已导出配套参数结构 DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS；
//! 3. **弃 (b) 轮询**：30s 轮询判定睡眠/唤醒需比较电源状态快照，AC 台式机
//!    状态不变无法判定（正确性不达标），且恢复延迟 30s——事件驱动优于轮询。
//!
//! # 恢复链路（唤醒事件 → main.rs 装配动作）
//!
//! 唤醒事件（PBT_APMRESUMEAUTOMATIC / PBT_APMRESUMESUSPEND，系统线程池
//! 回调）→ [run_resume_recovery]：lan 态（配对开启）判定 → fire
//! rebind(true)（main.rs 钩子：关停旧实例 → 等待端口释放 → 按 Lan 重建，
//! 8765 优先）→ [kick_all_ws] 全量踢出旧 WS 连接（移动端收 transport.closed
//! 自动重连 + 游标追赶，D3 §7.5）。loopback 态跳过——回环监听不受睡眠影响。
//!
//! # 未覆盖项（诚实记录）
//!
//! - **mDNS 重广播**（Z0 G-1 第 2 项）：mDNS 发现底座尚未实现（Z0 §3.4 L1
//!   列为二维码引导之外的辅助路径，R1-R2 排期）；唤醒动作已预留叠加点
//!   （同一 [ResumeAction] 内追加广播调用即可），待 mDNS 落地后接线；
//! - **真实睡眠/唤醒手测**：PowerRegisterSuspendResumeNotification 的真实
//!   触发需真机睡眠/唤醒验证（CI 无法模拟 ACPI 睡眠），单测覆盖纯逻辑与
//!   事件判定，注册链路的端到端留手工验证。

use std::sync::Arc;

/// 唤醒恢复动作（main.rs 装配闭包：lan 判定 → rebind(true) → WS 踢重连）
pub type ResumeAction = Arc<dyn Fn() + Send + Sync>;

/// 唤醒踢出原因（出网 error 帧 reason；非 token-revoked → 移动端按
/// transport.closed 语义自动重连，对齐 ws.rs kicked_envelope 映射）
pub const KICK_REASON_WAKE: &str = "wake-rebind";

/// 电源监视器（Windows 持有注册句柄，Drop 注销 Suspend/Resume 通知；
/// 非 Windows 为无字段空壳，[start] 返回 None）
pub struct SystemPowerMonitor {
    #[cfg(windows)]
    registration: platform::PowerRegistration,
}

/// 启动电源监视（全进程单例：仅 main.rs setup 装配一次；Windows 注册
/// Suspend/Resume 回调，其余平台 no-op 返回 None）
pub fn start(on_resume: ResumeAction) -> Option<SystemPowerMonitor> {
    platform::start(on_resume)
}

/// 唤醒恢复执行（可测纯逻辑：注入 lan 判定与动作，mock 断言）
///
/// 语义对齐 [crate::server::pairing::PairingCoordinator] 的 fire rebind(true)：
/// **lan 态（配对开启）才恢复**——loopback 态服务恒在（回环监听不受睡眠
/// 影响，应用进程存活即可用），无需重建；lan 态 0.0.0.0 监听经睡眠后
/// 可能失效（网卡重置 / 防火墙会话过期），必须重绑端口。
///
/// 返回是否执行了恢复（lan 态判定结果；调用方可据此记日志）。
pub fn run_resume_recovery(
    pairing_enabled: bool,
    rebind: &dyn Fn(bool),
    kick_all: &dyn Fn() -> usize,
) -> bool {
    if !pairing_enabled {
        return false;
    }
    rebind(true);
    let kicked = kick_all();
    tracing::info!(target: "system-power", kicked, "睡眠唤醒恢复：重绑端口 + WS 踢重连");
    true
}

/// 踢出注册表全部 WS 连接（返回被踢数）。睡眠期间连接已成半开/超时态，
/// 显式踢出让移动端收到 transport.closed 立即重连（而非等 90s 心跳超时，
/// ws.rs HEARTBEAT_TIMEOUT_MS）。conn_id 列表取自注册表快照，踢出语义与
/// ws.rs [crate::server::ws::WsRegistry::kick] 一致（信号即发即回，注销由
/// sender task 收尾）。
pub fn kick_all_ws(registry: &crate::server::ws::WsRegistry) -> usize {
    let conn_ids: Vec<u64> = registry.snapshot().iter().map(|c| c.conn_id).collect();
    conn_ids
        .iter()
        .filter(|id| registry.kick(**id, KICK_REASON_WAKE))
        .count()
}

// ── 平台实现 ─────────────────────────────────────────────

#[cfg(windows)]
mod platform {
    use std::sync::OnceLock;

    use super::{ResumeAction, SystemPowerMonitor};
    use windows_sys::Win32::System::Power::{
        DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS, PowerRegisterSuspendResumeNotification,
        PowerUnregisterSuspendResumeNotification,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DEVICE_NOTIFY_CALLBACK, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND,
    };

    /// 全局恢复动作（进程单例；Win32 回调无法携带 Rust 生命周期化上下文，
    /// 经静态通道取用——[super::start] 文档注明全进程仅装配一次）
    static RESUME_ACTION: OnceLock<ResumeAction> = OnceLock::new();

    /// Suspend/Resume 注册句柄（HPOWERNOTIFY；Drop 时注销通知）
    pub struct PowerRegistration {
        handle: isize,
    }

    impl Drop for PowerRegistration {
        fn drop(&mut self) {
            // SAFETY：handle 为 PowerRegisterSuspendResumeNotification 成功
            // 返回的注册句柄，注销语义幂等（失败仅记日志，不影响退出）
            #[allow(unsafe_code)]
            let _ = unsafe { PowerUnregisterSuspendResumeNotification(self.handle) };
        }
    }

    /// 注册 Suspend/Resume 回调（DEVICE_NOTIFY_CALLBACK 形态；回调运行于
    /// 系统线程池）。失败返回 None 并记错误日志——睡眠恢复降级为移动端
    /// 心跳超时被动发现（ws.rs 90s 半开检测），应用功能不受影响。
    pub fn start(on_resume: ResumeAction) -> Option<SystemPowerMonitor> {
        if RESUME_ACTION.set(on_resume).is_err() {
            tracing::error!(target: "system-power", "电源监视已装配（全进程单例），拒绝重复注册");
            return None;
        }
        let params = DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
            Callback: Some(callback),
            Context: std::ptr::null_mut(),
        };
        let mut registration: *mut core::ffi::c_void = std::ptr::null_mut();
        // SAFETY：
        // - params 为栈上完整回调参数结构，注册调用返回后系统不再引用
        //   （Context 为空指针，无生命周期负担）；
        // - registration 由系统在成功时填充，失败保持空指针；
        // - 成功句柄移交 PowerRegistration 持有，Drop 时注销。
        #[allow(unsafe_code)]
        let rc = unsafe {
            PowerRegisterSuspendResumeNotification(
                DEVICE_NOTIFY_CALLBACK,
                std::ptr::addr_of!(params) as *mut core::ffi::c_void,
                &mut registration,
            )
        };
        if rc != 0 {
            tracing::error!(
                target: "system-power",
                rc,
                "PowerRegisterSuspendResumeNotification 注册失败"
            );
            return None;
        }
        tracing::info!(target: "system-power", "电源监视已注册（Suspend/Resume 回调）");
        Some(SystemPowerMonitor {
            registration: PowerRegistration {
                handle: registration as isize,
            },
        })
    }

    /// 电源事件回调（系统线程池调用；仅唤醒事件派发恢复动作）。
    ///
    /// # Safety
    /// 回调由系统按注册时参数原样调用；本注册 Context 为空指针，回调不
    /// 接触 context/setting 指针内容，恢复动作经静态 RESUME_ACTION 取用。
    #[allow(unsafe_code)]
    unsafe extern "system" fn callback(
        _context: *const core::ffi::c_void,
        event_type: u32,
        _setting: *const core::ffi::c_void,
    ) -> u32 {
        if is_resume_event(event_type) {
            if let Some(action) = RESUME_ACTION.get() {
                // 恢复动作全部为非阻塞同步调用（rebind 钩子内部经
                // tauri::async_runtime 派发异步重建；WS 踢出为信号语义），
                // 可在系统线程池回调内直接执行
                action();
            }
        }
        0
    }

    /// 唤醒事件判定（可测纯函数）：自动唤醒（PBT_APMRESUMEAUTOMATIC）与
    /// 用户交互唤醒（PBT_APMRESUMESUSPEND）都算唤醒；挂起事件不触发恢复。
    pub(crate) fn is_resume_event(event_type: u32) -> bool {
        matches!(event_type, PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND)
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{ResumeAction, SystemPowerMonitor};

    /// 非 Windows no-op（当前桌面多端互通目标平台为 Windows；macOS/Linux
    /// 由系统电源管理自动恢复网络栈，无需应用侧重绑）
    pub fn start(_on_resume: ResumeAction) -> Option<SystemPowerMonitor> {
        None
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    /// mock 记录器（rebind 调用参数 / 踢出次数）
    struct Recorder {
        rebinds: Vec<bool>,
        kicks: usize,
    }

    /// 构造记录器与两个 mock 动作（rebind 记录参数；kick 计数并返回）
    fn recorder() -> (
        Arc<Mutex<Recorder>>,
        impl Fn(bool),
        impl Fn() -> usize,
    ) {
        let inner = Arc::new(Mutex::new(Recorder {
            rebinds: Vec::new(),
            kicks: 0,
        }));
        let rebind_inner = Arc::clone(&inner);
        let kick_inner = Arc::clone(&inner);
        (
            inner,
            move |lan: bool| {
                rebind_inner
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .rebinds
                    .push(lan);
            },
            move || {
                let mut r = kick_inner.lock().unwrap_or_else(|e| e.into_inner());
                r.kicks += 1;
                r.kicks
            },
        )
    }

    /// 唤醒恢复：loopback 态（未配对）不恢复、不动钩子；lan 态 fire
    /// rebind(true) + WS 踢重连（G-1 核心链路断言）。
    #[test]
    fn resume_recovery_fires_rebind_true_and_kicks_only_in_lan() {
        let (log, rebind, kick) = recorder();

        // loopback 态（未配对）：不恢复，rebind/kick 均不触发
        let recovered = run_resume_recovery(false, &rebind, &kick);
        assert!(!recovered, "loopback 态不应执行恢复");
        assert!(
            log.lock().unwrap_or_else(|e| e.into_inner()).rebinds.is_empty(),
            "loopback 态不得触发重绑"
        );
        assert_eq!(log.lock().unwrap_or_else(|e| e.into_inner()).kicks, 0);

        // lan 态（配对开启）：fire rebind(true) + WS 踢重连
        let recovered = run_resume_recovery(true, &rebind, &kick);
        assert!(recovered, "lan 态必须执行恢复");
        let log = log.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(log.rebinds, vec![true], "唤醒恢复必须 fire rebind(true)");
        assert_eq!(log.kicks, 1, "唤醒恢复必须触发 WS 踢重连");
    }

    /// WS 踢重连：注册表全部连接被踢（kick 只发信号，注销是 sender task
    /// 职责——表内连接保留，重复踢出幂等无害）。
    #[test]
    fn kick_all_ws_kicks_every_registered_connection() {
        use crate::server::ws::{RegisterOutcome, WsRegistry};
        let registry = WsRegistry::new();
        for i in 0..3 {
            let (kill_tx, _kill_rx) = tokio::sync::watch::channel(None);
            assert_eq!(
                registry.register(&format!("hash-{i}"), &format!("dev-{i}"), kill_tx, 0),
                RegisterOutcome::Registered(i + 1),
                "测试连接注册必须成功"
            );
        }
        assert_eq!(registry.snapshot().len(), 3);
        assert_eq!(kick_all_ws(&registry), 3, "必须全量踢出 3 个连接");
        assert_eq!(
            registry.snapshot().len(),
            3,
            "kick 不注销连接（注销由 sender task 收尾）"
        );
        // 幂等：重复踢出仍全量返回（信号重复发送无害）
        assert_eq!(kick_all_ws(&registry), 3);
    }

    /// 踢出原因契约：非 token-revoked → 移动端按 transport.closed 语义
    /// 自动重连（若写成 revoked 语义，移动端会进入不可重试终止态）。
    #[test]
    fn kick_reason_is_reconnectable_not_revoked() {
        assert_eq!(KICK_REASON_WAKE, "wake-rebind");
        assert_ne!(KICK_REASON_WAKE, "token-revoked");
    }

    /// Windows：唤醒事件判定与官方 PBT 常量一致（挂起不触发恢复）。
    #[cfg(windows)]
    #[test]
    fn resume_event_classification_matches_windows_pbt() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND, PBT_APMSUSPEND,
        };
        assert!(super::platform::is_resume_event(PBT_APMRESUMEAUTOMATIC));
        assert!(super::platform::is_resume_event(PBT_APMRESUMESUSPEND));
        assert!(!super::platform::is_resume_event(PBT_APMSUSPEND), "挂起不触发恢复");
        assert!(!super::platform::is_resume_event(0));
        assert!(!super::platform::is_resume_event(u32::MAX));
    }

    /// 非 Windows：电源监视 no-op（平台隔离验收）。
    #[cfg(not(windows))]
    #[test]
    fn start_is_noop_off_windows() {
        assert!(start(Arc::new(|| {})).is_none());
    }
}
