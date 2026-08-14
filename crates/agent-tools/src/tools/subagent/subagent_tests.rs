//! `subagent` 测试（SR-06a 拆分外置；由父模 `#[path]` 接入，无孤儿）。
//! 全部既有测试原样迁移（零删除）；共享测试替身持有于本文件，子域经 `use super::*` 取用。
//! 子域：tool（入参解析/T-D-07）、batch（批量/C6）、guard（守卫）、filter（防护面）、
//! db（落库链路）、atomic（批量原子性/审批挂靠）。

#![allow(clippy::disallowed_methods)]

use super::*;
use async_trait::async_trait;
use crate::context::{AskChannel, AskDecision};
use crate::definition::ToolError;
use serde_json::Value;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

// ── 测试替身 ──────────────────────────────────────────────────

/// 记录式 spawner：记录请求并按预设结果应答（守卫拒绝 / 成功）
#[derive(Debug)]
struct RecordingSpawner {
    requests: Mutex<Vec<SubagentSpawnRequest>>,
    outcome: Result<SubagentSpawnResult, SubagentSpawnError>,
}

impl RecordingSpawner {
    fn ok() -> Self {
        Self {
            requests: Mutex::new(Vec::new()),
            outcome: Ok(SubagentSpawnResult {
                subagent_id: "sub-1".to_string(),
                subagent_run_id: "sub-run-1".to_string(),
                session_id: "sub-sess-1".to_string(),
                status: SubagentState::Running,
                summary: Some("子代理已启动".to_string()),
                flow_node_id: None,
                display_label: None,
            }),
        }
    }

    fn rejecting(rejection: RecursionGuardRejection) -> Self {
        Self {
            requests: Mutex::new(Vec::new()),
            outcome: Err(SubagentSpawnError::GuardRejected(rejection)),
        }
    }

    /// 嵌套禁止构造：直接产出 [SubagentSpawnError::NestingDenied] 变体
    /// （T-D-02 验收：工具出站映射走专用错误变体 + 专用错误码）
    fn rejecting_nesting(rejection: RecursionGuardRejection) -> Self {
        Self {
            requests: Mutex::new(Vec::new()),
            outcome: Err(SubagentSpawnError::NestingDenied(rejection)),
        }
    }

    fn requests(&self) -> Vec<SubagentSpawnRequest> {
        self.requests.lock().unwrap().clone()
    }
}

#[async_trait]
impl SubagentSpawner for RecordingSpawner {
    async fn spawn(
        &self,
        req: &SubagentSpawnRequest,
    ) -> Result<SubagentSpawnResult, SubagentSpawnError> {
        self.requests.lock().unwrap().push(req.clone());
        let mut result = self.outcome.clone()?;
        // C6 调度器扩展：flow_node_id 回显（引擎侧据此关联依赖图节点）
        result.flow_node_id = req.flow_node_id.clone();
        // T-D-05：display_label 回显（出站信封携带）
        result.display_label = req.display_label.clone();
        Ok(result)
    }
}

/// 记录式审批通道（AskChannel 接线面测试：写类调用产生审批记录）
#[derive(Debug, Clone)]
struct RecordingAskChannel {
    calls: Arc<Mutex<Vec<(String, Value)>>>,
    decision: AskDecision,
}

impl RecordingAskChannel {
    fn allowing() -> Self {
        Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            decision: AskDecision::Allowed,
        }
    }

    fn calls(&self) -> Vec<(String, Value)> {
        self.calls.lock().unwrap().clone()
    }
}

#[async_trait]
impl AskChannel for RecordingAskChannel {
    async fn ask(&self, tool_name: &str, args: &Value) -> Result<AskDecision, ToolError> {
        self.calls
            .lock()
            .unwrap()
            .push((tool_name.to_string(), args.clone()));
        Ok(self.decision.clone())
    }
}


// ── 落库链路（conex-db dev-dependency，I3-S7 同款接线模式）────

/// 测试 spawner：模拟引擎侧实现——守卫快照采集（内存记账）→ 校验 →
/// session_agents 落库 → 返回结果
struct DbSpawner {
    db: conex_db::LocalDb,
    guard: RecursionGuardConfig,
    /// 自增序号（agent id 唯一性，模拟引擎侧 id 生成）
    seq: AtomicUsize,
    /// run id → 深度（主会话 run 无记录 = 深度 0，沿 parent_id 链数）
    run_depths: Mutex<std::collections::HashMap<String, usize>>,
    /// 父 run id → 未终态子代理数（兄弟并发）
    active_siblings: Mutex<std::collections::HashMap<String, usize>>,
    /// 全局未终态子代理 run 数（并发预算）
    active_concurrent: AtomicUsize,
}

impl DbSpawner {
    fn new(db: conex_db::LocalDb) -> Self {
        Self {
            db,
            guard: DEFAULT_RECURSION_GUARD,
            seq: AtomicUsize::new(0),
            run_depths: Mutex::new(std::collections::HashMap::new()),
            active_siblings: Mutex::new(std::collections::HashMap::new()),
            active_concurrent: AtomicUsize::new(0),
        }
    }

    /// 手动 Debug 助手（LocalDb 不实现 Debug，内部为 Mutex<Connection>）
    fn debug_fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DbSpawner")
            .field("guard", &self.guard)
            .field("active_concurrent", &self.active_concurrent)
            .finish_non_exhaustive()
    }

    /// 守卫判定（T-D-02 映射：嵌套禁止走专用错误变体，错误码
    /// subagent.nesting_denied；其余复用 GuardRejected）——引擎侧
    /// spawner（T-D-13）按同一映射实现
    fn check_guard(&self, snapshot: RecursionGuardSnapshot) -> Result<(), SubagentSpawnError> {
        check_recursion_guard(snapshot, self.guard).map_err(|rejection| match rejection {
            RecursionGuardRejection::NestingDenied { .. } => {
                SubagentSpawnError::NestingDenied(rejection)
            }
            other => SubagentSpawnError::GuardRejected(other),
        })
    }

    /// 落库 + 记账 + 结果（守卫已在调用方完成——单发经 [Self::spawn]
    /// 检查，批量经 [Self::spawn_many] 前瞻统一检查；此处不重复检查，
    /// 否则批量逐条路径会与「前瞻预加」判定产生中间态偏差）
    async fn spawn_unchecked(
        &self,
        req: &SubagentSpawnRequest,
        depth: usize,
    ) -> Result<SubagentSpawnResult, SubagentSpawnError> {
        let parent_run = req.parent_run_id.as_deref().unwrap_or_default();

        // 落库（pending 首写即 running）
        let n = self.seq.fetch_add(1, Ordering::SeqCst);
        let subagent_id = format!("sub-{depth}-{n}");
        let subagent_run_id = format!("sub-run-{depth}-{n}");
        let now = 1_700_000_000;
        let row = self.row_for(req, &subagent_id, &subagent_run_id, depth, now);
        let mut agents = self
            .db
            .load_session_agents(&req.parent_session_id)
            .map_err(|e| SubagentSpawnError::PersistFailed(e.to_string()))?;
        agents.push(row);
        self.db
            .save_session_agents(&req.parent_session_id, &agents)
            .map_err(|e| SubagentSpawnError::PersistFailed(e.to_string()))?;

        // 记账（已分配语义；终态释放由引擎侧完成）
        {
            let mut siblings = self.active_siblings.lock().unwrap();
            *siblings.entry(parent_run.to_string()).or_insert(0) += 1;
        }
        self.active_concurrent.fetch_add(1, Ordering::SeqCst);
        self.run_depths
            .lock()
            .unwrap()
            .insert(subagent_run_id.clone(), depth);

        Ok(SubagentSpawnResult {
            subagent_id,
            subagent_run_id,
            session_id: format!("sub-sess-{depth}-{n}"),
            status: SubagentState::Running,
            summary: None,
            flow_node_id: req.flow_node_id.clone(),
            display_label: req.display_label.clone(),
        })
    }

    /// 落库行构造（pending 首写即 running；depth 沿 parent_run_id 链）
    fn row_for(
        &self,
        req: &SubagentSpawnRequest,
        subagent_id: &str,
        subagent_run_id: &str,
        depth: usize,
        now: i64,
    ) -> conex_types::SessionAgent {
        conex_types::SessionAgent {
            id: subagent_id.to_string(),
            subagent_run_id: subagent_run_id.to_string(),
            parent_session_id: req.parent_session_id.clone(),
            parent_run_id: req.parent_run_id.clone().unwrap_or_default(),
            parent_tool_call_id: req.parent_tool_call_id.clone(),
            description: req.description.clone().unwrap_or_default(),
            mode: req.mode.clone().unwrap_or_default(),
            status: SubagentState::Pending.to_db_status().to_string(),
            summary: None,
            messages: Vec::new(),
            started_at: now,
            ended_at: None,
            depth: Some(depth as i64),
            subagent_path_json: None,
            // T-D-07 落库面：task_type / display_label / 写路径白名单
            // 随 spawn 请求落库（model_override 扩展点预留不落库）
            task_type: req.task_type.map(|t| t.as_str().to_string()),
            display_label: req.display_label.clone(),
            allowed_write_paths_json: req.allowed_write_paths.as_ref().map(|paths| {
                serde_json::to_string(paths).expect("路径白名单序列化不应失败")
            }),
            // v9 新列（D-02 LK-04 并行契约）：测试替身行无子会话映射
            sub_session_id: None,
        }
    }
}

impl std::fmt::Debug for DbSpawner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.debug_fmt(f)
    }
}

#[async_trait]
impl SubagentSpawner for DbSpawner {
    async fn spawn(
        &self,
        req: &SubagentSpawnRequest,
    ) -> Result<SubagentSpawnResult, SubagentSpawnError> {
        // 1. 守卫快照：深度沿 parent_id 链（父 run 深度 + 1）
        let parent_run = req.parent_run_id.as_deref().unwrap_or_default();
        let depth = self
            .run_depths
            .lock()
            .unwrap()
            .get(parent_run)
            .copied()
            .unwrap_or(0)
            + 1;
        let snapshot = RecursionGuardSnapshot {
            depth,
            active_siblings: *self
                .active_siblings
                .lock()
                .unwrap()
                .get(parent_run)
                .unwrap_or(&0),
            active_concurrent: self.active_concurrent.load(Ordering::SeqCst),
        };
        self.check_guard(snapshot)?;
        // 2. 落库 + 记账 + 结果（守卫已通过）
        self.spawn_unchecked(req, depth).await
    }

    /// 批量派发（T-D-06 原子语义）：**前瞻快照统一守卫**——批量任务
    /// 同父（parent_run_id 取首条），depth 共享，active_siblings /
    /// active_concurrent 按 N 预加后一次判定；任一拒绝 → 整体失败
    /// **零 run**（session_agents 无新增行，不产生部分成功）；全部
    /// 通过 → 逐条落库 + 启动（顺序与入参一致）。
    ///
    /// 注：逐条落库阶段若出现持久化失败（DB 写入错误，测试域不触发），
    /// 前序行已落库——该路径属灾难性失败，由引擎侧负责回滚；
    /// 「零 run」保证针对守卫拒绝（验收断言 session_agents 无新增行）。
    async fn spawn_many(
        &self,
        requests: &[SubagentSpawnRequest],
    ) -> Result<Vec<SubagentSpawnResult>, SubagentSpawnError> {
        if requests.is_empty() {
            return Ok(Vec::new());
        }
        let n = requests.len();
        let parent_run = requests[0].parent_run_id.as_deref().unwrap_or_default();
        let depth = self
            .run_depths
            .lock()
            .unwrap()
            .get(parent_run)
            .copied()
            .unwrap_or(0)
            + 1;
        let snapshot = RecursionGuardSnapshot {
            depth,
            active_siblings: self
                .active_siblings
                .lock()
                .unwrap()
                .get(parent_run)
                .copied()
                .unwrap_or(0)
                + n,
            active_concurrent: self.active_concurrent.load(Ordering::SeqCst) + n,
        };
        self.check_guard(snapshot)?;
        // 全部通过 → 逐条落库 + 启动
        let mut results = Vec::with_capacity(n);
        for req in requests {
            results.push(self.spawn_unchecked(req, depth).await?);
        }
        Ok(results)
    }
}

fn request(
    prompt: &str,
    parent_session: &str,
    parent_run: Option<&str>,
) -> SubagentSpawnRequest {
    SubagentSpawnRequest {
        agent_id: None,
        prompt: prompt.to_string(),
        role: None,
        capability_mode: None,
        allowed_tools: None,
        timeout_ms: None,
        description: None,
        mode: None,
        parent_session_id: parent_session.to_string(),
        parent_run_id: parent_run.map(str::to_string),
        parent_tool_call_id: None,
        flow_node_id: None,
        is_composite: false,
        task_type: None,
        allowed_write_paths: None,
        display_label: None,
        // 扩展点预留：测试构造点同样显式 None（编译器强制）
        model_override: None,
    }
}

// ── 子域接线（SD-47 同款 `#[path]` 旁挂）──────────────────────────

#[path = "subagent_tests_tool.rs"]
mod tool_tests;
#[path = "subagent_tests_batch.rs"]
mod batch_tests;
#[path = "subagent_tests_guard.rs"]
mod guard_tests;
#[path = "subagent_tests_filter.rs"]
mod filter_tests;
#[path = "subagent_tests_db.rs"]
mod db_tests;
#[path = "subagent_tests_atomic.rs"]
mod atomic_tests;
