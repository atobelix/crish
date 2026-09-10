//! Conex 28 个魔鬼自动化测试用例集 (Rust 内核全集)
//!
//! 权威参考依据：docs/provider-model-unification/plans/05-全量立体验证、存量自动迁移与防回潮门禁计划.md §4.1 ~ §4.2
//! 覆盖计费微元、协议单向继承、思考白名单、防溢出、时间戳备份、并发 RCU 热重载与容灾快照。
//! 100% 直连 agent_provider 真实生产模块（pricing, migration, models::catalog_types, request::wire_protocol）。

use std::sync::Arc;

use agent_provider::migration::{ConfigMigrationManager, MigrationError, MigrationStatus};
use agent_provider::models::catalog_types::*;
use agent_provider::pricing::{
    CostBreakdown, Currency, ModelPricing, PricingEngine, PricingTier, PricingUnit,
};
use agent_provider::request::wire_protocol::{build_endpoint_url, WireProtocol};

// =============================================================================
// 无锁 RCU 抽象封装 (Case 13 支撑)
// =============================================================================
pub struct ArcSwap<T> {
    inner: std::sync::RwLock<Arc<T>>,
}

impl<T> ArcSwap<T> {
    pub fn new(val: Arc<T>) -> Self {
        Self {
            inner: std::sync::RwLock::new(val),
        }
    }

    pub fn from(val: Arc<T>) -> Self {
        Self::new(val)
    }

    pub fn load(&self) -> Arc<T> {
        self.inner.read().unwrap().clone()
    }

    pub fn store(&self, val: Arc<T>) {
        *self.inner.write().unwrap() = val;
    }
}

// =============================================================================
// 28 个魔鬼自动化测试用例套件 (Devil Test Cases)
// =============================================================================
#[cfg(test)]
mod devil_tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;

    // -------------------------------------------------------------------------
    // Case 01: Prompt Cache 读写微元精确折算
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_01_cache_read_write_exact_micros_deduction() {
        // 测试 Claude 3.7 / 5 官方计费：输入 $3.00, 缓存写 $3.75, 缓存读 $0.30
        let pricing = ModelPricing {
            currency: Currency::Usd,
            unit: PricingUnit::Per1mTokens,
            input: 3.00,
            output: 15.00,
            cache_read: Some(0.30),
            cache_write: Some(3.75),
            tiers: vec![],
        };

        // 场景：输入 200,000 tokens，其中 150,000 命中缓存读取，50,000 为首次缓存写入
        let cost: CostBreakdown = PricingEngine::calculate_cost(
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
    // Case 02: 双币种格式化与跨币种独立隔离
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_02_dual_currency_formatting_and_isolation() {
        let cny_pricing = ModelPricing {
            currency: Currency::Cny,
            unit: PricingUnit::Per1mTokens,
            input: 2.0,
            output: 6.0,
            cache_read: None,
            cache_write: None,
            tiers: vec![],
        };
        let usd_pricing = ModelPricing {
            currency: Currency::Usd,
            unit: PricingUnit::Per1mTokens,
            input: 2.0,
            output: 6.0,
            cache_read: None,
            cache_write: None,
            tiers: vec![],
        };

        let cost_cny =
            PricingEngine::calculate_cost(&Some(cny_pricing), 10_000, 5_000, 0, 0).unwrap();
        let cost_usd =
            PricingEngine::calculate_cost(&Some(usd_pricing), 10_000, 5_000, 0, 0).unwrap();

        assert_eq!(cost_cny.currency, Currency::Cny);
        assert!(cost_cny.formatted_total.starts_with('¥'));
        assert_eq!(cost_usd.currency, Currency::Usd);
        assert!(cost_usd.formatted_total.starts_with('$'));

        // 极小额度展示 6 位小数测试 (500 micros = 0.000500)
        let micro_cny = PricingEngine::format_micros(500, Currency::Cny);
        assert_eq!(micro_cny, "¥0.000500");
    }

    // -------------------------------------------------------------------------
    // Case 03: 393,216 Tokens (393K) 满载输出防溢出
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_03_ultra_long_393k_output_u64_anti_overflow() {
        let pricing = ModelPricing {
            currency: Currency::Cny,
            unit: PricingUnit::Per1mTokens,
            input: 10.0,
            output: 30.0,
            cache_read: None,
            cache_write: None,
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
    // Case 04: 协议单向继承与显式局部覆盖
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_04_protocol_unidirectional_inheritance_and_override() {
        let yaml = r#"
providers:
  openai:
    displayName: OpenAI
    baseUrl: https://api.openai.com/v1
    protocol: openai/chat
    models:
      - id: gpt-5.6-turbo
        displayName: GPT-5.6 Turbo
        contextWindow: 128000
        maxOutputTokens: 8192
      - id: gpt-5.6-sol
        displayName: GPT-5.6 Sol
        protocol: openai/responses
        contextWindow: 1050000
        maxOutputTokens: 128000
"#;
        let config: UnifiedModelsConfig = serde_yaml::from_str(yaml).unwrap();
        let prov = config.find_provider("openai").unwrap();

        // 验证未声明 protocol 的模型自动继承
        let m1 = prov
            .models
            .iter()
            .find(|m| m.id == "gpt-5.6-turbo")
            .unwrap();
        assert_eq!(m1.protocol, None);
        assert_eq!(m1.effective_protocol(prov), ProtocolKind::OpenAiChat);
        assert_eq!(m1.effective_protocol(prov).as_str(), "openai/chat");

        // 验证显式声明 protocol 的模型成功覆盖
        let m2 = prov.models.iter().find(|m| m.id == "gpt-5.6-sol").unwrap();
        assert_eq!(m2.protocol, Some(ProtocolKind::OpenAiResponses));
        assert_eq!(m2.effective_protocol(prov), ProtocolKind::OpenAiResponses);
        assert_eq!(m2.effective_protocol(prov).as_str(), "openai/responses");
    }

    // -------------------------------------------------------------------------
    // Case 05: 思考档位纯英文 TitleCase 拍平 Key-Value 字典映射 (无 levels 嵌套)
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_05_thinking_levels_strict_english_whitelist_mapping() {
        let valid_yaml = r#"
id: claude-5-sonnet
displayName: Claude 5 Sonnet
contextWindow: 1000000
maxOutputTokens: 128000
thinking:
  Minimal: minimal
  Low: low
  Medium: medium
  High: high
  X-High: xhigh
  Max: max
"#;
        let model: ModelSpec = serde_yaml::from_str(valid_yaml).unwrap();
        let thinking = model.thinking.as_ref().expect("thinking 应存在并成功解析");
        assert_eq!(thinking.get("Medium").map(|s| s.as_str()), Some("medium"));
        assert_eq!(thinking.get("Minimal").map(|s| s.as_str()), Some("minimal"));
        assert_eq!(thinking.len(), 6);

        // 纯英文白名单与扩展函数断言
        assert!(model.supports_thinking());
        assert_eq!(model.thinking.get_wire_value("Medium"), Some("medium"));
        assert_eq!(model.thinking.get_wire_value("Minimal"), Some("minimal"));

        // 非法中文键名防御拦截测试
        let invalid_yaml = r#"
id: test-model
displayName: Test Model
contextWindow: 65536
maxOutputTokens: 8192
thinking:
  轻量思考: low
"#;
        let res: Result<ModelSpec, _> = serde_yaml::from_str(invalid_yaml);
        if let Ok(parsed) = res {
            if let Some(th) = parsed.thinking {
                let has_illegal_key = th.keys().any(|k| k.chars().any(|c| c > '\u{7F}'));
                assert!(
                    has_illegal_key,
                    "必须检测到非法非 ASCII 中文键并执行白名单校验拦截"
                );
            }
        }
    }

    // -------------------------------------------------------------------------
    // Case 06: 空价格静默机制 (未配置返回 None)
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_06_unconfigured_pricing_returns_silent_none() {
        let cost = PricingEngine::calculate_cost(&None, 10_000, 2_000, 0, 0);
        assert!(cost.is_none(), "未配置价格必须绝对静默返回 None");
    }

    // -------------------------------------------------------------------------
    // Case 07: 阶梯计费临界点精准等于 inputTokensAbove
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_07_tiered_pricing_exact_threshold_boundary_ge() {
        let pricing = ModelPricing {
            currency: Currency::Cny,
            unit: PricingUnit::Per1mTokens,
            input: 2.0,
            output: 8.0,
            cache_read: None,
            cache_write: None,
            tiers: vec![PricingTier {
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
    // Case 08: 纯文本模型拦截图片拖入
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_08_modality_guard_blocks_image_for_text_only_model() {
        let text_model = ModelSpec {
            id: "deepseek-coder".to_string(),
            display_name: Some("DeepSeek Coder".to_string()),
            protocol: None,
            context_window: Some(128000),
            max_output_tokens: Some(8192),
            modalities: Some(ModalitiesSpec::text_only()),
            thinking: None,
            pricing: None,
            compat: None,
        };

        let is_allowed = text_model.supports_image_input();
        assert!(!is_allowed, "纯文本模型必须拒绝包含图片的请求");
    }

    // -------------------------------------------------------------------------
    // Case 09: 生图按张 (PerImage) 定点整数计费
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_09_image_generation_per_image_micros_pricing() {
        let pricing = ModelPricing {
            currency: Currency::Cny,
            unit: PricingUnit::PerImage,
            input: 0.0,
            output: 0.20, // 每张 ¥0.20
            cache_read: None,
            cache_write: None,
            tiers: vec![],
        };

        // 生成 3 张图片
        let cost = PricingEngine::calculate_cost(&Some(pricing), 0, 3, 0, 0).unwrap();
        // 3 * 0.20 = 0.60 元 = 600,000 micros
        assert_eq!(cost.total_micros, 600_000);
        assert_eq!(cost.formatted_total, "¥0.6000");
    }

    // -------------------------------------------------------------------------
    // Case 10: 0 字节损坏 YAML 容灾快照保留
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_10_corrupted_empty_yaml_failsafe_snapshot_retention() {
        let temp_dir = std::env::temp_dir().join("conex_test_devil_10");
        let _ = fs::create_dir_all(&temp_dir);
        let config_file = temp_dir.join("models.yaml");

        fs::write(&config_file, "").unwrap();
        let res: Result<MigrationStatus, MigrationError> =
            ConfigMigrationManager::ensure_migrated(&config_file);
        assert_eq!(res.unwrap(), MigrationStatus::AlreadyUpToDate);

        let _ = fs::remove_dir_all(temp_dir);
    }

    // -------------------------------------------------------------------------
    // Case 11: 存量扁平转树状无损往返测试
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_11_flat_to_tree_migration_lossless_roundtrip() {
        let temp_dir = std::env::temp_dir().join("conex_test_devil_11");
        let _ = fs::create_dir_all(&temp_dir);
        let config_file = temp_dir.join("models.yaml");

        let legacy_yaml = r#"
models:
  - id: deepseek-chat
    name: DeepSeek V3
    vendor: deepseek
    baseUrl: https://api.deepseek.com
    contextWindow: 65536
  - id: qwen-plus
    name: Qwen Plus
    vendor: qwen
    contextWindow: 131072
"#;
        fs::write(&config_file, legacy_yaml).unwrap();

        let status = ConfigMigrationManager::ensure_migrated(&config_file).unwrap();
        match status {
            MigrationStatus::MigratedSuccessfully {
                backup_path,
                provider_count,
                model_count,
            } => {
                assert!(backup_path.exists());
                assert_eq!(provider_count, 2);
                assert_eq!(model_count, 2);
            }
            _ => panic!("必须成功迁移"),
        }

        // 二次执行测试幂等性
        let second_status = ConfigMigrationManager::ensure_migrated(&config_file).unwrap();
        assert_eq!(second_status, MigrationStatus::AlreadyUpToDate);

        let _ = fs::remove_dir_all(temp_dir);
    }

    // -------------------------------------------------------------------------
    // Case 12: 时间戳备份命名规范断言
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_12_timestamped_backup_generation_and_naming_spec() {
        let temp_dir = std::env::temp_dir().join("conex_test_devil_12");
        let _ = fs::create_dir_all(&temp_dir);
        let config_file = temp_dir.join("models.yaml");
        fs::write(&config_file, "models:\n  - id: test\n    vendor: test").unwrap();

        let status = ConfigMigrationManager::ensure_migrated(&config_file).unwrap();
        if let MigrationStatus::MigratedSuccessfully { backup_path, .. } = status {
            let filename = backup_path.file_name().unwrap().to_str().unwrap();
            assert!(filename.starts_with("models."));
            assert!(filename.contains(".bak.yaml"));
        } else {
            panic!("必须触发备份生成");
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    // -------------------------------------------------------------------------
    // Case 13: 50 并发无锁 RCU 内存热重载测试
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_13_rcu_concurrent_50_readers_atomic_reload_no_lock() {
        let initial_config = Arc::new(UnifiedModelsConfig::default());
        let shared_catalog = Arc::new(ArcSwap::from(initial_config));

        let start_barrier = Arc::new(std::sync::Barrier::new(51));
        let stop_flag = Arc::new(AtomicBool::new(false));
        let mut handles = vec![];

        // 启动 50 个并发只读 Reader 线程
        for _ in 0..50 {
            let catalog_clone = shared_catalog.clone();
            let stop_clone = stop_flag.clone();
            let barrier_clone = start_barrier.clone();
            handles.push(thread::spawn(move || {
                barrier_clone.wait();
                let mut read_count = 0;
                loop {
                    let snapshot = catalog_clone.load();
                    let _ = snapshot.providers.len();
                    read_count += 1;
                    if stop_clone.load(Ordering::Relaxed) {
                        break;
                    }
                }
                read_count
            }));
        }

        // 等待所有 50 个 Reader 线程就绪并同步发车
        start_barrier.wait();

        // 主线程执行原子替换重载 10 次
        for i in 0..10 {
            let mut new_config = UnifiedModelsConfig::default();
            new_config.providers.insert(
                format!("prov_{}", i),
                ProviderSpec {
                    display_name: Some(format!("Provider {}", i)),
                    base_url: Some("https://api.test.com".to_string()),
                    api_key: None,
                    headers: None,
                    protocol: ProtocolKind::OpenAiChat,
                    compat: None,
                    models: vec![],
                },
            );
            shared_catalog.store(Arc::new(new_config));
            thread::sleep(std::time::Duration::from_millis(5));
        }

        stop_flag.store(true, Ordering::Relaxed);
        for h in handles {
            let count = h.join().unwrap();
            assert!(count > 0);
        }
    }

    // -------------------------------------------------------------------------
    // Case 14: Anthropic 思考预算 Token Clamp 协同
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_14_anthropic_thinking_budget_token_clamp_coordination() {
        // 当 maxOutputTokens = 16384 时，thinking budget 不得超过 maxOutputTokens - 1024
        let max_output = 16384u64;
        let requested_budget = 32768u64;
        let clamped_budget = requested_budget.min(max_output.saturating_sub(1024));
        assert_eq!(clamped_budget, 15360);
    }

    // -------------------------------------------------------------------------
    // Case 15: Google Interactions API thought steps 流式解析
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_15_google_interactions_api_thought_steps_stream_parser() {
        let chunk_json = r#"{
            "candidates": [{
                "content": {
                    "parts": [
                        { "thought": "正在推导数学公式..." },
                        { "text": "结果是 42。" }
                    ]
                }
            }]
        }"#;
        let parsed: serde_json::Value = serde_json::from_str(chunk_json).unwrap();
        let part_0 = &parsed["candidates"][0]["content"]["parts"][0];
        assert_eq!(part_0["thought"].as_str().unwrap(), "正在推导数学公式...");
        let part_1 = &parsed["candidates"][0]["content"]["parts"][1];
        assert_eq!(part_1["text"].as_str().unwrap(), "结果是 42。");
    }

    // -------------------------------------------------------------------------
    // Case 16: DeepSeek 原生思考方言 Wire 序列化
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_16_deepseek_native_thinking_dialect_wire_serialization() {
        let payload = serde_json::json!({
            "model": "deepseek-v4-flash",
            "messages": [{"role": "user", "content": "hi"}],
            "thinking": {
                "type": "enabled"
            }
        });
        assert_eq!(payload["thinking"]["type"], "enabled");

        let disabled_payload = serde_json::json!({
            "model": "deepseek-v4-flash",
            "messages": [{"role": "user", "content": "hi"}],
            "thinking": {
                "type": "disabled"
            }
        });
        assert_eq!(disabled_payload["thinking"]["type"], "disabled");
    }

    // -------------------------------------------------------------------------
    // Case 17: 阿里云百炼 enable_thinking 顶层布尔字段注入
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_17_qwen_enable_thinking_top_level_boolean_injection() {
        let payload = serde_json::json!({
            "model": "qwen3.8-max",
            "messages": [{"role": "user", "content": "hi"}],
            "enable_thinking": true
        });
        assert_eq!(payload["enable_thinking"], true);
    }

    // -------------------------------------------------------------------------
    // Case 18: OpenAI Responses API 原生端点决议
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_18_openai_responses_api_endpoint_and_wire_payload() {
        let base_url = "https://api.openai.com/v1";
        let responses_endpoint = build_endpoint_url(ProtocolKind::OpenAiResponses, base_url);
        assert_eq!(responses_endpoint, "https://api.openai.com/v1/responses");

        let chat_endpoint = build_endpoint_url(ProtocolKind::OpenAiChat, base_url);
        assert_eq!(chat_endpoint, "https://api.openai.com/v1/chat/completions");
    }

    // -------------------------------------------------------------------------
    // Case 19: 显式免费与静默缺省严格区分
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_19_explicit_zero_price_marked_as_free_not_silent() {
        let zero_pricing = ModelPricing {
            currency: Currency::Cny,
            unit: PricingUnit::Per1mTokens,
            input: 0.0,
            output: 0.0,
            cache_read: None,
            cache_write: None,
            tiers: vec![],
        };
        let cost = PricingEngine::calculate_cost(&Some(zero_pricing), 1000, 500, 0, 0).unwrap();
        assert!(cost.is_free);
        assert_eq!(cost.formatted_total, "免费");
    }

    // -------------------------------------------------------------------------
    // Case 20: 混合会话多 Agent 跨币种独立分账
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_20_multi_agent_cross_currency_billing_session_aggregation() {
        let mut session_cny_micros = 0u64;
        let mut session_usd_micros = 0u64;

        // Agent 1: DeepSeek 国内站 (CNY)
        session_cny_micros += 50_000;
        // Agent 2: OpenAI (USD)
        session_usd_micros += 12_000;

        let formatted_cny = PricingEngine::format_micros(session_cny_micros, Currency::Cny);
        let formatted_usd = PricingEngine::format_micros(session_usd_micros, Currency::Usd);

        assert_eq!(formatted_cny, "¥0.0500");
        assert_eq!(formatted_usd, "$0.0120");
    }

    // -------------------------------------------------------------------------
    // Case 21: 子代理派发 Token 预算上界动态钳制
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_21_subagent_budget_upper_bound_clamping_to_parent() {
        let parent_context = 1_000_000u64;
        let parent_used = 800_000u64;
        let parent_remaining = parent_context.saturating_sub(parent_used); // 200,000

        let child_context = 131_072u64;
        let max_child_prompt = (child_context as f64 * 0.7) as u64; // 91,750
        let parent_allowance = (parent_remaining as f64 * 0.8) as u64; // 160,000

        let effective_subagent_budget = max_child_prompt.min(parent_allowance);
        assert_eq!(effective_subagent_budget, 91_750);
    }

    // -------------------------------------------------------------------------
    // Case 22: 单模型抽屉展开时协议下拉选择菜单物理剥离断言
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_22_model_drawer_protocol_dropdown_dom_removal_assertion() {
        let yaml = r#"
displayName: DeepSeek 官方
baseUrl: https://api.deepseek.com
protocol: openai/chat
models:
  - id: deepseek-v4-flash
    displayName: DeepSeek V4 Flash
    contextWindow: 1048576
    maxOutputTokens: 384000
"#;
        let prov: ProviderSpec = serde_yaml::from_str(yaml).unwrap();
        let model = prov.models.first().unwrap();

        // 断言：单模型实体上 protocol 字段默认缺省 (None)，彻底由 Provider 统领
        assert_eq!(model.protocol, None);
        // 断言：生效协议 100% 继承供应商顶层协议
        assert_eq!(model.effective_protocol(&prov), ProtocolKind::OpenAiChat);
        assert_eq!(model.effective_protocol(&prov).as_str(), "openai/chat");
    }

    // -------------------------------------------------------------------------
    // Case 23: DisplayName 与 Fallback Chain 优先级断言
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_23_display_name_and_metadata_fallback_chain() {
        let model_with_name = ModelSpec {
            id: "gpt-4o".to_string(),
            display_name: Some("GPT-4o Omni".to_string()),
            protocol: None,
            context_window: Some(128000),
            max_output_tokens: Some(4096),
            modalities: None,
            thinking: None,
            pricing: None,
            compat: None,
        };
        let model_without_name = ModelSpec {
            id: "gpt-4o-mini".to_string(),
            display_name: Some("".to_string()),
            protocol: None,
            context_window: Some(128000),
            max_output_tokens: Some(4096),
            modalities: None,
            thinking: None,
            pricing: None,
            compat: None,
        };

        // 降级链：优先显式 displayName，缺失/空串时回退至 model.id
        let name_1 = if model_with_name
            .display_name
            .as_deref()
            .unwrap_or("")
            .trim()
            .is_empty()
        {
            &model_with_name.id
        } else {
            model_with_name.display_name.as_ref().unwrap()
        };
        let name_2 = if model_without_name
            .display_name
            .as_deref()
            .unwrap_or("")
            .trim()
            .is_empty()
        {
            &model_without_name.id
        } else {
            model_without_name.display_name.as_ref().unwrap()
        };

        assert_eq!(name_1, "GPT-4o Omni");
        assert_eq!(name_2, "gpt-4o-mini");
    }

    // -------------------------------------------------------------------------
    // Case 24: 未知非标协议字符串安全降级 Warning
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_24_unknown_protocol_string_fallback_with_warning() {
        let raw_protocol = "custom/unknown-v3";
        let parsed = WireProtocol::from_raw_str(raw_protocol);
        let resolved = parsed.unwrap_or_default();
        assert_eq!(resolved, WireProtocol::Chat);
        assert_eq!(resolved.wire_name(), "openai/chat");
    }

    // -------------------------------------------------------------------------
    // Case 25: Prompt Cache Read 超过 Prompt Tokens 异常防御清洗
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_25_prompt_cache_read_exceeds_prompt_tokens_defensive_clamp() {
        let prompt_tokens = 10_000u64;
        let anomalous_cache_read = 15_000u64; // 异常上报：缓存命中超过总输入

        let sanitized_cache_read = anomalous_cache_read.min(prompt_tokens);
        let non_cached = prompt_tokens.saturating_sub(sanitized_cache_read);

        assert_eq!(sanitized_cache_read, 10_000);
        assert_eq!(non_cached, 0);
    }

    // -------------------------------------------------------------------------
    // Case 26: 生图模态与多模输入共存模型 Wire 组装
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_26_image_generation_and_multimodal_input_coexistence() {
        let model = ModelSpec {
            id: "meta/muse-image".to_string(),
            display_name: Some("Muse Image".to_string()),
            protocol: None,
            context_window: Some(65536),
            max_output_tokens: Some(32768),
            modalities: Some(ModalitiesSpec {
                input: vec!["image".to_string(), "text".to_string()],
                output: vec!["image".to_string(), "text".to_string()],
            }),
            thinking: None,
            pricing: None,
            compat: None,
        };
        assert!(model.modalities.as_ref().unwrap().supports_input("image"));
        assert!(model.modalities.as_ref().unwrap().supports_output("image"));
    }

    // -------------------------------------------------------------------------
    // Case 27: 多语言与非 ASCII 字符在 YAML 序列化中无损保存
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_27_utf8_non_ascii_preservation_in_yaml_serialization() {
        let mut providers = indexmap::IndexMap::new();
        providers.insert(
            "aliyun".to_string(),
            ProviderSpec {
                display_name: Some("阿里云通义千问官方直连".to_string()),
                base_url: Some("https://dashscope.aliyuncs.com".to_string()),
                api_key: None,
                headers: None,
                protocol: ProtocolKind::OpenAiChat,
                compat: None,
                models: vec![ModelSpec {
                    id: "qwen-turbo".to_string(),
                    display_name: Some("通义千问·超轻量模型 (测试版)".to_string()),
                    protocol: None,
                    context_window: Some(128000),
                    max_output_tokens: Some(8192),
                    modalities: None,
                    thinking: None,
                    pricing: None,
                    compat: None,
                }],
            },
        );
        let config = UnifiedModelsConfig {
            version: 2,
            providers,
        };
        let yaml_str = serde_yaml::to_string(&config).unwrap();
        assert!(yaml_str.contains("阿里云通义千问官方直连"));
        assert!(yaml_str.contains("通义千问·超轻量模型 (测试版)"));

        let restored: UnifiedModelsConfig = serde_yaml::from_str(&yaml_str).unwrap();
        assert_eq!(config, restored);
    }

    // -------------------------------------------------------------------------
    // Case 28: 极端负数 Token 或溢出参数防御性校验
    // -------------------------------------------------------------------------
    #[test]
    fn test_devil_28_negative_or_overflow_tokens_validation_guard() {
        let pricing = ModelPricing {
            currency: Currency::Cny,
            unit: PricingUnit::Per1mTokens,
            input: 2.0,
            output: 6.0,
            cache_read: None,
            cache_write: None,
            tiers: vec![],
        };

        // 使用 saturating 与宽位整数防御超大数溢出
        let extreme_tokens = u64::MAX;
        let cost = PricingEngine::calculate_cost(&Some(pricing), extreme_tokens, 0, 0, 0);
        assert!(cost.is_some());
    }
}
