//! 摘要文档（Schema V1）规范面：校验 / markdown 渲染投影 / 旧格式兼容解析
//!
//! 职责（04 §3.2 D1 / 00-plan §6.1）：
//! - **JSON 为规范面**：required 骨架 + `additionalProperties: true`
//!   （AI 自由扩展 custom），校验机器可读；
//! - **markdown 渲染为确定性投影**：同文档同输出（无时间戳），同步成功
//!   路径作为链文本写入对话（R-G 场景 A）；
//! - **兼容解析**：旧 L1/stub 文本可解析为最低骨架文档（legacy 兼容，
//!   不删旧接口面），使 existing 通道对历史摘要可读。
//!
//! 本模块保持纯函数、无运行时依赖（既有 crate 定位）；JSON 化由本侧
//! validate 兜底，不强求 LLM 必输 JSON（T-13 边界）。

use std::fmt;

/// Schema V1 版本号（required 骨架变更需升版本）
pub const SUMMARY_SCHEMA_VERSION: u32 = 1;

/// Schema V1 required 字段（00-plan §6.1；固定顺序即文档结构序）
pub const SUMMARY_REQUIRED_FIELDS: [&str; 12] = [
    "schemaVersion",
    "blockId",
    "generation",
    "droppedIds",
    "height",
    "tier",
    "goal",
    "constraints",
    "progress",
    "decisions",
    "nextSteps",
    "criticalContext",
];

/// 摘要文档校验/渲染错误（Display 供日志与降级判定）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SummaryDocError {
    /// 非合法 JSON（或非 JSON 对象）
    InvalidJson,
    /// 缺少 required 字段
    MissingField(&'static str),
    /// 字节超预算（顶层预算钳制：绝不 byte 截断 JSON，保解析）
    TooLarge { bytes: usize, max: usize },
    /// 某字段必须为数组
    NotArray(&'static str),
}

impl fmt::Display for SummaryDocError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SummaryDocError::InvalidJson => write!(f, "摘要文档不是合法 JSON 对象"),
            SummaryDocError::MissingField(field) => {
                write!(f, "摘要文档缺少 required 字段：{field}")
            }
            SummaryDocError::TooLarge { bytes, max } => {
                write!(f, "摘要文档超预算：{bytes} 字节 > {max} 字节")
            }
            SummaryDocError::NotArray(field) => {
                write!(f, "摘要文档字段 {field} 必须为数组")
            }
        }
    }
}

impl std::error::Error for SummaryDocError {}

/// Schema V1 校验：JSON 解析 + required 骨架 + droppedIds 数组 + 字节预算。
///
/// `additionalProperties: true` 天然允许 custom 自由扩展（00-plan §6.1）；
/// 校验通过后返回解析出的 [serde_json::Value] 供渲染/合并使用。
pub fn validate_summary_document(
    json: &str,
    max_bytes: usize,
) -> Result<serde_json::Value, SummaryDocError> {
    if json.len() > max_bytes {
        return Err(SummaryDocError::TooLarge {
            bytes: json.len(),
            max: max_bytes,
        });
    }
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|_| SummaryDocError::InvalidJson)?;
    let object = value.as_object().ok_or(SummaryDocError::InvalidJson)?;
    for field in SUMMARY_REQUIRED_FIELDS {
        if !object.contains_key(field) {
            return Err(SummaryDocError::MissingField(field));
        }
    }
    if object.get("droppedIds").is_none_or(|v| !v.is_array()) {
        return Err(SummaryDocError::NotArray("droppedIds"));
    }
    Ok(value)
}

fn string_field<'a>(doc: &'a serde_json::Value, key: &str) -> &'a str {
    doc.get(key).and_then(|v| v.as_str()).unwrap_or("")
}

/// 字符串数组渲染为列表（非数组/空数组 → 不输出条目）
fn push_string_list(out: &mut String, doc: &serde_json::Value, key: &str) {
    if let Some(items) = doc.get(key).and_then(|v| v.as_array()) {
        for item in items {
            if let Some(text) = item.as_str() {
                out.push_str("- ");
                out.push_str(text);
                out.push('\n');
            }
        }
    }
}

/// decisions 条目渲染：对象（topic/detail/reason）或纯字符串皆可
fn push_decisions(out: &mut String, doc: &serde_json::Value) {
    if let Some(items) = doc.get("decisions").and_then(|v| v.as_array()) {
        for item in items {
            if let Some(object) = item.as_object() {
                let topic = object.get("topic").and_then(|v| v.as_str()).unwrap_or("");
                let detail = object.get("detail").and_then(|v| v.as_str()).unwrap_or("");
                let reason = object.get("reason").and_then(|v| v.as_str()).unwrap_or("");
                let mut line = String::from("- ");
                if !topic.is_empty() {
                    line.push_str(topic);
                }
                if !detail.is_empty() {
                    if !topic.is_empty() {
                        line.push('：');
                    }
                    line.push_str(detail);
                }
                if !reason.is_empty() {
                    line.push_str("（理由：");
                    line.push_str(reason);
                    line.push('）');
                }
                out.push_str(&line);
                out.push('\n');
            } else if let Some(text) = item.as_str() {
                out.push_str("- ");
                out.push_str(text);
                out.push('\n');
            }
        }
    }
}

/// 结构字段渲染：paths[]（path/changed/note）、signatures[]（name/kind/file）、
/// counts{}（键序固定排序）——仅在文档中存在时输出（00-plan §6.1 structured）
fn push_paths(out: &mut String, doc: &serde_json::Value) {
    if let Some(items) = doc.get("paths").and_then(|v| v.as_array()) {
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

fn push_signatures(out: &mut String, doc: &serde_json::Value) {
    if let Some(items) = doc.get("signatures").and_then(|v| v.as_array()) {
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

fn push_counts(out: &mut String, doc: &serde_json::Value) {
    if let Some(object) = doc.get("counts").and_then(|v| v.as_object()) {
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
pub fn summary_to_markdown(doc: &serde_json::Value) -> String {
    let mut out = String::new();
    out.push_str("## Goal\n");
    out.push_str(string_field(doc, "goal"));
    out.push_str("\n\n## Constraints\n");
    push_string_list(&mut out, doc, "constraints");
    out.push_str("\n## Progress\n");
    push_string_list(&mut out, doc, "progress");
    out.push_str("\n## Key Decisions\n");
    push_decisions(&mut out, doc);
    out.push_str("\n## Next Steps\n");
    push_string_list(&mut out, doc, "nextSteps");
    out.push_str("\n## Critical Context\n");
    out.push_str(string_field(doc, "criticalContext"));
    push_paths(&mut out, doc);
    push_signatures(&mut out, doc);
    push_counts(&mut out, doc);
    out
}

/// 旧格式文本 → 最低骨架文档（legacy 兼容解析；04 §6.1 / 00-plan §6.1）
///
/// 识别形态：
/// - L1 占位符 `[Compacted N earlier message(s) to fit context window]`；
/// - 块引用行 `[Compacted N earlier message(s) · block {b} · generation {g}
///   · 恢复: decompress_context(blockId="{b}")]`（01 §2.2）。
///
/// blockId/generation 从文本提取（缺失时 blockId 为空串、generation=0）；
/// droppedIds 为空数组（原文信息熵已收缩，不伪造）；tier=legacy。
pub fn parse_legacy_summary(text: &str) -> Option<serde_json::Value> {
    let trimmed = text.trim();
    if !trimmed.starts_with("[Compacted") {
        return None;
    }
    Some(serde_json::json!({
        "schemaVersion": SUMMARY_SCHEMA_VERSION,
        "blockId": extract_block_id(trimmed).unwrap_or_default(),
        "generation": extract_generation(trimmed).unwrap_or(0),
        "droppedIds": [],
        "height": 1,
        "tier": "legacy",
        "goal": trimmed,
        "constraints": [],
        "progress": [],
        "decisions": [],
        "nextSteps": [],
        "criticalContext": "",
    }))
}

/// 提取块 id：优先块引用行形态 `blockId="{...}"`；兜底中性 stub 形态
/// `[Compacted({block_id}) ...]`（无正则依赖的手工扫描）
fn extract_block_id(text: &str) -> Option<String> {
    const MARK: &str = "blockId=\"";
    if let Some(start) = text.find(MARK) {
        let start = start + MARK.len();
        if let Some(end) = text[start..].find('"') {
            return Some(text[start..start + end].to_string());
        }
    }
    const PAREN: &str = "Compacted(";
    if let Some(start) = text.find(PAREN) {
        let start = start + PAREN.len();
        if let Some(end) = text[start..].find(')') {
            return Some(text[start..start + end].to_string());
        }
    }
    None
}

/// 提取 `generation {g}` 段中的代数（仅数字）
fn extract_generation(text: &str) -> Option<u32> {
    const MARK: &str = "generation ";
    let start = text.find(MARK)? + MARK.len();
    let digits: String = text[start..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        parse_legacy_summary, summary_to_markdown, validate_summary_document, SummaryDocError,
        SUMMARY_REQUIRED_FIELDS,
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
            "decisions": [
                { "topic": "stub 语义", "detail": "中性句柄", "reason": "R-C 永不改写" },
                "保留既有前缀"
            ],
            "nextSteps": ["轮次 2 持久层"],
            "criticalContext": "fold_start = system 后首个非链下标",
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

    fn valid_doc_json() -> String {
        serde_json::to_string(&valid_doc()).unwrap()
    }

    #[test]
    fn validate_accepts_legal_document_with_custom_extensions() {
        let doc = validate_summary_document(&valid_doc_json(), 4096).expect("合法文档必须通过校验");
        // custom 自由扩展不阻碍（additionalProperties: true）
        assert_eq!(doc["custom"]["agentNotes"], "任意扩展");
        assert_eq!(doc["schemaVersion"], 1);
    }

    #[test]
    fn validate_rejects_missing_required_field() {
        let mut doc = valid_doc();
        doc.as_object_mut().unwrap().remove("criticalContext");
        let err =
            validate_summary_document(&serde_json::to_string(&doc).unwrap(), 4096).unwrap_err();
        assert_eq!(err, SummaryDocError::MissingField("criticalContext"));
        // required 清单与方案一致
        assert!(SUMMARY_REQUIRED_FIELDS.contains(&"goal"));
        assert!(SUMMARY_REQUIRED_FIELDS.contains(&"nextSteps"));
    }

    #[test]
    fn validate_rejects_non_array_dropped_ids() {
        let mut doc = valid_doc();
        doc["droppedIds"] = serde_json::json!("u1");
        let err =
            validate_summary_document(&serde_json::to_string(&doc).unwrap(), 4096).unwrap_err();
        assert_eq!(err, SummaryDocError::NotArray("droppedIds"));
    }

    #[test]
    fn validate_rejects_too_large_and_invalid_json() {
        let json = valid_doc_json();
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
        assert_eq!(
            validate_summary_document("[]", 4096).unwrap_err(),
            SummaryDocError::InvalidJson
        );
    }

    #[test]
    fn summary_to_markdown_is_deterministic_with_fixed_order() {
        let doc = valid_doc();
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
        assert!(first.contains("stub 语义：中性句柄（理由：R-C 永不改写）"));
        assert!(first.contains("fold_start = system 后首个非链下标"));
        assert!(first.contains("fold_start_of（function，lib.rs）"));
        assert!(first.contains("messagesDropped: 2"));
        // 无时间戳（确定性前提）
        assert!(!first.contains("timestamp") && !first.contains("createdAt"));
    }

    #[test]
    fn legacy_placeholder_parses_to_skeleton_document() {
        // L1 占位符：无块 id → 骨架最低形态
        let l1 = "[Compacted 3 earlier message(s) to fit context window]";
        let doc = parse_legacy_summary(l1).expect("L1 文本必须可解析");
        assert_eq!(doc["blockId"], "");
        assert_eq!(doc["generation"], 0);
        assert_eq!(doc["tier"], "legacy");
        assert!(doc["droppedIds"].as_array().unwrap().is_empty());
        assert_eq!(doc["height"], 1);
        // 骨架可过 Schema V1 校验（existing 通道可读）
        assert!(validate_summary_document(&serde_json::to_string(&doc).unwrap(), 4096).is_ok());
    }

    #[test]
    fn legacy_block_line_extracts_block_id_and_generation() {
        let line = "[Compacted 7 earlier message(s) · block compacted-summary-1-3 · generation 1 · 恢复: decompress_context(blockId=\"compacted-summary-1-3\")]";
        let doc = parse_legacy_summary(line).expect("块引用行必须可解析");
        assert_eq!(doc["blockId"], "compacted-summary-1-3");
        assert_eq!(doc["generation"], 1);
        // 渲染确定性（骨架文档亦可投影）
        let rendered = summary_to_markdown(&doc);
        assert!(rendered.contains("## Goal"));
    }

    #[test]
    fn legacy_stub_text_extracts_block_id_from_parens() {
        // 中性 stub 形态（T-13）：块 id 在 Compacted(...) 括号内
        let stub = "[Compacted(compacted-summary-1-1) 2 条消息 · 摘要见块表]";
        let doc = parse_legacy_summary(stub).expect("stub 文本必须可解析");
        assert_eq!(doc["blockId"], "compacted-summary-1-1");
        assert_eq!(doc["generation"], 0);
        assert_eq!(doc["tier"], "legacy");
        // 骨架可过 Schema V1 校验（existing 通道可读）
        assert!(validate_summary_document(&serde_json::to_string(&doc).unwrap(), 4096).is_ok());
    }

    #[test]
    fn non_legacy_text_returns_none() {
        assert!(parse_legacy_summary("## Goal\n(none)").is_none());
        assert!(parse_legacy_summary("").is_none());
    }
}
