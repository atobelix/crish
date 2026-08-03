//! 缓存参数载体与键派生（P2 通用格式层，docs/cache-optimization/03-plans/P2-wire-cache-params.md §3.1）
//!
//! - [CacheRetention]：缓存保留档位（none/short/long，默认 short）
//! - [TtlBucket]：wire 层 TTL 桶（5m/1h，A2 C3：避免与 P3 models 层同名 `CacheTtl` 冲突）
//! - [CacheControl]：块级/消息级缓存控制标记（Anthropic 系 wire 值）
//! - [CacheKey]：OpenAI 系 prompt_cache_key 语义载体（会话 ID → 码点钳 64，
//!   A2 C4：请求构造面真源，P3 derive_prompt_cache_key 委托本实现）
//! - [CacheMechanism] / [CacheCapability]：缓存机制分类与厂商能力声明
//! - [BreakpointPlan] / [apply_cache_controls] / [text_to_parts_with_cc]：
//!   断点预算分配与 wire 施加（三锚点，载体字段由 messages.rs 提供）
//!
//! 全部为纯数据结构/纯函数（无 HTTP、无 IO），单测驱动。

use serde_json::{json, Value};

use crate::models::{cache_behavior_for, infer_vendor, CacheBehavior, CacheTtl, ModelCatalog, VendorId};
use crate::request::messages::{ChatContent, ChatContentPart, ChatMessage};

/// 缓存保留档位（对齐 pi 的 CacheRetention 三档，pi-cache-analysis.md:126-131）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CacheRetention {
    /// 完全不参与缓存（不发任何缓存参数；摘要请求强制此档，对齐 pi compaction.ts:562-581）
    None,
    /// 短档：Anthropic 5 分钟 TTL 桶 / OpenAI in_memory
    #[default]
    Short,
    /// 长档：Anthropic 1 小时 TTL 桶（写价 2x）/ OpenAI 24h extended
    Long,
}

/// wire 层 TTL 桶（对齐 opencode protocols/utils/cache.ts:12-16 的 5m/1h 双桶）
///
/// 命名按 A2 审计 C3 裁决：P3 在 models/ttl.rs 定义同名 `CacheTtl`（Short/Hour/Day
/// 三档路由语义），两者同处 agent-provider crate 必然冲突；本类型（wire 桶）更名
/// `TtlBucket`，`CacheTtl` 名称留给 P3 的模型级 TTL 路由档。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TtlBucket {
    /// `{"type":"ephemeral"}`（Anthropic 默认 5 分钟；命中刷新免费）
    FiveMinutes,
    /// `{"type":"ephemeral","ttl":"1h"}`（写价 2x，受模型开关 supportsLongCacheRetention 约束）
    OneHour,
}

/// 块级/消息级缓存控制标记（Anthropic 系 wire 值）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheControl {
    /// `{"type":"ephemeral"}`
    Ephemeral,
    /// `{"type":"ephemeral","ttl":"1h"}`
    Ephemeral1h,
}

impl CacheControl {
    /// 序列化为 wire 值
    pub fn to_value(self) -> Value {
        match self {
            Self::Ephemeral => json!({ "type": "ephemeral" }),
            Self::Ephemeral1h => json!({ "type": "ephemeral", "ttl": "1h" }),
        }
    }
}

/// OpenAI prompt_cache_key 最大长度（码点）
pub const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH: usize = 64;

/// 统一缓存键（OpenAI 系 prompt_cache_key 的语义载体）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheKey(pub String);

impl CacheKey {
    /// 会话 ID → 缓存键：按 Unicode 码点钳到 64（对齐 pi openai-prompt-cache.ts:1-8
    /// 的 OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH=64；钳制真源见 pi-cache-analysis.md:169）
    ///
    /// 空串/全空白 → None（显式不参与缓存由调用方用 [CacheRetention::None] 表达）。
    /// 钳制按码点而非字节（`.chars().take(64)`），多字节 UTF-8 会话 ID
    /// （中文/emoji）不会截成半字符。
    pub fn from_session_id(session_id: &str) -> Option<Self> {
        let trimmed = session_id.trim();
        if trimmed.is_empty() {
            return None;
        }
        Some(Self(
            trimmed.chars().take(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).collect(),
        ))
    }
}

/// 缓存机制分类（00-catalog 第 12.1 节 cache_type/cache_mechanism 的 Rust 形态）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheMechanism {
    /// 自动缓存（DeepSeek/Kimi/GLM 隐式/Gemini 隐式）：客户端零参数，只保前缀稳定
    Auto,
    /// Anthropic 式显式断点（官方 Anthropic / MiniMax M2.x / 百炼显式 / GLM 待实测）
    Explicit,
    /// OpenAI 系键路由（prompt_cache_key + retention；GPT-5.6+ 可叠加 options）
    Key,
    /// 不支持缓存（本地模型等）
    None,
}

/// 缓存能力声明（对齐 pi types.ts:621 的 supportsCacheControlOnTools 等模型开关）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CacheCapability {
    /// 机制分类（决定走哪条注入路径）
    pub mechanism: CacheMechanism,
    /// 是否支持块级/消息级 cache_control（Anthropic 系）
    pub supports_cache_control: bool,
    /// 工具定义上能否携带 cache_control（Fireworks 反例：拒绝未知字段，
    /// pi-cache-analysis.md:314；DeepSeek 忽略但强制省略）
    pub supports_cache_control_on_tools: bool,
    /// 断点预算上限（Anthropic/MiniMax/百炼 = 4）
    pub breakpoint_cap: usize,
    /// 可用的 TTL 桶（默认仅 5m；长档受 supports_long_retention 约束）
    pub ttl_buckets: &'static [TtlBucket],
    /// 是否发送 prompt_cache_key（OpenAI/Kimi/xAI/百炼 Responses）
    pub prompt_cache_key: bool,
    /// prompt_cache_retention 可用档（in_memory / 24h）
    pub retention: CacheRetention,
    /// 是否支持 GPT-5.6+ prompt_cache_options.mode（显式/隐式开关）
    pub supports_explicit_prompt_cache_mode: bool,
}

// ════════════════════════════════════════════════════════════════════════
// T-13b：断点预算与策略（P2 §3.1.2/§3.1.3、§3.2、§3.4）
// 追加于 T-13a 载体之上；全部为纯数据结构/纯函数（无 HTTP、无 IO）。
// 运行时唯一判定/消费入口 = build_cache_policy（engine.rs 只调本函数，
// P2 §3.2【调度者裁决】）；infer_cache_capability + CACHE_CAPABILITY_TABLE
// 降级为"无 catalog 可用时的内置保守兜底默认"（数据值以 P3 §3.2.2 矩阵转录）。
// ════════════════════════════════════════════════════════════════════════

/// 写入断点上限（Anthropic 每请求最多 4 个显式 cache_control 断点；
/// 措辞按 A1-19 统一：写入断点上限 4，implicit 自动缓存占 1 槽位时显式最多 3）
pub const ANTHROPIC_BREAKPOINT_CAP: usize = 4;

/// 断点放置计划（三锚点布尔；对齐 opencode ANTHROPIC_BREAKPOINT_CAP=4 的
/// 层级分配输出，anthropic-messages.ts:511-514）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BreakpointPlan {
    /// 是否在最后一个工具上打断点（工具位于缓存层级最高处，优先保留）
    pub tools: bool,
    /// 是否在首条 system 消息上打断点（user-prefix 模式下为首条 user 消息）
    pub system: bool,
    /// 是否在最后一条 user/tool 消息末块打断点（工具循环内每轮锚点稳定）
    pub messages: bool,
}

impl BreakpointPlan {
    /// 任一断点开启（T-15 注入前快速短路；全 false = 请求字节与未施加时一致）
    pub fn has_any(&self) -> bool {
        self.tools || self.system || self.messages
    }
}

/// 断点放置摘要（供日志与未来 P5 归因消费，P5 §3.4.3 MissAttribution；
/// placed/dropped 记账在 T-14 载体字段落地后由 [apply_cache_controls] 完成）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BreakpointReport {
    /// 实际放置的断点数
    pub placed: usize,
    /// 因预算超限被丢弃的断点数（不报错，降级日志用）
    pub dropped: usize,
}

/// 按失效层级分配断点预算：tools → system → messages（对齐 opencode
/// anthropic-messages.ts:511-514）。`tools_count > 0` 即 tools 层申请断点
/// （锚点 = 最后一个工具，对齐 jcode format_tools 只放最后工具，jcode-cache-analysis.md:53-59）；
/// 总上限 [ANTHROPIC_BREAKPOINT_CAP]=4，超限先丢 messages 尾部、绝不报错
/// （opencode cacheControl 记账同款：anthropic-messages.ts:243-250、534-537）。
///
/// 三锚点模型需求至多 3（tools + system + messages 各 1）恒 ≤ 4，超限为
/// 防御性路径；内部 [allocate_breakpoints_with_cap] 暴露预算参数，供超限
/// 测试与未来多工具/多消息断点扩展复用同一层级分配逻辑。
pub fn allocate_breakpoints(tools_count: usize, has_system: bool, messages: bool) -> BreakpointPlan {
    allocate_breakpoints_with_cap(ANTHROPIC_BREAKPOINT_CAP, tools_count, has_system, messages)
}

/// 预算可调的内部实现（默认入口 [allocate_breakpoints] 固定 cap=4；
/// 测试经此构造超限场景，未来断点扩展复用同一逻辑）
fn allocate_breakpoints_with_cap(
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
    let (capability, omit_cache_control) = match catalog {
        Some(catalog) => {
            let vendor = infer_vendor(&url, &model_lower);
            let behavior = cache_behavior_for(Some(catalog), vendor, &model_lower);
            (capability_from_behavior(&behavior), behavior.omit_cache_control)
        }
        None => {
            let capability = infer_cache_capability(base_url, model);
            // 兜底表无 omit 位（T-13a 冻结）：DeepSeek 强制省略按 vendor 推断
            // 直判（与 infer_cache_capability 同链：url 关键字 → model 前缀）
            let omit = infer_vendor(&url, &model_lower) == VendorId::Deepseek;
            (capability, omit)
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
            affinity_header: affinity_header(&capability, session_id.unwrap_or("")),
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
                affinity_header: affinity_header(&capability, session_id.unwrap_or("")),
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
                    affinity_header: affinity_header(&capability, session_id.unwrap_or("")),
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
                affinity_header: affinity_header(&capability, session_id.unwrap_or("")),
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
/// TTL 桶：default_ttl 为 1h 档（Hour）→ 5m+1h 双桶；5m/Day 档只挂 5m 桶
/// （Day=24h 属 OpenAI retention 长档值域，wire 桶无 24h 档，写价 2x 宁缺毋滥）。
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
    let ttl_buckets = if behavior.default_ttl == Some(CacheTtl::Hour) {
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

/// 会话亲和头判定（P2 只提供判定入口，默认全关，pi-cache-analysis.md:141-143；
/// 数据表 x-grok-conv-id / x-dashscope-session-cache / x-session-affinity 由 P3
/// §3.3.2 交付并经 overrides 通道注入后由本函数判定——本函数不直接持数据。
/// A1 注记：与 P3 session_affinity_headers 取一实现，本函数为 P2 侧判定入口）
pub fn affinity_header(
    _capability: &CacheCapability,
    _session_id: &str,
) -> Option<(&'static str, String)> {
    None
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
/// 【调度者裁决】本表与 [infer_cache_capability] 降级为"无 catalog 可用时的
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

/// 在 wire 消息序列上施加断点（A 子主题的注入执行面；纯后处理 pass，与
/// to_chat_messages 解耦——既有 0 深拷贝映射保持纯函数，断点逻辑独立可测）
///
/// 锚点规则（对齐 pi 三锚点 anthropic-messages.ts:991-1000/1256-1278/1320、
/// Kimi 三锚点 kimi-code-cache-analysis.md:109-117）：
/// - system：第一条 role=system 消息（user-prefix 模式下 system prompt 已被改写
///   为 user 角色，回退首条 user 消息），文本内容改写为 parts 数组形态
///   （string content 无法携带 cache_control，pi-cache-analysis.md:139）；
/// - messages：最后一条 role=user 或 role=tool 消息（工具循环内 tool_result
///   承载历史缓存；OpenAI 兼容线路上 tool 结果落在 role=tool 消息）；
///   端点支持消息级断点（supports_message_cache_control=true，Anthropic 原生
///   端点"顶层自动模式"）时挂消息级字段、不改写内容；部分兼容端点只认
///   content part 级（false）时挂最后一个文本块；
/// - 可缓存类型白名单：text 块（image/document/tool_result 等随 wire 扩展）；
/// - TTL 桶 → 块级断点值（[cache_control_for_ttl]）；
/// - plan 全 false → 零报告且请求字节与未施加时完全一致；
/// - 锚点不存在（无 system/user/tool 消息）或无可缓存文本块 → dropped 记账，
///   不报错（P5 归因消费，P5 §3.4.3）。
///
/// 【接线】载体字段 ChatContentPart::Text.cache_control / ChatMessage.cache_control
/// 由 T-14（messages.rs）交付；本函数为 T-15 build.rs post-pass 的调用面
/// （`apply_cache_controls(&mut wire, &plan, policy.ttl, supports_message_cache_control)`）。
pub fn apply_cache_controls(
    messages: &mut [ChatMessage],
    plan: &BreakpointPlan,
    ttl: TtlBucket,
    supports_message_cache_control: bool,
) -> BreakpointReport {
    let mut report = BreakpointReport::default();
    if !plan.has_any() {
        return report;
    }
    let cc = cache_control_for_ttl(ttl);

    // system 锚点：首条 role=system 消息；user-prefix 模式（无 system 角色）
    // 回退首条 user 消息。文本内容改写为 parts 形态挂断点。
    let system_index = if plan.system {
        messages
            .iter()
            .position(|m| m.role == "system")
            .or_else(|| messages.iter().position(|m| m.role == "user"))
    } else {
        None
    };
    match system_index {
        Some(index) => {
            if apply_part_level_cc(&mut messages[index], cc) {
                report.placed += 1;
            } else {
                report.dropped += 1;
            }
        }
        // 请求了 system 断点但锚点不存在 → 无法放置，dropped 记账
        None => {
            if plan.system {
                report.dropped += 1;
            }
        }
    }

    // messages 锚点：最后一条 role=user / role=tool 消息
    let messages_index = if plan.messages {
        messages.iter().rposition(|m| m.role == "user" || m.role == "tool")
    } else {
        None
    };
    match messages_index {
        Some(index) => {
            // system 回退锚点与 messages 锚点重合（单条 user 消息场景）→
            // 不重复放置（断点已由 system 锚点落在同一消息上）
            if Some(index) == system_index {
                return report;
            }
            let placed = if supports_message_cache_control {
                // 端点支持消息级断点：整条消息挂 cache_control（无内容改写，
                // Anthropic 原生端点顶层自动模式载体）
                if messages[index].cache_control.is_some() {
                    false
                } else {
                    messages[index].cache_control = Some(cc);
                    true
                }
            } else {
                apply_part_level_cc(&mut messages[index], cc)
            };
            if placed {
                report.placed += 1;
            } else {
                report.dropped += 1;
            }
        }
        // 请求了 messages 断点但锚点不存在 → 无法放置，dropped 记账
        None => {
            if plan.messages {
                report.dropped += 1;
            }
        }
    }
    report
}

/// part 级断点施加：Text 内容改写为 parts 形态挂断点；Parts 内容挂到最后一个
/// 文本块（白名单）；content=None / 无文本块 → 无法放置返回 false（计入 dropped）
fn apply_part_level_cc(message: &mut ChatMessage, cc: CacheControl) -> bool {
    match message.content.take() {
        Some(ChatContent::Text(text)) => {
            message.content = Some(text_to_parts_with_cc(&text, cc));
            true
        }
        Some(ChatContent::Parts(mut parts)) => {
            let cacheable = parts
                .iter_mut()
                .rev()
                .find_map(|part| match part {
                    ChatContentPart::Text { cache_control, .. } => Some(cache_control),
                    _ => None,
                });
            match cacheable {
                Some(part_cc) => {
                    *part_cc = Some(cc);
                    message.content = Some(ChatContent::Parts(parts));
                    true
                }
                // 纯图片等无文本块 → 白名单外，无法放置
                None => {
                    message.content = Some(ChatContent::Parts(parts));
                    false
                }
            }
        }
        None => false,
    }
}

/// TTL 桶 → 块级断点值（Anthropic 系 wire 值映射；T-15 工具级附加
/// to_cache_aware_tool 同款复用，避免双实现漂移）
pub fn cache_control_for_ttl(ttl: TtlBucket) -> CacheControl {
    match ttl {
        TtlBucket::FiveMinutes => CacheControl::Ephemeral,
        TtlBucket::OneHour => CacheControl::Ephemeral1h,
    }
}

/// 文本消息 → parts 数组形态（对齐 pi：string content 无法携带 cache_control，
/// pi-cache-analysis.md:139；kimi-code-cache-analysis.md:113-117）
///
/// 输出 `Parts([Text { text, cache_control: Some(cc) }])`——调用方（system/messages
/// 锚点施加、T-15 断点改写）把 string content 改写为可携带断点的形态；
/// wire 形状：`{"type":"text","text":..,"cache_control":{"type":"ephemeral"}[,"ttl":"1h"]}`。
pub fn text_to_parts_with_cc(text: &str, cc: CacheControl) -> ChatContent {
    ChatContent::Parts(vec![ChatContentPart::Text {
        text: text.to_string(),
        cache_control: Some(cc),
    }])
}

#[cfg(test)]
mod tests {
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
    fn affinity_header_defaults_off() {
        // P2 默认全关：任何能力与会话 ID 都不产生亲和头（P3 数据注入后翻转）
        assert_eq!(affinity_header(&ANTHROPIC_CACHE, "ses-123"), None);
        assert_eq!(affinity_header(&GROK_CACHE, "ses-123"), None);
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
}
