//! 集成测试：`file: None`（旧版行为：仅 stderr，不产生文件）。
//!
//! 独立测试进程，保证本文件内的初始化是本进程的首次安装。

#[test]
fn init_without_file_config_does_not_create_files() {
    // 该目录不应被任何逻辑创建（未配置文件层）
    let dir = std::env::temp_dir().join(format!(
        "crish-telemetry-legacy-{}",
        std::process::id()
    ));

    let ok = conex_telemetry::init_default("info", None);
    assert!(ok, "旧版签名路径应安装成功");

    // 发射记录：宏为活跃 subscriber 所捕获，不得 panic
    tracing::info!(target: "test", "legacy mode log line");
    tracing::warn!(target: "test", "legacy mode warn line");

    assert!(
        !dir.exists(),
        "file: None 时不应创建日志目录: {}",
        dir.display()
    );
}
