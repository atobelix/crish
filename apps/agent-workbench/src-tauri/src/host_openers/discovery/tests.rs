//! 快捷方式候选路径的信任边界（Start Menu 根内 + .lnk 后缀）。

use super::trusted_shortcut_path_with_roots;
use std::path::PathBuf;

#[test]
fn shortcut_path_must_be_a_link_inside_a_canonical_start_menu_root() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let root = temp.path().join("Programs");
    let outside = temp.path().join("Programs-Evil");
    std::fs::create_dir_all(&root).expect("create Start Menu root");
    std::fs::create_dir_all(&outside).expect("create sibling directory");
    let trusted = root.join("Editor.lnk");
    let sibling = outside.join("Editor.lnk");
    let wrong_extension = root.join("Editor.exe");
    std::fs::write(&trusted, b"link").expect("create trusted link");
    std::fs::write(&sibling, b"link").expect("create sibling link");
    std::fs::write(&wrong_extension, b"not a link").expect("create executable");
    let roots = vec![root.clone()];

    assert_eq!(
        trusted_shortcut_path_with_roots(&trusted, &roots),
        Some(trusted.canonicalize().unwrap())
    );
    assert!(trusted_shortcut_path_with_roots(&sibling, &roots).is_none());
    assert!(trusted_shortcut_path_with_roots(&wrong_extension, &roots).is_none());
    assert!(trusted_shortcut_path_with_roots(&PathBuf::from("missing.lnk"), &roots).is_none());
}
