//! Cron 调度纯函数（T-CF-08 冻结接口；TY-P3 自 conex-types 的 cron 模块迁入）
//!
//! 模块职责：
//! - [parse_cron]：5 段式 cron 表达式解析（分 时 日 月 周），语义逐项对齐前端
//!   校验器 workflowScheduler.ts:99-205（`*`、`n`、`a-b`、列表、`*/step`、
//!   `a-b/step`、`n/step` 全语法）；
//! - [CronSchedule::next_fire_after]：after_ms 之后第一个命中时刻（本地时区
//!   语义，时区偏移由 [LocalOffset] 注入；无命中返回 None）；
//! - [CronSchedule::cron_label]：人类可读标签（对齐前端 cronExpressionLabel
//!   workflowScheduler.ts:212-241）。
//!
//! 时间计算：公历换算走 `conex_shared::time`（Hinnant 算法唯一真源，本模块
//! 不复制）；本地时区偏移经 [LocalOffset] 注入——生产用 [SystemLocal]
//! （chrono `Local` 按**目标时刻**取偏移，含系统时区数据库的 DST 规则），
//! 确定性测试用 [FixedOffsetMinutes]。
//!
//! ## 语义选择（任务书 T-CF-08 定稿，与前端标签逻辑对齐）
//!
//! 1. **月/日/周 联合匹配 = AND**：month、day-of-month、day-of-week 三域**都命中
//!    才触发**（「两域都命中才触发」的常见语义，任务书 :729 明示；与 Vixie
//!    cron 的「任一域命中即触发」OR 语义不同）——「0 0 30 2 *」（2 月 30 日）
//!    恒无命中，返回 None。
//! 2. **本地时区 = 目标时刻的偏移**：先用 after_ms 时刻的偏移算候选，再按候选
//!    时刻的偏移复核；两次偏移不同（跨 DST 切换）则按新偏移重算一次，避免
//!    「按当前偏移展开未来墙钟」在切换点偏一小时（TY-11）。
//! 3. **步进语义对齐前端**：`a-b/n` 展开为 a..=b 的等差序列（首项 a，步长 n，
//!    可越过 b 之后部分项被截断）；`n/step` 从 n 起步进至字段上限；`*/n` 要求
//!    n ≤ 上限（前端拒绝 `*/60`）；列表内不允许步进（前端 split(',') 后逐项
//!    只校验单值/范围）。
//! 4. **dow 0-7**：0 与 7 都表示周日（前端 CRON_FIELD_BOUNDS 注释同源）。

pub mod parse;
pub mod schedule;

#[cfg(test)]
mod tests;

pub use parse::{parse_cron, CronError, CronField};
pub use schedule::CronSchedule;

/// 本地时区偏移提供者（分钟，东八区为 +480）
///
/// 抽成 trait 的唯一目的是把「系统时区」从纯计算中剥离：生产走 [SystemLocal]，
/// 测试注入 [FixedOffsetMinutes] 获得确定性（R3/R4 不断言本机时区）。
pub trait LocalOffset {
    /// 给定 UTC 时刻（epoch 毫秒）在该时区生效的偏移分钟数
    ///
    /// 必须按 `utc_ms` **目标时刻**求值，而不是「当前时刻」——DST 切换前后
    /// 同一墙钟时刻对应不同 UTC 时刻，用当前偏移展开未来墙钟会偏一小时。
    fn offset_minutes_at(&self, utc_ms: i64) -> i32;
}

/// 固定偏移（分钟；确定性测试注入，UTC+8 = 480）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FixedOffsetMinutes(pub i32);

impl LocalOffset for FixedOffsetMinutes {
    fn offset_minutes_at(&self, _utc_ms: i64) -> i32 {
        self.0
    }
}

/// 系统本地时区（chrono `Local`：偏移按目标时刻查询，含系统时区 DST 规则）
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemLocal;

impl LocalOffset for SystemLocal {
    fn offset_minutes_at(&self, utc_ms: i64) -> i32 {
        use chrono::{Local, LocalResult, TimeZone};

        // UTC 时刻 → 本地时刻的映射是全函数；Ambiguous 仅在按本地墙钟构造
        // 时出现（回拨重叠），此处取较早一侧；None 为防御分支（不可达），
        // 退化为当前偏移，保证签名恒有值。
        match Local.timestamp_millis_opt(utc_ms) {
            LocalResult::Single(dt) => dt.offset().local_minus_utc() / 60,
            LocalResult::Ambiguous(earliest, _) => earliest.offset().local_minus_utc() / 60,
            LocalResult::None => Local::now().offset().local_minus_utc() / 60,
        }
    }
}
