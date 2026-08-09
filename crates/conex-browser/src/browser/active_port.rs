//! DevToolsActivePort 解析与轮询（维度 10 §5）
//!
//! - 时序：50ms 轮询 / 30s deadline / 提前退出检测（§5.1，S0-02 实测 1.3s 级拿到端口）；
//! - 解析：两行纯文本（port + ws_path），纯函数 `parse`（§5.2，单测覆盖）；
//! - 陈旧文件陷阱（S0-02 实测）：强杀后 DevToolsActivePort 残留旧 port/旧 GUID，
//!   必须「启动前删除」+ 轮询窗口内以内容为准（§5.1 第 1 步 + 报告 §4 实现层注意）；
//! - 诊断拼接前 URL 脱敏（评审 21-L10）：stderr 行内可能含敏感参数。
//!
//! 锁纪律（31-security-baseline B8）：本模块无锁。

use crate::browser::endpoint::CdpEndpoint;
use std::path::Path;
use std::time::Duration;

/// Chrome 写入的端口文件（profile 根下）。
pub const ACTIVE_PORT_FILE: &str = "DevToolsActivePort";
/// 轮询间隔（§5.1）。
pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(50);
/// 轮询总超时（§5.1）。
pub const DEFAULT_POLL_TIMEOUT: Duration = Duration::from_secs(30);

/// 解析错误（§5.2 校验规则）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// 空内容/无有效行。
    Empty,
    /// 第一行不是合法端口（非数字/0/越界）。
    InvalidPort(String),
    /// 缺少第二行 ws_path（不默认填充）。
    MissingWsPath,
    /// ws_path 形态非法（不以 `/` 开头 / 含空白或控制字符）。
    InvalidWsPath(String),
}

/// 解析 DevToolsActivePort 内容（§5.2 全规则）。
pub fn parse(content: &str) -> Result<CdpEndpoint, ParseError> {
    let mut lines: Vec<&str> = content
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    // 尾随空行/空白容忍（测试 4），但首行不得为空
    if lines.is_empty() {
        return Err(ParseError::Empty);
    }
    let port_line = lines.remove(0);
    let port: u16 = port_line
        .parse()
        .map_err(|_| ParseError::InvalidPort(port_line.to_string()))?;
    if port == 0 {
        return Err(ParseError::InvalidPort(port_line.to_string()));
    }
    let ws_path = lines
        .first()
        .ok_or(ParseError::MissingWsPath)?
        .to_string();
    if !is_valid_ws_path(&ws_path) {
        return Err(ParseError::InvalidWsPath(ws_path));
    }
    Ok(CdpEndpoint { port, ws_path })
}

/// ws_path 形态校验：以 `/` 开头、无空白/换行/控制字符
/// （形如 `/devtools/browser/<uuid>` 仅作模式提示，不强约束前缀，兼容版本漂移）。
pub fn is_valid_ws_path(path: &str) -> bool {
    if !path.starts_with('/') {
        return false;
    }
    !path
        .chars()
        .any(|c| c.is_whitespace() || c.is_control())
}

/// 删除 profile 根下残留的陈旧 DevToolsActivePort（§5.1 第 1 步，S0-02 陷阱）。
/// 不存在视为成功；其他 I/O 错误忽略（best-effort，启动前尽力而为）。
/// 豁免 clippy 删除禁令：陈旧端口文件为崩溃残留的自家运行期标记
/// （S0-02 实测陷阱），直删语义与 R-2 一致（运行期文件非用户资产）。
#[allow(clippy::disallowed_methods)]
pub fn remove_stale_active_port(profile_dir: &Path) {
    let path = profile_dir.join(ACTIVE_PORT_FILE);
    match std::fs::remove_file(&path) {
        Ok(()) => {
            tracing::debug!("已删除残留 DevToolsActivePort：{}", path.display());
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            tracing::warn!("删除残留 DevToolsActivePort 失败（忽略）：{e}");
        }
    }
}

/// 轮询设置（默认 50ms/30s，测试注入缩短）。
#[derive(Debug, Clone, Copy)]
pub struct PollSettings {
    pub interval: Duration,
    pub timeout: Duration,
}

impl Default for PollSettings {
    fn default() -> Self {
        PollSettings {
            interval: DEFAULT_POLL_INTERVAL,
            timeout: DEFAULT_POLL_TIMEOUT,
        }
    }
}

/// 轮询结果（提前退出/超时携带 stderr 诊断）。
#[derive(Debug, Clone)]
pub enum WaitOutcome {
    /// 解析成功（§5.2 校验通过）。
    Endpoint(CdpEndpoint),
    /// 子进程提前退出（§5.1 第 3 步 a）。
    EarlyExit { exit_code: i32, stderr: String },
    /// 超时（§5.1 第 4 步）。
    Timeout { stderr: String },
}

/// stderr 环形缓冲（最近 N 行，失败路径诊断拼接）。
#[derive(Debug, Default)]
pub struct StderrRing {
    lines: std::collections::VecDeque<String>,
    cap: usize,
}

impl StderrRing {
    pub fn new(cap: usize) -> Self {
        StderrRing {
            lines: std::collections::VecDeque::new(),
            cap: cap.max(1),
        }
    }

    pub fn push(&mut self, line: String) {
        if self.lines.len() == self.cap {
            self.lines.pop_front();
        }
        self.lines.push_back(line);
    }

    /// 原始快照。
    pub fn snapshot(&self) -> Vec<String> {
        self.lines.iter().cloned().collect()
    }

    /// 拼接 + URL 脱敏（评审 21-L10：行内可能含 query 敏感参数）。
    pub fn redacted_join(&self) -> String {
        redact_urls(&self.lines.iter().cloned().collect::<Vec<_>>().join("\n"))
    }
}

/// URL 脱敏：`ws://...`/`http(s)://...` 直至空白为止整段替换为 `<redacted>`。
/// 无 regex 依赖，纯字节扫描（够用即可）。
pub fn redact_urls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let is_scheme = |j: usize, scheme: &[u8]| -> bool {
            bytes[j..].starts_with(scheme)
                && (j == 0 || !is_url_char(bytes[j - 1]))
                && (j + scheme.len() >= bytes.len() || bytes[j + scheme.len()] != b':')
        };
        if is_scheme(i, b"ws://") || is_scheme(i, b"wss://")
            || is_scheme(i, b"http://") || is_scheme(i, b"https://")
        {
            out.push_str("<redacted>");
            // 跳到 URL 结尾（空白/行尾）
            while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
                i += 1;
            }
        } else {
            let c = text[i..].chars().next().expect("非空");
            out.push(c);
            i += c.len_utf8();
        }
    }
    out
}

/// 是否为 URL 字符（用于 scheme 边界判断）。
fn is_url_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+')
}

/// 轮询入口：spawn 后的子进程 + stderr 环形缓冲（tokio Mutex 跨 await 持有，
/// 由后台 stderr 读取任务填充、失败路径快照）。
/// `child` 为 None 时跳过提前退出检测（纯文件轮询，测试注入用）。
pub async fn wait_active_port(
    profile_dir: &Path,
    mut child: Option<&mut tokio::process::Child>,
    stderr: &tokio::sync::Mutex<StderrRing>,
    settings: &PollSettings,
) -> WaitOutcome {
    let start = tokio::time::Instant::now();
    let file = profile_dir.join(ACTIVE_PORT_FILE);
    loop {
        // a. 提前退出检测（§5.1 第 3 步 a）
        if let Some(c) = child.as_mut() {
            if let Ok(Some(status)) = c.try_wait() {
                let code = status.code().unwrap_or(-1);
                return WaitOutcome::EarlyExit {
                    exit_code: code,
                    stderr: stderr.lock().await.redacted_join(),
                };
            }
        }
        // b. 读文件并解析（解析失败视为未就绪，继续轮询）
        if let Ok(content) = tokio::fs::read_to_string(&file).await {
            if let Ok(ep) = parse(&content) {
                return WaitOutcome::Endpoint(ep);
            }
        }
        if start.elapsed() >= settings.timeout {
            return WaitOutcome::Timeout {
                stderr: stderr.lock().await.redacted_join(),
            };
        }
        tokio::time::sleep(settings.interval).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 两行合法 → port/ws_path 正确（S0-02 实测格式）。
    #[test]
    fn parse_valid_two_line() {
        let content = "38689\n/devtools/browser/ba90110e-33a1-4569-9dd1-5437b8f729b0\n";
        let ep = parse(content).expect("合法内容");
        assert_eq!(ep.port, 38689);
        assert_eq!(ep.ws_path, "/devtools/browser/ba90110e-33a1-4569-9dd1-5437b8f729b0");
    }

    /// 端口校验：非数字/0/越界 → InvalidPort。
    #[test]
    fn parse_rejects_invalid_port() {
        for bad in ["abc", "0", "65536", "-1", "3.14", "99999", "0x10"].map(str::to_string) {
            let content = format!("{bad}\n/devtools/browser/x\n");
            assert!(
                matches!(parse(&content), Err(ParseError::InvalidPort(_))),
                "应拒绝端口：{bad}"
            );
        }
    }

    /// 缺少 ws_path（单行/空第二行）→ 错误，不默认填充。
    #[test]
    fn parse_rejects_missing_ws_path() {
        assert!(matches!(parse("38689\n"), Err(ParseError::MissingWsPath)));
        assert!(matches!(parse("38689"), Err(ParseError::MissingWsPath)));
        assert!(matches!(parse("38689\n  \n"), Err(ParseError::MissingWsPath)));
    }

    /// 尾随空白/空行容忍。
    #[test]
    fn parse_ignores_trailing_blank() {
        let ep = parse("38689\n/devtools/browser/x\n\n\n  \n").expect("容忍尾随空行");
        assert_eq!(ep.port, 38689);
        let ep = parse(" 38689 \n /devtools/browser/x ").expect("容忍行内空白");
        assert_eq!(ep.port, 38689);
    }

    /// 注入拒绝：ws_path 含换行/控制字符/非 `/` 开头。
    #[test]
    fn parse_rejects_injection() {
        // 第二行内嵌 \r（非行尾）→ 控制字符拒绝（行尾 \r\n 由 lines() 归一容忍）
        let content = "38689\n/devtools/browser/a\r127.0.0.1:9999\n";
        assert!(matches!(parse(content), Err(ParseError::InvalidWsPath(_))));
        // 控制字符
        assert!(matches!(
            parse("38689\n/devtools/browser/\u{7}\n"),
            Err(ParseError::InvalidWsPath(_))
        ));
        // 不以 / 开头
        assert!(matches!(
            parse("38689\ndevtools/browser/x\n"),
            Err(ParseError::InvalidWsPath(_))
        ));
        // 制表符
        assert!(matches!(
            parse("38689\n/devtools/browser/\t x\n"),
            Err(ParseError::InvalidWsPath(_))
        ));
        // 空文件
        assert!(matches!(parse(""), Err(ParseError::Empty)));
        // 行尾 CRLF 为合法行终止（Windows 落盘形态），解析容忍
        let ep = parse("38689\r\n/devtools/browser/a\r\n").expect("容忍 CRLF");
        assert_eq!(ep.port, 38689);
        assert_eq!(ep.ws_path, "/devtools/browser/a");
    }

    /// 端口边界：1 与 65535 合法。
    #[test]
    fn parse_port_boundaries() {
        assert_eq!(parse("1\n/p\n").unwrap().port, 1);
        assert_eq!(parse("65535\n/p\n").unwrap().port, 65535);
    }

    /// 轮询：合法文件 → Endpoint（mock 文件 + 不 spawn 子进程，直接驱动内部循环）。
    #[tokio::test]
    async fn wait_active_port_reads_file() {
        let dir = tempfile::tempdir().expect("临时目录");
        let path = dir.path().join(ACTIVE_PORT_FILE);
        std::fs::write(&path, "12345\n/devtools/browser/t\n").expect("写入");

        // 直接以「无子进程」驱动：纯文件轮询（child=None 跳过退出检测）
        let ring = tokio::sync::Mutex::new(StderrRing::new(20));
        let outcome = wait_active_port(
            dir.path(),
            None,
            &ring,
            &PollSettings {
                interval: Duration::from_millis(5),
                timeout: Duration::from_secs(2),
            },
        )
        .await;
        match outcome {
            WaitOutcome::Endpoint(ep) => {
                assert_eq!(ep.port, 12345);
                assert_eq!(ep.ws_path, "/devtools/browser/t");
            }
            other => panic!("应为 Endpoint，实际：{other:?}"),
        }
    }

    /// 陈旧残留：预置旧内容 → 启动前删除 → 轮询到的是新内容。
    #[test]
    fn stale_file_removed_before_poll() {
        let dir = tempfile::tempdir().expect("临时目录");
        let path = dir.path().join(ACTIVE_PORT_FILE);
        std::fs::write(&path, "9999\n/devtools/browser/stale\n").expect("写入陈旧内容");
        remove_stale_active_port(dir.path());
        assert!(!path.exists(), "启动前必须删除陈旧文件（S0-02 陷阱）");
    }

    /// 端口越界（65536）与路径注入在 parse 层已覆盖；此处验证 remove 对不存在文件幂等。
    #[test]
    fn remove_stale_idempotent() {
        let dir = tempfile::tempdir().expect("临时目录");
        remove_stale_active_port(dir.path()); // 不存在 → 无 panic
    }

    /// URL 脱敏：ws:// 与 query 参数整段替换。
    #[test]
    fn redact_urls_masks_schemes() {
        let input = "DevTools listening on ws://127.0.0.1:38689/devtools/browser/uuid\n"
            .to_string()
            + "error url: https://a.example/query?secret=1&token=abc done";
        let out = redact_urls(&input);
        assert!(!out.contains("38689"));
        assert!(!out.contains("ws://"));
        assert!(!out.contains("secret=1"));
        assert!(!out.contains("token=abc"));
        assert!(out.contains("<redacted>"));
        assert!(out.contains("DevTools listening on"));
    }

    /// 脱敏不误伤普通文本。
    #[test]
    fn redact_urls_keeps_plain_text() {
        let out = redact_urls("normal line with words and http like text");
        assert_eq!(out, "normal line with words and http like text");
    }

    /// StderrRing：容量上限 + 快照 + 脱敏拼接。
    #[test]
    fn stderr_ring_cap_and_join() {
        let mut ring = StderrRing::new(3);
        ring.push("a".into());
        ring.push("ws://127.0.0.1:1/x".into());
        ring.push("c".into());
        ring.push("d".into());
        assert_eq!(
            ring.snapshot(),
            vec![
                "ws://127.0.0.1:1/x".to_string(),
                "c".to_string(),
                "d".to_string()
            ]
        );
        let joined = ring.redacted_join();
        assert!(!joined.contains("127.0.0.1"));
        assert!(joined.contains("<redacted>"));
    }
}
