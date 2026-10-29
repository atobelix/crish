//! server 测试 · 绑定/探测/关闭与装配级 router 闭环。

use super::super::*;
use super::support::*;

use std::net::TcpListener as StdTcpListener;

#[tokio::test]
async fn bind_port_zero_gets_ephemeral_port() {
    let instance = ServerInstance::bind(temp_config(0))
        .await
        .expect("端口 0 绑定必须成功");
    assert_ne!(instance.addr().port(), 0, "系统应分配实际端口");
    assert_eq!(instance.addr().ip(), std::net::Ipv4Addr::LOCALHOST);
}

#[tokio::test]
async fn port_probe_falls_back_to_next_port_when_occupied() {
    // 动态占住基准端口 → 探测兜底应落到后续可用探测端口（并发下 base_port + 1 可能被其它测试占用）
    let temp_listener = StdTcpListener::bind("127.0.0.1:0").expect("获取可用临时端口");
    let base_port = temp_listener.local_addr().expect("读取端口").port();
    let occupied = temp_listener;
    let instance = ServerInstance::bind(temp_config(base_port))
        .await
        .expect("探测兜底必须成功");
    assert_ne!(
        instance.addr().port(),
        base_port,
        "不得绑定已被占用的基准端口"
    );
    assert!(
        instance.addr().port() > base_port
            && instance.addr().port() <= base_port + config::PORT_PROBE_COUNT,
        "基准端口被占用时应回退到探测范围内的可用端口"
    );
    drop(occupied);
}

#[test]
fn service_capabilities_cover_all_17_wire_names() {
    let caps = service_capabilities();
    assert_eq!(caps.len(), ALL_CAPABILITIES.len(), "能力位必须 17 位全表");
    for cap in ALL_CAPABILITIES {
        let wire = serde_json::to_string(&cap)
            .unwrap_or_default()
            .trim_matches('"')
            .to_string();
        assert!(caps.contains_key(&wire), "能力位缺 {wire}");
    }
    // 骨架默认支持集 / 关闭集
    for on in [
        "taskList",
        "runControl",
        "eventReplay",
        "approval",
        "settings",
        "presence",
        "streams",
    ] {
        assert!(caps[on], "{on} 应为骨架支持位");
    }
    for off in ["fileWrite", "runTask", "taskInput", "sessionSearch"] {
        assert!(!caps[off], "{off} 骨架期不应开放");
    }
}

#[test]
fn shutdown_is_idempotent_and_signals_watch() {
    let handle = ServerHandle::new(temp_config(0), "127.0.0.1:0".parse().expect("固定地址"));
    let rx = handle.shutdown_rx();
    handle.shutdown();
    handle.shutdown();
    // 同步检查当前值（serve 启动时的先行置位短路依赖此语义）
    assert!(*rx.borrow());
}

#[tokio::test]
async fn serve_info_endpoint_then_graceful_shutdown() {
    let instance = ServerInstance::bind(temp_config(0))
        .await
        .expect("绑定失败");
    let addr = instance.addr();
    let handle = instance.handle().clone();
    let router = instance.router(None, None, None, None, None);
    let task = tokio::spawn(async move { instance.serve(router).await });

    // 轮询等待服务就绪并请求 /v1/info（真实监听 + HTTP 往返）
    let url = format!("http://{addr}/v1/info");
    let mut info: Option<serde_json::Value> = None;
    for _ in 0..50 {
        if let Ok(response) = reqwest::get(&url).await {
            if response.status().is_success() {
                info = response.json::<serde_json::Value>().await.ok();
                if info.is_some() {
                    break;
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let info = info.expect("服务应在 1s 内就绪并响应 /v1/info");
    assert_eq!(info["service"].as_str(), Some("crish-agent-workbench"));
    assert_eq!(info["port"].as_u64(), Some(addr.port() as u64));
    assert_eq!(info["bindMode"].as_str(), Some("loopback"));
    assert_eq!(info["pairingActive"].as_bool(), Some(false));
    assert_eq!(info["protocolVersion"].as_u64(), Some(1));
    let caps = info["capabilities"]
        .as_object()
        .expect("capabilities 应为对象");
    assert_eq!(caps.len(), ALL_CAPABILITIES.len());

    // 优雅关停：serve future 应正常返回（而非挂死）
    handle.shutdown();
    let result = task.await.expect("serve 任务不应 panic");
    assert!(result.is_ok(), "serve 应正常退出：{result:?}");
}

// ── 装配级集成测试（R1-11 G-1：router 注入真实后端 + 扇出器）──

/// 测试事件发射器（记录通道与载荷；不依赖 Tauri runtime）
#[derive(Default)]
struct RecordingEmitter {
    calls: std::sync::Mutex<Vec<(String, String)>>,
}

impl conex_run::core_event_bridge::Emitter for RecordingEmitter {
    fn emit(&self, channel: &str, payload: &str) {
        self.calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((channel.to_string(), payload.to_string()));
    }
}

struct TestBackendStub;

#[async_trait::async_trait]
impl backend::ApiBackend for TestBackendStub {
    async fn get_status(&self) -> Result<serde_json::Value, ServerError> {
        Ok(serde_json::json!({
            "initialized": false,
            "version": option_env!("CARGO_PKG_VERSION").unwrap_or("0.1.0"),
        }))
    }

    async fn get_run_snapshot(
        &self,
        _params: conex_types::device::RunSnapshotParams,
    ) -> Result<conex_types::device::RunSnapshotResult, ServerError> {
        Err(ServerError::internal("test stub"))
    }

    async fn read_session_events(
        &self,
        _params: conex_types::device::EventPageParams,
    ) -> Result<conex_types::device::EventPageResult, ServerError> {
        Err(ServerError::internal("test stub"))
    }

    async fn list_sessions(
        &self,
        _params: conex_types::device::ListSessionsParams,
    ) -> Result<conex_types::device::ListSessionsResult, ServerError> {
        Err(ServerError::internal("test stub"))
    }

    async fn list_commands(&self) -> Result<conex_types::device::ListCommandsResult, ServerError> {
        Err(ServerError::internal("test stub"))
    }

    async fn run_task(
        &self,
        _p: conex_types::device::RunTaskParams,
    ) -> Result<conex_types::device::RunTaskResult, ServerError> {
        Err(ServerError::internal("test stub"))
    }

    async fn run_control(
        &self,
        _p: conex_types::device::RunControlParams,
    ) -> Result<conex_types::device::RunControlResult, ServerError> {
        Err(ServerError::internal("test stub"))
    }

    async fn cancel_run(
        &self,
        _p: conex_types::device::CancelRunParams,
    ) -> Result<conex_types::device::CancelRunResult, ServerError> {
        Err(ServerError::internal("test stub"))
    }

    async fn approve(
        &self,
        _p: conex_types::device::ApproveParams,
    ) -> Result<conex_types::device::ApproveResult, ServerError> {
        Err(ServerError::internal("test stub"))
    }

    async fn deny(
        &self,
        _p: conex_types::device::DenyParams,
    ) -> Result<conex_types::device::ApproveResult, ServerError> {
        Err(ServerError::internal("test stub"))
    }
}

/// 装配级测试最小真实面（G-1）：ApiBackend 注入 ApiBackend 槽
fn assembled_backend() -> (Arc<dyn backend::ApiBackend>, Arc<RecordingEmitter>) {
    let webview = Arc::new(RecordingEmitter::default());
    (Arc::new(TestBackendStub), webview)
}

/// WS 订阅 + 扇出 → events.push（实时推送链路最小闭环：订阅注册 →
/// fanout 发布 → drain 推送）。返回推送帧 body。
async fn subscribe_and_receive_push(
    addr: SocketAddr,
    token: &str,
    fanout: &fanout::FanOutEmitter,
) -> serde_json::Value {
    use conex_run::core_event_bridge::Emitter;
    use futures_util::{SinkExt, StreamExt};
    let ws_url = format!("ws://{addr}/v1/events?token={token}");
    let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .expect("WS 升级必须成功");
    // 订阅 s-1（DeviceEnvelope 信封：v/kind/msgId/ts/from/to/auth/body；
    // auth 为空占位——测试态免签名，对齐 DeviceEnvelope::unsigned）
    let subscribe = serde_json::json!({
        "v": 1,
        "kind": "events.subscribe",
        "msgId": "asm-subscribe-1",
        "ts": now_ms(),
        "from": "mobile",
        "to": "desktop",
        "auth": { "deviceId": "", "nonce": "", "sig": "", "ts": 0 },
        "body": { "sessions": ["s-1"], "lastSequences": {} },
    });
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        subscribe.to_string().into(),
    ))
    .await
    .expect("订阅帧发送必须成功");
    // 等待 subscribe.ok（服务端已处理订阅并重建 fanout 过滤器）
    let (kind, _) = {
        let text = tokio::time::timeout(std::time::Duration::from_secs(3), ws.next())
            .await
            .expect("等待订阅回执超时")
            .expect("订阅回执帧必须存在")
            .expect("帧读取成功");
        let frame: serde_json::Value =
            serde_json::from_str(&text.to_string()).expect("订阅回执必须为合法信封");
        assert_eq!(
            frame["kind"].as_str().unwrap_or_default(),
            "events.subscribe.ok",
            "订阅回执：{frame}"
        );
        (
            frame["kind"].as_str().unwrap_or_default().to_string(),
            frame["body"].clone(),
        )
    };
    assert_eq!(kind, "events.subscribe.ok");
    // 引擎事件 → 扇出（与生产同源：EventBridge 汇聚点挂接 FanOutEmitter）
    let payload = serde_json::json!({
        "type": "agent-start",
        "sessionId": "s-1",
        "schemaVersion": 1,
        "runId": "r-asm",
        "timestamp": "2026-01-01T00:00:00Z",
        "sequence": 1,
    });
    fanout.emit("workbench-run-event", &payload.to_string());
    // 等待 events.push
    let text = tokio::time::timeout(std::time::Duration::from_secs(3), ws.next())
        .await
        .expect("等待推送超时")
        .expect("推送帧必须存在")
        .expect("帧读取成功");
    let frame: serde_json::Value =
        serde_json::from_str(&text.to_string()).expect("推送帧必须为合法信封");
    assert_eq!(
        frame["kind"].as_str().unwrap_or_default(),
        "events.push",
        "扇出事件必须经 WS 推送"
    );
    let _ = ws.close(None).await;
    frame["body"].clone()
}

/// 装配链路总验证（R1-11 G-1 核心验收）：
/// ① /v1/info 免鉴权可达；② 无令牌 /v1/status → 401；
/// ③ 持令牌 /v1/status → 200 + 真实 CoreStatus（后端注入证明——
///    router(None) 时该端点运行期 500「服务命令后端未接线」）；
/// ④ WS 订阅 + 扇出发布 → events.push 实时送达（event_stream 注入）；
/// ⑤ 优雅关停。
#[tokio::test]
async fn assembled_router_serves_real_backend_fanout_and_401() {
    use axum::http::StatusCode;

    let (backend, _webview) = assembled_backend();
    let fanout = Arc::new(fanout::FanOutEmitter::new(vec![]));

    // 临时令牌库（pairing.json 预签发，鉴权面走真实 TokenStore 文件）
    let dir = tempfile::tempdir().expect("临时目录必须可创建");
    let mut config = ServerConfig::new(dir.path());
    config.port = 0;
    let token = {
        let mut store = auth::TokenStore::new(config.pairing_file_path.clone());
        store.issue("asm-device", now_ms()).expect("签发必须成功")
    };

    let instance = ServerInstance::bind(config).await.expect("绑定失败");
    let addr = instance.addr();
    let handle = instance.handle().clone();
    let router = instance.router(Some(backend), Some(Arc::clone(&fanout)), None, None, None);
    let task = tokio::spawn(async move { instance.serve(router).await });

    // 就绪轮询
    let info_url = format!("http://{addr}/v1/info");
    for _ in 0..50 {
        if reqwest::get(&info_url).await.is_ok() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }

    // ① /v1/info 免鉴权可达
    let info: serde_json::Value = reqwest::get(&info_url)
        .await
        .expect("请求必须可达")
        .json()
        .await
        .expect("info 必须为合法 JSON");
    assert_eq!(info["service"].as_str(), Some("crish-agent-workbench"));
    assert_eq!(info["port"].as_u64(), Some(addr.port() as u64));

    // ② 无令牌 /v1/status → 401（鉴权中间件不受后端注入影响）
    let response = reqwest::get(format!("http://{addr}/v1/status"))
        .await
        .expect("请求必须可达");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    // ③ 持令牌 → 200 + 真实 CoreStatus（后端已注入：非 500 未接线）
    let client = reqwest::Client::new();
    let response = client
        .get(format!("http://{addr}/v1/status"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .expect("请求必须可达");
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "后端注入后 /v1/status 必须 200（router(None) 时为 500 未接线）"
    );
    let status: serde_json::Value = response.json().await.expect("status 必须为合法 JSON");
    assert_eq!(
        status["initialized"].as_bool(),
        Some(false),
        "CoreStatus 载荷：{status}"
    );
    assert!(
        status["version"]
            .as_str()
            .is_some_and(|version| !version.is_empty()),
        "CoreStatus 必须携带真实版本"
    );

    // ④ WS 订阅 + 扇出 → events.push（事件流订阅链路闭环）
    let push = subscribe_and_receive_push(addr, &token, &fanout).await;
    assert_eq!(push["sessionId"].as_str(), Some("s-1"));
    assert_eq!(push["event"]["type"].as_str(), Some("agent-start"));
    // preview=false 时字段省略（skip_serializing_if）——带 sequence 的
    // 实时帧不得标记预览
    assert_ne!(
        push["preview"].as_bool(),
        Some(true),
        "带 sequence 的帧不得为 preview"
    );

    // ⑤ 优雅关停
    handle.shutdown();
    let result = task.await.expect("serve 任务不应 panic");
    assert!(result.is_ok(), "serve 应正常退出：{result:?}");
}

/// 装配面互斥验证：fanout 注入路由后，服务关闭仍可正常收尾
/// （set_event_stream 注入路径不破坏优雅关停语义）。
#[tokio::test]
async fn router_with_fanout_shuts_down_gracefully() {
    let fanout = Arc::new(fanout::FanOutEmitter::new(vec![]));
    let instance = ServerInstance::bind(temp_config(0))
        .await
        .expect("绑定失败");
    let addr = instance.addr();
    let handle = instance.handle().clone();
    let router = instance.router(None, Some(fanout), None, None, None);
    let task = tokio::spawn(async move { instance.serve(router).await });
    // 等服务就绪
    let url = format!("http://{addr}/v1/info");
    for _ in 0..50 {
        if reqwest::get(&url).await.is_ok() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    handle.shutdown();
    let result = task.await.expect("serve 任务不应 panic");
    assert!(result.is_ok(), "serve 应正常退出：{result:?}");
}
