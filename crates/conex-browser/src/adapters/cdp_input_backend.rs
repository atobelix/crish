//! CdpInputBackend —— `InputBackend` 浏览器线适配器（05 文档 §4.3，纯加法）
//!
//! 把共享层输入注入抽象映射为既有 `InputCmd` 序列，经 `InputPipeline::dispatch`
//! 注入（no-wait 快速路径 + 单消费者保序 + bump 即时 +1，pipeline.rs:133）：
//! - 键名解析复用 `action/keyboard.rs` 权威面（KEY_MAP 查表 + 单字符回退，
//!   经 `parse_key_sequence`；规范名别名 ctrl→Control / win→Meta，04 文档 §2.4）；
//! - 修饰键位掩码 1=Alt 2=Ctrl 4=Meta 8=Shift（input/mod.rs 与 keyboard.rs 常量）；
//! - 内部 `MouseState`（RwLock）记录最后注入坐标与按压键——CDP mouseMoved
//!   必须携带当前按压状态（§3.2）；浏览器线无 OS 光标，cursor_position 返回
//!   最后已知注入坐标（05 文档 §9 问题 4）。
//!
//! 不替换既有 panel_input.rs 接线：本适配器是共享层输入面的平行新增入口。
//! 管线内部（保序/no-wait/bump）零改动；`InputCmd`/`to_cdp` 原样复用
//! （05 文档 §4.3 关键不变量）。

use std::sync::{Arc, RwLock};
use std::time::Duration;

use async_trait::async_trait;
use conex_shared::input::{
    ClickCount, InputBackend, InputBackendError, KeyName, MouseButton, PhysicalPoint,
    ScrollDirection,
};

use crate::action::keyboard::{parse_key_sequence, KeySpec};
use crate::action::{TYPE_CHUNK_DELAY_MS, TYPE_CHUNK_SIZE};
use crate::input::{InputButton, InputCmd, InputError, InputPipeline};

/// 滚轮像素增量归一化倍率（05 文档 §4.3：amount × 120 像素）。
const SCROLL_DELTA_SCALE: i64 = 120;

/// 拖拽分步插值步长（px，对齐桌面 DRAG_STEP_PX=32，conex-computer action.rs:23）。
const DRAG_STEP_PX: i64 = 32;

/// 拖拽分步间延迟（ms，对齐桌面 DRAG_STEP_DELAY_MS=8）。
const DRAG_STEP_DELAY_MS: u64 = 8;

/// 鼠标状态（浏览器线内部面：CDP mouseMoved 必须携带当前按压键与位掩码）。
#[derive(Debug, Clone, Copy)]
struct MouseState {
    /// 最后注入坐标（cursor_position 返回面，05 文档 §9 问题 4）。
    pos: PhysicalPoint,
    /// 当前按压键（无则 None；mouseMoved button 字段）。
    pressed: Option<InputButton>,
    /// CDP buttons 位掩码（1=左 2=右 4=中 8=侧后 16=侧前，input/mod.rs:35 同款）。
    mask: u32,
}

impl Default for MouseState {
    fn default() -> Self {
        MouseState {
            pos: PhysicalPoint { x: 0, y: 0 },
            pressed: None,
            mask: 0,
        }
    }
}

/// 输入后端（浏览器线）：方法序列 → InputCmd → InputPipeline::dispatch。
pub struct CdpInputBackend {
    pipeline: Arc<InputPipeline>,
    mouse: RwLock<MouseState>,
}

impl CdpInputBackend {
    /// 新建（app 侧既有 `InputPipeline` 实例注入，panel_input.rs 现状不变）。
    pub fn new(pipeline: Arc<InputPipeline>) -> Self {
        CdpInputBackend {
            pipeline,
            mouse: RwLock::new(MouseState::default()),
        }
    }

    /// 内部管线引用（诊断/活动钩子接线面）。
    pub fn pipeline(&self) -> &Arc<InputPipeline> {
        &self.pipeline
    }

    /// 单命令注入（错误映射：InputError → InputBackendError）。
    async fn dispatch(&self, cmd: InputCmd) -> Result<(), InputBackendError> {
        self.pipeline.dispatch(cmd).await.map_err(map_input_error)
    }

    /// 取目标坐标（None → 最后已知坐标）。
    fn pos_of(&self, p: Option<PhysicalPoint>) -> PhysicalPoint {
        match p {
            Some(p) => p,
            None => self.mouse.read().unwrap_or_else(|g| g.into_inner()).pos,
        }
    }

    /// 构造 MouseMove（携带当前按压键与位掩码，§3.2）。
    fn move_cmd(&self, p: PhysicalPoint, modifiers: u32) -> InputCmd {
        let m = self.mouse.read().unwrap_or_else(|g| g.into_inner());
        InputCmd::MouseMove {
            x: f64::from(p.x),
            y: f64::from(p.y),
            button: m.pressed.unwrap_or(InputButton::None),
            buttons: m.mask,
            modifiers,
        }
    }

    /// 更新最后已知坐标。
    fn set_pos(&self, p: PhysicalPoint) {
        let mut m = self.mouse.write().unwrap_or_else(|g| g.into_inner());
        m.pos = p;
    }

    /// 当前按钮位掩码（同步读取，防读写锁守卫跨 await 导致 future 非 Send）。
    fn buttons_mask(&self) -> u32 {
        self.mouse.read().unwrap_or_else(|g| g.into_inner()).mask
    }
}

/// InputError → InputBackendError（05 文档 §4.1 错误面映射）。
fn map_input_error(e: InputError) -> InputBackendError {
    match e {
        InputError::NoActiveTab => {
            InputBackendError::Failed("无活动标签会话".to_string())
        }
        InputError::SendFailed { message } => InputBackendError::Failed(message),
        InputError::QueueClosed => {
            InputBackendError::Failed("输入管线已关闭".to_string())
        }
    }
}

/// 键名解析（04 文档 §2.4 键名规范，桌面线同款规范名）：
/// ① 规范名别名 → KEY_MAP 键名（ctrl→Control / win→Meta；KEY_MAP 无缩写键名）；
/// ② 经 `parse_key_sequence` 单名解析（KEY_MAP 查表 + 单字符键回退，
///    action/keyboard.rs 同一权威面，不复制字符表）；
/// 未注册键名 → Failed。
fn resolve_key(name: &KeyName) -> Result<KeySpec, InputBackendError> {
    let canonical = match name.0.as_str() {
        "ctrl" => "Control".to_string(),
        "win" => "Meta".to_string(),
        other => other.to_string(),
    };
    parse_key_sequence(&canonical)
        .map(|seq| seq.main)
        .map_err(|e| InputBackendError::Failed(format!("键名无法解析：{}（{e}）", name.0)))
}

/// MouseButton → InputButton（CDP button 字段）。
fn to_input_button(btn: MouseButton) -> InputButton {
    match btn {
        MouseButton::Left => InputButton::Left,
        MouseButton::Middle => InputButton::Middle,
        MouseButton::Right => InputButton::Right,
        MouseButton::Back => InputButton::Back,
        MouseButton::Forward => InputButton::Forward,
    }
}

/// 按键 → CDP buttons 位（1=左 2=右 4=中 8=侧后 16=侧前，§3.2）。
fn button_bit(btn: InputButton) -> u32 {
    match btn {
        InputButton::None => 0,
        InputButton::Left => 1,
        InputButton::Right => 2,
        InputButton::Middle => 4,
        InputButton::Back => 8,
        InputButton::Forward => 16,
    }
}

/// ClickCount → CDP clickCount（§3.5：单击 1 / 双击 2 / 三击 3，
/// 双击/三击间隔由 Chrome 按 clickCount 判定，后端不生成间隔）。
fn click_count_value(count: ClickCount) -> u32 {
    match count {
        ClickCount::Single => 1,
        ClickCount::Double => 2,
        ClickCount::Triple => 3,
    }
}

/// 滚动方向 → (delta_x, delta_y)（§3.4：amount × 120 归一化像素；Up/Left 为负）。
fn scroll_delta(dir: ScrollDirection, amount: u32) -> (f64, f64) {
    let delta = i64::from(amount) * SCROLL_DELTA_SCALE;
    match dir {
        ScrollDirection::Up => (0.0, -(delta as f64)),
        ScrollDirection::Down => (0.0, delta as f64),
        ScrollDirection::Left => (-(delta as f64), 0.0),
        ScrollDirection::Right => (delta as f64, 0.0),
    }
}

/// KeySpec → KeyDown（可打印单字符携带 text/unmodifiedText，§3.3）。
fn key_down(spec: &KeySpec, modifiers: u32) -> InputCmd {
    let printable = spec.name.chars().count() == 1;
    InputCmd::KeyDown {
        key: Some(spec.name.clone()),
        code: Some(spec.code.clone()),
        text: printable.then(|| spec.name.clone()),
        unmodified_text: printable.then(|| spec.name.clone()),
        windows_virtual_key_code: spec.vk as u32,
        native_virtual_key_code: Some(spec.vk as u32),
        auto_repeat: false,
        modifiers,
        location: 0,
    }
}

/// KeySpec → KeyUp（text 置空不发送，§3.3）。
fn key_up(spec: &KeySpec, modifiers: u32) -> InputCmd {
    InputCmd::KeyUp {
        key: Some(spec.name.clone()),
        code: Some(spec.code.clone()),
        windows_virtual_key_code: spec.vk as u32,
        native_virtual_key_code: Some(spec.vk as u32),
        modifiers,
        location: 0,
    }
}

#[async_trait]
impl InputBackend for CdpInputBackend {
    async fn mouse_move(&self, p: PhysicalPoint) -> Result<(), InputBackendError> {
        self.dispatch(self.move_cmd(p, 0)).await?;
        self.set_pos(p);
        Ok(())
    }

    async fn click(
        &self,
        btn: MouseButton,
        count: ClickCount,
        p: Option<PhysicalPoint>,
        mods: &[KeyName],
    ) -> Result<(), InputBackendError> {
        // ① 修饰键按序按下（查表 KEY_MAP，12 文档 §4.1）
        let specs: Vec<KeySpec> = mods.iter().map(resolve_key).collect::<Result<_, _>>()?;
        let mut mod_mask: u32 = 0;
        for spec in &specs {
            mod_mask |= spec.modifier_mask as u32;
            self.dispatch(key_down(spec, mod_mask)).await?;
        }
        // ② 带坐标先移动（无坐标留在当前位，05 文档 §4.3 行）
        let target = self.pos_of(p);
        if p.is_some() {
            self.dispatch(self.move_cmd(target, mod_mask)).await?;
        }
        // ③ 按下/抬起（clickCount 透传：双击/三击语义由 Chrome 判定，§3.5）
        let input_btn = to_input_button(btn);
        let bit = button_bit(input_btn);
        let count = click_count_value(count);
        {
            let mut m = self.mouse.write().unwrap_or_else(|g| g.into_inner());
            m.pos = target;
            m.mask |= bit;
        }
        self.dispatch(InputCmd::MousePress {
            x: f64::from(target.x),
            y: f64::from(target.y),
            button: input_btn,
            buttons: self.buttons_mask(),
            click_count: count,
            modifiers: mod_mask,
        })
        .await?;
        {
            let mut m = self.mouse.write().unwrap_or_else(|g| g.into_inner());
            m.pressed = None;
            m.mask &= !bit;
        }
        self.dispatch(InputCmd::MouseRelease {
            x: f64::from(target.x),
            y: f64::from(target.y),
            button: input_btn,
            buttons: self.buttons_mask(),
            click_count: count,
            modifiers: mod_mask,
        })
        .await?;
        // ④ 修饰键逆序抬起
        for spec in specs.iter().rev() {
            mod_mask &= !(spec.modifier_mask as u32);
            self.dispatch(key_up(spec, mod_mask)).await?;
        }
        Ok(())
    }

    async fn button(&self, btn: MouseButton, down: bool) -> Result<(), InputBackendError> {
        let input_btn = to_input_button(btn);
        let bit = button_bit(input_btn);
        let (x, y) = {
            let m = self.mouse.read().unwrap_or_else(|g| g.into_inner());
            (m.pos.x, m.pos.y)
        };
        if down {
            {
                let mut m = self.mouse.write().unwrap_or_else(|g| g.into_inner());
                m.mask |= bit;
                m.pressed = Some(input_btn);
            }
            self.dispatch(InputCmd::MousePress {
                x: f64::from(x),
                y: f64::from(y),
                button: input_btn,
                buttons: self.buttons_mask(),
                click_count: 1,
                modifiers: 0,
            })
            .await
        } else {
            {
                let mut m = self.mouse.write().unwrap_or_else(|g| g.into_inner());
                m.mask &= !bit;
                m.pressed = None;
            }
            self.dispatch(InputCmd::MouseRelease {
                x: f64::from(x),
                y: f64::from(y),
                button: input_btn,
                buttons: self.buttons_mask(),
                click_count: 1,
                modifiers: 0,
            })
            .await
        }
    }

    async fn drag(&self, from: PhysicalPoint, to: PhysicalPoint) -> Result<(), InputBackendError> {
        // 步长对齐桌面 DRAG_STEP_PX=32 语义（conex-computer action.rs:23）：
        // 起点移动 → 按下左键 → 分步线性插值移动 → 终点抬起
        self.mouse_move(from).await?;
        self.button(MouseButton::Left, true).await?;
        let dx = to.x - from.x;
        let dy = to.y - from.y;
        let distance = i64::from(dx.abs().max(dy.abs()));
        let steps = ((distance + DRAG_STEP_PX - 1) / DRAG_STEP_PX).max(1);
        for step in 1..=steps {
            let t = step as f64 / steps as f64;
            let x = from.x + (f64::from(dx) * t).round() as i32;
            let y = from.y + (f64::from(dy) * t).round() as i32;
            self.mouse_move(PhysicalPoint { x, y }).await?;
            tokio::time::sleep(Duration::from_millis(DRAG_STEP_DELAY_MS)).await;
        }
        self.button(MouseButton::Left, false).await
    }

    async fn scroll(
        &self,
        dir: ScrollDirection,
        amount: u32,
        p: Option<PhysicalPoint>,
        mods: &[KeyName],
    ) -> Result<(), InputBackendError> {
        let mod_mask = resolve_mods_mask(mods)?;
        let target = self.pos_of(p);
        // 带坐标先移动（trait 语义：滚动作用于目标点）
        if p.is_some() {
            self.dispatch(self.move_cmd(target, mod_mask)).await?;
        }
        let (delta_x, delta_y) = scroll_delta(dir, amount);
        self.dispatch(InputCmd::Wheel {
            x: f64::from(target.x),
            y: f64::from(target.y),
            delta_x,
            delta_y,
            buttons: self.buttons_mask(),
            modifiers: mod_mask,
        })
        .await?;
        self.set_pos(target);
        Ok(())
    }

    async fn type_text(&self, text: &str) -> Result<(), InputBackendError> {
        // 按 50 字符分块 + 块间 12ms 节流（04 文档 §2.3，TYPE_CHUNK_SIZE 同款语义；
        // 按字符切分不破坏代理对/CJK，整块走 Input.insertText）
        let chars: Vec<char> = text.chars().collect();
        let total_chunks = chars.chunks(TYPE_CHUNK_SIZE).count();
        for (i, chunk) in chars.chunks(TYPE_CHUNK_SIZE).enumerate() {
            let chunk_text: String = chunk.iter().collect();
            self.dispatch(InputCmd::Text { text: chunk_text }).await?;
            if i + 1 < total_chunks {
                tokio::time::sleep(Duration::from_millis(TYPE_CHUNK_DELAY_MS)).await;
            }
        }
        Ok(())
    }

    async fn key(&self, keys: &[KeyName], hold_ms: Option<u32>) -> Result<(), InputBackendError> {
        // 修饰键按序 down → 主键 down/up → 修饰键逆序 up（§4.3；
        // 可打印字符携带 text，§3.3）；hold_ms=Some：主键按住后松开
        let specs: Vec<KeySpec> = keys.iter().map(resolve_key).collect::<Result<_, _>>()?;
        let mut modifiers: Vec<KeySpec> = Vec::new();
        let mut main: Option<KeySpec> = None;
        for spec in specs {
            if spec.modifier_mask != 0 {
                modifiers.push(spec);
            } else if main.is_none() {
                main = Some(spec);
            } else {
                return Err(InputBackendError::Failed(
                    "组合键只能有一个主键".to_string(),
                ));
            }
        }
        // 纯修饰键串：最后一个修饰键充当主键（对齐 action/keyboard.rs parse_key_sequence）
        let main = match main {
            Some(m) => m,
            None => modifiers
                .pop()
                .ok_or_else(|| InputBackendError::Failed("组合键缺少主键".to_string()))?,
        };
        let mut mask: u32 = 0;
        for spec in &modifiers {
            mask |= spec.modifier_mask as u32;
            self.dispatch(key_down(spec, mask)).await?;
        }
        self.dispatch(key_down(&main, mask)).await?;
        if let Some(ms) = hold_ms {
            tokio::time::sleep(Duration::from_millis(u64::from(ms))).await;
        }
        self.dispatch(key_up(&main, mask)).await?;
        for spec in modifiers.iter().rev() {
            mask &= !(spec.modifier_mask as u32);
            self.dispatch(key_up(spec, mask)).await?;
        }
        Ok(())
    }

    async fn cursor_position(&self) -> Result<PhysicalPoint, InputBackendError> {
        // 浏览器线无 OS 光标：返回最后已知注入坐标（05 文档 §9 问题 4）
        let m = self.mouse.read().unwrap_or_else(|g| g.into_inner());
        Ok(m.pos)
    }
}

/// 修饰键列表 → 位掩码（键名解析 + 严格修饰键校验——对齐桌面线
/// 「修饰键只允许 ctrl/alt/shift/win」语义，conex-computer action.rs:266）。
fn resolve_mods_mask(mods: &[KeyName]) -> Result<u32, InputBackendError> {
    let mut mask: u32 = 0;
    for name in mods {
        let spec = resolve_key(name)?;
        if spec.modifier_mask == 0 {
            return Err(InputBackendError::Failed(format!(
                "键名不是修饰键：{}",
                name.0
            )));
        }
        mask |= spec.modifier_mask as u32;
    }
    Ok(mask)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cdp::error::CdpError;
    use crate::cdp::mock::{MockReply, MockServer};
    use crate::cdp::sender::{
        ApprovalDenied, BrowserAuditEvent, CancellationToken, CdpCommandView, IdKey,
    };
    use crate::cdp::transport::{CdpEndpoint, ExpectedBrowser};
    use async_trait::async_trait;
    use serde_json::{json, Value};
    use std::sync::atomic::AtomicBool;

    /// 放行策略钩子（会话面测试用，同 pipeline.rs 测试）。
    struct AllowHooks {
        stop: Arc<AtomicBool>,
        token: CancellationToken,
    }

    impl AllowHooks {
        fn new() -> Self {
            AllowHooks {
                stop: Arc::new(AtomicBool::new(false)),
                token: CancellationToken::new(),
            }
        }
    }

    #[async_trait]
    impl crate::cdp::sender::CommandPolicyHooks for AllowHooks {
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

    /// 会话恢复所需 mock 自动应答全表（同 pipeline.rs 测试）。
    fn restore_reply_map() -> Vec<(&'static str, MockReply)> {
        vec![
            (
                "Browser.getVersion",
                MockReply::Ok(json!({
                    "protocolVersion": "1.3",
                    "product": "Chrome/151.0.7922.72",
                    "revision": "@abc",
                    "userAgent": "ua",
                    "jsVersion": "13.1.71"
                })),
            ),
            ("Target.setDiscoverTargets", MockReply::Ok(json!({}))),
            (
                "Target.getTargets",
                MockReply::Ok(json!({
                    "targetInfos": [
                        { "targetId": "T1", "type": "page", "title": "A", "url": "https://a.example" }
                    ]
                })),
            ),
            (
                "Target.attachToTarget",
                MockReply::Ok(json!({ "sessionId": "S1" })),
            ),
            ("Page.enable", MockReply::Ok(json!({}))),
            ("Page.setLifecycleEventsEnabled", MockReply::Ok(json!({}))),
            ("Runtime.enable", MockReply::Ok(json!({}))),
            ("DOM.enable", MockReply::Ok(json!({}))),
            ("Network.enable", MockReply::Ok(json!({}))),
            ("Runtime.runIfWaitingForDebugger", MockReply::Ok(json!({}))),
            (
                "Runtime.evaluate",
                MockReply::Ok(json!({ "result": { "value": 1 } })),
            ),
            ("Page.setWindowOpenHandler", MockReply::Ok(json!({}))),
        ]
    }

    /// 组装：mock 会话 + 输入命令自动应答 + 活动标签就绪。
    async fn setup() -> (MockServer, Arc<crate::BrowserSession>) {
        let mock = MockServer::spawn().await;
        for (method, reply) in restore_reply_map() {
            mock.set_auto_reply(method, reply);
        }
        mock.set_auto_reply("Input.dispatchMouseEvent", MockReply::Ok(json!({})));
        mock.set_auto_reply("Input.dispatchKeyEvent", MockReply::Ok(json!({})));
        mock.set_auto_reply("Input.insertText", MockReply::Ok(json!({})));

        let session = Arc::new(
            crate::BrowserSession::connect(
                CdpEndpoint {
                    port: mock.addr.port(),
                    ws_path: "/devtools/browser/adapters-input-test".to_string(),
                },
                ExpectedBrowser::default(),
                Arc::new(AllowHooks::new()),
            )
            .await
            .expect("会话建连失败"),
        );
        mock.send_event(
            "Target.attachedToTarget",
            json!({
                "sessionId": "S1",
                "targetInfo": { "targetId": "T1", "type": "page", "title": "A", "url": "https://a.example" },
                "waitingForDebugger": false,
            }),
            None,
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while session.current_session().is_err() {
            assert!(std::time::Instant::now() < deadline, "活动标签未就绪");
            tokio::task::yield_now().await;
        }
        (mock, session)
    }

    /// 取下一帧鼠标事件参数（wire 保序：按派发序消费）。
    async fn next_mouse(mock: &mut MockServer) -> Value {
        mock.expect_command("Input.dispatchMouseEvent").await["params"].clone()
    }

    /// 取下一帧键盘事件参数。
    async fn next_key(mock: &mut MockServer) -> Value {
        mock.expect_command("Input.dispatchKeyEvent").await["params"].clone()
    }

    /// 取下一帧文本插入参数。
    async fn next_insert(mock: &mut MockServer) -> Value {
        mock.expect_command("Input.insertText").await["params"].clone()
    }

    /// InputError → InputBackendError 映射（05 文档 §4.1 错误面）。
    #[test]
    fn input_error_mapping() {
        assert!(matches!(
            map_input_error(InputError::NoActiveTab),
            InputBackendError::Failed(_)
        ));
        assert!(matches!(
            map_input_error(InputError::SendFailed {
                message: "x".to_string()
            }),
            InputBackendError::Failed(m) if m == "x"
        ));
        assert!(matches!(
            map_input_error(InputError::QueueClosed),
            InputBackendError::Failed(_)
        ));
    }

    /// mouse_move → mouseMoved（坐标/button=none/buttons=0/clickCount=0）。
    #[tokio::test]
    async fn mouse_move_maps_to_mouse_moved() {
        let (mut mock, session) = setup().await;
        let backend = CdpInputBackend::new(InputPipeline::new(session.clone()));
        backend
            .mouse_move(PhysicalPoint { x: 120, y: -40 })
            .await
            .expect("移动失败");
        let p = next_mouse(&mut mock).await;
        assert_eq!(p["type"], "mouseMoved");
        assert_eq!(p["x"], 120.0);
        assert_eq!(p["y"], -40.0);
        assert_eq!(p["button"], "none", "无按压时 button=none");
        assert_eq!(p["buttons"], 0);
        assert_eq!(p["clickCount"], 0);
        session.shutdown().await;
    }

    /// click(Single, 带坐标)：移动 → 按下 → 抬起（clickCount=1 透传），
    /// 光标位置 = 最后点击坐标。
    #[tokio::test]
    async fn click_single_moves_then_presses_releases() {
        let (mut mock, session) = setup().await;
        let backend = CdpInputBackend::new(InputPipeline::new(session.clone()));
        backend
            .click(
                MouseButton::Left,
                ClickCount::Single,
                Some(PhysicalPoint { x: 10, y: 20 }),
                &[],
            )
            .await
            .expect("点击失败");
        let move_p = next_mouse(&mut mock).await;
        assert_eq!(move_p["type"], "mouseMoved", "press 不得越过 move");
        assert_eq!(move_p["x"], 10.0);
        let press_p = next_mouse(&mut mock).await;
        assert_eq!(press_p["type"], "mousePressed");
        assert_eq!(press_p["button"], "left");
        assert_eq!(press_p["clickCount"], 1);
        assert_eq!(press_p["buttons"], 1);
        let release_p = next_mouse(&mut mock).await;
        assert_eq!(release_p["type"], "mouseReleased");
        assert_eq!(release_p["clickCount"], 1);
        assert_eq!(release_p["buttons"], 0, "抬起后按钮位清空");
        let pos = backend.cursor_position().await.expect("查询失败");
        assert_eq!(pos, PhysicalPoint { x: 10, y: 20 });
        session.shutdown().await;
    }

    /// click(Double, 带修饰键)：修饰键先按下 → 点击（clickCount=2 透传）→
    /// 修饰键逆序抬起（双击/三击间隔由 Chrome 判定，05 文档 §4.1）。
    #[tokio::test]
    async fn click_double_with_ctrl_orders_mods_around_click() {
        let (mut mock, session) = setup().await;
        let backend = CdpInputBackend::new(InputPipeline::new(session.clone()));
        backend
            .click(
                MouseButton::Right,
                ClickCount::Double,
                None,
                &[KeyName("ctrl".to_string())],
            )
            .await
            .expect("点击失败");
        let ctrl_down = next_key(&mut mock).await;
        assert_eq!(ctrl_down["type"], "keyDown");
        assert_eq!(ctrl_down["key"], "Control");
        assert_eq!(ctrl_down["modifiers"], 2, "Ctrl 掩码位 2（§3.1）");
        let press = next_mouse(&mut mock).await;
        assert_eq!(press["type"], "mousePressed");
        assert_eq!(press["button"], "right");
        assert_eq!(press["clickCount"], 2, "双击 clickCount=2 透传");
        assert_eq!(press["modifiers"], 2, "按住 Ctrl 点击");
        let release = next_mouse(&mut mock).await;
        assert_eq!(release["type"], "mouseReleased");
        assert_eq!(release["clickCount"], 2);
        assert_eq!(release["modifiers"], 2);
        let ctrl_up = next_key(&mut mock).await;
        assert_eq!(ctrl_up["type"], "keyUp");
        assert_eq!(ctrl_up["modifiers"], 0, "抬起后掩码清空");
        session.shutdown().await;
    }

    /// button 按下/抬起分离原语：作用于当前光标位置；按住状态下移动携带
    /// 按压键与位掩码（§3.2，拖拽保持面）。
    #[tokio::test]
    async fn button_press_release_at_last_pos() {
        let (mut mock, session) = setup().await;
        let backend = CdpInputBackend::new(InputPipeline::new(session.clone()));
        backend
            .mouse_move(PhysicalPoint { x: 5, y: 6 })
            .await
            .expect("移动失败");
        let _ = next_mouse(&mut mock).await;
        backend.button(MouseButton::Left, true).await.expect("按下失败");
        let press = next_mouse(&mut mock).await;
        assert_eq!(press["type"], "mousePressed");
        assert_eq!(press["x"], 5.0, "作用于当前光标位置");
        assert_eq!(press["y"], 6.0);
        assert_eq!(press["buttons"], 1);
        backend
            .mouse_move(PhysicalPoint { x: 7, y: 8 })
            .await
            .expect("移动失败");
        let moved = next_mouse(&mut mock).await;
        assert_eq!(moved["type"], "mouseMoved");
        assert_eq!(moved["button"], "left", "拖拽中移动必须携带按压键（§3.2）");
        assert_eq!(moved["buttons"], 1);
        backend
            .button(MouseButton::Left, false)
            .await
            .expect("抬起失败");
        let release = next_mouse(&mut mock).await;
        assert_eq!(release["type"], "mouseReleased");
        assert_eq!(release["buttons"], 0);
        session.shutdown().await;
    }

    /// drag：起点移动 → 按下左键 → 分步插值（步长 ≤32px，对齐桌面语义）→
    /// 终点抬起；拖拽全程保持左键按下（buttons=1）。
    #[tokio::test]
    async fn drag_interpolates_steps_with_button_held() {
        let (mut mock, session) = setup().await;
        let backend = CdpInputBackend::new(InputPipeline::new(session.clone()));
        backend
            .drag(
                PhysicalPoint { x: 0, y: 0 },
                PhysicalPoint { x: 100, y: 0 },
            )
            .await
            .expect("拖拽失败");
        let m0 = next_mouse(&mut mock).await;
        assert_eq!(m0["type"], "mouseMoved");
        assert_eq!(m0["x"], 0.0);
        assert_eq!(m0["buttons"], 0, "按下前不携带按压位");
        let press = next_mouse(&mut mock).await;
        assert_eq!(press["type"], "mousePressed");
        for expected in [25.0, 50.0, 75.0, 100.0] {
            let m = next_mouse(&mut mock).await;
            assert_eq!(m["type"], "mouseMoved");
            assert_eq!(m["x"], expected, "分步插值（ceil(100/32)=4 步）");
            assert_eq!(m["buttons"], 1, "拖拽中保持左键按下");
        }
        let release = next_mouse(&mut mock).await;
        assert_eq!(release["type"], "mouseReleased");
        assert_eq!(release["buttons"], 0);
        session.shutdown().await;
    }

    /// scroll：delta = amount × 120 归一化像素；Up/Left 为负；
    /// 带坐标先移动；修饰键掩码透传。
    #[tokio::test]
    async fn scroll_delta_normalized_amount_120() {
        let (mut mock, session) = setup().await;
        let backend = CdpInputBackend::new(InputPipeline::new(session.clone()));
        backend
            .scroll(
                ScrollDirection::Down,
                3,
                Some(PhysicalPoint { x: 50, y: 60 }),
                &[],
            )
            .await
            .expect("滚动失败");
        let moved = next_mouse(&mut mock).await;
        assert_eq!(moved["type"], "mouseMoved", "带坐标先移动");
        assert_eq!(moved["x"], 50.0);
        let w = next_mouse(&mut mock).await;
        assert_eq!(w["type"], "mouseWheel");
        assert_eq!(w["x"], 50.0);
        assert_eq!(w["y"], 60.0);
        assert_eq!(w["deltaY"], 360.0, "Down 3 档 × 120");
        assert_eq!(w["deltaX"], 0.0);
        backend
            .scroll(
                ScrollDirection::Up,
                1,
                None,
                &[KeyName("shift".to_string())],
            )
            .await
            .expect("滚动失败");
        let w = next_mouse(&mut mock).await;
        assert_eq!(w["deltaY"], -120.0, "Up 为负");
        assert_eq!(w["modifiers"], 8, "Shift 掩码位 8 透传");
        backend
            .scroll(ScrollDirection::Left, 1, None, &[])
            .await
            .expect("滚动失败");
        let w = next_mouse(&mut mock).await;
        assert_eq!(w["deltaX"], -120.0, "Left 为负");
        backend
            .scroll(ScrollDirection::Right, 2, None, &[])
            .await
            .expect("滚动失败");
        let w = next_mouse(&mut mock).await;
        assert_eq!(w["deltaX"], 240.0, "Right 2 档 × 120");
        session.shutdown().await;
    }

    /// type_text：按 50 字符分块 + 块间 12ms 节流（04 文档 §2.3）；
    /// 120 字符 → 3 块（50/50/20）+ 恰 2 次节流。
    #[tokio::test]
    async fn type_text_chunks_50_chars_with_throttle() {
        let (mut mock, session) = setup().await;
        let backend = CdpInputBackend::new(InputPipeline::new(session.clone()));
        let started = tokio::time::Instant::now();
        backend
            .type_text(&"x".repeat(120))
            .await
            .expect("输入失败");
        for expected_len in [50usize, 50, 20] {
            let p = next_insert(&mut mock).await;
            assert_eq!(
                p["text"].as_str().unwrap().chars().count(),
                expected_len,
                "分块大小按字符计"
            );
        }
        assert!(
            started.elapsed() >= Duration::from_millis(24),
            "块间节流 12ms × 2（实际 {:?}）",
            started.elapsed()
        );
        session.shutdown().await;
    }

    /// key 组合键：修饰键按序 down → 主键 down/up（可打印字符携带 text）→
    /// 修饰键逆序 up（掩码递减）。
    #[tokio::test]
    async fn key_chord_modifiers_down_main_down_up_reverse_up() {
        let (mut mock, session) = setup().await;
        let backend = CdpInputBackend::new(InputPipeline::new(session.clone()));
        backend
            .key(
                &[KeyName("ctrl".to_string()), KeyName("a".to_string())],
                None,
            )
            .await
            .expect("组合键失败");
        let ctrl_down = next_key(&mut mock).await;
        assert_eq!(ctrl_down["type"], "keyDown");
        assert_eq!(ctrl_down["key"], "Control");
        assert_eq!(ctrl_down["modifiers"], 2);
        let a_down = next_key(&mut mock).await;
        assert_eq!(a_down["type"], "keyDown");
        assert_eq!(a_down["key"], "a");
        assert_eq!(a_down["text"], "a", "可打印字符携带 text（§3.3）");
        assert_eq!(a_down["modifiers"], 2);
        let a_up = next_key(&mut mock).await;
        assert_eq!(a_up["type"], "keyUp");
        assert!(a_up.get("text").is_none(), "keyUp 无 text");
        let ctrl_up = next_key(&mut mock).await;
        assert_eq!(ctrl_up["type"], "keyUp");
        assert_eq!(ctrl_up["modifiers"], 0, "逆序释放后掩码归零");
        session.shutdown().await;
    }

    /// key hold_ms：主键 KeyDown → 按住 → KeyUp（hold 时长生效）。
    #[tokio::test]
    async fn key_hold_ms_holds_between_down_and_up() {
        let (mut mock, session) = setup().await;
        let backend = CdpInputBackend::new(InputPipeline::new(session.clone()));
        let started = tokio::time::Instant::now();
        backend
            .key(&[KeyName("Enter".to_string())], Some(30))
            .await
            .expect("按键失败");
        let down = next_key(&mut mock).await;
        assert_eq!(down["type"], "keyDown");
        let up = next_key(&mut mock).await;
        assert_eq!(up["type"], "keyUp");
        assert!(
            started.elapsed() >= Duration::from_millis(30),
            "hold_ms=30 应生效（实际 {:?}）",
            started.elapsed()
        );
        session.shutdown().await;
    }

    /// 键名解析失败：未知键名 / 组合键多主键 → Failed。
    #[tokio::test]
    async fn unknown_key_name_fails() {
        let (mock, session) = setup().await;
        let backend = CdpInputBackend::new(InputPipeline::new(session.clone()));
        let err = backend
            .key(&[KeyName("BogusKey".to_string())], None)
            .await
            .expect_err("未知键名应失败");
        assert!(matches!(err, InputBackendError::Failed(_)));
        let err = backend
            .click(
                MouseButton::Left,
                ClickCount::Single,
                None,
                &[KeyName("Bogus".to_string())],
            )
            .await
            .expect_err("未知修饰键应失败");
        assert!(matches!(err, InputBackendError::Failed(_)));
        let err = backend
            .key(
                &[KeyName("a".to_string()), KeyName("b".to_string())],
                None,
            )
            .await
            .expect_err("多主键应失败");
        assert!(matches!(err, InputBackendError::Failed(_)));
        let _ = mock;
        session.shutdown().await;
    }

    /// cursor_position：默认原点（0,0）即最后已知坐标（05 文档 §9 问题 4）。
    #[tokio::test]
    async fn cursor_position_returns_last_known_pos() {
        let (mock, session) = setup().await;
        let backend = CdpInputBackend::new(InputPipeline::new(session.clone()));
        assert_eq!(
            backend.cursor_position().await.expect("查询失败"),
            PhysicalPoint { x: 0, y: 0 },
            "默认原点是最后已知坐标（浏览器线无 OS 光标）"
        );
        let _ = mock;
        session.shutdown().await;
    }
}
