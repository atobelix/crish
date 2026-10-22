//! 传输层门禁与段表阻断模式生成（§4.3 传输层，R-11）

use std::net::{Ipv4Addr, Ipv6Addr};

use async_trait::async_trait;

use crate::cdp::domains::SetBlockedURLsParams;
use crate::cdp::error::CdpError;
use crate::gate::segments::{IPV4_SEGMENTS, IPV6_SEGMENTS};

/// IPv4 段 → URL 阻断模式（§4.3 传输层：/8 单模式；细段逐 /16 通配展开，双协议 http/https 阻断）。
pub(crate) fn ipv4_blocked_patterns(net: &Ipv4Addr, prefix: u8) -> Vec<String> {
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
pub(crate) fn ipv6_blocked_patterns(net: &Ipv6Addr, prefix: u8) -> Vec<String> {
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
