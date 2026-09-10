//! 共享层 InputBackend 对齐（分发域）

use async_trait::async_trait;
use conex_shared::input::{
    ClickCount as SharedClickCount, InputBackend, InputBackendError, KeyName as SharedKeyName,
    MouseButton as SharedMouseButton, PhysicalPoint as SharedPoint,
    ScrollDirection as SharedScrollDirection,
};
use enigo::{Direction, Mouse};

use crate::coord::Point;

use super::backend::{run_steps_guarded, OsInputBackend};
use super::keys::to_enigo_button_shared;
use super::steps::{build_click_steps, build_scroll_steps};

/// 共享层输入后端对齐(05 §4.4):八方法全形,click/scroll 补坐标与修饰键
/// (坐标存在先移动;修饰键 press/release 包裹)。
///
/// 与既有 `ComputerSession::dispatch` 派发路径并存:dispatch 走本地方法
/// (坐标/修饰键由 dispatch 前置包裹,lib.rs),共享 trait 方法为 S6 新契约;
/// 两者共享 `build_*` 序列构建与 `run_steps_guarded` 执行器(必须传入
/// abort 查询,无「不看停止」入口),注入语义一致。
#[async_trait]
impl InputBackend for OsInputBackend {
    async fn mouse_move(&self, p: SharedPoint) -> Result<(), InputBackendError> {
        self.mouse_move(Point::new(p.x, p.y))
            .map_err(InputBackendError::Failed)
    }

    async fn click(
        &self,
        btn: SharedMouseButton,
        count: SharedClickCount,
        p: Option<SharedPoint>,
        mods: &[SharedKeyName],
    ) -> Result<(), InputBackendError> {
        let times = match count {
            SharedClickCount::Single => 1,
            SharedClickCount::Double => 2,
            SharedClickCount::Triple => 3,
        };
        let steps = build_click_steps(to_enigo_button_shared(btn), times, p, mods);
        let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
        let should_abort = || self.aborted();
        run_steps_guarded(&mut enigo, &steps, should_abort).map_err(InputBackendError::Failed)
    }

    async fn button(&self, btn: SharedMouseButton, down: bool) -> Result<(), InputBackendError> {
        let direction = if down {
            Direction::Press
        } else {
            Direction::Release
        };
        let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
        enigo
            .button(to_enigo_button_shared(btn), direction)
            .map_err(|e| InputBackendError::Failed(format!("鼠标按键失败: {e:?}")))
    }

    async fn drag(&self, from: SharedPoint, to: SharedPoint) -> Result<(), InputBackendError> {
        self.drag(Point::new(from.x, from.y), Point::new(to.x, to.y))
            .map_err(InputBackendError::Failed)
    }

    async fn scroll(
        &self,
        dir: SharedScrollDirection,
        amount: u32,
        p: Option<SharedPoint>,
        mods: &[SharedKeyName],
    ) -> Result<(), InputBackendError> {
        let steps = build_scroll_steps(dir, amount, p, mods);
        let mut enigo = self.enigo.lock().expect("注入后端锁损坏");
        let should_abort = || self.aborted();
        run_steps_guarded(&mut enigo, &steps, should_abort).map_err(InputBackendError::Failed)
    }

    async fn type_text(&self, text: &str) -> Result<(), InputBackendError> {
        self.type_text_inner(text)
            .map_err(InputBackendError::Failed)
    }

    async fn key(
        &self,
        keys: &[SharedKeyName],
        hold_ms: Option<u32>,
    ) -> Result<(), InputBackendError> {
        let names: Vec<String> = keys.iter().map(|k| k.0.clone()).collect();
        self.key_hold_inner(&names, hold_ms)
            .map_err(InputBackendError::Failed)
    }

    async fn cursor_position(&self) -> Result<SharedPoint, InputBackendError> {
        let p = self.cursor_physical().map_err(InputBackendError::Failed)?;
        Ok(SharedPoint { x: p.x, y: p.y })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::action::inject::OsInputBackend;
    use conex_shared::input::{
        ClickCount as SharedClickCount, InputBackend, MouseButton as SharedMouseButton,
        ScrollDirection as SharedScrollDirection,
    };
    use std::sync::Arc;

    fn block_on<F: std::future::Future>(fut: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("测试运行时构建失败")
            .block_on(fut)
    }

    fn backend_with_abort_set() -> OsInputBackend {
        let backend = OsInputBackend::new().expect("注入后端初始化失败");
        backend.set_abort_checker(Some(Arc::new(|| true)));
        backend
    }

    fn assert_aborted(err: InputBackendError) {
        match err {
            InputBackendError::Failed(msg) => {
                assert!(msg.contains("停止"), "中止错误应含停止语义，实得: {msg}");
            }
            other => panic!("预期 Failed(停止)，实得 {other:?}"),
        }
    }

    #[test]
    fn input_backend_click_aborts_when_flag_set() {
        let backend = backend_with_abort_set();
        let err = block_on(InputBackend::click(
            &backend,
            SharedMouseButton::Left,
            SharedClickCount::Single,
            None,
            &[],
        ))
        .expect_err("abort 置位时 InputBackend::click 必须中止");
        assert_aborted(err);
    }

    #[test]
    fn input_backend_scroll_aborts_when_flag_set() {
        let backend = backend_with_abort_set();
        let err = block_on(InputBackend::scroll(
            &backend,
            SharedScrollDirection::Down,
            3,
            None,
            &[],
        ))
        .expect_err("abort 置位时 InputBackend::scroll 必须中止");
        assert_aborted(err);
    }

    #[test]
    fn os_input_backend_implements_trait_and_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<OsInputBackend>();
        fn assert_backend<T: InputBackend>() {}
        assert_backend::<OsInputBackend>();
    }
}
