//! 令牌哈希 / 签发校验 / 持久化 / 撤销与失败计数测试

use super::*;

#[test]
fn sha256_hex_matches_known_vector() {
    // SHA-256("abc") 标准向量
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(sha256_hex(b"abc").len(), 64);
}

#[test]
fn generate_token_is_64_hex_and_unique() {
    let a = generate_token_hex().expect("CSPRNG 必须可用");
    let b = generate_token_hex().expect("CSPRNG 必须可用");
    assert_eq!(a.len(), 64);
    assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(a, b, "两次生成必须不同");
}

#[test]
fn constant_time_eq_behavior() {
    assert!(constant_time_eq("abc", "abc"));
    assert!(!constant_time_eq("abc", "abd"));
    assert!(!constant_time_eq("abc", "abcd"));
    assert!(!constant_time_eq("", "a"));
    assert!(constant_time_eq("", ""));
}

#[test]
fn issue_verify_roundtrip() {
    let path = temp_file("roundtrip");
    let mut store = TokenStore::new(path.clone());
    let raw = store.issue("Pixel-9", 1000).expect("签发必须成功");
    assert_eq!(store.records().len(), 1);
    // 明文校验通过
    assert_eq!(store.verify(&raw, 2000), TokenVerdict::Valid);
    // 错误令牌 → Invalid
    assert_eq!(store.verify("deadbeef", 2000), TokenVerdict::Invalid);
    // 空串 → Invalid
    assert_eq!(store.verify("", 2000), TokenVerdict::Invalid);
    let _ = fs::remove_file(path);
}

#[test]
fn persisted_file_never_contains_raw_token() {
    let path = temp_file("leak");
    let mut store = TokenStore::new(path.clone());
    let raw = store.issue("Pixel-9", 1000).expect("签发必须成功");
    let text = fs::read_to_string(&path).expect("落盘文件必须存在");
    // 防泄漏：文件里不得出现明文令牌
    assert!(!text.contains(&raw), "pairing.json 不得包含明文令牌");
    // 形状：hash 字段 = 64 字符 hex，且不等于明文
    let file: PairingFile = serde_json::from_str(&text).expect("文件应为合法 pairing.json");
    assert_eq!(file.version, PAIRING_FILE_VERSION);
    assert_eq!(file.tokens.len(), 1);
    assert_eq!(file.tokens[0].hash.len(), 64);
    assert_ne!(file.tokens[0].hash, raw);
    assert_eq!(file.tokens[0].label, "Pixel-9");
    assert!(!file.tokens[0].revoked);
    assert!(file.pairing_enabled);
    let _ = fs::remove_file(path);
}

#[test]
fn revoked_token_fails_verification() {
    let path = temp_file("revoke");
    let mut store = TokenStore::new(path.clone());
    let raw = store.issue("d1", 1000).expect("签发必须成功");
    let hash = sha256_hex(raw.as_bytes());
    assert!(store.revoke(&hash), "撤销应命中");
    assert_eq!(store.verify(&raw, 2000), TokenVerdict::Revoked);
    // 撤销后落盘持久化
    let file: PairingFile = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert!(file.tokens[0].revoked);
    let _ = fs::remove_file(path);
}

#[test]
fn revoke_all_and_save() {
    let path = temp_file("revoke-all");
    let mut store = TokenStore::new(path.clone());
    store.issue("a", 1).unwrap();
    store.issue("b", 1).unwrap();
    store.revoke_all();
    assert_eq!(store.records().iter().filter(|t| !t.revoked).count(), 0);
    let file: PairingFile = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert!(!file.pairing_enabled, "全部撤销后配对面视为关闭");
    let _ = fs::remove_file(path);
}

#[test]
fn persistence_roundtrip_across_reload() {
    let path = temp_file("persist");
    let raw = {
        let mut store = TokenStore::new(path.clone());
        store.issue("iPhone", 1000).unwrap()
    };
    // 重启（重新 load）后令牌仍有效
    let mut reloaded = TokenStore::load(&path);
    assert_eq!(reloaded.records().len(), 1);
    assert_eq!(reloaded.verify(&raw, 3000), TokenVerdict::Valid);
    // last_seen 更新
    assert_eq!(reloaded.records()[0].last_seen_at_ms, 3000);
    let _ = fs::remove_file(path);
}

#[test]
fn load_missing_or_corrupt_file_falls_back_to_empty() {
    let missing = temp_file("missing");
    let store = TokenStore::load(&missing);
    assert!(store.is_empty());
    let _ = fs::remove_file(missing);

    let corrupt = temp_file("corrupt");
    fs::write(&corrupt, "{ 这不是合法 JSON").unwrap();
    let store = TokenStore::load(&corrupt);
    assert!(store.is_empty(), "损坏文件应降级为空库");
    let _ = fs::remove_file(corrupt);
}

// ── R1-10 T-01：认证失败计数 ──

/// T-01 失败计数：伪造令牌（哈希不匹配）每次认证失败按尝试哈希累计；
/// 合法令牌校验成功不产生计数（计数器只对失败路径开火）
#[test]
fn t01_failed_attempts_counted_per_forged_token() {
    let path = temp_file("t01-fail-count");
    let mut store = TokenStore::new(path.clone());
    store.issue("d1", 1000).expect("签发必须成功");

    let forged = "f".repeat(64);
    let forged_hash = sha256_hex(forged.as_bytes());
    // 伪造令牌三连失败：计数必须递增（防爆破的计数锚）
    for expected in 1..=3 {
        assert_eq!(
            store.verify(&forged, 2000),
            TokenVerdict::Invalid,
            "伪造令牌必须认证失败"
        );
        store.record_failed_attempt(&forged);
        assert_eq!(
            store.auth_failure_count(&forged_hash),
            expected,
            "第 {expected} 次失败后计数应为 {expected}"
        );
    }
    // 合法令牌校验成功：不产生失败计数
    let legit = store.issue("d2", 2500).expect("签发必须成功");
    assert_eq!(store.verify(&legit, 3000), TokenVerdict::Valid);
    assert_eq!(
        store.auth_failure_count(&forged_hash),
        3,
        "合法校验不得改写伪造令牌的失败计数"
    );
    let _ = fs::remove_file(path);
}

// ── R1-10 T-11：撤销即时性 ──

/// T-11 撤销即时性：撤销立即生效（verify → Revoked）；重启加载后旧令牌
/// 重放/重连仍被拒（撤销持久化，注册表删除 ≠ 只杀活动会话）
#[test]
fn t11_revoked_token_never_valid_again_across_reload() {
    let path = temp_file("t11-reload");
    let mut store = TokenStore::new(path.clone());
    let raw = store.issue("d1", 1000).expect("签发必须成功");
    let hash = sha256_hex(raw.as_bytes());
    assert_eq!(store.verify(&raw, 1500), TokenVerdict::Valid);

    // 撤销 → 立即可见 Revoked
    assert!(store.revoke(&hash), "撤销应命中");
    assert_eq!(store.verify(&raw, 2000), TokenVerdict::Revoked);

    // 重启加载（模拟服务重启后的重连请求）：旧令牌仍被拒
    let mut reloaded = TokenStore::load(&path);
    assert_eq!(reloaded.verify(&raw, 2500), TokenVerdict::Revoked);

    // 撤销后新签发令牌不影响旧令牌状态（旧令牌不会被复活）
    let new_raw = reloaded.issue("d2", 3000).expect("签发必须成功");
    assert_eq!(reloaded.verify(&new_raw, 3100), TokenVerdict::Valid);
    assert_eq!(reloaded.verify(&raw, 3200), TokenVerdict::Revoked);
    let _ = fs::remove_file(path);
}

/// T-11 撤销即时性：撤销后校验失败（Revoked）不刷新 last_seen——撤销
/// 设备的「活性」随时间冻结，设备列表/审计不再把它当活跃设备
#[test]
fn t11_revoked_verification_does_not_touch_last_seen() {
    let path = temp_file("t11-last-seen");
    let mut store = TokenStore::new(path.clone());
    let raw = store.issue("d1", 1000).expect("签发必须成功");
    assert_eq!(store.verify(&raw, 2000), TokenVerdict::Valid);
    assert_eq!(store.records()[0].last_seen_at_ms, 2000);

    let hash = sha256_hex(raw.as_bytes());
    assert!(store.revoke(&hash));
    assert_eq!(store.verify(&raw, 3000), TokenVerdict::Revoked);
    assert_eq!(
        store.records()[0].last_seen_at_ms,
        2000,
        "撤销后的校验失败不得刷新 last_seen（活性冻结）"
    );
    let _ = fs::remove_file(path);
}

/// T-11 撤销即时性：改名（rename）不得复活已撤销令牌——撤销状态与
/// 设备标签变更相互独立，重连校验仍走 Revoked 分支
#[test]
fn t11_rename_after_revoke_keeps_revoked() {
    let path = temp_file("t11-rename");
    let mut store = TokenStore::new(path.clone());
    let raw = store.issue("d1", 1000).expect("签发必须成功");
    let hash = sha256_hex(raw.as_bytes());
    assert!(store.revoke(&hash));
    assert!(store.rename(&hash, "新名字"), "改名应命中");
    assert_eq!(
        store.verify(&raw, 2000),
        TokenVerdict::Revoked,
        "改名不得复活已撤销令牌"
    );
    assert_eq!(store.records()[0].label, "新名字");
    let _ = fs::remove_file(path);
}
