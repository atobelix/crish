use serde::{Deserialize, Serialize};
use std::io::{BufRead, Write};

#[derive(Deserialize)]
struct HttpRequest {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
    // 保留字段以维持向后兼容；daemon 模式下总是流式转发 body
    #[serde(rename = "streamBody")]
    #[allow(dead_code)]
    stream_body: Option<bool>,
}

#[derive(Serialize)]
struct HttpResponseHeader {
    status: u16,
    #[serde(rename = "statusText")]
    status_text: Option<String>,
    headers: Vec<(String, String)>,
    error: Option<String>,
    // chunked=true 时 header 行之后跟随分块帧流；chunked=false 时无 body（仅用于错误响应）
    #[serde(rename = "chunked")]
    chunked: bool,
}

// 单线程 runtime：daemon 串行处理请求，无需多线程；匹配 Cargo.toml 的 tokio features（rt+macros+io-std，不含 rt-multi-thread）
#[tokio::main(flavor = "current_thread")]
async fn main() {
    // 在进程启动时创建一次 reqwest::Client，跨请求复用连接池
    // （与原实现的关键差异：原实现每次 spawn 新进程，client 连接池无法跨请求复用）
    let client = reqwest::Client::builder()
        .pool_idle_timeout(std::time::Duration::from_secs(60))
        .build()
        .unwrap_or_else(|e| {
            eprintln!("Failed to build HTTP client: {e}");
            std::process::exit(1);
        });

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    // daemon 主循环：从 stdin 读取行分隔的 JSON 请求 → 处理 → 写响应到 stdout → 继续读下一行
    // stdin EOF（父进程关闭）时退出循环，进程退出
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("Failed to read stdin: {e}");
                break;
            }
        };
        if line.is_empty() {
            continue;
        }

        let request: HttpRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let err_header = HttpResponseHeader {
                    status: 0,
                    status_text: None,
                    headers: vec![],
                    error: Some(format!("Failed to parse request JSON: {e}")),
                    chunked: false,
                };
                let _ = write_response_header(&err_header, &mut stdout);
                continue;
            }
        };

        if let Err(e) = process_request(&client, &request, &mut stdout).await {
            eprintln!("Request processing failed: {e}");
            // daemon 不因单个请求失败而退出，继续服务下一个请求
        }
    }
}

async fn process_request(
    client: &reqwest::Client,
    request: &HttpRequest,
    stdout: &mut std::io::Stdout,
) -> Result<(), Box<dyn std::error::Error>> {
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
    if let Some(timeout_ms) = request.timeout_ms {
        req_builder = req_builder.timeout(std::time::Duration::from_millis(timeout_ms));
    }
    for (key, value) in &request.headers {
        req_builder = req_builder.header(key.as_str(), value.as_str());
    }
    if let Some(body) = &request.body {
        req_builder = req_builder.body(body.clone());
    }

    let mut response = match req_builder.send().await {
        Ok(r) => r,
        Err(e) => {
            let err_header = HttpResponseHeader {
                status: 0,
                status_text: None,
                headers: vec![],
                error: Some(format!("HTTP request failed: {e}")),
                chunked: false,
            };
            write_response_header(&err_header, stdout)?;
            return Ok(());
        }
    };

    let status = response.status();
    let status_text = status.canonical_reason().map(|s| s.to_string());
    let headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .filter_map(|(k, v)| Some((k.to_string(), v.to_str().ok()?.to_string())))
        .collect();

    // 写响应头（chunked=true），随后流式转发 body 分块
    // 分块帧协议（行分隔，逐帧写入 stdout）：
    //   数据帧: <十进制长度>\n<对应字节数>
    //   结束帧: 0\n
    //   错误帧: -1\n<单行错误信息>\n
    // 客户端按帧解析并推入 ReadableStream，实现端到端流式转发，避免全量缓冲。
    let header = HttpResponseHeader {
        status: status.as_u16(),
        status_text,
        headers,
        error: None,
        chunked: true,
    };
    write_response_header(&header, stdout)?;

    // 流式读取 upstream body 并逐帧写入 stdout
    // response.chunk() 增量返回网络数据，不缓冲完整 body，保持流式优势
    let mut frame_buf: Vec<u8> = Vec::with_capacity(8192);
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                let len = chunk.len();
                frame_buf.clear();
                frame_buf.extend_from_slice(len.to_string().as_bytes());
                frame_buf.push(b'\n');
                frame_buf.extend_from_slice(&chunk);
                stdout.write_all(&frame_buf)?;
                stdout.flush()?;
            }
            Ok(None) => {
                // body 读完，写结束帧
                stdout.write_all(b"0\n")?;
                stdout.flush()?;
                break;
            }
            Err(e) => {
                // 中途读取失败：写错误帧通知客户端流中断
                let msg = format!("{e}").replace(['\n', '\r'], " ");
                stdout.write_all(b"-1\n")?;
                stdout.write_all(msg.as_bytes())?;
                stdout.write_all(&[b'\n'])?;
                stdout.flush()?;
                break;
            }
        }
    }
    Ok(())
}

fn write_response_header(
    header: &HttpResponseHeader,
    stdout: &mut std::io::Stdout,
) -> Result<(), std::io::Error> {
    let json = serde_json::to_string(header)?;
    stdout.write_all(json.as_bytes())?;
    stdout.write_all(&[b'\n'])?;
    stdout.flush()?;
    Ok(())
}
