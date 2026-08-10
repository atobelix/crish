//! 流式帧类型（stream.*；M6 §7 / §10.7）
//!
//! 大载荷分块流模型：`stream.open → stream.chunk* → stream.close`；块 ≤ 64
//! KiB（STREAM_CHUNK_MAX）；断线按字节 offset 续传（`stream.resume`），块级
//! 幂等（seq 去重，重复块直接丢弃）。
//!
//! - 方向：`from/to` 区分下行（D→M）与上行（M→D）——上行大载荷（prompt
//!   超限分块提交）与下行流共用同一组 kind（M6 §7.4）；
//! - 结束标志分层：`stream.close` 是流级收口，chunk 的 `final` 是块级终帧
//!   标记；
//! - 续传游标双锚：`nextOffset`（字节）/ `seq`（块号）；服务端流上下文保留
//!   STREAM_TTL_MS（5min），超时清理 → close 带 stream.cursor_stale。

use serde::{Deserialize, Serialize};

use crate::device::error::ErrorBody;

/// 流载荷类别（wire snake_case；M6 §10.7）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamKind {
    /// 事件历史回放
    EventReplay,
    /// 文件内容
    File,
    /// 任务输出
    TaskOutput,
    /// 上行 prompt（remote.runTask.prompt 超限分块提交）
    Prompt,
}

/// 流开启（stream.open；服务端发起下行流；上行场景由桌面先登记后开流）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamOpen {
    /// 流 id（发送方唯一）
    pub stream_id: String,
    /// 载荷类别
    pub kind: StreamKind,
    /// 总字节数（已知则填，未知省略）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    /// 元数据（sessionId / path / mime / encoding 等）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
}

/// 流数据块（stream.chunk；≤ 65536 字符/块）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamChunk {
    /// 流 id
    pub stream_id: String,
    /// 块序号（从 1 起；块级幂等去重键）
    pub seq: u64,
    /// UTF-8 文本块（或 base64，meta.encoding=b64）
    pub data: String,
    /// 块级终帧标记（非流级收口；流级收口走 stream.close）
    #[serde(default, skip_serializing_if = "crate::device::skip_false", rename = "final")]
    pub is_final: bool,
    /// 字节偏移锚点（续传用；final 时省略）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<u64>,
}

/// 断线续传（stream.resume，双向可用；按字节 offset 重发，服务端按块边界对齐）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamResume {
    /// 流 id
    pub stream_id: String,
    /// 已收到字节偏移（断线重连后取最近一次 chunk 的 nextOffset）
    pub offset: u64,
}

/// 流结束（stream.close；流级收口：ok / error / 交付统计）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamClose {
    /// 流 id
    pub stream_id: String,
    /// 是否正常收口
    pub ok: bool,
    /// ok=false 时的错误载荷（如 stream.cursor_stale）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
    /// 已交付总字节数
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_delivered: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::error::DeviceErrorCode;

    #[test]
    fn stream_open_roundtrip_snake_kind() {
        let open = StreamOpen {
            stream_id: "st-01HZ".into(),
            kind: StreamKind::EventReplay,
            total_bytes: Some(102_400),
            meta: Some(serde_json::json!({ "sessionId": "s-abc", "path": "src/a.ts" })),
        };
        let json = serde_json::to_value(&open).unwrap();
        assert_eq!(json["streamId"], "st-01HZ");
        assert_eq!(json["kind"], "event_replay");
        assert_eq!(json["totalBytes"], 102_400);
        assert_eq!(json["meta"]["sessionId"], "s-abc");
        let back: StreamOpen = serde_json::from_str(&serde_json::to_string(&open).unwrap()).unwrap();
        assert_eq!(open, back);

        // 全部流类别 wire 值
        assert_eq!(serde_json::to_string(&StreamKind::File).unwrap(), "\"file\"");
        assert_eq!(serde_json::to_string(&StreamKind::TaskOutput).unwrap(), "\"task_output\"");
        assert_eq!(serde_json::to_string(&StreamKind::Prompt).unwrap(), "\"prompt\"");
    }

    #[test]
    fn stream_chunk_roundtrip_final_rename() {
        let chunk = StreamChunk {
            stream_id: "st-01HZ".into(),
            seq: 1,
            data: "hello".into(),
            is_final: true,
            next_offset: None,
        };
        let json = serde_json::to_value(&chunk).unwrap();
        assert_eq!(json["streamId"], "st-01HZ");
        assert_eq!(json["seq"], 1);
        assert_eq!(json["data"], "hello");
        // Rust 关键字 final 经 rename 为 `final`，且 final=true 不省略
        assert_eq!(json["final"], true);
        assert!(json.get("nextOffset").is_none());
        let back: StreamChunk = serde_json::from_str(&serde_json::to_string(&chunk).unwrap()).unwrap();
        assert_eq!(chunk, back);

        // final=false 省略；nextOffset 携带续传锚点
        let chunk2 = StreamChunk {
            stream_id: "st-01HZ".into(),
            seq: 2,
            data: "world".into(),
            is_final: false,
            next_offset: Some(65_536),
        };
        let json2 = serde_json::to_value(&chunk2).unwrap();
        assert!(json2.get("final").is_none());
        assert_eq!(json2["nextOffset"], 65_536);
    }

    #[test]
    fn stream_resume_roundtrip() {
        let resume = StreamResume { stream_id: "st-01HZ".into(), offset: 65_536 };
        let json = serde_json::to_value(&resume).unwrap();
        assert_eq!(json["streamId"], "st-01HZ");
        assert_eq!(json["offset"], 65_536);
        let back: StreamResume = serde_json::from_str(&serde_json::to_string(&resume).unwrap()).unwrap();
        assert_eq!(resume, back);
    }

    #[test]
    fn stream_close_roundtrip_with_error() {
        let ok_close = StreamClose {
            stream_id: "st-01HZ".into(),
            ok: true,
            error: None,
            total_delivered: Some(102_400),
        };
        let json = serde_json::to_value(&ok_close).unwrap();
        assert_eq!(json["ok"], true);
        assert_eq!(json["totalDelivered"], 102_400);
        assert!(json.get("error").is_none());
        let back: StreamClose =
            serde_json::from_str(&serde_json::to_string(&ok_close).unwrap()).unwrap();
        assert_eq!(ok_close, back);

        // 错误收口：ok=false + ErrorBody 嵌套
        let err_close = StreamClose {
            stream_id: "st-01HZ".into(),
            ok: false,
            error: Some(ErrorBody::new(
                DeviceErrorCode::StreamCursorStale,
                "流上下文已超时清理",
            )),
            total_delivered: None,
        };
        let json = serde_json::to_value(&err_close).unwrap();
        assert_eq!(json["ok"], false);
        assert_eq!(json["error"]["code"], "stream.cursor_stale");
        assert_eq!(json["error"]["retryable"], false);
        let back: StreamClose =
            serde_json::from_str(&serde_json::to_string(&err_close).unwrap()).unwrap();
        assert_eq!(err_close, back);
    }
}
