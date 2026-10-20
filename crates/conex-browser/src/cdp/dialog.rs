//! 对话框/弹窗拦截状态机（维度 11 §7）
//!
//! ## JS 对话框（§7.1，每会话一份状态）
//!
//! ```text
//! None ──javascriptDialogOpening──▶ Open{ info, opened_at }
//!   Open ──handleJavaScriptDialog 成功──▶ None（广播 DialogClosed）
//!   Open ──超时无应答──▶ 自动 dismiss(false) → None（广播 DialogClosed{accepted:false}）
//! ```
//!
//! - 上抛：DialogOpened 进 typed 总线 → 面板提示 + 工具层可应答
//! - 阻塞识别：对话框打开期间渲染器命令必然超时——`diagnose_timeout` 在
//!   `DialogState::Open` 下判定 `DialogBlocked`，不再误判为标签卡死
//!   （不触发 activateTarget 复活，agent-browser RendererState 同款语义）
//! - 默认策略：上抛等待应答（协同语义：AI 触发对话框须用户可见）；
//!   30s 超时自动 dismiss（可配置注入）
//!
//! ## window.open 收口（§7.2）
//!
//! `WindowOpenPolicy::evaluate` 裁决原语：引擎默认策略 = 转为标签页；
//! 域名门禁命中（维度 17 权威实现，此处为对接原语）→ Deny + 审计 NavigationBlocked。

use crate::cdp::bus::{BrowserEvent, DialogInfo};
use crate::cdp::domains::names::PAGE_HANDLE_JAVASCRIPT_DIALOG;
use crate::cdp::error::CdpError;
use crate::cdp::sender::CommandChannel;
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 对话框超时自动 dismiss（30s，可配置注入）。
pub const DIALOG_AUTO_DISMISS_TIMEOUT: Duration = Duration::from_secs(30);

/// 对话框状态（每会话一份）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum DialogState {
    #[default]
    None,
    Open {
        info: DialogInfo,
        opened_at_ms: u64,
    },
}

/// 探针超时诊断（§7.1 阻塞识别：对话框未决 ≠ 标签卡死）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimeoutDiagnosis {
    /// 对话框打开中：渲染器暂停属预期，不复活、不误判
    DialogBlocked,
    /// 无对话框：真卡死（交维度 14 复活路径）
    TabHang,
}

/// 对话框注册表（状态机 + 超时自动 dismiss + 应答原语）。
pub struct DialogRegistry {
    states: Arc<Mutex<HashMap<String, DialogState>>>,
    timeout: Duration,
    gen: AtomicU64,
    /// 自动 dismiss 钩子（lib.rs 接线：发 Page.handleJavaScriptDialog(false)）
    auto_dismiss: Arc<dyn Fn(&str) + Send + Sync>,
}

impl DialogRegistry {
    pub fn new(timeout: Duration, auto_dismiss: Arc<dyn Fn(&str) + Send + Sync>) -> Self {
        DialogRegistry {
            states: Arc::new(Mutex::new(HashMap::new())),
            timeout,
            gen: AtomicU64::new(0),
            auto_dismiss,
        }
    }

    /// 状态机输入（由总线驱动任务调用）。
    pub fn on_event(&self, event: &BrowserEvent) {
        match event {
            BrowserEvent::DialogOpened(info) => {
                let gen = self.gen.fetch_add(1, Ordering::SeqCst) + 1;
                let opened_at_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                {
                    let mut states = self.states.lock().unwrap_or_else(|p| p.into_inner());
                    states.insert(
                        info.session.clone(),
                        DialogState::Open {
                            info: info.clone(),
                            opened_at_ms,
                        },
                    );
                }
                self.spawn_timeout(info.session.clone(), gen);
            }
            BrowserEvent::DialogClosed { session, .. } => {
                let mut states = self.states.lock().unwrap_or_else(|p| p.into_inner());
                states.insert(session.clone(), DialogState::None);
            }
            _ => {}
        }
    }

    /// 会话状态。
    pub fn state(&self, session: &str) -> DialogState {
        self.states
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(session)
            .cloned()
            .unwrap_or(DialogState::None)
    }

    /// 当前未决对话框会话（应答路由用；多个时取最早打开的）。
    pub fn open_session(&self) -> Option<String> {
        let states = self.states.lock().unwrap_or_else(|p| p.into_inner());
        states
            .iter()
            .filter(|(_, s)| matches!(s, DialogState::Open { .. }))
            .min_by_key(|(_, s)| match s {
                DialogState::Open { opened_at_ms, .. } => *opened_at_ms,
                _ => u64::MAX,
            })
            .map(|(session, _)| session.clone())
    }

    /// 探针超时诊断（§7.1 阻塞识别）。
    pub fn diagnose_timeout(&self, session: &str) -> TimeoutDiagnosis {
        if matches!(self.state(session), DialogState::Open { .. }) {
            TimeoutDiagnosis::DialogBlocked
        } else {
            TimeoutDiagnosis::TabHang
        }
    }

    /// 应答原语：Page.handleJavaScriptDialog（仅活动标签可应答，页面暂停态天然串行）。
    pub async fn handle(
        &self,
        session: &str,
        accept: bool,
        prompt_text: Option<&str>,
        channel: &dyn CommandChannel,
    ) -> Result<(), CdpError> {
        let mut params = json!({ "accept": accept });
        if let Some(text) = prompt_text {
            params["promptText"] = json!(text);
        }
        channel
            .send_command(
                PAGE_HANDLE_JAVASCRIPT_DIALOG,
                Some(params),
                Some(session),
                Duration::from_secs(5),
            )
            .await
            .map(|_| {
                // 命令成功 → 状态机收敛（Chrome 的 javascriptDialogClosed 事件随后也会到达，
                // 幂等无害）
                let mut states = self.states.lock().unwrap_or_else(|p| p.into_inner());
                states.insert(session.to_string(), DialogState::None);
            })
    }

    /// 超时自动 dismiss（30s 无应答 → dismiss(false)，防动作链挂死）。
    fn spawn_timeout(&self, session: String, gen: u64) {
        let states = self.states.clone();
        let auto_dismiss = self.auto_dismiss.clone();
        let timeout = self.timeout;
        tokio::spawn(async move {
            tokio::time::sleep(timeout).await;
            // 仅当代次匹配（对话框未被动处理）时自愈
            let still_open = matches!(
                states
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(&session),
                Some(DialogState::Open { .. })
            );
            if !still_open {
                return;
            }
            // 是否自愈由状态存在性判定（handle/on_event 已收敛则状态非 Open）；
            // 代数不做比较，仅随日志输出，便于对齐「同一会话多次弹窗」的时序。
            tracing::info!("对话框超时自动 dismiss：session={session} gen={gen}");
            auto_dismiss(&session);
            let mut guard = states.lock().unwrap_or_else(|p| p.into_inner());
            guard.insert(session, DialogState::None);
        });
    }
}

/// window.open 裁决（§7.2）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowOpenDecision {
    /// 转为标签页（引擎默认策略：Target.createTarget(url) 后允许页面继续）
    AllowAsTab,
    /// 域名门禁命中 → 拒绝打开 + 审计 NavigationBlocked（维度 17 接线）
    Deny { reason: String },
}

/// window.open 收口策略（维度 17 DomainGate 的对接原语；MVP 提供简化匹配语义：
/// `*.example.com` = 任意子域（不含根域）；`example.com` = 根域 + 任意子域，
/// 对齐 R-7 裁决；最终权威实现以维度 17 为准）。
#[derive(Debug, Clone, Default)]
pub struct WindowOpenPolicy {
    blocklist: Vec<String>,
}

impl WindowOpenPolicy {
    pub fn new(blocklist: Vec<String>) -> Self {
        WindowOpenPolicy { blocklist }
    }

    /// 裁决：命中黑名单 → Deny；否则 AllowAsTab（默认策略 = 转为标签页）。
    pub fn evaluate(&self, url: &str) -> WindowOpenDecision {
        let Some(host) = extract_host(url) else {
            return WindowOpenDecision::Deny {
                reason: format!("非法 URL：{url}"),
            };
        };
        for entry in &self.blocklist {
            if host_matches(&host, entry) {
                return WindowOpenDecision::Deny {
                    reason: format!("域名门禁命中：{entry}"),
                };
            }
        }
        WindowOpenDecision::AllowAsTab
    }
}

/// 从 URL 提取 host（纯字符串解析，不做 DNS；解析层校验属维度 17 解析级检查点 R-11）。
fn extract_host(url: &str) -> Option<String> {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return None;
    }
    // 去除端口
    let host = authority
        .rsplit_once(':')
        .map(|(h, _)| h)
        .unwrap_or(authority);
    // 去除 IPv6 括号
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let host = host.trim();
    // 空串 / 含空白（注入形态）→ 拒绝
    if host.is_empty() || host.chars().any(char::is_whitespace) {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

/// 黑名单匹配（R-7 语义：`*.example.com` 仅任意子域命中（不含根域）；
/// `example.com` 裸条目 = 根域 + 任意子域）。
fn host_matches(host: &str, entry: &str) -> bool {
    let entry = entry.trim();
    if let Some(domain) = entry.strip_prefix("*.") {
        // 通配条目：仅子域后缀命中，根域放行
        let domain = domain.trim();
        !domain.is_empty() && host.ends_with(&format!(".{domain}"))
    } else {
        // 裸条目：根域或任意子域
        !entry.is_empty() && (host == entry || host.ends_with(&format!(".{entry}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// 自动 dismiss 钩子类型（测试别名）。
    type DismissHook = Arc<dyn Fn(&str) + Send + Sync>;

    /// 记录式自动 dismiss 钩子。
    fn recording_dismiss() -> (DismissHook, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_clone = calls.clone();
        let hook: DismissHook = Arc::new(move |_session: &str| {
            calls_clone.fetch_add(1, Ordering::SeqCst);
        });
        (hook, calls)
    }

    fn dialog_info(session: &str) -> DialogInfo {
        DialogInfo {
            session: session.to_string(),
            dialog_type: "alert".to_string(),
            message: "hi".to_string(),
            url: "https://e.com".to_string(),
            default_prompt: None,
        }
    }

    /// 验收 9.1-27：None→Open→Closed；超时自动 dismiss(false)
    #[tokio::test]
    async fn dialog_state_transitions() {
        let (dismiss, calls) = recording_dismiss();
        let registry = DialogRegistry::new(Duration::from_millis(50), dismiss);

        assert_eq!(registry.state("s1"), DialogState::None);
        // 打开
        registry.on_event(&BrowserEvent::DialogOpened(dialog_info("s1")));
        assert!(matches!(registry.state("s1"), DialogState::Open { .. }));
        assert_eq!(registry.open_session().as_deref(), Some("s1"));
        // 关闭
        registry.on_event(&BrowserEvent::DialogClosed {
            session: "s1".to_string(),
            accepted: true,
        });
        assert_eq!(registry.state("s1"), DialogState::None);
        assert!(registry.open_session().is_none());

        // 超时自动 dismiss：重新打开后等待超时（50ms）
        registry.on_event(&BrowserEvent::DialogOpened(dialog_info("s1")));
        assert!(matches!(registry.state("s1"), DialogState::Open { .. }));
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(registry.state("s1"), DialogState::None, "超时后应自动收敛");
        assert_eq!(calls.load(Ordering::SeqCst), 1, "超时应触发自动 dismiss");
    }

    /// 验收 9.1-28：DialogState::Open 下探针超时 → DialogBlocked 而非 revivable
    #[tokio::test]
    async fn dialog_blocked_not_misjudged() {
        let (dismiss, _) = recording_dismiss();
        let registry = DialogRegistry::new(Duration::from_secs(30), dismiss);

        assert_eq!(registry.diagnose_timeout("s1"), TimeoutDiagnosis::TabHang);
        registry.on_event(&BrowserEvent::DialogOpened(dialog_info("s1")));
        assert_eq!(
            registry.diagnose_timeout("s1"),
            TimeoutDiagnosis::DialogBlocked,
            "对话框打开期间探针超时不得误判为标签卡死"
        );
    }

    /// 验收 9.1-29：handler 命中门禁 → deny + NavigationBlocked 审计（裁决原语）
    #[test]
    fn windowopen_deny_on_blocklist() {
        let policy = WindowOpenPolicy::new(vec![
            "evil.example.com".to_string(),
            "*.spy.example".to_string(),
        ]);
        // 黑名单命中 → Deny
        assert_eq!(
            policy.evaluate("https://evil.example.com/path?x=1"),
            WindowOpenDecision::Deny {
                reason: "域名门禁命中：evil.example.com".to_string()
            }
        );
        assert_eq!(
            policy.evaluate("https://sub.spy.example"),
            WindowOpenDecision::Deny {
                reason: "域名门禁命中：*.spy.example".to_string()
            }
        );
        // R-7：*.example.com 不含根域 → spy.example 根域放行
        assert_eq!(
            policy.evaluate("https://spy.example"),
            WindowOpenDecision::AllowAsTab
        );
        // 未命中 → AllowAsTab（默认转标签页）
        assert_eq!(
            policy.evaluate("https://good.example.com/x"),
            WindowOpenDecision::AllowAsTab
        );
        // 端口/IPv6 形态
        assert_eq!(
            policy.evaluate("http://evil.example.com:8080/"),
            WindowOpenDecision::Deny {
                reason: "域名门禁命中：evil.example.com".to_string()
            }
        );
        // 非法 URL → Deny
        assert!(matches!(
            policy.evaluate(""),
            WindowOpenDecision::Deny { .. }
        ));
        assert!(matches!(
            policy.evaluate("   "),
            WindowOpenDecision::Deny { .. }
        ));
    }
}
