/**
 * CATALOG_CACHE_RATES 静态表 — OpenAI + Anthropic 条目（聚合导出口）
 * （从 pricingStore.ts 拆出，T4-11 SR-06-R1；T4-11 R2 按厂商进一步细分）。
 *
 * 数据源：docs/cache-optimization/10-model-catalog-v2/04-master-model-list.md
 * （R2 汇总 2026-08-03，唯一数据源；R3 不得越过本表）。数据日期 2026-08-03。
 * 转录范围：四指标完整且非「明确不转录」（§13.4：已下线/非对话/未获取）条目；
 * 双币种厂商每模型单条（v1 catalog.json 默认直连口径），CNY/USD 双条目归服务端。
 * 基础四价 = 首档；tieredPricing 档位 P1B 起随条目收录（估算按 input 长度落档，
 * 见 resolve4dPricesForTokens）。
 * 别名/旧键条目（v1 catalog.json 或旧费率表形态）与官方 ID 同价，注释标注。
 * 键名规则：官方 API ID 直抄；GLM/MiniMax/Qwen 等点号异形按 schema §1.4
 * 保留目录横线形态的旧键作为别名。
 *
 * 实现明细按厂商拆分到子文件，本文件仅作聚合再导出，保持消费方 import 路径不变：
 * - pricingCatalogDataOpenAI.ts：CATALOG_RATES_OPENAI（§1.1 + §1.3 旧轨）
 * - pricingCatalogDataAnthropic.ts：CATALOG_RATES_ANTHROPIC（§2.1 P0 11 条）
 */

export { CATALOG_RATES_OPENAI } from './pricingCatalogDataOpenAI';
export { CATALOG_RATES_ANTHROPIC } from './pricingCatalogDataAnthropic';
