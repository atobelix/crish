use super::*;
use crate::browser::profile::browser_root;

/// 快速 tuning（测试用）。
fn fast_tuning() -> LaunchTuning {
    LaunchTuning {
        poll_interval: Duration::from_millis(20),
        poll_timeout: Duration::from_secs(3),
        launch_retry_delay: Duration::from_millis(30),
        crash_backoff: Duration::from_millis(60),
        crash_window: Duration::from_secs(30),
        crash_max_restarts: 3,
        wait_or_kill: Duration::from_millis(300),
    }
}

/// 测试数据根 + 管理器（含空格路径守卫：.bat 假浏览器参数解析不兼容空格）。
struct Harness {
    dir: tempfile::TempDir,
    manager: BrowserManager,
}

impl Harness {
    fn new() -> Option<Self> {
        let dir = tempfile::tempdir().expect("临时目录");
        if dir.path().to_string_lossy().contains(' ') {
            // 32 评审 F6（P2-7）：%TEMP% 含空格（如用户名含空格）时 .bat 假
            // 浏览器参数解析不兼容——显式报告跳过原因，避免覆盖静默丢失
            eprintln!(
                "跳过 .bat harness 测试：临时目录路径含空格（{}）",
                dir.path().display()
            );
            return None;
        }
        Some(Harness {
            manager: BrowserManager::with_tuning(dir.path().to_path_buf(), fast_tuning()),
            dir,
        })
    }

    /// 放置 CfT 缓存假二进制（仅满足 discover 命中，实际 spawn 走 binary_override）。
    fn fake_cft_binary(&self) {
        let root = browser_root(self.dir.path());
        let dir = root.join("browsers").join("chrome-151.0.7922.77");
        std::fs::create_dir_all(&dir).expect("缓存目录");
        let rel = crate::browser::cft::binary_rel_path().expect("平台路径");
        let bin = dir.join(rel);
        std::fs::create_dir_all(bin.parent().expect("父目录")).expect("目录");
        std::fs::write(bin, b"placeholder").expect("写入假二进制占位");
    }

    /// 写入假浏览器 .bat 脚本（spawn 经 LaunchConfig.binary_override 注入）。
    fn fake_browser(&self, script: &str) -> PathBuf {
        let p = self.dir.path().join("fake-browser.bat");
        std::fs::write(&p, script).expect("写入假浏览器脚本");
        p
    }

    /// 标准测试配置：CfT 缓存（discover 命中）+ 假浏览器脚本（spawn 注入）。
    fn config(&self, script: &str) -> LaunchConfig {
        self.fake_cft_binary();
        LaunchConfig {
            binary_override: Some(self.fake_browser(script)),
            ..Default::default()
        }
    }
}

/// 假浏览器脚本：写 DevToolsActivePort 后常驻（正常启动）。
/// 注意：Rust 传给 cmd 的参数带引号（`"--user-data-dir=C:\..."` 单 token），
/// 手动调用时可能不带引号（`=` 被 for 拆成两 token）；`%%~a` 去引号 +
/// 双形态解析（前缀匹配 / NEXT 取下一 token）兜底两种传参。
fn script_ok() -> String {
    "@echo off\r\n\
         setlocal enabledelayedexpansion\r\n\
         set PROFILE=\r\n\
         set NEXT=0\r\n\
         for %%a in (%*) do (\r\n\
         \x20 set \"A=%%~a\"\r\n\
         \x20 if \"!NEXT!\"==\"1\" (\r\n\
         \x20\x20 if not \"!A!\"==\"--user-data-dir\" set \"PROFILE=!A!\"\r\n\
         \x20\x20 set \"NEXT=0\"\r\n\
         \x20 )\r\n\
         \x20 if \"!A:~0,16!\"==\"--user-data-dir=\" set \"PROFILE=!A:~16!\"\r\n\
         \x20 if \"!A!\"==\"--user-data-dir\" set \"NEXT=1\"\r\n\
         )\r\n\
         if not defined PROFILE exit /b 9\r\n\
         > \"!PROFILE!\\DevToolsActivePort\" echo 38689\r\n\
         >> \"!PROFILE!\\DevToolsActivePort\" echo /devtools/browser/fake-session-uuid\r\n\
         :loop\r\n\
         ping -n 2 127.0.0.1 >nul\r\n\
         goto loop\r\n"
        .to_string()
}

/// 假浏览器脚本：写端口后约 1s 崩溃退出（退出码 1）。
fn script_crash() -> String {
    "@echo off\r\n\
         setlocal enabledelayedexpansion\r\n\
         set PROFILE=\r\n\
         set NEXT=0\r\n\
         for %%a in (%*) do (\r\n\
         \x20 set \"A=%%~a\"\r\n\
         \x20 if \"!NEXT!\"==\"1\" (\r\n\
         \x20\x20 if not \"!A!\"==\"--user-data-dir\" set \"PROFILE=!A!\"\r\n\
         \x20\x20 set \"NEXT=0\"\r\n\
         \x20 )\r\n\
         \x20 if \"!A:~0,16!\"==\"--user-data-dir=\" set \"PROFILE=!A:~16!\"\r\n\
         \x20 if \"!A!\"==\"--user-data-dir\" set \"NEXT=1\"\r\n\
         )\r\n\
         if not defined PROFILE exit /b 9\r\n\
         > \"!PROFILE!\\DevToolsActivePort\" echo 38689\r\n\
         >> \"!PROFILE!\\DevToolsActivePort\" echo /devtools/browser/fake-session-uuid\r\n\
         ping -n 2 127.0.0.1 >nul\r\n\
         exit /b 1\r\n"
        .to_string()
}

/// 假浏览器脚本：立即退出（提前退出诊断）。
fn script_early_exit() -> String {
    "@echo off\r\nexit /b 7\r\n".to_string()
}

/// 事件流采集：订阅并收集指定数量的 StateChanged 状态序列。
async fn collect_states(
    rx: &mut broadcast::Receiver<ProcessEvent>,
    count: usize,
) -> Vec<BrowserState> {
    let mut out = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(25);
    while out.len() < count {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let ev = tokio::time::timeout(remaining, rx.recv())
            .await
            .expect("等待事件超时")
            .expect("通道关闭");
        if let ProcessEvent::StateChanged { state, .. } = ev {
            out.push(state);
        }
    }
    out
}

mod graceful_stop;
mod lifecycle;
mod process_drop_panic;
