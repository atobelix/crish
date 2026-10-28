//! LR-T1（launch-gap/00 §4 行 4 · 原 05·LR-02）
//!
//! workbench 生产装配源码 **零** `MemoryNoteBackend`；默认只允许
//! `StoreNoteBackend` 或未接线 `None`（`note_backend_unwired`）。
//!
//! Memory 集成测头必须钉 **不得**关 EL-05。本文件绿 **≠ 关 EL-05**，
//! **≠** 删除 Memory 测试后端，**≠** session-loop 重构。
//!
//! 运行：`cargo test -p crish-agent-workbench --test lr_t1_memory_prod_ban`
//! 孪生脚本（无 MSVC 时可跑）：`node scripts/check-lr-t1-memory-prod-ban.mjs`

use std::fs;
use std::path::{Path, PathBuf};

const MEMORY_IDENT: &str = "MemoryNoteBackend";
const STORE_IDENT: &str = "StoreNoteBackend";

/// Memory 集成测（夹具 / 形状 / 双后端对齐）。绿 ≠ 关 EL-05。
const MEMORY_INTEGRATION_PINS: &[&str] = &[
    "crates/agent-tools/src/note_backend_tests.rs",
    "crates/agent-tools/src/note_backend_tests_memory.rs",
    "crates/agent-tools/src/note_backend_tests_result.rs",
    "crates/agent-tools/src/note_plan_ops_tests.rs",
    "crates/agent-tools/src/note_memory.rs",
    "crates/agent-tools/src/note_memory_query.rs",
    "crates/agent-tools/src/note_memory_apply.rs",
    "crates/agent-tools/src/note_memory_batch.rs",
    "crates/agent-tools/src/note_stress_guard.rs",
    "crates/conex-note-runtime/tests/note_plan_parity.rs",
    "crates/agent-tools/src/tools/note_query_blocks.rs",
    "crates/agent-tools/src/tools/note_document_outline.rs",
    "crates/agent-tools/src/tools/note_document_get_md.rs",
    "crates/agent-tools/src/tools/note_document_apply_md.rs",
    "crates/agent-tools/src/tools/note_send_to_note.rs",
    "crates/agent-tools/src/tools/note_block_batch.rs",
    "crates/agent-tools/src/tools/note_block_insert.rs",
    "crates/agent-tools/src/tools/note_block_update.rs",
    "crates/agent-tools/src/tools/note_block_delete.rs",
    "crates/agent-tools/src/tools/note_block_move.rs",
    "crates/agent-tools/src/tools/note_block_set_attr.rs",
];

/// 生产装配入口（注入点；须走 `try_backend` / `init_default` / Store）。
const PROD_INJECT_FILES: &[&str] = &[
    "src/note_runtime.rs",
    "src/engine_build.rs",
    "src/run_ipc.rs",
    "src/main.rs",
    "src/note_commands.rs",
    "src/note_commands_apply.rs",
    // ACT-102 双库并发装配：NoteRuntime 初始化入口（原 main.rs 内联）。
    "src/db_setup.rs",
];

fn workspace_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .join("../../..")
        .canonicalize()
        .expect("workspace root")
}

fn workbench_src() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn read_utf8(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|e| panic!("读 {} 失败: {e}", path.display()))
}

fn collect_rs(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap_or_else(|e| panic!("列目录 {}: {e}", dir.display())) {
        let entry = entry.expect("read_dir entry");
        let path = entry.path();
        if path.is_dir() {
            collect_rs(&path, out);
        } else if path.extension().and_then(|s| s.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

fn is_test_only_rs(path: &Path) -> bool {
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    name.ends_with("_tests.rs") || name.ends_with("_test.rs") || name == "tests.rs"
}

/// 去掉 `//` 行/行尾注释（含 `//!` `///`）。
///
/// 不按首个 `#[cfg(test)]` 截断：`core_run_commands` / `main` 等大文件
/// 中段也有测试辅助，截断会误删后面的生产注入点。
fn production_code(src: &str) -> String {
    src.lines()
        .map(|line| match line.find("//") {
            Some(i) => &line[..i],
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn contains_ident(src: &str, ident: &str) -> bool {
    src.split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .any(|w| w == ident)
}

fn file_header(src: &str) -> String {
    src.lines()
        .take_while(|l| {
            let t = l.trim_start();
            t.starts_with("//!") || t.is_empty()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn header_pins_memory_not_closing_el05(header: &str) -> bool {
    header.contains("EL-05")
        && (header.contains('≠') || header.contains("禁关") || header.contains("不得"))
}

/// 生产装配 `.rs`（去注释）零 `MemoryNoteBackend`。
#[test]
fn lr_t1_workbench_prod_src_zero_memory_note_backend() {
    let src_root = workbench_src();
    let mut files = Vec::new();
    collect_rs(&src_root, &mut files);
    assert!(!files.is_empty(), "workbench src 应有 .rs");

    let mut scanned = 0usize;
    let mut hits = Vec::new();
    for path in &files {
        if is_test_only_rs(path) {
            continue;
        }
        scanned += 1;
        let code = production_code(&read_utf8(path));
        if contains_ident(&code, MEMORY_IDENT) {
            hits.push(path.display().to_string());
        }
    }
    assert!(scanned >= 8, "至少扫描装配入口，实际 {scanned}");
    assert!(
        hits.is_empty(),
        "LR-T1：workbench 生产装配源码禁止 {MEMORY_IDENT}，命中: {hits:?}"
    );
}

/// 默认打开 / 槽位类型只允许 Store；未接线保持 Option。
#[test]
fn lr_t1_prod_inject_is_store_or_unwired() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let runtime = production_code(&read_utf8(&manifest.join("src/note_runtime.rs")));
    assert!(
        contains_ident(&runtime, STORE_IDENT),
        "note_runtime 生产码必须出现 {STORE_IDENT}"
    );
    assert!(
        runtime.contains("StoreNoteBackend::open"),
        "open_at 必须 StoreNoteBackend::open"
    );
    assert!(
        runtime.contains("fn try_backend()") && runtime.contains("Option<NoteBackendHandle>"),
        "try_backend 必须 Option（允许 unwired）"
    );
    assert!(
        runtime.contains("fn try_store_backend()")
            && runtime.contains("Option<Arc<StoreNoteBackend>>"),
        "try_store_backend 必须 Option<Arc<StoreNoteBackend>>"
    );
    assert!(
        !contains_ident(&runtime, MEMORY_IDENT),
        "note_runtime 生产码零 {MEMORY_IDENT}"
    );

    let engine = production_code(&read_utf8(&manifest.join("src/engine_build.rs")));
    assert!(
        engine.contains("note_runtime::try_backend"),
        "engine produce 必须注入 try_backend（Store 或 None；闭包或函数项均可）"
    );
    assert!(
        !contains_ident(&engine, MEMORY_IDENT),
        "engine_build 零 {MEMORY_IDENT}"
    );

    // run 域下沉 conex-run 后：装配消费面 = crate 侧注入槽（生产槽由壳层
    // engine_build 的 note_runtime::try_backend() 注入，见上方断言）。
    let run = production_code(&read_utf8(
        &workspace_root().join("crates/conex-run/src/run/run_launch.rs"),
    ));
    assert!(
        run.contains("note_backend = crate::engine_assembly::note_backend()"),
        "core_run 必须经注入槽同源取 note backend（Store 或 None）"
    );
    assert!(
        !contains_ident(&run, MEMORY_IDENT),
        "run_launch 零 {MEMORY_IDENT}"
    );

    // NoteRuntime 初始化唯一入口随 ACT-102 双库并发装配迁入 db_setup：
    // 断言随之迁移到新落点，语义不变（Store 打开；失败保持 unwired = None）。
    // 同时新增 main.rs 消费面断言——只断言「调用存在」不足以证明接线，
    // 必须断言 main 真正消费并发装配的返回值。
    let db_setup = production_code(&read_utf8(&manifest.join("src/db_setup.rs")));
    assert!(
        db_setup.contains("note_runtime::init_default()"),
        "NoteRuntime 初始化唯一入口 = db_setup 的 init_default（Store 打开）"
    );
    assert!(
        !contains_ident(&db_setup, MEMORY_IDENT),
        "db_setup 生产码零 {MEMORY_IDENT}"
    );

    let main = production_code(&read_utf8(&manifest.join("src/main.rs")));
    assert!(
        main.contains("db_init.note_runtime"),
        "main setup 必须消费并发装配的 note_runtime（Some = Store；None = unwired）"
    );
    assert!(
        !contains_ident(&main, MEMORY_IDENT),
        "main 零 {MEMORY_IDENT}"
    );

    for rel in PROD_INJECT_FILES {
        let code = production_code(&read_utf8(&manifest.join(rel)));
        assert!(
            !contains_ident(&code, MEMORY_IDENT),
            "{rel} 生产码零 {MEMORY_IDENT}"
        );
    }
}

/// Memory 集成测头钉：不得关 EL-05。
#[test]
fn lr_t1_memory_integration_headers_must_not_close_el05() {
    let root = workspace_root();
    for rel in MEMORY_INTEGRATION_PINS {
        let path = root.join(rel);
        assert!(path.is_file(), "Memory 集成测缺失（禁止删后端/测）: {rel}");
        let src = read_utf8(&path);
        let header = file_header(&src);
        assert!(
            header_pins_memory_not_closing_el05(&header),
            "{rel} 测头必须钉 Memory 测不得关 EL-05（含 EL-05 且 ≠/禁关/不得）\n头:\n{header}"
        );
        if rel.contains("note_memory.rs") {
            assert!(
                src.contains("pub struct MemoryNoteBackend"),
                "禁止删除 Memory 测试后端（{rel}）"
            );
        }
    }
}

/// 本门禁绿 ≠ 关 EL-05。
#[test]
fn lr_t1_this_gate_does_not_close_el05() {
    let here = include_str!("lr_t1_memory_prod_ban.rs");
    let header = file_header(here);
    assert!(
        header.contains("≠ 关 EL-05") || header.contains("**≠ 关 EL-05**"),
        "本测头必须自钉 ≠ 关 EL-05"
    );
    assert!(header.contains("EL-05"));
}
