//! 规范配置的唯一读取与提交入口。历史字段迁移属于 migration 模块。

use super::{ModelRef, ModelSpec, ProtocolKind, ProviderSpec, UnifiedModelsConfig};

#[path = "config_validation.rs"]
mod config_validation;

/// 配置语法或语义错误，保留可用的行列定位。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YamlParseError {
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub message: String,
}

impl YamlParseError {
    pub fn semantic(message: impl Into<String>) -> Self {
        Self {
            line: None,
            column: None,
            message: message.into(),
        }
    }

    pub fn from_serde(err: serde_yaml::Error) -> Self {
        let (line, column) = err
            .location()
            .map(|loc| (loc.line() as u32, loc.column() as u32))
            .unzip();
        Self {
            line,
            column,
            message: format!("解析 models.yaml 失败: {err}"),
        }
    }
}

impl std::fmt::Display for YamlParseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for YamlParseError {}

impl UnifiedModelsConfig {
    pub fn from_yaml_str(content: &str) -> Result<Self, String> {
        Self::from_yaml_str_detailed(content).map_err(|error| error.to_string())
    }

    /// YAML 解析、身份与思考键归一、语义校验必须经过同一入口。
    pub fn from_yaml_str_detailed(content: &str) -> Result<Self, YamlParseError> {
        if content.lines().all(|line| {
            let line = line.trim();
            line.is_empty() || line.starts_with('#')
        }) {
            return Ok(Self::default());
        }
        // Value 的映射解析拒绝重复物理键，不能先装进可覆盖的 IndexMap。
        let value: serde_yaml::Value =
            serde_yaml::from_str(content).map_err(YamlParseError::from_serde)?;
        if value.is_null() {
            return Ok(Self::default());
        }
        if !value.is_mapping() {
            return Err(YamlParseError::semantic("models.yaml 根节点必须为配置对象"));
        }
        if value.get("models").is_some() {
            return Err(YamlParseError::semantic("旧版 v1 models 列表必须先执行显式迁移"));
        }
        let mut config: Self = serde_yaml::from_value(value).map_err(YamlParseError::from_serde)?;
        config
            .normalize_for_commit()
            .map_err(YamlParseError::semantic)?;
        Ok(config)
    }

    /// 完整候选树先在克隆中校验，成功后替换；失败不破坏调用者草稿。
    pub fn normalize_for_commit(&mut self) -> Result<(), String> {
        let mut candidate = self.clone();
        config_validation::normalize(&mut candidate)?;
        *self = candidate;
        Ok(())
    }

    /// 校验与提交共用规则；校验本身不会修改调用者数据。
    pub fn validate(&self) -> Result<(), String> {
        let mut candidate = self.clone();
        config_validation::normalize(&mut candidate)
    }

    /// 查找保留禁用条目供设置页编辑；请求必须使用 find_enabled_model。
    pub fn find_provider(&self, provider_id: &str) -> Option<&ProviderSpec> {
        self.providers.get(provider_id.trim())
    }

    pub fn find_model(&self, provider_id: &str, model_id: &str) -> Option<&ModelSpec> {
        self.find_provider(provider_id)?.find_model(model_id)
    }

    /// 请求解析只接受精确且启用的供应商和模型，不补配身份。
    pub fn find_enabled_model(&self, model_ref: &ModelRef) -> Option<(&ProviderSpec, &ModelSpec)> {
        let provider = self.find_provider(&model_ref.provider_id)?;
        if !provider.enabled {
            return None;
        }
        let model = provider.find_model(&model_ref.model_id)?;
        model.enabled.then_some((provider, model))
    }

    pub fn effective_protocol(&self, provider_id: &str, model_id: &str) -> Option<ProtocolKind> {
        let provider = self.find_provider(provider_id)?;
        let model = provider.find_model(model_id)?;
        Some(model.effective_protocol(provider))
    }
}
