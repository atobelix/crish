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
//! - [fanout]：事件扇出（FanOutEmitter + WsBroadcast，R1-01）。
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
    /// CoreStateBackend 注入，骨架期传 None）
    pub fn router(&self, backend: Option<Arc<dyn backend::ApiBackend>>) -> Router {
        let tokens = auth::TokenStore::load(&self.handle.config.pairing_file_path);
        let state = ServerState::new(&self.handle, tokens, backend);
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
        let router = instance.router(None);
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
}
