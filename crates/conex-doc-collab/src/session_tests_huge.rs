//! A-HUGE / M2 分段测试（SR-06g · 拆分 · 测外置 · ≠ EL）。
//!
//! 助手 `join_split_chain` / `count_split_segments` 在 [`super`]（`session_tests`）入口。
use super::super::*;
use super::*;

    /// A-HUGE-01：亚阈文本保持单叶，无 `split_of` 子段。
    #[test]
    fn a_huge_01_below_threshold_stays_single_leaf() {
        let _ = crate::a_huge::A_HUGE_01;
        let mut s = DocSession::new("d1");
        assert_eq!(s.huge_threshold(), DEFAULT_T_HUGE);
        let id = BlockId::new();
        insert_root(&mut s, id, "a0");
        let payload = "x".repeat(1024); // 1 KiB ≪ 256 KiB
        s.apply(
            Origin::User,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: payload.clone(),
            }],
        )
        .unwrap();
        assert_eq!(s.read_text(&id), payload);
        assert_eq!(s.tree.nodes.len(), 1, "亚阈不得强制分段");
        assert!(s
            .tree
            .get(&id)
            .unwrap()
            .props
            .attrs
            .get(ATTR_SPLIT_OF)
            .is_none());
        assert!(s.plan_split_huge(id).unwrap().is_empty());
    }

    /// A-HUGE-01 变体：刚好低于 T_HUGE 仍单叶。
    #[test]
    fn a_huge_01_just_below_threshold_single() {
        let thr = MIN_T_HUGE;
        let mut s = DocSession::new("d1").with_huge_threshold(thr);
        assert_eq!(s.huge_threshold(), thr);
        let id = BlockId::new();
        insert_root(&mut s, id, "a0");
        let payload = "a".repeat(thr - 1);
        s.apply(
            Origin::User,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: payload.clone(),
            }],
        )
        .unwrap();
        assert_eq!(s.tree.nodes.len(), 1);
        assert_eq!(s.read_text(&id).len(), thr - 1);
        assert_eq!(count_split_segments(&s, id), 1);
    }

    /// A-HUGE-02：一次插入超大字符串 → 同事务自动分段，拼接 equals 原文。
    #[test]
    fn a_huge_02_auto_split_on_huge_insert() {
        let _ = crate::a_huge::A_HUGE_02;
        let thr = MIN_T_HUGE; // 64 KiB，便于测试
        let mut s = DocSession::new("d1").with_huge_threshold(thr);
        let id = BlockId::new();
        insert_root(&mut s, id, "a0");
        // 约 2.5 × T_HUGE → 多段
        let payload = "b".repeat(thr * 2 + thr / 2);
        let nodes_before = s.tree.nodes.len();
        s.apply(
            Origin::Agent,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: payload.clone(),
            }],
        )
        .unwrap();
        let segs = count_split_segments(&s, id);
        assert!(segs > 1, "超阈应分段，got segs={segs}");
        assert!(s.tree.nodes.len() > nodes_before);
        assert_eq!(join_split_chain(&s, id), payload, "拼接 equals 原文");
        // 每段 ≤ T_SEGMENT
        let seg_max = s.segment_target();
        let parent = s.tree.get(&id).unwrap().parent;
        let siblings = match parent {
            Some(pid) => s.tree.get(&pid).unwrap().children.clone(),
            None => s.tree.root_children.clone(),
        };
        for sid in siblings {
            let is_chain = sid == id
                || s.tree
                    .get(&sid)
                    .and_then(|n| n.props.attrs.get(ATTR_SPLIT_OF))
                    .and_then(|v| v.as_str())
                    .map(|x| x == id.to_string())
                    .unwrap_or(false);
            if is_chain {
                assert!(
                    s.read_text(&sid).len() <= seg_max,
                    "段 {} 超 T_SEGMENT",
                    sid
                );
            }
        }
        // 后续段带 split_of
        let has_split_of = s.tree.nodes.values().any(|n| {
            n.id != id
                && n.props
                    .attrs
                    .get(ATTR_SPLIT_OF)
                    .and_then(|v| v.as_str())
                    == Some(&id.to_string())
        });
        assert!(has_split_of);
    }

    /// A-HUGE-02：超阈写入与失败 Op 同批 → 整批失败、零半树。
    #[test]
    fn a_huge_02_failed_batch_no_half_tree() {
        let thr = MIN_T_HUGE;
        let mut s = DocSession::new("d1").with_huge_threshold(thr);
        let id = BlockId::new();
        insert_root(&mut s, id, "a0");
        s.apply(
            Origin::User,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: "seed".into(),
            }],
        )
        .unwrap();
        let rev_before = s.rev;
        let nodes_before = s.tree.nodes.len();
        let text_before = s.read_text(&id);
        let missing = BlockId::new();
        let huge = "z".repeat(thr + 1024);

        let err = s
            .apply(
                Origin::Agent,
                &[
                    Op::TextEdit {
                        id,
                        start: 0,
                        end: 4,
                        insert: huge,
                    },
                    Op::Move {
                        id,
                        new_parent: Some(missing),
                        order: "a0".into(),
                    },
                ],
            )
            .unwrap_err();
        assert!(matches!(err, ApplyError::NotFound(_)));
        assert_eq!(s.rev, rev_before);
        assert_eq!(s.tree.nodes.len(), nodes_before, "零半树：节点数不变");
        assert_eq!(s.read_text(&id), text_before);
        assert!(!s.tree.nodes.values().any(|n| n
            .props
            .attrs
            .contains_key(ATTR_SPLIT_OF)));
    }

    /// `plan_split_huge` 可测：先以高阈写入单叶，再降阈规划/应用 Op。
    #[test]
    fn plan_split_huge_ops_apply_cleanly() {
        let thr = MIN_T_HUGE;
        // 高阈写入 → 保持单叶（A-HUGE-01）
        let mut s = DocSession::new("d1").with_huge_threshold(MAX_T_HUGE);
        let id = BlockId::new();
        insert_root(&mut s, id, "a0");
        let payload = "c".repeat(thr * 2 + 4096);
        assert!(payload.len() < MAX_T_HUGE);
        s.apply(
            Origin::User,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: payload.clone(),
            }],
        )
        .unwrap();
        assert_eq!(s.tree.nodes.len(), 1, "高阈下应仍为单叶");

        // 降阈后 plan 应给出多 Op
        s.set_huge_threshold(thr);
        let plan = s.plan_split_huge(id).unwrap();
        assert!(
            plan.len() >= 3,
            "至少 TextEdit 首段 + Insert + TextEdit，got {}",
            plan.len()
        );
        assert!(matches!(plan[0], Op::TextEdit { .. }));

        s.apply(Origin::System, &plan).unwrap();
        assert!(count_split_segments(&s, id) > 1);
        assert_eq!(join_split_chain(&s, id), payload);
        // 已分段后再次 plan 为空
        assert!(s.plan_split_huge(id).unwrap().is_empty());
    }

    /// `with_huge_threshold` 钳制 64KiB..=16MiB。
    #[test]
    fn huge_threshold_clamped() {
        let s = DocSession::new("d1").with_huge_threshold(1);
        assert_eq!(s.huge_threshold(), MIN_T_HUGE);
        let s2 = DocSession::new("d1").with_huge_threshold(usize::MAX);
        assert_eq!(s2.huge_threshold(), MAX_T_HUGE);
        let s3 = DocSession::new("d1").with_huge_threshold(128 * 1024);
        assert_eq!(s3.huge_threshold(), 128 * 1024);
        assert_eq!(s3.segment_target(), DEFAULT_T_SEGMENT.min(128 * 1024));
    }

    #[test]
    fn partition_utf8_prefers_newline_and_roundtrips() {
        let text = format!("{}\n{}", "a".repeat(100), "b".repeat(100));
        let parts = partition_utf8(&text, 120);
        assert!(parts.len() >= 2);
        assert_eq!(parts.concat(), text);
        // 中文 char 边界
        let cjk = "你好世界".repeat(20);
        let parts2 = partition_utf8(&cjk, 17);
        assert_eq!(parts2.concat(), cjk);
        for p in &parts2 {
            assert!(p.len() <= 17 || p.chars().count() == 1);
        }
    }

    /// 含换行的超长文本分段后拼接 equals（边界安全）。
    #[test]
    fn a_huge_split_with_newlines_roundtrip() {
        let thr = MIN_T_HUGE;
        let mut s = DocSession::new("d1").with_huge_threshold(thr);
        let id = BlockId::new();
        insert_root(&mut s, id, "a0");
        let line = format!("{}\n", "行".repeat(1000));
        let payload = line.repeat(40); // 远超 64KiB
        assert!(payload.len() >= thr);
        s.apply(
            Origin::User,
            &[Op::TextEdit {
                id,
                start: 0,
                end: 0,
                insert: payload.clone(),
            }],
        )
        .unwrap();
        assert!(count_split_segments(&s, id) > 1);
        assert_eq!(join_split_chain(&s, id), payload);
    }
