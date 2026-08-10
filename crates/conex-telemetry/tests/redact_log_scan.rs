//! 集成测试：T-06 日志扫描零命中 / T-09 事件流快照扫描（D5 §9.4 redact 模块）。
//!
//! - `redact_log_scan_e2e`（T-06，D5 §9.1:1166 / §9.4:1276）：构造典型远程
//!   会话日志样本（含明文令牌/配对码/Provider key 形态）→ redact_text 后
//!   扫描零命中断言；另覆盖「落盘日志文件」形态（模拟 DailyFileWriter 产物）。
//! - `event_stream_snapshot_scan_no_key_forms`（T-09，D5 §9.1:1169）：远程
//!   事件流 JSON 快照（含 sk- 形态）→ 扫描断言无密钥形态。
//!
//! 扫描形态口径（D5 §6.3 验证）：43 字符 base64url 令牌 / 完整 sha256 hex /
//! CXN-XXXX-XXXX-XXXX 配对码 / `sk-` 前缀 Provider key。

// 测试代码临时目录清理豁免（clippy.toml 豁免面：「测试代码临时目录清理：
// 非产品删除路径，测试 mod 内 allow + 理由」——临时日志目录是自家测试
// 产物，进回收站反而不正确；与 tests/subscriber_file.rs 等既有测试同款）
#![allow(clippy::disallowed_methods)]

use conex_telemetry::redact::{redact_text, scan_sensitive, SensitiveKind};

/// 典型远程会话日志样本（tracing compact 行形态；刻意植入三处明文敏感
/// 形态——令牌、配对码、Provider key；另含铁律允许的 12 hex 前缀行）。
fn typical_remote_session_log() -> Vec<String> {
    let token_hex64 = "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9";
    let code = "CXN-7K4P-Q2MB-9XRT";
    let key = "sk-proj-ABCDEF123456";
    vec![
        "2026-08-11T10:00:00.000Z  INFO server: 令牌库已加载 path=C:\\Users\\dev\\AppData\\Roaming\\crish\\pairing.json tokens=1".to_string(),
        "2026-08-11T10:00:02.123Z  INFO ws: 连接注册 conn_id=3 label=Pixel-9 token_prefix=0a1b2c3d4e5f".to_string(),
        format!("2026-08-11T10:00:03.456Z  WARN auth: 配对码校验失败 pair.invalid_code code={code}"),
        "2026-08-11T10:00:05.789Z DEBUG ws: 心跳超时（90s 无客户端帧），踢出 conn_id=3".to_string(),
        format!("2026-08-11T10:00:06.000Z ERROR gateway: 认证失败 auth.invalid_token token={token_hex64}"),
        format!("2026-08-11T10:00:07.000Z  INFO core: provider 请求发出 api_key={key}"),
        "2026-08-11T10:00:08.000Z  INFO ws: 连接注销 conn_id=3 label=Pixel-9".to_string(),
    ]
}

/// T-06 令牌窃取·日志泄露：全链路无明文（D5 §6.3 打码铁律）。
///
/// 跑典型远程会话日志样本（含明文令牌/配对码/Provider key 形态）→
/// 逐行 redact_text → 扫描零命中断言；另验证允许的 12 hex 前缀形态
/// 与普通行原样保留（铁律允许形态不被误伤）。
#[test]
fn redact_log_scan_e2e() {
    let log = typical_remote_session_log();

    // 阳性对照：原始样本确实含全部三种敏感形态（扫描器必须能发现——
    // 若事件流/日志真含敏感形态，本断言先行变红）
    let raw = log.join("\n");
    let hits = scan_sensitive(&raw);
    for kind in [
        SensitiveKind::Token,
        SensitiveKind::PairCode,
        SensitiveKind::ProviderKey,
    ] {
        assert!(hits.contains(&kind), "原始样本应命中 {kind:?}");
    }

    // 全链路打码：逐行 redact_text 后扫描零命中（T-06 核心断言）
    let redacted: Vec<String> = log.iter().map(|line| redact_text(line)).collect();
    for line in &redacted {
        assert!(scan_sensitive(line).is_empty(), "打码后不得残留敏感形态：{line}");
    }

    // 允许形态保留：12 hex 前缀（铁律允许）与无敏感形态行不得被误伤
    assert!(
        redacted[1].contains("token_prefix=0a1b2c3d4e5f"),
        "允许的 12 hex 前缀应保留：{}",
        redacted[1]
    );
    assert_eq!(redacted[0], log[0], "无敏感形态行必须原样通过");
    assert_eq!(redacted[3], log[3], "无敏感形态行必须原样通过");
}

/// T-06 落盘形态：真实日志文件（模拟 DailyFileWriter 产物：按日单文件）
/// 读回后经同管线打码，扫描零命中。
#[test]
fn redact_log_scan_file_persisted() {
    let dir = std::env::temp_dir().join(format!("crish-redact-scan-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("临时目录创建应成功");
    let path = dir.join("workbench.20260811.log");
    std::fs::write(&path, typical_remote_session_log().join("\n") + "\n").expect("写入样本日志");

    let content = std::fs::read_to_string(&path).expect("读回日志文件");
    let redacted = redact_text(&content);
    let hits = scan_sensitive(&redacted);
    assert!(hits.is_empty(), "落盘日志打码后必须零命中：{hits:?}");

    let _ = std::fs::remove_dir_all(&dir);
}

/// T-09 密钥不出桌面：远程事件流快照扫描（D5 §9.1:1169）。
///
/// 移动端任何响应/事件流中不得存在 provider key 形态（`sk-` 前缀等）。
/// 样本为典型远程事件流 JSON 快照（信封：type/seq/deviceId/ts/payload，
/// 对齐 D3/M6 信封形态），内含 sk- 形态 + 令牌 + 配对码形态——断言：
/// 1. 阳性对照：原始快照能被扫描器发现全部形态（若事件流真含密钥会红）；
/// 2. 打码后：扫描零命中，且 `sk-`/`CXN-` 前缀整体消失；
/// 3. 打码不破坏 JSON 结构（替换值仍为合法字符串，快照可解析）。
#[test]
fn event_stream_snapshot_scan_no_key_forms() {
    let snapshot = event_stream_snapshot();

    // 阳性对照：三种形态必须全部被扫描器发现
    let hits = scan_sensitive(&snapshot);
    for kind in [
        SensitiveKind::Token,
        SensitiveKind::PairCode,
        SensitiveKind::ProviderKey,
    ] {
        assert!(hits.contains(&kind), "原始快照应命中 {kind:?}");
    }

    // 打码后零命中（T-09 断言：移动端事件流不得存在密钥形态）
    let redacted = redact_text(&snapshot);
    assert!(
        scan_sensitive(&redacted).is_empty(),
        "事件流快照打码后不得残留密钥形态：{redacted}"
    );
    assert!(!redacted.contains("sk-"), "打码后不得含 sk- 前缀：{redacted}");
    assert!(!redacted.contains("CXN-"), "打码后不得含 CXN- 前缀：{redacted}");

    // 打码不破坏 JSON 结构（占位在引号内，仍是合法字符串值）
    let parsed: serde_json::Value = serde_json::from_str(&redacted).expect("打码后快照仍须是合法 JSON");
    assert_eq!(parsed[0]["type"], "session.event", "非敏感字段必须原样保留");
}

/// 远程事件流 JSON 快照样本（信封形态对齐 D3/M6：type/seq/deviceId/ts/payload；
/// 三处敏感形态分别落在 approval 参数、pair.ok、auth.ok 载荷中）。
fn event_stream_snapshot() -> String {
    let token_hex64 = "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9";
    format!(
        "[{{\"type\":\"session.event\",\"seq\":1,\"deviceId\":\"d-1\",\"ts\":1000,\
          \"payload\":{{\"state\":\"established\"}}}},{{\"type\":\"remote-command\",\"seq\":2,\
          \"deviceId\":\"d-1\",\"ts\":1001,\"payload\":{{\"command\":\"git status\"}}}},{{\
          \"type\":\"approval-requested\",\"seq\":3,\"deviceId\":\"d-1\",\"ts\":1002,\"payload\":{{\
          \"tool\":\"config_secret_reveal\",\"parameters\":{{\"api_key\":\"sk-proj-ABCDEF123456\"}}}}}},{{\
          \"type\":\"pair.ok\",\"seq\":4,\"ts\":1003,\"payload\":{{\"code\":\"CXN-7K4P-Q2MB-9XRT\"}}}},{{\
          \"type\":\"auth.ok\",\"seq\":5,\"ts\":1004,\"payload\":{{\"token\":\"{token_hex64}\"}}}}]"
    )
}
