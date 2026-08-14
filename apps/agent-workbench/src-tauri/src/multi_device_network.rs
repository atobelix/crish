//! 网络环境检测（R1-09 G-4：Windows 防火墙 / AP 隔离用户引导数据源）。
//!
//! 数据来源与口径：
//! - 网络配置文件类别：优先 NLM COM (INetworkListManager) 实时探测活动网络类别，
//!   回退读注册表 `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\NetworkList\Profiles`
//!   下各 profile 的 `Category` 值（REG_DWORD：0 = 公用 / 1 = 专用 / 2 = 域），
//!   按 Fail-Closed min() 聚合判定当前网络类型（公网优先：任何 Public 即判定 Public）。
//! - 可直连 IP 枚举：独立实现，逻辑与 server/pairing.rs 的
//!   `windows_ip_enum::local_unicast_ips`（GetAdaptersAddresses，
//!   pairing.rs:449-533）及 `default_route_ip`（UDP connect 技巧，
//!   pairing.rs:318-330）同源——该文件并行阵营活跃且模块私有，禁止修改，
//!   故在本文件复刻并注明来源，过滤规则保持一致；
//! - hint 引导文案：公用网络 → 提示切换专用；AP 隔离 → 引导手动输 IP
//!   （规格 Z0-master-plan.md:416 G-4）。
//!
//! 全部失败路径安全降级：非 Windows / 注册表无权限 → `unknown`；
//! IP 枚举失败 → 含 "0.0.0.0" 占位（UI 侧过滤并引导检查网络连接）。

#![allow(unsafe_code)]

use serde::Serialize;

/// 网络环境检测结果（命令面 multi_device_network_info 载荷）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkEnvInfo {
    /// 网络配置文件类别：public / private / domain / unknown
    /// （注册表 Category 聚合结果，见 [classify_category]）
    pub profile: String,
    /// 可直连 IP 列表（手机可手动输入；推荐 IP 恒在首位，
    /// 空网络时含 "0.0.0.0" 占位）
    pub usable_ips: Vec<String>,
    /// 引导文案（公用网络切换 / AP 隔离兜底，UI 直接渲染）
    pub hint: String,
}

/// 网络类别判定结果（注册表 / NLM COM Category 聚合后的语义态）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkKind {
    /// 公用网络（Windows 默认拦截入站，需切换专用）
    Public,
    /// 专用网络（家用/办公局域网常态）
    Private,
    /// 域网络（域受信网络，入站放行策略同专用）
    Domain,
    /// 无 profile 或读取失败（非 Windows / 无权限）
    Unknown,
}

/// 主入口：收集 NLM COM / 注册表 profile 类别 → 判定网络类型 → 枚举可直连 IP →
/// 生成引导文案。全部路径零 panic（外部输入仅来自本机 COM/注册表/网卡）。
pub fn network_env_info() -> NetworkEnvInfo {
    #[cfg(windows)]
    let categories = {
        let nlm_cats = nlm_com::query_connected_network_categories();
        if !nlm_cats.is_empty() {
            nlm_cats
        } else {
            read_profile_categories()
        }
    };
    #[cfg(not(windows))]
    let categories = read_profile_categories();

    let kind = classify_network_categories(&categories);
    NetworkEnvInfo {
        profile: kind_to_profile(kind).to_string(),
        usable_ips: usable_lan_ips(),
        hint: hint_for(kind),
    }
}

/// Windows NLM COM / 注册表 Category 集合 → 网络类别聚合判定。
///
/// Fail-Closed 铁律（公网优先，最严格安全假设）：
/// 1. 只要存在任何一个 Public (0)，整体判定为 Public（Windows 默认拦截入站）；
/// 2. 均为非公网时，取最小信任级别（Private 1 优先于 Domain 2）；
/// 3. 异常值（>2）按公用处理（Fail-Closed）；
/// 4. 空集合（非 Windows / 无权限 / 键缺失）→ 未知。
pub fn classify_network_categories(categories: &[u32]) -> NetworkKind {
    if categories.is_empty() {
        return NetworkKind::Unknown;
    }
    // Fail-Closed 铁律：只要存在任何一个 Public (0)，整体判定为 Public
    if categories.iter().any(|&c| c == 0) {
        return NetworkKind::Public;
    }
    // 均为非公网时，取最小信任级别（Private 1 优先于 Domain 2）
    match categories.iter().copied().min() {
        Some(1) => NetworkKind::Private,
        Some(2) => NetworkKind::Domain,
        _ => NetworkKind::Public,
    }
}

/// 网络类别 → wire 字符串（前端按此渲染徽标与提示）。
fn kind_to_profile(kind: NetworkKind) -> &'static str {
    match kind {
        NetworkKind::Public => "public",
        NetworkKind::Private => "private",
        NetworkKind::Domain => "domain",
        NetworkKind::Unknown => "unknown",
    }
}

/// 引导文案（G-4 规格文案，UI 直接渲染）。
fn hint_for(kind: NetworkKind) -> String {
    match kind {
        NetworkKind::Public => "当前为公用网络，请切换到专用网络后重试；若手机仍无法连接，\
             请关闭路由器客户端隔离（AP 隔离），或手动输入上方 IP。"
            .to_string(),
        NetworkKind::Private | NetworkKind::Domain => {
            "手机无法连接时请关闭路由器客户端隔离（AP 隔离），或手动输入上方 IP。".to_string()
        }
        NetworkKind::Unknown => "未能识别当前网络类型。若手机无法连接，请检查 Windows 防火墙是否\
             放行专用网络，并关闭路由器客户端隔离（AP 隔离），或手动输入上方 IP。"
            .to_string(),
    }
}

// ── Windows NLM (Network List Manager) COM 探测 ───────────────────────

#[cfg(windows)]
mod nlm_com {
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Clone, Copy)]
    pub struct GUID {
        pub data1: u32,
        pub data2: u16,
        pub data3: u16,
        pub data4: [u8; 8],
    }

    pub const CLSID_NETWORK_LIST_MANAGER: GUID = GUID {
        data1: 0xDCB00DA0,
        data2: 0x570F,
        data3: 0x4A9B,
        data4: [0x8D, 0x69, 0x19, 0x9F, 0xDB, 0xA5, 0x72, 0x3B],
    };

    pub const IID_INETWORK_LIST_MANAGER: GUID = GUID {
        data1: 0xDCB00000,
        data2: 0x570F,
        data3: 0x4A9B,
        data4: [0x8D, 0x69, 0x19, 0x9F, 0xDB, 0xA5, 0x72, 0x3B],
    };

    pub const CLSCTX_INPROC_SERVER: u32 = 1;
    pub const COINIT_MULTITHREADED: u32 = 0;
    pub const NLM_ENUM_NETWORK_CONNECTED: u32 = 1;
    pub const S_OK: i32 = 0;

    #[link(name = "ole32")]
    unsafe extern "system" {
        pub fn CoInitializeEx(pvReserved: *const c_void, dwCoInit: u32) -> i32;
        pub fn CoUninitialize();
        pub fn CoCreateInstance(
            rclsid: *const GUID,
            pUnkOuter: *mut c_void,
            dwClsContext: u32,
            riid: *const GUID,
            ppv: *mut *mut c_void,
        ) -> i32;
    }

    #[repr(C)]
    pub struct INetworkListManagerVtbl {
        // IUnknown
        pub query_interface:
            unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> i32,
        pub add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
        pub release: unsafe extern "system" fn(*mut c_void) -> u32,
        // IDispatch
        pub get_type_info_count: unsafe extern "system" fn(*mut c_void, *mut u32) -> i32,
        pub get_type_info:
            unsafe extern "system" fn(*mut c_void, u32, u32, *mut *mut c_void) -> i32,
        pub get_ids_of_names: unsafe extern "system" fn(
            *mut c_void,
            *const GUID,
            *const *const u16,
            u32,
            u32,
            *mut i32,
        ) -> i32,
        pub invoke: unsafe extern "system" fn(
            *mut c_void,
            i32,
            *const GUID,
            u32,
            u16,
            *mut c_void,
            *mut c_void,
            *mut c_void,
            *mut u32,
        ) -> i32,
        // INetworkListManager
        pub get_networks: unsafe extern "system" fn(*mut c_void, u32, *mut *mut c_void) -> i32,
    }

    #[repr(C)]
    pub struct IEnumNetworksVtbl {
        // IUnknown
        pub query_interface:
            unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> i32,
        pub add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
        pub release: unsafe extern "system" fn(*mut c_void) -> u32,
        // IDispatch
        pub get_type_info_count: unsafe extern "system" fn(*mut c_void, *mut u32) -> i32,
        pub get_type_info:
            unsafe extern "system" fn(*mut c_void, u32, u32, *mut *mut c_void) -> i32,
        pub get_ids_of_names: unsafe extern "system" fn(
            *mut c_void,
            *const GUID,
            *const *const u16,
            u32,
            u32,
            *mut i32,
        ) -> i32,
        pub invoke: unsafe extern "system" fn(
            *mut c_void,
            i32,
            *const GUID,
            u32,
            u16,
            *mut c_void,
            *mut c_void,
            *mut c_void,
            *mut u32,
        ) -> i32,
        // IEnumNetworks
        pub get_new_enum: unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> i32,
        pub next: unsafe extern "system" fn(*mut c_void, u32, *mut *mut c_void, *mut u32) -> i32,
    }

    #[repr(C)]
    pub struct INetworkVtbl {
        // IUnknown
        pub query_interface:
            unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> i32,
        pub add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
        pub release: unsafe extern "system" fn(*mut c_void) -> u32,
        // IDispatch
        pub get_type_info_count: unsafe extern "system" fn(*mut c_void, *mut u32) -> i32,
        pub get_type_info:
            unsafe extern "system" fn(*mut c_void, u32, u32, *mut *mut c_void) -> i32,
        pub get_ids_of_names: unsafe extern "system" fn(
            *mut c_void,
            *const GUID,
            *const *const u16,
            u32,
            u32,
            *mut i32,
        ) -> i32,
        pub invoke: unsafe extern "system" fn(
            *mut c_void,
            i32,
            *const GUID,
            u32,
            u16,
            *mut c_void,
            *mut c_void,
            *mut c_void,
            *mut u32,
        ) -> i32,
        // INetwork
        pub get_name: unsafe extern "system" fn(*mut c_void, *mut *mut u16) -> i32,
        pub set_name: unsafe extern "system" fn(*mut c_void, *const u16) -> i32,
        pub get_description: unsafe extern "system" fn(*mut c_void, *mut *mut u16) -> i32,
        pub set_description: unsafe extern "system" fn(*mut c_void, *const u16) -> i32,
        pub get_network_id: unsafe extern "system" fn(*mut c_void, *mut GUID) -> i32,
        pub get_domain_type: unsafe extern "system" fn(*mut c_void, *mut u32) -> i32,
        pub get_network_connections:
            unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> i32,
        pub get_time_created_and_connected:
            unsafe extern "system" fn(*mut c_void, *mut u32, *mut u32, *mut u32, *mut u32) -> i32,
        pub is_connected_to_internet: unsafe extern "system" fn(*mut c_void, *mut i16) -> i32,
        pub is_connected: unsafe extern "system" fn(*mut c_void, *mut i16) -> i32,
        pub get_category: unsafe extern "system" fn(*mut c_void, *mut u32) -> i32,
    }

    /// 通过 Windows Network List Manager COM API 查询当前活跃连接网卡的 Category 列表
    pub fn query_connected_network_categories() -> Vec<u32> {
        let mut categories = Vec::new();
        unsafe {
            let hr_init = CoInitializeEx(std::ptr::null(), COINIT_MULTITHREADED);
            let must_uninit = hr_init >= 0;

            let mut p_mgr: *mut c_void = std::ptr::null_mut();
            let hr = CoCreateInstance(
                &CLSID_NETWORK_LIST_MANAGER,
                std::ptr::null_mut(),
                CLSCTX_INPROC_SERVER,
                &IID_INETWORK_LIST_MANAGER,
                &mut p_mgr,
            );

            if hr == S_OK && !p_mgr.is_null() {
                let vtbl = *(p_mgr as *const *const INetworkListManagerVtbl);
                let mut p_enum: *mut c_void = std::ptr::null_mut();
                let hr_enum =
                    ((*vtbl).get_networks)(p_mgr, NLM_ENUM_NETWORK_CONNECTED, &mut p_enum);

                if hr_enum == S_OK && !p_enum.is_null() {
                    let enum_vtbl = *(p_enum as *const *const IEnumNetworksVtbl);
                    loop {
                        let mut p_network: *mut c_void = std::ptr::null_mut();
                        let mut fetched: u32 = 0;
                        let hr_next = ((*enum_vtbl).next)(p_enum, 1, &mut p_network, &mut fetched);
                        if hr_next != S_OK || fetched == 0 || p_network.is_null() {
                            break;
                        }

                        let net_vtbl = *(p_network as *const *const INetworkVtbl);
                        let mut cat: u32 = 0;
                        let hr_cat = ((*net_vtbl).get_category)(p_network, &mut cat);
                        if hr_cat == S_OK {
                            categories.push(cat);
                        }

                        let unk_vtbl = *(p_network as *const *const INetworkVtbl);
                        ((*unk_vtbl).release)(p_network);
                    }

                    ((*enum_vtbl).release)(p_enum);
                }

                ((*vtbl).release)(p_mgr);
            }

            if must_uninit {
                CoUninitialize();
            }
        }
        categories
    }
}

// ── 网络配置文件类别（注册表读取，Windows only）──────────────────────

/// 枚举 `NetworkList\Profiles` 下全部 profile 的 Category 值（REG_DWORD）。
/// 返回空 Vec = 非 Windows / 键不存在 / 无权限（调用方按 Unknown 降级）。
#[cfg(windows)]
fn read_profile_categories() -> Vec<u32> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{ERROR_NO_MORE_ITEMS, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
    };

    const PROFILES_SUBKEY: &str =
        r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\NetworkList\Profiles";
    let to_wide = |s: &str| -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };

    let mut root: HKEY = std::ptr::null_mut();
    // Safety: lpSubKey 为常量路径的 UTF-16 空终止串；KEY_READ 只读访问，
    // 错误路径全部降级返回，不传播指针。
    let rc = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            to_wide(PROFILES_SUBKEY).as_ptr(),
            0,
            KEY_READ,
            &mut root,
        )
    };
    if rc != ERROR_SUCCESS {
        return Vec::new();
    }

    let mut out = Vec::new();
    let mut index: u32 = 0;
    loop {
        // profile 名为 GUID（约 38 字符），256 字符缓冲足够
        let mut name_buf = [0u16; 256];
        let mut name_len = name_buf.len() as u32;
        // Safety: lpName 指向可写 256 槽缓冲，lpcchName 对应该缓冲长度；
        // 其余参数传空指针（不需要类名/最后写入时间）。
        let rc = unsafe {
            RegEnumKeyExW(
                root,
                index,
                name_buf.as_mut_ptr(),
                &mut name_len,
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if rc == ERROR_NO_MORE_ITEMS {
            break;
        }
        if rc != ERROR_SUCCESS {
            break;
        }
        index += 1;
        let name = String::from_utf16_lossy(&name_buf[..name_len as usize]);
        if let Some(category) = read_category(root, &name) {
            out.push(category);
        }
    }
    // Safety: root 为上方 RegOpenKeyExW 成功打开的有效句柄
    unsafe {
        RegCloseKey(root);
    }
    out
}

/// 读取单个 profile 的 Category 值（REG_DWORD）；任一环节失败返回 None。
#[cfg(windows)]
fn read_category(
    profiles: windows_sys::Win32::System::Registry::HKEY,
    profile_name: &str,
) -> Option<u32> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, KEY_READ, REG_DWORD, REG_VALUE_TYPE,
    };

    let to_wide = |s: &str| -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };

    let mut key: HKEY = std::ptr::null_mut();
    // Safety: lpSubKey 为枚举得到的 profile 名（UTF-16 空终止）；只读打开
    let rc = unsafe {
        RegOpenKeyExW(
            profiles,
            to_wide(profile_name).as_ptr(),
            0,
            KEY_READ,
            &mut key,
        )
    };
    if rc != ERROR_SUCCESS {
        return None;
    }

    let mut category: u32 = 0;
    let mut value_type: REG_VALUE_TYPE = 0;
    let mut size: u32 = std::mem::size_of::<u32>() as u32;
    // Safety: lpData 指向 4 字节 u32，lpcbData 对应该容量；值类型不符
    // 或长度不符时按 None 降级（不会越界写）。
    let rc = unsafe {
        RegQueryValueExW(
            key,
            to_wide("Category").as_ptr(),
            std::ptr::null(),
            &mut value_type,
            &mut category as *mut u32 as *mut u8,
            &mut size,
        )
    };
    // Safety: key 为上方成功打开的有效句柄
    unsafe {
        RegCloseKey(key);
    }
    if rc != ERROR_SUCCESS || value_type != REG_DWORD || size != 4 {
        return None;
    }
    Some(category)
}

/// 非 Windows 平台：无注册表来源，返回空（按 Unknown 降级）。
#[cfg(not(windows))]
fn read_profile_categories() -> Vec<u32> {
    Vec::new()
}

// ── 可直连 IP 枚举（复刻 server/pairing.rs，来源注明）─────────────────

/// 本机可达 IP 集合（手机可手动输入列表）：
/// 默认路由 IP 恒在首位（与配对二维码内嵌同源），其余为网卡枚举
/// IPv4（私有网段优先）；枚举失败或空网络时含 "0.0.0.0" 占位。
fn usable_lan_ips() -> Vec<String> {
    let mut ips: Vec<String> = Vec::new();
    #[cfg(windows)]
    {
        ips.extend(
            windows_ip_enum::local_unicast_ips()
                .into_iter()
                .filter(is_usable_lan_ip)
                .map(|ip| ip.to_string()),
        );
        // 私有网段优先（手机直连首选；排序规则同 pairing.rs pick_recommended_ip）
        ips.sort_by_key(|s| !is_private_ip_str(s));
    }
    // 默认路由 IP（UDP connect 技巧；来源 pairing.rs:318-330）
    let host = default_route_ip();
    if host != "0.0.0.0" && !ips.contains(&host) {
        ips.insert(0, host);
    }
    if ips.is_empty() {
        ips.push("0.0.0.0".to_string());
    }
    ips
}

/// 默认路由 IP（UDP connect 技巧：零依赖、非 Windows 专用）。
/// 失败（无网络/多网卡环境）返回 "0.0.0.0"——UI 侧引导检查网络。
/// 来源：server/pairing.rs `default_route_ip`（pairing.rs:318-330）。
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

/// 判定 IP 是否属于私有网段：RFC1918（10/8、172.16/12、192.168/16）+
/// IPv6 ULA（fc00::/7）。来源：pairing.rs:396-406。
fn is_private_ip(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 10 || (o[0] == 172 && (16..=31).contains(&o[1])) || (o[0] == 192 && o[1] == 168)
        }
        std::net::IpAddr::V6(v6) => (v6.segments()[0] & 0xfe00) == 0xfc00,
    }
}

/// 字符串形式私有网段判定（排序键用；解析失败按非私有）。
fn is_private_ip_str(s: &str) -> bool {
    match s.parse::<std::net::IpAddr>() {
        Ok(ip) => is_private_ip(&ip),
        Err(_) => false,
    }
}

/// 判定 IP 是否可被手机直连：排除回环/未指定/链路本地/组播；
/// 服务监听为 IPv4（0.0.0.0），IPv6 地址不可直连，不在集合内。
/// 来源：pairing.rs:408-422。
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
    ip.is_ipv4()
        && !ip.is_loopback()
        && !ip.is_unspecified()
        && !is_link_local(ip)
        && !ip.is_multicast()
}

/// Windows 网卡单播地址枚举（GetAdaptersAddresses，经 windows-sys 直调）。
///
/// 复刻自 server/pairing.rs `windows_ip_enum`（pairing.rs:449-533）：
/// 该模块为私有且配对文件并行阵营活跃（禁止修改），故在此独立维护；
/// 实现与过滤语义同源（仅取 IPv4 单播，去重）。
/// 失败返回空 Vec——调用方回退默认路由 IP。
/// # Safety
/// 仅在低频调用路径执行；错误路径全部安全降级。
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 网络类别聚合：空集合 → 未知；单类别直判；Fail-Closed（公网优先，min() 聚合）；异常值按公用 fail-closed。
    #[test]
    fn classify_category_resolves_trust_level() {
        assert_eq!(classify_network_categories(&[]), NetworkKind::Unknown);
        assert_eq!(classify_network_categories(&[0]), NetworkKind::Public);
        assert_eq!(classify_network_categories(&[1]), NetworkKind::Private);
        assert_eq!(classify_network_categories(&[2]), NetworkKind::Domain);
        // Fail-Closed 铁律：公用 + 专用 → 公用（任何公网均视为公用）
        assert_eq!(classify_network_categories(&[0, 1]), NetworkKind::Public);
        assert_eq!(classify_network_categories(&[0, 2]), NetworkKind::Public);
        // 专用 + 域 → 专用（Private 1 优先于 Domain 2）
        assert_eq!(classify_network_categories(&[1, 2]), NetworkKind::Private);
        // 异常值（>2）按公用处理（fail-closed：提示最安全）
        assert_eq!(classify_network_categories(&[9]), NetworkKind::Public);
        assert_eq!(classify_network_categories(&[3, 4]), NetworkKind::Public);
    }

    /// wire 字符串映射（前端徽标/提示消费）。
    #[test]
    fn kind_to_profile_maps_all_kinds() {
        assert_eq!(kind_to_profile(NetworkKind::Public), "public");
        assert_eq!(kind_to_profile(NetworkKind::Private), "private");
        assert_eq!(kind_to_profile(NetworkKind::Domain), "domain");
        assert_eq!(kind_to_profile(NetworkKind::Unknown), "unknown");
    }

    /// 引导文案：公用 → 切换专用 + AP 隔离兜底；专用/域 → AP 隔离兜底；
    /// 未知 → 通用兜底（均含「手动输入」关键词）。
    #[test]
    fn hint_for_covers_guidance_paths() {
        let public = hint_for(NetworkKind::Public);
        assert!(public.contains("切换到专用网络"), "公用网络必须提示切换");
        assert!(public.contains("客户端隔离"), "公用提示必须含 AP 隔离兜底");
        assert!(public.contains("手动输入上方 IP"));

        let private = hint_for(NetworkKind::Private);
        let domain = hint_for(NetworkKind::Domain);
        assert!(
            private.contains("关闭路由器客户端隔离"),
            "专用网络提示 AP 隔离"
        );
        assert!(
            !private.contains("切换到专用网络"),
            "专用网络不重复提示切换"
        );
        assert_eq!(private, domain, "专用与域提示文案一致");

        let unknown = hint_for(NetworkKind::Unknown);
        assert!(unknown.contains("Windows 防火墙"), "未知网络提示检查防火墙");
        assert!(unknown.contains("手动输入上方 IP"));
    }

    /// 私有网段判定（复刻自 pairing.rs 的过滤规则自测）。
    #[test]
    fn private_ip_classification() {
        use std::net::IpAddr;
        for s in [
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.5",
            "fc00::1",
            "fd12::1",
        ] {
            let ip: IpAddr = s.parse().expect("测试 IP 合法");
            assert!(is_private_ip(&ip), "{s} 应为私有网段");
        }
        for s in ["8.8.8.8", "100.64.0.1", "2001:4860::8888"] {
            let ip: IpAddr = s.parse().expect("测试 IP 合法");
            assert!(!is_private_ip(&ip), "{s} 不应为私有网段");
        }
    }

    /// 可直连过滤（复刻自 pairing.rs 的过滤规则自测）。
    #[test]
    fn usable_lan_ip_filter() {
        use std::net::IpAddr;
        let ok: IpAddr = "192.168.1.5".parse().expect("合法 IP");
        assert!(is_usable_lan_ip(&ok));
        for s in [
            "127.0.0.1",
            "0.0.0.0",
            "169.254.1.1",
            "224.0.0.1",
            "fe80::1",
        ] {
            let ip: IpAddr = s.parse().expect("测试 IP 合法");
            assert!(!is_usable_lan_ip(&ip), "{s} 不应可直连");
        }
    }

    /// 集成：主入口跨平台可用（Windows 真实注册表环境或 CI 均不 panic；
    /// profile 为四态之一；usable_ips 非空——空网络含 "0.0.0.0" 占位）。
    #[test]
    fn network_env_info_is_well_formed() {
        let info = network_env_info();
        assert!(
            matches!(
                info.profile.as_str(),
                "public" | "private" | "domain" | "unknown"
            ),
            "profile 必须为四态之一：{}",
            info.profile
        );
        assert!(
            !info.usable_ips.is_empty(),
            "IP 列表不应为空（空网络含占位）"
        );
        assert!(!info.hint.is_empty(), "引导文案不应为空");
        // 排序不变量：推荐 IP（默认路由）恒在首位——除非列表为占位
        if info.usable_ips.len() > 1 {
            let first = &info.usable_ips[0];
            assert_ne!(first, "0.0.0.0", "有多个 IP 时首位不得为占位");
        }
    }
}
