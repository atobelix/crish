//! P1 多标签工具流集成测试（15 文档 §7 + 22 裁决 U-12/M-1/T-14）
//!
//! 覆盖：
//! - 多标签工具流：new_tab → list_tabs → switch_tab → per-tab 动作/版本隔离 → close_tab；
//! - MAX_TABS 上限（注入计数：超限 createTarget 零派发，U-12 码）；
//! - tab 失效（target destroyed 后动作返回 node_gone 语义）；
//! - switch_tab 后活动标签变更 + 目标标签版本即时推进（R-1）。
//!
//! 会话为 MockSession（tests/common/mod.rs）：内部 per-tab 路由表驱动
//! tab_session/activate_tab/getTargets/closeTarget 语义。

mod common;

use agent_tools::context::create_mock_tool_context;
use agent_tools::registry::ToolRegistry;
use common::{mock_config, MockSession};
use conex_browser_tools::gate::{HostResolver, MvpDomainGate};
use conex_browser_tools::register_browser_tools;
use serde_json::{json, Value};
use std::net::IpAddr;
use std::sync::Arc;

/// 确定性解析器（同 success_paths.rs）：任何主机名解析到公网地址，
/// 测试面不依赖 CI 真实 DNS（假域名在真实 resolver 下解析失败会被 fail-closed 阻断）。
struct AlwaysPublicResolver;

impl HostResolver for AlwaysPublicResolver {
    fn resolve(&self, _host: &str) -> Result<Vec<IpAddr>, String> {
        Ok(vec!["93.184.216.34".parse().expect("字面量 IP")])
    }
}

struct Harness {
    mock: Arc<MockSession>,
    registry: ToolRegistry,
}

fn harness_with_max(max_tabs: usize) -> Harness {
    let mock = MockSession::new();
    let mut registry = ToolRegistry::new();
    let mut config = mock_config(&mock, false);
    config.max_tabs = Some(max_tabs);
    config.gate = Some(Arc::new(
        MvpDomainGate::with_resolver(&[], &[], Arc::new(AlwaysPublicResolver)).expect("门禁构造"),
    ));
    register_browser_tools(&mut registry, config).expect("注册成功");
    Harness { mock, registry }
}

fn harness() -> Harness {
    harness_with_max(8)
}

impl Harness {
    async fn run(
        &self,
        name: &str,
        args: Value,
    ) -> Result<Value, agent_tools::definition::ToolError> {
        let tool = self.registry.get(name).expect("工具应注册");
        tool.execute(&create_mock_tool_context(), args).await
    }

    async fn run_ok(&self, name: &str, args: Value) -> Value {
        self.run(name, args)
            .await
            .unwrap_or_else(|e| panic!("{name} 应成功：{e}"))
    }

    async fn run_err(&self, name: &str, args: Value) -> agent_tools::definition::ToolError {
        self.run(name, args).await.expect_err("应报错")
    }
}

fn tab_ids(out: &Value) -> Vec<String> {
    out["tabs"]
        .as_array()
        .expect("tabs 数组")
        .iter()
        .map(|t| t["tabId"].as_str().expect("tabId").to_string())
        .collect()
}

/// 多标签工具流：new_tab → list_tabs（含新标签）→ switch_tab（活动标签变更 +
/// 版本推进）→ per-tab 动作（按 tab_id 路由）→ close_tab → list_tabs 收敛。
#[tokio::test]
async fn multi_tab_tool_flow() {
    let h = harness();

    // 1. 新建标签（T9 入 mock 路由表）
    let out = h
        .run_ok("browser_new_tab", json!({ "url": "https://x.example/" }))
        .await;
    assert_eq!(out["tabId"], "T9");
    h.mock.assert_recorded("browser:Target.createTarget");

    // 2. list_tabs：T1/T2/T9 全量可见
    let tabs = tab_ids(&h.run_ok("browser_list_tabs", json!({})).await);
    assert_eq!(tabs, vec!["T1", "T2", "T9"]);

    // 3. switch_tab 到 T9：activateTarget 派发 + 活动槽显式切换 + 版本即时推进
    let out = h
        .run_ok("browser_switch_tab", json!({ "tab_id": "T9" }))
        .await;
    assert_eq!(out["tabId"], "T9");
    h.mock
        .assert_recorded("browser:Target.activateTarget {\"targetId\":\"T9\"}");
    h.mock.assert_recorded("activate-tab:T9");
    h.mock.assert_recorded("bump:T9");

    // 4. 动作按 tab_id 路由：显式 T2 + 缺省（活动标签 T9）双路径
    h.run_ok("browser_click", json!({ "tab_id": "T2", "ref": 3 }))
        .await;
    h.mock.assert_recorded("action:tab=T2");
    h.run_ok("browser_click", json!({ "ref": 3 })).await;
    // switch 后的活动标签确实变更（缺省动作落在 T9）
    h.mock.assert_recorded("action:tab=T9 version=7");

    // 5. close_tab T2 → list_tabs 剩 T1/T9
    let out = h
        .run_ok("browser_close_tab", json!({ "tab_id": "T2" }))
        .await;
    assert_eq!(out["closedTabId"], "T2");
    assert_eq!(out["remainingTabs"], 2);
    let tabs = tab_ids(&h.run_ok("browser_list_tabs", json!({})).await);
    assert_eq!(tabs, vec!["T1", "T9"]);
}

/// per-tab 版本隔离（15 §7.1 验收 5）：动作请求携带各自标签的版本号，
/// 一标签推进不污染另一标签的版本面（底层 per-tab 版本由 VersionTracker 保证，
/// 本层断言工具请求按目标标签取版本）。
#[tokio::test]
async fn per_tab_version_isolation_in_requests() {
    let h = harness();
    h.mock.set_version("T1", 3);
    h.mock.set_version("T2", 9);

    // T1 上动作（缺省活动标签）→ 携带 T1 版本 3
    h.run_ok("browser_click", json!({ "ref": 1 })).await;
    h.mock.assert_recorded("action:tab=T1 version=3");
    // T2 上动作（显式 tab_id）→ 携带 T2 版本 9（T1 的推进不影响 T2）
    h.run_ok("browser_click", json!({ "tab_id": "T2", "ref": 1 }))
        .await;
    h.mock.assert_recorded("action:tab=T2 version=9");
    // 快照同样按 tab_id 路由（感知面与动作面同口径）
    h.run_ok("browser_snapshot", json!({ "tab_id": "T2" }))
        .await;
    h.mock.assert_recorded("snapshot:capture tab=T2");
    // 版本推进（note_action_done）只作用目标标签
    h.run_ok("browser_switch_tab", json!({ "tab_id": "T2" }))
        .await;
    h.mock.assert_recorded("bump:T2");
}

/// MAX_TABS 上限（15 §7.3 验收 9 + U-12 码）：8 个标签已满 → new_tab 返回
/// tab_limit_exceeded 且 createTarget 零注入；关闭一个后可再开。
#[tokio::test]
async fn max_tabs_limit_blocks_new_tab_without_injection() {
    let h = harness_with_max(2);
    h.mock.set_tabs(&["T1", "T2"]);

    let err = h
        .run_err("browser_new_tab", json!({ "url": "https://x.example/" }))
        .await;
    assert_eq!(
        err.code(),
        "tool.browser.tab_limit_exceeded",
        "错误码：{err}"
    );
    assert!(err.to_string().contains("MAX_TABS=2"), "应携带上限：{err}");
    let injected = h
        .mock
        .calls()
        .iter()
        .filter(|c| c.contains("Target.createTarget"))
        .count();
    assert_eq!(injected, 0, "超限时 createTarget 零注入");

    // 关闭一个（T2）→ 可再开（注入计数 1）
    h.run_ok("browser_close_tab", json!({ "tab_id": "T2" }))
        .await;
    let out = h
        .run_ok("browser_new_tab", json!({ "url": "https://x.example/" }))
        .await;
    assert_eq!(out["tabId"], "T9");
    let injected = h
        .mock
        .calls()
        .iter()
        .filter(|c| c.contains("Target.createTarget"))
        .count();
    assert_eq!(injected, 1, "关闭后可再开（注入恰好 1 次）");
}

/// MAX_TABS 可配（1-16）：max_tabs=3 时第 4 个标签被拒。
#[tokio::test]
async fn max_tabs_configurable_range() {
    let h = harness_with_max(3);
    h.mock.set_tabs(&["T1", "T2", "T3"]);
    let err = h
        .run_err("browser_new_tab", json!({ "url": "https://x.example/" }))
        .await;
    assert_eq!(err.code(), "tool.browser.tab_limit_exceeded");
    assert!(err.to_string().contains("MAX_TABS=3"));

    // 配置校验：超范围（17）注册期拒绝
    let mut registry = ToolRegistry::new();
    let mut config = mock_config(&MockSession::new(), false);
    config.max_tabs = Some(17);
    let err = register_browser_tools(&mut registry, config).expect_err("越界配置应拒绝");
    assert_eq!(err.code(), "tool.invalid_input");
}

/// tab 失效（target destroyed 后）：close_tab 关闭 T2 → 对 T2 的动作/快照
/// 一律 node_gone（目标过期语义）；已关闭标签不可再 switch（node_gone）。
#[tokio::test]
async fn destroyed_tab_actions_return_node_gone() {
    let h = harness();

    // 关闭 T2（路由表移除）
    h.run_ok("browser_close_tab", json!({ "tab_id": "T2" }))
        .await;

    // 动作（click）→ node_gone，零派发（execute_action 不被调用）
    let err = h
        .run_err("browser_click", json!({ "tab_id": "T2", "ref": 1 }))
        .await;
    assert_eq!(err.code(), "tool.browser.node_gone", "错误码：{err}");
    assert!(
        !h.mock
            .calls()
            .iter()
            .any(|c| c.starts_with("action:tab=T2")),
        "已销毁标签不得派发动作"
    );

    // 快照 → node_gone
    let err = h
        .run_err("browser_snapshot", json!({ "tab_id": "T2" }))
        .await;
    assert_eq!(err.code(), "tool.browser.node_gone");

    // switch_tab 已关闭标签 → node_gone（activateTarget 不派发）
    let err = h
        .run_err("browser_switch_tab", json!({ "tab_id": "T2" }))
        .await;
    assert_eq!(err.code(), "tool.browser.node_gone");
    h.mock
        .assert_not_recorded("browser:Target.activateTarget {\"targetId\":\"T2\"}");

    // T1 不受影响（隔离面）
    h.run_ok("browser_click", json!({ "ref": 1 })).await;
    h.mock.assert_recorded("action:tab=T1");
}

/// 感知面 per-tab 路由：get_url/get_title/screenshot/wait_for 按 tab_id 路由，
/// 失效标签同样 node_gone。
#[tokio::test]
async fn sense_tools_route_per_tab() {
    let h = harness();
    h.mock.assert_not_recorded("browser:Target.activateTarget");

    // get_url/get_title 显式 T2
    h.run_ok("browser_get_url", json!({ "tab_id": "T2" })).await;
    h.run_ok("browser_get_title", json!({ "tab_id": "T2" }))
        .await;
    h.mock
        .assert_recorded("browser:Target.getTargetInfo {\"targetId\":\"T2\"}");

    // screenshot 按 tab_id 路由到对应会话
    h.run_ok("browser_screenshot", json!({ "tab_id": "T2" }))
        .await;
    h.mock.assert_recorded("page:Page.captureScreenshot");

    // wait_for 显式 T2（WaitOptions.tab_id 携带）
    h.run_ok(
        "browser_wait_for",
        json!({ "tab_id": "T2", "condition": "text", "text": "你好" }),
    )
    .await;
    h.mock.assert_recorded("wait:Text(\"你好\")");

    // 失效标签 → node_gone
    h.run_ok("browser_close_tab", json!({ "tab_id": "T2" }))
        .await;
    let err = h
        .run_err("browser_get_url", json!({ "tab_id": "T2" }))
        .await;
    assert_eq!(err.code(), "tool.browser.node_gone");
    let err = h
        .run_err(
            "browser_wait_for",
            json!({ "tab_id": "T2", "condition": "text", "text": "x" }),
        )
        .await;
    assert_eq!(err.code(), "tool.browser.node_gone");
}

impl MockSession {
    fn assert_not_recorded(&self, needle: &str) {
        let calls = self.calls();
        assert!(
            !calls.iter().any(|c| c.contains(needle)),
            "不应记录含 {needle:?} 的调用：{calls:?}"
        );
    }
}
