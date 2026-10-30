//! workflow/tests.rs 拆出的独立测试（仅搬移，断言与用例数不变）。
//!
//! 经 workflow/tests.rs `mod extra;` 挂载；`super::super` = workflow 模块。

use super::super::schedule::epoch_ms_to_iso;

#[test]
fn epoch_iso_format_is_parseable() {
    let iso = epoch_ms_to_iso(1_752_000_000_000);
    assert!(iso.ends_with('Z'), "应为 UTC Z 后缀：{iso}");
    assert!(iso.contains('T'), "应为 ISO 格式：{iso}");
    let secs = iso[..iso.len() - 5].replace(['T', ':'], "-");
    let parts: Vec<&str> = secs.split('-').collect();
    assert_eq!(parts.len(), 6, "ISO 应含完整日期时间字段：{iso}");
}
