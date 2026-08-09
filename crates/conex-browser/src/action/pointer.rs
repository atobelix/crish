//! 鼠标管线（维度 14 §2.3 表：click/hover/drag/scroll，pointer.rs）
//!
//! - click：mouseMoved → mousePressed → mouseReleased（button/clickCount 透传；
//!   双击 = count 1|2 两次按下/释放序列）；
//! - hover：mouseMoved；
//! - drag：mousePressed(from) → 8 步插值 mouseMoved（拖拽语义需要中间轨迹）→
//!   mouseReleased(to)；
//! - scroll：页面级 = 视口中心 mouseWheel；元素级 = 容器内注入点 mouseWheel
//!   （§3.2 滚动容器路径，方向约定：Up/Down 走 deltaY，Left/Right 走 deltaX）。

use crate::action::{
    ActionError, ActionErrorKind, ActionExecutor, Located, MouseButton, ResolvedPoint, ScrollDir,
};
use crate::cdp::domains::DispatchMouseEventParams;

/// 拖拽插值步数（§2.3：分 8 步 mouseMoved）。
const DRAG_STEPS: usize = 8;

/// 左键拖拽中的按钮位（buttons=1）。
const DRAG_BUTTONS: i32 = 1;

/// 按键 → CDP button 名（§2.3 透传）。
pub fn button_name(button: MouseButton) -> &'static str {
    match button {
        MouseButton::Left => "left",
        MouseButton::Right => "right",
        MouseButton::Middle => "middle",
    }
}

/// 按键 → 按下位（buttons 字段，供拖拽保持）。
pub fn button_flag(button: MouseButton) -> i32 {
    match button {
        MouseButton::Left => 1,
        MouseButton::Right => 2,
        MouseButton::Middle => 4,
    }
}

fn moved(x: f64, y: f64, buttons: i32) -> DispatchMouseEventParams {
    DispatchMouseEventParams {
        event_type: "mouseMoved".to_string(),
        x,
        y,
        button: None,
        buttons: Some(buttons),
        click_count: None,
        delta_x: None,
        delta_y: None,
        modifiers: None,
        pointer_type: None,
    }
}

fn pressed(x: f64, y: f64, button: MouseButton, click_count: i32) -> DispatchMouseEventParams {
    DispatchMouseEventParams {
        event_type: "mousePressed".to_string(),
        x,
        y,
        button: Some(button_name(button).to_string()),
        buttons: Some(button_flag(button)),
        click_count: Some(click_count),
        delta_x: None,
        delta_y: None,
        modifiers: None,
        pointer_type: None,
    }
}

fn released(x: f64, y: f64, button: MouseButton, click_count: i32) -> DispatchMouseEventParams {
    DispatchMouseEventParams {
        event_type: "mouseReleased".to_string(),
        x,
        y,
        button: Some(button_name(button).to_string()),
        buttons: Some(0),
        click_count: Some(click_count),
        delta_x: None,
        delta_y: None,
        modifiers: None,
        pointer_type: None,
    }
}

fn wheel(x: f64, y: f64, delta_x: f64, delta_y: f64) -> DispatchMouseEventParams {
    DispatchMouseEventParams {
        event_type: "mouseWheel".to_string(),
        x,
        y,
        button: None,
        buttons: Some(0),
        click_count: None,
        delta_x: Some(delta_x),
        delta_y: Some(delta_y),
        modifiers: None,
        pointer_type: None,
    }
}

/// click 派发（§2.3：count 1|2，单击/双击；右键走 contextmenu 语义）。
pub async fn dispatch_mouse_click(
    exec: &ActionExecutor,
    point: &ResolvedPoint,
    button: MouseButton,
    count: u8,
) -> Result<(), ActionError> {
    if exec.abort.is_cancelled() {
        return Err(ActionError::new(
            ActionErrorKind::Aborted,
            "用户接管/令牌吊销（点击前）",
        ));
    }
    let count = i32::from(count);
    exec.ops.mouse_event(moved(point.x, point.y, 0)).await?;
    for click_count in 1..=count {
        exec.ops.mouse_event(pressed(point.x, point.y, button, click_count)).await?;
        exec.ops.mouse_event(released(point.x, point.y, button, click_count)).await?;
    }
    Ok(())
}

/// hover 派发（mouseMoved）。
pub async fn dispatch_hover(
    exec: &ActionExecutor,
    point: &ResolvedPoint,
) -> Result<(), ActionError> {
    if exec.abort.is_cancelled() {
        return Err(ActionError::new(
            ActionErrorKind::Aborted,
            "用户接管/令牌吊销（hover 前）",
        ));
    }
    exec.ops.mouse_event(moved(point.x, point.y, 0)).await?;
    Ok(())
}

/// drag 派发（§2.3：press(from) → 8 步插值 moved → release(to)）。
pub async fn dispatch_drag(
    exec: &ActionExecutor,
    from: &ResolvedPoint,
    to: &ResolvedPoint,
) -> Result<(), ActionError> {
    if exec.abort.is_cancelled() {
        return Err(ActionError::new(
            ActionErrorKind::Aborted,
            "用户接管/令牌吊销（拖拽前）",
        ));
    }
    exec.ops
        .mouse_event(pressed(from.x, from.y, MouseButton::Left, 1))
        .await?;
    for step in 1..=DRAG_STEPS {
        if exec.abort.is_cancelled() {
            return Err(ActionError::new(
                ActionErrorKind::Aborted,
                "用户接管/令牌吊销（拖拽步进间）",
            ));
        }
        let t = step as f64 / DRAG_STEPS as f64;
        let x = from.x + (to.x - from.x) * t;
        let y = from.y + (to.y - from.y) * t;
        // 拖拽中保持左键按下（buttons=1）
        exec.ops.mouse_event(moved(x, y, DRAG_BUTTONS)).await?;
    }
    exec.ops
        .mouse_event(released(to.x, to.y, MouseButton::Left, 1))
        .await?;
    Ok(())
}

/// scroll 派发（页面级：视口中心；元素级：容器内注入点）。
pub async fn dispatch_scroll(
    exec: &ActionExecutor,
    located: Option<&Located>,
    dir: ScrollDir,
    amount: i32,
) -> Result<(), ActionError> {
    let point = match located {
        Some(Located::Point { point, .. }) => *point,
        _ => {
            // 页面级滚动：视口中心 + mouseWheel（§2.3）
            let viewport = exec.ops.viewport().await?;
            ResolvedPoint {
                x: viewport.width / 2.0,
                y: viewport.height / 2.0,
            }
        }
    };
    let amount = f64::from(amount);
    // 方向约定：Down → deltaY 正；Up → deltaY 负；Left → deltaX 正（内容左移）；Right → deltaX 负
    let (dx, dy) = match dir {
        ScrollDir::Up => (0.0, -amount),
        ScrollDir::Down => (0.0, amount),
        ScrollDir::Left => (amount, 0.0),
        ScrollDir::Right => (-amount, 0.0),
    };
    exec.ops
        .mouse_event(wheel(point.x, point.y, dx, dy))
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::action::mocks::*;
    use crate::action::{ActionExecutor, ActionOptions, ElementMeta, ElementRef};
    use crate::cdp::sender::CancellationToken;
    use std::sync::Arc;

    fn point(x: f64, y: f64) -> ResolvedPoint {
        ResolvedPoint { x, y }
    }

    /// click：左键单击序列（moved → pressed → released，坐标透传）。
    #[tokio::test]
    async fn click_single_sequence() {
        let ops = MockOps::new();
        let token = CancellationToken::new();
        let exec = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }])),
            token,
        )
        .with_gate(Arc::new(AllowGate))
        .with_delay(Arc::new(RecordingDelay::new()));
        exec.click(&"t1".to_string(), 1, ElementRef { index: 0, backend_node_id: 11 }, MouseButton::Left, 1)
            .await
            .expect("点击应成功");
        let events = ops.calls_of(MockOp::MouseEvent);
        assert_eq!(events.len(), 3);
        assert!(events[0].detail.contains("mouseMoved x=50 y=25"));
        assert!(events[1].detail.contains("mousePressed x=50 y=25 button=left count=1"));
        assert!(events[2].detail.contains("mouseReleased x=50 y=25 button=left count=1"));
    }

    /// 双击：两次按下/释放序列，clickCount 透传 1/2。
    #[tokio::test]
    async fn double_click_sequence() {
        let ops = MockOps::new();
        let token = CancellationToken::new();
        let exec = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }])),
            token,
        )
        .with_gate(Arc::new(AllowGate))
        .with_delay(Arc::new(RecordingDelay::new()));
        exec.click(&"t1".to_string(), 1, ElementRef { index: 0, backend_node_id: 11 }, MouseButton::Left, 2)
            .await
            .expect("双击应成功");
        let events = ops.calls_of(MockOp::MouseEvent);
        assert_eq!(events.len(), 5, "moved + 2×(pressed+released)");
        assert!(events[1].detail.contains("count=1"));
        assert!(events[3].detail.contains("count=2"), "双击第二次 clickCount=2");
    }

    /// 右键：button=right（contextmenu 语义）。
    #[tokio::test]
    async fn right_click_button() {
        let ops = MockOps::new();
        let token = CancellationToken::new();
        let exec = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }])),
            token,
        )
        .with_gate(Arc::new(AllowGate))
        .with_delay(Arc::new(RecordingDelay::new()));
        exec.click(&"t1".to_string(), 1, ElementRef { index: 0, backend_node_id: 11 }, MouseButton::Right, 1)
            .await
            .expect("右键应成功");
        let events = ops.calls_of(MockOp::MouseEvent);
        assert!(events[1].detail.contains("button=right"));
    }

    /// hover：仅 mouseMoved。
    #[tokio::test]
    async fn hover_moves_only() {
        let ops = MockOps::new();
        let token = CancellationToken::new();
        let exec = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }])),
            token,
        )
        .with_gate(Arc::new(AllowGate))
        .with_delay(Arc::new(RecordingDelay::new()));
        exec.hover(&"t1".to_string(), 1, ElementRef { index: 0, backend_node_id: 11 })
            .await
            .expect("hover 应成功");
        let events = ops.calls_of(MockOp::MouseEvent);
        assert_eq!(events.len(), 1);
        assert!(events[0].detail.contains("mouseMoved"));
    }

    /// drag：8 步插值轨迹（含起点 1/8 与终点 8/8），拖拽保持 buttons=1。
    #[tokio::test]
    async fn drag_interpolates_8_steps() {
        let ops = MockOps::new();
        let token = CancellationToken::new();
        let exec = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }])),
            token,
        )
        .with_gate(Arc::new(AllowGate))
        .with_delay(Arc::new(RecordingDelay::new()));
        exec.drag(
            &"t1".to_string(),
            1,
            ElementRef { index: 0, backend_node_id: 11 },
            ElementRef { index: 1, backend_node_id: 21 },
        )
        .await
        .expect("拖拽应成功");
        let events = ops.calls_of(MockOp::MouseEvent);
        assert_eq!(events.len(), 1 + 8 + 1, "press + 8 步 + release");
        assert!(events[0].detail.contains("mousePressed x=50 y=25"));
        // 第 1 步 = 1/8 插值：from(50,25) → to(250,25)
        assert!(events[1].detail.contains("mouseMoved x=75 y=25"), "{}", events[1].detail);
        // 第 8 步 = 终点 (250,25)
        assert!(events[8].detail.contains("mouseMoved x=250 y=25"));
        assert!(events[9].detail.contains("mouseReleased x=250 y=25"));
        // 拖拽中保持 buttons=1
        assert!(events[4].detail.contains("buttons=1"), "{}", events[4].detail);
    }

    /// 页面级滚动：视口中心 + deltaY（down 正 / up 负）。
    #[tokio::test]
    async fn page_scroll_wheel_at_viewport_center() {
        let ops = MockOps::new();
        let token = CancellationToken::new();
        let exec = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }])),
            token,
        )
        .with_gate(Arc::new(AllowGate))
        .with_delay(Arc::new(RecordingDelay::new()));
        exec.scroll(&"t1".to_string(), 1, ScrollDir::Down, 800, None)
            .await
            .expect("页面滚动应成功");
        let events = ops.calls_of(MockOp::MouseEvent);
        assert_eq!(events.len(), 1);
        // 视口 1280x720 → 中心 (640, 360)；wheel 方向：down → deltaY 正
        let d = &events[0].detail;
        assert!(d.contains("mouseWheel") && d.contains("x=640") && d.contains("y=360") && d.contains("deltaY=800"), "{d}");
        exec.scroll(&"t1".to_string(), 1, ScrollDir::Up, 200, None)
            .await
            .expect("上滚应成功");
        assert!(ops.calls_of(MockOp::MouseEvent)[1].detail.contains("deltaY=-200"));
    }

    /// 元素级滚动：容器内注入点滚轮（Left → deltaX 正）。
    #[tokio::test]
    async fn element_scroll_uses_element_point() {
        let ops = MockOps::new();
        let token = CancellationToken::new();
        let exec = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }])),
            token,
        )
        .with_gate(Arc::new(AllowGate))
        .with_delay(Arc::new(RecordingDelay::new()));
        exec.scroll(
            &"t1".to_string(),
            1,
            ScrollDir::Left,
            300,
            Some(ElementRef { index: 0, backend_node_id: 11 }),
        )
        .await
        .expect("元素滚动应成功");
        let events = ops.calls_of(MockOp::MouseEvent);
        assert_eq!(events.len(), 1);
        let d = &events[0].detail;
        assert!(d.contains("mouseWheel") && d.contains("x=50") && d.contains("y=25") && d.contains("deltaX=300"), "{d}");
        // 元素 box 可见时无需 scrollIntoViewIfNeeded（§3.2 仅 box 无效时触发）
        assert_eq!(ops.count(MockOp::ScrollIntoView), 0);
    }

    /// 定位失败：元素无 box（NodeStale）→ click 不派发坐标事件。
    #[tokio::test]
    async fn click_stale_no_dispatch() {
        let ops = MockOps::new();
        ops.state.lock().unwrap().box_models.remove(&111);
        let token = CancellationToken::new();
        let exec = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }])),
            token,
        )
        .with_gate(Arc::new(AllowGate))
        .with_delay(Arc::new(RecordingDelay::new()));
        let err = exec
            .click(&"t1".to_string(), 1, ElementRef { index: 0, backend_node_id: 11 }, MouseButton::Left, 1)
            .await
            .expect_err("应失败");
        assert_eq!(err.kind, ActionErrorKind::NodeStale);
        assert_eq!(ops.count(MockOp::MouseEvent), 0);
    }

    /// 元素级滚动前置校验：scrollIntoView 后 box 仍无效 → NotInteractive（不派发滚轮）。
    #[tokio::test]
    async fn element_scroll_not_interactive() {
        let ops = MockOps::new();
        ops.state.lock().unwrap().box_models.insert(111, crate::cdp::domains::BoxModel {
            content: vec![2000.0, 0.0, 2100.0, 0.0, 2100.0, 50.0, 2000.0, 50.0],
            padding: vec![],
            border: vec![],
            margin: vec![],
            width: 100,
            height: 50,
        });
        let token = CancellationToken::new();
        let exec = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }])),
            token,
        )
        .with_gate(Arc::new(AllowGate))
        .with_delay(Arc::new(RecordingDelay::new()))
        .with_options(ActionOptions {
            not_interactive_wait_ms: 1,
            ..ActionOptions::default()
        });
        let err = exec
            .scroll(
                &"t1".to_string(),
                1,
                ScrollDir::Down,
                100,
                Some(ElementRef { index: 0, backend_node_id: 11 }),
            )
            .await
            .expect_err("应 NotInteractive");
        // 等待可见超时仍归类 NotInteractive（§5.1），额度内两轮定位
        assert_eq!(err.kind, ActionErrorKind::NotInteractive);
        assert_eq!(ops.count(MockOp::MouseEvent), 0, "不可见不得派发滚轮");
        assert_eq!(ops.count(MockOp::ScrollIntoView), 4, "两轮定位 × 各 2 次滚动重试");
    }

    /// 派发中点坐标与插值数学的独立校验（直接调用 dispatch_drag）。
    #[tokio::test]
    async fn drag_math_endpoints() {
        let ops = MockOps::new();
        let token = CancellationToken::new();
        let exec = ActionExecutor::new(
            Arc::new(ops.clone()),
            Arc::new(MockSnapshotStore::with_elements(1, &[ElementMeta {
                backend_node_id: 11,
                is_password: false,
            }])),
            token,
        );
        dispatch_drag(&exec, &point(0.0, 0.0), &point(80.0, 0.0))
            .await
            .expect("拖拽应成功");
        let events = ops.calls_of(MockOp::MouseEvent);
        // 插值步进应为 10 的倍数（80/8=10）
        for (i, event) in events.iter().enumerate().skip(1).take(8) {
            let x = (i as f64) * 10.0;
            assert!(
                event.detail.contains(&format!("x={x}")),
                "第 {i} 步应 x={x}：{}",
                event.detail
            );
        }
    }
}
