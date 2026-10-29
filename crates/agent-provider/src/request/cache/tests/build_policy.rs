//! cache 测试 · build_cache_policy / prompt_cache_mode

use super::*;

// ── build_cache_policy ──

#[test]
fn build_cache_policy_deepseek_omits_everything() {
    // DeepSeek 全省略：整个 cache 参数组不出现（P3 矩阵 omit 恒 true，
    // 请求体不含任何 cache 键，对齐 deepseek-reasonix-cache-analysis.md:111-112）。
    // vendor 由 yaml provider 身份（providerId）声明，不由 baseUrl/模型名推断。
    assert_eq!(
        build_cache_policy(
            None,
            Some("deepseek"),
            Some("deepseek-v4"),
            Some("ses-1"),
            None
        ),
        None
    );
    assert_eq!(
        build_cache_policy(
            None,
            Some("deepseek"),
            Some("deepseek-chat"),
            Some("ses-1"),
            None
        ),
        None
    );
    // 即使 overrides 显式开启也省略（omit 优先于覆盖）
    assert_eq!(
        build_cache_policy(
            None,
            Some("deepseek"),
            Some("deepseek-v4"),
            Some("ses-1"),
            Some(&json!({ "enabled": true }))
        ),
        None
    );
}

#[test]
fn build_cache_policy_auto_zero_params() {
    // Auto 机制（Gemini 隐式）：零参数 policy——不发键/断点/options/亲和头
    let policy = build_cache_policy(
        None,
        Some("gemini"),
        Some("gemini-2.5-pro"),
        Some("ses-1"),
        None,
    )
    .expect("Auto 机制应产出零参数策略");
    assert_eq!(policy.mechanism, CacheMechanism::Auto);
    assert_eq!(policy.retention, CacheRetention::Short);
    assert_eq!(policy.breakpoints, None);
    assert_eq!(policy.cache_key, None);
    assert_eq!(policy.prompt_cache_options, None);
    assert_eq!(policy.affinity_header, None);
}

#[test]
fn build_cache_policy_key_injects_cache_key() {
    // Key 机制：会话 ID → prompt_cache_key（钳 64）；retention 默认 Short
    let policy = build_cache_policy(None, Some("openai"), Some("gpt-4o"), Some("ses-abc"), None)
        .expect("Key 机制应注入键");
    assert_eq!(policy.mechanism, CacheMechanism::Key);
    assert_eq!(policy.cache_key, Some(CacheKey("ses-abc".to_string())));
    assert_eq!(policy.retention, CacheRetention::Short);
    // overrides 可升档 Long（wire 值 "24h" 由 T-15 经 retention_wire_value 发出）
    let policy = build_cache_policy(
        None,
        Some("openai"),
        Some("gpt-4o"),
        Some("ses-abc"),
        Some(&json!({ "retention": "long" })),
    )
    .expect("Key 机制应注入键");
    assert_eq!(policy.retention, CacheRetention::Long);
    assert_eq!(retention_wire_value(policy.retention), Some("24h"));
}

#[test]
fn build_cache_policy_key_without_session_id_returns_none() {
    // 无会话 ID → 无键可发 → 整体不注入（P2 §3.2 步骤 4：session_id?）
    assert_eq!(
        build_cache_policy(None, Some("openai"), Some("gpt-4o"), None, None),
        None
    );
    assert_eq!(
        build_cache_policy(None, Some("openai"), Some("gpt-4o"), Some("   "), None),
        None
    );
}

#[test]
fn build_cache_policy_unknown_vendor_none() {
    // 未声明为已知厂商的身份（本地/自定义网关）→ fail-closed，不参与缓存
    assert_eq!(
        build_cache_policy(
            None,
            Some("localhost"),
            Some("llama-3.1"),
            Some("ses-1"),
            None
        ),
        None
    );
}

#[test]
fn build_cache_policy_disabled_override_none() {
    // extra.cache.enabled == false → 完全不参与（P2 §3.2 步骤 1）
    assert_eq!(
        build_cache_policy(
            None,
            Some("openai"),
            Some("gpt-4o"),
            Some("ses-1"),
            Some(&json!({ "enabled": false }))
        ),
        None
    );
}

#[test]
fn build_cache_policy_key_none_retention_non_56_returns_none() {
    // 非 5.6+ Key 机制 + retention=none → 整体不参与（摘要请求同款）
    assert_eq!(
        build_cache_policy(
            None,
            Some("openai"),
            Some("gpt-4o"),
            Some("ses-1"),
            Some(&json!({ "retention": "none" }))
        ),
        None
    );
}

#[test]
fn build_cache_policy_explicit_plan_enabled() {
    // Explicit 机制（MiniMax M2.x）：breakpoints 启用位 + retention 驱动 TTL 桶
    let policy = build_cache_policy(
        None,
        Some("minimax"),
        Some("minimax-m2.1"),
        Some("ses-1"),
        None,
    )
    .expect("M2.x 应启用显式断点注入");
    assert_eq!(policy.mechanism, CacheMechanism::Explicit);
    assert_eq!(policy.breakpoints, Some(BreakpointPlan::default()));
    assert_eq!(policy.cache_key, None);
    // 兜底表 M2.x 无 1h 桶：retention=long 也不升桶（保守，写价 2x 宁缺毋滥）
    let policy = build_cache_policy(
        None,
        Some("minimax"),
        Some("minimax-m2.1"),
        Some("ses-1"),
        Some(&json!({ "retention": "long" })),
    )
    .expect("M2.x 应启用显式断点注入");
    assert_eq!(policy.ttl, TtlBucket::FiveMinutes);
    // Anthropic 官方有 1h 桶：retention=long → OneHour
    let policy = build_cache_policy(
        None,
        Some("anthropic"),
        Some("claude-sonnet-4"),
        Some("ses-1"),
        Some(&json!({ "retention": "long" })),
    )
    .expect("Anthropic 应启用显式断点注入");
    assert_eq!(policy.ttl, TtlBucket::OneHour);
    assert_eq!(policy.retention, CacheRetention::Long);
}

#[test]
fn build_cache_policy_catalog_drives_deepseek_omit() {
    // catalog 真源路径（C2）：DeepSeek 经 cache_behavior_for 的 omit 位 →
    // 整个 cache 参数组不出现；vendor 由 providerId 声明
    let catalog = ModelCatalog::bundled();
    assert_eq!(
        build_cache_policy(
            Some(&catalog),
            Some("deepseek"),
            Some("deepseek-v4-flash"),
            Some("ses-1"),
            None
        ),
        None
    );
    assert_eq!(
        build_cache_policy(
            Some(&catalog),
            Some("deepseek"),
            Some("deepseek-v4"),
            Some("ses-1"),
            Some(&json!({ "enabled": true }))
        ),
        None
    );
    assert_eq!(
        build_cache_policy(
            None,
            Some("deepseek"),
            Some("deepseek-v4-flash"),
            Some("ses-1"),
            None
        ),
        None
    );
}

#[test]
fn build_cache_policy_catalog_drives_minimax_m2_breakpoints() {
    // MiniMax M2.x 经 catalog：条目显式声明主动缓存（cacheType both /
    // supportsCacheControl true）→ Explicit 断点注入
    let catalog = ModelCatalog::bundled();
    let policy = build_cache_policy(
        Some(&catalog),
        Some("minimax"),
        Some("minimax-m2-7"),
        Some("ses-1"),
        None,
    )
    .expect("M2-7 经 catalog 应启用显式断点注入");
    assert_eq!(policy.mechanism, CacheMechanism::Explicit);
    assert_eq!(policy.breakpoints, Some(BreakpointPlan::default()));
    assert_eq!(policy.ttl, TtlBucket::FiveMinutes);
    assert_eq!(policy.cache_key, None);
    // M3 经 catalog：条目声明关主动缓存 → Auto 零参数（隐式缓存不发任何字段）
    let m3 = build_cache_policy(
        Some(&catalog),
        Some("minimax"),
        Some("minimax-m3"),
        Some("ses-1"),
        None,
    )
    .expect("M3 经 catalog 应为 Auto 零参数");
    assert_eq!(m3.mechanism, CacheMechanism::Auto);
    assert_eq!(m3.breakpoints, None);
    assert_eq!(m3.cache_key, None);
    assert_eq!(m3.prompt_cache_options, None);
}

#[test]
fn build_cache_policy_catalog_drives_grok_key() {
    // Grok 经 catalog：supports_prompt_cache_key → Key 键路由（会话 ID 派生键）
    let catalog = ModelCatalog::bundled();
    let policy = build_cache_policy(
        Some(&catalog),
        Some("grok"),
        Some("grok-4.5"),
        Some("ses-grok"),
        None,
    )
    .expect("Grok 经 catalog 应走键路由");
    assert_eq!(policy.mechanism, CacheMechanism::Key);
    assert_eq!(policy.cache_key, Some(CacheKey("ses-grok".to_string())));
    assert_eq!(policy.retention, CacheRetention::Short);
}

// ── G1（02-model-specific-optimizations.md 缺口 G1）：Anthropic 1h 长档
//    在 catalog 路径不再永久关闭（矩阵 Short 只表达默认档，不表达能力上限）──

#[test]
fn build_cache_policy_anthropic_catalog_path_enables_one_hour_bucket() {
    // G1 核心：catalog 路径 Anthropic（条目 cacheTtl="5m"、矩阵 default_ttl
    // =Short）——retention=long 覆盖时发出 OneHour 桶（cacheWritePrice1h
    // 定价能力与请求侧恢复接线）；默认档（无覆盖）仍 5m（1h 写价 2x，
    // 由档位显式开启）
    let catalog = ModelCatalog::bundled();
    let policy = build_cache_policy(
        Some(&catalog),
        Some("anthropic"),
        Some("claude-opus-4-5"),
        Some("ses-1"),
        Some(&json!({ "retention": "long" })),
    )
    .expect("Anthropic catalog 路径应启用显式断点注入");
    assert_eq!(policy.mechanism, CacheMechanism::Explicit);
    assert_eq!(policy.retention, CacheRetention::Long);
    assert_eq!(policy.ttl, TtlBucket::OneHour);
    let policy = build_cache_policy(
        Some(&catalog),
        Some("anthropic"),
        Some("claude-opus-4-5"),
        Some("ses-1"),
        None,
    )
    .expect("Anthropic catalog 路径应启用显式断点注入");
    assert_eq!(policy.ttl, TtlBucket::FiveMinutes);
}

#[test]
fn build_cache_policy_anthropic_catalog_1h_entry_sets_long_retention() {
    // 模型级 ttl 档（catalog 条目 cache_ttl="1h" → default_ttl=Hour）：
    // 双桶 + 默认 Long 档（任务书：Anthropic 1h 配置 → 双桶含 1h）
    let mut entries = std::collections::BTreeMap::new();
    entries.insert(
        crate::models::ModelRef::new("anthropic", "claude-long-1h").key(),
        ModelCatalogEntry {
            model: "claude-long-1h".to_string(),
            provider: "anthropic".to_string(),
            vendor: "anthropic".to_string(),
            supports_prompt_caching: true,
            supports_cache_control: true,
            breakpoint_max: Some(4),
            cache_ttl: Some("1h".to_string()),
            ..Default::default()
        },
    );
    let catalog = ModelCatalog {
        entries,
        version: 0,
    };
    let policy = build_cache_policy(
        Some(&catalog),
        Some("anthropic"),
        Some("claude-long-1h"),
        Some("ses-1"),
        None,
    )
    .expect("1h 条目应启用显式断点注入");
    assert_eq!(policy.mechanism, CacheMechanism::Explicit);
    assert_eq!(policy.retention, CacheRetention::Long);
    assert_eq!(policy.ttl, TtlBucket::OneHour);
}

#[test]
fn build_cache_policy_short_config_keeps_five_minutes_only() {
    // G1 反例（任务书：Short 配置 → 仅 5m 桶）：MiniMax M2.x 同为
    // supports_cache_control=true，但矩阵仅 5m 单桶——G1 厂商限定防止
    // 随 Anthropic 一并放宽到 1h
    let catalog = ModelCatalog::bundled();
    let policy = build_cache_policy(
        Some(&catalog),
        Some("minimax"),
        Some("minimax-m2-7"),
        Some("ses-1"),
        Some(&json!({ "retention": "long" })),
    )
    .expect("M2.x 应启用显式断点注入");
    assert_eq!(policy.mechanism, CacheMechanism::Explicit);
    assert_eq!(policy.retention, CacheRetention::Long);
    assert_eq!(policy.ttl, TtlBucket::FiveMinutes);
}

// ── G2（02-model-specific-optimizations.md 缺口 G2）：x-grok-conv-id 会话
//    亲和头接线（消费 models/cache_key.rs session_affinity_headers 数据表）──

#[test]
fn build_cache_policy_grok_injects_affinity_header() {
    // Grok 模型 → policy.affinity_header = x-grok-conv-id，值 = session_id
    // 前 64 码点（键推导结果）；catalog / 无 catalog 两路径行为一致
    let catalog = ModelCatalog::bundled();
    for (catalog, provider_id, model) in [
        (Some(&catalog), Some("grok"), Some("grok-4.5")),
        (None, Some("grok"), Some("grok-4.5")),
    ] {
        let policy = build_cache_policy(catalog, provider_id, model, Some("ses-grok"), None)
            .expect("Grok 应走键路由");
        assert_eq!(
            policy.affinity_header,
            Some(("x-grok-conv-id", "ses-grok".to_string())),
            "路径 {model:?} / {provider_id:?}"
        );
    }
    // 超长会话 ID：header 值恰好 64 码点（含多字节尾字符）
    let long = format!("{}尾", "g".repeat(63));
    let policy = build_cache_policy(
        Some(&catalog),
        Some("grok"),
        Some("grok-4.5"),
        Some(long.as_str()),
        None,
    )
    .expect("Grok 应走键路由");
    let header = policy.affinity_header.expect("Grok 必须注入亲和头");
    assert_eq!(header.0, "x-grok-conv-id");
    assert_eq!(header.1.chars().count(), 64);
    assert!(header.1.ends_with('尾'));
}

#[test]
fn build_cache_policy_other_vendors_no_affinity_header() {
    // G2 反例：Anthropic（Explicit）/ OpenAI（Key）/ Gemini（Auto）→
    // affinity_header 恒 None（矩阵 conv_header 关）；DeepSeek omit 整体 None
    for (catalog, provider_id, model) in [
        (None, Some("anthropic"), Some("claude-sonnet-5")),
        (None, Some("openai"), Some("gpt-4o")),
        (None, Some("gemini"), Some("gemini-2.5-pro")),
        (None, Some("deepseek"), Some("deepseek-v4-flash")),
    ] {
        let policy = build_cache_policy(catalog, provider_id, model, Some("ses-1"), None);
        if let Some(policy) = policy {
            assert_eq!(policy.affinity_header, None, "{model:?} 不得注入亲和头");
        }
    }
    // Grok 无有效会话 ID → 键路由整体不注入（无键则无路由对象，亲和头同源）
    assert_eq!(
        build_cache_policy(None, Some("grok"), Some("grok-4.5"), Some("   "), None),
        None
    );
}

#[test]
fn build_cache_policy_catalog_unknown_model_conservative() {
    // 未声明身份的 provider → fail-closed（不猜不注入）
    let catalog = ModelCatalog::bundled();
    assert_eq!(
        build_cache_policy(
            Some(&catalog),
            Some("localhost"),
            Some("llama-3.1"),
            Some("ses-1"),
            None
        ),
        None
    );
    // 已知厂商但目录未收录的模型：保持 vendor 默认行为（目录缺失 ≠ 全关；
    // 如 OpenAI 未知系列按 vendor 默认行走键路由）
    let policy = build_cache_policy(
        Some(&catalog),
        Some("openai"),
        Some("gpt-8-future"),
        Some("ses-1"),
        None,
    )
    .expect("已知厂商未知模型应保持 vendor 默认行为");
    assert_eq!(policy.mechanism, CacheMechanism::Key);
}

#[test]
fn prompt_cache_mode_as_str() {
    // wire 值（camelCase，与 TS 对齐）
    assert_eq!(PromptCacheMode::Implicit.as_str(), "implicit");
    assert_eq!(PromptCacheMode::Explicit.as_str(), "explicit");
}
