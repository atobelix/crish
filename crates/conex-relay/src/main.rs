use anyhow::Result;
use conex_relay::server::RelayServer;
use std::env;
use std::net::SocketAddr;
use tracing::info;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();

    let port: u16 = env::var("RELAY_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8766);

    // 签名密钥必填（audit-repair-202609 T15）：缺失或过短直接拒绝启动，
    // 杜绝以源码内置默认密钥对外服务（任何人可据此伪造票据）。
    let secret = env::var("RELAY_SECRET").unwrap_or_default();
    if secret.len() < 32 {
        return Err(anyhow::anyhow!(
            "RELAY_SECRET must be set to at least 32 bytes for ticket signing (got {} bytes)",
            secret.len()
        ));
    }

    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    info!("Starting Conex Relay Server on port {}", port);
    let server = RelayServer::new(addr, secret);
    server.run().await
}
