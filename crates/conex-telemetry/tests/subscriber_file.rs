//! 集成测试：双通道文件层（PE-04 T04.1-1）。
//!
//! 独立测试进程（integration test 二进制），保证全局 subscriber 状态
//! 不被其他测试文件污染——本文件内的初始化就是本进程的首次安装。

use std::io::Read;

use conex_telemetry::{init_default, FileConfig};

fn temp_log_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("crish-telemetry-{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("临时目录创建应成功");
    dir
}

#[test]
fn init_with_file_config_creates_daily_log_with_content() {
    let dir = temp_log_dir("file");

    // 首次安装：文件层 + stderr 双通道
    let ok = init_default(
        "debug",
        Some(FileConfig {
            dir: dir.clone(),
            file_name_prefix: "testwork".to_string(),
        }),
    );
    assert!(ok, "首次安装应成功（返回 true）");

    // 发射一条记录，随后从文件读回验证
    tracing::info!(target: "test", "hello from telemetry file test");

    // 幂等：再次调用（不同参数）不得重建/覆盖既有 subscriber 与文件
    let ok2 = init_default(
        "error",
        Some(FileConfig {
            dir: dir.clone(),
            file_name_prefix: "other".to_string(),
        }),
    );
    assert!(ok2, "幂等调用应返回 true（先前已安装）");

    // 日志目录应出现 testwork.*.log（而非 other.*.log——首次安装生效）
    let entries: Vec<_> = std::fs::read_dir(&dir)
        .expect("日志目录应存在")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .collect();
    assert!(!entries.is_empty(), "日志目录应生成文件");
    let file_path = entries
        .iter()
        .find(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("testwork.") && n.ends_with(".log"))
                .unwrap_or(false)
        })
        .expect("应存在 testwork.*.log 文件");
    assert!(
        entries.iter().all(|p| !p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .starts_with("other.")),
        "幂等：二次调用不得创建 other.*.log"
    );

    let mut content = String::new();
    std::fs::File::open(file_path)
        .expect("打开日志文件")
        .read_to_string(&mut content)
        .expect("读取日志文件");
    assert!(
        content.contains("hello from telemetry file test"),
        "日志文件应包含测试记录；实际内容:\n{}",
        content
    );
}
