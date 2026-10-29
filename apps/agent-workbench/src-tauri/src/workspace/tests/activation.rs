use super::*;

#[test]
fn activate_default_root_restores_registered_root_after_project_switch() {
    let temp = TestDir::new();
    let default_root = temp.path().join("default-root");
    let project_root = temp.path().join("active-project");
    fs::create_dir(&default_root).expect("create default root");
    fs::create_dir(&project_root).expect("create project root");
    let config_dir = temp.path().join("config");
    fs::create_dir(&config_dir).expect("create config dir");

    let reg = make_root_registry(&default_root, &config_dir);
    let project = reg
        .register_dialog_paths(std::slice::from_ref(&project_root), true)
        .expect("register selected project")
        .remove(0);
    assert_eq!(reg.active_root(), Some(project));

    let activated = reg
        .activate_registered_root(&default_root)
        .expect("registered default root should reactivate");
    let canonical_default =
        strip_verbatim_prefix(&default_root.canonicalize().expect("canonical default root"));
    assert_eq!(activated, canonical_default);
    assert_eq!(reg.active_root(), Some(canonical_default));
}

#[test]
fn activate_default_root_rejects_unregistered_path_without_mutation() {
    let temp = TestDir::new();
    let active_root = temp.path().join("active-project");
    let unregistered_root = temp.path().join("unregistered-root");
    fs::create_dir(&active_root).expect("create active root");
    fs::create_dir(&unregistered_root).expect("create unregistered root");
    let config_dir = temp.path().join("config");
    fs::create_dir(&config_dir).expect("create config dir");

    let reg = make_root_registry(&active_root, &config_dir);
    let roots_before = reg.roots();
    let active_before = reg.active_root();

    let error = reg
        .activate_registered_root(&unregistered_root)
        .expect_err("unregistered root must not be activated");

    assert_eq!(error.code, ERR_WORKSPACE_NOT_GRANTED);
    assert_eq!(reg.roots(), roots_before);
    assert_eq!(reg.active_root(), active_before);
}

#[test]
fn default_root_scope_sync_failure_preserves_registry_and_recent_file() {
    let temp = TestDir::new();
    let default_root = temp.path().join("default-root");
    let active_root = temp.path().join("active-project");
    fs::create_dir(&default_root).expect("create default root");
    fs::create_dir(&active_root).expect("create active root");
    let config_dir = temp.path().join("config");
    fs::create_dir(&config_dir).expect("create config dir");
    let registry = make_root_registry(&default_root, &config_dir);
    registry
        .register_dialog_paths(std::slice::from_ref(&active_root), true)
        .expect("register active project");
    let recent_file = config_dir.join(RECENT_FILE_NAME);
    let recent_before_bytes = fs::read(&recent_file).expect("snapshot recent file");
    let (roots_before, active_before, recent_before) = {
        let inner = registry.inner.lock().expect("lock registry");
        (inner.roots.clone(), inner.active, inner.recent.clone())
    };
    let error = registry
        .activate_registered_root_with(&default_root, |_| {
            Err(FileCommandError::new(
                ERR_INTERNAL,
                "injected scope failure",
            ))
        })
        .expect_err("scope synchronization failure must reject activation");
    assert_eq!(error.code, ERR_INTERNAL);
    let inner = registry.inner.lock().expect("lock registry after failure");
    assert_eq!(inner.roots, roots_before);
    assert_eq!(inner.active, active_before);
    assert_eq!(inner.recent, recent_before);
    assert_eq!(
        fs::read(recent_file).expect("read recent after failure"),
        recent_before_bytes
    );
}
