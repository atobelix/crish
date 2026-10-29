//! APNs 供应商测试（apns.rs 拆分）：JWT 签名 / 载荷映射 / 请求与响应。

use super::*;

use crate::push::intent::PayloadDigest;
use crate::push::vendor::{VendorDevice, VendorNotification, VendorPlatform};
use crate::push::PushLevel;

const KEY_ID: &str = "ABC123DEFG";
const TEAM_ID: &str = "TEAMID42";

fn signer() -> (JwtEs256Signer, tempfile::TempDir) {
    // 生成 P-256 密钥 → 写入 PKCS#8 PEM（临时目录）
    let rng = ring::rand::SystemRandom::new();
    let pkcs8 = ring::signature::EcdsaKeyPair::generate_pkcs8(
        &ring::signature::ECDSA_P256_SHA256_FIXED_SIGNING,
        &rng,
    )
    .expect("生成测试密钥");
    // PEM 段内用标准 base64（与 Apple 签发的 .p8 一致）
    use base64::engine::general_purpose::STANDARD;
    let pem = format!(
        "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
        STANDARD.encode(pkcs8.as_ref())
    );
    let dir = tempfile::tempdir().expect("临时目录");
    let path = dir.path().join("AuthKey.p8");
    std::fs::write(&path, pem).expect("写 .p8");
    let signer = JwtEs256Signer::load(&path, KEY_ID, TEAM_ID).expect("加载签名器");
    (signer, dir)
}

fn notification(level: PushLevel, token: &str) -> VendorNotification {
    VendorNotification::new(
        VendorDevice::new("dev-1", token, VendorPlatform::Ios),
        level,
        "approval-requested:tc-9f3a",
        Some("session:s-7".to_string()),
        "approval",
        PayloadDigest {
            session_id: "s-7".to_string(),
            biz_key: "tc-9f3a".to_string(),
            digest: Some("执行部署脚本".to_string()),
            detail: Some("bash".to_string()),
        },
    )
}

/// JWT 结构断言：三段 base64url、header/claims 字段、签名 64 字节可验签
#[test]
fn jwt_structure_es256_signature() {
    let (signer, _dir) = signer();
    let now = 1_786_214_400;
    let jwt = signer.sign(now).expect("签发 JWT");

    let parts: Vec<&str> = jwt.split('.').collect();
    assert_eq!(parts.len(), 3, "JWT 必为三段");

    // header：alg=ES256、kid=KeyID
    let header: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).expect("header base64url"))
            .expect("header JSON");
    assert_eq!(header["alg"], "ES256");
    assert_eq!(header["kid"], KEY_ID);

    // claims：iss=TeamID、iat=now、exp=now+1h
    let claims: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).expect("claims base64url"))
            .expect("claims JSON");
    assert_eq!(claims["iss"], TEAM_ID);
    assert_eq!(claims["iat"], now);
    assert_eq!(claims["exp"], now + APNS_JWT_TTL_SECS);

    // 签名：64 字节裸 r||s，且用公钥验签通过
    let signature = URL_SAFE_NO_PAD.decode(parts[2]).expect("签名 base64url");
    assert_eq!(signature.len(), 64, "ES256 签名为裸 r||s 64 字节");
    let signing_input = format!("{}.{}", parts[0], parts[1]);
    ring::signature::UnparsedPublicKey::new(
        &ring::signature::ECDSA_P256_SHA256_FIXED,
        signer.public_key(),
    )
    .verify(signing_input.as_bytes(), &signature)
    .expect("签名可用公钥验证");
}

/// 签名确定性不做断言（ECDSA 随机化），但结构稳定：同输入两次签发
/// 都满足三段 + 验签
#[test]
fn jwt_sign_twice_both_valid() {
    let (signer, _dir) = signer();
    let now = 1_786_214_400;
    for _ in 0..2 {
        let jwt = signer.sign(now).expect("签发 JWT");
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let signature = URL_SAFE_NO_PAD.decode(parts[2]).expect("签名 base64url");
        assert_eq!(signature.len(), 64);
        let signing_input = format!("{}.{}", parts[0], parts[1]);
        ring::signature::UnparsedPublicKey::new(
            &ring::signature::ECDSA_P256_SHA256_FIXED,
            signer.public_key(),
        )
        .verify(signing_input.as_bytes(), &signature)
        .expect("验签通过");
    }
}

/// 坏 .p8 → Credential 错误（格式错 / 缺文件）
#[test]
fn jwt_load_rejects_bad_key() {
    let dir = tempfile::tempdir().expect("临时目录");
    let bad = dir.path().join("bad.p8");
    std::fs::write(&bad, "not a pem").expect("写坏文件");
    assert!(matches!(
        JwtEs256Signer::load(&bad, KEY_ID, TEAM_ID),
        Err(VendorError::Credential(_))
    ));

    let missing = dir.path().join("missing.p8");
    assert!(matches!(
        JwtEs256Signer::load(&missing, KEY_ID, TEAM_ID),
        Err(VendorError::Io { .. })
    ));
}

/// 载荷映射（D7 §3.3.13 S1 样例对齐）：alert/badge/sound/thread-id/
/// interruption-level/crish 白名单
#[test]
fn payload_maps_s1_approval_sample() {
    let n = notification(PushLevel::P0Critical, "tok-1");
    let payload = apns_payload(&n);
    assert_eq!(payload.aps.alert.title, "bash");
    assert_eq!(payload.aps.alert.body, "执行部署脚本");
    assert_eq!(payload.aps.sound, "default");
    assert_eq!(payload.aps.badge, 1);
    assert_eq!(payload.aps.thread_id.as_deref(), Some("session:s-7"));
    assert_eq!(payload.aps.interruption_level, Some("active"));

    let crish = payload.crish.expect("crish 白名单");
    assert_eq!(crish.session_id.as_deref(), Some("s-7"));
    assert_eq!(crish.biz_key.as_deref(), Some("tc-9f3a"));
}

/// 级别 → interruption-level 映射（M8 §2.2.3-3）
#[test]
fn payload_interruption_level_by_severity() {
    assert_eq!(interruption_level(PushLevel::P0Critical), "active");
    assert_eq!(interruption_level(PushLevel::P1Important), "active");
    assert_eq!(interruption_level(PushLevel::P2Collapsible), "passive");
}

/// 截断上限（§6.2 title ≤ 30 字 / §6.3 body ≤ 120 字，中文按字计）
#[test]
fn payload_truncates_long_text() {
    let long = "超长正文".repeat(50); // 200 字
    let n = VendorNotification::new(
        VendorDevice::new("d", "tok", VendorPlatform::Ios),
        PushLevel::P1Important,
        "run-terminal:run-1",
        None,
        "run",
        PayloadDigest {
            session_id: "s".to_string(),
            biz_key: "run-1".to_string(),
            digest: Some(long),
            detail: Some("很长的标题".repeat(20)),
        },
    );
    let payload = apns_payload(&n);
    assert_eq!(
        payload.aps.alert.title.chars().count(),
        APNS_TITLE_MAX_CHARS
    );
    assert_eq!(payload.aps.alert.body.chars().count(), APNS_BODY_MAX_CHARS);
}

/// 缺省标题：detail 为空 → "Crish 通知"；digest 为空 → 空正文不 panic
#[test]
fn payload_falls_back_when_text_missing() {
    let n = VendorNotification::new(
        VendorDevice::new("d", "tok", VendorPlatform::Ios),
        PushLevel::P2Collapsible,
        "cache-waste-alert:run-9",
        None,
        "summary",
        PayloadDigest::default(),
    );
    let payload = apns_payload(&n);
    assert_eq!(payload.aps.alert.title, APNS_DEFAULT_TITLE);
    assert_eq!(payload.aps.alert.body, "");
    assert_eq!(payload.aps.interruption_level, Some("passive"));
}

/// 请求构造：URL /3/device/{token}、bearer 头、apns-topic=bundle id、
/// collapse-id、body = 载荷 JSON
#[test]
fn build_request_prod_and_sandbox() {
    let creds = APNsCredentials {
        auth_key_path: "AuthKey.p8".into(),
        key_id: KEY_ID.to_string(),
        team_id: TEAM_ID.to_string(),
        bundle_id: "com.crish.mobile".to_string(),
        sandbox: false,
    };
    let n = notification(PushLevel::P0Critical, "tok-1");
    let req = build_apns_send_request(&creds, &n, "jwt-abc").expect("构造请求");
    assert_eq!(req.url, "https://api.push.apple.com/3/device/tok-1");
    assert_eq!(req.authorization, "bearer jwt-abc");
    assert_eq!(req.apns_push_type, "alert");
    assert_eq!(req.apns_priority, 10);
    assert_eq!(req.apns_topic, "com.crish.mobile");
    assert_eq!(req.apns_collapse_id.as_deref(), Some("session:s-7"));
    let body: serde_json::Value = serde_json::from_slice(&req.body).expect("body 是 JSON");
    assert_eq!(body["aps"]["alert"]["title"], "bash");

    let sandbox_creds = APNsCredentials {
        sandbox: true,
        ..creds.clone()
    };
    let req_sandbox = build_apns_send_request(&sandbox_creds, &n, "jwt").expect("沙箱请求");
    assert_eq!(
        req_sandbox.url,
        "https://api.sandbox.push.apple.com/3/device/tok-1"
    );

    // 空 token → Build 错误
    let empty = VendorNotification::new(
        VendorDevice::new("d", "", VendorPlatform::Ios),
        PushLevel::P0Critical,
        "k",
        None,
        "run",
        PayloadDigest::default(),
    );
    assert!(matches!(
        build_apns_send_request(&creds, &empty, "jwt"),
        Err(VendorError::Build(_))
    ));
}

/// 响应解析矩阵（M8 §2.2.3-4）
#[test]
fn response_status_to_outcome() {
    assert_eq!(
        parse_apns_response(200, None, None),
        VendorSendOutcome::Delivered
    );
    assert_eq!(
        parse_apns_response(410, Some(r#"{"reason":"Unregistered"}"#), None),
        VendorSendOutcome::DeviceNotRegistered
    );
    // 429 → RateLimited + Retry-After 秒值
    assert_eq!(
        parse_apns_response(429, None, Some("30")),
        VendorSendOutcome::RateLimited {
            retry_after: Some(std::time::Duration::from_secs(30))
        }
    );
    // 400/403 → 永久失败（reason 从 body 提取）
    match parse_apns_response(400, Some(r#"{"reason":"BadDeviceToken"}"#), None) {
        VendorSendOutcome::FailedPermanent { reason } => {
            assert_eq!(reason, "BadDeviceToken")
        }
        other => panic!("400 应永久失败：{other:?}"),
    }
    match parse_apns_response(403, None, None) {
        VendorSendOutcome::FailedPermanent { .. } => {}
        other => panic!("403 应永久失败：{other:?}"),
    }
    // 5xx → 可重试
    assert_eq!(
        parse_apns_response(503, None, None),
        VendorSendOutcome::FailedRetryable { retry_after: None }
    );
    // 未预期状态码 → 永久失败
    match parse_apns_response(418, None, None) {
        VendorSendOutcome::FailedPermanent { reason } => {
            assert!(reason.contains("418"))
        }
        other => panic!("418 应永久失败：{other:?}"),
    }
}

/// Retry-After 解析：非法值 → None
#[test]
fn retry_after_parse_handles_bad_values() {
    assert_eq!(parse_retry_after(None), None);
    assert_eq!(parse_retry_after(Some("abc")), None);
    assert_eq!(
        parse_retry_after(Some(" 15 ")),
        Some(std::time::Duration::from_secs(15))
    );
}

/// 截断辅助：UTF-8 安全（多字节字符不撕裂）
#[test]
fn truncate_chars_utf8_safe() {
    assert_eq!(truncate_chars("审批请求", 2), "审批");
    assert_eq!(truncate_chars("abcd", 3), "abc");
    assert_eq!(truncate_chars("短", 100), "短");
}
