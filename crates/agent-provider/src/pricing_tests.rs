use super::*;

// -------------------------------------------------------------------------
// 测试 1: DeepSeek 2026 真实单价折算（输入 ¥3.00, 输出 ¥12.00, 缓存读取 ¥0.10）
// -------------------------------------------------------------------------
#[test]
fn test_deepseek_2026_real_pricing() {
    let pricing = ModelPricingSpec {
        currency: CurrencyKind::Cny,
        input: 3.00,
        output: 12.00,
        cache_read: Some(0.10),
        cache_write: None,
        per_image: None,
        tiers: vec![],
    };

    // 场景：总输入 100,000 tokens，其中 80,000 tokens 命中缓存读取；输出 20,000 tokens
    let cost = PricingEngine::calculate_cost(
        &Some(pricing),
        100_000, // prompt_tokens
        20_000,  // completion_tokens
        80_000,  // cache_read_tokens
        0,       // cache_write_tokens
    )
    .expect("计费应成功");

    // 未命中普通输入 = 100,000 - 80,000 = 20,000 tokens
    // input_micros = 20,000 * 3.0 / 1M = 60,000 micros (¥0.0600)
    // cache_read_micros = 80,000 * 0.10 / 1M = 8,000 micros (¥0.0080)
    // cache_write_micros = 0
    // output_micros = 20,000 * 12.00 / 1M = 240,000 micros (¥0.2400)
    // total_micros = 60,000 + 8,000 + 0 + 240,000 = 308,000 micros (¥0.3080)
    assert_eq!(cost.currency, CurrencyKind::Cny);
    assert_eq!(cost.input_micros, 60_000);
    assert_eq!(cost.cache_read_micros, 8_000);
    assert_eq!(cost.cache_write_micros, 0);
    assert_eq!(cost.output_micros, 240_000);
    assert_eq!(cost.total_micros, 308_000);
    assert_eq!(cost.formatted_total, "¥0.3080");
    assert!(!cost.is_free);
    assert!((cost.total_as_f64() - 0.308).abs() < 1e-9);
}

// -------------------------------------------------------------------------
// 测试 2: Anthropic Claude 5 真实单价折算（输入 $5.00, 输出 $25.00, 缓存读取 $0.50, 写入 $6.25）
// -------------------------------------------------------------------------
#[test]
fn test_claude_5_real_pricing() {
    let pricing = ModelPricingSpec {
        currency: CurrencyKind::Usd,
        input: 5.00,
        output: 25.00,
        cache_read: Some(0.50),
        cache_write: Some(6.25),
        per_image: None,
        tiers: vec![],
    };

    // 场景：总输入 200,000 tokens，其中 150,000 命中缓存读取，50,000 为首次缓存写入；输出 10,000 tokens
    let cost = PricingEngine::calculate_cost(&Some(pricing), 200_000, 10_000, 150_000, 50_000)
        .expect("计费应成功");

    // 未命中普通输入 = 200,000 - 150,000 = 50,000 tokens
    // input_micros = 50,000 * 5.00 / 1M = 250,000 micros ($0.2500)
    // cache_read_micros = 150,000 * 0.50 / 1M = 75,000 micros ($0.0750)
    // cache_write_micros = 50,000 * 6.25 / 1M = 312,500 micros ($0.3125)
    // output_micros = 10,000 * 25.00 / 1M = 250,000 micros ($0.2500)
    // total_micros = 250,000 + 75,000 + 312,500 + 250,000 = 887,500 micros ($0.8875)
    assert_eq!(cost.currency, CurrencyKind::Usd);
    assert_eq!(cost.input_micros, 250_000);
    assert_eq!(cost.cache_read_micros, 75_000);
    assert_eq!(cost.cache_write_micros, 312_500);
    assert_eq!(cost.output_micros, 250_000);
    assert_eq!(cost.total_micros, 887_500);
    assert_eq!(cost.formatted_total, "$0.8875");
    assert!(!cost.is_free);
    assert!((cost.total_as_f64() - 0.8875).abs() < 1e-9);
}

// -------------------------------------------------------------------------
// 测试 3: 393K 超长上下文与大 Token 数的大整数防溢出
// -------------------------------------------------------------------------
#[test]
fn test_ultra_long_393k_context_large_token_anti_overflow() {
    let pricing = ModelPricingSpec {
        currency: CurrencyKind::Cny,
        input: 10.0,
        output: 30.0,
        cache_read: None,
        cache_write: None,
        per_image: None,
        tiers: vec![],
    };

    // 满载生成 393,216 tokens
    let cost = PricingEngine::calculate_cost(
        &Some(pricing),
        1_000_000, // 1M 输入
        393_216,   // 393K 输出
        0,
        0,
    )
    .expect("计费应成功");

    // 1M * 10 = 10 元 = 10,000,000 micros
    // 393,216 * 30 / 1_000_000 = 11.79648 元 = 11,796,480 micros
    // Total = 21,796,480 micros
    assert_eq!(cost.output_micros, 11_796_480);
    assert_eq!(cost.total_micros, 21_796_480);
    assert_eq!(cost.formatted_total, "¥21.7965");

    // 极端大数测试：500,000,000 tokens (5亿 tokens) 单价 $100.0/1M
    // 验证 u128 宽位计算不发生溢出 panic
    let huge_pricing = ModelPricingSpec {
        currency: CurrencyKind::Usd,
        input: 100.0,
        output: 100.0,
        cache_read: None,
        cache_write: None,
        per_image: None,
        tiers: vec![],
    };
    let huge_cost =
        PricingEngine::calculate_cost(&Some(huge_pricing), 500_000_000, 500_000_000, 0, 0)
            .expect("大数计算不应溢出");

    // 500M * 100 / 1M = 50,000 元 = 50,000,000,000 micros
    assert_eq!(huge_cost.input_micros, 50_000_000_000);
    assert_eq!(huge_cost.output_micros, 50_000_000_000);
    assert_eq!(huge_cost.total_micros, 100_000_000_000);
    assert_eq!(huge_cost.formatted_total, "$100000.0000");
}

// -------------------------------------------------------------------------
// 测试 4: 空配置静默机制 (返回 None)
// -------------------------------------------------------------------------
#[test]
fn test_unconfigured_pricing_returns_silent_none() {
    let cost = PricingEngine::calculate_cost(&None, 10_000, 2_000, 0, 0);
    assert!(cost.is_none(), "未配置价格必须绝对静默返回 None");
}

// -------------------------------------------------------------------------
// Case 01: Prompt Cache 读写微元精确折算 (Plan 05 魔鬼用例对齐)
// -------------------------------------------------------------------------
#[test]
fn test_devil_01_cache_read_write_exact_micros_deduction() {
    // 测试 Claude 3.7 / 5 官方计费：输入 $3.00, 缓存写 $3.75, 缓存读 $0.30
    let pricing = ModelPricingSpec {
        currency: CurrencyKind::Usd,
        input: 3.00,
        output: 15.00,
        cache_read: Some(0.30),
        cache_write: Some(3.75),
        per_image: None,
        tiers: vec![],
    };

    // 场景：输入 200,000 tokens，其中 150,000 命中缓存读取，50,000 为首次缓存写入
    let cost = PricingEngine::calculate_cost(
        &Some(pricing),
        200_000,
        10_000,  // 输出 10,000
        150_000, // 缓存命中 150k
        50_000,  // 缓存写入 50k
    )
    .expect("计费应成功");

    // 普通输入 = 200k - 150k = 50k * $3.00 = 150,000 micros ($0.15)
    // 缓存读取 = 150k * $0.30 = 45,000 micros ($0.045)
    // 缓存写入 = 50k * $3.75 = 187,500 micros ($0.1875)
    // 输出 = 10k * $15.00 = 150,000 micros ($0.15)
    // Total = 150,000 + 45,000 + 187,500 + 150,000 = 532,500 micros ($0.5325)
    assert_eq!(cost.input_micros, 150_000);
    assert_eq!(cost.cache_read_micros, 45_000);
    assert_eq!(cost.cache_write_micros, 187_500);
    assert_eq!(cost.output_micros, 150_000);
    assert_eq!(cost.total_micros, 532_500);
    assert_eq!(cost.formatted_total, "$0.5325");
}

// -------------------------------------------------------------------------
// Case 02: 双币种格式化与跨币种独立隔离 (Plan 05 魔鬼用例对齐)
// -------------------------------------------------------------------------
#[test]
fn test_devil_02_dual_currency_formatting_and_isolation() {
    let cny_pricing = ModelPricingSpec {
        currency: CurrencyKind::Cny,
        input: 2.0,
        output: 6.0,
        cache_read: None,
        cache_write: None,
        per_image: None,
        tiers: vec![],
    };
    let usd_pricing = ModelPricingSpec {
        currency: CurrencyKind::Usd,
        input: 2.0,
        output: 6.0,
        cache_read: None,
        cache_write: None,
        per_image: None,
        tiers: vec![],
    };

    let cost_cny = PricingEngine::calculate_cost(&Some(cny_pricing), 10_000, 5_000, 0, 0).unwrap();
    let cost_usd = PricingEngine::calculate_cost(&Some(usd_pricing), 10_000, 5_000, 0, 0).unwrap();

    assert_eq!(cost_cny.currency, CurrencyKind::Cny);
    assert!(cost_cny.formatted_total.starts_with('¥'));
    assert_eq!(cost_usd.currency, CurrencyKind::Usd);
    assert!(cost_usd.formatted_total.starts_with('$'));

    // 极小额度展示 6 位小数测试 (500 micros = 0.000500)
    let micro_cny = PricingEngine::format_micros(500, CurrencyKind::Cny);
    assert_eq!(micro_cny, "¥0.000500");
}

// -------------------------------------------------------------------------
// Case 03: 393,216 Tokens (393K) 满载输出防溢出 (Plan 05 魔鬼用例对齐)
// -------------------------------------------------------------------------
#[test]
fn test_devil_03_ultra_long_393k_output_u64_anti_overflow() {
    let pricing = ModelPricingSpec {
        currency: CurrencyKind::Cny,
        input: 10.0,
        output: 30.0,
        cache_read: None,
        cache_write: None,
        per_image: None,
        tiers: vec![],
    };

    // 模拟满载生成 393,216 tokens
    let cost = PricingEngine::calculate_cost(
        &Some(pricing),
        1_000_000, // 1M 输入
        393_216,   // 393K 输出
        0,
        0,
    )
    .unwrap();

    // 1M * 10 = 10 元 = 10,000,000 micros
    // 393,216 * 30 / 1_000_000 = 11.79648 元 = 11,796,480 micros
    // Total = 21,796,480 micros
    assert_eq!(cost.output_micros, 11_796_480);
    assert_eq!(cost.total_micros, 21_796_480);
    assert_eq!(cost.formatted_total, "¥21.7965");
}

// -------------------------------------------------------------------------
// Case 06: 空价格静默机制 (Plan 05 魔鬼用例对齐)
// -------------------------------------------------------------------------
#[test]
fn test_devil_06_unconfigured_pricing_returns_silent_none() {
    let cost = PricingEngine::calculate_cost(&None, 10_000, 2_000, 0, 0);
    assert!(cost.is_none(), "未配置价格必须绝对静默返回 None");
}

// -------------------------------------------------------------------------
// Case 07: 阶梯计费临界点精准等于 inputTokensAbove (Plan 05 魔鬼用例对齐)
// -------------------------------------------------------------------------
#[test]
fn test_devil_07_tiered_pricing_exact_threshold_boundary_ge() {
    let pricing = ModelPricingSpec {
        currency: CurrencyKind::Cny,
        input: 2.0,
        output: 8.0,
        cache_read: None,
        cache_write: None,
        per_image: None,
        tiers:         vec![PricingTier {
            input_tokens_above: 262_144,
            input: 4.0, // 达到门槛翻倍
            output: 16.0,
            cache_read: None,
            cache_write: None,
        }],
    };

    // 临界点精确等于 262,144 tokens (>= 判定)
    let cost = PricingEngine::calculate_cost(&Some(pricing), 262_144, 10_000, 0, 0).unwrap();
    // 命中新阶梯：262,144 * 4.0 / 1M = 1.048576 元 = 1,048,576 micros
    assert_eq!(cost.input_micros, 1_048_576);
}

// -------------------------------------------------------------------------
// Case 09: 生图按张 (PerImage) 定点整数计费 (Plan 05 魔鬼用例对齐)
// -------------------------------------------------------------------------
#[test]
fn test_devil_09_image_generation_per_image_micros_pricing() {
    let pricing = ModelPricingSpec {
        currency: CurrencyKind::Cny,
        input: 0.0,
        output: 0.0,
        cache_read: None,
        cache_write: None,
        per_image: Some(0.20), // 每张 ¥0.20（费率显式在 per_image 字段）
        tiers: vec![],
    };

    // 生成 3 张图片
    let cost = PricingEngine::calculate_cost(&Some(pricing), 0, 3, 0, 0).unwrap();
    // 3 * 0.20 = 0.60 元 = 600,000 micros
    assert_eq!(cost.total_micros, 600_000);
    assert_eq!(cost.formatted_total, "¥0.6000");
}

// -------------------------------------------------------------------------
// Case 19: 显式免费与静默缺省严格区分 (Plan 05 魔鬼用例对齐)
// -------------------------------------------------------------------------
#[test]
fn test_devil_19_explicit_zero_price_marked_as_free_not_silent() {
    let zero_pricing = ModelPricingSpec {
        currency: CurrencyKind::Cny,
        input: 0.0,
        output: 0.0,
        cache_read: None,
        cache_write: None,
        per_image: None,
        tiers: vec![],
    };
    let cost = PricingEngine::calculate_cost(&Some(zero_pricing), 1000, 500, 0, 0).unwrap();
    assert!(cost.is_free);
    assert_eq!(cost.formatted_total, "免费");
    assert_eq!(cost.total_micros, 0);
}

// -------------------------------------------------------------------------
// Case 20: 混合会话多 Agent 跨币种独立分账 (Plan 05 魔鬼用例对齐)
// -------------------------------------------------------------------------
#[test]
fn test_devil_20_multi_agent_cross_currency_billing_session_aggregation() {
    let mut session_cny_micros = 0u64;
    let mut session_usd_micros = 0u64;

    // Agent 1: DeepSeek 国内站 (CNY)
    session_cny_micros += 50_000;
    // Agent 2: OpenAI (USD)
    session_usd_micros += 12_000;

    let formatted_cny = PricingEngine::format_micros(session_cny_micros, CurrencyKind::Cny);
    let formatted_usd = PricingEngine::format_micros(session_usd_micros, CurrencyKind::Usd);

    assert_eq!(formatted_cny, "¥0.0500");
    assert_eq!(formatted_usd, "$0.0120");
}

// -------------------------------------------------------------------------
// 测试: 浮点数累加误差根除验证
// -------------------------------------------------------------------------
#[test]
fn test_floating_point_precision_losslessness() {
    // 浮点数运算中 0.1 + 0.2 != 0.3
    let float_sum = 0.1f64 + 0.2f64;
    assert_ne!(float_sum, 0.3f64);

    // 微元定点运算中 100,000 + 200,000 == 300,000 绝对精确
    let micro_a = PricingEngine::f64_to_micros(0.1);
    let micro_b = PricingEngine::f64_to_micros(0.2);
    let micro_sum = micro_a + micro_b;
    assert_eq!(micro_sum, 300_000);
    assert_eq!(
        PricingEngine::format_micros(micro_sum, CurrencyKind::Usd),
        "$0.3000"
    );
}

// -------------------------------------------------------------------------
// 测试: 缓存读取超过总输入时的防溢出保护 (saturating_sub)
// -------------------------------------------------------------------------
#[test]
fn test_cache_read_exceeds_prompt_tokens_saturating() {
    let pricing = ModelPricingSpec {
        currency: CurrencyKind::Usd,
        input: 2.0,
        output: 4.0,
        cache_read: Some(0.2),
        cache_write: None,
        per_image: None,
        tiers: vec![],
    };

    // 异常或非对称数据：cache_read (20,000) > prompt_tokens (10,000)
    let cost = PricingEngine::calculate_cost(&Some(pricing), 10_000, 0, 20_000, 0).unwrap();
    assert_eq!(cost.input_micros, 0); // saturating_sub 归零，不 panic
    assert_eq!(cost.cache_read_micros, 4_000);
    assert_eq!(cost.total_micros, 4_000);
}

// -------------------------------------------------------------------------
// 测试: 货币格式化进位防错 (999_960 微元进位到 1.0000)
// -------------------------------------------------------------------------
#[test]
fn test_formatting_carry_rounding() {
    // 999_960 微元，四舍五入到4位小数进位为 1.0000
    let formatted = PricingEngine::format_micros(999_960, CurrencyKind::Usd);
    assert_eq!(formatted, "$1.0000");

    // 0 微元
    let formatted_zero = PricingEngine::format_micros(0, CurrencyKind::Cny);
    assert_eq!(formatted_zero, "¥0.0000");

    // 1 微元 (<1000 微元展示 6 位小数)
    let formatted_one = PricingEngine::format_micros(1, CurrencyKind::Cny);
    assert_eq!(formatted_one, "¥0.000001");
}

// -------------------------------------------------------------------------
// 测试: 引擎直接消费 ModelPricingSpec（SSOT 收敛后无中间 DTO）
// -------------------------------------------------------------------------
#[test]
fn test_catalog_types_model_pricing_spec_interop() {
    let spec = ModelPricingSpec {
        currency: CurrencyKind::Cny,
        input: 3.0,
        output: 9.0,
        cache_read: Some(0.1),
        cache_write: Some(0.0),
        per_image: None,
        tiers: Vec::new(),
    };

    let cost =
        PricingEngine::calculate_cost(&Some(spec), 100_000, 10_000, 50_000, 0).expect("Spec 计费应成功");

    // non_cached_prompt = 50_000 * 3.0 = 150_000 micros
    // cache_read = 50_000 * 0.1 = 5_000 micros
    // output = 10_000 * 9.0 = 90_000 micros
    // total = 245_000 micros
    assert_eq!(cost.currency, CurrencyKind::Cny);
    assert_eq!(cost.input_micros, 150_000);
    assert_eq!(cost.cache_read_micros, 5_000);
    assert_eq!(cost.output_micros, 90_000);
    assert_eq!(cost.total_micros, 245_000);
    assert_eq!(cost.formatted_total, "¥0.2450");
}

// -------------------------------------------------------------------------
// 测试: Serde JSON 序列化与反序列化（ModelPricingSpec 为唯一计费 DTO）
// -------------------------------------------------------------------------
#[test]
fn test_serde_roundtrip() {
    let pricing = ModelPricingSpec {
        currency: CurrencyKind::Usd,
        input: 3.0,
        output: 15.0,
        cache_read: Some(0.3),
        cache_write: Some(3.75),
        per_image: None,
        tiers: vec![PricingTier {
            input_tokens_above: 100_000,
            input: 2.5,
            output: 12.0,
            cache_read: Some(0.25),
            cache_write: Some(3.0),
        }],
    };

    let json_str = serde_json::to_string(&pricing).unwrap();
    let deserialized: ModelPricingSpec = serde_json::from_str(&json_str).unwrap();
    assert_eq!(pricing, deserialized);

    let cost = PricingEngine::calculate_cost(&Some(pricing), 50_000, 10_000, 0, 0).unwrap();
    let cost_json = serde_json::to_string(&cost).unwrap();
    let deserialized_cost: CostBreakdown = serde_json::from_str(&cost_json).unwrap();
    assert_eq!(cost, deserialized_cost);
}

// -------------------------------------------------------------------------
// 测试: SSOT 收敛后按张计费费率显式来自 per_image 字段
// （不再借用 output 字段做 input=0/output=per_img 隐式编码，无信息损失）
// -------------------------------------------------------------------------
#[test]
fn test_per_image_rate_explicit_not_output_encoded() {
    // 即使 input/output 被误配了 Token 费率，按张计费也只认 per_image 费率
    let image_spec = ModelPricingSpec {
        currency: CurrencyKind::Cny,
        input: 5.0,
        output: 7.0,
        cache_read: None,
        cache_write: None,
        per_image: Some(0.20),
        tiers: Vec::new(),
    };
    let cost = PricingEngine::calculate_cost(&Some(image_spec), 1_000_000, 3, 0, 0).unwrap();
    // 3 张 × ¥0.20 = ¥0.60 = 600,000 micros（绝不是 output 7.0 或 Token 口径）
    assert_eq!(cost.total_micros, 600_000);
    assert_eq!(cost.formatted_total, "¥0.6000");
    assert_eq!(cost.input_micros, 0, "按张计费不产生输入段费用");
}

// -------------------------------------------------------------------------
// 测试: 免费短路判定必须考虑 per_image 费率
// （纯生图模型 input/output 常为 0、费率在 per_image——不得被误判为全免）
// -------------------------------------------------------------------------
#[test]
fn test_free_shortcut_considers_per_image_rate() {
    // input/output 全 0 但 per_image 有费率 → 绝不能短路判全免
    let image_spec = ModelPricingSpec {
        currency: CurrencyKind::Cny,
        input: 0.0,
        output: 0.0,
        cache_read: None,
        cache_write: None,
        per_image: Some(0.20),
        tiers: Vec::new(),
    };
    let cost = PricingEngine::calculate_cost(&Some(image_spec), 0, 3, 0, 0).unwrap();
    assert!(!cost.is_free, "有 per_image 费率时绝不得标记为免费");
    assert_eq!(cost.total_micros, 600_000);

    // per_image 显式 0.0 + 四价 0 + 无阶梯 → 显式全免
    let free_image_spec = ModelPricingSpec {
        currency: CurrencyKind::Cny,
        input: 0.0,
        output: 0.0,
        cache_read: None,
        cache_write: None,
        per_image: Some(0.0),
        tiers: Vec::new(),
    };
    let free_cost = PricingEngine::calculate_cost(&Some(free_image_spec), 0, 3, 0, 0).unwrap();
    assert!(free_cost.is_free);
    assert_eq!(free_cost.formatted_total, "免费");
}

// -------------------------------------------------------------------------
// 测试: NaN / Infinity / 负数防崩异常防御
// -------------------------------------------------------------------------
#[test]
fn test_nan_and_infinity_defense() {
    assert_eq!(PricingEngine::tokens_to_micros(100_000, f64::NAN), 0);
    assert_eq!(PricingEngine::tokens_to_micros(100_000, f64::INFINITY), 0);
    assert_eq!(
        PricingEngine::tokens_to_micros(100_000, f64::NEG_INFINITY),
        0
    );
    assert_eq!(PricingEngine::tokens_to_micros(100_000, -5.0), 0);
    assert_eq!(PricingEngine::f64_to_micros(f64::NAN), 0);
    assert_eq!(PricingEngine::f64_to_micros(f64::INFINITY), 0);
    assert_eq!(PricingEngine::f64_to_micros(-1.0), 0);
}

// -------------------------------------------------------------------------
// 测试: Default 默认值契约（币种 SSOT = CurrencyKind）
// -------------------------------------------------------------------------
#[test]
fn test_default_trait_implementations() {
    let def_curr = CurrencyKind::default();
    assert_eq!(def_curr, CurrencyKind::Usd);
    assert_eq!(def_curr.symbol(), "$");
    assert_eq!(def_curr.code(), "USD");
    // 兼容别名路径：pricing::Currency 与 CurrencyKind 同一类型
    let alias_curr = Currency::default();
    assert_eq!(alias_curr, CurrencyKind::Usd);

    let def_breakdown = CostBreakdown::default();
    assert_eq!(def_breakdown.total_micros, 0);
    assert_eq!(def_breakdown.formatted_total, "$0.0000");
}

// -------------------------------------------------------------------------
// 测试: 多阶梯阶梯倒序匹配验证
// -------------------------------------------------------------------------
#[test]
fn test_multi_tier_descending_matching() {
    let pricing = ModelPricingSpec {
        currency: CurrencyKind::Cny,
        input: 1.0,
        output: 2.0,
        cache_read: None,
        cache_write: None,
        per_image: None,
        tiers:         vec![
            PricingTier {
                input_tokens_above: 100_000,
                input: 2.0,
                output: 4.0,
                cache_read: None,
                cache_write: None,
            },
            PricingTier {
                input_tokens_above: 500_000,
                input: 3.0,
                output: 6.0,
                cache_read: None,
                cache_write: None,
            },
        ],
    };

    // 1. 低于 100k -> 基础档 (input: 1.0)
    let c1 = PricingEngine::calculate_cost(&Some(pricing.clone()), 50_000, 0, 0, 0).unwrap();
    assert_eq!(c1.input_micros, 50_000);

    // 2. 达到 100k 但低于 500k -> 档位 1 (input: 2.0)
    let c2 = PricingEngine::calculate_cost(&Some(pricing.clone()), 100_000, 0, 0, 0).unwrap();
    assert_eq!(c2.input_micros, 200_000);

    // 3. 达到 500k -> 档位 2 (input: 3.0)
    let c3 = PricingEngine::calculate_cost(&Some(pricing), 500_000, 0, 0, 0).unwrap();
    assert_eq!(c3.input_micros, 1_500_000);
}

// -------------------------------------------------------------------------
// 测试: 基础价格为 0 但配置了阶梯费率时，绝不被短路误判为全免
// -------------------------------------------------------------------------
#[test]
fn test_base_price_zero_with_tiers_not_short_circuited_as_free() {
    let pricing = ModelPricingSpec {
        currency: CurrencyKind::Cny,
        input: 0.0,
        output: 0.0,
        cache_read: None,
        cache_write: None,
        per_image: None,
        tiers:         vec![PricingTier {
            input_tokens_above: 32_768,
            input: 4.0,
            output: 12.0,
            cache_read: Some(0.5),
            cache_write: None,
        }],
    };

    // 场景 1：用量超过 32,768 门槛，应当命中阶梯计费，绝不能因为基础价格为 0 而短路误判为免费
    let cost = PricingEngine::calculate_cost(&Some(pricing.clone()), 100_000, 20_000, 0, 0)
        .expect("计费应成功");

    assert!(!cost.is_free, "命中收费阶梯时绝不得标记为 is_free");
    assert_ne!(cost.formatted_total, "免费");
    // 100,000 * 4.0 / 1M = 400,000 micros (¥0.4000)
    // 20,000 * 12.0 / 1M = 240,000 micros (¥0.2400)
    // Total = 640,000 micros (¥0.6400)
    assert_eq!(cost.input_micros, 400_000);
    assert_eq!(cost.output_micros, 240_000);
    assert_eq!(cost.total_micros, 640_000);
    assert_eq!(cost.formatted_total, "¥0.6400");

    // 场景 2：用量未达到 32,768 门槛，在免费区间内，费用为 0
    let free_tier_cost = PricingEngine::calculate_cost(&Some(pricing), 10_000, 1_000, 0, 0)
        .expect("免费区间计费应成功");
    assert_eq!(free_tier_cost.total_micros, 0);
    assert_eq!(free_tier_cost.formatted_total, "¥0.0000");
}

// -------------------------------------------------------------------------
// 测试: u64::MAX 极端 Token 数量定点饱和截断，防止回绕为极小随机值
// -------------------------------------------------------------------------
#[test]
fn test_u64_max_extreme_token_saturation_anti_wrapping() {
    let pricing = ModelPricingSpec {
        currency: CurrencyKind::Usd,
        input: 100.0,
        output: 100.0,
        cache_read: None,
        cache_write: None,
        per_image: None,
        tiers: vec![],
    };

    let extreme_tokens = u64::MAX;
    let cost = PricingEngine::calculate_cost(&Some(pricing), extreme_tokens, extreme_tokens, 0, 0)
        .expect("极端大数计算应成功");

    // u64::MAX * 100.0 / 1M 的结果远远超过 u64::MAX，必须饱和截断在 u64::MAX，不能回绕为极小随机值
    assert_eq!(cost.input_micros, u64::MAX);
    assert_eq!(cost.output_micros, u64::MAX);
    assert_eq!(cost.total_micros, u64::MAX);
    assert!(!cost.is_free);

    // 单独验证 tokens_to_micros 饱和截断
    let micros = PricingEngine::tokens_to_micros(u64::MAX, 100.0);
    assert_eq!(micros, u64::MAX);

    // 验证 PerImage 大数饱和截断
    let img_pricing = ModelPricingSpec {
        currency: CurrencyKind::Usd,
        input: 0.0,
        output: 0.0,
        cache_read: None,
        cache_write: None,
        per_image: Some(100.0),
        tiers: vec![],
    };
    let img_cost = PricingEngine::calculate_cost(&Some(img_pricing), 0, u64::MAX, 0, 0)
        .expect("按张极端大数计算应成功");
    assert_eq!(img_cost.output_micros, u64::MAX);
    assert_eq!(img_cost.total_micros, u64::MAX);
}

// -------------------------------------------------------------------------
// 测试: CostBreakdown 与 PricingEngine 的便捷辅助构造与 Usage 结算方法
// -------------------------------------------------------------------------
#[test]
fn test_cost_breakdown_helper_methods_and_usage() {
    use crate::events::ProviderUsage;

    let pricing = ModelPricingSpec {
        currency: CurrencyKind::Cny,
        input: 2.0,
        output: 6.0,
        cache_read: Some(0.2),
        cache_write: Some(1.0),
        per_image: None,
        tiers: vec![],
    };

    let usage = ProviderUsage {
        prompt_tokens: Some(50_000),
        completion_tokens: Some(10_000),
        cache_read_tokens: Some(20_000),
        cache_write_tokens: Some(5_000),
        ..Default::default()
    };

    let cost1 = PricingEngine::calculate_cost_from_usage(&Some(pricing.clone()), &usage).unwrap();
    let cost2 = CostBreakdown::from_usage(&Some(pricing), &usage).unwrap();
    assert_eq!(cost1, cost2);
    // non-cached = 30k * 2.0 = 60,000 micros
    // output = 10k * 6.0 = 60,000 micros
    // read = 20k * 0.2 = 4,000 micros
    // write = 5k * 1.0 = 5,000 micros
    // total = 129,000 micros
    assert_eq!(cost1.total_micros, 129_000);

    let free_breakdown = CostBreakdown::free(CurrencyKind::Cny);
    assert!(free_breakdown.is_free);
    assert_eq!(free_breakdown.formatted_total, "免费");
}
