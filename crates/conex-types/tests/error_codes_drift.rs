//! 错误码契约漂移护栏。
//!
//! Rust 侧 `error::catalog` 是唯一声明表；`contracts/error-codes.json` 是给
//! `scripts/generate-engine-bindings.mjs` 的机器可读导出。本测试把两者逐字段
//! 锁定，并校验目录无重复、按 code 排序。
//!
//! 更新契约：
//! `UPDATE_CONTRACTS=1 cargo test -p conex-types --test error_codes_drift`

use conex_types::error::{error_catalog, CrishErrorInfo};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

const CONTRACT_VERSION: u32 = 1;

fn contract_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("contracts/error-codes.json")
}

fn entry_json(info: &CrishErrorInfo) -> Value {
    json!({
        "code": info.code,
        "title": info.title,
        "category": info.category,
        "retryable": info.retryable,
        "public": info.is_public,
        "action": info.action,
    })
}

fn build_contract() -> Value {
    let mut entries: Vec<&'static CrishErrorInfo> = error_catalog().collect();
    entries.sort_by_key(|info| info.code);
    let codes: Vec<Value> = entries.iter().map(|info| entry_json(info)).collect();
    json!({
        "contract": "error-codes",
        "schemaVersion": CONTRACT_VERSION,
        "count": codes.len(),
        "codes": codes,
    })
}

fn render_contract(value: &Value) -> String {
    let mut text = serde_json::to_string_pretty(value).expect("序列化错误码契约");
    text.push('\n');
    text
}

#[test]
fn catalog_has_no_duplicate_codes() {
    let codes: Vec<&str> = error_catalog().map(|info| info.code).collect();
    let unique: BTreeSet<&str> = codes.iter().copied().collect();
    assert_eq!(
        unique.len(),
        codes.len(),
        "error catalog 存在重复 code：{codes:?}"
    );
}

#[test]
fn contract_json_matches_catalog() {
    let actual = build_contract();
    let path = contract_path();

    if std::env::var("UPDATE_CONTRACTS").as_deref() == Ok("1") {
        fs::write(&path, render_contract(&actual)).expect("写入 error-codes.json");
        return;
    }

    let raw = fs::read_to_string(&path).unwrap_or_else(|err| {
        panic!(
            "读取 {} 失败：{err}。首次生成请运行 UPDATE_CONTRACTS=1 cargo test -p conex-types --test error_codes_drift",
            path.display()
        )
    });
    let expected: Value = serde_json::from_str(&raw).expect("解析 error-codes.json");
    assert_eq!(
        expected, actual,
        "error-codes.json 与 Rust catalog 漂移；执行 UPDATE_CONTRACTS=1 cargo test -p conex-types --test error_codes_drift 重生成"
    );
}
