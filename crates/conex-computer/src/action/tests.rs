use super::*;
use crate::coord::ScaleSpec;

fn scale_16x9() -> ScaleSpec {
    ScaleSpec::new(0, 0, 2560, 1440, 1366, 768)
}

#[test]
fn validate_key_empty_rejected() {
    let action = Action::Key { keys: vec![] };
    assert!(matches!(
        action.validate(&scale_16x9()),
        Err(ActionError::InvalidParams(_))
    ));
}

#[test]
fn validate_key_unknown_rejected() {
    let action = Action::Key {
        keys: vec!["ctrll".to_string()],
    };
    assert!(matches!(
        action.validate(&scale_16x9()),
        Err(ActionError::InvalidParams(_))
    ));
}

#[test]
fn validate_key_two_plain_keys_rejected() {
    // 组合键只允许一个非修饰键(04 §2.1 数组语义)
    let action = Action::Key {
        keys: vec!["a".to_string(), "b".to_string()],
    };
    assert!(matches!(
        action.validate(&scale_16x9()),
        Err(ActionError::InvalidParams(_))
    ));
}

#[test]
fn validate_key_ok() {
    let combos = [
        vec!["ctrl".to_string(), "c".to_string()],
        vec!["alt".to_string(), "shift".to_string(), "tab".to_string()],
        vec!["ctrl".to_string(), "alt".to_string(), "delete".to_string()],
    ];
    for keys in combos {
        assert!(
            Action::Key { keys }.validate(&scale_16x9()).is_ok(),
            "合法组合键应通过"
        );
    }
}

#[test]
fn validate_key_overlong_rejected() {
    let keys = (0..=MAX_KEYS_IN_COMBO)
        .map(|_| "ctrl".to_string())
        .collect::<Vec<_>>();
    let action = Action::Key { keys };
    assert!(matches!(
        action.validate(&scale_16x9()),
        Err(ActionError::InvalidParams(_))
    ));
}

#[test]
fn validate_type_empty_rejected() {
    let action = Action::Type {
        text: String::new(),
    };
    assert!(matches!(
        action.validate(&scale_16x9()),
        Err(ActionError::InvalidParams(_))
    ));
}

#[test]
fn validate_type_overlong_rejected() {
    let text = "a".repeat(MAX_TYPE_CHARS + 1);
    let action = Action::Type { text };
    assert!(matches!(
        action.validate(&scale_16x9()),
        Err(ActionError::InvalidParams(_))
    ));
}

#[test]
fn validate_type_nul_rejected() {
    let action = Action::Type {
        text: "abc\0def".to_string(),
    };
    assert!(matches!(
        action.validate(&scale_16x9()),
        Err(ActionError::InvalidParams(_))
    ));
}

#[test]
fn validate_type_ok() {
    let action = Action::Type {
        text: "中文 input 测试 ❤️".to_string(),
    };
    assert!(action.validate(&scale_16x9()).is_ok());
}

#[test]
fn validate_mouse_move_negative_coordinate_rejected() {
    let action = Action::MouseMove {
        coordinate: Point::new(-1, 0),
    };
    assert!(matches!(
        action.validate(&scale_16x9()),
        Err(ActionError::InvalidParams(_))
    ));
}

#[test]
fn validate_mouse_move_out_of_bounds_rejected() {
    let action = Action::MouseMove {
        coordinate: Point::new(1367, 0),
    };
    assert!(matches!(
        action.validate(&scale_16x9()),
        Err(ActionError::CoordsOutOfBounds)
    ));
}

#[test]
fn validate_mouse_move_ok() {
    let action = Action::MouseMove {
        coordinate: Point::new(683, 384),
    };
    assert!(action.validate(&scale_16x9()).is_ok());
}

#[test]
fn validate_drag_endpoints() {
    // 起点负坐标 → 非法参数
    let action = Action::Drag {
        start_coordinate: Point::new(-5, 0),
        coordinate: Point::new(100, 100),
    };
    assert!(matches!(
        action.validate(&scale_16x9()),
        Err(ActionError::InvalidParams(_))
    ));
    // 终点越界 → 坐标越界
    let action = Action::Drag {
        start_coordinate: Point::new(0, 0),
        coordinate: Point::new(9999, 9999),
    };
    assert!(matches!(
        action.validate(&scale_16x9()),
        Err(ActionError::CoordsOutOfBounds)
    ));
    // 合法
    let action = Action::Drag {
        start_coordinate: Point::new(100, 100),
        coordinate: Point::new(200, 200),
    };
    assert!(action.validate(&scale_16x9()).is_ok());
}

#[test]
fn validate_hold_key_duration() {
    // 0 与负值拒绝
    for bad in [-1.0, 0.0] {
        let action = Action::HoldKey {
            key: "a".to_string(),
            duration_secs: bad,
        };
        assert!(
            matches!(
                action.validate(&scale_16x9()),
                Err(ActionError::InvalidParams(_))
            ),
            "时长 {bad} 应拒绝"
        );
    }
    // 超过 100s 拒绝
    let action = Action::HoldKey {
        key: "a".to_string(),
        duration_secs: 100.5,
    };
    assert!(matches!(
        action.validate(&scale_16x9()),
        Err(ActionError::InvalidParams(_))
    ));
    // 边界 100.0 允许(04 §2.1 上限 100s)
    let action = Action::HoldKey {
        key: "a".to_string(),
        duration_secs: 100.0,
    };
    assert!(action.validate(&scale_16x9()).is_ok());
    // 未知键名拒绝
    let action = Action::HoldKey {
        key: "not-a-key".to_string(),
        duration_secs: 1.0,
    };
    assert!(matches!(
        action.validate(&scale_16x9()),
        Err(ActionError::InvalidParams(_))
    ));
}

#[test]
fn validate_scroll_params() {
    // 非法修饰键拒绝
    let action = Action::Scroll {
        direction: ScrollDirection::Down,
        amount: 3,
        coordinate: None,
        modifiers: vec!["foo".to_string()],
    };
    assert!(matches!(
        action.validate(&scale_16x9()),
        Err(ActionError::InvalidParams(_))
    ));
    // 坐标越界拒绝
    let action = Action::Scroll {
        direction: ScrollDirection::Down,
        amount: 3,
        coordinate: Some(Point::new(2000, 0)),
        modifiers: vec![],
    };
    assert!(matches!(
        action.validate(&scale_16x9()),
        Err(ActionError::CoordsOutOfBounds)
    ));
    // 合法(amount=0 按 04 非负整数语义放行)
    let action = Action::Scroll {
        direction: ScrollDirection::Down,
        amount: 0,
        coordinate: None,
        modifiers: vec!["shift".to_string()],
    };
    assert!(action.validate(&scale_16x9()).is_ok());
}

#[test]
fn validate_click_params() {
    // ctrl+click 合法
    let action = Action::Click {
        button: MouseButton::Left,
        count: ClickCount::Single,
        coordinate: Some(Point::new(100, 100)),
        modifiers: vec!["ctrl".to_string()],
    };
    assert!(action.validate(&scale_16x9()).is_ok());
    // 越界坐标拒绝
    let action = Action::Click {
        button: MouseButton::Left,
        count: ClickCount::Single,
        coordinate: Some(Point::new(-1, 0)),
        modifiers: vec![],
    };
    assert!(matches!(
        action.validate(&scale_16x9()),
        Err(ActionError::InvalidParams(_))
    ));
}

#[test]
fn validate_cursor_position_ok() {
    assert!(Action::CursorPosition.validate(&scale_16x9()).is_ok());
}

#[test]
fn is_valid_key_name_covers_spec() {
    // 04 §2.4 键名规范全覆盖
    let spec_names = [
        "ctrl",
        "alt",
        "shift",
        "win",
        "a",
        "z",
        "0",
        "9",
        "f1",
        "f12",
        "f24",
        "enter",
        "tab",
        "space",
        "backspace",
        "delete",
        "escape",
        "arrow_up",
        "arrow_down",
        "arrow_left",
        "arrow_right",
        "home",
        "end",
        "page_up",
        "page_down",
        "caps_lock",
    ];
    for name in spec_names {
        assert!(is_valid_key_name(name), "规范键名 {name} 应合法");
    }
    // 扩展键
    for name in ["insert", "pause", "scroll_lock", "num_lock"] {
        assert!(is_valid_key_name(name));
    }
    // 非法键名
    for name in ["f25", "bogus", "ctrl+a", "", "ü"] {
        assert!(!is_valid_key_name(name), "非法键名 {name} 应拒绝");
    }
}

#[test]
fn chunk_text_groups_by_chars() {
    // 42 中文 → 1 块
    let text = "中".repeat(42);
    let chunks = chunk_text(&text, TYPING_GROUP_SIZE);
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].chars().count(), 42);
    // 86 → 2 块(50 + 36)
    let text = "a".repeat(86);
    let chunks = chunk_text(&text, TYPING_GROUP_SIZE);
    assert_eq!(chunks.len(), 2);
    assert_eq!(chunks[0].chars().count(), 50);
    assert_eq!(chunks[1].chars().count(), 36);
    // emoji 代理对不被截断:"❤️🙂" 为 3 个 char(❤=1 + VS16=1 + 🙂=1),
    // 30 次重复 = 90 字符,分块后字符总数不变
    let text = "❤️🙂".repeat(30);
    let chunks = chunk_text(&text, TYPING_GROUP_SIZE);
    assert_eq!(chunks.iter().map(|c| c.chars().count()).sum::<usize>(), 90);
    // 空文本 → 空数组
    assert!(chunk_text("", TYPING_GROUP_SIZE).is_empty());
    // 组大小 0 防御
    assert!(chunk_text("abc", 0).is_empty());
}

#[test]
fn action_serde_roundtrip() {
    let action = Action::Click {
        button: MouseButton::Right,
        count: ClickCount::Double,
        coordinate: Some(Point::new(10, 20)),
        modifiers: vec!["ctrl".to_string()],
    };
    let json = serde_json::to_string(&action).expect("序列化失败");
    let back: Action = serde_json::from_str(&json).expect("反序列化失败");
    assert_eq!(action, back);
}

#[test]
#[cfg(windows)]
fn adversarial_computer_stop_5ms_response() {
    use crate::action::inject::{run_steps_guarded, InjectStep};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let aborted = Arc::new(AtomicBool::new(false));
    let mut enigo = enigo::Enigo::new(&enigo::Settings::default()).unwrap();
    let steps = vec![
        InjectStep::DelayMs { ms: 200 },
        InjectStep::DelayMs { ms: 200 },
    ];

    let aborted_clone = aborted.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(15));
        aborted_clone.store(true, Ordering::SeqCst);
    });

    let start = std::time::Instant::now();
    let flag = aborted.clone();
    let res = run_steps_guarded(&mut enigo, &steps, move || flag.load(Ordering::SeqCst));
    let elapsed = start.elapsed();

    assert!(res.is_err(), "注入必须被停止中断");
    assert!(
        elapsed.as_millis() < 80,
        "停止响应延迟必须 <= 5ms（实际总耗时 {}ms）",
        elapsed.as_millis()
    );
}
