//! 会话级连续 git 回退计数（I3-S7：C4 引擎级落地）
//!
//! C4 规格（04-Agent功能需求设计.md §2 C4）：
//! - **同会话时窗内第 ≥2 次回退（无论面积）必审批**，杜绝「分多次小额
//!   回退绕过 C3 面积门禁」；
//! - 计数持久化 session_meta（键 `revert_streak_count` / `revert_last_at`，
//!   S6 已预留 [crate::revert::SESSION_META_KEY_REVERT_STREAK_COUNT] /
//!   [crate::revert::SESSION_META_KEY_REVERT_STREAK_LAST_AT]），重启可恢复；
//! - 时窗归零：距上次回退超过 `revert_streak_window_seconds`（默认 600s，
//!   session_meta 可配）清零——**惰性归零**（每次调用前检查，不依赖定时器）；
//! - 只统计实际回退（成功 / 被拒 / 审批中）：[RevertCounterGuard::record_revert]
//!   计数 +1；纯 git 状态查询走 [RevertCounterGuard::peek]（只读，不计数）。
//!
//! 实现契约（S6 预留，crates/agent-tools/src/revert.rs）：本模块消费
//! [RevertCounterStore] / [RevertCounterSnapshot]，实现时窗归零与第 2 次
//! 必审批判定，并把 C4 判定与 C3 面积判定（[crate::revert::RevertPolicy]
//! 的 `gate_verdict`）合并为统一回退护栏（[combine_revert_gate]）。
//!
//! 存储接线：agent-tools 是叶子 crate，生产代码不依赖 conex-db（对齐
//! audit.rs 接线约定——落库面在引擎侧接线）。引擎侧接线方实现
//! [RevertCounterStore] over `conex_db::LocalDb::get_session_meta /
//! set_session_meta`（参考实现见本文件测试模块 `SessionMetaRevertCounterStore`，
//! 含重启恢复断言；save 失败由实现方记录审计/日志，不得静默丢计数）。

use crate::permission::{PermissionMode, PermissionVerdict};
use crate::revert::{RevertCounterSnapshot, RevertCounterStore};
use std::sync::Arc;

/// session_meta 键：时窗配置（秒，可配覆盖；04 C4 第 3 条，`revert_*`
/// 键命名空间由 C4 独占）。
pub const REVERT_WINDOW_SECONDS_KEY: &str = "revert_streak_window_seconds";
/// 时窗默认值：600 秒（04 C4 第 3 条）。
pub const DEFAULT_REVERT_WINDOW_SECONDS: u64 = 600;

/// 连续回退判定结果（C4 第 4 条：时窗内第 ≥2 次 → 必审批）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreakVerdict {
    /// 窗口内本次已是第 ≥2 次回退 → 强制审批（无论面积 / 权限模式）。
    NeedsApproval,
    /// 首次（窗口内第 1 次或时窗已归零）→ 不触发连续回退审批。
    Allow,
}

/// 回退护栏触发原因（供审批载荷与 events 审计）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevertGuardReason {
    /// 面积超阈值（C3/S6 面积判定触发）。
    AreaOverThreshold,
    /// 时窗内第 ≥2 次回退（C4 连续回退计数触发）。
    StreakSecondCall,
}

/// 连续回退判定结果（单次调用完整载荷）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevertGuardOutcome {
    /// 连续计数维度判定。
    pub streak: StreakVerdict,
    /// 记录场景 = 本次调用后应持久化的快照；只读（peek）场景 = 当前快照（不递增）。
    pub snapshot_after: RevertCounterSnapshot,
    /// 当前时窗配置（秒）。
    pub window_seconds: u64,
}

/// 时窗内计数（只读纯函数）：惰性归零 + 窗口内累计次数。
///
/// 归零语义：`now - last_at > window` 才归零（恰好等于时窗仍在窗口内）；
/// 时窗配置为 0 时视为「永不归零」（保守侧，宁可多审不漏审）；
/// 时间戳缺失 / 时钟回拨时保留计数（保守侧）。
fn window_count(snapshot: RevertCounterSnapshot, now_unix: i64, window_seconds: u64) -> u64 {
    if snapshot.streak_count == 0 {
        return 0;
    }
    let Some(last) = snapshot.last_revert_at_unix else {
        // 无有效时间戳 → 无法判定窗口，保守保留计数。
        return snapshot.streak_count;
    };
    let window = (window_seconds as i64).saturating_mul(1);
    if window > 0 && now_unix.saturating_sub(last) > window {
        return 0;
    }
    snapshot.streak_count
}

/// 连续回退判定（纯函数）：惰性归零 + 第 2 次起必审批 + 新快照（计数 +1）。
///
/// 返回 `(本次判定, 调用后应持久化的新快照)`；不触达存储。
pub fn evaluate_streak(
    snapshot: RevertCounterSnapshot,
    now_unix: i64,
    window_seconds: u64,
) -> (StreakVerdict, RevertCounterSnapshot) {
    let count = window_count(snapshot, now_unix, window_seconds);
    let verdict = if count >= 1 {
        StreakVerdict::NeedsApproval
    } else {
        StreakVerdict::Allow
    };
    let new_snapshot = RevertCounterSnapshot {
        streak_count: count.saturating_add(1),
        last_revert_at_unix: Some(now_unix),
    };
    (verdict, new_snapshot)
}

/// 统一回退护栏判定：合并 C3 面积判定（[crate::revert::RevertPolicy]
/// `gate_verdict` 产出）与 C4 连续计数判定。
///
/// 合并矩阵（I3-S7 任务卡第 2 条）：
/// - 面积大 → 面积判定优先（ask/full-access 由 S6 产出 NeedsApproval，
///   plan 由 S6 产出 Deny）；
/// - 面积小但窗口内第 2 次 → 必审批（ask/full-access NeedsApproval；
///   plan 拒绝——安全优先，审批通道在 plan 下不存在）；
/// - 面积小且首次 → `None`（按既有三态矩阵，零打扰）。
///
/// 返回 `Option<PermissionVerdict>`：`Some` = 回退护栏接管判定（不落既有
/// 三态矩阵）；`None` = 护栏放行（走既有矩阵）。
pub fn combine_revert_gate(
    area_verdict: Option<PermissionVerdict>,
    streak: StreakVerdict,
    mode: PermissionMode,
) -> Option<PermissionVerdict> {
    if let Some(verdict) = area_verdict {
        return Some(verdict);
    }
    match streak {
        StreakVerdict::NeedsApproval => Some(match mode {
            PermissionMode::Plan => PermissionVerdict::Deny,
            _ => PermissionVerdict::NeedsApproval,
        }),
        StreakVerdict::Allow => None,
    }
}

/// 回退护栏触发原因列表（审批载荷 / events 用；面积 + 连续双维度合取）。
pub fn guard_reasons(area_triggered: bool, streak: StreakVerdict) -> Vec<RevertGuardReason> {
    let mut reasons = Vec::new();
    if area_triggered {
        reasons.push(RevertGuardReason::AreaOverThreshold);
    }
    if streak == StreakVerdict::NeedsApproval {
        reasons.push(RevertGuardReason::StreakSecondCall);
    }
    reasons
}

/// 宽容解析 session_meta 两键为计数快照；任一键缺失或非法 → `None`
/// （视为全新会话，从零计数）。
pub fn snapshot_from_persisted(
    count_raw: Option<&str>,
    last_at_raw: Option<&str>,
) -> Option<RevertCounterSnapshot> {
    let streak_count = count_raw?.trim().parse::<u64>().ok()?;
    let last_revert_at_unix = last_at_raw?.trim().parse::<i64>().ok();
    Some(RevertCounterSnapshot {
        streak_count,
        last_revert_at_unix,
    })
}

/// 序列化为 session_meta 落库载荷（计数键值, 时间戳键值）。
pub fn snapshot_to_persisted_pair(snapshot: &RevertCounterSnapshot) -> (String, String) {
    (
        snapshot.streak_count.to_string(),
        snapshot
            .last_revert_at_unix
            .map(|v| v.to_string())
            .unwrap_or_else(|| "0".to_string()),
    )
}

/// 解析时窗配置（session_meta 覆盖键；缺失 / 非法 → 默认 600s）。
pub fn parse_window_seconds(raw: Option<&str>) -> u64 {
    raw.and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_REVERT_WINDOW_SECONDS)
}

/// 当前 Unix 秒（对齐 [RevertCounterSnapshot] 时间戳单位；系统时间不可用 0）。
pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 会话级连续回退计数守卫（存储 + 时窗配置）。
///
/// 接线契约：每次**实际回退调用**（成功 / 被拒 / 审批中）前调用
/// [Self::record_revert] 计数 +1 并落库；纯 git 状态查询走 [Self::peek]
/// （只读，不改变计数）。判定结果由统一护栏 [combine_revert_gate] 与
/// C3 面积判定合并（合并点在 S6 判定链挂载，见 04 §4 互斥约定）。
#[derive(Clone)]
pub struct RevertCounterGuard {
    store: Arc<dyn RevertCounterStore>,
    window_seconds: u64,
}

impl RevertCounterGuard {
    /// 构造计数守卫（显式时窗，秒；0 = 永不归零，保守侧）。
    pub fn new(store: Arc<dyn RevertCounterStore>, window_seconds: u64) -> Self {
        Self {
            store,
            window_seconds,
        }
    }

    /// 构造计数守卫（默认时窗 600s）。
    pub fn with_default_window(store: Arc<dyn RevertCounterStore>) -> Self {
        Self::new(store, DEFAULT_REVERT_WINDOW_SECONDS)
    }

    /// 记录一次实际回退：惰性归零 → 判定 → 计数 +1 → 落库。
    ///
    /// 返回本次判定与调用后快照（供审批载荷 / events）。落库失败由存储
    /// 实现自行记录（不得静默丢计数）；接线方按安全优先处理——判定结果
    /// 已返回，本次审批照常生效。
    pub fn record_revert(&self, session_id: &str, now_unix: i64) -> RevertGuardOutcome {
        let snapshot = self.store.load(session_id);
        let (streak, snapshot_after) = evaluate_streak(snapshot, now_unix, self.window_seconds);
        self.store.save(session_id, snapshot_after);
        RevertGuardOutcome {
            streak,
            snapshot_after,
            window_seconds: self.window_seconds,
        }
    }

    /// 只读视图：计算「现在发起回退会如何判定」——**不计数、不落库**
    /// （04 C4 第 5 条：纯 git 状态查询不改变计数）。
    pub fn peek(&self, session_id: &str, now_unix: i64) -> RevertGuardOutcome {
        let snapshot = self.store.load(session_id);
        let count = window_count(snapshot, now_unix, self.window_seconds);
        let streak = if count >= 1 {
            StreakVerdict::NeedsApproval
        } else {
            StreakVerdict::Allow
        };
        RevertGuardOutcome {
            streak,
            snapshot_after: snapshot,
            window_seconds: self.window_seconds,
        }
    }

    /// 当前时窗配置（秒）。
    pub fn window_seconds(&self) -> u64 {
        self.window_seconds
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::revert::InMemoryRevertCounterStore;
    use conex_test_utils::TempWorkspace;

    // ===== SessionMetaRevertCounterStore：接线参考实现 =====
    //
    // 生产位置：引擎侧接线点（session-loop / orchestrator / engine，依赖
    // conex-db 的层）——agent-tools 是叶子 crate，生产不依赖 conex-db
    // （对齐 audit.rs 接线约定）。多会话共用同一 session_meta 表（该表为
    // 全局 KV，无会话列），故键按 `{session_id}:{S6 预留键名}` 编码隔离；
    // 单会话引擎传入空 session_id 时退化为 04 字面键名
    // （`revert_streak_count` / `revert_last_at`）。

    const KEY_COUNT: &str = "revert_streak_count";
    const KEY_LAST_AT: &str = "revert_last_at";

    struct SessionMetaRevertCounterStore {
        db: conex_db::LocalDb,
    }

    impl std::fmt::Debug for SessionMetaRevertCounterStore {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            // LocalDb 不实现 Debug（内部为 Mutex<Connection>），此处仅满足
            // RevertCounterStore 的 Debug bound，打印类型名即可。
            f.write_str("SessionMetaRevertCounterStore")
        }
    }

    impl SessionMetaRevertCounterStore {
        fn key_of(session_id: &str, key: &str) -> String {
            if session_id.is_empty() {
                key.to_string()
            } else {
                format!("{session_id}:{key}")
            }
        }
    }

    impl RevertCounterStore for SessionMetaRevertCounterStore {
        fn load(&self, session_id: &str) -> RevertCounterSnapshot {
            let count_key = Self::key_of(session_id, KEY_COUNT);
            let last_key = Self::key_of(session_id, KEY_LAST_AT);
            let count = self.db.get_session_meta(&count_key).ok().flatten();
            let last_at = self.db.get_session_meta(&last_key).ok().flatten();
            snapshot_from_persisted(count.as_deref(), last_at.as_deref())
                .unwrap_or_default()
        }

        fn save(&self, session_id: &str, snapshot: RevertCounterSnapshot) {
            let (count, last_at) = snapshot_to_persisted_pair(&snapshot);
            let _ = self
                .db
                .set_session_meta(&Self::key_of(session_id, KEY_COUNT), &count);
            let _ = self
                .db
                .set_session_meta(&Self::key_of(session_id, KEY_LAST_AT), &last_at);
        }
    }

    fn memory_guard(window_seconds: u64) -> RevertCounterGuard {
        let store: Arc<dyn RevertCounterStore> = Arc::new(InMemoryRevertCounterStore::new());
        RevertCounterGuard::new(store, window_seconds)
    }

    // ---- 计数递增与第 2 次起必审批 ----

    /// C4 验收 1：同会话两次小额回退，第二次触发审批（第一次放行）。
    /// 注（I3-S6 交接修正）：两次回退间隔须在时窗（600s）内——原数据
    /// 1000s 间隔会触发惰性归零，与断言矛盾；仅修正测试数据，逻辑未动。
    #[test]
    fn second_revert_in_window_requires_approval() {
        let guard = memory_guard(DEFAULT_REVERT_WINDOW_SECONDS);
        let first = guard.record_revert("s1", 1_000);
        assert_eq!(first.streak, StreakVerdict::Allow, "首次回退不触发");
        assert_eq!(first.snapshot_after.streak_count, 1);

        let second = guard.record_revert("s1", 1_100);
        assert_eq!(second.streak, StreakVerdict::NeedsApproval, "窗口内第 2 次必审批");
        assert_eq!(second.snapshot_after.streak_count, 2);
        assert_eq!(second.snapshot_after.last_revert_at_unix, Some(1_100));
    }

    /// C4 验收 2：窗口内 3 次回退产生 2 个审批请求，计数递增。
    /// 注（I3-S6 交接修正）：步长 100s 保持在时窗（600s）内（原 1000s 步长
    /// 触发惰性归零导致全部放行）；仅修正测试数据，逻辑未动。
    #[test]
    fn three_reverts_in_window_produce_two_approvals() {
        let guard = memory_guard(DEFAULT_REVERT_WINDOW_SECONDS);
        let outcomes: Vec<RevertGuardOutcome> = (1_000..=1_200)
            .step_by(100)
            .map(|t| guard.record_revert("s1", t))
            .collect();
        assert_eq!(
            outcomes
                .iter()
                .filter(|o| o.streak == StreakVerdict::NeedsApproval)
                .count(),
            2,
            "3 次回退应产生 2 个连续回退审批"
        );
        assert_eq!(outcomes[0].snapshot_after.streak_count, 1);
        assert_eq!(outcomes[1].snapshot_after.streak_count, 2);
        assert_eq!(outcomes[2].snapshot_after.streak_count, 3, "计数递增");
    }

    /// 会话隔离：不同会话互不影响。
    #[test]
    fn sessions_are_isolated() {
        let guard = memory_guard(DEFAULT_REVERT_WINDOW_SECONDS);
        guard.record_revert("s1", 1_700_000_000);
        guard.record_revert("s1", 1_700_000_100);
        let other = guard.record_revert("s2", 1_700_000_200);
        assert_eq!(other.streak, StreakVerdict::Allow, "其他会话首次放行");
        assert_eq!(other.snapshot_after.streak_count, 1);
    }

    // ---- 时窗归零 ----

    /// C4 验收 3：超时窗后再次回退，计数归零、不触发连续回退审批。
    #[test]
    fn window_elapsed_resets_streak() {
        let guard = memory_guard(DEFAULT_REVERT_WINDOW_SECONDS);
        guard.record_revert("s1", 1_700_000_000);
        guard.record_revert("s1", 1_700_000_100);
        // 距上次回退超过 600s → 惰性归零
        let later = 1_700_000_100 + 601;
        let outcome = guard.record_revert("s1", later);
        assert_eq!(outcome.streak, StreakVerdict::Allow, "超时窗后再次回退不触发");
        assert_eq!(outcome.snapshot_after.streak_count, 1, "归零后本次为第 1 次");
        assert_eq!(outcome.snapshot_after.last_revert_at_unix, Some(later));
    }

    /// 时窗边界：恰好等于时窗不归零（仍窗口内，触发审批）。
    #[test]
    fn window_boundary_exact_elapsed_stays_in_window() {
        let guard = memory_guard(DEFAULT_REVERT_WINDOW_SECONDS);
        guard.record_revert("s1", 1_700_000_000);
        let outcome = guard.record_revert("s1", 1_700_000_000 + 600);
        assert_eq!(
            outcome.streak,
            StreakVerdict::NeedsApproval,
            "恰好等于时窗仍属窗口内，必审批"
        );
        assert_eq!(outcome.snapshot_after.streak_count, 2);
    }

    /// 时窗配置 0 = 永不归零（保守侧：宁可多审不漏审）。
    #[test]
    fn window_zero_never_resets() {
        let guard = memory_guard(0);
        guard.record_revert("s1", 1_700_000_000);
        let outcome = guard.record_revert("s1", 1_700_000_000 + 10 * 600);
        assert_eq!(outcome.streak, StreakVerdict::NeedsApproval);
        assert_eq!(outcome.snapshot_after.streak_count, 2);
    }

    /// 时钟回拨不 panic、不误归零（保留计数，保守侧）。
    #[test]
    fn clock_rewind_keeps_streak() {
        let guard = memory_guard(DEFAULT_REVERT_WINDOW_SECONDS);
        guard.record_revert("s1", 1_700_000_100);
        // now < last（时钟回拨）→ saturating 差值为 0 → 不归零
        let outcome = guard.record_revert("s1", 1_700_000_090);
        assert_eq!(outcome.streak, StreakVerdict::NeedsApproval);
        assert_eq!(outcome.snapshot_after.streak_count, 2);
    }

    // ---- 序列化与宽容解析 ----

    /// 持久化载荷往返稳定（session_meta 落库链）。
    #[test]
    fn snapshot_serialization_roundtrip() {
        let snapshot = RevertCounterSnapshot {
            streak_count: 7,
            last_revert_at_unix: Some(1_751_700_000_100_000),
        };
        let (count, last_at) = snapshot_to_persisted_pair(&snapshot);
        let back = snapshot_from_persisted(Some(&count), Some(&last_at)).unwrap();
        assert_eq!(back, snapshot, "序列化往返必须一致");
    }

    /// 宽容解析：键缺失 / 非法值 → None（视为全新会话）。
    #[test]
    fn snapshot_from_persisted_tolerates_missing_or_garbage() {
        assert_eq!(snapshot_from_persisted(None, None), None);
        assert_eq!(snapshot_from_persisted(Some("2"), None), None);
        assert_eq!(snapshot_from_persisted(None, Some("1000")), None);
        assert_eq!(snapshot_from_persisted(Some("abc"), Some("1000")), None);
        assert_eq!(
            snapshot_from_persisted(Some("2"), Some("1000")),
            Some(RevertCounterSnapshot {
                streak_count: 2,
                last_revert_at_unix: Some(1000),
            })
        );
        // 计数合法但时间戳缺失 → 时间戳按 None 保留（窗口判定走保守分支）
        let snap = snapshot_from_persisted(Some("2"), Some("0")).unwrap();
        assert_eq!(snap.last_revert_at_unix, Some(0));
    }

    /// 时窗配置解析：默认 600、合法覆盖、非法回退默认。
    #[test]
    fn parse_window_seconds_defaults_and_overrides() {
        assert_eq!(parse_window_seconds(None), 600);
        assert_eq!(parse_window_seconds(Some("garbage")), 600);
        assert_eq!(parse_window_seconds(Some("120")), 120);
        assert_eq!(parse_window_seconds(Some("0")), 0, "0 合法：永不归零");
    }

    // ---- 统一回退护栏（面积 + 连续，I3-S7 任务卡第 2 条）----

    /// 面积大 → 面积判定优先（S6 产出，如 full-access 下 NeedsApproval）。
    #[test]
    fn combine_area_verdict_takes_priority() {
        assert_eq!(
            combine_revert_gate(
                Some(PermissionVerdict::NeedsApproval),
                StreakVerdict::Allow,
                PermissionMode::FullAccess,
            ),
            Some(PermissionVerdict::NeedsApproval),
            "面积大必审批（即使首次）"
        );
        assert_eq!(
            combine_revert_gate(
                Some(PermissionVerdict::Deny),
                StreakVerdict::Allow,
                PermissionMode::Plan,
            ),
            Some(PermissionVerdict::Deny),
            "plan 下面积大保持更严拒绝"
        );
    }

    /// 面积小但窗口内第 2 次 → 必审批（防分多次小额回退绕过 C3）。
    #[test]
    fn combine_streak_second_call_requires_approval() {
        for mode in [PermissionMode::Ask, PermissionMode::FullAccess] {
            assert_eq!(
                combine_revert_gate(None, StreakVerdict::NeedsApproval, mode),
                Some(PermissionVerdict::NeedsApproval),
                "{mode:?} 下连续回退第 2 次必审批（full-access 不豁免）"
            );
        }
        assert_eq!(
            combine_revert_gate(None, StreakVerdict::NeedsApproval, PermissionMode::Plan),
            Some(PermissionVerdict::Deny),
            "plan 下连续回退拒绝（审批通道不存在，安全优先）"
        );
    }

    /// 面积小且首次 → 按既有矩阵放行（不产生审批）。
    #[test]
    fn combine_first_call_small_area_allows() {
        for mode in [
            PermissionMode::Ask,
            PermissionMode::FullAccess,
            PermissionMode::Plan,
        ] {
            assert_eq!(
                combine_revert_gate(None, StreakVerdict::Allow, mode),
                None,
                "{mode:?} 下面积小且首次按既有矩阵放行"
            );
        }
    }

    /// 触发原因：面积 + 连续双维度合取。
    #[test]
    fn guard_reasons_union() {
        assert_eq!(
            guard_reasons(true, StreakVerdict::NeedsApproval),
            vec![
                RevertGuardReason::AreaOverThreshold,
                RevertGuardReason::StreakSecondCall,
            ]
        );
        assert_eq!(guard_reasons(true, StreakVerdict::Allow), vec![
            RevertGuardReason::AreaOverThreshold
        ]);
        assert_eq!(guard_reasons(false, StreakVerdict::NeedsApproval), vec![
            RevertGuardReason::StreakSecondCall
        ]);
        assert!(guard_reasons(false, StreakVerdict::Allow).is_empty());
    }

    // ---- 只读视图（C4 验收 5：纯查询不计数）----

    /// peek 不改变计数、不落库。
    /// 注（I3-S6 交接修正）：peek/下次回退时间点须在时窗（600s）内
    /// （原 1000s 间隔触发惰性归零）；仅修正测试数据，逻辑未动。
    #[test]
    fn peek_does_not_count() {
        let guard = memory_guard(DEFAULT_REVERT_WINDOW_SECONDS);
        guard.record_revert("s1", 1_000);
        let peek = guard.peek("s1", 1_100);
        assert_eq!(peek.streak, StreakVerdict::NeedsApproval);
        assert_eq!(peek.snapshot_after.streak_count, 1, "peek 不递增计数");
        // 计数未被改变：下一次 record 仍是第 2 次
        let next = guard.record_revert("s1", 1_200);
        assert_eq!(next.snapshot_after.streak_count, 2, "peek 后计数未被推进");
    }

    /// 全新会话 peek：Allow 且计数保持 0。
    #[test]
    fn peek_fresh_session_allows() {
        let guard = memory_guard(DEFAULT_REVERT_WINDOW_SECONDS);
        let peek = guard.peek("s1", 1_700_000_000);
        assert_eq!(peek.streak, StreakVerdict::Allow);
        assert_eq!(peek.snapshot_after.streak_count, 0);
    }

    // ---- 持久化链路（session_meta 落库 + 重启恢复）----

    /// C4 验收 4：模拟重启后读取 session_meta，计数恢复且行为一致。
    /// 注（I3-S6 交接修正）：时间点间隔保持在时窗（600s）内（原 1000s
    /// 间隔触发惰性归零）；仅修正测试数据，逻辑未动。
    #[test]
    fn session_meta_store_persists_across_restart() {
        let ws = TempWorkspace::new("revert_counter_meta");
        let db_path = ws.path().join("sessions.db");

        // 第一段「会话」：两次回退（第 2 次触发审批），计数落库
        let persisted_count;
        let persisted_last;
        {
            let db = conex_db::LocalDb::open(&db_path).expect("打开测试库失败");
            let store: Arc<dyn RevertCounterStore> =
                Arc::new(SessionMetaRevertCounterStore { db });
            let guard = RevertCounterGuard::with_default_window(store);
            let first = guard.record_revert("", 1_700_000_000);
            assert_eq!(first.streak, StreakVerdict::Allow);
            let second = guard.record_revert("", 1_700_000_100);
            assert_eq!(second.streak, StreakVerdict::NeedsApproval);
            persisted_count = second.snapshot_after.streak_count;
            persisted_last = second.snapshot_after.last_revert_at_unix;
        } // db 析构，模拟进程退出

        // 重启：重开同库，session_meta 键必须保留（单会话引擎 → 04 字面键名）
        let db2 = conex_db::LocalDb::open(&db_path).expect("重开测试库失败");
        assert_eq!(
            db2.get_session_meta(KEY_COUNT).expect("读取计数键失败"),
            Some(persisted_count.to_string()),
            "重启后计数必须从 session_meta 恢复"
        );
        assert_eq!(
            db2.get_session_meta(KEY_LAST_AT).expect("读取时间戳键失败"),
            Some(persisted_last.expect("时间戳应已落库").to_string()),
            "重启后最近回退时间戳必须从 session_meta 恢复"
        );

        // 行为一致：恢复计数后下一次回退仍触发审批
        let store2: Arc<dyn RevertCounterStore> =
            Arc::new(SessionMetaRevertCounterStore { db: db2 });
        let guard2 = RevertCounterGuard::with_default_window(store2);
        let third = guard2.record_revert("", 1_700_000_200);
        assert_eq!(
            third.streak,
            StreakVerdict::NeedsApproval,
            "重启恢复计数后第 3 次仍应触发审批"
        );
        assert_eq!(third.snapshot_after.streak_count, persisted_count + 1);
    }

    /// 空库（无键）→ 全新会话，首次放行。
    #[test]
    fn session_meta_store_missing_keys_yield_fresh_state() {
        let ws = TempWorkspace::new("revert_counter_fresh");
        let db = conex_db::LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
        let store: Arc<dyn RevertCounterStore> =
            Arc::new(SessionMetaRevertCounterStore { db });
        let guard = RevertCounterGuard::with_default_window(store);
        let first = guard.record_revert("", 1_700_000_000);
        assert_eq!(first.streak, StreakVerdict::Allow, "全新会话首次回退放行");
        assert_eq!(first.snapshot_after.streak_count, 1);
    }

    /// 多会话经 session_meta 键前缀隔离。
    #[test]
    fn session_meta_store_isolates_sessions() {
        let ws = TempWorkspace::new("revert_counter_sessions");
        let db = conex_db::LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
        let store: Arc<dyn RevertCounterStore> =
            Arc::new(SessionMetaRevertCounterStore { db: db.clone() });
        let guard = RevertCounterGuard::with_default_window(store);
        guard.record_revert("s1", 1_700_000_000);
        guard.record_revert("s1", 1_700_000_100);
        let other = guard.record_revert("s2", 1_700_000_200);
        assert_eq!(other.streak, StreakVerdict::Allow, "会话 s2 不受 s1 计数影响");
        // 落库键含会话前缀
        assert!(db.get_session_meta("s1:revert_streak_count").unwrap().is_some());
        assert!(db.get_session_meta("s2:revert_streak_count").unwrap().is_some());
    }

    /// 集成：真实 session_meta 存储走 3 次回退 → 2 个审批请求、计数递增。
    #[test]
    fn counter_sequence_via_session_meta_store() {
        let ws = TempWorkspace::new("revert_counter_seq");
        let db = conex_db::LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
        let store: Arc<dyn RevertCounterStore> =
            Arc::new(SessionMetaRevertCounterStore { db });
        let guard = RevertCounterGuard::with_default_window(store);
        let approvals = (1_700_000_000..=1_700_000_200)
            .step_by(100)
            .map(|t| guard.record_revert("s1", t))
            .filter(|o| o.streak == StreakVerdict::NeedsApproval)
            .count();
        assert_eq!(approvals, 2, "窗口内 3 次回退产生 2 个审批请求");
    }
}
