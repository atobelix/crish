//! 模型目录查询方法集（定价、窗口、能力位与长度分档/峰谷查询）

use super::{peak_pricing_2x_at, tier_for_tokens, TieredPriceTier};

use super::entry::ModelCatalogEntry;
use super::store::ModelCatalog;

impl ModelCatalog {
    /// 完整身份的精确查询；缺失返回 None，不改型号、不查默认、不跨供应商。
    pub fn lookup(&self, vendor: &str, model: &str) -> Option<&ModelCatalogEntry> {
        self.entries.get(&ModelCatalogEntry::key(vendor, model))
    }

    /// 便捷：上下文窗口钳制（P4/压缩层消费；窗口缺失 → None）
    pub fn context_window_for(&self, vendor: &str, model: &str) -> Option<u64> {
        self.lookup(vendor, model)
            .and_then(|entry| entry.context_window)
    }

    /// 便捷：输出上限
    pub fn max_output_for(&self, vendor: &str, model: &str) -> Option<u64> {
        self.lookup(vendor, model)
            .and_then(|entry| entry.max_output_tokens)
    }

    /// 便捷：最低可缓存前缀（条目缺失或未收录 → 回退 1024，
    /// 对齐 litellm `DEFAULT_MINIMUM_PROMPT_CACHE_TOKEN_COUNT`）
    pub fn prompt_cache_min_tokens_for(&self, vendor: &str, model: &str) -> u64 {
        self.lookup(vendor, model)
            .and_then(|entry| entry.prompt_cache_min_tokens)
            .unwrap_or(1024)
    }

    /// 便捷：缓存资格判定（未知模型保守为不支持，对齐 jcode"否则视为不支持"）
    pub fn supports_prompt_caching_for(&self, vendor: &str, model: &str) -> bool {
        self.lookup(vendor, model)
            .is_some_and(|entry| entry.supports_prompt_caching)
    }

    /// 便捷：Responses API 支持（engine.rs `provider_url` 判定用；未知模型保守为不支持）
    pub fn supports_responses_for(&self, vendor: &str, model: &str) -> bool {
        self.lookup(vendor, model)
            .is_some_and(|entry| entry.supports_responses)
    }

    // ===== v2 四价查询（v2 Schema §2 C/D 组语义；全部 Option，缺失 = 未收录）=====

    /// 便捷：未缓存输入价（per_1M）
    pub fn input_price_for(&self, vendor: &str, model: &str) -> Option<f64> {
        self.lookup(vendor, model)
            .and_then(|entry| entry.input_price)
    }

    /// 便捷：输出价（per_1M）
    pub fn output_price_for(&self, vendor: &str, model: &str) -> Option<f64> {
        self.lookup(vendor, model)
            .and_then(|entry| entry.output_price)
    }

    /// 便捷：缓存命中价（per_1M）
    pub fn cache_read_price_for(&self, vendor: &str, model: &str) -> Option<f64> {
        self.lookup(vendor, model)
            .and_then(|entry| entry.cache_read_price)
    }

    /// 便捷：通用写价（per_1M）。语义 = 条目 `cacheWritePrice`；Anthropic 系无
    /// 通用写价只有 5m/1h 双档时兜底 `cacheWritePrice5m`（对齐前端费率表
    /// `writePerMTok` 规则：cacheWritePrice ?? cacheWritePrice5m ?? 0，03 §8.2）。
    pub fn cache_write_price_for(&self, vendor: &str, model: &str) -> Option<f64> {
        self.lookup(vendor, model)
            .and_then(|entry| entry.cache_write_price.or(entry.cache_write_price_5m))
    }

    /// 便捷：Anthropic 5m 档写价（per_1M）
    pub fn cache_write_price_5m_for(&self, vendor: &str, model: &str) -> Option<f64> {
        self.lookup(vendor, model)
            .and_then(|entry| entry.cache_write_price_5m)
    }

    /// 便捷：Anthropic 1h 档写价（per_1M）
    pub fn cache_write_price_1h_for(&self, vendor: &str, model: &str) -> Option<f64> {
        self.lookup(vendor, model)
            .and_then(|entry| entry.cache_write_price_1h)
    }

    /// 便捷：写免费显式位（v2 三态语义：true = 写免费；false = 有写价或未收录；
    /// 未知模型保守 false）
    pub fn cache_write_free_for(&self, vendor: &str, model: &str) -> bool {
        self.lookup(vendor, model)
            .is_some_and(|entry| entry.cache_write_free)
    }

    /// 便捷：计价币种（USD / CNY；未知模型 = None，禁止隐式 USD）
    pub fn currency_for(&self, vendor: &str, model: &str) -> Option<&str> {
        self.lookup(vendor, model)
            .and_then(|entry| entry.currency.as_deref())
    }

    /// 便捷：缓存存储费（/1M·h；免费档 = 0，未收录 = None）
    pub fn storage_price_per_1m_hour_for(&self, vendor: &str, model: &str) -> Option<f64> {
        self.lookup(vendor, model)
            .and_then(|entry| entry.storage_price_per_1m_hour)
    }

    /// 便捷：价格形态（"official" | "derived" | "unavailable"；缺省 = official）
    pub fn price_status_for(&self, vendor: &str, model: &str) -> Option<&str> {
        self.lookup(vendor, model)
            .and_then(|entry| entry.price_status.as_deref())
    }

    // ===== 长度分档与峰谷定价消费（DEEPCHECK-05 #8：tieredPricing/peakPricing 双端消费）=====
    //
    // 此前 tieredPricing / peakPricingSchedule 仅解析与测试消费，长上下文档
    // （≥32K/≥128K/≥200K/≥256K/≥272K/≥512K，catalog.json 43 条档位）无计价查询，
    // 长上下文成本系统性低估约 45%（DEEPCHECK-05 §8 量化）。本区提供：
    // - `tiered_tier_for`：输入长度分档命中（litellm `[min, max)` 半开区间）；
    // - `input_price_for_tokens` 等四价变体：档内覆盖价 ?? 基础四价；
    // - `is_long_context_for`：长上下文档判定（无上界档，即 v1 longContextThreshold
    //   迁移语义——Gemini/Grok/OpenAI ≥200K 全 token 2x 计费档）；
    // - `peak_pricing_2x_for`：DeepSeek 峰谷判定（北京时间 9-12 / 14-18 2x）。
    // 全部为纯查询，不改变既有 `*_for` 签名（基础价语义保持，调用方零迁移）。
    // 纯函数底（tier_for_tokens / peak_pricing_2x_at）随域拆至 catalog_price.rs。

    /// 输入长度分档命中（对齐 litellm `tiered_pricing` 的 `range: [min, max)`
    /// 半开区间：`minTokens` 含下界、`maxTokens` 不含上界、`maxTokens = None`
    /// 为无上界长上下文档档）。未收录 / 无档 / 长度不落任何档 → None
    /// （调用方沿用基础四价）。
    pub fn tiered_tier_for(
        &self,
        vendor: &str,
        model: &str,
        input_tokens: u64,
    ) -> Option<&TieredPriceTier> {
        let entry = self.lookup(vendor, model)?;
        tier_for_tokens(entry.tiered_pricing.as_deref(), input_tokens)
    }

    /// 长上下文档判定：输入长度命中**无上界档**（只写 `minTokens` 的 2x 档，
    /// v1 `longContextThreshold`/`longContextInputPrice` 迁移语义；如 Gemini 3.1
    /// Pro / Grok 4.5 / GPT-5.5 pro ≥200K 全量 2x 计费）。无档模型恒 false。
    pub fn is_long_context_for(&self, vendor: &str, model: &str, input_tokens: u64) -> bool {
        self.tiered_tier_for(vendor, model, input_tokens)
            .is_some_and(|tier| tier.max_tokens.is_none())
    }

    /// 分档未缓存输入价（per_1M）：档内覆盖价 ?? 基础四价；未收录 → None
    pub fn input_price_for_tokens(
        &self,
        vendor: &str,
        model: &str,
        input_tokens: u64,
    ) -> Option<f64> {
        let entry = self.lookup(vendor, model)?;
        tier_for_tokens(entry.tiered_pricing.as_deref(), input_tokens)
            .and_then(|tier| tier.input_price)
            .or(entry.input_price)
    }

    /// 分档输出价（per_1M）：档内覆盖价 ?? 基础四价；未收录 → None
    pub fn output_price_for_tokens(
        &self,
        vendor: &str,
        model: &str,
        input_tokens: u64,
    ) -> Option<f64> {
        let entry = self.lookup(vendor, model)?;
        tier_for_tokens(entry.tiered_pricing.as_deref(), input_tokens)
            .and_then(|tier| tier.output_price)
            .or(entry.output_price)
    }

    /// 分档缓存命中价（per_1M）：档内覆盖价 ?? 基础四价；未收录 → None
    pub fn cache_read_price_for_tokens(
        &self,
        vendor: &str,
        model: &str,
        input_tokens: u64,
    ) -> Option<f64> {
        let entry = self.lookup(vendor, model)?;
        tier_for_tokens(entry.tiered_pricing.as_deref(), input_tokens)
            .and_then(|tier| tier.cache_read_price)
            .or(entry.cache_read_price)
    }

    /// 分档通用写价（per_1M）：档内覆盖价 ?? [Self::cache_write_price_for]
    /// （基础通用写价含 Anthropic `cacheWritePrice5m` 兜底语义）；未收录 → None
    pub fn cache_write_price_for_tokens(
        &self,
        vendor: &str,
        model: &str,
        input_tokens: u64,
    ) -> Option<f64> {
        self.tiered_tier_for(vendor, model, input_tokens)
            .and_then(|tier| tier.cache_write_price)
            .or_else(|| self.cache_write_price_for(vendor, model))
    }

    /// 峰谷定价判定（DeepSeek `peakPricing2x` 消费面）：当前 UTC 时刻
    /// （epoch 秒）是否落在 [PeakPricingSchedule] 的北京时间窗口内。
    ///
    /// 规则（保守不高估成本）：
    /// - `peak_pricing_2x = false` / 无 schedule / `tz` 非 `Asia/Shanghai`
    ///   （仅支持 UTC+8，其余时区无法换算 → false）；
    /// - `effectiveFrom`（YYYY-MM-DD）未到（北京当日 0 点起生效）→ false；
    /// - 窗口 `"HH:MM-HH:MM"` 左闭右开（09:00 入峰、12:00 出峰）；
    /// - 任何解析失败 → false。
    pub fn peak_pricing_2x_for(&self, vendor: &str, model: &str, now_utc_secs: u64) -> bool {
        let Some(entry) = self.lookup(vendor, model) else {
            return false;
        };
        peak_pricing_2x_at(entry, now_utc_secs)
    }
}
