//! multi_replace 工具（T-EG-01：REQ-E01 多块非连续代码原子替换）
//!
//! 单次调用完成同一文件的多个非连续代码块精确原文替换，任一 Chunk 匹配失败
//! 则整体回滚（文件保持原状），替换结果与逐个手工修改效果一致。
//! 契约依据：REQ-EG-现状分析.md 1.7（schema 草案）/ 1.8（伪代码骨架）、
//! 04-EG方案.md 4.1（schema 定稿与执行流程 10 步）。
//!
//! 原子性分层（04-EG方案.md 4.2）：
//! - 层 1（本文件）读 → 全部校验 → 内存构建 → 一次写盘；失败不触碰磁盘；
//! - 层 2/3（写路径互斥 / 写前快照）由 R-EG2 装配（write_paths / backup），
//!   本文件仅声明写路径互斥（未接线时不强制）与消耗文档配额；
//! - 层 4（文件系统级）：同目录临时文件 + rename 交换，Windows 上目标存在
//!   时先 remove 再 rename（04-EG方案.md 4.1 第 9 步既定方案）。
//!
//! EOL 处理（移植 apps/crish-desktop/src/api/applyFileDiff.ts:287-297）：
//! 匹配统一按 LF（CRLF/CR 归一化），写回按原文件偏好还原 CRLF。

use crate::context::ToolContext;
use crate::definition::{Tool, ToolDefinition, ToolError};
use crate::tools::{
    decode_text, display_path, require_string, resolve_workspace_path, snapshot_tag,
};
use crate::write_paths::{claim_write_guard, ClaimMode};
use async_trait::async_trait;
use std::path::Path;

/// 工具名（注册键，错误消息共用）
pub(crate) const MULTI_REPLACE_TOOL_NAME: &str = "multi_replace_file_content";

/// multi_replace 工具：多块非连续精确原文原子替换
pub(crate) struct MultiReplaceFileTool {
    def: ToolDefinition,
}

impl MultiReplaceFileTool {
    pub(crate) fn new() -> Self {
        Self {
            def: ToolDefinition {
                name: MULTI_REPLACE_TOOL_NAME.to_string(),
                // 描述含注释保留机制面（REQ-E03 保险一，04-EG方案.md 5.1.2 第 3 条）：
                // 精确匹配天然不触碰未指定内容；replacement_content 必须承载注释行
                description: "对同一文件的多个非连续代码块做精确原文替换：任一 Chunk 匹配失败则整体回滚，文件保持原状。target_content 必须与文件严格匹配（含缩进空白与注释行）；replacement_content 需完整承载目标区间内的注释行，与本次修改无关的注释不得删除、修改或移位。chunks=1 时行为与单块替换一致，可替代单点修改。".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "target_file": { "type": "string", "description": "目标文件绝对路径（工作区内；经路径安全校验）" },
                        "replacement_chunks": {
                            "type": "array",
                            "minItems": 1,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "start_line": { "type": "integer", "minimum": 1, "description": "搜索范围起始行号（1-indexed，闭区间）" },
                                    "end_line": { "type": "integer", "minimum": 1, "description": "搜索范围结束行号（1-indexed，闭区间）" },
                                    "target_content": { "type": "string", "description": "要被替换的精确原文（含缩进空白，必须与文件严格匹配）" },
                                    "replacement_content": { "type": "string", "description": "替换后的新内容（需完整承载目标区间内的注释行）" },
                                    "allow_multiple": { "type": "boolean", "default": false, "description": "范围内允许多实例替换；默认 false（多处匹配报错）" }
                                },
                                "required": ["start_line", "end_line", "target_content", "replacement_content"],
                                "additionalProperties": false
                            }
                        }
                    },
                    "required": ["target_file", "replacement_chunks"],
                    "additionalProperties": false
                }),
                dangerous: true,
                fatal_on_error: false,
            },
        }
    }
}

#[async_trait]
impl Tool for MultiReplaceFileTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    /// 执行流程对齐 REQ-EG-现状分析.md 1.8 伪代码骨架（10 步）
    async fn execute(
        &self,
        ctx: &ToolContext,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, ToolError> {
        // 1. 入参解析与路径校验（resolve_workspace_path：越界/控制字符/深度/包含性）
        let path_str = require_string(&args, "target_file")?;
        let file_path = resolve_workspace_path(&ctx.workspace_root, &path_str)?;
        let display = display_path(&ctx.workspace_root, &file_path);
        // chunk 解析 + 行号范围校验（start<=end、1-indexed；target_content 非空）
        let chunks = parse_chunks(&args)?;

        // 2. 硬沙箱越权拒绝（T-D-08：Allowed 白名单下目标不在允许集 → 拒绝；
        //    未装配策略 = 不强制；先越权后互斥，串行叠加）
        crate::write_paths::check_write_allowance_for_ctx(ctx, &file_path)?;
        // 3. 写路径互斥声明（未接线 = None 不强制；接线后冲突报 tool.write_path_conflict）
        let _claim = claim_write_guard(ctx, &path_str, ClaimMode::Write)?;
        // 3. 探索类子代理写文档配额检查（未装配 = 放行，与 write_file 同款）
        crate::explore_quota::guard_explore_docs_write(ctx)?;

        // 4. 读入 + 解码（BOM 探测；二进制拒绝——对齐 diff.rs:111-116 语义）
        let bytes = std::fs::read(&file_path).map_err(|e| {
            ToolError::execution_failed(MULTI_REPLACE_TOOL_NAME, format!("{display}: {e}"))
        })?;
        let decoded = decode_text(&bytes);
        if decoded.is_binary {
            return Err(ToolError::execution_failed(
                MULTI_REPLACE_TOOL_NAME,
                format!("{display}: 二进制文件无法做文本替换"),
            ));
        }
        // 编码护栏（A1-H1，裁决 D4 fail-closed）：解码过程注入过 U+FFFD 的
        // 文件不是有效 UTF-8（疑似 GBK/latin1 等 legacy 编码），若继续写回
        // 将按 UTF-8 落盘、原编码字节被静默改写 → 此处拒绝（二进制拒绝在前，
        // 二进制分支标记恒 false，两错误语义不重叠；encode 侧零改动）
        if decoded.lossy_replaced {
            return Err(ToolError::execution_failed(
                MULTI_REPLACE_TOOL_NAME,
                format!(
                    "{display}: 文件不是有效 UTF-8（疑似 GBK/latin1 等 legacy 编码），拒绝替换以防破坏原编码字节；请先将文件转码为 UTF-8 再操作"
                ),
            ));
        }

        // 5. EOL 归一化：匹配统一按 \n，写回还原原文件风格（applyFileDiff.ts:287-297）
        let crlf_style = prefers_crlf(&decoded.text);
        let normalized = normalize_eol(&decoded.text);
        let text_len = normalized.len();
        // 行起始字节偏移表（行号 ↔ 字节坐标换算），总行数按 \n 切分（对齐 read_file）
        let line_starts = line_start_offsets(&normalized);
        let total_lines = normalized.lines().count();

        // 6. 逐 chunk 匹配：行号范围圈定候选区间 → 统计 target_content 出现次数；
        //    0 处失败 / >1 处且 allow_multiple=false 失败 / 其余记录替换区间
        let mut spans: Vec<ChunkSpan> = Vec::new();
        for (idx, chunk) in chunks.iter().enumerate() {
            let (lo, hi) = scope_range(
                &normalized, &line_starts, total_lines, text_len,
                chunk.start_line, chunk.end_line,
            );
            let scope = &normalized[lo..hi];
            let target = normalize_eol(&chunk.target_content);
            let hits = find_matches(scope, &target);
            if hits.is_empty() {
                return Err(chunk_not_found_error(idx, chunk, scope, &target, total_lines));
            }
            if hits.len() > 1 && !chunk.allow_multiple {
                return Err(chunk_multiple_error(idx, chunk, hits.len(), total_lines));
            }
            // 偏移换算回全文坐标，逐实例记录（allow_multiple=true 时全部替换）
            let replacement = normalize_eol(&chunk.replacement_content);
            for (rel_start, rel_end) in hits {
                spans.push(ChunkSpan {
                    start: lo + rel_start,
                    end: lo + rel_end,
                    replacement: replacement.clone(),
                });
            }
        }

        // 7. 区间重叠校验：chunk 间行区间不允许重叠（校验期拒绝，语义最直观）
        check_chunk_overlap(&chunks)?;

        // 8. 内存整体应用（一次重建全文，未触碰磁盘——层 1 原子性）
        let mut new_text = apply_all(&normalized, &spans);
        // 写回还原 EOL 风格：原文件含 CRLF → 全部还原 CRLF（preferEolStyle 语义）
        if crlf_style {
            new_text = new_text.replace('\n', "\r\n");
        }

        // 9. 一次性原子落盘（同目录临时文件 + rename；Windows 先 remove 再 rename）
        //    编码解析/编码直接复用 fs.rs 的 pub(crate) 实现（F5 本地镜像已去重）
        let encoding = crate::tools::fs::resolve_write_encoding(&file_path, None)?;
        let out_bytes = crate::tools::fs::encode_text(&new_text, &encoding)?;
        atomic_write(&file_path, &out_bytes)?;

        // 10. 配额消耗 + 输出（对齐 write_file 输出形状 fs.rs:210-217）
        crate::explore_quota::consume_explore_docs_quota(ctx);
        let tag = snapshot_tag(&file_path).unwrap_or_default();
        // 变更行数 = 各 chunk 目标行数与替换行数的较大者之和（text 摘要用）
        let lines_changed: usize = chunks
            .iter()
            .map(|c| {
                let target_lines = normalize_eol(&c.target_content).lines().count().max(1);
                let replacement_lines =
                    normalize_eol(&c.replacement_content).lines().count().max(1);
                target_lines.max(replacement_lines)
            })
            .sum();
        let text = format!(
            "Replaced {} chunks in {display} ({lines_changed} lines changed)\nSnapshot tag: {tag}",
            chunks.len(),
        );
        Ok(serde_json::json!({
            "path": display,
            "chunksApplied": chunks.len(),
            "newSnapshotTag": tag,
            "text": text,
        }))
    }
}

/// 单个替换块（对齐 04-EG方案.md 4.1 ReplacementChunk 草案）
struct ReplacementChunk {
    /// 搜索范围起始行号（1-indexed，闭区间）
    start_line: usize,
    /// 搜索范围结束行号（1-indexed，闭区间）
    end_line: usize,
    /// 要被替换的精确原文（含缩进空白，必须与文件严格匹配，含注释行）
    target_content: String,
    /// 替换后的新内容（需完整承载目标区间内的注释行）
    replacement_content: String,
    /// 范围内是否允许替换多个实例；默认 false（多处匹配报错）
    allow_multiple: bool,
}

/// 一次命中的替换区间（全文字节坐标，半开区间 start..end）
struct ChunkSpan {
    start: usize,
    end: usize,
    replacement: String,
}

/// 解析 replacement_chunks 入参：数组 + minItems 1 + 元素字段校验
/// （行号 1-indexed 正整数；start<=end；target_content 非空；allow_multiple 缺省 false）
fn parse_chunks(args: &serde_json::Value) -> Result<Vec<ReplacementChunk>, ToolError> {
    let arr = args
        .get("replacement_chunks")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| ToolError::invalid_input("replacement_chunks must be an array"))?;
    if arr.is_empty() {
        return Err(ToolError::invalid_input(
            "replacement_chunks must contain at least one chunk (minItems 1)",
        ));
    }
    let mut chunks = Vec::with_capacity(arr.len());
    for (i, item) in arr.iter().enumerate() {
        let obj = item.as_object().ok_or_else(|| {
            ToolError::invalid_input(format!("replacement_chunks[{i}] must be an object"))
        })?;
        let start_line = chunk_line_number(obj, "start_line", i)?;
        let end_line = chunk_line_number(obj, "end_line", i)?;
        if start_line > end_line {
            return Err(ToolError::invalid_input(format!(
                "replacement_chunks[{i}]: start_line ({start_line}) must be <= end_line ({end_line})"
            )));
        }
        let target_content = chunk_string(obj, "target_content", i)?;
        // replacement_content 可为空串（纯删除语义）；target_content 非空
        let replacement_content = chunk_string_allow_empty(obj, "replacement_content", i)?;
        // allow_multiple 缺省 false（对齐 schema default）
        let allow_multiple = obj
            .get("allow_multiple")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        chunks.push(ReplacementChunk {
            start_line,
            end_line,
            target_content,
            replacement_content,
            allow_multiple,
        });
    }
    Ok(chunks)
}

/// 解析 chunk 行号：必须为正整数（≥1）；接受整数或整数值浮点（模型常发 3.0）
fn chunk_line_number(
    obj: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    idx: usize,
) -> Result<usize, ToolError> {
    let label = format!("replacement_chunks[{idx}].{key}");
    let v = obj
        .get(key)
        .ok_or_else(|| ToolError::invalid_input(format!("{label} is required")))?;
    let n: u64 = if let Some(u) = v.as_u64() {
        u
    } else if let Some(i) = v.as_i64() {
        if i < 1 {
            return Err(ToolError::invalid_input(format!(
                "{label} must be a positive integer"
            )));
        }
        i as u64
    } else if let Some(f) = v.as_f64() {
        if !f.is_finite() || f.fract() != 0.0 || f < 1.0 {
            return Err(ToolError::invalid_input(format!(
                "{label} must be a positive integer"
            )));
        }
        f as u64
    } else {
        return Err(ToolError::invalid_input(format!(
            "{label} must be a positive integer"
        )));
    };
    if n == 0 {
        return Err(ToolError::invalid_input(format!("{label} must be >= 1")));
    }
    usize::try_from(n).map_err(|_| ToolError::invalid_input(format!("{label} is out of range")))
}

/// chunk 字符串字段（非空）
fn chunk_string(
    obj: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    idx: usize,
) -> Result<String, ToolError> {
    let s = chunk_string_allow_empty(obj, key, idx)?;
    if s.is_empty() {
        return Err(ToolError::invalid_input(format!(
            "replacement_chunks[{idx}].{key} must not be empty"
        )));
    }
    Ok(s)
}

/// chunk 字符串字段（允许空串：replacement_content 的纯删除语义）
fn chunk_string_allow_empty(
    obj: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    idx: usize,
) -> Result<String, ToolError> {
    obj.get(key)
        .and_then(serde_json::Value::as_str)
        .map(String::from)
        .ok_or_else(|| {
            ToolError::invalid_input(format!("replacement_chunks[{idx}].{key} must be a string"))
        })
}

/// EOL 归一化：CRLF 与 CR 统一为 LF（对齐 applyFileDiff.ts:287-289 normalizeEol）
fn normalize_eol(s: &str) -> String {
    if !s.contains('\r') {
        return s.to_string();
    }
    s.replace("\r\n", "\n").replace('\r', "\n")
}

/// 原文件偏好 CRLF？写回时还原（对齐 applyFileDiff.ts:292-296 preferEolStyle）
fn prefers_crlf(s: &str) -> bool {
    s.contains("\r\n")
}

/// 行起始字节偏移表：offset[i] = 第 i+1 行的起始字节（末尾追加文件末尾哨兵）
fn line_start_offsets(text: &str) -> Vec<usize> {
    let mut starts = vec![0usize];
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            starts.push(i + 1);
        }
    }
    starts
}

/// 行号范围圈定：返回 [start_line, end_line] 闭区间对应的字节范围
///
/// - end 越界钳制到文件末尾（end > 总行数时只搜到文件末尾）；
/// - start 超出文件末尾 → 空区间（自然落到「0 处匹配」错误路径）；
/// - 末行行尾换行剔除：区间文本不含行尾终止符，对齐「行区间 join」语义。
fn scope_range(
    text: &str,
    line_starts: &[usize],
    total_lines: usize,
    text_len: usize,
    start: usize,
    end: usize,
) -> (usize, usize) {
    if start > total_lines {
        return (text_len, text_len);
    }
    let lo = line_starts[start - 1];
    let hi_clamped = end.min(total_lines);
    let mut hi = line_starts
        .get(hi_clamped)
        .copied()
        .unwrap_or(text_len)
        .min(text_len);
    if hi > lo && text.as_bytes()[hi - 1] == b'\n' {
        hi -= 1;
    }
    (lo, hi)
}

/// 收集 needle 在 haystack 中的全部非重叠匹配（字节坐标；对齐 TS countOccurrences
/// 的非重叠计数语义：命中后从命中尾继续查找）
fn find_matches(haystack: &str, needle: &str) -> Vec<(usize, usize)> {
    haystack
        .match_indices(needle)
        .map(|(i, m)| (i, i + m.len()))
        .collect()
}

/// 区间重叠校验：chunk 间行区间 [start_line, end_line] 不允许重叠（校验期拒绝，
/// 语义最直观、测试最稳定——04-EG方案.md 4.1 第 7 步推荐定稿）
fn check_chunk_overlap(chunks: &[ReplacementChunk]) -> Result<(), ToolError> {
    for i in 0..chunks.len() {
        for j in (i + 1)..chunks.len() {
            let a = &chunks[i];
            let b = &chunks[j];
            if a.start_line <= b.end_line && b.start_line <= a.end_line {
                return Err(ToolError::execution_failed(
                    MULTI_REPLACE_TOOL_NAME,
                    format!(
                        "chunks 行区间重叠：chunk #{}（行 {}-{}）与 chunk #{}（行 {}-{}）区间不允许重叠；文件未做任何修改",
                        i + 1, a.start_line, a.end_line, j + 1, b.start_line, b.end_line,
                    ),
                ));
            }
        }
    }
    Ok(())
}

/// 内存整体应用：按字节偏移把全部替换区间一次性重建全文。
/// 区间已通过重叠校验（行区间不相交 → 字节区间必然不相交），按起点排序
/// 保证替换顺序与原文位置一致（防御性检查：相邻区间不允许重叠）。
fn apply_all(text: &str, spans: &[ChunkSpan]) -> String {
    let mut sorted: Vec<&ChunkSpan> = spans.iter().collect();
    sorted.sort_by_key(|s| s.start);
    let mut out = String::with_capacity(text.len() + 64);
    let mut pos = 0usize;
    for span in sorted {
        debug_assert!(span.start >= pos, "替换区间重叠（防御性检查）");
        out.push_str(&text[pos..span.start]);
        out.push_str(&span.replacement);
        pos = span.end;
    }
    out.push_str(&text[pos..]);
    out
}

/// chunk 匹配失败错误：0 处命中（含失败 chunk 序号 + 原因 + 「文件未做任何修改」）
fn chunk_not_found_error(
    idx: usize,
    chunk: &ReplacementChunk,
    scope: &str,
    target: &str,
    total_lines: usize,
) -> ToolError {
    let mut detail = if chunk.start_line > total_lines {
        format!(
            "行 {}-{} 超出文件末尾（文件共 {total_lines} 行）",
            chunk.start_line, chunk.end_line
        )
    } else {
        format!(
            "{} 内未找到 target_content，允许范围 {}..={}，文件共 {total_lines} 行",
            range_display(chunk.start_line, chunk.end_line.min(total_lines)),
            chunk.start_line,
            chunk.end_line,
        )
    };
    // 常见失败提示：target_content 携带行尾换行时提示去除（与行区间 join 语义对齐）
    let trimmed = target.trim_end_matches('\n');
    if trimmed.len() < target.len() && !find_matches(scope, trimmed).is_empty() {
        detail.push_str("；提示：target_content 末尾含多余换行符，请去除后再试");
    }
    chunk_error(idx, detail)
}

/// chunk 匹配失败错误：范围内多处匹配且 allow_multiple=false
fn chunk_multiple_error(
    idx: usize,
    chunk: &ReplacementChunk,
    hits: usize,
    total_lines: usize,
) -> ToolError {
    chunk_error(
        idx,
        format!(
            "{} 内出现 {hits} 处匹配（allow_multiple=false），允许范围 {}..={}，文件共 {total_lines} 行",
            range_display(chunk.start_line, chunk.end_line.min(total_lines)),
            chunk.start_line,
            chunk.end_line,
        ),
    )
}

/// 失败 chunk 错误形状：message 含 chunk 序号 + 原因 + 明示「文件未做任何修改」
fn chunk_error(idx: usize, detail: String) -> ToolError {
    ToolError::execution_failed(
        MULTI_REPLACE_TOOL_NAME,
        format!("chunk #{} 匹配失败（{detail}）；文件未做任何修改", idx + 1),
    )
}

/// 行区间展示：单行合并为「行 N」，多行显示「行 N-M」
fn range_display(start: usize, end: usize) -> String {
    if start == end {
        format!("行 {start}")
    } else {
        format!("行 {start}-{end}")
    }
}

/// 原子落盘：同目录临时文件 `<name>.agent-tmp-<pid>-<n>` + rename 交换。
///
/// - 临时文件用 create_new 独占创建（防碰撞，n 递增重试）；
/// - Windows 上 rename 不覆盖既有目标，先 remove 再 rename（04-EG方案.md 4.1
///   第 9 步；在写路径互斥 + 写前快照兜底前提下为既定一致方案）；
/// - rename 失败时清理临时文件，不留残骸。
///
/// G2 禁令豁免（clippy.toml disallowed-methods）：本函数 remove 的是「被本次
/// 写盘取代的旧文件自身」，属原子写盘交换语义而非删除接口（04-EG方案.md 4.2
/// 层 4 定稿），进回收站反而不正确（旧态被新态取代，恢复语义由写前快照承担）；
/// 与 clippy.toml 豁免面「自管文件轮转」同性质，函数级 allow + 理由。
#[allow(clippy::disallowed_methods)]
fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), ToolError> {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let base = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let mut tmp: Option<std::path::PathBuf> = None;
    for i in 0..128u32 {
        let candidate = parent.join(format!("{base}.agent-tmp-{}-{i}", std::process::id()));
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(mut f) => {
                use std::io::Write;
                if let Err(e) = f.write_all(bytes) {
                    let _ = std::fs::remove_file(&candidate);
                    return Err(ToolError::execution_failed(
                        MULTI_REPLACE_TOOL_NAME,
                        format!("{}: 写入临时文件失败: {e}", target.display()),
                    ));
                }
                tmp = Some(candidate);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(ToolError::execution_failed(
                    MULTI_REPLACE_TOOL_NAME,
                    format!("{}: 创建临时文件失败: {e}", target.display()),
                ));
            }
        }
    }
    let tmp = tmp.ok_or_else(|| {
        ToolError::execution_failed(
            MULTI_REPLACE_TOOL_NAME,
            format!("{}: 创建临时文件失败（重试耗尽）", target.display()),
        )
    })?;

    // Windows：rename 不覆盖既有文件，先 remove 再 rename（§4.1 第 9 步）
    #[cfg(windows)]
    {
        if target.exists() {
            std::fs::remove_file(target).map_err(|e| {
                ToolError::execution_failed(
                    MULTI_REPLACE_TOOL_NAME,
                    format!("{}: 删除旧文件失败: {e}", target.display()),
                )
            })?;
        }
    }

    if let Err(e) = std::fs::rename(&tmp, target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(ToolError::execution_failed(
            MULTI_REPLACE_TOOL_NAME,
            format!("{}: 原子替换失败: {e}", target.display()),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// （原编码解析/编码本地镜像 resolve_write_encoding / encode_text 已于 F7 可见性
// 收尾后删除——直接复用 fs.rs:368/402 的 pub(crate) 实现，行为同构不再双份维护）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    // G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use crate::context::{create_mock_tool_context, ToolContext};
    use crate::tools::fs::WriteFileTool;
    use conex_test_utils::TempWorkspace;
    use serde_json::json;

    /// 测试用会话上下文：workspace_root 指向临时工作区（对齐 fs.rs:631-636 模式）
    fn mock_ctx(ws: &TempWorkspace) -> ToolContext {
        ToolContext {
            workspace_root: ws.path().clone(),
            ..create_mock_tool_context()
        }
    }

    /// 工具实例（无状态，共享）
    fn tool() -> MultiReplaceFileTool {
        MultiReplaceFileTool::new()
    }

    /// 读取文件原始字节（回滚/等价断言用，避免 EOL 或编码二次解释）
    fn raw_bytes(ws: &TempWorkspace, rel: &str) -> Vec<u8> {
        std::fs::read(ws.path().join(rel)).unwrap()
    }

    /// 对标 legacy e2e 黄金用例（REQ-EG-现状分析.md 1.10）：初始 5 行组件
    const COMPONENT_TS_INITIAL: &str = "\
import React from 'react';
function Component() {
  const [count, setCount] = useState(0);
  return <div>{count}</div>;
}
";

    /// 三块替换后的期望形态（= legacy e2e 中 replacedCode 的期望）
    const COMPONENT_TS_EXPECTED: &str = "\
import React, { useState } from 'react';
function Component() {
  const [count, setCount] = useState(10);
  return <button>{count}</button>;
}
";

    /// 黄金用例三块入参（头 import + 中部字段 + 尾部 JSX，互不连续）
    fn golden_chunks_args() -> serde_json::Value {
        json!({
            "target_file": "src/component.ts",
            "replacement_chunks": [
                {
                    "start_line": 1,
                    "end_line": 1,
                    "target_content": "import React from 'react';",
                    "replacement_content": "import React, { useState } from 'react';"
                },
                {
                    "start_line": 3,
                    "end_line": 3,
                    "target_content": "  const [count, setCount] = useState(0);",
                    "replacement_content": "  const [count, setCount] = useState(10);"
                },
                {
                    "start_line": 4,
                    "end_line": 4,
                    "target_content": "  return <div>{count}</div>;",
                    "replacement_content": "  return <button>{count}</button>;"
                }
            ]
        })
    }

    // ==================== schema 契约（04-EG方案.md 4.1 全文） ====================

    #[test]
    fn multi_replace_schema_matches_contract() {
        // 对齐 04-EG方案.md 4.1 JSON schema 草案：名称 / 危险标记 / 失败语义
        let t = tool();
        assert_eq!(t.name(), "multi_replace_file_content");
        let def = t.definition();
        assert!(def.dangerous);
        assert!(!def.fatal_on_error);
        assert!(def.description.contains("精确原文"));
        assert!(def.description.contains("replacement_content"));
        assert!(def.description.contains("注释"));

        let schema = &def.input_schema;
        // 顶层形状：object + required + additionalProperties false
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["additionalProperties"], false);
        assert!(schema["required"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "target_file"));
        assert!(schema["required"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "replacement_chunks"));

        // replacement_chunks：数组 minItems 1，元素 additionalProperties false
        let chunks_schema = &schema["properties"]["replacement_chunks"];
        assert_eq!(chunks_schema["type"], "array");
        assert_eq!(chunks_schema["minItems"], 1);
        let item = &chunks_schema["items"];
        assert_eq!(item["additionalProperties"], false);
        assert_eq!(item["type"], "object");
        // 行号字段 minimum 1（1-indexed）
        assert_eq!(item["properties"]["start_line"]["minimum"], 1);
        assert_eq!(item["properties"]["end_line"]["minimum"], 1);
        // allow_multiple 缺省 false
        assert_eq!(item["properties"]["allow_multiple"]["default"], false);
        // required 四个字段齐全
        let required: Vec<&str> = item["required"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        for field in ["start_line", "end_line", "target_content", "replacement_content"] {
            assert!(required.contains(&field), "缺失 required 字段 {field}");
        }
    }

    // ==================== 黄金用例：多块替换（REQ-E01 验收 1） ====================

    #[tokio::test]
    async fn multi_replace_multiple_chunks_golden_e2e() {
        // 对标 legacy e2e 黄金场景（现状分析 1.10）：三块非连续替换全部生效
        let ws = TempWorkspace::new("mrepl_golden");
        ws.write_file("src/component.ts", COMPONENT_TS_INITIAL);
        let out = tool().execute(&mock_ctx(&ws), golden_chunks_args()).await.unwrap();

        // 输出形状：path / chunksApplied / newSnapshotTag / text（对齐 write_file）
        assert_eq!(out["path"], "src/component.ts");
        assert_eq!(out["chunksApplied"], 3);
        let tag = out["newSnapshotTag"].as_str().unwrap();
        assert_eq!(tag.len(), 12);
        assert!(out["text"].as_str().unwrap().contains("Replaced 3 chunks in src/component.ts"));
        assert!(out["text"].as_str().unwrap().contains("Snapshot tag:"));

        // 三处修改全部生效，未覆盖内容原样
        assert_eq!(ws.read_file("src/component.ts"), COMPONENT_TS_EXPECTED);
    }

    // ==================== 任一失败回滚（REQ-E01 验收 2） ====================

    #[tokio::test]
    async fn multi_replace_any_failure_rolls_back_file_unchanged() {
        // chunk#2 target_content 少一个空格（精确匹配失败）→ 报错 + 文件字节不变
        let ws = TempWorkspace::new("mrepl_rollback");
        ws.write_file("src/component.ts", COMPONENT_TS_INITIAL);
        let before = raw_bytes(&ws, "src/component.ts");
        let mut args = golden_chunks_args();
        // chunk#2 target_content 少一个空格（= 与 useState 之间的空格缺失）→
        // 不再与文件严格匹配，0 处命中
        args["replacement_chunks"][1]["target_content"] =
            json!("  const [count, setCount] =useState(0);");

        let err = tool().execute(&mock_ctx(&ws), args).await.unwrap_err();
        // 错误形状：失败 chunk 序号 + 原因 + 「文件未做任何修改」
        assert!(err.to_string().contains("chunk #2"), "错误应含失败 chunk 序号");
        assert!(err.to_string().contains("未找到 target_content"));
        assert!(err.to_string().contains("文件未做任何修改"));
        // 回滚：文件字节与调用前完全一致
        assert_eq!(raw_bytes(&ws, "src/component.ts"), before, "文件必须保持原状");
    }

    // ==================== 与手工修改等价（REQ-E01 验收 3） ====================

    #[tokio::test]
    async fn multi_replace_equivalent_to_write_file_rewrite() {
        // 相同修改：multi_replace（3 chunks）与 write_file 全量重写 → 两文件字节一致
        let ws = TempWorkspace::new("mrepl_equiv");
        ws.write_file("src/a.ts", COMPONENT_TS_INITIAL);
        ws.write_file("src/b.ts", COMPONENT_TS_INITIAL);

        let mut args = golden_chunks_args();
        args["target_file"] = json!("src/a.ts");
        tool().execute(&mock_ctx(&ws), args).await.unwrap();
        WriteFileTool::new()
            .execute(&mock_ctx(&ws), json!({ "path": "src/b.ts", "content": COMPONENT_TS_EXPECTED, "overwrite": true }))
            .await
            .unwrap();

        assert_eq!(
            raw_bytes(&ws, "src/a.ts"),
            raw_bytes(&ws, "src/b.ts"),
            "multi_replace 结果与全量重写字节必须一致"
        );
    }

    // ==================== allow_multiple 判定 ====================

    #[tokio::test]
    async fn multi_replace_allow_multiple_false_rejects_duplicates() {
        // 重复片段在范围内 2 处，allow_multiple 缺省 false → 报错、不写盘
        let ws = TempWorkspace::new("mrepl_dupe");
        ws.write_file("d.txt", "AAA\nBBB\nAAA\nCCC\n");
        let before = raw_bytes(&ws, "d.txt");

        let err = tool()
            .execute(
                &mock_ctx(&ws),
                json!({
                    "target_file": "d.txt",
                    "replacement_chunks": [
                        { "start_line": 1, "end_line": 4, "target_content": "AAA", "replacement_content": "ZZZ" }
                    ]
                }),
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("chunk #1"));
        assert!(err.to_string().contains("2 处匹配"));
        assert!(err.to_string().contains("allow_multiple=false"));
        assert!(err.to_string().contains("文件未做任何修改"));
        assert_eq!(raw_bytes(&ws, "d.txt"), before, "多处匹配报错必须不写盘");
    }

    #[tokio::test]
    async fn multi_replace_allow_multiple_true_replaces_all() {
        // allow_multiple=true → 范围内全部实例都被替换（对齐 1.9 测试映射）
        let ws = TempWorkspace::new("mrepl_multi_true");
        ws.write_file("d.txt", "AAA\nBBB\nAAA\nCCC\n");

        let out = tool()
            .execute(
                &mock_ctx(&ws),
                json!({
                    "target_file": "d.txt",
                    "replacement_chunks": [
                        {
                            "start_line": 1, "end_line": 4,
                            "target_content": "AAA",
                            "replacement_content": "ZZZ",
                            "allow_multiple": true
                        }
                    ]
                }),
            )
            .await
            .unwrap();
        assert_eq!(out["chunksApplied"], 1);
        assert_eq!(ws.read_file("d.txt"), "ZZZ\nBBB\nZZZ\nCCC\n");
    }

    // ==================== 行号范围圈定 ====================

    #[tokio::test]
    async fn multi_replace_line_range_scoping() {
        // target 在范围内 1 处、范围外 1 处 → 只替换范围内（范围外不动）
        let ws = TempWorkspace::new("mrepl_scope");
        ws.write_file("s.txt", "AAA\nBBB\nAAA\n");

        tool()
            .execute(
                &mock_ctx(&ws),
                json!({
                    "target_file": "s.txt",
                    "replacement_chunks": [
                        { "start_line": 1, "end_line": 1, "target_content": "AAA", "replacement_content": "ZZZ" }
                    ]
                }),
            )
            .await
            .unwrap();

        assert_eq!(ws.read_file("s.txt"), "ZZZ\nBBB\nAAA\n", "范围外同名内容不得改动");
    }

    // ==================== chunks=1 等价单块（REQ-E01 1.3） ====================

    #[tokio::test]
    async fn multi_replace_single_chunk_equals_single_block() {
        // 单 chunk 调用即单块替换语义（E-3 决策落地，现状分析 1.6.4）
        let ws = TempWorkspace::new("mrepl_single");
        ws.write_file("x.rs", "fn main() {\n    println!(\"hi\");\n}\n");

        let out = tool()
            .execute(
                &mock_ctx(&ws),
                json!({
                    "target_file": "x.rs",
                    "replacement_chunks": [
                        {
                            "start_line": 2, "end_line": 2,
                            "target_content": "    println!(\"hi\");",
                            "replacement_content": "    println!(\"hello\");"
                        }
                    ]
                }),
            )
            .await
            .unwrap();

        assert_eq!(out["chunksApplied"], 1);
        assert_eq!(ws.read_file("x.rs"), "fn main() {\n    println!(\"hello\");\n}\n");
    }

    // ==================== 注释保留（REQ-E03 验收共用） ====================

    #[tokio::test]
    async fn multi_replace_preserves_comments() {
        // 替换中部字段：头部注释 / 行内注释 / 尾部 doc 注释原样保留；
        // replacement_content 承载注释行（E03 保险一：注释不得删除、修改或移位）
        let ws = TempWorkspace::new("mrepl_comments");
        let content = [
            "// 头部注释：模块说明",
            "function Component() {",
            "  // 行内注释：字段定义",
            "  const count = 0;",
            "}",
            "/// 尾部 doc 注释",
            "export { Component };",
        ]
        .join("\n");
        ws.write_file("c.rs", &content);

        tool()
            .execute(
                &mock_ctx(&ws),
                json!({
                    "target_file": "c.rs",
                    "replacement_chunks": [
                        {
                            "start_line": 4, "end_line": 4,
                            "target_content": "  const count = 0;",
                            "replacement_content": "  // 字段已更新为 10\n  const count = 10;"
                        }
                    ]
                }),
            )
            .await
            .unwrap();

        let result = ws.read_file("c.rs");
        // 未覆盖区间的注释原样保留
        assert!(result.contains("// 头部注释：模块说明"), "头部注释必须保留");
        assert!(result.contains("// 行内注释：字段定义"), "行内注释必须保留");
        assert!(result.contains("/// 尾部 doc 注释"), "尾部 doc 注释必须保留");
        // replacement_content 承载的注释行完整落地
        assert!(
            result.contains("  // 字段已更新为 10\n  const count = 10;"),
            "replacement_content 承载的注释行必须完整"
        );
        assert!(result.contains("export { Component };"));
    }

    // ==================== EOL 归一化（CRLF 文件匹配 LF 内容） ====================

    #[tokio::test]
    async fn multi_replace_crlf_matches_lf_content_and_restores_eol() {
        // CRLF 文件：target_content 用 LF 内容精确匹配，写回还原 CRLF 风格
        let ws = TempWorkspace::new("mrepl_crlf");
        let crlf_body = COMPONENT_TS_INITIAL.replace('\n', "\r\n");
        ws.write_file("src/component.ts", &crlf_body);

        tool().execute(&mock_ctx(&ws), golden_chunks_args()).await.unwrap();

        let bytes = raw_bytes(&ws, "src/component.ts");
        let result = String::from_utf8(bytes).unwrap();
        // 期望结果还原为 CRLF：换行全部为 \r\n，无残留独立 \n
        assert_eq!(result, COMPONENT_TS_EXPECTED.replace('\n', "\r\n"));
        assert_eq!(result.matches("\r\n").count(), result.matches('\n').count());
    }

    // ==================== 区间重叠拒绝 ====================

    #[tokio::test]
    async fn multi_replace_overlapping_ranges_rejected() {
        // 两个 chunk 行区间重叠（行 3 共享）→ 报错，文件不变
        let ws = TempWorkspace::new("mrepl_overlap");
        ws.write_file("src/component.ts", COMPONENT_TS_INITIAL);
        let before = raw_bytes(&ws, "src/component.ts");

        let err = tool()
            .execute(
                &mock_ctx(&ws),
                json!({
                    "target_file": "src/component.ts",
                    "replacement_chunks": [
                        {
                            "start_line": 1, "end_line": 3,
                            "target_content": "import React from 'react';",
                            "replacement_content": "import React, { useState } from 'react';"
                        },
                        {
                            "start_line": 3, "end_line": 5,
                            "target_content": "useState(0)",
                            "replacement_content": "useState(10)"
                        }
                    ]
                }),
            )
            .await
            .unwrap_err();

        assert!(err.to_string().contains("行区间重叠"));
        assert!(err.to_string().contains("chunk #1"));
        assert!(err.to_string().contains("chunk #2"));
        assert!(err.to_string().contains("文件未做任何修改"));
        assert_eq!(raw_bytes(&ws, "src/component.ts"), before);
    }

    // ==================== 编码续写（BOM 保留） ====================

    #[tokio::test]
    async fn multi_replace_preserves_utf16le_encoding() {
        // UTF-16LE（带 BOM）文件替换后仍按原编码写回（镜像 fs.rs 编码续写契约）
        let ws = TempWorkspace::new("mrepl_u16");
        let mut bytes = vec![0xFF, 0xFE];
        for u in "line one\nline two\n".encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        std::fs::write(ws.path().join("u.txt"), &bytes).unwrap();

        tool()
            .execute(
                &mock_ctx(&ws),
                json!({
                    "target_file": "u.txt",
                    "replacement_chunks": [
                        {
                            "start_line": 1, "end_line": 1,
                            "target_content": "line one",
                            "replacement_content": "line one changed"
                        }
                    ]
                }),
            )
            .await
            .unwrap();

        let after = raw_bytes(&ws, "u.txt");
        assert!(after.starts_with(&[0xFF, 0xFE]), "必须保留 UTF-16LE BOM");
        let text: String = after[2..]
            .chunks_exact(2)
            .map(|c| {
                let u = u16::from_le_bytes([c[0], c[1]]);
                char::from_u32(u as u32).unwrap()
            })
            .collect();
        assert_eq!(text, "line one changed\nline two\n");
    }

    #[tokio::test]
    async fn multi_replace_rejects_legacy_encoding() {
        // GBK「中文」（D6 D0 CE C4）：无 NUL 的 legacy 编码文件过去被
        // lossy 解码为 U+FFFD 后按 UTF-8 写回（原字节被静默破坏）；
        // 编码护栏（A1-H1，裁决 D4 fail-closed）→ 结构化拒绝，文件字节零改动
        let ws = TempWorkspace::new("mrepl_legacy");
        let gbk: Vec<u8> = vec![0xD6, 0xD0, 0xCE, 0xC4];
        std::fs::write(ws.path().join("gbk.txt"), &gbk).unwrap();
        let before = raw_bytes(&ws, "gbk.txt");

        let err = tool()
            .execute(
                &mock_ctx(&ws),
                json!({
                    "target_file": "gbk.txt",
                    "replacement_chunks": [
                        { "start_line": 1, "end_line": 1, "target_content": "x", "replacement_content": "y" }
                    ]
                }),
            )
            .await
            .unwrap_err();

        assert!(err.to_string().contains("legacy 编码"), "错误文案必须含 legacy 编码引导");
        assert!(err.to_string().contains("转码为 UTF-8"), "错误文案必须含转码引导");
        assert_eq!(
            raw_bytes(&ws, "gbk.txt"),
            before,
            "编码护栏拒绝后文件字节必须零改动"
        );
    }

    // ==================== 入参校验与错误路径 ====================

    #[tokio::test]
    async fn multi_replace_invalid_inputs_rejected() {
        let ws = TempWorkspace::new("mrepl_badinput");
        ws.write_file("x.txt", "hello\n");

        // start_line > end_line → 结构化入参错误
        let err = tool()
            .execute(
                &mock_ctx(&ws),
                json!({
                    "target_file": "x.txt",
                    "replacement_chunks": [
                        { "start_line": 5, "end_line": 3, "target_content": "a", "replacement_content": "b" }
                    ]
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");

        // 空数组（违反 minItems 1）
        let err = tool()
            .execute(&mock_ctx(&ws), json!({ "target_file": "x.txt", "replacement_chunks": [] }))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");

        // 行号 0（违反 minimum 1）
        let err = tool()
            .execute(
                &mock_ctx(&ws),
                json!({
                    "target_file": "x.txt",
                    "replacement_chunks": [
                        { "start_line": 0, "end_line": 1, "target_content": "a", "replacement_content": "b" }
                    ]
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.invalid_input");

        // 空 target_content（空串会导致全文件匹配，拒绝）
        let err = tool()
            .execute(
                &mock_ctx(&ws),
                json!({
                    "target_file": "x.txt",
                    "replacement_chunks": [
                        { "start_line": 1, "end_line": 1, "target_content": "", "replacement_content": "b" }
                    ]
                }),
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("target_content"));
    }

    #[tokio::test]
    async fn multi_replace_missing_binary_and_escape_errors() {
        let ws = TempWorkspace::new("mrepl_errs");
        ws.write_file("x.txt", "hello\n");

        // 路径越界 → tool.path_escape（复用 resolve_workspace_path 安全校验）
        let err = tool()
            .execute(
                &mock_ctx(&ws),
                json!({
                    "target_file": "../outside.txt",
                    "replacement_chunks": [
                        { "start_line": 1, "end_line": 1, "target_content": "a", "replacement_content": "b" }
                    ]
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.path_escape");

        // 目标文件不存在 → tool.execution_failed
        let err = tool()
            .execute(
                &mock_ctx(&ws),
                json!({
                    "target_file": "ghost.txt",
                    "replacement_chunks": [
                        { "start_line": 1, "end_line": 1, "target_content": "a", "replacement_content": "b" }
                    ]
                }),
            )
            .await
            .unwrap_err();
        assert_eq!(err.code(), "tool.execution_failed");

        // 二进制文件（含 NUL 字节）→ 拒绝替换（对齐 diff.rs 语义）
        let p = ws.path().join("bin.dat");
        std::fs::write(&p, [0u8, 1u8, 2u8, 3u8]).unwrap();
        let err = tool()
            .execute(
                &mock_ctx(&ws),
                json!({
                    "target_file": "bin.dat",
                    "replacement_chunks": [
                        { "start_line": 1, "end_line": 1, "target_content": "a", "replacement_content": "b" }
                    ]
                }),
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("二进制"));

        // 行号范围超出文件末尾 → 0 处匹配的失败 chunk 错误（含明确提示）
        let err = tool()
            .execute(
                &mock_ctx(&ws),
                json!({
                    "target_file": "x.txt",
                    "replacement_chunks": [
                        { "start_line": 10, "end_line": 20, "target_content": "hello", "replacement_content": "world" }
                    ]
                }),
            )
            .await
            .unwrap_err();
        assert!(err.to_string().contains("超出文件末尾"));
        assert!(err.to_string().contains("文件共 1 行"));
    }
}
