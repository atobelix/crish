//! 集成测试：panic hook 崩溃文件（PE-04 T04.1-3）。
#![allow(clippy::disallowed_methods)] // 测试临时目录清理，非产品物理删除路径
//!
//! 独立测试进程（integration test 二进制）：hook 为进程级全局状态，
//! 与其他测试文件（panic_hook_none.rs）分离进程，保证安装配置互不干扰。
//! 本文件内为单一测试（hook 只允许一次安装，拆多个测试会因并行执行
//! 产生目录归属竞争）。

use conex_telemetry::install_panic_hook_with_crash_dir;

fn temp_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("crish-telemetry-crash-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[test]
fn panic_writes_crash_file_with_message() {
    let dir = temp_dir();
    install_panic_hook_with_crash_dir(Some(dir.clone()));

    // 场景 1：裸 panic（hook 在触发线程执行、先于 unwinding；
    // catch_unwind 拦截后 join 正常返回，测试本身不失败）。
    let handle = std::thread::spawn(|| {
        let _ = std::panic::catch_unwind(|| {
            panic!("telemetry test panic boom");
        });
    });
    handle.join().expect("线程不应二次 panic");

    // 场景 2：应用真实路径——命令层 catch_unwind 拦截 panic，
    // hook 仍先落盘（T04.1-3 与 catch_unwind 并存不冲突）。
    // 间隔 >1s 保证时间戳文件名不碰撞（同秒同线程名会互相覆盖）。
    std::thread::sleep(std::time::Duration::from_millis(1100));
    let handle = std::thread::spawn(|| {
        let result: Result<(), _> = conex_telemetry::catch_unwind(|| {
            panic!("caught panic in command layer");
        });
        assert!(result.is_err(), "catch_unwind 应返回 Err(payload)");
        assert_eq!(result.unwrap_err().code, "common.panic");
    });
    handle.join().expect("线程不应二次 panic");

    // 崩溃目录应被 hook 自动创建并写入 crash-*.log
    let entries: Vec<_> = std::fs::read_dir(&dir)
        .expect("崩溃目录应存在")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .collect();
    assert!(
        entries.len() >= 2,
        "两次 panic 应生成两个独立崩溃文件（时间戳防覆盖）；实际 {} 个",
        entries.len()
    );
    assert!(
        entries.iter().all(|p| p
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .starts_with("crash-")),
        "文件应命名为 crash-YYYYMMDD-HHMMSS-<thread>.log"
    );

    let all_content = entries
        .iter()
        .map(|p| std::fs::read_to_string(p).expect("读取崩溃文件"))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        all_content.contains("telemetry test panic boom"),
        "崩溃文件应含场景 1 的 panic message；实际内容:\n{}",
        all_content
    );
    assert!(
        all_content.contains("caught panic in command layer"),
        "崩溃文件应含场景 2（catch_unwind）的 panic message"
    );
    assert!(all_content.contains("thread:"), "应含 thread 字段");
    assert!(all_content.contains("location:"), "应含 location 字段");
    assert!(
        all_content.contains("panic_message:"),
        "应含 panic_message 字段"
    );
}
