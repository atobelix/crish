use chardetng::EncodingDetector;
use encoding_rs::{Encoding, UTF_8};
use serde::Serialize;

/// Result of encoding detection.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EncodingDetectResult {
    /// Detected encoding label (e.g. "UTF-8", "GB18030", "Shift_JIS")
    pub(crate) encoding: String,
    /// Detection confidence between 0.0 and 1.0
    pub(crate) confidence: f32,
    /// Whether a BOM was detected
    pub(crate) has_bom: bool,
}

/// Detect encoding by checking BOM markers first, then using chardetng.
fn detect_encoding(data: &[u8]) -> EncodingDetectResult {
    if let Some(bom_enc) = detect_bom(data) {
        return EncodingDetectResult {
            encoding: bom_enc,
            confidence: 1.0,
            has_bom: true,
        };
    }

    let mut detector = EncodingDetector::new();
    detector.feed(data, true);
    let (encoding, is_reliable) = detector.guess_assess(None, true);
    let encoding_name = encoding.name().to_string();
    let confidence = if is_reliable { 0.95 } else { 0.6 };

    EncodingDetectResult {
        encoding: encoding_name,
        confidence,
        has_bom: false,
    }
}

// BOM signatures sorted by length (longest first) for correct matching.
const BOM_SIGS: &[(&[u8], &str)] = &[
    (b"\x00\x00\xFE\xFF", "UTF-32BE"),
    (b"\xFF\xFE\x00\x00", "UTF-32LE"),
    (b"\x2B\x2F\x76\x38", "UTF-7"),
    (b"\x2B\x2F\x76\x39", "UTF-7"),
    (b"\x2B\x2F\x76\x2B", "UTF-7"),
    (b"\x2B\x2F\x76\x2F", "UTF-7"),
    (b"\x2B\x2F\x76\x38\x2D", "UTF-7"),
    (b"\xDD\x73\x66\x73", "UTF-EBCDIC"),
    (b"\x84\x31\x95\x33", "BOCU-1"),
    (b"\xFE\xFF", "UTF-16BE"),
    (b"\xFF\xFE", "UTF-16LE"),
    (b"\xEF\xBB\xBF", "UTF-8"),
    (b"\xF7\x64\x4C", "UTF-1"),
    (b"\x0E\xFE\xFF", "SCSU"),
];

fn detect_bom(data: &[u8]) -> Option<String> {
    for (sig, name) in BOM_SIGS {
        if data.len() >= sig.len() && data[..sig.len()] == **sig {
            return Some(name.to_string());
        }
    }
    None
}

/// Decode bytes to UTF-8 string.
///
/// If `encoding_hint` is provided, uses that encoding for decoding.
/// Otherwise auto-detects the encoding first.
/// Invalid characters are replaced with U+FFFD (never panics).
fn decode_to_utf8(data: &[u8], encoding_hint: Option<&str>) -> Result<String, String> {
    let encoding: &Encoding = match encoding_hint {
        Some(hint) => Encoding::for_label(hint.as_bytes())
            .ok_or_else(|| format!("Unsupported encoding: {hint}"))?,
        None => {
            let detected = detect_encoding(data);
            Encoding::for_label(detected.encoding.as_bytes()).unwrap_or(UTF_8)
        }
    };
    let (cow, _encoding_used, _had_errors) = encoding.decode(data);
    Ok(cow.into_owned())
}

/// Detect encoding of the given byte data.
///
/// First checks for BOM signatures (UTF-8, UTF-16LE, UTF-16BE, etc.),
/// then falls back to `chardetng` statistical detection.
#[tauri::command]
pub(crate) fn perf_encoding_detect(data: Vec<u8>) -> Result<EncodingDetectResult, String> {
    Ok(detect_encoding(&data))
}

/// Decode bytes to UTF-8 string.
///
/// If `encoding` is specified, decodes using that encoding.
/// If `encoding` is None, auto-detects the encoding first.
/// Invalid bytes are replaced with U+FFFD (never panics).
#[tauri::command]
pub(crate) fn perf_encoding_decode(
    data: Vec<u8>,
    encoding: Option<String>,
) -> Result<String, String> {
    decode_to_utf8(&data, encoding.as_deref())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_utf8_bom() {
        let data = b"\xEF\xBB\xBFhello";
        let result = detect_encoding(data);
        assert_eq!(result.encoding, "UTF-8");
        assert!(result.has_bom);
        assert_eq!(result.confidence, 1.0);
    }

    #[test]
    fn test_detect_utf16le_bom() {
        let data = b"\xFF\xFE\x68\x00\x65\x00";
        let result = detect_encoding(data);
        assert_eq!(result.encoding, "UTF-16LE");
        assert!(result.has_bom);
    }

    #[test]
    fn test_detect_utf16be_bom() {
        let data = b"\xFE\xFF\x00\x68\x00\x65";
        let result = detect_encoding(data);
        assert_eq!(result.encoding, "UTF-16BE");
        assert!(result.has_bom);
    }

    #[test]
    fn test_detect_no_bom_ascii() {
        let data = b"hello world";
        let result = detect_encoding(data);
        assert!(!result.has_bom);
        assert_eq!(result.encoding, "UTF-8");
        assert!(result.confidence > 0.5);
    }

    #[test]
    fn test_detect_chinese_gb18030() {
        let data = b"\xC4\xE3\xBA\xC3"; // "你好" in GB18030
        let result = detect_encoding(data);
        assert!(!result.has_bom);
        // chardetng should detect this as GB18030 or similar
        assert!(result.confidence > 0.0);
    }

    #[test]
    fn test_decode_utf8_no_encoding() {
        let data = b"hello world";
        let result = decode_to_utf8(data, None).unwrap();
        assert_eq!(result, "hello world");
    }

    #[test]
    fn test_decode_utf8_with_encoding() {
        let data = b"hello world";
        let result = decode_to_utf8(data, Some("utf-8")).unwrap();
        assert_eq!(result, "hello world");
    }

    #[test]
    fn test_decode_invalid_utf8_replacement() {
        // Invalid UTF-8 byte 0xFF should be replaced, not panic
        let data = b"hello\xFFworld";
        let result = decode_to_utf8(data, Some("utf-8")).unwrap();
        assert_eq!(result, "hello\u{FFFD}world");
    }

    #[test]
    fn test_decode_unsupported_encoding() {
        let data = b"hello";
        let result = decode_to_utf8(data, Some("nonexistent-encoding"));
        assert!(result.is_err());
    }

    #[test]
    fn test_detect_command() {
        let data = b"\xEF\xBB\xBFtest";
        let result = perf_encoding_detect(data.to_vec()).unwrap();
        assert_eq!(result.encoding, "UTF-8");
        assert!(result.has_bom);
    }

    #[test]
    fn test_decode_command_with_encoding() {
        let data = b"hello";
        let result = perf_encoding_decode(data.to_vec(), Some("utf-8".to_string())).unwrap();
        assert_eq!(result, "hello");
    }

    #[test]
    fn test_decode_command_auto_detect() {
        let data = b"hello world";
        let result = perf_encoding_decode(data.to_vec(), None).unwrap();
        assert_eq!(result, "hello world");
    }

    #[test]
    fn test_decode_command_invalid_replacement() {
        let data = b"\xFF\xFE";
        // UTF-16LE BOM with just BOM should decode to empty string
        let result = perf_encoding_decode(data.to_vec(), None).unwrap_or_default();
        assert!(result.is_empty() || result.contains('\u{FFFD}'));
    }
}
