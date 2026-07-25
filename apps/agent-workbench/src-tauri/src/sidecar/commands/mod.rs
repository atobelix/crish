use serde_json::Value;

use crate::{commands::WorkbenchRunTaskRequest, process};

pub(crate) fn daemon_command_with_type(mut request: Value, message_type: &str) -> Result<Value, String> {
    match request {
        Value::Object(ref mut object) => {
            object.insert("type".to_string(), Value::String(message_type.to_string()));
            Ok(request)
        }
        _ => Err(format!(
            "Invalid {message_type} request: request must be a JSON object"
        )),
    }
}

pub(crate) fn normalize_rewind_request_for_daemon(
    mut request: Value,
    allow_dry_run: bool,
) -> Result<Value, String> {
    if let Value::Object(ref mut object) = request {
        object.remove("runId");
        if object
            .remove("dryRun")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
            && !allow_dry_run
        {
            return Err(
                "Invalid conversation rewind request: dryRun must use preview, not apply"
                    .to_string(),
            );
        }
        if object
            .remove("force")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
        {
            return Err(
                "Invalid conversation rewind request: force is not supported by the daemon protocol"
                    .to_string(),
            );
        }
        if let Some(retain) = object
            .remove("retainTargetUserMessage")
            .and_then(|value| value.as_bool())
        {
            object.insert(
                "mode".to_string(),
                Value::String(
                    if retain {
                        "keep-user-message"
                    } else {
                        "remove-user-message"
                    }
                    .to_string(),
                ),
            );
        }
    }
    Ok(request)
}

pub(crate) fn build_read_session_events_command(
    session_id: String,
    after_sequence: Option<u64>,
    last_event_id: Option<String>,
    max_events: Option<u64>,
    cursor: Option<Value>,
    include_snapshot: Option<bool>,
) -> Value {
    let mut cmd = serde_json::json!({
        "type": "read-session-events",
        "sessionId": session_id,
    });
    if let Some(sequence) = after_sequence {
        cmd["afterSequence"] = serde_json::Value::Number(sequence.into());
    }
    if let Some(event_id) = last_event_id.filter(|value| !value.trim().is_empty()) {
        cmd["lastEventId"] = serde_json::Value::String(event_id);
    }
    if let Some(value) = max_events {
        cmd["maxEvents"] = serde_json::Value::Number(value.into());
    }
    if let Some(value) = cursor {
        cmd["cursor"] = value;
    }
    if let Some(value) = include_snapshot {
        cmd["includeSnapshot"] = serde_json::Value::Bool(value);
    }
    cmd
}

pub(crate) fn build_read_run_events_command(
    run_id: String,
    after_sequence: Option<u64>,
    last_event_id: Option<String>,
    include_snapshot: Option<bool>,
    max_events: Option<u64>,
    cursor: Option<Value>,
) -> Value {
    let mut cmd = serde_json::json!({
        "type": "read-run-events",
        "runId": run_id,
    });
    if let Some(sequence) = after_sequence {
        cmd["afterSequence"] = serde_json::Value::Number(sequence.into());
    }
    if let Some(event_id) = last_event_id.filter(|value| !value.trim().is_empty()) {
        cmd["lastEventId"] = serde_json::Value::String(event_id);
    }
    if let Some(value) = include_snapshot {
        cmd["includeSnapshot"] = serde_json::Value::Bool(value);
    }
    if let Some(value) = max_events {
        cmd["maxEvents"] = serde_json::Value::Number(value.into());
    }
    if let Some(value) = cursor {
        cmd["cursor"] = value;
    }
    cmd
}

pub(crate) fn build_workbench_run_task_command(
    request: WorkbenchRunTaskRequest,
    forced_mode: Option<&str>,
) -> (Value, String, Option<String>) {
    let run_id = request
        .run_id
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| format!("run-{}", process::now_millis()));
    let session_id = request.session_id.filter(|v| !v.trim().is_empty());
    let mode = forced_mode
        .map(str::to_string)
        .or_else(|| request.mode.filter(|v| !v.trim().is_empty()));

    let mut cmd_json = serde_json::json!({
        "type": "run-task",
        "runId": run_id,
        "prompt": request.prompt,
    });
    if let Some(mode) = mode {
        cmd_json["mode"] = serde_json::Value::String(mode);
    }
    if let Some(workspace_mode) = request.workspace_mode.filter(|v| !v.trim().is_empty()) {
        cmd_json["workspaceMode"] = serde_json::Value::String(workspace_mode);
    }
    if let Some(visible_goal) = request.visible_goal.filter(|v| !v.trim().is_empty()) {
        cmd_json["visibleGoal"] = serde_json::Value::String(visible_goal);
    }
    if let Some(budget_difficulty) = request.budget_difficulty.filter(|v| !v.trim().is_empty()) {
        cmd_json["budgetDifficulty"] = serde_json::Value::String(budget_difficulty);
    }
    if let Some(run_token_budget) = request.run_token_budget {
        cmd_json["runTokenBudget"] = serde_json::Value::Number(run_token_budget.into());
    }
    if let Some(max_rounds) = request.max_rounds {
        cmd_json["maxRounds"] = serde_json::Value::Number(max_rounds.into());
    }
    if let Some(max_stalled_rounds) = request.max_stalled_rounds {
        cmd_json["maxStalledRounds"] = serde_json::Value::Number(max_stalled_rounds.into());
    }
    if let Some(background_drain_timeout_ms) = request.background_drain_timeout_ms {
        cmd_json["backgroundDrainTimeoutMs"] =
            serde_json::Value::Number(background_drain_timeout_ms.into());
    }
    if let Some(cwd) = request.cwd.filter(|v| !v.trim().is_empty()) {
        cmd_json["cwd"] = serde_json::Value::String(cwd);
    }
    if let Some(session_id) = session_id.as_ref() {
        cmd_json["sessionId"] = serde_json::Value::String(session_id.clone());
    }
    if let Some(permission_mode) = request.permission_mode.filter(|v| !v.trim().is_empty()) {
        cmd_json["permissionMode"] = serde_json::Value::String(permission_mode);
    }

    (cmd_json, run_id, session_id)
}

pub(crate) mod status_commands;
pub(crate) mod session_commands;
pub(crate) mod run_commands;
pub(crate) mod config_commands;
pub(crate) mod plan_commands;
pub(crate) mod action_commands;

pub(crate) use status_commands::*;
pub(crate) use session_commands::*;
pub(crate) use run_commands::*;
pub(crate) use plan_commands::*;
pub(crate) use action_commands::*;

#[cfg(test)]
mod tests;
