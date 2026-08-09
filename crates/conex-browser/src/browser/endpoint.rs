//! 会话 token 与端点类型（维度 10 §7）
//!
//! - `SessionToken`：会话级绑定标识（uuid v4），Debug 脱敏（§7.3 日志纪律）；
//! - `CdpEndpoint` 复用维度 11 已有类型（cdp/transport.rs，含脱敏 Debug），
//!   本模块仅重导出，不重复定义，避免端点类型双源。
//!
//! 锁纪律（31-security-baseline B8，评审 21-L2）：本模块无锁；日志面一律经脱敏
//! 展示，端口/WS path/token 不进任何 tracing 输出（10 文档 §7.3 硬要求）。

use std::fmt;

/// CDP 端点（端口 + WS path），维度 11 既有类型重导出。
/// Debug 实现已在 cdp/transport.rs 脱敏（输出 `<redacted>`）。
pub use crate::cdp::transport::CdpEndpoint;

/// 会话 token：uuid v4，即会话 profile 目录名（`sessions/<uuid>/`），
/// 用于「会话 ↔ 进程 ↔ profile」三方绑定校验（10 文档 §7.1）。
/// Debug/Display 均脱敏（§7.3 日志纪律硬要求）。
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct SessionToken(String);

impl fmt::Debug for SessionToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SessionToken(<redacted>)")
    }
}

impl SessionToken {
    /// 生成新会话 token（uuid v4）。
    pub fn new() -> Self {
        SessionToken(uuid::Uuid::new_v4().to_string())
    }

    /// 原始值（仅进程内传递；不进日志/事件/前端）。
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// 是否为合法 token 形态（防路径注入：必须为纯 uuid 形态）。
    pub fn is_well_formed(&self) -> bool {
        uuid::Uuid::parse_str(&self.0).is_ok()
    }
}

impl Default for SessionToken {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for SessionToken {
    /// 展示面同样脱敏（tracing 宏不得直接打印结构体，本实现兜底）。
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// token 生成 + 合法性自检。
    #[test]
    fn token_generation_and_well_formed() {
        let a = SessionToken::new();
        let b = SessionToken::new();
        assert_ne!(a, b, "token 必须唯一");
        assert!(a.is_well_formed());
        assert_eq!(a.as_str().len(), 36, "uuid v4 形态");
    }

    /// 路径注入防御：带路径分隔符/token 形态不符 → is_well_formed 拒绝。
    #[test]
    fn token_rejects_path_injection() {
        let evil = SessionToken("..\\..\\x".to_string());
        assert!(!evil.is_well_formed());
        let evil2 = SessionToken("C:/Windows".to_string());
        assert!(!evil2.is_well_formed());
        let evil3 = SessionToken("../../etc".to_string());
        assert!(!evil3.is_well_formed());
    }

    /// Debug/Display 均脱敏：不含 token 原文。
    #[test]
    fn token_debug_redacted() {
        let t = SessionToken::new();
        let debug = format!("{t:?}");
        let display = t.to_string();
        assert!(!debug.contains(t.as_str()), "Debug 不得含 token 原文：{debug}");
        assert!(debug.contains("<redacted>"));
        assert_eq!(display, "<redacted>");
    }

    /// CdpEndpoint 脱敏（复用维度 11 实现，回归断言）。
    #[test]
    fn endpoint_debug_redacted() {
        let e = CdpEndpoint {
            port: 38689,
            ws_path: "/devtools/browser/ba90110e-33a1-4569-9dd1-5437b8f729b0".to_string(),
        };
        let debug = format!("{e:?}");
        assert!(!debug.contains("38689"), "Debug 不得含端口：{debug}");
        assert!(!debug.contains("ba90110e"), "Debug 不得含 ws_path：{debug}");
        assert!(!debug.contains("/devtools/"), "Debug 不得含 path 片段：{debug}");
    }

    // ---------- 脱敏变体全表（评审 P2 补强：12 种端口/路径/token 形态零泄漏） ----------

    /// 6 种端口 × 6 种路径形态：Debug 输出必须恒定为固定红acted 形态，
    /// 端口数字、路径片段、路径内嵌端口样数字一律不得出现。
    #[test]
    fn endpoint_debug_redaction_variants() {
        let cases = [
            (1u16, "/devtools/browser/a"),
            (443, "/devtools/browser/ba90110e-33a1-4569-9dd1-5437b8f729b0"),
            (38689, "/devtools/browser/38689"),
            (65535, "/"),
            (8080, "/devtools/page/ABC123"),
            (10000, "/devtools/browser/token?secret=1"),
        ];
        for (port, path) in cases {
            let e = CdpEndpoint { port, ws_path: path.to_string() };
            let debug = format!("{e:?}");
            assert_eq!(debug, "CdpEndpoint { <redacted> }", "Debug 必须固定形态（port={port} path={path}）");
            assert!(!debug.contains(&port.to_string()), "端口 {port} 不得泄漏：{debug}");
            assert!(!debug.contains("devtools"), "ws_path 不得泄漏：{path}");
            assert!(!debug.contains("secret"), "路径参数不得泄漏：{path}");
            // url() 仅用于内部建连（不进日志面），功能面仍可用
            assert!(e.url().starts_with("ws://127.0.0.1:"), "url() 拼接不受脱敏影响");
            assert!(e.url().contains(&port.to_string()), "url() 内部必须携带端口（建连用）");
        }
    }

    /// 6 种 token 形态（含非法/注入/空串）：Debug 与 Display 恒为固定脱敏串，
    /// 原始值零泄漏（输出即常量，逐形态断言）。
    #[test]
    fn session_token_redaction_variants() {
        let shapes = [
            "ba90110e-33a1-4569-9dd1-5437b8f729b0",
            "38689",
            "secret-token-abc",
            "..\\..\\x",
            "中文-token-路径",
            "",
        ];
        for s in shapes {
            let t = SessionToken(s.to_string());
            assert_eq!(format!("{t:?}"), "SessionToken(<redacted>)", "token={s:?}");
            assert_eq!(t.to_string(), "<redacted>", "token={s:?}");
            if !s.is_empty() {
                assert!(!format!("{t:?}").contains(s), "Debug 不得含原文：{s:?}");
                assert!(!t.to_string().contains(s), "Display 不得含原文：{s:?}");
            }
        }
    }
}
