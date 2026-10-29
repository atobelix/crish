//! 面板输入路由（P1-B1：browser_input 上行 → P1-A InputPipeline 对接 + 高频节流）
//!
//! ## 传输选型（U-13 主控裁决）
//! 输入上行经 Tauri invoke（browser_input 命令，本模块消费）——不用 WS；
//! 帧下行见 [crate::browser::frame_stream]。
//!
//! ## 高频节流（任务书二选一：取 **Rust 侧按帧间隔合并**，注释说明）
//! 高频 mousemove/wheel 事件在 Rust 侧合并（[PanelInputRouter] 持 pending
//! 态，flush 周期取最新值派发）——**单一权威节流**：与前端是否节流无关，
//! 事件洪泛在到达 IPC 边界前即被收敛（对齐 12 §2.5/§3.4 的 rAF 合并语义，
//! 此处下沉到引擎侧）。前端 rAF 合并仅作 IPC 预过滤（见
//! apps/crish-desktop/.../usePanelInput.ts 注释）。
//! - move：pending 覆写（最新优先，未消费的旧帧零成本丢弃）；
//! - wheel：delta 累加（同一合并窗内多次滚轮收敛为一次注入，12 §3.4）；
//! - down/up/key/text：离散事件**直通不合并**；down/up 前先 flush 积压 move
//!   （press 先于 move 送达，事件序保真，12 §3.2）。
//!
//! ## P1-A 对接（并行实施已落地，2026-08）
//! 注入管线 = `conex_browser::input::InputPipeline`（12 §4.1：语义化
//! `InputCmd` + 有界 mpsc + 单消费者串行派发 + no-wait + 版本推进）：
//! - 本模块完成「前端事件语义 → InputCmd」的映射层（12 §3 映射表）；
//! - 派发 no-wait：`route` 只入队（tauri::async_runtime::spawn 后立即返回
//!   invoke），不等待 CDP 注入结果（12 §4.1 no-wait 语义）；
//! - 版本推进（R-1/U-1 注入即时 +1）与活动钩子（input_active 升帧 / 维度 15
//!   上报）由 P1-A 管线内部承担（consumer_loop 注入成功 → bump + activity）；
//! - 管线随连接生命周期注入/清除（BrowserSlot::connect /
//!   drop_raw_session），未接线时路由/合并/节流照常生效，派发丢弃
//!   （debug 留痕）——浏览器停止后输入事件不产生副作用。

use conex_browser::input::{InputButton, InputCmd, InputPipeline, KeyEventType};
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// flush 周期（~30Hz，帧间隔量级：Base 8fps 的 1/3 以上，兼顾 G-2 输入延迟
/// ≤30ms 目标与洪泛收敛；测试注入短窗）。
const DEFAULT_FLUSH_INTERVAL: Duration = Duration::from_millis(33);

/// 输入事件种类（browser_input 契约；serde 小写）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum InputEventKind {
    Mouse,
    Wheel,
    Key,
    Text,
}

/// browser_input 命令载荷（前端 → Rust；字段 camelCase，全部可选——
/// 按 kind 取用子集，12 §3.1/§3.2/§3.3 映射面）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserInputEvent {
    pub kind: InputEventKind,
    /// mouse：down/up/move（缺省视为 move）；key：down/up（缺省 down）
    pub action: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    /// mouse：none/left/right/middle/back/forward
    pub button: Option<String>,
    /// mouse：位掩码（1=左 2=右 4=中 8=back 16=forward，12 §3.2）
    pub buttons: Option<u32>,
    pub click_count: Option<u32>,
    /// wheel：像素增量（前端已按 §3.4 归一化 deltaMode）
    pub delta_x: Option<f64>,
    pub delta_y: Option<f64>,
    /// CDP modifiers（1=Alt 2=Ctrl 4=Meta 8=Shift，12 §3.1）
    pub modifiers: Option<u32>,
    pub key: Option<String>,
    pub code: Option<String>,
    /// keydown 可打印字符 text / text 种类合成文本（IME 桥 P1-B2 后接入）
    pub text: Option<String>,
    pub windows_virtual_key_code: Option<u32>,
    pub native_virtual_key_code: Option<u32>,
    pub auto_repeat: Option<bool>,
    pub location: Option<u32>,
}

/// 合并窗内的高频事件 pending 态。
#[derive(Debug, Clone, PartialEq)]
enum PendingInput {
    /// 最近一次 mousemove（覆写 = 最新优先丢旧帧）。
    Move {
        x: f64,
        y: f64,
        button: InputButton,
        buttons: u32,
        click_count: u32,
        modifiers: u32,
    },
    /// 合并窗内滚轮 delta 累加（12 §3.4 rAF 合并语义）。
    Wheel {
        x: f64,
        y: f64,
        delta_x: f64,
        delta_y: f64,
        buttons: u32,
        modifiers: u32,
    },
}

/// 高频合并器（纯逻辑：路由/合并/「事件语义 → InputCmd」映射）。
///
/// 与管线/IO 解耦，可独立单测（对齐 12 §3 映射表）；[PanelInputRouter]
/// 持有本合并器并把产出的命令送入注入管线。
#[derive(Debug, Default)]
struct Coalescer {
    /// 合并 pending（高频事件：move 覆写 / wheel 累加）
    pending: Option<PendingInput>,
}

impl Coalescer {
    /// 路由一条前端事件：返回**立即派发**的命令列表（down/up/key/text 直通；
    /// move/wheel 入 pending，flush 时产出）。down/up 前先 flush 积压 move
    /// （press 先于 move 送达，事件序保真，12 §3.2）。
    fn route(&mut self, evt: &BrowserInputEvent) -> Vec<InputCmd> {
        let mut out = Vec::new();
        match evt.kind {
            InputEventKind::Mouse => {
                let action = evt.action.as_deref().unwrap_or("move");
                match action {
                    "move" => {
                        self.merge(PendingInput::Move {
                            x: evt.x.unwrap_or(0.0),
                            y: evt.y.unwrap_or(0.0),
                            button: map_button(evt.button.as_deref()),
                            buttons: evt.buttons.unwrap_or(0),
                            click_count: evt.click_count.unwrap_or(1),
                            modifiers: evt.modifiers.unwrap_or(0),
                        });
                    }
                    "down" | "up" => {
                        // 事件序保真：press/release 前先 flush 积压 move
                        out.append(&mut self.flush());
                        let (x, y, button, buttons, click_count, modifiers) = (
                            evt.x.unwrap_or(0.0),
                            evt.y.unwrap_or(0.0),
                            map_button(evt.button.as_deref()),
                            evt.buttons.unwrap_or(0),
                            evt.click_count.unwrap_or(1),
                            evt.modifiers.unwrap_or(0),
                        );
                        let cmd = if action == "down" {
                            InputCmd::MousePress {
                                x,
                                y,
                                button,
                                buttons,
                                click_count,
                                modifiers,
                            }
                        } else {
                            InputCmd::MouseRelease {
                                x,
                                y,
                                button,
                                buttons,
                                click_count,
                                modifiers,
                            }
                        };
                        out.push(cmd);
                    }
                    other => {
                        tracing::debug!(target: "browser", action = other, "未知 mouse action（忽略）");
                    }
                }
            }
            InputEventKind::Wheel => {
                self.merge(PendingInput::Wheel {
                    x: evt.x.unwrap_or(0.0),
                    y: evt.y.unwrap_or(0.0),
                    delta_x: evt.delta_x.unwrap_or(0.0),
                    delta_y: evt.delta_y.unwrap_or(0.0),
                    buttons: evt.buttons.unwrap_or(0),
                    modifiers: evt.modifiers.unwrap_or(0),
                });
            }
            InputEventKind::Key => {
                let event_type = if evt.action.as_deref() == Some("up") {
                    KeyEventType::Up
                } else {
                    KeyEventType::Down
                };
                // 12 §3.3：key/code/VK 直取浏览器事件（无查表误差）；
                // nativeVirtualKeyCode 缺省（0）→ None（省略字段不发 null）
                let native = match evt.native_virtual_key_code {
                    Some(v) if v != 0 => Some(v),
                    _ => None,
                };
                let cmd = match event_type {
                    KeyEventType::Down => InputCmd::KeyDown {
                        key: evt.key.clone(),
                        code: evt.code.clone(),
                        text: evt.text.clone(),
                        unmodified_text: evt.text.clone(),
                        windows_virtual_key_code: evt.windows_virtual_key_code.unwrap_or(0),
                        native_virtual_key_code: native,
                        auto_repeat: evt.auto_repeat.unwrap_or(false),
                        modifiers: evt.modifiers.unwrap_or(0),
                        location: evt.location.unwrap_or(0),
                    },
                    KeyEventType::Up => InputCmd::KeyUp {
                        key: evt.key.clone(),
                        code: evt.code.clone(),
                        windows_virtual_key_code: evt.windows_virtual_key_code.unwrap_or(0),
                        native_virtual_key_code: native,
                        modifiers: evt.modifiers.unwrap_or(0),
                        location: evt.location.unwrap_or(0),
                    },
                };
                out.push(cmd);
            }
            InputEventKind::Text => {
                let text = evt.text.clone().unwrap_or_default();
                if text.is_empty() {
                    tracing::debug!(target: "browser", "空合成文本（合成取消，不注入）");
                } else {
                    // 12 §3.7：compositionend 整串注入（防 surrogate pair 切分破坏）
                    out.push(InputCmd::Text { text });
                }
            }
        }
        out
    }

    /// 取积压高频事件并映射为命令（move 最新值 / wheel 累加值）。
    fn flush(&mut self) -> Vec<InputCmd> {
        match self.pending.take() {
            Some(PendingInput::Move {
                x,
                y,
                button,
                buttons,
                click_count: _,
                modifiers,
            }) => {
                vec![InputCmd::MouseMove {
                    x,
                    y,
                    button,
                    buttons,
                    modifiers,
                }]
            }
            Some(PendingInput::Wheel {
                x,
                y,
                delta_x,
                delta_y,
                buttons,
                modifiers,
            }) => {
                vec![InputCmd::Wheel {
                    x,
                    y,
                    delta_x,
                    delta_y,
                    buttons,
                    modifiers,
                }]
            }
            None => Vec::new(),
        }
    }

    /// 合并高频事件（move 覆写 / wheel 累加；PendingInput 互斥同槽位）。
    fn merge(&mut self, pending: PendingInput) {
        // wheel 同窗累加（delta 累加；坐标/位掩码取最新）
        if let PendingInput::Wheel {
            x,
            y,
            delta_x,
            delta_y,
            buttons,
            modifiers,
        } = pending
        {
            if let Some(PendingInput::Wheel {
                delta_x: px,
                delta_y: py,
                x: qx,
                y: qy,
                buttons: qb,
                modifiers: qm,
            }) = self.pending.as_mut()
            {
                *px += delta_x;
                *py += delta_y;
                *qx = x;
                *qy = y;
                *qb = buttons;
                *qm = modifiers;
                return;
            }
            self.pending = Some(PendingInput::Wheel {
                x,
                y,
                delta_x,
                delta_y,
                buttons,
                modifiers,
            });
            return;
        }
        self.pending = Some(pending);
    }
}

/// 面板输入路由器（BrowserSlot 字段；高频节流 + P1-A 管线对接）。
pub(crate) struct PanelInputRouter {
    /// 高频合并器（move 覆写 / wheel 累加 + 事件 → InputCmd 映射）
    coalescer: Mutex<Coalescer>,
    /// P1-A 注入管线（随连接生命周期注入；None = 未接线：路由/合并照常，
    /// 派发丢弃 + debug 留痕）
    pipeline: Mutex<Option<Arc<InputPipeline>>>,
    /// flush 周期（帧间隔量级；测试注入短窗）
    flush_ms: Duration,
    /// flush 任务惰性单飞（进程级常驻，空 pending 零开销）
    flush_spawned: AtomicBool,
}

impl PanelInputRouter {
    pub(crate) fn new() -> Self {
        PanelInputRouter {
            coalescer: Mutex::new(Coalescer::default()),
            pipeline: Mutex::new(None),
            flush_ms: DEFAULT_FLUSH_INTERVAL,
            flush_spawned: AtomicBool::new(false),
        }
    }

    /// 注入 flush 周期（测试用短窗）。
    #[cfg(test)]
    fn with_flush_ms(mut self, flush_ms: Duration) -> Self {
        self.flush_ms = flush_ms;
        self
    }

    /// 注入 P1-A 注入管线（BrowserSlot::connect 时调用；替换旧管线——
    /// 旧管线 Drop 终止其消费任务）。
    pub(crate) fn set_pipeline(&self, pipeline: Arc<InputPipeline>) {
        *self.pipeline.lock().unwrap_or_else(|p| p.into_inner()) = Some(pipeline);
    }

    /// 清除注入管线（浏览器停止/重连时调用；此后输入事件不产生副作用）。
    pub(crate) fn clear_pipeline(&self) {
        *self.pipeline.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    /// 管线是否已接线（browser_input 命令面可据此判断注入面可用）。
    #[cfg(test)]
    pub(crate) fn pipeline_wired(&self) -> bool {
        self.pipeline
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some()
    }

    /// 路由入口（browser_input 命令消费）：合并/直通 + 惰性启动 flush 任务。
    pub(crate) fn route(self: &Arc<Self>, evt: &BrowserInputEvent) {
        let cmds = self
            .coalescer
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .route(evt);
        for cmd in cmds {
            self.dispatch(cmd);
        }
        self.ensure_flush_task();
    }

    // ---------- 内部 ----------

    /// 立即 flush 积压（down/up 前调用；也由 flush 任务周期调用）。
    fn flush_now(&self) -> bool {
        let cmds = self
            .coalescer
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .flush();
        for cmd in &cmds {
            self.dispatch(cmd.clone());
        }
        !cmds.is_empty()
    }

    /// 派发（no-wait）：管线未接线 → debug 留痕丢弃；接线 → 后台异步派发
    /// （不等待 CDP 注入结果，invoke 立即返回）。
    fn dispatch(&self, cmd: InputCmd) {
        let Some(pipeline) = self
            .pipeline
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
        else {
            tracing::debug!(
                target: "browser",
                cmd = %cmd.method(),
                "输入事件进入面板路由（注入管线未接线，丢弃）"
            );
            return;
        };
        // no-wait：入队即返回；版本推进/活动钩子由管线消费端内部承担。
        // 同步 fn 内 tokio::spawn → tauri::async_runtime::spawn（全局 runtime
        // 惰性初始化，同步/异步上下文均安全；与 tokio::spawn 语义一致，
        // 任务 detach 运行，句柄不持有）。
        tauri::async_runtime::spawn(async move {
            if let Err(error) = pipeline.dispatch(cmd).await {
                tracing::warn!(target: "browser", error = %error, "输入注入失败（丢弃）");
            }
        });
    }

    /// flush 任务惰性单飞（进程级常驻：空 pending 周期检查零开销）。
    fn ensure_flush_task(self: &Arc<Self>) {
        if self.flush_spawned.swap(true, Ordering::SeqCst) {
            return;
        }
        let this = Arc::clone(self);
        // 同步 fn 内 tokio::spawn → tauri::async_runtime::spawn（全局 runtime
        // 惰性初始化，同步/异步上下文均安全；闭包内 tokio::time 在 tauri 的
        // tokio runtime 中运行，interval 语义不变）。
        tauri::async_runtime::spawn(async move {
            let mut tick = tokio::time::interval(this.flush_ms);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                this.flush_now();
            }
        });
    }
}

/// 前端按钮串 → P1-A InputButton（非法值收敛 None，宽容解析；12 §3.2 表）。
fn map_button(value: Option<&str>) -> InputButton {
    match value {
        Some("left") => InputButton::Left,
        Some("right") => InputButton::Right,
        Some("middle") => InputButton::Middle,
        Some("back") => InputButton::Back,
        Some("forward") => InputButton::Forward,
        _ => InputButton::None,
    }
}

#[cfg(test)]
mod tests;
