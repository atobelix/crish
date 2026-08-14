//! 连接配置域（SR-04 拆分 · engine_provider.rs → engine_provider/connection.rs）
//!
//! 承载 HTTP 客户端构造与连接级超时/keepalive 配置（D1 §3.3 连接配置表）。
//! 头钉：SR-04 · 拆分 · ≠ EL（结构性搬移，不改语义）。

use std::time::Duration;

/// 连接配置覆盖面（D1 §3.3 连接配置表）：None 字段 = 默认值
/// （connect_timeout 10s / tcp_keepalive 30s / h2 ping 30s+5s）；
/// 测试装配可传参覆盖（短超时 / 关 keepalive——04 §2.3 可传参面）。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ClientConnectionConfig {
    /// 建连超时（默认 10s；reqwest 默认 30s 过长）
    pub connect_timeout: Option<Duration>,
    /// TCP keepalive（默认 30s；半开连接 2-3 探针周期内 RST）
    pub tcp_keepalive: Option<Duration>,
    /// HTTP/2 PING 间隔（默认 30s；h2 静默挂起对抗）
    pub http2_keep_alive_interval: Option<Duration>,
    /// HTTP/2 PING 无响应判定超时（默认 5s；须 interval>0 才生效）
    pub http2_keep_alive_timeout: Option<Duration>,
}

impl Default for ClientConnectionConfig {
    fn default() -> Self {
        Self {
            connect_timeout: None,
            tcp_keepalive: None,
            http2_keep_alive_interval: None,
            http2_keep_alive_timeout: None,
        }
    }
}

impl ClientConnectionConfig {
    /// 默认连接配置（D1 §3.3 / 04 §2.3 连接配置表）
    pub(crate) fn defaults() -> Self {
        Self {
            connect_timeout: Some(Duration::from_secs(10)),
            tcp_keepalive: Some(Duration::from_secs(30)),
            http2_keep_alive_interval: Some(Duration::from_secs(30)),
            http2_keep_alive_timeout: Some(Duration::from_secs(5)),
        }
    }

    /// 解析生效配置：None 字段 → 默认值（单测断言字段级生效面）
    pub(crate) fn resolve(options: Option<ClientConnectionConfig>) -> ClientConnectionConfig {
        let defaults = Self::defaults();
        match options {
            None => defaults,
            Some(overrides) => ClientConnectionConfig {
                connect_timeout: overrides
                    .connect_timeout
                    .or(defaults.connect_timeout),
                tcp_keepalive: overrides.tcp_keepalive.or(defaults.tcp_keepalive),
                http2_keep_alive_interval: overrides
                    .http2_keep_alive_interval
                    .or(defaults.http2_keep_alive_interval),
                http2_keep_alive_timeout: overrides
                    .http2_keep_alive_timeout
                    .or(defaults.http2_keep_alive_timeout),
            },
        }
    }
}

/// 生产 HTTP 客户端构造（D1 §3.3 / 04 §2.3 单点封装；engine.rs 生产
/// 装配点唯一替换——其余测试域 Client::new 保持不动，最小改动面）。
///
/// connect_timeout 10s / tcp_keepalive 30s / h2 ping 30s+5s；**不设总 .timeout()**
/// （流式长输出不被总超时误杀，请求级超时由双段超时承担）；pool_idle_timeout
/// 保持默认 90s。测试装配经 [ClientConnectionConfig] 传参覆盖。
pub(crate) fn build_http_client(options: Option<ClientConnectionConfig>) -> reqwest::Client {
    let resolved = ClientConnectionConfig::resolve(options);
    // resolve 恒填充默认值（None 字段 → 默认），unwrap 不会触发；显式 expect
    // 而非 unwrap_or——重复常量有漂移风险，报错指向 resolve。
    reqwest::Client::builder()
        .connect_timeout(resolved.connect_timeout.expect("连接配置解析后恒有默认值"))
        .tcp_keepalive(resolved.tcp_keepalive.expect("连接配置解析后恒有默认值"))
        .http2_keep_alive_interval(
            resolved
                .http2_keep_alive_interval
                .expect("连接配置解析后恒有默认值"),
        )
        .http2_keep_alive_timeout(
            resolved
                .http2_keep_alive_timeout
                .expect("连接配置解析后恒有默认值"),
        )
        .build()
        .expect("reqwest 客户端构造")
}
