//! S1 流式工具输出协议（TOOLS-01 §3.1）
//!
//! 一次工具调用产生 `[Progress*, Terminal]` 流：任意多 Progress、恰好一个
//! Terminal 且恒为末项（对齐 grok xai-tool-runtime/src/tool.rs 的流形状，
//! 值类型为 serde_json::Value）。本模块只承载流形状、开放式进度载荷与
//! 构造助手；工具的流式实现（如 shell_command 逐行推送）由各工具在
//! `execute_stream` 中构造，旧工具零改动走默认实现（见 [crate::definition::Tool]）。
//!
//! 阶段 1 范围：Text 全量实现；Custom 供工具自定义进度使用；Content 仅
//! 定义类型不实现生产/消费（预留图片/资源等富内容块）。

use crate::definition::ToolError;
use futures_util::{Future, Stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::pin::Pin;

/// 一次工具调用产生的流：任意多 Progress，恰好一个 Terminal 且恒为末项
pub type ToolStream = Pin<Box<dyn Stream<Item = ToolStreamItem> + Send>>;

/// 流中一项
#[derive(Debug)]
pub enum ToolStreamItem {
    /// 中间进度（零或多个）
    Progress(ToolProgress),
    /// 终值（恰好一个，恒为末项）
    Terminal(Result<serde_json::Value, ToolError>),
}

impl ToolStreamItem {
    /// 是否为终值项（流消费方见到 Terminal 后可短路收口）
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Terminal(_))
    }
}

/// 开放式进度载荷（对齐 grok ToolProgress；序列化 tag="kind" snake_case）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToolProgress {
    /// 自由文本增量（stdout 块、日志行）
    Text { text: String },
    /// 富内容块（预留：图片/资源，阶段 1 只定义类型不实现消费）
    Content { blocks: Vec<ContentBlock> },
    /// 工具自定义进度（subkind 为工具自有稳定判别符；外层 kind 恒为 custom）
    Custom {
        subkind: String,
        payload: serde_json::Value,
    },
}

/// 富内容块（阶段 1 仅类型占位，不实现生产/消费）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ContentBlock {
    /// 块类型判别符（如 image / resource，阶段 1 仅定义）
    pub kind: String,
    /// 块载荷（形状由 kind 决定，阶段 1 不实现）
    pub data: serde_json::Value,
}

/// 单元素流（默认实现的构造助手）：只含终值，零 Progress
///
/// 旧工具经默认 `execute_stream` 包 execute 结果时使用；流只含一项
/// Terminal，恒为末项且满足「任意多 Progress」的零特例。
pub fn terminal_only(result: Result<serde_json::Value, ToolError>) -> ToolStream {
    Box::pin(futures_util::stream::once(async move {
        ToolStreamItem::Terminal(result)
    }))
}

/// 进度流 + 终值：progress 全部推送完后接终值，Terminal 恒为末项
///
/// progress 为工具推送的中间进度序列；terminal 为产出终值的异步任务，
/// 在 progress 耗尽后才被轮询，保证终值恒为流末项。
pub fn with_progress<P, F>(progress: P, terminal: F) -> ToolStream
where
    P: Stream<Item = ToolProgress> + Send + 'static,
    F: Future<Output = Result<serde_json::Value, ToolError>> + Send + 'static,
{
    let progress = progress.map(ToolStreamItem::Progress);
    let terminal = futures_util::stream::once(async move {
        ToolStreamItem::Terminal(terminal.await)
    });
    Box::pin(progress.chain(terminal))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn terminal_only_yields_single_terminal_item() {
        // 单元素流：零 Progress、一项 Terminal(Ok)，且恒为末项
        let mut stream = terminal_only(Ok(json!({ "ok": true })));
        let item = stream.next().await.unwrap();
        assert!(item.is_terminal());
        match item {
            ToolStreamItem::Terminal(Ok(v)) => assert_eq!(v, json!({ "ok": true })),
            _ => panic!("默认实现流应只含 Terminal(Ok)"),
        }
        assert!(stream.next().await.is_none(), "流在 Terminal 后不得再有项");
    }

    #[tokio::test]
    async fn terminal_only_propagates_error() {
        // 终值为 Err 时原样透传（默认实现包 execute 失败路径）
        let err = ToolError::execution_failed("t", "模拟失败");
        let mut stream = terminal_only(Err(err.clone()));
        match stream.next().await.unwrap() {
            ToolStreamItem::Terminal(Err(e)) => assert_eq!(e, err),
            _ => panic!("应为 Terminal(Err)"),
        }
    }

    #[tokio::test]
    async fn with_progress_emits_progress_then_terminal_last() {
        // 流形状：Progress 序列在前，Terminal 恒为末项
        let progress = futures_util::stream::iter(vec![
            ToolProgress::Text { text: "第一块".to_string() },
            ToolProgress::Text { text: "第二块".to_string() },
        ]);
        let terminal = async { Ok(json!({ "final": true })) };
        let mut stream = with_progress(progress, terminal);

        let p1 = stream.next().await.unwrap();
        assert!(matches!(
            p1,
            ToolStreamItem::Progress(ToolProgress::Text { ref text }) if text == "第一块"
        ));
        let p2 = stream.next().await.unwrap();
        assert!(matches!(
            p2,
            ToolStreamItem::Progress(ToolProgress::Text { ref text }) if text == "第二块"
        ));
        let t = stream.next().await.unwrap();
        assert!(t.is_terminal(), "Terminal 恒为末项");
        assert!(stream.next().await.is_none(), "流在 Terminal 后不得再有项");
    }

    #[tokio::test]
    async fn with_progress_zero_progress_still_terminal() {
        // 零 Progress 的退化形状：仍恰好一个 Terminal 恒为末项
        let mut stream = with_progress(
            futures_util::stream::empty::<ToolProgress>(),
            async { Ok(json!({ "final": true })) },
        );
        let t = stream.next().await.unwrap();
        assert!(t.is_terminal());
        assert!(stream.next().await.is_none());
    }

    #[tokio::test]
    async fn with_progress_terminal_error_propagates() {
        // 终值任务返回 Err 时透传，仍为末项
        let err = ToolError::execution_failed("t", "模拟失败");
        let err_task = err.clone();
        let mut stream = with_progress(
            futures_util::stream::empty::<ToolProgress>(),
            async move { Err(err_task) },
        );
        match stream.next().await.unwrap() {
            ToolStreamItem::Terminal(Err(e)) => assert_eq!(e, err),
            _ => panic!("应为 Terminal(Err)"),
        }
    }

    #[test]
    fn tool_progress_serde_kind_tag() {
        // 序列化 tag="kind" snake_case（对齐 grok 语义，供出站事件映射）
        let text = ToolProgress::Text { text: "hi".to_string() };
        let v = serde_json::to_value(&text).unwrap();
        assert_eq!(v["kind"], "text");
        assert_eq!(v["text"], "hi");

        let custom = ToolProgress::Custom {
            subkind: "phase".to_string(),
            payload: json!({ "step": 1 }),
        };
        let v = serde_json::to_value(&custom).unwrap();
        assert_eq!(v["kind"], "custom");
        assert_eq!(v["subkind"], "phase");
        assert_eq!(v["payload"]["step"], 1);
        // 反序列化 roundtrip
        let back: ToolProgress = serde_json::from_value(v).unwrap();
        assert_eq!(back, custom);

        let content = ToolProgress::Content {
            blocks: vec![ContentBlock {
                kind: "image".to_string(),
                data: json!({ "url": "x" }),
            }],
        };
        let v = serde_json::to_value(&content).unwrap();
        assert_eq!(v["kind"], "content");
        let back: ToolProgress = serde_json::from_value(v).unwrap();
        assert_eq!(back, content);
    }
}
