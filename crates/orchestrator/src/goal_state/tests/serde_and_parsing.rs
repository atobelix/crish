use serde_json::json;

use super::*;

// ── U11：无 goal_state / 坏 JSON → fail-open 不 panic ─────────

#[test]
fn u11_from_json_fail_open() {
    assert_eq!(GoalState::from_json(None), None, "缺键 = 无 goal");
    assert_eq!(
        GoalState::from_json(Some("not json{")),
        None,
        "坏 JSON = 无 goal"
    );
    // 字段级容忍：空对象 → 全默认
    let empty = GoalState::from_json(Some("{}")).expect("空对象应取默认态");
    assert_eq!(empty, GoalState::default());
    assert_eq!(empty.schema_version, GOAL_SCHEMA_VERSION);
}

/// 序列化键名断言（snake_case 主体 + schemaVersion/updatedAtMs 驼峰，
/// §4.1 / 02-定夺 S1）
#[test]
fn u11_serialize_shape_snake_case_with_version_fields() {
    let state = GoalState::new("修复构建", 12, 2);
    let value = serde_json::to_value(&state).unwrap();
    assert_eq!(value["goal"], "修复构建");
    assert_eq!(value["max_rounds"], 12);
    assert_eq!(value["max_stalled_rounds"], 2);
    assert_eq!(value["current_round"], 0);
    assert_eq!(value["stalled_rounds"], 0);
    assert!(value.get("progress_signature").is_some());
    assert_eq!(value["schemaVersion"], 1, "schemaVersion 驼峰（S1）");
    assert_eq!(value["updatedAtMs"], 0, "updatedAtMs 驼峰（S1）");
    assert!(value.get("maxRounds").is_none(), "不得序列化为 camelCase");
}

/// 序列化 → 解析往返一致
#[test]
fn u11_roundtrip_preserves_state() {
    let mut state = active_state();
    state.current_round = 3;
    state.stalled_rounds = 1;
    state.progress_signature = Some("tools:fnv1a:7f3a123456789abc".into());
    state.stopped_reason = Some(STOP_REASON.into());
    state.updated_at_ms = 1_789_000_000_000;
    let restored = GoalState::from_json(Some(&state.to_json())).unwrap();
    assert_eq!(restored, state, "往返无损");
}

/// 未知字段忽略 + 缺省字段取默认值（字段级容忍）
#[test]
fn u11_unknown_fields_ignored_and_defaults_applied() {
    let raw = json!({
        "goal": "修复构建",
        "futureField": 42,
        "max_rounds": 5,
    });
    let state = GoalState::from_json(Some(&raw.to_string())).unwrap();
    assert_eq!(state.goal, "修复构建");
    assert_eq!(state.max_rounds, 5);
    assert_eq!(
        state.max_stalled_rounds, DEFAULT_GOAL_MAX_STALLED_ROUNDS,
        "缺省字段取默认值"
    );
    assert_eq!(state.current_round, 0);
    assert!(state.progress_signature.is_none());
}

// ── U12：L2 退化计数——tool_success_count 进入评估面 ─────────

#[test]
fn u12_success_count_reaches_assessment_as_evidence() {
    // 签名相同 + 成功工具结果 → 重置 stalled（计数消费证据）
    let mut state = active_state();
    state.stalled_rounds = 1;
    state.progress_signature = Some("tools:fnv1a:same00000000000".into());
    let calls = [stamp("read_file", &["path"])];
    let input = RoundInput {
        current: state,
        tool_calls: calls.to_vec(),
        tool_success_count: 3,
        ..round(AgentEndReason::Stop, "读取成功", &calls)
    };
    let assessment = assess_round(&input);
    assert_eq!(
        assessment.stalled_delta, 0,
        "成功计数 >0 重置 stalled（L2 证据）"
    );
    // 事件载荷 evidence 数据源：壳层直取 RoundInput.tool_success_count
    assert_eq!(
        input.tool_success_count, 3,
        "壳层可直取计数进 goal-round-completed 载荷"
    );
}

// ── 补充：checklist 解析器（L1 基础）────────────────────────

#[test]
fn checklist_parser_aligned_with_frontend() {
    let text = "\
- [x] 修复构建
- [ ] 补测试
* [X] 写文档
  * [ ] 缩进项
- [x] 本轮总结
- 普通列表项
1. [x] 有序号不算
- [x]任务无空白分隔不算
";
    let items = parse_checklist(text);
    let texts: Vec<(&str, bool)> = items.iter().map(|i| (i.text.as_str(), i.done)).collect();
    assert_eq!(
        texts,
        vec![
            ("修复构建", true),
            ("补测试", false),
            ("写文档", true),
            ("缩进项", false),
        ],
        "伪任务「本轮总结」丢弃，无空白分隔/有序号行不匹配（前端同构）"
    );
}

/// 伪任务中英文前缀全部丢弃
#[test]
fn checklist_pseudo_tasks_dropped() {
    let text = "- [x] 本轮总结\n- [x] 本轮小结\n- [x] 本轮回顾\n- [x] Round Summary: next\n- [x] Summary of this round\n- [x] Round recap\n- [x] iteration summary\n- [x] 真实任务";
    let items = parse_checklist(text);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].text, "真实任务");
}

// ── 补充：文案 DONE 检测（L0 基础）──────────────────────────

#[test]
fn done_detection_matches_frontend() {
    assert!(reply_looks_goal_done("DONE"));
    assert!(reply_looks_goal_done("done"));
    assert!(reply_looks_goal_done("全部完成 DONE"));
    assert!(reply_looks_goal_done("目标已完成"));
    assert!(reply_looks_goal_done("全部任务完成"));
    assert!(reply_looks_goal_done("目标达成"));
    assert!(reply_looks_goal_done("Goal completed successfully"));
    assert!(reply_looks_goal_done("All tasks completed."));
    assert!(reply_looks_goal_done("The goal achieved"));
    assert!(reply_looks_goal_done("  完成 DONE  "));
    assert!(!reply_looks_goal_done(""));
    assert!(
        reply_looks_goal_done(r"DONE 未完成"),
        r"DONE 后空格即单词边界（\bDONE\b）"
    );
    assert!(!reply_looks_goal_done("DONEXX")); // \b 边界
    assert!(!reply_looks_goal_done("XDONE")); // \b 边界
    assert!(!reply_looks_goal_done("随便说说"));
}

// ── 补充：工具批指纹（§3.4 签名语义）────────────────────────

#[test]
fn fingerprint_empty_batch_is_none() {
    assert_eq!(tool_batch_fingerprint(&[]), None, "无工具轮签名不变");
}

#[test]
fn fingerprint_stable_and_param_value_noise_tolerated() {
    let a = [stamp("read_file", &["path"])];
    let b = [stamp("read_file", &["path"])];
    assert_eq!(
        tool_batch_fingerprint(&a),
        tool_batch_fingerprint(&b),
        "同批同签名（确定性）"
    );
    // 参数值噪声容忍（key 集相同，值不同）
    let a = [ToolCallStamp {
        tool_name: "read_file".into(),
        param_keys: vec!["path".into()],
    }];
    let b = [ToolCallStamp {
        tool_name: "read_file".into(),
        param_keys: vec!["path".into()],
    }];
    assert_eq!(tool_batch_fingerprint(&a), tool_batch_fingerprint(&b));
}

#[test]
fn fingerprint_key_order_insensitive_but_call_order_sensitive() {
    let a = [stamp("read_file", &["path", "depth"])];
    let b = [stamp("read_file", &["depth", "path"])];
    assert_eq!(
        tool_batch_fingerprint(&a),
        tool_batch_fingerprint(&b),
        "key 集合排序后拼串，顺序无关"
    );
    let c = [stamp("read_file", &["path"]), stamp("grep", &["pattern"])];
    let d = [stamp("grep", &["pattern"]), stamp("read_file", &["path"])];
    assert_ne!(
        tool_batch_fingerprint(&c),
        tool_batch_fingerprint(&d),
        "工具批顺序敏感（序列整体哈希）"
    );
}

#[test]
fn fingerprint_prefix_shape() {
    let sig = tool_batch_fingerprint(&[stamp("read_file", &["path"])]).unwrap();
    assert!(sig.starts_with("tools:fnv1a:"), "签名带域前缀（§4.1）");
    assert_eq!(sig.len(), "tools:fnv1a:".len() + 16, "十六进制 16 位");
}
