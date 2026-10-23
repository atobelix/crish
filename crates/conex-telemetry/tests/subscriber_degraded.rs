//! 集成测试：文件层不可用 → 降级仅 stderr、返回 false、不 panic
#![allow(clippy::disallowed_methods)] // 测试临时文件清理，非产品物理删除路径
//! （PE-04 T04.1-1：日志不可用不能阻断应用启动）。
//!
//! 独立测试进程，保证本文件内的初始化是本进程的首次安装。

#[test]
fn init_with_uncreatable_dir_degrades_gracefully() {
    // 构造一个「父路径是文件」的目录：create_dir_all 必然失败
    // （Windows 与 Unix 通用，路径/权限无关）。
    let blocker =
        std::env::temp_dir().join(format!("crish-telemetry-blocker-{}", std::process::id()));
    std::fs::write(&blocker, b"x").expect("写入阻塞文件");

    let bad_dir = blocker.join("logs"); // 文件之下不可能再建目录
    let ok = conex_telemetry::init_default(
        "info",
        Some(conex_telemetry::FileConfig {
            dir: bad_dir,
            file_name_prefix: "t".to_string(),
        }),
    );
    assert!(!ok, "文件层不可用时应返回 false（降级信号）");

    // 降级后 subscriber 仍可用（stderr 通道），tracing 宏不 panic
    tracing::info!(target: "test", "degraded mode still logs to stderr");
    tracing::error!(target: "test", "degraded error line");

    let _ = std::fs::remove_file(&blocker);
}
