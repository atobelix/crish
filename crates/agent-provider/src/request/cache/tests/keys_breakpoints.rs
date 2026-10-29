//! cache 测试 · CacheRetention / CacheKey / CacheControl / 断点预算 / 亲和头 / 能力表

use super::*;

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
    assert_eq!(
        CacheControl::Ephemeral.to_value(),
        json!({ "type": "ephemeral" })
    );
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
    assert!(BreakpointPlan {
        tools: true,
        ..Default::default()
    }
    .has_any());
    assert!(BreakpointPlan {
        system: true,
        ..Default::default()
    }
    .has_any());
    assert!(BreakpointPlan {
        messages: true,
        ..Default::default()
    }
    .has_any());
}

#[test]
fn allocate_breakpoints_four_quadrants() {
    // 预算四象限：仅 tools / 仅 system / 仅 messages / 全有
    assert_eq!(
        allocate_breakpoints(2, false, false),
        BreakpointPlan {
            tools: true,
            system: false,
            messages: false
        }
    );
    assert_eq!(
        allocate_breakpoints(0, true, false),
        BreakpointPlan {
            tools: false,
            system: true,
            messages: false
        }
    );
    assert_eq!(
        allocate_breakpoints(0, false, true),
        BreakpointPlan {
            tools: false,
            system: false,
            messages: true
        }
    );
    assert_eq!(
        allocate_breakpoints(1, true, true),
        BreakpointPlan {
            tools: true,
            system: true,
            messages: true
        }
    );
    // 全无 → 零断点
    assert_eq!(
        allocate_breakpoints(0, false, false),
        BreakpointPlan::default()
    );
}

#[test]
fn allocate_breakpoints_drops_tail_when_over_cap() {
    // 超限丢尾不报错（P2 §5.1：cap=1 只保 tools；层级 tools→system→messages，
    // 超限先丢 messages 尾部，对齐 opencode anthropic-messages.ts:511-514）
    let plan = allocate_breakpoints_with_cap(1, 1, true, true);
    assert_eq!(
        plan,
        BreakpointPlan {
            tools: true,
            system: false,
            messages: false
        }
    );
    // cap=2：tools + system 保，messages 丢
    let plan = allocate_breakpoints_with_cap(2, 1, true, true);
    assert_eq!(
        plan,
        BreakpointPlan {
            tools: true,
            system: true,
            messages: false
        }
    );
    // cap=0（极端）→ 全丢不 panic
    assert_eq!(
        allocate_breakpoints_with_cap(0, 1, true, true),
        BreakpointPlan::default()
    );
    // 默认入口恒 cap=4：三锚点需求 ≤ 3 全分配
    assert!(allocate_breakpoints(1, true, true).has_any());
}

// ── retention / 亲和头 ──

#[test]
fn retention_wire_value_mapping() {
    // OpenAI 官方值域（P2 §3.2 / 00-catalog §2.1）
    assert_eq!(
        retention_wire_value(CacheRetention::Short),
        Some("in_memory")
    );
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
