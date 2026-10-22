//! 域名门禁基础类型与抽象（时钟、解析器抽象与常量）

use std::net::{IpAddr, ToSocketAddrs};
use std::time::{Duration, Instant};

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
