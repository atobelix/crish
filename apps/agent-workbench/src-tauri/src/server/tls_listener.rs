//! TLS 监听适配器（axum `Listener` 实现）。
//!
//! 0.8 仅对 `tokio::net::TcpListener` 预置
//! `SocketAddr: Connected<IncomingStream<TcpListener>>`——自定义 Listener
//! 必须显式实现 [axum::extract::connect_info::Connected]（见 [super] 的 serve
//! 接线说明），否则 `into_make_service_with_connect_info::<SocketAddr>` 编译
//! 不通过；限速仅挂 REST /v1/pair，ws.rs 配对升级路径不受影响。

use std::net::SocketAddr;
use std::time::Duration;

/// TLS 握手超时。
///
/// 握手在 accept 循环内串行等待：不设上限时，任意客户端建立 TCP 连接后不发
/// 握手数据即可永久挂死循环，后续所有连接（配对、事件推送）全部无法进入
/// ——局域网内零门槛 DoS。正常握手在毫秒级完成，5s 已是极宽松上界。
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) struct TlsListener {
    inner: tokio::net::TcpListener,
    acceptor: tokio_rustls::TlsAcceptor,
}

impl TlsListener {
    pub(super) fn new(inner: tokio::net::TcpListener, acceptor: tokio_rustls::TlsAcceptor) -> Self {
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
            match tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await {
                Ok(Ok(tls)) => return (tls, addr),
                Ok(Err(error)) => {
                    // T-04 语义落点：明文 ws/HTTP 请求或错误指纹客户端 →
                    // TLS 层拒绝（服务端不回应任何 ws:// 握手，D5 §2.1）；
                    // 拒绝不终止 serve，继续接受下一条连接
                    tracing::warn!(
                        target: "server",
                        %addr,
                        "TLS 握手失败（明文请求或证书不被信任）：{error}"
                    );
                }
                Err(_) => {
                    // 超时即判定为 Slowloris 探测，丢弃该连接（stream 随 drop 关闭）
                    tracing::warn!(
                        target: "server",
                        %addr,
                        timeout_ms = TLS_HANDSHAKE_TIMEOUT.as_millis(),
                        "TLS 握手超时，已丢弃连接"
                    );
                }
            }
        }
    }
}
