//! 配对协调器：状态机 / 网络推荐 / 令牌签发与撤销 / 爆破锁定全链。

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
        std::env::temp_dir().join(format!("pairing-test-{}-{unique}.json", std::process::id())),
    )));
    let ws = Arc::new(WsRegistry::new());
    let coordinator = Arc::new(PairingCoordinator::new(tokens, ws.clone()));
    let rebinds = Arc::new(Mutex::new(Vec::new()));
    let hook_rebinds = rebinds.clone();
    coordinator.set_rebind_hook(Arc::new(move |lan: bool| {
        hook_rebinds
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(lan);
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
    assert!(
        result.qr.contains(&result.recommended_ip),
        "二维码内嵌推荐 IP"
    );
    assert!(!result.local_ips.is_empty(), "本机 IP 集合不应为空");
    assert!(
        result.local_ips.contains(&result.recommended_ip),
        "推荐 IP 应在集合内"
    );
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
    assert_eq!(
        *rebinds.lock().unwrap_or_else(|e| e.into_inner()),
        vec![true]
    );
}

#[test]
fn classify_private_vs_public_ip() {
    use std::net::IpAddr;
    let private_ips = [
        "10.0.0.1",
        "10.255.255.255",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.5",
        "fc00::1",
        "fd12:3456::1",
    ];
    let public_ips = [
        "8.8.8.8",
        "100.64.0.1",
        "172.15.255.255",
        "172.32.0.1",
        "192.169.0.1",
        "2001:4860:4860::8888",
        "169.254.1.1",
        "127.0.0.1",
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
    assert_eq!(
        pick_recommended_ip(&only_public).as_deref(),
        Some("8.8.8.8")
    );

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
    assert_eq!(
        *rebinds.lock().unwrap_or_else(|e| e.into_inner()),
        vec![true]
    );
}

#[test]
fn active_devices_track_issued_and_revoked_tokens() {
    let (coordinator, _) = test_coordinator();
    assert!(!coordinator.has_active_devices(), "初始无设备");
    let now = crate::server::now_ms();
    let code = valid_code(&coordinator);
    coordinator
        .complete_pairing(&code, "active-device", now)
        .expect("配对成功必须签发令牌");
    assert!(coordinator.has_active_devices(), "签发后应识别到有效设备");
    coordinator.revoke_all();
    assert!(!coordinator.has_active_devices(), "撤销后不得保持 Lan 依据");
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
    let restart = coordinator
        .start_pairing(after_cooldown + 1)
        .expect("重新开启配对必须成功");
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
    assert_eq!(
        *rebinds.lock().unwrap_or_else(|e| e.into_inner()),
        vec![true, false]
    );
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
    assert_eq!(
        *rebinds.lock().unwrap_or_else(|e| e.into_inner()),
        vec![true, false]
    );
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

#[test]
fn qr_data_for_smoke() {
    let code = PairCode::normalize("CXN-7K4P-Q2MB-9XRT").unwrap();
    assert_eq!(
        qr_data_for(&code, "192.168.1.5", 8765),
        "crish-pair://CXN-7K4P-Q2MB-9XRT@192.168.1.5:8765"
    );
}
