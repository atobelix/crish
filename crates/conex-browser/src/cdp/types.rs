//! JSON-RPC 信封与容错解析（维度 11 §3.1）
//!
//! - `CdpCommand`：出站命令信封（id/method/params/sessionId，双层路由字段）
//! - `CdpMessage`：入站消息信封（响应与事件共用；宽容解析铁律：全字段 Option）
//! - `CdpError`：线格式错误结构（与 `crate::cdp::error::CdpError` 引擎错误区分）
//! - `CdpEvent`：事件载体（method/params/sessionId，供分类 router 转译）
//!
//! 宽容解析铁律（评审乙 §3.1/风险 4）：
//! - 信封字段全部 Option，未知字段 serde 默认忽略；
//! - 类型容错：`string_or_int` / `opt_vec_string_or_int` 自定义 deserializer
//!   （Lightpanda 与 Chrome 类型不一致的既有先例）。

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

/// 容错解析：值可能是字符串或整数时统一转字符串。
/// Lightpanda 发送数字 nodeId/childId，Chrome 发送字符串，两者都要接受。
pub fn string_or_int<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let v = Value::deserialize(deserializer)?;
    match v {
        Value::String(s) => Ok(s),
        Value::Number(n) => Ok(n.to_string()),
        other => Err(serde::de::Error::custom(format!(
            "期望字符串或整数，实际为 {}",
            other
        ))),
    }
}

/// 容错解析：可选字符串数组，每个元素可能是字符串或整数。
pub fn opt_vec_string_or_int<'de, D>(deserializer: D) -> Result<Option<Vec<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    let opt: Option<Vec<Value>> = Option::deserialize(deserializer)?;
    match opt {
        None => Ok(None),
        Some(vec) => {
            let mut result = Vec::with_capacity(vec.len());
            for v in vec {
                match v {
                    Value::String(s) => result.push(s),
                    Value::Number(n) => result.push(n.to_string()),
                    other => {
                        return Err(serde::de::Error::custom(format!(
                            "数组中期望字符串或整数，实际为 {}",
                            other
                        )))
                    }
                }
            }
            Ok(Some(result))
        }
    }
}

/// 出站命令信封（agent-browser types.rs:53-62 同款）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CdpCommand {
    pub id: u64,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
    /// 双层路由：Some(session) → 目标会话，None → browser 级
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// 入站消息信封：响应与事件共用（agent-browser types.rs:65-73 同款）。
/// - 有 id = 命令响应；有 method = 事件；二者必居其一
/// - 全字段 Option：协议版本漂移时宽容解析不报错
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CdpMessage {
    pub id: Option<u64>,
    pub result: Option<Value>,
    pub error: Option<WireCdpError>,
    pub method: Option<String>,
    pub params: Option<Value>,
    pub session_id: Option<String>,
}

/// 线格式错误结构（CDP 错误码 + 消息）。
/// 与 `crate::cdp::error::CdpError`（引擎错误枚举）区分：本结构是 JSON 面上的原始形态。
#[derive(Debug, Clone, Deserialize)]
pub struct WireCdpError {
    pub code: Option<i64>,
    pub message: String,
    pub data: Option<String>,
}

impl std::fmt::Display for WireCdpError {
    /// 响应错误文本不嵌入敏感参数（agent-browser commands.rs:190 先例）。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

/// 事件载体（分发到事件总线的原始面，由 bus::classify 转译为强类型事件）。
#[derive(Debug, Clone)]
pub struct CdpEvent {
    pub method: String,
    pub params: Value,
    pub session_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdp::error::CdpError;

    fn wire_error(code: i64, message: &str) -> WireCdpError {
        WireCdpError {
            code: Some(code),
            message: message.to_string(),
            data: None,
        }
    }

    /// 验收 9.1-1：命令序列化/响应反序列化双向一致（含 sessionId 省略规则）
    #[test]
    fn types_envelope_roundtrip() {
        // 命令：browser 级（无 sessionId 字段）
        let cmd = CdpCommand {
            id: 7,
            method: "Browser.getVersion".to_string(),
            params: None,
            session_id: None,
        };
        let json = serde_json::to_string(&cmd).expect("命令序列化失败");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("JSON 解析失败");
        assert_eq!(parsed["id"], 7);
        assert_eq!(parsed["method"], "Browser.getVersion");
        // 省略规则：无 params/sessionId 时字段不出现
        assert!(parsed.get("params").is_none());
        assert!(parsed.get("sessionId").is_none());

        // 命令：会话级（camelCase 字段名）
        let cmd = CdpCommand {
            id: 8,
            method: "Page.navigate".to_string(),
            params: Some(serde_json::json!({ "url": "https://example.com" })),
            session_id: Some("S1".to_string()),
        };
        let json = serde_json::to_string(&cmd).expect("命令序列化失败");
        assert!(json.contains("\"sessionId\":\"S1\""));
        assert!(json.contains("\"method\":\"Page.navigate\""));

        // 响应反序列化：带 result
        let resp = r#"{"id":8,"result":{"frameId":"F1"},"sessionId":"S1"}"#;
        let msg: CdpMessage = serde_json::from_str(resp).expect("响应反序列化失败");
        assert_eq!(msg.id, Some(8));
        assert_eq!(msg.result.as_ref().unwrap()["frameId"], "F1");
        assert_eq!(msg.session_id.as_deref(), Some("S1"));
        assert!(msg.error.is_none());
        assert!(msg.method.is_none());

        // 事件反序列化：带 method/params
        let evt = r#"{"method":"Page.frameNavigated","params":{"frame":{"id":"F1","url":"https://e.com"}},"sessionId":"S1"}"#;
        let msg: CdpMessage = serde_json::from_str(evt).expect("事件反序列化失败");
        assert!(msg.id.is_none());
        assert_eq!(msg.method.as_deref(), Some("Page.frameNavigated"));
        assert_eq!(msg.session_id.as_deref(), Some("S1"));
    }

    /// 验收 9.1-2：未知字段/类型漂移 → 宽容解析不报错
    #[test]
    fn types_tolerant_parse_unknown_fields() {
        // 未知字段 + id 缺省 + 未识别嵌套结构：必须不报错
        let resp = r#"{"id":1,"result":{"newField":{"a":[1,2,3]},"future":null},"futureTop":true}"#;
        let msg: CdpMessage = serde_json::from_str(resp).expect("未知字段不应导致解析失败");
        assert_eq!(msg.id, Some(1));
        assert!(msg.result.is_some());

        // 错误对象缺 code/data：仍可解析
        let err = r#"{"id":2,"error":{"message":"only message"}}"#;
        let msg: CdpMessage = serde_json::from_str(err).expect("缺省字段不应导致解析失败");
        let e = msg.error.expect("错误字段缺失");
        assert!(e.code.is_none());
        assert_eq!(e.message, "only message");

        // string_or_int 容错：数字 nodeId 也能解析为字符串
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct AxNode {
            #[serde(deserialize_with = "string_or_int")]
            node_id: String,
        }
        let n: AxNode = serde_json::from_str(r#"{"nodeId": 42}"#).expect("数字 nodeId 容错失败");
        assert_eq!(n.node_id, "42");
        let n: AxNode =
            serde_json::from_str(r#"{"nodeId": "42"}"#).expect("字符串 nodeId 解析失败");
        assert_eq!(n.node_id, "42");

        // opt_vec_string_or_int 容错
        #[derive(Deserialize)]
        struct Node {
            #[serde(
                default,
                rename = "childIds",
                deserialize_with = "opt_vec_string_or_int"
            )]
            child_ids: Option<Vec<String>>,
        }
        let n: Node = serde_json::from_str(r#"{"childIds":[1,"2",3]}"#).expect("混合数组容错失败");
        assert_eq!(n.child_ids.unwrap(), vec!["1", "2", "3"]);
        let n: Node = serde_json::from_str(r#"{}"#).expect("缺省字段容错失败");
        assert!(n.child_ids.is_none());
    }

    /// 验收 9.1-3：-32601 → DomainUnavailable；-32000 + Context gone → ContextGone
    #[test]
    fn types_error_map_domain_not_implemented() {
        let e = CdpError::from_wire(
            "DOMSnapshot.captureSnapshot",
            &wire_error(-32601, "Method not found"),
        );
        assert!(matches!(
            e,
            CdpError::DomainUnavailable { ref method } if method == "DOMSnapshot.captureSnapshot"
        ));

        let e = CdpError::from_wire("Page.navigate", &wire_error(-32000, "Target closed"));
        assert!(matches!(e, CdpError::ContextGone { .. }));

        let e = CdpError::from_wire(
            "Runtime.evaluate",
            &wire_error(-32000, "Cannot find context with specified id"),
        );
        assert!(matches!(e, CdpError::ContextGone { .. }));

        // 其他 -32000 保持 Server
        let e = CdpError::from_wire(
            "Page.navigate",
            &wire_error(-32000, "Session with given id not found."),
        );
        assert!(matches!(e, CdpError::Server { code: -32000, .. }));

        // 各错误码归类
        assert!(matches!(
            CdpError::from_wire("X", &wire_error(-32700, "parse error")),
            CdpError::Protocol { .. }
        ));
        assert!(matches!(
            CdpError::from_wire("X", &wire_error(-32600, "invalid request")),
            CdpError::Protocol { .. }
        ));
        assert!(matches!(
            CdpError::from_wire("X", &wire_error(-32602, "invalid params")),
            CdpError::BadParams { .. }
        ));
        assert!(matches!(
            CdpError::from_wire("X", &wire_error(-32603, "internal error")),
            CdpError::Internal { .. }
        ));
    }
}
