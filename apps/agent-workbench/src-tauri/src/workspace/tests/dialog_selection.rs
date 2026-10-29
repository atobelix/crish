use super::*;

/// T07.2 用例 3：register(Dialog) 后根内读写成功（注册返回 canonical 路径）。
#[test]
fn register_dialog_returns_canonical_path() {
    let temp = TestDir::new();
    let root = temp.path().join("project");
    fs::create_dir(&root).expect("create root");
    let reg = WorkspaceRegistry::init_with_config_dir(temp.path()).expect("init");

    let canonical = reg
        .register(&root, RegisterSource::Dialog)
        .expect("dialog register should succeed");
    assert!(canonical.is_absolute());
    assert_eq!(
        canonical,
        strip_verbatim_prefix(&root.canonicalize().expect("canonical root"))
    );
}

/// 原生 picker 的回调路径进入注册表后可执行沙箱写入，未选路径仍被拒绝。
#[test]
fn native_dialog_selection_authorizes_guarded_write_only_for_selected_root() {
    let temp = TestDir::new();
    let selected_root = temp.path().join("selected-project");
    let unselected_root = temp.path().join("unselected-project");
    fs::create_dir(&selected_root).expect("create selected root");
    fs::create_dir(&unselected_root).expect("create unselected root");
    let reg = WorkspaceRegistry::init_with_config_dir(&temp.path().join("config"))
        .expect("init registry");

    let selected = register_native_dialog_selection(&reg, Some(vec![selected_root.clone()]), true)
        .expect("register selected root")
        .expect("selection result");
    let canonical = selected[0].clone();
    let guard = reg
        .resolve_guard(&canonical.to_string_lossy())
        .expect("selected root must resolve through the workspace guard");
    crate::fs_commands::write::write_file_content_with_guard(
        &guard,
        "authorized.txt",
        "selected by native dialog",
        false,
    )
    .expect("guarded write inside selected root");
    assert_eq!(
        fs::read_to_string(canonical.join("authorized.txt")).expect("read guarded file"),
        "selected by native dialog"
    );

    let err = reg
        .register(&unselected_root, RegisterSource::RecentList)
        .expect_err("arbitrary unselected root must not be reauthorized");
    assert_eq!(err.code, ERR_WORKSPACE_NOT_GRANTED, "err: {}", err.message);
    assert_eq!(
        reg.resolve_guard(&unselected_root.to_string_lossy())
            .expect_err("unselected root must be outside the guard")
            .code,
        ERR_OUTSIDE_WORKSPACE
    );
}

/// 成功的原生 picker 注册会把且仅把注册表授权根同步到 asset 协议。
#[test]
fn native_dialog_selection_syncs_asset_scope_for_registered_root() {
    let temp = TestDir::new();
    let selected_root = temp.path().join("selected-project");
    let unselected_root = temp.path().join("unselected-project");
    fs::create_dir(&selected_root).expect("create selected root");
    fs::create_dir(&unselected_root).expect("create unselected root");
    let registry = WorkspaceRegistry::init_with_config_dir(&temp.path().join("config"))
        .expect("init registry");
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build mock Tauri app");

    let result = register_native_dialog_selection_and_sync(
        app.handle(),
        &registry,
        Some(vec![selected_root.clone()]),
        true,
    )
    .expect("register and scope selected root");

    assert!(result.is_some());
    assert!(app
        .asset_protocol_scope()
        .is_allowed(selected_root.join("image.png")));
    assert!(!app
        .asset_protocol_scope()
        .is_allowed(unselected_root.join("secret.png")));
}

/// 失效的旧根不应阻止本次成功注册的新根同步到 asset scope。
#[test]
fn native_dialog_selection_syncs_new_root_when_old_registered_root_is_unavailable() {
    let temp = TestDir::new();
    let old_root = temp.path().join("old-project");
    let new_root = temp.path().join("new-project");
    fs::create_dir(&old_root).expect("create old root");
    fs::create_dir(&new_root).expect("create new root");
    let registry = WorkspaceRegistry::init_with_config_dir(&temp.path().join("config"))
        .expect("init registry");
    registry
        .register_dialog_paths(std::slice::from_ref(&old_root), true)
        .expect("register old root");
    fs::remove_dir_all(&old_root).expect("remove old root");
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build mock Tauri app");

    register_native_dialog_selection_and_sync(
        app.handle(),
        &registry,
        Some(vec![new_root.clone()]),
        true,
    )
    .expect("register new root despite unavailable old root");

    assert!(app
        .asset_protocol_scope()
        .is_allowed(new_root.join("image.png")));
    assert!(!app
        .asset_protocol_scope()
        .is_allowed(old_root.join("secret.png")));
}

/// RecentList 复授权成功后同步 asset scope，不依赖旧进程内的授权状态。
#[test]
fn opening_recent_workspace_syncs_asset_scope() {
    let temp = TestDir::new();
    let root = temp.path().join("recent-project");
    fs::create_dir(&root).expect("create recent root");
    let config_dir = temp.path().join("config");
    fs::create_dir(&config_dir).expect("create config dir");
    fs::write(
        config_dir.join(RECENT_FILE_NAME),
        serde_json::to_string(&vec![root.to_string_lossy().to_string()]).expect("json"),
    )
    .expect("write recent workspace");
    let registry = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init registry");
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build mock Tauri app");
    assert!(!app
        .asset_protocol_scope()
        .is_allowed(root.join("image.png")));
    let registered = registry
        .register(&root, RegisterSource::RecentList)
        .expect("recent workspace reauthorization");
    sync_asset_scope(app.handle(), std::slice::from_ref(&registered))
        .expect("sync recent workspace asset scope");

    assert!(app
        .asset_protocol_scope()
        .is_allowed(root.join("image.png")));
}

/// 原生 picker 取消不注册根、不更新 recent，也不创建持久化文件。
#[test]
fn native_dialog_cancel_has_no_registry_or_persistence_side_effects() {
    let temp = TestDir::new();
    let config_dir = temp.path().join("config");
    let reg = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init registry");
    let roots_before = reg.roots();
    let recent_before = reg.inner.lock().expect("lock registry").recent.clone();

    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build mock Tauri app");
    let asset_scope_before = app.asset_protocol_scope().allowed_patterns();
    let result = register_native_dialog_selection_and_sync(app.handle(), &reg, None, true)
        .expect("cancel should be a successful no-op");

    assert_eq!(result, None);
    assert_eq!(reg.roots(), roots_before);
    assert_eq!(
        reg.inner.lock().expect("lock registry").recent,
        recent_before
    );
    assert!(!config_dir.join(RECENT_FILE_NAME).exists());
    assert_eq!(
        app.asset_protocol_scope().allowed_patterns(),
        asset_scope_before
    );
}

/// 原生多选先校验全部路径；任一无效项都不得留下部分授权。
#[test]
fn native_dialog_multi_selection_validation_is_atomic() {
    let temp = TestDir::new();
    let valid_root = temp.path().join("valid-project");
    fs::create_dir(&valid_root).expect("create valid root");
    let invalid_root = temp.path().join("missing-project");
    let config_dir = temp.path().join("config");
    let reg = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init registry");
    let roots_before = reg.roots();

    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build mock Tauri app");
    let asset_scope_before = app.asset_protocol_scope().allowed_patterns();
    let err = register_native_dialog_selection_and_sync(
        app.handle(),
        &reg,
        Some(vec![valid_root.clone(), invalid_root]),
        true,
    )
    .expect_err("missing selected root must reject the batch");

    assert_eq!(err.code, ERR_WORKSPACE_NOT_GRANTED, "err: {}", err.message);
    assert_eq!(reg.roots(), roots_before);
    assert!(!config_dir.join(RECENT_FILE_NAME).exists());
    assert_eq!(
        app.asset_protocol_scope().allowed_patterns(),
        asset_scope_before
    );
}

/// recent 持久化失败时注册失败，不能提前扩展 asset scope。
#[test]
fn native_dialog_persistence_failure_does_not_expand_asset_scope() {
    let temp = TestDir::new();
    let selected_root = temp.path().join("selected-project");
    fs::create_dir(&selected_root).expect("create selected root");
    let config_path_is_file = temp.path().join("config-file");
    fs::write(&config_path_is_file, "not a directory").expect("create config file");
    let registry =
        WorkspaceRegistry::init_with_config_dir(&config_path_is_file).expect("init registry");
    let roots_before = registry.roots();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build mock Tauri app");
    let asset_scope_before = app.asset_protocol_scope().allowed_patterns();

    let error = register_native_dialog_selection_and_sync(
        app.handle(),
        &registry,
        Some(vec![selected_root.clone()]),
        true,
    )
    .expect_err("failed recent persistence must reject registration");

    assert_eq!(
        error.code, ERR_WORKSPACE_NOT_GRANTED,
        "error: {}",
        error.message
    );
    assert_eq!(registry.roots(), roots_before);
    assert_eq!(
        app.asset_protocol_scope().allowed_patterns(),
        asset_scope_before
    );
}

#[test]
fn native_dialog_single_scope_failure_leaves_recent_and_registry_unchanged() {
    let temp = TestDir::new();
    let current_root = temp.path().join("current-root");
    let selected_root = temp.path().join("selected-root");
    fs::create_dir(&current_root).expect("create current root");
    fs::create_dir(&selected_root).expect("create selected root");
    let config_dir = temp.path().join("config");
    fs::create_dir(&config_dir).expect("create config dir");
    let registry = make_root_registry(&current_root, &config_dir);
    registry
        .register_dialog_paths(std::slice::from_ref(&current_root), true)
        .expect("register current root");
    let recent_file = config_dir.join(RECENT_FILE_NAME);
    let recent_before_bytes = fs::read(&recent_file).expect("snapshot recent file");
    let (roots_before, active_before, recent_before) = {
        let inner = registry.inner.lock().expect("lock registry");
        (inner.roots.clone(), inner.active, inner.recent.clone())
    };
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build mock Tauri app");
    let scope_before = app.asset_protocol_scope().allowed_patterns();

    let error = registry
        .register_dialog_paths_with(std::slice::from_ref(&selected_root), true, |roots| {
            fs::remove_dir_all(&roots[0]).expect("invalidate selected root before scope sync");
            sync_asset_scope(app.handle(), roots)
        })
        .expect_err("scope failure must reject new dialog authorization");

    assert_eq!(error.code, ERR_INTERNAL);
    let inner = registry.inner.lock().expect("lock registry after failure");
    assert_eq!(inner.roots, roots_before);
    assert_eq!(inner.active, active_before);
    assert_eq!(inner.recent, recent_before);
    assert_eq!(
        fs::read(&recent_file).expect("read recent after failure"),
        recent_before_bytes
    );
    assert_eq!(app.asset_protocol_scope().allowed_patterns(), scope_before);
    assert!(!app
        .asset_protocol_scope()
        .is_allowed(selected_root.join("secret.txt")));
}

#[test]
fn native_dialog_batch_scope_failure_leaves_recent_and_registry_unchanged() {
    let temp = TestDir::new();
    let current_root = temp.path().join("current-root");
    let first_selected = temp.path().join("first-selected");
    let second_selected = temp.path().join("second-selected");
    fs::create_dir(&current_root).expect("create current root");
    fs::create_dir(&first_selected).expect("create first selected root");
    fs::create_dir(&second_selected).expect("create second selected root");
    let config_dir = temp.path().join("config");
    fs::create_dir(&config_dir).expect("create config dir");
    let registry = make_root_registry(&current_root, &config_dir);
    registry
        .register_dialog_paths(std::slice::from_ref(&current_root), true)
        .expect("register current root");
    let recent_file = config_dir.join(RECENT_FILE_NAME);
    let recent_before_bytes = fs::read(&recent_file).expect("snapshot recent file");
    let (roots_before, active_before, recent_before) = {
        let inner = registry.inner.lock().expect("lock registry");
        (inner.roots.clone(), inner.active, inner.recent.clone())
    };
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build mock Tauri app");
    let scope_before = app.asset_protocol_scope().allowed_patterns();
    let selected = [first_selected.clone(), second_selected];

    let error = registry
        .register_dialog_paths_with(&selected, true, |roots| {
            fs::remove_dir_all(&roots[1]).expect("invalidate second root before scope sync");
            sync_asset_scope(app.handle(), roots)
        })
        .expect_err("scope failure must reject the entire dialog batch");

    assert_eq!(error.code, ERR_INTERNAL);
    let inner = registry.inner.lock().expect("lock registry after failure");
    assert_eq!(inner.roots, roots_before);
    assert_eq!(inner.active, active_before);
    assert_eq!(inner.recent, recent_before);
    assert_eq!(
        fs::read(&recent_file).expect("read recent after failure"),
        recent_before_bytes
    );
    assert_eq!(app.asset_protocol_scope().allowed_patterns(), scope_before);
    assert!(!app
        .asset_protocol_scope()
        .is_allowed(first_selected.join("secret.txt")));
}

#[test]
fn native_dialog_partial_scope_failure_keeps_selection_out_of_registry_and_recent() {
    let temp = TestDir::new();
    let current_root = temp.path().join("current-root");
    let first_selected = temp.path().join("first-selected");
    let second_selected = temp.path().join("second-selected");
    fs::create_dir(&current_root).expect("create current root");
    fs::create_dir(&first_selected).expect("create first selected root");
    fs::create_dir(&second_selected).expect("create second selected root");
    let config_dir = temp.path().join("config");
    fs::create_dir(&config_dir).expect("create config dir");
    let registry = make_root_registry(&current_root, &config_dir);
    registry
        .register_dialog_paths(std::slice::from_ref(&current_root), true)
        .expect("register current root");
    let recent_file = config_dir.join(RECENT_FILE_NAME);
    let recent_before_bytes = fs::read(&recent_file).expect("snapshot recent file");
    let (roots_before, active_before, recent_before) = {
        let inner = registry.inner.lock().expect("lock registry");
        (inner.roots.clone(), inner.active, inner.recent.clone())
    };
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build mock Tauri app");

    // Tauri 的 asset protocol scope 只有追加授权接口，没有移除 allow pattern 的接口。
    // 模拟第一项已按用户原生选择成功授权、随后第二项同步失败。
    let error = register_native_dialog_selection_and_sync_with(
        &registry,
        Some(vec![first_selected.clone(), second_selected.clone()]),
        true,
        |roots| {
            sync_asset_scope(app.handle(), &roots[..1])?;
            Err(FileCommandError::new(
                ERR_INTERNAL,
                "injected failure after first selected root was scoped",
            ))
        },
    )
    .unwrap_err();
    assert!(error
        .message
        .contains("所选目录可能已有部分进入资源访问范围"));

    assert_eq!(error.code, ERR_INTERNAL);
    let inner = registry.inner.lock().expect("lock registry after failure");
    assert_eq!(inner.roots, roots_before);
    assert_eq!(inner.active, active_before);
    assert_eq!(inner.recent, recent_before);
    assert_eq!(
        fs::read(&recent_file).expect("read recent after failure"),
        recent_before_bytes
    );
    assert!(!recent_file.with_extension("json.tmp").exists());
    assert!(app
        .asset_protocol_scope()
        .is_allowed(first_selected.join("secret.txt")));
    assert!(!app
        .asset_protocol_scope()
        .is_allowed(second_selected.join("secret.txt")));
}

#[test]
fn native_dialog_recent_commit_failure_reports_completed_scope_and_preserves_registry() {
    let temp = TestDir::new();
    let current_root = temp.path().join("current-root");
    let selected_root = temp.path().join("selected-root");
    fs::create_dir(&current_root).expect("create current root");
    fs::create_dir(&selected_root).expect("create selected root");
    let config_dir = temp.path().join("config");
    fs::create_dir(&config_dir).expect("create config dir");
    let recent_file = config_dir.join(RECENT_FILE_NAME);
    fs::create_dir(&recent_file).expect("make recent target a directory to reject rename");
    let recent_sentinel = recent_file.join("preserve.txt");
    fs::write(&recent_sentinel, "existing recent target").expect("write target sentinel");
    let registry = make_root_registry(&current_root, &config_dir);
    let (roots_before, active_before, recent_before) = {
        let inner = registry.inner.lock().expect("lock registry");
        (inner.roots.clone(), inner.active, inner.recent.clone())
    };
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build mock Tauri app");

    let error = register_native_dialog_selection_and_sync_with(
        &registry,
        Some(vec![selected_root.clone()]),
        true,
        |roots| sync_asset_scope(app.handle(), roots),
    )
    .expect_err("recent rename failure must reject dialog registration");

    assert_eq!(error.code, ERR_INTERNAL);
    assert!(error.message.contains("已同步进入资源访问范围"));
    assert!(error.message.contains("注册表与近期列表未提交"));
    assert!(recent_file.is_dir());
    assert_eq!(
        fs::read(&recent_sentinel).expect("read preserved recent target sentinel"),
        b"existing recent target"
    );
    assert!(!recent_file.with_extension("json.tmp").exists());
    let inner = registry.inner.lock().expect("lock registry after failure");
    assert_eq!(inner.roots, roots_before);
    assert_eq!(inner.active, active_before);
    assert_eq!(inner.recent, recent_before);
    assert!(app
        .asset_protocol_scope()
        .is_allowed(selected_root.join("secret.txt")));
}
