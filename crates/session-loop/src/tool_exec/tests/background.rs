//! BG2 · 工具调用超时转后台——执行器三方竞速与后台移交测试
//!
//! 假宿主（内存实现 [ToolBackgroundHost] 契约）+ 虚拟时钟断言：
//! 阈值到点占位收口且后续轮次继续、落定结果与直执同构、permit
//! 释放不饿死同批工具、detach 前 abort 仍 Cancelled、detach 后
//! 越过 60s 与任意时长不杀执行、在途去重、排队等获槽、资格外 /
//! 未装配宿主时行为与 BG2 之前一致。
use super::super::*;
use super::fixture::*;
use crate::safe_point::AbortSignal;
use crate::tool_events::{ToolBackgroundAdmission, ToolBackgroundHost, ToolBackgroundRegistration};
use agent_tools::context::AbortToken;
use agent_tools::definition::{Tool, ToolDefinition, ToolError};
use conex_types::tool::ToolConcurrency;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

// ── 假宿主 ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FakeState {
    Queued,
    Running,
    Settled,
    Cancelled,
}

struct FakeEntry {
    session_id: String,
    tool_name: String,
    args_digest: String,
    state: FakeState,
    token: AbortToken,
    result: Option<ClassifiedToolResult>,
}

/// 内存假宿主：语义与注册表对齐（登记幂等 / 在途扫描 / 子令牌 /
/// 落定先落定者胜 / wait_admitted 的 enable-then-check 唤醒口径）
struct FakeHost {
    entries: Mutex<HashMap<String, FakeEntry>>,
    changed: tokio::sync::Notify,
    /// true 时新登记一律排队（队列测试用；admit 手动放行）
    force_queue: AtomicBool,
}

impl std::fmt::Debug for FakeHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("FakeHost")
    }
}

impl FakeHost {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            entries: Mutex::new(HashMap::new()),
            changed: tokio::sync::Notify::new(),
            force_queue: AtomicBool::new(false),
        })
    }

    fn state(&self, call_id: &str) -> Option<FakeState> {
        self.entries.lock().unwrap().get(call_id).map(|e| e.state)
    }

    fn result(&self, call_id: &str) -> Option<ClassifiedToolResult> {
        self.entries
            .lock()
            .unwrap()
            .get(call_id)
            .and_then(|e| e.result.clone())
    }

    fn is_empty(&self) -> bool {
        self.entries.lock().unwrap().is_empty()
    }

    /// 测试放行：排队条目获槽（注册表 settle 后自动准入的替身）
    fn admit(&self, call_id: &str) {
        {
            let mut entries = self.entries.lock().unwrap();
            if let Some(e) = entries.get_mut(call_id) {
                if e.state == FakeState::Queued {
                    e.state = FakeState::Running;
                }
            }
        }
        self.changed.notify_waiters();
    }

    /// 测试取消：条目终态 + 子令牌中止（注册表 cancel 的替身）
    fn cancel(&self, call_id: &str) {
        {
            let mut entries = self.entries.lock().unwrap();
            if let Some(e) = entries.get_mut(call_id) {
                e.state = FakeState::Cancelled;
                e.token.abort();
            }
        }
        self.changed.notify_waiters();
    }
}

#[async_trait::async_trait]
impl ToolBackgroundHost for FakeHost {
    fn find_inflight(
        &self,
        session_id: &str,
        tool_name: &str,
        args_digest: &str,
    ) -> Option<String> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .find(|(_, e)| {
                matches!(e.state, FakeState::Queued | FakeState::Running)
                    && e.session_id == session_id
                    && e.tool_name == tool_name
                    && e.args_digest == args_digest
            })
            .map(|(k, _)| k.clone())
    }

    fn inflight_elapsed_ms(&self, call_id: &str, _now_ms: u64) -> Option<u64> {
        self.entries
            .lock()
            .unwrap()
            .get(call_id)
            .filter(|e| matches!(e.state, FakeState::Queued | FakeState::Running))
            .map(|_| 0)
    }

    fn register(&self, task: ToolBackgroundRegistration) -> ToolBackgroundAdmission {
        let outcome = {
            let mut entries = self.entries.lock().unwrap();
            if entries.contains_key(&task.call_id) {
                ToolBackgroundAdmission::AlreadyExists
            } else {
                let queued = self.force_queue.load(Ordering::SeqCst);
                entries.insert(
                    task.call_id.clone(),
                    FakeEntry {
                        session_id: task.session_id.clone(),
                        tool_name: task.tool_name.clone(),
                        args_digest: task.args_digest.clone(),
                        state: if queued {
                            FakeState::Queued
                        } else {
                            FakeState::Running
                        },
                        token: AbortToken::child_of(&task.parent_token),
                        result: None,
                    },
                );
                if queued {
                    ToolBackgroundAdmission::Queued
                } else {
                    ToolBackgroundAdmission::Admitted
                }
            }
        };
        self.changed.notify_waiters();
        outcome
    }

    fn entry_token(&self, call_id: &str) -> Option<AbortToken> {
        self.entries
            .lock()
            .unwrap()
            .get(call_id)
            .filter(|e| matches!(e.state, FakeState::Queued | FakeState::Running))
            .map(|e| e.token.clone())
    }

    async fn wait_admitted(&self, call_id: &str) -> bool {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let entries = self.entries.lock().unwrap();
                match entries.get(call_id) {
                    None => return false,
                    Some(e) => match e.state {
                        FakeState::Running => return true,
                        FakeState::Queued => {}
                        _ => return false,
                    },
                }
            }
            notified.await;
        }
    }

    fn attach_handle(&self, call_id: &str, _handle: tokio::task::JoinHandle<()>) -> bool {
        // 假宿主不持有任务句柄（包装任务自管理）；仅 Running 视为挂入成功
        self.state(call_id) == Some(FakeState::Running)
    }

    fn settle(&self, call_id: &str, result: ClassifiedToolResult, _now_ms: u64) -> bool {
        let settled = {
            let mut entries = self.entries.lock().unwrap();
            match entries.get_mut(call_id) {
                Some(e) if e.state == FakeState::Running => {
                    e.state = FakeState::Settled;
                    e.result = Some(result);
                    true
                }
                _ => false,
            }
        };
        if settled {
            self.changed.notify_waiters();
        }
        settled
    }
}

// ── 资格慢工具 ─────────────────────────────────────────────────

/// BG2 资格慢工具：定义阈值可配，执行计数 + 入参回显（同构断言源）
struct BgSlowTool {
    def: ToolDefinition,
    sleep_ms: u64,
    started: Arc<AtomicUsize>,
    finished: Arc<AtomicUsize>,
}

impl BgSlowTool {
    fn new(
        name: &str,
        threshold: Option<u32>,
        sleep_ms: u64,
    ) -> (Arc<Self>, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let started = Arc::new(AtomicUsize::new(0));
        let finished = Arc::new(AtomicUsize::new(0));
        let tool = Arc::new(Self {
            def: ToolDefinition {
                name: name.to_string(),
                description: "bg slow tool".to_string(),
                input_schema: serde_json::json!({ "type": "object" }),
                dangerous: false,
                fatal_on_error: false,
                background_after_ms: threshold,
            },
            sleep_ms,
            started: Arc::clone(&started),
            finished: Arc::clone(&finished),
        });
        (tool, started, finished)
    }
}

#[async_trait::async_trait]
impl Tool for BgSlowTool {
    fn name(&self) -> &str {
        &self.def.name
    }
    fn definition(&self) -> &ToolDefinition {
        &self.def
    }
    async fn execute(
        &self,
        _ctx: &agent_tools::context::ToolContext,
        args: Value,
    ) -> Result<Value, ToolError> {
        self.started.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(self.sleep_ms)).await;
        self.finished.fetch_add(1, Ordering::SeqCst);
        Ok(serde_json::json!({ "echo": args, "done": true }))
    }
}

/// 虚拟时钟推进后让出调度：包装任务的落定链（唤醒 → 驱动 →
/// 后处理 → settle）需要若干次任务轮转才走完，断言前统一冲刷。
async fn flush_tasks() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

fn bg_options(host: &Arc<FakeHost>) -> ToolBatchOptions {
    ToolBatchOptions {
        timeout: Duration::from_secs(60),
        tool_background: Some(host.clone() as Arc<dyn ToolBackgroundHost>),
        ..Default::default()
    }
}

fn arg_call(id: &str, name: &str, v: &str) -> ToolBatchCall {
    ToolBatchCall {
        id: id.into(),
        tool_name: name.into(),
        summary: format!("call {name}"),
        input: serde_json::json!({ "v": v }),
        category: conex_types::tool::ToolCategory::Internal,
        concurrency: ToolConcurrency::Sequential,
    }
}

// ── 用例 ───────────────────────────────────────────────────────

/// 阈值到点：本轮占位收口（信封形状 §3.3）、后续轮次照常执行；
/// 后台落定结果与直接执行同构（输出一致）。
#[tokio::test(start_paused = true)]
async fn detach_placeholder_then_settles_isomorphic() {
    let (tool, started, finished) = BgSlowTool::new("bgslow", Some(50), 10_000);
    let host = FakeHost::new();
    let exec = Arc::new(ToolExecutor::new(registry_with(vec![
        tool as Arc<dyn Tool>,
        Arc::new(EchoTool),
    ])));
    let opts = bg_options(&host);
    let calls = vec![call("c1", "bgslow", ToolConcurrency::Sequential)];
    let ctx = exec_ctx();
    let handle = {
        let exec = Arc::clone(&exec);
        let opts = opts.clone();
        tokio::spawn(async move { exec.execute_batch(&calls, &ctx, None, &opts, None).await })
    };
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(60)).await;
    let out = handle.await.unwrap();
    let r = &out.results[0];
    assert!(r.is_ok(), "占位必须是 ok 结果：{:?}", r.error_kind);
    assert!(out.fatal.is_none(), "占位不触发 fatal");
    assert_eq!(r.output["mode"], "background");
    assert_eq!(r.output["callId"], "c1");
    assert_eq!(r.output["toolName"], "bgslow");
    assert!(r.output["elapsedMs"].as_u64().is_some());
    assert!(r.output["note"].as_str().unwrap().contains("tool_task"));
    assert_eq!(started.load(Ordering::SeqCst), 1);
    assert_eq!(finished.load(Ordering::SeqCst), 0);
    assert_eq!(host.state("c1"), Some(FakeState::Running));

    // 后续轮次不被钉住：echo 立即完成（无需推进时钟）
    let calls2 = vec![call("e1", "echo", ToolConcurrency::Sequential)];
    let out2 = exec
        .execute_batch(&calls2, &exec_ctx(), None, &opts, None)
        .await;
    assert!(out2.results[0].is_ok());
    assert_eq!(*out2.results[0].output, serde_json::json!({ "v": "e1" }));

    // 后台落定：结果与直接执行同构
    tokio::time::advance(Duration::from_millis(11_000)).await;
    tokio::task::yield_now().await;
    assert_eq!(host.state("c1"), Some(FakeState::Settled));
    let settled = host.result("c1").expect("落定结果");
    assert!(settled.is_ok());
    assert_eq!(
        *settled.output,
        serde_json::json!({ "echo": { "v": "c1" }, "done": true })
    );
    let (direct_tool, _, _) = BgSlowTool::new("bgslow", Some(50), 10_000);
    let direct_exec = ToolExecutor::new(registry_with(vec![direct_tool as Arc<dyn Tool>]));
    let direct_calls = vec![call("c1", "bgslow", ToolConcurrency::Sequential)];
    let direct_handle = tokio::spawn(async move {
        direct_exec
            .execute_batch(
                &direct_calls,
                &exec_ctx(),
                None,
                &ToolBatchOptions::default(),
                None,
            )
            .await
    });
    tokio::time::advance(Duration::from_millis(11_000)).await;
    let direct = direct_handle.await.unwrap();
    assert_eq!(
        *direct.results[0].output, *settled.output,
        "注册表终态结果必须与直执同构"
    );
}

/// detach 释放 permit：max_parallel=1 时同批 echo 不被慢工具饿死。
#[tokio::test(start_paused = true)]
async fn detach_releases_permit_sibling_not_starved() {
    let (tool, started, _finished) = BgSlowTool::new("bgslow", Some(50), 10_000);
    let host = FakeHost::new();
    let exec = ToolExecutor::new(registry_with(vec![
        tool as Arc<dyn Tool>,
        Arc::new(EchoTool),
    ]));
    let mut opts = bg_options(&host);
    opts.max_parallel = Some(1);
    let calls = vec![
        call("c1", "bgslow", ToolConcurrency::Parallel),
        call("e1", "echo", ToolConcurrency::Parallel),
    ];
    let ctx = exec_ctx();
    let handle =
        tokio::spawn(async move { exec.execute_batch(&calls, &ctx, None, &opts, None).await });
    tokio::task::yield_now().await;
    // 只推进 300ms：批必须在此窗口内整批收口（慢工具若占住 permit，
    // echo 要等 10s，批不可能完成）
    tokio::time::advance(Duration::from_millis(300)).await;
    flush_tasks().await;
    assert!(
        handle.is_finished(),
        "detach 未释放 permit：同批 echo 被慢工具饿死"
    );
    let out = handle.await.unwrap();
    assert_eq!(out.results[0].output["mode"], "background");
    assert!(out.results[1].is_ok());
    assert_eq!(*out.results[1].output, serde_json::json!({ "v": "e1" }));
    assert_eq!(started.load(Ordering::SeqCst), 1);
    tokio::time::advance(Duration::from_millis(11_000)).await;
    flush_tasks().await;
    assert_eq!(host.state("c1"), Some(FakeState::Settled));
}

/// abort 在 detach 前命中：仍按 Cancelled 收口，不登记后台条目。
#[tokio::test(start_paused = true)]
async fn abort_before_detach_still_cancelled() {
    let (tool, _started, finished) = BgSlowTool::new("bgslow", Some(50), 10_000);
    let host = FakeHost::new();
    let exec = ToolExecutor::new(registry_with(vec![tool as Arc<dyn Tool>]));
    let opts = bg_options(&host);
    let signal = AbortSignal::new();
    let calls = vec![call("c1", "bgslow", ToolConcurrency::Sequential)];
    let ctx = exec_ctx();
    let handle = {
        let sig = signal.clone();
        tokio::spawn(async move {
            exec.execute_batch(&calls, &ctx, None, &opts, Some(&sig))
                .await
        })
    };
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(20)).await;
    signal.abort();
    let out = handle.await.unwrap();
    assert_eq!(
        out.results[0].error_kind,
        Some(ToolErrorKind::Cancelled),
        "detach 前 abort 必须走现行 Cancelled 语义"
    );
    assert!(host.is_empty(), "未 detach 不得登记后台条目");
    assert_eq!(finished.load(Ordering::SeqCst), 0);
}

/// detach 后不设时长上限：虚拟时钟越过 60s 硬超时与任意时长
/// （+1h），执行不被杀；取消后条目终态、无结果落定。
#[tokio::test(start_paused = true)]
async fn no_time_cap_after_detach_virtual_clock() {
    let (tool, _started, finished) = BgSlowTool::new("bgslow", Some(50), 7_200_000);
    let host = FakeHost::new();
    let exec = ToolExecutor::new(registry_with(vec![tool as Arc<dyn Tool>]));
    let opts = bg_options(&host); // timeout = 60s（现行硬超时原值）
    let calls = vec![call("c1", "bgslow", ToolConcurrency::Sequential)];
    let ctx = exec_ctx();
    let handle =
        tokio::spawn(async move { exec.execute_batch(&calls, &ctx, None, &opts, None).await });
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(60)).await;
    let out = handle.await.unwrap();
    assert_eq!(out.results[0].output["mode"], "background");
    // 越过 60s：若硬超时臂在 detach 后仍生效，条目此时应已被杀/
    // 落定为 Timeout——断言仍在 Running 且工具体未完成
    tokio::time::advance(Duration::from_millis(61_000)).await;
    tokio::task::yield_now().await;
    assert_eq!(host.state("c1"), Some(FakeState::Running));
    assert_eq!(finished.load(Ordering::SeqCst), 0);
    // 再越过任意时长（+1 小时虚拟时钟）：仍不杀
    tokio::time::advance(Duration::from_millis(3_600_000)).await;
    tokio::task::yield_now().await;
    assert_eq!(host.state("c1"), Some(FakeState::Running));
    assert_eq!(finished.load(Ordering::SeqCst), 0);
    // 终止只能来自取消：条目取消 → 包装落定被拒、结果不落表
    host.cancel("c1");
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(10)).await;
    tokio::task::yield_now().await;
    assert_eq!(host.state("c1"), Some(FakeState::Cancelled));
    assert!(host.result("c1").is_none());
    assert_eq!(finished.load(Ordering::SeqCst), 0);
}

/// 在途去重：同 (session, tool, 入参) 的第二次调用不重复执行，
/// 占位指向在途条目 callId。
#[tokio::test(start_paused = true)]
async fn dedup_hit_points_at_inflight_entry() {
    let (tool, started, _finished) = BgSlowTool::new("bgslow", Some(50), 10_000);
    let host = FakeHost::new();
    let exec = Arc::new(ToolExecutor::new(registry_with(vec![
        tool as Arc<dyn Tool>,
    ])));
    let opts = bg_options(&host);
    let calls = vec![arg_call("c1", "bgslow", "same")];
    let ctx = exec_ctx();
    let handle = {
        let exec = Arc::clone(&exec);
        let calls = calls.clone();
        let ctx = ctx.clone();
        let opts = opts.clone();
        tokio::spawn(async move { exec.execute_batch(&calls, &ctx, None, &opts, None).await })
    };
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(60)).await;
    let out = handle.await.unwrap();
    assert_eq!(out.results[0].output["callId"], "c1");

    // 第二轮同参调用（不同 callId）：立即以去重占位收口
    let calls2 = vec![arg_call("c2", "bgslow", "same")];
    let out2 = exec
        .execute_batch(&calls2, &exec_ctx(), None, &opts, None)
        .await;
    let r2 = &out2.results[0];
    assert!(r2.is_ok());
    assert_eq!(r2.output["mode"], "background");
    assert_eq!(r2.output["callId"], "c1", "占位必须指向在途条目");
    assert!(r2.deduplicated, "去重占位须带 deduplicated 标记");
    assert_eq!(
        started.load(Ordering::SeqCst),
        1,
        "同参在途时不得重复执行工具体"
    );
    tokio::time::advance(Duration::from_millis(11_000)).await;
    flush_tasks().await;
    assert_eq!(host.state("c1"), Some(FakeState::Settled));
}

/// 排队条目：包装任务等获槽期间不驱动执行；获槽后照常落定。
#[tokio::test(start_paused = true)]
async fn queued_unit_waits_for_admission() {
    let (tool, started, finished) = BgSlowTool::new("bgslow", Some(50), 10_000);
    let host = FakeHost::new();
    host.force_queue.store(true, Ordering::SeqCst);
    let exec = ToolExecutor::new(registry_with(vec![tool as Arc<dyn Tool>]));
    let opts = bg_options(&host);
    let calls = vec![call("c1", "bgslow", ToolConcurrency::Sequential)];
    let ctx = exec_ctx();
    let handle =
        tokio::spawn(async move { exec.execute_batch(&calls, &ctx, None, &opts, None).await });
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(60)).await;
    let out = handle.await.unwrap();
    assert_eq!(out.results[0].output["mode"], "background");
    assert_eq!(host.state("c1"), Some(FakeState::Queued));
    // 排队 5s（虚拟）：执行体虽已在环启动（detach = 中途移交），
    // 排队期间不得被继续驱动——完成计数必须停在 0（排队不计时、
    // 更不推进执行）
    tokio::time::advance(Duration::from_millis(5_000)).await;
    flush_tasks().await;
    assert_eq!(started.load(Ordering::SeqCst), 1, "执行体在环内已启动");
    assert_eq!(
        finished.load(Ordering::SeqCst),
        0,
        "排队期间执行单元不得被驱动推进"
    );
    // 放行 → 驱动 → 落定
    host.admit("c1");
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(11_000)).await;
    flush_tasks().await;
    assert_eq!(finished.load(Ordering::SeqCst), 1);
    assert_eq!(host.state("c1"), Some(FakeState::Settled));
    assert!(host.result("c1").unwrap().is_ok());
}

/// 资格外工具：宿主在场也不 detach，按现行硬超时收口。
#[tokio::test(start_paused = true)]
async fn ineligible_tool_never_detaches() {
    let host = FakeHost::new();
    let exec = ToolExecutor::new(registry_with(vec![Arc::new(SlowTool { ms: 500 })]));
    let mut opts = bg_options(&host);
    opts.timeout = Duration::from_millis(50);
    let calls = vec![call("c1", "slow", ToolConcurrency::Sequential)];
    let ctx = exec_ctx();
    let handle =
        tokio::spawn(async move { exec.execute_batch(&calls, &ctx, None, &opts, None).await });
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(100)).await;
    let out = handle.await.unwrap();
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Timeout));
    assert!(host.is_empty());
}

/// 未装配宿主：资格工具也走现行路径（BG2 之前的行为）。
#[tokio::test(start_paused = true)]
async fn eligible_tool_without_host_uses_legacy_timeout() {
    let (tool, started, _finished) = BgSlowTool::new("bgslow", Some(50), 10_000);
    let exec = ToolExecutor::new(registry_with(vec![tool as Arc<dyn Tool>]));
    let opts = ToolBatchOptions {
        timeout: Duration::from_millis(100),
        ..Default::default()
    };
    let calls = vec![call("c1", "bgslow", ToolConcurrency::Sequential)];
    let ctx = exec_ctx();
    let handle =
        tokio::spawn(async move { exec.execute_batch(&calls, &ctx, None, &opts, None).await });
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(200)).await;
    let out = handle.await.unwrap();
    assert_eq!(out.results[0].error_kind, Some(ToolErrorKind::Timeout));
    assert_eq!(started.load(Ordering::SeqCst), 1);
}

/// Some(0) = 声明资格未指定值 → 取批选项全局默认 T。
#[tokio::test(start_paused = true)]
async fn threshold_zero_falls_back_to_global_default() {
    let (tool, _started, _finished) = BgSlowTool::new("bgslow", Some(0), 10_000);
    let host = FakeHost::new();
    let exec = ToolExecutor::new(registry_with(vec![tool as Arc<dyn Tool>]));
    let mut opts = bg_options(&host);
    opts.background_after_default = Duration::from_millis(30);
    let calls = vec![call("c1", "bgslow", ToolConcurrency::Sequential)];
    let ctx = exec_ctx();
    let handle =
        tokio::spawn(async move { exec.execute_batch(&calls, &ctx, None, &opts, None).await });
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(20)).await;
    tokio::task::yield_now().await;
    assert!(
        !handle.is_finished(),
        "默认 T=30ms 未到点不得提前 detach/收口"
    );
    tokio::time::advance(Duration::from_millis(20)).await;
    let out = handle.await.unwrap();
    assert_eq!(out.results[0].output["mode"], "background");
    assert_eq!(host.state("c1"), Some(FakeState::Running));
}
