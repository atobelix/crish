use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RustSkill {
    file_path: String,
    base_dir: String,
    content: String,
    raw: String,
    scope: String,
    system: bool,
    name: String,
    description: String,
    tags: Vec<String>,
    applies_to: Vec<String>,
    disable_model_invocation: bool,
    file_activation: Option<String>,
}

fn parse_frontmatter(content: &str) -> (std::collections::HashMap<String, String>, String) {
    let mut data = std::collections::HashMap::new();
    let mut body = content.to_string();
    if content.starts_with("---") {
        if let Some(end_idx) = content[3..].find("\n---") {
            let actual_end = end_idx + 3;
            let raw_fm = &content[3..actual_end];
            body = content[actual_end + 4..].to_string();
            for line in raw_fm.lines() {
                if let Some((key, val)) = line.split_once(':') {
                    let k = key.trim().to_string();
                    let v = val.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
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
        .unwrap_or_else(|| "".to_string());

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

fn get_home_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .ok()
        .map(PathBuf::from)
        .or_else(|| std::env::var("HOME").ok().map(PathBuf::from))
}

pub(crate) fn workbench_discover_skills(
    workspace_path: Option<String>,
    extra_dirs: Vec<String>,
) -> Result<Vec<RustSkill>, String> {
    let mut skills = Vec::new();

    if let Some(ref ws) = workspace_path {
        let ws_path = Path::new(ws);
        if ws_path.is_dir() {
            let roots = [
                ws_path.join(".conex").join("skills"),
                ws_path.join(".codex").join("skills"),
                ws_path.join(".agents").join("skills"),
                ws_path.join(".claude").join("skills"),
            ];
            for r in &roots {
                if r.is_dir() {
                    discover_in_dir_rust(r, "project", 0, false, &mut skills);
                }
            }
        }
    }

    if let Some(home) = get_home_dir() {
        let roots = [
            home.join(".codex").join("skills"),
            home.join(".conex").join("skills"),
            home.join(".claude").join("skills"),
            home.join(".agents").join("skills"),
            home.join(".grok").join("skills"),
            home.join(".grok").join("bundled").join("skills"),
        ];
        for r in &roots {
            if r.is_dir() {
                discover_in_dir_rust(r, "global", 0, false, &mut skills);
            }
        }
    }

    for dir in extra_dirs {
        let path = Path::new(&dir);
        if path.is_dir() {
            let scope = if path.is_absolute() { "global" } else { "project" };
            discover_in_dir_rust(path, scope, 0, false, &mut skills);
        }
    }

    Ok(skills)
}
