use super::*;

/// 事件面零端点：StateChanged Debug 不含端口/路径片段（§7.3 回归）。
#[test]
fn endpoint_never_in_events() {
    let ev = ProcessEvent::StateChanged {
        state: BrowserState::Running,
        restarts: 0,
        backend: Some(BackendResolution {
            backend: crate::browser::discover::Backend::SystemChrome {
                path: PathBuf::from("C:\\secret\\chrome.exe"),
            },
            probes: vec![],
        }),
        error: None,
    };
    let debug = format!("{ev:?}");
    assert!(!debug.contains("38689"));
    assert!(!debug.contains("/devtools/"));
    assert!(!debug.contains("secret"));
    // status 也不含端点
    let status = BrowserStatus {
        state: BrowserState::Running,
        restarts: 0,
        backend: Some("SystemChrome".into()),
        last_error: None,
        nav_tabs: 1,
    };
    assert!(!format!("{status:?}").contains("ws://"));
}

// —— G-9：优雅停止先发 Browser.close（发送面单元测试，跨平台可跑）——

/// G-9 测试假发送器：记录调用序列 + 可控副作用——`exit_flag` 写入 close
/// 标志文件（触发假浏览器脚本自然退出）、`fail` 注入发送失败。
#[derive(Clone, Default)]
struct RecordingClose {
    calls: Arc<Mutex<Vec<&'static str>>>,
    exit_flag: Option<PathBuf>,
    fail: bool,
}

impl RecordingClose {
    fn recorded(&self) -> Vec<&'static str> {
        self.calls.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

#[async_trait]
impl BrowserCloseSender for RecordingClose {
    async fn send_browser_close(&self) -> Result<(), crate::cdp::error::CdpError> {
        self.calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(crate::cdp::domains::names::BROWSER_CLOSE);
        if let Some(flag) = &self.exit_flag {
            let _ = tokio::fs::write(flag, "close").await;
        }
        if self.fail {
            return Err(crate::cdp::error::CdpError::Internal {
                method: Some(crate::cdp::domains::names::BROWSER_CLOSE.to_string()),
                message: "测试注入：发送失败".to_string(),
            });
        }
        Ok(())
    }
}

/// G-9：登记发送面后，优雅停止的发送步骤发出 `Browser.close`（命令序列）。
#[tokio::test]
async fn graceful_close_sender_emits_browser_close() {
    let dir = tempfile::tempdir().expect("临时目录");
    let mgr = BrowserManager::new(dir.path());
    let recorder = Arc::new(RecordingClose::default());
    mgr.register_close_sender(recorder.clone());
    mgr.send_browser_close_gracefully().await;
    assert_eq!(
        recorder.recorded(),
        vec![crate::cdp::domains::names::BROWSER_CLOSE],
        "优雅停止必须先发 Browser.close"
    );
}

/// G-9：无会话登记 → 发送步骤直接返回（既有兜底语义，不 panic）。
#[tokio::test]
async fn graceful_close_sender_absent_is_noop() {
    let dir = tempfile::tempdir().expect("临时目录");
    let mgr = BrowserManager::new(dir.path());
    mgr.send_browser_close_gracefully().await;
}

/// G-9：发送失败（无连接/拒绝）→ 静默容忍，不 panic、不阻塞停止收敛。
#[tokio::test]
async fn graceful_close_sender_failure_tolerated() {
    let dir = tempfile::tempdir().expect("临时目录");
    let mgr = BrowserManager::new(dir.path());
    let recorder = Arc::new(RecordingClose {
        fail: true,
        ..Default::default()
    });
    mgr.register_close_sender(recorder.clone());
    mgr.send_browser_close_gracefully().await;
    assert_eq!(
        recorder.recorded(),
        vec![crate::cdp::domains::names::BROWSER_CLOSE]
    );
}

/// G-9：登记 → 清空 → 不再发送（会话结束路径不向已死会话重复发送）。
#[tokio::test]
async fn close_sender_register_clear_cycle() {
    let dir = tempfile::tempdir().expect("临时目录");
    let mgr = BrowserManager::new(dir.path());
    let recorder = Arc::new(RecordingClose::default());
    mgr.register_close_sender(recorder.clone());
    mgr.clear_close_sender();
    mgr.send_browser_close_gracefully().await;
    assert!(
        recorder.recorded().is_empty(),
        "清空后不得再发 Browser.close"
    );
}

/// 假浏览器 .bat harness 生命周期测试（32 评审 P1-1 修复）：
/// 全部用例依赖 `.bat`/cmd 语义假浏览器脚本（写 DevToolsActivePort、
/// `ping -n 2` 计时循环），ubuntu 中层 CI（`cargo test --workspace`）的
/// unix spawn 直接 exec 无 shebang 文件必失败——整组 `#[cfg(windows)]`
/// 门控（ubuntu 不编译不收集）。与 platform/windows.rs 已门控的
/// `job_kill_tree_terminates`（杀树原语层，windows.rs:284-286）不重复：
/// 本组覆盖 BrowserManager 生命周期调度面（start/stop/崩溃自愈/双启竞态）。
#[cfg(windows)]
mod harness; // mod harness（`#[cfg(windows)]` 门控，32 评审 P1-1）
