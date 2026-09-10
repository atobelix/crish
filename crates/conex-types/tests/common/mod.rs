//! conex-types 测试公共基建（T11.3 golden 统一规范落地）
//!
//! 统一 golden fixture 访问辅助函数（单一实现，各测试文件经
//! `mod common;` 复用，禁止各测试文件自造第二套路径拼接）：
//!
//! - [fixture_dir]：fixture 根目录（`tests/fixtures/`，CARGO_MANIFEST_DIR 相对）；
//! - [fixture]：按文件名读取 fixture 文本（缺失即 panic，失败信息带路径）。
//!
//! ## golden fixture 管理规范（T11.3 / PE-03 T03.10）
//!
//! - **目录**：`tests/fixtures/events-v1/` = v1 基线事件样本（24 事件每类 ≥1 条
//!   + `frame-with-runid-sequence.json` 完整信封帧；文件名 `event-<type>.json`）；
//! - **清单 SoT**：`events_schema_version.rs` 的 `V1_EVENT_TYPES`（与
//!   `33-event-schema-changelog.md` v1 表逐条对应，变体数一致性由测试锁定）；
//! - **新增事件三步门禁**：① 登记 changelog（33 号文档）→ ② 加入
//!   `V1_EVENT_TYPES` 清单 → ③ 补 `event-<type>.json` v1 样本（缺一即
//!   `v1_fixture_files_cover_all_24_event_types` 测试失败）；
//! - **样本规则**：v1 样本 = 无 `schemaVersion` 字段的旧帧形状（向后兼容
//!   解析测试依赖）；字段用最小集 + 关键字段（硬依赖表 03 §5.1 锚定值）；
//! - **golden 变更审查**：修改/新增 fixture 属契约变更，须同步 changelog
//!   登记（版本 | 事件 | 字段变更 | 兼容性 | 依据），拒绝「改 fixture 吞 diff」。

use std::fs;
use std::path::PathBuf;

/// fixture 根目录（tests/fixtures/）
pub fn fixture_dir() -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures"))
}

/// 读取 fixture 文本（缺失即 panic，失败信息带完整路径）
pub fn fixture(name: &str) -> String {
    fs::read_to_string(fixture_dir().join(name))
        .unwrap_or_else(|e| panic!("读取 fixture {name} 失败：{e}"))
}

/// v1 事件样本子目录（events-v1/）
pub fn v1_fixture_dir() -> PathBuf {
    fixture_dir().join("events-v1")
}

/// 读取 v1 事件样本（`events-v1/event-<type>.json`）
pub fn v1_fixture(type_name: &str) -> String {
    fs::read_to_string(v1_fixture_dir().join(format!("event-{type_name}.json")))
        .unwrap_or_else(|e| panic!("读取 v1 样本 {type_name} 失败：{e}"))
}
