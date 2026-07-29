use std::collections::HashMap;
use std::time::{Duration, Instant};

// Re-export shared types from conex-types (single source of truth)
pub use conex_types::{IpcEnvelope, IpcResponse};

/// Encode an IPC envelope to a JSON line (newline-terminated).
pub fn encode(envelope: &IpcEnvelope) -> String {
    let mut json = serde_json::to_string(envelope).unwrap_or_default();
    json.push('\n');
    json
}

/// Decode a JSON line into an IPC envelope.
pub fn decode(line: &str) -> Result<IpcEnvelope, IpcError> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err(IpcError::EmptyLine);
    }
    serde_json::from_str(trimmed).map_err(|e| IpcError::ParseError(e.to_string()))
}

/// Encode an IPC response to a JSON line.
pub fn encode_response(response: &IpcResponse) -> String {
    let mut json = serde_json::to_string(response).unwrap_or_default();
    json.push('\n');
    json
}

/// Decode a JSON line into an IPC response.
pub fn decode_response(line: &str) -> Result<IpcResponse, IpcError> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err(IpcError::EmptyLine);
    }
    serde_json::from_str(trimmed).map_err(|e| IpcError::ParseError(e.to_string()))
}

#[derive(Debug, Clone, PartialEq)]
pub enum IpcError {
    EmptyLine,
    ParseError(String),
    Timeout(String),
    NotFound(String),
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IpcError::EmptyLine => write!(f, "empty line"),
            IpcError::ParseError(msg) => write!(f, "parse error: {msg}"),
            IpcError::Timeout(id) => write!(f, "request timed out: {id}"),
            IpcError::NotFound(id) => write!(f, "request not found: {id}"),
        }
    }
}

impl std::error::Error for IpcError {}

/// Tracks pending IPC requests and their timeouts.
pub struct CorrelationTracker {
    pending: HashMap<String, Instant>,
    timeout: Duration,
}

impl CorrelationTracker {
    pub fn new(timeout: Duration) -> Self {
        Self {
            pending: HashMap::new(),
            timeout,
        }
    }

    /// Register a new pending request.
    pub fn track(&mut self, id: String) {
        self.pending.insert(id, Instant::now());
    }

    /// Mark a request as completed (response received).
    pub fn complete(&mut self, id: &str) -> bool {
        self.pending.remove(id).is_some()
    }

    /// Check if a request is still pending.
    pub fn is_pending(&self, id: &str) -> bool {
        self.pending.contains_key(id)
    }

    /// Remove and return all expired request IDs.
    pub fn collect_expired(&mut self) -> Vec<String> {
        let now = Instant::now();
        let expired: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, started)| now.duration_since(**started) > self.timeout)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &expired {
            self.pending.remove(id);
        }
        expired
    }

    /// Number of currently pending requests.
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_decode_roundtrip() {
        let envelope = IpcEnvelope {
            id: "req-1".to_string(),
            method: "search".to_string(),
            payload: serde_json::json!({"query": "test"}),
            timestamp: 1700000000,
        };
        let encoded = encode(&envelope);
        assert!(encoded.ends_with('\n'));

        let decoded = decode(&encoded).unwrap();
        assert_eq!(envelope, decoded);
    }

    #[test]
    fn decode_empty_line_fails() {
        assert_eq!(decode(""), Err(IpcError::EmptyLine));
        assert_eq!(decode("   "), Err(IpcError::EmptyLine));
    }

    #[test]
    fn decode_malformed_json_fails() {
        let result = decode("{invalid json}");
        assert!(matches!(result, Err(IpcError::ParseError(_))));
    }

    #[test]
    fn response_encode_decode_roundtrip() {
        let response = IpcResponse {
            id: "req-1".to_string(),
            result: Some(serde_json::json!({"hits": []})),
            error: None,
        };
        let encoded = encode_response(&response);
        let decoded = decode_response(&encoded).unwrap();
        assert_eq!(response, decoded);
    }

    #[test]
    fn response_with_error() {
        let response = IpcResponse {
            id: "req-2".to_string(),
            result: None,
            error: Some("not found".to_string()),
        };
        let json = serde_json::to_value(&response).unwrap();
        assert!(json.get("result").is_none());
        assert_eq!(json["error"], "not found");
    }

    #[test]
    fn correlation_tracker_basic() {
        let mut tracker = CorrelationTracker::new(Duration::from_secs(5));
        tracker.track("req-1".to_string());
        tracker.track("req-2".to_string());

        assert_eq!(tracker.pending_count(), 2);
        assert!(tracker.is_pending("req-1"));

        assert!(tracker.complete("req-1"));
        assert!(!tracker.is_pending("req-1"));
        assert_eq!(tracker.pending_count(), 1);

        // Completing unknown ID returns false
        assert!(!tracker.complete("req-unknown"));
    }

    #[test]
    fn correlation_tracker_expiry() {
        let mut tracker = CorrelationTracker::new(Duration::from_millis(0));
        tracker.track("req-old".to_string());

        // With 0ms timeout, everything is immediately expired
        std::thread::sleep(Duration::from_millis(1));
        let expired = tracker.collect_expired();
        assert_eq!(expired, vec!["req-old"]);
        assert_eq!(tracker.pending_count(), 0);
    }
}
