//! 摘要文档（Schema V1）规范面：强类型校验 / markdown 渲染投影
//!
//! 职责（04 §3.2 D1 / 00-plan §6.1）：
//! - **JSON 为规范面**：required 骨架 + `additionalProperties: true`
//!   （AI 自由扩展 custom），校验机器可读；
//! - **markdown 渲染为确定性投影**：同文档同输出（无时间戳），同步成功
//!   路径作为链文本写入对话（R-G 场景 A）。
//!
//! 类型即契约：required 字段由 [SummaryDocument] 表达，字段缺失 / 类型不符
//! 由 serde 报错并映射为 [SummaryDocError]（调用方走既有降级路径）。
//! 本模块保持纯函数、无运行时依赖（既有 crate 定位）。

use std::fmt;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Schema V1 版本号（required 骨架变更需升版本）
pub const SUMMARY_SCHEMA_VERSION: u32 = 1;

/// 摘要层级标记（取值以生产者为准：压缩摘要 `chunk`、阶段总结 `stage-N`）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SummaryTier {
    /// 压缩摘要（LLM 契约固定值）
    Chunk,
    /// 阶段里程碑总结（N 从 1 起）
    Stage(u32),
}

impl SummaryTier {
    /// 里程碑下标（0-based）→ 阶段标记 `stage-{index + 1}`
    pub fn stage(index: u32) -> Self {
        Self::Stage(index + 1)
    }
}

impl fmt::Display for SummaryTier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SummaryTier::Chunk => f.write_str("chunk"),
            SummaryTier::Stage(number) => write!(f, "stage-{number}"),
        }
    }
}

impl Serialize for SummaryTier {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for SummaryTier {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        if raw == "chunk" {
            return Ok(SummaryTier::Chunk);
        }
        if let Some(number) = raw.strip_prefix("stage-").and_then(|n| n.parse().ok()) {
            return Ok(SummaryTier::Stage(number));
        }
        Err(D::Error::custom(format!(
            "tier 必须是 \"chunk\" 或 \"stage-N\"，实际为 {raw:?}"
        )))
    }
}

/// Schema V1 摘要文档（wire 字段名 camelCase，与事件 / checkpoint / 前端
/// `criticalContext` / `droppedIds` 口径一致）。
///
/// `decisions` / `critical_context` 只接受 prompt 契约的字符串数组形态；
/// 其它形态（对象条目、顶层对象、纯文本）一律校验失败，杜绝静默吞成空行。
/// 未知键（custom / counts / paths / signatures / range 等）经 [Self::extra]
/// 无损保留。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SummaryDocument {
    pub schema_version: u32,
    pub block_id: String,
    pub generation: u32,
    pub dropped_ids: Vec<String>,
    pub height: u32,
    pub tier: SummaryTier,
    pub goal: String,
    pub constraints: Vec<String>,
    pub progress: Vec<String>,
    pub decisions: Vec<String>,
    pub next_steps: Vec<String>,
    pub critical_context: Vec<String>,
    /// 自由扩展键（additionalProperties: true）
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// 摘要文档校验错误（Display 供日志与降级判定）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SummaryDocError {
    /// 非合法 JSON（语法错误 / 空输入）
    InvalidJson,
    /// 文档结构不符合 Schema V1（缺字段 / 类型错 / tier 非法）
    Schema(String),
    /// 字节超预算（顶层预算钳制：绝不 byte 截断 JSON，保解析）
    TooLarge { bytes: usize, max: usize },
}

impl fmt::Display for SummaryDocError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SummaryDocError::InvalidJson => write!(f, "摘要文档不是合法 JSON"),
            SummaryDocError::Schema(message) => {
                write!(f, "摘要文档不符合 Schema V1：{message}")
            }
            SummaryDocError::TooLarge { bytes, max } => {
                write!(f, "摘要文档超预算：{bytes} 字节 > {max} 字节")
            }
        }
    }
}

impl std::error::Error for SummaryDocError {}

/// Schema V1 校验：字节预算 → JSON 语法 → 强类型反序列化。
///
/// `additionalProperties: true` 由 [SummaryDocument::extra] 承载，自由扩展
/// 不阻碍校验。
pub fn validate_summary_document(
    json: &str,
    max_bytes: usize,
) -> Result<SummaryDocument, SummaryDocError> {
    if json.len() > max_bytes {
        return Err(SummaryDocError::TooLarge {
            bytes: json.len(),
            max: max_bytes,
        });
    }
    serde_json::from_str(json).map_err(|error| match error.classify() {
        serde_json::error::Category::Syntax | serde_json::error::Category::Eof => {
            SummaryDocError::InvalidJson
        }
        _ => SummaryDocError::Schema(error.to_string()),
    })
}

/// 字符串数组渲染为列表（空数组 → 不输出条目）
fn push_string_list(out: &mut String, items: &[String]) {
    for item in items {
        out.push_str("- ");
        out.push_str(item);
        out.push('\n');
    }
}

/// Critical Context 渲染：逐条渲染为无序列表（空白条目跳过，杜绝空白行）
fn push_critical_context(out: &mut String, items: &[String]) {
    for item in items {
        let trimmed = item.trim();
        if !trimmed.is_empty() {
            out.push_str("- ");
            out.push_str(trimmed);
            out.push('\n');
        }
    }
}

/// 结构字段渲染：paths[]（path/changed/note）、signatures[]（name/kind/file）、
/// counts{}（键序固定排序）——仅在文档中存在时输出（00-plan §6.1 structured）
fn push_paths(out: &mut String, extra: &serde_json::Map<String, serde_json::Value>) {
    if let Some(items) = extra.get("paths").and_then(|v| v.as_array()) {
        out.push_str("\n## Paths\n");
        for item in items {
            if let Some(object) = item.as_object() {
                let path = object.get("path").and_then(|v| v.as_str()).unwrap_or("");
                let changed = object.get("changed").and_then(|v| v.as_bool());
                let note = object.get("note").and_then(|v| v.as_str()).unwrap_or("");
                out.push_str("- ");
                out.push_str(path);
                if let Some(changed) = changed {
                    out.push_str(&format!("（changed：{changed}"));
                    if !note.is_empty() {
                        out.push_str("；note：");
                        out.push_str(note);
                    }
                    out.push('）');
                } else if !note.is_empty() {
                    out.push_str("（note：");
                    out.push_str(note);
                    out.push('）');
                }
                out.push('\n');
            }
        }
    }
}

fn push_signatures(out: &mut String, extra: &serde_json::Map<String, serde_json::Value>) {
    if let Some(items) = extra.get("signatures").and_then(|v| v.as_array()) {
        out.push_str("\n## Signatures\n");
        for item in items {
            if let Some(object) = item.as_object() {
                let name = object.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let kind = object.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                let file = object.get("file").and_then(|v| v.as_str()).unwrap_or("");
                let mut line = format!("- {name}");
                if !kind.is_empty() {
                    line.push_str(&format!("（{kind}"));
                    if !file.is_empty() {
                        line.push('，');
                        line.push_str(file);
                    }
                    line.push('）');
                } else if !file.is_empty() {
                    line.push_str(&format!("（{file}）"));
                }
                out.push_str(&line);
                out.push('\n');
            }
        }
    }
}

fn push_counts(out: &mut String, extra: &serde_json::Map<String, serde_json::Value>) {
    if let Some(object) = extra.get("counts").and_then(|v| v.as_object()) {
        out.push_str("\n## Counts\n");
        // 键序固定排序保证确定性（不依赖 serde_json Map 内部序）
        let mut keys: Vec<&String> = object.keys().collect();
        keys.sort();
        for key in keys {
            out.push_str("- ");
            out.push_str(key);
            out.push_str(": ");
            if let Some(value) = object.get(key) {
                if value.is_string() {
                    out.push_str(value.as_str().unwrap_or(""));
                } else {
                    out.push_str(&value.to_string());
                }
            }
            out.push('\n');
        }
    }
}

/// markdown 渲染投影（确定性：同文档同输出，无时间戳；固定节序与分隔符）
///
/// 骨架节（Goal/Constraints/Progress/Key Decisions/Next Steps/
/// Critical Context）恒输出（required）；结构字段
/// （paths[]/signatures[]/counts{}）仅在场时输出。
pub fn summary_to_markdown(doc: &SummaryDocument) -> String {
    let mut out = String::new();
    out.push_str("## Goal\n");
    out.push_str(&doc.goal);
    out.push_str("\n\n## Constraints\n");
    push_string_list(&mut out, &doc.constraints);
    out.push_str("\n## Progress\n");
    push_string_list(&mut out, &doc.progress);
    out.push_str("\n## Key Decisions\n");
    push_string_list(&mut out, &doc.decisions);
    out.push_str("\n## Next Steps\n");
    push_string_list(&mut out, &doc.next_steps);
    out.push_str("\n## Critical Context\n");
    push_critical_context(&mut out, &doc.critical_context);
    push_paths(&mut out, &doc.extra);
    push_signatures(&mut out, &doc.extra);
    push_counts(&mut out, &doc.extra);
    out
}

#[cfg(test)]
mod tests {
    use super::{
        summary_to_markdown, validate_summary_document, SummaryDocError, SummaryDocument,
        SummaryTier,
    };

    /// 合法 V1 文档（含 structured 扩展与 custom 自由键）
    fn valid_doc() -> serde_json::Value {
        serde_json::json!({
            "schemaVersion": 1,
            "blockId": "compacted-summary-1-1",
            "generation": 1,
            "droppedIds": ["u1", "a1"],
            "height": 1,
            "tier": "chunk",
            "goal": "实现折叠链冻结",
            "constraints": ["B1 冻结", "B2 单调"],
            "progress": ["引擎钳制完成", "测试全绿"],
            "decisions": ["stub 语义：中性句柄", "保留既有前缀"],
            "nextSteps": ["轮次 2 持久层"],
            "criticalContext": ["fold_start = system 后首个非链下标"],
            "paths": [
                { "path": "crates/conex-compaction/src/lib.rs", "changed": true, "note": "链钳制" }
            ],
            "signatures": [
                { "name": "fold_start_of", "kind": "function", "file": "lib.rs" }
            ],
            "counts": { "messagesDropped": 2, "turnsCovered": 1 },
            "custom": { "agentNotes": "任意扩展" }
        })
    }

    fn valid_document() -> SummaryDocument {
        validate_summary_document(&valid_doc().to_string(), 4096).expect("合法文档必须通过校验")
    }

    #[test]
    fn validate_accepts_legal_document_with_custom_extensions() {
        let doc = valid_document();
        // custom 自由扩展不阻碍（additionalProperties: true）
        assert_eq!(doc.extra["custom"]["agentNotes"], "任意扩展");
        assert_eq!(doc.schema_version, 1);
        assert_eq!(doc.tier, SummaryTier::Chunk);
        assert_eq!(doc.critical_context, ["fold_start = system 后首个非链下标"]);
        assert_eq!(doc.decisions.len(), 2);
    }

    /// R3：validate → serialize 往返后与原 JSON 语义相等（extra flatten 不丢键）
    #[test]
    fn validate_serialize_roundtrip_preserves_wire_shape_and_extra_keys() {
        let doc = valid_document();
        let roundtrip = serde_json::to_value(&doc).expect("序列化");
        assert_eq!(
            roundtrip,
            valid_doc(),
            "wire 字段名 / 形态 / 扩展键必须无损"
        );
    }

    #[test]
    fn tier_serializes_chunk_and_stage_forms() {
        assert_eq!(
            serde_json::to_value(SummaryTier::Stage(2)).unwrap(),
            serde_json::json!("stage-2")
        );
        let doc = SummaryDocument {
            tier: SummaryTier::Stage(3),
            ..valid_document()
        };
        assert_eq!(serde_json::to_value(&doc).unwrap()["tier"], "stage-3");
        // 生产者集合外的 tier 值必须校验失败
        let mut unknown_tier = valid_doc();
        unknown_tier["tier"] = serde_json::json!("final");
        assert!(matches!(
            validate_summary_document(&unknown_tier.to_string(), 4096),
            Err(SummaryDocError::Schema(_))
        ));
    }

    #[test]
    fn validate_rejects_missing_required_field() {
        let mut doc = valid_doc();
        doc.as_object_mut().unwrap().remove("criticalContext");
        let err = validate_summary_document(&doc.to_string(), 4096).unwrap_err();
        match err {
            SummaryDocError::Schema(message) => {
                assert!(
                    message.contains("missing field `criticalContext`"),
                    "缺失 required 字段必须由 serde 报错：{message}"
                );
            }
            other => panic!("期望 Schema 错误，实际 {other:?}"),
        }
    }

    #[test]
    fn validate_rejects_non_array_dropped_ids() {
        let mut doc = valid_doc();
        doc["droppedIds"] = serde_json::json!("u1");
        let err = validate_summary_document(&doc.to_string(), 4096).unwrap_err();
        match err {
            SummaryDocError::Schema(message) => {
                assert!(
                    message.contains("expected a sequence"),
                    "droppedIds 类型错必须是序列类型错误：{message}"
                );
            }
            other => panic!("期望 Schema 错误，实际 {other:?}"),
        }
    }

    /// R4：D-CP-2 删除的多形态输入必须返回错误（不得渲染成空行）
    #[test]
    fn validate_rejects_deleted_multi_shape_forms() {
        let mut critical_string = valid_doc();
        critical_string["criticalContext"] = serde_json::json!("纯文本关键上下文");
        let mut critical_object = valid_doc();
        critical_object["criticalContext"] = serde_json::json!({ "path": "src/lib.rs" });
        let mut decision_object = valid_doc();
        decision_object["decisions"] = serde_json::json!([
            { "topic": "stub 语义", "detail": "中性句柄", "reason": "R-C 永不改写" }
        ]);
        for (name, doc) in [
            ("criticalContext 纯文本", critical_string),
            ("criticalContext 顶层对象", critical_object),
            ("decisions 对象条目", decision_object),
        ] {
            assert!(
                matches!(
                    validate_summary_document(&doc.to_string(), 4096),
                    Err(SummaryDocError::Schema(_))
                ),
                "{name} 形态必须校验失败"
            );
        }
    }

    #[test]
    fn validate_rejects_too_large_and_invalid_json() {
        let json = valid_doc().to_string();
        let bytes = json.len();
        assert_eq!(
            validate_summary_document(&json, bytes - 1).unwrap_err(),
            SummaryDocError::TooLarge {
                bytes,
                max: bytes - 1
            }
        );
        assert_eq!(
            validate_summary_document("not json", 4096).unwrap_err(),
            SummaryDocError::InvalidJson
        );
        // 合法 JSON 但不是 Schema V1 对象 → 结构错误
        assert!(matches!(
            validate_summary_document("[]", 4096),
            Err(SummaryDocError::Schema(_))
        ));
    }

    #[test]
    fn summary_to_markdown_is_deterministic_with_fixed_order() {
        let doc = valid_document();
        let first = summary_to_markdown(&doc);
        // 同输入同输出
        assert_eq!(first, summary_to_markdown(&doc));
        // 节序固定
        let goal = first.find("## Goal").unwrap();
        let constraints = first.find("## Constraints").unwrap();
        let progress = first.find("## Progress").unwrap();
        let decisions = first.find("## Key Decisions").unwrap();
        let next_steps = first.find("## Next Steps").unwrap();
        let critical = first.find("## Critical Context").unwrap();
        let paths = first.find("## Paths").unwrap();
        let signatures = first.find("## Signatures").unwrap();
        let counts = first.find("## Counts").unwrap();
        assert!(goal < constraints && constraints < progress && progress < decisions);
        assert!(decisions < next_steps && next_steps < critical);
        assert!(critical < paths && paths < signatures && signatures < counts);
        // 内容在场
        assert!(first.contains("实现折叠链冻结"));
        assert!(first.contains("B1 冻结"));
        assert!(first.contains("- stub 语义：中性句柄\n"));
        assert!(first.contains("fold_start = system 后首个非链下标"));
        assert!(first.contains("fold_start_of（function，lib.rs）"));
        assert!(first.contains("messagesDropped: 2"));
        // 无时间戳（确定性前提）
        assert!(!first.contains("timestamp") && !first.contains("createdAt"));
    }

    #[test]
    fn test_critical_context_array_rendering() {
        let doc = validate_summary_document(
            &serde_json::json!({
                "schemaVersion": 1,
                "blockId": "summary-1",
                "generation": 1,
                "droppedIds": ["m1", "m2"],
                "height": 1,
                "tier": "chunk",
                "goal": "重构关键上下文",
                "constraints": ["零未捕获异常"],
                "progress": ["完成分词器重构"],
                "decisions": ["Critical Context 单形态渲染"],
                "nextSteps": ["跑通完整测试"],
                "criticalContext": [
                    "path/to/file.rs:42",
                    "Command failed: exit 1",
                    "  ",
                    ""
                ]
            })
            .to_string(),
            4096,
        )
        .unwrap();
        let md = summary_to_markdown(&doc);
        // 空白条目跳过：节内只留两条有效条目，且无空白行
        assert!(
            md.contains("## Critical Context\n- path/to/file.rs:42\n- Command failed: exit 1\n")
        );
        let crit_section = md.split("## Critical Context").nth(1).unwrap();
        assert!(crit_section.trim().starts_with("- path/to/file.rs:42"));
        assert!(!crit_section.contains("- \n"), "不得渲染空条目");
    }

    /// 空数组 → 只保留节头，不产生空白条目 / 空白标题
    #[test]
    fn empty_critical_context_renders_header_only() {
        let mut json = valid_doc();
        json["criticalContext"] = serde_json::json!([]);
        // 只留骨架字段（structured 扩展会追加后继节）
        json.as_object_mut()
            .unwrap()
            .retain(|key, _| !matches!(key.as_str(), "paths" | "signatures" | "counts" | "custom"));
        let doc = validate_summary_document(&json.to_string(), 4096).unwrap();
        let md = summary_to_markdown(&doc);
        assert!(
            md.ends_with("## Critical Context\n"),
            "空数组不得渲染空条目"
        );
        assert!(!md.contains("- \n"));
    }
}
