//! 四维双币微元定点计费引擎 (Micros Pricing Engine)
//!
//! 采用纯 u64/u128 整数定点运算，以 micros (10^-6 货币单位) 为基准，
//! 彻底根除浮点运算累加误差，支持阶梯计费、Prompt Cache 扣减与按张计费。

use serde::{Deserialize, Serialize};

/// 货币枚举 (严格限定为 CNY 或 USD)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Currency {
    Cny,
    Usd,
}

impl Currency {
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

impl Default for Currency {
    fn default() -> Self {
        Self::Usd
    }
}

impl std::fmt::Display for Currency {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.code())
    }
}

impl From<crate::models::catalog_types::CurrencyKind> for Currency {
    fn from(kind: crate::models::catalog_types::CurrencyKind) -> Self {
        match kind {
            crate::models::catalog_types::CurrencyKind::Cny => Currency::Cny,
            crate::models::catalog_types::CurrencyKind::Usd => Currency::Usd,
        }
    }
}

impl From<Currency> for crate::models::catalog_types::CurrencyKind {
    fn from(c: Currency) -> Self {
        match c {
            Currency::Cny => crate::models::catalog_types::CurrencyKind::Cny,
            Currency::Usd => crate::models::catalog_types::CurrencyKind::Usd,
        }
    }
}

/// 计量计价单位枚举
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PricingUnit {
    Per1mTokens,
    PerImage,
    PerRequest,
}

impl Default for PricingUnit {
    fn default() -> Self {
        Self::Per1mTokens
    }
}

/// 阶梯计费配置
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingTier {
    /// 触发此阶梯的输入 Token 数量门槛 (>= inputTokensAbove)
    pub input_tokens_above: u64,
    /// 阶梯普通输入单价
    pub input: f64,
    /// 阶梯生成输出单价
    pub output: f64,
    /// 阶梯缓存读取单价
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,
    /// 阶梯缓存写入单价
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<f64>,
}

/// 模型四价计费定义
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPricing {
    /// 结算币种
    pub currency: Currency,
    /// 计费单位 (默认 per_1m_tokens)
    #[serde(default)]
    pub unit: PricingUnit,
    /// 基础普通提示词输入单价 (元/1M Tokens 或 $/1M Tokens)
    pub input: f64,
    /// 生成补全输出单价 (元/1M Tokens 或 $/1M Tokens)
    pub output: f64,
    /// 提示词上下文缓存命中读取独立单价 (Cache Read / Hit)，绝非固定一折
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,
    /// 提示词上下文缓存创建写入独立单价 (Cache Write / Creation)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<f64>,
    /// 阶梯计费档位列表
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tiers: Vec<PricingTier>,
}

impl From<crate::models::catalog_types::ModelPricingSpec> for ModelPricing {
    fn from(spec: crate::models::catalog_types::ModelPricingSpec) -> Self {
        let (unit, input, output) = if let Some(per_img) = spec.per_image {
            (PricingUnit::PerImage, 0.0, per_img)
        } else {
            (PricingUnit::Per1mTokens, spec.input, spec.output)
        };
        Self {
            currency: spec.currency.into(),
            unit,
            input,
            output,
            cache_read: spec.cache_read,
            cache_write: spec.cache_write,
            // plans/05 T5.1：必须拷贝阶梯（spec 真没有才为空；禁止静默清空）
            tiers: spec
                .tiers
                .into_iter()
                .map(|t| PricingTier {
                    input_tokens_above: t.input_tokens_above,
                    input: t.input,
                    output: t.output,
                    cache_read: t.cache_read,
                    cache_write: t.cache_write,
                })
                .collect(),
        }
    }
}

impl From<&crate::models::catalog_types::ModelPricingSpec> for ModelPricing {
    fn from(spec: &crate::models::catalog_types::ModelPricingSpec) -> Self {
        spec.clone().into()
    }
}

impl From<ModelPricing> for crate::models::catalog_types::ModelPricingSpec {
    fn from(p: ModelPricing) -> Self {
        let per_image = if p.unit == PricingUnit::PerImage {
            Some(p.output)
        } else {
            None
        };
        Self {
            currency: p.currency.into(),
            input: p.input,
            output: p.output,
            cache_read: p.cache_read,
            cache_write: p.cache_write,
            per_image,
            tiers: p
                .tiers
                .into_iter()
                .map(|t| crate::models::catalog_types::PricingTier {
                    input_tokens_above: t.input_tokens_above,
                    input: t.input,
                    output: t.output,
                    cache_read: t.cache_read,
                    cache_write: t.cache_write,
                })
                .collect(),
        }
    }
}

impl From<&ModelPricing> for crate::models::catalog_types::ModelPricingSpec {
    fn from(p: &ModelPricing) -> Self {
        p.clone().into()
    }
}

impl Default for ModelPricing {
    fn default() -> Self {
        Self {
            currency: Currency::default(),
            unit: PricingUnit::default(),
            input: 0.0,
            output: 0.0,
            cache_read: None,
            cache_write: None,
            tiers: Vec::new(),
        }
    }
}

/// 定点微元账目明细 (CostBreakdown)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostBreakdown {
    /// 结算货币类型
    pub currency: Currency,
    /// 普通输入微元开销 ($10^{-6}$ 货币单位)
    pub input_micros: u64,
    /// 生成输出微元开销 ($10^{-6}$ 货币单位)
    pub output_micros: u64,
    /// 缓存读取微元开销 ($10^{-6}$ 货币单位)
    pub cache_read_micros: u64,
    /// 缓存写入微元开销 ($10^{-6}$ 货币单位)
    pub cache_write_micros: u64,
    /// 总微元开销 ($10^{-6}$ 货币单位)
    pub total_micros: u64,
    /// 格式化带货币符号的总额展示字符串 (如 "¥0.0520" 或 "$0.0034", 极小额带6位小数)
    pub formatted_total: String,
    /// 是否为显式完全免费
    pub is_free: bool,
}

impl CostBreakdown {
    /// 转换为浮点金额（元/美元），仅供无需定点精度的展示或日志场景
    pub fn total_as_f64(&self) -> f64 {
        self.total_micros as f64 / 1_000_000.0
    }

    /// 构造权威显式全免账单明细
    pub fn free(currency: Currency) -> Self {
        Self {
            currency,
            input_micros: 0,
            output_micros: 0,
            cache_read_micros: 0,
            cache_write_micros: 0,
            total_micros: 0,
            formatted_total: "免费".to_string(),
            is_free: true,
        }
    }

    /// 根据 Token 用量与模型定价直接生成权威 CostBreakdown（会话流结算入口）
    pub fn from_usage(
        pricing_opt: &Option<ModelPricing>,
        usage: &crate::events::ProviderUsage,
    ) -> Option<Self> {
        PricingEngine::calculate_cost_from_usage(pricing_opt, usage)
    }

    /// 根据详细 Token 计数与模型定价直接生成权威 CostBreakdown
    pub fn calculate(
        pricing_opt: &Option<ModelPricing>,
        prompt_tokens: u64,
        completion_tokens: u64,
        cache_read_tokens: u64,
        cache_write_tokens: u64,
    ) -> Option<Self> {
        PricingEngine::calculate_cost(
            pricing_opt,
            prompt_tokens,
            completion_tokens,
            cache_read_tokens,
            cache_write_tokens,
        )
    }
}

impl Default for CostBreakdown {
    fn default() -> Self {
        Self {
            currency: Currency::default(),
            input_micros: 0,
            output_micros: 0,
            cache_read_micros: 0,
            cache_write_micros: 0,
            total_micros: 0,
            formatted_total: "$0.0000".to_string(),
            is_free: false,
        }
    }
}

/// 定点微元计费引擎
pub struct PricingEngine;

impl PricingEngine {
    /// 计算单次调用的四维双币微元账目
    ///
    /// 若 `pricing_opt` 为 `None`，返回 `None` 实现空配置静默 (Zero-Cost Silence)。
    pub fn calculate_cost(
        pricing_opt: &Option<ModelPricing>,
        prompt_tokens: u64,
        completion_tokens: u64,
        cache_read_tokens: u64,
        cache_write_tokens: u64,
    ) -> Option<CostBreakdown> {
        let pricing = pricing_opt.as_ref()?;

        // 显式免费模型判断：必须且仅当不存在阶梯计费且所有四项费率均为 0.0 时，才允许短路返回全免
        if pricing.tiers.is_empty()
            && pricing.input == 0.0
            && pricing.output == 0.0
            && pricing.cache_read.unwrap_or(0.0) == 0.0
            && pricing.cache_write.unwrap_or(0.0) == 0.0
        {
            return Some(CostBreakdown::free(pricing.currency));
        }

        // 分支 1：按张计费模式 (PerImage)
        if pricing.unit == PricingUnit::PerImage {
            let image_count = completion_tokens;
            let rate_micros_per_image = Self::f64_to_micros(pricing.output);
            let product = (image_count as u128) * (rate_micros_per_image as u128);
            let total_micros = product.min(u64::MAX as u128) as u64;

            return Some(CostBreakdown {
                currency: pricing.currency,
                input_micros: 0,
                output_micros: total_micros,
                cache_read_micros: 0,
                cache_write_micros: 0,
                total_micros,
                formatted_total: Self::format_micros(total_micros, pricing.currency),
                is_free: false,
            });
        }

        // 分支 2：按次计费模式 (PerRequest)
        if pricing.unit == PricingUnit::PerRequest {
            let rate_micros = Self::f64_to_micros(pricing.input.max(pricing.output));
            let total_micros = rate_micros;

            return Some(CostBreakdown {
                currency: pricing.currency,
                input_micros: rate_micros,
                output_micros: 0,
                cache_read_micros: 0,
                cache_write_micros: 0,
                total_micros,
                formatted_total: Self::format_micros(total_micros, pricing.currency),
                is_free: false,
            });
        }

        // 分支 3：按百万 Token 计费模式 (Per1mTokens)
        let mut active_input_rate = pricing.input;
        let mut active_output_rate = pricing.output;
        let mut active_cache_read_rate = pricing.cache_read.unwrap_or(0.0);
        let mut active_cache_write_rate = pricing.cache_write.unwrap_or(0.0);

        // 检索阶梯计费（按照门槛倒序匹配）
        if !pricing.tiers.is_empty() {
            let mut sorted_tiers = pricing.tiers.clone();
            sorted_tiers.sort_by(|a, b| b.input_tokens_above.cmp(&a.input_tokens_above));
            for tier in sorted_tiers {
                if prompt_tokens >= tier.input_tokens_above {
                    active_input_rate = tier.input;
                    active_output_rate = tier.output;
                    if let Some(cr) = tier.cache_read {
                        active_cache_read_rate = cr;
                    }
                    if let Some(cw) = tier.cache_write {
                        active_cache_write_rate = cw;
                    }
                    break;
                }
            }
        }

        // 扣除已命中缓存读取的普通输入 Tokens
        let non_cached_prompt_tokens = prompt_tokens.saturating_sub(cache_read_tokens);

        let input_micros = Self::tokens_to_micros(non_cached_prompt_tokens, active_input_rate);
        let output_micros = Self::tokens_to_micros(completion_tokens, active_output_rate);
        let cache_read_micros = Self::tokens_to_micros(cache_read_tokens, active_cache_read_rate);
        let cache_write_micros =
            Self::tokens_to_micros(cache_write_tokens, active_cache_write_rate);

        let total_micros = input_micros
            .saturating_add(output_micros)
            .saturating_add(cache_read_micros)
            .saturating_add(cache_write_micros);

        Some(CostBreakdown {
            currency: pricing.currency,
            input_micros,
            output_micros,
            cache_read_micros,
            cache_write_micros,
            total_micros,
            formatted_total: Self::format_micros(total_micros, pricing.currency),
            is_free: false,
        })
    }

    /// 基于 ModelPricingSpec 计算费用（与 `catalog_types` 无缝互操作）
    pub fn calculate_cost_from_spec(
        spec_opt: &Option<crate::models::catalog_types::ModelPricingSpec>,
        prompt_tokens: u64,
        completion_tokens: u64,
        cache_read_tokens: u64,
        cache_write_tokens: u64,
    ) -> Option<CostBreakdown> {
        let pricing = spec_opt.as_ref().map(ModelPricing::from);
        Self::calculate_cost(
            &pricing,
            prompt_tokens,
            completion_tokens,
            cache_read_tokens,
            cache_write_tokens,
        )
    }

    /// 基于 ProviderUsage 与 ModelPricing 计算费用（会话流结算权威入口）
    pub fn calculate_cost_from_usage(
        pricing_opt: &Option<ModelPricing>,
        usage: &crate::events::ProviderUsage,
    ) -> Option<CostBreakdown> {
        let prompt_tokens = usage.prompt_tokens.unwrap_or(0);
        let completion_tokens = usage.completion_tokens.unwrap_or(0);
        let cache_read_tokens = usage.cache_read_tokens.unwrap_or(0);
        let cache_write_tokens = usage.cache_write_tokens.unwrap_or(0);
        Self::calculate_cost(
            pricing_opt,
            prompt_tokens,
            completion_tokens,
            cache_read_tokens,
            cache_write_tokens,
        )
    }

    /// 基于 ProviderUsage 与 ModelPricingSpec 计算费用（与 catalog_types 无缝互操作）
    pub fn calculate_cost_from_usage_spec(
        spec_opt: &Option<crate::models::catalog_types::ModelPricingSpec>,
        usage: &crate::events::ProviderUsage,
    ) -> Option<CostBreakdown> {
        let prompt_tokens = usage.prompt_tokens.unwrap_or(0);
        let completion_tokens = usage.completion_tokens.unwrap_or(0);
        let cache_read_tokens = usage.cache_read_tokens.unwrap_or(0);
        let cache_write_tokens = usage.cache_write_tokens.unwrap_or(0);
        Self::calculate_cost_from_spec(
            spec_opt,
            prompt_tokens,
            completion_tokens,
            cache_read_tokens,
            cache_write_tokens,
        )
    }

    /// 将费率 (元/1M Tokens) 转换为微元并与 Token 数量定点乘算
    ///
    /// 使用 u128 防止大 Token 数相乘溢出，加 500_000 实现严格四舍五入除以 1_000_000，
    /// 并在转换为 u64 时使用饱和截断 .min(u64::MAX as u128)，彻底消灭强制 as u64 导致的回绕溢出。
    #[inline]
    pub fn tokens_to_micros(tokens: u64, rate_per_1m: f64) -> u64 {
        if tokens == 0 || !rate_per_1m.is_finite() || rate_per_1m <= 0.0 {
            return 0;
        }
        let rate_micros = Self::f64_to_micros(rate_per_1m);
        let product = (tokens as u128) * (rate_micros as u128);
        let rounded = product.saturating_add(500_000);
        let result = rounded / 1_000_000;
        result.min(u64::MAX as u128) as u64
    }

    /// 浮点数四舍五入转为微元整数 (1.00 -> 1_000_000)
    #[inline]
    pub fn f64_to_micros(val: f64) -> u64 {
        if !val.is_finite() || val <= 0.0 {
            return 0;
        }
        let rounded = (val * 1_000_000.0).round();
        if rounded >= (u64::MAX as f64) {
            u64::MAX
        } else {
            rounded as u64
        }
    }

    /// 格式化微元为带符号的货币字符串
    ///
    /// - 若金额为 0：返回 "$0.0000" 或 "¥0.0000"
    /// - 若金额极小 (< 1000 微元，即 < 0.001 货币单位)：保留 6 位小数 (如 "¥0.000500")
    /// - 常规金额：保留 4 位小数并正确四舍五入进位 (如 "¥0.0520", "$0.5325")
    pub fn format_micros(micros: u64, currency: Currency) -> String {
        let symbol = currency.symbol();
        if micros == 0 {
            return format!("{}0.0000", symbol);
        }

        let whole = micros / 1_000_000;
        let fraction = micros % 1_000_000;

        if micros < 1_000 {
            format!("{}{}.{:06}", symbol, whole, fraction)
        } else {
            let fraction_4 = (fraction + 50) / 100;
            let whole_adj = whole + fraction_4 / 10_000;
            let rem_4 = fraction_4 % 10_000;
            format!("{}{}.{:04}", symbol, whole_adj, rem_4)
        }
    }
}

#[cfg(test)]
#[path = "pricing_tests.rs"]
mod pricing_tests;
