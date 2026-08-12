//! 工具族实现：守卫链接线 + 13 个 computer_* 工具真实执行路径（06 文档 §4.2）。
//!
//! ## 执行守卫链（顺序即优先级；06 文档 §4.2）
//!
//! ```text
//! computer_* 工具 execute：
//! ① 会话注入检查   session 未注入            → tool.computer.not_ready
//! ② 互斥守卫       activation.current() 非
//!                   DesktopActive            → tool.session.exclusive   ← 硬约束，审批前
//! ③ 开启态复查     check_action_allowed()
//!                   未开启/已挂起/急停后      → tool.computer.not_enabled（零副作用）
//! ④ 急停自查       stop.stopped()            → tool.computer.cancelled
//! ⑤ 逐次审批       approval.require_approval(载荷) → Pending
//!                   → 引擎经 ctx.ask 送用户   → settle 收口
//!                   拒绝/急停中/并发请求      → Denied（零注入；approval.rejected）
//! ⑥ 执行           参数校验(→invalid_params) → 坐标换算(→coords_out_of_bounds，
//!                   会话内 dispatch) → ActionTargetGate 门禁(提权→
//!                   elevated_window，RealComputerSession 内) →
//!                   ComputerOps.dispatch / screenshot / snapshot
//!                   注入批次间自查 stop/abort_token → tool.computer.cancelled
//! ```
//!
//! - 守卫②在审批之前（04 §4.6 / 18 §6.3：互斥是硬约束，不占审批资源）；
//! - 守卫③在审批之前（security.rs:216 `check_action_allowed` 注释登记；
//!   挂载是注册时刻快照，运行期挂起/急停后回 Idle 由本守卫兜底拒绝）；
//! - 审批载荷 = `ApprovalRequest`（动作名 + 参数摘要 + 目标窗口标题 + 物理
//!   坐标）；`approval` 未注入（None）时按 Denied 收口（安全默认，不静默
//!   放行——06 遗留⑤）；`ctx.ask` 未接线同样按 Denied 收口；
//! - 审批等待期取消：等待期间 `stop.stopped()` / `ctx.abort_token.is_aborted()`
//!   以 Denied（原因「急停/取消」）收口，拒绝时零注入；
//! - `computer_estop` 自身不被急停打断（跳过守卫④）：触发
//!   `EmergencyStop::global_stop()` + `ctx.abort_token.abort()`（同一吊销链，
//!   来源 Global，04 §4.3 ①）+ 会话开启态关闭（恢复需用户重新显式开启）；
//! - 动作前检查器（06 遗留⑥）挂在 [`crate::session::RealComputerSession`]
//!   dispatch 内（05 文档 §5.2：白名单/提权 → elevated_window），工具层
//!   经 [`crate::error::map_session_error`] 映射 `SessionError::Gate`。

use crate::error;
use crate::session::ComputerOps;
use agent_tools::context::{AskDecision, ToolContext};
use agent_tools::definition::{Tool, ToolDefinition, ToolError};
use agent_tools::registry::ToolRegistry;
use async_trait::async_trait;
use base64::Engine;
use conex_computer::action::{ClickCount, MouseButton, ScrollDirection};
use conex_computer::coord::Point;
use conex_computer::perception::{PerceptionNode, PerceptionSnapshot};
use conex_computer::security::{
    Approval, ApprovalGate, ApprovalRequest, EmergencyStop, SessionEnablement,
};
use conex_computer::{Action, ActionResult};
use conex_computer::activation::ActivationGate;
use serde_json::{json, Value};
use std::io::Cursor;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// 工具类别（13 个，06 文档 §2 裁决：注入 8 / 感知 4 / 急停 1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolKind {
    // 注入 8（全 dangerous=true，Ask 审批）
    Click,
    Type,
    Key,
    HoldKey,
    Move,
    Button,
    Drag,
    Scroll,
    // 感知 4（全 dangerous=true，默认审批）
    Wait,
    Screenshot,
    CursorPosition,
    Snapshot,
    // 急停 1（自身不被急停打断）
    Estop,
}

/// 守卫共享上下文（注册时从 [crate::ComputerToolsConfig] 装配注入各工具）。
pub(crate) struct GuardCtx {
    /// 会话注入面（未注入 = 守卫① not_ready）
    pub session: Option<Arc<dyn ComputerOps>>,
    /// 会话互斥守卫（S3；守卫②，审批前）
    pub activation: Option<Arc<ActivationGate>>,
    /// 会话级显式开启判据（守卫③，审批前）
    pub enablement: Option<Arc<SessionEnablement>>,
    /// 全动作审批门（守卫⑤）
    pub approval: Option<Arc<ApprovalGate>>,
    /// 三级急停旗（守卫④ + 批次间自查）
    pub stop: Option<Arc<EmergencyStop>>,
}

/// 电脑操作工具（定义 + 类别 + 守卫上下文；execute 走统一守卫链）。
pub(crate) struct ComputerTool {
    def: ToolDefinition,
    kind: ToolKind,
    ctx: Arc<GuardCtx>,
}

impl ComputerTool {
    /// 构造工具（全量 dangerous=true，06 文档 §2 裁决）
    pub(crate) fn new(
        name: &'static str,
        description: &'static str,
        input_schema: Value,
        kind: ToolKind,
        ctx: Arc<GuardCtx>,
    ) -> Self {
        Self {
            def: ToolDefinition {
                name: name.to_string(),
                description: description.to_string(),
                input_schema,
                dangerous: true,
                fatal_on_error: false,
            },
            kind,
            ctx,
        }
    }

    /// 急停/中止令牌自查（守卫④ 与批次间自查共用判据）
    fn stopped(&self, tctx: &ToolContext) -> bool {
        self.ctx.stop.as_ref().is_some_and(|s| s.stopped()) || tctx.abort_token.is_aborted()
    }

    /// 注入批次间自查（守卫⑥ 末段：dispatch 返回后急停旗/中止令牌已置位
    /// → `tool.computer.cancelled`，模型可见执行已中止）
    fn check_in_flight(&self, tctx: &ToolContext) -> Result<(), ToolError> {
        if self.stopped(tctx) {
            Err(error::cancelled())
        } else {
            Ok(())
        }
    }

    /// 守卫⑤ 逐次审批（Ask 逐次审批语义：一次一票；approval 未注入 /
    /// ctx.ask 未接线均按 Denied 收口，不静默放行）。
    async fn approve(&self, tctx: &ToolContext, args: &Value) -> Result<(), ToolError> {
        let Some(gate) = &self.ctx.approval else {
            return Err(error::approval_rejected(
                "审批门未注入（安全默认：拒绝放行，06 遗留⑤）",
            ));
        };
        let request = approval_request(&self.def.name, args);
        // 载荷序列化提前（ApprovalRequest 非 Clone；Value 为 owned 拷贝）
        let payload = approval_payload(&request);
        match gate.require_approval(request) {
            Approval::Granted => Ok(()),
            Approval::Denied { reason } => Err(error::approval_rejected(reason)),
            Approval::Pending { id } => {
                // 审批传输面（agent-tools ctx.ask / AskChannel）：未接线 →
                // 按 Denied 收口（settle 清在途，零注入）
                let Some(ask) = &tctx.ask else {
                    let _ = gate.settle(
                        id,
                        Approval::Denied {
                            reason: "审批传输面未接线（ctx.ask），按拒绝收口".into(),
                        },
                    );
                    return Err(error::approval_rejected(
                        "审批传输面未接线（ctx.ask），按拒绝收口",
                    ));
                };
                let decision = ask.ask(&self.def.name, &payload).await.map_err(|e| {
                    let _ = gate.settle(
                        id,
                        Approval::Denied {
                            reason: format!("审批传输失败：{e}"),
                        },
                    );
                    error::approval_rejected(format!("审批传输失败：{e}"))
                })?;
                // 审批等待期取消：急停/中止令牌 → 以 Denied 收口（零注入，
                // security.rs:305-314 注释登记；estop 自身不被急停打断，豁免）
                if self.stopped(tctx) && !matches!(self.kind, ToolKind::Estop) {
                    let _ = gate.settle(
                        id,
                        Approval::Denied {
                            reason: "急停/取消（审批等待期）".into(),
                        },
                    );
                    return Err(error::cancelled());
                }
                let verdict = match decision {
                    AskDecision::Allowed => Approval::Granted,
                    AskDecision::Denied { reason } => Approval::Denied { reason },
                };
                match gate.settle(id, verdict) {
                    Ok(Approval::Granted) => Ok(()),
                    Ok(Approval::Denied { reason }) => Err(error::approval_rejected(reason)),
                    // 竞态（急停中 settle 放行被拒 / 已结算）→ 拒绝收口
                    Ok(_) => Err(error::approval_rejected("审批收口异常，按拒绝处理")),
                    Err(e) => Err(error::approval_rejected(format!("审批收口失败：{e}"))),
                }
            }
        }
    }

    /// 守卫⑥ 执行（参数校验 → 会话派发 → 批次间自查；感知/急停分支）
    async fn execute_kind(
        &self,
        tctx: &ToolContext,
        session: &dyn ComputerOps,
        args: &Value,
    ) -> Result<Value, ToolError> {
        let name = self.def.name.as_str();
        match self.kind {
            // ── 注入 8 ──
            ToolKind::Click => {
                let action = parse_click(args)?;
                session
                    .dispatch(&action)
                    .await
                    .map_err(|e| error::map_session_error(name, e))?;
                self.check_in_flight(tctx)?;
                Ok(json!({
                    "ok": true,
                    "perceptionVersion": session.perception_version()
                }))
            }
            ToolKind::Type => {
                let text = parse_type_text(args)?;
                session
                    .dispatch(&Action::Type { text: text.clone() })
                    .await
                    .map_err(|e| error::map_session_error(name, e))?;
                self.check_in_flight(tctx)?;
                Ok(json!({
                    "ok": true,
                    "typedChars": text.chars().count(),
                    "perceptionVersion": session.perception_version()
                }))
            }
            ToolKind::Key => {
                let keys = parse_keys(args)?;
                session
                    .dispatch(&Action::Key { keys })
                    .await
                    .map_err(|e| error::map_session_error(name, e))?;
                self.check_in_flight(tctx)?;
                Ok(json!({
                    "ok": true,
                    "perceptionVersion": session.perception_version()
                }))
            }
            ToolKind::HoldKey => {
                let key = parse_hold_key_name(args)?;
                let duration_secs = parse_hold_key_duration(args)?;
                session
                    .dispatch(&Action::HoldKey {
                        key,
                        duration_secs,
                    })
                    .await
                    .map_err(|e| error::map_session_error(name, e))?;
                self.check_in_flight(tctx)?;
                Ok(json!({ "ok": true, "durationSecs": duration_secs }))
            }
            ToolKind::Move => {
                let coordinate = required_point(args, "coordinate")?;
                session
                    .dispatch(&Action::MouseMove { coordinate })
                    .await
                    .map_err(|e| error::map_session_error(name, e))?;
                self.check_in_flight(tctx)?;
                Ok(json!({
                    "ok": true,
                    "perceptionVersion": session.perception_version()
                }))
            }
            ToolKind::Button => {
                let (button, down) = parse_button_down(args)?;
                let action = if down {
                    Action::MouseDown { button }
                } else {
                    Action::MouseUp { button }
                };
                session
                    .dispatch(&action)
                    .await
                    .map_err(|e| error::map_session_error(name, e))?;
                self.check_in_flight(tctx)?;
                Ok(json!({
                    "ok": true,
                    "perceptionVersion": session.perception_version()
                }))
            }
            ToolKind::Drag => {
                let (start_coordinate, coordinate) = parse_drag(args)?;
                session
                    .dispatch(&Action::Drag {
                        start_coordinate,
                        coordinate,
                    })
                    .await
                    .map_err(|e| error::map_session_error(name, e))?;
                self.check_in_flight(tctx)?;
                Ok(json!({
                    "ok": true,
                    "perceptionVersion": session.perception_version()
                }))
            }
            ToolKind::Scroll => {
                let (direction, amount, coordinate, modifiers) = parse_scroll(args)?;
                session
                    .dispatch(&Action::Scroll {
                        direction,
                        amount,
                        coordinate,
                        modifiers,
                    })
                    .await
                    .map_err(|e| error::map_session_error(name, e))?;
                self.check_in_flight(tctx)?;
                Ok(json!({
                    "ok": true,
                    "perceptionVersion": session.perception_version()
                }))
            }
            // ── 感知 4（不注入输入，无批次间自查）──
            ToolKind::Wait => {
                let duration = parse_wait_duration(args)?;
                let with_screenshot = parse_wait_screenshot(args)?;
                let started = Instant::now();
                tokio::time::sleep(Duration::from_secs_f64(duration)).await;
                let elapsed_secs = started.elapsed().as_secs_f64();
                let screenshot = if with_screenshot {
                    screenshot_payload(session, name, "png", 90, None).await?
                } else {
                    Value::Null
                };
                Ok(json!({ "elapsedSecs": elapsed_secs, "screenshot": screenshot }))
            }
            ToolKind::Screenshot => {
                let (format, quality, region) = parse_screenshot_args(args)?;
                screenshot_payload(session, name, &format, quality, region).await
            }
            ToolKind::CursorPosition => {
                let result = session
                    .dispatch(&Action::CursorPosition)
                    .await
                    .map_err(|e| error::map_session_error(name, e))?;
                let ActionResult::CursorPosition(p) = result else {
                    return Err(ToolError::execution_failed(
                        name,
                        "光标位置查询未返回坐标（会话返回异常）",
                    ));
                };
                Ok(json!({
                    "x": p.x,
                    "y": p.y,
                    "displayNumber": session.display_count(),
                    "perceptionVersion": session.perception_version()
                }))
            }
            ToolKind::Snapshot => {
                let (max_depth, max_elements) = parse_snapshot_args(args)?;
                let snap = session
                    .snapshot()
                    .await
                    .map_err(|e| error::map_perception_error(name, e))?;
                let snap = apply_budget(snap, max_depth, max_elements);
                Ok(json!({
                    "tree": snap.root,
                    "nodeCount": snap.node_count,
                    "truncated": snap.truncated,
                    "perceptionVersion": session.perception_version()
                }))
            }
            // ── 急停 1（触发全局急停链；自身不被急停打断，已完成即返回）──
            ToolKind::Estop => {
                let reason = parse_estop_reason(args)?
                    .unwrap_or_else(|| "（未提供原因）".to_string());
                // 04 §4.3 ①：AI 主动急停并入全局急停链（来源 Global，无新增 StopSource）
                if let Some(stop) = &self.ctx.stop {
                    stop.global_stop();
                }
                // 同一吊销链：引擎侧 abort_token 吊销（context.rs:44，幂等）
                tctx.abort_token.abort();
                // 恢复需用户重新显式开启（04 §4.4）：关闭会话开启态兜底
                if let Some(enablement) = &self.ctx.enablement {
                    enablement.disable(format!("AI 主动急停：{reason}"));
                }
                Ok(json!({ "ok": true, "stopped": true }))
            }
        }
    }
}

#[async_trait]
impl Tool for ComputerTool {
    fn name(&self) -> &str {
        &self.def.name
    }

    fn definition(&self) -> &ToolDefinition {
        &self.def
    }

    async fn execute(&self, tctx: &ToolContext, args: Value) -> Result<Value, ToolError> {
        // ① 会话注入检查（未注入 → tool.computer.not_ready，对齐 R-9 gating）
        let session = self.ctx.session.as_ref().ok_or_else(|| {
            error::not_ready("电脑操作会话未注入（ComputerToolsConfig.session）")
        })?;
        // ② 互斥守卫（S3 ActivationGate；审批前，两向生效）
        if let Some(activation) = &self.ctx.activation {
            if !activation.current().is_desktop() {
                return Err(error::exclusive(format!(
                    "当前会话模式：{}",
                    activation.current()
                )));
            }
        }
        // ③ 开启态复查（审批前；挂载是注册时刻快照，运行期挂起/急停后回
        //    Idle 由本守卫兜底拒绝，零副作用）
        if let Some(enablement) = &self.ctx.enablement {
            if let Err(e) = enablement.check_action_allowed() {
                return Err(error::not_enabled(e.to_string()));
            }
        }
        // ④ 急停自查（estop 自身不被急停打断，跳过）
        if !matches!(self.kind, ToolKind::Estop) && self.stopped(tctx) {
            return Err(error::cancelled());
        }
        // ⑤ 逐次审批
        self.approve(tctx, &args).await?;
        // ⑥ 执行
        self.execute_kind(tctx, session.as_ref(), &args).await
    }
}

// ===== 参数解析（守卫⑥ 第 1 步；全部失败返回 tool.computer.invalid_params） =====

/// 未知参数拒绝（schema additionalProperties=false 的工具层兜底）。
fn reject_unknown(args: &Value, allowed: &[&str]) -> Result<(), ToolError> {
    if let Some(obj) = args.as_object() {
        for key in obj.keys() {
            if !allowed.contains(&key.as_str()) {
                return Err(error::invalid_params(format!("未知参数：{key}")));
            }
        }
    }
    Ok(())
}

fn optional_string(args: &Value, key: &str) -> Result<Option<String>, ToolError> {
    match args.get(key) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(error::invalid_params(format!("{key} 必须是字符串"))),
    }
}

fn required_string(args: &Value, key: &str) -> Result<String, ToolError> {
    optional_string(args, key)?
        .ok_or_else(|| error::invalid_params(format!("缺少必填参数：{key}")))
}

fn optional_bool(args: &Value, key: &str) -> Result<Option<bool>, ToolError> {
    match args.get(key) {
        None => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(error::invalid_params(format!("{key} 必须是布尔值"))),
    }
}

fn optional_f64(args: &Value, key: &str) -> Result<Option<f64>, ToolError> {
    match args.get(key) {
        None => Ok(None),
        Some(v) => v
            .as_f64()
            .map(Some)
            .ok_or_else(|| error::invalid_params(format!("{key} 必须是数字"))),
    }
}

fn optional_u64(args: &Value, key: &str) -> Result<Option<u64>, ToolError> {
    match args.get(key) {
        None => Ok(None),
        Some(v) => v
            .as_u64()
            .map(Some)
            .ok_or_else(|| error::invalid_params(format!("{key} 必须是非负整数"))),
    }
}

fn optional_string_array(args: &Value, key: &str) -> Result<Option<Vec<String>>, ToolError> {
    match args.get(key) {
        None => Ok(None),
        Some(Value::Array(items)) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                match item {
                    Value::String(s) => out.push(s.clone()),
                    _ => {
                        return Err(error::invalid_params(format!(
                            "{key} 的元素必须是字符串"
                        )))
                    }
                }
            }
            Ok(Some(out))
        }
        Some(_) => Err(error::invalid_params(format!(
            "{key} 必须是字符串数组"
        ))),
    }
}

/// 坐标点解析（[x,y] 二元组 → Point；类型/长度错误 → invalid_params。
/// 负值与边界越界由会话内 `Action::validate`（coords_out_of_bounds）承担）。
fn parse_point(v: &Value, what: &str) -> Result<Point, ToolError> {
    let arr = v.as_array().ok_or_else(|| {
        error::invalid_params(format!("{what} 必须是 [x,y] 整数二元组"))
    })?;
    if arr.len() != 2 {
        return Err(error::invalid_params(format!(
            "{what} 必须是 [x,y] 整数二元组（长度 2）"
        )));
    }
    let mut coords = [0i32; 2];
    for (i, item) in arr.iter().enumerate() {
        let raw = item.as_i64().ok_or_else(|| {
            error::invalid_params(format!("{what}[{i}] 必须是整数"))
        })?;
        coords[i] = i32::try_from(raw).map_err(|_| {
            error::invalid_params(format!("{what}[{i}] 超出 i32 坐标范围"))
        })?;
    }
    Ok(Point::new(coords[0], coords[1]))
}

fn optional_point(args: &Value, key: &str) -> Result<Option<Point>, ToolError> {
    match args.get(key) {
        None => Ok(None),
        Some(v) => parse_point(v, key).map(Some),
    }
}

fn required_point(args: &Value, key: &str) -> Result<Point, ToolError> {
    args.get(key)
        .ok_or_else(|| error::invalid_params(format!("缺少必填参数：{key}")))
        .and_then(|v| parse_point(v, key))
}

fn parse_button(args: &Value) -> Result<MouseButton, ToolError> {
    let name = optional_string(args, "button")?.unwrap_or_else(|| "left".to_string());
    match name.as_str() {
        "left" => Ok(MouseButton::Left),
        "right" => Ok(MouseButton::Right),
        "middle" => Ok(MouseButton::Middle),
        other => Err(error::invalid_params(format!(
            "button 仅支持 left/right/middle，收到 {other}"
        ))),
    }
}

fn parse_click_count(args: &Value) -> Result<ClickCount, ToolError> {
    let name = optional_string(args, "count")?.unwrap_or_else(|| "single".to_string());
    match name.as_str() {
        "single" => Ok(ClickCount::Single),
        "double" => Ok(ClickCount::Double),
        "triple" => Ok(ClickCount::Triple),
        other => Err(error::invalid_params(format!(
            "count 仅支持 single/double/triple，收到 {other}"
        ))),
    }
}

fn parse_modifiers(args: &Value) -> Result<Vec<String>, ToolError> {
    let modifiers = optional_string_array(args, "modifiers")?.unwrap_or_default();
    for m in &modifiers {
        if !conex_computer::action::is_modifier_name(m) {
            return Err(error::invalid_params(format!(
                "modifiers 仅支持 ctrl/alt/shift/win，收到 {m}"
            )));
        }
    }
    Ok(modifiers)
}

fn parse_click(args: &Value) -> Result<Action, ToolError> {
    reject_unknown(args, &["button", "count", "coordinate", "modifiers"])?;
    let button = parse_button(args)?;
    let count = parse_click_count(args)?;
    let coordinate = optional_point(args, "coordinate")?;
    let modifiers = parse_modifiers(args)?;
    Ok(Action::Click {
        button,
        count,
        coordinate,
        modifiers,
    })
}

fn parse_type_text(args: &Value) -> Result<String, ToolError> {
    reject_unknown(args, &["text"])?;
    let text = required_string(args, "text")?;
    if text.is_empty() {
        return Err(error::invalid_params("text 不能为空"));
    }
    if text.chars().count() > conex_computer::action::MAX_TYPE_CHARS {
        return Err(error::invalid_params(format!(
            "text 超长（>{} 字符）",
            conex_computer::action::MAX_TYPE_CHARS
        )));
    }
    Ok(text)
}

fn parse_keys(args: &Value) -> Result<Vec<String>, ToolError> {
    reject_unknown(args, &["keys"])?;
    let keys = optional_string_array(args, "keys")?
        .ok_or_else(|| error::invalid_params("缺少必填参数：keys"))?;
    if keys.is_empty() {
        return Err(error::invalid_params("keys 不能为空"));
    }
    if keys.len() > conex_computer::action::MAX_KEYS_IN_COMBO {
        return Err(error::invalid_params(format!(
            "keys 数量超过上限（{}）",
            conex_computer::action::MAX_KEYS_IN_COMBO
        )));
    }
    let mut plain_keys = 0;
    for key in &keys {
        if !conex_computer::action::is_valid_key_name(key) {
            return Err(error::invalid_params(format!("未知键名：{key}")));
        }
        if !conex_computer::action::is_modifier_name(key) {
            plain_keys += 1;
        }
    }
    if plain_keys > 1 {
        return Err(error::invalid_params("keys 只允许一个非修饰键"));
    }
    Ok(keys)
}

fn parse_hold_key_name(args: &Value) -> Result<String, ToolError> {
    reject_unknown(args, &["key", "duration"])?;
    let key = required_string(args, "key")?;
    if !conex_computer::action::is_valid_key_name(&key) {
        return Err(error::invalid_params(format!("未知键名：{key}")));
    }
    Ok(key)
}

fn parse_hold_key_duration(args: &Value) -> Result<f32, ToolError> {
    let duration = optional_f64(args, "duration")?
        .ok_or_else(|| error::invalid_params("缺少必填参数：duration"))?;
    if !(0.0 < duration && duration <= conex_computer::action::HOLD_KEY_MAX_SECS as f64) {
        return Err(error::invalid_params(format!(
            "duration 必须满足 0 < d ≤ {}，收到 {duration}",
            conex_computer::action::HOLD_KEY_MAX_SECS
        )));
    }
    Ok(duration as f32)
}

fn parse_button_down(args: &Value) -> Result<(MouseButton, bool), ToolError> {
    reject_unknown(args, &["button", "down"])?;
    let button = parse_button(args)?;
    let down = optional_bool(args, "down")?
        .ok_or_else(|| error::invalid_params("缺少必填参数：down"))?;
    Ok((button, down))
}

fn parse_drag(args: &Value) -> Result<(Point, Point), ToolError> {
    reject_unknown(args, &["start_coordinate", "coordinate"])?;
    let start_coordinate = required_point(args, "start_coordinate")?;
    let coordinate = required_point(args, "coordinate")?;
    Ok((start_coordinate, coordinate))
}

fn parse_scroll(
    args: &Value,
) -> Result<(ScrollDirection, u32, Option<Point>, Vec<String>), ToolError> {
    reject_unknown(args, &["direction", "amount", "coordinate", "modifiers"])?;
    let direction = optional_string(args, "direction")?
        .ok_or_else(|| error::invalid_params("缺少必填参数：direction"))?;
    let direction = match direction.as_str() {
        "up" => ScrollDirection::Up,
        "down" => ScrollDirection::Down,
        "left" => ScrollDirection::Left,
        "right" => ScrollDirection::Right,
        other => {
            return Err(error::invalid_params(format!(
                "direction 仅支持 up/down/left/right，收到 {other}"
            )))
        }
    };
    let amount_raw = optional_u64(args, "amount")?
        .ok_or_else(|| error::invalid_params("缺少必填参数：amount"))?;
    let amount = u32::try_from(amount_raw).map_err(|_| {
        error::invalid_params(format!("amount 超出 u32 范围：{amount_raw}"))
    })?;
    let coordinate = optional_point(args, "coordinate")?;
    let modifiers = parse_modifiers(args)?;
    Ok((direction, amount, coordinate, modifiers))
}

fn parse_wait_duration(args: &Value) -> Result<f64, ToolError> {
    let duration = optional_f64(args, "duration")?
        .ok_or_else(|| error::invalid_params("缺少必填参数：duration"))?;
    if !(0.0 < duration && duration <= 100.0) {
        return Err(error::invalid_params(format!(
            "duration 必须满足 0 < d ≤ 100，收到 {duration}"
        )));
    }
    Ok(duration)
}

fn parse_wait_screenshot(args: &Value) -> Result<bool, ToolError> {
    reject_unknown(args, &["duration", "screenshot"])?;
    Ok(optional_bool(args, "screenshot")?.unwrap_or(false))
}

fn parse_screenshot_args(args: &Value) -> Result<(String, u8, Option<[i32; 4]>), ToolError> {
    reject_unknown(args, &["format", "quality", "region"])?;
    let format = optional_string(args, "format")?.unwrap_or_else(|| "png".to_string());
    if !matches!(format.as_str(), "png" | "jpeg") {
        return Err(error::invalid_params(format!(
            "format 仅支持 png/jpeg，收到 {format}"
        )));
    }
    let quality = optional_u64(args, "quality")?.unwrap_or(80);
    if !(1..=100).contains(&quality) {
        return Err(error::invalid_params(format!(
            "quality 必须在 1..100，收到 {quality}"
        )));
    }
    let region = match args.get("region") {
        None => None,
        Some(v) => {
            let arr = v.as_array().ok_or_else(|| {
                error::invalid_params("region 必须是 [x0,y0,x1,y1] 整数四元组")
            })?;
            if arr.len() != 4 {
                return Err(error::invalid_params(
                    "region 必须是 [x0,y0,x1,y1] 整数四元组（长度 4）",
                ));
            }
            let mut out = [0i32; 4];
            for (i, item) in arr.iter().enumerate() {
                let raw = item.as_i64().ok_or_else(|| {
                    error::invalid_params(format!("region[{i}] 必须是整数"))
                })?;
                out[i] = i32::try_from(raw).map_err(|_| {
                    error::invalid_params(format!("region[{i}] 超出 i32 范围"))
                })?;
            }
            Some(out)
        }
    };
    Ok((format, quality as u8, region))
}

fn parse_snapshot_args(args: &Value) -> Result<(Option<u64>, Option<u64>), ToolError> {
    reject_unknown(args, &["max_depth", "max_elements"])?;
    let max_depth = optional_u64(args, "max_depth")?;
    let max_elements = optional_u64(args, "max_elements")?;
    if max_depth.is_some_and(|d| d == 0) {
        return Err(error::invalid_params("max_depth 必须 ≥ 1"));
    }
    if max_elements.is_some_and(|n| n == 0) {
        return Err(error::invalid_params("max_elements 必须 ≥ 1"));
    }
    Ok((max_depth, max_elements))
}

fn parse_estop_reason(args: &Value) -> Result<Option<String>, ToolError> {
    reject_unknown(args, &["reason"])?;
    optional_string(args, "reason")
}

// ===== 审批载荷（守卫⑤） =====

/// 审批载荷构造：动作名 + 参数摘要（06 §2.2：`type` 载明文，其余摘要化）。
/// 窗口标题 / 物理坐标需会话面（UIA 感知 / 坐标换算），工具层不持有，
/// 当前置 None（遗留登记：引擎 executor 层在守卫⑤前填充）。
fn approval_request(tool_name: &str, args: &Value) -> ApprovalRequest {
    ApprovalRequest::new(tool_name, params_summary(tool_name, args))
}

/// 参数摘要（逐工具字段面；type 明文展示——审计只落 sha256 由引擎侧负责）。
fn params_summary(tool_name: &str, args: &Value) -> String {
    match tool_name {
        "computer_click" => {
            summary_of(args, &["button", "count", "coordinate", "modifiers"])
        }
        "computer_type" => {
            args.get("text")
                .and_then(Value::as_str)
                .map(|t| format!("text={t}"))
                .unwrap_or_default()
        }
        "computer_key" => summary_of(args, &["keys"]),
        "computer_hold_key" => summary_of(args, &["key", "duration"]),
        "computer_move" => summary_of(args, &["coordinate"]),
        "computer_button" => summary_of(args, &["button", "down"]),
        "computer_drag" => summary_of(args, &["start_coordinate", "coordinate"]),
        "computer_scroll" => {
            summary_of(args, &["direction", "amount", "coordinate", "modifiers"])
        }
        "computer_wait" => summary_of(args, &["duration", "screenshot"]),
        "computer_screenshot" => summary_of(args, &["format", "quality", "region"]),
        "computer_cursor_position" => "cursor_position".to_string(),
        "computer_snapshot" => summary_of(args, &["max_depth", "max_elements"]),
        "computer_estop" => summary_of(args, &["reason"]),
        other => format!("{other}: {args}"),
    }
}

/// 指定字段 → 摘要串（`field=value` 空格拼接；数组展开为逗号串）。
fn summary_of(args: &Value, fields: &[&str]) -> String {
    fields
        .iter()
        .filter_map(|f| {
            args.get(f)
                .map(|v| format!("{f}={}", summarize_value(v)))
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn summarize_value(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(items) => {
            let inner = items
                .iter()
                .map(summarize_value)
                .collect::<Vec<_>>()
                .join(",");
            format!("[{inner}]")
        }
        other => other.to_string(),
    }
}

/// 审批载荷序列化（ctx.ask / AskChannel 传输面；ApprovalRequest 展开为
/// 工具名 + 参数 JSON——06 遗留⑤ 映射面）。
fn approval_payload(request: &ApprovalRequest) -> Value {
    json!({
        "action": request.action,
        "paramsSummary": request.params_summary,
        "windowTitle": request.window_title,
        "position": request.position.map(|p| json!({ "x": p.x, "y": p.y })),
    })
}

// ===== 感知后处理（06 遗留⑧ zoom region 裁剪 + format 转换；纯函数可单测） =====

/// 截图后处理纯函数：
/// 1. 解码 PNG 合成帧；
/// 2. region 裁剪（API 空间 [x0,y0,x1,y1]；越界 → `tool.computer.coords_out_of_bounds`，
///    zoom 并入语义 06 §2.1）；
/// 3. 按 format 重编码：png 原样输出 / jpeg 按 quality（1..100）压缩。
fn postprocess_frame(
    data: &[u8],
    format: &str,
    quality: u8,
    region: Option<[i32; 4]>,
) -> Result<Vec<u8>, ToolError> {
    let img = image::load_from_memory(data).map_err(|e| {
        ToolError::execution_failed("computer_screenshot", format!("截图解码失败：{e}"))
    })?;
    let img = match region {
        Some([x0, y0, x1, y1]) => {
            let (w, h) = (img.width() as i64, img.height() as i64);
            let (x0, y0, x1, y1) = (x0 as i64, y0 as i64, x1 as i64, y1 as i64);
            if x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0 || x1 > w || y1 > h {
                return Err(error::coords_out_of_bounds(format!(
                    "region 越界：[{x0},{y0},{x1},{y1}] 超出合成帧 {w}x{h}（API 空间）"
                )));
            }
            img.crop_imm(x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32)
        }
        None => img,
    };
    let mut buf = Cursor::new(Vec::new());
    if format == "jpeg" {
        let rgb = img.to_rgb8();
        let mut encoder =
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
        encoder
            .encode(
                &rgb,
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|e| {
                ToolError::execution_failed("computer_screenshot", format!("JPEG 编码失败：{e}"))
            })?;
    } else {
        img.write_to(&mut buf, image::ImageFormat::Png).map_err(|e| {
            ToolError::execution_failed("computer_screenshot", format!("PNG 编码失败：{e}"))
        })?;
    }
    Ok(buf.into_inner())
}

/// 截图工具载荷（screenshot / wait+screenshot 共用；base64 编码 +
/// 显示环境字段）。
async fn screenshot_payload(
    session: &dyn ComputerOps,
    name: &str,
    format: &str,
    quality: u8,
    region: Option<[i32; 4]>,
) -> Result<Value, ToolError> {
    let frame = session
        .screenshot()
        .await
        .map_err(|e| error::map_session_error(name, e))?;
    let data = postprocess_frame(&frame.data, format, quality, region)?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&data);
    Ok(json!({
        "image": {
            "mediaType": if format == "jpeg" { "image/jpeg" } else { "image/png" },
            "data": encoded,
        },
        "displayWidthPx": frame.width,
        "displayHeightPx": frame.height,
        "displayNumber": session.display_count(),
        "perceptionVersion": session.perception_version(),
    }))
}

/// 快照树预算（06 §2.2 max_depth / max_elements）：在会话侧固定预算
/// （深度 6 / 节点 2000）之上做请求级二次截断；截断标记并入原快照。
fn apply_budget(
    snap: PerceptionSnapshot,
    max_depth: Option<u64>,
    max_elements: Option<u64>,
) -> PerceptionSnapshot {
    let mut budget = Budget {
        max_depth: max_depth.map(|d| d as usize).unwrap_or(usize::MAX),
        remaining: max_elements.map(|n| n as usize).unwrap_or(usize::MAX),
        truncated: snap.truncated,
        count: 0,
    };
    let root = truncate_node(snap.root, 0, &mut budget);
    PerceptionSnapshot {
        root,
        // nodeCount 联动实际截断后的节点数（快照面与树面一致）
        node_count: budget.count,
        truncated: budget.truncated,
    }
}

/// 遍历预算（请求级：深度/节点数上限 + 截断标记 + 实际节点计数）
struct Budget {
    max_depth: usize,
    remaining: usize,
    truncated: bool,
    count: usize,
}

/// 递归截断节点（深度 0 = 根；max_depth 触顶或节点数触顶 → 截断子节点）
fn truncate_node(node: PerceptionNode, depth: usize, budget: &mut Budget) -> PerceptionNode {
    budget.remaining = budget.remaining.saturating_sub(1);
    budget.count += 1;
    let mut children = Vec::new();
    if depth + 1 < budget.max_depth {
        for child in node.children {
            if budget.remaining == 0 {
                budget.truncated = true;
                break;
            }
            children.push(truncate_node(child, depth + 1, budget));
        }
    } else if !node.children.is_empty() {
        budget.truncated = true;
    }
    PerceptionNode {
        role: node.role,
        name: node.name,
        value: node.value,
        rect: node.rect,
        is_password: node.is_password,
        children,
    }
}

// ===== 注册 =====

/// 13 个工具定义清单（注册序 = 注入 → 感知 → 急停；与
/// [crate::ALL_TOOL_NAMES] 逐一对应，注册数断言测试守护）。
pub(crate) fn definitions(ctx: Arc<GuardCtx>) -> Vec<ComputerTool> {
    vec![
        // ── 注入 8（全 dangerous=true）──
        ComputerTool::new(
            "computer_click",
            "鼠标点击（危险操作，需审批）。button=left/right/middle，count=single/double/triple；带 coordinate 先移动再点击；带 modifiers 按住修饰键点击（如 ctrl+click）。",
            json!({
                "type": "object",
                "properties": {
                    "button": { "type": "string", "enum": ["left", "right", "middle"], "description": "鼠标按键（缺省 left）" },
                    "count": { "type": "string", "enum": ["single", "double", "triple"], "description": "点击次数语义（缺省 single；双击/三击间隔由后端生成）" },
                    "coordinate": { "type": "array", "items": { "type": "integer" }, "minItems": 2, "maxItems": 2, "description": "目标坐标 [x,y]（API 空间，缺省 = 当前光标位置）" },
                    "modifiers": { "type": "array", "items": { "type": "string" }, "description": "按住修饰键（ctrl/alt/shift/win）" }
                },
                "required": [],
                "additionalProperties": false
            }),
            ToolKind::Click,
            ctx.clone(),
        ),
        ComputerTool::new(
            "computer_type",
            "向当前焦点输入文本（危险操作，需审批）。50 字符/块 + 12ms 节流不丢字；中文/emoji 走 Unicode 直送；审批弹窗明文展示 text。",
            json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "待输入文本（非空，≤100000 字符）" }
                },
                "required": ["text"],
                "additionalProperties": false
            }),
            ToolKind::Type,
            ctx.clone(),
        ),
        ComputerTool::new(
            "computer_key",
            "发送组合键（危险操作，需审批）。keys 数组语义（如 [\"ctrl\",\"c\"]），至多一个非修饰键；不做字符串解析。",
            json!({
                "type": "object",
                "properties": {
                    "keys": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 16, "description": "组合键数组（归一化键名，如 [\"ctrl\",\"c\"]）" }
                },
                "required": ["keys"],
                "additionalProperties": false
            }),
            ToolKind::Key,
            ctx.clone(),
        ),
        ComputerTool::new(
            "computer_hold_key",
            "按住指定键 duration 秒后松开（危险操作，需审批）。duration 上限 100s。",
            json!({
                "type": "object",
                "properties": {
                    "key": { "type": "string", "description": "归一化键名（如 a/enter/f1）" },
                    "duration": { "type": "number", "minimum": 0, "exclusiveMinimum": true, "maximum": 100, "description": "按住时长（秒，0 < d ≤ 100）" }
                },
                "required": ["key", "duration"],
                "additionalProperties": false
            }),
            ToolKind::HoldKey,
            ctx.clone(),
        ),
        ComputerTool::new(
            "computer_move",
            "移动光标到指定坐标（危险操作，需审批）。coordinate 为 API 空间 [x,y]，经缩放校验后注入；等待完成再返回（_sync 语义）。",
            json!({
                "type": "object",
                "properties": {
                    "coordinate": { "type": "array", "items": { "type": "integer" }, "minItems": 2, "maxItems": 2, "description": "目标坐标 [x,y]（API 空间）" }
                },
                "required": ["coordinate"],
                "additionalProperties": false
            }),
            ToolKind::Move,
            ctx.clone(),
        ),
        ComputerTool::new(
            "computer_button",
            "按下/抬起分离原语（危险操作，需审批）。作用于当前光标位置；down=true 按下 / false 抬起；供拖拽/选区/画板场景由模型编排。",
            json!({
                "type": "object",
                "properties": {
                    "button": { "type": "string", "enum": ["left", "right", "middle"], "description": "鼠标按键（缺省 left）" },
                    "down": { "type": "boolean", "description": "true = 按下，false = 抬起" }
                },
                "required": ["down"],
                "additionalProperties": false
            }),
            ToolKind::Button,
            ctx.clone(),
        ),
        ComputerTool::new(
            "computer_drag",
            "拖拽（危险操作，需审批）。按下起点 → 分步移动终点 → 抬起；两端点均走缩放校验。",
            json!({
                "type": "object",
                "properties": {
                    "start_coordinate": { "type": "array", "items": { "type": "integer" }, "minItems": 2, "maxItems": 2, "description": "拖拽起点 [x,y]（API 空间）" },
                    "coordinate": { "type": "array", "items": { "type": "integer" }, "minItems": 2, "maxItems": 2, "description": "拖拽终点 [x,y]（API 空间）" }
                },
                "required": ["start_coordinate", "coordinate"],
                "additionalProperties": false
            }),
            ToolKind::Drag,
            ctx.clone(),
        ),
        ComputerTool::new(
            "computer_scroll",
            "滚动（危险操作，需审批；大 amount 默认拒绝型）。direction=up/down/left/right，amount 非负整数；可先移动再滚动、可带修饰键（如 shift+wheel 横向语义由 OS 决定）。",
            json!({
                "type": "object",
                "properties": {
                    "direction": { "type": "string", "enum": ["up", "down", "left", "right"], "description": "滚动方向" },
                    "amount": { "type": "integer", "minimum": 0, "description": "滚动量（非负整数）" },
                    "coordinate": { "type": "array", "items": { "type": "integer" }, "minItems": 2, "maxItems": 2, "description": "可选，先移动到该坐标再滚动" },
                    "modifiers": { "type": "array", "items": { "type": "string" }, "description": "可选，按住修饰键滚动" }
                },
                "required": ["direction", "amount"],
                "additionalProperties": false
            }),
            ToolKind::Scroll,
            ctx.clone(),
        ),
        // ── 感知 4（全 dangerous=true，默认审批）──
        ComputerTool::new(
            "computer_wait",
            "等待并返回（感知类，不注入任何输入）。duration 秒后完成；screenshot=true 时顺带返回截屏。",
            json!({
                "type": "object",
                "properties": {
                    "duration": { "type": "number", "minimum": 0, "exclusiveMinimum": true, "maximum": 100, "description": "等待时长（秒，0 < d ≤ 100）" },
                    "screenshot": { "type": "boolean", "description": "可选，等待后返回截屏（缺省 false）" }
                },
                "required": ["duration"],
                "additionalProperties": false
            }),
            ToolKind::Wait,
            ctx.clone(),
        ),
        ComputerTool::new(
            "computer_screenshot",
            "返回缩放后全桌面截屏（感知类，默认审批）。format=png/jpeg，quality 质量档；region 裁剪局部区域（zoom 语义，越界报错）。",
            json!({
                "type": "object",
                "properties": {
                    "format": { "type": "string", "enum": ["png", "jpeg"], "description": "图像格式（缺省 png；jpeg 为低质量档）" },
                    "quality": { "type": "integer", "minimum": 1, "maximum": 100, "description": "可选，jpeg 质量档（50-75 有效面）" },
                    "region": { "type": "array", "items": { "type": "integer" }, "minItems": 4, "maxItems": 4, "description": "可选，裁剪区域 [x0,y0,x1,y1]（API 空间，zoom 语义）" }
                },
                "required": [],
                "additionalProperties": false
            }),
            ToolKind::Screenshot,
            ctx.clone(),
        ),
        ComputerTool::new(
            "computer_cursor_position",
            "返回当前光标位置（感知类，默认审批；API 空间坐标，经物理→API 换算）。",
            json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
            ToolKind::CursorPosition,
            ctx.clone(),
        ),
        ComputerTool::new(
            "computer_snapshot",
            "返回 UIA 结构化快照（感知类，默认审批）。元素/角色/名称/边界矩形/索引紧凑序列化；密码框文本抑制（<password>）与键名脱敏已内置。",
            json!({
                "type": "object",
                "properties": {
                    "max_depth": { "type": "integer", "minimum": 1, "description": "可选，UIA 树深度上限" },
                    "max_elements": { "type": "integer", "minimum": 1, "description": "可选，UIA 树节点数上限" }
                },
                "required": [],
                "additionalProperties": false
            }),
            ToolKind::Snapshot,
            ctx.clone(),
        ),
        // ── 急停 1（dangerous=true）──
        ComputerTool::new(
            "computer_estop",
            "AI 主动急停（危险操作，需审批）。触发全局急停链：中止在途注入 → 感知源停止 → 会话回 Idle；恢复需用户重新显式开启。",
            json!({
                "type": "object",
                "properties": {
                    "reason": { "type": "string", "description": "可选，急停原因（审计记录）" }
                },
                "required": [],
                "additionalProperties": false
            }),
            ToolKind::Estop,
            ctx.clone(),
        ),
    ]
}

/// 注册全部 13 个 computer_* 工具（幂等：同名已注册跳过，不报冲突；
/// 06 文档 §3.2 幂等语义对齐浏览器线 17 §1.4）。
pub(crate) fn register_all(
    registry: &ToolRegistry,
    ctx: Arc<GuardCtx>,
) -> Result<(), ToolError> {
    for tool in definitions(ctx) {
        if !registry.has(tool.name()) {
            registry.register_runtime(Arc::new(tool))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 参数解析透传：click 参数 → Action::Click（按钮/次数/坐标/修饰键）。
    #[test]
    fn parse_click_maps_fields() {
        let args = json!({
            "button": "right",
            "count": "double",
            "coordinate": [100, 200],
            "modifiers": ["ctrl"]
        });
        let action = parse_click(&args).expect("参数应解析成功");
        match action {
            Action::Click {
                button,
                count,
                coordinate,
                modifiers,
            } => {
                assert_eq!(button, MouseButton::Right);
                assert_eq!(count, ClickCount::Double);
                assert_eq!(coordinate, Some(Point::new(100, 200)));
                assert_eq!(modifiers, vec!["ctrl".to_string()]);
            }
            other => panic!("应解析为 Click：{other:?}"),
        }
    }

    /// 参数校验失败 → tool.computer.invalid_params（未知键名/越界时长）。
    #[test]
    fn parse_hold_key_rejects_bad_key_and_duration() {
        let err = parse_hold_key_name(&json!({ "key": "not-a-key" })).expect_err("未知键名应拒绝");
        assert_eq!(err.code(), crate::codes::TOOL_COMPUTER_INVALID_PARAMS);
        let err = parse_hold_key_duration(&json!({ "duration": 200 })).expect_err("超长应拒绝");
        assert_eq!(err.code(), crate::codes::TOOL_COMPUTER_INVALID_PARAMS);
    }

    /// 审批摘要：type 明文展示（06 §2.2：审批弹窗明文展示 text）。
    #[test]
    fn params_summary_type_shows_plaintext() {
        let summary = params_summary("computer_type", &json!({ "text": "hello 世界" }));
        assert_eq!(summary, "text=hello 世界");
        let summary = params_summary("computer_click", &json!({ "button": "left", "coordinate": [1, 2] }));
        assert_eq!(summary, "button=left coordinate=[1,2]");
        assert_eq!(
            params_summary("computer_cursor_position", &json!({})),
            "cursor_position"
        );
    }

    /// 审批载荷序列化（ctx.ask 传输面形状：action/paramsSummary 必带，
    /// windowTitle/position 可空）。
    #[test]
    fn approval_payload_shape() {
        let request = ApprovalRequest::new("computer_type", "text=hello");
        let payload = approval_payload(&request);
        assert_eq!(payload["action"], "computer_type");
        assert_eq!(payload["paramsSummary"], "text=hello");
        assert!(payload["windowTitle"].is_null());
        assert!(payload["position"].is_null());
    }

    /// 截图后处理：PNG 输入 → PNG 原样输出 + region 裁剪尺寸正确 + 越界拒绝。
    #[test]
    fn postprocess_crops_region_and_rejects_out_of_bounds() {
        // 生成 4x4 PNG 测试帧
        let mut img = image::RgbaImage::new(4, 4);
        for pixel in img.pixels_mut() {
            *pixel = image::Rgba([255, 0, 0, 255]);
        }
        let mut buf = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(img.clone())
            .write_to(&mut buf, image::ImageFormat::Png)
            .expect("PNG 编码成功");
        let png = buf.into_inner();

        // 无 region：原样输出
        let out = postprocess_frame(&png, "png", 80, None).expect("应成功");
        let decoded = image::load_from_memory(&out).expect("输出应可解码");
        assert_eq!((decoded.width(), decoded.height()), (4, 4));

        // region 裁剪：2x2
        let out = postprocess_frame(&png, "png", 80, Some([1, 1, 3, 3])).expect("应成功");
        let decoded = image::load_from_memory(&out).expect("输出应可解码");
        assert_eq!((decoded.width(), decoded.height()), (2, 2));

        // jpeg 转换（quality 参数生效）
        let out = postprocess_frame(&png, "jpeg", 50, None).expect("应成功");
        let decoded = image::load_from_memory(&out).expect("输出应可解码");
        assert_eq!((decoded.width(), decoded.height()), (4, 4));

        // 越界拒绝：x1 超出帧宽 → coords_out_of_bounds
        let err =
            postprocess_frame(&png, "png", 80, Some([0, 0, 5, 4])).expect_err("越界应拒绝");
        assert_eq!(err.code(), crate::codes::TOOL_COMPUTER_COORDS_OUT_OF_BOUNDS);
        // 非法 region（反向区间）同样拒绝
        let err =
            postprocess_frame(&png, "png", 80, Some([2, 0, 1, 4])).expect_err("反向应拒绝");
        assert_eq!(err.code(), crate::codes::TOOL_COMPUTER_COORDS_OUT_OF_BOUNDS);
    }

    /// 快照树预算：max_depth / max_elements 二次截断 + 截断标记并入。
    #[test]
    fn budget_truncates_depth_and_elements() {
        use conex_computer::perception::Rect;
        fn leaf(name: &str) -> PerceptionNode {
            PerceptionNode::new("button", name, "", Rect::new(0, 0, 1, 1), vec![])
        }
        let root = PerceptionNode::new(
            "window",
            "w",
            "",
            Rect::new(0, 0, 10, 10),
            vec![
                leaf("a"),
                PerceptionNode::new(
                    "pane",
                    "p",
                    "",
                    Rect::new(0, 0, 10, 10),
                    vec![leaf("b"), leaf("c")],
                ),
            ],
        );
        let snap = PerceptionSnapshot {
            root,
            node_count: 5,
            truncated: false,
        };

        // max_depth=1：只有根（深度 0），截断标记置位
        let out = apply_budget(snap.clone(), Some(1), None);
        assert!(out.truncated, "深度截断必须标记");
        assert_eq!(out.node_count, 1);
        assert!(out.root.children.is_empty());

        // max_elements=2：根 + 首子，其余截断
        let out = apply_budget(snap.clone(), None, Some(2));
        assert!(out.truncated, "节点数截断必须标记");
        assert_eq!(out.node_count, 2);
        assert_eq!(out.root.children.len(), 1);

        // 预算充足：不新增截断
        let out = apply_budget(snap, Some(10), Some(10));
        assert!(!out.truncated);
        assert_eq!(out.node_count, 5);
        assert_eq!(out.root.children.len(), 2);
    }

    /// 注册数断言（tools 层自检：13 定义 + 幂等跳过）。
    #[test]
    fn register_all_mounts_13_tools_idempotently() {
        let ctx = Arc::new(GuardCtx {
            session: None,
            activation: None,
            enablement: None,
            approval: None,
            stop: None,
        });
        let registry = ToolRegistry::new();
        register_all(&registry, ctx).expect("注册成功");
        assert_eq!(registry.len(), 13);
        assert_eq!(registry.len(), crate::ALL_TOOL_NAMES.len());
        // 幂等：重复注册不冲突
        register_all(&registry, Arc::new(GuardCtx {
            session: None,
            activation: None,
            enablement: None,
            approval: None,
            stop: None,
        }))
        .expect("重复注册应幂等");
        assert_eq!(registry.len(), 13);
    }
}
