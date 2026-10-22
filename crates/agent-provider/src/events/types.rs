use serde::{Deserialize, Serialize};

/// stop 原因（02 §1.1：stop|tool-call|length|error）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StopReason {
    /// 正常结束（finish_reason=stop/null 等）
    Stop,
    /// 工具调用收尾（finish_reason=tool_calls/function_call，或流内有工具调用）
    ToolCall,
    /// 长度截断（finish_reason=length / max_tokens / status=incomplete）
    Length,
    /// 错误收尾（解析异常、服务端错误帧、空流保护等）
    Error,
}

/// 用量统计（对齐 shared:tool.ts:286-293 的 ProviderUsage）
///
/// 字段序列化为 camelCase（promptTokens/completionTokens/…）；wire 层的
/// `prompt_tokens??input_tokens` 归一（02 §2.5）由解析层负责，本类型不感知。
///
/// T3.4（G1-d）归一化口径裁决：`prompt_tokens` **保持 provider 原始上报值**
/// （不做 cached/write 减法改写），与 session-loop `stream.rs` 的 ProviderUsage
/// 语义一致；归一化 `input = prompt - cached_read - cache_write` 作为派生量
/// 在 usage 聚合层经 [ProviderUsage::cache_breakdown] 收敛（C9 口径真源）——
/// Included 轨（chat/responses）下 `CacheBreakdown.miss` 即归一 input；
/// Excluded 轨（anthropic/gemini）下 `miss = prompt`、`input_total = prompt + read + write`。
/// reasoning 已从 completion 侧独立解析（各轨 parser 填入 reasoning_tokens），
/// completion_tokens 保留总输出（含思考），归一不把 reasoning 从 completion 减去
/// （对齐 pi-ai parseChunkUsage：output 保留 completion 总量）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    /// promptTokens：提示词 token 数
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u64>,
    /// completionTokens：生成 token 数
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<u64>,
    /// totalTokens：总数
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    /// cacheReadTokens：缓存命中读取
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    /// cacheWriteTokens：缓存写入
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
    /// cacheMissTokens：缓存未命中输入（DeepSeek 顶层 prompt_cache_miss_tokens；
    /// 其余协议族由 [ProviderUsage::cache_breakdown] 按口径推导，此处可为 None）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_miss_tokens: Option<u64>,
    /// reasoningTokens：推理 token 数
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
}

/// 协议族口径标记（LiteLLM 双命名空间：prompt 是否已含缓存，P2 §3.3 D）
///
/// 恒等式（C9 口径唯一真源）：`input_total = miss + read + write`；
/// Included 系下 `input_total = prompt`，Excluded 系下 `input_total = prompt + read + write`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CacheAccounting {
    /// OpenAI 系（chat/responses）：prompt 已含缓存
    #[default]
    Included,
    /// Anthropic/Gemini 系：prompt 不含缓存
    Excluded,
}

/// 归一化派生结果（唯一口径入口，P5 测量/成本直接消费；C9）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheBreakdown {
    /// 缓存命中读取（cacheReadTokens）
    pub read: u64,
    /// 缓存写入（cacheWriteTokens）
    pub write: u64,
    /// 未缓存输入（= 计费输入；DeepSeek 顶层 miss 存在时优先）
    pub miss: u64,
    /// 归一化后的输入总量 = miss + read + write
    pub input_total: u64,
}

/// model 请求信息（`before-request` 载荷，M14：model.beforeRequest 事件源）
///
/// 请求前发射点装配（引擎侧接线位）：url/model/max_tokens 由请求构建
/// 完成后填充；`attempt` 为第几次尝试（重试循环内从 1 起）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRequestInfo {
    /// 请求 URL（endpoint）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// 生效模型名
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// 本次调用 max_tokens（None = 未限制）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    /// 第几次尝试（1 起；重试循环内每次尝试递增）
    pub attempt: u32,
}

/// model 响应信息（`after-response` 载荷，M14：model.afterResponse 事件源）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelResponseInfo {
    /// HTTP 状态码（流前响应可观测；无 HTTP 层信息为 None）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// 本次尝试是否成功（2xx / 无错误）
    pub ok: bool,
    /// 失败文案（ok=false 时携带）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 单次尝试耗时（毫秒）
    pub duration_ms: u64,
    /// 响应用量（流成功收口时携带）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<ProviderUsage>,
}

/// model 请求生命周期观测器（M14：before-request / after-response 发射点
/// 消费面；I8 生态轮接 HookRegistry 的 model.beforeRequest / model.afterResponse
/// 钩子——本 trait 只观测不改写，失败不阻塞请求路径）
pub trait ModelRequestObserver: Send + Sync {
    /// 请求前回调（每次尝试发起前）
    fn on_before_request(&self, info: &ModelRequestInfo);
    /// 响应后回调（每次尝试结束后；成功/失败均触发）
    fn on_after_response(&self, info: &ModelResponseInfo);
}

impl ProviderUsage {
    /// 按协议族口径归一化派生缓存拆分（P2 §3.3 D；C9 口径真源）
    ///
    /// - Included（OpenAI 系）：miss = prompt - read - write、input_total = prompt；
    /// - Excluded（Anthropic/Gemini 系）：miss = prompt、input_total = prompt + read + write；
    /// - read/write 为 None 时按 0 处理；推导结果为负时钳 0；
    /// - DeepSeek 顶层 `cache_miss_tokens` 存在时直接取服务端报告值，不依赖推导；
    /// - prompt 缺失时返回 None（无输入侧数据可派）。
    pub fn cache_breakdown(&self, accounting: CacheAccounting) -> Option<CacheBreakdown> {
        let read = self.cache_read_tokens.unwrap_or(0);
        let write = self.cache_write_tokens.unwrap_or(0);
        let prompt = self.prompt_tokens?;
        let miss = self.cache_miss_tokens.unwrap_or_else(|| match accounting {
            CacheAccounting::Included => prompt.saturating_sub(read.saturating_add(write)),
            CacheAccounting::Excluded => prompt,
        });
        let input_total = match accounting {
            CacheAccounting::Included => prompt,
            CacheAccounting::Excluded => prompt.saturating_add(read).saturating_add(write),
        };
        Some(CacheBreakdown {
            read,
            write,
            miss,
            input_total,
        })
    }
}

/// 取两分片字段的较大值（next 存在且大于 prev 时取 next；防 0/部分值覆盖）
fn max_or(prev: Option<u64>, next: Option<u64>) -> Option<u64> {
    match (prev, next) {
        (Some(p), Some(n)) => Some(p.max(n)),
        (Some(p), None) => Some(p),
        (None, n) => n,
    }
}

/// 分片流式合并的 max 语义（P2 §3.3 D；02 §六.6 的延续裁决）
///
/// - 输入侧三字段（prompt/cacheRead/cacheWrite/cacheMiss）在分片间取 max，
///   防代理用 0/部分值覆盖 message_start 的完整 input（pi anthropic-messages.ts 同类防御）；
/// - completion/reasoning 侧维持"后到优先"（next 存在时取 next）；
/// - total 恒由最终合并结果重算（prompt/completion 任一存在时），否则回退显式 total
///   （next 优先，其次 prev）。
pub fn merge_usage_shards(prev: &ProviderUsage, next: &ProviderUsage) -> ProviderUsage {
    let prompt_tokens = max_or(prev.prompt_tokens, next.prompt_tokens);
    let cache_read_tokens = max_or(prev.cache_read_tokens, next.cache_read_tokens);
    let cache_write_tokens = max_or(prev.cache_write_tokens, next.cache_write_tokens);
    let cache_miss_tokens = max_or(prev.cache_miss_tokens, next.cache_miss_tokens);
    let completion_tokens = next.completion_tokens.or(prev.completion_tokens);
    let reasoning_tokens = next.reasoning_tokens.or(prev.reasoning_tokens);
    let total_tokens = if prompt_tokens.is_some() || completion_tokens.is_some() {
        Some(prompt_tokens.unwrap_or(0) + completion_tokens.unwrap_or(0))
    } else {
        next.total_tokens.or(prev.total_tokens)
    };
    ProviderUsage {
        prompt_tokens,
        completion_tokens,
        total_tokens,
        cache_read_tokens,
        cache_write_tokens,
        cache_miss_tokens,
        reasoning_tokens,
    }
}
