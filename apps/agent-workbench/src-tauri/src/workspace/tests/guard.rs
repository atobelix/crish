use super::*;

/// T07.2 用例 7：recent-workspaces.json 损坏/缺失 → 空列表 + 不 panic。
#[test]
fn corrupt_recent_file_yields_empty_list() {
    let temp = TestDir::new();
    let config_dir = temp.path().join("config");
    fs::create_dir(&config_dir).expect("create config dir");
    fs::write(config_dir.join(RECENT_FILE_NAME), "not-valid-json{{{{")
        .expect("write corrupt recent");
    let reg = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init");
    // 损坏的 recent 不应使注册表初始化失败
    let inner = reg.inner.lock().expect("lock");
    assert!(inner.recent.is_empty());
}

/// T07.2 用例 1：未授权根外绝对路径 → ERR_OUTSIDE_WORKSPACE。
#[test]
fn resolve_guard_rejects_absolute_path_outside_all_roots() {
    let temp = TestDir::new();
    let root = temp.path().join("workspace");
    fs::create_dir(&root).expect("create root");
    let outside = temp.path().join("outside");
    fs::create_dir(&outside).expect("create outside");
    let reg = make_root_registry(&root, temp.path());

    let err = reg
        .resolve_guard(&outside.to_string_lossy())
        .expect_err("outside path must be rejected");
    assert_eq!(err.code, ERR_OUTSIDE_WORKSPACE);
}

/// T07.2 用例 11：drive-relative 变体（`C:foo`）不得放行到系统盘。
#[cfg(windows)]
#[test]
fn resolve_guard_handles_drive_relative_path() {
    let temp = TestDir::new();
    let root = temp.path().join("workspace");
    fs::create_dir(&root).expect("create root");
    let reg = make_root_registry(&root, temp.path());

    // drive-relative（`C:foo`）在 Rust 中非绝对路径 → 以活动根为基准，
    // 守卫内部包含性校验保证不越界（不得误放行到系统盘）。
    let guard = reg
        .resolve_guard("C:foo")
        .expect("drive-relative resolves against active root");
    // 注意：resolve_existing 对不存在的路径返回 ERR_NOT_FOUND（未越界）
    let err = guard.resolve_existing("C:foo").expect_err("not exists");
    assert_eq!(err.code, crate::fs_commands::types::ERR_NOT_FOUND);
}

/// T07.2 用例 12：UNC / `\\?\` 前缀路径 canonicalize 后越界判定一致（拒绝）。
#[cfg(windows)]
#[test]
fn resolve_guard_rejects_unc_and_verbatim_prefix() {
    let temp = TestDir::new();
    let root = temp.path().join("workspace");
    fs::create_dir(&root).expect("create root");
    let reg = make_root_registry(&root, temp.path());

    // 不存在的 UNC 路径：canonicalize 失败 → 拒绝（not_found / read_file / outside 均可）
    let err = reg
        .resolve_guard(r"\\server\share\some\file.txt")
        .expect_err("UNC must not be granted");
    assert_ne!(err.code, ERR_INTERNAL, "err: {:?}", err.code);
    // `\\?\` 前缀路径同样拒绝
    let verbatim = format!(r"\\?\{}\\nested.txt", root.to_string_lossy());
    let err = reg
        .resolve_guard(&verbatim)
        .expect_err("verbatim path must not be granted");
    assert_ne!(err.code, ERR_INTERNAL, "err: {:?}", err.code);
}

/// T07.2 用例 13：根不可达（canonicalize 全失败）→ 拒绝 + 明确错误，不裸用传入根。
#[test]
fn register_rejects_unreachable_root() {
    let temp = TestDir::new();
    let reg = WorkspaceRegistry::init_with_config_dir(temp.path()).expect("init");
    let missing = temp.path().join("no-such-drive-root");
    let err = reg
        .register(&missing, RegisterSource::Dialog)
        .expect_err("unreachable root must be rejected");
    assert_eq!(err.code, ERR_WORKSPACE_NOT_GRANTED, "err: {}", err.message);
    assert!(
        err.message.contains("cannot resolve"),
        "err: {}",
        err.message
    );
}

/// 相对路径解析：以活动根为基准，`..` 越界由守卫二次校验拒绝。
#[test]
fn resolve_guard_relative_paths_join_active_root() {
    let temp = TestDir::new();
    let root = temp.path().join("workspace");
    fs::create_dir(&root).expect("create root");
    fs::create_dir(root.join("nested")).expect("create nested");
    let reg = make_root_registry(&root, temp.path());

    let guard = reg
        .resolve_guard("")
        .expect("empty path resolves to active root");
    assert_eq!(
        guard.root(),
        &strip_verbatim_prefix(&root.canonicalize().expect("canon"))
    );

    let guard = reg
        .resolve_guard("nested")
        .expect("relative path resolves to active root");
    assert_eq!(
        guard.root(),
        &strip_verbatim_prefix(&root.canonicalize().expect("canon"))
    );
}

/// 根内子目录绝对路径：前缀匹配授权。
#[test]
fn resolve_guard_allows_path_inside_root() {
    let temp = TestDir::new();
    let root = temp.path().join("workspace");
    fs::create_dir_all(root.join("src")).expect("create root");
    let inside = root.join("src").join("main.rs");
    fs::write(&inside, "fn main() {}").expect("write file");
    let reg = make_root_registry(&root, temp.path());

    let guard = reg
        .resolve_guard(&inside.to_string_lossy())
        .expect("path inside root must resolve");
    assert_eq!(
        guard.root(),
        &strip_verbatim_prefix(&root.canonicalize().expect("canon"))
    );
}

/// 根前缀相似但不包含（`/home/proj` vs `/home/proj2` 语义）→ 拒绝。
#[test]
fn resolve_guard_rejects_sibling_prefix_path() {
    let temp = TestDir::new();
    let root = temp.path().join("workspace");
    fs::create_dir(&root).expect("create root");
    let sibling = temp.path().join("workspace2");
    fs::create_dir(&sibling).expect("create sibling");
    let reg = make_root_registry(&root, temp.path());

    let err = reg
        .resolve_guard(&sibling.to_string_lossy())
        .expect_err("sibling prefix path must be rejected");
    assert_eq!(err.code, ERR_OUTSIDE_WORKSPACE);
}

/// 多根：任一已授权根内路径均可解析。
#[test]
fn resolve_guard_accepts_any_authorized_root() {
    let temp = TestDir::new();
    let root_a = temp.path().join("proj-a");
    let root_b = temp.path().join("proj-b");
    fs::create_dir_all(root_a.join("sub")).expect("create a");
    fs::create_dir_all(root_b.join("sub")).expect("create b");
    let file_b = root_b.join("sub").join("note.txt");
    fs::write(&file_b, "b").expect("write b");
    let reg = WorkspaceRegistry::init_with_config_dir(temp.path()).expect("init");
    reg.register(&root_a, RegisterSource::Dialog)
        .expect("register a");
    reg.register(&root_b, RegisterSource::Dialog)
        .expect("register b");

    let guard = reg
        .resolve_guard(&file_b.to_string_lossy())
        .expect("file under root_b must resolve");
    assert_eq!(
        guard.root(),
        &strip_verbatim_prefix(&root_b.canonicalize().expect("canon"))
    );
}
