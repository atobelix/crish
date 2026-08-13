//! `subagent` 工具入参解析域测试（SR-06a 拆分）：入参解析 / T-D-07 任务类型默认集 / 定义注册表。
//!
//! 全部既有测试原样迁移（零删除）；`use super::*` 经父模命名空间取共享替身与门面 re-export。

#![allow(clippy::disallowed_methods)]

use super::*;

use crate::context::{create_mock_tool_context, ToolContext};
use crate::definition::Tool;
use std::path::PathBuf;

// ── 工具入参解析 ──────────────────────────────────────────────

#[tokio::test]
async fn tool_requires_prompt() {
    let spawner = Arc::new(RecordingSpawner::ok());
    let tool = RunSubagentTool::with_spawner(Some(spawner.clone()));
    let ctx = create_mock_tool_context();
    let err = tool.execute(&ctx, serde_json::json!({})).await.unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    assert!(spawner.requests().is_empty(), "缺 prompt 不得发起 spawn");
}

#[tokio::test]
async fn tool_rejects_unknown_role_and_capability() {
    let spawner = Arc::new(RecordingSpawner::ok());
    let tool = RunSubagentTool::with_spawner(Some(spawner.clone()));
    let ctx = create_mock_tool_context();
    let err = tool
        .execute(
            &ctx,
            serde_json::json!({ "prompt": "调查 X", "role": "wizard" }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    assert!(err.to_string().contains("未知角色"));
    let err = tool
        .execute(
            &ctx,
            serde_json::json!({ "prompt": "调查 X", "capabilityMode": "super" }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    assert!(err.to_string().contains("未知能力模式"));
    assert!(spawner.requests().is_empty());
}

#[tokio::test]
async fn tool_parses_optional_args_into_request() {
    let spawner = Arc::new(RecordingSpawner::ok());
    let tool = RunSubagentTool::with_spawner(Some(spawner.clone()));
    let ctx = ToolContext {
        session_id: "parent-sess".to_string(),
        ..create_mock_tool_context()
    };
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({
                "prompt": "完成模块 A",
                "agentId": "def-researcher",
                "role": "researcher",
                "capabilityMode": "read-only",
                "allowedTools": ["read_file", "grep_search"],
                "timeoutMs": 120_000,
                "description": "调研模块 A",
                "mode": "research"
            }),
        )
        .await
        .unwrap();
    let requests = spawner.requests();
    assert_eq!(requests.len(), 1);
    let req = &requests[0];
    assert_eq!(req.prompt, "完成模块 A");
    assert_eq!(req.agent_id.as_deref(), Some("def-researcher"));
    assert_eq!(req.role, Some(SubagentRole::Researcher));
    assert_eq!(req.capability_mode, Some(SubagentCapabilityMode::ReadOnly));
    assert_eq!(
        req.allowed_tools,
        Some(vec!["read_file".to_string(), "grep_search".to_string()])
    );
    assert_eq!(req.timeout_ms, Some(120_000));
    assert_eq!(req.description.as_deref(), Some("调研模块 A"));
    assert_eq!(req.mode.as_deref(), Some("research"));
    assert_eq!(req.parent_session_id, "parent-sess", "父会话 = 工具执行会话");
    assert!(req.parent_run_id.is_none(), "父 run 由引擎侧补齐");
    // 出站信封
    assert_eq!(out["subagentId"], "sub-1");
    assert_eq!(out["subagentRunId"], "sub-run-1");
    assert_eq!(out["sessionId"], "sub-sess-1");
    assert_eq!(out["status"], "running");
}

// ── T-D-07：任务类型 / 默认权限集 / 定义注册表 / display_label ──

#[test]
fn task_type_parse_as_str_roundtrip_kebab_case() {
    // 六枚举 wire 名 kebab-case 往返 + 未知名拒绝（对齐 TS 契约）
    let all = [
        (TaskType::Analysis, "analysis"),
        (TaskType::Design, "design"),
        (TaskType::Review, "review"),
        (TaskType::Implementation, "implementation"),
        (TaskType::Organization, "organization"),
        (TaskType::Commit, "commit"),
    ];
    for (variant, wire) in all {
        assert_eq!(variant.as_str(), wire, "wire 名必须 kebab-case");
        assert_eq!(TaskType::parse(wire), Some(variant), "wire 名可解析回枚举");
        assert!(
            !wire.contains('_'),
            "wire 名不得含下划线（kebab-case 契约）"
        );
    }
    assert_eq!(TaskType::parse("wizard"), None, "未知任务类型解析为 None");
    assert_eq!(TaskType::parse(""), None);
}

#[test]
fn task_type_boundary_summary_available_for_ui() {
    // 一句话边界（给主 agent / UI 展示）：六枚举全部有边界文案
    for variant in [
        TaskType::Analysis,
        TaskType::Design,
        TaskType::Review,
        TaskType::Implementation,
        TaskType::Organization,
        TaskType::Commit,
    ] {
        let summary = variant.boundary_summary();
        assert!(!summary.is_empty(), "边界文案不得为空");
        assert!(
            summary.contains('，') || summary.contains('+') || summary.contains('仅'),
            "边界文案应为人读一句话"
        );
    }
}

#[test]
fn default_permissions_analysis_readonly_no_write_no_command() {
    // 验收锚点（调研-权限传递层.md §5 默认权限集）：analysis =
    // 只读白名单（复用 readonly.rs:27-34 语义）、无写、无命令
    let p = default_permissions(TaskType::Analysis);
    assert_eq!(p.tool_set, DefaultToolSet::ReadOnlyWhitelist);
    assert_eq!(p.write_scope, DefaultWriteScope::None);
    assert_eq!(p.command_policy, DefaultCommandPolicy::None);
}

#[test]
fn default_permissions_design_and_review_quota_one() {
    // design/review：只读白名单 + 仅 write_file、凭证式配额 1、无命令
    for task_type in [TaskType::Design, TaskType::Review] {
        let p = default_permissions(task_type);
        assert_eq!(p.tool_set, DefaultToolSet::ReadOnlyPlusWriteFile);
        assert_eq!(
            p.write_scope,
            DefaultWriteScope::Quota {
                granted: true,
                quota: 1
            },
            "{task_type:?} 写配额 = 1（凭证式）"
        );
        assert_eq!(p.command_policy, DefaultCommandPolicy::None);
    }
}

#[test]
fn default_permissions_implementation_full_workspace_build_test() {
    // implementation：全工具集 + 工作区根沙箱 + 构建/测试类命令
    let p = default_permissions(TaskType::Implementation);
    assert_eq!(p.tool_set, DefaultToolSet::Full);
    assert_eq!(p.write_scope, DefaultWriteScope::WorkspaceRoot);
    assert_eq!(p.command_policy, DefaultCommandPolicy::BuildTest);
}

#[test]
fn default_permissions_organization_main_agent_dirs_fail_closed() {
    // organization：只读 + 写、主 agent 显式目录（不配退化为只读）、无命令
    let p = default_permissions(TaskType::Organization);
    assert_eq!(p.tool_set, DefaultToolSet::ReadOnlyPlusWriteFile);
    assert_eq!(p.write_scope, DefaultWriteScope::MainAgentDirs);
    assert_eq!(p.command_policy, DefaultCommandPolicy::None);
}

#[test]
fn default_permissions_commit_shell_only_git_prefix() {
    // commit：仅 shell_command + git 前缀命令，无写文件工具
    let p = default_permissions(TaskType::Commit);
    assert_eq!(p.tool_set, DefaultToolSet::ShellOnly);
    assert_eq!(p.write_scope, DefaultWriteScope::NoWriteTools);
    assert_eq!(p.command_policy, DefaultCommandPolicy::GitOnly);
}

#[test]
fn parameter_convergence_definition_has_no_enable_switches() {
    // 参数收敛断言（类型级）：REQ-D04 九参数收敛为五项（调研-
    // 权限传递层.md §3.2）——enable_write_tools / enable_command_tools /
    // enable_mcp_tools / allowed_read_paths **不存在于定义契约**
    // （SubagentDefinition 字段即全部收敛参数，引用不存在的字段 =
    // 编译错误，此处以「构造完整定义 + 全字段读取」做类型级锚定）。
    let def = SubagentDefinition {
        id: "def-x".to_string(),
        name: "调研员".to_string(),
        description: Some("调研模块 A".to_string()),
        system_prompt: Some("你是调研员".to_string()),
        task_type: Some(TaskType::Analysis),
        allowed_write_paths: Some(vec![PathBuf::from("docs/notes")]),
        display_label: Some("Rust 内核分析师".to_string()),
        // 扩展点预留：显式 None（编译器强制）
        model_override: None,
    };
    assert_eq!(def.id, "def-x");
    assert_eq!(def.name, "调研员");
    assert_eq!(def.effective_task_type(), TaskType::Analysis);
    assert_eq!(
        def.effective_write_paths(),
        Some(vec![PathBuf::from("docs/notes")])
    );
    assert_eq!(def.effective_display_label(), "Rust 内核分析师");
    assert_eq!(def.model_override, None, "扩展点预留必须恒 None");
}

#[test]
fn definition_registry_resolves_and_merges_fields_over_defaults() {
    // 定义实例化验收：注册五项参数定义 → agentId 解析完整 spawn 字段 →
    // 合并语义正确（显式字段覆盖 task_type 默认集）
    let mut registry = SubagentDefinitionRegistry::new();
    assert!(registry.is_empty());
    registry
        .register(SubagentDefinition {
            id: "def-impl".to_string(),
            name: "实现员".to_string(),
            description: None,
            system_prompt: None,
            task_type: Some(TaskType::Implementation),
            // 显式白名单覆盖 implementation 默认集（工作区根）
            allowed_write_paths: Some(vec![PathBuf::from("crates/foo")]),
            display_label: Some("实现工程师".to_string()),
            model_override: None,
        })
        .expect("首次注册应成功");
    assert!(!registry.is_empty());
    assert_eq!(registry.len(), 1);
    assert!(registry.contains("def-impl"));

    // agentId 解析：同一份定义可反复解析（天然支持多次实例化）
    let def = registry.get("def-impl").expect("定义可检索");
    assert_eq!(def.effective_task_type(), TaskType::Implementation);
    assert_eq!(
        def.effective_write_paths(),
        Some(vec![PathBuf::from("crates/foo")]),
        "显式字段必须覆盖 task_type 默认集"
    );
    assert_eq!(def.effective_display_label(), "实现工程师");
    let again = registry.get("def-impl").expect("再次解析同一份定义");
    assert_eq!(again, def, "解析结果稳定（多次实例化基础）");

    // 重复 id 拒绝（防静默替换）
    let dup = SubagentDefinition {
        id: "def-impl".to_string(),
        name: "冒充者".to_string(),
        description: None,
        system_prompt: None,
        task_type: None,
        allowed_write_paths: None,
        display_label: None,
        model_override: None,
    };
    assert_eq!(
        registry.register(dup),
        Err(SubagentRegistryError::DuplicateId("def-impl".to_string()))
    );
    assert_eq!(registry.len(), 1, "被拒注册不得污染注册表");

    // 缺省语义：task_type 缺省 = analysis（最安全）；display_label
    // 缺省取 name；write_paths None = 引擎按默认集装配
    let plain = SubagentDefinition {
        id: "def-plain".to_string(),
        name: "通用子代理".to_string(),
        description: None,
        system_prompt: None,
        task_type: None,
        allowed_write_paths: None,
        display_label: None,
        model_override: None,
    };
    assert_eq!(plain.effective_task_type(), TaskType::Analysis);
    assert_eq!(plain.effective_write_paths(), None);
    assert_eq!(plain.effective_display_label(), "通用子代理");
}

#[tokio::test]
async fn tool_parses_task_type_write_paths_and_display_label() {
    // T-D-07 入参解析：taskType / allowedWritePaths / displayLabel →
    // SpawnRequest；displayLabel 出站信封回显（T-D-05）
    let spawner = Arc::new(RecordingSpawner::ok());
    let tool = RunSubagentTool::with_spawner(Some(spawner.clone()));
    let ctx = ToolContext {
        session_id: "parent-sess".to_string(),
        ..create_mock_tool_context()
    };
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({
                "prompt": "完成模块 A",
                "taskType": "implementation",
                "allowedWritePaths": ["crates/foo", "docs/notes"],
                "displayLabel": "实现工程师"
            }),
        )
        .await
        .unwrap();
    let requests = spawner.requests();
    assert_eq!(requests.len(), 1);
    let req = &requests[0];
    assert_eq!(req.task_type, Some(TaskType::Implementation));
    assert_eq!(
        req.allowed_write_paths,
        Some(vec![PathBuf::from("crates/foo"), PathBuf::from("docs/notes")])
    );
    assert_eq!(req.display_label.as_deref(), Some("实现工程师"));
    // 全构造点 model_override 显式 None（编译器强制断言）
    assert_eq!(req.model_override, None, "工具路径 model_override 恒 None");
    // 出站信封回显 displayLabel
    assert_eq!(out["displayLabel"], "实现工程师");
}

#[tokio::test]
async fn tool_rejects_unknown_task_type() {
    // 未知 taskType 结构化拒绝（对齐 role/capabilityMode 的拒绝面；
    // displayLabel 是独立自由文本字段，不在拒绝面内）
    let spawner = Arc::new(RecordingSpawner::ok());
    let tool = RunSubagentTool::with_spawner(Some(spawner.clone()));
    let ctx = create_mock_tool_context();
    let err = tool
        .execute(
            &ctx,
            serde_json::json!({ "prompt": "调查 X", "taskType": "wizard" }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    assert!(err.to_string().contains("未知任务类型"));
    assert!(spawner.requests().is_empty(), "拒绝不得发起 spawn");
}

#[tokio::test]
async fn tool_rejects_non_array_allowed_write_paths() {
    let spawner = Arc::new(RecordingSpawner::ok());
    let tool = RunSubagentTool::with_spawner(Some(spawner.clone()));
    let ctx = create_mock_tool_context();
    let err = tool
        .execute(
            &ctx,
            serde_json::json!({ "prompt": "调查 X", "allowedWritePaths": "docs" }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code(), "tool.invalid_input");
    assert!(err.to_string().contains("必须是字符串数组"));
    assert!(spawner.requests().is_empty());
}

#[tokio::test]
async fn tool_display_label_accepts_free_text_not_enum() {
    // T-D-05 验收：displayLabel 是自由文本独立字段，非枚举拒绝面——
    // 传入「wizard」等自由标签不被拒（现有拒绝测试只针对 role /
    // capabilityMode / taskType 枚举字段）
    let spawner = Arc::new(RecordingSpawner::ok());
    let tool = RunSubagentTool::with_spawner(Some(spawner.clone()));
    let ctx = create_mock_tool_context();
    let out = tool
        .execute(
            &ctx,
            serde_json::json!({ "prompt": "任务", "displayLabel": "wizard" }),
        )
        .await
        .unwrap();
    assert_eq!(out["displayLabel"], "wizard");
    assert_eq!(
        spawner.requests()[0].display_label.as_deref(),
        Some("wizard")
    );
}

#[tokio::test]
async fn tool_without_extension_args_leaves_defaults() {
    // 未传扩展参数：task_type / write_paths / display_label 全 None
    // （None = 不覆盖继承值/定义值，引擎按缺省 analysis + 默认集装配）
    let spawner = Arc::new(RecordingSpawner::ok());
    let tool = RunSubagentTool::with_spawner(Some(spawner.clone()));
    let ctx = create_mock_tool_context();
    tool.execute(&ctx, serde_json::json!({ "prompt": "任务" }))
        .await
        .unwrap();
    let req = &spawner.requests()[0];
    assert_eq!(req.task_type, None);
    assert_eq!(req.allowed_write_paths, None);
    assert_eq!(req.display_label, None);
    assert_eq!(req.model_override, None);
}

#[tokio::test]
async fn tool_without_spawner_returns_structured_unavailable() {
    let tool = RunSubagentTool::new();
    let ctx = create_mock_tool_context();
    let err = tool
        .execute(&ctx, serde_json::json!({ "prompt": "任务" }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), "common.unsupported");
    assert!(err.to_string().contains("未接线"));
}

