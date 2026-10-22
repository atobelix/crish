//! 域名门禁测试套件与 Mock 设施

mod policy;
mod resolver;
mod transport;

use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;

use crate::cdp::error::CdpError;
use crate::gate::formal::FormalDomainGate;
use crate::gate::transport::SetBlockedSender;
use crate::gate::types::{GateClock, HostResolver};

/// 假 resolver：任何主机名解析到公网地址（确定性——不依赖 CI 真实 DNS）。
#[derive(Debug, Clone, Copy)]
pub(crate) struct AlwaysPublicResolver;

impl HostResolver for AlwaysPublicResolver {
    fn resolve(&self, _host: &str) -> Result<Vec<IpAddr>, String> {
        Ok(vec!["93.184.216.34".parse().expect("字面量 IP")])
    }
}

/// 假 resolver：解析失败（fail-closed 策略测试面）。
#[derive(Debug, Clone, Copy)]
pub(crate) struct FailingResolver;

impl HostResolver for FailingResolver {
    fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, String> {
        Err(format!("NXDOMAIN：{host}"))
    }
}

/// 假 resolver：返回固定地址列表（多 A 记录 / 内网解析场景）。
#[derive(Debug, Clone)]
pub(crate) struct MultiIpResolver(pub(crate) Vec<IpAddr>);

impl HostResolver for MultiIpResolver {
    fn resolve(&self, _host: &str) -> Result<Vec<IpAddr>, String> {
        Ok(self.0.clone())
    }
}

/// 序列化假 resolver：按调用次数依次返回预设结果（重绑定模拟：
/// 首次公网 IP、随后解析到内网）+ 调用计数（断言每动作一次解析）。
#[derive(Debug, Default)]
pub(crate) struct SequenceResolver {
    results: Mutex<std::collections::VecDeque<Result<Vec<IpAddr>, String>>>,
    calls: AtomicUsize,
}

impl SequenceResolver {
    pub(crate) fn new(results: Vec<Result<Vec<IpAddr>, String>>) -> Self {
        SequenceResolver {
            results: Mutex::new(results.into()),
            calls: AtomicUsize::new(0),
        }
    }

    pub(crate) fn call_count(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl HostResolver for SequenceResolver {
    fn resolve(&self, _host: &str) -> Result<Vec<IpAddr>, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.results
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pop_front()
            .unwrap_or_else(|| Err("序列耗尽".to_string()))
    }
}

/// 可控时钟（60s 窗口测试注入）。
#[derive(Debug, Default)]
pub(crate) struct MockClock {
    now: AtomicU64,
}

impl MockClock {
    pub(crate) fn advance(&self, ms: u64) {
        self.now.fetch_add(ms, Ordering::SeqCst);
    }
}

impl GateClock for MockClock {
    fn now_ms(&self) -> u64 {
        self.now.load(Ordering::SeqCst)
    }
}

pub(crate) fn gate(allow: &[&str], block: &[&str]) -> FormalDomainGate {
    FormalDomainGate::with_resolver(
        &allow.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        &block.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        Arc::new(AlwaysPublicResolver),
    )
    .expect("门禁构造失败")
}

pub(crate) fn denied(g: &FormalDomainGate, url: &str) -> Option<String> {
    match crate::action::gate::DomainGate::check(g, url) {
        Ok(()) => None,
        Err(d) => Some(d.reason),
    }
}

/// 简化 glob 匹配（`*` 通配任意序列；模拟 Chromium 阻断模式匹配口径）。
pub(crate) fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (n, m) = (p.len(), t.len());
    let mut dp = vec![vec![false; m + 1]; n + 1];
    dp[0][0] = true;
    for i in 1..=n {
        if p[i - 1] == '*' {
            dp[i][0] = dp[i - 1][0];
        }
    }
    for i in 1..=n {
        for j in 1..=m {
            if p[i - 1] == '*' {
                dp[i][j] = dp[i - 1][j] || dp[i][j - 1];
            } else {
                dp[i][j] = dp[i - 1][j - 1] && p[i - 1] == t[j - 1];
            }
        }
    }
    dp[n][m]
}

/// mock 发送面：记录每次下发的阻断清单。
#[derive(Debug, Default)]
pub(crate) struct RecordingSender {
    pub(crate) calls: Arc<Mutex<Vec<Vec<String>>>>,
}

#[async_trait]
impl SetBlockedSender for RecordingSender {
    async fn set_blocked_urls(&self, urls: &[String]) -> Result<(), CdpError> {
        self.calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(urls.to_vec());
        Ok(())
    }
}
