//! 会话级只读能力集（维度 17 §5.3 / 34 §5.2 E-3，R-12）
//!
//! - 外部浏览器类 MCP（chrome-devtools-mcp 族）经 `--browserUrl` attach 受管实例
//!   CDP 端点时，为该连接配置**只读命令域**：snapshot / screenshot / console /
//!   network 四类只读面（34 §5.2 E-3）；Input 注入、`Runtime.evaluate`、
//!   `Network.getAllCookies` 等按 17 §2 矩阵审批、**默认拒绝**。
//! - **fail-closed（默认拒绝）**：未列入白名单的域/方法/事件一律拒绝——与维度
//!   17 §2.3 默认拒绝面同级（红线语义，不可审批豁免）。实测依据 34 §4.3：
//!   MCP 自身不拒绝任何操作，本能力集是 R-12 的唯一拦截点。
//! - 拦截面两处：
//!   - **命令面**：统一发送层 `CommandSender::execute` 最前段（经
//!     `CommandPolicyHooks::attach_caps` 注入，默认 None = 不启用）；拒绝返回
//!     `CdpError::CapabilityDenied`（工具层映射 `tool.browser.capability_disabled`，
//!     conex-types error.rs 已登记）。
//!   - **事件面**：`CapsEventFilter` 过滤迭代器——attach 会话用其替代裸
//!     subscribe，只透传白名单事件（非白名单事件一律丢弃）。
//! - **正常 browser_\* 工具面不受影响**：能力集仅在 attach 会话的 hooks 注入后
//!   生效（`attach_caps` 默认 None），与 `BrowserToolsConfig.mcp_attach_allowed`
//!   语义一致（会话级开关，默认关闭）。
//!
//! 白名单语义（34 §5.2 E-3）：
//! - 命令（"Domain.method" **精确匹配**，不支持通配）：
//!   `DOMSnapshot.captureSnapshot`（snapshot 面）、`Page.captureScreenshot`
//!   （screenshot 面）、`Runtime.enable`（console 面——consoleAPICalled 事件流
//!   订阅的必需 enable 命令，事件订阅面非执行/写入面）、`Network.enable`
//!   （network 面——同上，Network 事件流订阅必需）；
//! - 事件（"Domain.event" 精确匹配，或 "Domain.\*" 域级通配——事件为被动
//!   观察数据、无副作用，域级通配仅事件面开放）：
//!   `Runtime.consoleAPICalled`（console 面）、`Network.*`（network 面全事件）、
//!   `DOMSnapshot.documentUpdated`（snapshot 面，快照域事件）。

use crate::cdp::types::CdpEvent;
use std::collections::BTreeSet;
use std::sync::Arc;
use tokio::sync::broadcast;

/// 会话级只读能力集（R-12）：attach 会话的 CDP 面白名单。
///
/// fail-closed：未列入白名单的域/方法/事件一律拒绝。空集（`Default`）= 全拒绝，
/// 不随协议版本漂移放行任何新方法/事件。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ReadonlyCaps {
    /// 允许的命令（"Domain.method" 精确匹配，如 "Page.captureScreenshot"）。
    /// 命令面**不支持** "Domain.*" 通配（精确匹配更严格，fail-closed 面收窄）。
    commands: BTreeSet<String>,
    /// 允许的事件（"Domain.event" 精确匹配；"Domain.*" 通配该域全部事件）。
    /// 通配仅事件面开放——事件为被动观察数据（Chrome 主动推送），无副作用。
    events: BTreeSet<String>,
}

impl ReadonlyCaps {
    /// 显式构造（引擎侧按需扩展 / 测试用；空参 = fail-closed 全拒绝）。
    pub fn new(
        commands: impl IntoIterator<Item = impl Into<String>>,
        events: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        ReadonlyCaps {
            commands: commands.into_iter().map(Into::into).collect(),
            events: events.into_iter().map(Into::into).collect(),
        }
    }

    /// 标准只读能力集（34 §5.2 E-3 / 17 §5.3）：snapshot / screenshot /
    /// console / network 四类只读面。
    pub fn mcp_attach_default() -> Self {
        Self::new(
            [
                // snapshot 面：DOMSnapshot 域唯一采集命令（快照采集，只读）
                "DOMSnapshot.captureSnapshot",
                // screenshot 面：页面截图（只读）
                "Page.captureScreenshot",
                // console 面：consoleAPICalled 事件流订阅的必需 enable 命令
                // （事件订阅面：不执行页面代码、不写页面状态）
                "Runtime.enable",
                // network 面：Network 事件流订阅的必需 enable 命令（同上）
                "Network.enable",
            ],
            [
                // console 面：控制台消息事件（只读观察）
                "Runtime.consoleAPICalled",
                // snapshot 面：DOM 快照更新事件（DOMSnapshot 域唯一事件，只读观察）
                "DOMSnapshot.documentUpdated",
                // network 面：Network 域全部事件（requestWillBeSent/responseReceived/
                // loadingFinished/loadingFailed/dataReceived 等——均为被动观察数据，
                // 域级通配仅事件面开放）
                "Network.*",
            ],
        )
    }

    /// 命令是否在只读白名单内（精确匹配，fail-closed：未列入一律拒绝）。
    pub fn allows_command(&self, method: &str) -> bool {
        self.commands.contains(method)
    }

    /// 事件是否在只读白名单内（精确匹配 + 域级通配，fail-closed：未列入一律丢弃）。
    pub fn allows_event(&self, method: &str) -> bool {
        if self.events.contains(method) {
            return true;
        }
        // 域级通配："Network.*" 覆盖 Network 域全部事件
        if let Some((domain, _)) = method.split_once('.') {
            if self.events.contains(format!("{domain}.*").as_str()) {
                return true;
            }
        }
        false
    }

    /// 事件过滤迭代器（attach 会话装配：替代裸 subscribe，只透传白名单事件）。
    /// 用法：spawn 泵循环 `filter.next_allowed().await` 转发（与 bus 泵同构）。
    pub fn filter_events(&self, rx: broadcast::Receiver<CdpEvent>) -> CapsEventFilter {
        CapsEventFilter::new(rx, Arc::new(self.clone()))
    }
}

/// 事件过滤迭代器：包装 `CdpClient::subscribe` 的 broadcast receiver，
/// 只透传白名单事件（非白名单事件静默丢弃，fail-closed 透传面）。
pub struct CapsEventFilter {
    rx: broadcast::Receiver<CdpEvent>,
    caps: Arc<ReadonlyCaps>,
}

impl CapsEventFilter {
    pub fn new(rx: broadcast::Receiver<CdpEvent>, caps: Arc<ReadonlyCaps>) -> Self {
        CapsEventFilter { rx, caps }
    }

    /// 取下一个白名单事件（非白名单事件自动丢弃后继续等待；
    /// 通道关闭/连接断开返回 None）。tokio 1.53 broadcast::Receiver 无公开
    /// poll_recv（Stream impl 在 tokio-stream，不引新依赖）——采用 async
    /// 迭代器形态，装配面与 bus 泵（`spawn_event_pump` 消费 recv 循环）同构。
    pub async fn next_allowed(&mut self) -> Option<CdpEvent> {
        loop {
            match self.rx.recv().await {
                Ok(event) => {
                    if self.caps.allows_event(&event.method) {
                        return Some(event);
                    }
                    // 非白名单事件：丢弃后继续等待（不透传 attach 会话）
                }
                // 积压丢失（订阅慢于生产）：跳过继续（对齐 bus 泵 Lagged 宽容语义）
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                // 通道关闭（连接断开/客户端弃置）：流结束
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdp::mock::{MockReply, MockServer};
    use serde_json::json;

    /// 标准配置命令面：四类只读面全部命中（34 §5.2 E-3 正向面）。
    #[test]
    fn mcp_attach_default_allows_all_readonly_commands() {
        let caps = ReadonlyCaps::mcp_attach_default();
        for method in [
            "DOMSnapshot.captureSnapshot", // snapshot 面
            "Page.captureScreenshot",      // screenshot 面
            "Runtime.enable",              // console 面（事件流订阅）
            "Network.enable",              // network 面（事件流订阅）
        ] {
            assert!(
                caps.allows_command(method),
                "只读命令 {method} 应在白名单内"
            );
        }
    }

    /// 典型拒绝面（17 §2 矩阵 / 34 §4.3 实测工具→CDP 映射）：交互注入、
    /// 求值、cookie 全量读写、导航、模拟、目标管理等一律拒绝。
    #[test]
    fn mcp_attach_default_denies_typical_non_readonly_commands() {
        let caps = ReadonlyCaps::mcp_attach_default();
        for method in [
            "Runtime.evaluate",                 // 求值类（34 §4.3：MCP 自身不拒绝，此面是唯一拦截点）
            "Input.dispatchMouseEvent",         // 交互注入
            "Input.dispatchKeyEvent",           // 交互注入
            "Input.insertText",                 // 交互注入（剪贴板 M-7 注入面）
            "Input.dispatchTouchEvent",         // 交互注入
            "Network.getAllCookies",            // cookie 全量读取（敏感域只读命令不授予）
            "Network.setCookie",                // cookie 写入
            "Network.deleteCookies",            // cookie 删除
            "Network.setBlockedURLs",           // 网络阻断配置（配置面非观察面）
            "Page.navigate",                    // 导航（写入面）
            "Page.reload",                      // 导航
            "Page.setDownloadBehavior",         // 下载配置
            "DOM.setFileInputFiles",            // 上传注入
            "Emulation.setDeviceMetricsOverride", // 模拟面
            "Target.createTarget",              // 目标管理
            "Browser.close",                    // 浏览器生命周期
            "Accessibility.getFullAXTree",      // 快照未列入的命令面（精确匹配）
        ] {
            assert!(
                !caps.allows_command(method),
                "非只读命令 {method} 必须被拒绝（fail-closed）"
            );
        }
    }

    /// fail-closed 语义钉死：空能力集（Default）= 全拒绝，协议漂移不自动放行。
    #[test]
    fn default_empty_caps_is_fail_closed() {
        let caps = ReadonlyCaps::default();
        for method in [
            "Page.captureScreenshot",
            "Runtime.evaluate",
            "Network.enable",
            "任何.未列出的方法",
        ] {
            assert!(!caps.allows_command(method), "{method} 应被拒绝");
        }
        for event in ["Runtime.consoleAPICalled", "Network.requestWillBeSent", "任何.事件"] {
            assert!(!caps.allows_event(event), "{event} 应被拒绝");
        }
    }

    /// 事件白名单正向面：console 精确命中 + network 域通配命中 + snapshot 事件命中。
    #[test]
    fn mcp_attach_default_event_whitelist() {
        let caps = ReadonlyCaps::mcp_attach_default();
        for event in [
            "Runtime.consoleAPICalled",          // console 面精确命中
            "Network.requestWillBeSent",         // network 面（通配）
            "Network.responseReceived",          // network 面（通配）
            "Network.loadingFinished",           // network 面（通配）
            "Network.loadingFailed",             // network 面（通配）
            "Network.dataReceived",              // network 面（通配）
            "Network.requestWillBeSentExtraInfo", // network 面（通配，协议扩展事件）
            "Network.webSocketFrameReceived",    // network 面（通配，子面事件）
            "DOMSnapshot.documentUpdated",       // snapshot 面事件
        ] {
            assert!(caps.allows_event(event), "只读事件 {event} 应透传");
        }
    }

    /// 事件白名单拒绝面：非四类只读面的事件一律丢弃（fail-closed）。
    #[test]
    fn mcp_attach_default_event_denies_others() {
        let caps = ReadonlyCaps::mcp_attach_default();
        for event in [
            "Runtime.exceptionThrown",   // 异常事件不在 console 面清单
            "Runtime.executionContextCreated",
            "Page.frameNavigated",       // 页面导航事件（非观察白名单）
            "Page.loadEventFired",
            "Input.dispatchKeyEvent",    // 事件面同样拒绝交互域
            "Target.attachedToTarget",
            "DOM.childNodeInserted",
            "Accessibility.loadComplete",
        ] {
            assert!(!caps.allows_event(event), "非白名单事件 {event} 必须丢弃");
        }
    }

    /// 命令面不支持域级通配（fail-closed 收窄）：即使配置了 "Page.*" 命令条目，
    /// 未精确列出的 Page 方法仍被拒绝——通配仅事件面开放。
    #[test]
    fn command_whitelist_is_exact_no_wildcard() {
        let caps = ReadonlyCaps::new(["Page.*"], ["Network.*"]);
        assert!(!caps.allows_command("Page.navigate"), "命令面不允许通配命中");
        assert!(!caps.allows_command("Page.captureScreenshot"), "通配条目不等于精确列出");
        // 事件面通配语义不受影响（对照面）
        assert!(caps.allows_event("Network.requestWillBeSent"));
    }

    /// 事件过滤流（集成）：mock WS 注入混合事件 → 过滤流只产出白名单事件。
    #[tokio::test]
    async fn event_filter_passes_only_whitelist() {
        let mock = MockServer::spawn().await;
        mock.set_auto_reply("Runtime.enable", MockReply::Ok(json!({})));
        let client = Arc::new(
            crate::cdp::client::CdpClient::connect(&mock.url("/devtools/browser/caps-filter"))
                .await
                .expect("建连失败"),
        );
        let caps = Arc::new(ReadonlyCaps::mcp_attach_default());
        let mut filtered = caps.filter_events(client.subscribe());

        // 混合注入：2 个白名单事件 + 3 个非白名单事件（含 Runtime.evaluate 同域
        // 变体与 Network 域外事件）
        mock.send_event("Runtime.consoleAPICalled", json!({ "type": "log" }), None);
        mock.send_event("Network.requestWillBeSent", json!({ "requestId": "1" }), None);
        mock.send_event("Runtime.evaluate", json!({ "result": {} }), None);
        mock.send_event("Page.frameNavigated", json!({ "frame": {} }), None);
        mock.send_event("Runtime.exceptionThrown", json!({ "exception": {} }), None);

        // 过滤迭代器只产出白名单事件（顺序保持注入序）
        let e1 = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            filtered.next_allowed(),
        )
        .await
        .expect("等待白名单事件超时")
        .expect("迭代器提前结束");
        assert_eq!(e1.method, "Runtime.consoleAPICalled");
        let e2 = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            filtered.next_allowed(),
        )
        .await
        .expect("等待白名单事件超时")
        .expect("迭代器提前结束");
        assert_eq!(e2.method, "Network.requestWillBeSent");
        // 非白名单事件不透传：短暂窗口后迭代器仍无第三个事件
        let got_third = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            filtered.next_allowed(),
        )
        .await;
        assert!(
            got_third.is_err(),
            "非白名单事件不得透传（收到 {:?}）",
            got_third.ok()
        );
    }
}
