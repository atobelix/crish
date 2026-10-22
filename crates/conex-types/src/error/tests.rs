use super::*;
use crate::CoreError;

#[test]
fn to_error_payload_roundtrip() {
    let err = CrishError::new(codes::STORE_WRITE_FAILED, "disk full")
        .with_metadata(serde_json::json!({ "path": "/tmp/db" }));
    let payload = err.to_error_payload(0);
    assert_eq!(payload.code, "store.write_failed");
    assert_eq!(payload.message, "disk full");
    assert_eq!(payload.category, CrishErrorCategory::Transient);
    assert!(payload.retryable);
    assert_eq!(
        payload.metadata,
        Some(serde_json::json!({ "path": "/tmp/db" }))
    );
    // JSON roundtrip
    let json = serde_json::to_string(&payload).unwrap();
    let back: CrishErrorPayload = serde_json::from_str(&json).unwrap();
    assert_eq!(payload, back);
}

#[test]
fn payload_serializes_to_camel_case_and_public_field() {
    let err = CrishError::new(codes::TOOL_PATH_ESCAPE, "escape attempt");
    let payload = err.to_error_payload(0);
    let json = serde_json::to_value(&payload).unwrap();
    // is_public 序列化为 "public"
    assert_eq!(json["public"], true);
    // category 序列化为 lowercase
    assert_eq!(json["category"], "security");
    // action 字段存在
    assert_eq!(json["action"], "action.tool.check_path");
    // timestamp 存在
    assert!(json["timestamp"].is_i64());
}

#[test]
fn cause_chain_truncation_at_depth_8() {
    // 构建 10 层 cause 链：depth0 -> depth1 -> ... -> depth9
    let mut err = CrishError::new(codes::COMMON_UNKNOWN, "depth 9");
    for i in (0..9).rev() {
        err = CrishError::new(codes::COMMON_UNKNOWN, format!("depth {i}")).with_cause(err);
    }
    let payload = err.to_error_payload(0);
    // 遍历 cause 链，统计到达截断层的深度
    let mut current = &payload;
    let mut depth = 0u8;
    while let Some(cause) = &current.cause {
        current = cause;
        depth += 1;
    }
    // 第 8 层为截断 payload
    assert_eq!(depth, CRISH_ERROR_CAUSE_MAX_DEPTH);
    assert_eq!(current.code, codes::COMMON_UNKNOWN);
    assert!(current.message.contains("truncated"));
    assert_eq!(
        current.metadata.as_ref().and_then(|m| m.get("truncated")),
        Some(&serde_json::json!(true))
    );
}

#[test]
fn from_core_error_invalid_input() {
    // Q30：显式工厂——调用方按码表选码（此处示范 tool.invalid_input），
    // 不再走 common.unsupported 隐式兜底
    let err = from_core_error_with_context(
        CoreError::InvalidInput("bad input".into()),
        codes::TOOL_INVALID_INPUT,
    );
    assert_eq!(err.code, codes::TOOL_INVALID_INPUT);
    assert_eq!(err.category, CrishErrorCategory::Protocol);
    assert!(!err.is_retryable());
}

#[test]
fn from_core_error_cancelled() {
    let err = from_core_error_with_context(CoreError::Cancelled, codes::COMMON_UNSUPPORTED);
    assert_eq!(err.code, codes::RUNTIME_ABORTED);
    assert_eq!(err.category, CrishErrorCategory::Permanent);
    assert!(!err.is_retryable());
}

#[test]
fn from_core_error_not_found_carries_legacy_kind() {
    let err = from_core_error_with_context(
        CoreError::NotFound("missing".into()),
        codes::COMMON_UNSUPPORTED,
    );
    // 12-T-PD-07：NotFound 主码按单一真源切至 common.not_found
    // （原兜底 common.unknown 随之统一），legacyKind 标记保留
    assert_eq!(err.code, codes::COMMON_NOT_FOUND);
    assert_eq!(
        err.metadata.as_ref().and_then(|m| m.get("legacyKind")),
        Some(&serde_json::json!("NotFound"))
    );
}

#[test]
fn from_unknown_std_error() {
    let io_err = std::io::Error::other("something broke");
    let payload = CrishErrorPayload::from_unknown(&io_err);
    assert_eq!(payload.code, codes::COMMON_UNKNOWN);
    assert_eq!(payload.category, CrishErrorCategory::Permanent);
    assert!(!payload.is_retryable());
    assert!(payload.message.contains("something broke"));
}

#[test]
fn from_unknown_downcasts_crish_error() {
    let crish = CrishError::new(codes::STORE_CORRUPTED, "db corrupted");
    let payload = CrishErrorPayload::from_unknown(&crish);
    assert_eq!(payload.code, codes::STORE_CORRUPTED);
    assert_eq!(payload.category, CrishErrorCategory::Permanent);
}

#[test]
fn unknown_code_falls_back_to_common_unknown() {
    let info_val = info("nonexistent.code");
    assert_eq!(info_val.code, codes::COMMON_UNKNOWN);
    assert_eq!(info_val.category, CrishErrorCategory::Permanent);
}

// ── T-D-08：tool.write_not_allowed 登记断言 ──

/// 硬沙箱错误码已登记：Permanent / 不可重试 / 文案含「写入路径」。
#[test]
fn write_not_allowed_registered() {
    let info_val = info(codes::TOOL_WRITE_NOT_ALLOWED);
    assert_eq!(info_val.code, codes::TOOL_WRITE_NOT_ALLOWED);
    assert_eq!(info_val.category, CrishErrorCategory::Permanent);
    assert!(!info_val.retryable, "越权写为确定拒绝，不可重试");
    assert!(info_val.is_public, "越权拒绝必须对前端可见（编排用）");
    assert!(
        info_val.title.contains("写入路径"),
        "文案「写入路径不在允许范围内」"
    );
    // 构造错误：category/retryable 由注册表派生，payload 出站正确
    let err = CrishError::new(codes::TOOL_WRITE_NOT_ALLOWED, "目标不在允许范围");
    assert_eq!(err.code, codes::TOOL_WRITE_NOT_ALLOWED);
    assert_eq!(err.category, CrishErrorCategory::Permanent);
    assert!(!err.is_retryable());
}

// ── F8-02：tool.write_path_conflict 登记断言（写路径互斥，agent-tools 局部码并入注册表）──

/// 写路径互斥冲突码已登记：Permanent / 不可重试（确定拒绝，
/// 等待占用者释放后由主 agent 编排重试），且对前端可见。
#[test]
fn write_path_conflict_registered() {
    let info_val = info(codes::TOOL_WRITE_PATH_CONFLICT);
    assert_eq!(info_val.code, codes::TOOL_WRITE_PATH_CONFLICT);
    assert_eq!(info_val.category, CrishErrorCategory::Permanent);
    assert!(!info_val.retryable, "互斥冲突为确定拒绝，不可自动重试");
    assert!(info_val.is_public, "冲突须对前端可见（编排串行需要）");
    assert!(info_val.title.contains("互斥"), "文案应含「互斥」");
    // 构造错误：category/retryable 由注册表派生，payload 出站正确
    let err = CrishError::new(codes::TOOL_WRITE_PATH_CONFLICT, "目标已被占用");
    assert_eq!(err.code, codes::TOOL_WRITE_PATH_CONFLICT);
    assert_eq!(err.category, CrishErrorCategory::Permanent);
    assert!(!err.is_retryable());
}

// ── S5：tool.computer.* 8 码 + tool.session.exclusive 登记断言（06 文档 §5 码表）──

/// computer 域 8 码 + 跨线共享码 tool.session.exclusive 全部已登记，
/// category/retryable/is_public 按 06 文档 §5 码表语义与任务分类裁决派生。
#[test]
fn computer_codes_registered() {
    let cases: [(&str, CrishErrorCategory, bool, bool); 9] = [
        // (码, category, retryable, is_public)
        (
            codes::TOOL_COMPUTER_INVALID_PARAMS,
            CrishErrorCategory::Permanent,
            false,
            true,
        ),
        (
            codes::TOOL_COMPUTER_COORDS_OUT_OF_BOUNDS,
            CrishErrorCategory::Permanent,
            false,
            true,
        ),
        (
            codes::TOOL_COMPUTER_ELEVATED_WINDOW,
            CrishErrorCategory::Security,
            false,
            true,
        ),
        (
            codes::TOOL_COMPUTER_NOT_ENABLED,
            CrishErrorCategory::Permanent,
            false,
            true,
        ),
        (
            codes::TOOL_COMPUTER_NOT_READY,
            CrishErrorCategory::Transient,
            true,
            true,
        ),
        (
            codes::TOOL_COMPUTER_CANCELLED,
            CrishErrorCategory::Permanent,
            false,
            false,
        ),
        (
            codes::TOOL_COMPUTER_CAPABILITY_UNAVAILABLE,
            CrishErrorCategory::Security,
            false,
            true,
        ),
        (
            codes::TOOL_COMPUTER_UNWIRED,
            CrishErrorCategory::Permanent,
            false,
            true,
        ),
        (
            codes::TOOL_SESSION_EXCLUSIVE,
            CrishErrorCategory::Permanent,
            false,
            true,
        ),
    ];
    for (code, category, retryable, is_public) in cases {
        let info_val = info(code);
        assert_eq!(info_val.code, code, "{code} 必须已登记");
        assert_eq!(info_val.category, category, "{code} category 不符");
        assert_eq!(info_val.retryable, retryable, "{code} retryable 不符");
        assert_eq!(info_val.is_public, is_public, "{code} is_public 不符");
        // 构造错误：category/retryable 由注册表派生，payload 出站正确
        let err = CrishError::new(code, "test");
        assert_eq!(err.code, code);
        assert_eq!(err.category, category);
        assert_eq!(err.is_retryable(), retryable);
    }
}

// ── PE-03 T03.3：core_error_code 显式映射（6 kind × 主码表 + 注册存在性）──    /// 6 个 kind 全部映射到 78 码体系主码（§2.4.2 映射表逐行断言）。
#[test]
fn core_error_code_maps_all_kinds() {
    assert_eq!(
        core_error_code(&CoreError::InvalidInput("x".into())),
        codes::COMMON_INVALID_INPUT
    );
    assert_eq!(
        core_error_code(&CoreError::Encoding("x".into())),
        codes::COMMON_ENCODING
    );
    assert_eq!(core_error_code(&CoreError::Io("x".into())), codes::STORE_IO);
    assert_eq!(
        core_error_code(&CoreError::NotFound("x".into())),
        codes::COMMON_NOT_FOUND
    );
    assert_eq!(
        core_error_code(&CoreError::Cancelled),
        codes::RUNTIME_ABORTED
    );
    assert_eq!(
        core_error_code(&CoreError::Internal("x".into())),
        codes::COMMON_UNKNOWN
    );
}

/// 映射出的主码必须存在于注册表（info 回查 code 一致），禁止映射到未登记码。
#[test]
fn core_error_code_targets_are_registered() {
    let samples = [
        CoreError::InvalidInput("x".into()),
        CoreError::Encoding("x".into()),
        CoreError::Io("x".into()),
        CoreError::NotFound("x".into()),
        CoreError::Cancelled,
        CoreError::Internal("x".into()),
    ];
    for err in samples {
        let code = core_error_code(&err);
        assert_eq!(
            info(code).code,
            code,
            "主码 {code} 必须已登记（info 回查一致）"
        );
    }
}

/// 主码唯一性：6 个 kind 不得共享同一主码（映射总覆盖 + 区分度）。
#[test]
fn core_error_code_primary_codes_are_unique() {
    let samples = [
        CoreError::InvalidInput("x".into()),
        CoreError::Encoding("x".into()),
        CoreError::Io("x".into()),
        CoreError::NotFound("x".into()),
        CoreError::Cancelled,
        CoreError::Internal("x".into()),
    ];
    let mut codes_seen: Vec<&'static str> = samples.iter().map(core_error_code).collect();
    let before = codes_seen.len();
    codes_seen.sort_unstable();
    codes_seen.dedup();
    assert_eq!(codes_seen.len(), before, "6 个 kind 的主码必须互不相同");
}

/// 双入口一致性（12-T-PD-07）：`from_core_error_with_context` 与
/// `core_error_code` 对同一 kind 产出同一主码——双映射入口共用单一
/// 真源，杜绝「core_error_code 说 common.encoding、上下文映射却说
/// store.corrupted」的码分裂。InvalidInput 例外：Q30 契约由调用方
/// 按上下文选精确码，传入主码本身时双入口一致（其余 5 种 kind 的
/// 入参 "x" 被忽略，码走单一真源）。
#[test]
fn dual_mapping_entries_agree() {
    let kinds = [
        CoreError::InvalidInput("x".into()),
        CoreError::Encoding("x".into()),
        CoreError::Io("x".into()),
        CoreError::NotFound("x".into()),
        CoreError::Cancelled,
        CoreError::Internal("x".into()),
    ];
    for k in kinds {
        let expected = core_error_code(&k);
        let invalid_input_code = match k {
            CoreError::InvalidInput(_) => expected,
            _ => "x",
        };
        let mapped = from_core_error_with_context(k, invalid_input_code);
        assert_eq!(
            mapped.code, expected,
            "双入口对 kind 的主码必须一致（单一真源，禁止散落 map_err）"
        );
    }
}

#[test]
fn crish_error_implements_std_error() {
    let cause = CrishError::new(codes::STORE_CORRUPTED, "root cause");
    let outer = CrishError::new(codes::COMMON_UNKNOWN, "wrapper").with_cause(cause);
    // Display
    assert_eq!(format!("{}", outer), "common.unknown: wrapper");
    // std::error::Error::source
    let src = std::error::Error::source(&outer);
    assert!(src.is_some());
    let src_msg = src.unwrap().to_string();
    assert!(src_msg.contains("store.corrupted"));
}
