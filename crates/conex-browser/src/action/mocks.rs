//! 动作层确定性测试基建（cfg(test)）：PageOps/SnapshotStore/Delay/DomainGate mock
//!
//! 设计口径（14 §10）：重试/超时/竞态全部 mock 测试，真实浏览器 e2e 留待联调；
//! mock 记录全部调用（MockCall 顺序可断言），支持一次性失败队列、指定第 N 次失败、
//! 持久失败、挂起（触发总预算超时）、abort 注入（on_fail_cancel/cancel_after_char）。

use crate::action::{
    ActionError, ActionErrorKind, Delay, DomainGate, ElementMeta, GateDenial, PageOps,
    SnapshotStore, ViewportSize,
};
use crate::cdp::domains::{BoxModel, DispatchKeyEventParams, DispatchMouseEventParams};
use crate::cdp::sender::CancellationToken;
use crate::cdp::version::{Stale, TabId};
use async_trait::async_trait;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 可注入失败的 CDP 操作面。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MockOp {
    CurrentUrl,
    Viewport,
    PushNodes,
    BoxModel,
    ScrollIntoView,
    FocusNode,
    ResolveNode,
    CallFunctionOn,
    MouseEvent,
    KeyEvent,
    InsertText,
    Evaluate,
    CreateIsolatedWorld,
    EvaluateIsolated,
    NetworkInFlight,
    SetFileInputFiles,
    IsFileInput,
    FileChooserNode,
    AwaitConnectionRestored,
    GoBack,
    TargetAlive,
}

/// 调用记录（op + 参数摘要，顺序即派发顺序）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockCall {
    pub op: MockOp,
    pub detail: String,
}

/// MockOps 可变状态（测试直接 lock 注入行为/断言记录）。
pub struct MockOpsState {
    pub calls: Vec<MockCall>,
    pub counts: HashMap<MockOp, u32>,
    /// 当前 URL（门禁/导航复核输入）
    pub url: String,
    /// mouse_event 后切换的 URL（导航模拟；§5.4 后置复核）
    pub url_after_mouse: Option<String>,
    pub viewport: ViewportSize,
    /// backendNodeId → 前端树 nodeId（未登记 → 返回 -1 → 视为节点过期）
    pub node_by_backend: HashMap<i64, i64>,
    /// nodeId → box（未登记 → Err(NodeStale)，模拟 "Could not compute box model"）
    pub box_models: HashMap<i64, BoxModel>,
    /// 遮挡检测结果（elementFromPoint 模板返回值）
    pub occlusion: bool,
    /// 文本轮询/activeElement 回读结果（Evaluate 模板分支）
    pub text_match: bool,
    /// activeElement 回读值（verify_progress 输入）
    pub active_value: String,
    /// upload 回读文件名（files[0].name 模板分支）
    pub readback_name: String,
    /// select 回读值（options 模板分支）
    pub select_return: String,
    /// 在途请求数（NetworkIdle 输入）
    pub in_flight: usize,
    /// file input 节点集合（is_file_input 判定）
    pub file_inputs: HashSet<i64>,
    /// fileChooserOpened 暴露的 file input backendNodeId（None → 无事件）
    pub chooser_node: Option<i64>,
    /// ConnectionRestored 是否已到达（AwaitConnection 输入）
    pub restored: bool,
    /// 目标存活（TargetClosed 恢复路径输入）
    pub alive: bool,
    /// 持久失败（每次调用都失败）
    pub persist_errors: HashMap<MockOp, ActionError>,
    /// 指定第 N 次调用失败（(op, 第 N 次) → 错误）
    pub fail_on_call: HashMap<(MockOp, u32), ActionError>,
    /// 一次性失败队列（下一次匹配调用即消耗；on_fail_cancel 同步触发）
    pub fail_queue: VecDeque<(MockOp, ActionError)>,
    /// fail_queue 消耗时触发取消（重试中注入 abort 的确定性手段）
    pub on_fail_cancel: Option<CancellationToken>,
    /// 挂起面（调用永不返回；配合总预算超时测试）
    pub hang: HashSet<MockOp>,
    /// 第 N 个键盘事件后触发取消（type 分块间 abort 注入）
    pub cancel_after_char: Option<(u32, CancellationToken)>,
    /// 隔离世界标识（CreateIsolatedWorld 返回；None → 世界创建失败注入）
    pub isolated_world: Option<String>,
    /// 隔离世界求值返回（EvaluateIsolated 结果；表达式关键字可分支）
    pub isolated_result: Value,
}

/// 确定性 CDP mock（全部方法即时返回；注入面见 MockOpsState）。
#[derive(Clone)]
pub struct MockOps {
    pub state: Arc<Mutex<MockOpsState>>,
}

impl MockOps {
    pub fn new() -> Self {
        let state = MockOpsState {
            calls: Vec::new(),
            counts: HashMap::new(),
            url: "https://example.com".to_string(),
            url_after_mouse: None,
            viewport: ViewportSize { width: 1280.0, height: 720.0 },
            node_by_backend: HashMap::from([
                (11, 111),
                (21, 121),
                (22, 122),
                (31, 131),
            ]),
            box_models: HashMap::from([
                (111, box_at(0.0, 0.0, 100.0, 50.0)),
                (121, box_at(200.0, 0.0, 100.0, 50.0)),
                (122, box_at(0.0, 200.0, 100.0, 50.0)),
                (131, box_at(0.0, 0.0, 100.0, 50.0)),
            ]),
            occlusion: true,
            text_match: false,
            active_value: String::new(),
            readback_name: String::new(),
            select_return: String::new(),
            in_flight: 0,
            file_inputs: HashSet::new(),
            chooser_node: None,
            restored: true,
            alive: true,
            persist_errors: HashMap::new(),
            fail_on_call: HashMap::new(),
            fail_queue: VecDeque::new(),
            on_fail_cancel: None,
            hang: HashSet::new(),
            cancel_after_char: None,
            isolated_world: Some("world-42".to_string()),
            isolated_result: Value::Null,
        };
        MockOps { state: Arc::new(Mutex::new(state)) }
    }

    fn record(&self, op: MockOp, detail: impl Into<String>) {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        *s.counts.entry(op).or_insert(0) += 1;
        s.calls.push(MockCall { op, detail: detail.into() });
    }

    fn inject(&self, op: MockOp) -> Option<ActionError> {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let n = *s.counts.get(&op).unwrap_or(&0);
        if let Some(err) = s.fail_on_call.get(&(op, n)).cloned() {
            return Some(err);
        }
        if s.fail_queue.front().map(|(o, _)| *o == op).unwrap_or(false) {
            let (_, err) = s.fail_queue.pop_front().expect("front 已判非空");
            if let Some(t) = &s.on_fail_cancel {
                t.cancel();
            }
            return Some(err);
        }
        s.persist_errors.get(&op).cloned()
    }

    fn hangs(&self, op: MockOp) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .hang
            .contains(&op)
    }

    /// 指定操作的调用记录（保序）。
    pub fn calls_of(&self, op: MockOp) -> Vec<MockCall> {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .calls
            .iter()
            .filter(|c| c.op == op)
            .cloned()
            .collect()
    }

    /// 指定操作调用次数。
    pub fn count(&self, op: MockOp) -> usize {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .counts
            .get(&op)
            .copied()
            .unwrap_or(0) as usize
    }
}

impl Default for MockOps {
    fn default() -> Self {
        Self::new()
    }
}

fn box_at(x: f64, y: f64, w: f64, h: f64) -> BoxModel {
    BoxModel {
        content: vec![x, y, x + w, y, x + w, y + h, x, y + h],
        padding: vec![x, y, x + w, y, x + w, y + h, x, y + h],
        border: vec![x, y, x + w, y, x + w, y + h, x, y + h],
        margin: vec![x, y, x + w, y, x + w, y + h, x, y + h],
        width: w as i64,
        height: h as i64,
    }
}

fn mouse_detail(p: &DispatchMouseEventParams) -> String {
    format!(
        "{} x={} y={} button={} count={} buttons={} deltaX={} deltaY={}",
        p.event_type,
        p.x,
        p.y,
        p.button.clone().unwrap_or_default(),
        p.click_count.unwrap_or(0),
        p.buttons.unwrap_or(0),
        p.delta_x.unwrap_or(0.0),
        p.delta_y.unwrap_or(0.0),
    )
}

fn key_detail(p: &DispatchKeyEventParams) -> String {
    format!(
        "{} key={:?} code={:?} mods={} vk={} text={:?}",
        p.event_type,
        p.key.clone().unwrap_or_default(),
        p.code.clone().unwrap_or_default(),
        p.modifiers.unwrap_or(0),
        p.windows_virtual_key_code.unwrap_or(0),
        p.text.clone().unwrap_or_default(),
    )
}

#[allow(clippy::unused_async)]
#[async_trait]
impl PageOps for MockOps {
    async fn current_url(&self) -> Result<String, ActionError> {
        self.record(MockOp::CurrentUrl, "");
        if let Some(err) = self.inject(MockOp::CurrentUrl) {
            return Err(err);
        }
        if self.hangs(MockOp::CurrentUrl) {
            std::future::pending().await
        }
        Ok(self.state.lock().unwrap_or_else(|p| p.into_inner()).url.clone())
    }

    async fn viewport(&self) -> Result<ViewportSize, ActionError> {
        self.record(MockOp::Viewport, "");
        if let Some(err) = self.inject(MockOp::Viewport) {
            return Err(err);
        }
        Ok(self.state.lock().unwrap_or_else(|p| p.into_inner()).viewport)
    }

    async fn push_nodes(&self, backend_ids: &[i64]) -> Result<Vec<i64>, ActionError> {
        self.record(MockOp::PushNodes, format!("{backend_ids:?}"));
        if let Some(err) = self.inject(MockOp::PushNodes) {
            return Err(err);
        }
        if self.hangs(MockOp::PushNodes) {
            std::future::pending().await
        }
        let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        Ok(backend_ids
            .iter()
            .map(|b| s.node_by_backend.get(b).copied().unwrap_or(-1))
            .collect())
    }

    async fn box_model(&self, node_id: i64) -> Result<BoxModel, ActionError> {
        self.record(MockOp::BoxModel, format!("node={node_id}"));
        if let Some(err) = self.inject(MockOp::BoxModel) {
            return Err(err);
        }
        let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        match s.box_models.get(&node_id) {
            Some(model) => Ok(model.clone()),
            None => Err(ActionError::new(
                ActionErrorKind::NodeStale,
                format!("getBoxModel 失败：Could not compute box model（node {node_id}）"),
            )),
        }
    }

    async fn scroll_into_view(&self, node_id: i64) -> Result<(), ActionError> {
        self.record(MockOp::ScrollIntoView, format!("node={node_id}"));
        if let Some(err) = self.inject(MockOp::ScrollIntoView) {
            return Err(err);
        }
        Ok(())
    }

    async fn focus_node(&self, node_id: i64) -> Result<(), ActionError> {
        self.record(MockOp::FocusNode, format!("node={node_id}"));
        if let Some(err) = self.inject(MockOp::FocusNode) {
            return Err(err);
        }
        Ok(())
    }

    async fn resolve_node(&self, node_id: i64) -> Result<String, ActionError> {
        self.record(MockOp::ResolveNode, format!("node={node_id}"));
        if let Some(err) = self.inject(MockOp::ResolveNode) {
            return Err(err);
        }
        Ok(format!("obj-{node_id}"))
    }

    async fn call_function_on(
        &self,
        object_id: &str,
        function: &str,
        args: &[Value],
    ) -> Result<Value, ActionError> {
        self.record(
            MockOp::CallFunctionOn,
            format!("fn={function} args={args:?} obj={object_id}"),
        );
        if let Some(err) = self.inject(MockOp::CallFunctionOn) {
            return Err(err);
        }
        let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let value = if function.contains("elementFromPoint") {
            serde_json::json!(s.occlusion)
        } else if function.contains("files") {
            serde_json::json!(s.readback_name)
        } else if function.contains("options") {
            serde_json::json!(s.select_return)
        } else {
            serde_json::json!(s.text_match)
        };
        Ok(value)
    }

    async fn mouse_event(&self, params: DispatchMouseEventParams) -> Result<(), ActionError> {
        let detail = mouse_detail(&params);
        self.record(MockOp::MouseEvent, detail);
        if let Some(err) = self.inject(MockOp::MouseEvent) {
            return Err(err);
        }
        if self.hangs(MockOp::MouseEvent) {
            std::future::pending().await
        }
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(url) = s.url_after_mouse.clone() {
            s.url = url; // 导航模拟（§5.4 后置复核输入）
        }
        Ok(())
    }

    async fn key_event(&self, params: DispatchKeyEventParams) -> Result<(), ActionError> {
        let detail = key_detail(&params);
        self.record(MockOp::KeyEvent, detail);
        if let Some(err) = self.inject(MockOp::KeyEvent) {
            return Err(err);
        }
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((n, token)) = s.cancel_after_char.as_mut() {
            if *n > 0 {
                *n -= 1;
                if *n == 0 {
                    token.cancel();
                }
            }
        }
        Ok(())
    }

    async fn insert_text(&self, text: &str) -> Result<(), ActionError> {
        self.record(MockOp::InsertText, format!("text={text:?}"));
        if let Some(err) = self.inject(MockOp::InsertText) {
            return Err(err);
        }
        Ok(())
    }

    async fn evaluate(&self, expression: &str) -> Result<Value, ActionError> {
        self.record(MockOp::Evaluate, format!("expr={expression}"));
        if let Some(err) = self.inject(MockOp::Evaluate) {
            return Err(err);
        }
        let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        // 回读模板（activeElement）→ active_value；文本轮询模板 → text_match
        let value = if expression.contains("activeElement") {
            serde_json::json!(s.active_value)
        } else {
            serde_json::json!(s.text_match)
        };
        Ok(value)
    }

    async fn create_isolated_world(&self) -> Result<String, ActionError> {
        self.record(MockOp::CreateIsolatedWorld, "");
        if let Some(err) = self.inject(MockOp::CreateIsolatedWorld) {
            return Err(err);
        }
        let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        s.isolated_world
            .clone()
            .ok_or_else(|| ActionError::new(ActionErrorKind::Unsupported, "世界创建失败（注入）"))
    }

    async fn evaluate_isolated(&self, world_id: &str, expression: &str) -> Result<Value, ActionError> {
        self.record(MockOp::EvaluateIsolated, format!("world={world_id} expr={expression}"));
        if let Some(err) = self.inject(MockOp::EvaluateIsolated) {
            return Err(err);
        }
        let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        Ok(s.isolated_result.clone())
    }

    async fn network_in_flight(&self) -> Result<usize, ActionError> {
        self.record(MockOp::NetworkInFlight, "");
        if let Some(err) = self.inject(MockOp::NetworkInFlight) {
            return Err(err);
        }
        Ok(self.state.lock().unwrap_or_else(|p| p.into_inner()).in_flight)
    }

    async fn set_file_input_files(
        &self,
        backend_node_id: i64,
        files: &[String],
    ) -> Result<(), ActionError> {
        self.record(
            MockOp::SetFileInputFiles,
            format!("backend={backend_node_id} files={files:?}"),
        );
        if let Some(err) = self.inject(MockOp::SetFileInputFiles) {
            return Err(err);
        }
        Ok(())
    }

    async fn is_file_input(&self, node_id: i64) -> Result<bool, ActionError> {
        self.record(MockOp::IsFileInput, format!("node={node_id}"));
        if let Some(err) = self.inject(MockOp::IsFileInput) {
            return Err(err);
        }
        Ok(self
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .file_inputs
            .contains(&node_id))
    }

    async fn file_chooser_node(&self, timeout: Duration) -> Result<i64, ActionError> {
        self.record(
            MockOp::FileChooserNode,
            format!("timeout={}ms", timeout.as_millis()),
        );
        if let Some(err) = self.inject(MockOp::FileChooserNode) {
            return Err(err);
        }
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .chooser_node
            .ok_or_else(|| {
                ActionError::new(
                    ActionErrorKind::Timeout,
                    "等待 Page.fileChooserOpened 超时（mock 无事件）",
                )
            })
    }

    async fn await_connection_restored(&self, timeout: Duration) -> Result<(), ActionError> {
        self.record(
            MockOp::AwaitConnectionRestored,
            format!("timeout={}ms", timeout.as_millis()),
        );
        if let Some(err) = self.inject(MockOp::AwaitConnectionRestored) {
            return Err(err);
        }
        if self.state.lock().unwrap_or_else(|p| p.into_inner()).restored {
            Ok(())
        } else {
            Err(ActionError::new(
                ActionErrorKind::ConnectionLost,
                format!("等待 ConnectionRestored 超时（{}ms）", timeout.as_millis()),
            ))
        }
    }

    async fn go_back(&self) -> Result<(), ActionError> {
        self.record(MockOp::GoBack, "");
        if let Some(err) = self.inject(MockOp::GoBack) {
            return Err(err);
        }
        Ok(())
    }

    async fn target_alive(&self) -> Result<bool, ActionError> {
        self.record(MockOp::TargetAlive, "");
        if let Some(err) = self.inject(MockOp::TargetAlive) {
            return Err(err);
        }
        Ok(self.state.lock().unwrap_or_else(|p| p.into_inner()).alive)
    }
}

/// MockOps 可变状态（快照面）。
pub struct MockSnapState {
    pub version: u64,
    /// version → 索引表；u64::MAX 为任意版本兜底键
    pub elements: HashMap<u64, Vec<ElementMeta>>,
    /// 重快照一次性失败队列
    pub take_errors: VecDeque<ActionError>,
    pub take_count: usize,
    /// note_action_done 记录（tab_id 序）
    pub bumps: Vec<String>,
    /// 恒 Stale（版本校验注入面）
    pub stale_forever: bool,
}

/// 确定性快照存储 mock。
#[derive(Clone)]
pub struct MockSnapshotStore {
    pub state: Arc<Mutex<MockSnapState>>,
}

impl MockSnapshotStore {
    pub fn new(version: u64) -> Self {
        MockSnapshotStore {
            state: Arc::new(Mutex::new(MockSnapState {
                version,
                elements: HashMap::new(),
                take_errors: VecDeque::new(),
                take_count: 0,
                bumps: Vec::new(),
                stale_forever: false,
            })),
        }
    }

    /// 任意版本兜底索引表（重快照后版本递增仍可命中）。
    pub fn with_elements(version: u64, elements: &[ElementMeta]) -> Self {
        let store = Self::new(version);
        store
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .elements
            .insert(u64::MAX, elements.to_vec());
        store
    }

    pub fn take_count(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take_count
    }
}

#[allow(clippy::unused_async)]
#[async_trait]
impl SnapshotStore for MockSnapshotStore {
    fn snapshot_version(&self, tab_id: &TabId) -> u64 {
        let _ = tab_id;
        self.state.lock().unwrap_or_else(|p| p.into_inner()).version
    }

    fn validate_snapshot(&self, tab_id: &TabId, version: u64) -> Result<(), Stale> {
        let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if s.stale_forever || version != s.version {
            return Err(Stale {
                tab_id: tab_id.clone(),
                expected: version,
                current: s.version,
                epoch: 0,
            });
        }
        Ok(())
    }

    async fn take_snapshot(&self, tab_id: &TabId) -> Result<u64, ActionError> {
        self.record_take();
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(err) = s.take_errors.pop_front() {
            return Err(err);
        }
        s.version += 1;
        let _ = tab_id;
        Ok(s.version)
    }

    fn element_by_index(&self, tab_id: &TabId, version: u64, index: usize) -> Option<ElementMeta> {
        let s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let _ = tab_id;
        s.elements
            .get(&version)
            .or_else(|| s.elements.get(&u64::MAX))
            .and_then(|list| list.get(index))
            .copied()
    }

    fn note_action_done(&self, tab_id: &TabId) {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .bumps
            .push(tab_id.clone());
    }
}

impl MockSnapshotStore {
    fn record_take(&self) {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take_count += 1;
    }
}

/// 记录型延迟（不真实等待；断言节流/重试延迟序列）。
pub struct RecordingDelay {
    pub sleeps: Arc<Mutex<Vec<Duration>>>,
}

impl RecordingDelay {
    pub fn new() -> Self {
        RecordingDelay { sleeps: Arc::new(Mutex::new(Vec::new())) }
    }

    pub fn durations(&self) -> Vec<Duration> {
        self.sleeps.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

impl Default for RecordingDelay {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Delay for RecordingDelay {
    async fn sleep(&self, duration: Duration) {
        self.sleeps
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(duration);
    }
}

/// 全放行门禁（测试默认面）。
pub struct AllowGate;

impl DomainGate for AllowGate {
    fn check(&self, _url: &str) -> Result<(), GateDenial> {
        Ok(())
    }
}

/// 子串拒绝门禁（deny 列表命中即拒绝）。
pub struct DenyGate {
    deny: Vec<String>,
}

impl DenyGate {
    pub fn new(deny: Vec<String>) -> Self {
        DenyGate { deny }
    }
}

impl DomainGate for DenyGate {
    fn check(&self, url: &str) -> Result<(), GateDenial> {
        if self.deny.iter().any(|d| url.contains(d.as_str())) {
            Err(GateDenial {
                url: url.to_string(),
                reason: format!("域名被拒绝（黑名单命中：{url}）"),
            })
        } else {
            Ok(())
        }
    }
}
