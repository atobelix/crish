//! wait_subagents 测试 · 调度声明序列化、dispatch_* 落库与重启恢复、通道错误映射、dispatch_outputs 往返（自 wait_subagents_tests.rs 纯搬迁）

use super::*;

// ── 调度声明：序列化与剩余等待（重启恢复）───────────────────

#[test]
fn declaration_meta_pairs_roundtrip() {
    let decl = DispatchDeclaration {
        mode: WaitMode::Timer,
        wait_ms: Some(30_000),
        subagent_ids: vec!["sub-1".to_string(), "sub-2".to_string()],
        dispatched_at_ms: 1_000_000,
    };
    let pairs = decl.to_meta_pairs();
    assert_eq!(pairs[0].0, "dispatch_mode");
    assert_eq!(pairs[0].1, "timer");
    assert_eq!(pairs[1].0, "dispatch_wait_ms");
    assert_eq!(pairs[1].1, "30000");
    assert_eq!(pairs[2].0, "dispatch_agents");
    assert!(pairs[2].1.contains("sub-1"));
    let restored = DispatchDeclaration::from_meta_pairs(pairs).expect("恢复声明");
    assert_eq!(restored, decl);
}

#[test]
fn declaration_remaining_wait_computation() {
    let decl = DispatchDeclaration {
        mode: WaitMode::Timer,
        wait_ms: Some(30_000),
        subagent_ids: vec!["sub-1".to_string()],
        dispatched_at_ms: 1_000_000,
    };
    assert_eq!(decl.remaining_wait_ms(1_010_000), Some(20_000));
    assert_eq!(decl.remaining_wait_ms(1_030_000), Some(0));
    assert!(decl.is_expired(1_030_000));
    assert!(!decl.is_expired(1_029_999));
    // 不限时（await-all / parallel-work 缺省）：剩余恒 None
    let unlimited = DispatchDeclaration {
        mode: WaitMode::AwaitAll,
        wait_ms: None,
        subagent_ids: vec!["sub-1".to_string()],
        dispatched_at_ms: 1_000_000,
    };
    assert_eq!(unlimited.remaining_wait_ms(u64::MAX), None);
}

#[test]
fn declaration_from_meta_pairs_fail_open() {
    // 关键键缺失 / 非法 → None（不 panic）
    assert!(
        DispatchDeclaration::from_meta_pairs([("dispatch_mode", "timer".to_string())]).is_none()
    );
    let bad = vec![
        ("dispatch_mode", "timer".to_string()),
        ("dispatch_wait_ms", "abc".to_string()),
        ("dispatch_agents", "[]".to_string()),
        ("dispatch_dispatched_at", "1000".to_string()),
    ];
    assert!(
        DispatchDeclaration::from_meta_pairs(bad).is_none(),
        "空清单视为无效"
    );
    // wait_ms 非法 → 宽容为 None（不限时）
    let ok = vec![
        ("dispatch_mode", "timer".to_string()),
        ("dispatch_wait_ms", "abc".to_string()),
        ("dispatch_agents", "[\"sub-1\"]".to_string()),
        ("dispatch_dispatched_at", "1000".to_string()),
    ];
    let decl = DispatchDeclaration::from_meta_pairs(ok).expect("恢复");
    assert_eq!(decl.mode, WaitMode::Timer);
    assert_eq!(decl.wait_ms, None);
}

// ── dispatch_* 落库与重启恢复（conex-db dev-dependency）───────

/// 引擎侧同构的 dispatch_* 存储（session_meta 键 → 值，只读接口）
struct DbDispatchStore {
    db: conex_db::LocalDb,
}

impl DbDispatchStore {
    fn persist(&self, declaration: &DispatchDeclaration) -> Result<(), conex_db::DbFailure> {
        for (key, value) in declaration.to_meta_pairs() {
            self.db.set_session_meta(key, &value)?;
        }
        Ok(())
    }

    fn load(&self) -> Option<DispatchDeclaration> {
        let pairs = [
            DISPATCH_META_KEY_MODE,
            DISPATCH_META_KEY_WAIT_MS,
            DISPATCH_META_KEY_AGENTS,
            DISPATCH_META_KEY_DISPATCHED_AT,
        ]
        .iter()
        .filter_map(|key| {
            self.db
                .get_session_meta(key)
                .ok()
                .flatten()
                .map(|value| (*key, value))
        })
        .collect::<Vec<_>>();
        DispatchDeclaration::from_meta_pairs(pairs)
    }
}

#[test]
fn dispatch_meta_persists_across_restart() {
    let ws = TempWorkspace::new("wait_dispatch_meta");
    let db_path = ws.path().join("sessions.db");
    let declaration = DispatchDeclaration {
        mode: WaitMode::Timer,
        wait_ms: Some(30_000),
        subagent_ids: vec!["sub-1".to_string(), "sub-2".to_string()],
        dispatched_at_ms: 1_000_000,
    };

    // 第一次打开：持久化调度声明
    {
        let db = conex_db::LocalDb::open(&db_path).expect("打开测试库失败");
        DbDispatchStore { db }
            .persist(&declaration)
            .expect("落库失败");
    }

    // 模拟重启：重新打开同一库文件，恢复「等待什么」
    let db = conex_db::LocalDb::open(&db_path).expect("重开测试库失败");
    let restored = DbDispatchStore { db }.load().expect("重启恢复声明");
    assert_eq!(restored, declaration);
    assert_eq!(
        restored.remaining_wait_ms(1_010_000),
        Some(20_000),
        "重启后按 dispatch_dispatched_at 重算剩余等待"
    );
    assert!(restored.is_expired(1_030_000), "到点判定可跨重启");
}

#[test]
fn dispatch_meta_mode_roundtrip_all_modes() {
    let ws = TempWorkspace::new("wait_dispatch_modes");
    let db = conex_db::LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
    let store = DbDispatchStore { db };
    for (mode, wait_ms) in [
        (WaitMode::AwaitAll, None),
        (WaitMode::Timer, Some(45_000)),
        (WaitMode::ParallelWork, None),
    ] {
        let declaration = DispatchDeclaration {
            mode,
            wait_ms,
            subagent_ids: vec!["sub-1".to_string()],
            dispatched_at_ms: 2_000_000,
        };
        store.persist(&declaration).expect("落库失败");
        let restored = store.load().expect("恢复");
        assert_eq!(restored, declaration, "模式 {mode:?} 跨写读一致");
    }
}

// ── 通道错误映射 ──────────────────────────────────────────────

#[test]
fn wait_error_codes_mapped() {
    assert_eq!(
        SubagentWaitError::UnknownAgent("x".to_string()).code(),
        "common.not_found"
    );
    assert_eq!(
        SubagentWaitError::PersistFailed("e".to_string()).code(),
        "store.write_failed"
    );
    assert_eq!(
        SubagentWaitError::InjectFailed("e".to_string()).code(),
        "tool.execution_failed"
    );
    assert_eq!(
        SubagentWaitError::Unavailable("e".to_string()).code(),
        "common.unsupported"
    );
}

// ── dispatch_outputs 持久化 JSON：往返与旧数据兼容 ─────────────

/// 序列化 → 解析往返一致
#[test]
fn dispatch_outputs_value_roundtrip() {
    let mut outputs = HashMap::new();
    outputs.insert(
        "sub-1".to_string(),
        vec![
            SubagentOutput {
                path: "01-kernel-analysis.md".to_string(),
                summary: "内核分析完成".to_string(),
                bytes: 1_024,
            },
            SubagentOutput {
                path: "docs/02-frontend.md".to_string(),
                summary: "内核分析完成".to_string(),
                bytes: 512,
            },
        ],
    );
    outputs.insert(
        "sub-2".to_string(),
        vec![SubagentOutput {
            path: "03-missing.md".to_string(),
            summary: String::new(),
            bytes: 0,
        }],
    );
    let value = dispatch_outputs_value(&outputs);
    let parsed = parse_dispatch_outputs(Some(&value));
    assert_eq!(parsed, outputs, "序列化 → 解析往返一致");
}

/// 旧数据兼容（parse 容错，对齐 explore_quota.rs:70-88）：
/// 缺失键 / 损坏 JSON / 非对象 → 空清单，不回退
#[test]
fn dispatch_outputs_parse_tolerant_for_old_data() {
    assert!(parse_dispatch_outputs(None).is_empty(), "旧格式无该键 → 空");
    assert!(
        parse_dispatch_outputs(Some("not-json")).is_empty(),
        "损坏 JSON → 空"
    );
    assert!(
        parse_dispatch_outputs(Some("[1, 2]")).is_empty(),
        "非对象 → 空"
    );
    assert!(parse_dispatch_outputs(Some("{}")).is_empty(), "空对象 → 空");
}

/// 条目级容错：单条损坏不影响其余条目解析（bytes 非法值按 0 兜底）
#[test]
fn dispatch_outputs_parse_entry_level_tolerance() {
    let value = r#"{
        "sub-1": [
            {"path": "01.md", "summary": "s", "bytes": 12},
            {"path": ""},
            {"summary": "缺路径"}
        ],
        "sub-2": "不是数组",
        "sub-3": [{"path": "03.md", "bytes": "非数字"}]
    }"#;
    let parsed = parse_dispatch_outputs(Some(value));
    assert_eq!(parsed.len(), 2, "非法条目与非法键跳过，合法条目保留");
    // sub-1：仅合法条目保留，非法条目丢弃
    assert_eq!(parsed["sub-1"].len(), 1);
    assert_eq!(parsed["sub-1"][0].path, "01.md");
    assert_eq!(parsed["sub-1"][0].summary, "s");
    assert_eq!(parsed["sub-1"][0].bytes, 12);
    // sub-3：path 合法即保留，bytes 非法值按 0 兜底（容错不丢弃）
    assert_eq!(parsed["sub-3"].len(), 1);
    assert_eq!(parsed["sub-3"][0].path, "03.md");
    assert_eq!(parsed["sub-3"][0].bytes, 0);
}

/// 旧格式 dispatch 数据解析不回退：有无 dispatch_outputs 键均可恢复
/// 声明（未知键忽略，from_meta_pairs 既有 `_ => {}` 容错）
#[test]
fn dispatch_declaration_parses_with_and_without_outputs_key() {
    // 旧格式（F9 及以前，无 dispatch_outputs 键）
    let old = vec![
        ("dispatch_mode", "await-all".to_string()),
        ("dispatch_wait_ms", "0".to_string()),
        ("dispatch_agents", "[\"sub-1\",\"sub-2\"]".to_string()),
        ("dispatch_dispatched_at", "1000".to_string()),
    ];
    let decl = DispatchDeclaration::from_meta_pairs(old).expect("旧格式必须可恢复");
    assert_eq!(decl.subagent_ids, vec!["sub-1", "sub-2"]);
    // 新格式（含 dispatch_outputs 键）同样可恢复，键值互不影响
    let mut outputs = HashMap::new();
    outputs.insert(
        "sub-1".to_string(),
        vec![SubagentOutput {
            path: "01.md".to_string(),
            summary: "s".to_string(),
            bytes: 12,
        }],
    );
    let new = vec![
        ("dispatch_mode", "await-all".to_string()),
        ("dispatch_wait_ms", "0".to_string()),
        ("dispatch_agents", "[\"sub-1\",\"sub-2\"]".to_string()),
        ("dispatch_dispatched_at", "1000".to_string()),
        (DISPATCH_META_KEY_OUTPUTS, dispatch_outputs_value(&outputs)),
    ];
    let decl = DispatchDeclaration::from_meta_pairs(new).expect("新格式必须可恢复");
    assert_eq!(decl.subagent_ids, vec!["sub-1", "sub-2"]);
    // dispatch_outputs 值经独立解析函数读回（声明结构不含该字段）
    let parsed = parse_dispatch_outputs(Some(&dispatch_outputs_value(&outputs)));
    assert_eq!(parsed, outputs);
}
