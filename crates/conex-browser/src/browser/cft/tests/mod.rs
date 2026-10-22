//! browser::cft 单元测试：公共导入与 mock HTTP 服务端 / zip fixture（自 cft.rs 平移）。

use super::*;
use std::io::Write;

mod download;
mod locate_extract;

// ---------- mock HTTP 服务端（tokio TcpListener，仅测试用） ----------

/// 按状态码应答（200 返回固定正文）。
async fn mock_server<F>(mut handler: F, count: usize) -> (tokio::task::JoinHandle<()>, String)
where
    F: FnMut(&str) -> u16 + Send + 'static,
{
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("绑定");
    let addr = listener.local_addr().expect("地址");
    let url = format!("http://{addr}/file.zip");
    let handle = tokio::spawn(async move {
        let mut served = 0;
        while served < count {
            let (mut sock, _) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => break,
            };
            served += 1;
            let mut buf = [0u8; 2048];
            let _ = tokio::io::AsyncReadExt::read(&mut sock, &mut buf).await;
            let status = handler("req");
            let body = if status == 200 {
                b"hello chrome zip".to_vec()
            } else {
                Vec::new()
            };
            let reason = if status == 200 { "OK" } else { "Err" };
            write_http(&mut sock, status, reason, &body).await;
        }
    });
    (handle, url)
}

/// 固定字节应答（损坏 zip / 合法 zip 注入）。
async fn mock_vec_server(payload: Vec<u8>, count: usize) -> (tokio::task::JoinHandle<()>, String) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("绑定");
    let addr = listener.local_addr().expect("地址");
    let url = format!("http://{addr}/payload");
    let handle = tokio::spawn(async move {
        for _ in 0..count {
            let (mut sock, _) = listener.accept().await.expect("accept");
            let mut buf = [0u8; 2048];
            let _ = tokio::io::AsyncReadExt::read(&mut sock, &mut buf).await;
            write_http(&mut sock, 200, "OK", &payload).await;
        }
    });
    (handle, url)
}

/// 分块编码应答（无 Content-Length，测累积字节上限路径）。
async fn mock_chunked_server(
    payload: Vec<u8>,
    chunk: usize,
    count: usize,
) -> (tokio::task::JoinHandle<()>, String) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("绑定");
    let addr = listener.local_addr().expect("地址");
    let url = format!("http://{addr}/chunked");
    let handle = tokio::spawn(async move {
        for _ in 0..count {
            let (mut sock, _) = listener.accept().await.expect("accept");
            let mut buf = [0u8; 2048];
            let _ = tokio::io::AsyncReadExt::read(&mut sock, &mut buf).await;
            use tokio::io::AsyncWriteExt;
            let _ = sock
                .write_all(
                    b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                )
                .await;
            for part in payload.chunks(chunk) {
                let _ = sock
                    .write_all(format!("{:x}\r\n", part.len()).as_bytes())
                    .await;
                let _ = sock.write_all(part).await;
                let _ = sock.write_all(b"\r\n").await;
            }
            let _ = sock.write_all(b"0\r\n\r\n").await;
        }
    });
    (handle, url)
}

/// 构造简单 zip（多文件同内容，Stored 压缩，供上限测试的确定性 fixture）。
fn build_test_zip(files: &[&str], content: &[u8]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for name in files {
        writer
            .start_file(name.to_string(), options)
            .expect("start_file");
        writer.write_all(content).expect("写入");
    }
    writer.finish().expect("finish").into_inner()
}

async fn write_http(sock: &mut tokio::net::TcpStream, status: u16, reason: &str, body: &[u8]) {
    use tokio::io::AsyncWriteExt;
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = sock.write_all(head.as_bytes()).await;
    if !body.is_empty() {
        let _ = sock.write_all(body).await;
    }
}

/// 写入正常 zip（src 目录整体打包）。
fn write_test_zip(zip_path: &Path, src: &Path) {
    let file = std::fs::File::create(zip_path).expect("创建 zip");
    let mut writer = zip::ZipWriter::new(file);
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    fn add_dir(
        writer: &mut zip::ZipWriter<std::fs::File>,
        base: &Path,
        rel: &Path,
        options: zip::write::SimpleFileOptions,
    ) {
        for entry in std::fs::read_dir(base.join(rel)).expect("read_dir") {
            let entry = entry.expect("entry");
            let path = entry.path();
            let rel_path = rel.join(entry.file_name());
            if path.is_dir() {
                let name = format!("{}/", rel_path.to_string_lossy().replace('\\', "/"));
                writer.add_directory(name, options).expect("add_directory");
                add_dir(writer, base, &rel_path, options);
            } else {
                let name = rel_path.to_string_lossy().replace('\\', "/");
                writer.start_file(name, options).expect("start_file");
                std::io::copy(&mut std::fs::File::open(&path).expect("open"), writer)
                    .expect("copy");
            }
        }
    }
    add_dir(&mut writer, src, Path::new(""), options);
    writer.finish().expect("finish");
}

/// 写入含路径穿越条目的 zip（手工构造条目名）。
fn write_evil_zip(zip_path: &Path, evil_name: &str, content: &[u8]) {
    let file = std::fs::File::create(zip_path).expect("创建 zip");
    let mut writer = zip::ZipWriter::new(file);
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    writer
        .start_file(evil_name.to_string(), options)
        .expect("start_file");
    writer.write_all(content).expect("写入");
    writer.finish().expect("finish");
}
