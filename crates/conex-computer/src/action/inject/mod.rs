//! Windows 注入后端（按领域拆）
//!
//! 四域：
//! - `steps`: 注入步骤枚举与纯函数构建器（步骤构建域）
//! - `keys`: 键名→enigo 映射与按钮映射（键映射域）
//! - `backend`: OsInputBackend 结构与执行器、5ms 切片中止（执行域）
//! - `input`: InputBackend trait 实现（分发域）

pub mod backend;
pub mod input;
pub mod keys;
pub mod steps;

pub use backend::{InjectError, OsInputBackend, release_all_keys_and_buttons, run_steps_guarded};
pub use steps::InjectStep;
