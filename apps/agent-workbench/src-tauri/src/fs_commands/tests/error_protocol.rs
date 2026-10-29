use std::fs;

use super::support::*;
use crate::fs_commands::types;

// ── PS-04 T4.5（F4 F1-02）：错误协议统一 CoreError ──

/// T4.5-R2（红 → 绿）：原生目录选择链（`workbench_select*` 命令 +
/// `dialog::select_folder` / `dialog::register_picked_folder`）已于
/// 2026-09-15 真漂移债务清零时**物理切除**（前端目录选择统一走
/// plugin-dialog，生产代码零消费）。
///
/// 原断言钉的是被退役链路的错误映射面：注册表未托管 → `CoreError::Internal`、
/// 非法路径 → `CoreError::InvalidInput`、合法路径 → canonical 注册成功。
/// 第一条随 `register_picked_folder` 退役（同类未托管映射面由
/// `discover_skills_outside_root_returns_core_error` 继续守护）；后两条改钉其
/// 底层真源 `WorkspaceRegistry::register`——授权/拒绝语义不随命令退役而变。
/// 另加「实现面不得复活」负向不变量。
#[test]
fn select_folder_error_paths_use_core_error_protocol() {
    use crate::workspace::{RegisterSource, WorkspaceRegistry};
    let temp = TestDir::new();
    let auth_root = temp.path().join("auth");
    fs::create_dir_all(&auth_root).expect("create auth root");

    // 退役链路物理切除（needle 分片拼接，避免断言文案自身命中源文本）
    let removed = concat!("workbench_select", "_folder");
    assert!(
        !include_str!("../mod.rs").contains(removed),
        "已退役命令 {removed} 严禁在实现面复活"
    );

    let config_dir = temp.path().join("config");
    fs::create_dir_all(&config_dir).expect("create config dir");
    let reg = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init registry");
    reg.register(&auth_root, RegisterSource::Dialog)
        .expect("dialog register auth_root");

    // 路径非法（不是目录）→ 授权注册表拒绝（原 CoreError::InvalidInput 映射面）
    let not_a_dir = temp.path().join("file.txt");
    fs::write(&not_a_dir, "x").expect("write file");
    assert!(
        reg.register(&not_a_dir, RegisterSource::Dialog).is_err(),
        "非目录路径必须被授权注册表拒绝"
    );

    // 合法目录（授权根内）→ 注册成功（路径返回 canonical）
    let ok = reg
        .register(&auth_root, RegisterSource::Dialog)
        .expect("授权根内应注册成功");
    assert!(
        types::path_is_same_or_child(&ok, &auth_root),
        "授权根内注册应返回 canonical 路径：{}",
        ok.display()
    );
}

/// T4.5-R3（红 → 绿）：`workbench_discover_skills` 的 workspace_path 越界
/// → `CoreError::InvalidInput`（serde `{kind, detail}` 形状，detail 保留
/// workspace_not_granted 文案）；注册表未托管 → `CoreError::Internal`。
/// 修复前返回 String 错误 → kind 缺失 → 红。
#[test]
fn discover_skills_outside_root_returns_core_error() {
    use crate::workspace::{RegisterSource, WorkspaceRegistry};
    let temp = TestDir::new();
    let auth_root = temp.path().join("auth");
    let outside = temp.path().join("outside");
    fs::create_dir_all(&auth_root).expect("create auth root");
    fs::create_dir(&outside).expect("create outside dir");
    let config_dir = temp.path().join("config");
    fs::create_dir_all(&config_dir).expect("create config dir");
    let reg = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init registry");
    reg.register(&auth_root, RegisterSource::Dialog)
        .expect("dialog register auth_root");
    let app = tauri::test::mock_builder()
        .manage(reg)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");

    let result = super::super::workbench_discover_skills(
        app.handle().clone(),
        Some(outside.to_string_lossy().into_owned()),
        Vec::new(),
    );
    let err = result.expect_err("越界 workspace_path 必须拒绝");
    let json = serde_json::to_value(&err).expect("错误必须可序列化");
    assert_eq!(
        json.get("kind").and_then(|v| v.as_str()),
        Some("InvalidInput"),
        "错误必须按 CoreError {{kind,detail}} 协议序列化（当前形态 {json}）"
    );
    let detail = json
        .get("detail")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    assert!(
        detail.contains("workspace_not_granted"),
        "detail 应保留 workspace_not_granted 文案：{detail}"
    );

    // 注册表未托管 → Internal（命令级不 panic，kind 可分类）
    let bare = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("bare mock app");
    let result = super::super::workbench_discover_skills(bare.handle().clone(), None, Vec::new());
    let err = result.expect_err("未托管注册表必须拒绝");
    let json = serde_json::to_value(&err).expect("错误必须可序列化");
    assert_eq!(
        json.get("kind").and_then(|v| v.as_str()),
        Some("Internal"),
        "未托管注册表应为 CoreError::Internal（当前形态 {json}）"
    );
}
