// 技能域操作实现（server 层 SkillsOps 的 Tauri 装配实现，G7）。
// 读与桌面「设置 → 扩展 → 技能」页同一份真源：宿主技能发现函数
// crate::fs_commands::skills::workbench_discover_skills（桌面技能页
// 主路径经 Tauri 命令 workbench_discover_skills 消费同一函数）——
// 扫描活动工作区 .crish/.conex skills 目录（project）与用户主目录
// 同名目录（global）的 SKILL.md 并解析 frontmatter；本层只做跨端
// 轻量投影（不带正文/raw），不另建移动端技能表。
//
// 诚实边界（2026-11-01 G7 查实）：
// - 技能启停（activation）的生效值不是宿主数据：真源在桌面 webview
//   localStorage（crish_skill_activation_v1，T03.7 起显式本地-only），
//   宿主侧无可远程读写的启停存储——本域只有只读 list，无启停写面，
//   投影也不含任何冒充生效状态的字段（fileActivation 仅为文件
//   frontmatter 声明的缺省，语义见协议层 SkillEntry 文档）；
// - 附加技能目录（extra dirs）同样存桌面 localStorage 并逐次调用
//   传入发现函数，远程不可见——本层恒传空 extra_dirs，经附加目录
//   引入的技能不出现在结果中（桌面本地专属面，不伪造可见）。
use std::collections::HashSet;
use std::sync::Arc;

use conex_device_protocol::{ListSkillsResult, SkillEntry};
use sha2::{Digest, Sha256};

use crate::fs_commands::skills::{workbench_discover_skills, RustSkill};
use crate::server::backend::SkillsOps;
use crate::server::ServerError;

pub(crate) struct AppSkillsOps {
    app: tauri::AppHandle,
}

impl AppSkillsOps {
    pub(crate) fn create(app: tauri::AppHandle) -> Arc<dyn SkillsOps> {
        Arc::new(Self { app })
    }
}

/// 技能稳定 id（与桌面 skillId.ts / agent-runtime 同算法：
/// `skill_` + sha256(`${name}:${filePath}`) hex 前 12 字符——桌面
/// 列表的去重键与斜杠命令解析都以此为准，宿主投影必须同值）
fn skill_stable_id(name: &str, file_path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{name}:{file_path}").as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    format!("skill_{}", &hex[..12])
}

/// 作用域呈现序（与桌面设置列表 sortSkillsForSettings 同口径：
/// project 先于 workspace 先于其余（含 global））
fn scope_order(scope: &str) -> u8 {
    match scope {
        "project" => 0,
        "workspace" => 1,
        _ => 2,
    }
}

/// 发现结果 → C44 响应投影（纯函数）：按稳定 id 去重保留先现者
/// （与桌面 normalizeSkills + 列表去重同口径——如工作区恰为主目录
/// 时同一文件会以 project/global 两次被发现，只保留先现的
/// project 条目）；排序 = 作用域序后按名称升序（桌面设置列表
/// 呈现顺序）；正文/raw 不进投影（浏览面只需要目录元数据）。
fn project_skills(discovered: Vec<RustSkill>) -> ListSkillsResult {
    let mut seen: HashSet<String> = HashSet::new();
    let mut skills: Vec<SkillEntry> = Vec::new();
    for skill in discovered {
        let id = skill_stable_id(&skill.name, &skill.file_path);
        if !seen.insert(id.clone()) {
            continue;
        }
        skills.push(SkillEntry {
            id,
            name: skill.name,
            description: skill.description,
            scope: skill.scope,
            system: skill.system,
            disable_model_invocation: skill.disable_model_invocation,
            file_activation: skill.file_activation,
        });
    }
    skills.sort_by(|a, b| {
        scope_order(&a.scope)
            .cmp(&scope_order(&b.scope))
            .then_with(|| a.name.cmp(&b.name))
    });
    ListSkillsResult { skills }
}

impl SkillsOps for AppSkillsOps {
    fn list_skills(&self) -> Result<ListSkillsResult, ServerError> {
        // 活动工作区根 = WorkspaceRegistry.active_root（与文件域
        // guard_for 的缺省口径一致：移动端技能目录跟随桌面当前
        // 工作区）；无活动工作区时只发现全局技能。注册表本身不可达
        // 时传 None——发现函数会以其内部错误为准（如实上报），
        // 不在此处吞掉或伪造。
        let workspace_path = crate::workspace::registry(&self.app)
            .ok()
            .and_then(|registry| registry.active_root())
            .map(|root| root.to_string_lossy().into_owned());
        let discovered = workbench_discover_skills(&self.app, workspace_path, Vec::new())
            .map_err(|error| ServerError::from_core_error(&error))?;
        Ok(project_skills(discovered))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_skill(name: &str, file_path: &str, scope: &str) -> RustSkill {
        RustSkill {
            file_path: file_path.to_string(),
            base_dir: file_path
                .rsplit_once('/')
                .map(|(dir, _)| dir.to_string())
                .unwrap_or_default(),
            content: String::new(),
            raw: String::new(),
            scope: scope.to_string(),
            system: false,
            name: name.to_string(),
            description: String::new(),
            tags: Vec::new(),
            applies_to: Vec::new(),
            disable_model_invocation: false,
            file_activation: None,
        }
    }

    #[test]
    fn stable_id_matches_desktop_golden_vector() {
        // 桌面 skillId.ts 金标向量：skillStableId('my-skill',
        // '/tmp/x/SKILL.md') === 'skill_95cfb221d00f'（agent-runtime
        // 同算法；投影 id 与桌面不一致 = 跨端身份漂移，必须红）
        assert_eq!(
            skill_stable_id("my-skill", "/tmp/x/SKILL.md"),
            "skill_95cfb221d00f"
        );
    }

    #[test]
    fn project_skills_dedupes_by_id_keeping_first() {
        // 同一文件被 project/global 两次发现（工作区 = 主目录的
        // 边缘情形）：只保留先现的 project 条目
        let result = project_skills(vec![
            fixture_skill("dup", "/home/u/.conex/skills/dup/SKILL.md", "project"),
            fixture_skill("dup", "/home/u/.conex/skills/dup/SKILL.md", "global"),
        ]);
        assert_eq!(result.skills.len(), 1);
        assert_eq!(result.skills[0].scope, "project");
    }

    #[test]
    fn project_skills_sorts_project_first_then_name() {
        let result = project_skills(vec![
            fixture_skill("zeta", "/g/zeta/SKILL.md", "global"),
            fixture_skill("beta", "/p/beta/SKILL.md", "project"),
            fixture_skill("alpha", "/g/alpha/SKILL.md", "global"),
            fixture_skill("apple", "/p/apple/SKILL.md", "project"),
        ]);
        let names: Vec<&str> = result.skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["apple", "beta", "alpha", "zeta"]);
    }

    #[test]
    fn project_skills_passes_metadata_through() {
        let mut skill = fixture_skill("sys", "/g/.system/sys/SKILL.md", "global");
        skill.system = true;
        skill.disable_model_invocation = true;
        skill.file_activation = Some("recommended".to_string());
        skill.description = "系统技能".to_string();
        let result = project_skills(vec![skill]);
        let entry = &result.skills[0];
        assert!(entry.system);
        assert!(entry.disable_model_invocation);
        assert_eq!(entry.file_activation.as_deref(), Some("recommended"));
        assert_eq!(entry.description, "系统技能");
        assert_eq!(
            entry.id,
            skill_stable_id("sys", "/g/.system/sys/SKILL.md")
        );
    }

    #[test]
    fn project_skills_empty_is_empty() {
        let result = project_skills(Vec::new());
        assert!(result.skills.is_empty());
    }
}
