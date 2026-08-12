//! `note_backend` 集成测入口（**SD-23** 外置；**SD-47** 按域拆）。
//!
//! 由父模 [`crate::note_backend`] 经 `#[path]` 接入（无孤儿）。子域：
//! - [`memory`]：`memory_*` query/apply/get_md + batch_token
//! - [`w4`]：`w4f_*` / `w4r_*` / `apply_result_json`
//!
//! **≠ EL-05**；**≠ W6-E**；**≠ A-AGT 满表**；Memory 测绿 **禁关**生产。
//! 不重写 trait 语义，只迁测。

#[path = "note_backend_tests_memory.rs"]
mod memory;

#[path = "note_backend_tests_w4.rs"]
mod w4;
