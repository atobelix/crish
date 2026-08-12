//! 服务端真实 WS 集成测试（R1-11 验收缺口 G-7；D2 §13.1 L2）
//!
//! 与 ws.rs 内部单测（bin 目标内联，可触私有 API）不同，本文件是
//! **外部集成测试**：仅消费 lib 公开 API（`crish_agent_workbench::server`），
//! 起真实服务（[ServerInstance::bind] + [router::build_router] + serve 监听
//! 系统分配临时端口）→ 真实 WS 客户端（tokio-tungstenite 0.29，dev-dep）
//! 经 TCP/HTTP 升级连入 → 断言协议契约。全链路（鉴权 / 订阅 / 重放 /
//! 续传 / 心跳 / 连接上限 / 踢出）走真实网络往返，不 mock 传输层。
//!
//! 契约类覆盖（D2 §13.1 L2 六项 + 红线 6）：
//! 1. 重放先实时后：resume 期间新事件排队，done 后按序到达；
//! 2. 断线续传：断连 → 重连 → events.resume{afterSequence} 从 last+1 起；
//! 3. Delta 丢帧：600 条 message-delta + 1 条 message-end → 连接级缓冲
//!    512（CONN_QUEUE_CAPACITY）→ message-end 必达、delta 不全达；
//! 4. 心跳：heartbeat.ok 回执；90s 半开踢出（tokio 虚拟时钟加速，
//!    对齐 ws.rs 内部测试 pause/advance 机制——超时常量私有，不改配置）；
//! 5. 连接上限：第 9 连接拒绝（conn.limit）；
//! 6. 踢出：撤销设备 → ≤1s 墙钟断开（红线 6）；撤销后重连 401；
//!    撤销全部 → 全部活动连接被踢。
//! 配对链路（任务要求）：真实走 REST POST /v1/pair（pair_endpoint.rs），
//! 配对码 → 令牌 → 令牌连 WS 订阅成功（端到端验证 G-2 装配面）。
//!
//! 命名约定：契约类用例统一 `integration_*` 前缀；断言网络语义的用例
//! 按「行为 + 契约」命名（如 integration_resume_after_disconnect_
//! continues_from_last_seq）。
//!
//! 运行：`cargo test -p crish-agent-workbench --test server_integration`
//! 全部用例默认执行（不 ignore；D2 §13.2「契约类断言不得 ignore」）。

#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use conex_types::device::{
    ApproveParams, ApproveResult, CancelRunParams, CancelRunResult, DenyParams, DeviceEnvelope,
    DeviceEndpoint, DeviceErrorCode, ErrorBody, EventPageParams, EventPageResult, EventsPush,
    HeartbeatOk, ListCommandsResult, ListSessionsParams, ListSessionsResult, MessageKind,
    ResumeDone, ResumePage, RunControlParams, RunControlResult, RunSnapshotParams,
    RunSnapshotResult, RunTaskParams, RunTaskResult,
};
use crish_agent_workbench::core_event_bridge::Emitter;
use crish_agent_workbench::server::backend::ApiBackend;
use crish_agent_workbench::server::pairing::PairingCoordinator;
use crish_agent_workbench::server::{
    auth, router, ServerConfig, ServerError, ServerHandle, ServerInstance, ServerState,
    fanout::FanOutEmitter,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};

/// 测试本地时钟（epoch ms；服务端 now_ms 为 crate 私有，测试自持同源
/// 实现——SystemTime 与墙钟一致，仅作信封 ts 占位）
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// 就绪探测等待（对齐 ws.rs 内部测试：/v1/info 免鉴权可达即服务就绪）。
/// 注意：用 yield 而非 sleep——paused（虚拟时钟）测试下 sleep 永不完成，
/// TCP IO 不随 pause 暂停，yield 轮询两种时钟下都可靠。
async fn wait_ready(addr: SocketAddr) {
    let url = format!("http://{addr}/v1/info");
    for _ in 0..200 {
        if reqwest::get(&url).await.is_ok() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("服务在 200 轮探测内未就绪：{url}");
}

// ── 内存事件后端（ApiBackend stub，模式对齐 ws.rs 内部测试 MemoryBackend）──

/// 内存事件后端：read_session_events 从内存表分页（游标语义与
/// conex-db query_events 同构：`sequence > after` 升序 + limit）——
/// 重放 / 续传用例的事件种子源；其余命令面返回未接线错误（本文件
/// 只测事件流契约，不测 REST 命令面——后者由 router.rs 单测覆盖）。
struct MemoryBackend {
    /// 会话 → (sequence, 扁平事件 JSON)
    events: Mutex<std::collections::HashMap<String, Vec<(u64, Value)>>>,
}

impl MemoryBackend {
    fn new() -> Self {
        Self {
            events: Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// 追加事件（sequence 递增）
    fn push(&self, session_id: &str, event_type: &str, sequence: u64) {
        let mut map = self.events.lock().unwrap();
        map.entry(session_id.to_string()).or_default().push((
            sequence,
            json!({
                "type": event_type,
                "sessionId": session_id,
                "sequence": sequence,
                "schemaVersion": 1,
                "runId": "r-integration",
            }),
        ));
    }

    /// 批量追加（连续 sequence）
    fn push_range(&self, session_id: &str, event_type: &str, from: u64, count: u64) {
        for seq in from..from + count {
            self.push(session_id, event_type, seq);
        }
    }
}

#[async_trait::async_trait]
impl ApiBackend for MemoryBackend {
    async fn get_status(&self) -> Result<serde_json::Value, ServerError> {
        Ok(json!({ "initialized": true }))
    }
    async fn run_task(&self, _p: RunTaskParams) -> Result<RunTaskResult, ServerError> {
        Err(ServerError::internal("测试后端不支持"))
    }
    async fn run_control(&self, _p: RunControlParams) -> Result<RunControlResult, ServerError> {
        Err(ServerError::internal("测试后端不支持"))
    }
    async fn cancel_run(&self, _p: CancelRunParams) -> Result<CancelRunResult, ServerError> {
        Err(ServerError::internal("测试后端不支持"))
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

// ── 测试服务装配（真实 bind + serve）──

/// 运行中的测试服务（真实监听 + 真实 WS 端点）
struct TestServer {
    addr: SocketAddr,
    handle: ServerHandle,
    /// 单设备便捷令牌（labels[0]）
    token: String,
    /// 全部签发令牌（与 labels 同序）
    tokens: Vec<String>,
    /// 事件扇出源（测试侧驱动广播：emit 即客户端 events.push）
    fanout: Arc<FanOutEmitter>,
    /// 配对协调器（REST /v1/pair 消费；撤销踢出链路与路由层共享
    /// WsRegistry——revoke 的 kick 才打得中真实连接）
    pairing: Option<Arc<PairingCoordinator>>,
    /// serve 任务（测试结束随 runtime 清理；serve 退出错误在此可见）
    _serve: tokio::task::JoinHandle<Result<(), ServerError>>,
}

/// 装配并启动真实服务：
/// - 临时目录配置（port=0 系统分配；multi_device_enabled=true——
///   POST /v1/pair 的 503 检查要求开启，D5 D-01 路由层镜像）；
/// - 预签发 N 个令牌（TokenStore::issue 自动落盘 pairing.json）；
/// - 注入后端 / 扇出 / 配对协调器（协调器与路由层共享 WsRegistry，
///   撤销踢出全链真实可达）；
/// - serve 监听真实端口，返回 harness。
async fn spawn_server(
    backend: Option<Arc<dyn ApiBackend>>,
    fanout: Option<Arc<FanOutEmitter>>,
    labels: &[&str],
    with_pairing: bool,
) -> TestServer {
    let dir = tempfile::tempdir().expect("临时目录必须可创建");
    let mut config = ServerConfig::new(dir.path());
    config.port = 0;
    config.multi_device_enabled = true;

    // 预签发令牌（先落盘 pairing.json，供下方 ServerState 从文件重载；
    // 协调器随后改用路由层共享 Arc，撤销即时性全链真实可测）
    let token_store = Arc::new(Mutex::new(auth::TokenStore::new(
        config.pairing_file_path.clone(),
    )));
    let mut issued = Vec::new();
    for label in labels {
        issued.push(
            token_store
                .lock()
                .unwrap()
                .issue(label, now_ms())
                .expect("签发必须成功"),
        );
    }

    let instance = ServerInstance::bind(config).await.expect("测试绑定失败");
    let addr = instance.addr();
    let handle = instance.handle().clone();
    let fanout = fanout.unwrap_or_else(|| Arc::new(FanOutEmitter::new(vec![])));

    // 手动装配 ServerState（非 instance.router()——需要把协调器的
    // WsRegistry 与路由层对齐，revoke 踢出才命中真实连接）。令牌库经
    // TokenStore::load 从 pairing.json 重载（预签发已落盘；与生产
    // router() 的加载语义同源）
    let mut state = ServerState::new(
        instance.handle(),
        auth::TokenStore::load(&instance.handle().config().pairing_file_path),
        backend,
    );
    state.set_event_stream(Some(Arc::clone(&fanout)));
    let registry = state.ws_registry();
    let pairing = if with_pairing {
        // 协调器与路由层共享同一 TokenStore Arc（state.tokens()）——
        // 撤销即时性全链真实：revoke 落共享库 → 路由层鉴权立即可见
        // revoked → 重连 401（与 main.rs 生产装配的「命令面与路由层
        // 同 Arc」口径一致，ServerState::reload_tokens 的再入在此共享
        // 下无副作用）
        let coordinator = Arc::new(PairingCoordinator::new(state.tokens(), registry));
        state = state.with_pairing(Arc::clone(&coordinator));
        Some(coordinator)
    } else {
        None
    };
    let router = router::build_router(state);
    let serve = tokio::spawn(async move { instance.serve(router).await });
    wait_ready(addr).await;

    TestServer {
        addr,
        handle,
        token: issued[0].clone(),
        tokens: issued,
        fanout,
        pairing,
        _serve: serve,
    }
}

// ── WS 客户端工具（tokio-tungstenite 真实连接）──

type WsStream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// 建立真实 WS 连接（query token 升级；升级失败即 panic）
async fn ws_connect(addr: SocketAddr, token: &str) -> WsStream {
    let url = format!("ws://{addr}/v1/events?token={token}");
    let (ws, _) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("WS 升级必须成功（101）");
    ws
}

/// 读下一帧文本（超时护栏；Close/错误折叠为标记串；控制帧跳过——
/// tungstenite 0.29 会把 Ping/Pong 控制帧传给应用层，服务端心跳 Ping
/// 到达时库已自动回 Pong，此处忽略不干扰业务帧读取）。
///
/// 注意：paused（虚拟时钟）测试下 timeout 退化为不触发——调用方须先
/// advance 确保帧已到达 socket 再读（对齐 ws.rs 内部测试同款纪律）。
async fn next_text(ws: &mut WsStream) -> Option<String> {
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

/// 发送信封帧（kind + body；msgId 测试生成）
async fn send_envelope(ws: &mut WsStream, kind: MessageKind, body: Value) {
    let envelope = DeviceEnvelope::unsigned(
        kind,
        format!("m-int-{}", now_ms()),
        now_ms(),
        DeviceEndpoint::Mobile,
        DeviceEndpoint::Desktop,
        body,
    );
    let text = serde_json::to_string(&envelope).expect("信封必须可序列化");
    ws.send(tokio_tungstenite::tungstenite::Message::Text(text.into()))
        .await
        .expect("帧发送必须成功");
}

/// 解析信封帧（kind wire 名 + body；标记串原样透出）
fn parse_frame(text: &str) -> (String, Value) {
    if text == "<closed>" || text == "<error>" {
        return (text.to_string(), Value::Null);
    }
    let envelope: DeviceEnvelope = serde_json::from_str(text).expect("帧必须为合法信封");
    (envelope.kind.as_str(), envelope.body)
}

/// 广播事件（模拟引擎 emit → FanOutEmitter 扇出；载荷为信封扁平 JSON，
/// 事件字段需可被 AgentEvent 完整解析，否则 fanout 侧 fail-closed 跳过）
fn publish(
    fanout: &FanOutEmitter,
    session_id: &str,
    event_type: &str,
    sequence: Option<u64>,
    extra: Option<Value>,
) {
    let mut payload = json!({
        "type": event_type,
        "sessionId": session_id,
        "schemaVersion": 1,
        "runId": "r-integration",
        "timestamp": "2026-01-01T00:00:00Z",
    });
    if let Some(extra) = extra {
        if let Some(map) = extra.as_object() {
            for (key, value) in map {
                payload[key] = value.clone();
            }
        }
    }
    if let Some(seq) = sequence {
        payload["sequence"] = json!(seq);
    }
    fanout.emit("workbench-run-event", &payload.to_string());
}

/// 订阅 + 等待回执（sessions + 逐会话断线游标）
async fn subscribe(
    ws: &mut WsStream,
    sessions: &[(&str, u64)],
) -> (String, Value) {
    let last_sequences = serde_json::Map::from_iter(
        sessions
            .iter()
            .map(|(sid, seq)| (sid.to_string(), json!(seq))),
    );
    send_envelope(
        ws,
        MessageKind::EventsSubscribe,
        json!({ "sessions": sessions.iter().map(|(sid, _)| sid).collect::<Vec<_>>(), "lastSequences": last_sequences }),
    )
    .await;
    let text = next_text(ws).await.expect("订阅回执必须到达");
    let (kind, body) = parse_frame(&text);
    assert_eq!(
        kind,
        "events.subscribe.ok",
        "订阅回执：{text}"
    );
    (kind, body)
}

/// 心跳往返（确认服务端已注册本连接——所有用例的注册完成屏障）
async fn confirm_registered(ws: &mut WsStream) {
    send_envelope(ws, MessageKind::Heartbeat, json!({ "ts": now_ms(), "deviceTimeMs": now_ms() })).await;
    let text = next_text(ws).await.expect("必须收到 heartbeat.ok");
    let (kind, _) = parse_frame(&text);
    assert_eq!(kind, "heartbeat.ok", "注册确认心跳回执：{text}");
}

// ── 契约类用例（D2 §13.1 L2 + 红线 6）──

/// 配对链路（任务要求）：REST POST /v1/pair 真实拿令牌 → 令牌连 WS
/// 订阅成功（G-2 装配面端到端：配对码 → 令牌 → 连接鉴权全链）。
/// 附加断言：配对码单次使用（二次使用 → 401 pair.used）。
#[tokio::test]
async fn integration_pair_over_rest_issues_usable_token() {
    let server = spawn_server(None, None, &["pre-seeded"], true).await;
    let coordinator = server.pairing.as_ref().expect("配对协调器必须装配");

    // 开启配对 → 拿配对码（CXN-XXXX-XXXX-XXXX）
    let start = coordinator
        .start_pairing(now_ms())
        .expect("开启配对必须成功");
    assert!(start.code.starts_with("CXN-"), "配对码格式：{}", start.code);

    // REST 配对：{code, label} → 200 {token}（令牌仅此一次明文返回）
    let client = reqwest::Client::new();
    let response = client
        .post(format!("http://{}/v1/pair", server.addr))
        .json(&json!({ "code": start.code, "label": "phone-1" }))
        .send()
        .await
        .expect("POST /v1/pair 必须可达");
    assert_eq!(response.status(), 200, "配对成功应 200");
    let body: Value = response.json().await.expect("响应必须为 JSON");
    let token = body["token"].as_str().expect("配对响应必须携带明文令牌");
    assert_eq!(token.len(), 64, "令牌必须为 64 hex（D3 §5.1 token 形态）");

    // 新令牌连 WS：升级成功 + 心跳往返（令牌已可鉴权）
    let mut ws = ws_connect(server.addr, token).await;
    confirm_registered(&mut ws).await;

    // 配对码单次使用：二次提交同一码 → 401（pair.used）
    let again = client
        .post(format!("http://{}/v1/pair", server.addr))
        .json(&json!({ "code": start.code, "label": "phone-2" }))
        .send()
        .await
        .expect("二次配对请求必须可达");
    assert_eq!(again.status(), 401, "配对码二次使用必须拒绝（pair.used）");
}

/// 订阅 → 广播 → events.push 实时送达（D2 §13.1 L2 用例 1：载荷与
/// EventBridge 输出同构——事件字段逐字节透传，sequence 不被裁剪）。
#[tokio::test]
async fn integration_subscribe_receives_broadcast_push() {
    let server = spawn_server(None, Some(Arc::new(FanOutEmitter::new(vec![]))), &["dev-1"], false)
        .await;
    let mut ws = ws_connect(server.addr, &server.token).await;
    confirm_registered(&mut ws).await;
    subscribe(&mut ws, &[("s-1", 0)]).await;

    // 引擎事件 → 扇出（与生产同源：EventBridge 汇聚点挂接 FanOutEmitter）
    publish(&server.fanout, "s-1", "agent-start", Some(7), None);

    let text = next_text(&mut ws).await.expect("推送帧必须到达");
    let (kind, body) = parse_frame(&text);
    assert_eq!(kind, "events.push", "扇出事件必须经 WS 推送：{text}");
    let push: EventsPush = serde_json::from_value(body).expect("push 载荷必须为合法 EventsPush");
    assert_eq!(push.session_id, "s-1");
    assert_eq!(push.event["type"], "agent-start");
    assert_eq!(push.event["sequence"], 7, "sequence 必须原样透传");
    assert!(!push.preview, "带 sequence 的帧不得标记 preview");
}

/// 重放先实时后（D2 §13.1 L2 用例 2 + Z0 §9.9 R1-05 出口锚点）：
/// resume 期间到达的实时事件入 pending，resume.done 之后才按序 flush——
/// 客户端看到的顺序必须是 重放页 → done → 实时事件。
#[tokio::test]
async fn integration_resume_defers_realtime_until_done() {
    let backend = Arc::new(MemoryBackend::new());
    backend.push_range("s-1", "message-end", 1, 300);
    let fanout = Arc::new(FanOutEmitter::new(vec![]));
    let server = spawn_server(
        Some(backend as Arc<dyn ApiBackend>),
        Some(Arc::clone(&fanout)),
        &["dev-1"],
        false,
    )
    .await;
    let mut ws = ws_connect(server.addr, &server.token).await;
    confirm_registered(&mut ws).await;
    subscribe(&mut ws, &[("s-1", 0)]).await;

    // 发起 resume（15 页分页，窗口足够大）
    send_envelope(
        &mut ws,
        MessageKind::EventsResume,
        json!({ "sessionId": "s-1", "afterSequence": 0, "maxEvents": 20 }),
    )
    .await;

    // 收到第 1 页 = 服务端已进入重放态（begin_replay）→ 广播实时帧必入
    // pending，不会混入重放页
    let (kind, _) = parse_frame(&next_text(&mut ws).await.expect("第 1 页必须到达"));
    assert_eq!(kind, "events.resume.page");
    publish(&server.fanout, "s-1", "agent-start", None, None);

    // 读完剩余 14 页
    for _ in 1..15 {
        let (kind, body) = parse_frame(&next_text(&mut ws).await.expect("重放页必须到达"));
        assert_eq!(kind, "events.resume.page");
        let page: ResumePage = serde_json::from_value(body).expect("分页载荷必须合法");
        assert_eq!(page.events.len(), 20);
    }

    // 收口：done 之后才收到 pending 的实时帧（先重放后实时）
    let (kind, body) = parse_frame(&next_text(&mut ws).await.expect("resume.done 必须到达"));
    assert_eq!(kind, "events.resume.done");
    let done: ResumeDone = serde_json::from_value(body).expect("done 载荷必须合法");
    assert_eq!(done.resumed_to, 300);

    let (kind, body) = parse_frame(&next_text(&mut ws).await.expect("pending 实时帧必须到达"));
    assert_eq!(kind, "events.push", "pending 实时帧必须在 done 之后按序 flush");
    let push: EventsPush = serde_json::from_value(body).expect("push 载荷必须合法");
    assert_eq!(push.event["type"], "agent-start");
}

/// 断线续传（D2 §13.1 L2 用例 3 + Z0 §9.9 R1-05 出口锚点，任务点名命名）：
/// 客户端断连（只同步到 seq 200）→ 重连订阅带断点游标 → resume 恰好从
/// lastSequence+1（=201）起逐页 → done。
#[tokio::test]
async fn integration_resume_after_disconnect_continues_from_last_seq() {
    let backend = Arc::new(MemoryBackend::new());
    backend.push_range("s-1", "message-end", 1, 300);
    let server = spawn_server(Some(backend as Arc<dyn ApiBackend>), None, &["dev-1"], false)
        .await;

    // 首次连接：全量重放 0..300（200/页 → 2 页）→ 记录已同步游标
    let mut ws1 = ws_connect(server.addr, &server.token).await;
    confirm_registered(&mut ws1).await;
    subscribe(&mut ws1, &[("s-1", 0)]).await;
    send_envelope(
        &mut ws1,
        MessageKind::EventsResume,
        json!({ "sessionId": "s-1", "afterSequence": 0, "maxEvents": 200 }),
    )
    .await;
    let (kind, body) = parse_frame(&next_text(&mut ws1).await.expect("第 1 页必须到达"));
    assert_eq!(kind, "events.resume.page");
    let page: ResumePage = serde_json::from_value(body).expect("分页载荷必须合法");
    assert_eq!(page.events.len(), 200);
    let (kind, body) = parse_frame(&next_text(&mut ws1).await.expect("第 2 页必须到达"));
    assert_eq!(kind, "events.resume.page");
    let page: ResumePage = serde_json::from_value(body).expect("分页载荷必须合法");
    assert_eq!(page.events.len(), 100);
    let (kind, body) = parse_frame(&next_text(&mut ws1).await.expect("done 必须到达"));
    assert_eq!(kind, "events.resume.done");
    let done: ResumeDone = serde_json::from_value(body).expect("done 载荷必须合法");
    assert_eq!(done.resumed_to, 300);

    // 模拟断线：客户端只同步到 seq 200 即断连（重放 250..300 途中掉线）
    let _ = ws1.close(None).await;

    // 重连：订阅携带断点游标（lastSequences {s-1: 200}）→ resume 从 201 起
    let mut ws2 = ws_connect(server.addr, &server.token).await;
    confirm_registered(&mut ws2).await;
    subscribe(&mut ws2, &[("s-1", 200)]).await;
    send_envelope(
        &mut ws2,
        MessageKind::EventsResume,
        json!({ "sessionId": "s-1", "afterSequence": 200, "maxEvents": 200 }),
    )
    .await;
    let (kind, body) = parse_frame(&next_text(&mut ws2).await.expect("续传第 1 页必须到达"));
    assert_eq!(kind, "events.resume.page");
    let page: ResumePage = serde_json::from_value(body).expect("分页载荷必须合法");
    assert_eq!(
        page.events[0]["sequence"],
        201,
        "断线续传必须从 lastSeq+1（201）起，不得重发已同步事件"
    );
    assert_eq!(page.events.len(), 100, "200..300 共 100 条");
    let (kind, body) = parse_frame(&next_text(&mut ws2).await.expect("续传 done 必须到达"));
    assert_eq!(kind, "events.resume.done");
    let done: ResumeDone = serde_json::from_value(body).expect("done 载荷必须合法");
    assert_eq!(done.resumed_to, 300);
}

/// Delta 丢帧 message-end 必达（D2 §13.1 L2 用例 4）：600 条
/// message-delta（Delta 级可丢）+ 1 条 message-end（Critical 级必达）→
/// 连接级缓冲（CONN_QUEUE_CAPACITY=512）满后丢 Delta 保 Critical——
/// 断言 message-end 到达且 delta 不全达（丢帧可观测）。
#[tokio::test]
async fn integration_delta_flood_keeps_message_end() {
    let server = spawn_server(None, Some(Arc::new(FanOutEmitter::new(vec![]))), &["dev-1"], false)
        .await;
    let mut ws = ws_connect(server.addr, &server.token).await;
    confirm_registered(&mut ws).await;
    subscribe(&mut ws, &[("s-1", 0)]).await;

    // 洪峰：600 条 delta + 收口 message-end（顺序 = 引擎真实发射顺序）
    for seq in 1..=600 {
        publish(
            &server.fanout,
            "s-1",
            "message-delta",
            Some(seq),
            Some(json!({
                "messageId": format!("m-{seq}"),
                "block": { "type": "text", "text": format!("delta-{seq}") },
            })),
        );
    }
    publish(
        &server.fanout,
        "s-1",
        "message-end",
        Some(601),
        Some(json!({
            "message": {
                "id": "m-end",
                "role": "assistant",
                "createdAt": "2026-01-01T00:00:00Z",
                "blocks": [{ "type": "text", "text": "end" }],
            },
        })),
    );

    // 读帧直到 message-end（上限 700 防悬挂；delta 可能被丢 → 提前到 end）
    let mut delta_count = 0u32;
    let mut saw_end = false;
    for _ in 0..700 {
        let text = next_text(&mut ws).await.expect("推送帧必须到达");
        if text == "<closed>" {
            break;
        }
        let (kind, body) = parse_frame(&text);
        assert_eq!(kind, "events.push", "洪峰下只应收到 events.push：{text}");
        let event_type = body["event"]["type"].as_str().unwrap_or_default();
        match event_type {
            "message-delta" => delta_count += 1,
            "message-end" => {
                saw_end = true;
                break;
            }
            _ => panic!("意外事件类型：{event_type}"),
        }
    }
    assert!(saw_end, "message-end 必达（Critical 永不丢）");
    assert!(
        delta_count < 600,
        "丢帧必须可观测：600 条 delta 只应送达 {delta_count} 条（缓冲 512）"
    );
}

/// 心跳回执（D2 §13.1 L2 用例 6）：客户端 heartbeat → heartbeat.ok
/// 携带服务端时钟（时钟校准载荷）。
#[tokio::test]
async fn integration_heartbeat_ok_replies_with_server_time() {
    let server = spawn_server(None, None, &["dev-1"], false).await;
    let mut ws = ws_connect(server.addr, &server.token).await;
    confirm_registered(&mut ws).await;
    send_envelope(
        &mut ws,
        MessageKind::Heartbeat,
        json!({ "ts": now_ms(), "deviceTimeMs": now_ms() }),
    )
    .await;
    let text = next_text(&mut ws).await.expect("心跳回执必须到达");
    let (kind, body) = parse_frame(&text);
    assert_eq!(kind, "heartbeat.ok");
    let ok: HeartbeatOk = serde_json::from_value(body).expect("回执载荷必须合法");
    assert!(ok.server_time > 0, "heartbeat.ok 必须携带桌面时钟");
}

/// 心跳半开踢出（D2 §10.2「3 × 心跳间隔」90s 无客户端帧 → 踢出）：
/// 用 tokio 虚拟时钟加速（pause + advance 91s——超时常量为私有，不改
/// 配置；对齐 ws.rs 内部测试同款机制）。建立后既不发送应用帧也不读取，
/// 模拟半开连接 → 服务端踢出并发送 heartbeat-timeout error 帧。
#[tokio::test]
async fn integration_heartbeat_timeout_kicks_half_open_connection() {
    tokio::time::pause();
    let server = spawn_server(None, None, &["dev-1"], false).await;
    let mut ws = ws_connect(server.addr, &server.token).await;
    // 推进 91s（3 个心跳周期）→ 第 3 个 tick 时超时判定触发
    tokio::time::advance(Duration::from_secs(91)).await;
    // 多轮让行：kick 经 watch → sender 发帧 → TCP 写出，链路多任务协作
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
    let text = next_text(&mut ws).await.expect("应收到踢出帧");
    let (kind, body) = parse_frame(&text);
    assert_eq!(kind, "error");
    let error: ErrorBody = serde_json::from_value(body).expect("错误载荷必须合法");
    assert!(
        error.message.contains("heartbeat-timeout"),
        "踢出原因必须携带 heartbeat-timeout：{}",
        error.message
    );
    // 踢出后连接关闭
    let closed = next_text(&mut ws).await;
    assert!(
        closed.as_deref() == Some("<closed>") || closed.as_deref() == Some("<error>"),
        "踢出后连接必须关闭：{closed:?}"
    );
}

/// 连接上限（D2 §10.5：MAX_WS_CONNECTIONS=8，超限拒绝新连接）：
/// 占满 8 个连接后第 9 个 → conn.limit 错误帧 + 关闭；旧连接不受影响。
#[tokio::test]
async fn integration_ninth_connection_rejected_with_conn_limit() {
    let labels: Vec<String> = (0..9).map(|i| format!("dev-{i}")).collect();
    let label_refs: Vec<&str> = labels.iter().map(String::as_str).collect();
    let server = spawn_server(None, None, &label_refs, false).await;

    // 占满 8 个连接（逐个心跳确认注册完成，避免升级回调未完成即建新连）
    let mut sockets = Vec::new();
    for token in &server.tokens[..8] {
        let mut ws = ws_connect(server.addr, token).await;
        confirm_registered(&mut ws).await;
        sockets.push(ws);
    }

    // 第 9 个连接 → 拒绝（conn.limit 错误帧 + 关闭）
    let mut ninth = ws_connect(server.addr, &server.tokens[8]).await;
    let text = next_text(&mut ninth).await.expect("应收到 conn.limit 拒绝帧");
    let (kind, body) = parse_frame(&text);
    assert_eq!(kind, "error");
    let error: ErrorBody = serde_json::from_value(body).expect("错误载荷必须合法");
    assert!(
        error.message.contains("conn.limit"),
        "拒绝原因必须携带 conn.limit：{}",
        error.message
    );

    // 旧连接不受影响（心跳往返仍通）
    confirm_registered(&mut sockets[0]).await;
}

/// 红线 6（≤1s 集成断言）：撤销设备 → 该设备活动连接 ≤1s 内断开。
/// 时延测量：墙钟 [std::time::Instant]——撤销调用（revoke_device：
/// 令牌失效 + 落盘 + 注册表踢出信号）到客户端收到踢出帧的墙钟差。
/// 全链走真实装配：协调器 ↔ 路由层共享 WsRegistry（revoke 的 kick 直接
/// 命中在线连接）与共享令牌库。
#[tokio::test]
async fn integration_revoke_device_kicks_within_1s_wall_clock() {
    let server = spawn_server(None, None, &["dev-1"], true).await;
    let coordinator = server.pairing.as_ref().expect("配对协调器必须装配");

    let mut ws = ws_connect(server.addr, &server.token).await;
    confirm_registered(&mut ws).await;

    // 墙钟测量起点：撤销调用（红线 6 的 t0 = 用户点撤销的时刻）
    let started = Instant::now();
    let hash = auth::sha256_hex(server.token.as_bytes());
    let revoked = coordinator.revoke_device(&hash);
    assert!(revoked, "撤销必须命中在线设备");

    // 客户端收到踢出帧（error token-revoked）——t1 = 断开信号到达
    let text = next_text(&mut ws).await.expect("撤销后必须收到踢出帧");
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(1),
        "红线 6：撤销到断开墙钟时延 {}ms，必须 ≤1s",
        elapsed.as_millis()
    );
    let (kind, body) = parse_frame(&text);
    assert_eq!(kind, "error", "踢出帧：{text}");
    let error: ErrorBody = serde_json::from_value(body).expect("错误载荷必须合法");
    assert_eq!(error.code, DeviceErrorCode::AuthDeviceRevoked);
    assert!(
        error.message.contains("token-revoked"),
        "踢出原因必须携带 token-revoked：{}",
        error.message
    );

    // 连接随后关闭（服务端踢出后 close）
    let closed = next_text(&mut ws).await;
    assert!(
        closed.as_deref() == Some("<closed>") || closed.as_deref() == Some("<error>"),
        "踢出后连接必须关闭：{closed:?}"
    );
}

/// 撤销后重连 → 401（T-11 集成级：撤销即时性——旧令牌永不再有效；
/// ws.rs 内部测试只覆盖 401 路径与注册表踢出，本用例把「撤销 → 在线
/// 断开 → 重连拒绝」三段全链走真实网络）。
#[tokio::test]
async fn integration_revoked_token_rejected_on_reconnect() {
    let server = spawn_server(None, None, &["dev-1"], true).await;
    let coordinator = server.pairing.as_ref().expect("配对协调器必须装配");

    // 撤销（连接建立与否不影响 401 面；为时序真实先建立并断开）
    let mut ws = ws_connect(server.addr, &server.token).await;
    confirm_registered(&mut ws).await;
    let hash = auth::sha256_hex(server.token.as_bytes());
    assert!(coordinator.revoke_device(&hash), "撤销必须命中");
    let _ = next_text(&mut ws).await; // 踢出帧
    let _ = ws.close(None).await;

    // 重连：升级阶段即 401（auth.device_revoked）
    let response = reqwest::get(format!("http://{}/v1/events?token={}", server.addr, server.token))
        .await
        .expect("升级请求必须可达");
    assert_eq!(
        response.status(),
        reqwest::StatusCode::UNAUTHORIZED,
        "已撤销令牌必须被升级拒绝"
    );
}

/// 撤销全部设备（revoke_all）→ 全部活动连接被踢（红线 6「断开全部活动
/// 连接」的多连接形态：每个在线设备都收到 token-revoked 且连接关闭）。
#[tokio::test]
async fn integration_revoke_all_kicks_every_active_connection() {
    let labels = ["dev-a", "dev-b"];
    let server = spawn_server(None, None, &labels, true).await;
    let coordinator = server.pairing.as_ref().expect("配对协调器必须装配");

    // 两台设备各自建立连接并确认注册
    let mut ws_a = ws_connect(server.addr, &server.tokens[0]).await;
    confirm_registered(&mut ws_a).await;
    let mut ws_b = ws_connect(server.addr, &server.tokens[1]).await;
    confirm_registered(&mut ws_b).await;

    // 撤销全部：令牌全失效 + 全部连接踢出
    coordinator.revoke_all();

    for (name, ws) in [("dev-a", &mut ws_a), ("dev-b", &mut ws_b)] {
        let text = next_text(ws).await.expect(&format!("{name} 必须收到踢出帧"));
        let (kind, body) = parse_frame(&text);
        assert_eq!(kind, "error", "{name} 踢出帧：{text}");
        let error: ErrorBody = serde_json::from_value(body).expect("错误载荷必须合法");
        assert!(
            error.message.contains("token-revoked"),
            "{name} 踢出原因必须携带 token-revoked：{}",
            error.message
        );
    }
}
