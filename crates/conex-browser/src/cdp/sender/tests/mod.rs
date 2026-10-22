use super::*;
use crate::cdp::client::CdpClient;
use crate::cdp::mock::{MockReply, MockServer};
use serde_json::json;
use std::sync::Mutex;

/// 记录型钩子：管线顺序断言（验收 9.1-20）。
struct RecordingHooks {
    order: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    token: CancellationToken,
    approve_ok: bool,
    /// 会话只读能力集（R-12）：None = 不启用（默认，正常工具面）
    caps: Mutex<Option<Arc<ReadonlyCaps>>>,
    idempotent_cached: Mutex<Option<Result<Value, CdpError>>>,
    /// 幂等钩子返回前的延迟（H3 测试用：让并发合并方先订阅在途通道，
    /// 确定性复现「缓存命中 + 在途等待方」时序）
    cache_delay: Mutex<Option<Duration>>,
}

impl RecordingHooks {
    fn new(approve_ok: bool) -> Self {
        RecordingHooks {
            order: Arc::new(Mutex::new(Vec::new())),
            stop: Arc::new(AtomicBool::new(false)),
            token: CancellationToken::new(),
            approve_ok,
            caps: Mutex::new(None),
            idempotent_cached: Mutex::new(None),
            cache_delay: Mutex::new(None),
        }
    }
    fn set_caps(&self, caps: ReadonlyCaps) {
        *self.caps.lock().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(caps));
    }
    fn record(&self, step: &str) {
        self.order
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(step.to_string());
    }
    fn steps(&self) -> Vec<String> {
        self.order.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

#[async_trait]
impl CommandPolicyHooks for RecordingHooks {
    async fn idempotent(&self, _key: &IdKey) -> Option<Result<Value, CdpError>> {
        self.record("idempotent");
        let delay = *self.cache_delay.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(d) = delay {
            tokio::time::sleep(d).await;
        }
        self.idempotent_cached
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
    async fn approve(&self, _cmd: &CdpCommandView) -> Result<(), ApprovalDenied> {
        self.record("approve");
        if self.approve_ok {
            Ok(())
        } else {
            Err(ApprovalDenied {
                reason: "测试拒绝".to_string(),
            })
        }
    }
    fn audit(&self, event: BrowserAuditEvent) {
        self.record(match event.phase {
            AuditPhase::Before => "audit:before",
            AuditPhase::After => "audit:after",
            AuditPhase::Denied => "audit:denied",
            AuditPhase::Blocked => "audit:blocked",
        });
    }
    fn emergency_stop(&self) -> Arc<AtomicBool> {
        self.stop.clone()
    }
    fn abort_token(&self) -> CancellationToken {
        self.token.clone()
    }
    fn attach_caps(&self) -> Option<Arc<ReadonlyCaps>> {
        self.caps.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

/// 组装：mock 服务端 + 直连 client 通道 + 记录钩子。
async fn setup(approve_ok: bool) -> (MockServer, Arc<CdpClient>, Arc<RecordingHooks>) {
    let mock = MockServer::spawn().await;
    let client = Arc::new(
        crate::cdp::client::CdpClient::connect(&mock.url("/devtools/browser/sender"))
            .await
            .expect("建连失败"),
    );
    let hooks = Arc::new(RecordingHooks::new(approve_ok));
    (mock, client, hooks)
}

mod attach_proxy;
mod pipeline;
mod real_chrome;
