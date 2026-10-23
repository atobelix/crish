use conex_types::events::MissAttribution;
use conex_types::message::AgentMessageRole;

use super::{msg, scalars, tools, tracker};
use crate::cache_tracker::hash::build_request_signature;

/// C13：on_compaction 代数 +1、基线作废；压缩后首轮 usage 无基线 → 不计 miss。
/// v1.1 T-27 扩展断言：pending_compaction 置位、rebuild_signature 初始为空
/// （待 capture_post_compaction 填充）——压缩后首轮 usage 回退路径（重建
/// 签名缺失）与既有行为一致。
#[test]
fn on_compaction_invalidates_baseline_and_bumps_generation() {
    let mut t = tracker(60);
    t.capture_signature(Some("sys"), &tools(), &[]);
    assert!(t
        .record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000)
        .is_none());
    assert!(t.baseline().is_some(), "首轮后基线必须建立");
    t.on_compaction();
    assert!(t.baseline().is_none(), "压缩后基线必须作废");
    assert!(t.pending_compaction, "压缩后必须置 pending 标记");
    assert!(
        t.rebuild_signature.is_none(),
        "重建签名初始为空，待 capture_post_compaction 填充"
    );
    t.capture_signature(Some("sys"), &tools(), &[]);
    let miss = t.record_usage(scalars(5_000, 0, 0, None), 50, 5_050, 2_000);
    assert!(miss.is_none(), "压缩后新内容非重放 → 不计 miss");
    assert!(
        !t.pending_compaction,
        "压缩后首轮 usage 后 pending 必须清除"
    );
    let stats = t.finish();
    // 压缩前的浪费量不因重置而丢失（run 聚合只累计真实 detectMiss）
    assert_eq!(stats.cache_read_tokens, 8_000);
    assert_eq!(stats.prompt_tokens, 15_000);
}

/// T-28：压缩后重建签名与相同输入上的 capture_signature 相等（同一构造
/// 路径，评审 02 §3.3：正常路径下两签名一致，前缀比对不误报）
#[test]
fn capture_post_compaction_matches_capture_signature_on_same_input() {
    let m1 = msg("m1", AgentMessageRole::User, "你好", "2026-01-01T00:00:00Z");
    let m2 = msg(
        "m2",
        AgentMessageRole::Assistant,
        "回复",
        "2026-01-01T00:00:00Z",
    );
    let msgs = [m1, m2];
    let mut t = tracker(0);
    t.capture_post_compaction(Some("sys"), &tools(), &msgs);
    t.capture_signature(Some("sys"), &tools(), &msgs);
    assert_eq!(
        t.rebuild_signature.as_ref(),
        t.pending_signature.as_ref(),
        "同一输入上重建签名与请求签名必须相等"
    );
}

/// T-29 四态之 Identical：pending + 重建一致 → 无额外记录、pending 清理、
/// 重建签名清空防陈旧
#[test]
fn post_compaction_first_request_identical_clears_pending() {
    let m1 = msg("m1", AgentMessageRole::User, "你好", "2026-01-01T00:00:00Z");
    let m2 = msg(
        "m2",
        AgentMessageRole::Assistant,
        "回复",
        "2026-01-01T00:00:00Z",
    );
    let msgs = vec![m1, m2];
    let mut t = tracker(60);
    t.on_compaction();
    t.capture_post_compaction(Some("sys"), &tools(), &msgs);
    t.capture_signature(Some("sys"), &tools(), &msgs);
    let miss = t.record_usage(scalars(5_000, 0, 0, None), 50, 5_050, 2_000);
    assert!(miss.is_none(), "压缩后首请求前缀一致 → 无额外记录");
    assert!(!t.pending_compaction, "pending 必须消费清除");
    assert!(t.rebuild_signature.is_none(), "重建签名必须清空防陈旧");
}

/// T-29 四态之 TailAppend：压缩后首请求前对话被追加（steering 注入 /
/// overflow 阶梯）→ 追加区豁免，不计 harness 改写
#[test]
fn post_compaction_first_request_tail_append_is_exempt() {
    let m1 = msg("m1", AgentMessageRole::User, "你好", "2026-01-01T00:00:00Z");
    let m2 = msg(
        "m2",
        AgentMessageRole::Assistant,
        "回复",
        "2026-01-01T00:00:00Z",
    );
    let m3 = msg("m3", AgentMessageRole::User, "追加", "2026-01-01T00:00:00Z");
    let mut t = tracker(60);
    t.on_compaction();
    t.capture_post_compaction(Some("sys"), &tools(), &[m1.clone(), m2.clone()]);
    // 压缩后、record_usage 前被追加 → pending 签名含新消息、重建不含
    t.capture_signature(Some("sys"), &tools(), &[m1, m2, m3]);
    let miss = t.record_usage(scalars(5_000, 0, 0, None), 50, 5_050, 2_000);
    assert!(
        miss.is_none(),
        "追加区豁免 → 不计 miss、不误报 harness 改写"
    );
    assert!(!t.pending_compaction, "pending 必须消费清除");
    assert!(t.rebuild_signature.is_none(), "重建签名必须清空防陈旧");
}

/// T-29 四态之 HeadRewrite：压缩后历史区被改写（harness 二次改写）→
/// warn 诊断 + 归因 PrefixChanged（零浪费审计记录）
#[test]
fn post_compaction_first_request_head_rewrite_detected() {
    let m1 = msg("m1", AgentMessageRole::User, "你好", "2026-01-01T00:00:00Z");
    let m2 = msg(
        "m2",
        AgentMessageRole::Assistant,
        "回复",
        "2026-01-01T00:00:00Z",
    );
    let mut t = tracker(60);
    t.on_compaction();
    t.capture_post_compaction(Some("sys"), &tools(), &[m1.clone(), m2.clone()]);
    // 历史第一条被改写（异常 / harness 二次改写）
    let m1_rewritten = msg("m1", AgentMessageRole::User, "改写", "2026-01-01T00:00:00Z");
    t.capture_signature(Some("sys"), &tools(), &[m1_rewritten, m2]);
    let miss = t.record_usage(scalars(5_000, 0, 0, None), 50, 5_050, 2_000);
    let miss = miss.expect("历史区改写必须产出诊断审计记录");
    assert_eq!(miss.attribution, MissAttribution::PrefixChanged);
    assert_eq!(miss.missed_tokens, 0, "诊断记录零浪费，不影响 token 累计");
    assert!(!t.pending_compaction, "pending 必须消费清除");
    assert!(t.rebuild_signature.is_none(), "重建签名必须清空防陈旧");
}

/// T-29 回归：无 pending（常规路径）行为不变
#[test]
fn record_usage_without_pending_compaction_unaffected() {
    let mut t = tracker(60);
    t.capture_signature(Some("sys"), &tools(), &[]);
    assert!(!t.pending_compaction, "常规路径不得置 pending");
    assert!(t.rebuild_signature.is_none());
    assert!(t
        .record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000)
        .is_none());
    assert!(!t.pending_compaction, "常规路径不得置 pending");
    assert!(t.rebuild_signature.is_none(), "常规路径不得产生重建签名");
}

/// T-30：外部代数注入后基线代数戳使用注入值；校准语义（先自增再注入
/// → 以注入值为准）；on_compaction 自增保留为回退（轮次 4 改单源消费）
#[test]
fn apply_external_generation_calibrates_baseline_generation() {
    let mut t = tracker(0);
    t.apply_external_generation(5);
    t.capture_signature(Some("sys"), &tools(), &[]);
    assert!(t
        .record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000)
        .is_none());
    let baseline = t.baseline().expect("首轮后基线必须建立");
    assert_eq!(baseline.generation, 5, "外部注入代数应覆盖内部自增");
    // 校准语义：on_compaction 自增后注入外部值 → 以注入值为准
    let mut t2 = tracker(0);
    t2.on_compaction();
    t2.apply_external_generation(3);
    t2.capture_signature(Some("sys"), &tools(), &[]);
    assert!(t2
        .record_usage(scalars(10_000, 8_000, 500, None), 100, 10_100, 1_000)
        .is_none());
    assert_eq!(t2.baseline().unwrap().generation, 3, "注入值应校准自增值");
}

/// on_compaction 后增量锚点失效 → 下一轮 capture_signature 全量重算。
#[test]
fn on_compaction_invalidates_incremental_anchor() {
    let m1 = msg("m1", AgentMessageRole::User, "你好", "2026-01-01T00:00:00Z");
    let m2 = msg(
        "m2",
        AgentMessageRole::Assistant,
        "摘要",
        "2026-01-01T00:00:00Z",
    );
    let mut t = tracker(0);
    t.capture_signature(Some("sys"), &tools(), std::slice::from_ref(&m1));
    // 压缩后对话被替换
    t.on_compaction();
    t.capture_signature(Some("sys"), &tools(), std::slice::from_ref(&m2));
    let sig = t.pending_signature.clone().unwrap();
    let full = build_request_signature(Some("sys"), &tools(), &[m2]);
    assert_eq!(sig, full, "压缩后应全量重算（增量锚点已失效）");
}
