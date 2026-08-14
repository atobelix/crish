//! 域名门禁正式实现（维度 17 §4，R-7/R-11 接线位）
//!
//! **权威声明（R-7）**：`DomainGate` 结构与匹配语义以维度 17 §4 为全项目唯一权威；
//! 本模块即该权威的**正式实现**（M7 接线位，`conex-browser/src/gate.rs`），
//! 补齐 browser-tools `MvpDomainGate` 模块头登记的未接线面：
//! ① 60s DNS 重绑定窗口重复校验（§4.3 步骤 4，R-11）；
//! ② 传输层 `Network.setBlockedURLs`（§4.3 传输层，R-11）。
//!
//! 结构（17 §4.2 文档结构 DomainGate ↔ 本模块 `FormalDomainGate`，命名避让既有 trait）：
//! - 匹配语义（§4.2 定死）：`example.com` = 根域 + 任意子域；`*.example.com` =
//!   任意子域（不含根域）；`*`/`**` = 任意；IP 字面量可入白/黑名单；
//!   TLD 通配（`example.*`）配置期拒绝；黑名单命中不可豁免（含 full-access）；
//! - 判定流程（§4.3）：scheme 门禁 → IP 字面量段表（不触发 DNS）→
//!   主机名解析级校验（fail-closed）→ 60s 重绑定窗口每动作复查；
//! - 传输层（§4.3 传输层，R-11）：[`blocked_urls`] 段表程序化生成
//!   （保留/内网段 + 云元数据 `169.254.169.254` + 链路本地），
//!   [`TransportGate`] 经 [`SetBlockedSender`] 下发 + iframe 导航订阅兜底重挂。
//!
//! **接线点登记（并行域，不在本文件实施）**：
//! - 工具层注入（P0-2 配置入口落地）：`BrowserToolsConfig.domain_allowlist/
//!   domain_blocklist`（conex-browser-tools/src/lib.rs）——`config.gate`
//!   未注入时由 `register_browser_tools` 构造本正式实现（05 文档方案 A
//!   注入语义更新：缺省兜底从 `MvpDomainGate` 升级为本实现，非法模式
//!   注册期拒绝）；显式注入仍优先（引擎侧装配任意 `DomainGate` 实现，
//!   含 `MvpDomainGate`，配置列表被忽略）；
//! - 引擎侧注入：`FormalDomainGate::new(allowlist, blocklist)` 装箱为
//!   `Arc<dyn DomainGate>`，经 `BrowserToolsConfig.gate` 注入工具层
//!   （27 方案 S4 会话槽 `BrowserSlot::gate()`，apps/agent-workbench/
//!   src-tauri/src/browser/mod.rs:263 现装配空白名单 `MvpDomainGate`——
//!   用户配置列表值源接线登记：会话设置面 P1）；
//! - 动作执行器注入：`ActionExecutor::with_gate`（action/mod.rs:328）；
//! - 传输层会话接线：`TransportGate::apply` 于会话启动/重连恢复（11 §2.4
//!   拦截重挂清单第 5 项）/门禁配置变更时调用；`TransportGate::on_frame_navigated`
//!   于 BrowserSession 事件面 `BrowserEvent::NavigationStarted`（11 §5.1，
//!   bus.rs:133）订阅内调用（iframe 新建/导航兜底，幂等重挂）；
//! - `SetBlockedSender` 生产实现：BrowserSession `send_page` 发送面
//!   （`Network.setBlockedURLs` + [`SetBlockedURLsParams`]）。
//!
//! **与 MvpDomainGate 的关系（05 文档方案 A，P0-2 注入语义更新）**：
//! browser-tools 的 `MvpDomainGate` 保持 MVP 实现供显式注入（引擎侧既有
//! 权线不破坏）；`config.gate` 未注入时，tools 侧缺省兜底已升级为构造
//! 本正式实现（从配置列表注入 allowlist/blocklist），两者匹配语义同源
//! （R-7 定死）。

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use url::Url;

use crate::action::gate::{DomainGate, GateDenial};
use crate::cdp::domains::SetBlockedURLsParams;
use crate::cdp::error::CdpError;

/// 60s 重绑定窗口（§4.3 步骤 4，R-11：校验通过后窗口内每动作一次复查）。
pub const REBINDING_WINDOW: Duration = Duration::from_secs(60);

/// 主机名解析器抽象（§4.3 步骤 3；测试注入假解析，生产走系统 resolver）。
pub trait HostResolver: Send + Sync {
    /// 解析主机名 → 全部地址（仅解析不连接；失败返回原因）。
    fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, String>;
}

/// 系统 resolver（`ToSocketAddrs`：A/AAAA 解析，不发起连接）。
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemResolver;

impl HostResolver for SystemResolver {
    fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, String> {
        (host, 0)
            .to_socket_addrs()
            .map(|iter| iter.map(|sa| sa.ip()).collect())
            .map_err(|e| e.to_string())
    }
}

/// 时钟抽象（60s 重绑定窗口判定；测试注入可控时钟）。
pub trait GateClock: Send + Sync {
    /// 当前时刻（毫秒，单调起点即可，仅用于差值比较）。
    fn now_ms(&self) -> u64;
}

/// 系统时钟（进程启动锚定的单调毫秒）。
#[derive(Debug, Clone, Copy)]
pub struct SystemClock {
    start: Instant,
}

impl Default for SystemClock {
    fn default() -> Self {
        SystemClock {
            start: Instant::now(),
        }
    }
}

impl GateClock for SystemClock {
    fn now_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }
}

/// 门禁模式条目（纯域名层，不匹配路径/query，§4.2）。
#[derive(Debug, Clone, PartialEq, Eq)]
enum Pattern {
    /// `example.com`：根域 + 任意子域
    Root(String),
    /// `*.example.com`：任意子域（不含根域）
    Sub(String),
    /// `*` / `**`：任意域名
    Any,
    /// IP 字面量（白名单/黑名单显式条目，§4.2）
    Ip(IpAddr),
}

impl Pattern {
    /// 解析模式条目；TLD 通配/多星号/非法字符 → Err（配置校验期报错，§4.2）。
    fn parse(raw: &str) -> Result<Self, String> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Err("空模式".to_string());
        }
        if raw == "*" || raw == "**" {
            return Ok(Pattern::Any);
        }
        // IP 字面量优先（127.0.0.1 / ::1 可入白名单/黑名单，§4.2）
        if let Ok(ip) = raw.parse::<IpAddr>() {
            return Ok(Pattern::Ip(ip));
        }
        if raw.contains('*') && !raw.starts_with("*.") {
            return Err(format!("非法通配模式（仅允许 * 或 *. 前缀）：{raw}"));
        }
        if let Some(rest) = raw.strip_prefix("*.") {
            if rest.is_empty() {
                return Err("*. 后缺少域名".to_string());
            }
            validate_host_part(rest)?;
            return Ok(Pattern::Sub(normalize_host(rest)?));
        }
        validate_host_part(raw)?;
        Ok(Pattern::Root(normalize_host(raw)?))
    }

    /// 主机名是否命中（host 已小写规范化，无尾点）。
    fn matches_host(&self, host: &str) -> bool {
        match self {
            Pattern::Any => true,
            Pattern::Root(d) => host == d || host.ends_with(&format!(".{d}")),
            Pattern::Sub(d) => host.ends_with(&format!(".{d}")),
            Pattern::Ip(_) => false,
        }
    }

    fn matches_ip(&self, ip: &IpAddr) -> bool {
        matches!(self, Pattern::Ip(expected) if expected == ip)
    }
}

/// 主机部分合法性（仅字母/数字/点/连字符；IDN 经 `url` crate 解析面
/// 已转 punycode，配置条目维持 ASCII 面）。
fn validate_host_part(host: &str) -> Result<(), String> {
    if host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        Ok(())
    } else {
        Err(format!("主机含非法字符（配置条目仅 ASCII）：{host}"))
    }
}

/// 主机规范化（小写 + 去尾点，§4.2 匹配前处理）。
fn normalize_host(host: &str) -> Result<String, String> {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return Err("空主机".to_string());
    }
    Ok(host)
}

// ---------------------------------------------------------------------------
// 保留/内网段表（§4.3 判定与传输层阻断同源，单点维护）
// ---------------------------------------------------------------------------

/// IPv4 保留/内网段表（§4.3；含 CGNAT 100.64/10 与基准段 198.18/15 加固项）。
const IPV4_SEGMENTS: &[(Ipv4Addr, u8)] = &[
    (Ipv4Addr::new(0, 0, 0, 0), 8),
    (Ipv4Addr::new(10, 0, 0, 0), 8),
    (Ipv4Addr::new(127, 0, 0, 0), 8),
    (Ipv4Addr::new(172, 16, 0, 0), 12),
    (Ipv4Addr::new(192, 168, 0, 0), 16),
    (Ipv4Addr::new(169, 254, 0, 0), 16),
    (Ipv4Addr::new(100, 64, 0, 0), 10),
    (Ipv4Addr::new(198, 18, 0, 0), 15),
];

/// IPv6 保留/内网段表（§4.3；2001:db8::/32 文档段按常规对待，不列入）。
const IPV6_SEGMENTS: &[(Ipv6Addr, u8)] = &[
    (Ipv6Addr::LOCALHOST, 128),
    (Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 0), 7),
    (Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 0), 10),
    (Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0, 0), 96),
];

/// IPv4 段命中判定（CIDR 前缀比对）。
fn ipv4_reserved(ip: &Ipv4Addr) -> bool {
    let value = u32::from(*ip);
    IPV4_SEGMENTS.iter().any(|(net, prefix)| {
        let mask = if *prefix == 0 {
            0
        } else {
            u32::MAX << (32 - *prefix as u32)
        };
        u32::from(*net) & mask == value & mask
    })
}

/// IPv6 段命中判定（CIDR 前缀比对）。
fn ipv6_reserved(ip: &Ipv6Addr) -> bool {
    let value = u128::from(*ip);
    IPV6_SEGMENTS.iter().any(|(net, prefix)| {
        if *prefix == 128 {
            u128::from(*net) == value
        } else {
            let shift = 128 - *prefix as u32;
            u128::from(*net) >> shift == value >> shift
        }
    })
}

/// 保留/内网段统一判定（主机名解析校验面；回环亦属阻断面——非 localhost
/// 主机名解析到回环即 SSRF，不享字面量回环放行面）。
fn is_reserved(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => ipv4_reserved(v4),
        IpAddr::V6(v6) => ipv6_reserved(v6),
    }
}

/// 本机回环判定（IP 字面量默认放行面）：IPv4 127.0.0.0/8、IPv6 ::1、
/// IPv4 映射回环（::ffff:127.x.x.x）。
fn is_loopback_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.octets()[0] == 127,
        IpAddr::V6(v6) => {
            v6.is_loopback() || v4_mapped_of(v6).is_some_and(|v4| v4.octets()[0] == 127)
        }
    }
}

/// 本机主机名判定（默认放行面，本地测试页场景）：localhost 及其常见变体。
fn is_local_hostname(host: &str) -> bool {
    host == "localhost" || host == "localhost.localdomain" || host == "localhost.local"
}

/// ::ffff:0:0/96 解包（IPv4 映射地址 → 映射目标；非映射返回 None）。
fn v4_mapped_of(ip: &Ipv6Addr) -> Option<Ipv4Addr> {
    let seg = ip.segments();
    if seg[..6] == [0, 0, 0, 0, 0, 0xffff] {
        Some(Ipv4Addr::new(
            (seg[6] >> 8) as u8,
            (seg[6] & 0xff) as u8,
            (seg[7] >> 8) as u8,
            (seg[7] & 0xff) as u8,
        ))
    } else {
        None
    }
}

/// IPv4 段 → URL 阻断模式（§4.3 传输层：/8 单模式；细段逐 /16 通配展开，双协议 http/https 阻断）。
fn ipv4_blocked_patterns(net: &Ipv4Addr, prefix: u8) -> Vec<String> {
    let first = u32::from(*net);
    let a = (first >> 24) as u8;
    if prefix <= 8 {
        return vec![format!("http://{a}.*"), format!("https://{a}.*")];
    }
    let host_bits = 32 - prefix as u32;
    let mask = (1u32 << host_bits) - 1;
    let end = first | mask;
    let b_first = ((first >> 16) & 0xFF) as u8;
    let b_last = ((end >> 16) & 0xFF) as u8;
    (b_first..=b_last)
        .flat_map(|b| vec![format!("http://{a}.{b}.*"), format!("https://{a}.{b}.*")])
        .collect()
}

/// IPv6 段 → URL 阻断模式（§4.3 传输层：精确 /128、IPv4 映射 /96 特例、
/// 其余按 4-bit 边界展开为前缀通配，双协议 http/https 阻断）。
fn ipv6_blocked_patterns(net: &Ipv6Addr, prefix: u8) -> Vec<String> {
    let value = u128::from(*net);
    if prefix == 128 {
        return vec![format!("http://[{net}]*"), format!("https://[{net}]*")];
    }
    if prefix == 96 && (value >> 32) == 0xffff {
        return vec![
            "http://[::ffff:*".to_string(),
            "https://[::ffff:*".to_string(),
        ];
    }
    // 非精确段：固定完整 nibble 前缀 + 次 nibble 范围通配
    let free_bits_in_nibble = (4 - prefix % 4) % 4;
    let count = 1u32 << free_bits_in_nibble;
    let full_fixed_bits = prefix - prefix % 4;
    let prefix_hex = if full_fixed_bits > 0 {
        format!("{:x}", value >> (128 - full_fixed_bits as u32))
    } else {
        String::new()
    };
    let base_nibble = (value >> (128 - full_fixed_bits as u32 - 4)) & 0xF;
    (0..count)
        .flat_map(|i| {
            vec![
                format!("http://[{prefix_hex}{:x}*", (base_nibble as u32) + i),
                format!("https://[{prefix_hex}{:x}*", (base_nibble as u32) + i),
            ]
        })
        .collect()
}

/// 传输层阻断模式程序化生成（§4.3 传输层，R-11）：保留/内网段全部
/// IPv4/IPv6 段的 URL 形态 + 云元数据端点（`169.254.169.254`）显式阻断
/// + 链路本地（`169.254.0.0/16`），全覆盖 http 与 https 双协议。
pub fn blocked_urls() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (net, prefix) in IPV4_SEGMENTS {
        out.extend(ipv4_blocked_patterns(net, *prefix));
    }
    for (net, prefix) in IPV6_SEGMENTS {
        out.extend(ipv6_blocked_patterns(net, *prefix));
    }
    // 云元数据端点显式阻断（§4.3；虽已含于 169.254.0.0/16，显式声明便于审计）
    out.push("http://169.254.169.254/*".to_string());
    out.push("https://169.254.169.254/*".to_string());
    out.sort();
    out.dedup();
    out
}

/// `Network.setBlockedURLs` 发送面抽象（传输层接线点：生产实现 = BrowserSession
/// 发送面，测试注入 mock 发送面）。
#[async_trait]
pub trait SetBlockedSender: Send + Sync {
    /// 下发阻断清单（会话级，覆盖全部 frame 请求）。
    async fn set_blocked_urls(&self, urls: &[String]) -> Result<(), CdpError>;
}

/// 传输层门禁（R-11 §4.3 传输层）：持有段表生成的阻断清单，经发送面应用，
/// 并提供 iframe 导航订阅兜底（重挂幂等）。
#[derive(Debug, Clone)]
pub struct TransportGate {
    patterns: Vec<String>,
}

impl Default for TransportGate {
    fn default() -> Self {
        Self::new()
    }
}

impl TransportGate {
    /// 新建（阻断清单 = 段表程序化生成结果）。
    pub fn new() -> Self {
        TransportGate {
            patterns: blocked_urls(),
        }
    }

    /// 当前阻断清单（诊断/审计面）。
    pub fn patterns(&self) -> &[String] {
        &self.patterns
    }

    /// 构造 `Network.setBlockedURLs` 参数（发送面复用既有参数类型）。
    pub fn to_params(&self) -> SetBlockedURLsParams {
        SetBlockedURLsParams {
            urls: self.patterns.clone(),
        }
    }

    /// 全量应用（会话启动 / 门禁配置变更时调用；覆盖全部页面请求含 iframe）。
    pub async fn apply(&self, sender: &dyn SetBlockedSender) -> Result<(), CdpError> {
        sender.set_blocked_urls(&self.patterns).await
    }

    /// iframe 导航订阅兜底（§4.3 传输层订阅面）：`BrowserEvent::NavigationStarted`
    /// （11 §5.1 含 frame）到达时对新建/导航 frame 重新应用——清单为会话级，
    /// 重挂幂等，覆盖主 URL 不变的 iframe 内网导航请求。
    pub async fn on_frame_navigated(&self, sender: &dyn SetBlockedSender) -> Result<(), CdpError> {
        self.apply(sender).await
    }
}

/// 正式域名门禁（17 §4.1/§4.2/§4.3 全流程 + R-11 传输层接线面）。
///
/// - §4.1 默认策略：白名单为空 = 全允许（限公共互联网）；非空 = 白名单外 Deny；
/// - §4.2 通配符语义（R-7 定死）；黑名单命中不可豁免（优先于白名单）；
/// - §4.3 判定：scheme 门禁 → IP 字面量段表（不触发 DNS）→ 主机名解析级校验
///   （fail-closed，白名单显式命中 = 显式信任跳过解析）→ 60s 重绑定窗口复查；
/// - R-11 传输层：`blocked_urls`/`TransportGate` 段表程序化生成与下发。
#[derive(Clone)]
pub struct FormalDomainGate {
    allowlist: Vec<Pattern>,
    blocklist: Vec<Pattern>,
    resolver: Arc<dyn HostResolver>,
    fail_closed_resolve: bool,
    clock: Arc<dyn GateClock>,
    /// host → 上次校验通过时刻（60s 重绑定窗口起点；§4.3 步骤 4）。
    window: Arc<Mutex<HashMap<String, u64>>>,
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
    fn with_parts(
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
    fn record_validated(&self, host: &str) {
        let now = self.clock.now_ms();
        let window_ms = REBINDING_WINDOW.as_millis() as u64;
        let mut guard = self.window.lock().unwrap_or_else(|p| p.into_inner());
        guard.retain(|_, &mut t| now.saturating_sub(t) < window_ms);
        guard.insert(host.to_string(), now);
    }

    /// IP 判定（§4.2/§4.3 步骤 2）：黑名单优先 → 本机回环默认放行（本地测试页
    /// 场景，§4.3 口径）→ 其余保留段（白名单显式条目可豁免）→ 白名单非空时
    /// 未命中拒绝。
    fn allow_ip(&self, ip: &IpAddr) -> bool {
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
    fn resolved_to_internal(&self, host: &str) -> Result<Vec<IpAddr>, String> {
        if is_local_hostname(host) {
            return Ok(Vec::new());
        }
        self.resolver
            .resolve(host)
            .map_err(|e| format!("{host}：{e}"))
    }

    fn allow_host(&self, host: &str) -> bool {
        if self.blocklist.iter().any(|p| p.matches_host(host)) {
            return false;
        }
        if self.allowlist.is_empty() {
            return true;
        }
        self.allowlist.iter().any(|p| p.matches_host(host))
    }
}

impl DomainGate for FormalDomainGate {
    fn check(&self, url: &str) -> Result<(), GateDenial> {
        let denial = |reason: String| GateDenial {
            url: url.to_string(),
            reason,
        };
        // ① scheme 门禁（§4.3 步骤 1；解析失败 fail-closed）
        let parsed = match Url::parse(url) {
            Ok(p) => p,
            Err(e) => return Err(denial(format!("URL 解析失败（fail-closed）：{e}"))),
        };
        match parsed.scheme() {
            "http" | "https" => {}
            "about" => {
                let page = parsed.path();
                if page == "blank" || page == "newtab" {
                    return Ok(());
                }
                return Err(denial(format!("scheme 门禁：about:{page} 不支持")));
            }
            other => {
                return Err(denial(format!("scheme 门禁：仅 http/https，收到 {other}")));
            }
        }
        // ② IP 字面量判定（§4.3 步骤 2：字面量不触发 DNS；本机回环默认放行，
        //    其余保留段命中除非白名单显式条目豁免——本机调试途径，§4.2）
        if let Some(host) = parsed.host() {
            match host {
                url::Host::Ipv4(ip) => {
                    if !self.allow_ip(&IpAddr::V4(ip)) {
                        return Err(denial(format!(
                            "IP 字面量命中保留/内网段或不在允许面：{ip}"
                        )));
                    }
                    return Ok(());
                }
                url::Host::Ipv6(ip) => {
                    if !self.allow_ip(&IpAddr::V6(ip)) {
                        return Err(denial(format!(
                            "IP 字面量命中保留/内网段或不在允许面：{ip}"
                        )));
                    }
                    return Ok(());
                }
                url::Host::Domain(_) => {}
            }
        }
        // ③ 主机名（§4.2 + §4.3 步骤 3 解析校验 + 步骤 4 重绑定窗口）
        let Some(host_str) = parsed.host_str() else {
            return Err(denial("URL 无主机（fail-closed）".to_string()));
        };
        let host = match normalize_host(host_str) {
            Ok(h) => h,
            Err(e) => return Err(denial(format!("主机规范化失败（fail-closed）：{e}"))),
        };
        if !self.allow_host(&host) {
            return Err(denial(format!("域名不在允许面：{host}")));
        }
        // 白名单显式命中 = 显式信任（含该域解析面，跳过解析校验）；默认面
        // （白名单为空，全允许限公共互联网）做解析级校验（SSRF，§4.3 步骤 3）
        if !self.allowlist.is_empty() {
            self.record_validated(&host);
            return Ok(());
        }
        // 解析失败策略：默认 fail-closed（阻断，裁决），`with_fail_closed_resolve
        // (false)` 可配 fail-open（解析失败放行，解析成功命中内网仍阻断）
        let ips = match self.resolved_to_internal(&host) {
            Ok(ips) => ips,
            Err(e) => {
                if self.fail_closed_resolve {
                    return Err(denial(format!("主机名解析失败（fail-closed 阻断）：{e}")));
                }
                self.record_validated(&host);
                return Ok(());
            }
        };
        let leaked: Vec<String> = ips
            .iter()
            .filter(|ip| is_reserved(ip))
            .map(|ip| ip.to_string())
            .collect();
        if leaked.is_empty() {
            // ④ 校验通过 → 记录 60s 窗口起点；窗口内每动作一次重新解析并校验
            //（本实现每次 check 均重新解析，不缓存校验结果——重绑定在第二次
            //  校验被拦截，R-11）
            self.record_validated(&host);
            return Ok(());
        }
        Err(denial(format!(
            "主机名解析到内网/保留地址（SSRF 面阻断）：{host} → {}",
            leaked.join(", ")
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    /// 假 resolver：任何主机名解析到公网地址（确定性——不依赖 CI 真实 DNS）。
    #[derive(Debug, Clone, Copy)]
    struct AlwaysPublicResolver;

    impl HostResolver for AlwaysPublicResolver {
        fn resolve(&self, _host: &str) -> Result<Vec<IpAddr>, String> {
            Ok(vec!["93.184.216.34".parse().expect("字面量 IP")])
        }
    }

    /// 假 resolver：解析失败（fail-closed 策略测试面）。
    #[derive(Debug, Clone, Copy)]
    struct FailingResolver;

    impl HostResolver for FailingResolver {
        fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, String> {
            Err(format!("NXDOMAIN：{host}"))
        }
    }

    /// 假 resolver：返回固定地址列表（多 A 记录 / 内网解析场景）。
    #[derive(Debug, Clone)]
    struct MultiIpResolver(Vec<IpAddr>);

    impl HostResolver for MultiIpResolver {
        fn resolve(&self, _host: &str) -> Result<Vec<IpAddr>, String> {
            Ok(self.0.clone())
        }
    }

    /// 序列化假 resolver：按调用次数依次返回预设结果（重绑定模拟：
    /// 首次公网 IP、随后解析到内网）+ 调用计数（断言每动作一次解析）。
    #[derive(Debug, Default)]
    struct SequenceResolver {
        results: std::sync::Mutex<std::collections::VecDeque<Result<Vec<IpAddr>, String>>>,
        calls: AtomicUsize,
    }

    impl SequenceResolver {
        fn new(results: Vec<Result<Vec<IpAddr>, String>>) -> Self {
            SequenceResolver {
                results: std::sync::Mutex::new(results.into()),
                calls: AtomicUsize::new(0),
            }
        }

        fn call_count(&self) -> usize {
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
    struct MockClock {
        now: AtomicU64,
    }

    impl MockClock {
        fn advance(&self, ms: u64) {
            self.now.fetch_add(ms, Ordering::SeqCst);
        }
    }

    impl GateClock for MockClock {
        fn now_ms(&self) -> u64 {
            self.now.load(Ordering::SeqCst)
        }
    }

    fn gate(allow: &[&str], block: &[&str]) -> FormalDomainGate {
        FormalDomainGate::with_resolver(
            &allow.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            &block.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            Arc::new(AlwaysPublicResolver),
        )
        .expect("门禁构造失败")
    }

    fn denied(g: &FormalDomainGate, url: &str) -> Option<String> {
        match g.check(url) {
            Ok(()) => None,
            Err(d) => Some(d.reason),
        }
    }

    /// T-5 默认策略：白名单为空 → 公共域名放行（解析到公网）；IP 字面量保留段
    /// 阻断；本机回环默认放行（本地测试页场景，§4.3 口径）。
    #[test]
    fn default_policy_blocks_reserved_ips() {
        let g = gate(&[], &[]);
        assert!(g.check("https://example.com").is_ok());
        assert!(g.check("https://www.example.com/a?b=1").is_ok());
        // 本机回环默认放行（127.0.0.0/8、::1、IPv4 映射回环；本地测试页场景）
        assert!(g.check("http://127.0.0.1:8080/").is_ok());
        assert!(g.check("http://[::1]/").is_ok());
        assert!(g.check("http://[::ffff:127.0.0.1]/").is_ok());
        for url in [
            "http://0.0.0.0/",
            "http://10.0.0.5/",
            "http://192.168.1.1/",
            "http://172.16.0.1/",
            "http://172.31.255.255/",
            "http://169.254.169.254/latest/meta-data/",
            "http://100.64.0.1/",
            "http://198.18.0.1/",
            "http://[fc00::1]/",
            "http://[fe80::1]/",
        ] {
            let reason = denied(&g, url).expect("应阻断");
            assert!(reason.contains("保留"), "命中段族应说明：{url} → {reason}");
        }
        // 非保留 IP 字面量（白名单为空默认放行，限公共互联网）
        assert!(g.check("http://8.8.8.8/").is_ok());
        assert!(g.check("http://[2001:4860:4860::8888]/").is_ok());
        // file:// 与 javascript: scheme 阻断
        assert!(denied(&g, "file:///C:/x").is_some());
        assert!(denied(&g, "javascript:alert(1)").is_some());
        // about 特例放行
        assert!(g.check("about:blank").is_ok());
        assert!(g.check("about:newtab").is_ok());
    }

    /// 评审 F10：localhost 类主机名默认放行（不触发解析）；黑名单显式命中
    /// 仍阻断（黑名单不可豁免）。
    #[test]
    fn localhost_and_loopback_default_allowed() {
        let g = gate(&[], &[]);
        assert!(g.check("http://localhost:8080/").is_ok());
        assert!(g.check("http://localhost.localdomain/").is_ok());
        let g = gate(&[], &["localhost"]);
        assert!(denied(&g, "http://localhost:8080/").is_some());
        let g = gate(&[], &["127.0.0.1"]);
        assert!(denied(&g, "http://127.0.0.1:8080/").is_some());
    }

    /// 评审 F10：主机名解析校验（§4.3 步骤 3）——解析到内网/保留段（含回环）
    /// 阻断（SSRF 面）；解析到公网放行。
    #[test]
    fn hostname_lookup_blocks_internal_resolution() {
        let g = gate(&[], &[]);
        assert!(g.check("https://any-public.example/").is_ok());
        let g = FormalDomainGate::with_resolver(
            &[],
            &[],
            Arc::new(MultiIpResolver(vec!["192.168.1.99".parse().unwrap()])),
        )
        .unwrap();
        let reason = denied(&g, "https://internal.example/").expect("应阻断");
        assert!(reason.contains("SSRF"), "说明：{reason}");
        // 解析到回环（非 localhost 主机名）→ 阻断（恶意 DNS 指向本机）
        let g = FormalDomainGate::with_resolver(
            &[],
            &[],
            Arc::new(MultiIpResolver(vec!["127.0.0.1".parse().unwrap()])),
        )
        .unwrap();
        let reason = denied(&g, "https://evil.example/").expect("应阻断");
        assert!(reason.contains("SSRF"), "说明：{reason}");
        // 多地址：任一命中保留段即阻断（DNS 多 A 记录场景）
        let g = FormalDomainGate::with_resolver(
            &[],
            &[],
            Arc::new(MultiIpResolver(vec![
                "93.184.216.34".parse().unwrap(),
                "10.0.0.1".parse().unwrap(),
            ])),
        )
        .unwrap();
        assert!(
            denied(&g, "https://mixed.example/").is_some(),
            "多地址含内网即阻断"
        );
    }

    /// 评审 F10：解析失败策略——默认 fail-closed（阻断）；`with_fail_closed_resolve
    /// (false)` 可配 fail-open（放行）。
    #[test]
    fn lookup_failure_fail_closed_by_default() {
        let g = FormalDomainGate::with_resolver(&[], &[], Arc::new(FailingResolver)).unwrap();
        let reason = denied(&g, "https://no-such-host.invalid/").expect("fail-closed 应阻断");
        assert!(reason.contains("fail-closed"), "说明：{reason}");
        let g = FormalDomainGate::with_resolver(&[], &[], Arc::new(FailingResolver))
            .unwrap()
            .with_fail_closed_resolve(false);
        assert!(g.check("https://no-such-host.invalid/").is_ok());
    }

    /// 评审 F10：白名单显式命中 = 显式信任——跳过解析校验（解析面不可达）。
    #[test]
    fn allowlist_explicit_trust_skips_lookup() {
        let g = FormalDomainGate::with_resolver(
            &["trusted.example".to_string()],
            &[],
            Arc::new(MultiIpResolver(vec!["10.0.0.1".parse().unwrap()])),
        )
        .unwrap();
        assert!(
            g.check("https://trusted.example/").is_ok(),
            "白名单显式信任跳过解析校验"
        );
        assert!(
            denied(&g, "https://other.example/").is_some(),
            "白名单非空时白名单外 Deny"
        );
    }

    /// T-6/T-7 通配符语义 + 黑名单不可豁免 + 配置校验。
    #[test]
    fn wildcard_and_blocklist_semantics() {
        let g = gate(&["*.corp.example"], &[]);
        assert!(g.check("https://a.corp.example/").is_ok());
        assert!(denied(&g, "https://corp.example/").is_some(), "*. 不含根域");
        assert!(denied(&g, "https://example.com/").is_some(), "白名单外拒绝");

        let g = gate(&["example.com"], &[]);
        assert!(g.check("https://example.com/").is_ok());
        assert!(
            g.check("https://www.example.com/").is_ok(),
            "根域条目含子域"
        );
        assert!(denied(&g, "https://evil-example.com/").is_some());
        assert!(denied(&g, "https://example.com.evil.com/").is_some());

        // 黑名单不可豁免（含全放行 `*`），黑名单优先于白名单
        let g = gate(&["*"], &["*.evil.example"]);
        assert!(g.check("https://anywhere.example/").is_ok());
        assert!(denied(&g, "https://www.evil.example/").is_some());
        let g = gate(&["good.example"], &["good.example"]);
        assert!(denied(&g, "https://good.example/").is_some());

        // 大小写/尾点规范化
        let g = gate(&["EXAMPLE.COM"], &[]);
        assert!(g.check("https://WWW.Example.COM./").is_ok());

        // 配置校验：TLD 通配/多星号/非法字符拒绝
        for bad in ["example.*", "*.", "*x.example", "exa*mple.com", ""] {
            assert!(
                FormalDomainGate::new(&[bad.to_string()], &[]).is_err(),
                "应拒绝非法模式：{bad}"
            );
        }
        assert!(FormalDomainGate::new(&["*.example.com".to_string()], &[]).is_ok());
        assert!(
            FormalDomainGate::new(&["127.0.0.1".to_string()], &[]).is_ok(),
            "IP 字面量可入白名单"
        );
    }

    /// IP 字面量白名单是本机调试站点唯一放行途径（§4.2）。
    #[test]
    fn ip_literal_allowlist_permits_loopback() {
        let g = gate(&["127.0.0.1"], &[]);
        assert!(g.check("http://127.0.0.1:8080/").is_ok());
        assert!(
            denied(&g, "http://10.0.0.1/").is_some(),
            "白名单 IP 条目只豁免本条目，其余保留段仍阻断"
        );
        let g = gate(&["8.8.8.8"], &[]);
        assert!(g.check("http://8.8.8.8/").is_ok());
        assert!(denied(&g, "http://9.9.9.9/").is_some(), "白名单外 Deny");
    }

    /// R-11 §4.3 步骤 4：60s 重绑定窗口——首次校验通过（公网 IP）后，窗口内
    /// 每动作一次重新解析；重绑定（随后解析到内网）被第二次校验拦截；
    /// 解析器调用计数证明无结果缓存（每动作一次解析）。
    #[test]
    fn rebinding_window_catches_rebind_within_60s() {
        let clock = Arc::new(MockClock::default());
        let resolver = Arc::new(SequenceResolver::new(vec![
            Ok(vec!["93.184.216.34".parse().unwrap()]),
            Ok(vec!["10.0.0.1".parse().unwrap()]),
        ]));
        let g =
            FormalDomainGate::with_parts(&[], &[], resolver.clone(), true, clock.clone()).unwrap();

        // 首次校验：公网 IP → 放行，窗口起点记录
        assert!(g.check("https://example.com/").is_ok());
        assert!(
            g.within_rebinding_window("example.com"),
            "校验通过后进入 60s 窗口"
        );
        assert_eq!(resolver.call_count(), 1);

        // 窗口内第二次校验（时钟推进 30s < 60s）：解析器再次被调用（每动作一次），
        // 重绑定到内网 → 阻断
        clock.advance(30_000);
        let reason = denied(&g, "https://example.com/").expect("重绑定应被拦截");
        assert!(reason.contains("SSRF"), "说明：{reason}");
        assert_eq!(
            resolver.call_count(),
            2,
            "窗口内每动作一次重新解析（无结果缓存）"
        );
    }

    /// R-11 §4.3 步骤 4：窗口过期——60s 后条目清除，重新按常规路径全量校验；
    /// 期间未校验的主机不在窗口内。
    #[test]
    fn rebinding_window_expires_after_60s() {
        let clock = Arc::new(MockClock::default());
        let resolver = Arc::new(MultiIpResolver(vec!["93.184.216.34".parse().unwrap()]));
        let g = FormalDomainGate::with_parts(&[], &[], resolver, true, clock.clone()).unwrap();
        assert!(g.check("https://example.com/").is_ok());
        assert!(g.within_rebinding_window("example.com"));
        // 窗口内仍有效
        clock.advance(59_000);
        assert!(g.within_rebinding_window("example.com"));
        // 过期：60s 边界外窗口关闭
        clock.advance(2_000);
        assert!(
            !g.within_rebinding_window("example.com"),
            "60s 后窗口应关闭"
        );
        // 过期后再次校验：按常规路径重新全量校验（仍放行公网）
        assert!(g.check("https://example.com/").is_ok());
        assert!(
            g.within_rebinding_window("example.com"),
            "新校验重新开启窗口"
        );
    }

    /// R-11 传输层：段表程序化生成——清单覆盖全部保留段（IPv4/IPv6 逐段抽样
    /// glob 命中），公网/段外抽样不命中；云元数据端点显式在列。
    #[test]
    fn blocked_urls_cover_segments() {
        let urls = blocked_urls();
        // 关键条目显式断言（段表与模式同源）
        for expected in [
            "http://0.*",
            "http://10.*",
            "http://127.*",
            "http://192.168.*",
            "http://169.254.*",
            "http://169.254.169.254/*",
            "http://198.18.*",
            "http://198.19.*",
            "http://[::1]*",
            "http://[fc*",
            "http://[fd*",
            "http://[::ffff:*",
        ] {
            assert!(urls.iter().any(|p| p == expected), "应含条目：{expected}");
        }
        // 172.16/12 → 逐 /16 共 16 条
        for b in 16..=31u8 {
            let expected = format!("http://172.{b}.*");
            assert!(urls.iter().any(|p| p == &expected), "应含条目：{expected}");
        }
        // 100.64/10 → 逐 /16 共 64 条
        for b in 64..=127u8 {
            let expected = format!("http://100.{b}.*");
            assert!(urls.iter().any(|p| p == &expected), "应含条目：{expected}");
        }
        // fe80::/10 → 4 个 /12 前缀通配
        for prefix in ["fe8", "fe9", "fea", "feb"] {
            let expected = format!("http://[{prefix}*");
            assert!(urls.iter().any(|p| p == &expected), "应含条目：{expected}");
        }

        // 段内抽样 glob 命中 (涵盖 http 与 https 双协议)
        let matches = |ip_url: &str| urls.iter().any(|p| glob_match(p, ip_url));
        for sample in [
            "http://10.1.2.3/x",
            "https://10.1.2.3/x",
            "http://172.16.0.1/",
            "https://172.16.0.1/",
            "http://172.31.255.255/",
            "https://172.31.255.255/",
            "http://192.168.100.1:8080/",
            "https://192.168.100.1:8080/",
            "http://169.254.169.254/latest/meta-data/",
            "https://169.254.169.254/latest/meta-data/",
            "http://100.64.0.1/",
            "https://100.64.0.1/",
            "http://100.127.255.255/",
            "http://198.19.1.1/",
            "http://0.0.0.0/",
            "http://127.0.0.1/",
            "https://127.0.0.1/",
            "http://[::1]/",
            "https://[::1]/",
            "http://[fc00::1]/",
            "https://[fc00::1]/",
            "http://[fdff::1]/",
            "http://[fe80::1]/",
            "https://[fe80::1]/",
            "http://[febf::1]/",
            "http://[::ffff:10.0.0.1]/",
            "https://[::ffff:10.0.0.1]/",
        ] {
            assert!(matches(sample), "段内地址应被阻断清单覆盖：{sample}");
        }
        // 公网/段外抽样不命中
        for sample in [
            "http://8.8.8.8/",
            "https://8.8.8.8/",
            "http://1.1.1.1/",
            "https://1.1.1.1/",
            "http://172.15.0.1/",
            "http://172.32.0.1/",
            "http://100.63.0.1/",
            "http://100.128.0.1/",
            "http://198.17.0.1/",
            "http://198.20.0.1/",
            "http://169.253.0.1/",
            "http://[2001:4860:4860::8888]/",
            "https://[2001:4860:4860::8888]/",
            "http://[2606:2800::1]/",
            "http://[fec0::1]/",
        ] {
            assert!(!matches(sample), "段外地址不应被覆盖：{sample}");
        }
    }

    /// 简化 glob 匹配（`*` 通配任意序列；模拟 Chromium 阻断模式匹配口径）。
    fn glob_match(pattern: &str, text: &str) -> bool {
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

    /// R-11 传输层：mock 发送面接收 `Network.setBlockedURLs` 参数——参数类型
    /// 复用既有 `SetBlockedURLsParams`，序列化 camelCase 正确。
    #[test]
    fn transport_gate_params_wire_and_apply() {
        let gate = TransportGate::new();
        assert_eq!(gate.patterns(), &blocked_urls());

        // 参数断言（mock 发送面）
        let params = gate.to_params();
        let v = serde_json::to_value(&params).expect("序列化失败");
        assert_eq!(v["urls"], serde_json::json!(gate.patterns()));
        assert_eq!(
            v["urls"].as_array().map(Vec::len),
            Some(gate.patterns().len())
        );

        // apply：经 mock 发送面下发阻断清单
        let sender = RecordingSender::default();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(gate.apply(&sender))
            .expect("apply 失败");
        assert_eq!(sender.calls.lock().unwrap().len(), 1);
        assert_eq!(sender.calls.lock().unwrap()[0], *gate.patterns());
    }

    /// R-11 传输层：iframe 导航订阅——NavigationStarted 事件到达后重挂阻断清单
    /// （幂等重挂，覆盖主 URL 不变的 iframe 内网导航请求）。
    #[test]
    fn transport_gate_iframe_subscription_reapplies() {
        let gate = TransportGate::new();
        let sender = RecordingSender::default();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            gate.apply(&sender).await.expect("首次应用失败");
            // iframe 导航事件 → 重挂（幂等：清单不变、再次下发）
            gate.on_frame_navigated(&sender).await.expect("重挂失败");
        });
        let calls = sender.calls.lock().unwrap();
        assert_eq!(calls.len(), 2, "iframe 导航应触发重挂");
        assert_eq!(calls[0], calls[1], "重挂清单不变（幂等）");
        assert_eq!(calls[1], *gate.patterns());
    }

    /// mock 发送面：记录每次下发的阻断清单。
    #[derive(Debug, Default)]
    struct RecordingSender {
        calls: Arc<Mutex<Vec<Vec<String>>>>,
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

    /// 段表程序化一致性：IPv4/IPv6 段边界抽查。
    #[test]
    fn segment_boundaries() {
        assert!(!ipv4_reserved(&Ipv4Addr::new(172, 15, 0, 1)));
        assert!(ipv4_reserved(&Ipv4Addr::new(172, 16, 0, 1)));
        assert!(ipv4_reserved(&Ipv4Addr::new(172, 31, 255, 255)));
        assert!(ipv4_reserved(&Ipv4Addr::new(100, 127, 255, 255)));
        assert!(!ipv4_reserved(&Ipv4Addr::new(100, 128, 0, 1)));
        assert!(ipv4_reserved(&Ipv4Addr::new(198, 19, 255, 255)));
        assert!(!ipv4_reserved(&Ipv4Addr::new(198, 20, 0, 1)));
        assert!(ipv4_reserved(&Ipv4Addr::new(0, 0, 0, 0)));
        assert!(!ipv4_reserved(&Ipv4Addr::new(8, 8, 8, 8)));
        assert!(ipv6_reserved(&Ipv6Addr::LOCALHOST));
        assert!(ipv6_reserved(&"fc00::1".parse::<Ipv6Addr>().unwrap()));
        assert!(ipv6_reserved(&"fdff::1".parse::<Ipv6Addr>().unwrap()));
        assert!(ipv6_reserved(&"fe80::1".parse::<Ipv6Addr>().unwrap()));
        assert!(ipv6_reserved(
            &"::ffff:10.0.0.1".parse::<Ipv6Addr>().unwrap()
        ));
        assert!(!ipv6_reserved(
            &"2001:4860:4860::8888".parse::<Ipv6Addr>().unwrap()
        ));
        assert!(!ipv6_reserved(&"fec0::1".parse::<Ipv6Addr>().unwrap()));
    }

    /// SystemResolver 对 IP 字面量解析不经 DNS（确定性命中）。
    #[test]
    fn system_resolver_resolves_literal_ips() {
        let r = SystemResolver;
        let ips = r.resolve("8.8.8.8").expect("IP 字面量解析不应失败");
        assert!(ips.contains(&"8.8.8.8".parse::<IpAddr>().unwrap()));
    }
}
