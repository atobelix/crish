//! stage_summary 模块测试（G-02 批 1 顺带拆：测试外置至 stage_summary_tests.rs，
//! 行为零变更；模块内 `#[cfg(test)] #[path = "stage_summary_tests.rs"] mod tests;`
//! 接线，仿 shell.rs/subagent.rs 测试旁挂先例）

use super::*;
use conex_compaction::summary_document::validate_summary_document;

fn sample_document(stage_index: u32) -> serde_json::Value {
    build_stage_summary_document(&StageSummaryDocument {
        stage_index,
        block_id: format!("stage-summary-{}", stage_index + 1),
        generation: 1,
        goal: "实现分阶段总结".to_string(),
        constraints: vec!["每阶梯只触发一次".to_string()],
        progress: vec!["里程碑判定已落地".to_string(), "Schema 构造已落地".to_string()],
        decisions: vec!["系统段注入为主选".to_string()],
        next_steps: vec!["接线 run 收口触发".to_string()],
        critical_context: "estimate/window 双源口径".to_string(),
        range: Some(StageSummaryRange {
            start_message_id: "m1".to_string(),
            end_message_id: "m40".to_string(),
            message_count: 40,
        }),
    })
}

// ── 配置解析（E2 §7.1 / 07 §4.5 测试 4）───────────────────────

#[test]
fn parse_stage_ratios_accepts_json_array() {
    assert_eq!(parse_stage_ratios("[0.4,0.6,0.8]"), Some(vec![0.4, 0.6, 0.8]));
    assert_eq!(parse_stage_ratios("[0.5]"), Some(vec![0.5]), "单阶梯可配");
}

#[test]
fn parse_stage_ratios_accepts_single_number() {
    assert_eq!(parse_stage_ratios("0.5"), Some(vec![0.5]));
}

#[test]
fn parse_stage_ratios_filters_invalid_items() {
    // 非数值 / 负值 / 超 1（比例超窗）→ 丢弃；合法项保留
    assert_eq!(
        parse_stage_ratios(r#"[0.4,"x",0.6,-0.1,1.5]"#),
        Some(vec![0.4, 0.6])
    );
    // 乱序 → 升序归一（判定遍历确定性）
    assert_eq!(parse_stage_ratios("[0.8,0.4,0.6]"), Some(vec![0.4, 0.6, 0.8]));
    // 重复 → 去重
    assert_eq!(parse_stage_ratios("[0.4,0.4,0.6]"), Some(vec![0.4, 0.6]));
}

#[test]
fn parse_stage_ratios_malformed_falls_back() {
    assert_eq!(parse_stage_ratios("not-a-number"), None);
    assert_eq!(parse_stage_ratios("[]"), None, "空数组 → None（回退默认）");
    assert_eq!(parse_stage_ratios("[0,0]"), None, "全非法项 → None");
    assert_eq!(parse_stage_ratios("{\"a\":1}"), None, "非数组对象 → None");
}

#[test]
fn stage_ratios_from_session_meta_fail_open() {
    assert_eq!(stage_ratios_from_session_meta(|_| None), None, "键缺失 → None");
    assert_eq!(
        stage_ratios_from_session_meta(|k| if k == META_KEY_STAGE_RATIOS {
            Some("[0.4,0.6,0.8]".to_string())
        } else {
            None
        }),
        Some(vec![0.4, 0.6, 0.8])
    );
    assert_eq!(
        stage_ratios_from_session_meta(|k| if k == META_KEY_STAGE_RATIOS {
            Some("bad".to_string())
        } else {
            None
        }),
        None,
        "键存在但非法 → None（fail-open 回退默认）"
    );
}

// ── 里程碑判定（07 §4.4 测试 1：40/60/80 边界 + 每阶梯一次）────

#[test]
fn milestone_boundaries_40_60_80() {
    let ratios = [0.4, 0.6, 0.8];
    // 阈值严格达到才触发（< 阈值不触发；≥ 阈值触发）
    assert_eq!(next_pending_milestone(0.399, &ratios, &[]), None);
    assert_eq!(next_pending_milestone(0.4, &ratios, &[]), Some(0));
    // 0.6 未达且 0.4 已触发 → None
    assert_eq!(next_pending_milestone(0.59, &ratios, &[0]), None);
    assert_eq!(next_pending_milestone(0.6, &ratios, &[0]), Some(1));
    assert_eq!(next_pending_milestone(0.8, &ratios, &[0, 1]), Some(2));
    // 满窗（ratio ≥ 1）仍只触发最后一个未触发里程碑
    assert_eq!(next_pending_milestone(1.0, &ratios, &[0, 1]), Some(2));
}

#[test]
fn milestone_triggered_suppression_once_per_stage() {
    let ratios = [0.4, 0.6, 0.8];
    // 已触发抑制：0.5 只跨过 0.4（已触发）→ 0.6 未达标 → None（同阶梯
    // 不重复、未达标阶梯不提前触发）
    assert_eq!(next_pending_milestone(0.5, &ratios, &[0]), None);
    // 0.6 达标 → 触发 0.6（0.4 已触发不重复）
    assert_eq!(next_pending_milestone(0.6, &ratios, &[0]), Some(1));
    // 0.85 达标 → 触发 0.8（0.4/0.6 已触发不重复）
    assert_eq!(next_pending_milestone(0.85, &ratios, &[0, 1]), Some(2));
    // 全触发 → None（每阶梯对话生命周期内只触发一次）
    assert_eq!(next_pending_milestone(1.0, &ratios, &[0, 1, 2]), None);
}

#[test]
fn milestone_unusual_order_backfills_lower_stages() {
    let ratios = [0.4, 0.6, 0.8];
    // 异常顺序：高阶梯已触发而低阶梯未触发 → 补触发低阶梯
    assert_eq!(next_pending_milestone(0.5, &ratios, &[2]), Some(0));
    assert_eq!(next_pending_milestone(0.7, &ratios, &[2]), Some(0));
}

#[test]
fn milestone_defensive_edge_cases() {
    // 空阶梯 / 空触发集合 → None
    assert_eq!(next_pending_milestone(0.9, &[], &[]), None);
    // 非有限 / 负比例 → None（防御，不触发）
    assert_eq!(next_pending_milestone(f64::NAN, &[0.4], &[]), None);
    assert_eq!(next_pending_milestone(f64::INFINITY, &[0.4], &[]), None);
    assert_eq!(next_pending_milestone(-1.0, &[0.4], &[]), None);
    // 配置中含非有限阈值 → 跳过
    assert_eq!(next_pending_milestone(0.9, &[f64::NAN, 0.6], &[]), Some(1));
}

#[test]
fn estimate_ratio_window_zero_never_triggers() {
    assert_eq!(estimate_ratio(0, 0), 0.0, "窗口 0 → 0.0（永不触发）");
    assert_eq!(estimate_ratio(40, 100), 0.4);
    assert_eq!(estimate_ratio(80, 100), 0.8);
    assert_eq!(estimate_ratio(120, 100), 1.2, "超窗比例放行（≥ 阈值即可触发）");
}

// ── 已触发状态容器 ─────────────────────────────────────────────

#[test]
fn milestone_state_marks_and_queries() {
    let mut state = StageMilestoneState::new();
    assert!(!state.has_triggered(0));
    state.mark_triggered(0);
    state.mark_triggered(1);
    assert!(state.has_triggered(0) && state.has_triggered(1));
    state.mark_triggered(0);
    assert_eq!(state.triggered(), &[0, 1], "重复标记幂等且保持升序");
    // 与判定函数联动：标记后同阶梯不再触发；未达标阶梯不提前触发
    let ratios = [0.4, 0.6, 0.8];
    // 0.4/0.6 已触发、0.5 未达 0.8 → None（同阶梯不重复、未达标不触发）
    assert_eq!(
        next_pending_milestone(0.5, &ratios, state.triggered()),
        None
    );
    // 0.9 达标 → 触发 0.8（唯一未触发阶梯，升序遍历跳过已触发项）
    assert_eq!(next_pending_milestone(0.9, &ratios, state.triggered()), Some(2));
}

// ── Schema 构造（07 §4.4 测试 2：Schema V1 合法 JSON）──────────

#[test]
fn stage_summary_document_is_valid_schema_v1() {
    let doc = sample_document(0);
    let json = serde_json::to_string(&doc).unwrap();
    // Schema V1 校验通过（required 骨架 + droppedIds 数组）
    validate_summary_document(&json, 4096).expect("阶段总结必须过 Schema V1 校验");
    assert_eq!(doc["schemaVersion"], 1);
    assert_eq!(doc["tier"], "stage-1", "tier 标记 stage-N");
    assert!(doc["droppedIds"].as_array().unwrap().is_empty(), "droppedIds 空数组（无损）");
    assert_eq!(doc["height"], 1);
    assert_eq!(doc["range"]["startMessageId"], "m1", "custom range 覆盖消息 id 区间");
    assert_eq!(doc["range"]["messageCount"], 40);
    // 阶段下标 → tier 命名
    assert_eq!(stage_tier(0), "stage-1");
    assert_eq!(stage_tier(1), "stage-2");
    assert_eq!(stage_tier(2), "stage-3");
}

#[test]
fn stage_summary_document_without_range_omits_key() {
    let mut input = StageSummaryDocument {
        stage_index: 1,
        block_id: "stage-summary-2".to_string(),
        generation: 0,
        goal: "g".to_string(),
        constraints: Vec::new(),
        progress: Vec::new(),
        decisions: Vec::new(),
        next_steps: Vec::new(),
        critical_context: String::new(),
        range: None,
    };
    let doc = build_stage_summary_document(&input);
    assert!(doc.get("range").is_none(), "range=None 不输出键");
    input.stage_index = 2;
    let doc2 = build_stage_summary_document(&input);
    assert_eq!(doc2["tier"], "stage-3");
    // 缺省空数组字段合法（Schema V1 校验兼容）
    validate_summary_document(&serde_json::to_string(&doc2).unwrap(), 4096).unwrap();
}

// ── md 渲染稳定化（E2 §6.5 ①/⑤）───────────────────────────────

#[test]
fn stage_summary_markdown_is_deterministic_with_tier() {
    let doc = sample_document(0);
    let first = stage_summary_to_markdown(&doc);
    assert_eq!(first, stage_summary_to_markdown(&doc), "同文档同输出（稳定化）");
    assert!(first.starts_with("## 阶段性总结（stage-1）"), "tier 标注头");
    assert!(first.contains("## Goal"), "骨架节复用 Schema V1 渲染");
    assert!(first.contains("实现分阶段总结"));
    assert!(first.contains("里程碑判定已落地"));
    // 无时间戳（确定性前提）
    assert!(!first.contains("timestamp") && !first.contains("createdAt"));
}

// ── checkpoint 载荷转换（07 §4.4 测试 3 / D7 T11）──────────────

#[test]
fn checkpoint_payload_maps_stage_summary_fields() {
    let doc = sample_document(0);
    let payload = stage_summary_to_checkpoint_payload(&doc);
    assert_eq!(payload.target, "实现分阶段总结", "target ← goal");
    assert_eq!(
        payload.summary,
        "[stage-1] 里程碑判定已落地；Schema 构造已落地",
        "summary ← [tier] + progress 拼接"
    );
    assert_eq!(payload.completed, vec!["里程碑判定已落地", "Schema 构造已落地"], "completed ← progress");
    assert_eq!(payload.next, vec!["接线 run 收口触发"], "next ← nextSteps");
    assert!(payload.files.is_empty(), "files 空（无损快照不携带文件清单）");
    assert!(payload.timestamp.is_none(), "timestamp 由采集端补");
}

#[test]
fn checkpoint_payload_handles_empty_progress() {
    let doc = build_stage_summary_document(&StageSummaryDocument {
        stage_index: 0,
        block_id: "stage-summary-1".to_string(),
        generation: 0,
        goal: "g".to_string(),
        constraints: Vec::new(),
        progress: Vec::new(),
        decisions: Vec::new(),
        next_steps: Vec::new(),
        critical_context: String::new(),
        range: None,
    });
    let payload = stage_summary_to_checkpoint_payload(&doc);
    assert_eq!(payload.summary, "[stage-1] 阶段无进展记录");
    assert!(payload.completed.is_empty());
}

// ── 素材继承链（07 §4.4：progress/nextSteps 被终结摘要继承）────

#[test]
fn existing_text_inherits_goal_and_next_steps_deterministically() {
    let doc = sample_document(2);
    let first = stage_summary_to_existing_text(&doc);
    assert_eq!(first, stage_summary_to_existing_text(&doc), "existing 素材确定性");
    assert!(first.contains("[stage-3 阶段总结]"));
    assert!(first.contains("目标：实现分阶段总结"), "goal 继承");
    assert!(first.contains("已完成：里程碑判定已落地"), "progress 继承");
    assert!(first.contains("下一步：接线 run 收口触发"), "nextSteps 继承");
}

#[test]
fn inheritance_view_extracts_fields() {
    let doc = sample_document(0);
    let inherited = stage_summary_inheritance(&doc);
    assert_eq!(inherited.goal, Some("实现分阶段总结"));
    assert_eq!(inherited.progress.len(), 2);
    assert_eq!(inherited.next_steps, vec!["接线 run 收口触发"]);
    // 字段缺失 → 空面（不 panic）
    let empty_doc = serde_json::json!({});
    let empty = stage_summary_inheritance(&empty_doc);
    assert_eq!(empty, StageSummaryInheritance::default());
}
