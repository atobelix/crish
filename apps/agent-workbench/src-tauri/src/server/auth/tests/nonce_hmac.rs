//! Nonce 幂等表（弱网重传 / 重放 / 时钟偏差 / LRU）与 HMAC-SHA256 测试

use super::*;

// ── Nonce 幂等表与 HMAC-SHA256 测试 ──

#[test]
fn adversarial_nonce_idempotent_retry_and_clock_sync() {
    let guard = AdvancedNonceGuard::new(1000, 300_000);
    let now = 1_770_800_000_000u64;
    let payload_hash = [0xabu8; 32];

    // 1. 首次合法请求
    let res1 = guard.check_and_record("dev-1", "nonce-100", now, now, payload_hash);
    assert!(matches!(res1, NonceCheckResult::Valid));
    guard.update_response("dev-1", "nonce-100", 200, b"{\"status\":\"ok\"}");

    // 2. 弱网丢包后原样重传 -> 必须幂等返回缓存响应，严禁报错 401
    let res2 = guard.check_and_record("dev-1", "nonce-100", now, now + 2000, payload_hash);
    match res2 {
        NonceCheckResult::IdempotentRetry { status, body } => {
            assert_eq!(status, 200);
            assert_eq!(body, b"{\"status\":\"ok\"}");
        }
        _ => panic!("合法弱网重传必须被判定为 IdempotentRetry"),
    }

    // 3. 恶意篡改 Payload 的相同 Nonce -> 必须拦截
    let tampered_hash = [0xcd; 32];
    let res3 = guard.check_and_record("dev-1", "nonce-100", now, now + 3000, tampered_hash);
    assert!(matches!(res3, NonceCheckResult::ReplayDetected));

    // 4. 时钟偏差 > 300s -> 拦截并返回 ClockSkewTooLarge
    let res4 = guard.check_and_record("dev-1", "nonce-101", now + 350_000, now, payload_hash);
    assert!(matches!(res4, NonceCheckResult::ClockSkewTooLarge { .. }));
}

#[test]
fn adversarial_weak_network_loss_jitter_and_600s_clock_skew_self_healing() {
    let guard = AdvancedNonceGuard::new(1000, DEFAULT_CLOCK_SKEW_MS); // 300_000ms threshold
    let server_base_time_ms = 1_770_800_000_000u64;

    // 1. 模拟客户端存在 600s (600,000ms) 时钟偏差（例如客户端本地时间过快 600s）
    let client_skew_ms = 600_000u64;
    let mut client_local_time_ms = server_base_time_ms + client_skew_ms;
    let payload_hash = [0x5au8; 32];

    // 未进行时钟对齐前发送请求 -> 因时钟偏差 600s > 300s 被守卫拦截，返回 ClockSkewTooLarge
    let unaligned_res = guard.check_and_record(
        "device-mobile-01",
        "nonce-unaligned-001",
        client_local_time_ms,
        server_base_time_ms,
        payload_hash,
    );
    match unaligned_res {
        NonceCheckResult::ClockSkewTooLarge {
            diff_ms,
            max_skew_ms,
        } => {
            assert_eq!(diff_ms, 600_000);
            assert_eq!(max_skew_ms, 300_000);
        }
        _ => panic!("未校准时钟偏差 600s 必须被判定为 ClockSkewTooLarge"),
    }

    // 2. 模拟客户端通过免鉴权 GET /v1/hello 获得服务端时钟 server_time_ms 进行单向时钟对齐
    // 客户端计算 offset = server_time_ms - client_local_time_ms (-600,000ms)
    let simulated_hello_server_time = server_base_time_ms;
    let clock_offset_ms: i64 = simulated_hello_server_time as i64 - client_local_time_ms as i64;
    assert_eq!(clock_offset_ms, -600_000);

    // 3. 模拟弱网环境：30% 丢包率、高达 500ms 抖动（Jitter）、100 次业务请求与重传
    let mut total_attempts = 0;
    let mut total_idempotent_hits = 0;
    let mut total_first_valids = 0;
    let false_positive_401_errors = 0;

    for req_idx in 0..100 {
        let nonce = format!("nonce-tx-{req_idx:04}");
        let req_payload_hash = {
            let mut h = [0u8; 32];
            h[0] = (req_idx & 0xff) as u8;
            h[1] = ((req_idx >> 8) & 0xff) as u8;
            h[2] = 0xee;
            h
        };

        // 客户端推进本地时钟并叠加 jitter（0..500ms）
        client_local_time_ms += 100;
        let jitter_ms = ((req_idx * 37) % 500) as u64; // 0..500ms 伪随机抖动

        // 客户端发送时使用单向对齐后的时间戳
        let aligned_req_ts = (client_local_time_ms as i64 + clock_offset_ms) as u64 + jitter_ms;
        let current_server_now = server_base_time_ms + (req_idx as u64 * 100) + (jitter_ms / 2);

        // 模拟 30% 丢包率（当 req_idx % 10 in [2, 5, 8] 时模拟网络丢包，触发客户端 1~2 次重传）
        let will_drop_packet = (req_idx % 10 == 2) || (req_idx % 10 == 5) || (req_idx % 10 == 8);

        // 首次请求到达服务端
        total_attempts += 1;
        let check1 = guard.check_and_record(
            "device-mobile-01",
            &nonce,
            aligned_req_ts,
            current_server_now,
            req_payload_hash,
        );

        match check1 {
            NonceCheckResult::Valid => {
                total_first_valids += 1;
                let resp_body = format!("{{\"runId\":\"run-{req_idx}\",\"status\":\"success\"}}");
                guard.update_response("device-mobile-01", &nonce, 200, resp_body.as_bytes());
            }
            other => {
                panic!("校准后首次请求必须被放行为 Valid, 实际为: {other:?}");
            }
        }

        // 若发生弱网丢包，客户端发起 1~2 次幂等重传（带 500ms 抖动与相同 Nonce）
        if will_drop_packet {
            let retransmission_count = (req_idx % 2) + 1; // 1 或 2 次重传
            for retry in 1..=retransmission_count {
                total_attempts += 1;
                let retry_jitter_ms = ((req_idx * 41 + retry * 73) % 500) as u64;
                let retry_server_now = current_server_now + 500 + retry_jitter_ms;

                // 客户端重传时保持原 Nonce 与原 Payload 哈希，时间戳保持对齐
                let retry_req_ts = aligned_req_ts;

                let retry_check = guard.check_and_record(
                    "device-mobile-01",
                    &nonce,
                    retry_req_ts,
                    retry_server_now,
                    req_payload_hash,
                );

                match retry_check {
                    NonceCheckResult::IdempotentRetry { status, body } => {
                        total_idempotent_hits += 1;
                        assert_eq!(status, 200);
                        let expected_body =
                            format!("{{\"runId\":\"run-{req_idx}\",\"status\":\"success\"}}");
                        assert_eq!(body, expected_body.as_bytes());
                    }
                    other => {
                        panic!("合法幂等重传严禁报错或失效，实际结果: {other:?}");
                    }
                }
            }
        }
    }

    // 4. 关键指标与断言
    assert_eq!(total_first_valids, 100);
    assert_eq!(total_idempotent_hits, 40); // 30 个丢包请求产生 40 次幂等重传命中
    assert_eq!(total_attempts, 140);
    assert_eq!(false_positive_401_errors, 0, "断言弱网重传 0 误报 401");
}

#[test]
fn nonce_guard_capacity_eviction_lru() {
    let guard = AdvancedNonceGuard::new(3, 300_000);
    let now = 1_000_000u64;

    assert!(matches!(
        guard.check_and_record("d1", "n1", now, now, [1u8; 32]),
        NonceCheckResult::Valid
    ));
    assert!(matches!(
        guard.check_and_record("d1", "n2", now, now, [2u8; 32]),
        NonceCheckResult::Valid
    ));
    assert!(matches!(
        guard.check_and_record("d1", "n3", now, now, [3u8; 32]),
        NonceCheckResult::Valid
    ));
    assert_eq!(guard.len(), 3);

    // 插入第 4 个，淘汰最旧的 n1
    assert!(matches!(
        guard.check_and_record("d1", "n4", now, now, [4u8; 32]),
        NonceCheckResult::Valid
    ));
    assert_eq!(guard.len(), 3);

    // n1 已被驱逐，再次进入视为全新 Valid 请求
    assert!(matches!(
        guard.check_and_record("d1", "n1", now, now, [1u8; 32]),
        NonceCheckResult::Valid
    ));
}

#[test]
fn hmac_helpers_smoke() {
    let key = b"test-secret-key-123456789012345";
    let data = b"payload to be signed";
    let raw_sig = hmac_sha256(key, data);
    assert_eq!(raw_sig.len(), 32);
    let sig = hmac_sha256_hex(key, data);
    assert_eq!(sig.len(), 64);
    assert!(verify_hmac_sha256(key, data, &sig));
    assert!(!verify_hmac_sha256(key, b"different-data", &sig));
    assert!(!verify_hmac_sha256(b"wrong-key", data, &sig));
    assert!(!verify_hmac_sha256(key, data, "invalid-hex"));

    let canon_http =
        canonical_http_signing_payload("dev-1", "POST", "/v1/runs", 1000, "nonce-1", "abcdef");
    assert_eq!(canon_http, "dev-1POST/v1/runs1000nonce-1abcdef");

    let canon_ws =
        canonical_ws_signing_payload("dev-1", 1000, "nonce-1", "msg-1", "runTask", 1, "{}");
    assert_eq!(canon_ws, "dev-11000nonce-1msg-1runTask1{}");
}

#[test]
fn advanced_nonce_guard_methods() {
    let guard = AdvancedNonceGuard::default();
    assert_eq!(guard.clock_skew_ms(), DEFAULT_CLOCK_SKEW_MS);
    assert!(guard.is_empty());
    guard.check_and_record("d1", "n1", 1000, 1000, [0u8; 32]);
    assert!(!guard.is_empty());
    guard.update_response("d1", "n1", 200, b"ok");
    let cached = guard.get_cached_response("d1", "n1");
    assert_eq!(cached, Some((200, b"ok".to_vec())));

    assert_eq!(TOKEN_BYTES, 32);
    assert_eq!(PAIRING_FILE_VERSION, 1);
    assert_eq!(SERVER_TIME_HEADER, "X-Server-Time-Ms");
}
