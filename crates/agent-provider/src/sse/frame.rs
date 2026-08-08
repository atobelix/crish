//! SSE 分帧层（任务书 B2.3；02-provider-semantics.md §二.1、§六.1）
//!
//! 增量字节流 → [SseFrame]：
//! - 分隔符 `\n\n` / `\r\n\r\n`，取更早出现的合法边界；`\r\n\n` 场景按 2 字节
//!   处理避免吞帧（对齐 TS findSseSeparator / sseSeparatorLength）
//! - `data:` 多行以 `\n` 连接聚合；event/id/retry 字段聚合
//! - `[DONE]` 流终止哨兵识别
//! - 注释行（`:` 开头）与非 JSON keep-alive 跳过，不炸流
//! - 残留 buffer 保留到下一批；跨 chunk UTF-8 增量解码（std::str::from_utf8
//!   保留不完整多字节序列）

use serde_json::Value;
use thiserror::Error;

/// 单帧（event/data/id/retry 字段聚合）
///
/// `data` 为聚合后的字符串（对齐 TS parseSseFrame 的输入形态），
/// `[DONE]` 时 data 为哨兵串 "[DONE]"。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseFrame {
    /// `event:` 字段（SSE 规范字段；多行取最后一个）
    pub event: Option<String>,
    /// `data:` 行聚合（多行以 `\n` 连接）
    pub data: Option<String>,
    /// `id:` 字段（SSE 规范字段；多行取最后一个）
    pub id: Option<String>,
    /// `retry:` 字段（SSE 规范字段；非数字忽略）
    pub retry: Option<u64>,
}

impl SseFrame {
    /// `[DONE]` 哨兵识别（02 §二.1：流终止）
    pub fn is_done(&self) -> bool {
        self.data.as_deref() == Some("[DONE]")
    }
}

/// 分帧层错误（02 §二.1）
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SseFrameError {
    /// 流内出现无法按 UTF-8 解码的字节序列（增量解码无法恢复）
    #[error("SSE 流含无效 UTF-8 字节序列")]
    InvalidUtf8,
    /// data 形似 JSON（`{`/`[` 开头）但解析失败 → invalid-stream
    /// （对应 TS MalformedSseFrameError，02 §二.1:318-327,345-356）
    #[error("Malformed SSE JSON data frame: {raw}")]
    MalformedSseFrame {
        /// 解析失败的 data 原文
        raw: String,
    },
}

/// 增量 SSE 分帧器（跨 push 调用保持状态）
#[derive(Debug, Default)]
pub struct SseParser {
    /// 未解码的原始字节残留（含跨 chunk 的不完整多字节序列）
    buffer: Vec<u8>,
    /// 已解码但尚未到达帧边界的内容
    pending: String,
    /// 已识别 `[DONE]`，流终结
    done: bool,
}

impl SseParser {
    /// 新建分帧器
    pub fn new() -> Self {
        Self::default()
    }

    /// 流是否已以 `[DONE]` 终结
    pub fn is_done(&self) -> bool {
        self.done
    }

    /// 追加一批字节，产出完整帧
    ///
    /// `[DONE]` 哨兵帧会包含在返回中（`is_done()` 可识别），之后该帧同批的
    /// 后续内容以及后续 push 的输入都会被丢弃（对齐 TS 遇 [DONE] 立即 return）。
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<SseFrame>, SseFrameError> {
        if self.done {
            return Ok(Vec::new());
        }
        self.buffer.extend_from_slice(bytes);
        let decoded = self.decode_utf8()?;
        self.pending.push_str(&decoded);
        self.split_frames()
    }

    /// 流结束收尾：尝试解析末尾未分帧的残留内容（02 §二.1:169-179、§六.1）
    ///
    /// - 残留为空白 → 无帧；
    /// - 残留含不完整 UTF-8 序列 → [SseFrameError::InvalidUtf8]；
    /// - 残留为 `[DONE]` → 哨兵被消费，不产出帧；
    /// - `[DONE]` 之后调用 → 空。
    pub fn finish(&mut self) -> Result<Vec<SseFrame>, SseFrameError> {
        if self.done {
            return Ok(Vec::new());
        }
        let decoded = self.decode_utf8()?;
        self.pending.push_str(&decoded);
        let mut frames = self.split_frames()?;
        if !self.done && !self.pending.trim().is_empty() {
            let body = std::mem::take(&mut self.pending);
            if let Some(frame) = parse_frame_body(&body)? {
                if frame.is_done() {
                    // EOF 残留的 [DONE]：只消费不产出（对齐 TS `parsed !== '[DONE]'`）
                    self.done = true;
                } else {
                    frames.push(frame);
                }
            }
        }
        self.done = true;
        Ok(frames)
    }

    /// 增量 UTF-8 解码：消费合法前缀，尾部不完整多字节序列保留到下一批
    ///
    /// 注意（AA-01 Q19 / PE-06 T06.3「预期保留」）：下方两处
    /// `String::from_utf8(...).expect(...)` 属**合理 expect**——前置
    /// `from_utf8` 校验保证安全，文档记录为正面保留项，勿删勿改
    /// （锁 expect 治理范围 PE-07 T07.6 亦不含此处）。
    fn decode_utf8(&mut self) -> Result<String, SseFrameError> {
        match std::str::from_utf8(&self.buffer) {
            Ok(_) => {
                let bytes = std::mem::take(&mut self.buffer);
                Ok(String::from_utf8(bytes).expect("已校验为合法 UTF-8"))
            }
            Err(err) => {
                if err.error_len().is_some() {
                    return Err(SseFrameError::InvalidUtf8);
                }
                // error_len 为 None：尾部是未完成的字符序列，等下一批字节补全
                let valid_up_to = err.valid_up_to();
                let tail: Vec<u8> = self.buffer.drain(..valid_up_to).collect();
                Ok(String::from_utf8(tail).expect("前缀已校验为合法 UTF-8"))
            }
        }
    }

    /// 从 pending 中切出尽可能多的完整帧；命中 `[DONE]` 立即终结并丢弃其后内容
    fn split_frames(&mut self) -> Result<Vec<SseFrame>, SseFrameError> {
        let mut frames = Vec::new();
        while !self.done {
            let Some(index) = find_separator(&self.pending) else {
                break;
            };
            let sep_len = separator_len(&self.pending, index);
            let body = self.pending[..index].to_owned();
            self.pending.drain(..index + sep_len);
            if let Some(frame) = parse_frame_body(&body)? {
                if frame.is_done() {
                    self.done = true;
                }
                frames.push(frame);
            }
        }
        Ok(frames)
    }
}

/// 定位更早出现的合法帧边界（对齐 TS findSseSeparator，02 §二.1:297-307）
fn find_separator(text: &str) -> Option<usize> {
    let lf = text.find("\n\n");
    let crlf = text.find("\r\n\r\n");
    match (lf, crlf) {
        (None, None) => None,
        (Some(i), None) | (None, Some(i)) => Some(i),
        (Some(a), Some(b)) => Some(a.min(b)),
    }
}

/// 帧边界字节长度：`\r\n\r\n` 为 4，`\n\n` 为 2
///
/// `\r\n\n` 场景按 2 字节处理避免吞帧（对齐 TS sseSeparatorLength 310-315）：
/// 边界前的 `\r` 属于上一行的行尾，由帧体解析时的行 trim 消化。
fn separator_len(text: &str, index: usize) -> usize {
    if text[index..].starts_with("\r\n\r\n") {
        4
    } else {
        2
    }
}

/// 解析帧体：聚合 `data:` 行、收集 event/id/retry 字段（02 §二.1）
///
/// - 无 data 行 → 不产出帧（对齐 TS `if (!data) return null`）；
/// - `[DONE]` → 哨兵帧；
/// - data 形似 JSON（`{`/`[` 开头）但解析失败 → [SseFrameError::MalformedSseFrame]；
/// - 合法 JSON 但非 object（array/string/number/null）→ 跳过；
/// - 非 JSON keep-alive（如 `data: ping`）→ 跳过，不炸流（02 §二.1:357-358）。
fn parse_frame_body(body: &str) -> Result<Option<SseFrame>, SseFrameError> {
    let mut event: Option<String> = None;
    let mut id: Option<String> = None;
    let mut retry: Option<u64> = None;
    let mut data_lines: Vec<&str> = Vec::new();

    for line in body.split('\n') {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.trim());
        } else if let Some(rest) = line.strip_prefix("event:") {
            event = Some(rest.trim().to_owned());
        } else if let Some(rest) = line.strip_prefix("id:") {
            id = Some(rest.trim().to_owned());
        } else if let Some(rest) = line.strip_prefix("retry:") {
            retry = rest.trim().parse::<u64>().ok();
        }
        // 其余行（`:` 开头的注释、未知字段）忽略，不炸流
    }

    if data_lines.is_empty() {
        return Ok(None);
    }
    let data = data_lines.join("\n");
    if data == "[DONE]" {
        return Ok(Some(SseFrame {
            event,
            data: Some(data),
            id,
            retry,
        }));
    }
    match serde_json::from_str::<Value>(&data) {
        Ok(Value::Object(_)) => Ok(Some(SseFrame {
            event,
            data: Some(data),
            id,
            retry,
        })),
        Ok(_) => Ok(None),
        Err(_) if data.starts_with('{') || data.starts_with('[') => {
            Err(SseFrameError::MalformedSseFrame { raw: data })
        }
        Err(_) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一次性解析整个输入（push + finish）
    fn parse_all(input: &str) -> Result<Vec<SseFrame>, SseFrameError> {
        let mut parser = SseParser::new();
        let mut frames = parser.push(input.as_bytes())?;
        frames.extend(parser.finish()?);
        Ok(frames)
    }

    fn data_of(frames: &[SseFrame], index: usize) -> &str {
        frames[index].data.as_deref().unwrap_or("<无 data>")
    }

    #[test]
    fn single_data_frame() {
        let frames = parse_all("data: {\"a\":1}\n\n").unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(data_of(&frames, 0), "{\"a\":1}");
    }

    #[test]
    fn data_value_is_trimmed() {
        let frames = parse_all("data:  {\"a\":1}  \n\n").unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(data_of(&frames, 0), "{\"a\":1}");
    }

    #[test]
    fn multi_data_lines_joined_with_newline() {
        // 聚合后 "{\"a\"\n:1}" 仍是合法 JSON 对象（JSON 允许空白换行）
        let frames = parse_all("data: {\"a\"\ndata: :1}\n\n").unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(data_of(&frames, 0), "{\"a\"\n:1}");
    }

    #[test]
    fn event_and_data_fields() {
        let frames = parse_all("event: message\ndata: {\"a\":1}\n\n").unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].event.as_deref(), Some("message"));
        assert_eq!(data_of(&frames, 0), "{\"a\":1}");
    }

    #[test]
    fn id_and_retry_fields() {
        let frames = parse_all("id: 42\nretry: 1000\ndata: {\"a\":1}\n\n").unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].id.as_deref(), Some("42"));
        assert_eq!(frames[0].retry, Some(1000));
    }

    #[test]
    fn invalid_retry_ignored() {
        let frames = parse_all("retry: abc\ndata: {\"a\":1}\n\n").unwrap();
        assert_eq!(frames[0].retry, None);
    }

    #[test]
    fn fields_without_data_skipped() {
        let frames = parse_all("event: x\nid: 1\n\n").unwrap();
        assert!(frames.is_empty());
    }

    #[test]
    fn crlf_boundary() {
        let frames = parse_all("data: {\"a\":1}\r\n\r\n").unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(data_of(&frames, 0), "{\"a\":1}");
    }

    #[test]
    fn crlf_then_lf_uses_two_bytes_without_swallowing_frame() {
        // `\r\n\n` 场景：边界按 2 字节，前面的 `\r` 由行 trim 消化，帧不被吞
        let frames = parse_all("data: {\"a\":1}\r\n\ndata: {\"b\":2}\n\n").unwrap();
        assert_eq!(frames.len(), 2, "两帧都应产出");
        assert_eq!(data_of(&frames, 0), "{\"a\":1}");
        assert_eq!(data_of(&frames, 1), "{\"b\":2}");
    }

    #[test]
    fn earlier_boundary_wins() {
        // `\n\n` 比 `\r\n\r\n` 更早出现时取前者
        let frames = parse_all("data: {\"a\":1}\n\ndata: {\"b\":2}\r\n\r\n").unwrap();
        assert_eq!(frames.len(), 2);
        assert_eq!(data_of(&frames, 0), "{\"a\":1}");
        assert_eq!(data_of(&frames, 1), "{\"b\":2}");
    }

    #[test]
    fn multiple_frames_in_one_push() {
        let frames = parse_all("data: {\"a\":1}\n\ndata: {\"b\":2}\n\n").unwrap();
        assert_eq!(frames.len(), 2);
    }

    #[test]
    fn residual_buffer_kept_until_next_batch() {
        let mut parser = SseParser::new();
        assert!(
            parser.push(b"data: {}").unwrap().is_empty(),
            "未到边界不应产出帧"
        );
        let frames = parser.push(b"\n\n").unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(data_of(&frames, 0), "{}");
    }

    #[test]
    fn done_sentinel_recognized() {
        let mut parser = SseParser::new();
        let frames = parser.push(b"data: [DONE]\n\n").unwrap();
        assert_eq!(frames.len(), 1);
        assert!(frames[0].is_done());
        assert!(parser.is_done());
    }

    #[test]
    fn done_discards_trailing_content_in_same_batch() {
        let frames = parse_all("data: [DONE]\n\ndata: {\"a\":1}\n\n").unwrap();
        assert_eq!(frames.len(), 1);
        assert!(frames[0].is_done());
    }

    #[test]
    fn push_after_done_is_empty() {
        let mut parser = SseParser::new();
        parser.push(b"data: [DONE]\n\n").unwrap();
        assert!(parser.push(b"data: {\"a\":1}\n\n").unwrap().is_empty());
        assert!(parser.finish().unwrap().is_empty());
    }

    #[test]
    fn comment_lines_skipped_without_breaking_stream() {
        let frames = parse_all(": keep-alive\n\ndata: {\"a\":1}\n\n").unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(data_of(&frames, 0), "{\"a\":1}");
    }

    #[test]
    fn non_json_keepalive_skipped_without_breaking_stream() {
        let frames = parse_all("data: ping\n\ndata: {\"a\":1}\n\n").unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(data_of(&frames, 0), "{\"a\":1}");
    }

    #[test]
    fn keepalive_only_stream_yields_nothing() {
        let frames = parse_all(": ping\n\n: pong\n\ndata: hi\n\n").unwrap();
        assert!(frames.is_empty());
    }

    #[test]
    fn valid_json_non_object_skipped() {
        for payload in ["42", "[1,2]", "\"str\"", "null"] {
            let frames = parse_all(&format!("data: {payload}\n\n")).unwrap();
            assert!(frames.is_empty(), "非 object JSON 应跳过: {payload}");
        }
    }

    #[test]
    fn malformed_json_raises_error() {
        let error = parse_all("data: {bad\n\n").unwrap_err();
        assert_eq!(
            error,
            SseFrameError::MalformedSseFrame { raw: "{bad".into() }
        );
    }

    #[test]
    fn malformed_json_still_raises_after_line_trim() {
        // 行 trim 后形似 JSON（`{` 开头）但解析失败 → invalid-stream
        let error = parse_all("data:   {bad\n\n").unwrap_err();
        assert_eq!(
            error,
            SseFrameError::MalformedSseFrame { raw: "{bad".into() }
        );
    }

    #[test]
    fn data_not_starting_with_brace_is_keepalive_even_if_invalid_json() {
        // 聚合后以空白开头（`{` 不在行首）→ 不判定为损坏帧，按 keep-alive 跳过（对齐 TS）
        let frames = parse_all("data: \ndata: {bad\n\n").unwrap();
        assert!(frames.is_empty());
    }

    #[test]
    fn unknown_fields_ignored() {
        let frames = parse_all("foo: bar\ndata: {\"a\":1}\n\n").unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(data_of(&frames, 0), "{\"a\":1}");
    }

    #[test]
    fn utf8_split_across_chunks() {
        // "data: {\"msg\":\"" + 中(E4 B8 AD 拆两批) + "\"}\n\n"
        let mut parser = SseParser::new();
        assert!(parser.push(b"data: {\"msg\":\"").unwrap().is_empty());
        assert!(
            parser.push(&[0xE4, 0xB8]).unwrap().is_empty(),
            "半字符不应产出帧"
        );
        let frames = parser.push(&[0xAD]).unwrap();
        assert!(frames.is_empty(), "未到帧边界");
        let frames = parser.push(b"\"}\n\n").unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(data_of(&frames, 0), "{\"msg\":\"中\"}");
    }

    #[test]
    fn invalid_utf8_raises_error() {
        let mut parser = SseParser::new();
        assert_eq!(
            parser.push(&[0xFF]).unwrap_err(),
            SseFrameError::InvalidUtf8
        );
    }

    #[test]
    fn incomplete_utf8_then_invalid_continuation_raises() {
        // 首字节完整后补入非法续字节 → 无效序列上抛
        let mut parser = SseParser::new();
        assert!(parser.push(&[0xE4, 0xB8]).unwrap().is_empty());
        assert_eq!(
            parser.push(&[0x41]).unwrap_err(),
            SseFrameError::InvalidUtf8
        );
    }

    #[test]
    fn finish_parses_trailing_frame_without_separator() {
        let mut parser = SseParser::new();
        assert!(parser.push(b"data: {\"a\":1}").unwrap().is_empty());
        let frames = parser.finish().unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(data_of(&frames, 0), "{\"a\":1}");
    }

    #[test]
    fn finish_ignores_whitespace_trailing() {
        let frames = parse_all("data: {\"a\":1}\n\n  \n").unwrap();
        assert_eq!(frames.len(), 1, "空白残留不产出帧");
    }

    #[test]
    fn finish_consumes_trailing_done_silently() {
        let mut parser = SseParser::new();
        assert!(parser.push(b"data: [DONE]").unwrap().is_empty());
        assert!(
            parser.finish().unwrap().is_empty(),
            "EOF 残留的 [DONE] 只消费不产出"
        );
        assert!(parser.is_done());
    }

    #[test]
    fn finish_drops_trailing_keepalive() {
        let mut parser = SseParser::new();
        assert!(parser.push(b"data: ping").unwrap().is_empty());
        assert!(
            parser.finish().unwrap().is_empty(),
            "EOF 残留的 keep-alive 不产出"
        );
    }

    #[test]
    fn finish_twice_is_empty() {
        let mut parser = SseParser::new();
        parser.push(b"data: {\"a\":1}\n\n").unwrap();
        assert!(parser.finish().unwrap().is_empty());
        assert!(parser.finish().unwrap().is_empty());
    }

    #[test]
    fn empty_and_blank_inputs_are_noop() {
        let mut parser = SseParser::new();
        assert!(parser.push(b"").unwrap().is_empty());
        assert!(parser.push(b"\n\n").unwrap().is_empty(), "空帧体不产出帧");
        assert!(parser.finish().unwrap().is_empty());
    }

    #[test]
    fn oversized_pending_without_separator_is_rejected() {
        // F3 #5 红：服务端持续灌无分隔符数据 → pending 无界增长（OOM 面）。
        // 现实现静默缓冲不报错 → 本用例失败；修复后必须上抛 FrameTooLarge。
        // 注：4MB 为修复引入的单帧上限（MAX_PENDING_BYTES），此处用字面量
        // 保持红测试在旧实现上可编译、以断言形态复现缺陷。
        let mut parser = SseParser::new();
        let big = "a".repeat(4 * 1024 * 1024 + 1);
        let result = parser.push(big.as_bytes());
        assert!(
            result.is_err(),
            "超限 pending（>4MB 无分隔符）应上抛错误，而非静默缓冲"
        );
    }

    #[test]
    fn many_frames_in_one_push_parse_in_single_pass() {
        // F3 #5 性能红：单次 push 内大量小帧必须单遍分帧（O(n)）。
        // 旧实现 split_frames 每帧 find_separator 重扫 + drain 前移 →
        // O(n²)，30k 帧（420KB）debug 下需数十秒；单遍应 < 10s（宽裕阈值）。
        let frame = "data: {\"a\":1}\n\n";
        let mut input = String::with_capacity(frame.len() * 30_000);
        for _ in 0..30_000 {
            input.push_str(frame);
        }
        let mut parser = SseParser::new();
        let started = std::time::Instant::now();
        let frames = parser.push(input.as_bytes()).expect("合法帧不应报错");
        let elapsed = started.elapsed();
        assert_eq!(frames.len(), 30_000, "全部帧都应产出");
        assert!(
            elapsed.as_secs() < 10,
            "解析 30k 帧耗时 {elapsed:?}，疑似 O(n²) 逐帧重扫（期望单遍 <10s）"
        );
    }
}
