use anyhow::Result;
use conex_relay::account::HttpAccountVerifier;
use conex_relay::server::{build_app, config_from_env, serve, AppState};
use std::sync::Arc;
use tracing::info;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "conex_relay=info,tower_http=warn".into()),
        )
        .init();

    let (bind, config) = config_from_env()?;
    let auth_base_url = config.auth_base_url.clone();
    let public_relay_url = config.public_relay_url.clone();
    let account = Arc::new(HttpAccountVerifier::new(auth_base_url.clone()));
    let state = Arc::new(AppState::new(config, account));

    let listener = tokio::net::TcpListener::bind(bind).await?;
    info!(
        target: "relay",
        bind = %bind,
        auth = %auth_base_url,
        public = %public_relay_url,
        "conex relay listening"
    );
    serve(listener, build_app(state)).await
}
