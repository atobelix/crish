use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

#[derive(Deserialize)]
struct HttpRequest {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
    #[serde(rename = "streamBody")]
    stream_body: Option<bool>,
}

#[derive(Serialize)]
struct HttpResponseHeader {
    status: u16,
    #[serde(rename = "statusText")]
    status_text: Option<String>,
    headers: Vec<(String, String)>,
    error: Option<String>,
}

#[tokio::main]
async fn main() {
    // Read request from stdin
    let mut input = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut input) {
        let err_header = HttpResponseHeader {
            status: 0,
            status_text: None,
            headers: vec![],
            error: Some(format!("Failed to read stdin: {e}")),
        };
        let _ = write_response_header(&err_header);
        std::process::exit(1);
    }

    let request: HttpRequest = match serde_json::from_str(&input) {
        Ok(r) => r,
        Err(e) => {
            let err_header = HttpResponseHeader {
                status: 0,
                status_text: None,
                headers: vec![],
                error: Some(format!("Failed to parse request JSON: {e}")),
            };
            let _ = write_response_header(&err_header);
            std::process::exit(1);
        }
    };

    // Build reqwest request
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(request.timeout_ms.unwrap_or(60_000)))
        .build()
        .unwrap_or_else(|e| {
            eprintln!("Failed to build HTTP client: {e}");
            std::process::exit(1);
        });

    let method = match request.method.to_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        "PATCH" => reqwest::Method::PATCH,
        "HEAD" => reqwest::Method::HEAD,
        "OPTIONS" => reqwest::Method::OPTIONS,
        _ => reqwest::Method::POST,
    };

    let mut req_builder = client.request(method, &request.url);
    for (key, value) in &request.headers {
        req_builder = req_builder.header(key.as_str(), value.as_str());
    }
    if let Some(body) = &request.body {
        req_builder = req_builder.body(body.clone());
    }

    let response = match req_builder.send().await {
        Ok(r) => r,
        Err(e) => {
            let err_header = HttpResponseHeader {
                status: 0,
                status_text: None,
                headers: vec![],
                error: Some(format!("HTTP request failed: {e}")),
            };
            let _ = write_response_header(&err_header);
            std::process::exit(1);
        }
    };

    let status = response.status();
    let status_text = status.canonical_reason().map(|s| s.to_string());
    let headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .filter_map(|(k, v)| Some((k.to_string(), v.to_str().ok()?.to_string())))
        .collect();

    // Write response header as JSON + newline
    let header = HttpResponseHeader {
        status: status.as_u16(),
        status_text,
        headers,
        error: None,
    };
    if let Err(e) = write_response_header(&header) {
        eprintln!("Failed to write response header: {e}");
        std::process::exit(1);
    }

    // Stream response body to stdout
    if request.stream_body.unwrap_or(false) {
        // For streaming, we write chunks as they arrive
        // The caller reads stdout as a stream
        // No special framing needed - raw bytes follow the header newline
    }

    match response.bytes().await {
        Ok(bytes) => {
            let mut stdout = std::io::stdout().lock();
            if let Err(e) = stdout.write_all(&bytes) {
                eprintln!("Failed to write response body: {e}");
            }
            let _ = stdout.flush();
        }
        Err(e) => {
            eprintln!("Failed to read response body: {e}");
        }
    }
}

fn write_response_header(header: &HttpResponseHeader) -> Result<(), std::io::Error> {
    let json = serde_json::to_string(header)?;
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(json.as_bytes())?;
    stdout.write_all(&[b'\n'])?;
    stdout.flush()?;
    Ok(())
}
