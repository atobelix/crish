//! 四维双币微元定点计费引擎 (Micros Pricing Engine)
//!
//! 采用纯 u64/u128 整数定点运算，以 micros (10^-6 货币单位) 为基准，
//! 彻底根除浮点运算累加误差，支持阶梯计费、Prompt Cache 扣减与按张计费。
//!
//! ## SSOT 契约（计费平行 DTO 收敛）
//!
//! 计费数据的唯一真源 = [ModelPricingSpec]（连同 [CurrencyKind] / [PricingTier]，
//! 均定义于 [crate::models::catalog_types]）。本模块是纯计算引擎，直接消费该契约；
//! 历史上与之平行的引擎侧 `Currency` / `PricingUnit` / `ModelPricing` DTO 已删除，
//! **禁止再引入第二套计费结构**：
//! - 结算币种：`CurrencyKind`（本模块 re-export 为 `Currency`，仅作旧路径兼容别名）；
//! - 计费模式：由 `ModelPricingSpec.per_image` 显式判定——`Some(rate)` = 按张计费
//!   （每张单价 = rate 本身，不再借用 `output` 字段做 `input=0/output=per_img`
//!   隐式编码）；`None` = 按百万 Token 计费（四维费率 + 可选阶梯）；
//! - `PerRequest`（按次）无 wire 表达且无生产构造方，已作为死枚举删除。

use serde::{Deserialize, Serialize};

pub use crate::models::catalog_types::PricingTier;
use crate::models::catalog_types::{CurrencyKind, ModelPricingSpec};

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
    /// 计算单次调用的四维双币微元账目（唯一算费入口，直接消费 catalog SSOT）
    ///
    /// 计费模式由 `pricing.per_image` 显式判定：
    /// - `Some(rate)` → 按张计费：`completion_tokens` 解释为张数，每张单价 = rate；
    /// - `None` → 按百万 Token 计费（含阶梯检索与缓存扣减）。
    ///
    /// 若 `pricing_opt` 为 `None`，返回 `None` 实现空配置静默 (Zero-Cost Silence)。
    pub fn calculate_cost(
        pricing_opt: &Option<ModelPricingSpec>,
        prompt_tokens: u64,
        completion_tokens: u64,
        cache_read_tokens: u64,
        cache_write_tokens: u64,
    ) -> Option<CostBreakdown> {
        let pricing = pricing_opt.as_ref()?;

        // 显式免费模型判断：必须且仅当不存在阶梯计费、无按张费率且
        // 所有四项 Token 费率均为 0.0 时，才允许短路返回全免
        // （per_image 必须参与判定：纯生图模型 input/output 常为 0，费率在 per_image）
        if pricing.tiers.is_empty()
            && pricing.per_image.unwrap_or(0.0) == 0.0
            && pricing.input == 0.0
            && pricing.output == 0.0
            && pricing.cache_read.unwrap_or(0.0) == 0.0
            && pricing.cache_write.unwrap_or(0.0) == 0.0
        {
            return Some(CostBreakdown::free(pricing.currency));
        }

        // 分支 1：按张计费模式 (PerImage)——费率显式来自 spec.per_image，
        // 绝不借用 output 字段编码（无 input=0/output=per_img 信息损失）
        if let Some(rate_per_image) = pricing.per_image {
            let image_count = completion_tokens;
            let rate_micros_per_image = Self::f64_to_micros(rate_per_image);
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

        // 分支 2：按百万 Token 计费模式 (Per1mTokens)
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

    /// 基于 ProviderUsage 与 ModelPricingSpec 计算费用（会话流结算权威入口）
    pub fn calculate_cost_from_usage(
        pricing_opt: &Option<ModelPricingSpec>,
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
