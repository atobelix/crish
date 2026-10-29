//! TLS 测试 · R1-10 安全测试面（TLS-01~10 清单自动化）。

use super::super::*;
use super::support::*;

use rustls::client::danger::ServerCertVerifier;

/// 移动端对偶验证器（D5 §2.2 pinning 模型 / TLS-05）：客户端只信任
/// SHA-256(SubjectPublicKeyInfo) 与配对期拿到的指纹一致的证书链
/// （T-03 自动化的「注入错误指纹」载体，对应移动端对偶实现）。
#[derive(Debug)]
struct FingerprintVerifier {
    /// 期望 CA 指纹（64 位小写 hex）。
    pinned: String,
    /// ring 的签名算法支持面（委托真实签名校验）。
    supported: rustls::crypto::WebPkiSupportedAlgorithms,
}

impl FingerprintVerifier {
    fn new(pinned: String) -> Self {
        Self {
            pinned,
            supported: rustls::crypto::ring::default_provider()
                .signature_verification_algorithms,
        }
    }
}

impl rustls::client::danger::ServerCertVerifier for FingerprintVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        intermediates: &[rustls::pki_types::CertificateDer<'_>],
        server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        // 主机名校验（TLS-05 移动端职责）：SNI 必须与固定域名一致。
        let expected =
            rustls::pki_types::ServerName::try_from("crish-remote").expect("常量域名恒合法");
        if server_name != &expected {
            return Err(rustls::Error::General(format!(
                "主机名未在固定清单：{server_name:?}"
            )));
        }
        // 指纹 pin：链上任一证书（叶子或中间 CA）SPKI 指纹命中即放行；
        // 服务端证书链 = 叶子 + CA（TLS-05 注释），pin 锚定 CA。
        let pinned = self.pinned.as_str();
        let matched = std::iter::once(end_entity)
            .chain(intermediates.iter())
            .any(|cert| spki_sha256_hex(cert.as_ref()).ok().as_deref() == Some(pinned));
        if matched {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(format!(
                "CA 指纹不匹配（pin={pinned}），拒绝握手（T-03）"
            )))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.supported)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.supported)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.supported.supported_schemes()
    }
}

/// 指纹 pin 客户端（注入 pin 值；错误 pin → 握手拒绝）。
fn client_config_with_pin(pin: String) -> rustls::ClientConfig {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("默认版本受 rustls 支持")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(FingerprintVerifier::new(pin)))
        .with_no_client_auth()
}

/// 受限套件客户端：指定套件 + 版本（信任锚 = CA 证书；None = 空根库）。
fn client_config_restricted(
    suites: &[rustls::SupportedCipherSuite],
    versions: &[&'static rustls::SupportedProtocolVersion],
    trust_ca: Option<&CertificateDer<'static>>,
) -> rustls::ClientConfig {
    let ring = rustls::crypto::ring::default_provider();
    let provider = Arc::new(rustls::crypto::CryptoProvider {
        cipher_suites: suites.to_vec(),
        kx_groups: ring.kx_groups.clone(),
        ..ring
    });
    let mut roots = rustls::RootCertStore::empty();
    if let Some(ca) = trust_ca {
        roots.add(ca.clone()).expect("CA 入根库");
    }
    rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(versions)
        .expect("版本组合受 rustls 支持")
        .with_root_certificates(roots)
        .with_no_client_auth()
}

#[test]
fn fingerprint_verifier_rejects_wrong_pin_unit() {
    // D5 §9.4 tls_wrong_fingerprint_rejected 的验证器单元面（不依赖网络）。
    let dir = tempfile::tempdir().expect("创建临时目录");
    let material =
        load_or_generate_with(dir.path(), &CertOptions::default()).expect("首次生成");
    let name = rustls::pki_types::ServerName::try_from("crish-remote").expect("常量域名恒合法");
    let now = rustls::pki_types::UnixTime::now();
    // 正确指纹 → 放行。
    let ok_verifier = FingerprintVerifier::new(material.ca_fingerprint().to_string());
    assert!(
        ok_verifier
            .verify_server_cert(
                &material.server_chain[0],
                &[material.server_chain[1].clone()],
                &name,
                &[],
                now,
            )
            .is_ok(),
        "正确指纹必须放行"
    );
    // 错误指纹（全零 64 hex，模拟攻击者伪造 CA 的 SPKI）→ 拒绝。
    let bad_verifier = FingerprintVerifier::new("0".repeat(64));
    assert!(
        bad_verifier
            .verify_server_cert(
                &material.server_chain[0],
                &[material.server_chain[1].clone()],
                &name,
                &[],
                now,
            )
            .is_err(),
        "错误指纹必须拒绝（T-03）"
    );
    // 主机名不匹配 → 拒绝（TLS-05 主机名校验由移动端承担）。
    let other_name =
        rustls::pki_types::ServerName::try_from("evil.example.com").expect("域名合法");
    assert!(
        ok_verifier
            .verify_server_cert(
                &material.server_chain[0],
                &[material.server_chain[1].clone()],
                &other_name,
                &[],
                now,
            )
            .is_err(),
        "主机名不匹配必须拒绝"
    );
}

#[tokio::test]
async fn tls_wrong_fingerprint_rejected_handshake() {
    // T-03 自动化（D5 §9.1）：注入错误指纹 → 握手失败，无降级路径；
    // 控制组：正确指纹 → 握手成功。
    let dir = tempfile::tempdir().expect("创建临时目录");
    let material =
        load_or_generate_with(dir.path(), &CertOptions::default()).expect("首次生成");
    let wrong = client_config_with_pin("0".repeat(64));
    assert!(
        !try_handshake_with(&material, wrong).await,
        "错误指纹必须握手失败（T-03）"
    );
    let right = client_config_with_pin(material.ca_fingerprint().to_string());
    assert!(
        try_handshake_with(&material, right).await,
        "正确指纹必须握手成功"
    );
}

#[tokio::test]
async fn tls_weak_cipher_absent_exact_aead_allowlist() {
    // D5 §9.4 tls_weak_cipher_absent（TLS-03）：服务端只接受
    // TLS_AES_256_GCM_SHA384（1.3）/ ECDHE-ECDSA-AES256-GCM（1.2），
    // 白名单外的套件一律握手失败（含其余 AEAD 套件，如 AES-128-GCM）。
    use rustls::crypto::ring::cipher_suite::{
        TLS13_AES_128_GCM_SHA256, TLS13_AES_256_GCM_SHA384,
        TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
    };
    let dir = tempfile::tempdir().expect("创建临时目录");
    let material =
        load_or_generate_with(dir.path(), &CertOptions::default()).expect("首次生成");
    let ca = load_cert_der(&dir.path().join(CA_CERT_FILE)).expect("读回 CA 证书");
    // 1.3：白名单外（AES-128-GCM）→ 拒绝。
    let client = client_config_restricted(
        &[TLS13_AES_128_GCM_SHA256],
        &[&rustls::version::TLS13],
        Some(&ca),
    );
    assert!(
        !try_handshake_with(&material, client).await,
        "白名单外 1.3 套件必须拒绝"
    );
    // 1.3：白名单内（AES-256-GCM）→ 放行（控制组）。
    let client = client_config_restricted(
        &[TLS13_AES_256_GCM_SHA384],
        &[&rustls::version::TLS13],
        Some(&ca),
    );
    assert!(
        try_handshake_with(&material, client).await,
        "白名单 1.3 套件必须放行"
    );
    // 1.2：白名单外（ECDHE-ECDSA-AES128-GCM）→ 拒绝。
    let client = client_config_restricted(
        &[TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256],
        &[&rustls::version::TLS12],
        Some(&ca),
    );
    assert!(
        !try_handshake_with(&material, client).await,
        "白名单外 1.2 套件必须拒绝"
    );
    // 1.2：白名单内（ECDHE-ECDSA-AES256-GCM）→ 放行（控制组；同时证明
    // 服务端接受 1.2——TLS-02 的行为面）。
    let client = client_config_restricted(
        &[TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384],
        &[&rustls::version::TLS12],
        Some(&ca),
    );
    assert!(
        try_handshake_with(&material, client).await,
        "白名单 1.2 套件必须放行"
    );
}

#[test]
fn session_resumption_tickets_disabled() {
    // TLS-07：默认装配不签发会话票据（rustls 默认 NeverProducesTickets），
    // 跨重启/跨装配不存在可复用的票据——比「重启清空票据密钥」更强。
    let dir = tempfile::tempdir().expect("创建临时目录");
    let material =
        load_or_generate_with(dir.path(), &CertOptions::default()).expect("首次生成");
    let config = material.server_config().expect("装配 ServerConfig");
    assert!(!config.ticketer.enabled(), "会话复用票据必须禁用（TLS-07）");
}

#[cfg(unix)]
#[test]
fn private_key_files_are_0600_on_unix() {
    // TLS-01：私钥 0600 落盘（unix；windows 由用户目录 ACL 承接，见 write_atomic）。
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().expect("创建临时目录");
    load_or_generate_with(dir.path(), &CertOptions::default()).expect("首次生成");
    for f in [CA_KEY_FILE, SERVER_KEY_FILE] {
        let meta = std::fs::metadata(dir.path().join(f)).expect("读取私钥文件元数据");
        assert_eq!(
            meta.permissions().mode() & 0o777,
            0o600,
            "{f} 权限必须 0600（TLS-01）"
        );
    }
}
