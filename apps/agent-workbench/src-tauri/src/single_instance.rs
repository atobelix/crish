//! 单实例锁（多端互通 R1-09 缺口 G-2：桌面多实例端口竞争）
//!
//! # 选型
//!
//! 采用官方插件 `tauri-plugin-single-instance`（计划 G-2 首选项「Tauri 单实例
//! 插件/named mutex」；crates.io 网络可用，已实测可拉取）。理由：
//! - Windows 内部机制即**命名互斥**：`CreateMutexW`（bInitialOwner=TRUE）+
//!   `GetLastError() == ERROR_ALREADY_EXISTS` 判定第二实例，互斥名
//!   `{identifier}-sim`（本应用 = `io.github.conex-community.crish-sim`）——
//!   与自研 named mutex 方案语义等价，且无需新增任何 windows-sys feature 依赖
//!   负担（插件自带声明，0.61 与仓库锁定版本同源）；
//! - 第二实例→首实例的唤醒通道（Windows 隐藏消息窗口 + WM_COPYDATA）由插件
//!   免费提供；自研方案必须重造该 IPC（消息窗口 + COPYDATA 协议），与官方
//!   插件重复且极易出错，违反「架构优雅、杜绝打补丁」铁律；
//! - 跨平台免费：Windows 命名互斥 / Linux D-Bus / macOS，仓库仅需追加一条
//!   依赖声明（平台相关依赖由插件自身 cfg 隔离，不进入其它平台构建图）。
//!
//! # 机制（Windows，对齐插件 v2.4.x 源码语义）
//!
//! 1. **首实例**：插件 setup 阶段（`Builder::build()` 内）创建命名互斥成功 →
//!    创建不可见消息窗口（`{identifier}-siw`，消息类 `{identifier}-sic`）；
//! 2. **第二实例**：同一互斥名二次 `CreateMutexW` → `ERROR_ALREADY_EXISTS` →
//!    `FindWindowW` 找到首实例隐藏窗口 → `SendMessageW(WM_COPYDATA)` 传递
//!    `cwd|args` → 第二实例 `cleanup_before_exit()` + `std::process::exit(0)`；
//! 3. **首实例**：消息窗口收到 WM_COPYDATA → 调用本模块注册的
//!    [on_second_instance] 回调（携带第二实例的 args/cwd）。
//!
//! 第二实例的退出发生在 `build()` 阶段、`run()` 之前——因此不会初始化窗口、
//! 本地服务（8765-8775 端口）与数据库，天然消除端口竞争（G-2 本体）。
//! 注意：`main()` 顶部的 telemetry 初始化在 build 之前，第二实例会留下一行
//! 日志文件（无害，属诚实留痕）。
//!
//! # 第二实例提示方案（诚实边界）
//!
//! 第二实例无法弹 GUI（设计如此：`exit(0)` 在 run() 之前），提示放首实例侧：
//! - 窗口前置：`show` + `unminimize` + `set_focus`（Tauri 原生 API，无新依赖）；
//! - 任务栏闪烁：`request_user_attention(Informational)`（Windows 原生
//!   FlashWindowEx 语义，用户可感知的真实提示）；
//! - 前端契约事件 `single-instance://second-launch`：载荷
//!   `{"args": [...], "cwd": "..."}`，crish-desktop 侧监听后可补 toast；
//!   事件是真实发射通道（前端暂未消费时无副作用），本次任务的可视提示
//!   以窗口前置 + 任务栏闪烁为准，未做假实现；
//! - tracing 日志（target: `single-instance`）。
//!
//! # 已知限制（如实记录，不回避）
//!
//! - **崩溃恢复**：首实例进程异常终止后互斥成为 abandoned，插件既不接管
//!   （未调 `WaitForSingleObject` 认领）也不重建消息窗口（`FindWindowW` 为空
//!   → 什么都不做）——此时后续多实例可并存，端口竞争退化为 R1-02 端口探测
//!   兜底。硬化建议（后续轮次）：自研命名互斥 + `WAIT_ABANDONED` 认领语义；
//! - **启动竞态**：`ERROR_ALREADY_EXISTS` 但窗口尚未找到（首实例 setup 进行
//!   中）的极小窗口内，第二实例不退出而继续运行——同受 R1-02 探测兜底。
//!
//! # 配对模式语义（G-2 第 3 项）
//!
//! 单实例锁保证任意时刻至多一个实例存活 → 「配对模式仅首实例可开」自动满足
//! （多实例根本无法并存，配对协调器 [server::pairing] 无需感知锁）。若后续
//! 移除单实例锁，必须在配对启动入口补显式守卫，本注释即契约。
//!
//! # 测试
//!
//! 单元测试直接验证 Win32 命名互斥语义（与插件内部同源）：测试专用锁名含
//! 进程 ID，与真实应用锁 `{identifier}-sim` 及并行测试完全隔离；同进程
//! 跨线程复现「两实例并存」场景。真实锁由插件持有，无法在进程内二次构建
//! 验证（第二实例会 `exit(0)` 杀掉测试进程），故以同源 Win32 原语测试锁定
//! 判定语义。

use tauri::{Emitter, Manager};

/// 主窗口 label：tauri.conf.json 未显式声明 → Tauri 2 默认 `"main"`。
/// 窗口前置提示的查找键；常量测试锁定防漂移。
pub(crate) const MAIN_WINDOW_LABEL: &str = "main";

/// 前端契约事件名（命名遵循仓库 `x://y` 惯例，如 `browser://state-changed`）。
/// crish-desktop 侧监听后展示 toast 等提示；事件为真实发射通道，前端暂未
/// 消费时无副作用。
pub(crate) const EVENT_SECOND_LAUNCH: &str = "single-instance://second-launch";

/// 注册单实例锁插件（须在 Builder 链上**最先**注册：插件 setup 在
/// `build()` 阶段执行，第二实例此时即退出，避免其它插件 setup 空跑；
/// 接线点见 main.rs）。
pub fn register<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_single_instance::init(|app, args, cwd| {
        on_second_instance(app, &args, &cwd);
    })
}

/// 首实例回调：第二实例启动时由插件唤醒本实例（Windows: WM_COPYDATA），
/// 执行窗口前置提示 + 事件发射。
pub(crate) fn on_second_instance<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    args: &[String],
    cwd: &str,
) {
    tracing::warn!(
        target: "single-instance",
        args = ?args,
        cwd = %cwd,
        "检测到第二实例启动（本实例保持运行）：执行窗口前置提示"
    );

    // 窗口前置 + 任务栏闪烁：show/unminimize 兜底最小化或隐藏状态，
    // set_focus 尝试置前，request_user_attention 提供任务栏闪烁（Windows
    // 前景锁可能抑制 set_focus，闪烁是用户可感知的兜底提示）。
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
    } else {
        tracing::warn!(
            target: "single-instance",
            "主窗口未就绪，跳过窗口前置提示（事件仍照发）"
        );
    }

    // 前端契约事件（载荷形状由 build_second_launch_payload 测试锁定）
    if let Err(error) = app.emit(EVENT_SECOND_LAUNCH, build_second_launch_payload(args, cwd)) {
        tracing::warn!(
            target: "single-instance",
            error = %error,
            "second-launch 事件发射失败"
        );
    }
}

/// 构建 `second-launch` 事件载荷（纯函数：便于测试锁定前端契约形状）。
pub(crate) fn build_second_launch_payload(args: &[String], cwd: &str) -> serde_json::Value {
    serde_json::json!({
        "args": args,
        "cwd": cwd,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Win32 命名互斥语义（与插件 Windows 实现同源：
    /// `CreateMutexW` + `ERROR_ALREADY_EXISTS` 判定）。测试锁名含进程 ID，
    /// 与真实应用锁（`{identifier}-sim`，由插件创建）完全隔离；同进程跨线程
    /// 复现「两个实例并存」：
    /// - 首创建（线程 A 持有，模拟首实例）→ 错误码非 ALREADY_EXISTS；
    /// - 同锁名二次创建（主线程，模拟第二实例）→ ERROR_ALREADY_EXISTS
    ///   （插件第二实例判定依据，逐字对齐）；
    /// - 全部句柄关闭后（模拟首实例退出）→ 同名锁可重新创建。
    #[cfg(windows)]
    #[allow(unsafe_code)]
    #[test]
    fn named_mutex_second_acquire_fails_then_reacquire_after_release() {
        use std::sync::mpsc;
        use windows_sys::Win32::{
            Foundation::{CloseHandle, GetLastError, SetLastError, ERROR_ALREADY_EXISTS},
            System::Threading::{CreateMutexW, ReleaseMutex},
        };

        // 测试专用锁名：进程 ID 隔离多进程并行测试；后缀隔离同进程并行测试
        let mutex_name: Vec<u16> = format!("Crish.SI.Test.{}.mutex", std::process::id())
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();

        // HANDLE（*mut c_void）非 Send，跨线程以 usize 传递后转回
        let (tx_created, rx_created) = mpsc::channel::<usize>();
        let (tx_release, rx_release) = mpsc::channel::<()>();

        std::thread::scope(|scope| {
            // 首实例线程：创建并持有互斥（bInitialOwner=TRUE，镜像插件调用参数）；
            // move 闭包拿走 Sender/Receiver（mpsc 非 Sync，不可跨线程共享），
            // 锁名克隆一份给线程使用，主线程保留原值做二次创建
            let thread_name = mutex_name.clone();
            scope.spawn(move || unsafe {
                let handle = CreateMutexW(std::ptr::null(), 1, thread_name.as_ptr());
                assert!(!handle.is_null(), "首次创建命名互斥必须成功");
                tx_created
                    .send(handle as usize)
                    .expect("通知主线程创建完成");
                // 超时兜底：主线程断言失败时避免 scope 收尾死锁
                let _ = rx_release.recv_timeout(std::time::Duration::from_secs(30));
                ReleaseMutex(handle);
                CloseHandle(handle);
            });

            let _first = rx_created.recv().expect("首实例线程已创建互斥");

            // 第二实例视角：同名二次创建 → ERROR_ALREADY_EXISTS
            unsafe {
                SetLastError(0);
                let second = CreateMutexW(std::ptr::null(), 1, mutex_name.as_ptr());
                assert!(!second.is_null(), "已存在的互斥仍应返回句柄");
                assert_eq!(
                    GetLastError(),
                    ERROR_ALREADY_EXISTS,
                    "同锁名二次创建必须报 ALREADY_EXISTS（插件第二实例判定依据）"
                );
                CloseHandle(second);
            }
            tx_release.send(()).expect("放行首实例线程");
        });

        // 首实例退出后（全部句柄已关闭）：同名锁应可重新创建
        unsafe {
            SetLastError(0);
            let reacquired = CreateMutexW(std::ptr::null(), 1, mutex_name.as_ptr());
            assert!(!reacquired.is_null());
            assert_ne!(
                GetLastError(),
                ERROR_ALREADY_EXISTS,
                "互斥释放后应可重新创建（首实例退出后可再次启动）"
            );
            CloseHandle(reacquired);
        }
    }

    /// second-launch 事件载荷形状（前端契约；含中文/空格路径防转义回归）。
    #[test]
    fn second_launch_payload_contract() {
        let args = vec![
            "crish://pair".to_string(),
            "--flag".to_string(),
            "含空格路径 C:\\work dir".to_string(),
        ];
        let payload = build_second_launch_payload(&args, "C:\\work\\项目目录");

        assert_eq!(payload["args"][0], "crish://pair");
        assert_eq!(payload["args"][1], "--flag");
        assert_eq!(payload["args"][2], "含空格路径 C:\\work dir");
        assert_eq!(payload["cwd"], "C:\\work\\项目目录");
    }

    /// 窗口 label / 事件名常量契约：label 与 tauri.conf.json（未显式声明 →
    /// 默认 "main"）对齐；事件名遵循仓库 `x://y` 惯例。防改名后前端契约
    /// 静默断裂。
    #[test]
    fn window_label_and_event_constants() {
        assert_eq!(MAIN_WINDOW_LABEL, "main");
        assert_eq!(EVENT_SECOND_LAUNCH, "single-instance://second-launch");
    }
}
