//! 编码命令载荷解码。先尝试十六位小端，再尝试八位字节序列。

use super::flags::is_ps_encoded_command_flag;

fn decode_base64_payload(input: &str) -> Option<Vec<u8>> {
    let clean = input.trim().trim_matches(['"', '\'']);
    let mut buf = Vec::new();
    let mut accumulator: u32 = 0;
    let mut bits: u32 = 0;

    for byte in clean.bytes() {
        if byte.is_ascii_whitespace() {
            continue;
        }
        if byte == b'=' {
            break;
        }
        let val: u32 = match byte {
            b'A'..=b'Z' => (byte - b'A') as u32,
            b'a'..=b'z' => (byte - b'a' + 26) as u32,
            b'0'..=b'9' => (byte - b'0' + 52) as u32,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        };
        accumulator = (accumulator << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            buf.push(((accumulator >> bits) & 0xFF) as u8);
        }
    }
    if buf.is_empty() { None } else { Some(buf) }
}

fn decode_text(bytes: Vec<u8>) -> Option<String> {
    let has_null = bytes.contains(&0);
    if has_null && bytes.len() % 2 == 0 {
        if let Some(text) = utf16_le(&bytes) {
            return Some(text);
        }
    }
    if let Ok(utf8_str) = String::from_utf8(bytes.clone()) {
        if !utf8_str.is_empty() {
            return Some(utf8_str);
        }
    }
    if bytes.len() % 2 == 0 {
        return utf16_le(&bytes);
    }
    None
}

fn utf16_le(bytes: &[u8]) -> Option<String> {
    let u16_chars: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|chunk| u16::from_le_bytes(*chunk))
        .collect();
    String::from_utf16(&u16_chars).ok()
}

/// 从参数中取出编码载荷并解码为明文。
pub fn extract_and_decode_ps_payload(args: &[String]) -> Option<String> {
    for (idx, arg) in args.iter().enumerate() {
        if !is_ps_encoded_command_flag(arg) {
            continue;
        }
        let lower = arg.to_lowercase();
        let stripped = if let Some(s) = lower.strip_prefix("--") {
            s
        } else if let Some(s) = lower.strip_prefix('-').or_else(|| lower.strip_prefix('/')) {
            s
        } else {
            continue;
        };

        let raw_payload = if let Some(pos) = stripped.find([':', '=']) {
            let prefix_len = if arg.starts_with("--") {
                2
            } else if arg.starts_with('-') || arg.starts_with('/') {
                1
            } else {
                0
            };
            arg[prefix_len + pos + 1..].trim()
        } else {
            args.get(idx + 1).map(String::as_str).unwrap_or("").trim()
        };

        let clean_payload = raw_payload.trim_matches(['"', '\'']);
        if clean_payload.is_empty() {
            continue;
        }
        if let Some(bytes) = decode_base64_payload(clean_payload) {
            if let Some(text) = decode_text(bytes) {
                return Some(text);
            }
        }
    }
    None
}
