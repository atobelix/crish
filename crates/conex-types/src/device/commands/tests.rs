use super::*;
use crate::device::error::DeviceErrorCode;
use crate::device::error::ErrorBody;

#[test]
fn command_request_roundtrip_camel_case() {
    let req = CommandRequest::with_typed_params(
        "approve",
        &ApproveParams {
            tool_call_id: "tc-9".into(),
            run_id: Some("r-01".into()),
        },
    )
    .with_timeout(30_000);
    let json = serde_json::to_value(&req).unwrap();
    assert_eq!(json["command"], "approve");
    assert_eq!(json["params"]["toolCallId"], "tc-9");
    assert_eq!(json["params"]["runId"], "r-01");
    assert_eq!(json["timeoutMs"], 30_000);
    let back: CommandRequest = serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
    assert_eq!(req, back);
}

#[test]
fn command_result_three_states() {
    let ok = CommandResult::success(
        "m-1",
        serde_json::json!({ "ok": true, "toolCallId": "tc-9" }),
    );
    let json = serde_json::to_value(&ok).unwrap();
    assert_eq!(json["reqMsgId"], "m-1");
    assert_eq!(json["ok"], true);
    assert_eq!(json["result"]["toolCallId"], "tc-9");
    assert!(json.get("partial").is_none());
    assert!(json.get("error").is_none());

    let err = CommandResult::failure(
        "m-2",
        ErrorBody::new(DeviceErrorCode::CmdApprovalMismatch, "已处理"),
    );
    let json = serde_json::to_value(&err).unwrap();
    assert_eq!(json["ok"], false);
    assert_eq!(json["error"]["code"], "cmd.approval_mismatch");
    assert!(json.get("result").is_none());

    let part = CommandResult::partial("m-3", serde_json::json!({ "accepted": 2 }));
    let json = serde_json::to_value(&part).unwrap();
    assert_eq!(json["partial"], true);

    let back: CommandResult = serde_json::from_str(&serde_json::to_string(&ok).unwrap()).unwrap();
    assert_eq!(ok, back);
}

#[test]
fn approve_params_example_parse() {
    // M6 §4.2.1 示例：{"toolCallId":"tc-9","runId":"r-01"}
    let params: ApproveParams =
        serde_json::from_str(r#"{"toolCallId":"tc-9","runId":"r-01"}"#).unwrap();
    assert_eq!(params.tool_call_id, "tc-9");
    assert_eq!(params.run_id.as_deref(), Some("r-01"));
    // runId 缺省容错
    let minimal: ApproveParams = serde_json::from_str(r#"{"toolCallId":"tc-9"}"#).unwrap();
    assert_eq!(minimal.run_id, None);
}

#[test]
fn deny_params_reason() {
    let params: DenyParams =
        serde_json::from_str(r#"{"toolCallId":"tc-9","runId":"r-01","reason":"风险过高"}"#)
            .unwrap();
    assert_eq!(params.reason.as_deref(), Some("风险过高"));
}

#[test]
fn run_task_params_example_parse() {
    // M6 §4.4.1 示例
    let params: RunTaskParams = serde_json::from_str(
        r#"{"sessionId":"s-abc","prompt":"帮我修登录页 bug","permissionMode":"ask","clientMessageId":"msg-01HZ"}"#,
    )
    .unwrap();
    assert_eq!(params.session_id.as_deref(), Some("s-abc"));
    assert_eq!(params.prompt, "帮我修登录页 bug");
    assert_eq!(params.permission_mode, Some(PermissionMode::Ask));
    assert_eq!(params.client_message_id.as_deref(), Some("msg-01HZ"));
    assert_eq!(params.history, None);
}

#[test]
fn event_page_result_example_parse() {
    // M6 §4.1.3 响应示例
    let result: EventPageResult = serde_json::from_str(
        r#"{"events":[{"type":"approval-requested","sequence":130}],"nextAfterSequence":130,"hasMore":true,"latestSequence":135}"#,
    )
    .unwrap();
    assert_eq!(result.events.len(), 1);
    assert_eq!(result.next_after_sequence, 130);
    assert!(result.has_more);
    assert_eq!(result.latest_sequence, Some(135));
}

#[test]
fn pending_approval_example_parse() {
    // M6 §4.2.2 C13 响应元素
    let approval: PendingApproval = serde_json::from_str(
        r#"{"requestId":"req-01","toolCallId":"tc-9","toolName":"shell:write","summary":"npm test 需要执行权限","cwd":"C:\\Software\\conex","sessionId":"s-abc","runId":"r-01","requesterRunId":null,"reason":null,"arbiter":"user","requestedAt":1754700000000,"expiresAt":1754700120000,"dangerLevel":1}"#,
    )
    .unwrap();
    assert_eq!(approval.tool_call_id, "tc-9");
    assert_eq!(approval.arbiter, Arbiter::User);
    assert_eq!(approval.danger_level, 1);
    assert_eq!(approval.requester_run_id, None);
}

#[test]
fn enum_wire_values() {
    assert_eq!(
        serde_json::to_string(&CheckDecision::RequiresApproval).unwrap(),
        "\"requires-approval\""
    );
    assert_eq!(
        serde_json::to_string(&RunControlLevel::CooperativeStop).unwrap(),
        "\"cooperative_stop\""
    );
    assert_eq!(
        serde_json::to_string(&PermissionMode::FullAccess).unwrap(),
        "\"full-access\""
    );
    assert_eq!(
        serde_json::to_string(&PairState::Handshaking).unwrap(),
        "\"handshaking\""
    );
    assert_eq!(
        serde_json::to_string(&DeviceType::Phone).unwrap(),
        "\"phone\""
    );
    assert_eq!(
        serde_json::to_string(&SetSettingsKey::ResponseStyle).unwrap(),
        "\"responseStyle\""
    );
    assert_eq!(
        serde_json::to_string(&Arbiter::MainAgent).unwrap(),
        "\"main-agent\""
    );
    assert_eq!(
        serde_json::to_string(&PageDirection::Backward).unwrap(),
        "\"backward\""
    );
    assert_eq!(
        serde_json::to_string(&ApprovalChannel::Mobile).unwrap(),
        "\"mobile\""
    );
    assert_eq!(
        serde_json::to_string(&SettingsConfirmStatus::Withdrawn).unwrap(),
        "\"withdrawn\""
    );
}

#[test]
fn command_spec_table_counts() {
    assert_eq!(COMMANDS.len(), 37);
    // 全部请求方向 M→D
    for spec in COMMANDS {
        assert_eq!(spec.direction, MessageDirection::MobileToDesktop);
    }
    // 写命令五条（M6 §1.3：approve/deny/writeFile/setSettings/pauseAutomation）
    let writes: Vec<&CommandSpec> = COMMANDS.iter().filter(|s| s.write).collect();
    assert_eq!(writes.len(), 5);
    let write_names: Vec<&str> = writes.iter().map(|s| s.name).collect();
    assert_eq!(
        write_names,
        [
            "approve",
            "deny",
            "writeFile",
            "setSettings",
            "pauseAutomation"
        ]
    );
    // 域分布：10 + 5 + 8 + 4 + 5 + 5
    let domains: Vec<CommandDomain> = COMMANDS.iter().map(|s| s.domain).collect();
    for d in [
        CommandDomain::Monitor,
        CommandDomain::Approval,
        CommandDomain::Files,
        CommandDomain::Sessions,
        CommandDomain::Settings,
        CommandDomain::Devices,
    ] {
        assert_eq!(
            domains.iter().filter(|&&x| x == d).count(),
            match d {
                CommandDomain::Monitor => 10,
                CommandDomain::Approval => 5,
                CommandDomain::Files => 8,
                CommandDomain::Sessions => 4,
                CommandDomain::Settings => 5,
                CommandDomain::Devices => 5,
            }
        );
    }
    // 命令名唯一
    let names: std::collections::HashSet<&str> = COMMANDS.iter().map(|s| s.name).collect();
    assert_eq!(names.len(), 37);
}

#[test]
fn remote_and_result_kinds_lock_spec_table() {
    assert_eq!(REMOTE_KINDS.len(), 37);
    assert_eq!(RESULT_KINDS.len(), 37);
    for (i, spec) in COMMANDS.iter().enumerate() {
        assert_eq!(REMOTE_KINDS[i], format!("remote.{}", spec.name));
        assert_eq!(RESULT_KINDS[i], format!("result.{}", spec.name));
    }
    let unique: std::collections::HashSet<&str> = REMOTE_KINDS
        .iter()
        .chain(RESULT_KINDS.iter())
        .copied()
        .collect();
    assert_eq!(unique.len(), 74);
}

#[test]
fn device_entry_type_rename() {
    let entry = DeviceEntry {
        device_id: "7f0a".into(),
        name: "我的 iPhone".into(),
        device_type: DeviceType::Phone,
        role: DeviceRole::This,
        channel: Some(DeviceChannel::Lan),
        online: Some(true),
        last_active_at: Some(1754700000000),
        paired_at: Some("2026-08-01T08:00:00Z".into()),
        needs_reauth: Some(false),
    };
    let json = serde_json::to_value(&entry).unwrap();
    // Rust 关键字 type 经 rename 为 `type`
    assert_eq!(json["type"], "phone");
    assert_eq!(json["deviceId"], "7f0a");
    assert_eq!(json["channel"], "lan");
    assert_eq!(json["needsReauth"], false);
    let back: DeviceEntry = serde_json::from_str(&serde_json::to_string(&entry).unwrap()).unwrap();
    assert_eq!(entry, back);
}

#[test]
fn settings_result_two_states() {
    let direct: SetSettingsResult = serde_json::from_str(r#"{"ok":true,"applied":true}"#).unwrap();
    assert_eq!(direct.pending, None);
    let pending: SetSettingsResult = serde_json::from_str(
        r#"{"ok":true,"applied":false,"pending":true,"confirmRequestId":"cf-01HZ"}"#,
    )
    .unwrap();
    assert_eq!(pending.confirm_request_id.as_deref(), Some("cf-01HZ"));
}
