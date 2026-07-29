use std::collections::VecDeque;

// Re-export shared type from conex-types (single source of truth)
pub use conex_types::StreamChunk;

/// Backpressure signal returned when buffer exceeds threshold.
#[derive(Debug, Clone, PartialEq)]
pub struct BackpressureSignal {
    pub buffered_bytes: usize,
    pub threshold: usize,
}

/// Stream session state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamState {
    Open,
    Closed,
    Aborted,
}

/// Manages a single stream's lifecycle with backpressure detection.
pub struct StreamSession {
    state: StreamState,
    buffer: VecDeque<StreamChunk>,
    buffered_bytes: usize,
    backpressure_threshold: usize,
    total_received: usize,
}

impl StreamSession {
    /// Create a new open stream session with a backpressure threshold (bytes).
    pub fn new(backpressure_threshold: usize) -> Self {
        Self {
            state: StreamState::Open,
            buffer: VecDeque::new(),
            buffered_bytes: 0,
            backpressure_threshold,
            total_received: 0,
        }
    }

    /// Current stream state.
    pub fn state(&self) -> StreamState {
        self.state
    }

    /// Push a chunk into the stream buffer.
    /// Returns Err if the stream is not open.
    pub fn push(&mut self, chunk: StreamChunk) -> Result<Option<BackpressureSignal>, StreamError> {
        if self.state != StreamState::Open {
            return Err(StreamError::NotOpen(self.state));
        }

        let chunk_len = chunk.data.len();
        self.buffered_bytes += chunk_len;
        self.total_received += chunk_len;

        if chunk.is_final {
            self.state = StreamState::Closed;
        }

        self.buffer.push_back(chunk);

        // Check backpressure
        if self.buffered_bytes > self.backpressure_threshold {
            Ok(Some(BackpressureSignal {
                buffered_bytes: self.buffered_bytes,
                threshold: self.backpressure_threshold,
            }))
        } else {
            Ok(None)
        }
    }

    /// Drain the next chunk from the buffer (consumer side).
    pub fn drain(&mut self) -> Option<StreamChunk> {
        let chunk = self.buffer.pop_front()?;
        self.buffered_bytes = self.buffered_bytes.saturating_sub(chunk.data.len());
        Some(chunk)
    }

    /// Drain all buffered chunks.
    pub fn drain_all(&mut self) -> Vec<StreamChunk> {
        let chunks: Vec<StreamChunk> = self.buffer.drain(..).collect();
        self.buffered_bytes = 0;
        chunks
    }

    /// Abort the stream, discarding all buffered data.
    pub fn abort(&mut self) {
        self.state = StreamState::Aborted;
        self.buffer.clear();
        self.buffered_bytes = 0;
    }

    /// Close the stream gracefully (no more pushes accepted).
    pub fn close(&mut self) {
        if self.state == StreamState::Open {
            self.state = StreamState::Closed;
        }
    }

    /// Current buffered byte count.
    pub fn buffered_bytes(&self) -> usize {
        self.buffered_bytes
    }

    /// Total bytes received over the lifetime of this stream.
    pub fn total_received(&self) -> usize {
        self.total_received
    }

    /// Number of chunks currently buffered.
    pub fn buffered_chunks(&self) -> usize {
        self.buffer.len()
    }

    /// Check if backpressure is currently active.
    pub fn is_backpressured(&self) -> bool {
        self.buffered_bytes > self.backpressure_threshold
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum StreamError {
    NotOpen(StreamState),
}

impl std::fmt::Display for StreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StreamError::NotOpen(state) => write!(f, "stream is not open (state: {state:?})"),
        }
    }
}

impl std::error::Error for StreamError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(data: &str, is_final: bool) -> StreamChunk {
        StreamChunk {
            data: data.as_bytes().to_vec(),
            is_final,
        }
    }

    #[test]
    fn new_stream_is_open() {
        let session = StreamSession::new(1024);
        assert_eq!(session.state(), StreamState::Open);
        assert_eq!(session.buffered_bytes(), 0);
    }

    #[test]
    fn push_and_drain() {
        let mut session = StreamSession::new(1024);
        session.push(chunk("hello", false)).unwrap();
        session.push(chunk(" world", false)).unwrap();

        assert_eq!(session.buffered_chunks(), 2);
        assert_eq!(session.buffered_bytes(), 11);

        let c1 = session.drain().unwrap();
        assert_eq!(c1.data, b"hello");
        assert_eq!(session.buffered_bytes(), 6);

        let c2 = session.drain().unwrap();
        assert_eq!(c2.data, b" world");
        assert_eq!(session.buffered_bytes(), 0);

        assert!(session.drain().is_none());
    }

    #[test]
    fn backpressure_triggers() {
        let mut session = StreamSession::new(10); // 10 byte threshold
        let result = session.push(chunk("12345678901", false)).unwrap(); // 11 bytes > 10
        assert!(result.is_some());
        let signal = result.unwrap();
        assert_eq!(signal.buffered_bytes, 11);
        assert_eq!(signal.threshold, 10);
        assert!(session.is_backpressured());
    }

    #[test]
    fn no_backpressure_under_threshold() {
        let mut session = StreamSession::new(100);
        let result = session.push(chunk("small", false)).unwrap();
        assert!(result.is_none());
        assert!(!session.is_backpressured());
    }

    #[test]
    fn final_chunk_closes_stream() {
        let mut session = StreamSession::new(1024);
        session.push(chunk("done", true)).unwrap();
        assert_eq!(session.state(), StreamState::Closed);

        // Cannot push after close
        let result = session.push(chunk("more", false));
        assert!(result.is_err());
    }

    #[test]
    fn abort_discards_buffer() {
        let mut session = StreamSession::new(1024);
        session.push(chunk("data1", false)).unwrap();
        session.push(chunk("data2", false)).unwrap();
        assert_eq!(session.buffered_chunks(), 2);

        session.abort();
        assert_eq!(session.state(), StreamState::Aborted);
        assert_eq!(session.buffered_bytes(), 0);
        assert_eq!(session.buffered_chunks(), 0);

        // Cannot push after abort
        let result = session.push(chunk("more", false));
        assert!(result.is_err());
    }

    #[test]
    fn push_after_abort_rejected() {
        let mut session = StreamSession::new(1024);
        session.abort();
        let result = session.push(chunk("data", false));
        assert_eq!(result.unwrap_err(), StreamError::NotOpen(StreamState::Aborted));
    }

    #[test]
    fn total_received_tracks_lifetime() {
        let mut session = StreamSession::new(1024);
        session.push(chunk("12345", false)).unwrap();
        session.push(chunk("67890", false)).unwrap();
        session.drain(); // drain doesn't affect total_received
        assert_eq!(session.total_received(), 10);
    }

    #[test]
    fn drain_all_clears_buffer() {
        let mut session = StreamSession::new(1024);
        session.push(chunk("a", false)).unwrap();
        session.push(chunk("b", false)).unwrap();
        session.push(chunk("c", false)).unwrap();

        let all = session.drain_all();
        assert_eq!(all.len(), 3);
        assert_eq!(session.buffered_bytes(), 0);
        assert_eq!(session.buffered_chunks(), 0);
    }
}
