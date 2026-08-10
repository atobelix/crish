//! 输入注入管线（维度 12 §3/§4：用户路径与 AI 路径共用的唯一注入面，P1-A）
//!
//! - `InputCmd`：语义化输入命令（mouse_move / mouse_press / mouse_release /
//!   wheel / scroll / key_down / key_up / text(insertText)），用户（面板，
//!   12 文档 §3 映射表）与 AI（维度 14 动作执行）共用，差异仅在
//!   「语义 → InputCmd」的映射层（§4.1）；
//! - `to_cdp`：命令 → CDP Input 域参数（dispatchMouseEvent / dispatchKeyEvent /
//!   insertText）；**省略字段不发 null**（12 文档 §3.3：CDP 收到 null 字符串
//!   整个命令失败，agent-browser websocket.rs:572-577 同款注释）；
//! - 修饰键位掩码：`1=Alt 2=Ctrl 4=Meta 8=Shift`（§3.1，与
//!   action/keyboard.rs 的 MOD_* 常量一致，见 `modifier_bits` 断言）；
//! - 键盘映射：用户路径 key/code/VK 直取浏览器事件（§3.3，无查表误差）；
//!   AI 路径键名查表复用 `action/keyboard.rs::lookup_key`（KEY_MAP 引用）；
//! - 触摸输入一期映射为鼠标语义（pointer 事件覆盖点击/滚动），真触控手势
//!   （捏合/双指）列入后续增强（评审 20 12-7）。

mod pipeline;

pub use pipeline::{
    InputError, InputPipeline, InputStats, INPUT_CMD_TIMEOUT, INPUT_QUEUE_CAPACITY,
};

use serde_json::{json, Map, Value};

/// 鼠标按键（CDP Input.dispatchMouseEvent button 字段；多键同按取 buttons 并集）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputButton {
    /// 无按键（mouseMoved 无按压 / mouseWheel）。
    None,
    Left,
    Right,
    Middle,
    /// 侧键返回（buttons 位 8）。
    Back,
    /// 侧键前进（buttons 位 16）。
    Forward,
}

/// 鼠标事件类型（12 文档 §3.2 映射表行）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseEventType {
    /// pointermove（button = 当前按压键，无则 none）
    Moved,
    /// pointerdown（左/右/中/侧键）
    Pressed,
    /// pointerup（释放键）
    Released,
    /// wheel / 触控板滚动（deltaX/deltaY 像素增量）
    Wheel,
}

/// 键盘事件类型（12 文档 §3.3）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyEventType {
    /// keydown（可打印字符携带 text/unmodifiedText）
    Down,
    /// keyup（text 置空不发送）
    Up,
}

/// 语义化输入命令（用户路径与 AI 路径共用，12 文档 §3 映射表的管线输入面）。
#[derive(Debug, Clone, PartialEq)]
pub enum InputCmd {
    /// mouseMoved（§3.2：button = 当前按压键，无则 none；buttons = 位掩码）。
    MouseMove {
        x: f64,
        y: f64,
        button: InputButton,
        buttons: u32,
        modifiers: u32,
    },
    /// mousePressed（§3.2：左/右/中/侧键 + clickCount 按 §3.5 点击判定）。
    MousePress {
        x: f64,
        y: f64,
        button: InputButton,
        buttons: u32,
        click_count: u32,
        modifiers: u32,
    },
    /// mouseReleased（释放键 + 位掩码更新 + clickCount 按 §3.5）。
    MouseRelease {
        x: f64,
        y: f64,
        button: InputButton,
        buttons: u32,
        click_count: u32,
        modifiers: u32,
    },
    /// mouseWheel（§3.4：delta 为归一化后的像素增量）。
    Wheel {
        x: f64,
        y: f64,
        delta_x: f64,
        delta_y: f64,
        buttons: u32,
        modifiers: u32,
    },
    /// scroll（触控板双指/页面滚动，与 wheel 同一 CDP 映射，§3.4）。
    Scroll {
        x: f64,
        y: f64,
        delta_x: f64,
        delta_y: f64,
        modifiers: u32,
    },
    /// keyDown（可打印字符携带 text/unmodifiedText；控制键与组合键 text 置空，
    /// 12 文档 §3.3——命令和弦不做文本插入，Ctrl+A 全选语义正确）。
    KeyDown {
        key: Option<String>,
        code: Option<String>,
        text: Option<String>,
        unmodified_text: Option<String>,
        windows_virtual_key_code: u32,
        native_virtual_key_code: Option<u32>,
        auto_repeat: bool,
        modifiers: u32,
        /// 数字小键盘键置 3（§3.3）。
        location: u32,
    },
    /// keyUp（text 置空不发送，§3.3）。
    KeyUp {
        key: Option<String>,
        code: Option<String>,
        windows_virtual_key_code: u32,
        native_virtual_key_code: Option<u32>,
        modifiers: u32,
        location: u32,
    },
    /// text（IME 合成文本 compositionend 一次注入，Input.insertText；§3.7
    /// 整串注入避免逐字符切分破坏 surrogate pair）。
    Text { text: String },
}

impl InputCmd {
    /// 命令对应的 CDP 方法名（诊断/统计用）。
    pub fn method(&self) -> &'static str {
        to_cdp(self).0
    }
}

/// 鼠标按键 → CDP button 字符串（§3.2 表）。
pub fn input_button_name(button: InputButton) -> &'static str {
    match button {
        InputButton::None => "none",
        InputButton::Left => "left",
        InputButton::Right => "right",
        InputButton::Middle => "middle",
        InputButton::Back => "back",
        InputButton::Forward => "forward",
    }
}

/// 鼠标事件类型 → CDP type 字符串（§3.2 表）。
pub fn mouse_event_type_name(event_type: MouseEventType) -> &'static str {
    match event_type {
        MouseEventType::Moved => "mouseMoved",
        MouseEventType::Pressed => "mousePressed",
        MouseEventType::Released => "mouseReleased",
        MouseEventType::Wheel => "mouseWheel",
    }
}

/// 键盘事件类型 → CDP type 字符串（§3.3 表）。
pub fn key_event_type_name(event_type: KeyEventType) -> &'static str {
    match event_type {
        KeyEventType::Down => "keyDown",
        KeyEventType::Up => "keyUp",
    }
}

/// 命令 → CDP (method, params)（省略字段不发 null，§3.3 纪律）。
pub fn to_cdp(cmd: &InputCmd) -> (&'static str, Value) {
    match cmd {
        InputCmd::MouseMove {
            x,
            y,
            button,
            buttons,
            modifiers,
        } => {
            let mut p = Map::new();
            p.insert(
                "type".into(),
                json!(mouse_event_type_name(MouseEventType::Moved)),
            );
            p.insert("x".into(), json!(x));
            p.insert("y".into(), json!(y));
            p.insert("button".into(), json!(input_button_name(*button)));
            p.insert("buttons".into(), json!(buttons));
            p.insert("clickCount".into(), json!(0));
            p.insert("modifiers".into(), json!(modifiers));
            (CDP_INPUT_DISPATCH_MOUSE, Value::Object(p))
        }
        InputCmd::MousePress {
            x,
            y,
            button,
            buttons,
            click_count,
            modifiers,
        } => {
            let mut p = Map::new();
            p.insert(
                "type".into(),
                json!(mouse_event_type_name(MouseEventType::Pressed)),
            );
            p.insert("x".into(), json!(x));
            p.insert("y".into(), json!(y));
            p.insert("button".into(), json!(input_button_name(*button)));
            p.insert("buttons".into(), json!(buttons));
            p.insert("clickCount".into(), json!(click_count));
            p.insert("modifiers".into(), json!(modifiers));
            (CDP_INPUT_DISPATCH_MOUSE, Value::Object(p))
        }
        InputCmd::MouseRelease {
            x,
            y,
            button,
            buttons,
            click_count,
            modifiers,
        } => {
            let mut p = Map::new();
            p.insert(
                "type".into(),
                json!(mouse_event_type_name(MouseEventType::Released)),
            );
            p.insert("x".into(), json!(x));
            p.insert("y".into(), json!(y));
            p.insert("button".into(), json!(input_button_name(*button)));
            p.insert("buttons".into(), json!(buttons));
            p.insert("clickCount".into(), json!(click_count));
            p.insert("modifiers".into(), json!(modifiers));
            (CDP_INPUT_DISPATCH_MOUSE, Value::Object(p))
        }
        InputCmd::Wheel {
            x,
            y,
            delta_x,
            delta_y,
            buttons,
            modifiers,
        } => {
            let mut p = Map::new();
            p.insert(
                "type".into(),
                json!(mouse_event_type_name(MouseEventType::Wheel)),
            );
            p.insert("x".into(), json!(x));
            p.insert("y".into(), json!(y));
            p.insert("button".into(), json!("none"));
            p.insert("buttons".into(), json!(buttons));
            p.insert("clickCount".into(), json!(0));
            p.insert("deltaX".into(), json!(delta_x));
            p.insert("deltaY".into(), json!(delta_y));
            p.insert("modifiers".into(), json!(modifiers));
            (CDP_INPUT_DISPATCH_MOUSE, Value::Object(p))
        }
        InputCmd::Scroll {
            x,
            y,
            delta_x,
            delta_y,
            modifiers,
        } => {
            // scroll 与 wheel 同一 CDP 映射（§3.4：触控板双指滚动即 wheel 事件）
            let mut p = Map::new();
            p.insert(
                "type".into(),
                json!(mouse_event_type_name(MouseEventType::Wheel)),
            );
            p.insert("x".into(), json!(x));
            p.insert("y".into(), json!(y));
            p.insert("button".into(), json!("none"));
            p.insert("buttons".into(), json!(0));
            p.insert("clickCount".into(), json!(0));
            p.insert("deltaX".into(), json!(delta_x));
            p.insert("deltaY".into(), json!(delta_y));
            p.insert("modifiers".into(), json!(modifiers));
            (CDP_INPUT_DISPATCH_MOUSE, Value::Object(p))
        }
        InputCmd::KeyDown {
            key,
            code,
            text,
            unmodified_text,
            windows_virtual_key_code,
            native_virtual_key_code,
            auto_repeat,
            modifiers,
            location,
        } => {
            let mut p = Map::new();
            p.insert(
                "type".into(),
                json!(key_event_type_name(KeyEventType::Down)),
            );
            if let Some(v) = key {
                p.insert("key".into(), json!(v));
            }
            if let Some(v) = code {
                p.insert("code".into(), json!(v));
            }
            if let Some(v) = text {
                p.insert("text".into(), json!(v));
            }
            if let Some(v) = unmodified_text {
                p.insert("unmodifiedText".into(), json!(v));
            }
            p.insert(
                "windowsVirtualKeyCode".into(),
                json!(windows_virtual_key_code),
            );
            if let Some(v) = native_virtual_key_code {
                p.insert("nativeVirtualKeyCode".into(), json!(v));
            }
            if *auto_repeat {
                p.insert("autoRepeat".into(), json!(true));
            }
            p.insert("modifiers".into(), json!(modifiers));
            if *location != 0 {
                p.insert("location".into(), json!(location));
            }
            (CDP_INPUT_DISPATCH_KEY, Value::Object(p))
        }
        InputCmd::KeyUp {
            key,
            code,
            windows_virtual_key_code,
            native_virtual_key_code,
            modifiers,
            location,
        } => {
            let mut p = Map::new();
            p.insert("type".into(), json!(key_event_type_name(KeyEventType::Up)));
            if let Some(v) = key {
                p.insert("key".into(), json!(v));
            }
            if let Some(v) = code {
                p.insert("code".into(), json!(v));
            }
            p.insert(
                "windowsVirtualKeyCode".into(),
                json!(windows_virtual_key_code),
            );
            if let Some(v) = native_virtual_key_code {
                p.insert("nativeVirtualKeyCode".into(), json!(v));
            }
            p.insert("modifiers".into(), json!(modifiers));
            if *location != 0 {
                p.insert("location".into(), json!(location));
            }
            (CDP_INPUT_DISPATCH_KEY, Value::Object(p))
        }
        InputCmd::Text { text } => (CDP_INPUT_INSERT_TEXT, json!({ "text": text })),
    }
}

/// CDP Input 域方法名（本模块内部使用；与 action/ops.rs 常量互补）。
const CDP_INPUT_DISPATCH_MOUSE: &str = "Input.dispatchMouseEvent";
const CDP_INPUT_DISPATCH_KEY: &str = "Input.dispatchKeyEvent";
const CDP_INPUT_INSERT_TEXT: &str = "Input.insertText";

#[cfg(test)]
mod tests {
    use super::*;

    /// 鼠标按钮映射表穷举（12 文档 §3.2 表：left/right/middle/back/forward/none）。
    #[test]
    fn mouse_button_mapping_exhaustive() {
        let cases = [
            (InputButton::None, "none"),
            (InputButton::Left, "left"),
            (InputButton::Right, "right"),
            (InputButton::Middle, "middle"),
            (InputButton::Back, "back"),
            (InputButton::Forward, "forward"),
        ];
        for (button, name) in cases {
            assert_eq!(input_button_name(button), name);
        }
    }

    /// 事件类型映射穷举（§3.2/§3.3）。
    #[test]
    fn event_type_mapping_exhaustive() {
        assert_eq!(mouse_event_type_name(MouseEventType::Moved), "mouseMoved");
        assert_eq!(
            mouse_event_type_name(MouseEventType::Pressed),
            "mousePressed"
        );
        assert_eq!(
            mouse_event_type_name(MouseEventType::Released),
            "mouseReleased"
        );
        assert_eq!(mouse_event_type_name(MouseEventType::Wheel), "mouseWheel");
        assert_eq!(key_event_type_name(KeyEventType::Down), "keyDown");
        assert_eq!(key_event_type_name(KeyEventType::Up), "keyUp");
    }

    /// 修饰键位掩码（§3.1：1=Alt 2=Ctrl 4=Meta 8=Shift）与 action 侧 KEY_MAP 一致。
    #[test]
    fn modifier_bits_match_key_map() {
        use crate::action::keyboard::{lookup_key, MOD_ALT, MOD_CTRL, MOD_META, MOD_SHIFT};
        assert_eq!(MOD_SHIFT, 8, "Shift 位 8（§3.1）");
        assert_eq!(MOD_CTRL, 2, "Ctrl 位 2（§3.1）");
        assert_eq!(MOD_ALT, 1, "Alt 位 1（§3.1）");
        assert_eq!(MOD_META, 4, "Meta 位 4（§3.1）");
        // AI 路径键名查表复用 KEY_MAP（12 文档 §4.1：key → Key 查 Playwright 布局）
        assert_eq!(lookup_key("Control").unwrap().modifier_mask, MOD_CTRL);
        assert_eq!(lookup_key("Shift").unwrap().modifier_mask, MOD_SHIFT);
        assert_eq!(lookup_key("Enter").unwrap().vk, 13);
        assert_eq!(lookup_key("ArrowLeft").unwrap().vk, 37);
    }

    /// mouse_move → mouseMoved：button/buttons/clickCount=0/modifiers 全字段。
    #[test]
    fn to_cdp_mouse_move() {
        let (method, params) = to_cdp(&InputCmd::MouseMove {
            x: 12.5,
            y: 30.0,
            button: InputButton::Left,
            buttons: 1,
            modifiers: 2,
        });
        assert_eq!(method, "Input.dispatchMouseEvent");
        assert_eq!(params["type"], "mouseMoved");
        assert_eq!(params["x"], 12.5);
        assert_eq!(params["y"], 30.0);
        assert_eq!(params["button"], "left");
        assert_eq!(params["buttons"], 1);
        assert_eq!(params["clickCount"], 0);
        assert_eq!(params["modifiers"], 2);
        assert!(params.get("deltaX").is_none(), "移动事件不得带 delta");
    }

    /// mouse_press/release：按钮名 + clickCount 透传（§3.2/§3.5）。
    #[test]
    fn to_cdp_mouse_press_release() {
        let (_, params) = to_cdp(&InputCmd::MousePress {
            x: 1.0,
            y: 2.0,
            button: InputButton::Right,
            buttons: 2,
            click_count: 2,
            modifiers: 0,
        });
        assert_eq!(params["type"], "mousePressed");
        assert_eq!(params["button"], "right");
        assert_eq!(params["clickCount"], 2);

        let (_, params) = to_cdp(&InputCmd::MouseRelease {
            x: 1.0,
            y: 2.0,
            button: InputButton::Forward,
            buttons: 18,
            click_count: 1,
            modifiers: 0,
        });
        assert_eq!(params["type"], "mouseReleased");
        assert_eq!(params["button"], "forward");
        assert_eq!(params["buttons"], 18, "多键并集位掩码透传");
    }

    /// wheel 滚动 delta 透传（§3.4：归一化后的像素增量）+ scroll 别名同映射。
    #[test]
    fn to_cdp_wheel_delta_and_scroll_alias() {
        let (method, params) = to_cdp(&InputCmd::Wheel {
            x: 100.0,
            y: 200.0,
            delta_x: -120.0,
            delta_y: 240.0,
            buttons: 0,
            modifiers: 8,
        });
        assert_eq!(method, "Input.dispatchMouseEvent");
        assert_eq!(params["type"], "mouseWheel");
        assert_eq!(params["deltaX"], -120.0);
        assert_eq!(params["deltaY"], 240.0);
        assert_eq!(params["button"], "none");
        assert_eq!(params["modifiers"], 8);

        let (method, params) = to_cdp(&InputCmd::Scroll {
            x: 0.0,
            y: 0.0,
            delta_x: 0.0,
            delta_y: 120.0,
            modifiers: 0,
        });
        assert_eq!(method, "Input.dispatchMouseEvent");
        assert_eq!(params["type"], "mouseWheel", "scroll 与 wheel 同一映射");
        assert_eq!(params["deltaY"], 120.0);
    }

    /// key_down 可打印字符：keyDown + text/unmodifiedText 透传（§3.3）；
    /// 可选字段省略不发 null（CDP null 字符串整个命令失败，§3.3 纪律）。
    #[test]
    fn to_cdp_key_down_printable_omits_null_fields() {
        let (method, params) = to_cdp(&InputCmd::KeyDown {
            key: Some("a".to_string()),
            code: Some("KeyA".to_string()),
            text: Some("a".to_string()),
            unmodified_text: Some("a".to_string()),
            windows_virtual_key_code: 65,
            native_virtual_key_code: None,
            auto_repeat: false,
            modifiers: 0,
            location: 0,
        });
        assert_eq!(method, "Input.dispatchKeyEvent");
        assert_eq!(params["type"], "keyDown");
        assert_eq!(params["key"], "a");
        assert_eq!(params["code"], "KeyA");
        assert_eq!(params["text"], "a");
        assert_eq!(params["unmodifiedText"], "a");
        assert_eq!(params["windowsVirtualKeyCode"], 65);
        assert!(
            params.get("nativeVirtualKeyCode").is_none(),
            "None 字段不得发 null"
        );
        assert!(params.get("autoRepeat").is_none(), "false 省略");
        assert!(params.get("location").is_none(), "0 省略");
    }

    /// key_down 控制键/组合键：text 置空（§3.3：命令和弦不做文本插入）；
    /// autoRepeat/location 真值发送（§3.3：数字小键盘 location=3）。
    #[test]
    fn to_cdp_key_down_control_and_numpad() {
        let (_, params) = to_cdp(&InputCmd::KeyDown {
            key: Some("Control".to_string()),
            code: Some("ControlLeft".to_string()),
            text: None,
            unmodified_text: None,
            windows_virtual_key_code: 17,
            native_virtual_key_code: Some(17),
            auto_repeat: true,
            modifiers: 2,
            location: 0,
        });
        assert_eq!(params["type"], "keyDown");
        assert!(params.get("text").is_none(), "控制键不携带 text");
        assert_eq!(params["autoRepeat"], true);
        assert_eq!(params["nativeVirtualKeyCode"], 17);

        let (_, params) = to_cdp(&InputCmd::KeyDown {
            key: Some("0".to_string()),
            code: Some("Numpad0".to_string()),
            text: Some("0".to_string()),
            unmodified_text: Some("0".to_string()),
            windows_virtual_key_code: 96,
            native_virtual_key_code: None,
            auto_repeat: false,
            modifiers: 0,
            location: 3,
        });
        assert_eq!(params["location"], 3, "数字小键盘 location=3");
    }

    /// key_up：text 置空不发送（§3.3）。
    #[test]
    fn to_cdp_key_up_no_text() {
        let (_, params) = to_cdp(&InputCmd::KeyUp {
            key: Some("a".to_string()),
            code: Some("KeyA".to_string()),
            windows_virtual_key_code: 65,
            native_virtual_key_code: None,
            modifiers: 0,
            location: 0,
        });
        assert_eq!(params["type"], "keyUp");
        assert!(params.get("text").is_none(), "keyUp 不携带 text");
        assert!(params.get("unmodifiedText").is_none());
    }

    /// IME 文本注入（§3.7）：compositionend 整串透传 Input.insertText。
    #[test]
    fn to_cdp_text_insert_text_passthrough() {
        let (method, params) = to_cdp(&InputCmd::Text {
            text: "你好世界🙂".to_string(),
        });
        assert_eq!(method, "Input.insertText");
        assert_eq!(params["text"], "你好世界🙂");
    }
}
