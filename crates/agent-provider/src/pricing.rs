//! 用户配置驱动的微元计价。缺单价与显式免费不同；图片必须有真实数量。
//! 阶梯逐字段继承，使用归一后的输入总数与缓存分项；当前配置不用于历史重算。

use serde::{Deserialize, Serialize};

pub use crate::models::catalog_types::PricingTier;
use crate::models::catalog_types::{CurrencyKind, ModelPricingSpec, PricingUnit};

/// 货币类型兼容别名：SSOT = [CurrencyKind]（catalog_types）。
/// 保留 `pricing::Currency` 路径仅为既有调用方不漂移；禁止再扩展平行枚举。
pub use crate::models::catalog_types::CurrencyKind as Currency;

/// 定点微元账目明细 (CostBreakdown)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostBreakdown {
    /// 结算货币类型
    pub currency: CurrencyKind,
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
    pub fn free(currency: CurrencyKind) -> Self {
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
        pricing_opt: &Option<ModelPricingSpec>,
        usage: &crate::events::ProviderUsage,
    ) -> Option<Self> {
        PricingEngine::calculate_cost_from_usage(pricing_opt, usage)
    }

    /// 根据详细 Token 计数与模型定价直接生成权威 CostBreakdown
    pub fn calculate(
        pricing_opt: &Option<ModelPricingSpec>,
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
            currency: CurrencyKind::default(),
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
    /// Token 使用量入口不推断图片张数；需要图片费用时必须显式提供 image_count。
    pub fn calculate_cost(
        pricing: &Option<ModelPricingSpec>,
        prompt_tokens: u64,
        completion_tokens: u64,
        cache_read_tokens: u64,
        cache_write_tokens: u64,
    ) -> Option<CostBreakdown> {
        Self::calculate_cost_with_images(
            pricing,
            prompt_tokens,
            completion_tokens,
            cache_read_tokens,
            cache_write_tokens,
            None,
        )
    }

    /// 按实际使用的维度收费。缺少该维度单价或图片数量时返回未定价，绝不填 0。
    pub fn calculate_cost_with_images(
        pricing: &Option<ModelPricingSpec>,
        prompt_tokens: u64,
        completion_tokens: u64,
        cache_read_tokens: u64,
        cache_write_tokens: u64,
        image_count: Option<u64>,
    ) -> Option<CostBreakdown> {
        let pricing = pricing.as_ref()?;
        if cache_read_tokens > prompt_tokens
            || cache_write_tokens > prompt_tokens - cache_read_tokens
        {
            return None;
        }
        let image_only = pricing.unit == PricingUnit::PerImage;
        let mut rates = [
            pricing.input,
            pricing.output,
            pricing.cache_read,
            pricing.cache_write,
        ];
        if let Some(tier) = pricing
            .tiers
            .iter()
            .filter(|tier| prompt_tokens >= tier.input_tokens_above)
            .max_by_key(|tier| tier.input_tokens_above)
        {
            for (base, tier_rate) in
                rates
                    .iter_mut()
                    .zip([tier.input, tier.output, tier.cache_read, tier.cache_write])
            {
                *base = tier_rate.or(*base);
            }
        }
        if rates
            .iter()
            .flatten()
            .chain(pricing.per_image.iter())
            .any(|rate| !rate.is_finite() || *rate < 0.0)
        {
            return None;
        }
        let has_image_price = pricing.per_image.is_some() || image_only;
        let image_micros = if has_image_price {
            Self::rate_cost(image_count?, pricing.per_image?, 6)
        } else {
            if image_count.is_some_and(|count| count > 0) {
                return None;
            }
            0
        };
        let counts = if image_only {
            [0; 4]
        } else {
            [
                prompt_tokens - cache_read_tokens - cache_write_tokens,
                completion_tokens,
                cache_read_tokens,
                cache_write_tokens,
            ]
        };
        if !has_image_price && rates.iter().all(Option::is_none) {
            return None;
        }
        let scale = if pricing.unit == PricingUnit::Token {
            6
        } else {
            0
        };
        let mut components = [0_u64; 4];
        for ((cost, count), rate) in components.iter_mut().zip(counts).zip(rates) {
            if count > 0 {
                *cost = Self::rate_cost(count, rate?, scale);
            }
        }
        components[1] = components[1].saturating_add(image_micros);
        let total_micros = components.into_iter().fold(0_u64, u64::saturating_add);
        let is_free = if image_only {
            pricing.per_image == Some(0.0)
        } else {
            // 缺价且有该维度用量已在上方返回 None；未使用的可选维度不构成收费。
            pricing.tiers.is_empty()
                && rates[0] == Some(0.0)
                && rates[1] == Some(0.0)
                && rates[2].is_none_or(|rate| rate == 0.0)
                && rates[3].is_none_or(|rate| rate == 0.0)
                && (!has_image_price || pricing.per_image == Some(0.0))
        };
        Some(CostBreakdown {
            currency: pricing.currency,
            input_micros: components[0],
            output_micros: components[1],
            cache_read_micros: components[2],
            cache_write_micros: components[3],
            total_micros,
            formatted_total: if is_free {
                "免费".into()
            } else {
                Self::format_micros(total_micros, pricing.currency)
            },
            is_free,
        })
    }

    /// 图片数量来自图片生成响应，不能借用任何 Token 计数字段。
    pub fn calculate_image_cost(
        pricing: &Option<ModelPricingSpec>,
        image_count: u64,
    ) -> Option<CostBreakdown> {
        Self::calculate_cost_with_images(pricing, 0, 0, 0, 0, Some(image_count))
    }

    pub fn calculate_cost_from_usage(
        pricing: &Option<ModelPricingSpec>,
        usage: &crate::events::ProviderUsage,
    ) -> Option<CostBreakdown> {
        Self::calculate_cost(
            pricing,
            usage.prompt_tokens?,
            usage.completion_tokens?,
            usage.cache_read_tokens.unwrap_or(0),
            usage.cache_write_tokens.unwrap_or(0),
        )
    }

    /// 每百万 Token 费率折算为微元；两侧百万因子相消，最后一步才四舍五入。
    pub fn tokens_to_micros(tokens: u64, rate_per_1m: f64) -> u64 {
        Self::rate_cost(tokens, rate_per_1m, 0)
    }

    pub fn f64_to_micros(value: f64) -> u64 {
        Self::rate_cost(1, value, 6)
    }

    /// 使用费率的十进制表示做整数乘除，避免先把单个 Token 价格舍入为 0。
    fn rate_cost(count: u64, rate: f64, micro_scale: i32) -> u64 {
        if count == 0 || !rate.is_finite() || rate <= 0.0 {
            return 0;
        }
        let text = rate.to_string();
        let (mantissa, exponent) = match text.split_once(['e', 'E']) {
            Some((mantissa, exponent)) => (mantissa, exponent.parse::<i32>().unwrap_or(0)),
            None => (text.as_str(), 0),
        };
        let decimals = mantissa
            .split_once('.')
            .map_or(0, |(_, fraction)| fraction.len()) as i32;
        let digits: String = mantissa.chars().filter(|ch| *ch != '.').collect();
        let digits = digits.trim_start_matches('0');
        let coefficient = match digits.parse::<u128>() {
            Ok(value) => value,
            Err(_) => return u64::MAX,
        };
        let Some(mut value) = u128::from(count).checked_mul(coefficient) else {
            return u64::MAX;
        };
        let scale = micro_scale + exponent - decimals;
        if scale >= 0 {
            let Some(factor) = 10_u128.checked_pow(scale as u32) else {
                return u64::MAX;
            };
            value = value.saturating_mul(factor);
        } else {
            let Some(divisor) = 10_u128.checked_pow((-scale) as u32) else {
                return 0;
            };
            let quotient = value / divisor;
            let remainder = value % divisor;
            value = quotient + u128::from(remainder >= divisor / 2);
        }
        value.min(u128::from(u64::MAX)) as u64
    }

    /// 格式化微元为带符号的货币字符串
    ///
    /// - 若金额为 0：返回 "$0.0000" 或 "¥0.0000"
    /// - 若金额极小 (< 1000 微元，即 < 0.001 货币单位)：保留 6 位小数 (如 "¥0.000500")
    /// - 常规金额：保留 4 位小数并正确四舍五入进位 (如 "¥0.0520", "$0.5325")
    pub fn format_micros(micros: u64, currency: CurrencyKind) -> String {
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
