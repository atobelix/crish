//! MockBackend 的 ApiBackend 实现（游标分页 / 未知 id 404 / 错误映射 / 写面幂等）

use super::*;

#[async_trait::async_trait]
impl ApiBackend for MockBackend {
    async fn get_status(&self) -> Result<serde_json::Value, ServerError> {
        self.fail()?;
        Ok(serde_json::json!({
            "initialized": true,
            "version": "1.4.2-test",
            "engineReady": true,
            "dbReady": true,
            "searchIndexReady": true,
            "compactionReady": false,
            "providerStatus": {
                "hasApiKey": true,
                "model": "deepseek-v4",
                "credentialMode": "direct",
            },
            "logLevel": "info",
            "restore": {
                "state": "done",
                "mode": "snapshot-incremental",
                "interruptedCount": 0,
            },
            "backgroundTasks": {
                "activeCount": 1,
                "daemonCount": 1,
            },
            "activeRuns": [
                { "runId": "r-1", "sessionId": "s-1", "status": "running" }
            ],
            "pendingApprovals": [
                {
                    "toolCallId": "tc-9",
                    "toolName": "shell:write",
                    "runId": "r-1",
                    "summary": "npm test 需要执行权限",
                }
            ],
        }))
    }

    async fn get_run_snapshot(
        &self,
        params: RunSnapshotParams,
    ) -> Result<RunSnapshotResult, ServerError> {
        self.fail()?;
        if params.run_id == "r-missing" {
            return Err(Self::not_found("run not found（mock）"));
        }
        Ok(RunSnapshotResult {
            snapshot: serde_json::json!({
                "runId": params.run_id,
                "sessionId": "s-1",
                "status": "running",
                "cursor": 127,
                "createdAt": 1_754_700_000_000_i64,
                "updatedAt": 1_754_700_030_000_i64,
                "endReason": null,
                "error": null,
                "usage": {
                    "promptTokens": 2100,
                    "completionTokens": 1400,
                    "totalTokens": 3500,
                    "sampleCount": 3,
                },
            }),
        })
    }

    async fn read_session_events(
        &self,
        params: EventPageParams,
    ) -> Result<EventPageResult, ServerError> {
        self.fail()?;
        if params.session_id == "s-missing" {
            return Err(Self::not_found("会话不存在（mock）"));
        }
        let after = params.after_sequence.unwrap_or(0);
        let max = params.max_events.unwrap_or(PAGE_SIZE_DEFAULT) as usize;
        Ok(self.paginate(after, max))
    }

    async fn read_run_events(
        &self,
        params: RunEventsParams,
    ) -> Result<EventPageResult, ServerError> {
        self.fail()?;
        if params.run_id == "r-missing" {
            return Err(Self::not_found("run not found（mock）"));
        }
        let after = params.after_sequence.unwrap_or(0);
        let max = params.max_events.unwrap_or(PAGE_SIZE_DEFAULT) as usize;
        Ok(self.paginate(after, max))
    }

    async fn list_sessions(
        &self,
        _params: ListSessionsParams,
    ) -> Result<ListSessionsResult, ServerError> {
        self.fail()?;
        Ok(ListSessionsResult {
            sessions: vec![SessionIndexEntry {
                id: "s-1".to_string(),
                title: "修复登录页 bug".to_string(),
                folder: "常规会话".to_string(),
                is_pinned: false,
                is_archived: false,
                branch_parent_id: None,
                timestamp: "2026-08-09T08:00:00Z".to_string(),
                updated_at: 1_754_700_000_000,
                message_count: 42,
                pinned_message_ids: None,
                engine_cursor: Some(128),
                engine_last_run_id: Some("r-1".to_string()),
                hydrated_from_engine: Some(true),
            }],
        })
    }

    async fn list_background_tasks(
        &self,
        _params: ListTasksParams,
    ) -> Result<ListTasksResult, ServerError> {
        self.fail()?;
        Ok(ListTasksResult {
            tasks: vec![
                serde_json::json!({
                    "taskId": "t-1",
                    "command": "npm run build",
                    "cwd": "C:\\Software\\conex",
                    "status": "running",
                    "isDaemon": false,
                    "startedAt": 1_754_700_000_000_i64,
                    "exitCode": null,
                    "lineCount": 42,
                }),
                serde_json::json!({
                    "taskId": "t-2",
                    "command": "npm test",
                    "cwd": "C:\\Software\\conex",
                    "status": "completed",
                    "isDaemon": false,
                    "startedAt": 1_754_600_000_000_i64,
                    "exitCode": 0,
                    "lineCount": 128,
                }),
            ],
        })
    }

    async fn get_task_output(
        &self,
        params: TaskOutputParams,
    ) -> Result<TaskOutputResult, ServerError> {
        self.fail()?;
        if params.task_id == "t-missing" {
            return Err(Self::not_found("任务不存在（mock）"));
        }
        let after = params.after_line.unwrap_or(0) as usize;
        let max = params.max_lines.unwrap_or(PAGE_SIZE_DEFAULT) as usize;
        let page: Vec<String> = self.lines.iter().skip(after).take(max).cloned().collect();
        let next = (after + page.len()) as u64;
        let has_more = (after + page.len()) < self.lines.len();
        Ok(TaskOutputResult {
            lines: page,
            truncated: has_more,
            line_count: self.lines.len() as u64,
            next_after_line: Some(next),
            has_more: Some(has_more),
        })
    }

    async fn get_flow_snapshot(
        &self,
        params: FlowSnapshotParams,
    ) -> Result<FlowSnapshotResult, ServerError> {
        self.fail()?;
        if params.session_id == "s-missing" {
            return Err(Self::not_found("会话不存在（mock）"));
        }
        Ok(FlowSnapshotResult {
            flow: serde_json::json!({
                "flowDeclaration": { "id": "f-1" },
                "flowState": { "phase": "running" },
                "agents": [
                    {
                        "agentId": "sub-3",
                        "status": "running",
                        "description": "调研",
                        "summary": null,
                        "depth": 1,
                    }
                ],
            }),
        })
    }

    async fn list_commands(&self) -> Result<ListCommandsResult, ServerError> {
        self.fail()?;
        Ok(ListCommandsResult {
            contract_version: "1.0.0".to_string(),
            commands: vec![ManifestEntry {
                name: "core_get_status".to_string(),
                family: "core".to_string(),
                surface: CommandSurface::Engine,
                registered: true,
            }],
        })
    }

    async fn get_search_index(&self) -> Result<SearchIndexResult, ServerError> {
        self.fail()?;
        Ok(SearchIndexResult {
            ready: true,
            state: Some(serde_json::json!({
                "totalFiles": 1200,
                "lastBuiltAt": 1_754_600_000_000_i64,
            })),
        })
    }

    async fn run_task(&self, params: RunTaskParams) -> Result<RunTaskResult, ServerError> {
        self.fail()?;
        // R1-10 T-08：记录远程申报的权限模式（装配面降级断言用）
        *self.last_run_permission_mode.lock().unwrap() = params.permission_mode;
        if params.prompt.trim().is_empty() {
            return Err(Self::invalid("prompt 不能为空（mock）"));
        }
        // clientMessageId 幂等：同 id 重发回显首次 runId（M6 C24）
        if let Some(client_message_id) = params.client_message_id.as_deref() {
            let mut run_ids = self.run_ids.lock().unwrap();
            if let Some(existing) = run_ids.get(client_message_id) {
                return Ok(RunTaskResult {
                    run_id: existing.clone(),
                    session_id: "s-1".to_string(),
                });
            }
            let run_id = format!("r-{}", run_ids.len() + 1);
            run_ids.insert(client_message_id.to_string(), run_id.clone());
            return Ok(RunTaskResult {
                run_id,
                session_id: "s-1".to_string(),
            });
        }
        Ok(RunTaskResult {
            run_id: "r-remote".to_string(),
            session_id: "s-1".to_string(),
        })
    }
    async fn run_control(
        &self,
        params: conex_types::device::RunControlParams,
    ) -> Result<conex_types::device::RunControlResult, ServerError> {
        self.fail()?;
        // 记录收到的参数（路径 runId 覆盖断言）
        *self.last_run_control.lock().unwrap() = Some(params.clone());
        Ok(conex_types::device::RunControlResult { ok: true })
    }
    async fn cancel_run(
        &self,
        params: conex_types::device::CancelRunParams,
    ) -> Result<conex_types::device::CancelRunResult, ServerError> {
        self.fail()?;
        if params.run_id == "r-missing" {
            return Err(Self::not_found("run not found（mock）"));
        }
        Ok(conex_types::device::CancelRunResult {
            ok: true,
            run_id: params.run_id,
        })
    }
    async fn approve(
        &self,
        params: conex_types::device::ApproveParams,
    ) -> Result<conex_types::device::ApproveResult, ServerError> {
        self.fail()?;
        self.decide(&params.tool_call_id, "approved")
    }
    async fn deny(
        &self,
        params: DenyParams,
    ) -> Result<conex_types::device::ApproveResult, ServerError> {
        self.fail()?;
        *self.last_deny_reason.lock().unwrap() = params.reason.clone();
        self.decide(&params.tool_call_id, "denied")
    }

    async fn list_pending_approvals(
        &self,
        _params: conex_types::device::ListPendingApprovalsParams,
    ) -> Result<conex_types::device::ListPendingApprovalsResult, ServerError> {
        self.fail()?;
        Ok(conex_types::device::ListPendingApprovalsResult {
            approvals: vec![
                conex_types::device::PendingApproval {
                    request_id: "approval-tc-9".to_string(),
                    tool_call_id: "tc-9".to_string(),
                    tool_name: "shell:write".to_string(),
                    summary: Some("call shell:write".to_string()),
                    cwd: Some("C:\\Software\\conex".to_string()),
                    session_id: Some("s-1".to_string()),
                    run_id: Some("r-1".to_string()),
                    requester_run_id: None,
                    reason: None,
                    arbiter: conex_types::device::Arbiter::User,
                    requested_at: 1_754_700_000_000,
                    expires_at: 1_754_700_120_000,
                    danger_level: 2,
                    param_keys: Some(vec!["script".to_string()]),
                },
                conex_types::device::PendingApproval {
                    request_id: "approval-tc-8".to_string(),
                    tool_call_id: "tc-8".to_string(),
                    tool_name: "read_file".to_string(),
                    summary: Some("call read_file".to_string()),
                    cwd: Some("C:\\Software\\conex".to_string()),
                    session_id: Some("s-1".to_string()),
                    run_id: Some("r-1".to_string()),
                    requester_run_id: None,
                    reason: None,
                    arbiter: conex_types::device::Arbiter::User,
                    requested_at: 1_754_700_000_000,
                    expires_at: 1_754_700_120_000,
                    danger_level: 1,
                    param_keys: None,
                },
            ],
            latest_sequence: None,
        })
    }

    async fn approval_history(
        &self,
        _params: conex_types::device::ApprovalHistoryParams,
    ) -> Result<conex_types::device::ApprovalHistoryResult, ServerError> {
        self.fail()?;
        Ok(conex_types::device::ApprovalHistoryResult {
            items: vec![
                conex_types::device::ApprovalHistoryItem {
                    sequence: 12,
                    tool_call_id: "tc-5".to_string(),
                    tool_name: None,
                    decision: conex_types::events::ApprovalDecision::Approved,
                    reason: None,
                    channel: Some(conex_types::device::ApprovalChannel::Mobile),
                    resolved_at: Some(1_754_700_005_000),
                    session_id: Some("s-1".to_string()),
                    run_id: Some("r-1".to_string()),
                },
                conex_types::device::ApprovalHistoryItem {
                    sequence: 14,
                    tool_call_id: "tc-6".to_string(),
                    tool_name: None,
                    decision: conex_types::events::ApprovalDecision::Denied,
                    reason: Some("风险过高".to_string()),
                    channel: Some(conex_types::device::ApprovalChannel::Mobile),
                    resolved_at: Some(1_754_700_006_000),
                    session_id: Some("s-1".to_string()),
                    run_id: Some("r-1".to_string()),
                },
            ],
            next_after_sequence: Some(14),
            has_more: Some(false),
        })
    }

    async fn settings_get(
        &self,
        params: conex_types::device::GetSettingsParams,
    ) -> Result<conex_types::device::GetSettingsResult, ServerError> {
        self.fail()?;
        *self.last_settings_keys.lock().unwrap() = params.keys.clone();
        Ok(conex_types::device::GetSettingsResult {
            settings: serde_json::json!({
                "apiKey": "",
                "baseUrl": "https://api.example.com",
                "model": "deepseek-v4",
                "hasApiKey": true,
                "credentialMode": "direct",
                "endpoint": "responses",
                "stream": true,
            }),
        })
    }

    async fn settings_set(
        &self,
        params: SettingsUpdateParams,
    ) -> Result<conex_types::device::GetSettingsResult, ServerError> {
        self.fail()?;
        if params.credential_mode.is_some() || params.endpoint.is_some() || params.stream.is_some()
        {
            return Err(Self::invalid(
                "credentialMode / endpoint / stream 不在 REST 非敏感配置更新面（mock）",
            ));
        }
        Ok(conex_types::device::GetSettingsResult {
            settings: serde_json::json!({
                "apiKey": "",
                "baseUrl": params.base_url.unwrap_or_else(|| "https://api.example.com".to_string()),
                "model": params.model.unwrap_or_else(|| "deepseek-v4".to_string()),
                "hasApiKey": true,
                "credentialMode": "direct",
                "endpoint": "responses",
                "stream": true,
            }),
        })
    }

    // ── R2-12c 新增面（C21/C30/C31 透传断言；C22 占位继承缺省）──

    async fn search_files(
        &self,
        params: SearchFilesParams,
    ) -> Result<SearchFilesResult, ServerError> {
        self.fail()?;
        *self.last_search_files.lock().unwrap() = Some(params);
        Ok(SearchFilesResult {
            results: vec![
                FileSearchHit {
                    rel_path: "src/main.rs".to_string(),
                    kind: None,
                    size: None,
                },
                FileSearchHit {
                    rel_path: "README.md".to_string(),
                    kind: None,
                    size: None,
                },
            ],
        })
    }

    async fn settings_confirm(
        &self,
        params: SettingsConfirmParams,
    ) -> Result<SettingsConfirmResult, ServerError> {
        self.fail()?;
        *self.last_settings_confirm.lock().unwrap() = Some(params);
        Ok(SettingsConfirmResult {
            status: SettingsConfirmStatus::Withdrawn,
            reason: Some("mock 回执".to_string()),
        })
    }

    async fn pause_automation(
        &self,
        params: PauseAutomationParams,
    ) -> Result<PauseAutomationResult, ServerError> {
        self.fail()?;
        *self.last_pause_duration.lock().unwrap() = params.duration_sec;
        Ok(PauseAutomationResult {
            ok: true,
            paused_until: 1_754_700_060_000,
        })
    }
}
