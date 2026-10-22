//! 声明 / 产出清单落库往返与内存存储 fail-open 测试

use super::*;

// ── T-CF-10 验收断言 ─────────────────────────────────────────

/// 声明落库后读回一致（dispatch_* 键数据面 roundtrip）
#[tokio::test]
async fn wait_channel_persist_declaration_roundtrip() {
    let (channel, store, _, _) = test_channel();
    let declaration = DispatchDeclaration {
        mode: WaitMode::Timer,
        wait_ms: Some(30_000),
        subagent_ids: vec!["sa-1".to_string(), "sa-2".to_string()],
        dispatched_at_ms: 1_000_000,
    };
    channel
        .persist_declaration(&declaration)
        .await
        .expect("声明落库应成功");
    let loaded = store.load_all();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0], declaration, "读回应与写入一致");
    // 同一分发时刻重复持久化 → 幂等覆盖不新增
    channel
        .persist_declaration(&declaration)
        .await
        .expect("重复持久化应成功");
    assert_eq!(store.load_all().len(), 1, "同一分发时刻应幂等覆盖");
    // 新分发 → 追加；条数护栏生效（超过上限保留最近）
    for i in 0..DECLARATION_CAP {
        channel
            .persist_declaration(&DispatchDeclaration {
                mode: WaitMode::ParallelWork,
                wait_ms: None,
                subagent_ids: vec![format!("sa-{i}")],
                dispatched_at_ms: 2_000_000 + i as u64,
            })
            .await
            .expect("追加应成功");
    }
    assert_eq!(store.load_all().len(), DECLARATION_CAP, "条数上限应生效");
}

// ── persist_outputs 覆写落库（15-T-7 / DD6-T7）─────────────────

/// persist_outputs 落库 → 读回一致（dispatch_outputs 键形状冻结；
/// 整表覆盖语义天然有界，不引入条数上限）
#[tokio::test]
async fn wait_channel_persist_outputs_roundtrip() {
    let (channel, store, _, _) = test_channel();
    let mut outputs = HashMap::new();
    outputs.insert(
        "sa-1".to_string(),
        vec![SubagentOutput {
            path: "01-kernel-analysis.md".to_string(),
            summary: "内核分析完成".to_string(),
            bytes: 1_024,
        }],
    );
    outputs.insert(
        "sa-2".to_string(),
        vec![SubagentOutput {
            path: "docs/02-frontend.md".to_string(),
            summary: String::new(),
            bytes: 512,
        }],
    );
    channel
        .persist_outputs(&outputs)
        .await
        .expect("产出清单落库应成功");
    // 同实例读回一致（dispatch_outputs 键承载的解析后结构）
    assert_eq!(store.load_outputs(), outputs, "读回应与写入一致");
    // 键形状冻结：对齐 wait_subagents.rs:99 的 DISPATCH_META_KEY_OUTPUTS
    assert_eq!(DISPATCH_META_KEY_OUTPUTS, "dispatch_outputs", "键形状冻结");
    // 整表覆盖：再次落库（仅 sa-3）→ 旧清单被覆盖不合并（天然有界）
    let mut second = HashMap::new();
    second.insert(
        "sa-3".to_string(),
        vec![SubagentOutput {
            path: "03-report.md".to_string(),
            summary: "第三子代理产出".to_string(),
            bytes: 64,
        }],
    );
    channel
        .persist_outputs(&second)
        .await
        .expect("覆盖落库应成功");
    assert_eq!(store.load_outputs(), second, "整表覆盖语义（旧条目清除）");
    assert_eq!(store.load_outputs().len(), 1, "单键覆盖天然有界");
}

/// 落库数据经序列化形状读回一致（模拟 conex-db 真适配路径：
/// session_meta 的 dispatch_outputs 键值经序列化 → 解析恢复，
/// 即「新 store 实例读回」闭环）
#[tokio::test]
async fn wait_channel_persist_outputs_survives_serialized_read_back() {
    let (channel, store, _, _) = test_channel();
    let mut outputs = HashMap::new();
    outputs.insert(
        "sa-1".to_string(),
        vec![SubagentOutput {
            path: "01-kernel-analysis.md".to_string(),
            summary: "内核分析完成".to_string(),
            bytes: 1_024,
        }],
    );
    channel
        .persist_outputs(&outputs)
        .await
        .expect("产出清单落库应成功");
    // 与序列化键值闭环一致：解析 dispatch_outputs 序列化形状应还原落库内容
    let serialized = dispatch_outputs_value(&store.load_outputs());
    let recovered = parse_dispatch_outputs(Some(&serialized));
    assert_eq!(recovered, outputs, "序列化读回与落库一致");
    assert!(
        serialized.contains("01-kernel-analysis.md"),
        "序列化载荷应含产出路径"
    );
    // 损坏 / 缺失键值 → 空表（parse 容错，重启恢复不 panic）
    assert!(parse_dispatch_outputs(None).is_empty(), "缺失键 → 空表");
    assert!(
        parse_dispatch_outputs(Some("not-json")).is_empty(),
        "损坏值 → 空表"
    );
}

/// 未落库 / 空清单 → 空表（fail-open，不 panic）
#[test]
fn memory_wait_store_load_outputs_fail_open_empty() {
    let store = MemoryWaitStore::new();
    assert!(
        store.load_outputs().is_empty(),
        "未落库 → 空表（fail-open）"
    );
    store
        .save_outputs(&HashMap::new())
        .expect("空清单落库应成功");
    assert!(store.load_outputs().is_empty(), "空清单覆盖后仍为空表");
}
