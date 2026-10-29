//! 面板输入路由：camelCase 契约 / move 合并 / 序保真 / 键盘与 IME 直通。

use super::*;
use serde_json::json;

fn mouse(kind: InputEventKind, action: &str, x: f64, y: f64) -> BrowserInputEvent {
    BrowserInputEvent {
        kind,
        action: Some(action.to_string()),
        x: Some(x),
        y: Some(y),
        button: Some("left".to_string()),
        buttons: Some(1),
        click_count: Some(1),
        delta_x: None,
        delta_y: None,
        modifiers: Some(0),
        key: None,
        code: None,
        text: None,
        windows_virtual_key_code: None,
        native_virtual_key_code: None,
        auto_repeat: None,
        location: None,
    }
}

/// 命令载荷 camelCase 反序列化契约（前端 → Rust 字段面）。
#[test]
fn browser_input_event_deserializes_camel_case() {
    let evt: BrowserInputEvent = serde_json::from_value(json!({
        "kind": "mouse",
        "action": "down",
        "x": 12.5,
        "y": 34.5,
        "button": "left",
        "buttons": 1,
        "clickCount": 2,
        "modifiers": 8
    }))
    .expect("camelCase 反序列化");
    assert_eq!(evt.kind, InputEventKind::Mouse);
    assert_eq!(evt.action.as_deref(), Some("down"));
    assert_eq!(evt.click_count, Some(2));
    assert_eq!(evt.modifiers, Some(8));
    assert!(evt.key.is_none(), "mouse 事件键盘字段缺省");

    let key: BrowserInputEvent = serde_json::from_value(json!({
        "kind": "key",
        "action": "up",
        "key": "a",
        "code": "KeyA",
        "windowsVirtualKeyCode": 65,
        "autoRepeat": false
    }))
    .expect("键盘事件反序列化");
    assert_eq!(key.kind, InputEventKind::Key);
    assert_eq!(key.windows_virtual_key_code, Some(65));
}

/// 高频节流：N 次 move 合并为 1 次 flush（最新优先，未消费旧帧丢弃）。
#[test]
fn move_events_are_coalesced_last_wins() {
    let mut c = Coalescer::default();
    // 同一合并窗内连发 5 次 move（坐标递增）→ 不产出（积压在 pending）
    for i in 0..5u64 {
        let cmds = c.route(&mouse(InputEventKind::Mouse, "move", i as f64, i as f64));
        assert!(cmds.is_empty(), "move 必须积压不直通");
    }
    let cmds = c.flush();
    assert_eq!(cmds.len(), 1, "5 次 move 必须合并为 1 次派发");
    match &cmds[0] {
        InputCmd::MouseMove {
            x,
            y,
            button,
            buttons,
            ..
        } => {
            assert_eq!(*x, 4.0, "取最后一次坐标");
            assert_eq!(*y, 4.0);
            assert_eq!(*button, InputButton::Left);
            assert_eq!(*buttons, 1);
        }
        other => panic!("应为 MouseMove：{other:?}"),
    }
    assert!(c.flush().is_empty(), "二次 flush 无积压");
}

/// 事件序保真：down 前先 flush 积压 move（press 先于 move 送达）。
#[test]
fn press_flushes_pending_move_first() {
    let mut c = Coalescer::default();
    c.route(&mouse(InputEventKind::Mouse, "move", 10.0, 20.0));
    let cmds = c.route(&mouse(InputEventKind::Mouse, "down", 10.0, 20.0));
    assert_eq!(cmds.len(), 2, "move + down 一次产出（down 触发立即 flush）");
    assert_eq!(
        cmds[0],
        InputCmd::MouseMove {
            x: 10.0,
            y: 20.0,
            button: InputButton::Left,
            buttons: 1,
            modifiers: 0,
        },
        "先派发积压 move"
    );
    assert_eq!(
        cmds[1],
        InputCmd::MousePress {
            x: 10.0,
            y: 20.0,
            button: InputButton::Left,
            buttons: 1,
            click_count: 1,
            modifiers: 0,
        },
        "再派发 press"
    );
}

/// wheel 合并：同一窗内 delta 累加为一次注入（12 §3.4）。
#[test]
fn wheel_deltas_accumulate_in_window() {
    let mut c = Coalescer::default();
    for _ in 0..3 {
        let evt = BrowserInputEvent {
            kind: InputEventKind::Wheel,
            action: None,
            x: Some(5.0),
            y: Some(6.0),
            button: None,
            buttons: None,
            click_count: None,
            delta_x: Some(10.0),
            delta_y: Some(-20.0),
            modifiers: Some(2),
            key: None,
            code: None,
            text: None,
            windows_virtual_key_code: None,
            native_virtual_key_code: None,
            auto_repeat: None,
            location: None,
        };
        assert!(c.route(&evt).is_empty(), "wheel 必须积压不直通");
    }
    let cmds = c.flush();
    assert_eq!(cmds.len(), 1, "3 次 wheel 必须合并为 1 次注入");
    match &cmds[0] {
        InputCmd::Wheel {
            delta_x,
            delta_y,
            modifiers,
            buttons,
            ..
        } => {
            assert_eq!(*delta_x, 30.0, "deltaX 累加");
            assert_eq!(*delta_y, -60.0, "deltaY 累加");
            assert_eq!(*modifiers, 2, "modifiers 取最新（ctrl 缩放语义保留）");
            assert_eq!(*buttons, 0, "wheel 位掩码缺省 0");
        }
        other => panic!("应为 Wheel：{other:?}"),
    }
}

/// 键盘/文本直通（不合并）+ keyup 语义 + IME 文本整串注入。
#[test]
fn key_and_text_pass_through() {
    let mut c = Coalescer::default();
    let mut cmds = c.route(&BrowserInputEvent {
        kind: InputEventKind::Key,
        action: Some("down".to_string()),
        x: None,
        y: None,
        button: None,
        buttons: None,
        click_count: None,
        delta_x: None,
        delta_y: None,
        modifiers: Some(2),
        key: Some("a".to_string()),
        code: Some("KeyA".to_string()),
        text: Some("a".to_string()),
        windows_virtual_key_code: Some(65),
        native_virtual_key_code: Some(65),
        auto_repeat: Some(false),
        location: Some(0),
    });
    cmds.extend(c.route(&BrowserInputEvent {
        kind: InputEventKind::Key,
        action: Some("up".to_string()),
        x: None,
        y: None,
        button: None,
        buttons: None,
        click_count: None,
        delta_x: None,
        delta_y: None,
        modifiers: Some(0),
        key: Some("a".to_string()),
        code: Some("KeyA".to_string()),
        text: None,
        windows_virtual_key_code: Some(65),
        native_virtual_key_code: None,
        auto_repeat: None,
        location: None,
    }));
    cmds.extend(c.route(&BrowserInputEvent {
        kind: InputEventKind::Text,
        action: None,
        x: None,
        y: None,
        button: None,
        buttons: None,
        click_count: None,
        delta_x: None,
        delta_y: None,
        modifiers: None,
        key: None,
        code: None,
        text: Some("你好".to_string()),
        windows_virtual_key_code: None,
        native_virtual_key_code: None,
        auto_repeat: None,
        location: None,
    }));
    assert_eq!(cmds.len(), 3, "离散事件直通不合并");
    assert_eq!(
        cmds[0],
        InputCmd::KeyDown {
            key: Some("a".to_string()),
            code: Some("KeyA".to_string()),
            text: Some("a".to_string()),
            unmodified_text: Some("a".to_string()),
            windows_virtual_key_code: 65,
            native_virtual_key_code: Some(65),
            auto_repeat: false,
            modifiers: 2,
            location: 0,
        }
    );
    assert_eq!(
        cmds[1],
        InputCmd::KeyUp {
            key: Some("a".to_string()),
            code: Some("KeyA".to_string()),
            windows_virtual_key_code: 65,
            native_virtual_key_code: None,
            modifiers: 0,
            location: 0,
        }
    );
    assert_eq!(
        cmds[2],
        InputCmd::Text {
            text: "你好".to_string()
        }
    );
}

/// 空合成文本（合成取消，Esc）→ 不注入（12 §3.7 兜底语义，P1-B2 消费面）。
#[test]
fn empty_insert_text_skipped() {
    let mut c = Coalescer::default();
    let cmds = c.route(&BrowserInputEvent {
        kind: InputEventKind::Text,
        action: None,
        x: None,
        y: None,
        button: None,
        buttons: None,
        click_count: None,
        delta_x: None,
        delta_y: None,
        modifiers: None,
        key: None,
        code: None,
        text: Some("".to_string()),
        windows_virtual_key_code: None,
        native_virtual_key_code: None,
        auto_repeat: None,
        location: None,
    });
    assert!(cmds.is_empty(), "空文本不得注入");
}

/// 未知 mouse action → 忽略（宽容解析，不 panic）。
#[test]
fn unknown_mouse_action_ignored() {
    let mut c = Coalescer::default();
    let cmds = c.route(&mouse(InputEventKind::Mouse, "hover", 1.0, 2.0));
    assert!(cmds.is_empty());
}

/// 按钮映射（12 §3.2：left/right/middle/back/forward；非法值收敛 none）。
#[test]
fn button_mapping_table() {
    assert_eq!(map_button(Some("left")), InputButton::Left);
    assert_eq!(map_button(Some("right")), InputButton::Right);
    assert_eq!(map_button(Some("middle")), InputButton::Middle);
    assert_eq!(map_button(Some("back")), InputButton::Back);
    assert_eq!(map_button(Some("forward")), InputButton::Forward);
    assert_eq!(
        map_button(Some("joystick")),
        InputButton::None,
        "非法值收敛 none"
    );
    assert_eq!(map_button(None), InputButton::None);
}

/// 管线未接线（浏览器停止后）：路由/合并照常（不 panic），派发丢弃。
#[tokio::test]
async fn unwired_pipeline_drops() {
    let router = Arc::new(PanelInputRouter::new().with_flush_ms(Duration::from_millis(20)));
    assert!(!router.pipeline_wired(), "未接线判定");
    router.route(&mouse(InputEventKind::Mouse, "move", 1.0, 2.0));
    router.route(&mouse(InputEventKind::Mouse, "down", 1.0, 2.0));
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert!(!router.pipeline_wired());
}
