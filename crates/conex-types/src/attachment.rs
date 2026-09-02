//! 上下文引用 / 多模态附件统一强类型定义（维度四 · 详案 04 §2.1.1）
//!
//! **定位声明（主控复核裁决，详见 00-总方案 §三 #2 与详案 04 文首注记）**：
//! 本模块全部类型**不是**与详案 02 并行的顶层卡片实体，而是唯一时间线卡片
//! 契约 `MessageContextInjection`（TS：`apps/crish-desktop/src/store/types.ts`）
//! 的 `metadata` 类型化子结构 schema；顶层卡片只有 `ContextInjectionCardPayload`
//! （`crates/conex-types/src/injection_card.rs`），附件元数据经卡片 `kind`
//! （`file_context / git_status / terminal_output / workspace_env`）承载。
//! 前端 TS 同构见 `apps/crish-desktop/src/types/attachmentContracts.ts`（仅预览，
//! 不做 wire 权威）。
//!
//! Serde wire 对齐：`ContextAttachmentKind` 为 kebab-case（对齐 TS 字面量
//! `'code-snippet'` 等）；各 metadata / payload 结构体为 camelCase。
//!
//! 接线状态（本轮）：仅契约落地（Rust 模型 + serde wire 测试），消费侧
//! （session-loop 截断/预算、agent-provider wire 组装）由战役后续轮次接线，
//! 本模块暂无非测试消费方属预期。

use serde::{Deserialize, Serialize};

/// 附件类型枚举（wire：kebab-case；对齐 TS `ContextAttachmentKind`）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ContextAttachmentKind {
    /// 代码选区引用
    CodeSnippet,
    /// Git / 文件 Diff 对比快照
    DiffSnapshot,
    /// 终端运行与报错日志
    TerminalLog,
    /// 完整文件或文档
    FileDocument,
    /// 多模态图片资产
    MultimodalImage,
    /// 实体语义提及
    EntityMention,
}

/// 代码选区元数据（对齐 TS `CodeSnippetMeta`）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeSnippetMeta {
    pub file_path: String,
    pub start_line: u32,
    pub end_line: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_column: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_column: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_sha: Option<String>,
    pub language_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol_scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_lines: Option<u32>,
}

/// Diff 快照元数据（对齐 TS `DiffSnapshotMeta`）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSnapshotMeta {
    /// "working-tree" | "staged" | "commit" | "conflict"
    pub diff_kind: String,
    pub file_path: String,
    pub additions: u32,
    pub deletions: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_ref: Option<String>,
}

/// 终端日志元数据（对齐 TS `TerminalLogMeta`）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalLogMeta {
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// "stdout" | "stderr" | "mixed"
    pub stream_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_lines: Option<usize>,
}

/// 图像元数据（对齐 TS `MultimodalImageMeta`）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultimodalImageMeta {
    pub width: u32,
    pub height: u32,
    pub mime_type: String,
    /// "auto" | "low" | "high"
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ocr_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_file_name: Option<String>,
}

/// 截断状态描述（对齐 TS `TruncationInfo`；Rust 截断算法产出，前端仅展示）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TruncationInfo {
    pub is_truncated: bool,
    pub original_size_bytes: usize,
    pub injected_size_bytes: usize,
    pub original_lines: usize,
    pub injected_lines: usize,
    /// "head-tail" | "sliding-window" | "none"
    pub truncation_strategy: String,
}

/// 统一上下文附件载荷（metadata 子结构 schema；**非顶层卡片实体**，见模块
/// 文档。对齐 TS `ContextAttachmentPayload`）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextAttachmentPayload {
    /// 全局唯一附件 ID
    pub id: String,
    /// 附件类型
    pub kind: ContextAttachmentKind,
    /// 附件展示标题
    pub title: String,
    /// 文本载荷（代码、Diff、日志或文件内容；图片时为空）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_content: Option<String>,
    /// 二进制/图像数据引用（Data URL 或本地文件系统绝对路径）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_uri_or_path: Option<String>,
    /// 估计的 Token 占用
    pub estimated_tokens: u32,
    /// 截断状态
    pub truncation: TruncationInfo,
    /// 类型专用元数据（Tagged JSON Value）
    #[serde(default)]
    pub metadata: serde_json::Value,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachment_kind_serializes_to_kebab_case() {
        // wire 字面量须与 TS ContextAttachmentKind 对齐（'code-snippet' 等）
        assert_eq!(
            serde_json::to_value(ContextAttachmentKind::CodeSnippet).unwrap(),
            "code-snippet"
        );
        assert_eq!(
            serde_json::to_value(ContextAttachmentKind::DiffSnapshot).unwrap(),
            "diff-snapshot"
        );
        assert_eq!(
            serde_json::to_value(ContextAttachmentKind::TerminalLog).unwrap(),
            "terminal-log"
        );
        assert_eq!(
            serde_json::to_value(ContextAttachmentKind::FileDocument).unwrap(),
            "file-document"
        );
        assert_eq!(
            serde_json::to_value(ContextAttachmentKind::MultimodalImage).unwrap(),
            "multimodal-image"
        );
        assert_eq!(
            serde_json::to_value(ContextAttachmentKind::EntityMention).unwrap(),
            "entity-mention"
        );
    }

    #[test]
    fn code_snippet_meta_serializes_to_camel_case() {
        let meta = CodeSnippetMeta {
            file_path: "crates/session-loop/src/lib.rs".into(),
            start_line: 1,
            end_line: 10,
            start_column: Some(2),
            end_column: None,
            commit_sha: Some("3f8a91b".into()),
            language_id: "rust".into(),
            symbol_scope: Some("handle_prepare_turn".into()),
            total_lines: None,
        };
        let json = serde_json::to_value(&meta).unwrap();
        assert_eq!(json["filePath"], "crates/session-loop/src/lib.rs");
        assert_eq!(json["startLine"], 1);
        assert_eq!(json["startColumn"], 2);
        assert_eq!(json["commitSha"], "3f8a91b");
        assert_eq!(json["languageId"], "rust");
        assert_eq!(json["symbolScope"], "handle_prepare_turn");
        // None 字段应被跳过
        assert!(json.get("endColumn").is_none());
        assert!(json.get("totalLines").is_none());
        assert!(json.get("file_path").is_none());
    }

    #[test]
    fn diff_snapshot_meta_serializes_to_camel_case() {
        let meta = DiffSnapshotMeta {
            diff_kind: "working-tree".into(),
            file_path: "apps/crish-desktop/src/store/types.ts".into(),
            additions: 3,
            deletions: 1,
            base_ref: Some("HEAD".into()),
            target_ref: None,
        };
        let json = serde_json::to_value(&meta).unwrap();
        assert_eq!(json["diffKind"], "working-tree");
        assert_eq!(json["filePath"], "apps/crish-desktop/src/store/types.ts");
        assert_eq!(json["additions"], 3);
        assert_eq!(json["deletions"], 1);
        assert_eq!(json["baseRef"], "HEAD");
        assert!(json.get("targetRef").is_none());
    }

    #[test]
    fn terminal_log_meta_serializes_to_camel_case() {
        let meta = TerminalLogMeta {
            command: "cargo test -p session-loop".into(),
            cwd: Some("/workspace".into()),
            exit_code: Some(101),
            duration_ms: Some(1234),
            stream_kind: "stderr".into(),
            total_lines: Some(200),
        };
        let json = serde_json::to_value(&meta).unwrap();
        assert_eq!(json["command"], "cargo test -p session-loop");
        assert_eq!(json["exitCode"], 101);
        assert_eq!(json["durationMs"], 1234);
        assert_eq!(json["streamKind"], "stderr");
        assert_eq!(json["totalLines"], 200);
    }

    #[test]
    fn multimodal_image_meta_serializes_to_camel_case() {
        let meta = MultimodalImageMeta {
            width: 1280,
            height: 720,
            mime_type: "image/png".into(),
            detail: "high".into(),
            ocr_text: Some("CONEX".into()),
            original_file_name: None,
        };
        let json = serde_json::to_value(&meta).unwrap();
        assert_eq!(json["width"], 1280);
        assert_eq!(json["height"], 720);
        assert_eq!(json["mimeType"], "image/png");
        assert_eq!(json["detail"], "high");
        assert_eq!(json["ocrText"], "CONEX");
        assert!(json.get("originalFileName").is_none());
    }

    #[test]
    fn truncation_info_serializes_to_camel_case() {
        let info = TruncationInfo {
            is_truncated: true,
            original_size_bytes: 4096,
            injected_size_bytes: 2048,
            original_lines: 120,
            injected_lines: 40,
            truncation_strategy: "head-tail".into(),
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["isTruncated"], true);
        assert_eq!(json["originalSizeBytes"], 4096);
        assert_eq!(json["injectedSizeBytes"], 2048);
        assert_eq!(json["originalLines"], 120);
        assert_eq!(json["injectedLines"], 40);
        assert_eq!(json["truncationStrategy"], "head-tail");
        assert!(json.get("is_truncated").is_none());
    }

    #[test]
    fn attachment_payload_roundtrip() {
        let payload = ContextAttachmentPayload {
            id: "att_snippet_01".into(),
            kind: ContextAttachmentKind::CodeSnippet,
            title: "prepare_turn.rs L45-L60".into(),
            text_content: Some("let held: Vec<AgentMessage> = {".into()),
            data_uri_or_path: None,
            estimated_tokens: 184,
            truncation: TruncationInfo {
                is_truncated: false,
                original_size_bytes: 31,
                injected_size_bytes: 31,
                original_lines: 1,
                injected_lines: 1,
                truncation_strategy: "none".into(),
            },
            metadata: serde_json::json!({ "filePath": "crates/session-loop/src/lib.rs" }),
        };
        let json = serde_json::to_string(&payload).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["id"], "att_snippet_01");
        assert_eq!(value["kind"], "code-snippet");
        assert_eq!(value["estimatedTokens"], 184);
        assert_eq!(
            value["truncation"]["truncationStrategy"],
            "none"
        );
        assert_eq!(
            value["metadata"]["filePath"],
            "crates/session-loop/src/lib.rs"
        );
        assert!(value.get("dataUriOrPath").is_none());
        let back: ContextAttachmentPayload = serde_json::from_str(&json).unwrap();
        assert_eq!(payload, back);
    }

    #[test]
    fn attachment_payload_missing_optional_keys_deserialize_to_none() {
        // 旧/瘦载荷缺省可选字段 → 反序列化不炸（serde default 兜底）
        let raw = r#"{
            "id": "att_term_02",
            "kind": "terminal-log",
            "title": "cargo test",
            "estimatedTokens": 88,
            "truncation": {
                "isTruncated": false,
                "originalSizeBytes": 0,
                "injectedSizeBytes": 0,
                "originalLines": 0,
                "injectedLines": 0,
                "truncationStrategy": "none"
            }
        }"#;
        let payload: ContextAttachmentPayload = serde_json::from_str(raw).unwrap();
        assert_eq!(payload.text_content, None);
        assert_eq!(payload.data_uri_or_path, None);
        assert_eq!(payload.metadata, serde_json::Value::Null);
    }
}
