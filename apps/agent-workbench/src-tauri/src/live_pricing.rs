//! 计费取价适配（plans/05 T5.2）：唯一取价源 = `live_catalog`（yaml 投影）。
//!
//! 结算只读 live：禁止 `bundled_catalog()` / `catalog.json` / LS 价表。
//! 精确键 lookup `(provider_id, model_id)`，禁止模型名模糊 `includes`
//! （`pricingResolver.ts:62-68` 旧病）。
//!
//! 无条目或无 `pricing` → `None`（未定价三态之一，不是 0）。

use agent_provider::pricing::ModelPricing;

/// live yaml 单价 → [ModelPricing]（plans/05 §3.5）。
/// provider_id = yaml 树 `providers.<id>` 键（与 `EngineProviderConfig` 身份同一）。
pub(crate) fn live_model_pricing(provider_id: &str, model_id: &str) -> Option<ModelPricing> {
    let live = crate::engine_provider::protocol::live_catalog();
    let spec = live.find(provider_id, model_id)?;
    let pricing = spec.pricing.as_ref()?;
    Some(ModelPricing::from(pricing.clone()))
}
