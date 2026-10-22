// G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
#![allow(clippy::disallowed_methods)]

mod cancellation;
mod capacity;
mod flow;
mod hierarchy;
mod lifecycle;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex as StdMutex;
use std::sync::{Arc, Mutex};

use crate::core_error::CoreError;
use crate::core_run_commands::{RunTaskOptions, RunTaskResponse};
use agent_tools::tools::subagent::{SubagentRole, SubagentSpawnRequest, TaskType};
use async_trait::async_trait;
use conex_db::LocalDb;
use crish_agent_workbench::wait_channel::EventStreamBroadcast;
use orchestrator::steering_queue::PendingMessageQueue;

use super::spawner::SubagentSpawnerImpl;
use super::types::{SubagentRunConfig, SubagentRunLauncher};

/// 启动请求快照（RunTaskOptions 无 Debug/Clone——trait 对象 Debug 面
/// 不承载，测试自存轻量快照断言装配面）
#[derive(Debug, Clone)]
pub(crate) struct LaunchSnapshot {
    pub(crate) run_id: String,
    pub(crate) session_id: String,
    pub(crate) parent_run_id: Option<String>,
    pub(crate) subagent_config: Option<SubagentRunConfig>,
}

/// 记录式启动器：记录 launch 请求并按预设结果应答（记录 subagent_config
/// 装配断言面）
#[derive(Debug)]
pub(crate) struct RecordingLauncher {
    pub(crate) launches: StdMutex<Vec<LaunchSnapshot>>,
    pub(crate) outcome: Result<RunTaskResponse, CoreError>,
}

impl RecordingLauncher {
    pub(crate) fn ok() -> Self {
        Self {
            launches: StdMutex::new(Vec::new()),
            outcome: Ok(RunTaskResponse {
                run_id: "sub-run-ok".to_string(),
                session_id: "sub-sess-ok".to_string(),
            }),
        }
    }

    pub(crate) fn failing() -> Self {
        Self {
            launches: StdMutex::new(Vec::new()),
            outcome: Err(CoreError::internal("模拟 run 启动失败")),
        }
    }

    pub(crate) fn launches(&self) -> Vec<LaunchSnapshot> {
        self.launches.lock().unwrap().clone()
    }
}

#[async_trait]
impl SubagentRunLauncher for RecordingLauncher {
    async fn launch(&self, options: RunTaskOptions) -> Result<RunTaskResponse, CoreError> {
        self.launches.lock().unwrap().push(LaunchSnapshot {
            run_id: options.run_id.clone(),
            session_id: options.session_id.clone(),
            parent_run_id: options.parent_run_id.clone(),
            subagent_config: options.subagent_config.clone(),
        });
        self.outcome.clone()
    }
}

#[derive(Debug, Default)]
pub(crate) struct PanickingLauncher;

#[async_trait]
impl SubagentRunLauncher for PanickingLauncher {
    async fn launch(&self, _options: RunTaskOptions) -> Result<RunTaskResponse, CoreError> {
        panic!("simulated launcher panic");
    }
}

/// 在测试显式放行前阻塞 launcher，确保并发调用同时处于未终态预留态。
#[derive(Debug)]
pub(crate) struct GateLauncher {
    pub(crate) started: tokio::sync::Semaphore,
    pub(crate) resume: tokio::sync::Semaphore,
    pub(crate) launches: AtomicUsize,
}

impl GateLauncher {
    pub(crate) fn new() -> Self {
        Self {
            started: tokio::sync::Semaphore::new(0),
            resume: tokio::sync::Semaphore::new(0),
            launches: AtomicUsize::new(0),
        }
    }

    pub(crate) fn resume(&self, count: usize) {
        self.resume.add_permits(count);
    }
}

#[async_trait]
impl SubagentRunLauncher for GateLauncher {
    async fn launch(&self, options: RunTaskOptions) -> Result<RunTaskResponse, CoreError> {
        self.launches.fetch_add(1, Ordering::SeqCst);
        self.started.add_permits(1);
        self.resume
            .acquire()
            .await
            .map_err(|error| CoreError::internal(error.to_string()))?
            .forget();
        Ok(RunTaskResponse {
            run_id: options.run_id,
            session_id: options.session_id,
        })
    }
}

/// 在 launcher 返回前同步送入终态，覆盖真实 drive loop 可命中的竞态窗口。
#[derive(Debug, Default)]
pub(crate) struct ImmediateTerminalLauncher {
    pub(crate) spawner: StdMutex<Option<std::sync::Weak<SubagentSpawnerImpl>>>,
    pub(crate) terminal_task: StdMutex<Option<tokio::task::JoinHandle<()>>>,
}

impl ImmediateTerminalLauncher {
    pub(crate) fn attach(&self, spawner: &Arc<SubagentSpawnerImpl>) {
        *self.spawner.lock().unwrap() = Some(Arc::downgrade(spawner));
    }

    pub(crate) async fn wait_for_terminal(&self) {
        let task = self.terminal_task.lock().unwrap().take();
        if let Some(task) = task {
            task.await.expect("terminal callback should not panic");
        }
    }
}

#[async_trait]
impl SubagentRunLauncher for ImmediateTerminalLauncher {
    async fn launch(&self, options: RunTaskOptions) -> Result<RunTaskResponse, CoreError> {
        let spawner = self
            .spawner
            .lock()
            .unwrap()
            .as_ref()
            .and_then(std::sync::Weak::upgrade)
            .ok_or_else(|| CoreError::internal("test spawner is not attached"))?;
        let config = options
            .subagent_config
            .as_ref()
            .cloned()
            .ok_or_else(|| CoreError::internal("subagent config missing"))?;
        let terminal_task = tokio::spawn(async move {
            spawner
                .on_subagent_terminal(
                    &config,
                    agent_tools::tools::subagent::SubagentState::Completed,
                )
                .await;
        });
        *self.terminal_task.lock().unwrap() = Some(terminal_task);
        Ok(RunTaskResponse {
            run_id: options.run_id,
            session_id: options.session_id,
        })
    }
}

#[derive(Debug, Default)]
pub(crate) struct FailSecondLauncher {
    pub(crate) attempts: AtomicUsize,
}

#[async_trait]
impl SubagentRunLauncher for FailSecondLauncher {
    async fn launch(&self, options: RunTaskOptions) -> Result<RunTaskResponse, CoreError> {
        if self.attempts.fetch_add(1, Ordering::SeqCst) == 1 {
            return Err(CoreError::internal("second launch fails"));
        }
        Ok(RunTaskResponse {
            run_id: options.run_id,
            session_id: options.session_id,
        })
    }
}

pub(crate) type TestRig = (
    Arc<SubagentSpawnerImpl>,
    Arc<RecordingLauncher>,
    LocalDb,
    Arc<EventStreamBroadcast>,
    Arc<Mutex<PendingMessageQueue>>,
);

/// 测试装配：spawner + 注入槽（mock launcher / LocalDb / 广播 / 队列）
pub(crate) fn test_rig() -> TestRig {
    let launcher = Arc::new(RecordingLauncher::ok());
    let db = LocalDb::open_in_memory().expect("内存库");
    db.upsert_session_entry(&conex_types::SessionIndexEntry {
        id: "sess-main".to_string(),
        title: "主会话".to_string(),
        folder: String::new(),
        is_pinned: false,
        is_archived: false,
        branch_parent_id: None,
        timestamp: "2026-08-05T00:00:00.000Z".to_string(),
        updated_at: 1,
        message_count: 0,
        pinned_message_ids: None,
        engine_cursor: Some(0),
        engine_last_run_id: Some("run-main".to_string()),
        hydrated_from_engine: Some(true),
    })
    .expect("会话条目");
    let stream = Arc::new(EventStreamBroadcast::new());
    let queue = Arc::new(Mutex::new(PendingMessageQueue::new()));
    let spawner = Arc::new(SubagentSpawnerImpl::new());
    spawner.init(
        Some(Arc::clone(&launcher) as Arc<dyn SubagentRunLauncher>),
        Some(db.clone()),
        Some(Arc::clone(&stream)),
        Some(Arc::clone(&queue)),
    );
    (spawner, launcher, db, stream, queue)
}

/// 单发请求构造（父会话 + 任务类型 + 显式白名单）
pub(crate) fn request(prompt: &str, task_type: Option<TaskType>) -> SubagentSpawnRequest {
    SubagentSpawnRequest {
        agent_id: None,
        prompt: prompt.to_string(),
        role: Some(SubagentRole::Researcher),
        capability_mode: None,
        allowed_tools: None,
        description: Some("调研".to_string()),
        mode: Some("research".to_string()),
        parent_session_id: "sess-main".to_string(),
        parent_run_id: Some("run-main".to_string()),
        parent_tool_call_id: Some("call-1".to_string()),
        flow_node_id: None,
        is_composite: false,
        task_type,
        allowed_write_paths: Some(vec![std::path::PathBuf::from("docs/")]),
        display_label: Some("调研员".to_string()),
        // 扩展点预留：恒 None（编译器强制；本测试不携带）
        model_override: None,
    }
}

pub(crate) fn setup_main_run(spawner: &SubagentSpawnerImpl) {
    // 主 agent run 登记（深度 0）+ 当前活动 run 定位
    spawner.register_run("run-main", "sess-main", None);
    spawner.set_current_run("sess-main", "run-main");
}
