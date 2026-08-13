//! request/cache.rs 测试旁挂（SR-06e · 拆分 · ≠ EL；经 #[path] 接线，非直接 mod）
//!
//! 原 cache.rs `mod tests` 整段搬入，零删除零合并；测试名与断言形状不变。

use super::*;
use super::cache_policy::allocate_breakpoints_with_cap;
use crate::models::{cache_behavior_for, ModelCatalog, ModelCatalogEntry, VendorId};

// ── CacheRetention ──

#[test]
fn cache_retention_default_is_short() {
    // P2 §3.1.1：默认 Short（对齐 pi resolveCacheRetention 默认 "short"）
    assert_eq!(CacheRetention::default(), CacheRetention::Short);
}

// ── CacheKey::from_session_id ──

#[test]
fn cache_key_clamps_to_64_codepoints_without_splitting_chars() {
    // 纯 ASCII 超长：钳到 64 码点
    let long = "s".repeat(80);
    let key = CacheKey::from_session_id(&long).expect("非空应派生键");
    assert_eq!(key.0.chars().count(), 64);
    assert_eq!(key.0, "s".repeat(64));
    // 中文边界：第 65 个字符是多字节码点，禁止字节截断（不产生半个字符）
    let chinese = format!("{}汉", "a".repeat(63));
    let key = CacheKey::from_session_id(&chinese).expect("非空应派生键");
    assert_eq!(key.0.chars().count(), 64);
    assert!(key.0.ends_with('汉'));
    // emoji 边界：尾部 4 字节码点不被字节截断拆散
    let emoji = format!("{}😀", "a".repeat(63));
    let key = CacheKey::from_session_id(&emoji).expect("非空应派生键");
    assert_eq!(key.0.chars().count(), 64);
    assert!(key.0.ends_with('😀'));
}

#[test]
fn cache_key_trims_and_rejects_blank() {
    // 全空白 → None
    assert_eq!(CacheKey::from_session_id("   "), None);
    assert_eq!(CacheKey::from_session_id("\t\n "), None);
    // 首尾空白先 trim 再派生（trim 后非空）
    let key = CacheKey::from_session_id("  ses-abc  ").expect("去空白后应派生键");
    assert_eq!(key.0, "ses-abc");
}

#[test]
fn cache_key_empty_returns_none() {
    // 空输入 → None（调用方用 CacheRetention::None 表达显式不参与缓存）
    assert_eq!(CacheKey::from_session_id(""), None);
}

// ── CacheControl ──

#[test]
fn cache_control_to_value_shapes() {
    // wire 值形态（P2 §3.1.1）
    assert_eq!(CacheControl::Ephemeral.to_value(), json!({ "type": "ephemeral" }));
    assert_eq!(
        CacheControl::Ephemeral1h.to_value(),
        json!({ "type": "ephemeral", "ttl": "1h" })
    );
}

// ════════════════════════════════════════════════════════════════════
// T-13b：断点预算与策略
// ════════════════════════════════════════════════════════════════════

// ── BreakpointPlan / allocate_breakpoints ──

#[test]
fn breakpoint_plan_has_any() {
    // 全 false → false；任一开启 → true（T-15 注入前快速短路）
    assert!(!BreakpointPlan::default().has_any());
    assert!(BreakpointPlan { tools: true, ..Default::default() }.has_any());
    assert!(BreakpointPlan { system: true, ..Default::default() }.has_any());
    assert!(BreakpointPlan { messages: true, ..Default::default() }.has_any());
}

#[test]
fn allocate_breakpoints_four_quadrants() {
    // 预算四象限：仅 tools / 仅 system / 仅 messages / 全有
    assert_eq!(
        allocate_breakpoints(2, false, false),
        BreakpointPlan { tools: true, system: false, messages: false }
    );
    assert_eq!(
        allocate_breakpoints(0, true, false),
        BreakpointPlan { tools: false, system: true, messages: false }
    );
    assert_eq!(
        allocate_breakpoints(0, false, true),
        BreakpointPlan { tools: false, system: false, messages: true }
    );
    assert_eq!(
        allocate_breakpoints(1, true, true),
        BreakpointPlan { tools: true, system: true, messages: true }
    );
    // 全无 → 零断点
    assert_eq!(allocate_breakpoints(0, false, false), BreakpointPlan::default());
}

#[test]
fn allocate_breakpoints_drops_tail_when_over_cap() {
    // 超限丢尾不报错（P2 §5.1：cap=1 只保 tools；层级 tools→system→messages，
    // 超限先丢 messages 尾部，对齐 opencode anthropic-messages.ts:511-514）
    let plan = allocate_breakpoints_with_cap(1, 1, true, true);
    assert_eq!(plan, BreakpointPlan { tools: true, system: false, messages: false });
    // cap=2：tools + system 保，messages 丢
    let plan = allocate_breakpoints_with_cap(2, 1, true, true);
    assert_eq!(plan, BreakpointPlan { tools: true, system: true, messages: false });
    // cap=0（极端）→ 全丢不 panic
    assert_eq!(allocate_breakpoints_with_cap(0, 1, true, true), BreakpointPlan::default());
    // 默认入口恒 cap=4：三锚点需求 ≤ 3 全分配
    assert!(allocate_breakpoints(1, true, true).has_any());
}

// ── retention / 亲和头 ──

#[test]
fn retention_wire_value_mapping() {
    // OpenAI 官方值域（P2 §3.2 / 00-catalog §2.1）
    assert_eq!(retention_wire_value(CacheRetention::Short), Some("in_memory"));
    assert_eq!(retention_wire_value(CacheRetention::Long), Some("24h"));
    assert_eq!(retention_wire_value(CacheRetention::None), None);
}

#[test]
fn affinity_header_grok_chat_track_and_others_none() {
    // G2 接线：Grok Chat 轨 → x-grok-conv-id（值 = 键推导结果，session_id
    // 前 64 码点）；其余厂商 / 空会话 / None behavior → None
    let grok = cache_behavior_for(None, VendorId::Grok, "grok-4.5");
    assert_eq!(
        affinity_header(Some(&grok), "ses-123"),
        Some(("x-grok-conv-id", "ses-123".to_string()))
    );
    // 值 = 键推导（64 码点钳制，多字节尾字符完整保留）
    let long = format!("{}尾", "g".repeat(63));
    let header = affinity_header(Some(&grok), &long).expect("Grok 应注入亲和头");
    assert_eq!(header.0, "x-grok-conv-id");
    assert_eq!(header.1.chars().count(), 64);
    assert!(header.1.ends_with('尾'));
    // 其他厂商：Anthropic / OpenAI 系矩阵 conv_header 关 → None
    let anthropic = cache_behavior_for(None, VendorId::Anthropic, "claude-sonnet-5");
    assert_eq!(affinity_header(Some(&anthropic), "ses-123"), None);
    let openai = cache_behavior_for(None, VendorId::Openai, "gpt-5.6");
    assert_eq!(affinity_header(Some(&openai), "ses-123"), None);
    // 百炼 x-dashscope-session-cache 属 Responses 轨 → Chat 轨不注入
    let dashscope = cache_behavior_for(None, VendorId::Dashscope, "qwen3-max");
    assert_eq!(affinity_header(Some(&dashscope), "ses-1"), None);
    // 空/全空白会话 ID → None；None behavior → None
    assert_eq!(affinity_header(Some(&grok), ""), None);
    assert_eq!(affinity_header(Some(&grok), "   "), None);
    assert_eq!(affinity_header(None, "ses-123"), None);
}

// ── infer_cache_capability / CACHE_CAPABILITY_TABLE ──

#[test]
fn infer_cache_capability_transcribes_p3_matrix() {
    // P3 §3.2.2 矩阵转录钉死：base_url 关键字优先于 model 前缀
    assert_eq!(
        infer_cache_capability(Some("https://api.deepseek.com"), Some("any-model")).mechanism,
        CacheMechanism::Auto
    );
    assert_eq!(
        infer_cache_capability(None, Some("deepseek-v4")).mechanism,
        CacheMechanism::Auto
    );
    // MiniMax M2.x 开（Explicit 主动缓存）、M3 关（Auto 仅被动）
    assert_eq!(
        infer_cache_capability(None, Some("minimax-m2.1")).mechanism,
        CacheMechanism::Explicit
    );
    assert_eq!(
        infer_cache_capability(None, Some("minimax-m3-1.2")).mechanism,
        CacheMechanism::Auto
    );
    assert!(infer_cache_capability(None, Some("minimax-m2.1")).supports_cache_control);
    assert!(!infer_cache_capability(None, Some("minimax-m3")).supports_cache_control);
    // 官方 Anthropic / OpenAI / 隐式三家 + 键路由两家
    assert_eq!(
        infer_cache_capability(None, Some("claude-sonnet-4")).mechanism,
        CacheMechanism::Explicit
    );
    assert_eq!(
        infer_cache_capability(None, Some("gpt-4o")).mechanism,
        CacheMechanism::Key
    );
    assert_eq!(
        infer_cache_capability(None, Some("gemini-2.5-pro")).mechanism,
        CacheMechanism::Auto
    );
    assert_eq!(
        infer_cache_capability(None, Some("kimi-2.5")).mechanism,
        CacheMechanism::Auto
    );
    assert_eq!(
        infer_cache_capability(None, Some("grok-4")).mechanism,
        CacheMechanism::Key
    );
    assert_eq!(
        infer_cache_capability(None, Some("glm-5")).mechanism,
        CacheMechanism::Auto
    );
    assert_eq!(
        infer_cache_capability(Some("https://dashscope.aliyuncs.com"), Some("qwen3-max")).mechanism,
        CacheMechanism::Explicit
    );
    // 未知/本地（llama/ollama 等）→ 保守全关
    let unknown = infer_cache_capability(Some("http://localhost:11434"), Some("llama-3.1"));
    assert_eq!(unknown.mechanism, CacheMechanism::None);
    assert!(!unknown.supports_cache_control);
    assert!(!unknown.prompt_cache_key);
    assert_eq!(unknown.breakpoint_cap, 0);
}

#[test]
fn cache_capability_table_longest_prefix_wins() {
    // gpt-5.6 前缀长于 gpt → 命中 5.6 档（supports_explicit_prompt_cache_mode ✅）
    assert!(infer_cache_capability(None, Some("gpt-5.6-x")).supports_explicit_prompt_cache_mode);
    assert!(!infer_cache_capability(None, Some("gpt-4o")).supports_explicit_prompt_cache_mode);
    // base_url 关键字优先于 model 前缀（与 infer_reasoning_vendor 同构）
    assert_eq!(
        infer_cache_capability(Some("https://api.anthropic.com"), Some("gpt-4o")).mechanism,
        CacheMechanism::Explicit
    );
}

// ── build_cache_policy ──

#[test]
fn build_cache_policy_deepseek_omits_everything() {
    // DeepSeek 全省略：整个 cache 参数组不出现（P3 矩阵 omit 恒 true，
    // 请求体不含任何 cache 键，对齐 deepseek-reasonix-cache-analysis.md:111-112）
    assert_eq!(
        build_cache_policy(
            None,
            Some("https://api.deepseek.com"),
            Some("deepseek-v4"),
            Some("ses-1"),
            None
        ),
        None
    );
    assert_eq!(
        build_cache_policy(None, None, Some("deepseek-chat"), Some("ses-1"), None),
        None
    );
    // 即使 overrides 显式开启也省略（omit 优先于覆盖）
    assert_eq!(
        build_cache_policy(
            None,
            Some("https://api.deepseek.com"),
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
    let policy = build_cache_policy(None, None, Some("gemini-2.5-pro"), Some("ses-1"), None)
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
    let policy = build_cache_policy(None, None, Some("gpt-4o"), Some("ses-abc"), None)
        .expect("Key 机制应注入键");
    assert_eq!(policy.mechanism, CacheMechanism::Key);
    assert_eq!(policy.cache_key, Some(CacheKey("ses-abc".to_string())));
    assert_eq!(policy.retention, CacheRetention::Short);
    // overrides 可升档 Long（wire 值 "24h" 由 T-15 经 retention_wire_value 发出）
    let policy = build_cache_policy(
        None,
        None,
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
    assert_eq!(build_cache_policy(None, None, Some("gpt-4o"), None, None), None);
    assert_eq!(build_cache_policy(None, None, Some("gpt-4o"), Some("   "), None), None);
}

#[test]
fn build_cache_policy_unknown_vendor_none() {
    // 未知/本地模型 → 机制 None → 不参与缓存
    assert_eq!(
        build_cache_policy(
            None,
            Some("http://localhost:11434"),
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
            None,
            Some("gpt-4o"),
            Some("ses-1"),
            Some(&json!({ "enabled": false }))
        ),
        None
    );
}

#[test]
fn build_cache_policy_gpt56_none_emits_explicit_options() {
    // GPT-5.6+ none 档：prompt_cache_options={"mode":"explicit"}（"none 也须被
    // 尊重"，pi openai-responses.ts:278-285）；不发键
    let policy = build_cache_policy(
        None,
        None,
        Some("gpt-5.6-x"),
        Some("ses-1"),
        Some(&json!({ "retention": "none" })),
    )
    .expect("5.6+ none 档应发 explicit options");
    assert_eq!(
        policy.prompt_cache_options,
        Some(PromptCacheOptions { mode: PromptCacheMode::Explicit })
    );
    assert_eq!(policy.cache_key, None);
    assert_eq!(policy.retention, CacheRetention::None);
}

#[test]
fn build_cache_policy_key_none_retention_non_56_returns_none() {
    // 非 5.6+ Key 机制 + retention=none → 整体不参与（摘要请求同款）
    assert_eq!(
        build_cache_policy(
            None,
            None,
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
    let policy = build_cache_policy(None, None, Some("minimax-m2.1"), Some("ses-1"), None)
        .expect("M2.x 应启用显式断点注入");
    assert_eq!(policy.mechanism, CacheMechanism::Explicit);
    assert_eq!(policy.breakpoints, Some(BreakpointPlan::default()));
    assert_eq!(policy.cache_key, None);
    // 兜底表 M2.x 无 1h 桶：retention=long 也不升桶（保守，写价 2x 宁缺毋滥）
    let policy = build_cache_policy(
        None,
        None,
        Some("minimax-m2.1"),
        Some("ses-1"),
        Some(&json!({ "retention": "long" })),
    )
    .expect("M2.x 应启用显式断点注入");
    assert_eq!(policy.ttl, TtlBucket::FiveMinutes);
    // Anthropic 官方有 1h 桶：retention=long → OneHour
    let policy = build_cache_policy(
        None,
        None,
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
    // 整个 cache 参数组不出现；无 catalog 兜底（vendor 推断直判）同语义
    let catalog = ModelCatalog::bundled();
    assert_eq!(
        build_cache_policy(Some(&catalog), None, Some("deepseek-v4-flash"), Some("ses-1"), None),
        None
    );
    assert_eq!(
        build_cache_policy(
            Some(&catalog),
            Some("https://api.deepseek.com"),
            Some("deepseek-v4"),
            Some("ses-1"),
            Some(&json!({ "enabled": true }))
        ),
        None
    );
    assert_eq!(
        build_cache_policy(None, None, Some("deepseek-v4-flash"), Some("ses-1"), None),
        None
    );
}

#[test]
fn build_cache_policy_catalog_drives_minimax_m2_breakpoints() {
    // MiniMax M2.x 经 catalog：系列表 minimax-m2 开主动缓存 → Explicit 断点注入
    let catalog = ModelCatalog::bundled();
    let policy =
        build_cache_policy(Some(&catalog), None, Some("minimax-m2-7"), Some("ses-1"), None)
            .expect("M2-7 经 catalog 应启用显式断点注入");
    assert_eq!(policy.mechanism, CacheMechanism::Explicit);
    assert_eq!(policy.breakpoints, Some(BreakpointPlan::default()));
    assert_eq!(policy.ttl, TtlBucket::FiveMinutes);
    assert_eq!(policy.cache_key, None);
    // M3 经 catalog：系列表关主动缓存 → Auto 零参数（隐式缓存不发任何字段）
    let m3 = build_cache_policy(Some(&catalog), None, Some("minimax-m3"), Some("ses-1"), None)
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
    let policy =
        build_cache_policy(Some(&catalog), None, Some("grok-4.5"), Some("ses-grok"), None)
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
        None,
        Some("claude-opus-4-5"),
        Some("ses-1"),
        Some(&json!({ "retention": "long" })),
    )
    .expect("Anthropic catalog 路径应启用显式断点注入");
    assert_eq!(policy.mechanism, CacheMechanism::Explicit);
    assert_eq!(policy.retention, CacheRetention::Long);
    assert_eq!(policy.ttl, TtlBucket::OneHour);
    let policy =
        build_cache_policy(Some(&catalog), None, Some("claude-opus-4-5"), Some("ses-1"), None)
            .expect("Anthropic catalog 路径应启用显式断点注入");
    assert_eq!(policy.ttl, TtlBucket::FiveMinutes);
}

#[test]
fn build_cache_policy_anthropic_catalog_1h_entry_sets_long_retention() {
    // 模型级 ttl 档（catalog 条目 cache_ttl="1h" → default_ttl=Hour）：
    // 双桶 + 默认 Long 档（任务书：Anthropic 1h 配置 → 双桶含 1h）
    let mut entries = std::collections::BTreeMap::new();
    entries.insert(
        "anthropic::claude-long-1h".to_string(),
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
    let catalog = ModelCatalog { entries, version: 0 };
    let policy =
        build_cache_policy(Some(&catalog), None, Some("claude-long-1h"), Some("ses-1"), None)
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
        None,
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
    // 前 64 码点（键推导结果）；catalog / 兜底 model 前缀 / 兜底 base_url
    // 三路径行为一致
    let catalog = ModelCatalog::bundled();
    for (catalog, base_url, model) in [
        (Some(&catalog), None, Some("grok-4.5")),
        (None, None, Some("grok-4.5")),
        (None, Some("https://api.x.ai"), Some("grok-4.5")),
    ] {
        let policy = build_cache_policy(catalog, base_url, model, Some("ses-grok"), None)
            .expect("Grok 应走键路由");
        assert_eq!(
            policy.affinity_header,
            Some(("x-grok-conv-id", "ses-grok".to_string())),
            "路径 {model:?} / {base_url:?}"
        );
    }
    // 超长会话 ID：header 值恰好 64 码点（含多字节尾字符）
    let long = format!("{}尾", "g".repeat(63));
    let policy =
        build_cache_policy(Some(&catalog), None, Some("grok-4.5"), Some(long.as_str()), None)
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
    for (catalog, base_url, model) in [
        (None, None, Some("claude-sonnet-5")),
        (None, None, Some("gpt-4o")),
        (None, None, Some("gemini-2.5-pro")),
        (None, None, Some("deepseek-v4-flash")),
    ] {
        let policy = build_cache_policy(catalog, base_url, model, Some("ses-1"), None);
        if let Some(policy) = policy {
            assert_eq!(policy.affinity_header, None, "{model:?} 不得注入亲和头");
        }
    }
    // Grok 无有效会话 ID → 键路由整体不注入（无键则无路由对象，亲和头同源）
    assert_eq!(
        build_cache_policy(None, None, Some("grok-4.5"), Some("   "), None),
        None
    );
}

#[test]
fn build_cache_policy_catalog_unknown_model_conservative() {
    // 未知模型经 catalog：vendor 推断 Auto → 保守全关（不猜不注入）
    let catalog = ModelCatalog::bundled();
    assert_eq!(
        build_cache_policy(
            Some(&catalog),
            Some("http://localhost:11434"),
            Some("llama-3.1"),
            Some("ses-1"),
            None
        ),
        None
    );
    // 已知厂商但目录未收录的模型：保持 vendor 默认行为（目录缺失 ≠ 全关；
    // 如 OpenAI 未知系列按 vendor 默认行走键路由）
    let policy =
        build_cache_policy(Some(&catalog), None, Some("gpt-8-future"), Some("ses-1"), None)
            .expect("已知厂商未知模型应保持 vendor 默认行为");
    assert_eq!(policy.mechanism, CacheMechanism::Key);
}

#[test]
fn prompt_cache_mode_as_str() {
    // wire 值（camelCase，与 TS 对齐）
    assert_eq!(PromptCacheMode::Implicit.as_str(), "implicit");
    assert_eq!(PromptCacheMode::Explicit.as_str(), "explicit");
}

// ── apply_cache_controls / text_to_parts_with_cc（T-14 接线后真实实现）──

/// 便捷构造 wire 消息（cache_control 恒 None）
fn wire_message(role: &str, text: &str) -> ChatMessage {
    ChatMessage {
        role: role.to_string(),
        content: Some(ChatContent::Text(text.to_string())),
        tool_call_id: None,
        reasoning_content: None,
        tool_calls: Vec::new(),
        cache_control: None,
    }
}

/// 断言文本消息内容被改写为携带断点的 parts 形态
fn assert_text_part_with_cc(
    message: &ChatMessage,
    expected_text: &str,
    expected_cc: CacheControl,
) {
    match &message.content {
        Some(ChatContent::Parts(parts)) => {
            assert_eq!(parts.len(), 1, "改写为单文本块 parts 形态");
            match &parts[0] {
                ChatContentPart::Text { text, cache_control } => {
                    assert_eq!(text, expected_text);
                    assert_eq!(*cache_control, Some(expected_cc));
                }
                other => panic!("期望文本块，得到：{other:?}"),
            }
        }
        other => panic!("期望 parts 内容，得到：{other:?}"),
    }
}

#[test]
fn cache_control_for_ttl_mapping() {
    // TTL 桶 → 块级断点值（Anthropic 系 wire 值映射）
    assert_eq!(cache_control_for_ttl(TtlBucket::FiveMinutes), CacheControl::Ephemeral);
    assert_eq!(cache_control_for_ttl(TtlBucket::OneHour), CacheControl::Ephemeral1h);
}

#[test]
fn text_to_parts_with_cc_builds_part_with_cc() {
    // Text → parts 数组形态并携带块级断点（string content 无法携带
    // cache_control，pi-cache-analysis.md:139）
    let content = text_to_parts_with_cc("hello", CacheControl::Ephemeral);
    assert_eq!(
        content,
        ChatContent::Parts(vec![ChatContentPart::Text {
            text: "hello".to_string(),
            cache_control: Some(CacheControl::Ephemeral),
        }])
    );
    // wire 形状：type/text/cache_control 三键（T-14 单测要求）
    if let ChatContent::Parts(parts) = &content {
        assert_eq!(
            parts[0].to_value(),
            json!({ "type": "text", "text": "hello", "cache_control": { "type": "ephemeral" } })
        );
    } else {
        panic!("期望 parts 形态");
    }
    // Ephemeral1h 形状
    let content = text_to_parts_with_cc("hi", CacheControl::Ephemeral1h);
    if let ChatContent::Parts(parts) = &content {
        assert_eq!(
            parts[0].to_value()["cache_control"],
            json!({ "type": "ephemeral", "ttl": "1h" })
        );
    } else {
        panic!("期望 parts 形态");
    }
}

#[test]
fn apply_cache_controls_plan_all_false_leaves_bytes_unchanged() {
    // plan 全 false → 零报告、无任何改写（请求字节与未施加时完全一致）
    let mut messages = vec![wire_message("system", "系统指令"), wire_message("user", "你好")];
    let before = messages.iter().map(ChatMessage::to_value).collect::<Vec<_>>();
    let report = apply_cache_controls(
        &mut messages,
        &BreakpointPlan::default(),
        TtlBucket::FiveMinutes,
        false,
    );
    assert_eq!(report, BreakpointReport::default());
    let after = messages.iter().map(ChatMessage::to_value).collect::<Vec<_>>();
    assert_eq!(before, after, "plan 全 false 不得改动任何消息字节");
}

#[test]
fn apply_cache_controls_system_anchor_rewrites_first_system_message() {
    // system 锚点：首条 role=system 消息改写为 parts 形态并挂断点；
    // 其余消息不受影响（改写只发生在被打断点处）
    let mut messages = vec![wire_message("system", "系统指令"), wire_message("user", "你好")];
    let report = apply_cache_controls(
        &mut messages,
        &BreakpointPlan { system: true, ..Default::default() },
        TtlBucket::FiveMinutes,
        false,
    );
    assert_eq!(report, BreakpointReport { placed: 1, dropped: 0 });
    assert_text_part_with_cc(&messages[0], "系统指令", CacheControl::Ephemeral);
    assert_eq!(messages[1].content, Some(ChatContent::Text("你好".to_string())));
    // wire 形状：content[0].cache_control = {"type":"ephemeral"}
    let value = messages[0].to_value();
    assert_eq!(value["content"][0]["cache_control"], json!({ "type": "ephemeral" }));
}

#[test]
fn apply_cache_controls_system_anchor_falls_back_to_first_user_message() {
    // user-prefix 模式：无 system 角色消息，system 锚点回退首条 user 消息
    let mut messages = vec![
        wire_message("user", "System instructions for this run:\n\n全局提示"),
        wire_message("user", "你好"),
    ];
    let report = apply_cache_controls(
        &mut messages,
        &BreakpointPlan { system: true, ..Default::default() },
        TtlBucket::FiveMinutes,
        false,
    );
    assert_eq!(report, BreakpointReport { placed: 1, dropped: 0 });
    assert_text_part_with_cc(
        &messages[0],
        "System instructions for this run:\n\n全局提示",
        CacheControl::Ephemeral,
    );
    assert_eq!(messages[1].content, Some(ChatContent::Text("你好".to_string())));
}

#[test]
fn apply_cache_controls_messages_anchor_part_level_on_last_user() {
    // supports_message_cache_control=false（部分兼容端点只认 part 级）：
    // 最后一条 user 消息改写为 parts 形态挂断点，历史消息不动
    let mut messages = vec![
        wire_message("user", "第一问"),
        wire_message("assistant", "回复"),
        wire_message("user", "第二问"),
    ];
    let report = apply_cache_controls(
        &mut messages,
        &BreakpointPlan { messages: true, ..Default::default() },
        TtlBucket::FiveMinutes,
        false,
    );
    assert_eq!(report, BreakpointReport { placed: 1, dropped: 0 });
    assert_eq!(messages[0].content, Some(ChatContent::Text("第一问".to_string())));
    assert_eq!(messages[1].content, Some(ChatContent::Text("回复".to_string())));
    assert_text_part_with_cc(&messages[2], "第二问", CacheControl::Ephemeral);
}

#[test]
fn apply_cache_controls_messages_anchor_prefers_last_tool_message() {
    // 工具循环：最后一条 role=tool 消息承载历史缓存（OpenAI 兼容线路上
    // tool 结果落在 role=tool 消息）
    let mut messages = vec![wire_message("user", "查一下"), wire_message("tool", "结果")];
    let report = apply_cache_controls(
        &mut messages,
        &BreakpointPlan { messages: true, ..Default::default() },
        TtlBucket::FiveMinutes,
        false,
    );
    assert_eq!(report, BreakpointReport { placed: 1, dropped: 0 });
    assert_text_part_with_cc(&messages[1], "结果", CacheControl::Ephemeral);
}

#[test]
fn apply_cache_controls_message_level_used_when_supported() {
    // supports_message_cache_control=true（Anthropic 原生端点顶层自动模式）：
    // 挂消息级 cache_control，不改写内容
    let mut messages = vec![wire_message("user", "你好")];
    let report = apply_cache_controls(
        &mut messages,
        &BreakpointPlan { messages: true, ..Default::default() },
        TtlBucket::FiveMinutes,
        true,
    );
    assert_eq!(report, BreakpointReport { placed: 1, dropped: 0 });
    assert_eq!(messages[0].cache_control, Some(CacheControl::Ephemeral));
    assert_eq!(messages[0].content, Some(ChatContent::Text("你好".to_string())));
    let value = messages[0].to_value();
    assert_eq!(value["cache_control"], json!({ "type": "ephemeral" }));
    assert_eq!(value["content"], "你好");
}

#[test]
fn apply_cache_controls_ttl_one_hour_maps_to_ephemeral1h() {
    // TTL 桶 → 断点值：OneHour 桶挂 {"type":"ephemeral","ttl":"1h"}
    let mut messages = vec![wire_message("user", "你好")];
    let report = apply_cache_controls(
        &mut messages,
        &BreakpointPlan { messages: true, ..Default::default() },
        TtlBucket::OneHour,
        false,
    );
    assert_eq!(report, BreakpointReport { placed: 1, dropped: 0 });
    assert_text_part_with_cc(&messages[0], "你好", CacheControl::Ephemeral1h);
    let value = messages[0].to_value();
    assert_eq!(
        value["content"][0]["cache_control"],
        json!({ "type": "ephemeral", "ttl": "1h" })
    );
}

#[test]
fn apply_cache_controls_parts_content_marks_last_text_block() {
    // Parts 内容：断点挂到最后一个文本块（白名单），图片块原样保留
    let mut messages = vec![ChatMessage {
        role: "user".to_string(),
        content: Some(ChatContent::Parts(vec![
            ChatContentPart::ImageUrl {
                url: "https://example.com/a.png".to_string(),
                detail: None,
            },
            ChatContentPart::Text { text: "看图说话".to_string(), cache_control: None },
        ])),
        tool_call_id: None,
        reasoning_content: None,
        tool_calls: Vec::new(),
        cache_control: None,
    }];
    let report = apply_cache_controls(
        &mut messages,
        &BreakpointPlan { messages: true, ..Default::default() },
        TtlBucket::FiveMinutes,
        false,
    );
    assert_eq!(report, BreakpointReport { placed: 1, dropped: 0 });
    match &messages[0].content {
        Some(ChatContent::Parts(parts)) => {
            assert!(matches!(parts[0], ChatContentPart::ImageUrl { .. }), "图片块原样保留");
            match &parts[1] {
                ChatContentPart::Text { text, cache_control } => {
                    assert_eq!(text, "看图说话");
                    assert_eq!(*cache_control, Some(CacheControl::Ephemeral));
                }
                other => panic!("期望文本块：{other:?}"),
            }
        }
        other => panic!("期望 parts 内容：{other:?}"),
    }
}

#[test]
fn apply_cache_controls_unplaceable_anchor_counts_dropped() {
    // 锚点不存在（无 system/user 也无 user/tool 消息）→ 请求的断点无法
    // 放置 → dropped 记账（不报错，P5 归因消费）
    let mut messages = vec![wire_message("assistant", "回复")];
    let report = apply_cache_controls(
        &mut messages,
        &BreakpointPlan { system: true, messages: true, ..Default::default() },
        TtlBucket::FiveMinutes,
        false,
    );
    assert_eq!(report, BreakpointReport { placed: 0, dropped: 2 });
    // 消息未被改动
    assert_eq!(messages[0].content, Some(ChatContent::Text("回复".to_string())));
}

#[test]
fn apply_cache_controls_content_none_counts_dropped() {
    // 目标消息无 content → 无法挂 part 级断点 → dropped
    let mut messages = vec![ChatMessage {
        role: "user".to_string(),
        content: None,
        tool_call_id: None,
        reasoning_content: None,
        tool_calls: Vec::new(),
        cache_control: None,
    }];
    let report = apply_cache_controls(
        &mut messages,
        &BreakpointPlan { messages: true, ..Default::default() },
        TtlBucket::FiveMinutes,
        false,
    );
    assert_eq!(report, BreakpointReport { placed: 0, dropped: 1 });
}

#[test]
fn apply_cache_controls_same_anchor_not_double_placed() {
    // system 回退锚点与 messages 锚点重合（单条 user 消息 + 双计划）→
    // 只放置一次，不重复记账
    let mut messages = vec![wire_message("user", "你好")];
    let report = apply_cache_controls(
        &mut messages,
        &BreakpointPlan { system: true, messages: true, ..Default::default() },
        TtlBucket::FiveMinutes,
        false,
    );
    assert_eq!(report, BreakpointReport { placed: 1, dropped: 0 });
}

#[test]
fn apply_cache_controls_three_anchors_all_placed() {
    // 三锚点齐备（system + user + 工具循环）：全量放置
    let mut messages = vec![
        wire_message("system", "系统指令"),
        wire_message("user", "查一下"),
        wire_message("tool", "结果"),
    ];
    let report = apply_cache_controls(
        &mut messages,
        &BreakpointPlan { system: true, messages: true, ..Default::default() },
        TtlBucket::FiveMinutes,
        false,
    );
    assert_eq!(report, BreakpointReport { placed: 2, dropped: 0 });
    assert_text_part_with_cc(&messages[0], "系统指令", CacheControl::Ephemeral);
    assert_eq!(messages[1].content, Some(ChatContent::Text("查一下".to_string())));
    assert_text_part_with_cc(&messages[2], "结果", CacheControl::Ephemeral);
}
