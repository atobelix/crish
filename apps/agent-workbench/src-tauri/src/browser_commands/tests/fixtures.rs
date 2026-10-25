use crate::browser::StorageStateOps;
use crate::core_error::CoreError;
use crate::core_event_bridge::{Emitter, EventBridge};
use crate::core_run_commands::CoreRunState;
use crate::status_diagnostics::StatusDiagnostics;
use async_trait::async_trait;
use conex_browser::cdp::domains::Cookie as CdpCookie;
use conex_browser::cdp::domains::SetCookieParam;
use orchestrator::persist::InMemoryStore;
use orchestrator::restore::SnapshotFileStore;
use std::sync::Arc;

/// `CoreError` → detail 文本（断言辅助：错误文案与旧 String 契约同形，
/// 测试继续用 `starts_with` / `contains` 校验 J1b 码前缀与文案）。
pub(crate) fn err_detail(err: CoreError) -> String {
    match err {
        CoreError::InvalidInput(detail) => detail,
        CoreError::Encoding(detail) => detail,
        CoreError::Io(detail) => detail,
        CoreError::NotFound(detail) => detail,
        CoreError::Internal(detail) => detail,
        CoreError::Cancelled => "cancelled".to_string(),
    }
}

/// 单元测试专用内存事件接收器（实现 [Emitter] trait，记录信道与载荷）。
pub(crate) struct TestEmitter(pub(crate) Arc<std::sync::Mutex<Vec<String>>>);

impl Emitter for TestEmitter {
    fn emit(&self, channel: &str, payload: &str) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(format!("{channel}:{payload}"));
    }
}

/// 构造 mock 引擎状态（CoreRunState 可独立构造；浏览器槽随引擎
/// 装配为真实惰性槽——单元测试不触发启动，仅查询/停止安全面）。
pub(crate) fn mock_core_state(temp: &tempfile::TempDir) -> Arc<CoreRunState> {
    let bridge = EventBridge::new("test", Arc::new(TestEmitter(Arc::new(Default::default()))));
    Arc::new(CoreRunState::new(
        Arc::new(InMemoryStore::new()),
        Arc::new(SnapshotFileStore::new(temp.path().join("snapshot.json"))),
        bridge,
        Arc::new(StatusDiagnostics::new()),
        None,
    ))
}

/// J1b mock storage 发送面：预设实读结果 + 记录注入参数（命令层
/// 断言 CDP wire 面透传，不依赖真实浏览器）。
pub(crate) struct MockStorageOps {
    pub(crate) cookies: Arc<std::sync::Mutex<Vec<CdpCookie>>>,
    pub(crate) injected: Arc<std::sync::Mutex<Vec<SetCookieParam>>>,
    /// 实读调用计数（授权先行断言：未授权时零实读，§5.2 零副作用）。
    pub(crate) get_calls: Arc<std::sync::atomic::AtomicUsize>,
}

impl MockStorageOps {
    pub(crate) fn new(cookies: Vec<CdpCookie>) -> Self {
        MockStorageOps {
            cookies: Arc::new(std::sync::Mutex::new(cookies)),
            injected: Arc::new(std::sync::Mutex::new(Vec::new())),
            get_calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }
    }
}

#[async_trait]
impl StorageStateOps for MockStorageOps {
    async fn get_all_cookies(&self) -> Result<Vec<CdpCookie>, String> {
        self.get_calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(self
            .cookies
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone())
    }
    async fn set_cookies(&self, cookies: Vec<SetCookieParam>) -> Result<(), String> {
        self.injected
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .extend(cookies.clone());
        // N8：模拟浏览器落库——注入参数转 CdpCookie 并入回读面（命令的
        // 注入后回验路径对一致面断言；不一致面由 PartialWriteOps 覆盖）
        let mut stored = self.cookies.lock().unwrap_or_else(|p| p.into_inner());
        for c in cookies {
            stored.push(CdpCookie {
                name: c.name,
                value: c.value,
                domain: c.domain.unwrap_or_default(),
                path: c.path.unwrap_or_default(),
                expires: c.expires.unwrap_or(-1.0),
                size: 0,
                http_only: c.http_only.unwrap_or(false),
                secure: c.secure.unwrap_or(false),
                session: c.expires.is_none(),
                same_site: c.same_site,
                priority: None,
            });
        }
        Ok(())
    }
}

/// CDP cookie 构造辅助（对齐 import/storage_state.rs 测试面）。
pub(crate) fn cdp_cookie(overrides: impl Fn(&mut CdpCookie)) -> CdpCookie {
    let mut c = CdpCookie {
        name: "sid".to_string(),
        value: "abc123".to_string(),
        domain: ".example.com".to_string(),
        path: "/".to_string(),
        expires: 1_750_000_000.0,
        size: 10,
        http_only: true,
        secure: true,
        session: false,
        same_site: Some("Lax".to_string()),
        priority: Some("Medium".to_string()),
    };
    overrides(&mut c);
    c
}

/// 注入 mock storage 发送面（命令层断言面；未注入时槽为未连接面）。
pub(crate) fn inject_mock(state: &Arc<CoreRunState>, mock: MockStorageOps) {
    state
        .engine()
        .browser_slot()
        .inject_storage_ops(Arc::new(mock));
}

/// localStorage 注入通道调用记录（§5.3 注入执行面断言：调用序与参数）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ChannelCall {
    InitScript(String),
    SetItem {
        origin: String,
        key: String,
        value: String,
    },
    GetItems(String),
}

type MockItemsMap = Arc<std::sync::Mutex<std::collections::HashMap<String, Vec<(String, String)>>>>;

/// J1b 扩展面 mock 通道：记录调用（命令层断言 wire 参数透传，
/// 不依赖真实浏览器会话；对齐 import/storage_state.rs 测试面）。
#[derive(Default)]
pub(crate) struct MockLocalStorageChannel {
    pub(crate) calls: Arc<std::sync::Mutex<Vec<ChannelCall>>>,
    /// get_dom_storage_items 返回值（按 origin 预设；缺省空——
    /// 导出聚合断言面，P1-3）。
    pub(crate) items: MockItemsMap,
}

impl MockLocalStorageChannel {
    /// 预设某 origin 的 localStorage 读取结果（导出聚合断言，P1-3）。
    pub(crate) fn with_items(self, origin: &str, items: Vec<(&str, &str)>) -> Self {
        self.items.lock().unwrap_or_else(|p| p.into_inner()).insert(
            origin.to_string(),
            items
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        );
        self
    }
}

#[async_trait]
impl conex_browser::import::storage_state::LocalStorageChannel for MockLocalStorageChannel {
    async fn add_init_script(
        &self,
        source: &str,
    ) -> Result<(), conex_browser::import::storage_state::StorageStateError> {
        self.calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(ChannelCall::InitScript(source.to_string()));
        Ok(())
    }

    async fn set_dom_storage_item(
        &self,
        security_origin: &str,
        key: &str,
        value: &str,
    ) -> Result<(), conex_browser::import::storage_state::StorageStateError> {
        self.calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(ChannelCall::SetItem {
                origin: security_origin.to_string(),
                key: key.to_string(),
                value: value.to_string(),
            });
        Ok(())
    }

    async fn get_dom_storage_items(
        &self,
        security_origin: &str,
    ) -> Result<Vec<(String, String)>, conex_browser::import::storage_state::StorageStateError>
    {
        self.calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(ChannelCall::GetItems(security_origin.to_string()));
        Ok(self
            .items
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(security_origin)
            .cloned()
            .unwrap_or_default())
    }
}

/// 注入 mock localStorage 通道（命令层断言面；未注入时访问器走
/// 未连接路径 → not_ready）。
pub(crate) fn inject_local_storage_mock(state: &Arc<CoreRunState>, mock: MockLocalStorageChannel) {
    state
        .engine()
        .browser_slot()
        .inject_local_storage_channel(Arc::new(mock));
}
