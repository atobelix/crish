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

#[cfg(test)]
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
    /// 多端服务总开关真值（`multi_device_set_enabled` 的当前位置）。
    /// 协调器不持有服务开关，由命令面 `multi_device_pair_status` 回填；
    /// 前端以此为准，禁止再维护本地开关副本（防止切页/重挂载后显示失真）。
    pub service_enabled: bool,
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
            PairState::WaitingInput | PairState::KeyVerify | PairState::Establishing => pair
                .active_code(now_ms)
                .unwrap_or_else(|| pair.start(now_ms).expect("重新生成配对码不应失败")),
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
            // 真值由命令面回填（协调器不持有服务开关）
            service_enabled: false,
        }
    }

    /// 移动端配对校验入口（服务端 /v1/pair 与命令面共用）：
    /// 校验通过 → 签发令牌 → 保持 Lan（配对即授权）；失败按状态机计次。
    pub fn complete_pairing(
        &self,
        input: &str,
        label: &str,
        now_ms: u64,
    ) -> Result<String, ServerError> {
        let mut pair = self.pair.lock().unwrap_or_else(|e| e.into_inner());
        match pair.verify(input, now_ms) {
            VerifyOutcome::Success => {
                pair.advance_establishing();
                let mut tokens = self.tokens.lock().unwrap_or_else(|e| e.into_inner());
                let raw = tokens.issue(label, now_ms)?;
                tokens.save()?;
                pair.advance_established();
                // 配对即授权：保持 Lan（移动端持续可连）
                *self
                    .pairing_enabled
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = true;
                Ok(raw)
            }
            VerifyOutcome::WrongCode => Err(ServerError::protocol(
                DeviceErrorCode::PairInvalidCode,
                "配对码错误",
            )),
            VerifyOutcome::Expired => Err(ServerError::protocol(
                DeviceErrorCode::PairExpired,
                "配对码已过期",
            )),
            VerifyOutcome::Locked => Err(ServerError::protocol(
                DeviceErrorCode::PairTooManyAttempts,
                "失败次数过多，请稍后再试",
            )),
            VerifyOutcome::Used => Err(ServerError::protocol(
                DeviceErrorCode::PairUsed,
                "配对码已被使用",
            )),
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
            VerifyOutcome::InvalidFormat => Err(ServerError::protocol(
                DeviceErrorCode::PairInvalidCode,
                "配对码格式无效",
            )),
        }
    }

    /// 取消配对（D2 §5.4 关闭动作，R1-11 验收缺口 G-4 修复）：
    /// 关闭配对 = 撤销全部设备——清空全部已签发令牌（落盘）→
    /// WS 全部踢出（token-revoked）→ 状态机重置 → 恢复 Loopback → 重绑。
    /// 令牌全部失效后 REST 鉴权自然 401；重新开启配对签发全新令牌。
    pub fn cancel_pairing(&self) {
        self.revoke_all();
        self.pair.lock().unwrap_or_else(|e| e.into_inner()).cancel();
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
        if self
            .tokens
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .token_count()
            == 0
        {
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

    /// 是否存在有效配对设备（未撤销令牌）：桌面重启后据此保持 Lan 监听，
    /// 让已配对手机可直接重连，而无需重新进入配对模式。
    pub fn has_active_devices(&self) -> bool {
        !self.list_devices().is_empty()
    }

    /// 令牌哈希列表（撤销全链用）
    #[cfg(test)]
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
/// `pub(crate)`：multi_device_network 网络检测复用本单一真源。
pub(crate) fn default_route_ip() -> String {
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
/// `pub(crate)`：multi_device_network 网络检测复用本单一真源（原为其复刻件收敛）。
pub(crate) fn is_private_ip(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 10 || (o[0] == 172 && (16..=31).contains(&o[1])) || (o[0] == 192 && o[1] == 168)
        }
        std::net::IpAddr::V6(v6) => (v6.segments()[0] & 0xfe00) == 0xfc00,
    }
}

/// 判定 IP 是否可被手机直连：排除回环/未指定/链路本地/组播。
/// 服务监听为 IPv4（0.0.0.0），IPv6 地址不可直连，不在集合内。
/// `pub(crate)`：multi_device_network 网络检测复用本单一真源。
pub(crate) fn is_usable_lan_ip(ip: &std::net::IpAddr) -> bool {
    fn is_link_local(ip: &std::net::IpAddr) -> bool {
        match ip {
            std::net::IpAddr::V4(v4) => {
                let o = v4.octets();
                o[0] == 169 && o[1] == 254
            }
            std::net::IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) == 0xfe80,
        }
    }
    ip.is_ipv4()
        && !ip.is_loopback()
        && !ip.is_unspecified()
        && !is_link_local(ip)
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
/// `pub(crate)`：multi_device_network 网络检测复用本单一真源（原为其
/// 复刻件收敛——复制 unsafe FFI 双源漂移即安全风险）。
/// # Safety
/// 该模块仅在配对开启等低频路径调用，错误路径全部安全降级。
#[cfg(windows)]
pub(crate) mod windows_ip_enum {
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
        if sa.lpSockaddr.is_null() || sa.iSockaddrLength < std::mem::size_of::<SOCKADDR_IN>() as i32
        {
            return None;
        }
        if *(sa.lpSockaddr as *const u16) != AF_INET {
            return None;
        }
        let sin = &*(sa.lpSockaddr as *const SOCKADDR_IN);
        // sin_addr 以网络字节序存储：from_be 还原内存字节序
        Some(IpAddr::V4(Ipv4Addr::from(u32::from_be(
            sin.sin_addr.S_un.S_addr,
        ))))
    }

    /// 备用：SOCKADDR_IN6 读取（保留给未来 v6 监听支持；当前未用）
    #[allow(dead_code)]
    unsafe fn sockaddr_to_ipv6(sa: &SOCKET_ADDRESS) -> Option<IpAddr> {
        if sa.lpSockaddr.is_null()
            || sa.iSockaddrLength < std::mem::size_of::<SOCKADDR_IN6>() as i32
        {
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
#[cfg(test)]
pub fn qr_data_for(code: &PairCode, host: &str, port: u16) -> String {
    format!("crish-pair://{}@{host}:{port}", code.display())
}

#[cfg(test)]
mod tests;
