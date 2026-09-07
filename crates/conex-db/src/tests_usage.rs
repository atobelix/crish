//! 用量统计持久化、时序聚合、热力图切片与存量迁移测试集

use super::*;
use crate::usage_analytics::*;

#[test]
fn migration_v10_creates_usage_records_table_and_indexes() {
    let db = LocalDb::open_in_memory().unwrap();
    assert_eq!(db.user_version().unwrap(), 10);

    let conn = db.conn.lock().unwrap();
    let has_table: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='usage_records';",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(has_table, 1, "usage_records 表必须存在");

    let indexes: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='usage_records';")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .filter_map(|r| r.ok())
        .collect();

    assert!(indexes.contains(&"idx_usage_records_ts".to_string()));
    assert!(indexes.contains(&"idx_usage_records_model_ts".to_string()));
    assert!(indexes.contains(&"idx_usage_records_project_ts".to_string()));
    assert!(indexes.contains(&"idx_usage_records_session".to_string()));
}

#[test]
fn insert_and_clear_usage_records() {
    let db = LocalDb::open_in_memory().unwrap();

    let id1 = db
        .insert_usage_record(InsertUsageRecordInput {
            session_id: "s1".to_string(),
            run_id: Some("r1".to_string()),
            project_name: "conex".to_string(),
            model: "claude-3-7-sonnet".to_string(),
            provider: "anthropic".to_string(),
            prompt_tokens: 100,
            completion_tokens: 50,
            cache_read_tokens: 20,
            cache_write_tokens: 0,
            cost_cny: 0.15,
            cost_usd: 0.02,
            timestamp: 1700000000000,
        })
        .unwrap();
    assert!(id1 > 0);

    let id2 = db
        .insert_usage_record(InsertUsageRecordInput {
            session_id: "s1".to_string(),
            run_id: Some("r2".to_string()),
            project_name: "conex".to_string(),
            model: "deepseek-v4-flash".to_string(),
            provider: "deepseek".to_string(),
            prompt_tokens: 200,
            completion_tokens: 100,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cost_cny: 0.05,
            cost_usd: 0.007,
            timestamp: 1700000001000,
        })
        .unwrap();
    assert!(id2 > id1);

    // 清空历史
    db.clear_usage_history().unwrap();
    let conn = db.conn.lock().unwrap();
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM usage_records;", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn query_usage_dashboard_zero_fill_24h() {
    let db = LocalDb::open_in_memory().unwrap();
    let now_ms = 1700000000000i64; // 基准测试时刻
    let tz = -480; // 东八区

    // 在 now_ms - 2h 写入一条
    db.insert_usage_record(InsertUsageRecordInput {
        session_id: "s1".to_string(),
        run_id: None,
        project_name: "conex".to_string(),
        model: "deepseek-v4-flash".to_string(),
        provider: "deepseek".to_string(),
        prompt_tokens: 1000,
        completion_tokens: 500,
        cache_read_tokens: 200,
        cache_write_tokens: 0,
        cost_cny: 1.20,
        cost_usd: 0.16,
        timestamp: now_ms - 2 * 3600 * 1000,
    })
    .unwrap();

    let res = db.query_usage_dashboard("24h", tz, Some(now_ms)).unwrap();
    assert_eq!(res.points.len(), 24, "24h 必须输出严格 24 个时间桶");
    assert_eq!(res.total_input, 1000);
    assert_eq!(res.total_output, 500);
    assert_eq!(res.total_cache_read, 200);
    assert_eq!(res.hero.top_model, "deepseek-v4-flash");
    assert_eq!(res.hero.top_project, "conex");

    // 检查第 22 桶（now - 2h）有值，其余桶 Zero-Fill 补零
    let target_pt = &res.points[22];
    assert_eq!(target_pt.total, 1500);
    assert_eq!(target_pt.input, 1000);
    assert_eq!(target_pt.output, 500);
    assert_eq!(target_pt.cache, 200);

    // 检查空桶
    let empty_pt = &res.points[0];
    assert_eq!(empty_pt.total, 0);
    assert_eq!(empty_pt.cost, 0.0);
}

#[test]
fn query_usage_dashboard_7d_and_30d() {
    let db = LocalDb::open_in_memory().unwrap();
    let now_ms = 1700000000000i64;
    let tz = -480;

    let res_7d = db.query_usage_dashboard("7d", tz, Some(now_ms)).unwrap();
    assert_eq!(res_7d.points.len(), 7, "7d 必须输出严格 7 个日桶");

    let res_30d = db.query_usage_dashboard("30d", tz, Some(now_ms)).unwrap();
    assert_eq!(res_30d.points.len(), 30, "30d 必须输出严格 30 个日桶");
}

#[test]
fn query_activity_matrix_8x30() {
    let db = LocalDb::open_in_memory().unwrap();
    let now_ms = 1700000000000i64;
    let tz = -480;

    // 插入不同时段的数据
    // 1. 今天下午 14:00 (属于 12-15 时段，第 4 行)
    db.insert_usage_record(InsertUsageRecordInput {
        session_id: "s1".to_string(),
        run_id: None,
        project_name: "conex".to_string(),
        model: "claude-3-7-sonnet".to_string(),
        provider: "anthropic".to_string(),
        prompt_tokens: 500,
        completion_tokens: 300,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_cny: 0.5,
        cost_usd: 0.07,
        timestamp: now_ms,
    })
    .unwrap();

    let matrix = db.query_activity_matrix("30d", tz, Some(now_ms)).unwrap();
    assert_eq!(matrix.rows.len(), 8, "30d 必须为 8 行时段 (每 3 小时一段)");
    assert_eq!(matrix.rows[0], "00-03");
    assert_eq!(matrix.rows[7], "21-24");
    assert_eq!(matrix.cols.len(), 30, "30d 必须为 30 列日期");
    assert_eq!(matrix.cells.len(), 240, "30d 必须包含严格 240 个单元格");

    let active_cells: Vec<_> = matrix.cells.iter().filter(|c| c.tokens > 0).collect();
    assert!(!active_cells.is_empty(), "必须有单元格被命中");
    assert_eq!(active_cells[0].row, 2, "h=6 落在第 2 行 (06-09)");
    assert_eq!(active_cells[0].row_label, "06-09");
    assert!(active_cells[0].level >= 1 && active_cells[0].level <= 4);
}

#[test]
fn query_activity_matrix_24h_and_7d() {
    let db = LocalDb::open_in_memory().unwrap();
    let now_ms = 1700000000000i64;
    let tz = -480;

    let m_24h = db.query_activity_matrix("24h", tz, Some(now_ms)).unwrap();
    assert_eq!(m_24h.rows.len(), 2, "24h 必须为今日/昨日 2 行");
    assert_eq!(m_24h.cols.len(), 24, "24h 必须为 24 小时");
    assert_eq!(m_24h.cells.len(), 48);

    let m_7d = db.query_activity_matrix("7d", tz, Some(now_ms)).unwrap();
    assert_eq!(m_7d.rows.len(), 7, "7d 必须为周一至周日 7 行");
    assert_eq!(m_7d.cols.len(), 24, "7d 必须为 24 小时");
    assert_eq!(m_7d.cells.len(), 168);
}

/// audit-repair-202609 T21：7d 星期矩阵只纳入 diff_days 0..=6（7 个日历日），
/// 第 8 天（diff_days = 7，同一星期）不得叠加进同一行。
#[test]
fn query_activity_matrix_7d_excludes_eighth_calendar_day() {
    let db = LocalDb::open_in_memory().unwrap();
    let now_ms = 1700000000000i64;
    let tz = -480;

    let insert = |db: &LocalDb, session: &str, ts: i64, tokens: u64| {
        db.insert_usage_record(InsertUsageRecordInput {
            session_id: session.to_string(),
            run_id: None,
            project_name: "conex".to_string(),
            model: "test-model".to_string(),
            provider: "test".to_string(),
            prompt_tokens: tokens,
            completion_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cost_cny: 0.0,
            cost_usd: 0.0,
            timestamp: ts,
        })
        .unwrap();
    };

    // 今天（diff 0）与 6 天前（diff 6）纳入；7 天前（diff 7）排除
    insert(&db, "today", now_ms, 500);
    insert(&db, "six-days-ago", now_ms - 6 * 86_400_000, 700);
    insert(&db, "seven-days-ago", now_ms - 7 * 86_400_000, 900);

    let m = db.query_activity_matrix("7d", tz, Some(now_ms)).unwrap();
    let total: u64 = m.cells.iter().map(|c| c.tokens).sum();
    assert_eq!(
        total, 1200u64,
        "7d 星期矩阵只应包含今天(500)+6天前(700)，第 8 个日历日(900)不得计入"
    );
}

#[test]
fn import_legacy_usage_snapshot_idempotent() {
    let db = LocalDb::open_in_memory().unwrap();

    let legacy_json = serde_json::json!({
        "days": [
            {
                "day": "2026-08-01",
                "input": 5000,
                "output": 2000,
                "cost": 0.45,
                "cacheRead": 1000,
                "cacheWrite": 0
            },
            {
                "day": "2026-08-02",
                "input": 3000,
                "output": 1500,
                "cost": 0.30,
                "cacheRead": 0,
                "cacheWrite": 0
            }
        ]
    });

    // 首次导入
    let imported_first = db.import_legacy_usage_snapshot(&legacy_json).unwrap();
    assert!(imported_first, "首次导入必须返回 true");

    let conn = db.conn.lock().unwrap();
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM usage_records;", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 2, "两行数据必须入库");
    drop(conn);

    // 二次导入（幂等跳过）
    let imported_second = db.import_legacy_usage_snapshot(&legacy_json).unwrap();
    assert!(!imported_second, "二次导入必须返回 false（幂等跳过）");

    let conn2 = db.conn.lock().unwrap();
    let count2: i64 = conn2
        .query_row("SELECT COUNT(*) FROM usage_records;", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count2, 2, "行数保持不变");
}

#[test]
fn high_concurrency_insertions() {
    let db = LocalDb::open_in_memory().unwrap();
    let mut handles = Vec::new();

    for t in 0..10 {
        let db_clone = db.clone();
        let handle = std::thread::spawn(move || {
            for i in 0..20 {
                db_clone
                    .insert_usage_record(InsertUsageRecordInput {
                        session_id: format!("sess-{t}"),
                        run_id: Some(format!("run-{t}-{i}")),
                        project_name: "conex-bench".to_string(),
                        model: "deepseek-v4-flash".to_string(),
                        provider: "deepseek".to_string(),
                        prompt_tokens: 100,
                        completion_tokens: 50,
                        cache_read_tokens: 10,
                        cache_write_tokens: 0,
                        cost_cny: 0.01,
                        cost_usd: 0.0014,
                        timestamp: 1700000000000 + (t * 20 + i) as i64 * 1000,
                    })
                    .expect("并发写入绝不可发生锁毒化或死锁");
            }
        });
        handles.push(handle);
    }

    for h in handles {
        h.join().unwrap();
    }

    let conn = db.conn.lock().unwrap();
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM usage_records;", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 200, "10 个线程每线程 20 条必须精确达到 200 条记录");
}
