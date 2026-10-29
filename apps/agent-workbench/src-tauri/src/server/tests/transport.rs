//! server 测试 · 共享注册表接线与 wss-only 传输面。

use super::super::*;
use super::support::*;

use conex_types::device::{DeviceEndpoint, DeviceEnvelope, MessageKind};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

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
    let read = tokio::time::timeout(std::time::Duration::from_secs(3), stream.read(&mut buf)).await;
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
            reqwest::Certificate::from_pem(harness.ca_pem.as_bytes()).expect("CA PEM 必须可解析"),
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

/// 局域网绑定：`tls_extra_sans` 必须写入叶子证书 SAN（移动端按 IP 连接时
/// 系统 TLS 主机名校验依赖该扩展）；默认 SAN 仍保留。
#[tokio::test]
async fn tls_bind_adds_configured_lan_sans_to_leaf() {
    let dir = tempfile::tempdir().expect("临时目录必须可创建");
    let cert_dir = dir.path().join("multi-device");
    let mut config = ServerConfig::new(dir.path());
    config.port = 0;
    config.tls_enabled = true;
    config.tls_cert_dir = Some(cert_dir.clone());
    config.tls_extra_sans = vec!["192.168.1.77".to_string(), "hub.local".to_string()];
    let instance = ServerInstance::bind(config)
        .await
        .expect("TLS 实例绑定必须成功");
    instance.handle().shutdown();

    let pem =
        std::fs::read_to_string(cert_dir.join("server_cert.pem")).expect("叶子证书必须已落盘");
    let (_, parsed) =
        x509_parser::pem::parse_x509_pem(pem.as_bytes()).expect("叶子 PEM 必须可解析");
    let (_, cert) =
        x509_parser::parse_x509_certificate(&parsed.contents).expect("叶子 DER 必须可解析");
    let san = cert
        .extensions()
        .iter()
        .find_map(|ext| match ext.parsed_extension() {
            x509_parser::extensions::ParsedExtension::SubjectAlternativeName(names) => Some(names),
            _ => None,
        })
        .expect("叶子应含 SAN 扩展");
    assert!(
        san.general_names.iter().any(|name| matches!(
            name,
            x509_parser::extensions::GeneralName::IPAddress(octets)
                if octets == &[192, 168, 1, 77]
        )),
        "SAN 应包含局域网 IP 192.168.1.77"
    );
    assert!(
        san.general_names.iter().any(|name| matches!(
            name,
            x509_parser::extensions::GeneralName::DNSName(host) if *host == "hub.local"
        )),
        "SAN 应包含主机名 hub.local"
    );
    assert!(
        san.general_names.iter().any(|name| matches!(
            name,
            x509_parser::extensions::GeneralName::DNSName(host) if *host == "localhost"
        )),
        "默认 SAN（localhost）应保留"
    );
}

/// 账户远程 host 桥：loopback 入口必须校验桥密钥；通过后 trusted_relay
/// 跳过设备 HMAC，heartbeat 可直接拿到回执（现有协议处理器复用）。
#[tokio::test]
async fn relay_loopback_requires_secret_and_serves_trusted_frames() {
    let dir = tempfile::tempdir().expect("临时目录必须可创建");
    let mut config = ServerConfig::new(dir.path());
    config.port = 0;
    config.tls_enabled = false;
    config.relay_loopback_secret = Some("relay-bridge-secret".to_string());
    let instance = ServerInstance::bind(config).await.expect("loopback bind");
    let addr = instance.addr();
    let router = instance.router(None, None, None, None, None);
    let serve = tokio::spawn(async move { instance.serve(router).await });

    // 缺桥密钥：升级前 401。
    let missing = format!("ws://{addr}/v1/relay-loopback")
        .into_client_request()
        .expect("request");
    assert!(tokio_tungstenite::connect_async(missing).await.is_err());

    let mut request = format!("ws://{addr}/v1/relay-loopback")
        .into_client_request()
        .expect("request");
    request.headers_mut().insert(
        "Authorization",
        "Bearer relay-bridge-secret".parse().expect("header"),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(request)
        .await
        .expect("trusted bridge upgrade");
    let now = now_ms();
    let envelope = DeviceEnvelope::unsigned(
        MessageKind::Heartbeat,
        "m-bridge-1",
        now,
        DeviceEndpoint::Mobile,
        DeviceEndpoint::Desktop,
        serde_json::json!({ "ts": now, "deviceTimeMs": now }),
    );
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        serde_json::to_string(&envelope).expect("serialize").into(),
    ))
    .await
    .expect("send heartbeat");
    let frame = ws.next().await.expect("frame").expect("ok frame");
    let text = frame.into_text().expect("text frame");
    let value: serde_json::Value = serde_json::from_str(&text).expect("json");
    assert_eq!(value["kind"].as_str(), Some("heartbeat.ok"));
    let _ = ws.close(None).await;
    serve.abort();
}
