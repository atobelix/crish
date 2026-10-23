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
//! `crate::core_event_bridge`（实现其 Emitter trait——D2 §11-A 融合点 A
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
pub mod preview_headers;
pub mod preview_injector;
pub mod preview_proxy;
pub mod remote_whitelist;
pub mod router;
pub mod ws;

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
            let material = crate::multi_device::tls::load_or_generate_in(&cert_dir)
                .map_err(|e| ServerError::io(format!("TLS 证书材料加载/生成失败：{e}")))?;
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
        audit_bridge: Option<crate::core_event_bridge::EventBridge>,
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
/// 0.8 仅对 `tokio::net::TcpListener` 预置
/// `SocketAddr: Connected<IncomingStream<TcpListener>>`——自定义 Listener
/// 必须显式实现 [axum::extract::connect_info::Connected]（见下），否则
/// `into_make_service_with_connect_info::<SocketAddr>` 编译不通过；限速
/// 仅挂 REST /v1/pair，ws.rs 配对升级路径不受影响。
struct TlsListener {
    inner: tokio::net::TcpListener,
    acceptor: tokio_rustls::TlsAcceptor,
}

impl TlsListener {
    fn new(inner: tokio::net::TcpListener, acceptor: tokio_rustls::TlsAcceptor) -> Self {
        Self { inner, acceptor }
    }
}

impl axum::serve::Listener for TlsListener {
    type Io = tokio_rustls::server::TlsStream<tokio::net::TcpStream>;
    type Addr = SocketAddr;

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.inner.local_addr()
    }

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            let (stream, addr) = match self.inner.accept().await {
                Ok(accepted) => accepted,
                Err(error) => {
                    // TCP 层瞬态错误（连接重置等）：记录后继续接受
                    tracing::debug!(target: "server", %error, "accept 失败，继续监听");
                    continue;
                }
            };
            let acceptor = self.acceptor.clone();
            match acceptor.accept(stream).await {
                Ok(tls) => return (tls, addr),
                Err(error) => {
                    // T-04 语义落点：明文 ws/HTTP 请求或错误指纹客户端 →
                    // TLS 层拒绝（服务端不回应任何 ws:// 握手，D5 §2.1）；
                    // 拒绝不终止 serve，继续接受下一条连接
                    tracing::warn!(
                        target: "server",
                        %addr,
                        "TLS 握手失败（明文请求或证书不被信任）：{error}"
                    );
                }
            }
        }
    }
}

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
    /// 与引擎 run 上下文同一 [crate::core_event_bridge::EventBridge] 实例
    /// ——main.rs 装配面经 CoreStateBackend::event_bridge 注入；None =
    /// 未接线，router 白名单拒绝分支降级为纯结构化日志）
    audit_bridge: Option<crate::core_event_bridge::EventBridge>,
    /// 配对协调器（R1-11 G-2：REST /v1/pair 与 WS pair.hello 消息链消费；
    /// 与命令面 / main.rs 装配共用同一 Arc 实例；None = 未装配，配对入口
    /// 返回 503 诚实降级）
    pairing: Option<Arc<pairing::PairingCoordinator>>,
    /// Nonce 幂等与重放守卫（GW-01 生产级装配）
    nonce_guard: Arc<auth::AdvancedNonceGuard>,
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
            _started_at_ms: now_ms(),
        }
    }

    /// Nonce 幂等与重放守卫
    pub fn nonce_guard(&self) -> &Arc<auth::AdvancedNonceGuard> {
        &self.nonce_guard
    }

    /// 注入远程审计事件桥（R1-11：remote-* 审计 SecurityAudit 事件发射
    /// 通道；main.rs 装配面调用）
    // R1-11 备注：main.rs 装配消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn with_audit_bridge(mut self, bridge: crate::core_event_bridge::EventBridge) -> Self {
        self.audit_bridge = Some(bridge);
        self
    }

    /// 远程审计事件桥（R1-11：router 白名单拒绝分支 remote-source-attempt
    /// 事件发射；None = 未接线，降级纯结构化日志）
    // R1-11 备注：router.rs fallback 消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn audit_bridge(&self) -> Option<crate::core_event_bridge::EventBridge> {
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

    impl crate::core_event_bridge::Emitter for RecordingEmitter {
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

        async fn list_commands(
            &self,
        ) -> Result<conex_types::device::ListCommandsResult, ServerError> {
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

    // ── P2-5 连接面共享接线（with_ws_registry 注入：路由层注册表 =
    //    装配面共享注册表，push presence / 直投 / 撤销踢链观察真实连接）──

    /// 注入语义单元：注入后 ServerState 使用外部注册表（同一 Arc 实例），
    /// 未注入保持自建（与外部实例不同——兼容既有独立装配与测试）；可
    /// 反复注入（每次覆盖为新实例）。
    #[test]
    fn with_ws_registry_replaces_self_built_instance() {
        let handle = ServerHandle::new(temp_config(0), "127.0.0.1:0".parse().expect("固定地址"));
        let external = Arc::new(ws::WsRegistry::new());
        let state = ServerState::new(
            &handle,
            auth::TokenStore::new(temp_config(0).pairing_file_path),
            None,
        );
        assert!(
            !Arc::ptr_eq(&state.ws_registry(), &external),
            "未注入必须保持自建实例（与外部实例不同）"
        );
        let injected = state.with_ws_registry(Arc::clone(&external));
        assert!(
            Arc::ptr_eq(&injected.ws_registry(), &external),
            "注入后必须使用外部实例（连接面共享接线）"
        );
        let another = Arc::new(ws::WsRegistry::new());
        let reinjected = injected.with_ws_registry(Arc::clone(&another));
        assert!(
            Arc::ptr_eq(&reinjected.ws_registry(), &another),
            "反复注入必须覆盖为新实例"
        );
    }

    /// P2-5 构造测试（注入注册表 → 路由升级/注册 → 共享注册表查询到连接）：
    /// 注入外部注册表后，路由层 WS 连接注册进**共享**注册表（令牌哈希
    /// 主键 + 设备标签 + 已认证——撤销踢链可命中）；连接关闭后注销
    /// （断线清理经共享注册表一致生效）。
    #[tokio::test]
    async fn injected_shared_registry_sees_route_upgrade_connections() {
        // 外部共享注册表（模拟装配面 ⑤b：push presence / 配对协调器同实例）
        let shared = Arc::new(ws::WsRegistry::new());

        // 临时令牌库（pairing.json 预签发，鉴权面走真实 TokenStore 文件）
        let dir = tempfile::tempdir().expect("临时目录必须可创建");
        let mut config = ServerConfig::new(dir.path());
        config.port = 0;
        let token = {
            let mut store = auth::TokenStore::new(config.pairing_file_path.clone());
            store.issue("p2-5-device", now_ms()).expect("签发必须成功")
        };

        let instance = ServerInstance::bind(config).await.expect("绑定失败");
        let addr = instance.addr();
        let handle = instance.handle().clone();
        // 装配面注入共享注册表（router 第五参 = P2-5 接线点）
        let router = instance.router(None, None, None, None, Some(Arc::clone(&shared)));
        let task = tokio::spawn(async move { instance.serve(router).await });

        // 就绪轮询
        let info_url = format!("http://{addr}/v1/info");
        for _ in 0..50 {
            if reqwest::get(&info_url).await.is_ok() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }

        // 路由升级（真实 handle_socket 路径：鉴权 → 注册 → mark_authenticated）
        let ws_url = format!("ws://{addr}/v1/events?token={token}");
        let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .expect("WS 升级必须成功");

        // 共享注册表必须可见该连接（轮询等待注册——升级回执先于注册完成）
        let token_hash = auth::sha256_hex(token.as_bytes());
        let mut registered = false;
        for _ in 0..100 {
            let activities = shared.device_activities();
            if activities.len() == 1 && activities[0].0 == token_hash {
                registered = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(registered, "注入后路由连接必须注册进共享注册表");
        let activities = shared.device_activities();
        assert_eq!(activities.len(), 1);
        assert_eq!(activities[0].0, token_hash, "注册表主键 = 令牌哈希");
        assert_eq!(activities[0].1, "p2-5-device", "设备标签来自令牌库记录");
        let snapshot = shared.snapshot();
        assert_eq!(snapshot.len(), 1, "共享注册表快照必须含路由连接");
        assert!(
            shared.is_authenticated(snapshot[0].conn_id),
            "正常升级连接必须已认证（撤销踢链可命中）"
        );

        // 断线 → 注销（共享注册表清空；轮询等待 sender task 收尾）
        let _ = ws.close(None).await;
        for _ in 0..100 {
            if shared.count() == 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(shared.count(), 0, "断线清理必须经共享注册表一致生效");

        // 优雅关停
        handle.shutdown();
        let result = task.await.expect("serve 任务不应 panic");
        assert!(result.is_ok(), "serve 应正常退出：{result:?}");
    }

    // ── R1-11 wss 接线测试面（D5 D-02a / T-04 / T-03 装配面）──

    /// TLS 开启的服务测试装配：临时证书目录 + 预签发令牌。返回运行中的
    /// 服务句柄与客户端侧材料（CA DER / CA PEM / 明文令牌）。
    struct TlsTestHarness {
        handle: ServerHandle,
        addr: SocketAddr,
        token: String,
        ca_der: rustls::pki_types::CertificateDer<'static>,
        ca_pem: String,
        task: tokio::task::JoinHandle<Result<(), ServerError>>,
    }

    /// 装配并启动 wss-only 服务（tls_enabled=true + 临时证书目录 + 预签发
    /// 令牌；router 不经后端/扇出）。就绪探测 = TLS 握手成功（明文 http
    /// 探测在此模式不可用）。
    async fn spawn_tls_server() -> TlsTestHarness {
        let dir = tempfile::tempdir().expect("临时目录必须可创建");
        let cert_dir = dir.path().join("multi-device");
        let mut config = ServerConfig::new(dir.path());
        config.port = 0;
        config.tls_enabled = true;
        config.tls_cert_dir = Some(cert_dir.clone());
        // 预签发令牌（pairing.json 在 bind 前写入；router() 从文件加载）
        let token = {
            let mut store = auth::TokenStore::new(config.pairing_file_path.clone());
            store
                .issue("tls-test-device", now_ms())
                .expect("签发必须成功")
        };
        let instance = ServerInstance::bind(config)
            .await
            .expect("TLS 实例绑定必须成功");
        let addr = instance.addr();
        let handle = instance.handle().clone();
        let router = instance.router(None, None, None, None, None);
        let task = tokio::spawn(async move { instance.serve(router).await });
        // 读取 CA 材料（与实例同目录，bind 返回后文件锁已释放可重载；
        // reload_keeps_fingerprint 保证同一证书文件不被重写）
        let material =
            crate::multi_device::tls::load_or_generate_in(&cert_dir).expect("CA 材料必须可重载");
        let ca_der = material_ca_der(&material);
        let ca_pem = material.ca_cert_pem().expect("CA PEM 必须可读");
        // 就绪探测：TLS 握手成功即服务已进入 accept 循环
        let probe = tls_client_with_root(Some(&ca_der));
        for _ in 0..50 {
            if tls_probe_connect(addr, probe.clone()).await {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        TlsTestHarness {
            handle,
            addr,
            token,
            ca_der,
            ca_pem,
            task,
        }
    }

    /// TLS 客户端配置：信任锚 = 指定 CA 证书（None = 空根库，模拟未配对
    /// 设备无 pin 状态；移动端 pinning 模型 = 只信配对期拿到的 CA，D5
    /// §2.2 信任锚语义与默认链校验等价）。
    fn tls_client_with_root(
        ca: Option<&rustls::pki_types::CertificateDer<'static>>,
    ) -> rustls::ClientConfig {
        let mut roots = rustls::RootCertStore::empty();
        if let Some(ca) = ca {
            roots.add(ca.clone()).expect("CA 入根库");
        }
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("默认版本受 rustls 支持")
            .with_root_certificates(roots)
            .with_no_client_auth()
    }

    /// 从 TLS 材料取 CA 证书 DER（走公开的 `ca_cert_pem()` 读盘路径；
    /// `TlsMaterial` 字段私有，测试经公开面取证，与 tls.rs 内部测试同源）。
    fn material_ca_der(
        material: &crate::multi_device::tls::TlsMaterial,
    ) -> rustls::pki_types::CertificateDer<'static> {
        let pem = material.ca_cert_pem().expect("CA PEM 必须可读");
        let mut reader = std::io::BufReader::new(pem.as_bytes());
        let certs = rustls_pemfile::certs(&mut reader)
            .collect::<Result<Vec<_>, _>>()
            .expect("CA PEM 必须可解析");
        certs.into_iter().next().expect("CA PEM 必须含证书")
    }

    /// TLS 就绪探测：握手成功即 true（带 300ms 超时——serve 未进入
    /// accept 循环时 TCP 已可连但握手挂起）。
    async fn tls_probe_connect(addr: SocketAddr, client: rustls::ClientConfig) -> bool {
        let connector = tokio_rustls::TlsConnector::from(Arc::new(client));
        let stream = match tokio::net::TcpStream::connect(addr).await {
            Ok(stream) => stream,
            Err(_) => return false,
        };
        let name = rustls::pki_types::ServerName::try_from("crish-remote").expect("常量域名恒合法");
        tokio::time::timeout(
            std::time::Duration::from_millis(300),
            connector.connect(name, stream),
        )
        .await
        .map(|result| result.is_ok())
        .unwrap_or(false)
    }

    /// 手工 wss 升级请求：TLS 连接（指定客户端配置）→ 发送 HTTP
    /// `Upgrade: websocket` 请求 → 返回响应头文本与 TLS 流。TLS 握手
    /// 失败 / 未收到完整响应头 → Err（错误指纹 / 明文降级路径断言载体）。
    async fn wss_upgrade(
        addr: SocketAddr,
        client: rustls::ClientConfig,
        request_path: &str,
    ) -> Result<
        (
            String,
            tokio_rustls::client::TlsStream<tokio::net::TcpStream>,
        ),
        String,
    > {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let connector = tokio_rustls::TlsConnector::from(Arc::new(client));
        let stream = tokio::net::TcpStream::connect(addr)
            .await
            .map_err(|e| format!("TCP 连接失败：{e}"))?;
        let server_name =
            rustls::pki_types::ServerName::try_from("crish-remote").expect("常量域名恒合法");
        let mut tls = connector
            .connect(server_name, stream)
            .await
            .map_err(|e| format!("TLS 握手失败：{e}"))?;
        let request = format!(
            "GET {request_path} HTTP/1.1\r\nHost: crish-remote:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n", // gitleaks:allow
            port = addr.port()
        );
        tls.write_all(request.as_bytes())
            .await
            .map_err(|e| format!("写入升级请求失败：{e}"))?;
        tls.flush().await.map_err(|e| format!("flush 失败：{e}"))?;
        let mut buf = Vec::new();
        let mut byte = [0u8; 1];
        let mut header_end = false;
        for _ in 0..64 * 1024 {
            let n = tls
                .read(&mut byte)
                .await
                .map_err(|e| format!("读取响应失败：{e}"))?;
            if n == 0 {
                break;
            }
            buf.push(byte[0]);
            if buf.ends_with(b"\r\n\r\n") {
                header_end = true;
                break;
            }
        }
        let text = String::from_utf8_lossy(&buf).into_owned();
        if !header_end {
            return Err(format!("服务端未返回完整响应头（TLS 被拒？）：{text:?}"));
        }
        Ok((text, tls))
    }

    /// T-04 自动化（D5 §9.1 / R1-10 裁决 D-3）：wss-only 服务**不提供
    /// 明文 ws 端点**——明文 ws:// 握手请求（HTTP upgrade）在 TLS 层被
    /// 拒绝（无 101、无任何 HTTP 响应，D5 §2.1「服务端不回应 ws:// 握手
    /// 请求」）；且拒绝后服务继续存活（合法 wss 仍可连，拒绝不构成 DoS）。
    #[tokio::test]
    async fn tls_server_rejects_plaintext_ws_handshake() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let harness = spawn_tls_server().await;
        // 明文 ws 握手（HTTP upgrade 到 ws://；携带合法令牌也无效——请求
        // 根本到不了 HTTP 层）
        let mut stream = tokio::net::TcpStream::connect(harness.addr)
            .await
            .expect("TCP 必须可连");
        let request = format!(
            "GET /v1/events?token={} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n", // gitleaks:allow
            harness.token,
            harness.addr.port()
        );
        stream
            .write_all(request.as_bytes())
            .await
            .expect("写入握手请求必须成功");
        // 服务端在 TLS 层拒绝：读到的要么是 EOF，要么是 TLS alert 字节，
        // 绝不可能是 HTTP 101 响应
        let mut buf = [0u8; 1024];
        let read =
            tokio::time::timeout(std::time::Duration::from_secs(3), stream.read(&mut buf)).await;
        let got: Vec<u8> = match read {
            Ok(Ok(0)) => Vec::new(),
            Ok(Ok(n)) => buf[..n].to_vec(),
            Ok(Err(_)) | Err(_) => Vec::new(),
        };
        let text = String::from_utf8_lossy(&got);
        assert!(
            !text.starts_with("HTTP/1.1 101"),
            "明文 ws 握手必须被拒绝（T-04），却收到：{text}"
        );
        assert!(
            !text.contains("Sec-WebSocket-Accept"),
            "明文请求不得获得 WS 升级（T-04）：{text}"
        );
        // 拒绝后服务存活：合法 wss 升级仍成功（拒绝不得终止 serve）
        let client = tls_client_with_root(Some(&harness.ca_der));
        let path = format!("/v1/events?token={}", harness.token);
        let (status, tls) = wss_upgrade(harness.addr, client, &path)
            .await
            .expect("拒绝明文后合法 wss 必须仍可连");
        assert!(
            status.starts_with("HTTP/1.1 101"),
            "wss 升级状态行：{status}"
        );
        drop(tls);
        // 优雅关停
        harness.handle.shutdown();
        let result = harness.task.await.expect("serve 任务不应 panic");
        assert!(result.is_ok(), "serve 应正常退出：{result:?}");
    }

    /// wss 握手成功 + 指纹 pinning 装配面端到端（T-03 装配面）：
    /// 信任锚 = 配对期 CA（正确指纹）→ 101 升级成功；伪造 CA（另一目录
    /// 自签，指纹 ≠ 服务端 CA）/ 空信任锚（未配对）→ TLS 层握手失败，
    /// 无降级明文路径。指纹 pin 语义本身由 multi_device/tls.rs 的
    /// FingerprintVerifier 单测覆盖（正确/错误 pin 放行/拒绝）。
    #[tokio::test]
    async fn wss_upgrade_succeeds_with_pinned_ca_and_wrong_ca_fails() {
        let harness = spawn_tls_server().await;
        let path = format!("/v1/events?token={}", harness.token);
        // 控制组：正确 CA（配对期指纹对应的 CA 作信任锚）→ 101
        let client = tls_client_with_root(Some(&harness.ca_der));
        let (status, tls) = wss_upgrade(harness.addr, client, &path)
            .await
            .expect("正确 CA 必须升级成功");
        assert!(
            status.starts_with("HTTP/1.1 101"),
            "wss 升级状态行：{status}"
        );
        // 响应头大小写不敏感（hyper 以小写输出）；Sec-WebSocket-Accept 存在
        // = WS 升级计算完成
        assert!(
            status
                .to_ascii_lowercase()
                .contains("sec-websocket-accept:"),
            "101 必须携带 Sec-WebSocket-Accept：{status}"
        );
        drop(tls);
        // 伪造 CA（ARP 欺骗 + 伪造证书场景：另一临时目录自签，指纹不匹配）
        let fake_dir = tempfile::tempdir().expect("临时目录必须可创建");
        let fake = crate::multi_device::tls::load_or_generate_in(fake_dir.path())
            .expect("伪造 CA 材料必须可生成");
        let wrong = tls_client_with_root(Some(&material_ca_der(&fake)));
        let err = wss_upgrade(harness.addr, wrong, &path)
            .await
            .expect_err("伪造 CA 必须握手失败（T-03）");
        assert!(err.contains("TLS 握手失败"), "失败原因应为 TLS 层：{err}");
        // 空信任锚（未配对设备，无 pin）→ 同样握手失败
        let none = tls_client_with_root(None);
        let err = wss_upgrade(harness.addr, none, &path)
            .await
            .expect_err("空信任锚必须握手失败");
        assert!(err.contains("TLS 握手失败"), "失败原因应为 TLS 层：{err}");
        // 优雅关停
        harness.handle.shutdown();
        let result = harness.task.await.expect("serve 任务不应 panic");
        assert!(result.is_ok(), "serve 应正常退出：{result:?}");
    }

    /// REST 面同端口同样只讲 TLS（D5 D-02a「远程网关只提供 wss」的同源
    /// 语义）：https + 配对 CA 根证书 → /v1/info 200；明文 http 到同一
    /// 端口在 TLS 层被拒（T-04 的 REST 变体断言）。
    #[tokio::test]
    async fn tls_serves_rest_info_over_https_only() {
        let harness = spawn_tls_server().await;
        let client = reqwest::Client::builder()
            .add_root_certificate(
                reqwest::Certificate::from_pem(harness.ca_pem.as_bytes())
                    .expect("CA PEM 必须可解析"),
            )
            .build()
            .expect("reqwest 客户端必须可构建");
        let response = client
            .get(format!("https://127.0.0.1:{}/v1/info", harness.addr.port()))
            .send()
            .await
            .expect("https 请求必须可达");
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let info: serde_json::Value = response.json().await.expect("info 必须为合法 JSON");
        assert_eq!(info["service"].as_str(), Some("crish-agent-workbench"));
        // 明文 http 同端口 → TLS 层拒绝（无 HTTP 响应）
        let plain = reqwest::get(format!("http://127.0.0.1:{}/v1/info", harness.addr.port())).await;
        assert!(
            plain.is_err() || !plain.unwrap().status().is_success(),
            "明文 http 必须被拒绝（wss-only，T-04 REST 变体）"
        );
        // 优雅关停
        harness.handle.shutdown();
        let result = harness.task.await.expect("serve 任务不应 panic");
        assert!(result.is_ok(), "serve 应正常退出：{result:?}");
    }

    #[test]
    fn server_state_accessors_smoke() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = ServerConfig::new(dir.path());
        let handle = ServerHandle::new(config.clone(), "127.0.0.1:0".parse().unwrap());
        let tokens = auth::TokenStore::new(config.pairing_file_path.clone());
        let state = ServerState::new(&handle, tokens, None);
        assert!(state.started_at_ms() > 0);
        let _limiter = state.conn_limiter();
        let _pair_limiter = state.pair_limiter();
    }
}
