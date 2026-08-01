//! 集成测试：`install_panic_hook`（无崩溃目录）+ 幂等性。
//!
//! 独立测试进程：与 panic_hook.rs 分离，保证本文件内的安装是
//! 本进程的首次安装（幂等语义 = 首次调用配置生效）。

use conex_telemetry::install_panic_hook_with_crash_dir;

fn temp_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "crish-telemetry-nocrash-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[test]
fn install_without_crash_dir_writes_nothing() {
    let dir = temp_dir();
    conex_telemetry::install_panic_hook();

    // 触发 panic：无崩溃目录 → 不得创建任何文件
    let handle = std::thread::spawn(|| {
        let _ = std::panic::catch_unwind(|| panic!("panic without crash dir"));
    });
    handle.join().expect("线程不应二次 panic");
    assert!(!dir.exists(), "未配置崩溃目录时不应创建任何文件");

    // 幂等：再调用带崩溃目录的版本应无效（首次安装已生效）
    install_panic_hook_with_crash_dir(Some(dir.clone()));
    let handle = std::thread::spawn(|| {
        let _ = std::panic::catch_unwind(|| panic!("second panic after re-install"));
    });
    handle.join().expect("线程不应二次 panic");
    assert!(
        !dir.exists(),
        "幂等：重复安装不得改变行为（崩溃目录配置不生效）"
    );
}

#[test]
fn double_install_is_safe() {
    let dir = temp_dir();
    // 连续调用不 panic（幂等 no-op）
    conex_telemetry::install_panic_hook();
    conex_telemetry::install_panic_hook();
    install_panic_hook_with_crash_dir(Some(dir.clone()));

    let handle = std::thread::spawn(|| {
        let _ = std::panic::catch_unwind(|| panic!("third panic"));
    });
    handle.join().expect("线程不应二次 panic");
    assert!(!dir.exists(), "重复安装应保持首次配置（无崩溃目录）");
}
