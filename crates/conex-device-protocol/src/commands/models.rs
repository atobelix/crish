use serde::{Deserialize, Serialize};

// ── 模型域（G2/W-B 增补 C38/C39；归 F6 设置域——全局默认模型是全局
// 配置面，与桌面「设置 → 模型」页读写同一份统一模型树
// `UnifiedModelsConfig.activeModel`，不另建移动端专用模型表）──

/// C38 参数（空）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListModelsParams {}

/// 可选模型条目（C38 响应元素；仅含启用供应商下的启用模型——桌面
/// 全局默认选择器的可选集合同口径）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    /// 供应商 id（统一模型树 providers 键）
    pub provider_id: String,
    /// 模型 id（供应商内唯一；身份 = (providerId, modelId) 二元组）
    pub model_id: String,
    /// 显示名（模型 displayName，缺省回退 modelId）
    pub display_name: String,
    /// 供应商显示名（缺省 = 未配置 displayName；移动端作行副文案）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_display_name: Option<String>,
    /// 是否为当前全局默认模型
    pub active: bool,
    /// 视觉能力标记（G5b 投影扩展）：统一模型树 `modalities.input`
    /// 含 image（`ModelSpec::supports_image_input`，与引擎出站多模态
    /// 守卫同口径）。缺省 false：旧宿主不回传时按非视觉处理——移动端
    /// 据此把图片降级为元数据文本 part（引擎对非视觉模型带图是
    /// 硬拒而非降级，见 plans/04 §4.1，故移动端必须先行判定）。
    #[serde(default)]
    pub vision: bool,
}

/// 当前全局默认模型（按统一树 activeModel 原样解析；目标模型已停用/
/// 删除时仍如实回传——displayName 在树内查不到时回退 modelId）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveModelInfo {
    /// 供应商 id
    pub provider_id: String,
    /// 模型 id
    pub model_id: String,
    /// 显示名（模型 displayName，缺省回退 modelId）
    pub display_name: String,
}

/// C38 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListModelsResult {
    /// 可选模型列表（供应商按统一树顺序、模型按供应商内顺序）
    pub models: Vec<ModelEntry>,
    /// 当前全局默认模型（未设置 = 字段缺省；桌面语义「不指定时在
    /// 对话里选择」，移动端不得伪造）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_model: Option<ActiveModelInfo>,
}

/// C39 参数（切换全局默认模型；目标必须在可选集合内——不存在或
/// 已停用的模型/供应商按 cmd.invalid 拒绝，不静默落库）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetActiveModelParams {
    /// 供应商 id
    pub provider_id: String,
    /// 模型 id
    pub model_id: String,
}

/// C39 响应（切换后即时回传新全局默认，移动端据此刷新标签与列表态）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetActiveModelResult {
    /// 是否成功
    pub ok: bool,
    /// 切换后的全局默认模型
    pub active_model: ActiveModelInfo,
}
