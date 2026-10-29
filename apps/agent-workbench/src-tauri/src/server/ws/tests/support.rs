//! WS 测试共享基建（tests.rs 拆分）：内存后端、服务装配、帧工具。

#![allow(clippy::disallowed_methods)]

use super::super::*;

use conex_run::core_event_bridge::Emitter;

use crate::server::auth::TokenStore;
use crate::server::backend::ApiBackend;
use crate::server::fanout::FanOutEmitter;
use crate::server::{router, ServerConfig, ServerHandle, ServerInstance, ServerState};
use conex_types::device::{
    ApproveParams, ApproveResult, CancelRunParams, CancelRunResult, DenyParams, EventPageParams,
    EventPageResult, ListCommandsResult, ListSessionsParams, ListSessionsResult, RunControlParams,
    RunControlResult, RunSnapshotParams, RunSnapshotResult, RunTaskParams, RunTaskResult,
};
use std::net::SocketAddr;
use std::time::Duration;

/// 内存事件后端：read_session_events 从内存表分页（游标语义与
/// conex-db query_events 同构：`sequence > after` 升序 + limit）
pub(super) struct MemoryBackend {
    /// 会话 → (sequence, 扁平事件 JSON)
    pub(super) events: Mutex<HashMap<String, Vec<(u64, Value)>>>,
    pub(super) run_tasks: Mutex<Vec<RunTaskParams>>,
    pub(super) run_controls: Mutex<Vec<RunControlParams>>,
    pub(super) run_control_error: Mutex<Option<ServerError>>,
    pub(super) cancel_runs: Mutex<Vec<CancelRunParams>>,
}

impl MemoryBackend {
    pub(super) fn new() -> Self {
        Self {
            events: Mutex::new(HashMap::new()),
            run_tasks: Mutex::new(Vec::new()),
            run_controls: Mutex::new(Vec::new()),
            run_control_error: Mutex::new(None),
            cancel_runs: Mutex::new(Vec::new()),
        }
    }

    /// 追加事件（sequence 递增）
    pub(super) fn push(&self, session_id: &str, event_type: &str, sequence: u64) {
        let mut map = self.events.lock().unwrap();
        map.entry(session_id.to_string()).or_default().push((
            sequence,
            serde_json::json!({
                "type": event_type,
                "sessionId": session_id,
                "sequence": sequence,
                "schemaVersion": 1,
                "runId": "r-test",
            }),
        ));
    }

    /// 批量追加（连续 sequence）
    pub(super) fn push_range(&self, session_id: &str, event_type: &str, from: u64, count: u64) {
        for seq in from..from + count {
            self.push(session_id, event_type, seq);
        }
    }
}

#[async_trait::async_trait]
impl ApiBackend for MemoryBackend {
    async fn get_status(&self) -> Result<serde_json::Value, ServerError> {
        Ok(serde_json::json!({ "initialized": true }))
    }
    async fn run_task(&self, p: RunTaskParams) -> Result<RunTaskResult, ServerError> {
        let session_id = p
            .session_id
            .clone()
            .unwrap_or_else(|| "s-mobile".to_string());
        self.run_tasks.lock().unwrap().push(p);
        Ok(RunTaskResult {
            run_id: "r-mobile".to_string(),
            session_id,
        })
    }
    async fn run_control(&self, p: RunControlParams) -> Result<RunControlResult, ServerError> {
        self.run_controls.lock().unwrap().push(p);
        if let Some(error) = self.run_control_error.lock().unwrap().take() {
            return Err(error);
        }
        Ok(RunControlResult { ok: true })
    }
    async fn cancel_run(&self, p: CancelRunParams) -> Result<CancelRunResult, ServerError> {
        self.cancel_runs.lock().unwrap().push(p.clone());
        Ok(CancelRunResult {
            ok: true,
            run_id: p.run_id,
        })
    }
    async fn approve(&self, _p: ApproveParams) -> Result<ApproveResult, ServerError> {
        Err(ServerError::internal("测试后端不支持"))
    }
    async fn deny(&self, _p: DenyParams) -> Result<ApproveResult, ServerError> {
        Err(ServerError::internal("测试后端不支持"))
    }
    async fn list_sessions(
        &self,
        _p: ListSessionsParams,
    ) -> Result<ListSessionsResult, ServerError> {
        Err(ServerError::internal("测试后端不支持"))
    }
    async fn read_session_events(
        &self,
        params: EventPageParams,
    ) -> Result<EventPageResult, ServerError> {
        let rows = self.events.lock().unwrap();
        let session_rows = rows.get(&params.session_id).cloned().unwrap_or_default();
        let after = params.after_sequence.unwrap_or(0);
        let limit = params.max_events.unwrap_or(200) as usize;
        // 空会话 → None（与 core_read_session_events 语义对齐）
        let latest = session_rows.last().map(|(seq, _)| *seq);
        let filtered: Vec<(u64, Value)> = session_rows
            .into_iter()
            .filter(|(seq, _)| *seq > after)
            .collect();
        let has_more = filtered.len() > limit;
        let page: Vec<Value> = filtered
            .iter()
            .take(limit)
            .map(|(_, event)| event.clone())
            .collect();
        let next = page
            .last()
            .and_then(|event| event["sequence"].as_u64())
            .unwrap_or(after);
        Ok(EventPageResult {
            events: page,
            next_after_sequence: next,
            has_more,
            latest_sequence: latest,
        })
    }
    async fn get_run_snapshot(
        &self,
        _p: RunSnapshotParams,
    ) -> Result<RunSnapshotResult, ServerError> {
        Err(ServerError::internal("测试后端不支持"))
    }
    async fn list_commands(&self) -> Result<ListCommandsResult, ServerError> {
        Err(ServerError::internal("测试后端不支持"))
    }
}

/// 测试事件流注入：直接构造 R1-01 的 FanOutEmitter（发布经
/// FanOutEmitter::emit 驱动，与生产装配同源）
pub(super) fn test_fanout() -> Arc<FanOutEmitter> {
    Arc::new(FanOutEmitter::new(vec![]))
}

/// 测试服务（临时端口 + 多令牌 + 后端 + 事件流注入）；返回
/// (地址, 句柄, 明文令牌表, 连接注册表)
pub(super) async fn spawn_server_with_tokens(
    backend: Option<Arc<dyn ApiBackend>>,
    fanout: Option<Arc<FanOutEmitter>>,
    labels: &[&str],
) -> (SocketAddr, ServerHandle, Vec<String>, Arc<WsRegistry>) {
    let dir = tempfile::tempdir().expect("临时目录必须可创建");
    // port=0：系统分配临时端口（并行测试互不抢占）
    let mut config = ServerConfig::new(dir.path());
    config.port = 0;
    // 预签发令牌（pairing.json 由 TokenStore 落盘）
    let tokens = {
        let mut store = TokenStore::new(config.pairing_file_path.clone());
        let mut issued = Vec::new();
        for label in labels {
            issued.push(store.issue(label, now_ms()).expect("签发必须成功"));
        }
        issued
    };
    let instance = ServerInstance::bind(config).await.expect("测试绑定失败");
    let addr = instance.addr();
    let handle = instance.handle().clone();
    let registry = {
        let tokens_store = TokenStore::load(&instance.handle().config().pairing_file_path);
        let mut state = ServerState::new(instance.handle(), tokens_store, backend);
        state.set_event_stream(fanout);
        let registry = state.ws_registry();
        let router = router::build_router(state);
        tokio::spawn(async move {
            let _ = instance.serve(router).await;
        });
        registry
    };
    // 轮询等待服务就绪
    let url = format!("http://{addr}/v1/info");
    for _ in 0..100 {
        if reqwest::get(&url).await.is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    (addr, handle, tokens, registry)
}

/// 测试服务（单令牌便捷版）
pub(super) async fn test_server(
    backend: Option<Arc<dyn ApiBackend>>,
    fanout: Option<Arc<FanOutEmitter>>,
) -> (SocketAddr, ServerHandle, String, Arc<WsRegistry>) {
    let (addr, handle, mut tokens, registry) =
        spawn_server_with_tokens(backend, fanout, &["test-device"]).await;
    (addr, handle, tokens.remove(0), registry)
}

/// WS 客户端连接（query token）
pub(super) async fn ws_connect(
    addr: SocketAddr,
    token: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let url = format!("ws://{addr}/v1/events?token={token}");
    let (ws, _) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("WS 连接必须成功");
    ws
}

/// 读下一帧文本（超时护栏；Close/错误折叠为标记串；控制帧跳过——
/// tungstenite 0.29 会把 Ping/Pong 控制帧传给应用层，服务端心跳
/// Ping 到达时库已自动回 Pong，此处忽略不干扰业务帧读取）
pub(super) async fn next_text(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Option<String> {
    loop {
        match tokio::time::timeout(Duration::from_secs(3), ws.next()).await {
            Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text)))) => {
                return Some(text.to_string());
            }
            Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_)))) => {
                return Some(String::from("<closed>"));
            }
            Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Ping(_))))
            | Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Pong(_)))) => continue,
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(_))) => return Some(String::from("<error>")),
            Ok(None) => return Some(String::from("<closed>")),
            Err(_) => panic!("等待帧超时"),
        }
    }
}

/// 发送信封帧（kind + body；msgId 计数器生成）
pub(super) async fn send_envelope_text(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    kind: &str,
    body: Value,
) {
    let kind: MessageKind = serde_json::from_str(&format!("\"{kind}\"")).unwrap();
    let envelope = DeviceEnvelope::unsigned(
        kind,
        format!("m-test-{:08}", MSG_COUNTER.fetch_add(1, Ordering::Relaxed)),
        now_ms(),
        DeviceEndpoint::Mobile,
        DeviceEndpoint::Desktop,
        body,
    );
    let text = serde_json::to_string(&envelope).unwrap();
    let _ = ws
        .send(tokio_tungstenite::tungstenite::Message::Text(text.into()))
        .await;
}

/// 移动端 SessionCommand wire 帧（remote.<command> + body.command/params）
pub(super) async fn send_remote_command(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    command: &str,
    msg_id: &str,
    params: Value,
) {
    let envelope = DeviceEnvelope::unsigned(
        MessageKind::Remote(command.to_string()),
        msg_id,
        now_ms(),
        DeviceEndpoint::Mobile,
        DeviceEndpoint::Desktop,
        serde_json::json!({ "command": command, "params": params }),
    );
    let text = serde_json::to_string(&envelope).unwrap();
    let _ = ws
        .send(tokio_tungstenite::tungstenite::Message::Text(text.into()))
        .await;
}

/// 解析信封帧（kind wire 名 + body）
pub(super) fn parse_frame(text: &str) -> (String, Value) {
    if text == "<closed>" || text == "<error>" {
        return (text.to_string(), Value::Null);
    }
    let envelope: DeviceEnvelope = serde_json::from_str(text).expect("帧必须为合法信封");
    (envelope.kind.as_str(), envelope.body)
}

/// 广播事件（模拟引擎 emit → FanOutEmitter 扇出；载荷为信封扁平
/// JSON，与桌面事件通道同构——事件字段需可被 AgentEvent 完整解析，
/// 否则 fanout 侧 fail-closed 跳过）
pub(super) fn publish(
    fanout: &FanOutEmitter,
    session_id: &str,
    event_type: &str,
    sequence: Option<u64>,
) {
    let mut payload = serde_json::json!({
        "type": event_type,
        "sessionId": session_id,
        "schemaVersion": 1,
        "runId": "r-test",
        "timestamp": "2026-01-01T00:00:00Z",
    });
    // run-terminal 的必填事件字段（RunTerminalStatus）
    if event_type == "run-terminal" {
        payload["terminal"] = serde_json::json!("completed");
    }
    if let Some(seq) = sequence {
        payload["sequence"] = serde_json::json!(seq);
    }
    fanout.emit("workbench-run-event", &payload.to_string());
}

/// 心跳往返：确认服务端已注册本连接（并让 drain 完成订阅）
pub(super) async fn confirm_registered(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) {
    send_envelope_text(
        ws,
        "heartbeat",
        serde_json::json!({ "ts": now_ms(), "deviceTimeMs": now_ms() }),
    )
    .await;
    let (kind, _) = parse_frame(&next_text(ws).await.expect("必须收到 heartbeat.ok"));
    assert_eq!(kind, "heartbeat.ok");
}
