use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::core_error::CoreError;

/// 技能发现命令（PE-07 T07.2 审计面：skills.rs）。
///
/// - `workspace_path`：改为经 WorkspaceRegistry 解析——必须位于已授权根内
///   （canonicalize + 前缀包含校验），否则 `workspace_not_granted`；
/// - `extra_dirs`：越界目录或外部软件技能目录跳过，不拖垮本次发现；
/// - 用户主目录全局技能（只读发现）保持既有行为。

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RustSkill {
    pub(crate) file_path: String,
    pub(crate) base_dir: String,
    pub(crate) content: String,
    pub(crate) raw: String,
    pub(crate) scope: String,
    pub(crate) system: bool,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) tags: Vec<String>,
    pub(crate) applies_to: Vec<String>,
    pub(crate) disable_model_invocation: bool,
    pub(crate) file_activation: Option<String>,
}

impl RustSkill {
    /// 技能名（C10 注入段条目用）
    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    /// 技能描述（C10 注入段条目用）
    pub(crate) fn description(&self) -> &str {
        &self.description
    }

    /// 技能正文（SKILL.md body，C10 注入段正文用）
    pub(crate) fn content(&self) -> &str {
        &self.content
    }

    /// 作用域（project / global；同名冲突优先级判定用）
    pub(crate) fn scope(&self) -> &str {
        &self.scope
    }

    /// 是否系统技能（.system 目录 / frontmatter system 标记）
    pub(crate) fn is_system(&self) -> bool {
        self.system
    }
}

/// 错误码：路径未在已授权根内
const ERR_WORKSPACE_NOT_GRANTED: &str = "workspace_not_granted";

fn parse_frontmatter(content: &str) -> (std::collections::HashMap<String, String>, String) {
    let mut data = std::collections::HashMap::new();
    let mut body = content.to_string();
    if let Some(after_open) = content.strip_prefix("---") {
        if let Some(end_idx) = after_open.find("\n---") {
            let raw_fm = &after_open[..end_idx];
            body = after_open[end_idx + 4..].to_string();
            for line in raw_fm.lines() {
                if let Some((key, val)) = line.split_once(':') {
                    let k = key.trim().to_string();
                    let v = val
                        .trim()
                        .trim_matches(|c| c == '"' || c == '\'')
                        .to_string();
                    data.insert(k, v);
                }
            }
        }
    }
    (data, body)
}

fn first_markdown_sentence(content: &str) -> Option<String> {
    for line in content.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() && !trimmed.starts_with('#') {
            let len = trimmed.chars().count().min(160);
            let sentence: String = trimmed.chars().take(len).collect();
            return Some(sentence);
        }
    }
    None
}

fn parse_string_list(v: &str) -> Vec<String> {
    v.split(&[',', '[', ']'][..])
        .map(|s| s.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn load_skill_file_rust(file_path: &Path, scope: &str, system: bool) -> Option<RustSkill> {
    let raw = std::fs::read_to_string(file_path).ok()?;
    let (fm, body) = parse_frontmatter(&raw);

    let base_dir = file_path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let file_path_str = file_path.to_string_lossy().to_string();

    let fallback_name = file_path
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "skill".to_string())
        .replace(|c: char| !c.is_alphanumeric() && c != '-', "-")
        .trim_matches('-')
        .to_string();

    let name = fm.get("name").cloned().unwrap_or(fallback_name);

    let description = fm
        .get("description")
        .cloned()
        .unwrap_or_else(|| first_markdown_sentence(&body).unwrap_or_else(|| name.clone()));

    let applies_to = fm
        .get("applies-to")
        .or_else(|| fm.get("appliesTo"))
        .map(|val| parse_string_list(val))
        .unwrap_or_default();

    let tags = fm
        .get("tags")
        .map(|val| parse_string_list(val))
        .unwrap_or_default();

    let disable_model_invocation = fm
        .get("disable-model-invocation")
        .or_else(|| fm.get("disableModelInvocation"))
        .map(|val| val == "true")
        .unwrap_or(false);

    let file_activation = fm.get("activation").cloned();

    let system_in_fm = fm.get("system").map(|val| val == "true").unwrap_or(false);
    let is_system = system || file_path_str.contains(".system") || system_in_fm;

    Some(RustSkill {
        file_path: file_path_str,
        base_dir,
        content: body.trim().to_string(),
        raw,
        scope: scope.to_string(),
        system: is_system,
        name,
        description,
        tags,
        applies_to,
        disable_model_invocation,
        file_activation,
    })
}

fn discover_in_dir_rust(
    dir: &Path,
    scope: &str,
    depth: usize,
    system: bool,
    skills: &mut Vec<RustSkill>,
) {
    if depth > 5 {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    let mut has_skill_md = false;
    let mut skill_md_path = None;

    let mut subdirs = Vec::new();
    let mut files_at_root = Vec::new();

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let file_name = path.file_name().unwrap_or_default().to_string_lossy();
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };

        if metadata.is_dir() {
            let name_lower = file_name.to_lowercase();
            if name_lower == "node_modules" || name_lower == "__pycache__" {
                continue;
            }
            if name_lower.starts_with('.') && name_lower != ".system" {
                continue;
            }
            subdirs.push((path, name_lower == ".system"));
        } else {
            let name_upper = file_name.to_uppercase();
            if name_upper == "SKILL.MD" {
                has_skill_md = true;
                skill_md_path = Some(path);
            } else if depth == 0 && name_upper.ends_with(".MD") && name_upper != "README.MD" {
                files_at_root.push(path);
            }
        }
    }

    if has_skill_md {
        if let Some(path) = skill_md_path {
            if let Some(skill) = load_skill_file_rust(&path, scope, system) {
                skills.push(skill);
            }
        }
        return;
    }

    for (subdir, is_system_dir) in subdirs {
        discover_in_dir_rust(&subdir, scope, depth + 1, system || is_system_dir, skills);
    }

    for file_path in files_at_root {
        if let Some(skill) = load_skill_file_rust(&file_path, scope, system) {
            skills.push(skill);
        }
    }
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .ok()
        .map(PathBuf::from)
        .or_else(|| std::env::var("HOME").ok().map(PathBuf::from))
}

/// 发现技能（PE-07 T07.2：workspace_path / extra_dirs 经注册表包含性校验）。
///
/// 错误协议（PS-04 T4.5 / F4 F1-02）：统一 `CoreError {kind, detail}`——
/// 路径/注册表类（workspace_not_granted、不可解析）→ InvalidInput（detail
/// 保留现文案）；注册表未托管 → Internal。
///
/// `R: tauri::Runtime` 泛型：测试注入 MockRuntime 可直接调用（先例
/// core_commands.rs:170-177），生产走 Wry。
pub(crate) fn workbench_discover_skills<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_path: Option<String>,
    extra_dirs: Vec<String>,
) -> Result<Vec<RustSkill>, CoreError> {
    use tauri::Manager as _;
    let reg = app
        .try_state::<crate::workspace::WorkspaceRegistry>()
        .ok_or_else(|| {
            CoreError::Internal(
                "internal_error: WorkspaceRegistry is not managed; main.rs setup must call app.manage(WorkspaceRegistry::init()...)".to_string(),
            )
        })?;
    let roots = reg.roots();
    let mut skills = Vec::new();

    // 项目技能：workspace_path 必须位于已授权根内（canonicalize + 前缀包含）
    if let Some(ws) = workspace_path {
        let ws = ws.trim();
        if !ws.is_empty() {
            let ws_path = canonicalize_within_roots(ws, &roots).map_err(CoreError::InvalidInput)?;
            let roots = [
                ws_path.join(".crish").join("skills"),
                ws_path.join(".conex").join("skills"),
            ];
            for r in &roots {
                if r.is_dir() {
                    discover_in_dir_rust(r, "project", 0, false, &mut skills);
                }
            }
        }
    }

    // 全局技能：用户主目录（规范原生技能目录，不强行扫描别家不兼容软件目录）
    if let Some(home) = home_dir() {
        let roots = [
            home.join(".crish").join("skills"),
            home.join(".conex").join("skills"),
        ];
        for r in &roots {
            if r.is_dir() {
                discover_in_dir_rust(r, "global", 0, false, &mut skills);
            }
        }
    }

    // 附加目录越界时跳过。一次失败的外部导入不应当让技能库整体消失。
    for dir in extra_dirs {
        if is_foreign_skill_tree(Path::new(&dir)) {
            continue;
        }
        let path = match canonicalize_within_roots(&dir, &roots) {
            Ok(path) => path,
            Err(_) => continue,
        };
        if is_foreign_skill_tree(&path) {
            continue;
        }
        let scope = if path.is_absolute() {
            "global"
        } else {
            "project"
        };
        discover_in_dir_rust(&path, scope, 0, false, &mut skills);
    }

    Ok(skills)
}

fn is_foreign_skill_tree(path: &Path) -> bool {
    let components: Vec<String> = path
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => Some(value.to_string_lossy().to_lowercase()),
            _ => None,
        })
        .collect();
    let owned_at = components
        .windows(2)
        .position(|pair| (pair[0] == ".conex" || pair[0] == ".crish") && pair[1] == "skills");
    const FOREIGN_APP_DIRS: [&str; 5] = [".codex", ".claude", ".cursor", ".agents", ".gemini"];
    components.iter().enumerate().any(|(index, name)| {
        let marked = FOREIGN_APP_DIRS.contains(&name.as_str());
        marked && owned_at.map(|at| index < at).unwrap_or(true)
    })
}

/// canonicalize 后校验属于任一已授权根；失败时返回未授权文案。
pub(crate) fn canonicalize_within_roots(path: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    if path.contains('\0') {
        return Err(format!(
            "{ERR_WORKSPACE_NOT_GRANTED}: path contains NUL byte"
        ));
    }
    let p = Path::new(path);
    let canonical = p
        .canonicalize()
        .map_err(|e| format!("{ERR_WORKSPACE_NOT_GRANTED}: cannot resolve path `{path}`: {e}"))?;
    if roots
        .iter()
        .any(|root| crate::fs_commands::types::path_is_same_or_child(&canonical, root))
    {
        return Ok(canonical);
    }
    Err(format!(
        "{ERR_WORKSPACE_NOT_GRANTED}: path is outside the authorized workspace root: `{path}`"
    ))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::disallowed_methods)]

    use std::{
        env, fs,
        path::{Path, PathBuf},
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
            let path = env::temp_dir().join(format!(
                "conex-skill-discover-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create temp");
            Self { path }
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    /// 越界附加目录和外部软件技能目录必须跳过，工作区内的技能副本仍然返回。
    #[test]
    fn skips_foreign_and_outside_extra_dirs() {
        use crate::workspace::{RegisterSource, WorkspaceRegistry};

        let temp = TempRoot::new();
        let auth_root = temp.path.join("auth");
        let skill_dir = auth_root.join(".conex").join("skills").join("demo-skill");
        let outside = temp.path.join("outside-skill");
        let foreign = auth_root
            .join(".codex")
            .join("skills")
            .join("poison-inside");
        let tool_root = auth_root.join(".codex");
        let gemini_root = auth_root.join(".gemini");
        let bypass = auth_root
            .join(".codex")
            .join("skills")
            .join("wrap")
            .join(".conex")
            .join("skills")
            .join("poison-bypass");
        fs::create_dir_all(&skill_dir).expect("create owned skill dir");
        fs::create_dir_all(&outside).expect("create outside skill dir");
        fs::create_dir_all(&foreign).expect("create foreign skill dir");
        fs::create_dir_all(tool_root.join("skills").join("poison-root"))
            .expect("create tool root skill dir");
        fs::create_dir_all(
            gemini_root
                .join("antigravity")
                .join("skills")
                .join("poison-gemini"),
        )
        .expect("create gemini skill dir");
        fs::create_dir_all(&bypass).expect("create bypass skill dir");
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: demo-skill\ndescription: owned\n---\nbody\n",
        )
        .expect("write owned skill");
        fs::write(
            outside.join("SKILL.md"),
            "---\nname: poison-outside\ndescription: no\n---\nbody\n",
        )
        .expect("write outside skill");
        fs::write(
            foreign.join("SKILL.md"),
            "---\nname: poison-inside\ndescription: no\n---\nbody\n",
        )
        .expect("write foreign skill");
        fs::write(
            tool_root
                .join("skills")
                .join("poison-root")
                .join("SKILL.md"),
            "---\nname: poison-root\ndescription: no\n---\nbody\n",
        )
        .expect("write tool root skill");
        fs::write(
            gemini_root
                .join("antigravity")
                .join("skills")
                .join("poison-gemini")
                .join("SKILL.md"),
            "---\nname: poison-gemini\ndescription: no\n---\nbody\n",
        )
        .expect("write gemini skill");
        fs::write(
            bypass.join("SKILL.md"),
            "---\nname: poison-bypass\ndescription: no\n---\nbody\n",
        )
        .expect("write bypass skill");
        let config_dir = temp.path.join("config");
        fs::create_dir_all(&config_dir).expect("create config dir");
        let reg = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init registry");
        reg.register(&auth_root, RegisterSource::Dialog)
            .expect("register auth root");
        let app = tauri::test::mock_builder()
            .manage(reg)
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");

        let result = super::workbench_discover_skills(
            app.handle(),
            Some(auth_root.to_string_lossy().into_owned()),
            vec![
                outside.to_string_lossy().into_owned(),
                foreign.to_string_lossy().into_owned(),
                tool_root.to_string_lossy().into_owned(),
                gemini_root.to_string_lossy().into_owned(),
                bypass.to_string_lossy().into_owned(),
            ],
        )
        .expect("越界附加目录不应让发现整体失败");
        let names: Vec<_> = result.into_iter().map(|skill| skill.name).collect();
        assert!(
            names.iter().any(|name| name == "demo-skill"),
            "应返回工作区技能副本，实际 {names:?}"
        );
        assert!(
            !names.iter().any(|name| name.contains("poison")),
            "外部技能目录不应被当成已安装，实际 {names:?}"
        );
    }

    #[test]
    fn foreign_app_roots_are_not_skill_libraries() {
        assert!(super::is_foreign_skill_tree(Path::new(
            "C:/Users/orange/.codex"
        )));
        assert!(super::is_foreign_skill_tree(Path::new(
            "C:/Users/orange/.codex/skills/pkg"
        )));
        assert!(super::is_foreign_skill_tree(Path::new(
            "C:/Users/orange/.gemini"
        )));
        assert!(super::is_foreign_skill_tree(Path::new(
            "C:/Users/orange/.claude"
        )));
        assert!(super::is_foreign_skill_tree(Path::new(
            "C:/Users/orange/.cursor"
        )));
        assert!(super::is_foreign_skill_tree(Path::new(
            "C:/Users/orange/.agents"
        )));
        assert!(super::is_foreign_skill_tree(Path::new(
            "C:/proj/.codex/skills/pkg/.conex/skills/nested"
        )));
        assert!(!super::is_foreign_skill_tree(Path::new(
            "C:/Software/conex/.conex/skills/demo"
        )));
        assert!(!super::is_foreign_skill_tree(Path::new(
            "C:/Users/orange/.crish/skills/demo"
        )));
        assert!(!super::is_foreign_skill_tree(Path::new(
            "C:/Software/conex/.conex/skills/demo/.gemini/notes"
        )));
    }
}
