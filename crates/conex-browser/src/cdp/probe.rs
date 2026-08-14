//! 能力探测（维度 11 §6：CapabilityReport 生成与降级）
//!
//! 流程（连接成功后一次性 + 重连后重跑）：
//! 1. Browser.getVersion → 版本信息 + 最低版本线判定
//! 2. SystemInfo.getInfo（失败可容忍）→ 诊断字段
//! 3. 13 域冒烟（逐域并行，受发送层并发管理约束）：
//!    - Page/Runtime/DOM/Network/Log：enable 冒烟
//!    - Target：setDiscoverTargets 冒烟；Browser：getVersion 已证
//!    - Accessibility：getFullAXTree 空树冒烟（无 enable 命令）
//!    - DOMSnapshot：captureSnapshot 空页冒烟（R-3）
//!    - Input/Emulation/Storage：浏览器版本 ≥ 最低线推理
//!    - SystemInfo：getInfo 冒烟
//!
//! 失败分类：-32601 → Unsupported；超时 → Degraded（可能对话框阻塞）；
//! 其他错误 → Degraded（记入报告）。
//! 探测本身走发送层（全命令过闸门），单条 5s 超时，总预算 ≤ 10s。

use crate::cdp::domains::names::*;
use crate::cdp::domains::{BrowserVersionResult, GetFullAXTreeResult};
use crate::cdp::error::CdpError;
use crate::cdp::sender::{Command, CommandSender};
use futures_util::future::join_all;
use serde_json::{json, Value};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// 探测总预算（≤10s，§6.1）。
pub const PROBE_BUDGET: Duration = Duration::from_secs(10);
/// 单条探测命令超时（5s，§2.3 域 enable）。
pub const PROBE_COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
/// 最低版本线（Chromium 120，§6.3）。
pub const MIN_CHROMIUM_MAJOR: u64 = 120;

/// 13 域清单（R-3 补齐）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Domain {
    Browser,
    Target,
    Page,
    Runtime,
    Dom,
    DomSnapshot,
    Accessibility,
    Network,
    Input,
    Emulation,
    Storage,
    SystemInfo,
    Log,
}

impl Domain {
    pub const ALL: [Domain; 13] = [
        Domain::Browser,
        Domain::Target,
        Domain::Page,
        Domain::Runtime,
        Domain::Dom,
        Domain::DomSnapshot,
        Domain::Accessibility,
        Domain::Network,
        Domain::Input,
        Domain::Emulation,
        Domain::Storage,
        Domain::SystemInfo,
        Domain::Log,
    ];

    pub fn name(&self) -> &'static str {
        match self {
            Domain::Browser => "Browser",
            Domain::Target => "Target",
            Domain::Page => "Page",
            Domain::Runtime => "Runtime",
            Domain::Dom => "DOM",
            Domain::DomSnapshot => "DOMSnapshot",
            Domain::Accessibility => "Accessibility",
            Domain::Network => "Network",
            Domain::Input => "Input",
            Domain::Emulation => "Emulation",
            Domain::Storage => "Storage",
            Domain::SystemInfo => "SystemInfo",
            Domain::Log => "Log",
        }
    }
}

/// 域状态（§6.2）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DomainStatus {
    Supported,
    Unsupported { reason: String },
    Degraded { reason: String },
}

/// 域探测报告（13 域逐项）。
#[derive(Debug, Clone)]
pub struct DomainReport {
    pub domain: Domain,
    pub status: DomainStatus,
}

/// 浏览器版本信息（getVersion 回包）。
#[derive(Debug, Clone)]
pub struct BrowserVersion {
    pub product: String,
    pub protocol_version: String,
    pub user_agent: String,
    pub revision: String,
    pub js_version: String,
}

/// 特征旗标（由 domains 推断，§6.2；消费方按 §6.3 降级表执行）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FeatureFlags {
    /// Page 域支持 → 维度 12 帧流可用
    pub screencast: bool,
    /// DOMSnapshot + DOM + Runtime 支持 → 维度 13 主通道可用（缺失为致命）
    pub snapshot_dom: bool,
    /// Accessibility 支持 → AX 补充通道（可选增强）
    pub snapshot_ax: bool,
    /// Input 域支持（P0-1 判定）→ 交互类工具可用
    pub input_injection: bool,
    /// Network + Storage 支持（维度 16 依赖）
    pub cookie_readwrite: bool,
    /// Target.setAutoAttach 支持（跨域 iframe 采集依赖）
    pub iframe_sessions: bool,
    /// Emulation 支持（视口模拟）
    pub emulation: bool,
}

/// 能力报告（随 browser://state-changed 同批上抛，不含端点；报告本身无敏感字段）。
#[derive(Debug, Clone)]
pub struct CapabilityReport {
    pub browser: BrowserVersion,
    /// SystemInfo.getInfo 原文或 None（失败可容忍）
    pub os_info: Option<Value>,
    pub domains: Vec<DomainReport>,
    pub features: FeatureFlags,
    pub detected_at_ms: u64,
}

/// 执行能力探测（发送层全命令过闸门；总预算 ≤ 10s）。
pub async fn run(sender: &CommandSender) -> CapabilityReport {
    let start = Instant::now();
    let detected_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    // 1. 版本（先决：Input/Emulation/Storage 推理依赖）
    let version = fetch_version(sender).await;
    let major = version.as_ref().map(|v| v.major_version()).unwrap_or(0);

    // 2-3. 13 域冒烟逐域并行 + SystemInfo 原文独立采集（失败可容忍）
    let futs: Vec<_> = Domain::ALL
        .iter()
        .map(|d| probe_domain(sender, *d, major))
        .collect();
    let os_fut = fetch_system_info(sender);
    let results = join_all(futs).await;
    let os_info = os_fut.await;

    let domains = Domain::ALL
        .iter()
        .zip(results)
        .map(|(domain, status)| DomainReport {
            domain: *domain,
            status,
        })
        .collect::<Vec<_>>();

    let features = infer_features(&domains);

    // 预算断言日志（超预算仅告警，不中断——mock/真实差异由上层判定）
    let elapsed = start.elapsed();
    if elapsed > PROBE_BUDGET {
        tracing::warn!("能力探测超出预算：{}ms", elapsed.as_millis());
    }

    CapabilityReport {
        browser: BrowserVersion {
            product: version
                .as_ref()
                .and_then(|v| v.product.clone())
                .unwrap_or_default(),
            protocol_version: version
                .as_ref()
                .and_then(|v| v.protocol_version.clone())
                .unwrap_or_default(),
            user_agent: version
                .as_ref()
                .and_then(|v| v.user_agent.clone())
                .unwrap_or_default(),
            revision: version
                .as_ref()
                .and_then(|v| v.revision.clone())
                .unwrap_or_default(),
            js_version: version
                .as_ref()
                .and_then(|v| v.js_version.clone())
                .unwrap_or_default(),
        },
        os_info,
        domains,
        features,
        detected_at_ms,
    }
}

/// getVersion（5s；失败 → None，报告降级由域探测兜底）。
async fn fetch_version(sender: &CommandSender) -> Option<BrowserVersionResult> {
    let cmd = Command::new(BROWSER_GET_VERSION).with_timeout(PROBE_COMMAND_TIMEOUT);
    match sender.execute(cmd).await {
        Ok(v) => serde_json::from_value(v).ok(),
        Err(e) => {
            tracing::warn!("能力探测：getVersion 失败：{e}");
            None
        }
    }
}

/// SystemInfo 原文（失败可容忍 → None；仅诊断字段，不进能力判定）。
async fn fetch_system_info(sender: &CommandSender) -> Option<Value> {
    let cmd = Command::new(SYSTEM_INFO_GET_INFO).with_timeout(PROBE_COMMAND_TIMEOUT);
    match sender.execute(cmd).await {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::warn!("能力探测：SystemInfo.getInfo 失败（可容忍）：{e}");
            None
        }
    }
}

/// 单域冒烟（§6.1 第 3 步流程）。
async fn probe_domain(sender: &CommandSender, domain: Domain, major: u64) -> DomainStatus {
    let result = match domain {
        // Browser：getVersion 已证（fetch_version 阶段）
        Domain::Browser => Ok(Value::Null),
        Domain::Target => {
            sender
                .execute(
                    Command::new(TARGET_SET_DISCOVER_TARGETS)
                        .params(json!({ "discover": true }))
                        .with_timeout(PROBE_COMMAND_TIMEOUT),
                )
                .await
        }
        Domain::Page => {
            sender
                .execute(Command::new(PAGE_ENABLE).with_timeout(PROBE_COMMAND_TIMEOUT))
                .await
        }
        Domain::Runtime => {
            sender
                .execute(Command::new(RUNTIME_ENABLE).with_timeout(PROBE_COMMAND_TIMEOUT))
                .await
        }
        Domain::Dom => {
            sender
                .execute(Command::new(DOM_ENABLE).with_timeout(PROBE_COMMAND_TIMEOUT))
                .await
        }
        Domain::Network => {
            sender
                .execute(Command::new(NETWORK_ENABLE).with_timeout(PROBE_COMMAND_TIMEOUT))
                .await
        }
        Domain::Log => {
            sender
                .execute(Command::new(LOG_ENABLE).with_timeout(PROBE_COMMAND_TIMEOUT))
                .await
        }
        // Accessibility：无 enable 命令 → getFullAXTree 空树冒烟
        Domain::Accessibility => {
            match sender
                .execute(
                    Command::new(ACCESSIBILITY_GET_FULL_AX_TREE)
                        .params(json!({ "depth": 1 }))
                        .with_timeout(PROBE_COMMAND_TIMEOUT),
                )
                .await
            {
                Ok(v) => match serde_json::from_value::<GetFullAXTreeResult>(v) {
                    Ok(_) => Ok(Value::Null),
                    Err(e) => Err(CdpError::Internal {
                        method: Some(ACCESSIBILITY_GET_FULL_AX_TREE.to_string()),
                        message: e.to_string(),
                    }),
                },
                Err(e) => Err(e),
            }
        }
        // DOMSnapshot：captureSnapshot 空页冒烟（R-3）
        Domain::DomSnapshot => {
            sender
                .execute(
                    Command::new(DOM_SNAPSHOT_CAPTURE_SNAPSHOT)
                        .params(json!({ "computedStyles": [] }))
                        .with_timeout(PROBE_COMMAND_TIMEOUT),
                )
                .await
        }
        // Input/Emulation/Storage：无 enable 语义 → 版本推理（§6.1）
        Domain::Input | Domain::Emulation | Domain::Storage => {
            if major >= MIN_CHROMIUM_MAJOR {
                Ok(Value::Null)
            } else {
                Err(CdpError::DomainUnavailable {
                    method: format!("{}.enable", domain.name()),
                })
            }
        }
        Domain::SystemInfo => {
            sender
                .execute(Command::new(SYSTEM_INFO_GET_INFO).with_timeout(PROBE_COMMAND_TIMEOUT))
                .await
        }
    };
    map_result(domain.name(), result)
}

/// 失败分类（§6.1 第 3 步）。
fn map_result(method: &str, result: Result<Value, CdpError>) -> DomainStatus {
    match result {
        Ok(_) => DomainStatus::Supported,
        Err(CdpError::DomainUnavailable { .. }) => DomainStatus::Unsupported {
            reason: format!("{method} 不支持"),
        },
        Err(CdpError::Timeout { .. }) => DomainStatus::Degraded {
            reason: format!("{method} 超时（可能对话框阻塞）"),
        },
        Err(e) => DomainStatus::Degraded {
            reason: format!("{method} 探测失败：{e}"),
        },
    }
}

/// 特征旗标推断（§6.2）。
fn infer_features(domains: &[DomainReport]) -> FeatureFlags {
    let supported = |d: Domain| {
        domains
            .iter()
            .any(|r| r.domain == d && matches!(r.status, DomainStatus::Supported))
    };
    FeatureFlags {
        screencast: supported(Domain::Page),
        snapshot_dom: supported(Domain::DomSnapshot)
            && supported(Domain::Dom)
            && supported(Domain::Runtime),
        snapshot_ax: supported(Domain::Accessibility),
        input_injection: supported(Domain::Input),
        cookie_readwrite: supported(Domain::Network) && supported(Domain::Storage),
        iframe_sessions: supported(Domain::Target),
        emulation: supported(Domain::Emulation),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdp::mock::{MockReply, MockServer};
    use crate::cdp::sender::{
        ApprovalDenied, BrowserAuditEvent, CancellationToken, CdpCommandView, CommandChannel,
        CommandPolicyHooks, IdKey,
    };
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    /// 探测定制的放行钩子（无审计记录需求）。
    struct ProbeHooks {
        stop: Arc<AtomicBool>,
        token: CancellationToken,
    }

    impl ProbeHooks {
        fn new() -> Self {
            ProbeHooks {
                stop: Arc::new(AtomicBool::new(false)),
                token: CancellationToken::new(),
            }
        }
    }

    #[async_trait::async_trait]
    impl CommandPolicyHooks for ProbeHooks {
        async fn idempotent(&self, _key: &IdKey) -> Option<Result<Value, CdpError>> {
            None
        }
        async fn approve(&self, _cmd: &CdpCommandView) -> Result<(), ApprovalDenied> {
            Ok(())
        }
        fn audit(&self, _event: BrowserAuditEvent) {}
        fn emergency_stop(&self) -> Arc<AtomicBool> {
            self.stop.clone()
        }
        fn abort_token(&self) -> CancellationToken {
            self.token.clone()
        }
    }

    /// 组装：mock 全量自动应答 + 直连通道 + 放行钩子。
    async fn setup_probe(reply_map: Vec<(&'static str, MockReply)>) -> (MockServer, CommandSender) {
        let mock = MockServer::spawn().await;
        for (method, reply) in reply_map {
            mock.set_auto_reply(method, reply);
        }
        let client = Arc::new(
            crate::cdp::client::CdpClient::connect(&mock.url("/devtools/browser/probe"))
                .await
                .expect("建连失败"),
        );
        let channel: Arc<dyn CommandChannel> = client;
        let hooks = Arc::new(ProbeHooks::new());
        (mock, CommandSender::new(channel, hooks))
    }

    fn ok_map() -> Vec<(&'static str, MockReply)> {
        vec![
            (
                BROWSER_GET_VERSION,
                MockReply::Ok(json!({
                    "protocolVersion": "1.3",
                    "product": "Chrome/131.0.6778.204",
                    "revision": "@abc",
                    "userAgent": "ua",
                    "jsVersion": "13.1.71"
                })),
            ),
            (
                SYSTEM_INFO_GET_INFO,
                MockReply::Ok(
                    json!({ "gpu": {}, "modelName": "m", "modelVersion": "v", "commandLine": "" }),
                ),
            ),
            (TARGET_SET_DISCOVER_TARGETS, MockReply::Ok(json!({}))),
            (PAGE_ENABLE, MockReply::Ok(json!({}))),
            (RUNTIME_ENABLE, MockReply::Ok(json!({}))),
            (DOM_ENABLE, MockReply::Ok(json!({}))),
            (NETWORK_ENABLE, MockReply::Ok(json!({}))),
            (LOG_ENABLE, MockReply::Ok(json!({}))),
            (
                ACCESSIBILITY_GET_FULL_AX_TREE,
                MockReply::Ok(json!({ "nodes": [] })),
            ),
            (
                DOM_SNAPSHOT_CAPTURE_SNAPSHOT,
                MockReply::Ok(json!({ "strings": [], "documents": [] })),
            ),
        ]
    }

    /// 验收 9.1-25：mock enable 返回 -32601 → DomainStatus::Unsupported → FeatureFlags 关
    #[tokio::test]
    async fn probe_unsupported_domain_reported() {
        let mut map = ok_map();
        map.push((
            ACCESSIBILITY_GET_FULL_AX_TREE,
            MockReply::Error {
                code: -32601,
                message: "Method not found".to_string(),
            },
        ));
        map.push((
            DOM_SNAPSHOT_CAPTURE_SNAPSHOT,
            MockReply::Error {
                code: -32601,
                message: "Method not found".to_string(),
            },
        ));
        let (_mock, sender) = setup_probe(map).await;

        let report = run(&sender).await;
        let ax = report
            .domains
            .iter()
            .find(|d| d.domain == Domain::Accessibility)
            .expect("报告缺 Accessibility");
        assert!(
            matches!(ax.status, DomainStatus::Unsupported { .. }),
            "Accessibility 应 Unsupported，实际 {:?}",
            ax.status
        );
        let snap = report
            .domains
            .iter()
            .find(|d| d.domain == Domain::DomSnapshot)
            .expect("报告缺 DOMSnapshot");
        assert!(matches!(snap.status, DomainStatus::Unsupported { .. }));
        assert!(!report.features.snapshot_ax, "AX 旗标应关闭");
        assert!(
            !report.features.snapshot_dom,
            "DOM 快照旗标应关闭（DOMSnapshot 缺失）"
        );
        // 其余旗标不受影响
        assert!(report.features.screencast);
        assert!(report.features.input_injection);
        assert!(report.features.cookie_readwrite);
    }

    /// 验收 9.1-26：13 域（R-3 补齐）+ 特征旗标全部产出；耗时 ≤ 10s 预算断言
    #[tokio::test]
    async fn probe_report_structure() {
        let (_mock, sender) = setup_probe(ok_map()).await;
        let start = Instant::now();
        let report = run(&sender).await;

        assert_eq!(report.domains.len(), 13, "R-3 补齐后应为 13 域");
        for d in Domain::ALL {
            let r = report
                .domains
                .iter()
                .find(|r| r.domain == d)
                .unwrap_or_else(|| panic!("报告缺域 {}", d.name()));
            assert_eq!(
                r.status,
                DomainStatus::Supported,
                "域 {} 应 Supported",
                d.name()
            );
        }
        assert!(report.features.screencast);
        assert!(report.features.snapshot_dom);
        assert!(report.features.snapshot_ax);
        assert!(report.features.input_injection);
        assert!(report.features.cookie_readwrite);
        assert!(report.features.iframe_sessions);
        assert!(report.features.emulation);
        assert!(report.detected_at_ms > 0, "应产出检测时间戳");
        assert_eq!(report.browser.product, "Chrome/131.0.6778.204");
        assert!(report.os_info.is_some(), "SystemInfo 原文应产出");
        assert!(start.elapsed() <= PROBE_BUDGET, "探测耗时不得超预算");
    }
}
