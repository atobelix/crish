//! 跨 Chunk 增量无损 UTF-8 流式解码器
//!
//! 解决 Windows ConPTY 读管道以固定 8KB 缓冲区读取时，
//! 跨 Chunk 边界的 3 字节中文（如 UTF-8 0xE4 0xBD 0xA0 "你"）、
//! 4 字节 Emoji（如 0xF0 0x9F 0xA6 0x80 "🦀"）或 24-bit ANSI 转义序列被截断，
//! 从而被 `String::from_utf8_lossy` 破坏性替换为乱码字符 `\u{FFFD}`（）的问题。

/// 跨 Chunk 增量无损 UTF-8 流式解码器
#[derive(Debug, Default)]
pub struct Utf8ChunkBuffer {
    /// 暂存上一个 Chunk 末尾未成形的 1~3 字节 UTF-8 碎片
    carry: [u8; 4],
    /// carry 中当前存储的有效字节数 (0..=3)
    carry_len: usize,
}

impl Utf8ChunkBuffer {
    pub fn new() -> Self {
        Self {
            carry: [0u8; 4],
            carry_len: 0,
        }
    }

    /// 增量接收字节切片并解码出完整的合法 UTF-8 字符串。
    /// 尾部不完整的 1~3 字节将自动暂存，等待下一次 push 拼合。
    pub fn push(&mut self, chunk: &[u8]) -> String {
        if chunk.is_empty() && self.carry_len == 0 {
            return String::new();
        }

        // 若存在上期残存字节，拼合后解码
        if self.carry_len > 0 {
            let mut combined = Vec::with_capacity(self.carry_len + chunk.len());
            combined.extend_from_slice(&self.carry[..self.carry_len]);
            combined.extend_from_slice(chunk);
            self.carry_len = 0;
            return self.decode_slice(&combined);
        }

        self.decode_slice(chunk)
    }

    /// 核心切片解码与残存提取算法
    fn decode_slice(&mut self, bytes: &[u8]) -> String {
        let mut result = String::with_capacity(bytes.len());
        let mut current = bytes;

        loop {
            if current.is_empty() {
                break;
            }

            match std::str::from_utf8(current) {
                Ok(valid_str) => {
                    result.push_str(valid_str);
                    self.carry_len = 0;
                    break;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    if valid_up_to > 0 {
                        if let Ok(valid_str) = std::str::from_utf8(&current[..valid_up_to]) {
                            result.push_str(valid_str);
                        }
                    }

                    match error.error_len() {
                        None => {
                            // 末尾残存不完整 UTF-8 字符（1~3 字节）
                            let remaining = &current[valid_up_to..];
                            let rem_len = remaining.len();
                            debug_assert!(rem_len < 4, "UTF-8 残存字节数必须小于 4");
                            self.carry[..rem_len].copy_from_slice(remaining);
                            self.carry_len = rem_len;
                            break;
                        }
                        Some(invalid_len) => {
                            // 中间遇到真正的非法字节（损坏数据），替换为 \u{FFFD}
                            result.push('\u{FFFD}');
                            current = &current[valid_up_to + invalid_len..];
                        }
                    }
                }
            }
        }

        result
    }

    /// 流终止（EOF / 进程退出）时排空并清空残存缓冲区
    pub fn flush_lossy(&mut self) -> String {
        if self.carry_len == 0 {
            return String::new();
        }
        let lossy = String::from_utf8_lossy(&self.carry[..self.carry_len]).into_owned();
        self.carry_len = 0;
        lossy
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ascii_passthrough() {
        let mut buf = Utf8ChunkBuffer::new();
        assert_eq!(buf.push(b"hello world\r\n"), "hello world\r\n");
        assert_eq!(buf.flush_lossy(), "");
    }

    #[test]
    fn test_chinese_3byte_split_across_chunks() {
        let mut buf = Utf8ChunkBuffer::new();
        // 中文字符 "你" = [0xE4, 0xBD, 0xA0]
        // Chunk 1 给出前 2 字节
        let out1 = buf.push(&[0xE4, 0xBD]);
        assert_eq!(out1, "", "未完整前不得输出乱码");

        // Chunk 2 给出第 3 字节 + 后续 ASCII
        let out2 = buf.push(&[0xA0, b'!', b'?']);
        assert_eq!(out2, "你!?", "拼合后必须无损还原中文字符");
        assert_eq!(buf.flush_lossy(), "");
    }

    #[test]
    fn test_emoji_4byte_split_across_chunks() {
        let mut buf = Utf8ChunkBuffer::new();
        // Emoji "🦀" = [0xF0, 0x9F, 0xA6, 0x80]
        assert_eq!(buf.push(&[0xF0]), "");
        assert_eq!(buf.push(&[0x9F, 0xA6]), "");
        assert_eq!(buf.push(&[0x80, b'o', b'k']), "🦀ok");
        assert_eq!(buf.flush_lossy(), "");
    }

    #[test]
    fn test_ansi_color_sequence_split() {
        let mut buf = Utf8ChunkBuffer::new();
        let ansi_part1 = b"\x1b[38;2;255;";
        let ansi_part2 = b"128;0mRed\x1b[0m";
        let out1 = buf.push(ansi_part1);
        let out2 = buf.push(ansi_part2);
        assert_eq!(format!("{out1}{out2}"), "\x1b[38;2;255;128;0mRed\x1b[0m");
    }

    #[test]
    fn test_flush_lossy_on_truncated_stream() {
        let mut buf = Utf8ChunkBuffer::new();
        // 残存孤立 0xE4，流异常结束
        buf.push(&[0xE4]);
        let flushed = buf.flush_lossy();
        assert_eq!(flushed, "\u{FFFD}", "终止时排空残存字节为 lossy 字符");
    }

    #[test]
    fn test_invalid_bytes_in_middle() {
        let mut buf = Utf8ChunkBuffer::new();
        // 0xFF 为非法 UTF-8 起始字节
        let out = buf.push(b"abc\xFFdef");
        assert_eq!(out, "abc\u{FFFD}def");
        assert_eq!(buf.flush_lossy(), "");
    }
}
