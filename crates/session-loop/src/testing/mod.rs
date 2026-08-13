//! 测试替身（任务书 B3.6 的先行落地：B3.4 测试所需的一等公民）
//!
//! - [TestProvider]：脚本化 provider——事件脚本 / 按调用序号分叉脚本 /
//!   请求记录 / 栅栏 Sleep / 错误注入（对齐 05 §4.1-4.6、§6.2 能力表）；
//! - [TestTool]：脚本化工具——固定输出 / 固定抛错 / 调用入参记录
//!   （对齐 05 §4.3 createMockTool 的 executeHook 语义）。
//!
//! B3.6 将继续补齐 TestGateway / 断言助手（assert_request_text_contains 等）；
//! 本任务提供 B3.4 验收所需的全部能力。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_tools::definition::{Tool, ToolDefinition, ToolError};
use async_trait::async_trait;
use conex_types::message::AgentMessage;
use conex_types::response::ClassifiedStreamError;

use crate::provider::{ProviderCall, ProviderEventStream, ProviderRequest, ToolSchema};
use crate::stream::{ProviderStreamEvent, StopReason};

/// 脚本化测试 provider（05 §4.1/4.6 蓝本）
///
/// - 脚本数组按调用序号取（超出取最后一个，05 §6.2）；
/// - `error` 注入：调用即返回 Err(已分类传输错误)（05 §4.1 setError）；
/// - `pause_after_index` 栅栏：产出第 N 个事件后 Sleep（05 §4.5
///   pauseAfterIndex+pauseMs，配合 L2/L3 中途落地）；
/// - `requests` 记录每次调用的请求快照（05 §4.6，供 nudge / max_tokens
///   断言）。
#[derive(Debug)]
pub struct TestProvider {
    /// 按调用序号分叉的事件脚本（超出取最后一份）
    scripts: Vec<Vec<ProviderStreamEvent>>,
    /// 传输层错误注入（每次调用返回 Err）
    error: Option<ClassifiedStreamError>,
    /// 仅首次调用注入的错误（重试阶梯测试用，取后即空）
    error_once: Arc<Mutex<Option<ClassifiedStreamError>>>,
    /// 栅栏：产出第 N 个事件后 Sleep pause_ms
    pause_after_index: Option<(usize, Duration)>,
    /// 只产出前 fail_after 个事件后静默结束（05 §4.1 setFailAfter）
    fail_after: Option<usize>,
    /// 调用计数（线程安全：run 并发）
    call_count: Arc<Mutex<usize>>,
    /// 请求记录（断言快照；owned 形态，跨生命周期稳定存储）
    requests: Arc<Mutex<Vec<RequestSnapshot>>>,
}

impl TestProvider {
    /// 新建：单一事件脚本
    ///
    /// T06.3 Q20：构造期校验脚本非空——`stream()` 时按调用序号取脚本、
    /// 超出取最后一份（`last()` 必成功），避免延迟 panic。
    pub fn new(script: Vec<ProviderStreamEvent>) -> Self {
        assert!(!script.is_empty(), "TestProvider 脚本至少一份（构造期校验）");
        Self {
            scripts: vec![script],
            error: None,
            error_once: Arc::new(Mutex::new(None)),
            pause_after_index: None,
            fail_after: None,
            call_count: Arc::new(Mutex::new(0)),
            requests: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// 按调用序号分叉脚本（第 N 次调用取 scripts[N]；超出取最后一份）
    ///
    /// T06.3 Q20：构造期校验脚本数组非空（对齐 [Self::new]）。
    pub fn with_scripts(scripts: Vec<Vec<ProviderStreamEvent>>) -> Self {
        assert!(!scripts.is_empty(), "TestProvider 脚本数组至少一份（构造期校验）");
        Self {
            scripts,
            error: None,
            error_once: Arc::new(Mutex::new(None)),
            pause_after_index: None,
            fail_after: None,
            call_count: Arc::new(Mutex::new(0)),
            requests: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// 注入传输层错误（已分类；瞬态类走重试阶梯，其余 PROVIDER_ERROR）。
    /// 每次调用都注入（对齐 05 §4.1 setError 语义）。
    pub fn with_error(mut self, error: ClassifiedStreamError) -> Self {
        self.error = Some(error);
        self
    }

    /// 仅首次调用注入错误（重试阶梯测试用：一次失败后成功）
    pub fn with_error_once(mut self, error: ClassifiedStreamError) -> Self {
        self.error_once = Arc::new(Mutex::new(Some(error)));
        self
    }

    /// 栅栏：产出第 `index` 个事件后 Sleep（0 起；模拟流式停顿）
    pub fn with_pause(mut self, index: usize, pause_ms: u64) -> Self {
        self.pause_after_index = Some((index, Duration::from_millis(pause_ms)));
        self
    }

    /// 只产出前 n 个事件（模拟中途断流）
    pub fn with_fail_after(mut self, n: usize) -> Self {
        self.fail_after = Some(n);
        self
    }

    /// 请求记录快照（断言用：messages / tools / max_tokens）
    ///
    /// 冻结签名下 [ProviderRequest] 携带借用期 `'a`，替身内部改存 owned 快照
    /// （[RequestSnapshot]），字段访问形态与借用形态一致。
    pub fn requests(&self) -> Vec<RequestSnapshot> {
        self.requests.lock().unwrap().clone()
    }

    /// 调用次数
    pub fn call_count(&self) -> usize {
        *self.call_count.lock().unwrap()
    }

    /// 第 n 次请求的消息列表（越界返回空；owned 内容快照，供既有断言
    /// 访问形态不变——零拷贝身份断言用 [Self::request_message_arcs]）
    pub fn request_messages(&self, n: usize) -> Vec<AgentMessage> {
        self.requests()
            .get(n)
            .map(|r| r.messages.iter().map(|m| m.as_ref().clone()).collect())
            .unwrap_or_default()
    }

    /// 第 n 次请求的消息 Arc 列表（越界返回空；Arc 克隆便宜）
    ///
    /// PE-09 T09.3：请求链零拷贝的身份断言入口——与收口对话
    /// （[crate::r#loop::RunOutcome::messages]）逐条 `Arc::ptr_eq` 即证明
    /// 请求构建 0 深拷贝（旧形态每轮 `conversation.clone()` 每次都是新分配）。
    pub fn request_message_arcs(&self, n: usize) -> Vec<Arc<AgentMessage>> {
        self.requests().get(n).map(|r| r.messages.clone()).unwrap_or_default()
    }

    /// 第 n 次请求的 max_tokens
    pub fn request_max_tokens(&self, n: usize) -> Option<u32> {
        self.requests().get(n).and_then(|r| r.max_tokens)
    }

    /// 第 n 次请求的 system prompt（M1 注入通道断言用：注入段经
    /// system_prompt 面送达，不混入会话消息）
    pub fn request_system_prompt(&self, n: usize) -> Option<String> {
        self.requests().get(n).and_then(|r| r.system_prompt.clone())
    }

    /// 第 n 次请求的 session_id（S5 契约测钉断言用：build_request 注入
    /// 真实会话 ID，请求快照逐一对齐 [ProviderRequest] 字段）
    pub fn request_session_id(&self, n: usize) -> Option<String> {
        self.requests().get(n).and_then(|r| r.session_id.clone())
    }
}

#[async_trait]
impl ProviderCall for TestProvider {
    async fn stream<'a>(
        &self,
        request: &ProviderRequest<'a>,
    ) -> Result<ProviderEventStream, ClassifiedStreamError> {
        let index = {
            let mut count = self.call_count.lock().unwrap();
            let index = *count;
            *count += 1;
            index
        };

        self.requests
            .lock()
            .unwrap()
            .push(RequestSnapshot::from_request(request));

        // 仅首次注入的错误（取后即空，重试阶梯场景）
        if let Some(error) = self.error_once.lock().unwrap().take() {
            return Err(error);
        }

        if let Some(error) = &self.error {
            return Err(error.clone());
        }

        let script = self
            .scripts
            .get(index)
            .unwrap_or_else(|| self.scripts.last().expect("脚本至少一份"))
            .clone();

        let emit_until = self
            .fail_after
            .map(|f| f.min(script.len()))
            .unwrap_or(script.len());

        // 栅栏：产出第 N 个事件前 Sleep（模拟流式停顿，配合 L2/L3 中途落地）
        let pause = self.pause_after_index;

        // 脚本事件逐个产出（契约 v1，PE-02 §3.1.2：逐事件流出，禁止聚合缓冲；
        // 条目均为 Ok，流中错误由其他替身/实现注入——本替身只产出脚本事件）
        let stream = futures::stream::unfold(
            (script, emit_until, pause, 0usize),
            |(script, emit_until, pause, emitted)| async move {
                if emitted >= emit_until {
                    return None;
                }
                if let Some((pause_index, duration)) = pause {
                    if emitted == pause_index {
                        tokio::time::sleep(duration).await;
                    }
                }
                let event = script[emitted].clone();
                Some((Ok(event), (script, emit_until, pause, emitted + 1)))
            },
        );
        Ok(Box::pin(stream))
    }
}

/// Arc 共享形态替身（F2-02 run 级测试用：run 后仍需持有句柄断言调用数）
#[async_trait]
impl ProviderCall for Arc<TestProvider> {
    async fn stream<'a>(
        &self,
        request: &ProviderRequest<'a>,
    ) -> Result<ProviderEventStream, ClassifiedStreamError> {
        self.as_ref().stream(request).await
    }
}

impl TestProvider {
    /// 便捷构造：纯文字回复脚本
    pub fn text_reply(text: &str) -> Self {
        Self::new(vec![
            ProviderStreamEvent::text(text),
            ProviderStreamEvent::stop(StopReason::Stop),
        ])
    }

    /// 便捷构造：空响应脚本（无任何事件）
    pub fn empty_reply() -> Self {
        Self::new(vec![ProviderStreamEvent::stop(StopReason::Stop)])
    }

    /// 便捷构造：文本 + 工具调用脚本
    pub fn text_and_tool(text: &str, tool_name: &str) -> Self {
        Self::new(vec![
            ProviderStreamEvent::text(text),
            ProviderStreamEvent::tool_call(
                Some(format!("call_{tool_name}")),
                tool_name,
                serde_json::json!({}),
            ),
            ProviderStreamEvent::stop(StopReason::Stop),
        ])
    }
}

/// 请求快照（owned 形态，跨生命周期稳定存储）
///
/// 冻结签名下 [ProviderRequest] 携带借用期 `'a`（消息借用），替身无法在
/// `'static` 容器中长期保存借用值，故记录时转为 owned 快照；字段与
/// [ProviderRequest] 逐一对齐，断言访问形态不变。
///
/// PE-09 T09.3.2：消息以 `Vec<Arc<AgentMessage>>` 保存——快照记录为
/// 便宜 Arc 克隆，请求链 0 深拷贝的判定（[TestProvider::request_message_arcs]
/// 与收口对话逐条 `Arc::ptr_eq`）成立。
#[derive(Debug, Clone, Default)]
pub struct RequestSnapshot {
    /// 当前完整对话（用户 + 助手 + 工具结果 + steering 注入消息）
    pub messages: Vec<Arc<AgentMessage>>,
    /// 可用工具定义（注册表按注册序导出）
    pub tools: Vec<ToolSchema>,
    /// 本次调用 max_tokens（length 阶梯升级后透传）
    pub max_tokens: Option<u32>,
    /// 本次调用 system prompt（M1：注入通道断言用；system 角色面，
    /// 独立于会话对话）
    pub system_prompt: Option<String>,
    /// 本次调用 session_id（S5 接线后断言：build_request 注入真实值，
    /// 缓存键会话维度来源）
    pub session_id: Option<String>,
}

impl RequestSnapshot {
    /// 从借用形态的请求构建 owned 快照（Arc 克隆，0 深拷贝）
    fn from_request(request: &ProviderRequest<'_>) -> Self {
        Self {
            messages: request.messages.to_vec(),
            tools: request.tools.clone(),
            max_tokens: request.max_tokens,
            system_prompt: request.system_prompt.map(str::to_string),
            session_id: request.session_id.clone(),
        }
    }
}

/// 脚本化测试工具（05 §4.3 createMockTool 蓝本）
///
/// - 固定成功输出 / 固定抛错；
/// - `hook` 记录每次调用入参（executeHook 语义，供断言）。
#[derive(Debug)]
pub struct TestTool {
    /// 工具名
    name: String,
    /// 固定成功输出（execute 返回）
    output: serde_json::Value,
    /// 固定抛错（execute 返回 Err）
    error: Option<String>,
    /// 调用入参记录
    calls: Arc<Mutex<Vec<serde_json::Value>>>,
    /// 工具定义
    definition: ToolDefinition,
}

impl TestTool {
    /// 新建（固定成功输出）
    pub fn new(name: &str, output: serde_json::Value) -> Self {
        Self {
            name: name.to_string(),
            output,
            error: None,
            calls: Arc::new(Mutex::new(Vec::new())),
            definition: ToolDefinition {
                name: name.to_string(),
                description: format!("test tool {name}"),
                input_schema: serde_json::json!({"type": "object"}),
                dangerous: false,
                fatal_on_error: false,
            },
        }
    }

    /// 新建（固定抛错）
    pub fn with_error(name: &str, error: &str) -> Self {
        Self {
            name: name.to_string(),
            output: serde_json::Value::Null,
            error: Some(error.to_string()),
            calls: Arc::new(Mutex::new(Vec::new())),
            definition: ToolDefinition {
                name: name.to_string(),
                description: format!("test tool {name}"),
                input_schema: serde_json::json!({"type": "object"}),
                dangerous: false,
                fatal_on_error: false,
            },
        }
    }

    /// 标记 fatalOnError（工具定义级：出错即致命，run 以 error 收场）
    pub fn with_fatal_on_error(mut self) -> Self {
        self.definition.fatal_on_error = true;
        self
    }

    /// 调用入参记录快照
    pub fn calls(&self) -> Vec<serde_json::Value> {
        self.calls.lock().unwrap().clone()
    }

    /// 调用次数
    pub fn call_count(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

#[async_trait]
impl Tool for TestTool {
    fn name(&self) -> &str {
        &self.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.definition
    }

    async fn execute(
        &self,
        _ctx: &agent_tools::context::ToolContext,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, ToolError> {
        self.calls.lock().unwrap().push(args);
        if let Some(error) = &self.error {
            Err(ToolError::execution_failed(&self.name, error))
        } else {
            Ok(self.output.clone())
        }
    }
}
