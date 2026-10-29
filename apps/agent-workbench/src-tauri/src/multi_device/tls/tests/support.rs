//! TLS 测试共享基建（tls.rs 拆分）：证书参数、解析与握手往返。

use super::super::*;

/// 测试专用参数：叶子 1 天、阈值 2 天 → 每次加载都触发重签路径。
pub(super) fn opts_leaf_short() -> CertOptions {
    CertOptions {
        ca_lifetime: time::Duration::days(3650),
        leaf_lifetime: time::Duration::days(1),
        renew_threshold: time::Duration::days(2),
    }
}

pub(super) fn not_after_unix(cert_der: &[u8]) -> i64 {
    let (_, cert) = x509_parser::parse_x509_certificate(cert_der).expect("解析证书");
    cert.validity().not_after.timestamp()
}

pub(super) fn spki_algorithm_oid(cert_der: &[u8]) -> String {
    let (_, cert) = x509_parser::parse_x509_certificate(cert_der).expect("解析证书");
    cert.tbs_certificate
        .subject_pki
        .algorithm
        .algorithm
        .to_id_string()
}

pub(super) fn spki_raw(cert_der: &[u8]) -> Vec<u8> {
    let (_, cert) = x509_parser::parse_x509_certificate(cert_der).expect("解析证书");
    cert.tbs_certificate.subject_pki.raw.to_vec()
}

/// 默认客户端配置：信任锚 = 指定 CA（None = 空根库，模拟无系统信任）。
pub(super) fn default_client_config(
    trust_ca: Option<&CertificateDer<'static>>,
) -> rustls::ClientConfig {
    let mut roots = rustls::RootCertStore::empty();
    if let Some(ca) = trust_ca {
        roots.add(ca.clone()).expect("CA 入根库");
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("默认版本受 rustls 支持")
        .with_root_certificates(roots)
        .with_no_client_auth()
}

/// 完整 TLS 握手 + 双向字节交换；返回是否成功（服务端/客户端任一端失败即 false）。
pub(super) async fn try_handshake(
    material: &TlsMaterial,
    trust_ca: Option<&CertificateDer<'static>>,
) -> bool {
    try_handshake_with(material, default_client_config(trust_ca)).await
}

/// 指定客户端配置的握手往返（套件/版本/证书验证器注入用）。
pub(super) async fn try_handshake_with(
    material: &TlsMaterial,
    client_config: rustls::ClientConfig,
) -> bool {
    let acceptor = material.tls_acceptor().expect("装配 acceptor");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("绑定测试端口");
    let addr = listener.local_addr().expect("读取监听地址");

    let server = async {
        let (stream, _) = listener.accept().await?;
        let mut tls = acceptor.accept(stream).await?;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        tls.write_all(b"hello").await?;
        tls.flush().await?;
        let mut buf = [0u8; 4];
        tls.read_exact(&mut buf).await?;
        Ok::<(), std::io::Error>(())
    };
    let client = async {
        let connector = tokio_rustls::TlsConnector::from(Arc::new(client_config));
        let stream = tokio::net::TcpStream::connect(addr).await?;
        let server_name =
            rustls::pki_types::ServerName::try_from("crish-remote").expect("常量域名恒合法");
        let mut tls = connector.connect(server_name, stream).await?;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut buf = [0u8; 5];
        tls.read_exact(&mut buf).await?;
        tls.write_all(b"pong").await?;
        tls.flush().await?;
        Ok::<(), std::io::Error>(())
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let (r1, r2) = tokio::join!(server, client);
        r1.is_ok() && r2.is_ok()
    })
    .await
    .unwrap_or_default()
}
