use super::*;

/// T07.2 用例 5：workbench_open_workspace("C:\")（不在 recent，非默认根）→ workspace_not_granted。
#[test]
fn open_workspace_rejects_non_recent_absolute_path() {
    let temp = TestDir::new();
    let reg = WorkspaceRegistry::init_with_config_dir(temp.path()).expect("init");
    let err = reg
        .register(Path::new(r"C:\"), RegisterSource::RecentList)
        .expect_err("non-recent path must be rejected");
    assert_eq!(err.code, ERR_WORKSPACE_NOT_GRANTED, "err: {}", err.message);
}

/// T07.2 用例 5 变体：恶意诱导路径（根盘符）不得授权。
#[test]
fn open_workspace_rejects_drive_root() {
    let temp = TestDir::new();
    let reg = WorkspaceRegistry::init_with_config_dir(temp.path()).expect("init");
    #[cfg(windows)]
    let evil = "C:\\";
    #[cfg(not(windows))]
    let evil = "/";
    let err = reg
        .register(Path::new(evil), RegisterSource::RecentList)
        .expect_err("drive root must be rejected");
    assert_eq!(err.code, ERR_WORKSPACE_NOT_GRANTED, "err: {}", err.message);
}

/// T07.2 用例 6：workbench_open_workspace(recent 内路径) → 成功复授权。
#[test]
fn open_workspace_reauthorizes_recent_path() {
    let temp = TestDir::new();
    let root = temp.path().join("project");
    fs::create_dir(&root).expect("create root");
    let config_dir = temp.path().join("config");
    fs::create_dir(&config_dir).expect("create config dir");
    // 预置 recent 文件（模拟上次会话授权记录）
    let recent_path = config_dir.join(RECENT_FILE_NAME);
    fs::write(
        &recent_path,
        serde_json::to_string(&vec![root.to_string_lossy().to_string()]).expect("json"),
    )
    .expect("write recent file");

    let reg = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init");
    let canonical = reg
        .register(&root, RegisterSource::RecentList)
        .expect("recent path should be re-authorized");
    assert_eq!(
        canonical,
        strip_verbatim_prefix(&root.canonicalize().expect("canonical root"))
    );
    // 授权成功后回写 recent 文件仍存在且含该路径
    let persisted: Vec<String> =
        serde_json::from_str(&fs::read_to_string(&recent_path).expect("read recent"))
            .expect("parse recent");
    assert!(persisted.contains(&root.to_string_lossy().to_string()));
}

/// 重启后多目录项目的 recent 根可整批复授权，primary 成为活动根。
#[test]
fn recent_batch_reauthorizes_all_project_roots_and_activates_primary() {
    let temp = TestDir::new();
    let primary = temp.path().join("project-primary");
    let secondary = temp.path().join("project-secondary");
    fs::create_dir(&primary).expect("create primary root");
    fs::create_dir(&secondary).expect("create secondary root");
    let config_dir = temp.path().join("config");
    fs::create_dir(&config_dir).expect("create config dir");
    let recent_file = config_dir.join(RECENT_FILE_NAME);
    fs::write(
        &recent_file,
        serde_json::to_string(&vec![
            primary.to_string_lossy().into_owned(),
            secondary.to_string_lossy().into_owned(),
        ])
        .expect("serialize recent roots"),
    )
    .expect("write recent roots");

    let reg = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init registry");
    let registered = reg
        .register_recent_paths(&[primary.clone(), secondary.clone()], &primary, true)
        .expect("all recent roots should authorize together");
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build mock Tauri app");
    sync_asset_scope(app.handle(), &registered.roots).expect("sync every canonical recent root");
    assert!(app
        .asset_protocol_scope()
        .is_allowed(primary.join("image.png")));
    assert!(app
        .asset_protocol_scope()
        .is_allowed(secondary.join("image.png")));

    let canonical_primary = registered.primary;
    assert_eq!(registered.roots.len(), 2);

    assert_eq!(
        canonical_primary,
        strip_verbatim_prefix(&primary.canonicalize().expect("canonical primary"))
    );
    assert_eq!(reg.active_root(), Some(canonical_primary));
    assert_eq!(
        reg.resolve_guard(&secondary.to_string_lossy())
            .expect("secondary root must be registered")
            .root(),
        &strip_verbatim_prefix(&secondary.canonicalize().expect("canonical secondary"))
    );
}

/// 修改非活动项目时仍整批登记所有 recent 根，但不得改变当前活动根。
#[test]
fn recent_batch_can_preserve_active_root_for_inactive_project_edit() {
    let temp = TestDir::new();
    let active = temp.path().join("active-project");
    let primary = temp.path().join("inactive-primary");
    let secondary = temp.path().join("inactive-secondary");
    fs::create_dir(&active).expect("create active root");
    fs::create_dir(&primary).expect("create primary root");
    fs::create_dir(&secondary).expect("create secondary root");
    let config_dir = temp.path().join("config");
    fs::create_dir(&config_dir).expect("create config dir");

    let reg = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init registry");
    let active = reg
        .register_dialog_paths(&[active], true)
        .expect("register current native selection")
        .remove(0);
    reg.register_dialog_paths(&[primary.clone(), secondary.clone()], false)
        .expect("register inactive project roots without switching");
    assert_eq!(reg.active_root(), Some(active.clone()));

    let registered = reg
        .register_recent_paths(&[primary.clone(), secondary.clone()], &primary, false)
        .expect("reauthorize every inactive project root");
    let canonical_primary = registered.primary;
    assert_eq!(registered.roots.len(), 2);

    assert_eq!(
        canonical_primary,
        strip_verbatim_prefix(&primary.canonicalize().expect("canonical primary"))
    );
    assert_eq!(reg.active_root(), Some(active));
    assert!(reg.resolve_guard(&secondary.to_string_lossy()).is_ok());
}

/// 多目录复授权只要有一个未在 recent/default，整批不得改 registry 或 recent 文件。
#[test]
fn recent_batch_rejects_untrusted_root_without_partial_state_change() {
    let temp = TestDir::new();
    let trusted = temp.path().join("recent-root");
    let untrusted = temp.path().join("untrusted-root");
    fs::create_dir(&trusted).expect("create trusted root");
    fs::create_dir(&untrusted).expect("create untrusted root");
    let config_dir = temp.path().join("config");
    fs::create_dir(&config_dir).expect("create config dir");
    let recent_file = config_dir.join(RECENT_FILE_NAME);
    let recent_json = serde_json::to_string(&vec![trusted.to_string_lossy().into_owned()])
        .expect("serialize recent root");
    fs::write(&recent_file, &recent_json).expect("write recent root");

    let reg = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init registry");
    let roots_before = reg.roots();
    let active_before = reg.active_root();

    let err = reg
        .register_recent_paths(
            &[trusted, untrusted],
            &temp.path().join("recent-root"),
            true,
        )
        .expect_err("one untrusted root must reject the entire batch");

    assert_eq!(err.code, ERR_WORKSPACE_NOT_GRANTED, "err: {}", err.message);
    assert_eq!(reg.roots(), roots_before);
    assert_eq!(reg.active_root(), active_before);
    assert_eq!(
        fs::read_to_string(recent_file).expect("read recent"),
        recent_json
    );
}

#[test]
fn recent_single_scope_sync_failure_leaves_registry_and_recent_file_unchanged() {
    let temp = TestDir::new();
    let active_root = temp.path().join("active-root");
    let recent_root = temp.path().join("recent-root");
    fs::create_dir(&active_root).expect("create active root");
    fs::create_dir(&recent_root).expect("create recent root");
    let active_root = strip_verbatim_prefix(
        &active_root
            .canonicalize()
            .expect("canonicalize active root"),
    );
    let recent_root = strip_verbatim_prefix(
        &recent_root
            .canonicalize()
            .expect("canonicalize recent root"),
    );
    let config_dir = temp.path().join("config");
    fs::create_dir(&config_dir).expect("create config dir");
    let recent_file = config_dir.join(RECENT_FILE_NAME);
    let recent = vec![recent_root.clone()];
    let recent_json = serde_json::to_string(
        &recent
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
    )
    .expect("serialize recent root");
    fs::write(&recent_file, &recent_json).expect("write recent root");

    let registry = WorkspaceRegistry {
        inner: Mutex::new(RegistryInner {
            roots: vec![WorkspaceRoot {
                path: active_root,
                source: RegisterSource::Dialog,
            }],
            active: Some(0),
            recent,
            config_dir,
        }),
    };
    let (roots_before, active_before, recent_before) = {
        let inner = registry.inner.lock().expect("lock registry");
        (inner.roots.clone(), inner.active, inner.recent.clone())
    };

    let error = registry
        .register_recent_paths_with(
            std::slice::from_ref(&recent_root),
            &recent_root,
            true,
            |_| {
                Err(FileCommandError::new(
                    ERR_INTERNAL,
                    "injected asset scope synchronization failure",
                ))
            },
        )
        .expect_err("scope synchronization failure must reject registration");

    assert_eq!(error.code, ERR_INTERNAL);
    let inner = registry.inner.lock().expect("lock registry after failure");
    assert_eq!(inner.roots, roots_before);
    assert_eq!(inner.active, active_before);
    assert_eq!(inner.recent, recent_before);
    assert_eq!(
        fs::read_to_string(&recent_file).expect("read recent after failure"),
        recent_json
    );
    assert!(!recent_file.with_extension("json.tmp").exists());
}

#[test]
fn recent_batch_scope_sync_failure_leaves_registry_and_recent_file_unchanged() {
    let temp = TestDir::new();
    let active_root = temp.path().join("active-root");
    let first_recent_root = temp.path().join("first-recent-root");
    let primary_recent_root = temp.path().join("primary-recent-root");
    fs::create_dir(&active_root).expect("create active root");
    fs::create_dir(&first_recent_root).expect("create first recent root");
    fs::create_dir(&primary_recent_root).expect("create primary recent root");
    let active_root = strip_verbatim_prefix(
        &active_root
            .canonicalize()
            .expect("canonicalize active root"),
    );
    let first_recent_root = strip_verbatim_prefix(
        &first_recent_root
            .canonicalize()
            .expect("canonicalize first recent root"),
    );
    let primary_recent_root = strip_verbatim_prefix(
        &primary_recent_root
            .canonicalize()
            .expect("canonicalize primary recent root"),
    );
    let config_dir = temp.path().join("config");
    fs::create_dir(&config_dir).expect("create config dir");
    let recent_file = config_dir.join(RECENT_FILE_NAME);
    let recent = vec![first_recent_root.clone(), primary_recent_root.clone()];
    let recent_json = serde_json::to_string(
        &recent
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
    )
    .expect("serialize recent roots");
    fs::write(&recent_file, &recent_json).expect("write recent roots");

    let registry = WorkspaceRegistry {
        inner: Mutex::new(RegistryInner {
            roots: vec![WorkspaceRoot {
                path: active_root,
                source: RegisterSource::Dialog,
            }],
            active: Some(0),
            recent,
            config_dir,
        }),
    };
    let (roots_before, active_before, recent_before) = {
        let inner = registry.inner.lock().expect("lock registry");
        (inner.roots.clone(), inner.active, inner.recent.clone())
    };
    let requested_roots = [first_recent_root, primary_recent_root.clone()];

    let error = registry
        .register_recent_paths_with(&requested_roots, &primary_recent_root, true, |_| {
            Err(FileCommandError::new(
                ERR_INTERNAL,
                "injected asset scope synchronization failure",
            ))
        })
        .expect_err("scope synchronization failure must reject the batch");

    assert_eq!(error.code, ERR_INTERNAL);
    let inner = registry.inner.lock().expect("lock registry after failure");
    assert_eq!(inner.roots, roots_before);
    assert_eq!(inner.active, active_before);
    assert_eq!(inner.recent, recent_before);
    assert_eq!(
        fs::read_to_string(&recent_file).expect("read recent after failure"),
        recent_json
    );
    assert!(!recent_file.with_extension("json.tmp").exists());
}
