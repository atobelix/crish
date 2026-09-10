//! TS↔Rust 设备协议对拍闭环（R0-05；D8 §5.3.3 protocol-parity）
//!
//! 与 `tests/fixtures/device-protocol/` 样例集（唯一共享输入）双端消费：TS 侧
//! `packages/shared-types/src/generated/device/parity.test.ts` 消费同一目录。
//! 本文件断言：
//!
//! - `valid/*.json`：Rust serde 反序列化 DeviceEnvelope 成功 → body 按 kind
//!   类型化反序列化成功 → 重新序列化与样例**规范化 JSON** 一致（键码点升序
//!   递归排序，与 TS 侧 canonical 比较基准相同；样例即 wire 规范形态：
//!   PairCode 12 字符标准化 / 默认值省略，见 README.md 消费规则）；
//! - `invalid/*.json`：信封层或 body 层任一解析失败（与 TS parseDeviceFrame
//!   拒绝语义对齐——无效样例只收录双端一致拒绝的载荷）；
//! - canon 输入锁定：D3 §5.1 唯一真源（`deviceId ∥ ts ∥ nonce ∥ msgId ∥
//!   kind ∥ v` 再拼接 body 紧凑 JSON），以 13-remote-approve.json 样例锁定
//!   字节形态——R0-02a/b 注记裁决：M6 §10.1 把 from/to 列入 canon 的描述
//!   以 D3 §5.1 为准（Z0 §4.2 复述真源）。
//!
//! 对拍注记裁决（配对码字符集 / canon / tauri_command 占位 / ResumeState
//! 死条目）见 `tests/fixtures/device-protocol/README.md`。

use conex_types::device::{
    CommandRequest, CommandResult, DeviceEndpoint, DeviceEnvelope, ErrorBody, EventsPush, Hello,
    HelloOk, MessageKind, PairChallenge, PairHello, PairOk, PairVerify, Resume, ResumeDone,
    ResumePage, StreamChunk, Subscribe,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

/// 样例集根目录（共享输入；`tests/fixtures/device-protocol/`）
const FIXTURES_ROOT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/fixtures/device-protocol"
);

/// 递归按键码点升序排序后输出紧凑 JSON（双端 canonical 比较基准：
/// TS 侧 parity.test.ts 的 canonicalJsonString 同一语义；serde_json 默认
/// Map 后端已排序，此处显式排序保证与 preserve_order 开关无关的确定性）
fn canonical(value: &Value) -> String {
    fn sort(v: &Value) -> Value {
        match v {
            Value::Object(map) => {
                let sorted: BTreeMap<String, Value> =
                    map.iter().map(|(k, v)| (k.clone(), sort(v))).collect();
                Value::Object(sorted.into_iter().collect())
            }
            Value::Array(items) => Value::Array(items.iter().map(sort).collect()),
            other => other.clone(),
        }
    }
    serde_json::to_string(&sort(value)).expect("canonical JSON 序列化不应失败")
}

/// 按 kind 把 body 反序列化为强类型（返回类型化后重序列化的 Value；
/// 未覆盖 kind 返回 Err——新增样例必须同步接线）
fn parse_typed_body(kind: &MessageKind, body: &Value) -> Result<Value, String> {
    macro_rules! typed {
        ($ty:ty) => {{
            let v: $ty = serde_json::from_value(body.clone()).map_err(|e| e.to_string())?;
            serde_json::to_value(v).map_err(|e| e.to_string())
        }};
    }
    match kind {
        MessageKind::PairHello => typed!(PairHello),
        MessageKind::PairChallenge => typed!(PairChallenge),
        MessageKind::PairVerify => typed!(PairVerify),
        MessageKind::PairOk => typed!(PairOk),
        MessageKind::AuthHello => typed!(Hello),
        MessageKind::AuthHelloOk => typed!(HelloOk),
        MessageKind::EventsSubscribe => typed!(Subscribe),
        MessageKind::EventsPush => typed!(EventsPush),
        MessageKind::EventsResume => typed!(Resume),
        MessageKind::EventsResumePage => typed!(ResumePage),
        MessageKind::EventsResumeDone => typed!(ResumeDone),
        MessageKind::Remote(_) => typed!(CommandRequest),
        MessageKind::Result(_) => typed!(CommandResult),
        MessageKind::StreamChunk => typed!(StreamChunk),
        MessageKind::Error => typed!(ErrorBody),
        other => Err(format!("对拍未覆盖 kind：{}", other.as_str())),
    }
}

/// 完整解析（信封 + body 类型化）——valid 必须 Ok、invalid 必须 Err
fn parse_frame(json: &str) -> Result<(), String> {
    let env: DeviceEnvelope = serde_json::from_str(json).map_err(|e| e.to_string())?;
    parse_typed_body(&env.kind, &env.body).map(|_| ())
}

/// 读取 fixtures 子目录下全部样例文件（排序保证确定性）
fn fixture_files(subdir: &str) -> Vec<PathBuf> {
    let dir = std::path::Path::new(FIXTURES_ROOT).join(subdir);
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("读取样例目录 {dir:?} 失败：{e}"))
        .map(|entry| entry.expect("目录项可读").path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect();
    files.sort();
    files
}

fn load_fixture(path: &PathBuf) -> (String, Value) {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("读取样例 {} 失败：{e}", path.display()));
    let value: Value = serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("样例 {} 不是合法 JSON：{e}", path.display()));
    (text, value)
}

// ── 1. valid 样例：信封 + body 强类型双解析成功，重序列化与样例一致 ──

#[test]
fn valid_samples_roundtrip_and_match_fixture() {
    let files = fixture_files("valid");
    assert!(
        files.len() >= 10,
        "valid 样例集规模过小（{} 个），对拍覆盖面不足",
        files.len()
    );
    for path in files {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let (text, sample) = load_fixture(&path);
        let env: DeviceEnvelope = serde_json::from_str(&text)
            .unwrap_or_else(|e| panic!("样例 [{name}] 信封反序列化失败：{e}"));
        // body 按 kind 强类型反序列化 + 回写与样例 body 一致
        let typed = parse_typed_body(&env.kind, &env.body)
            .unwrap_or_else(|e| panic!("样例 [{name}] body 类型化失败：{e}"));
        assert_eq!(
            canonical(&typed),
            canonical(&env.body),
            "样例 [{name}] body 类型化回写与原始 body 不一致"
        );
        // 信封重序列化与样例规范化一致（配对码标准化 / 默认值省略规则内）
        let re = serde_json::to_value(&env).expect("信封重序列化不应失败");
        assert_eq!(
            canonical(&re),
            canonical(&sample),
            "样例 [{name}] 重序列化与样例不一致（wire 漂移）"
        );
    }
}

// ── 2. invalid 样例：双端一致拒绝（信封层或 body 层任一失败）──

#[test]
fn invalid_samples_are_rejected_both_sides() {
    let files = fixture_files("invalid");
    assert!(
        files.len() >= 5,
        "invalid 样例集规模过小（{} 个）",
        files.len()
    );
    for path in files {
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let (text, _) = load_fixture(&path);
        assert!(
            parse_frame(&text).is_err(),
            "样例 [{name}] 必须被拒绝（Rust 侧）；TS 侧 parity.test.ts 同步断言"
        );
    }
}

// ── 3. canon 输入锁定：D3 §5.1 字节形态（R0-02a/b 注记裁决）──

#[test]
fn canonical_signing_payload_locked_by_fixture() {
    // 以 13-remote-approve.json（审批命令请求）为 canon 锁定样例
    let path = std::path::Path::new(FIXTURES_ROOT).join("valid/13-remote-approve.json");
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("读取 canon 样例失败：{e}"));
    let env: DeviceEnvelope =
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("canon 样例反序列化失败：{e}"));

    // canon(header) = deviceId ∥ ts ∥ nonce ∥ msgId ∥ kind ∥ v，再拼接 body
    // 紧凑 JSON（serde_json 默认 Map 后端键序 = 码点序，确定性）
    let expected_header = "dev-mobile-0f3a1754651205000n-appr-01m-iph-005-0014remote.approve1";
    let body_json = serde_json::to_string(&env.body).expect("body 序列化不应失败");
    assert_eq!(
        env.canonical_signing_payload(),
        format!("{expected_header}{body_json}"),
        "canon 串字节形态与 D3 §5.1 不一致（M6 §10.1 的 from/to 入 canon 描述以 D3 为准）"
    );
    // 信封方向字段本身不入 canon
    assert_eq!(env.from, DeviceEndpoint::Mobile);
    assert_eq!(env.to, DeviceEndpoint::Desktop);
}
