use serde::{Deserialize, Serialize};

// ── 技能域（G7 增补 C44；归 F6 设置域——技能与桌面「设置 → 扩展 →
// 技能」同面，列表读桌面宿主的技能发现真源，不另建移动端技能表）──
//
// 真源与语义（2026-11-01 G7 查实）：
// - 技能目录真源 = 宿主文件系统技能库：活动工作区 `.crish/skills` /
//   `.conex/skills`（project）+ 用户主目录同名目录（global），由宿主
//   发现函数 `workbench_discover_skills` 递归扫描 SKILL.md 解析
//   frontmatter——桌面设置技能页的主路径正是经 Tauri 命令消费同一
//   函数，本命令只做跨端投影，与桌面所见为同一份目录；
// - 启停（activation 三态 enabled/recommended/disabled）的**生效值
//   不是宿主数据**：真源是桌面 webview 的 localStorage
//   （`crish_skill_activation_v1`，T03.7 起显式本地-only、daemon 同步
//   已删除），宿主侧不存在可远程读写的启停存储。故本批**不设启停
//   命令**：移动端只读浏览目录，启停仍在桌面端管理——不在移动端
//   伪造开关与「已启用」计数（原型技能面板的勾选语义无真源可落）；
// - 附加技能目录（桌面设置里添加的 extra dirs）同样存桌面
//   localStorage、逐次调用传入发现函数，远程不可见——经附加目录
//   引入的技能不会出现在本命令结果中（诚实边界，见 SkillEntry）。

/// C44 参数（空）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSkillsParams {}

/// 技能条目（C44 响应元素；宿主发现结果的轻量投影——不下发技能
/// 正文/raw 全文，浏览面只需要目录元数据，正文由桌面端在发送期
/// 解析注入，与 G2 模型条目的克制口径一致）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    /// 稳定 id（与桌面 skillId.ts / agent-runtime 同算法：
    /// `skill_` + sha256(`${name}:${filePath}`) hex 前 12 字符；
    /// 宿主投影时计算——同一技能在桌面与移动端 id 一致）
    pub id: String,
    /// 技能名（SKILL.md frontmatter name，缺省回退目录/文件名，
    /// 与宿主发现口径一致）
    pub name: String,
    /// 技能描述（frontmatter description；可为空串）
    pub description: String,
    /// 作用域（宿主发现原样值：`project` = 活动工作区技能目录，
    /// `global` = 用户主目录技能目录）
    pub scope: String,
    /// 是否系统技能（`.system` 目录 / 路径含 .system / frontmatter
    /// system:true，宿主发现口径）
    pub system: bool,
    /// 是否禁止模型自动调用（frontmatter disableModelInvocation；
    /// 为 true 的技能不进 /skill: 斜杠命令面，仅可被显式提及——
    /// 发现元数据原样投影，缺省 false）
    #[serde(default)]
    pub disable_model_invocation: bool,
    /// 技能文件 frontmatter 声明的缺省 activation（enabled /
    /// recommended / disabled 之一或任意文件内字符串；未声明 =
    /// 字段缺省）。**注意：这不是用户的生效启停状态**——生效值由
    /// 桌面端本地解析（localStorage 覆盖优先于文件声明），宿主侧
    /// 无从得知，本字段仅作文件元数据投影，移动端不得据此呈现
    /// 「已启用/已停用」状态。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_activation: Option<String>,
}

/// C44 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSkillsResult {
    /// 技能目录列表（宿主投影口径：按稳定 id 去重保留先现者——与
    /// 桌面设置列表同口径；排序 = 作用域 project 先于 global、
    /// 同域内按名称升序，与桌面设置列表呈现顺序一致）
    pub skills: Vec<SkillEntry>,
}
