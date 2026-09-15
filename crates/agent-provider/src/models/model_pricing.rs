//! 配置价格类型。所有单价保持可选，0 与未配置严格区分。

use serde::{Deserialize, Serialize};

/// 结算货币种类强类型定义
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CurrencyKind {
    /// 人民币结算 (¥)
    #[serde(rename = "CNY")]
    Cny,
    /// 美元结算 ($)
    #[serde(rename = "USD")]
    Usd,
}

impl Default for CurrencyKind {
    fn default() -> Self {
        Self::Usd
    }
}

impl CurrencyKind {
    /// 获取货币符号
    pub fn symbol(&self) -> &'static str {
        match self {
            Self::Cny => "¥",
            Self::Usd => "$",
        }
    }

    /// 获取 ISO 4217 货币代码
    pub fn code(&self) -> &'static str {
        match self {
            Self::Cny => "CNY",
            Self::Usd => "USD",
        }
    }
}

impl std::fmt::Display for CurrencyKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.code())
    }
}

/// 用户声明的价格单位；不在解析时隐式换算或补造价格。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
pub enum PricingUnit {
    #[default]
    #[serde(rename = "per_1m_tokens")]
    PerMillionTokens,
    #[serde(rename = "token")]
    Token,
    #[serde(rename = "per_image")]
    PerImage,
}

/// 阶梯价格只覆盖明确提供的维度；阈值零有效。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PricingTier {
    pub input_tokens_above: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<f64>,
}

/// 配置与计价消费共用同一类型，不建立第二套价格 DTO。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelPricingSpec {
    pub currency: CurrencyKind,
    #[serde(default)]
    pub unit: PricingUnit,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_image: Option<f64>,
    #[serde(default)]
    pub tiers: Vec<PricingTier>,
}

impl ModelPricingSpec {
    pub fn calculate_cost(
        &self,
        input_tokens: u64,
        output_tokens: u64,
        cache_read_tokens: u64,
        cache_write_tokens: u64,
    ) -> Option<crate::pricing::CostBreakdown> {
        crate::pricing::PricingEngine::calculate_cost(
            &Some(self.clone()),
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens,
        )
    }
}
