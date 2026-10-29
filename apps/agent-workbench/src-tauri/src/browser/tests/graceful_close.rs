//! browser 槽测试 · 优雅停止先发 Browser.close 的集成链路（Windows-only）。

#![cfg(windows)]

use super::super::*;

use conex_browser::browser::cft::binary_rel_path;
use conex_browser::browser::profile::browser_root;
use conex_browser::LaunchTuning;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::path::PathBuf;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

/// 迷你 CDP WS 服务端：应答全部命令（getVersion 真实载荷、
/// getTargets 空表、其余 Ok）并记录方法；收到 Browser.close 时写
/// close 标志文件（模拟浏览器收到关闭命令后退出）。
struct MiniCdpServer {
    addr: SocketAddr,
    received: Arc<Mutex<Vec<String>>>,
    flag_written: Arc<AtomicBool>,
}

impl MiniCdpServer {
    async fn spawn(profile_dir: PathBuf) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("迷你 CDP 服务端绑定失败");
        let addr = listener.local_addr().expect("地址获取失败");
        let received: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let flag_written = Arc::new(AtomicBool::new(false));
        let (rx, fx) = (Arc::clone(&received), Arc::clone(&flag_written));
        // 测试专用迷你服务端：#[tokio::test] 异步上下文（自带 runtime），
        // 保持 tokio::spawn 即可（与生产面无关；G-13 L3 P0 只涉及同步路径）
        tokio::spawn(async move {
            loop {
                let (stream, _) = match listener.accept().await {
                    Ok(v) => v,
                    Err(_) => break,
                };
                let (rx, fx) = (Arc::clone(&rx), Arc::clone(&fx));
                let profile = profile_dir.clone();
                // 同 async 上下文（外层任务内），保持 tokio::spawn
                tokio::spawn(async move {
                    let ws = match tokio_tungstenite::accept_async(stream).await {
                        Ok(w) => w,
                        Err(_) => return,
                    };
                    let (mut sink, mut reader) = ws.split();
                    while let Some(Ok(Message::Text(text))) = reader.next().await {
                        let v: Value = match serde_json::from_str(&text) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        let method = v["method"].as_str().unwrap_or_default().to_string();
                        rx.lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .push(method.clone());
                        if method == "Browser.close" {
                            // 模拟浏览器收到 Browser.close 后退出
                            let _ = tokio::fs::write(profile.join("close-flag"), "close").await;
                            fx.store(true, Ordering::SeqCst);
                        }
                        if let Some(id) = v["id"].as_u64() {
                            let result = match method.as_str() {
                                "Browser.getVersion" => json!({
                                    "protocolVersion": "1.3",
                                    "product": "Chrome/151.0.0.0"
                                }),
                                "Target.getTargets" => json!({ "targetInfos": [] }),
                                _ => json!({}),
                            };
                            let mut msg = json!({ "id": id, "result": result });
                            if let Some(s) = v["sessionId"].as_str() {
                                msg["sessionId"] = Value::String(s.to_string());
                            }
                            if sink
                                .send(Message::Text(msg.to_string().into()))
                                .await
                                .is_err()
                            {
                                break;
                            }
                        }
                    }
                });
            }
        });
        MiniCdpServer {
            addr,
            received,
            flag_written,
        }
    }

    fn close_count(&self) -> usize {
        self.received
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .filter(|m| m.as_str() == "Browser.close")
            .count()
    }
}

/// 假浏览器 .bat：解析 --user-data-dir → 写 DevToolsActivePort（指向
/// 迷你 CDP 服务端端口）→ 轮询 close 标志文件（服务端收到
/// Browser.close 后写入）→ 自然退出（exit 0）。
fn fake_browser_script(port: u16) -> String {
    format!(
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
         > \"!PROFILE!\\DevToolsActivePort\" echo {port}\r\n\
         >> \"!PROFILE!\\DevToolsActivePort\" echo /devtools/browser/fake-session-uuid\r\n\
         :loop\r\n\
         if exist \"!PROFILE!\\close-flag\" exit /b 0\r\n\
         ping -n 2 127.0.0.1 >nul\r\n\
         goto loop\r\n"
    )
}

/// N6 验收：会话建立（connect → register_session 接线）后 Graceful
/// 停止先发 Browser.close → 假浏览器自然退出（不杀树）→ 停止收尾
/// 清空发送面（M3 自动清空，二次停止不再向已死会话重复发送）。
#[tokio::test]
async fn graceful_stop_sends_browser_close_after_session_registered() {
    let dir = tempfile::tempdir().expect("临时目录");
    if dir.path().to_string_lossy().contains(' ') {
        // 路径含空格：.bat 假浏览器参数解析不兼容（显式跳过并说明）
        eprintln!(
            "跳过 .bat harness 测试：临时目录路径含空格（{}）",
            dir.path().display()
        );
        return;
    }
    // CfT 缓存占位（discover 命中；实际 spawn 走 binary_override）
    let cache = browser_root(dir.path())
        .join("browsers")
        .join("chrome-151.0.7922.77");
    std::fs::create_dir_all(&cache).expect("缓存目录");
    let rel = binary_rel_path().expect("平台路径");
    let bin = cache.join(rel);
    std::fs::create_dir_all(bin.parent().expect("父目录")).expect("目录");
    std::fs::write(bin, b"placeholder").expect("写入占位");
    // 迷你 CDP 服务端（先于假浏览器绑定端口，端口写入 .bat）
    let server = MiniCdpServer::spawn(dir.path().to_path_buf()).await;
    let bat = dir.path().join("fake-browser.bat");
    std::fs::write(&bat, fake_browser_script(server.addr.port())).expect("写入假浏览器脚本");
    let tuning = LaunchTuning {
        poll_interval: Duration::from_millis(20),
        poll_timeout: Duration::from_secs(3),
        launch_retry_delay: Duration::from_millis(30),
        crash_backoff: Duration::from_millis(60),
        crash_window: Duration::from_secs(30),
        crash_max_restarts: 3,
        // .bat 轮询粒度 ~1s：等待窗口须覆盖一轮以上轮询（对齐
        // conex-browser G-9 用例的 5s 放大，保证自然退出不杀树）
        wait_or_kill: Duration::from_secs(5),
    };
    let manager = Arc::new(BrowserManager::with_tuning(
        dir.path().to_path_buf(),
        tuning,
    ));
    let slot = Arc::new(BrowserSlot::from_parts(
        Some(manager),
        LaunchConfig {
            binary_override: Some(bat),
            ..Default::default()
        },
    ));
    // 会话建立：启动 + connect + register_session（N6 接线点）
    let started = slot.start().await.expect("启动+连接应成功");
    assert_eq!(started, "running");
    // Graceful 停止：先发 Browser.close（N6 断言点）
    slot.stop(false).await.expect("优雅停止应收敛");
    assert_eq!(
        server.close_count(),
        1,
        "优雅停止必须先发 Browser.close（经登记会话的发送面）"
    );
    assert!(
        server.flag_written.load(Ordering::SeqCst),
        "服务端应收到 Browser.close 并写退出标志"
    );
    assert_eq!(slot.status().state, "stopped");
    // 会话销毁 → 发送面已自动清空（M3 clear_session_state）：二次
    // 优雅停止幂等，不再向已死会话重复发送 Browser.close
    slot.stop(false).await.expect("二次停止幂等");
    assert_eq!(
        server.close_count(),
        1,
        "停止收尾必须清空发送面：不得向已死会话重复发送"
    );
}

#[tokio::test]
async fn input_accessor_smoke() {
    let slot = Arc::new(BrowserSlot::from_parts(None, LaunchConfig::default()));
    let inp = slot.input();
    assert!(!inp.pipeline_wired());
}
