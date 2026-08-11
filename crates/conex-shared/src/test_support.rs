//! 测试支撑（仅 `cfg(test)` 编译）：无第三方依赖的最小阻塞执行器。
//!
//! 本 crate 约束「无 tokio 运行时」，mock 冒烟测试经 [`block_on`] 驱动
//! `async_trait` 方法（mock 的异步体不真正挂起，首轮轮询即完成）。

#![allow(unsafe_code)]

use std::future::Future;
use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};

/// 构造无操作唤醒器（mock future 不挂起，唤醒函数仅满足契约）
fn noop_waker() -> Waker {
    unsafe fn clone_waker(_: *const ()) -> RawWaker {
        noop_raw_waker()
    }
    unsafe fn wake_by_ref(_: *const ()) {}
    fn wake(_: *const ()) {}
    fn drop_waker(_: *const ()) {}

    fn noop_raw_waker() -> RawWaker {
        static VTABLE: RawWakerVTable =
            RawWakerVTable::new(clone_waker, wake, wake_by_ref, drop_waker);
        RawWaker::new(std::ptr::null(), &VTABLE)
    }

    unsafe { Waker::from_raw(noop_raw_waker()) }
}

/// 阻塞驱动 future 至完成（测试专用；仅支持不真正挂起的 future）
pub(crate) fn block_on<F: Future>(fut: F) -> F::Output {
    let waker = noop_waker();
    let mut cx = Context::from_waker(&waker);
    let mut fut = Box::pin(fut);
    loop {
        match fut.as_mut().poll(&mut cx) {
            Poll::Ready(output) => return output,
            Poll::Pending => std::thread::yield_now(),
        }
    }
}
