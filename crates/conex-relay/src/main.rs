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

    let secret = env::var("RELAY_SECRET").ok();
    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    info!("Starting Conex Relay Server on port {}", port);
    let server = RelayServer::new(addr, secret);
    server.run().await
}
