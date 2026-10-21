//! 技能副本的写入与卸载。
//!
//! 导入只允许落在两处本应用技能库：
//! - 已授权工作区下的 `.conex/skills/<标识>/SKILL.md`
//! - 用户主目录下的 `.crish/skills/<标识>/SKILL.md`
//!
//! 调用方不能传入任意目标路径。卸载把该技能目录送进回收站，不碰外部软件里的原件。

use std::path::{Path, PathBuf};

use crate::core_error::CoreError;
use crate::fs_commands::skills::{canonicalize_within_roots, home_dir};
use crate::fs_commands::types::{path_is_same_or_child, MAX_TEXT_FILE_BYTES};

#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnedSkillWrite {
    pub(crate) skill_path: String,
    pub(crate) skill_dir: String,
    pub(crate) scope: String,
    pub(crate) removed: bool,
}

pub(crate) fn mutate_owned_skill<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    action: &str,
    scope: &str,
    workspace_path: Option<&str>,
    slug: &str,
    content: Option<&str>,
    overwrite: bool,
) -> Result<OwnedSkillWrite, CoreError> {
    let slug = validate_skill_slug(slug)?;
    let location = resolve_owned_skill_dir(app, scope, workspace_path, slug)?;
    match action {
        "install" => install_owned_skill(&location, slug, content, overwrite),
        "remove" => remove_owned_skill(&location, slug),
        _ => Err(CoreError::invalid_input("技能操作无效")),
    }
}

fn validate_skill_slug(slug: &str) -> Result<&str, CoreError> {
    let slug = slug.trim();
    if slug.is_empty()
        || slug.len() > 120
        || slug.starts_with('.')
        || slug.contains(['/', '\\', '\0', ':'])
        || !slug
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(CoreError::invalid_input("技能名称无效"));
    }
    Ok(slug)
}

struct OwnedSkillLocation {
    library: PathBuf,
    dir: PathBuf,
    scope: &'static str,
    anchor: PathBuf,
    library_root_name: &'static str,
}

fn resolve_owned_skill_dir<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    scope: &str,
    workspace_path: Option<&str>,
    slug: &str,
) -> Result<OwnedSkillLocation, CoreError> {
    use tauri::Manager as _;
    match scope {
        "project" => {
            let ws = workspace_path.unwrap_or("").trim();
            if ws.is_empty() {
                return Err(CoreError::invalid_input("未打开工作区，无法写入项目技能"));
            }
            let reg = app
                .try_state::<crate::workspace::WorkspaceRegistry>()
                .ok_or_else(|| CoreError::internal("工作区注册表未就绪，无法写入项目技能"))?;
            let roots = reg.roots();
            let anchor = canonicalize_within_roots(ws, &roots).map_err(CoreError::InvalidInput)?;
            let library = anchor.join(".conex").join("skills");
            Ok(OwnedSkillLocation {
                dir: library.join(slug),
                library,
                scope: "project",
                anchor,
                library_root_name: ".conex",
            })
        }
        "global" => {
            let anchor = home_dir()
                .ok_or_else(|| CoreError::invalid_input("未获取到用户主目录，无法写入全局技能"))?;
            let library = anchor.join(".crish").join("skills");
            Ok(OwnedSkillLocation {
                dir: library.join(slug),
                library,
                scope: "global",
                anchor,
                library_root_name: ".crish",
            })
        }
        _ => Err(CoreError::invalid_input("技能作用域无效")),
    }
}

fn reject_symlink(path: &Path) -> Result<(), CoreError> {
    if let Ok(meta) = std::fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() {
            return Err(CoreError::invalid_input("技能库路径不能是符号链接"));
        }
    }
    Ok(())
}

fn reject_owned_tree_symlinks(location: &OwnedSkillLocation) -> Result<(), CoreError> {
    reject_symlink(&location.anchor.join(location.library_root_name))?;
    reject_symlink(&location.library)?;
    reject_symlink(&location.dir)?;
    Ok(())
}

fn install_owned_skill(
    location: &OwnedSkillLocation,
    slug: &str,
    content: Option<&str>,
    overwrite: bool,
) -> Result<OwnedSkillWrite, CoreError> {
    let body = content.unwrap_or("").trim();
    if body.is_empty() {
        return Err(CoreError::invalid_input("技能正文为空，无法导入"));
    }
    if body.len() > MAX_TEXT_FILE_BYTES {
        return Err(CoreError::invalid_input("技能正文超过大小上限"));
    }
    reject_owned_tree_symlinks(location)?;
    std::fs::create_dir_all(&location.dir)
        .map_err(|err| CoreError::Io(format!("无法创建技能目录：{err}")))?;
    let canonical_dir = confirm_owned_skill_dir(location, slug)?;
    let file_path = canonical_dir.join("SKILL.md");
    reject_symlink(&file_path)?;
    if file_path.exists() && !overwrite {
        return Err(CoreError::invalid_input(format!(
            "已存在：{}",
            file_path.display()
        )));
    }
    std::fs::write(&file_path, body.as_bytes())
        .map_err(|err| CoreError::Io(format!("无法写入技能文件：{err}")))?;
    Ok(OwnedSkillWrite {
        skill_path: file_path.to_string_lossy().to_string(),
        skill_dir: canonical_dir.to_string_lossy().to_string(),
        scope: location.scope.to_string(),
        removed: false,
    })
}

fn remove_owned_skill(
    location: &OwnedSkillLocation,
    slug: &str,
) -> Result<OwnedSkillWrite, CoreError> {
    if !location.dir.exists() {
        return Ok(OwnedSkillWrite {
            skill_path: location.dir.join("SKILL.md").to_string_lossy().to_string(),
            skill_dir: location.dir.to_string_lossy().to_string(),
            scope: location.scope.to_string(),
            removed: false,
        });
    }
    reject_owned_tree_symlinks(location)?;
    let canonical_dir = confirm_owned_skill_dir(location, slug)?;
    let trash_root = location.anchor.join(".crish-trash");
    reject_symlink(&trash_root)?;
    std::fs::create_dir_all(&trash_root)
        .map_err(|err| CoreError::Io(format!("无法准备技能回收站：{err}")))?;
    conex_fs::trash::TrashService::new(&trash_root)
        .trash_file(&canonical_dir, false)
        .map_err(|err| CoreError::Io(format!("卸载技能副本失败：{err}")))?;
    Ok(OwnedSkillWrite {
        skill_path: canonical_dir.join("SKILL.md").to_string_lossy().to_string(),
        skill_dir: canonical_dir.to_string_lossy().to_string(),
        scope: location.scope.to_string(),
        removed: true,
    })
}

/// 规范化后的目录必须正好是「锚点/.conex|crish/skills/标识」。
/// 技能库本身是符号链接时，包含判断会跟着链接落到库外，这里用锚点把那条路堵上。
fn confirm_owned_skill_dir(
    location: &OwnedSkillLocation,
    slug: &str,
) -> Result<PathBuf, CoreError> {
    let anchor = location
        .anchor
        .canonicalize()
        .map_err(|err| CoreError::Io(format!("无法确认技能库锚点：{err}")))?;
    let library = location
        .library
        .canonicalize()
        .map_err(|err| CoreError::Io(format!("无法确认技能库：{err}")))?;
    let canonical = location
        .dir
        .canonicalize()
        .map_err(|err| CoreError::Io(format!("无法确认技能目录：{err}")))?;
    if !path_is_same_or_child(&canonical, &library) || canonical == library {
        return Err(CoreError::invalid_input("技能目录越出技能库"));
    }
    let skills_dir = canonical
        .parent()
        .ok_or_else(|| CoreError::invalid_input("技能目录越出技能库"))?;
    let root_dir = skills_dir
        .parent()
        .ok_or_else(|| CoreError::invalid_input("技能目录越出技能库"))?;
    let anchor_of_dir = root_dir
        .parent()
        .ok_or_else(|| CoreError::invalid_input("技能目录越出技能库"))?;
    let slug_name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let skills_name = skills_dir
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let root_name = root_dir
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if slug_name != slug || skills_name != "skills" || root_name != location.library_root_name {
        return Err(CoreError::invalid_input("技能目录名与标识不一致"));
    }
    let anchored = path_is_same_or_child(anchor_of_dir, &anchor)
        && path_is_same_or_child(&anchor, anchor_of_dir);
    if !anchored {
        return Err(CoreError::invalid_input("技能目录越出技能库"));
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::disallowed_methods)]

    use std::{
        env, fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct TempRoot {
        path: PathBuf,
    }

    impl TempRoot {
        fn new() -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time")
                .as_nanos();
            let path =
                env::temp_dir().join(format!("conex-owned-skill-{}-{nanos}", std::process::id()));
            fs::create_dir_all(&path).expect("create temp");
            Self { path }
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    /// 技能副本只能写进技能库，卸载后目录进入回收站。
    #[test]
    fn installs_and_removes_project_copy() {
        use crate::workspace::{RegisterSource, WorkspaceRegistry};

        let temp = TempRoot::new();
        let auth_root = temp.path.join("auth");
        fs::create_dir_all(&auth_root).expect("create auth root");
        let config_dir = temp.path.join("config");
        fs::create_dir_all(&config_dir).expect("create config dir");
        let reg = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init registry");
        reg.register(&auth_root, RegisterSource::Dialog)
            .expect("register auth root");
        let app = tauri::test::mock_builder()
            .manage(reg)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let handle = app.handle();
        let workspace = auth_root.to_string_lossy().into_owned();

        let rejected = super::mutate_owned_skill(
            handle,
            "install",
            "project",
            Some(workspace.as_str()),
            "../evil",
            Some("body"),
            true,
        );
        assert!(rejected.is_err(), "越界技能标识必须拒绝");

        let installed = super::mutate_owned_skill(
            handle,
            "install",
            "project",
            Some(workspace.as_str()),
            "demo-skill",
            Some("---\nname: demo-skill\ndescription: owned\n---\n正文\n"),
            true,
        )
        .expect("项目技能副本应写入成功");
        let skill_file = auth_root
            .join(".conex")
            .join("skills")
            .join("demo-skill")
            .join("SKILL.md");
        assert!(skill_file.is_file(), "技能文件应落在项目技能库");
        assert!(installed.skill_path.contains("demo-skill"));

        let again = super::mutate_owned_skill(
            handle,
            "install",
            "project",
            Some(workspace.as_str()),
            "demo-skill",
            Some("body"),
            false,
        );
        assert!(again.is_err(), "未允许覆盖时必须拒绝已存在的技能");

        let removed = super::mutate_owned_skill(
            handle,
            "remove",
            "project",
            Some(workspace.as_str()),
            "demo-skill",
            None,
            false,
        )
        .expect("卸载技能副本应成功");
        assert!(removed.removed, "应报告已卸载");
        assert!(!skill_file.exists(), "卸载后技能文件不应留在技能库");

        let missing = super::mutate_owned_skill(
            handle,
            "remove",
            "project",
            Some(workspace.as_str()),
            "demo-skill",
            None,
            false,
        )
        .expect("再次卸载不存在的副本应成功");
        assert!(!missing.removed, "目录已不存在时不应再报告删除");
    }
}
