//! 本地服务化网关（多端互通 D2 / R1-02：进程内嵌 axum HTTP + WS 服务骨架）
//!
//! 桌面 Hub 对外服务：随应用启动恒以 loopback 监听 `127.0.0.1:8765`
//! （8765 占用时顺序探测 8766..8775）；配对模式（R1-07）显式重绑
//! `0.0.0.0:8765`。与 Tauri 主循环共存于 `tauri::async_runtime`
//! （axum `serve` 由调用方 spawn，本模块不依赖 tauri），退出钩子经
//! [ServerHandle::shutdown] 触发优雅关停（D2 §5.3）。
//!
//! 模块职责（D2 §4.3）：
//! - [config]：服务配置（端口 / 绑定模式 / 令牌文件路径）；
//! - [auth]：令牌哈希存储（SHA-256 落 pairing.json）+ Bearer 校验中间件；
//! - [pair]：配对码生成 / TTL / 失败锁定（D3 §4.1 CXN-12 字符；
//!   完整配对流程 R1-07）；
//! - [backend]：与核心命令的桥接 trait（R1-03/04 的 CoreStateBackend
//!   直调既有 *_impl 契约体）；
//! - [router]：axum 路由注册（REST /v1/**；WS /v1/events 留 R1-05）；
//! - [error]：服务错误 → DeviceErrorCode / HTTP 状态映射；
//! - [ws]：WS 事件端点占位（R1-05 实现）；
//! - [fanout]：事件扇出（FanOutEmitter + WsBroadcast，R1-01）；
//! - [gateway]：帧网关（帧大小 1 MiB / 读超时 10s 纯判定，R1-10）；
//! - [limiter]：连接限流器（每设备 2 / 总量 8 状态机 + 审计计数，R1-10）。
//!
//! 可测试性架构（D2 §4.3）：本模块除 conex-types 外仅 fanout 引用
//! `crate::core_event_bridge`（实现其 Emitter trait——D2 §11-A 融合点 A
//! 的既定例外，其余模块零 crate:: 内部引用；router 测试经 tower
//! oneshot 驱动（无 Tauri 环境）。

pub mod auth;
pub mod backend;
pub mod config;
pub mod core_backend;
pub mod error;
pub mod fanout;
pub mod gateway;
pub mod limiter;
pub mod pair;
pub mod pairing;
pub mod router;
pub mod ws;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::Router;
use conex_types::device::{ALL_CAPABILITIES, MIN_PROTOCOL_VERSION, PROTOCOL_VERSION};
use serde::Serialize;
use tokio::sync::watch;

pub use config::{BindMode, ServerConfig};
pub use error::ServerError;

/// 服务自报信息（GET /v1/info；D2 §5.1 形状：port / bindMode /
/// pairingActive / version / protocolVersion + 能力位）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    /// 服务标识（固定字面量）
    pub service: String,
    /// 桌面应用版本（semver；Cargo 包版本）
    pub version: String,
    /// 跨端协议主版本（conex-types 常量）
    pub protocol_version: u32,
    /// 兼容下限（低于此版本需升级）
    pub min_protocol_version: u32,
    /// 实际生效端口（8765 占用时探测兜底后的真实值）
    pub port: u16,
    /// 绑定模式（loopback = 默认 / lan = 配对模式开放 0.0.0.0）
    pub bind_mode: BindMode,
    /// 配对模式是否开启
    pub pairing_active: bool,
    /// 服务时钟（epoch ms；时钟校准）
    pub server_time_ms: u64,
    /// 能力位（17 位全表 + 当前支持状态；wire 名与
    /// device-protocol.json 能力位一致）
    pub capabilities: HashMap<String, bool>,
}

/// 服务能力位（/v1/info 与后续 hello.ok 共用）
///
/// 骨架默认 = R1 服务面预期支持集（taskList / runControl / eventReplay /
/// approval / settings / presence / streams：REST T1 + WS 事件面）；
/// R1-03/04/05 接线后按实际暴露面收敛，其余位随 R2 命令批接线翻转
/// （fail-closed：缺省 false）。
pub fn service_capabilities() -> HashMap<String, bool> {
    const SUPPORTED: [&str; 7] = [
        "taskList",
        "runControl",
        "eventReplay",
        "approval",
        "settings",
        "presence",
        "streams",
    ];
    ALL_CAPABILITIES
        .iter()
        .map(|cap| {
            let wire = serde_json::to_string(cap)
                .unwrap_or_default()
                .trim_matches('"')
                .to_string();
            let supported = SUPPORTED.contains(&wire.as_str());
            (wire, supported)
        })
        .collect()
}

/// 服务句柄（可克隆；主循环持有用于退出钩子优雅关停）
#[derive(Clone)]
pub struct ServerHandle {
    config: ServerConfig,
    actual_addr: SocketAddr,
    shutdown_tx: watch::Sender<bool>,
}

impl ServerHandle {
    /// 新建句柄（[ServerInstance::bind] 内部调用；测试可直构）
    pub fn new(config: ServerConfig, actual_addr: SocketAddr) -> Self {
        let (shutdown_tx, _) = watch::channel(false);
        Self {
            config,
            actual_addr,
            shutdown_tx,
        }
    }

    /// 生效配置
    // R1-02 备注：R1-07 配对 GUI 命令 / server.json 持久化消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn config(&self) -> &ServerConfig {
        &self.config
    }

    /// 实际监听地址（含探测兜底后的真实端口）
    pub fn addr(&self) -> SocketAddr {
        self.actual_addr
    }

    /// 触发优雅关停（幂等）：停止接受新连接 → serve future 收尾返回
    /// （D2 §5.3；WS 侧「server-closing」广播与 2s 上限 R1-05/R1-09）
    pub fn shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
    }

    /// 关停信号接收端（serve 内部消费）
    pub fn shutdown_rx(&self) -> watch::Receiver<bool> {
        self.shutdown_tx.subscribe()
    }
}

/// 绑定后的服务实例（持有监听器；serve 消耗自身完成生命周期）
pub struct ServerInstance {
    handle: ServerHandle,
    listener: tokio::net::TcpListener,
}

impl ServerInstance {
    /// 绑定监听（D2 §5.1：8765 占用时顺序探测 8766..8775，全部失败返回
    /// 错误——调用方按「服务不启动不阻断应用」降级记录诊断；port=0 表示
    /// 系统分配临时端口（测试用））。需在 tokio runtime 上下文调用
    /// （生产 = tauri::async_runtime spawn 内，D2 §5.2 装配形态）。
    pub async fn bind(config: ServerConfig) -> Result<Self, ServerError> {
        let mut last_error: Option<std::io::Error> = None;
        for port in config.probe_ports() {
            let addr = config.bind_addr_for_port(port);
            match tokio::net::TcpListener::bind(addr).await {
                Ok(listener) => {
                    let actual_addr = listener
                        .local_addr()
                        .map_err(|e| ServerError::io(format!("读取实际地址失败：{e}")))?;
                    return Ok(Self {
                        handle: ServerHandle::new(config, actual_addr),
                        listener,
                    });
                }
                Err(error) => {
                    last_error = Some(error);
                    tracing::warn!(target: "server", port, "端口被占用，探测下一个");
                }
            }
        }
        Err(ServerError::io(format!(
            "端口 {}-{} 均不可绑定：{}",
            config.port,
            config.port.saturating_add(config::PORT_PROBE_COUNT - 1),
            last_error
                .as_ref()
                .map(|e| e.to_string())
                .unwrap_or_default()
        )))
    }

    /// 服务句柄（退出钩子优雅关停 + 元信息）
    pub fn handle(&self) -> &ServerHandle {
        &self.handle
    }

    /// 实际监听地址（端口为探测兜底后的生效值）
    pub fn addr(&self) -> SocketAddr {
        self.handle.addr()
    }

    /// 构建 axum Router（令牌库从 pairing.json 加载；backend 由 R1-03 的
    /// CoreStateBackend 注入，骨架期传 None；fanout 为 R1-01 事件扇出源
    /// （None = 未装配，WS 广播推送不可用，订阅/续传/心跳仍可用）——
    /// 生产装配（main.rs）注入真实后端与扇出器）
    pub fn router(
        &self,
        backend: Option<Arc<dyn backend::ApiBackend>>,
        fanout: Option<Arc<fanout::FanOutEmitter>>,
    ) -> Router {
        let tokens = auth::TokenStore::load(&self.handle.config.pairing_file_path);
        let mut state = ServerState::new(&self.handle, tokens, backend);
        state.set_event_stream(fanout);
        router::build_router(state)
    }

    /// 启动服务（axum serve + 优雅关停；由调用方 spawn 进
    /// tauri::async_runtime——本模块不依赖 tauri）。返回 = 服务退出
    /// （正常关停或 IO 错误）。
    pub async fn serve(self, router: Router) -> Result<(), ServerError> {
        let listener = self.listener;
        let mut shutdown_rx = self.handle.shutdown_rx();
        // 信号已先行置位（shutdown 早于 serve 启动）→ 直接结束
        if *shutdown_rx.borrow() {
            return Ok(());
        }
        let shutdown = async move {
            // watch 通道收到 true（[ServerHandle::shutdown]）或发送端全
            // drop（handle 被释放）→ 停止接受新连接，等待既有请求收尾
            let _ = shutdown_rx.changed().await;
        };
        axum::serve(listener, router)
            .with_graceful_shutdown(shutdown)
            .await
            .map_err(|e| ServerError::io(format!("axum serve 退出：{e}")))
    }
}

/// axum 路由共享状态（D2 §4.2「ServerState」：端口 / 绑定 / 令牌表 /
/// 后端句柄 / WS 连接注册表 / 事件流源；服务状态自持，不进 app.manage——
/// main.rs 仅注入 [ServerHandle] 供退出钩子关停）
#[derive(Clone)]
pub struct ServerState {
    config: ServerConfig,
    actual_addr: SocketAddr,
    tokens: Arc<Mutex<auth::TokenStore>>,
    // R1-02 备注：R1-03 CoreStateBackend 注入——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    backend: Option<Arc<dyn backend::ApiBackend>>,
    /// WS 连接注册表（R1-05：连接上限 / 踢出 / 订阅管理，D2 §10.5）
    ws_registry: Arc<ws::WsRegistry>,
    /// 连接限流器（R1-10：D5 §7.2 每设备 2 / 总量 8 并发上限状态机 +
    /// 审计计数；装配就绪，register 接线待 P0-3 裁决）
    conn_limiter: Arc<limiter::ConnectionLimiter>,
    /// 事件扇出源（R1-01 FanOutEmitter；未装配 = 广播 drain 不启动，
    /// 订阅/续传/心跳仍可用）
    event_stream: Option<Arc<fanout::FanOutEmitter>>,
    started_at_ms: u64,
}

impl ServerState {
    /// 新建路由状态（由 handle 派生元信息 + 令牌库 + 命令后端）
    pub fn new(
        handle: &ServerHandle,
        tokens: auth::TokenStore,
        backend: Option<Arc<dyn backend::ApiBackend>>,
    ) -> Self {
        Self {
            config: handle.config.clone(),
            actual_addr: handle.actual_addr,
            tokens: Arc::new(Mutex::new(tokens)),
            backend,
            ws_registry: Arc::new(ws::WsRegistry::new()),
            conn_limiter: Arc::new(limiter::ConnectionLimiter::new()),
            event_stream: None,
            started_at_ms: now_ms(),
        }
    }

    /// 服务自报信息（/v1/info 载荷）
    pub fn server_info(&self) -> ServerInfo {
        ServerInfo {
            service: "crish-agent-workbench".to_string(),
            version: option_env!("CARGO_PKG_VERSION").unwrap_or("0.0.0").to_string(),
            protocol_version: PROTOCOL_VERSION,
            min_protocol_version: MIN_PROTOCOL_VERSION,
            port: self.actual_addr.port(),
            bind_mode: self.config.bind_mode,
            pairing_active: self.config.pairing_enabled,
            server_time_ms: now_ms(),
            capabilities: service_capabilities(),
        }
    }

    /// 令牌库（鉴权中间件消费）
    pub fn tokens(&self) -> Arc<Mutex<auth::TokenStore>> {
        Arc::clone(&self.tokens)
    }

    /// 命令后端（R1-03 注入 CoreStateBackend；None = 尚未接线）
    // R1-02 备注：R1-03 handler 委托消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn backend(&self) -> Option<Arc<dyn backend::ApiBackend>> {
        self.backend.clone()
    }

    /// WS 连接注册表（R1-05：连接上限 / 踢出 / 订阅管理；R1-07 撤销全链
    /// 经 [ws::WsRegistry::kick_by_token_hash] 消费）
    pub fn ws_registry(&self) -> Arc<ws::WsRegistry> {
        Arc::clone(&self.ws_registry)
    }

    /// 连接限流器（R1-10：D5 §7.2 每设备 2 / 总量 8 并发上限；装配就绪，
    /// 连接建立/注销路径接线待主 Agent 裁决（P0-3 踢旧 vs 每设备 2），
    /// 测试直接消费）
    // R1-10 备注：register 接线待裁决——dead_code 静音（测试构建保持检查）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn conn_limiter(&self) -> Arc<limiter::ConnectionLimiter> {
        Arc::clone(&self.conn_limiter)
    }

    /// 事件扇出源（R1-01 FanOutEmitter；None = 未装配，WS 广播推送不可用）
    pub fn fanout(&self) -> Option<Arc<fanout::FanOutEmitter>> {
        self.event_stream.clone()
    }

    /// 注入事件扇出源（R1-01 装配点：main.rs 构造 FanOutEmitter 后注入；
    /// 测试注入空发射器）
    // R1-01 备注：main.rs 装配消费——dead_code 静音（测试构建保持检查）
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn set_event_stream(&mut self, stream: Option<Arc<fanout::FanOutEmitter>>) {
        self.event_stream = stream;
    }

    /// 服务启动时刻（epoch ms；R1-03 /v1/status 消费）
    // R1-02 备注：R1-03 状态面消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn started_at_ms(&self) -> u64 {
        self.started_at_ms
    }
}

/// 当前 UTC 毫秒时间戳（epoch ms）
pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener as StdTcpListener;

    /// 测试配置（临时目录令牌路径 + 指定端口；port=0 = 系统分配）
    fn temp_config(port: u16) -> ServerConfig {
        let mut config = ServerConfig::new(std::env::temp_dir());
        config.port = port;
        config
    }

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
        // 先占住默认端口 8765 → 探测兜底应落到 8766
        let occupied = StdTcpListener::bind("127.0.0.1:8765").expect("占用 8765 用于测试");
        let instance = ServerInstance::bind(temp_config(config::DEFAULT_PORT))
            .await
            .expect("探测兜底必须成功");
        assert_eq!(
            instance.addr().port(),
            config::DEFAULT_PORT + 1,
            "8765 被占用时应回退到 8766"
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
        let instance = ServerInstance::bind(temp_config(0)).await.expect("绑定失败");
        let addr = instance.addr();
        let handle = instance.handle().clone();
        let router = instance.router(None, None);
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

    impl crate::core_event_bridge::Emitter for RecordingEmitter {
        fn emit(&self, channel: &str, payload: &str) {
            self.calls
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push((channel.to_string(), payload.to_string()));
        }
    }

    /// 装配级测试最小真实面（G-1）：CoreRunState（内存库 + 临时快照 +
    /// 记录桥 + 独立诊断）→ CoreStateBackend 注入 ApiBackend 槽
    fn assembled_backend() -> (Arc<dyn backend::ApiBackend>, Arc<RecordingEmitter>) {
        static ASM_TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = ASM_TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let db = conex_db::LocalDb::open_in_memory().expect("内存库必须可打开");
        let store: Arc<dyn orchestrator::persist::Store> =
            Arc::new(orchestrator::persist::LocalDbStore::new(db));
        let snapshots: Arc<dyn orchestrator::restore::SnapshotStore> = Arc::new(
            orchestrator::restore::SnapshotFileStore::new(std::env::temp_dir().join(format!(
                "server-asm-{}-{seq}-snapshot.json",
                std::process::id()
            ))),
        );
        let webview = Arc::new(RecordingEmitter::default());
        let bridge = crate::core_event_bridge::EventBridge::new(
            "workbench-run-event",
            Arc::clone(&webview) as Arc<dyn crate::core_event_bridge::Emitter>,
        );
        let core = Arc::new(crate::core_run_commands::CoreRunState::new(
            store,
            snapshots,
            bridge,
            Arc::new(crate::status_diagnostics::StatusDiagnostics::new()),
            None,
        ));
        // 生产装配形态（main.rs）：真实 CoreStateBackend（只读面就绪标记
        // 按当前事实注入；此处压缩能力视为已接线）
        let backend: Arc<dyn backend::ApiBackend> = Arc::new(
            crate::server::core_backend::CoreStateBackend::new(core).with_compaction_ready(true),
        );
        (backend, webview)
    }

    /// WS 订阅 + 扇出 → events.push（实时推送链路最小闭环：订阅注册 →
    /// fanout 发布 → drain 推送）。返回推送帧 body。
    async fn subscribe_and_receive_push(
        addr: SocketAddr,
        token: &str,
        fanout: &fanout::FanOutEmitter,
    ) -> serde_json::Value {
        use crate::core_event_bridge::Emitter;
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
            let text = tokio::time::timeout(
                std::time::Duration::from_secs(3),
                ws.next(),
            )
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
        let router = instance.router(Some(backend), Some(Arc::clone(&fanout)));
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
        assert_ne!(push["preview"].as_bool(), Some(true), "带 sequence 的帧不得为 preview");

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
        let instance = ServerInstance::bind(temp_config(0)).await.expect("绑定失败");
        let addr = instance.addr();
        let handle = instance.handle().clone();
        let router = instance.router(None, Some(fanout));
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
}
