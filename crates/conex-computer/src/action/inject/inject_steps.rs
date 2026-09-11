//! 注入步骤枚举与纯函数构建器（步骤构建域 · 对齐 05 详案 D2 inject_steps.rs）

use conex_shared::input::{
    KeyName as SharedKeyName, PhysicalPoint as SharedPoint,
    ScrollDirection as SharedScrollDirection,
};
use enigo::Axis;

use crate::action::{is_modifier_name, CLICK_INTERVAL_MS};

/// 注入原语序列步骤(纯数据:click/scroll/key 的「移动 → 修饰键包裹」顺序
/// 语义可单测断言;执行器按序逐条落到 enigo / SetCursorPos)
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InjectStep {
    /// 绝对移动(物理像素,直连 SetCursorPos)
    MoveTo { x: i32, y: i32 },
    /// 按键按下(归一化键名,经 resolve 解析)
    KeyDown { name: String },
    /// 按键抬起(归一化键名)
    KeyUp { name: String },
    /// 鼠标按压-抬起一次
    ButtonClick { button: enigo::Button },
    /// 滚轮(方向 → 增量符号在构建期确定)
    Wheel { axis: enigo::Axis, amount: i32 },
    /// 等待间隔(毫秒;双击/三击间隔与 hold 时长)
    DelayMs { ms: u64 },
}

/// 构建点击序列(纯函数,05 §4.4 语义):
/// 坐标存在先 MoveTo → 修饰键按序 KeyDown → ButtonClick × times
/// (间隔 DelayMs,≤ 系统双击时间) → 修饰键逆序 KeyUp。
/// 顺序与既有 dispatch 包裹路径一致(先移动后修饰键,lib.rs)。
pub(crate) fn build_click_steps(
    btn: enigo::Button,
    times: u32,
    p: Option<SharedPoint>,
    mods: &[SharedKeyName],
) -> Vec<InjectStep> {
    let mut steps = Vec::new();
    if let Some(p) = p {
        steps.push(InjectStep::MoveTo { x: p.x, y: p.y });
    }
    for m in mods {
        steps.push(InjectStep::KeyDown { name: m.0.clone() });
    }
    for i in 0..times {
        steps.push(InjectStep::ButtonClick { button: btn });
        if i + 1 < times {
            steps.push(InjectStep::DelayMs {
                ms: CLICK_INTERVAL_MS,
            });
        }
    }
    for m in mods.iter().rev() {
        steps.push(InjectStep::KeyUp { name: m.0.clone() });
    }
    steps
}

/// 构建滚动序列(纯函数):坐标先 MoveTo → 修饰键按序 KeyDown →
/// Wheel(方向 → 增量符号) → 修饰键逆序 KeyUp。
pub(crate) fn build_scroll_steps(
    dir: SharedScrollDirection,
    amount: u32,
    p: Option<SharedPoint>,
    mods: &[SharedKeyName],
) -> Vec<InjectStep> {
    let mut steps = Vec::new();
    if let Some(p) = p {
        steps.push(InjectStep::MoveTo { x: p.x, y: p.y });
    }
    for m in mods {
        steps.push(InjectStep::KeyDown { name: m.0.clone() });
    }
    let (axis, signed) = match dir {
        SharedScrollDirection::Up => (Axis::Vertical, -(amount as i32)),
        SharedScrollDirection::Down => (Axis::Vertical, amount as i32),
        SharedScrollDirection::Left => (Axis::Horizontal, -(amount as i32)),
        SharedScrollDirection::Right => (Axis::Horizontal, amount as i32),
    };
    steps.push(InjectStep::Wheel {
        axis,
        amount: signed,
    });
    for m in mods.iter().rev() {
        steps.push(InjectStep::KeyUp { name: m.0.clone() });
    }
    steps
}

/// 构建组合键序列(纯函数,04 §2.1):修饰键按序 KeyDown →
/// 主键 KeyDown[/DelayMs(hold)]/KeyUp → 修饰键逆序 KeyUp。
pub(crate) fn build_key_steps(keys: &[String], hold_ms: Option<u32>) -> Vec<InjectStep> {
    let mut mods = Vec::new();
    let mut main = None;
    for name in keys {
        if is_modifier_name(name) {
            mods.push(name.clone());
        } else if main.is_none() {
            main = Some(name.clone());
        }
    }
    let mut steps = Vec::new();
    for m in &mods {
        steps.push(InjectStep::KeyDown { name: m.clone() });
    }
    if let Some(main) = main {
        steps.push(InjectStep::KeyDown { name: main.clone() });
        if let Some(ms) = hold_ms {
            steps.push(InjectStep::DelayMs { ms: ms as u64 });
        }
        steps.push(InjectStep::KeyUp { name: main });
    }
    for m in mods.iter().rev() {
        steps.push(InjectStep::KeyUp { name: m.clone() });
    }
    steps
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_shared::input::{KeyName as SharedKeyName, PhysicalPoint as SharedPoint};
    use enigo::{Axis, Button};

    fn p(x: i32, y: i32) -> SharedPoint {
        SharedPoint { x, y }
    }

    fn kn(name: &str) -> SharedKeyName {
        SharedKeyName(name.to_string())
    }

    #[test]
    fn click_steps_coord_moves_first_then_mods_wrapped() {
        let steps = build_click_steps(Button::Left, 1, Some(p(100, 200)), &[kn("ctrl")]);
        assert_eq!(
            steps,
            vec![
                InjectStep::MoveTo { x: 100, y: 200 },
                InjectStep::KeyDown {
                    name: "ctrl".to_string()
                },
                InjectStep::ButtonClick {
                    button: Button::Left
                },
                InjectStep::KeyUp {
                    name: "ctrl".to_string()
                },
            ]
        );
    }

    #[test]
    fn click_steps_without_coords_no_move() {
        let steps = build_click_steps(Button::Left, 1, None, &[]);
        assert_eq!(
            steps,
            vec![InjectStep::ButtonClick {
                button: Button::Left
            }]
        );
    }

    #[test]
    fn click_steps_double_generates_interval_delay() {
        let steps = build_click_steps(Button::Right, 2, None, &[]);
        assert_eq!(
            steps,
            vec![
                InjectStep::ButtonClick {
                    button: Button::Right
                },
                InjectStep::DelayMs {
                    ms: CLICK_INTERVAL_MS
                },
                InjectStep::ButtonClick {
                    button: Button::Right
                },
            ]
        );
    }

    #[test]
    fn click_steps_triple_generates_two_delays() {
        let steps = build_click_steps(Button::Left, 3, None, &[]);
        assert_eq!(steps.len(), 5);
        assert_eq!(
            steps[0],
            InjectStep::ButtonClick {
                button: Button::Left
            }
        );
        assert_eq!(
            steps[2],
            InjectStep::ButtonClick {
                button: Button::Left
            }
        );
        assert_eq!(
            steps[4],
            InjectStep::ButtonClick {
                button: Button::Left
            }
        );
        assert_eq!(
            steps[1],
            InjectStep::DelayMs {
                ms: CLICK_INTERVAL_MS
            }
        );
        assert_eq!(
            steps[3],
            InjectStep::DelayMs {
                ms: CLICK_INTERVAL_MS
            }
        );
    }

    #[test]
    fn click_steps_multi_mods_press_order_release_reverse() {
        let steps = build_click_steps(Button::Left, 1, None, &[kn("ctrl"), kn("alt")]);
        assert_eq!(
            steps,
            vec![
                InjectStep::KeyDown {
                    name: "ctrl".to_string()
                },
                InjectStep::KeyDown {
                    name: "alt".to_string()
                },
                InjectStep::ButtonClick {
                    button: Button::Left
                },
                InjectStep::KeyUp {
                    name: "alt".to_string()
                },
                InjectStep::KeyUp {
                    name: "ctrl".to_string()
                },
            ]
        );
    }

    #[test]
    fn scroll_steps_move_mods_wheel_wrapped() {
        let steps = build_scroll_steps(
            SharedScrollDirection::Down,
            3,
            Some(p(5, 6)),
            &[kn("shift")],
        );
        assert_eq!(
            steps,
            vec![
                InjectStep::MoveTo { x: 5, y: 6 },
                InjectStep::KeyDown {
                    name: "shift".to_string()
                },
                InjectStep::Wheel {
                    axis: Axis::Vertical,
                    amount: 3
                },
                InjectStep::KeyUp {
                    name: "shift".to_string()
                },
            ]
        );
    }

    #[test]
    fn scroll_steps_direction_sign_mapping() {
        let up = build_scroll_steps(SharedScrollDirection::Up, 4, None, &[]);
        assert_eq!(
            up[0],
            InjectStep::Wheel {
                axis: Axis::Vertical,
                amount: -4
            }
        );
        let left = build_scroll_steps(SharedScrollDirection::Left, 2, None, &[]);
        assert_eq!(
            left[0],
            InjectStep::Wheel {
                axis: Axis::Horizontal,
                amount: -2
            }
        );
        let right = build_scroll_steps(SharedScrollDirection::Right, 2, None, &[]);
        assert_eq!(
            right[0],
            InjectStep::Wheel {
                axis: Axis::Horizontal,
                amount: 2
            }
        );
    }

    #[test]
    fn key_steps_mods_order_and_reverse_release() {
        let steps = build_key_steps(
            &["ctrl".to_string(), "alt".to_string(), "c".to_string()],
            None,
        );
        assert_eq!(
            steps,
            vec![
                InjectStep::KeyDown {
                    name: "ctrl".to_string()
                },
                InjectStep::KeyDown {
                    name: "alt".to_string()
                },
                InjectStep::KeyDown {
                    name: "c".to_string()
                },
                InjectStep::KeyUp {
                    name: "c".to_string()
                },
                InjectStep::KeyUp {
                    name: "alt".to_string()
                },
                InjectStep::KeyUp {
                    name: "ctrl".to_string()
                },
            ]
        );
    }

    #[test]
    fn key_steps_hold_ms_inserts_delay_between_down_up() {
        let steps = build_key_steps(&["a".to_string()], Some(500));
        assert_eq!(
            steps,
            vec![
                InjectStep::KeyDown {
                    name: "a".to_string()
                },
                InjectStep::DelayMs { ms: 500 },
                InjectStep::KeyUp {
                    name: "a".to_string()
                },
            ]
        );
    }
}
