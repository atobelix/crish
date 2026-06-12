use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkbenchRunTaskRequest {
    pub(crate) prompt: String,
    pub(crate) visible_goal: Option<String>,
    pub(crate) session_id: Option<String>,
    pub(crate) run_id: Option<String>,
    pub(crate) mode: Option<String>,
    pub(crate) workspace_mode: Option<String>,
    pub(crate) budget_difficulty: Option<String>,
    pub(crate) run_token_budget: Option<u64>,
    pub(crate) max_rounds: Option<u64>,
    pub(crate) max_stalled_rounds: Option<u64>,
    pub(crate) background_drain_timeout_ms: Option<u64>,
    pub(crate) cwd: Option<String>,
    pub(crate) permission_mode: Option<String>,
}
