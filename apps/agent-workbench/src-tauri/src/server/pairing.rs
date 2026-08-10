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
//!   firewall_hint 文本（Windows 放行引导）。

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

/// 配对启动结果（命令面与 UI 消费）
#[derive(Debug, Clone, serde::Serialize)]
pub struct PairStartResult {
    /// 标准化配对码（CXN-XXXX-XXXX-XXXX）
    pub code: String,
    /// 二维码编码串（供 UI 渲染；格式 `crish-pair://<code>@<host>:<port>`）
    pub qr: String,
    /// Windows 防火墙放行提示（非 Windows 返回空串）
    pub firewall_hint: String,
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
        let host = default_route_ip();
        drop(pair);
        self.fire_rebind(true);
        Ok(PairStartResult {
            qr: format!("crish-pair://{}@{host}:{port}", code.display()),
            code: code.display(),
            firewall_hint: firewall_hint(),
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
            VerifyOutcome::NotAwaiting => Err(ServerError::protocol(
                DeviceErrorCode::PairInvalidCode,
                "当前未处于配对状态",
            )),
            VerifyOutcome::InvalidFormat => Err(ServerError::protocol(DeviceErrorCode::PairInvalidCode, "配对码格式无效")),
        }
    }

    /// 取消配对：状态机重置 → 恢复 Loopback → 重绑
    pub fn cancel_pairing(&self) {
        self.pair
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .cancel();
        *self
            .pairing_enabled
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = false;
        self.fire_rebind(false);
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

// ── 网络数据（无新依赖）────────────────────────────────────────────

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

/// Windows 防火墙放行提示（非 Windows 返回空）
fn firewall_hint() -> String {
    if cfg!(windows) {
        "请在 Windows 防火墙弹窗中允许 crish（专用网络），否则手机无法直连局域网服务。".to_string()
    } else {
        String::new()
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

    /// 测试协调器：注入记录重绑的钩子与临时令牌库
    fn test_coordinator() -> (Arc<PairingCoordinator>, Arc<Mutex<Vec<bool>>>) {
        let tokens = Arc::new(Mutex::new(TokenStore::new(
            std::env::temp_dir().join(format!("pairing-test-{}.json", std::process::id())),
        )));
        let ws = Arc::new(WsRegistry::new());
        let coordinator = Arc::new(PairingCoordinator::new(tokens, ws));
        let rebinds = Arc::new(Mutex::new(Vec::new()));
        let hook_rebinds = rebinds.clone();
        coordinator.set_rebind_hook(Arc::new(move |lan: bool| {
            hook_rebinds.lock().unwrap_or_else(|e| e.into_inner()).push(lan);
        }));
        coordinator.set_port(8765);
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

        assert!(coordinator.pairing_enabled());
        let status = coordinator.status(now);
        assert_eq!(status.state, "waiting-input");
        assert_eq!(status.bind_mode, "lan");
        assert!(status.code_remaining_ms.is_some());
        assert_eq!(*rebinds.lock().unwrap_or_else(|e| e.into_inner()), vec![true]);
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
