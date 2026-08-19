//! 键名→enigo 映射与按钮映射（键映射域）

use crate::action::MouseButton as ActionMouseButton;
use conex_shared::input::MouseButton as SharedMouseButton;

/// 功能键编号 → enigo 键码(F1-F24,enigo 为独立变体)
pub(crate) fn function_key(n: u8) -> Option<enigo::Key> {
    use enigo::Key;
    Some(match n {
        1 => Key::F1,
        2 => Key::F2,
        3 => Key::F3,
        4 => Key::F4,
        5 => Key::F5,
        6 => Key::F6,
        7 => Key::F7,
        8 => Key::F8,
        9 => Key::F9,
        10 => Key::F10,
        11 => Key::F11,
        12 => Key::F12,
        13 => Key::F13,
        14 => Key::F14,
        15 => Key::F15,
        16 => Key::F16,
        17 => Key::F17,
        18 => Key::F18,
        19 => Key::F19,
        20 => Key::F20,
        21 => Key::F21,
        22 => Key::F22,
        23 => Key::F23,
        24 => Key::F24,
        _ => return None,
    })
}

/// 本地按键 → enigo 键码(动作面三键)
pub(crate) fn to_enigo_button(button: ActionMouseButton) -> enigo::Button {
    use enigo::Button;
    match button {
        ActionMouseButton::Left => Button::Left,
        ActionMouseButton::Middle => Button::Middle,
        ActionMouseButton::Right => Button::Right,
    }
}

/// 共享层按键 → enigo 键码(含侧键 Back/Forward,S6 对齐扩展)
pub(crate) fn to_enigo_button_shared(button: SharedMouseButton) -> enigo::Button {
    use enigo::Button;
    match button {
        SharedMouseButton::Left => Button::Left,
        SharedMouseButton::Middle => Button::Middle,
        SharedMouseButton::Right => Button::Right,
        SharedMouseButton::Back => Button::Back,
        SharedMouseButton::Forward => Button::Forward,
    }
}

/// 键名 → enigo 键码（归一化键名解析，供 OsInputBackend::resolve 委托）
pub(crate) fn resolve_key(name: &str) -> Option<enigo::Key> {
    use enigo::Key;
    match name {
        "ctrl" => Some(Key::Control),
        "alt" => Some(Key::Alt),
        "shift" => Some(Key::Shift),
        "win" => Some(Key::Meta),
        "enter" => Some(Key::Return),
        "tab" => Some(Key::Tab),
        "space" => Some(Key::Space),
        "backspace" => Some(Key::Backspace),
        "delete" => Some(Key::Delete),
        "escape" => Some(Key::Escape),
        "arrow_up" => Some(Key::UpArrow),
        "arrow_down" => Some(Key::DownArrow),
        "arrow_left" => Some(Key::LeftArrow),
        "arrow_right" => Some(Key::RightArrow),
        "home" => Some(Key::Home),
        "end" => Some(Key::End),
        "page_up" => Some(Key::PageUp),
        "page_down" => Some(Key::PageDown),
        "caps_lock" => Some(Key::CapsLock),
        "insert" => Some(Key::Insert),
        "pause" => Some(Key::Pause),
        // Windows 平台上 enigo 的滚动锁定键为 `Scroll` 变体
        // (ScrollLock 仅 unix 平台存在)
        "scroll_lock" => Some(Key::Scroll),
        "num_lock" => Some(Key::Numlock),
        _ => {
            let mut chars = name.chars();
            let first = chars.next()?;
            if chars.next().is_none() {
                if let Some(digit) = first.to_digit(10) {
                    let vk = digit as u8;
                    return Some(match vk {
                        0 => Key::Num0,
                        1 => Key::Num1,
                        2 => Key::Num2,
                        3 => Key::Num3,
                        4 => Key::Num4,
                        5 => Key::Num5,
                        6 => Key::Num6,
                        7 => Key::Num7,
                        8 => Key::Num8,
                        9 => Key::Num9,
                        _ => return None,
                    });
                }
                if first.is_ascii_alphabetic() {
                    let letter = first.to_ascii_uppercase();
                    return Some(match letter {
                        'A' => Key::A,
                        'B' => Key::B,
                        'C' => Key::C,
                        'D' => Key::D,
                        'E' => Key::E,
                        'F' => Key::F,
                        'G' => Key::G,
                        'H' => Key::H,
                        'I' => Key::I,
                        'J' => Key::J,
                        'K' => Key::K,
                        'L' => Key::L,
                        'M' => Key::M,
                        'N' => Key::N,
                        'O' => Key::O,
                        'P' => Key::P,
                        'Q' => Key::Q,
                        'R' => Key::R,
                        'S' => Key::S,
                        'T' => Key::T,
                        'U' => Key::U,
                        'V' => Key::V,
                        'W' => Key::W,
                        'X' => Key::X,
                        'Y' => Key::Y,
                        'Z' => Key::Z,
                        _ => return None,
                    });
                }
            }
            if let Some(f) = name.strip_prefix('f') {
                if let Ok(n) = f.parse::<u8>() {
                    return function_key(n);
                }
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::action::{MouseButton};
    use conex_shared::input::MouseButton as SharedMouseButton;
    use enigo::Button;

    #[test]
    fn shared_button_mapping_covers_side_buttons() {
        assert_eq!(
            to_enigo_button_shared(SharedMouseButton::Left),
            Button::Left
        );
        assert_eq!(
            to_enigo_button_shared(SharedMouseButton::Middle),
            Button::Middle
        );
        assert_eq!(
            to_enigo_button_shared(SharedMouseButton::Right),
            Button::Right
        );
        assert_eq!(
            to_enigo_button_shared(SharedMouseButton::Back),
            Button::Back
        );
        assert_eq!(
            to_enigo_button_shared(SharedMouseButton::Forward),
            Button::Forward
        );
        // 动作面三键映射
        assert_eq!(to_enigo_button(MouseButton::Left), Button::Left);
        assert_eq!(to_enigo_button(MouseButton::Middle), Button::Middle);
        assert_eq!(to_enigo_button(MouseButton::Right), Button::Right);
        // 保持与原始 resolve 的一致性
        assert!(resolve_key("ctrl").is_some());
        assert!(resolve_key("a").is_some());
    }

    #[test]
    fn resolve_key_covers_digits_and_letters() {
        assert_eq!(resolve_key("0"), Some(enigo::Key::Num0));
        assert_eq!(resolve_key("9"), Some(enigo::Key::Num9));
        assert_eq!(resolve_key("a"), Some(enigo::Key::A));
        assert_eq!(resolve_key("z"), Some(enigo::Key::Z));
        assert_eq!(resolve_key("f1"), Some(enigo::Key::F1));
        assert_eq!(resolve_key("f24"), Some(enigo::Key::F24));
        assert_eq!(resolve_key("bogus"), None);
    }
}
