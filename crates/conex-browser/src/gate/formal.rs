//! 正式域名门禁核心结构体与配置（17 §4.1/§4.2/§4.3）

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};

use crate::gate::pattern::Pattern;
use crate::gate::segments::{is_local_hostname, is_loopback_ip, is_reserved};
use crate::gate::types::{GateClock, HostResolver, SystemClock, SystemResolver, REBINDING_WINDOW};

/// 正式域名门禁（17 §4.1/§4.2/§4.3 全流程 + R-11 传输层接线面）。
///
/// - §4.1 默认策略：白名单为空 = 全允许（限公共互联网）；非空 = 白名单外 Deny；
/// - §4.2 通配符语义（R-7 定死）；黑名单命中不可豁免（优先于白名单）；
/// - §4.3 判定：scheme 门禁 → IP 字面量段表（不触发 DNS）→ 主机名解析级校验
///   （fail-closed，白名单显式命中 = 显式信任跳过解析）→ 60s 重绑定窗口复查；
/// - R-11 传输层：`blocked_urls`/`TransportGate` 段表程序化生成与下发。
#[derive(Clone)]
pub struct FormalDomainGate {
    pub(crate) allowlist: Vec<Pattern>,
    pub(crate) blocklist: Vec<Pattern>,
    pub(crate) resolver: Arc<dyn HostResolver>,
    pub(crate) fail_closed_resolve: bool,
    pub(crate) clock: Arc<dyn GateClock>,
    /// host → 上次校验通过时刻（60s 重绑定窗口起点；§4.3 步骤 4）。
    pub(crate) window: Arc<Mutex<HashMap<String, u64>>>,
}

impl std::fmt::Debug for FormalDomainGate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FormalDomainGate")
            .field("allowlist", &self.allowlist)
            .field("blocklist", &self.blocklist)
            .field("fail_closed_resolve", &self.fail_closed_resolve)
            .field(
                "window_entries",
                &self.window.lock().map(|w| w.len()).unwrap_or(0),
            )
            .finish_non_exhaustive()
    }
}

impl FormalDomainGate {
    /// 构造（配置校验期：非法模式 → Err；默认系统 resolver + fail-closed +
    /// 系统时钟 + 60s 窗口）。
    pub fn new(allowlist: &[String], blocklist: &[String]) -> Result<Self, String> {
        Self::with_parts(
            allowlist,
            blocklist,
            Arc::new(SystemResolver),
            true,
            Arc::new(SystemClock::default()),
        )
    }

    /// 注入解析器构造（测试注入假解析；生产保持默认系统 resolver）。
    pub fn with_resolver(
        allowlist: &[String],
        blocklist: &[String],
        resolver: Arc<dyn HostResolver>,
    ) -> Result<Self, String> {
        Self::with_parts(
            allowlist,
            blocklist,
            resolver,
            true,
            Arc::new(SystemClock::default()),
        )
    }

    /// 注入时钟构造（测试注入可控时钟验证 60s 窗口语义）。
    pub fn with_clock(
        allowlist: &[String],
        blocklist: &[String],
        clock: Arc<dyn GateClock>,
    ) -> Result<Self, String> {
        Self::with_parts(allowlist, blocklist, Arc::new(SystemResolver), true, clock)
    }

    /// 全参数构造（内部聚合）。
    pub(crate) fn with_parts(
        allowlist: &[String],
        blocklist: &[String],
        resolver: Arc<dyn HostResolver>,
        fail_closed_resolve: bool,
        clock: Arc<dyn GateClock>,
    ) -> Result<Self, String> {
        let allowlist = allowlist
            .iter()
            .map(|p| Pattern::parse(p))
            .collect::<Result<Vec<_>, _>>()?;
        let blocklist = blocklist
            .iter()
            .map(|p| Pattern::parse(p))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(FormalDomainGate {
            allowlist,
            blocklist,
            resolver,
            fail_closed_resolve,
            clock,
            window: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// 解析失败策略开关（默认 fail-closed：解析失败即阻断；false = fail-open）。
    pub fn with_fail_closed_resolve(mut self, fail_closed: bool) -> Self {
        self.fail_closed_resolve = fail_closed;
        self
    }

    /// 60s 重绑定窗口状态（§4.3 步骤 4，R-11）：主机是否处于校验通过后的
    /// 复查窗口内。窗口内每动作一次重新解析并校验（实现不缓存校验结果）。
    pub fn within_rebinding_window(&self, host: &str) -> bool {
        let now = self.clock.now_ms();
        let window_ms = REBINDING_WINDOW.as_millis() as u64;
        self.window
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(host)
            .is_some_and(|&t| now.saturating_sub(t) < window_ms)
    }

    /// 校验通过后记录窗口起点（并惰性清除过期条目，防表无限增长）。
    pub(crate) fn record_validated(&self, host: &str) {
        let now = self.clock.now_ms();
        let window_ms = REBINDING_WINDOW.as_millis() as u64;
        let mut guard = self.window.lock().unwrap_or_else(|p| p.into_inner());
        guard.retain(|_, &mut t| now.saturating_sub(t) < window_ms);
        guard.insert(host.to_string(), now);
    }

    /// IP 判定（§4.2/§4.3 步骤 2）：黑名单优先 → 本机回环默认放行（本地测试页
    /// 场景，§4.3 口径）→ 其余保留段（白名单显式条目可豁免）→ 白名单非空时
    /// 未命中拒绝。
    pub(crate) fn allow_ip(&self, ip: &IpAddr) -> bool {
        if self.blocklist.iter().any(|p| p.matches_ip(ip)) {
            return false;
        }
        if is_loopback_ip(ip) {
            return true;
        }
        let reserved = is_reserved(ip);
        if reserved && !self.allowlist.iter().any(|p| p.matches_ip(ip)) {
            return false;
        }
        if self.allowlist.is_empty() {
            return true;
        }
        self.allowlist
            .iter()
            .any(|p| p.matches_ip(ip) || matches!(p, Pattern::Any))
    }

    /// 解析结果是否命中保留/内网段（§4.3 步骤 3 判定核：任一地址命中即阻断，
    /// 含回环——非 localhost 主机名解析到回环即 SSRF）。
    pub(crate) fn resolved_to_internal(&self, host: &str) -> Result<Vec<IpAddr>, String> {
        if is_local_hostname(host) {
            return Ok(Vec::new());
        }
        self.resolver
            .resolve(host)
            .map_err(|e| format!("{host}：{e}"))
    }

    pub(crate) fn allow_host(&self, host: &str) -> bool {
        if self.blocklist.iter().any(|p| p.matches_host(host)) {
            return false;
        }
        if self.allowlist.is_empty() {
            return true;
        }
        self.allowlist.iter().any(|p| p.matches_host(host))
    }
}
