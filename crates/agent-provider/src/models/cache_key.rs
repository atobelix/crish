//! 缓存键推导与会话亲和 header 数据（P3 §3.3 C / 任务 T-20）
//!
//! - [derive_prompt_cache_key]：prompt_cache_key 统一推导。**等价委托**
//!   [CacheKey::from_session_id]（A2 审计 C4：实现保留在 P2 请求构造面真源
//!   `request/cache.rs`，本函数只委托，禁止两套实现漂移）。
//! - [session_affinity_headers]：会话亲和 header 注入表（P3 §3.3.2 数据表）：
//!   `x-grok-conv-id`（Grok Chat 轨粘性路由，值 = 键推导结果）/
//!   `x-dashscope-session-cache`（百炼 Responses Session 缓存，固定值 enable）/
//!   `x-session-affinity`、`x-session-id`（OpenAI 系通用兼容，默认关闭，矩阵
//!   未开时不注入）。注入位置由 P2 提供（engine.rs 基础头 + 亲和头合并），
//!   本模块只交付数据与开关。
//!
//! 纯数据结构/纯函数（无 HTTP、无 IO），单测驱动。

use super::behavior::CacheBehavior;
use crate::request::cache::CacheKey;

/// prompt_cache_key 统一推导（P3 §3.3.1）
///
/// **等价委托** [CacheKey::from_session_id]：trim → 按 Unicode 码点钳 64 →
/// 空/全空白返回 None（A2 审计 C4：实现保留在 P2 请求构造面真源
/// `request/cache.rs`，本函数只委托，禁止两套实现漂移）。返回的 String 即
/// [CacheKey] 的内部载体（`key.0`）。
pub fn derive_prompt_cache_key(session_id: &str) -> Option<String> {
    CacheKey::from_session_id(session_id).map(|key| key.0)
}

/// 会话亲和 header 注入表（P3 §3.3.2 数据表；纯函数，空 Vec = 不注入）
///
/// 数据表：
/// - Grok Chat 轨：`x-grok-conv-id` = [derive_prompt_cache_key] 值
///   （session_id 前 64 码点，粘性路由，vendor-cache-mechanisms.md:121）；
/// - 百炼 Responses：`x-dashscope-session-cache: enable`（固定值，
///   vendor-cache-gaps.md:71-76）；
/// - OpenAI 系 `x-session-affinity` / `x-session-id`：默认关闭（可配置开关，
///   pi 默认 false，pi-cache-analysis.md:141-143），矩阵未开时不注入。
///
/// 注入条件：`supports_conv_header == true` 且配置了头名（Grok / Dashscope），
/// 且会话 ID 非空/非全空白；其余（DeepSeek 矩阵键省略、OpenAI 系默认关、
/// 未知厂商 Auto）一律不注入。
pub fn session_affinity_headers(
    behavior: &CacheBehavior,
    session_id: &str,
) -> Vec<(String, String)> {
    // 空/全空白会话 ID → 不注入（数据表统一前提）
    if session_id.trim().is_empty() {
        return Vec::new();
    }
    // 矩阵开关：supports_conv_header=false 或未配置头名（DeepSeek 键省略 /
    // OpenAI 系 x-session-affinity、x-session-id 默认关 / 未知厂商 Auto）→ 不注入
    let name = match (behavior.supports_conv_header, behavior.conv_header_name) {
        (true, Some(name)) => name,
        _ => return Vec::new(),
    };
    match name {
        // xAI Chat 轨粘性路由：值 = 键推导结果（session_id 前 64 码点）
        "x-grok-conv-id" => match derive_prompt_cache_key(session_id) {
            Some(value) => vec![(name.to_string(), value)],
            // 防御分支：键推导返回 None（与上方空检查同源，理论不可达）→ 不注入
            None => Vec::new(),
        },
        // 百炼 Responses Session 缓存：固定值 enable
        "x-dashscope-session-cache" => vec![(name.to_string(), "enable".to_string())],
        // 未收录的头名（未来矩阵扩展新增）→ 保守不注入
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::super::behavior::{cache_behavior_for, VendorId};
    use super::*;

    // ── derive_prompt_cache_key：等价委托（C4）──

    #[test]
    fn derive_prompt_cache_key_matches_truth_source_exactly() {
        // C4 等价委托钉死：与请求构造面真源逐字节一致（防双实现漂移）
        let samples: &[&str] = &["ses-abc", "  trimmed  ", "中文会话🙂", &"x".repeat(100)];
        for sample in samples {
            assert_eq!(
                derive_prompt_cache_key(sample),
                CacheKey::from_session_id(sample).map(|key| key.0)
            );
        }
    }

    #[test]
    fn derive_prompt_cache_key_empty_and_blank_returns_none() {
        // 空输入 → None（调用方用显式不参与缓存语义表达，P3 §3.3.1）
        assert_eq!(derive_prompt_cache_key(""), None);
        assert_eq!(derive_prompt_cache_key("   "), None);
        assert_eq!(derive_prompt_cache_key("\t\n "), None);
    }

    #[test]
    fn derive_prompt_cache_key_clamps_codepoints_without_panic() {
        // 验收 4：64+ 字符 sessionId 输出恰好 64 码点；中文/emoji 不 panic、
        // 不破坏 UTF-8（委托链按码点钳，R3 禁止拆代理对）
        let long = "s".repeat(80);
        let key = derive_prompt_cache_key(&long).expect("非空应派生键");
        assert_eq!(key.chars().count(), 64);
        // 中文边界：第 65 个字符为多字节码点，不得字节截断拆半字符
        let chinese = format!("{}汉", "a".repeat(63));
        let key = derive_prompt_cache_key(&chinese).expect("非空应派生键");
        assert_eq!(key.chars().count(), 64);
        assert!(key.ends_with('汉'));
        // emoji 边界：尾部 4 字节码点不被拆散（代理对完整保留）
        let emoji = format!("{}😀", "a".repeat(63));
        let key = derive_prompt_cache_key(&emoji).expect("非空应派生键");
        assert_eq!(key.chars().count(), 64);
        assert!(key.ends_with('😀'));
    }

    // ── session_affinity_headers：Grok Chat 轨 ──

    #[test]
    fn grok_chat_track_injects_conv_header_with_codepoint_64_value() {
        // 验收 2：Chat 轨返回 x-grok-conv-id，值 = session_id 前 64 码点
        let behavior = cache_behavior_for(None, VendorId::Grok, "grok-4.5");
        assert_eq!(behavior.conv_header_name, Some("x-grok-conv-id"));
        assert_eq!(
            session_affinity_headers(&behavior, "ses-123"),
            vec![("x-grok-conv-id".to_string(), "ses-123".to_string())]
        );
        // 长会话 ID：header 值恰好为前 64 码点（含多字节尾字符）
        let long = format!("{}尾", "g".repeat(63));
        let headers = session_affinity_headers(&behavior, &long);
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0].0, "x-grok-conv-id");
        assert_eq!(headers[0].1.chars().count(), 64);
        assert!(headers[0].1.ends_with('尾'));
    }

    #[test]
    fn grok_chat_track_empty_session_id_injects_nothing() {
        // 空/全空白会话 ID → 不注入（数据表统一前提）
        let behavior = cache_behavior_for(None, VendorId::Grok, "grok-4.5");
        assert!(session_affinity_headers(&behavior, "").is_empty());
        assert!(session_affinity_headers(&behavior, "   ").is_empty());
    }

    // ── session_affinity_headers：百炼 Dashscope ──

    #[test]
    fn dashscope_injects_session_cache_enable_header() {
        // 验收 2：Responses 轨返回 x-dashscope-session-cache: enable
        let behavior = cache_behavior_for(None, VendorId::Dashscope, "qwen3-max");
        assert_eq!(behavior.conv_header_name, Some("x-dashscope-session-cache"));
        assert_eq!(
            session_affinity_headers(&behavior, "ses-1"),
            vec![(
                "x-dashscope-session-cache".to_string(),
                "enable".to_string()
            )]
        );
        // 空会话 ID → 不注入
        assert!(session_affinity_headers(&behavior, "").is_empty());
    }

    // ── session_affinity_headers：矩阵联动省略 ──

    #[test]
    fn deepseek_matrix_omission_injects_nothing() {
        // DeepSeek 矩阵：supports_prompt_cache_key=false 且 supports_conv_header=
        // false（键省略联动，vendor-cache-gaps.md:104）→ 不注入
        let behavior = cache_behavior_for(None, VendorId::Deepseek, "deepseek-v4-flash");
        assert!(!behavior.supports_prompt_cache_key);
        assert!(!behavior.supports_conv_header);
        assert!(session_affinity_headers(&behavior, "ses-1").is_empty());
    }

    #[test]
    fn openai_affinity_headers_default_off() {
        // OpenAI 系 x-session-affinity / x-session-id 默认关闭（pi 默认 false，
        // 矩阵未开）→ 不注入
        let behavior = cache_behavior_for(None, VendorId::Openai, "gpt-5.6");
        assert!(!behavior.supports_conv_header);
        assert!(session_affinity_headers(&behavior, "ses-1").is_empty());
    }

    #[test]
    fn unknown_vendor_injects_nothing() {
        // 未知网关 → Auto 保守全关（jcode"否则视为不支持"）→ 空 Vec
        let behavior = cache_behavior_for(None, VendorId::Auto, "unknown-model");
        assert!(session_affinity_headers(&behavior, "ses-1").is_empty());
    }
}
