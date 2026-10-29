//! 多端服务生命周期装配（main.rs 拆分）：生命周期槽、装配状态与重建路径。
//!
//! 退出钩子 / 重绑钩子 / 开关命令共用同一 [MultiDeviceService] 实例；
//! 重建一律经 [restart_server] 单一路径（红线 1 与 wss 强制门控在此）。

use std::sync::Arc;

use crate::server;

/// 本地服务生命周期槽（G-1 装配）：当前句柄 + serve task 的单一真源。
///
/// 退出钩子经 handle 优雅关停；重绑（rebind 钩子）先取走旧 task 并 await
/// （serve 收尾 = listener 释放，端口立即可重绑）再重建——保证睡眠唤醒 /
/// 配对切换后端口不漂移（移动端重连沿用旧地址与二维码内嵌端口）。
/// 槽由 [MultiDeviceService] 持有（重绑 / 开关命令 / 退出钩子共用同一实例）。
#[derive(Default)]
pub(crate) struct ServerLifecycle {
    /// 当前生效服务句柄（退出钩子关停用）
    pub(crate) handle: Option<server::ServerHandle>,
    /// 当前 serve 任务（重绑前 await 等待端口释放）
    pub(crate) task: Option<tauri::async_runtime::JoinHandle<()>>,
}

/// 多端服务装配状态（R1-11 G-1 生产装配）：本地服务依赖与开关的单一真源。
///
/// setup 装配一次并 manage（`multi_device_set_enabled` 命令消费）；重绑钩子 /
/// 电源唤醒 / 开关命令 / 退出钩子共用同一生命周期槽与依赖实例——重建后
/// 句柄自动更新，退出关停无需再依赖 Tauri state 注入。
pub(crate) struct MultiDeviceService {
    /// 生命周期槽（当前句柄 + serve task；与退出钩子共用）
    pub(crate) lifecycle: Arc<std::sync::Mutex<ServerLifecycle>>,
    /// 诊断（环形缓冲，core_get_status 可见）
    pub(crate) diagnostics: Arc<conex_run::status_diagnostics::StatusDiagnostics>,
    /// 命令后端（CoreStateBackend 直调既有 *_impl 契约体；注入 router）
    pub(crate) backend: Option<Arc<dyn server::backend::ApiBackend>>,
    /// 事件扇出器（已挂 EventBridge 汇聚点；注入 ServerState.event_stream）
    pub(crate) fanout: Option<Arc<server::fanout::FanOutEmitter>>,
    /// 远程审计事件桥（R1-11：与引擎 run 上下文同一 EventBridge 实例——
    /// CoreStateBackend 经 core 透传；注入 ServerState.audit_bridge，
    /// remote-source-attempt 事件发射通道）
    pub(crate) audit_bridge: Option<conex_run::core_event_bridge::EventBridge>,
    /// 配对协调器（实际端口经 set_port 注入；重绑钩子已装配）
    pub(crate) pairing: Arc<server::pairing::PairingCoordinator>,
    /// WS 连接注册表（P2-5 连接面共享接线：与配对协调器 / push presence /
    /// 直投同一实例——restart_server 注入 ServerState，路由层升级注册即
    /// 进入共享注册表，presence 与撤销踢链观察真实连接）
    pub(crate) ws_registry: Arc<server::ws::WsRegistry>,
    /// 服务配置模板（端口 / 令牌路径；enabled 与 bind_mode 按当前态派生）
    pub(crate) base: server::config::ServerConfig,
    /// 服务总开关（D5 D-01 红线 1：enabled=false 时不 bind 任何端口）
    pub(crate) enabled: Arc<std::sync::atomic::AtomicBool>,
    /// 账户远程 loopback 网关生命周期（与面向局域网的 lifecycle 分离；
    /// 仅 127.0.0.1 + 桥密钥，不影响用户的多端服务开关）
    pub(crate) remote_lifecycle: Arc<std::sync::Mutex<ServerLifecycle>>,
}

impl MultiDeviceService {
    /// 服务开关当前值（false = 不监听任何端口，红线 1）
    pub(crate) fn enabled(&self) -> bool {
        self.enabled.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 当前生效配置（重绑钩子 / 开关命令 / 初始启动共用）：
    /// enabled 取开关当前值；bind_mode 跟随配对协调器状态（配对中 =
    /// Lan，否则 Loopback）——配对态由协调器持有，重启后保持正确绑定面。
    pub(crate) fn current_config(&self) -> server::config::ServerConfig {
        let mut config = self.base.clone();
        config.multi_device_enabled = self.enabled();
        config.pairing_enabled = self.pairing.pairing_enabled();
        // 已配对设备的令牌持久化在 pairing.json：桌面重启后即使未重新开启
        // 配对模式，也要保持 Lan，让手机可用既有令牌直接重连（配对开关只
        // 控制"新配对"，关闭配对会 revoke_all → 无有效设备 → 回 Loopback）。
        config.bind_mode = if config.pairing_enabled || self.pairing.has_active_devices() {
            server::config::BindMode::Lan
        } else {
            server::config::BindMode::Loopback
        };
        config
    }

    /// 服务开关命令（`multi_device_set_enabled`）：开启 → 按当前配对态
    /// 绑定监听；关闭 → 停服（关停旧实例后不 bind——红线 1）。与重绑
    /// 共用 [restart_server] 单一路径。
    pub(crate) async fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        self.enabled
            .store(enabled, std::sync::atomic::Ordering::SeqCst);
        let config = self.current_config();
        restart_server(config, self).await;
        Ok(())
    }

    /// 启动/复用账户远程的 loopback 网关。
    ///
    /// 与面向局域网的 `lifecycle` 完全分离：仅 bind 127.0.0.1、关闭 TLS、
    /// 打开 `/v1/relay-loopback` 桥密钥；不改变用户的多端服务开关，也不
    /// 暴露局域网端口。中继 host 桥用此地址把手机帧转发到现有协议处理器。
    pub(crate) async fn ensure_remote_gateway(
        &self,
        secret: String,
    ) -> Result<std::net::SocketAddr, String> {
        {
            let slot = self
                .remote_lifecycle
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(handle) = slot.handle.as_ref() {
                return Ok(handle.addr());
            }
        }
        let mut config = self.base.clone();
        config.port = 0;
        config.bind_mode = server::config::BindMode::Loopback;
        config.multi_device_enabled = true;
        config.pairing_enabled = false;
        config.tls_enabled = false;
        config.tls_extra_sans.clear();
        config.relay_loopback_secret = Some(secret);
        let instance = server::ServerInstance::bind(config)
            .await
            .map_err(|error| format!("remote loopback gateway bind failed: {error}"))?;
        let addr = instance.addr();
        let handle = instance.handle().clone();
        let router = instance.router(
            self.backend.clone(),
            self.fanout.clone(),
            self.audit_bridge.clone(),
            Some(Arc::clone(&self.pairing)),
            Some(Arc::clone(&self.ws_registry)),
        );
        let task = tauri::async_runtime::spawn(async move {
            if let Err(error) = instance.serve(router).await {
                tracing::error!(target: "remote", error = %error, "remote loopback gateway stopped");
            }
        });
        let mut slot = self
            .remote_lifecycle
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        slot.handle = Some(handle);
        slot.task = Some(task);
        tracing::info!(target: "remote", addr = %addr, "remote loopback gateway ready");
        Ok(addr)
    }

    /// 停止账户远程 loopback 网关（退出登录 / 服务关闭）。
    pub(crate) async fn stop_remote_gateway(&self) {
        let (handle, task) = {
            let mut slot = self
                .remote_lifecycle
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            (slot.handle.take(), slot.task.take())
        };
        if let Some(handle) = handle {
            handle.shutdown();
        }
        if let Some(task) = task {
            let _ = task.await;
        }
    }
}

/// 本地服务重建（R1-11 G-1 生产装配版：重绑钩子 / 开关命令 / 初始启动共用）：
///
/// 1. 服务开关门控（D5 §10.3 红线 1）：config.multi_device_enabled=false
///    时关停旧实例后**不 bind 任何端口**（Loopback 也不监听），记录诊断
///    并返回——「enabled=false 无任何端口监听」的 netstat 断言由本门控
///    保证（D5:948「服务关闭（不监听任何端口）」）；
/// 2. wss 强制（D5 D-02a「远程网关只提供 wss」/ D2 §12.8 裁决修正 11
///    「wss 强制 R1 即生效」）：红线 1 放行（服务开启）后**只提供 wss**
///    ——装配面置 tls_enabled=true（证书目录 None → 默认
///    config_dir()/multi-device/，tls.rs cert_dir 语义，无需显式设置；
///    明文 ws:// 握手在 TLS 层拒绝，无明文端点）；服务关闭（enabled=false）
///    时早返回不 bind，无明文/密文差异；
/// 3. 取走旧句柄与旧 serve task，shutdown 旧句柄并 await 旧 task——serve
///    收尾即 listener 释放，随后按同端口重建（8765 优先，占用探测兜底
///    语义不变，R1-02）；
/// 4. bind 新实例（绑定模式按 config：Loopback / Lan）→ 实际端口注入
///    配对协调器（set_port，二维码数据同源）→ 注入 CoreStateBackend 与
///    FanOutEmitter 构建 Router → 更新生命周期槽 → serve（新 task 入槽）。
///    失败仅记录诊断，不阻断应用（D1 §3.4 铁律）。
pub(crate) async fn restart_server(mut config: server::ServerConfig, service: &MultiDeviceService) {
    // ① 关停旧实例（先取走，避免退出钩子重复 shutdown——幂等无害）
    let (old_handle, old_task) = {
        let mut slot = service.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        (slot.handle.take(), slot.task.take())
    };
    if let Some(old) = old_handle {
        tracing::info!(target: "server", "关闭旧服务实例（重绑重建 / 停服）");
        old.shutdown();
    }
    if let Some(old_task) = old_task {
        // serve 收尾 = listener 释放（axum graceful shutdown 停止接受
        // 新连接后返回；已升级的 WS 连接由各自 task 继续收尾）
        let _ = old_task.await;
    }
    // ② 红线 1（D5 §10.3）：服务开关关闭 → 完全不 bind（Loopback 也不
    // 监听）——netstat 断言 876[5-9] 无监听由本门控保证
    if !config.multi_device_enabled {
        service.diagnostics.record(
            "server",
            false,
            Some("multi_device.enabled=false：服务未启动，无端口监听".to_string()),
        );
        tracing::info!(
            target: "server",
            "多端服务未开启（multi_device.enabled=false），不监听端口"
        );
        return;
    }
    // ②b wss 强制（D5 D-02a / D2 §12.8 裁决修正 11「wss 强制 R1 即生效」）：
    // 红线 1 放行（multi_device_enabled=true）后服务**只提供 wss**——置
    // tls_enabled=true；证书目录 None → 默认 config_dir()/multi-device/
    // （multi_device/tls.rs cert_dir 语义），无需显式设置。明文 ws:// 握手
    // 在 TLS 层拒绝（server/mod.rs TlsListener，fail-closed：材料失败即
    // bind 报错，绝不以明文降级），不存在明文端点（T-04 降级保护）。
    config.tls_enabled = true;
    // ②c 局域网 SAN：TLS 主机名校验依据连接 host（D5 §2.2），叶子必须包含
    // 本机对外公布的 IP。配对码/二维码中的 IP 来自同一枚举源，保证一致。
    if config.bind_mode == server::config::BindMode::Lan {
        config.tls_extra_sans = crate::multi_device_network::usable_lan_ips()
            .into_iter()
            .filter(|ip| ip != "0.0.0.0")
            .collect();
        // 手动输入允许主机名：把本机名一并纳入 SAN（仅 ASCII，避免 Ia5 非法）。
        if let Ok(name) = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")) {
            let name = name.trim();
            if !name.is_empty()
                && name.is_ascii()
                && !config.tls_extra_sans.iter().any(|s| s == name)
            {
                config.tls_extra_sans.push(name.to_string());
            }
        }
    }
    // ③ 重建并 serve（注入真实后端与扇出器；端口同步配对协调器）
    match server::ServerInstance::bind(config).await {
        Ok(instance) => {
            let addr = instance.addr();
            let handle = instance.handle().clone();
            {
                let mut slot = service.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
                slot.handle = Some(handle);
            }
            // 实际端口注入配对协调器（二维码 / qr_data 内嵌端口同源；
            // 8765 探测兜底后二维码反映真实端口）
            service.pairing.set_port(addr.port());
            service
                .diagnostics
                .record("server", true, Some(addr.to_string()));
            tracing::info!(target: "server", addr = %addr, "本地服务已重建（重绑完成）");
            let router = instance.router(
                service.backend.clone(),
                service.fanout.clone(),
                service.audit_bridge.clone(),
                // R1-11 G-2：配对协调器接入路由层（REST /v1/pair + WS pair
                // 消息链；与命令面同一 Arc 实例）
                Some(Arc::clone(&service.pairing)),
                // P2-5 连接面共享接线：路由层注册表 = 装配面共享注册表
                //（与 push presence / 直投 / 配对协调器 / 唤醒踢链同一实例）
                Some(Arc::clone(&service.ws_registry)),
            );
            let serve_task = tauri::async_runtime::spawn(async move {
                if let Err(error) = instance.serve(router).await {
                    tracing::error!(target: "server", error = %error, "本地服务异常退出");
                }
            });
            service
                .lifecycle
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .task = Some(serve_task);
        }
        Err(error) => {
            tracing::error!(
                target: "server",
                error = %error,
                "本地服务重建失败（多端能力降级，GUI 不受影响）"
            );
            service
                .diagnostics
                .record("server", false, Some(error.to_string()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── 多端服务开关状态机（R1-11 G-1：enabled 切换 → bind/stop 语义；
    //    D5 D-01 红线 1「enabled=false 无任何端口监听」）──

    /// 测试服务装配（无 Tauri 依赖；固定高位端口避免与并行测试抢占）
    fn test_md_service(enabled: bool, port: u16) -> Arc<MultiDeviceService> {
        static MD_TEST_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = MD_TEST_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tokens = Arc::new(std::sync::Mutex::new(server::auth::TokenStore::new(
            std::env::temp_dir().join(format!(
                "md-switch-{}-{seq}-pairing.json",
                std::process::id()
            )),
        )));
        let ws_registry = Arc::new(server::ws::WsRegistry::new());
        let pairing = Arc::new(server::pairing::PairingCoordinator::new(
            tokens,
            Arc::clone(&ws_registry),
        ));
        let mut base = server::config::ServerConfig::new(std::env::temp_dir());
        base.port = port;
        // wss 强制（装配层语义）：restart_server 在 enabled=true 时置
        // tls_enabled=true——测试注入唯一临时证书目录，隔离真实配置目录
        // （默认 config_dir()/multi-device/ 不得被测试污染）
        base.tls_cert_dir = Some(
            std::env::temp_dir().join(format!("md-switch-{}-{seq}-certs", std::process::id())),
        );
        Arc::new(MultiDeviceService {
            lifecycle: Arc::new(std::sync::Mutex::new(ServerLifecycle::default())),
            diagnostics: Arc::new(conex_run::status_diagnostics::StatusDiagnostics::new()),
            backend: None,
            fanout: None,
            audit_bridge: None,
            pairing,
            ws_registry,
            base,
            enabled: Arc::new(std::sync::atomic::AtomicBool::new(enabled)),
            remote_lifecycle: Arc::new(std::sync::Mutex::new(ServerLifecycle::default())),
        })
    }

    /// 尝试独占绑定指定端口（成功 = 端口当前空闲 / 无监听）
    async fn port_is_free(port: u16) -> bool {
        tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .is_ok()
    }

    /// 红线 1 语义：enabled=false 时 restart_server 完全不 bind（Loopback
    /// 也不监听）——生命周期槽无句柄，端口可被独立绑定。
    #[tokio::test]
    async fn disabled_service_never_binds_any_port() {
        let service = test_md_service(false, 19081);
        restart_server(service.current_config(), &service).await;

        assert!(
            service
                .lifecycle
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .handle
                .is_none(),
            "enabled=false 不得持有服务句柄"
        );
        assert!(
            port_is_free(19081).await,
            "enabled=false 时端口必须无监听（红线 1：netstat 876[5-9] 亦同）"
        );
        // 诊断如实上报（core_get_status 可见「服务未启动」）
        assert!(
            service
                .diagnostics
                .entries()
                .iter()
                .any(|entry| entry.subsystem == "server" && !entry.ready),
            "禁用态必须记录 server=false 诊断"
        );
    }

    /// 开关状态机：enabled=true → 绑定监听（端口被占）；关闭 → 停服
    /// （句柄取走 + 端口释放）。enabled 切换 → bind/stop 语义闭环。
    #[tokio::test]
    async fn switch_enables_bind_then_disable_stops_listening() {
        let service = test_md_service(false, 19082);
        assert!(!service.enabled(), "初始必须为关闭态（D-01）");

        // 开启 → 绑定监听（端口被占 = 有监听）
        service.set_enabled(true).await.expect("开启必须成功");
        assert!(service.enabled());
        assert!(
            !port_is_free(19082).await,
            "enabled=true 时端口必须被监听（绑定占用）"
        );
        // 实际端口已注入配对协调器（二维码数据同源：restart_server 的
        // set_port 生效，QR 内嵌 19082 而非默认 8765）
        let now = server::now_ms();
        let result = service
            .pairing
            .start_pairing(now)
            .expect("激活配对必须成功");
        assert!(
            result.qr.contains(":19082"),
            "二维码必须内嵌实际监听端口（set_port 注入）：{}",
            result.qr
        );

        // 关闭 → 停服：句柄取走 + serve 收尾 → 端口释放
        service.set_enabled(false).await.expect("关闭必须成功");
        assert!(!service.enabled());
        assert!(port_is_free(19082).await, "关闭后端口必须释放（无监听）");
        assert!(
            service
                .lifecycle
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .handle
                .is_none(),
            "关闭后生命周期槽不得残留句柄"
        );
    }

    /// 装配辅助纯逻辑：current_config 派生——enabled 取开关当前值；
    /// bind_mode 跟随配对协调器状态（配对中 = Lan，否则 Loopback）。
    #[test]
    fn current_config_follows_switch_and_pairing_state() {
        let service = test_md_service(false, 0);
        // 关闭态：Loopback + enabled=false
        let config = service.current_config();
        assert!(!config.multi_device_enabled);
        assert_eq!(config.bind_mode, server::config::BindMode::Loopback);
        assert!(!config.pairing_enabled);

        // 配对开启 → Lan（协调器状态驱动）
        let now = server::now_ms();
        service
            .pairing
            .start_pairing(now)
            .expect("激活配对必须成功");
        let config = service.current_config();
        assert_eq!(config.bind_mode, server::config::BindMode::Lan);
        assert!(config.pairing_enabled);
        // 开关仍关闭 → enabled 不被配对态带起（红线 1 门控不变）
        assert!(!config.multi_device_enabled);

        // 开关开启 → 派生配置带 enabled=true（同步写入开关位；set_enabled
        // 的异步重启路径由 switch_enables_bind_then_disable_stops_listening
        // 覆盖）
        service
            .enabled
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let config = service.current_config();
        assert!(config.multi_device_enabled);
        assert_eq!(config.bind_mode, server::config::BindMode::Lan);
    }

    /// 重绑钩子语义：服务关闭时 rebind 触发 → restart_server 停服不 bind
    /// （配对切换在开关关闭下不得产生监听）。
    #[tokio::test]
    async fn rebind_while_disabled_is_noop() {
        let service = test_md_service(false, 19083);
        // 模拟配对切换触发重绑（enabled=false 门控）
        let mut config = service.base.clone();
        config.bind_mode = server::config::BindMode::Lan;
        config.pairing_enabled = true;
        config.multi_device_enabled = false;
        restart_server(config, &service).await;
        assert!(
            port_is_free(19083).await,
            "开关关闭时配对重绑不得产生监听（红线 1）"
        );
    }

    /// 服务开启即 wss-only（D5 D-02a / D2 §12.8 裁决修正 11）：restart_server
    /// 在 multi_device_enabled=true 时强制置 tls_enabled=true——TLS 材料
    /// 生成（bind 内 load_or_generate_in 落盘 CA/叶子）即强制置位的落点
    /// 证据；明文 ws 端点不存在（TLS 层拒绝，mod.rs TlsListener 语义）。
    #[tokio::test]
    async fn enabled_service_forces_tls_wss_only() {
        let service = test_md_service(true, 19084);
        // 基线断言：测试构造的服务 config.tls_enabled=false——TLS 材料
        // 生成只能来自 restart_server 的强制置位，而非结构默认值
        assert!(
            !service.base.tls_enabled,
            "测试基线必须为明文构造（验证强制语义）"
        );
        restart_server(service.current_config(), &service).await;
        // 服务已监听（enabled=true）
        assert!(!port_is_free(19084).await, "enabled=true 必须监听端口");
        // TLS 材料已生成：证书目录出现 CA 与叶子文件（load_or_generate_in
        // 仅在 tls_enabled=true 时被 bind 调用——wss 强制的直接证据）
        let cert_dir = service
            .base
            .tls_cert_dir
            .clone()
            .expect("测试必须注入证书目录");
        for file in ["ca_cert.pem", "server_cert.pem"] {
            assert!(
                cert_dir.join(file).exists(),
                "wss 强制：证书材料 {file} 必须已生成（TLS 装配被触发）"
            );
        }
    }
}
