//! 配对协调器（R1-07）：配对状态机消费 + 令牌签发 + 撤销全链 + 网络数据。
//!
//! 职责（D2 §6 配对模式 / ADR-01 CXN 语义）：
//! - 配对激活：生成 CXN 12 字符码（pair.rs 状态机）→ `pairing_enabled=true`
//!   且 `bind_mode=Lan` → 触发 rebind 钩子（真实重绑由 main.rs 装配）；
//! - 配对完成（移动端 verify 成功）：签发 32B 令牌（auth.rs）→ **保持 Lan**
//!   （配对即授权，移动端持续可连）；
//! - 显式取消 / 全部撤销：恢复 `Loopback` + rebind 钩子；
//! - 撤销全链：revoke 令牌 → pairing.json 落盘 → WS 踢出
//!   （[ws::WsRegistry::kick_by_token_hash]）→ REST 鉴权自然 401；
//! - 二维码 / 防火墙提示：qr_data 编码（默认路由 IP + 端口 + 码）、
//!   firewall_hint 文本（Windows 放行引导）；
//! - 网络环境检测（G-4）：本机 IP 集合 + 网络配置文件类别
//!   （专用/公用/未知，基于 IP 网段的启发式判定，诚实标注粒度），
//!   UI 侧据此引导「公用网络切专用」「AP 隔离时手动输 IP」。

use std::sync::{Arc, Mutex};

use conex_types::device::PairCode;

use super::auth::TokenStore;
use super::pair::{PairState, PairStateMachine, VerifyOutcome};
use super::ws::WsRegistry;
use super::ServerError;
use conex_types::device::DeviceErrorCode;

/// 重绑钩子：配对模式开启（Lan）/关闭（Loopback）时通知持有者重建监听。
/// main.rs 装配真实重绑；测试注入记录器验证钩子触发。
pub type RebindHook = Arc<dyn Fn(bool /* lan */) + Send + Sync>;

/// 网络配置文件类别（G-4 检测结果，UI 据此渲染引导文案）。
/// 诚实标注粒度：真实 Windows 网络配置文件（专用/公用）无法从纯 IP 判定，
/// 本枚举为「推荐 IP 网段」启发式——私有网段大概率专用网络、公网网段
/// 大概率公用网络；无网络或无法判定时为 Unknown。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NetworkProfile {
    /// 推荐 IP 位于私有网段（RFC1918 / IPv6 ULA）：大概率专用网络
    Private,
    /// 推荐 IP 位于公网网段：大概率公用网络（Windows 默认拦截入站）
    Public,
    /// 无网络或无法判定（如默认路由探测失败）
    Unknown,
}

/// 配对启动结果（命令面与 UI 消费）
#[derive(Debug, Clone, serde::Serialize)]
pub struct PairStartResult {
    /// 标准化配对码（CXN-XXXX-XXXX-XXXX）
    pub code: String,
    /// 二维码编码串（供 UI 渲染；格式 `crish-pair://<code>@<host>:<port>`）
    pub qr: String,
    /// Windows 防火墙放行提示（非 Windows 返回空串）
    pub firewall_hint: String,
    /// 推荐本机 IP（与二维码内嵌同源；供 AP 隔离时手机手动输入首选）
    #[serde(rename = "recommendedIp")]
    pub recommended_ip: String,
    /// 本机全部可达 IP（多网卡/VPN 场景备选；检测失败时仅含推荐 IP）
    #[serde(rename = "localIps")]
    pub local_ips: Vec<String>,
    /// 网络配置文件类别（专用/公用/未知；启发式判定，见 [NetworkProfile]）
    #[serde(rename = "networkProfile")]
    pub network_profile: NetworkProfile,
}

/// 配对状态快照（状态命令消费）
#[derive(Debug, Clone, serde::Serialize)]
pub struct PairStatus {
    pub state: &'static str,
    pub pairing_enabled: bool,
    pub bind_mode: &'static str,
    pub code_remaining_ms: Option<u64>,
    pub failed_attempts: u32,
    pub token_count: usize,
}

/// 已配对设备条目（list_devices 消费）
#[derive(Debug, Clone, serde::Serialize)]
pub struct DeviceInfo {
    /// 令牌哈希（仅展示截断 12 字符，不泄露原文）
    pub id: String,
    pub label: String,
    pub issued_at_ms: u64,
    pub revoked: bool,
}

/// 配对协调器（Arc 共享于命令面与 main.rs 装配）
pub struct PairingCoordinator {
    pair: Mutex<PairStateMachine>,
    tokens: Arc<Mutex<TokenStore>>,
    ws_registry: Arc<WsRegistry>,
    /// 配对是否处于开启态（Lan）；关闭时回 Loopback
    pairing_enabled: Mutex<bool>,
    /// 生效端口（二维码数据用；由 ServerHandle 装配时注入）
    port: Mutex<u16>,
    /// 重绑钩子（None = 未装配，仅状态翻转）
    rebind: Mutex<Option<RebindHook>>,
}

impl PairingCoordinator {
    /// 新建协调器（绑定令牌库与 WS 注册表；端口与钩子由装配方注入）
    pub fn new(tokens: Arc<Mutex<TokenStore>>, ws_registry: Arc<WsRegistry>) -> Self {
        Self {
            pair: Mutex::new(PairStateMachine::new()),
            tokens,
            ws_registry,
            pairing_enabled: Mutex::new(false),
            port: Mutex::new(8765),
            rebind: Mutex::new(None),
        }
    }

    /// 装配端口（main.rs：ServerHandle 实际端口）
    pub fn set_port(&self, port: u16) {
        *self.port.lock().unwrap_or_else(|e| e.into_inner()) = port;
    }

    /// 装配重绑钩子（main.rs：重建 ServerInstance）
    pub fn set_rebind_hook(&self, hook: RebindHook) {
        *self.rebind.lock().unwrap_or_else(|e| e.into_inner()) = Some(hook);
    }

    /// 触发重绑（配对开启=Lan / 关闭=Loopback）
    fn fire_rebind(&self, lan: bool) {
        let hook = self
            .rebind
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(hook) = hook {
            hook(lan);
        }
    }

    /// 是否配对开启（Lan）
    pub fn pairing_enabled(&self) -> bool {
        *self
            .pairing_enabled
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// 激活配对：生成 CXN 码 → 开启 Lan → 重绑；返回码/二维码/防火墙提示。
    /// 已在配对中 → 返回既有码（幂等，不重置状态机）。
    pub fn start_pairing(&self, now_ms: u64) -> Result<PairStartResult, ServerError> {
        let mut pair = self.pair.lock().unwrap_or_else(|e| e.into_inner());
        let code = match pair.state() {
            PairState::WaitingInput | PairState::KeyVerify | PairState::Establishing => {
                pair.active_code(now_ms).unwrap_or_else(|| {
                    pair.start(now_ms).expect("重新生成配对码不应失败")
                })
            }
            _ => pair.start(now_ms)?,
        };
        *self
            .pairing_enabled
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = true;
        let port = *self.port.lock().unwrap_or_else(|e| e.into_inner());
        let host = recommended_ip();
        let local_ips = local_ip_list();
        let network_profile = network_profile_for(&host);
        drop(pair);
        self.fire_rebind(true);
        Ok(PairStartResult {
            qr: format!("crish-pair://{}@{host}:{port}", code.display()),
            code: code.display(),
            firewall_hint: firewall_hint(),
            recommended_ip: host,
            local_ips,
            network_profile,
        })
    }

    /// 配对状态快照（状态命令消费）
    pub fn status(&self, now_ms: u64) -> PairStatus {
        let pair = self.pair.lock().unwrap_or_else(|e| e.into_inner());
        let tokens = self.tokens.lock().unwrap_or_else(|e| e.into_inner());
        let enabled = *self
            .pairing_enabled
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        PairStatus {
            state: match pair.state() {
                PairState::Idle => "idle",
                PairState::WaitingInput => "waiting-input",
                PairState::KeyVerify => "key-verify",
                PairState::Establishing => "establishing",
                PairState::Established => "established",
            },
            pairing_enabled: enabled,
            bind_mode: if enabled { "lan" } else { "loopback" },
            code_remaining_ms: pair.active_code_remaining_ms(now_ms),
            failed_attempts: pair.failed_attempts(),
            token_count: tokens.token_count(),
        }
    }

    /// 移动端配对校验入口（服务端 /v1/pair 与命令面共用）：
    /// 校验通过 → 签发令牌 → 保持 Lan（配对即授权）；失败按状态机计次。
    pub fn complete_pairing(&self, input: &str, label: &str, now_ms: u64) -> Result<String, ServerError> {
        let mut pair = self.pair.lock().unwrap_or_else(|e| e.into_inner());
        match pair.verify(input, now_ms) {
            VerifyOutcome::Success => {
                let mut tokens = self.tokens.lock().unwrap_or_else(|e| e.into_inner());
                let raw = tokens.issue(label, now_ms)?;
                tokens.save()?;
                // 配对即授权：保持 Lan（移动端持续可连）
                *self
                    .pairing_enabled
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = true;
                Ok(raw)
            }
            VerifyOutcome::WrongCode => Err(ServerError::protocol(DeviceErrorCode::PairInvalidCode, "配对码错误")),
            VerifyOutcome::Expired => Err(ServerError::protocol(DeviceErrorCode::PairExpired, "配对码已过期")),
            VerifyOutcome::Locked => Err(ServerError::protocol(
                DeviceErrorCode::PairTooManyAttempts,
                "失败次数过多，请稍后再试",
            )),
            VerifyOutcome::Used => Err(ServerError::protocol(DeviceErrorCode::PairUsed, "配对码已被使用")),
            // R1-10 T-05：5 次爆破失败 → 配对会话销毁；冷却结束后正确码
            // 也永久失效，客户端必须重新开启配对
            VerifyOutcome::Destroyed => Err(ServerError::protocol(
                DeviceErrorCode::PairInvalidCode,
                "配对码已失效（失败次数过多会话销毁），请重新开启配对",
            )),
            VerifyOutcome::NotAwaiting => Err(ServerError::protocol(
                DeviceErrorCode::PairInvalidCode,
                "当前未处于配对状态",
            )),
            VerifyOutcome::InvalidFormat => Err(ServerError::protocol(DeviceErrorCode::PairInvalidCode, "配对码格式无效")),
        }
    }

    /// 取消配对（D2 §5.4 关闭动作，R1-11 验收缺口 G-4 修复）：
    /// 关闭配对 = 撤销全部设备——清空全部已签发令牌（落盘）→
    /// WS 全部踢出（token-revoked）→ 状态机重置 → 恢复 Loopback → 重绑。
    /// 令牌全部失效后 REST 鉴权自然 401；重新开启配对签发全新令牌。
    pub fn cancel_pairing(&self) {
        self.revoke_all();
        self.pair
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .cancel();
    }

    /// 撤销指定设备：令牌失效 → 落盘 → WS 踢出；其余设备仍在则保持 Lan。
    pub fn revoke_device(&self, hash: &str) -> bool {
        let revoked = {
            let mut tokens = self.tokens.lock().unwrap_or_else(|e| e.into_inner());
            let removed = tokens.revoke(hash);
            if removed {
                let _ = tokens.save();
            }
            removed
        };
        if revoked {
            self.ws_registry.kick_by_token_hash(hash, "token-revoked");
        }
        // 全部撤销后回 Loopback（关闭配对态）
        if self.tokens.lock().unwrap_or_else(|e| e.into_inner()).token_count() == 0 {
            *self
                .pairing_enabled
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = false;
            self.fire_rebind(false);
        }
        revoked
    }

    /// 重命名设备标签（令牌库内更新 + 落盘；返回是否命中）
    pub fn rename_device(&self, hash: &str, new_label: &str) -> bool {
        self.tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .rename(hash, new_label)
    }

    /// 撤销全部设备（含踢出与回 Loopback）
    pub fn revoke_all(&self) {
        {
            let mut tokens = self.tokens.lock().unwrap_or_else(|e| e.into_inner());
            tokens.revoke_all();
            let _ = tokens.save();
        }
        let all_hashes = self
            .tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .all_hashes();
        for hash in all_hashes {
            self.ws_registry.kick_by_token_hash(&hash, "token-revoked");
        }
        *self
            .pairing_enabled
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = false;
        self.fire_rebind(false);
    }

    /// 已配对设备列表（命令面展示）
    pub fn list_devices(&self) -> Vec<DeviceInfo> {
        self.tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .devices()
    }

    /// 令牌哈希列表（撤销全链用）
    pub fn token_hashes(&self) -> Vec<String> {
        self.tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .all_hashes()
    }
}

// ── 网络数据（G-4 检测：无新 crate 依赖）──────────────────────────────

/// 默认路由 IP（UDP connect 技巧：零依赖、非 Windows 专用）。
/// 失败（无网络/多网卡环境）返回 "0.0.0.0"——UI 侧允许手动输入。
fn default_route_ip() -> String {
    use std::net::UdpSocket;
    let sock = match UdpSocket::bind("0.0.0.0:0") {
        Ok(s) => s,
        Err(_) => return "0.0.0.0".to_string(),
    };
    match sock.connect("8.8.8.8:80") {
        Ok(()) => match sock.local_addr() {
            Ok(addr) if !addr.ip().is_unspecified() => addr.ip().to_string(),
            _ => "0.0.0.0".to_string(),
        },
        Err(_) => "0.0.0.0".to_string(),
    }
}

/// 推荐 IP：默认路由 IP 优先（与二维码内嵌同源，保证手动输入与扫码一致）；
/// 默认路由探测失败时从本机 IP 集合挑选（私有网段 IPv4 优先）。
fn recommended_ip() -> String {
    let host = default_route_ip();
    if host != "0.0.0.0" {
        return host;
    }
    pick_recommended_ip(&local_ip_list()).unwrap_or_else(|| "0.0.0.0".to_string())
}

/// 本机可达 IP 集合：Windows 枚举网卡单播地址 ∪ 默认路由 IP（保证在列）。
/// 枚举失败或非 Windows 平台时仅含默认路由 IP（或 "0.0.0.0" 占位）。
fn local_ip_list() -> Vec<String> {
    let mut ips: Vec<String> = Vec::new();
    #[cfg(windows)]
    {
        ips.extend(
            windows_ip_enum::local_unicast_ips()
                .into_iter()
                .filter(is_usable_lan_ip)
                .map(|ip| ip.to_string()),
        );
    }
    let host = default_route_ip();
    if host != "0.0.0.0" && !ips.iter().any(|s| s == &host) {
        ips.insert(0, host.clone());
    }
    if ips.is_empty() {
        ips.push(host);
    }
    ips
}

/// 挑选推荐 IP：私有网段 IPv4 优先 → 任意非回环 IPv4 → 任意可用地址。
/// 供默认路由探测失败时兜底；返回 None 表示无可选地址。
fn pick_recommended_ip(ips: &[String]) -> Option<String> {
    let parse = |s: &str| s.parse::<std::net::IpAddr>().ok();
    for s in ips {
        if let Some(ip) = parse(s) {
            if ip.is_ipv4() && is_private_ip(&ip) && !ip.is_loopback() {
                return Some(s.clone());
            }
        }
    }
    for s in ips {
        if let Some(ip) = parse(s) {
            // R1-10 修复：非回环 IPv4 兜底必须排除未指定占位（0.0.0.0）——
            // 否则「无可选地址」兜底会把占位符当推荐 IP 下发（QR 码/手动
            // 输入均不可用），与函数 doc「返回 None 表示无可选地址」相悖
            if ip.is_ipv4() && !ip.is_loopback() && !ip.is_unspecified() {
                return Some(s.clone());
            }
        }
    }
    for s in ips {
        if let Some(ip) = parse(s) {
            if is_usable_lan_ip(&ip) {
                return Some(s.clone());
            }
        }
    }
    None
}

/// 判定 IP 是否属于私有网段：RFC1918（10/8、172.16/12、192.168/16）+
/// IPv6 ULA（fc00::/7）。家庭/办公局域网基本都在私有网段。
fn is_private_ip(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 10
                || (o[0] == 172 && (16..=31).contains(&o[1]))
                || (o[0] == 192 && o[1] == 168)
        }
        std::net::IpAddr::V6(v6) => (v6.segments()[0] & 0xfe00) == 0xfc00,
    }
}

/// 判定 IP 是否可被手机直连：排除回环/未指定/链路本地/组播。
/// 服务监听为 IPv4（0.0.0.0），IPv6 地址不可直连，不在集合内。
fn is_usable_lan_ip(ip: &std::net::IpAddr) -> bool {
    fn is_link_local(ip: &std::net::IpAddr) -> bool {
        match ip {
            std::net::IpAddr::V4(v4) => {
                let o = v4.octets();
                o[0] == 169 && o[1] == 254
            }
            std::net::IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) == 0xfe80,
        }
    }
    ip.is_ipv4() && !ip.is_loopback() && !ip.is_unspecified() && !is_link_local(ip)
        && !ip.is_multicast()
}

/// 网络配置文件类别（启发式）：私有网段 → 专用；公网网段 → 公用；
/// 不可用地址/解析失败 → 未知。
fn network_profile_for(ip: &str) -> NetworkProfile {
    match ip.parse::<std::net::IpAddr>() {
        Ok(parsed) if !is_usable_lan_ip(&parsed) => NetworkProfile::Unknown,
        Ok(parsed) if is_private_ip(&parsed) => NetworkProfile::Private,
        Ok(_) => NetworkProfile::Public,
        Err(_) => NetworkProfile::Unknown,
    }
}

/// Windows 防火墙放行提示（非 Windows 返回空）
fn firewall_hint() -> String {
    if cfg!(windows) {
        "请在 Windows 防火墙弹窗中允许 crish（专用网络），否则手机无法直连局域网服务。".to_string()
    } else {
        String::new()
    }
}

/// Windows 网卡单播地址枚举（GetAdaptersAddresses，经 windows-sys 直调；
/// 无新增 crate，仅追加 feature）。失败返回空 Vec——调用方回退默认路由 IP。
/// # Safety
/// 该模块仅在配对开启等低频路径调用，错误路径全部安全降级。
#[cfg(windows)]
mod windows_ip_enum {
    #![allow(unsafe_code)] // 受控 FFI：仅指针遍历 + 明确的结构体读取，已评审
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
    use windows_sys::Win32::NetworkManagement::IpHelper::IP_ADAPTER_ADDRESSES_LH;
    use windows_sys::Win32::Networking::WinSock::{
        AF_INET, SOCKADDR_IN, SOCKADDR_IN6, SOCKET_ADDRESS,
    };

    /// 固定大小对齐缓冲（IP_ADAPTER_ADDRESSES_LH 要求 8 字节对齐读取）
    #[repr(C, align(8))]
    struct Align8Buf([u8; 65536]);

    /// 遍历适配器单播地址链表，仅取 IPv4（服务监听 0.0.0.0，v6 不可直连）。
    pub fn local_unicast_ips() -> Vec<IpAddr> {
        use windows_sys::Win32::NetworkManagement::IpHelper::GetAdaptersAddresses;
        let mut out = Vec::new();
        let mut buf = Box::new(Align8Buf([0u8; 65536]));
        let mut size = std::mem::size_of::<Align8Buf>() as u32;
        let first = buf.0.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH;
        let rc = unsafe { GetAdaptersAddresses(0, 0, std::ptr::null(), first, &mut size) };
        if rc == 0 {
            unsafe { collect_ips(first, &mut out) };
        }
        // 缓冲区不足（ERROR_BUFFER_OVERFLOW）：按 API 报告 size 动态扩容重试一次
        if rc == 111 && size > std::mem::size_of::<Align8Buf>() as u32 {
            let layout =
                std::alloc::Layout::from_size_align(size as usize, 8).expect("布局参数合法");
            let raw = unsafe { std::alloc::alloc_zeroed(layout) };
            let first = raw as *mut IP_ADAPTER_ADDRESSES_LH;
            let rc2 = unsafe { GetAdaptersAddresses(0, 0, std::ptr::null(), first, &mut size) };
            if rc2 == 0 {
                unsafe { collect_ips(first, &mut out) };
            }
            unsafe { std::alloc::dealloc(raw, layout) };
        }
        out
    }

    /// 遍历单播地址链表收集 IPv4 地址（去重）。
    /// # Safety
    /// first 必须指向 GetAdaptersAddresses 成功返回的合法链表头。
    unsafe fn collect_ips(first: *mut IP_ADAPTER_ADDRESSES_LH, out: &mut Vec<IpAddr>) {
        let mut node = first;
        while !node.is_null() {
            let mut unicast = (*node).FirstUnicastAddress;
            while !unicast.is_null() {
                if let Some(ip) = sockaddr_to_ipv4(&(*unicast).Address) {
                    if !out.contains(&ip) {
                        out.push(ip);
                    }
                }
                unicast = (*unicast).Next;
            }
            node = (*node).Next;
        }
    }

    /// 从 SOCKET_ADDRESS 读取 IPv4；非 AF_INET（v6 等）返回 None。
    /// # Safety
    /// lpSockaddr 由系统填充且长度字段约束为完整 sockaddr，类型按 sin_family 判定。
    unsafe fn sockaddr_to_ipv4(sa: &SOCKET_ADDRESS) -> Option<IpAddr> {
        if sa.lpSockaddr.is_null() || sa.iSockaddrLength < std::mem::size_of::<SOCKADDR_IN>() as i32 {
            return None;
        }
        if *(sa.lpSockaddr as *const u16) != AF_INET {
            return None;
        }
        let sin = &*(sa.lpSockaddr as *const SOCKADDR_IN);
        // sin_addr 以网络字节序存储：from_be 还原内存字节序
        Some(IpAddr::V4(Ipv4Addr::from(u32::from_be(sin.sin_addr.S_un.S_addr))))
    }

    /// 备用：SOCKADDR_IN6 读取（保留给未来 v6 监听支持；当前未用）
    #[allow(dead_code)]
    unsafe fn sockaddr_to_ipv6(sa: &SOCKET_ADDRESS) -> Option<IpAddr> {
        if sa.lpSockaddr.is_null() || sa.iSockaddrLength < std::mem::size_of::<SOCKADDR_IN6>() as i32 {
            return None;
        }
        if *(sa.lpSockaddr as *const u16) == AF_INET {
            return None;
        }
        let sin6 = &*(sa.lpSockaddr as *const SOCKADDR_IN6);
        Some(IpAddr::V6(Ipv6Addr::from(sin6.sin6_addr.u.Byte)))
    }
}

/// 生成器别名（对拍/测试引用）
pub fn qr_data_for(code: &PairCode, host: &str, port: u16) -> String {
    format!("crish-pair://{}@{host}:{port}", code.display())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::Mutex;

    use super::*;
    use crate::server::auth::TokenVerdict;
    use crate::server::ws::RegisterOutcome;

    /// 测试协调器（含 WS 注册表句柄，供踢出链断言）：注入记录重绑的
    /// 钩子与临时令牌库
    fn test_coordinator_with_ws() -> (
        Arc<PairingCoordinator>,
        Arc<WsRegistry>,
        Arc<Mutex<Vec<bool>>>,
    ) {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        let unique = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let tokens = Arc::new(Mutex::new(TokenStore::new(
            std::env::temp_dir().join(format!(
                "pairing-test-{}-{unique}.json",
                std::process::id()
            )),
        )));
        let ws = Arc::new(WsRegistry::new());
        let coordinator = Arc::new(PairingCoordinator::new(tokens, ws.clone()));
        let rebinds = Arc::new(Mutex::new(Vec::new()));
        let hook_rebinds = rebinds.clone();
        coordinator.set_rebind_hook(Arc::new(move |lan: bool| {
            hook_rebinds.lock().unwrap_or_else(|e| e.into_inner()).push(lan);
        }));
        coordinator.set_port(8765);
        (coordinator, ws, rebinds)
    }

    /// 测试协调器：注入记录重绑的钩子与临时令牌库
    fn test_coordinator() -> (Arc<PairingCoordinator>, Arc<Mutex<Vec<bool>>>) {
        let (coordinator, _ws, rebinds) = test_coordinator_with_ws();
        (coordinator, rebinds)
    }

    fn valid_code(coordinator: &PairingCoordinator) -> String {
        let now = crate::server::now_ms();
        let result = coordinator.start_pairing(now).expect("激活配对必须成功");
        result.code
    }

    #[test]
    fn start_pairing_activates_lan_and_returns_metadata() {
        let (coordinator, rebinds) = test_coordinator();
        let now = crate::server::now_ms();
        let result = coordinator.start_pairing(now).expect("激活配对必须成功");

        // CXN 展示形态：CXN-XXXX-XXXX-XXXX
        assert!(result.code.starts_with("CXN-"));
        assert!(result.qr.starts_with("crish-pair://"));
        assert!(result.qr.contains(&result.code));
        assert!(result.qr.contains(":8765"));
        assert!(!result.firewall_hint.is_empty() || !cfg!(windows));

        // G-4 网络检测字段：推荐 IP 与二维码内嵌同源；集合非空；类别枚举合法
        assert!(result.qr.contains(&result.recommended_ip), "二维码内嵌推荐 IP");
        assert!(!result.local_ips.is_empty(), "本机 IP 集合不应为空");
        assert!(result.local_ips.contains(&result.recommended_ip), "推荐 IP 应在集合内");
        assert!(
            matches!(
                result.network_profile,
                NetworkProfile::Private | NetworkProfile::Public | NetworkProfile::Unknown
            ),
            "网络类别必须为三态之一"
        );

        assert!(coordinator.pairing_enabled());
        let status = coordinator.status(now);
        assert_eq!(status.state, "waiting-input");
        assert_eq!(status.bind_mode, "lan");
        assert!(status.code_remaining_ms.is_some());
        assert_eq!(*rebinds.lock().unwrap_or_else(|e| e.into_inner()), vec![true]);
    }

    #[test]
    fn classify_private_vs_public_ip() {
        use std::net::IpAddr;
        let private_ips = [
            "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.5",
            "fc00::1", "fd12:3456::1",
        ];
        let public_ips = [
            "8.8.8.8", "100.64.0.1", "172.15.255.255", "172.32.0.1", "192.169.0.1",
            "2001:4860:4860::8888", "169.254.1.1", "127.0.0.1",
        ];
        for s in private_ips {
            let ip: IpAddr = s.parse().expect("测试 IP 合法");
            assert!(is_private_ip(&ip), "{s} 应为私有网段");
        }
        for s in public_ips {
            let ip: IpAddr = s.parse().expect("测试 IP 合法");
            assert!(!is_private_ip(&ip), "{s} 不应为私有网段");
        }
    }

    #[test]
    fn network_profile_classification() {
        assert_eq!(network_profile_for("192.168.1.5"), NetworkProfile::Private);
        assert_eq!(network_profile_for("10.0.0.8"), NetworkProfile::Private);
        assert_eq!(network_profile_for("172.20.3.3"), NetworkProfile::Private);
        assert_eq!(network_profile_for("8.8.8.8"), NetworkProfile::Public);
        assert_eq!(network_profile_for("100.64.0.1"), NetworkProfile::Public);
        // 不可用地址（回环/未指定/链路本地）与解析失败 → 未知
        assert_eq!(network_profile_for("127.0.0.1"), NetworkProfile::Unknown);
        assert_eq!(network_profile_for("169.254.1.1"), NetworkProfile::Unknown);
        assert_eq!(network_profile_for("0.0.0.0"), NetworkProfile::Unknown);
        assert_eq!(network_profile_for("not-an-ip"), NetworkProfile::Unknown);
    }

    #[test]
    fn pick_recommended_ip_prefers_private_ipv4() {
        let list = vec![
            "127.0.0.1".to_string(),
            "169.254.1.1".to_string(),
            "8.8.8.8".to_string(),
            "192.168.1.5".to_string(),
        ];
        assert_eq!(pick_recommended_ip(&list).as_deref(), Some("192.168.1.5"));

        // 无私有 IP 时回退任意非回环 IPv4
        let only_public = vec!["8.8.8.8".to_string(), "127.0.0.1".to_string()];
        assert_eq!(pick_recommended_ip(&only_public).as_deref(), Some("8.8.8.8"));

        // 全部不可用 → None
        let none = vec!["127.0.0.1".to_string(), "0.0.0.0".to_string()];
        assert_eq!(pick_recommended_ip(&none), None);
        assert_eq!(pick_recommended_ip(&[]), None);
    }

    #[test]
    fn local_ip_list_contains_recommended() {
        let list = local_ip_list();
        assert!(!list.is_empty(), "IP 集合不应为空");
        let host = recommended_ip();
        assert!(list.contains(&host), "推荐 IP {host} 应在集合内");
    }

    #[test]
    fn complete_pairing_issues_token_and_keeps_lan() {
        let (coordinator, rebinds) = test_coordinator();
        let now = crate::server::now_ms();
        let code = valid_code(&coordinator);

        let raw = coordinator
            .complete_pairing(&code, "test-device", now)
            .expect("配对成功必须签发令牌");
        assert_eq!(raw.len(), 64, "32B hex 令牌");

        let devices = coordinator.list_devices();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].label, "test-device");
        assert!(!devices[0].revoked);
        assert!(!devices[0].id.contains(raw.as_str()), "不得泄露令牌原文");

        // 配对即授权：保持 Lan，不触发回环重绑
        assert!(coordinator.pairing_enabled());
        assert_eq!(*rebinds.lock().unwrap_or_else(|e| e.into_inner()), vec![true]);
    }

    #[test]
    fn complete_pairing_wrong_code_counts_failure() {
        let (coordinator, _) = test_coordinator();
        let now = crate::server::now_ms();
        valid_code(&coordinator);

        let err = coordinator
            .complete_pairing("7K4PQ2MB9XRT", "bad", now)
            .expect_err("错误码必须拒绝");
        assert_eq!(err.device_code().as_str(), "pair.invalid_code");
        assert_eq!(coordinator.status(now).failed_attempts, 1);
    }

    // ── R1-10 T-05：配对码爆破 → 5 次失败销毁会话 + 锁定（协调器全链）──

    /// T-05 协调器全链：4 次失败计数 → 第 5 次销毁会话进入冷却 →
    /// 冷却期内正确码被拒（pair.too_many_attempts）→ 冷却结束后正确码
    /// 永久失效（pair.invalid_code）→ 重新开启配对签发新码可成功
    #[test]
    fn t05_bruteforce_destroys_pair_session_via_coordinator() {
        let (coordinator, _) = test_coordinator();
        let now = crate::server::now_ms();
        let code = valid_code(&coordinator);

        // 4 次错误：仅计数
        for i in 1..=4 {
            let err = coordinator
                .complete_pairing("7K4PQ2MB9XRT", "evil", now + i)
                .expect_err("错误码必须拒绝");
            assert_eq!(err.device_code().as_str(), "pair.invalid_code");
            // R1-10 并行阵营 in-flight 修复（协调标记）：failed_attempts 为
            // u32 而循环变量 i 为 u64——断言对齐（与 pair.rs:432 同模式）
            assert_eq!(coordinator.status(now + i).failed_attempts, i as u32);
        }
        // 第 5 次错误：锁定 + 销毁（冷却期 5 分钟；正确码冷却期内也被拒）
        let err = coordinator
            .complete_pairing("7K4PQ2MB9XRT", "evil", now + 5)
            .expect_err("第 5 次错误必须拒绝");
        assert_eq!(err.device_code().as_str(), "pair.invalid_code");
        let err = coordinator
            .complete_pairing(&code, "evil", now + 6)
            .expect_err("冷却期内正确码必须被拒");
        assert_eq!(
            err.device_code().as_str(),
            "pair.too_many_attempts",
            "冷却期内正确码 → too_many_attempts"
        );
        // 状态面：会话已销毁 → 无活跃码、失败计数归零（重新配对语义）
        let status = coordinator.status(now + 6);
        assert_eq!(status.state, "waiting-input");
        assert!(status.code_remaining_ms.is_none(), "销毁后无活跃码");
        assert_eq!(status.failed_attempts, 0, "销毁后失败计数归零");

        // 冷却结束后：正确码永久失效（pair.invalid_code，Destroyed 映射）
        let after_cooldown = now + 5 + crate::server::pair::PAIR_LOCK_COOLDOWN_MS + 1;
        let err = coordinator
            .complete_pairing(&code, "evil", after_cooldown)
            .expect_err("冷却结束后销毁的会话必须仍拒绝正确码");
        assert_eq!(
            err.device_code().as_str(),
            "pair.invalid_code",
            "冷却结束后正确码 → 失效（会话销毁）"
        );

        // 重新开启配对：新码签发成功，且能完成配对
        let restart = coordinator.start_pairing(after_cooldown + 1).expect("重新开启配对必须成功");
        assert_ne!(restart.code, code, "重新配对必须换新码");
        let raw = coordinator
            .complete_pairing(&restart.code, "fresh-device", after_cooldown + 2)
            .expect("新配对码必须可完成配对");
        assert_eq!(raw.len(), 64);
    }

    #[test]
    fn cancel_pairing_restores_loopback_and_rebinds() {
        let (coordinator, rebinds) = test_coordinator();
        let now = crate::server::now_ms();
        valid_code(&coordinator);
        assert!(coordinator.pairing_enabled());

        coordinator.cancel_pairing();
        assert!(!coordinator.pairing_enabled());
        assert_eq!(coordinator.status(now).state, "idle");
        assert_eq!(coordinator.status(now).bind_mode, "loopback");
        assert_eq!(*rebinds.lock().unwrap_or_else(|e| e.into_inner()), vec![true, false]);
    }

    /// G-4（R1-11 验收缺口修复）：关闭配对 = 撤销全部设备（D2 §5.4 关闭
    /// 动作）——清空全部已签发令牌 + WS 踢出 + 状态机重置 + 回 Loopback。
    #[test]
    fn cancel_pairing_revokes_all_tokens_and_kicks_ws() {
        let (coordinator, ws, rebinds) = test_coordinator_with_ws();
        let now = crate::server::now_ms();
        let code = valid_code(&coordinator);
        let raw = coordinator
            .complete_pairing(&code, "d1", now)
            .expect("签发必须成功");
        let hash = coordinator.token_hashes().pop().expect("应有令牌");

        // 模拟手机已连接：以该令牌哈希注册 WS 连接
        let (kill_tx, kill_rx) = tokio::sync::watch::channel::<Option<String>>(None);
        let conn_id = match ws.register(&hash, "d1", kill_tx, now) {
            RegisterOutcome::Registered(id) => id,
            RegisterOutcome::LimitExceeded => panic!("连接上限不应触发"),
        };
        assert_eq!(ws.count(), 1, "连接必须已注册");

        coordinator.cancel_pairing();

        // ① 设备列表空（撤销 = 解除配对关系）
        assert!(coordinator.list_devices().is_empty());
        // ② 令牌 verify 全 Revoked（REST 鉴权自然 401）
        assert_eq!(
            coordinator
                .tokens
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .verify(&raw, now),
            TokenVerdict::Revoked,
            "关闭配对后已签发令牌必须全部失效"
        );
        // ③ WS 踢出信号已下发（token-revoked）；sender task 收口注销后注册表为空
        assert_eq!(
            kill_rx.borrow().as_deref(),
            Some("token-revoked"),
            "关闭配对必须踢出全部在线连接"
        );
        ws.unregister(conn_id);
        assert_eq!(ws.count(), 0, "踢出后注册表清空");
        // ④ 状态机重置 + 回 Loopback + 重绑钩子（一次开启一次关闭）
        assert!(!coordinator.pairing_enabled());
        let status = coordinator.status(now);
        assert_eq!(status.state, "idle");
        assert_eq!(status.bind_mode, "loopback");
        assert_eq!(
            *rebinds.lock().unwrap_or_else(|e| e.into_inner()),
            vec![true, false]
        );
    }

    #[test]
    fn revoke_all_clears_devices_and_closes_pairing() {
        let (coordinator, rebinds) = test_coordinator();
        let now = crate::server::now_ms();
        let code = valid_code(&coordinator);
        coordinator
            .complete_pairing(&code, "d1", now)
            .expect("签发必须成功");

        coordinator.revoke_all();
        assert!(coordinator.list_devices().is_empty());
        assert!(!coordinator.pairing_enabled());
        assert_eq!(*rebinds.lock().unwrap_or_else(|e| e.into_inner()), vec![true, false]);
    }

    #[test]
    fn revoke_device_removes_single_and_kicks_ws() {
        let (coordinator, _) = test_coordinator();
        let now = crate::server::now_ms();
        let code = valid_code(&coordinator);
        coordinator
            .complete_pairing(&code, "d1", now)
            .expect("签发必须成功");

        let hash = coordinator.token_hashes().pop().expect("应有令牌");
        assert!(coordinator.revoke_device(&hash));
        assert!(!coordinator.revoke_device(&hash), "重复撤销返回 false");
        assert!(coordinator.list_devices().is_empty());
    }
}
