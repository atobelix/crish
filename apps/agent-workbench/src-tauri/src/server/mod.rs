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
//! - [limiter]：连接限流器（每设备 2 / 总量 8 状态机 + 审计计数，R1-10）；
//! - **TLS 装配**（R1-11 wss 接线）：`tls_enabled=true` 时监听仅提供
//!   wss——证书材料来自 multi_device/tls.rs（自签 CA + 指纹固定），明文
//!   ws:// 握手在 TLS 层拒绝（D5 D-02a / T-04；accept 层见 [TlsListener]）。
//!
//! 可测试性架构（D2 §4.3）：本模块除 conex-types 外仅 fanout 引用
//! `conex_run::core_event_bridge`（实现其 Emitter trait——D2 §11-A 融合点 A
//! 的既定例外，其余模块零 crate:: 内部引用；router 测试经 tower
//! oneshot 驱动（无 Tauri 环境）。

pub mod auth;
pub mod backend;
pub mod config;
pub mod error;
pub mod fanout;
pub mod gateway;
pub mod limiter;
pub mod pair;
pub mod pair_endpoint;
pub mod pairing;
pub mod remote_whitelist;
pub mod router;
mod tls_listener;
pub mod ws;

use tls_listener::TlsListener;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::serve::ListenerExt;
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
    /// TLS acceptor（`tls_enabled=true` 时装配；None = 明文监听）。
    /// 装配于 bind（fail-closed：材料加载/装配失败 → bind 报错，绝不
    /// 以明文降级启动，D5 D-02a「服务端只提供 wss」）。
    tls_acceptor: Option<tokio_rustls::TlsAcceptor>,
}

impl ServerInstance {
    /// 绑定监听（D2 §5.1：8765 占用时顺序探测 8766..8775，全部失败返回
    /// 错误——调用方按「服务不启动不阻断应用」降级记录诊断；port=0 表示
    /// 系统分配临时端口（测试用））。需在 tokio runtime 上下文调用
    /// （生产 = tauri::async_runtime spawn 内，D2 §5.2 装配形态）。
    ///
    /// TLS 语义（R1-11 wss 接线）：`config.tls_enabled=true` 时先加载/
    /// 生成证书材料（首次启动生成自签 CA + 叶子，multi_device/tls.rs 的
    /// TLS-01~10 语义）并装配 acceptor——材料失败即 bind 失败（fail-closed，
    /// 无明文降级）；false 时保持既有明文行为（既有测试与 loopback 联调
    /// 面，D2 L4-1/L2 口径）。
    pub async fn bind(config: ServerConfig) -> Result<Self, ServerError> {
        // 证书目录显式注入（测试隔离）优先，否则默认 config_dir()/multi-device/
        let tls_acceptor = if config.tls_enabled {
            let cert_dir = config
                .tls_cert_dir
                .clone()
                .unwrap_or_else(crate::multi_device::tls::cert_dir);
            let mut material = crate::multi_device::tls::load_or_generate_in(&cert_dir)
                .map_err(|e| ServerError::io(format!("TLS 证书材料加载/生成失败：{e}")))?;
            // 局域网模式：叶子 SAN 必须覆盖移动端实际连接的 IP（否则系统 TLS
            // 主机名校验必败）。CA 不变，指纹/既有配对不受影响。
            if !config.tls_extra_sans.is_empty() {
                let mut sans = crate::multi_device::tls::default_sans_strings();
                for san in &config.tls_extra_sans {
                    if !sans.iter().any(|existing| existing == san) {
                        sans.push(san.clone());
                    }
                }
                material
                    .reissue_leaf(&sans)
                    .map_err(|e| ServerError::io(format!("TLS 叶子证书 SAN 重签失败：{e}")))?;
            }
            Some(
                material
                    .tls_acceptor()
                    .map_err(|e| ServerError::io(format!("TLS acceptor 装配失败：{e}")))?,
            )
        } else {
            None
        };
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
                        tls_acceptor,
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
    /// （None = 未装配，WS 广播推送不可用，订阅/续传/心跳仍可用）；
    /// audit_bridge 为 R1-11 remote-* 审计事件发射通道（与引擎 run 上下
    /// 文同一 EventBridge 实例，main.rs 装配面经
    /// CoreStateBackend::event_bridge 注入；None = 未接线降级结构化日志）；
    /// pairing 为 R1-11 G-2 配对协调器（REST /v1/pair + WS pair 消息链消费，
    /// 命令面同一 Arc 实例；None = 配对入口 503 诚实降级）；
    /// ws_registry 为 P2-5 连接面共享注册表（装配面 ⑤b 与 push presence /
    /// 直投 / 配对协调器同一 Arc 实例——注入后路由层 WS 升级注册进入
    /// 共享注册表；None = 保持 ServerState 自建实例，兼容既有测试）
    /// ——生产装配（main.rs）注入真实后端与扇出器）
    pub fn router(
        &self,
        backend: Option<Arc<dyn backend::ApiBackend>>,
        fanout: Option<Arc<fanout::FanOutEmitter>>,
        audit_bridge: Option<conex_run::core_event_bridge::EventBridge>,
        pairing: Option<Arc<pairing::PairingCoordinator>>,
        ws_registry: Option<Arc<ws::WsRegistry>>,
    ) -> Router {
        let tokens = auth::TokenStore::load(&self.handle.config.pairing_file_path);
        let mut state = ServerState::new(&self.handle, tokens, backend);
        if let Some(registry) = ws_registry {
            state = state.with_ws_registry(registry);
        }
        state.set_event_stream(fanout);
        if let Some(bridge) = audit_bridge {
            state = state.with_audit_bridge(bridge);
        }
        if let Some(pairing) = pairing {
            state = state.with_pairing(pairing);
        }
        router::build_router(state)
    }

    /// 启动服务（axum serve + 优雅关停；由调用方 spawn 进
    /// tauri::async_runtime——本模块不依赖 tauri）。返回 = 服务退出
    /// （正常关停或 IO 错误）。
    ///
    /// TLS 语义（R1-11 wss 接线）：`tls_enabled=true` 时以 [TlsListener]
    /// 包装监听——每连接先做 TLS 握手，明文 ws:// 握手在 TLS 层拒绝
    /// （D5 §2.1 降级保护 / T-04，服务端不回应 ws:// 握手请求）；false
    /// 时保持既有明文 axum serve。
    pub async fn serve(self, router: Router) -> Result<(), ServerError> {
        let ServerInstance {
            handle,
            listener,
            tls_acceptor,
        } = self;
        let shutdown_rx = handle.shutdown_rx();
        // 信号已先行置位（shutdown 早于 serve 启动）→ 直接结束
        if *shutdown_rx.borrow() {
            return Ok(());
        }
        let result = match tls_acceptor {
            Some(acceptor) => {
                // no-op tap_io：仅借 axum 的
                // `Connected<IncomingStream<TapIo<L, F>>> for L::Addr` blanket
                // impl 获得 ConnectInfo 接线（自定义 Listener 无预置 impl，
                // 见 TlsListener 处说明）；tap 闭包为空操作，不改变 accept
                // 语义
                let listener = TlsListener::new(listener, acceptor).tap_io(|_| {});
                // R1 收口（/v1/pair 每源 IP 限速）：经
                // into_make_service_with_connect_info 注入客户端 SocketAddr
                //（pair_endpoint 的 ConnectInfo 提取依赖此接线——未注入时
                // ConnectInfo 提取即 500）
                axum::serve(
                    listener,
                    router.into_make_service_with_connect_info::<SocketAddr>(),
                )
                .with_graceful_shutdown(wait_for_shutdown(shutdown_rx))
                .await
            }
            None => {
                axum::serve(
                    listener,
                    router.into_make_service_with_connect_info::<SocketAddr>(),
                )
                .with_graceful_shutdown(wait_for_shutdown(shutdown_rx))
                .await
            }
        };
        result.map_err(|e| ServerError::io(format!("axum serve 退出：{e}")))
    }
}

/// 关停信号等待（serve 消费）：watch 通道收到 true（[ServerHandle::shutdown]）
/// 或发送端全部 drop（handle 被释放）→ 停止接受新连接，等待既有请求收尾。
async fn wait_for_shutdown(mut rx: watch::Receiver<bool>) {
    let _ = rx.changed().await;
}

/// TLS 包装监听器（axum Listener 适配，R1-11 wss 装配）
///
/// accept 语义（D5 §2.1 降级保护 / T-04 落点）：TCP accept 后先做 TLS
/// 握手——明文 ws:// 握手（无 ClientHello）或伪造证书客户端在**握手层**
/// 被拒绝：记录诊断（TLS-08 握手失败日志，审计通道的最小落地）后继续
/// 接受下一条连接，不终止 serve（垃圾连接不构成拒绝服务面）。
///
/// Connected / ConnectInfo 语义（R1 收口 /v1/pair 每源 IP 限速）：axum
// 客户端地址注入（R1 收口 /v1/pair 每源 IP 限速）说明：axum 0.8 的
// `into_make_service_with_connect_info::<SocketAddr>` 要求
// `SocketAddr: Connected<IncomingStream<'_, L>>`，但只对
// `tokio::net::TcpListener` 预置该实现——自定义 [TlsListener] 无法直接
// 满足（孤儿规则：本地类型被外部 `IncomingStream` 覆盖即不构成本地
// 实现）。axum 官方接线路 = 经 [axum::serve::ListenerExt::tap_io] 包装
// 为 `TapIo`（connect_info.rs 的 blanket impl
// `Connected<IncomingStream<TapIo<L, F>>> for L::Addr`）；serve 的 TLS
// 分支以 no-op tap 包装（见 [ServerInstance::serve]），源地址 = TLS
// accept 时从底层 `TcpListener::accept` 取得的客户端 SocketAddr
// （TLS 握手前后远端不变）。

/// axum 路由共享状态（D2 §4.2「ServerState」：端口 / 绑定 / 令牌表 /
/// 后端句柄 / WS 连接注册表 / 事件流源；服务状态自持，不进 app.manage——
/// main.rs 仅注入 [ServerHandle] 供退出钩子关停）
#[derive(Clone)]
pub struct ServerState {
    config: ServerConfig,
    actual_addr: SocketAddr,
    tokens: Arc<Mutex<auth::TokenStore>>,
    backend: Option<Arc<dyn backend::ApiBackend>>,
    /// WS 连接注册表（R1-05：连接上限 / 踢出 / 订阅管理，D2 §10.5）
    ws_registry: Arc<ws::WsRegistry>,
    /// 连接限流器（R1-10：D5 §7.2 每设备 2 / 总量 8 并发上限状态机 +
    /// 审计计数；D-1 裁决：生产并发面由 ws.rs 注册表踢旧承担，本限流器
    /// 为测试面 + R2 装配预留）
    _conn_limiter: Arc<limiter::ConnectionLimiter>,
    /// 配对请求限速器（R1 收口：POST /v1/pair 每源 IP 10 次/分钟，
    /// D2 §12.4 限速口径——AU4 问题 #1；pair_endpoint 消费）
    pair_limiter: Arc<limiter::PairRateLimiter>,
    /// 事件扇出源（R1-01 FanOutEmitter；未装配 = 广播 drain 不启动，
    /// 订阅/续传/心跳仍可用）
    event_stream: Option<Arc<fanout::FanOutEmitter>>,
    /// 远程审计事件桥（R1-11：remote-* 审计 SecurityAudit 事件发射通道；
    /// 与引擎 run 上下文同一 [conex_run::core_event_bridge::EventBridge] 实例
    /// ——main.rs 装配面经 CoreStateBackend::event_bridge 注入；None =
    /// 未接线，router 白名单拒绝分支降级为纯结构化日志）
    audit_bridge: Option<conex_run::core_event_bridge::EventBridge>,
    /// 配对协调器（R1-11 G-2：REST /v1/pair 与 WS pair.hello 消息链消费；
    /// 与命令面 / main.rs 装配共用同一 Arc 实例；None = 未装配，配对入口
    /// 返回 503 诚实降级）
    pairing: Option<Arc<pairing::PairingCoordinator>>,
    /// Nonce 幂等与重放守卫（GW-01 生产级装配）
    nonce_guard: Arc<auth::AdvancedNonceGuard>,
    /// 远程中继 loopback 桥密钥（None = /v1/relay-loopback 关闭）
    relay_loopback_secret: Option<String>,
    _started_at_ms: u64,
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
            _conn_limiter: Arc::new(limiter::ConnectionLimiter::new()),
            pair_limiter: Arc::new(limiter::PairRateLimiter::new()),
            event_stream: None,
            audit_bridge: None,
            pairing: None,
            nonce_guard: Arc::new(auth::AdvancedNonceGuard::new(
                auth::DEFAULT_NONCE_CAPACITY,
                auth::DEFAULT_CLOCK_SKEW_MS,
            )),
            relay_loopback_secret: handle.config.relay_loopback_secret.clone(),
            _started_at_ms: now_ms(),
        }
    }

    /// Nonce 幂等与重放守卫
    pub fn nonce_guard(&self) -> &Arc<auth::AdvancedNonceGuard> {
        &self.nonce_guard
    }

    /// 远程中继 loopback 桥密钥（None = 路由关闭）
    pub fn relay_loopback_secret(&self) -> Option<&str> {
        self.relay_loopback_secret.as_deref()
    }

    /// 注入远程审计事件桥（R1-11：remote-* 审计 SecurityAudit 事件发射
    /// 通道；main.rs 装配面调用）
    // R1-11 备注：main.rs 装配消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn with_audit_bridge(mut self, bridge: conex_run::core_event_bridge::EventBridge) -> Self {
        self.audit_bridge = Some(bridge);
        self
    }

    /// 远程审计事件桥（R1-11：router 白名单拒绝分支 remote-source-attempt
    /// 事件发射；None = 未接线，降级纯结构化日志）
    // R1-11 备注：router.rs fallback 消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn audit_bridge(&self) -> Option<conex_run::core_event_bridge::EventBridge> {
        self.audit_bridge.clone()
    }

    /// 注入配对协调器（R1-11 G-2：main.rs 装配面将命令面同一 Arc 实例
    /// 接入路由层——REST /v1/pair 与 WS pair 消息链共用协调器）
    pub fn with_pairing(mut self, pairing: Arc<pairing::PairingCoordinator>) -> Self {
        self.pairing = Some(pairing);
        self
    }

    /// 配对协调器（None = 未装配；配对入口 503 诚实降级）
    pub fn pairing(&self) -> Option<Arc<pairing::PairingCoordinator>> {
        self.pairing.clone()
    }

    /// 多端服务开关（D5 D-01 红线 1 的路由层镜像：false 时 REST /v1/pair
    /// 返回 503——服务未开启语义；生产装配面 enabled=false 时根本不 bind，
    /// 本检查兜住路由层测试与异常装配）
    pub fn multi_device_enabled(&self) -> bool {
        self.config.multi_device_enabled
    }

    /// 配对签发后重载令牌库（R1-11 G-2 收口点）：协调器与路由层各自持有
    /// TokenStore 实例（main.rs 装配的 coordinator store vs 本路由 store），
    /// complete_pairing 已把新令牌落盘 pairing.json——重载使新令牌立即可
    /// 用于 REST 鉴权与 WS 升级（R1-07 装配断裂：GUI 配对签发后手机连接
    /// 曾无法通过路由层校验）。仅配对成功这一低频事件调用；内存中
    /// last_seen 更新以文件为准重载（校验正确性不受影响）。
    pub fn reload_tokens(&self) {
        if let Ok(mut guard) = self.tokens.lock() {
            *guard = auth::TokenStore::load(&self.config.pairing_file_path);
        }
    }

    /// 服务自报信息（/v1/info 载荷）
    pub fn server_info(&self) -> ServerInfo {
        ServerInfo {
            service: "crish-agent-workbench".to_string(),
            version: option_env!("CARGO_PKG_VERSION")
                .unwrap_or("0.0.0")
                .to_string(),
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

    /// 注入外部 WS 连接注册表（P2-5 连接面共享接线：生产装配面将 ⑤b 共享
    /// 注册表——与 push presence / 直投 / 配对协调器同一 Arc 实例——接入
    /// 路由层；注入后路由层 WS 升级注册即进入共享注册表，presence 与撤销
    /// 踢链观察真实连接；未注入保持自建实例，兼容既有测试与独立装配）
    // R3 后续任务备注：main.rs 装配消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn with_ws_registry(mut self, registry: Arc<ws::WsRegistry>) -> Self {
        self.ws_registry = registry;
        self
    }

    /// 连接限流器（R1-10：D5 §7.2 每设备 2 / 总量 8 并发上限；D-1 裁决：
    /// 生产并发面由 ws.rs 注册表踢旧承担，本限流器为测试面 + R2 装配
    #[cfg(test)]
    pub fn conn_limiter(&self) -> Arc<limiter::ConnectionLimiter> {
        Arc::clone(&self._conn_limiter)
    }

    /// 配对请求限速器（R1 收口：POST /v1/pair 每源 IP 10 次/分钟，
    /// D2 §12.4；pair_endpoint 在服务开关检查后消费）
    pub fn pair_limiter(&self) -> Arc<limiter::PairRateLimiter> {
        Arc::clone(&self.pair_limiter)
    }

    /// 事件扇出源（R1-01 FanOutEmitter；None = 未装配，WS 广播推送不可用）
    pub fn fanout(&self) -> Option<Arc<fanout::FanOutEmitter>> {
        self.event_stream.clone()
    }

    /// 注入事件扇出源（R1-01 装配点：main.rs 构造 FanOutEmitter 后注入；
    /// 测试注入空发射器）
    pub fn set_event_stream(&mut self, stream: Option<Arc<fanout::FanOutEmitter>>) {
        self.event_stream = stream;
    }

    /// 服务启动时刻（epoch ms；R1-03 /v1/status 消费）
    #[cfg(test)]
    pub fn started_at_ms(&self) -> u64 {
        self._started_at_ms
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
mod tests;
