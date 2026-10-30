//! 模型身份的唯一编码；不按 URL、名称或字典补配供应商。

use serde::{Deserialize, Deserializer, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelRef {
    #[serde(deserialize_with = "read_identity")]
    pub provider_id: String,
    #[serde(deserialize_with = "read_identity")]
    pub model_id: String,
}

fn read_identity<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let raw = String::deserialize(deserializer)?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(serde::de::Error::custom("模型身份不能为空"));
    }
    Ok(trimmed.to_owned())
}

impl ModelRef {
    pub fn new(provider_id: impl Into<String>, model_id: impl Into<String>) -> Self {
        Self {
            provider_id: provider_id.into().trim().to_owned(),
            model_id: model_id.into().trim().to_owned(),
        }
    }

    pub fn normalized(&self) -> Self {
        Self::new(self.provider_id.clone(), self.model_id.clone())
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.provider_id.trim().is_empty() || self.model_id.trim().is_empty() {
            return Err("模型身份的 providerId 和 modelId 均不能为空".into());
        }
        Ok(())
    }

    /// JSON 二元组与前端 JSON.stringify([providerId, modelId]) 同构，无分隔符碰撞。
    pub fn key(&self) -> String {
        let normalized = self.normalized();
        serde_json::json!([normalized.provider_id, normalized.model_id]).to_string()
    }
}
