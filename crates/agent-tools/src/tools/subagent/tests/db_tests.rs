//! `subagent` 落库链路域测试（SR-06a 拆分）：conex-db 落库 / 深度链 / 守卫拒绝零 run。
//!
//! 全部既有测试原样迁移（零删除）；`use super::*` 经父模命名空间取共享替身与门面 re-export。

#![allow(clippy::disallowed_methods)]

use super::*;

use conex_test_utils::TempWorkspace;
use conex_types::error::codes;
use std::path::PathBuf;

#[tokio::test]
async fn spawn_persists_row_with_parent_chain() {
    let ws = TempWorkspace::new("subagent_db");
    let db = conex_db::LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
    db.insert_session("sess-main", "主会话")
        .expect("插入会话失败");
    let spawner = DbSpawner::new(db);

    // 第一层：主会话（深度 0）spawn 直接子代理 → 深度 1
    let result = spawner
        .spawn(&request("任务 A", "sess-main", Some("run-main")))
        .await
        .expect("第一层 spawn 应成功");
    assert_eq!(result.status, SubagentState::Running);

    // 落库断言：parent 链完整 + 深度 1 + 状态 running（非 pending）
    let agents = spawner
        .db
        .load_session_agents("sess-main")
        .expect("读取落库行失败");
    assert_eq!(agents.len(), 1);
    let row = &agents[0];
    assert_eq!(row.id, result.subagent_id);
    assert_eq!(row.subagent_run_id, result.subagent_run_id);
    assert_eq!(row.parent_session_id, "sess-main");
    assert_eq!(row.parent_run_id, "run-main");
    assert_eq!(row.depth, Some(1), "第一层深度 = 1");
    assert_eq!(row.status, "running", "pending 首写即 running");
    assert_ne!(row.status, "pending", "落库面不得出现 pending");
    assert!(is_db_status_allowed(&row.status));
}

#[tokio::test]
async fn spawn_persists_task_type_columns_and_reads_back() {
    // T-D-07 落库链路：task_type / display_label / allowed_write_paths
    // 随 spawn 落库并经 load_session_agents 读回（model_override 扩展点
    // 预留不落库——SessionAgent 无该字段，类型级保证）
    let ws = TempWorkspace::new("subagent_ext_db");
    let db = conex_db::LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
    db.insert_session("sess-main", "主会话")
        .expect("插入会话失败");
    let spawner = DbSpawner::new(db.clone());

    let mut req = request("实现任务", "sess-main", Some("run-main"));
    req.task_type = Some(TaskType::Implementation);
    req.allowed_write_paths = Some(vec![PathBuf::from("crates/foo")]);
    req.display_label = Some("实现工程师".to_string());
    req.model_override = None;
    let result = spawner.spawn(&req).await.expect("spawn 应成功");

    // 读回断言：三列与请求一致
    let agents = db.load_session_agents("sess-main").expect("读取落库行失败");
    assert_eq!(agents.len(), 1);
    let row = &agents[0];
    assert_eq!(
        row.task_type.as_deref(),
        Some("implementation"),
        "task_type 落库"
    );
    assert_eq!(
        row.display_label.as_deref(),
        Some("实现工程师"),
        "display_label 落库"
    );
    assert_eq!(
        row.allowed_write_paths_json.as_deref(),
        Some(r#"["crates/foo"]"#),
        "allowed_write_paths 以 JSON 数组落库"
    );
    assert_eq!(row.id, result.subagent_id);
}

#[tokio::test]
async fn spawn_depth_counts_along_parent_chain() {
    let ws = TempWorkspace::new("subagent_depth");
    let db = conex_db::LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
    db.insert_session("sess-main", "主会话")
        .expect("插入会话失败");
    let spawner = DbSpawner::new(db.clone());

    // 主会话（深度 0）→ 子代理（新会话深度 1，落 sess-main）：通过
    let child = spawner
        .spawn(&request("任务 A", "sess-main", Some("run-main")))
        .await
        .expect("第一层 spawn 应成功");
    assert!(
        child.subagent_run_id.starts_with("sub-run-1-"),
        "第一层 run id 应带深度 1 前缀（测试记账推导）"
    );
    let rows = spawner
        .db
        .load_session_agents("sess-main")
        .expect("读取第一层落库行失败");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].depth, Some(1), "主 Agent 直接子代理深度 = 1");
    assert_eq!(rows[0].parent_run_id, "run-main", "parent 链指向父 run");
    assert_eq!(
        rows[0].parent_session_id, "sess-main",
        "parent 链指向父会话"
    );

    // 子代理（子会话中，自身深度 1）→ 孙代理（新会话深度 2）：T-D-02
    // 嵌套禁止，专用变体拒绝且零 run（守卫层兜底：工具面外也无法绕过）
    db.insert_session(&child.session_id, "子会话")
        .expect("插入子会话失败");
    let err = spawner
        .spawn(&request(
            "任务 B",
            &child.session_id,
            Some(&child.subagent_run_id),
        ))
        .await
        .unwrap_err();
    assert_eq!(
        err,
        SubagentSpawnError::NestingDenied(RecursionGuardRejection::NestingDenied {
            current: 2,
            max: 1
        }),
        "子 Agent 发起 spawn 必须返回 NestingDenied（T-D-02 验收）"
    );
    assert_eq!(err.code(), codes::SUBAGENT_NESTING_DENIED);
    assert!(
        err.message().contains("所有子 Agent 由主 Agent 分配"),
        "文案必须带「所有子 Agent 由主 Agent 分配」指引"
    );
    // 零 run 语义：被拒后子会话落库行数为 0
    let rows = spawner
        .db
        .load_session_agents(&child.session_id)
        .expect("读取第二层落库行失败");
    assert_eq!(rows.len(), 0, "嵌套拒绝不得产生任何 run 行");
}

#[tokio::test]
async fn guard_rejection_writes_no_row() {
    let ws = TempWorkspace::new("subagent_guard_db");
    let db = conex_db::LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
    db.insert_session("sess-main", "主会话")
        .expect("插入会话失败");
    let spawner = DbSpawner::new(db);

    // 顶满并发后第 18 次 spawn 必须被拒（同父 run 下 17 兄弟已超
    // maxSiblings=16，判定序：深度 → 兄弟 → 并发，兄弟先命中）
    for i in 0..17 {
        spawner
            .spawn(&request(
                &format!("任务 {i}"),
                "sess-main",
                Some("run-main"),
            ))
            .await
            .expect("并发预算内 spawn 应成功");
    }
    let rejected = spawner
        .spawn(&request("任务 17", "sess-main", Some("run-main")))
        .await
        .unwrap_err();
    assert_eq!(
        rejected,
        SubagentSpawnError::GuardRejected(RecursionGuardRejection::SiblingsExceeded {
            current: 17,
            max: 16
        }),
        "同父 17 兄弟超 maxSiblings=16，兄弟并发判定先于全局并发命中"
    );
    // 零 run 语义：被拒后落库行数不变（17 行，无第 18 行）
    let agents = spawner
        .db
        .load_session_agents("sess-main")
        .expect("读取落库行失败");
    assert_eq!(agents.len(), 17, "超限拒绝不得产生任何 run 行");
}

#[tokio::test]
async fn guard_depth_rejection_writes_no_row() {
    let ws = TempWorkspace::new("subagent_guard_depth");
    let db = conex_db::LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
    db.insert_session("sess-main", "主会话")
        .expect("插入会话失败");
    let spawner = DbSpawner::new(db.clone());

    // maxDepth=1 下链长上限 = 1：第 1 层（深度 1）成功，第 2 层（深度 2）
    // 嵌套禁止快速失败（判定序：嵌套 → 深度 → 兄弟 → 并发）
    let mut parent_session = "sess-main".to_string();
    let mut parent_run: Option<String> = Some("run-main".to_string());
    for level in 1..=2 {
        db.insert_session(&parent_session, "会话").ok();
        let result = spawner
            .spawn(&request(
                &format!("任务 L{level}"),
                &parent_session,
                parent_run.as_deref(),
            ))
            .await;
        match level {
            1 => {
                let result = result.expect("第一层 spawn 应成功");
                parent_session = result.session_id.clone();
                parent_run = Some(result.subagent_run_id.clone());
            }
            2 => {
                let err = result.unwrap_err();
                assert_eq!(
                    err,
                    SubagentSpawnError::NestingDenied(RecursionGuardRejection::NestingDenied {
                        current: 2,
                        max: 1
                    }),
                    "第 2 层（新会话深度 2 > maxDepth=1）必须快速失败"
                );
            }
            _ => unreachable!(),
        }
    }
    // 零 run 语义：被拒层不落库（子会话中 0 行）
    let rows = spawner
        .db
        .load_session_agents(&parent_session)
        .expect("读取第二层落库行失败");
    assert_eq!(rows.len(), 0, "嵌套拒绝不得产生任何 run 行");
}
