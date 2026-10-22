//! CDP 交互抽象（PageOps）与延迟注入抽象（Delay）。

use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

use crate::action::ActionError;
use crate::action::locate::ViewportSize;
use crate::cdp::domains::{BoxModel, DispatchKeyEventParams, DispatchMouseEventParams};

/// 延迟注入抽象（重试延迟/type 节流/轮询间隔共用；测试注入记录型不真实等待）。
#[async_trait]
pub trait Delay: Send + Sync {
    async fn sleep(&self, duration: Duration);
}

/// 真实延迟（tokio sleep）。
pub struct TokioDelay;

#[async_trait]
impl Delay for TokioDelay {
    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

/// CDP 交互抽象（维度 14 消费面；真实实现 BrowserPageOps / 测试 mock 共用执行器）。
///
/// 全部方法按 `ActionError` 分类返回（映射口径见模块头注释），供重试状态机决策；
/// 命令参数一律经 JSON 序列化注入，函数模板固定、参数永不字符串拼接（R-5 纪律）。
#[async_trait]
pub trait PageOps: Send + Sync {
    /// 当前页面 URL（门禁动作检查点/导航复核/wait_for Url 条件）。
    async fn current_url(&self) -> Result<String, ActionError>;
    /// 布局视口尺寸（§3.3 坐标裁剪用）。
    async fn viewport(&self) -> Result<ViewportSize, ActionError>;
    /// DOM.pushNodesByBackendIdsToFrontend（backendNodeId → 前端树 nodeId）。
    async fn push_nodes(&self, backend_ids: &[i64]) -> Result<Vec<i64>, ActionError>;
    /// DOM.getBoxModel（nodeId；"Could not compute box model" → NodeStale）。
    async fn box_model(&self, node_id: i64) -> Result<BoxModel, ActionError>;
    /// DOM.scrollIntoViewIfNeeded（§3.2 滚动容器路径）。
    async fn scroll_into_view(&self, node_id: i64) -> Result<(), ActionError>;
    /// DOM.focus（无坐标路径聚焦）。
    async fn focus_node(&self, node_id: i64) -> Result<(), ActionError>;
    /// DOM.resolveNode → objectId（遮挡检测/select/回读共用）。
    async fn resolve_node(&self, node_id: i64) -> Result<String, ActionError>;
    /// Runtime.callFunctionOn（固定模板 + args 序列化注入，`this` 绑定目标元素）。
    async fn call_function_on(
        &self,
        object_id: &str,
        function: &str,
        args: &[Value],
    ) -> Result<Value, ActionError>;
    /// Input.dispatchMouseEvent（click/hover/drag/scroll 统一注入管线）。
    async fn mouse_event(&self, params: DispatchMouseEventParams) -> Result<(), ActionError>;
    /// Input.dispatchKeyEvent（type 三事件序列 / key 组合键）。
    async fn key_event(&self, params: DispatchKeyEventParams) -> Result<(), ActionError>;
    /// Input.insertText（IME 安全路径，§4.4）。
    async fn insert_text(&self, text: &str) -> Result<(), ActionError>;
    /// Runtime.evaluate（固定模板只读求值；wait_for 文本轮询/回读校验）。
    async fn evaluate(&self, expression: &str) -> Result<Value, ActionError>;
    /// 创建隔离世界（17 §3.2：evaluate 受限求值的隔离世界；缺陷 A 修复——
    /// Chrome 151 已移除 Runtime.createIsolatedWorld，改走 Page.getFrameTree（取主
    /// frameId）+ Page.createIsolatedWorld；返回 executionContextId 字符串）。
    /// 建世界成功后即注入 `__crish_read` 只读白名单代理（缺陷 B 修复）——
    /// 返回的世界保证代理已可见，注入失败视同世界创建失败。
    async fn create_isolated_world(&self) -> Result<String, ActionError>;
    /// Runtime.evaluate 于隔离世界执行（17 §3.2：awaitPromise/2s 超时/userGesture=false/
    /// returnByValue=true；返回纯 JSON 拷贝；`__crish_read` 代理由建世界时注入）。
    async fn evaluate_isolated(
        &self,
        world_id: &str,
        expression: &str,
    ) -> Result<Value, ActionError>;
    /// 在途请求数（wait_for NetworkIdle 条件）。
    async fn network_in_flight(&self) -> Result<usize, ActionError>;
    /// DOM.setFileInputFiles（上传直接路径，§9.1 4a）。
    async fn set_file_input_files(
        &self,
        backend_node_id: i64,
        files: &[String],
    ) -> Result<(), ActionError>;
    /// 元素是否为 input[type=file]（固定模板判定，§9.1 步骤 4 分流）。
    async fn is_file_input(&self, node_id: i64) -> Result<bool, ActionError>;
    /// 等待 Page.fileChooserOpened 事件（代理触发器路径，§9.1 4b）。
    async fn file_chooser_node(&self, timeout: Duration) -> Result<i64, ActionError>;
    /// 等待 ConnectionRestored 恢复事件（R-9，ConnectionLost 恢复路径）。
    async fn await_connection_restored(&self, timeout: Duration) -> Result<(), ActionError>;
    /// Page.goBack（门禁后置复核回退，§7.1 ③）。
    async fn go_back(&self) -> Result<(), ActionError>;
    /// 目标（标签页）存活探测（TargetClosed 恢复路径，§5.1）。
    async fn target_alive(&self) -> Result<bool, ActionError>;
}
