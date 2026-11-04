//! 工具后台轨命令面（BG5）：引擎工具后台注册表的 UI 查询 / 取消口。
//!
//! 与 shell 进程任务域（`background/` 的 `workbench_*` 命令、
//! BackgroundTaskManager）是**两条轨**，本面不碰那边：这里的对象是
//! conex-run 的通用后台注册表单例（`ToolBackgroundRegistry`，经
//! `CoreRunState::engine()` 取得），即「工具调用超时转后台」的进程内
//! 工具调用（callId 寻址），与模型侧 `tool_task` 工具查的是同一注册表。
//!
//! - `core_list_tool_background_tasks`：指定会话的未落定条目快照
//!   （Queued / Running，登记序）——会话级「后台中 N」指示的数据源；
//! - `core_cancel_tool_background_task`：单条取消——经 BG3 宿主
//!   cancel_and_notify（注册表取消口：子令牌触发 + 执行句柄 abort +
//!   Cancelled 收口落盘；同口扇出 tool-settled(cancelled) 与落定唤醒）。
//!   取消后的 settled(cancelled) 回注走 BG3 的事件面（host 通知包装），
//!   本命令只返回取消是否生效，呈现层据此先行收口、事件到达后由
//!   BG3 的 patch 接管同一条目。

use std::sync::Arc;

use agent_tools::tools::tool_task::ToolTaskStatus;
use conex_run::core_error::CoreError;
use conex_run::core_query::require_session_id;
use conex_run::run::CoreRunState;
use tauri::State;

/// `core_list_tool_background_tasks`：会话未落定后台工具快照。
#[tauri::command]
pub async fn core_list_tool_background_tasks(
    session_id: String,
    core: State<'_, Arc<CoreRunState>>,
) -> Result<Vec<ToolTaskStatus>, CoreError> {
    require_session_id(&session_id)?;
    let now_ms = conex_shared::time::now_millis();
    Ok(core
        .engine()
        .tool_background_registry()
        .session_snapshot(session_id.trim(), now_ms))
}

/// `core_cancel_tool_background_task`：取消单个后台工具调用。
///
/// 返回 true = 条目在途且已取消收口；false = 条目不存在或已终态
/// （先落定者胜，取消与执行落定竞速时以注册表裁决为准）。
#[tauri::command]
pub async fn core_cancel_tool_background_task(
    call_id: String,
    core: State<'_, Arc<CoreRunState>>,
) -> Result<bool, CoreError> {
    let call_id = call_id.trim();
    if call_id.is_empty() {
        return Err(CoreError::invalid_input("call_id 不能为空"));
    }
    let now_ms = conex_shared::time::now_millis();
    Ok(core
        .engine()
        .tool_background_registry()
        .cancel(call_id, now_ms))
}
