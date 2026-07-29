use std::time::Duration;

/// HTTP client wrapper with timeout and retry support.
pub struct NetClient {
    client: reqwest::Client,
    max_retries: u32,
}

impl NetClient {
    /// Create a new NetClient with default settings (30s timeout, 2 retries).
    pub fn new() -> Self {
        Self::with_config(Duration::from_secs(30), 2)
    }

    /// Create a NetClient with custom timeout and retry count.
    pub fn with_config(timeout: Duration, max_retries: u32) -> Self {
        let client = reqwest::Client::builder()
            .timeout(timeout)
            .pool_idle_timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_default();

        Self {
            client,
            max_retries,
        }
    }

    /// Perform a GET request with retry.
    pub async fn get(&self, url: &str, headers: &[(String, String)]) -> Result<NetResponse, NetError> {
        self.request_with_retry("GET", url, headers, None).await
    }

    /// Perform a POST request with retry.
    pub async fn post(
        &self,
        url: &str,
        headers: &[(String, String)],
        body: Option<String>,
    ) -> Result<NetResponse, NetError> {
        self.request_with_retry("POST", url, headers, body).await
    }

    async fn request_with_retry(
        &self,
        method: &str,
        url: &str,
        headers: &[(String, String)],
        body: Option<String>,
    ) -> Result<NetResponse, NetError> {
        let mut last_error = NetError::ConnectionFailed("no attempts made".to_string());

        for attempt in 0..=self.max_retries {
            if attempt > 0 {
                // Exponential backoff: 100ms, 200ms, 400ms...
                let delay = Duration::from_millis(100 * 2u64.pow(attempt - 1));
                tokio::time::sleep(delay).await;
            }

            let mut req = match method {
                "GET" => self.client.get(url),
                "POST" => self.client.post(url),
                "PUT" => self.client.put(url),
                "DELETE" => self.client.delete(url),
                _ => self.client.request(reqwest::Method::PATCH, url),
            };

            for (key, value) in headers {
                req = req.header(key.as_str(), value.as_str());
            }

            if let Some(ref body_str) = body {
                req = req.body(body_str.clone());
            }

            match req.send().await {
                Ok(response) => {
                    let status = response.status().as_u16();
                    let resp_headers: Vec<(String, String)> = response
                        .headers()
                        .iter()
                        .filter_map(|(k, v)| {
                            Some((k.to_string(), v.to_str().ok()?.to_string()))
                        })
                        .collect();

                    let body_bytes = response.bytes().await.unwrap_or_default();

                    return Ok(NetResponse {
                        status,
                        headers: resp_headers,
                        body: body_bytes.to_vec(),
                    });
                }
                Err(e) => {
                    last_error = NetError::ConnectionFailed(e.to_string());
                }
            }
        }

        Err(last_error)
    }
}

impl Default for NetClient {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone)]
pub struct NetResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl NetResponse {
    pub fn body_as_string(&self) -> String {
        String::from_utf8_lossy(&self.body).to_string()
    }
}

#[derive(Debug, Clone)]
pub enum NetError {
    ConnectionFailed(String),
    Timeout(String),
}

impl std::fmt::Display for NetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NetError::ConnectionFailed(msg) => write!(f, "connection failed: {msg}"),
            NetError::Timeout(msg) => write!(f, "timeout: {msg}"),
        }
    }
}

impl std::error::Error for NetError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn net_client_creation() {
        let client = NetClient::new();
        assert_eq!(client.max_retries, 2);
    }

    #[test]
    fn net_client_custom_config() {
        let client = NetClient::with_config(Duration::from_secs(5), 0);
        assert_eq!(client.max_retries, 0);
    }

    #[tokio::test]
    async fn request_to_invalid_host_fails() {
        let client = NetClient::with_config(Duration::from_millis(100), 0);
        let result = client.get("http://192.0.2.1:1/nonexistent", &[]).await;
        assert!(result.is_err());
    }

    #[test]
    fn net_response_body_as_string() {
        let resp = NetResponse {
            status: 200,
            headers: vec![],
            body: b"hello world".to_vec(),
        };
        assert_eq!(resp.body_as_string(), "hello world");
    }
}
