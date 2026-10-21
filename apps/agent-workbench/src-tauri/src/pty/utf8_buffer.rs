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

    /// 当前暂存的未完成 UTF-8 尾部字节数（0..=3）
    #[inline]
    #[allow(dead_code)]
    pub fn pending_len(&self) -> usize {
        self.carry_len
    }

    /// 是否存在待拼合的尾部 UTF-8 残存字节
    #[inline]
    #[allow(dead_code)]
    pub fn has_pending(&self) -> bool {
        self.carry_len > 0
    }

    /// 清空残存缓冲区（丢弃未完成字节）
    #[inline]
    #[allow(dead_code)]
    pub fn clear(&mut self) {
        self.carry_len = 0;
    }

    /// 根据 UTF-8 首字节判定该码点的期望总字节数（1..=4）
    #[inline]
    fn expected_utf8_len(first_byte: u8) -> usize {
        match first_byte {
            0x00..=0x7F => 1,
            0xC2..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF4 => 4,
            _ => 1,
        }
    }

    /// $O(1)$ 尾部不完整 UTF-8 序列剥离：
    /// 仅检查切片末尾最多 3 个字节，若末尾是合法的未完成 UTF-8 前缀（1~3 字节），
    /// 立即将其从主切片剥离并返回 `(主体切片, 尾部残存切片)`。
    ///
    /// 物理收益：66.7% 以上的 8KB 中文/Emoji 块会在边界处截断多字节字符；
    /// 预先以 $O(1)$ 剥离尾部 1~3 字节后，主体 8KB 切片可由 `std::str::from_utf8`
    /// 单遍零拷贝校验通过，彻底消除因末尾截断触发 `Err` 后对前 8190 字节的二次重复扫描。
    #[inline]
    fn split_incomplete_utf8_tail(bytes: &[u8]) -> (&[u8], &[u8]) {
        let len = bytes.len();
        if len == 0 || bytes[len - 1] < 0x80 {
            return (bytes, &[]);
        }

        let max_back = len.min(3);
        for k in 1..=max_back {
            let idx = len - k;
            let b = bytes[idx];
            // 0b10xxxxxx 为 UTF-8 续字节，继续向前寻找引导字节
            if (b & 0b1100_0000) == 0b1000_0000 {
                continue;
            }
            // 找到最后一个非续字节：在最多 3 字节的微小切片上判定是否为未完成 UTF-8 前缀
            return match std::str::from_utf8(&bytes[idx..]) {
                Err(err) if err.valid_up_to() == 0 && err.error_len().is_none() => {
                    (&bytes[..idx], &bytes[idx..])
                }
                _ => (bytes, &[]),
            };
        }

        (bytes, &[])
    }

    /// 增量接收字节切片并解码出完整的合法 UTF-8 字符串。
    /// 尾部不完整的 1~3 字节将自动暂存，等待下一次 push 拼合。
    ///
    /// 性能优化（ISSUE-05 / ISSUE-12）：
    /// 1. 当存在 1~3 字节残存时，仅从新 `chunk` 头部取最多 3 个字节在 4 字节栈缓冲
    ///    `self.carry` 内完成单字符边界拼合与 `copy_within` 原位压实，彻底消除整块
    ///    8KB `Vec` 重分配与向左搬移；
    /// 2. 对剩余切片先以 $O(1)$ 剥离尾部 1~3 字节未完成序列，使主体 8KB 切片单遍零拷贝
    ///    完成 `std::str::from_utf8` 解码。
    pub fn push(&mut self, chunk: &[u8]) -> String {
        if chunk.is_empty() {
            return String::new();
        }
        let mut result = String::with_capacity(self.carry_len + chunk.len());
        self.push_into(chunk, &mut result);
        result
    }

    /// 原地增量解码并直接追加至调用方提供的 `String` 缓冲区，消除中间 `String` 分配。
    pub fn push_into(&mut self, chunk: &[u8], out: &mut String) {
        if chunk.is_empty() {
            return;
        }

        out.reserve(self.carry_len + chunk.len());
        let mut remaining = chunk;

        // 若存在上期残存字节，仅在 4 字节栈缓冲上补齐当前字符所需字节并原位压实
        if self.carry_len > 0 {
            loop {
                let old_carry_len = self.carry_len;
                let expected_len = Self::expected_utf8_len(self.carry[0]);
                let need = expected_len.saturating_sub(old_carry_len);
                let take = remaining.len().min(need);

                if take > 0 {
                    self.carry[old_carry_len..old_carry_len + take]
                        .copy_from_slice(&remaining[..take]);
                    remaining = &remaining[take..];
                }
                let total = old_carry_len + take;

                match std::str::from_utf8(&self.carry[..total]) {
                    Ok(valid_str) => {
                        out.push_str(valid_str);
                        self.carry_len = 0;
                        break;
                    }
                    Err(error) => {
                        let valid_up_to = error.valid_up_to();
                        if valid_up_to > 0 {
                            if let Ok(valid_str) = std::str::from_utf8(&self.carry[..valid_up_to]) {
                                out.push_str(valid_str);
                            }
                        }
                        match error.error_len() {
                            None => {
                                if valid_up_to > 0 {
                                    self.carry.copy_within(valid_up_to..total, 0);
                                    self.carry_len = total - valid_up_to;
                                    if remaining.is_empty() {
                                        return;
                                    }
                                } else {
                                    // 新 chunk 字节数仍不足以补齐该字符，仅暂存这 1~3 字节等待下一块
                                    self.carry_len = total;
                                    return;
                                }
                            }
                            Some(invalid_len) => {
                                out.push('\u{FFFD}');
                                let consumed = valid_up_to + invalid_len;
                                if consumed < total {
                                    // 原位向左压实 carry 中尚未消费的 1~3 个残存字节
                                    self.carry.copy_within(consumed..total, 0);
                                    self.carry_len = total - consumed;
                                } else {
                                    self.carry_len = 0;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }

        if !remaining.is_empty() {
            self.decode_slice_into(remaining, out);
        }
    }

    /// 核心切片原地零拷贝解码与尾部残存提取算法
    fn decode_slice_into(&mut self, bytes: &[u8], result: &mut String) {
        let (body, incomplete_tail) = Self::split_incomplete_utf8_tail(bytes);
        let mut current = body;

        while !current.is_empty() {
            match std::str::from_utf8(current) {
                Ok(valid_str) => {
                    result.push_str(valid_str);
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
                            if incomplete_tail.is_empty() {
                                let rem = &current[valid_up_to..];
                                let rem_len = rem.len();
                                debug_assert!(rem_len < 4, "UTF-8 残存字节数必须小于 4");
                                self.carry[..rem_len].copy_from_slice(rem);
                                self.carry_len = rem_len;
                                return;
                            }
                            // body 末尾存在未完成前缀，但其后紧跟 incomplete_tail 的新引导字节，
                            // 故该未完成前缀实为被截断的损坏序列，应替换为 \u{FFFD} 并继续暂存 incomplete_tail
                            result.push('\u{FFFD}');
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

        if !incomplete_tail.is_empty() {
            let tail_len = incomplete_tail.len();
            debug_assert!(tail_len < 4, "UTF-8 尾部残存字节数必须小于 4");
            self.carry[..tail_len].copy_from_slice(incomplete_tail);
            self.carry_len = tail_len;
        } else {
            self.carry_len = 0;
        }
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
        assert!(!buf.has_pending());
        assert_eq!(buf.flush_lossy(), "");
    }

    #[test]
    fn test_chinese_3byte_split_across_chunks() {
        let mut buf = Utf8ChunkBuffer::new();
        // 中文字符 "你" = [0xE4, 0xBD, 0xA0]
        // Chunk 1 给出前 2 字节
        let out1 = buf.push(&[0xE4, 0xBD]);
        assert_eq!(out1, "", "未完整前不得输出乱码");
        assert_eq!(buf.pending_len(), 2);

        // Chunk 2 给出第 3 字节 + 后续 ASCII
        let out2 = buf.push(&[0xA0, b'!', b'?']);
        assert_eq!(out2, "你!?", "拼合后必须无损还原中文字符");
        assert_eq!(buf.pending_len(), 0);
        assert_eq!(buf.flush_lossy(), "");
    }

    #[test]
    fn test_emoji_4byte_split_across_chunks() {
        let mut buf = Utf8ChunkBuffer::new();
        // Emoji "🦀" = [0xF0, 0x9F, 0xA6, 0x80]
        assert_eq!(buf.push(&[0xF0]), "");
        assert_eq!(buf.pending_len(), 1);
        assert_eq!(buf.push(&[0x9F, 0xA6]), "");
        assert_eq!(buf.pending_len(), 3);
        assert_eq!(buf.push(&[0x80, b'o', b'k']), "🦀ok");
        assert_eq!(buf.pending_len(), 0);
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

    #[test]
    fn test_incomplete_carry_followed_by_invalid_continuation_and_multibyte() {
        let mut buf = Utf8ChunkBuffer::new();
        // Chunk 1 末尾留下孤立的 3 字节首字节 0xE4
        assert_eq!(buf.push(&[0xE4]), "");
        // Chunk 2 紧跟合法 4 字节 Emoji "🦀" + ASCII，0xE4 应转为 \u{FFFD} 且不吞噬后续 Emoji
        let out = buf.push(&[0xF0, 0x9F, 0xA6, 0x80, b'!']);
        assert_eq!(out, "\u{FFFD}🦀!");
        assert_eq!(buf.flush_lossy(), "");
    }

    #[test]
    fn test_8kb_boundary_split_zero_copy_equivalence() {
        let mut buf = Utf8ChunkBuffer::new();
        let mut chunk1 = vec![b'a'; 8190];
        // 在 8192 边界处放入 "中" [0xE4, 0xB8, 0xAD] 的前 2 字节
        chunk1.extend_from_slice(&[0xE4, 0xB8]);
        let mut chunk2 = vec![0xAD];
        chunk2.extend_from_slice(&vec![b'b'; 8191]);

        let out1 = buf.push(&chunk1);
        assert_eq!(out1.len(), 8190);
        assert_eq!(buf.pending_len(), 2);
        let out2 = buf.push(&chunk2);
        assert!(out2.starts_with('中'));
        assert_eq!(out2.len(), "中".len() + 8191);
        assert_eq!(buf.pending_len(), 0);
    }

    #[test]
    fn test_arbitrary_chunk_sizes_match_from_utf8_lossy() {
        // 构造含 ASCII、中文、4 字节 Emoji、非法字节、过长编码、交错截断前缀的混合字节流
        let mut stream = Vec::new();
        stream.extend_from_slice("Hello 世界 🦀🔥 Rust! ".as_bytes());
        stream.push(0xFF); // 孤立非法字节
        stream.extend_from_slice("继续输出中文与符号 🚀".as_bytes());
        stream.extend_from_slice(&[0xE0, 0x80, b'A']); // 过长非法序列 + ASCII
        stream.extend_from_slice(&[0xF0, 0x9F]); // 截断的 4 字节前缀后紧跟合法中文
        stream.extend_from_slice("终端流式测试完毕".as_bytes());
        stream.extend_from_slice(&[0xF0, b'A', 0xE4, 0xBD, 0xA0]); // 孤立引导字节 + ASCII + 完整中文
        stream.extend_from_slice(&[0xF0, b'A', 0xF0, 0x9F, b'B']); // 连续截断引导字节与 ASCII 交错
        stream.extend_from_slice(&[0xF0, b'A', 0xFF, b'B']); // 孤立引导字节 + ASCII + 非法字节 + ASCII
        stream.extend_from_slice(b"\r\n");

        let expected = String::from_utf8_lossy(&stream).into_owned();

        for step in 1..=20 {
            let mut buf = Utf8ChunkBuffer::new();
            let mut actual = String::new();
            for chunk in stream.chunks(step) {
                buf.push_into(chunk, &mut actual);
            }
            actual.push_str(&buf.flush_lossy());
            assert_eq!(
                actual, expected,
                "chunk 步长 {step} 解码结果必须与全量 lossy 完全一致"
            );
        }
    }
}
