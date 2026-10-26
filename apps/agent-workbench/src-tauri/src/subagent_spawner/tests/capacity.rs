use std::sync::atomic::Ordering;
use std::sync::Arc;

use agent_tools::tools::subagent::{
    RecursionGuardRejection, SubagentSpawnError, SubagentSpawnRequest, SubagentSpawner,
    SubagentState, TaskType,
};

use super::{request, setup_main_run, test_rig, GateLauncher};
use crate::subagent_spawner::types::{SubagentRunConfig, SubagentRunLauncher};

/// 兄弟并发上限包含本次请求：已有 15 个时第 16 个可发起，第 17 个拒绝。
#[tokio::test]
async fn spawn_siblings_exceeded() {
    let (spawner, _, db, _, _) = test_rig();
    setup_main_run(&spawner);
    // 预置 15 个未终态兄弟，再发起第 16 个。
    for i in 0..15 {
        let mut req = request(&format!("任务 {i}"), None);
        req.parent_run_id = Some("run-main".to_string());
        let _ = spawner.spawn(&req).await.expect("前 16 个应成功");
    }
    let sixteenth = spawner
        .spawn(&request("第 16 个", None))
        .await
        .expect("已有 15 个时第 16 个应放行");
    let _ = sixteenth;
    // 第 17 个：已有 16 + 本次 1 = 17 > maxSiblings=16 → 拒绝（零 run）
    let err = spawner
        .spawn(&request("第 17 个", None))
        .await
        .expect_err("兄弟并发超限必须拒绝");
    match &err {
        SubagentSpawnError::GuardRejected(rejection) => {
            assert!(matches!(
                rejection,
                RecursionGuardRejection::SiblingsExceeded {
                    current: 17,
                    max: 16
                }
            ));
        }
        other => panic!("必须为 GuardRejected(SiblingsExceeded)，实际 {other:?}"),
    }
    assert_eq!(
        db.load_session_agents("sess-main").unwrap().len(),
        16,
        "拒绝零 run"
    );
}

/// 全局并发上限包含本次请求：已有 15 个时第 16 个可发起，第 17 个拒绝。
#[tokio::test]
async fn spawn_concurrent_exceeded() {
    let (spawner, _, db, _, _) = test_rig();
    // 15 个并发子代理（不同父 run 也可计数——全局预算）
    for i in 0..15 {
        let mut req = request(&format!("任务 {i}"), None);
        req.parent_run_id = Some(format!("run-{i}"));
        let _ = spawner.spawn(&req).await.expect("预算内应成功");
    }
    let sixteenth = spawner
        .spawn(&request("第 16 个", None))
        .await
        .expect("已有 15 个时第 16 个应放行");
    let _ = sixteenth;
    // 第 17 个：已有 16 + 本次 1 = 17 > 16 → 拒绝（零 run）
    let err = spawner
        .spawn(&request("第 17 个", None))
        .await
        .expect_err("全局并发超限必须拒绝");
    assert!(matches!(
        err,
        SubagentSpawnError::GuardRejected(RecursionGuardRejection::ConcurrentExceeded {
            current: 17,
            max: 16
        })
    ));
    assert_eq!(
        db.load_session_agents("sess-main").unwrap().len(),
        16,
        "拒绝零 run"
    );
}

/// 17 个并发单发共享一个容量锁：首 16 个停在 launcher 内，第 17 个拒绝。
#[tokio::test]
async fn concurrent_spawn_reserves_capacity_before_launch() {
    let (spawner, _, db, stream, queue) = test_rig();
    let gate = Arc::new(GateLauncher::new());
    spawner.init(
        Some(Arc::clone(&gate) as Arc<dyn SubagentRunLauncher>),
        Some(db.clone()),
        Some(stream),
        Some(queue),
    );
    setup_main_run(&spawner);

    let tasks: Vec<_> = (0..17)
        .map(|index| {
            let spawner = Arc::clone(&spawner);
            tokio::spawn(async move {
                let mut req = request(&format!("并发任务 {index}"), None);
                req.parent_run_id = Some(format!("parallel-parent-{index}"));
                spawner.spawn(&req).await
            })
        })
        .collect();

    let arrivals = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        gate.started.acquire_many(16),
    )
    .await
    .expect("16 个 launcher 应到达 gate")
    .expect("started semaphore remains open");
    arrivals.forget();
    gate.resume(17);

    let mut succeeded = 0;
    let mut rejected = 0;
    for task in tasks {
        match task.await.expect("spawn task should not panic") {
            Ok(_) => succeeded += 1,
            Err(SubagentSpawnError::GuardRejected(
                RecursionGuardRejection::ConcurrentExceeded {
                    current: 17,
                    max: 16,
                },
            )) => rejected += 1,
            Err(error) => panic!("unexpected spawn result: {error:?}"),
        }
    }
    assert_eq!(gate.launches.load(Ordering::SeqCst), 16);
    assert_eq!(succeeded, 16);
    assert_eq!(rejected, 1);
    assert_eq!(spawner.active_count_for_test(), 16);
    assert_eq!(db.load_session_agents("sess-main").unwrap().len(), 16);
}

/// spawn_many 在第一个 await 前一次预留 N；并发单发不能抢走批次容量。
#[tokio::test]
async fn spawn_many_reserves_all_capacity_before_first_launch() {
    let (spawner, _, db, stream, queue) = test_rig();
    let gate = Arc::new(GateLauncher::new());
    spawner.init(
        Some(Arc::clone(&gate) as Arc<dyn SubagentRunLauncher>),
        Some(db.clone()),
        Some(stream),
        Some(queue),
    );
    setup_main_run(&spawner);

    let requests: Vec<_> = (0..16)
        .map(|index| request(&format!("批量任务 {index}"), None))
        .collect();
    let batch_spawner = Arc::clone(&spawner);
    let batch = tokio::spawn(async move { batch_spawner.spawn_many(&requests).await });

    tokio::time::timeout(std::time::Duration::from_secs(3), gate.started.acquire())
        .await
        .expect("批量的首个 launcher 应到达 gate")
        .expect("started semaphore remains open")
        .forget();

    assert_eq!(spawner.active_count_for_test(), 16);
    let err = spawner
        .spawn(&request("竞争单发", None))
        .await
        .expect_err("批量已原子预留全部容量，单发必须拒绝");
    assert!(matches!(
        err,
        SubagentSpawnError::GuardRejected(RecursionGuardRejection::SiblingsExceeded {
            current: 17,
            max: 16
        })
    ));
    assert_eq!(gate.launches.load(Ordering::SeqCst), 1);
    assert_eq!(db.load_session_agents("sess-main").unwrap().len(), 1);

    gate.resume(16);
    // 批量按请求顺序逐条启动；每项还要完成落库和 started ack。30 秒是全量并发测试下
    // 16 次串行收尾的完成窗口，不是性能 SLA。
    let results = tokio::time::timeout(std::time::Duration::from_secs(30), batch)
        .await
        .expect("16 项顺序启动、落库和 started ack 应在测试窗口内完成")
        .expect("batch task should not panic")
        .expect("16 个容量内任务应成功");
    assert_eq!(results.len(), 16);
    assert_eq!(gate.launches.load(Ordering::SeqCst), 16);
    assert_eq!(spawner.active_count_for_test(), 16);
    assert_eq!(db.load_session_agents("sess-main").unwrap().len(), 16);
}

// ── 批量派发（T-D-06：前瞻快照统一守卫原子语义）───────────────

#[tokio::test]
async fn spawn_many_three_tasks_all_launched() {
    let (spawner, launcher, db, _, _) = test_rig();
    setup_main_run(&spawner);
    let reqs: Vec<SubagentSpawnRequest> = (0..3)
        .map(|i| {
            let mut req = request(&format!("批量任务 {i}"), Some(TaskType::Review));
            req.parent_run_id = None; // 工具批量路径：按会话解析
            req
        })
        .collect();

    let results = spawner.spawn_many(&reqs).await.expect("批量派发应成功");
    assert_eq!(results.len(), 3);
    // 结果顺序与入参一致 + id 唯一
    let ids: Vec<&str> = results.iter().map(|r| r.subagent_id.as_str()).collect();
    assert!(ids[0] != ids[1] && ids[1] != ids[2]);
    // 全部落库（3 行）+ 启动 3 次（配置按条携带）
    assert_eq!(db.load_session_agents("sess-main").unwrap().len(), 3);
    assert_eq!(launcher.launches().len(), 3);
    for launch in launcher.launches() {
        assert_eq!(launch.parent_run_id.as_deref(), Some("run-main"));
        assert_eq!(
            launch
                .subagent_config
                .as_ref()
                .unwrap()
                .task_type
                .as_deref(),
            Some("review")
        );
    }
}

/// 批量守卫拒绝 → 整体失败零 run（session_agents 无新增行）
#[tokio::test]
async fn spawn_many_guard_rejection_zero_run() {
    let (spawner, launcher, db, _, _) = test_rig();
    setup_main_run(&spawner);
    // 预占预算：15 个并发 + 批量 3 个（15+3 = 18 > 16 → 拒绝）
    for i in 0..15 {
        let mut req = request(&format!("任务 {i}"), None);
        req.parent_run_id = Some(format!("run-{i}"));
        let _ = spawner.spawn(&req).await.expect("预算内应成功");
    }
    let before = db.load_session_agents("sess-main").unwrap().len();
    let launches_before = launcher.launches().len();
    let reqs: Vec<SubagentSpawnRequest> = (0..3)
        .map(|i| request(&format!("批量 {i}"), None))
        .collect();
    let err = spawner
        .spawn_many(&reqs)
        .await
        .expect_err("批量超限必须整体失败");
    assert!(matches!(
        err,
        SubagentSpawnError::GuardRejected(RecursionGuardRejection::ConcurrentExceeded { .. })
    ));
    assert_eq!(
        db.load_session_agents("sess-main").unwrap().len(),
        before,
        "零 run：无新增行"
    );
    assert_eq!(
        launcher.launches().len(),
        launches_before,
        "零 run：批量无新增启动（前序单发记录不变）"
    );
}

/// 空批量：成功返回空（不触碰守卫）
#[tokio::test]
async fn spawn_many_empty_returns_empty() {
    let (spawner, _, _, _, _) = test_rig();
    let results = spawner.spawn_many(&[]).await.expect("空批量应成功");
    assert!(results.is_empty());
}

/// 终态后记账释放：再次 spawn 可复用并发预算
#[tokio::test]
async fn terminal_releases_concurrent_budget() {
    let (spawner, _, _, _, _) = test_rig();
    setup_main_run(&spawner);
    let result = spawner
        .spawn(&request("调研", None))
        .await
        .expect("spawn 应成功");
    let cfg = SubagentRunConfig {
        subagent_id: result.subagent_id.clone(),
        subagent_run_id: result.subagent_run_id.clone(),
        parent_session_id: "sess-main".to_string(),
        task_type: None,
        allowed_write_paths: None,
        output_dir: None,
        started_at_ms: 1,
    };
    spawner
        .on_subagent_terminal(&cfg, SubagentState::Failed)
        .await;
    // 兄弟记账释放：同父再 spawn 不触发 SiblingsExceeded
    let again = spawner
        .spawn(&request("再调研", None))
        .await
        .expect("记账释放后应可再派发");
    assert!(again.subagent_id != result.subagent_id);
}
