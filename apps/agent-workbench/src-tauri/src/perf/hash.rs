use base64::prelude::{Engine as _, BASE64_STANDARD, BASE64_URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};

/// Compute SHA-256 hash of data and return as hex string.
///
/// Supports `sha256` and `sha256-hex` (default) algorithms.
/// Both produce the same hex output.
fn sha256_compute(data: &[u8]) -> String {
    let hash = Sha256::digest(data);
    format!("{:x}", hash)
}

/// Encode bytes to base64 string.
///
/// - `standard` (default): standard base64 with `=` padding
/// - `url_safe`: URL-safe base64 without padding
fn base64_encode(data: &[u8], config: &str) -> Result<String, String> {
    match config {
        "url_safe" => Ok(BASE64_URL_SAFE_NO_PAD.encode(data)),
        _ => Ok(BASE64_STANDARD.encode(data)),
    }
}

/// Decode base64 string to bytes.
///
/// - `standard` (default): standard base64 with `=` padding
/// - `url_safe`: URL-safe base64 without padding
fn base64_decode(input: &str, config: &str) -> Result<Vec<u8>, String> {
    match config {
        "url_safe" => BASE64_URL_SAFE_NO_PAD
            .decode(input)
            .map_err(|e| format!("Base64 URL-safe decode failed: {e}")),
        _ => BASE64_STANDARD
            .decode(input)
            .map_err(|e| format!("Base64 decode failed: {e}")),
    }
}

/// Compute SHA-256 hash of the given data.
///
/// Supported algorithms: `sha256`, `sha256-hex` (default).
/// Returns the hash as a lowercase hex string.
#[tauri::command]
pub(crate) fn perf_hash_compute(data: Vec<u8>, algorithm: Option<String>) -> Result<String, String> {
    let _algo = algorithm.as_deref().unwrap_or("sha256-hex");
    Ok(sha256_compute(&data))
}

/// Encode bytes to base64.
///
/// Supported configs:
/// - `standard` (default): standard base64 with `=` padding
/// - `url_safe`: URL-safe base64 without padding
#[tauri::command]
pub(crate) fn perf_base64_encode(data: Vec<u8>, config: Option<String>) -> Result<String, String> {
    base64_encode(&data, config.as_deref().unwrap_or("standard"))
}

/// Decode base64 string to bytes.
///
/// Supported configs:
/// - `standard` (default): standard base64 with `=` padding
/// - `url_safe`: URL-safe base64 without padding
#[tauri::command]
pub(crate) fn perf_base64_decode(encoded: String, config: Option<String>) -> Result<Vec<u8>, String> {
    base64_decode(&encoded, config.as_deref().unwrap_or("standard"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sha256_hex() {
        let result = sha256_compute(b"hello");
        assert_eq!(
            result,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn test_sha256_empty() {
        let result = sha256_compute(b"");
        assert_eq!(
            result,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn test_base64_encode_standard() {
        let result = base64_encode(b"hello world", "standard").unwrap();
        assert_eq!(result, "aGVsbG8gd29ybGQ=");
    }

    #[test]
    fn test_base64_encode_url_safe() {
        let result = base64_encode(b"\xFB\xFF", "url_safe").unwrap();
        assert_eq!(result, "-_8");
    }

    #[test]
    fn test_base64_decode_standard() {
        let result = base64_decode("aGVsbG8gd29ybGQ=", "standard").unwrap();
        assert_eq!(result, b"hello world");
    }

    #[test]
    fn test_base64_decode_url_safe() {
        let result = base64_decode("-_8", "url_safe").unwrap();
        assert_eq!(result, b"\xFB\xFF");
    }

    #[test]
    fn test_base64_decode_invalid() {
        let result = base64_decode("!!!invalid!!!", "standard");
        assert!(result.is_err());
    }

    #[test]
    fn test_hash_command_sha256() {
        let result = perf_hash_compute(b"test".to_vec(), Some("sha256".to_string())).unwrap();
        assert_eq!(
            result,
            "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
        );
    }

    #[test]
    fn test_hash_command_default() {
        let result = perf_hash_compute(b"test".to_vec(), None).unwrap();
        assert_eq!(
            result,
            "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
        );
    }

    #[test]
    fn test_encode_command_default() {
        let result = perf_base64_encode(b"hello".to_vec(), None).unwrap();
        assert_eq!(result, "aGVsbG8=");
    }

    #[test]
    fn test_encode_command_url_safe() {
        let result = perf_base64_encode(b"\xFB\xFF".to_vec(), Some("url_safe".to_string())).unwrap();
        assert_eq!(result, "-_8");
    }

    #[test]
    fn test_decode_command_default() {
        let result = perf_base64_decode("aGVsbG8=".to_string(), None).unwrap();
        assert_eq!(result, b"hello");
    }

    #[test]
    fn test_decode_command_url_safe() {
        let result = perf_base64_decode("-_8".to_string(), Some("url_safe".to_string())).unwrap();
        assert_eq!(result, b"\xFB\xFF");
    }

    #[test]
    fn test_large_data_chunked() {
        let data = vec![b'a'; 2_000_000];
        let result = sha256_compute(&data);
        assert_eq!(result.len(), 64);
    }
}
