//! 缓存策略组装域（SR-06e · 拆分 · ≠ EL）
//!
//! 从 request/cache.rs 拆出的实现域：
//! - 断点预算分配（[allocate_breakpoints] / [super::allocate_breakpoints_with_cap]）
//! - 缓存策略组装（[build_cache_policy]：能力判定 + 门控矩阵的唯一运行时入口）
//! - 厂商能力兜底表（[super::infer_cache_capability] / [super::CACHE_CAPABILITY_TABLE]）
//! - 会话亲和头（[super::affinity_header]）
//!
//! 门面（request/cache.rs）re-export 全部公开符号，对外路径不变。

use serde_json::Value;

use super::{
    ANTHROPIC_BREAKPOINT_CAP, BreakpointPlan, CacheCapability, CacheKey, CacheMechanism,
    CacheRetention, TtlBucket,
};
use crate::models::{
    cache_behavior_for, infer_vendor, session_affinity_headers, CacheBehavior, CacheTtl,
    ModelCatalog, VendorId,
};

/// 按失效层级分配断点预算：tools → system → messages（对齐 opencode
/// anthropic-messages.ts:511-514）。`tools_count > 0` 即 tools 层申请断点
/// （锚点 = 最后一个工具，对齐 jcode format_tools 只放最后工具，jcode-cache-analysis.md:53-59）；
/// 总上限 [ANTHROPIC_BREAKPOINT_CAP]=4，超限先丢 messages 尾部、绝不报错
/// （opencode cacheControl 记账同款：anthropic-messages.ts:243-250、534-537）。
///
/// 三锚点模型需求至多 3（tools + system + messages 各 1）恒 ≤ 4，超限为
/// 防御性路径；内部 [super::allocate_breakpoints_with_cap] 暴露预算参数，供超限
/// 测试与未来多工具/多消息断点扩展复用同一层级分配逻辑。
pub fn allocate_breakpoints(tools_count: usize, has_system: bool, messages: bool) -> BreakpointPlan {
    allocate_breakpoints_with_cap(ANTHROPIC_BREAKPOINT_CAP, tools_count, has_system, messages)
}

/// 预算可调的内部实现（默认入口 [allocate_breakpoints] 固定 cap=4；
/// 测试经此构造超限场景，未来断点扩展复用同一逻辑）
pub(crate) fn allocate_breakpoints_with_cap(
    cap: usize,
    tools_count: usize,
    has_system: bool,
    messages: bool,
) -> BreakpointPlan {
    let mut plan = BreakpointPlan::default();
    let mut left = cap;
    if tools_count > 0 && left > 0 {
        plan.tools = true;
        left -= 1;
    }
    if has_system && left > 0 {
        plan.system = true;
        left -= 1;
    }
    // messages 为末层：分配后无后续层级，无需再递减预算（避免死赋值警告）
    if messages && left > 0 {
        plan.messages = true;
    }
    plan
}

/// GPT-5.6+ prompt_cache_options.mode（00-catalog §2.1；一期只发 explicit 表达
/// "none 档也须被协议级尊重"，pi openai-responses.ts:278-285）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptCacheMode {
    /// 隐式（默认；不发 options 字段）
    Implicit,
    /// 显式（明确请求不使用隐式缓存）
    Explicit,
}

impl PromptCacheMode {
    /// wire 值（camelCase 语义与 TS 对齐）
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Implicit => "implicit",
            Self::Explicit => "explicit",
        }
    }
}

/// GPT-5.6+ prompt_cache_options（一期仅 {"mode": ...} 单字段）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PromptCacheOptions {
    /// 显式/隐式模式开关
    pub mode: PromptCacheMode,
}

/// 协议无关的缓存策略（单一决策输入；T-15 build.rs 消费，None 字段一律省略 =
/// compactObject 等价，无缓存配置时请求字节与现状逐字节一致）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachePolicy {
    /// 机制分类（记录注入路径；T-15 按机制决定 wire 上发哪些字段）
    pub mechanism: CacheMechanism,
    /// 保留档位（Key 机制 wire 发 prompt_cache_retention；Anthropic 系驱动 TTL 桶）
    pub retention: CacheRetention,
    /// 统一 TTL 桶（同请求不混用 5m/1h，00-catalog §1.3"1h 条目必须位于 5m 条目
    /// 之前"；T-15 传给 apply_cache_controls）
    pub ttl: TtlBucket,
    /// 显式断点放置计划（Explicit 机制 = Some 启用位；具体锚点分配依赖请求形态
    /// tools/system/messages，由 T-15 消费时经 [allocate_breakpoints] 落地）
    pub breakpoints: Option<BreakpointPlan>,
    /// OpenAI 系缓存键（Key 机制由会话 ID 派生并钳 64）
    pub cache_key: Option<CacheKey>,
    /// GPT-5.6+ prompt_cache_options.mode（None = 不发 options 字段）
    pub prompt_cache_options: Option<PromptCacheOptions>,
    /// 会话亲和头（默认 None 全关；P3 §3.3.2 数据表注入后经 overrides 通道翻转）
    pub affinity_header: Option<(&'static str, String)>,
}

/// 统一缓存策略组装：能力判定 + 门控矩阵 → 参数的唯一运行时判定/消费入口
/// （P2 §3.2【调度者裁决】：engine.rs 只调用本函数，不直接暴露能力表）
///
/// 输入：
/// - `catalog`：P3 模型目录（models/ 层，cache_behavior_for 数据真源；None →
///   内置保守兜底表）
/// - `base_url` / `model`：能力判定依据（base_url 关键字优先，model 前缀兜底）
/// - `session_id`：Key 机制 prompt_cache_key 的键来源（None/空白 → 不注入）
/// - `overrides`：ProviderConfig.extra.cache 覆盖 JSON（键名与 P3 CacheBehavior
///   字段对齐，P2 §3.4 建议 2：enabled / retention("short"|"long"|"none")）
///
/// 返回 None = 完全不参与缓存（请求体不含任何 cache 键）：
/// - DeepSeek（P3 矩阵 omit_cache_control 恒 true）→ 整个 cache 参数组不出现
/// - 未识别厂商（机制 None）→ 保守不注入
/// - enabled=false / 非 5.6+ 的 retention="none" / Key 机制无有效会话 ID → 不注入
pub fn build_cache_policy(
    catalog: Option<&ModelCatalog>,
    base_url: Option<&str>,
    model: Option<&str>,
    session_id: Option<&str>,
    overrides: Option<&Value>,
) -> Option<CachePolicy> {
    // 0. 能力判定（C2）：catalog 可用 → 数据真源（models/ 层 cache_behavior_for，
    //    CacheBehavior 经 capability_from_behavior 归并到 wire 决策面，omit 位
    //    单独带回供步骤 3 消费）；无 catalog → 内置保守兜底表
    //    （infer_cache_capability，数据值以 P3 §3.2.2 矩阵为准转录）
    let url = base_url.unwrap_or("").to_ascii_lowercase();
    let model_lower = model.unwrap_or("").to_ascii_lowercase();
    let (capability, behavior, omit_cache_control) = match catalog {
        Some(catalog) => {
            let vendor = infer_vendor(&url, &model_lower);
            let behavior = cache_behavior_for(Some(catalog), vendor, &model_lower);
            (capability_from_behavior(&behavior), behavior, behavior.omit_cache_control)
        }
        None => {
            let capability = infer_cache_capability(base_url, model);
            // 兜底表无 omit 位（T-13a 冻结）：DeepSeek 强制省略按 vendor 推断
            // 直判（与 infer_cache_capability 同链：url 关键字 → model 前缀）
            let omit = infer_vendor(&url, &model_lower) == VendorId::Deepseek;
            // G2：会话亲和头数据源 = 行为矩阵（models/cache_key.rs 数据表），
            // 兜底路径取矩阵默认行（与兜底表转录自同一 P3 §3.2.2 矩阵；Grok
            // 无 catalog 时同样注入 x-grok-conv-id，两路径行为一致）
            let behavior =
                cache_behavior_for(None, infer_vendor(&url, &model_lower), &model_lower);
            (capability, behavior, omit)
        }
    };
    // 1. 硬关：extra.cache.enabled == false → 完全不参与缓存（P2 §3.2 步骤 1）
    if overrides_disabled(overrides) {
        return None;
    }
    // 2. none 档：retention == "none" 整体不参与（摘要请求同款）；GPT-5.6+ 豁免——
    //    "none 也须被尊重"，改发 explicit options（P2 §3.2 步骤 5）
    let retention_override = parse_retention_override(overrides);
    if retention_override == Some(CacheRetention::None)
        && !capability.supports_explicit_prompt_cache_mode
    {
        return None;
    }
    // 3. DeepSeek 强制省略：P3 矩阵 omit_cache_control 恒 true（官方不支持
    //    prompt_cache_key，发出静默忽略，vendor-cache-gaps.md:104）；catalog
    //    路径直接消费 CacheBehavior 的 omit 位（唯一数据真源，C2）
    if omit_cache_control {
        return None;
    }
    // 4. 机制分流
    match capability.mechanism {
        // 机制 None（本地/未知模型）：不参与缓存
        CacheMechanism::None => None,
        // Auto（DeepSeek/Kimi/GLM/Gemini 隐式）：客户端零参数，只保前缀稳定；
        // retention 恒 Short 为内部档位，wire 上不发任何缓存字段
        CacheMechanism::Auto => Some(CachePolicy {
            mechanism: CacheMechanism::Auto,
            retention: CacheRetention::Short,
            ttl: TtlBucket::FiveMinutes,
            breakpoints: None,
            cache_key: None,
            prompt_cache_options: None,
            affinity_header: affinity_header(Some(&behavior), session_id.unwrap_or("")),
        }),
        // Explicit（Anthropic/MiniMax M2.x/百炼）：断点注入启用 + TTL 桶按档选
        CacheMechanism::Explicit => {
            let retention = retention_override.unwrap_or(capability.retention);
            if retention == CacheRetention::None {
                // 防御分支：显式断点机制下 none 档 = 不参与（实际已被步骤 2 拦截）
                return None;
            }
            Some(CachePolicy {
                mechanism: CacheMechanism::Explicit,
                retention,
                ttl: ttl_for_retention(retention, &capability),
                // 机制启用位：具体锚点（tools 数 / system / messages 形态）依赖请求
                // 内容，由 T-15 build.rs 消费时经 allocate_breakpoints 落地
                breakpoints: Some(BreakpointPlan::default()),
                cache_key: None,
                prompt_cache_options: None,
                affinity_header: affinity_header(Some(&behavior), session_id.unwrap_or("")),
            })
        }
        // Key（OpenAI/Kimi/xAI）：会话 ID 派生键 + retention 按档
        CacheMechanism::Key => {
            let retention = retention_override.unwrap_or(capability.retention);
            if retention == CacheRetention::None {
                // GPT-5.6+ none 档：prompt_cache_options={"mode":"explicit"} 协议级
                // 禁止隐式缓存（pi openai-responses.ts:278-285）；不发键
                return Some(CachePolicy {
                    mechanism: CacheMechanism::Key,
                    retention: CacheRetention::None,
                    ttl: ttl_for_retention(CacheRetention::None, &capability),
                    breakpoints: None,
                    cache_key: None,
                    prompt_cache_options: Some(PromptCacheOptions {
                        mode: PromptCacheMode::Explicit,
                    }),
                    affinity_header: affinity_header(Some(&behavior), session_id.unwrap_or("")),
                });
            }
            // 键路由：会话 ID → prompt_cache_key（码点钳 64）；无有效会话 ID →
            // 整体不注入（无键则无路由对象）
            let key = CacheKey::from_session_id(session_id?)?;
            Some(CachePolicy {
                mechanism: CacheMechanism::Key,
                retention,
                ttl: ttl_for_retention(retention, &capability),
                breakpoints: None,
                cache_key: Some(key),
                prompt_cache_options: None,
                affinity_header: affinity_header(Some(&behavior), session_id.unwrap_or("")),
            })
        }
    }
}

/// CacheBehavior（models/ 层数据真源）→ CacheCapability（wire 决策面）归并映射
/// （C2：行为矩阵是唯一数据真源，本映射只归并不新增事实）
///
/// 机制分类（与兜底表转录口径一致，P3 §3.2.2）：
/// - 不参与任何缓存（supports_prompt_caching=false，如 Qwen 直连保守行）→ None
/// - Anthropic 式断点（supports_cache_control=true，Anthropic/MiniMax M2.x/百炼）→ Explicit
/// - 键路由（supports_prompt_cache_key=true，OpenAI/Grok/Kimi）→ Key
/// - 其余自动缓存（DeepSeek/MiniMax M3/Gemini/GLM 隐式）→ Auto
///
/// TTL 桶：default_ttl 为 1h 档（Hour）→ 5m+1h 双桶；5m/30m/Day 档只挂 5m 桶
/// （v2 新增 30m 档 = gpt-5.6 系 TTL，wire 层 TtlBucket 无 30m 桶 → 保守按 5m 桶；
/// Day=24h 属 OpenAI retention 长档值域，wire 桶无 24h 档，写价 2x 宁缺毋滥）。
/// G1 修复（02-model-specific-optimizations.md 缺口 G1 / 条目 #10）：Anthropic
/// 官方能力上支持 5m+1h 双桶（supportsLongCacheRetention 模型开关默认 true，
/// pi anthropic-messages.ts:59-73）——矩阵 default_ttl=Short 只表达默认档位，
/// 不表达能力上限。此前判定只看 default_ttl，而 catalog 路径 Anthropic 条目
/// cacheTtl="5m"（矩阵行为行亦为 Short）→ 1h 桶永久关闭，cacheWritePrice1h
/// 定价与请求侧脱节；本判定同时消费矩阵 default_ttl 与模型级 ttl 档
/// （catalog 条目 cache_ttl 经 cache_behavior_for 归并进 default_ttl）：
/// 矩阵 1h 或 Anthropic 显式断点厂商即挂双桶。厂商限定防止放宽误伤——
/// MiniMax M2.x / 百炼同为 supports_cache_control=true 但矩阵仅 5m 单桶
/// （vendor-cache-mechanisms.md：M2.x 5m、百炼仅 ephemeral），不得随 Anthropic
/// 并入 1h。
/// GPT-5.6+ 显式模式位：CacheBehavior 无该字段（T-19 冻结），catalog 路径保守
/// 按非 5.6+ 处理（retention="none" 整体不参与），5.6+ 显式模式仍由无 catalog
/// 兜底表承担（OPENAI_CACHE_56 前缀行）。
fn capability_from_behavior(behavior: &CacheBehavior) -> CacheCapability {
    let mechanism = if !behavior.supports_prompt_caching {
        CacheMechanism::None
    } else if behavior.supports_cache_control {
        CacheMechanism::Explicit
    } else if behavior.supports_prompt_cache_key {
        CacheMechanism::Key
    } else {
        CacheMechanism::Auto
    };
    let ttl_buckets = if behavior.default_ttl == Some(CacheTtl::Hour)
        || (behavior.vendor == VendorId::Anthropic && behavior.supports_cache_control)
    {
        BUCKETS_5M_1H
    } else {
        BUCKETS_5M
    };
    let retention = match behavior.default_ttl {
        Some(CacheTtl::Hour | CacheTtl::Day) => CacheRetention::Long,
        _ => CacheRetention::Short,
    };
    CacheCapability {
        mechanism,
        supports_cache_control: behavior.supports_cache_control,
        supports_cache_control_on_tools: behavior.supports_cache_control,
        breakpoint_cap: behavior.breakpoint_max.map_or(0, usize::from),
        ttl_buckets,
        prompt_cache_key: behavior.supports_prompt_cache_key,
        retention,
        supports_explicit_prompt_cache_mode: false,
    }
}

/// extra.cache.enabled 覆盖判定（缺省 true；false = 完全不参与缓存）
fn overrides_disabled(overrides: Option<&Value>) -> bool {
    matches!(
        overrides.and_then(|v| v.get("enabled")).and_then(Value::as_bool),
        Some(false)
    )
}

/// extra.cache.retention 覆盖解析（"short" | "long" | "none"，缺省 None = 用能力表档）
fn parse_retention_override(overrides: Option<&Value>) -> Option<CacheRetention> {
    let raw = overrides?.get("retention")?.as_str()?;
    match raw.to_ascii_lowercase().as_str() {
        "short" => Some(CacheRetention::Short),
        "long" => Some(CacheRetention::Long),
        "none" => Some(CacheRetention::None),
        _ => None,
    }
}

/// retention → 统一 TTL 桶（同请求不混用 5m/1h，00-catalog §1.3；
/// 1h 桶仅能力表含 OneHour 且 retention=Long 时启用，写价 2x 宁缺毋滥）
fn ttl_for_retention(retention: CacheRetention, capability: &CacheCapability) -> TtlBucket {
    match retention {
        CacheRetention::Long if capability.ttl_buckets.contains(&TtlBucket::OneHour) => {
            TtlBucket::OneHour
        }
        _ => TtlBucket::FiveMinutes,
    }
}

/// OpenAI 系 prompt_cache_retention wire 值（官方值域，00-catalog §2.1）：
/// Short → "in_memory"、Long → "24h"、None → None（不发）。
/// 长档受 supports_long_retention 约束（P3 数据层），兜底保守。
pub fn retention_wire_value(retention: CacheRetention) -> Option<&'static str> {
    match retention {
        CacheRetention::None => None,
        CacheRetention::Short => Some("in_memory"),
        CacheRetention::Long => Some("24h"),
    }
}

/// 会话亲和头判定（G2 接线：消费 models/cache_key.rs 的
/// [session_affinity_headers] 数据表——行为矩阵 supports_conv_header +
/// conv_header_name 门控，Grok 行返回 x-grok-conv-id = derivePromptCacheKey
/// 值，session_id 前 64 码点，粘性路由，vendor-cache-mechanisms.md:121）。
///
/// 本文件域是 chat-completions 请求构造面，只放行 **Chat 轨**头名
/// （x-grok-conv-id）；百炼 x-dashscope-session-cache 属 Responses 轨
/// （vendor-cache-mechanisms.md 与 cache_key.rs 数据表注释），由未来
/// Responses 请求构造面消费，此处保守不注入（G2 验收：其他厂商 None）。
///
/// `behavior`：catalog 路径传 cache_behavior_for 结果；无 catalog 兜底时
/// 传行为矩阵默认行（与兜底表转录自同一 P3 §3.2.2 矩阵）；None → 不注入。
pub fn affinity_header(
    behavior: Option<&CacheBehavior>,
    session_id: &str,
) -> Option<(&'static str, String)> {
    let (name, value) = session_affinity_headers(behavior?, session_id)
        .into_iter()
        .next()?;
    if name == "x-grok-conv-id" {
        Some(("x-grok-conv-id", value))
    } else {
        // 未收录 / Responses 轨头名（如 x-dashscope-session-cache）→ 不注入
        None
    }
}

/// TTL 桶组合常量（能力表数据）
const BUCKETS_5M: &[TtlBucket] = &[TtlBucket::FiveMinutes];
const BUCKETS_5M_1H: &[TtlBucket] = &[TtlBucket::FiveMinutes, TtlBucket::OneHour];
const NO_TTL: &[TtlBucket] = &[];

/// Anthropic 官方（P3 §3.2.2 Anthropic 行：Explicit / cc ✅ / 20 块回溯 /
/// cap 4 / 5m+1h 双桶，vendor-cache-mechanisms.md:219-265）
const ANTHROPIC_CACHE: CacheCapability = CacheCapability {
    mechanism: CacheMechanism::Explicit,
    supports_cache_control: true,
    supports_cache_control_on_tools: true,
    breakpoint_cap: 4,
    ttl_buckets: BUCKETS_5M_1H,
    prompt_cache_key: false,
    retention: CacheRetention::Short,
    supports_explicit_prompt_cache_mode: false,
};

/// DeepSeek（P3 §3.2.2 Deepseek 行：Auto / omit 强制 ✅ / key ❌ 官方不支持 /
/// 默认 TTL 300s；客户端只做前缀稳定 + 解析 hit/miss）
const DEEPSEEK_CACHE: CacheCapability = CacheCapability {
    mechanism: CacheMechanism::Auto,
    supports_cache_control: false,
    supports_cache_control_on_tools: false,
    breakpoint_cap: 0,
    ttl_buckets: BUCKETS_5M,
    prompt_cache_key: false,
    retention: CacheRetention::Short,
    supports_explicit_prompt_cache_mode: false,
};

/// MiniMax M2.x（P3 §3.2.2 MiniMax 行：主动缓存仅 M2.x，Anthropic 轨 /
/// cc ✅ / 断点语义与 Anthropic 一致 cap 4 / 5m；P2 §3.3 A MiniMax 分支）
const MINIMAX_M2_CACHE: CacheCapability = CacheCapability {
    mechanism: CacheMechanism::Explicit,
    supports_cache_control: true,
    supports_cache_control_on_tools: true,
    breakpoint_cap: 4,
    ttl_buckets: BUCKETS_5M,
    prompt_cache_key: false,
    retention: CacheRetention::Short,
    supports_explicit_prompt_cache_mode: false,
};

/// MiniMax M3（P3 §3.2.2：M3 不支持主动缓存，vendor-cache-gaps.md:186 → Auto 全关）
const MINIMAX_M3_CACHE: CacheCapability = CacheCapability {
    mechanism: CacheMechanism::Auto,
    supports_cache_control: false,
    supports_cache_control_on_tools: false,
    breakpoint_cap: 0,
    ttl_buckets: BUCKETS_5M,
    prompt_cache_key: false,
    retention: CacheRetention::Short,
    supports_explicit_prompt_cache_mode: false,
};

/// OpenAI 官方（P3 §3.2.2 Openai 行：Key / cc ❌ 自有断点参数体系 / key ✅ /
/// 5.6+ cap 4；兜底保守 retention=Short，24h 长档由 P3 数据/overrides 显式开启）
const OPENAI_CACHE: CacheCapability = CacheCapability {
    mechanism: CacheMechanism::Key,
    supports_cache_control: false,
    supports_cache_control_on_tools: false,
    breakpoint_cap: 4,
    ttl_buckets: BUCKETS_5M,
    prompt_cache_key: true,
    retention: CacheRetention::Short,
    supports_explicit_prompt_cache_mode: false,
};

/// OpenAI GPT-5.6+（supports_explicit_prompt_cache_mode ✅：none 档须协议级尊重，
/// 发 {"mode":"explicit"}；5.6+ 仅 30m TTL，官方不发 retention，00-catalog §2.1）
const OPENAI_CACHE_56: CacheCapability = CacheCapability {
    mechanism: CacheMechanism::Key,
    supports_cache_control: false,
    supports_cache_control_on_tools: false,
    breakpoint_cap: 4,
    ttl_buckets: BUCKETS_5M,
    prompt_cache_key: true,
    retention: CacheRetention::Short,
    supports_explicit_prompt_cache_mode: true,
};

/// Kimi（P3 §3.2.2 Kimi 行：Auto 全自动 / key ✅ session/task id 语义；键辅助
/// 经 P3/T-18 数据层翻转后由 Key 化路径处理，本兜底表 Auto 分支零参数）
const KIMI_CACHE: CacheCapability = CacheCapability {
    mechanism: CacheMechanism::Auto,
    supports_cache_control: false,
    supports_cache_control_on_tools: false,
    breakpoint_cap: 0,
    ttl_buckets: BUCKETS_5M,
    prompt_cache_key: true,
    retention: CacheRetention::Short,
    supports_explicit_prompt_cache_mode: false,
};

/// xAI Grok（P3 §3.2.2 Grok 行：Key / key ✅ Responses 原生 / conv header ✅
/// x-grok-conv-id Chat 轨；亲和头 P2 默认关，P3 §3.3.2 数据注入后翻转）
const GROK_CACHE: CacheCapability = CacheCapability {
    mechanism: CacheMechanism::Key,
    supports_cache_control: false,
    supports_cache_control_on_tools: false,
    breakpoint_cap: 0,
    ttl_buckets: BUCKETS_5M,
    prompt_cache_key: true,
    retention: CacheRetention::Short,
    supports_explicit_prompt_cache_mode: false,
};

/// Gemini（P3 §3.2.2 Gemini 行：Auto 隐式 / 无 cache_control，cachedContent 独立
/// 资源 / 隐式最低 4096 tokens）
const GEMINI_CACHE: CacheCapability = CacheCapability {
    mechanism: CacheMechanism::Auto,
    supports_cache_control: false,
    supports_cache_control_on_tools: false,
    breakpoint_cap: 0,
    ttl_buckets: BUCKETS_5M,
    prompt_cache_key: false,
    retention: CacheRetention::Short,
    supports_explicit_prompt_cache_mode: false,
};

/// GLM z.ai（P3 §3.2.2 Glm 行：Auto / Anthropic 端点存在但未实测确认，保守 ❌，
/// vendor-cache-gaps.md:150-153）
const GLM_CACHE: CacheCapability = CacheCapability {
    mechanism: CacheMechanism::Auto,
    supports_cache_control: false,
    supports_cache_control_on_tools: false,
    breakpoint_cap: 0,
    ttl_buckets: BUCKETS_5M,
    prompt_cache_key: false,
    retention: CacheRetention::Short,
    supports_explicit_prompt_cache_mode: false,
};

/// 百炼 Dashscope（P3 §3.2.2 Dashscope 行：Explicit 仅 ephemeral / ≤4 / 20 块回溯 /
/// tools 中 cache_control 被忽略 vendor-cache-gaps.md:16-42 / conv header 仅 Responses）
const DASHSCOPE_CACHE: CacheCapability = CacheCapability {
    mechanism: CacheMechanism::Explicit,
    supports_cache_control: true,
    supports_cache_control_on_tools: false,
    breakpoint_cap: 4,
    ttl_buckets: BUCKETS_5M,
    prompt_cache_key: false,
    retention: CacheRetention::Short,
    supports_explicit_prompt_cache_mode: false,
};

/// 未识别厂商（P3 §3.2.2 Auto 行：保守默认不注入任何缓存字段，对齐 jcode
/// model_supports_cache 的"否则视为不支持"，jcode-cache-analysis.md:2744）
const UNKNOWN_CACHE: CacheCapability = CacheCapability {
    mechanism: CacheMechanism::None,
    supports_cache_control: false,
    supports_cache_control_on_tools: false,
    breakpoint_cap: 0,
    ttl_buckets: NO_TTL,
    prompt_cache_key: false,
    retention: CacheRetention::Short,
    supports_explicit_prompt_cache_mode: false,
};

/// 内置保守兜底能力表（model 名前缀，不区分大小写，最长前缀命中；覆盖顺序
/// 与 infer_reasoning_vendor / MODEL_SERIES_CAPABILITIES 同构，vendor.rs:219-270）
///
/// 【调度者裁决】本表与 [super::infer_cache_capability] 降级为"无 catalog 可用时的
/// 内置保守兜底默认"，仅由 [build_cache_policy] 内部兜底调用（engine.rs 不再
/// 直接暴露）；数据值以 P3 §3.2.2 矩阵为准转录；唯一数据真源 = P3
/// cache_behavior_for（models/behavior.rs，T-19 交付），P2 表只兜底。
pub const CACHE_CAPABILITY_TABLE: &[(&str, CacheCapability)] = &[
    ("claude", ANTHROPIC_CACHE),
    ("deepseek", DEEPSEEK_CACHE),
    ("minimax-m2", MINIMAX_M2_CACHE),
    ("minimax-m3", MINIMAX_M3_CACHE),
    ("gpt-5.6", OPENAI_CACHE_56),
    ("gpt", OPENAI_CACHE),
    ("o4", OPENAI_CACHE),
    ("o3", OPENAI_CACHE),
    ("o1", OPENAI_CACHE),
    ("kimi", KIMI_CACHE),
    ("grok", GROK_CACHE),
    ("gemini", GEMINI_CACHE),
    ("glm", GLM_CACHE),
];

/// 推断缓存能力（内置保守兜底；判定顺序与 infer_reasoning_vendor 完全同构，
/// vendor.rs:277-310：base_url 关键字优先 → [CACHE_CAPABILITY_TABLE] 最长前缀
/// → 未命中保守全关）
pub fn infer_cache_capability(base_url: Option<&str>, model: Option<&str>) -> CacheCapability {
    let url = base_url.unwrap_or("").to_ascii_lowercase();
    let model = model.unwrap_or("").to_ascii_lowercase();
    // ── base_url 关键字优先（与 infer_reasoning_vendor 判定顺序同构）──
    if url.contains("anthropic") || model.starts_with("claude") {
        return ANTHROPIC_CACHE;
    }
    if url.contains("deepseek") || model.starts_with("deepseek") {
        return DEEPSEEK_CACHE;
    }
    if url.contains("openai") {
        return if model.starts_with("gpt-5.6") {
            OPENAI_CACHE_56
        } else {
            OPENAI_CACHE
        };
    }
    if url.contains("generativelanguage.googleapis.com")
        || url.contains("gemini")
        || model.starts_with("gemini")
    {
        return GEMINI_CACHE;
    }
    if url.contains("dashscope") {
        return DASHSCOPE_CACHE;
    }
    // MiniMax 版本未知（url 命中但 model 无 m2/m3 前缀）保守按 M3（无主动缓存）
    if url.contains("minimax")
        && !model.starts_with("minimax-m2")
        && !model.starts_with("minimax-m3")
    {
        return MINIMAX_M3_CACHE;
    }
    // ── model 前缀最长命中（CACHE_CAPABILITY_TABLE）──
    let mut best: Option<&(&str, CacheCapability)> = None;
    for entry in CACHE_CAPABILITY_TABLE {
        if model.starts_with(entry.0)
            && best.is_none_or(|current| entry.0.len() > current.0.len())
        {
            best = Some(entry);
        }
    }
    best.map_or(UNKNOWN_CACHE, |entry| entry.1)
}
