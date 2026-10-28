//! 下载重试/进度/上限与 ensure_downloaded_from 安装、清理路径用例（自 cft.rs 平移）。

use super::*;
use crate::browser::cft::download::{download_zip, ensure_downloaded_from};
use std::sync::atomic::{AtomicU64, Ordering};

/// 下载重试：4xx 立即失败（mock 服务端）。
#[tokio::test]
async fn download_4xx_fails_immediately() {
    let (_server, url) = mock_server(move |_req| 404, 1).await;
    let client = reqwest::Client::new();
    let dir = tempfile::tempdir().expect("临时目录");
    let dest = dir.path().join("out.zip");
    let err = download_zip(
        &client,
        &url,
        &dest,
        &DownloadOpts {
            retries: 5,
            backoff: vec![Duration::from_millis(5)],
            progress: None,
        },
        CftLimits::default().max_download_bytes,
    )
    .await
    .expect_err("应失败");
    assert!(err.to_string().contains("4xx"), "4xx 应即时失败：{err}");
    assert!(matches!(err, CftError::DownloadFailed { retries, .. } if retries == 1));
}

/// 下载重试：5xx 重试至上限（计数断言）。
#[tokio::test]
async fn download_5xx_retries_then_fails() {
    let (_server, url) = mock_server(move |_req| 500, 4).await;
    let client = reqwest::Client::new();
    let dir = tempfile::tempdir().expect("临时目录");
    let dest = dir.path().join("out.zip");
    let err = download_zip(
        &client,
        &url,
        &dest,
        &DownloadOpts {
            retries: 3,
            backoff: vec![Duration::from_millis(2)],
            progress: None,
        },
        CftLimits::default().max_download_bytes,
    )
    .await
    .expect_err("应失败");
    assert!(
        matches!(err, CftError::DownloadFailed { retries: 3, .. }),
        "5xx 应重试 3 次：{err}"
    );
}

/// 下载成功：字节一致 + 进度回调触发。
#[tokio::test]
async fn download_success_with_progress() {
    let payload = b"hello chrome zip".to_vec();
    let (_server, url) = mock_server(move |_req| 200, 1).await;
    let client = reqwest::Client::new();
    let dir = tempfile::tempdir().expect("临时目录");
    let dest = dir.path().join("out.zip");
    let calls = Arc::new(AtomicU64::new(0));
    let calls2 = calls.clone();
    download_zip(
        &client,
        &url,
        &dest,
        &DownloadOpts {
            retries: 1,
            backoff: vec![],
            progress: Some(Arc::new(move |_, _| {
                calls2.fetch_add(1, Ordering::SeqCst);
            })),
        },
        CftLimits::default().max_download_bytes,
    )
    .await
    .expect("下载");
    assert_eq!(std::fs::read(&dest).unwrap(), payload);
    assert!(calls.load(Ordering::SeqCst) >= 1, "进度回调应触发");
}

/// 磁盘满/写失败模拟：目标路径父级被文件占位 → 下载失败（I/O 错误可重试后放弃）。
#[tokio::test]
async fn download_write_failure_cleans_up() {
    let (_server, url) = mock_server(move |_req| 200, 1).await;
    let client = reqwest::Client::new();
    let dir = tempfile::tempdir().expect("临时目录");
    // 目标父路径被文件占位 → File::create 失败（模拟磁盘满/权限拒绝）
    let blocker = dir.path().join("block");
    std::fs::write(&blocker, b"not a dir").expect("占位");
    let dest = blocker.join("out.zip");
    let err = download_zip(
        &client,
        &url,
        &dest,
        &DownloadOpts {
            retries: 2,
            backoff: vec![Duration::from_millis(2)],
            progress: None,
        },
        CftLimits::default().max_download_bytes,
    )
    .await
    .expect_err("应失败");
    assert!(matches!(err, CftError::DownloadFailed { .. }));
    assert!(!dest.exists(), "失败后不得残留半成品");
}

/// 下载/解压失败 → ensure_downloaded_from 清理版本目录（损坏 zip 注入）。
#[tokio::test]
async fn ensure_downloaded_corrupt_zip_cleans_up() {
    let (_server, url) = mock_vec_server(b"corrupt-zip-bytes".to_vec(), 1).await;
    let client = reqwest::Client::new();
    let dir = tempfile::tempdir().expect("临时目录");
    let root = dir.path().join("browser");
    let err = ensure_downloaded_from(
        &client,
        "9.9.9.9",
        &url,
        &root,
        &DownloadOpts::default(),
        CftLimits::default(),
    )
    .await
    .expect_err("损坏 zip 应失败");
    assert!(
        err.to_string().contains("解压") || err.to_string().contains("zip"),
        "错误应指向解压失败：{err}"
    );
    assert!(
        !cft_root(&root).join("chrome-9.9.9.9").exists(),
        "失败后版本目录必须清理（残留清理，§2.2）"
    );
}

/// 评审 G2（32 评审 G8 补强）：HTTP 下载失败路径（4xx 立即失败）——
/// 返回 `DownloadFailed` 且版本目录零残留。该失败信号即 discover 回退链
/// 的输入：Auto 链将 CftDownload 探测项 + 原因汇入 probes 后继续回退
/// 系统浏览器（不阻塞启动）；零残留保证回退链无需处理半成品状态。
#[tokio::test]
async fn ensure_downloaded_http_failure_clean_for_fallback() {
    let (_server, url) = mock_server(move |_req| 404, 1).await;
    let client = reqwest::Client::new();
    let dir = tempfile::tempdir().expect("临时目录");
    let root = dir.path().join("browser");
    let err = ensure_downloaded_from(
        &client,
        "9.9.9.8",
        &url,
        &root,
        &DownloadOpts {
            retries: 1,
            backoff: vec![],
            progress: None,
        },
        CftLimits::default(),
    )
    .await
    .expect_err("4xx 下载必须失败");
    assert!(
        matches!(err, CftError::DownloadFailed { retries: 1, .. }),
        "4xx 应立即失败（不重试）：{err}"
    );
    assert!(
        !cft_root(&root).join("chrome-9.9.9.8").exists(),
        "下载失败后版本目录必须清理（回退链前置条件：零残留）"
    );
}

/// 完整成功路径：mock 服务端提供合法 zip → 缓存目录 + 二进制就位。
#[tokio::test]
async fn ensure_downloaded_success_end_to_end() {
    // 构造平台一致的 zip（顶部前缀 chrome-<key>/）
    let key = platform_key().expect("平台键");
    let dir = tempfile::tempdir().expect("临时目录");
    let zip_bytes = {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        let top = format!("chrome-{key}");
        // 平台一致的二进制相对路径（win64: chrome.exe；linux64: chrome-linux64/chrome；
        // macOS: 嵌套 .app 路径）——fixture 不再硬编码 Windows 形态
        let binary_rel = crate::browser::cft::binary_rel_path().expect("平台二进制路径");
        writer.start_file(binary_rel, options).expect("start");
        writer.write_all(b"bin").expect("写入");
        writer
            .start_file(format!("{top}/sub/f.txt"), options)
            .expect("start");
        writer.write_all(b"txt").expect("写入");
        writer.finish().expect("finish").into_inner()
    };
    let (_server, url) = mock_vec_server(zip_bytes, 1).await;
    let client = reqwest::Client::new();
    let root = dir.path().join("browser");
    let cache = ensure_downloaded_from(
        &client,
        "151.0.7922.77",
        &url,
        &root,
        &DownloadOpts::default(),
        CftLimits::default(),
    )
    .await
    .expect("成功");
    assert_eq!(cache.version, "151.0.7922.77");
    assert!(
        cache.binary.is_file(),
        "二进制必须就位：{}",
        cache.binary.display()
    );
    assert_eq!(std::fs::read(&cache.binary).unwrap(), b"bin");
    assert!(
        !cft_root(&root)
            .join("chrome-151.0.7922.77/chrome.zip")
            .exists(),
        "zip 残留应删除"
    );
}

/// 评审 29 §M7：版本注入经 ensure_downloaded_from 拒绝——
/// sanitize 先于一切路径操作（零网络零写入），结构化错误 + 缓存根零残留。
#[tokio::test]
async fn ensure_downloaded_rejects_version_injection() {
    let client = reqwest::Client::new();
    for bad in ["../evil", "a/b", "a\\b", "..", ""] {
        let dir = tempfile::tempdir().expect("临时目录");
        let root = dir.path().join("browser");
        let err = ensure_downloaded_from(
            &client,
            bad,
            "http://127.0.0.1:1/never",
            &root,
            &DownloadOpts::default(),
            CftLimits::default(),
        )
        .await
        .expect_err("非法版本必须拒绝");
        assert!(
            matches!(err, CftError::InvalidVersion(_)),
            "应报 InvalidVersion：{err}"
        );
        assert!(
            !cft_root(&root).join("evil").exists(),
            "路径注入不得写出缓存根外"
        );
        let leftover = if cft_root(&root).exists() {
            std::fs::read_dir(cft_root(&root)).unwrap().count()
        } else {
            0
        };
        assert_eq!(leftover, 0, "缓存根必须零残留");
    }
}

/// 评审 29 §M7：下载超限（Content-Length 已知超限）→ 读取前中止、
/// 不重试（确定性失败）、半成品清理。
#[tokio::test]
async fn download_too_large_aborts_and_cleans() {
    let payload = vec![0x41u8; 65536];
    let (_server, url) = mock_vec_server(payload, 1).await;
    let client = reqwest::Client::new();
    let dir = tempfile::tempdir().expect("临时目录");
    let dest = dir.path().join("out.zip");
    let err = download_zip(
        &client,
        &url,
        &dest,
        &DownloadOpts {
            retries: 3,
            backoff: vec![Duration::from_millis(2)],
            progress: None,
        },
        1024,
    )
    .await
    .expect_err("应因超限失败");
    assert!(err.to_string().contains("上限"), "错误应指向超限：{err}");
    assert!(
        matches!(err, CftError::DownloadFailed { retries: 1, .. }),
        "超限不得重试：{err}"
    );
    assert!(!dest.exists(), "失败后不得残留半成品");
}

/// 评审 29 §M7：分块流（无 Content-Length）累积字节超限 → 中止 + 清理。
#[tokio::test]
async fn download_chunked_too_large_aborts_and_cleans() {
    let payload = vec![0x42u8; 65536];
    let (_server, url) = mock_chunked_server(payload, 4096, 1).await;
    let client = reqwest::Client::new();
    let dir = tempfile::tempdir().expect("临时目录");
    let dest = dir.path().join("out.zip");
    let err = download_zip(
        &client,
        &url,
        &dest,
        &DownloadOpts {
            retries: 1,
            backoff: vec![],
            progress: None,
        },
        1024,
    )
    .await
    .expect_err("应因累积超限失败");
    assert!(err.to_string().contains("上限"), "错误应指向超限：{err}");
    assert!(!dest.exists(), "失败后不得残留半成品");
}

/// 评审 29 §M7：解压超限经 ensure_downloaded_from → 中止 + 版本目录清理。
#[tokio::test]
async fn ensure_downloaded_extract_limit_cleans_up() {
    let key = platform_key().expect("平台键");
    let dir = tempfile::tempdir().expect("临时目录");
    let zip_bytes = {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        let top = format!("chrome-{key}");
        // 平台一致的二进制相对路径（win64: chrome.exe；linux64: chrome-linux64/chrome；
        // macOS: 嵌套 .app 路径）——fixture 不再硬编码 Windows 形态
        let binary_rel = crate::browser::cft::binary_rel_path().expect("平台二进制路径");
        writer.start_file(binary_rel, options).expect("start");
        writer.write_all(b"bin").expect("写入");
        writer
            .start_file(format!("{top}/sub/f.txt"), options)
            .expect("start");
        writer.write_all(b"txt").expect("写入");
        writer.finish().expect("finish").into_inner()
    };
    let (_server, url) = mock_vec_server(zip_bytes, 1).await;
    let client = reqwest::Client::new();
    let root = dir.path().join("browser");
    let limits = CftLimits {
        max_download_bytes: 1024 * 1024 * 1024,
        max_entries: 1,
        max_extract_bytes: 0,
    };
    let err = ensure_downloaded_from(
        &client,
        "9.9.9.7",
        &url,
        &root,
        &DownloadOpts::default(),
        limits,
    )
    .await
    .expect_err("超条目数应失败");
    assert!(
        matches!(err, CftError::TooLarge { .. }),
        "应为上限错误：{err}"
    );
    assert!(
        !cft_root(&root).join("chrome-9.9.9.7").exists(),
        "失败后版本目录必须清理（残留清理，§2.2）"
    );
}

/// 评审 29 §M7：截断 zip（合法文件头 + 截断中心目录）→ 结构化错误 + 版本目录清理。
#[tokio::test]
async fn ensure_downloaded_truncated_zip_cleans_up() {
    let full = build_test_zip(&["chrome-win64/chrome.exe"], b"bin");
    let truncated = full[..full.len() / 2].to_vec();
    let (_server, url) = mock_vec_server(truncated, 1).await;
    let client = reqwest::Client::new();
    let dir = tempfile::tempdir().expect("临时目录");
    let root = dir.path().join("browser");
    let err = ensure_downloaded_from(
        &client,
        "9.9.9.6",
        &url,
        &root,
        &DownloadOpts::default(),
        CftLimits::default(),
    )
    .await
    .expect_err("截断 zip 应失败");
    assert!(err.to_string().contains("zip"), "错误应指向解压失败：{err}");
    assert!(
        !cft_root(&root).join("chrome-9.9.9.6").exists(),
        "失败后版本目录必须清理"
    );
}
