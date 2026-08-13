//! `subagent` 批量原子性与审批挂靠域测试（SR-06a 拆分）：spawn_many 前瞻守卫原子性 / 审批通道挂靠。
//!
//! 全部既有测试原样迁移（零删除）；`use super::*` 经父模命名空间取共享替身与门面 re-export。

#![allow(clippy::disallowed_methods)]

use super::*;

use crate::context::{create_mock_tool_context, AskCallback, ToolContext};
use crate::definition::Tool;
use crate::tools::shell::ShellCommandTool;
use conex_test_utils::TempWorkspace;

// ── T-D-06：批量派发原子性（spawn_many 前瞻快照统一守卫）────────

#[tokio::test]
async fn spawn_many_three_tasks_all_persist_unique_ids() {
    // 一次派发 3 个任务全部成功：返回 3 条唯一 id（subagentId /
    // subagentRunId 两两不重复），session_agents 新增 3 行，顺序与
    // 入参一致（T-D-06 验收 1）
    let ws = TempWorkspace::new("subagent_many_ok");
    let db = conex_db::LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
    db.insert_session("sess-main", "主会话").expect("插入会话失败");
    let spawner = DbSpawner::new(db.clone());
    let reqs = vec![
        request("任务 A", "sess-main", Some("run-main")),
        request("任务 B", "sess-main", Some("run-main")),
        request("任务 C", "sess-main", Some("run-main")),
    ];
    let results = spawner.spawn_many(&reqs).await.expect("批量派发应成功");
    assert_eq!(results.len(), 3);
    let mut ids: Vec<&str> = results.iter().map(|r| r.subagent_id.as_str()).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 3, "3 条 subagentId 必须唯一");
    for (i, result) in results.iter().enumerate() {
        assert_eq!(result.status, SubagentState::Running);
        assert_eq!(result.subagent_id, format!("sub-1-{i}"), "深度 1 首批发 id 序号 {i}");
        assert_eq!(result.subagent_run_id, format!("sub-run-1-{i}"));
    }
    let agents = db
        .load_session_agents("sess-main")
        .expect("读取落库行失败");
    assert_eq!(agents.len(), 3, "3 个任务全部落库");
    let mut run_ids: Vec<&str> = agents.iter().map(|a| a.subagent_run_id.as_str()).collect();
    run_ids.sort();
    run_ids.dedup();
    assert_eq!(run_ids.len(), 3, "3 条 subagentRunId 必须唯一");
}

#[tokio::test]
async fn spawn_many_guard_rejection_concurrent_zero_run() {
    // N 个任务任一触发守卫拒绝 → 整体失败零 run：并发已顶满 16
    //（A:5 + B:5 + C:6，各父兄弟 ≤ maxSiblings=16），再批量派发 1 个 →
    // 前瞻预加 16+1=17 > maxConcurrent=16 → ConcurrentExceeded，
    // session_agents 无新增行（T-D-06 验收 2）
    let ws = TempWorkspace::new("subagent_many_conc");
    let db = conex_db::LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
    db.insert_session("sess-main", "主会话").expect("插入会话失败");
    let spawner = DbSpawner::new(db.clone());
    for (parent_run, count) in [("run-a", 5), ("run-b", 5), ("run-c", 6)] {
        for i in 0..count {
            spawner
                .spawn(&request(
                    &format!("任务 {parent_run}-{i}"),
                    "sess-main",
                    Some(parent_run),
                ))
                .await
                .expect("并发预算内 spawn 应成功");
        }
    }
    assert_eq!(spawner.active_concurrent.load(Ordering::SeqCst), 16);
    let err = spawner
        .spawn_many(&[request("任务 17", "sess-main", Some("run-d"))])
        .await
        .unwrap_err();
    assert_eq!(
        err,
        SubagentSpawnError::GuardRejected(RecursionGuardRejection::ConcurrentExceeded {
            current: 17,
            max: 16
        }),
        "前瞻预加 16+1=17 超 maxConcurrent=16，整体拒绝"
    );
    // 零 run：落库行数不变（16 行，无第 17 行）
    let agents = spawner
        .db
        .load_session_agents("sess-main")
        .expect("读取落库行失败");
    assert_eq!(agents.len(), 16, "批量守卫拒绝不得产生任何 run 行");
}

#[tokio::test]
async fn spawn_many_guard_rejection_siblings_zero_run() {
    // 批量前瞻预加命中兄弟并发：同父已有 16 兄弟，批量 2 个 →
    // 16+2=18 > maxSiblings=16 → SiblingsExceeded（判定序先于全局并发），
    // 整体失败零 run
    let ws = TempWorkspace::new("subagent_many_sib");
    let db = conex_db::LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
    db.insert_session("sess-main", "主会话").expect("插入会话失败");
    let spawner = DbSpawner::new(db.clone());
    for i in 0..16 {
        spawner
            .spawn(&request(&format!("任务 {i}"), "sess-main", Some("run-main")))
            .await
            .expect("兄弟预算内 spawn 应成功");
    }
    let err = spawner
        .spawn_many(&[
            request("批量 A", "sess-main", Some("run-main")),
            request("批量 B", "sess-main", Some("run-main")),
        ])
        .await
        .unwrap_err();
    assert_eq!(
        err,
        SubagentSpawnError::GuardRejected(RecursionGuardRejection::SiblingsExceeded {
            current: 18,
            max: 16
        }),
        "前瞻预加 16+2=18 超 maxSiblings=16，整体拒绝"
    );
    let agents = spawner
        .db
        .load_session_agents("sess-main")
        .expect("读取落库行失败");
    assert_eq!(agents.len(), 16, "批量拒绝不得产生任何 run 行");
}

#[tokio::test]
async fn spawn_many_boundary_concurrent_16_allowed() {
    // 边界允许侧：并发 13（A:5 + B:8）时批量 3 个 → 前瞻 13+3=16 =
    // maxConcurrent=16 → 全部成功落库；第 17 个并发才被拒（拒绝侧
    // 见 spawn_many_guard_rejection_concurrent_zero_run）
    let ws = TempWorkspace::new("subagent_many_bound");
    let db = conex_db::LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
    db.insert_session("sess-main", "主会话").expect("插入会话失败");
    let spawner = DbSpawner::new(db.clone());
    for (parent_run, count) in [("run-a", 5), ("run-b", 8)] {
        for i in 0..count {
            spawner
                .spawn(&request(
                    &format!("任务 {parent_run}-{i}"),
                    "sess-main",
                    Some(parent_run),
                ))
                .await
                .expect("并发预算内 spawn 应成功");
        }
    }
    let results = spawner
        .spawn_many(&[
            request("批量 A", "sess-main", Some("run-c")),
            request("批量 B", "sess-main", Some("run-c")),
            request("批量 C", "sess-main", Some("run-c")),
        ])
        .await
        .expect("前瞻 13+3=16 恰在上限内应成功");
    assert_eq!(results.len(), 3);
    assert_eq!(spawner.active_concurrent.load(Ordering::SeqCst), 16);
    let agents = spawner
        .db
        .load_session_agents("sess-main")
        .expect("读取落库行失败");
    assert_eq!(agents.len(), 16, "边界 16 个并发全部落库");
}

#[tokio::test]
async fn spawn_many_empty_input_returns_empty() {
    // 空批量防御：成功返回空结果，零落库
    let ws = TempWorkspace::new("subagent_many_empty");
    let db = conex_db::LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
    db.insert_session("sess-main", "主会话").expect("插入会话失败");
    let spawner = DbSpawner::new(db);
    let results = spawner.spawn_many(&[]).await.expect("空批量应成功返回空");
    assert!(results.is_empty());
    assert_eq!(
        spawner
            .db
            .load_session_agents("sess-main")
            .expect("读取落库行失败")
            .len(),
        0
    );
}

#[tokio::test]
async fn tool_batch_three_tasks_unique_ids_via_db_spawner() {
    // 工具路径 + 测试域原子 spawner 全链路：一次派发 3 个任务全部
    // 成功，返回 3 条唯一 id，session_agents 新增 3 行（T-D-06 验收 1）
    let ws = TempWorkspace::new("subagent_many_tool");
    let db = conex_db::LocalDb::open(ws.path().join("sessions.db")).expect("打开测试库失败");
    db.insert_session("sess-main", "主会话").expect("插入会话失败");
    let tool = RunSubagentTool::with_spawner(Some(Arc::new(DbSpawner::new(db.clone()))));
    let ctx = ToolContext {
        session_id: "sess-main".to_string(),
        ..create_mock_tool_context()
    };
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({
                "tasks": [
                    { "prompt": "任务 A", "role": "researcher" },
                    { "prompt": "任务 B", "capabilityMode": "read-only" },
                    { "prompt": "任务 C" }
                ]
            }),
        )
        .await
        .expect("批量派发应成功");
    let results = out["results"].as_array().expect("results 必须是数组");
    assert_eq!(results.len(), 3);
    let mut ids: Vec<String> = results
        .iter()
        .map(|r| {
            r["subagentId"]
                .as_str()
                .expect("subagentId 必须存在")
                .to_string()
        })
        .collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 3, "3 条 subagentId 必须唯一");
    let agents = db
        .load_session_agents("sess-main")
        .expect("读取落库行失败");
    assert_eq!(agents.len(), 3, "3 个任务全部落库");
}

// ── 审批通道挂靠（I3 原样挂靠，写类调用产生审批记录）──────────

#[tokio::test]
async fn subagent_write_ops_route_through_ask_channel() {
    // 子代理 run 的写类调用（shell_command 需审批形态）经 ctx.ask
    // 接线面（引擎侧由 ApprovalChannel → ApprovalGate 实现）产生审批
    // 请求；放行后继续执行（命令失败非致命，本测试只断言审批记录）。
    // 审计修复（T-3 预检高严重度）：原用例在 mock 上下文（cwd 默认
    // 仓库根）真实执行 `git push --force origin main`——存在真实强推
    // 与网络依赖隐患；改为在**临时目录**执行同形态写类命令：临时目录
    // 非 git 仓库，命令必然快速失败但审批挂靠语义不变（测试只断言
    // 审批记录与 exitCode 存在，不关心成败）。
    let recorder = RecordingAskChannel::allowing();
    let mut ctx = create_mock_tool_context();
    let probe_dir = std::env::temp_dir().join(format!(
        "ask_probe_{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&probe_dir).ok();
    ctx.workspace_root = probe_dir;
    ctx.ask = Some(Arc::new(recorder.clone()) as AskCallback);
    let tool = ShellCommandTool::new(30_000, 200_000, None);
    let command = "git push --force origin main";
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({ "command": command }),
        )
        .await
        .expect("审批放行后命令执行不应返回工具错误（非致命）");
    let calls = recorder.calls();
    assert_eq!(calls.len(), 1, "写类调用必须产生一次审批请求");
    assert_eq!(calls[0].0, "shell_command");
    assert_eq!(calls[0].1["command"], command);
    assert!(out.get("exitCode").is_some(), "命令已执行（审批放行语义）");
}

#[tokio::test]
async fn ask_unwired_returns_requires_approval() {
    // 审批通道未接线（ask=None）：返回 tool.requires_approval 结构化
    // 错误——执行器按 ApprovalRequired 分类透传（零打扰兜底，C3 语义）
    let ctx = create_mock_tool_context();
    let tool = ShellCommandTool::new(30_000, 200_000, None);
    let err = tool
        .execute(
            &ctx,
            serde_json::json!({ "command": "git push --force origin main" }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.requires_approval");
}
