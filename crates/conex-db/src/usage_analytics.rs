//! 用量监控时序分析与持久化聚合引擎（Conex Usage Analytics Engine）
//!
//! 模块职责：
//! 1. `usage_records` 表单行持久化与批量组提交接口；
//! 2. 24h（按时分桶）/ 7d / 30d（按天分桶）时钟时序聚合算法与 Zero-Fill 补零连续性保障；
//! 3. 活跃度矩阵（Activity Matrix Heatmap）切片算法（24h: 2x24 | 7d: 7x24 | 30d: 4x30 时段矩阵）；
//! 4. 6 项习惯与偏好纯文字宏观指标模型（平均用量、平均花费、消息数、最常用模型、峰值时段、最常项目）；
//! 5. 存量 LocalStorage（`crish_usage_history_v1`）快照幂等平滑迁移器。

use super::{DbFailure, DbFailureKind, LocalDb};
use rusqlite::params;
use std::collections::HashMap;

/// 单条用量记录行
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct UsageRecordRow {
    pub id: i64,
    pub session_id: String,
    pub run_id: Option<String>,
    pub project_name: String,
    pub model: String,
    pub provider: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cost_cny: f64,
    pub cost_usd: f64,
    pub timestamp: i64,
}

/// 写入用量参数
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct InsertUsageRecordInput {
    pub session_id: String,
    pub run_id: Option<String>,
    pub project_name: String,
    pub model: String,
    pub provider: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cost_cny: f64,
    pub cost_usd: f64,
    pub timestamp: i64,
}

/// 6 项纯文字习惯指标 DTO
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageHeroStats {
    pub daily_average_tokens: u64,
    pub daily_average_cost: f64,
    pub total_messages: u64,
    pub top_model: String,
    pub peak_active_hour_range: String,
    pub top_project: String,
}

/// 连续趋势折线图采样点 DTO
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTimeseriesPoint {
    pub label: String,
    pub timestamp: i64,
    pub input: u64,
    pub output: u64,
    pub cache: u64,
    pub total: u64,
    pub cost: f64,
    pub model_tokens: HashMap<String, u64>,
    pub model_costs: HashMap<String, f64>,
}

/// 4 维模型占比明细项 DTO
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageModelBreakdownItem {
    pub model: String,
    pub provider: String,
    pub tokens: u64,
    pub percentage: f64,
    pub cost: f64,
    pub cache_ratio: f64,
    pub call_count: u64,
}

/// 原子全景数据看板快照 DTO
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDashboardDto {
    pub range: String,
    pub hero: UsageHeroStats,
    pub points: Vec<UsageTimeseriesPoint>,
    pub max_tokens: u64,
    pub max_cost: f64,
    pub models: Vec<UsageModelBreakdownItem>,
    pub total_input: u64,
    pub total_output: u64,
    pub total_cache_read: u64,
    pub total_cost: f64,
    pub updated_at: i64,
}

/// 热力图单元格 DTO
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityMatrixCell {
    pub row: usize,
    pub col: usize,
    pub row_label: String,
    pub col_label: String,
    pub tokens: u64,
    pub cost: f64,
    pub calls: u64,
    pub level: u8,
}

/// 活跃度矩阵热力图 DTO
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityMatrixDto {
    pub range: String,
    pub rows: Vec<String>,
    pub cols: Vec<String>,
    pub cells: Vec<ActivityMatrixCell>,
    pub max_tokens: u64,
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯数学日历与时间算法工具函数（零外部依赖，极速无分配）
// ─────────────────────────────────────────────────────────────────────────────

/// Howard Hinnant 算法：将天数计数（从 1970-01-01 开始）转换为 (年, 月, 日)
pub fn days_to_ymd(days: i64) -> (i32, u32, u32) {
    let z = days + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1024 + doe / 1461 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d)
}

/// 星期计算（0 = 周一, ..., 6 = 周日）
pub fn day_of_week(days: i64) -> usize {
    // 1970-01-01 是周四 (index 3, where Monday = 0)
    let rem = (days + 3) % 7;
    if rem < 0 {
        (rem + 7) as usize
    } else {
        rem as usize
    }
}

/// 格式化为 MM-DD 字符串
pub fn format_month_day(timestamp_ms: i64, tz_offset_minutes: i32) -> String {
    let local_ms = timestamp_ms - (tz_offset_minutes as i64) * 60_000;
    let days = local_ms.div_euclid(86_400_000);
    let (_, m, d) = days_to_ymd(days);
    format!("{:02}-{:02}", m, d)
}

/// 格式化为 HH:00 字符串
pub fn format_hour_str(timestamp_ms: i64, tz_offset_minutes: i32) -> String {
    let local_ms = timestamp_ms - (tz_offset_minutes as i64) * 60_000;
    let seconds_of_day = local_ms.rem_euclid(86_400_000) / 1000;
    let hours = seconds_of_day / 3600;
    format!("{:02}:00", hours)
}

/// 获取当地时区的当前小时（0..23）
pub fn local_hour(timestamp_ms: i64, tz_offset_minutes: i32) -> u32 {
    let local_ms = timestamp_ms - (tz_offset_minutes as i64) * 60_000;
    let seconds_of_day = local_ms.rem_euclid(86_400_000) / 1000;
    (seconds_of_day / 3600) as u32
}

// ─────────────────────────────────────────────────────────────────────────────
// LocalDb 业务实现面
// ─────────────────────────────────────────────────────────────────────────────

impl LocalDb {
    /// 插入一条用量记录。经组提交 Writer。
    pub fn insert_usage_record(&self, input: InsertUsageRecordInput) -> Result<i64, DbFailure> {
        self.write_blocking(move |conn| {
            let timestamp = if input.timestamp <= 0 {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0)
            } else {
                input.timestamp
            };

            conn.execute(
                "INSERT INTO usage_records (
                    session_id, run_id, project_name, model, provider,
                    prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens,
                    cost_cny, cost_usd, timestamp
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12);",
                params![
                    input.session_id,
                    input.run_id,
                    input.project_name,
                    input.model,
                    input.provider,
                    input.prompt_tokens as i64,
                    input.completion_tokens as i64,
                    input.cache_read_tokens as i64,
                    input.cache_write_tokens as i64,
                    input.cost_cny,
                    input.cost_usd,
                    timestamp,
                ],
            )
            .map_err(|e| DbFailure {
                message: format!("insert_usage_record: {e}"),
                kind: DbFailureKind::Other("insert_usage_record".to_string()),
            })?;
            Ok(conn.last_insert_rowid())
        })
    }

    /// 清空本机全部用量记录。经组提交 Writer。
    pub fn clear_usage_history(&self) -> Result<(), DbFailure> {
        self.write_blocking(move |conn| {
            conn.execute("DELETE FROM usage_records;", [])
                .map_err(|e| DbFailure {
                    message: format!("clear_usage_history: {e}"),
                    kind: DbFailureKind::Other("clear_usage_history".to_string()),
                })?;
            Ok(())
        })
    }

    /// 存量 LocalStorage 快照平滑迁移（幂等，成功导入返回 true，已迁移过返回 false）。
    ///
    /// 写路径经组提交 Writer（D-P15：废除主连接裸锁写循环；幂等检查、
    /// 批量 INSERT 与迁移标记同处 Actor 的 `BEGIN IMMEDIATE` 事务内，
    /// check-then-write 原子生效；闭包禁 `self` / 禁嵌套事务）。
    pub fn import_legacy_usage_snapshot(
        &self,
        snapshot: &serde_json::Value,
    ) -> Result<bool, DbFailure> {
        let snapshot = snapshot.clone();
        self.write_blocking(move |conn| {
            // 检查 session_meta 标记
            let already_imported: bool = conn
                .query_row(
                    "SELECT COUNT(*) FROM session_meta WHERE key = 'legacy_usage_migrated_v10';",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map(|cnt| cnt > 0)
                .unwrap_or(false);

            if already_imported {
                return Ok(false);
            }

            let days = snapshot.get("days").and_then(|d| d.as_array());
            if let Some(day_list) = days {
                for item in day_list {
                    let day_str = item.get("day").and_then(|s| s.as_str()).unwrap_or("");
                    let input = item.get("input").and_then(|n| n.as_u64()).unwrap_or(0);
                    let output = item.get("output").and_then(|n| n.as_u64()).unwrap_or(0);
                    let cost = item.get("cost").and_then(|n| n.as_f64()).unwrap_or(0.0);
                    let cache_read = item.get("cacheRead").and_then(|n| n.as_u64()).unwrap_or(0);
                    let cache_write = item.get("cacheWrite").and_then(|n| n.as_u64()).unwrap_or(0);

                    if day_str.is_empty() {
                        continue;
                    }

                    // 将 YYYY-MM-DD 解析为当日正午时间戳（12:00:00 UTC）
                    let parts: Vec<&str> = day_str.split('-').collect();
                    if parts.len() != 3 {
                        continue;
                    }
                    let y: i32 = parts[0].parse().unwrap_or(1970);
                    let m: u32 = parts[1].parse().unwrap_or(1);
                    let d: u32 = parts[2].parse().unwrap_or(1);

                    const DAYS_BEFORE_MONTH: [i64; 12] =
                        [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
                    let is_leap = (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
                    let m_idx = ((m as usize).saturating_sub(1)).min(11);
                    let mut days_in_year = DAYS_BEFORE_MONTH[m_idx] + (d as i64 - 1);
                    if is_leap && m > 2 {
                        days_in_year += 1;
                    }
                    let mut total_days = 0i64;
                    for yr in 1970..y {
                        let yr_leap = (yr % 4 == 0 && yr % 100 != 0) || (yr % 400 == 0);
                        total_days += if yr_leap { 366 } else { 365 };
                    }
                    total_days += days_in_year;
                    let timestamp = total_days * 86_400_000 + 12 * 3_600_000;

                    conn.execute(
                        "INSERT INTO usage_records (
                            session_id, run_id, project_name, model, provider,
                            prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens,
                            cost_cny, cost_usd, timestamp
                        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12);",
                        params![
                            "legacy-session",
                            None::<String>,
                            "legacy",
                            "legacy-aggregated",
                            "default",
                            input as i64,
                            output as i64,
                            cache_read as i64,
                            cache_write as i64,
                            cost * 7.25, // 估算折合人民币
                            cost,
                            timestamp,
                        ],
                    )
                    .map_err(|e| DbFailure {
                        message: format!("import_legacy_snapshot_item: {e}"),
                        kind: DbFailureKind::Other("import_legacy_usage_snapshot".to_string()),
                    })?;
                }
            }

            // 写入 session_meta 迁移标记
            conn.execute(
                "INSERT OR REPLACE INTO session_meta (key, value) VALUES ('legacy_usage_migrated_v10', '1');",
                [],
            )
            .map_err(|e| DbFailure {
                message: format!("set_legacy_usage_migrated_flag: {e}"),
                kind: DbFailureKind::Other("import_legacy_usage_snapshot".to_string()),
            })?;

            Ok(true)
        })
    }

    /// 查询用量全景仪表盘数据
    pub fn query_usage_dashboard(
        &self,
        range: &str,
        tz_offset_minutes: i32,
        now_ms_override: Option<i64>,
    ) -> Result<UsageDashboardDto, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let now_ms = now_ms_override.unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0)
        });

        let (start_ms, bucket_size_ms, num_buckets, is_hourly, days_count) = match range {
            "24h" => {
                let bucket_size = 3_600_000; // 1h
                let count = 24;
                let start = now_ms - (count as i64 * bucket_size);
                (start, bucket_size, count, true, 1u64)
            }
            "7d" => {
                let bucket_size = 86_400_000; // 1d
                let count = 7;
                let start = now_ms - (count as i64 * bucket_size);
                (start, bucket_size, count, false, 7u64)
            }
            _ => {
                // 默认 30d
                let bucket_size = 86_400_000; // 1d
                let count = 30;
                let start = now_ms - (count as i64 * bucket_size);
                (start, bucket_size, count, false, 30u64)
            }
        };

        // 1. 初始化空桶进行 Zero-Fill 补齐
        let mut points: Vec<UsageTimeseriesPoint> = Vec::with_capacity(num_buckets);
        for i in 0..num_buckets {
            let b_start = start_ms + (i as i64 * bucket_size_ms);
            let label = if is_hourly {
                format_hour_str(b_start, tz_offset_minutes)
            } else {
                format_month_day(b_start, tz_offset_minutes)
            };
            points.push(UsageTimeseriesPoint {
                label,
                timestamp: b_start,
                input: 0,
                output: 0,
                cache: 0,
                total: 0,
                cost: 0.0,
                model_tokens: HashMap::new(),
                model_costs: HashMap::new(),
            });
        }

        // 2. 查询时间范围内的所有记录
        let mut stmt = conn
            .prepare(
                "SELECT id, session_id, run_id, project_name, model, provider,
                        prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens,
                        cost_cny, cost_usd, timestamp
                 FROM usage_records
                 WHERE timestamp >= ?1 AND timestamp <= ?2
                 ORDER BY timestamp ASC;",
            )
            .map_err(|e| self.latch_error("query_dashboard_prepare", e))?;

        let rows = stmt
            .query_map(params![start_ms, now_ms], |r| {
                Ok(UsageRecordRow {
                    id: r.get(0)?,
                    session_id: r.get(1)?,
                    run_id: r.get(2)?,
                    project_name: r.get(3)?,
                    model: r.get(4)?,
                    provider: r.get(5)?,
                    prompt_tokens: r.get::<_, i64>(6)?.max(0) as u64,
                    completion_tokens: r.get::<_, i64>(7)?.max(0) as u64,
                    cache_read_tokens: r.get::<_, i64>(8)?.max(0) as u64,
                    cache_write_tokens: r.get::<_, i64>(9)?.max(0) as u64,
                    cost_cny: r.get(10)?,
                    cost_usd: r.get(11)?,
                    timestamp: r.get(12)?,
                })
            })
            .map_err(|e| self.latch_error("query_dashboard_map", e))?;

        let mut total_input: u64 = 0;
        let mut total_output: u64 = 0;
        let mut total_cache_read: u64 = 0;
        let mut total_cost: f64 = 0.0;
        let mut total_messages: u64 = 0;

        let mut model_stats_map: HashMap<String, (String, u64, f64, u64, u64)> = HashMap::new(); // model -> (provider, tokens, cost, cache_read, calls)
        let mut project_counts: HashMap<String, u64> = HashMap::new();
        let mut hour_activity: [u64; 24] = [0; 24];

        for row_res in rows {
            let row = row_res.map_err(|e| self.latch_error("query_dashboard_row", e))?;
            let tokens = row.prompt_tokens + row.completion_tokens;
            total_input += row.prompt_tokens;
            total_output += row.completion_tokens;
            total_cache_read += row.cache_read_tokens;
            total_cost += row.cost_cny;
            total_messages += 1;

            // 分桶计算
            if row.timestamp >= start_ms && row.timestamp <= now_ms {
                let offset = row.timestamp - start_ms;
                let b_idx = (offset / bucket_size_ms).clamp(0, (num_buckets - 1) as i64) as usize;
                if let Some(pt) = points.get_mut(b_idx) {
                    pt.input += row.prompt_tokens;
                    pt.output += row.completion_tokens;
                    pt.cache += row.cache_read_tokens;
                    pt.total += tokens;
                    pt.cost += row.cost_cny;

                    *pt.model_tokens.entry(row.model.clone()).or_insert(0) += tokens;
                    *pt.model_costs.entry(row.model.clone()).or_insert(0.0) += row.cost_cny;
                }
            }

            // 模型统计汇总
            let entry = model_stats_map
                .entry(row.model.clone())
                .or_insert_with(|| (row.provider.clone(), 0, 0.0, 0, 0));
            entry.1 += tokens;
            entry.2 += row.cost_cny;
            entry.3 += row.cache_read_tokens;
            entry.4 += 1;

            // 项目计数汇总
            if !row.project_name.trim().is_empty() {
                *project_counts.entry(row.project_name.clone()).or_insert(0) += 1;
            }

            // 活跃时段统计
            let h = local_hour(row.timestamp, tz_offset_minutes) as usize;
            if h < 24 {
                hour_activity[h] += 1;
            }
        }

        // 3. 计算极值与最大值
        let mut max_tokens: u64 = 0;
        let mut max_cost: f64 = 0.0;
        for p in &points {
            if p.total > max_tokens {
                max_tokens = p.total;
            }
            if p.cost > max_cost {
                max_cost = p.cost;
            }
        }

        // 4. 构建模型占比列表
        let grand_total_tokens = total_input + total_output;
        let mut models: Vec<UsageModelBreakdownItem> = model_stats_map
            .into_iter()
            .map(|(model, (provider, tokens, cost, cache_read, calls))| {
                let percentage = if grand_total_tokens > 0 {
                    (tokens as f64 / grand_total_tokens as f64) * 100.0
                } else {
                    0.0
                };
                let total_all = tokens + cache_read;
                let cache_ratio = if total_all > 0 {
                    (cache_read as f64 / total_all as f64) * 100.0
                } else {
                    0.0
                };
                UsageModelBreakdownItem {
                    model,
                    provider,
                    tokens,
                    percentage,
                    cost,
                    cache_ratio,
                    call_count: calls,
                }
            })
            .collect();
        models.sort_by_key(|a| std::cmp::Reverse(a.tokens));

        // 5. 计算 6 项核心指标（若无真实用量数据，严禁伪造假数据画像，统一返回 "—"）
        let top_model = if grand_total_tokens > 0 {
            models
                .first()
                .map(|m| m.model.clone())
                .unwrap_or_else(|| "—".to_string())
        } else {
            "—".to_string()
        };

        let top_project = if grand_total_tokens > 0 {
            project_counts
                .into_iter()
                .max_by_key(|(_, cnt)| *cnt)
                .map(|(p, _)| p)
                .unwrap_or_else(|| "—".to_string())
        } else {
            "—".to_string()
        };

        // 计算峰值时段（3 小时连续滑动窗口，仅在有真实用量时计算）
        let mut max_sum: u64 = 0;
        let mut best_start_h: usize = 0;
        for h in 0..22 {
            let sum = hour_activity[h] + hour_activity[h + 1] + hour_activity[h + 2];
            if sum > max_sum {
                max_sum = sum;
                best_start_h = h;
            }
        }
        let peak_active_hour_range = if grand_total_tokens > 0 && max_sum > 0 {
            match best_start_h {
                0..=5 => "凌晨 00:00 – 05:00".to_string(),
                6..=11 => "上午 09:00 – 12:00".to_string(),
                12..=17 => "下午 14:00 – 17:00".to_string(),
                _ => "晚间 20:00 – 23:00".to_string(),
            }
        } else {
            "—".to_string()
        };

        let daily_average_tokens = grand_total_tokens / days_count;
        let daily_average_cost = total_cost / (days_count as f64).max(1.0);

        let hero = UsageHeroStats {
            daily_average_tokens,
            daily_average_cost,
            total_messages,
            top_model,
            peak_active_hour_range,
            top_project,
        };

        Ok(UsageDashboardDto {
            range: range.to_string(),
            hero,
            points,
            max_tokens,
            max_cost,
            models,
            total_input,
            total_output,
            total_cache_read,
            total_cost,
            updated_at: now_ms,
        })
    }

    /// 查询活跃度热力图矩阵切片
    pub fn query_activity_matrix(
        &self,
        range: &str,
        tz_offset_minutes: i32,
        now_ms_override: Option<i64>,
    ) -> Result<ActivityMatrixDto, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let now_ms = now_ms_override.unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0)
        });

        // 确定热力图布局
        let (rows, cols, num_rows, num_cols, start_ms) = match range {
            "24h" => {
                let rows = vec!["今日".to_string(), "昨日".to_string()];
                let mut cols = Vec::with_capacity(24);
                for h in 0..24 {
                    cols.push(format!("{:02}:00", h));
                }
                let start = now_ms - (48 * 3_600_000);
                (rows, cols, 2, 24, start)
            }
            "7d" => {
                let rows = vec![
                    "周一".to_string(),
                    "周二".to_string(),
                    "周三".to_string(),
                    "周四".to_string(),
                    "周五".to_string(),
                    "周六".to_string(),
                    "周日".to_string(),
                ];
                let mut cols = Vec::with_capacity(24);
                for h in 0..24 {
                    cols.push(format!("{:02}:00", h));
                }
                let start = now_ms - (7 * 86_400_000);
                (rows, cols, 7, 24, start)
            }
            _ => {
                // 30d 模式：8 行（时段，每 3 小时一段）x 30 列（日期）
                let rows = vec![
                    "00-03".to_string(),
                    "03-06".to_string(),
                    "06-09".to_string(),
                    "09-12".to_string(),
                    "12-15".to_string(),
                    "15-18".to_string(),
                    "18-21".to_string(),
                    "21-24".to_string(),
                ];
                let mut cols = Vec::with_capacity(30);
                for i in 0..30 {
                    let day_ts = now_ms - ((29 - i) as i64 * 86_400_000);
                    cols.push(format_month_day(day_ts, tz_offset_minutes));
                }
                let start = now_ms - (30 * 86_400_000);
                (rows, cols, 8, 30, start)
            }
        };

        // 初始化单元格
        let mut cells: Vec<ActivityMatrixCell> = Vec::with_capacity(num_rows * num_cols);
        for (r, row_label) in rows.iter().enumerate().take(num_rows) {
            for (c, col_label) in cols.iter().enumerate().take(num_cols) {
                cells.push(ActivityMatrixCell {
                    row: r,
                    col: c,
                    row_label: row_label.clone(),
                    col_label: col_label.clone(),
                    tokens: 0,
                    cost: 0.0,
                    calls: 0,
                    level: 0,
                });
            }
        }

        // 查询记录
        let mut stmt = conn
            .prepare(
                "SELECT prompt_tokens, completion_tokens, cost_cny, timestamp
                 FROM usage_records
                 WHERE timestamp >= ?1 AND timestamp <= ?2
                 ORDER BY timestamp ASC;",
            )
            .map_err(|e| self.latch_error("query_activity_prepare", e))?;

        let rows_iter = stmt
            .query_map(params![start_ms, now_ms], |r| {
                Ok((
                    (r.get::<_, i64>(0)?.max(0) as u64) + (r.get::<_, i64>(1)?.max(0) as u64),
                    r.get::<_, f64>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })
            .map_err(|e| self.latch_error("query_activity_map", e))?;

        let local_now_ms = now_ms - (tz_offset_minutes as i64) * 60_000;
        let today_days = local_now_ms.div_euclid(86_400_000);

        for row_res in rows_iter {
            let (tokens, cost, ts) =
                row_res.map_err(|e| self.latch_error("query_activity_row", e))?;
            let local_ts = ts - (tz_offset_minutes as i64) * 60_000;
            let record_days = local_ts.div_euclid(86_400_000);
            let h = ((local_ts.rem_euclid(86_400_000) / 1000) / 3600) as usize;

            match range {
                "24h" => {
                    let diff_days = today_days - record_days;
                    if diff_days == 0 && h < 24 {
                        // 今日
                        let idx = h;
                        if let Some(cell) = cells.get_mut(idx) {
                            cell.tokens += tokens;
                            cell.cost += cost;
                            cell.calls += 1;
                        }
                    } else if diff_days == 1 && h < 24 {
                        // 昨日
                        let idx = 24 + h;
                        if let Some(cell) = cells.get_mut(idx) {
                            cell.tokens += tokens;
                            cell.cost += cost;
                            cell.calls += 1;
                        }
                    }
                }
                "7d" => {
                    let diff_days = today_days - record_days;
                    // audit-repair-202609 T21：行轴为星期（7 行），只纳入
                    // diff_days 0..=6 —— 恰好 7 个日历日且每星期行仅对应
                    // 唯一一天；含 8 会让同一星期行叠加两天的数据。
                    if (0..7).contains(&diff_days) {
                        let dow = day_of_week(record_days); // 0=Mon..6=Sun
                        if dow < 7 && h < 24 {
                            let idx = dow * 24 + h;
                            if let Some(cell) = cells.get_mut(idx) {
                                cell.tokens += tokens;
                                cell.cost += cost;
                                cell.calls += 1;
                            }
                        }
                    }
                }
                _ => {
                    // 30d
                    let diff_days = today_days - record_days;
                    if (0..30).contains(&diff_days) {
                        let col_idx = (29 - diff_days) as usize;
                        let row_idx = (h / 3).min(7);
                        let idx = row_idx * 30 + col_idx;
                        if let Some(cell) = cells.get_mut(idx) {
                            cell.tokens += tokens;
                            cell.cost += cost;
                            cell.calls += 1;
                        }
                    }
                }
            }
        }

        // 计算最大用量与色阶等级 Level 0~4
        let mut max_tokens: u64 = 0;
        let mut min_nonzero: u64 = u64::MAX;
        for c in &cells {
            if c.tokens > max_tokens {
                max_tokens = c.tokens;
            }
            if c.tokens > 0 && c.tokens < min_nonzero {
                min_nonzero = c.tokens;
            }
        }
        if min_nonzero == u64::MAX {
            min_nonzero = 1;
        }

        for cell in &mut cells {
            if cell.tokens == 0 {
                cell.level = 0;
            } else if max_tokens == min_nonzero {
                cell.level = 2;
            } else {
                let ln_val = (1.0 + cell.tokens as f64).ln();
                let ln_min = (1.0 + min_nonzero as f64).ln();
                let ln_max = (1.0 + max_tokens as f64).ln();
                let ratio = ((ln_val - ln_min) / (ln_max - ln_min + 1e-6)).clamp(0.0, 1.0);
                let lvl = if ratio < 0.25 {
                    1
                } else if ratio < 0.50 {
                    2
                } else if ratio < 0.75 {
                    3
                } else {
                    4
                };
                cell.level = lvl;
            }
        }

        Ok(ActivityMatrixDto {
            range: range.to_string(),
            rows,
            cols,
            cells,
            max_tokens,
        })
    }
}
