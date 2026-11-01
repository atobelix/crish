use super::*;
use crate::error::DeviceErrorCode;
use crate::error::ErrorBody;
use conex_types::permission::PermissionMode;

#[test]
fn command_request_roundtrip_camel_case() {
    let req = CommandRequest::with_typed_params(
        "approve",
        &ApproveParams {
            tool_call_id: "tc-9".into(),
            run_id: Some("r-01".into()),
        },
    )
    .expect("参数序列化")
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
    // G5a：附件面两字段缺省 None，且序列化不出现（旧载荷逐字节不变）
    assert_eq!(params.content, None);
    assert_eq!(params.has_images, None);
    let serialized = serde_json::to_value(&params).unwrap();
    assert!(serialized.get("content").is_none());
    assert!(serialized.get("hasImages").is_none());
}
#[test]
fn run_task_params_content_roundtrip() {
    // G5a：content（OpenAI 形 parts）+ hasImages 解析与回写
    let params: RunTaskParams = serde_json::from_str(
        r#"{"prompt":"看图","content":[{"type":"text","text":"看图"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA","detail":"auto"},"name":"a.png","mime":"image/png"}],"hasImages":true}"#,
    )
    .unwrap();
    assert_eq!(params.has_images, Some(true));
    let content = params.content.clone().expect("content 存在");
    assert_eq!(content[0]["type"], "text");
    assert_eq!(content[1]["type"], "image_url");
    assert_eq!(content[1]["image_url"]["detail"], "auto");
    let back = serde_json::to_value(&params).unwrap();
    assert_eq!(back["hasImages"], serde_json::json!(true));
    assert_eq!(back["content"], content);
    // hasImages=false 显式下发（非视觉降级 parts）同样保真
    let text_only: RunTaskParams =
        serde_json::from_str(r#"{"prompt":"x","content":[{"type":"text","text":"- f.txt"}],"hasImages":false}"#)
            .unwrap();
    assert_eq!(text_only.has_images, Some(false));
    assert!(text_only.content.is_some());
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
        serde_json::to_string(&PermissionMode::Full).unwrap(),
        "\"full\""
    );
    assert_eq!(
        serde_json::to_string(&PermissionMode::Smart).unwrap(),
        "\"smart\""
    );
    assert_eq!(
        serde_json::to_string(&PermissionMode::Ask).unwrap(),
        "\"ask\""
    );
    assert_eq!(PermissionMode::default(), PermissionMode::Smart);
    assert_eq!(PermissionMode::Full.as_str(), "full");
    assert_eq!(PermissionMode::Full.to_string(), "full");
    assert_eq!(
        "full".parse::<PermissionMode>().unwrap(),
        PermissionMode::Full
    );
    assert_eq!(
        "smart".parse::<PermissionMode>().unwrap(),
        PermissionMode::Smart
    );
    assert_eq!(
        "ask".parse::<PermissionMode>().unwrap(),
        PermissionMode::Ask
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
    assert_eq!(COMMANDS.len(), 44);
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
    // 域分布：10 + 5 + 8 + 8 + 8 + 5（会话域 8 = M6 四条 + G3 会话操作
    // 四条；设置域 8 = M6 五条 + G2 模型两条 + G7 技能一条）
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
                CommandDomain::Sessions => 8,
                CommandDomain::Settings => 8,
                CommandDomain::Devices => 5,
            }
        );
    }
    // 命令名唯一
    let names: std::collections::HashSet<&str> = COMMANDS.iter().map(|s| s.name).collect();
    assert_eq!(names.len(), 44);
}

#[test]
fn remote_and_result_kinds_lock_spec_table() {
    assert_eq!(REMOTE_KINDS.len(), 44);
    assert_eq!(RESULT_KINDS.len(), 44);
    for (i, spec) in COMMANDS.iter().enumerate() {
        assert_eq!(REMOTE_KINDS[i], format!("remote.{}", spec.name));
        assert_eq!(RESULT_KINDS[i], format!("result.{}", spec.name));
    }
    let unique: std::collections::HashSet<&str> = REMOTE_KINDS
        .iter()
        .chain(RESULT_KINDS.iter())
        .copied()
        .collect();
    assert_eq!(unique.len(), 88);
}

#[test]
fn model_commands_wire_shape() {
    // C39 参数：(providerId, modelId) 二元组身份，camelCase
    let params: SetActiveModelParams =
        serde_json::from_str(r#"{"providerId":"anthropic","modelId":"claude-sonnet"}"#).unwrap();
    assert_eq!(params.provider_id, "anthropic");
    assert_eq!(params.model_id, "claude-sonnet");

    // C38 响应：activeModel 缺省时字段省略（未设置全局默认 = 诚实缺省）
    let empty = ListModelsResult {
        models: vec![],
        active_model: None,
    };
    let json = serde_json::to_value(&empty).unwrap();
    assert!(json.get("activeModel").is_none());
    assert_eq!(json["models"], serde_json::json!([]));

    // 条目往返：providerDisplayName 缺省省略、active 标记保真
    let result: ListModelsResult = serde_json::from_str(
        r#"{"models":[{"providerId":"p1","modelId":"m1","displayName":"M One","active":true}],"activeModel":{"providerId":"p1","modelId":"m1","displayName":"M One"}}"#,
    )
    .unwrap();
    assert_eq!(result.models[0].provider_display_name, None);
    assert!(result.models[0].active);
    let active = result.active_model.as_ref().expect("activeModel 应解析");
    assert_eq!(active.provider_id, "p1");
    let back = serde_json::to_value(&result).unwrap();
    assert!(back["models"][0].get("providerDisplayName").is_none());

    // G5b 视觉标记：旧线格式（无 vision 字段）解析为 false（非视觉缺省）；
    // vision=true 时序列化保真，供移动端决定图片直发/降级。
    assert!(!result.models[0].vision);
    assert_eq!(back["models"][0]["vision"], serde_json::json!(false));
    let vision_entry: ModelEntry = serde_json::from_str(
        r#"{"providerId":"p1","modelId":"m2","displayName":"M Two","active":false,"vision":true}"#,
    )
    .unwrap();
    assert!(vision_entry.vision);
}

#[test]
fn session_ops_commands_wire_shape() {
    // C40 参数：sessionId + 原始标题（规范化在宿主侧，与桌面改名同口径）
    let params: RenameSessionParams =
        serde_json::from_str(r#"{"sessionId":"s-1","title":"  新标题  "}"#).unwrap();
    assert_eq!(params.session_id, "s-1");
    assert_eq!(params.title, "  新标题  ");

    // C41/C42 参数：bool 标记 camelCase 往返
    let pinned: SetSessionPinnedParams =
        serde_json::from_str(r#"{"sessionId":"s-1","pinned":true}"#).unwrap();
    assert!(pinned.pinned);
    let archived: SetSessionArchivedParams =
        serde_json::from_str(r#"{"sessionId":"s-1","archived":false}"#).unwrap();
    assert!(!archived.archived);

    // C43 参数：仅 sessionId
    let delete: DeleteSessionParams =
        serde_json::from_str(r#"{"sessionId":"s-1"}"#).unwrap();
    assert_eq!(delete.session_id, "s-1");

    // 四条结果统一 OkResult（契约 GenericOkResult）：{ok:true}
    let ok: OkResult = serde_json::from_str(r#"{"ok":true}"#).unwrap();
    assert!(ok.ok);
    let json = serde_json::to_value(&ok).unwrap();
    assert_eq!(json["ok"], true);

    // G3 四条规格锁定：会话域、自然幂等非写命令（write=false）
    for name in [
        "renameSession",
        "setSessionPinned",
        "setSessionArchived",
        "deleteSession",
    ] {
        let spec = COMMANDS
            .iter()
            .find(|s| s.name == name)
            .expect("G3 命令必须在规格表");
        assert_eq!(spec.domain, CommandDomain::Sessions);
        assert!(!spec.write);
        assert_eq!(spec.result_type, "OkResult");
    }
}

#[test]
fn skill_commands_wire_shape() {
    // C44 参数：空对象
    let params: ListSkillsParams = serde_json::from_str(r#"{}"#).unwrap();
    assert_eq!(params, ListSkillsParams {});

    // C44 响应：条目往返——fileActivation 缺省省略、disableModelInvocation
    // 缺省 false（旧线格式无此字段按非禁调解析）
    let result: ListSkillsResult = serde_json::from_str(
        r#"{"skills":[{"id":"skill_95cfb221d00f","name":"my-skill","description":"演示技能","scope":"project","system":false}]}"#,
    )
    .unwrap();
    assert_eq!(result.skills.len(), 1);
    let entry = &result.skills[0];
    assert_eq!(entry.id, "skill_95cfb221d00f");
    assert!(!entry.disable_model_invocation);
    assert_eq!(entry.file_activation, None);
    let back = serde_json::to_value(&result).unwrap();
    assert!(back["skills"][0].get("fileActivation").is_none());
    assert_eq!(
        back["skills"][0]["disableModelInvocation"],
        serde_json::json!(false)
    );

    // 全字段保真：system / disableModelInvocation / fileActivation 往返
    let full: SkillEntry = serde_json::from_str(
        r#"{"id":"skill_aaaaaaaaaaaa","name":"sys","description":"","scope":"global","system":true,"disableModelInvocation":true,"fileActivation":"recommended"}"#,
    )
    .unwrap();
    assert!(full.system);
    assert!(full.disable_model_invocation);
    assert_eq!(full.file_activation.as_deref(), Some("recommended"));
    let full_back = serde_json::to_value(&full).unwrap();
    assert_eq!(full_back["fileActivation"], "recommended");

    // 空目录诚实形态：skills 空数组
    let empty: ListSkillsResult = serde_json::from_str(r#"{"skills":[]}"#).unwrap();
    assert!(empty.skills.is_empty());

    // G7 规格锁定：设置域、只读（write=false）、结果类型 ListSkillsResult
    let spec = COMMANDS
        .iter()
        .find(|s| s.name == "listSkills")
        .expect("G7 命令必须在规格表");
    assert_eq!(spec.domain, CommandDomain::Settings);
    assert!(!spec.write);
    assert_eq!(spec.params_type, "ListSkillsParams");
    assert_eq!(spec.result_type, "ListSkillsResult");
    assert_eq!(spec.tauri_command, "workbench_discover_skills");
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
