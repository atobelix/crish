//! LocalDb 真适配往返 / 重启恢复 / fail-open 与通道 Debug 形状测试

use super::*;

// ── LocalDb 真适配（D4 §3.8 ①）────────────────────────────────

/// 单声明槽往返：save → load_all 一致；重复 save（不同分发时刻）
/// 最新覆盖不新增（dispatch_* 单值键语义，W9）；产出清单往返 +
/// 整表覆盖；新 store 实例读同一 db → 声明与产出清单完全恢复
/// （模拟重启，D4 §3.8 ③）。
#[test]
fn local_db_wait_store_roundtrip_and_recovery() {
    let db = LocalDb::open_in_memory().expect("内存库打开应成功");
    let first = DispatchDeclaration {
        mode: WaitMode::AwaitAll,
        wait_ms: Some(30_000),
        subagent_ids: vec!["sa-1".to_string(), "sa-2".to_string()],
        dispatched_at_ms: 1_000_000,
    };
    {
        let store = LocalDbWaitStore::new(db.clone());
        store.save(&first);
        let loaded = store.load_all();
        assert_eq!(loaded.len(), 1, "单声明槽：至多一条");
        assert_eq!(loaded[0], first, "读回应与写入一致");
        // 最新覆盖：新分发（不同 dispatched_at）→ 仍单槽不新增
        let second = DispatchDeclaration {
            mode: WaitMode::Timer,
            wait_ms: Some(5_000),
            subagent_ids: vec!["sa-9".to_string()],
            dispatched_at_ms: 2_000_000,
        };
        store.save(&second);
        let loaded = store.load_all();
        assert_eq!(loaded.len(), 1, "单声明槽：重复 save 覆盖不新增");
        assert_eq!(loaded[0], second, "最新声明应覆盖旧声明");
        // 产出清单往返 + 整表覆盖
        let mut outputs = HashMap::new();
        outputs.insert(
            "sa-1".to_string(),
            vec![SubagentOutput {
                path: "01-kernel-analysis.md".to_string(),
                summary: "内核分析完成".to_string(),
                bytes: 1_024,
            }],
        );
        store.save_outputs(&outputs).expect("产出清单落库应成功");
        assert_eq!(store.load_outputs(), outputs, "产出清单读回应与写入一致");
        let second_outputs = HashMap::new();
        store
            .save_outputs(&second_outputs)
            .expect("空清单覆盖落库应成功");
        assert!(
            store.load_outputs().is_empty(),
            "整表覆盖语义（旧条目清除）"
        );
        store.save_outputs(&outputs).expect("重新落库应成功");
        // 模拟重启：新实例读同一 db → 完全恢复（D4 §3.8 ③）
        let recovered = LocalDbWaitStore::new(db.clone());
        let loaded = recovered.load_all();
        assert_eq!(loaded.len(), 1, "重启后声明应恢复（单槽）");
        assert_eq!(loaded[0].dispatched_at_ms, 2_000_000, "重启后基准时刻正确");
        assert_eq!(recovered.load_outputs(), outputs, "重启后产出清单应恢复");
    }
}

/// fail-open：空库 → 空声明集 / 空产出表；部分键缺失 → 空声明集；
/// 损坏键值 → 空（不 panic）。
#[test]
fn local_db_wait_store_fail_open() {
    let db = LocalDb::open_in_memory().expect("内存库打开应成功");
    let store = LocalDbWaitStore::new(db.clone());
    assert!(store.load_all().is_empty(), "空库 → 空声明集（fail-open）");
    assert!(
        store.load_outputs().is_empty(),
        "空库 → 空产出表（fail-open）"
    );
    // 仅 mode 键存在（其余关键键缺失）→ 解析失败返回空
    let _ = db.set_session_meta(DISPATCH_META_KEY_MODE, "await-all");
    assert!(store.load_all().is_empty(), "关键键缺失 → 空声明集");
    // 损坏产出键值 → 空表
    let _ = db.set_session_meta(DISPATCH_META_KEY_OUTPUTS, "not-json");
    assert!(store.load_outputs().is_empty(), "损坏产出键 → 空表");
}

/// 通道 Debug 形状（trait 要求 Debug；不 panic）
#[test]
fn wait_channel_debug_shape() {
    let (channel, _, _, _) = test_channel();
    let debug = format!("{channel:?}");
    assert!(debug.contains("WaitChannel"), "Debug 形状：{debug}");
}
