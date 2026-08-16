#!/usr/bin/env node
/**
 * LR-T1（launch-gap/00 §4 行 4 · 原 05·LR-02）
 *
 * workbench 生产装配源码零 MemoryNoteBackend；注入只允许 Store 或 unwired。
 * Memory 集成测头必须钉不得关 EL-05。本脚本绿 ≠ 关 EL-05。
 *
 * 孪生 cargo 测：apps/agent-workbench/src-tauri/tests/lr_t1_memory_prod_ban.rs
 * Run: node scripts/check-lr-t1-memory-prod-ban.mjs
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const workbenchSrc = resolve(root, 'apps/agent-workbench/src-tauri/src');
const workbenchRoot = resolve(root, 'apps/agent-workbench/src-tauri');

const MEMORY_IDENT = 'MemoryNoteBackend';
const STORE_IDENT = 'StoreNoteBackend';

const MEMORY_INTEGRATION_PINS = [
  'crates/agent-tools/src/note_backend_tests.rs',
  'crates/agent-tools/src/note_backend_tests_memory.rs',
  'crates/agent-tools/src/note_backend_tests_result.rs',
  'crates/agent-tools/src/note_plan_ops_tests.rs',
  'crates/agent-tools/src/note_memory.rs',
  'crates/agent-tools/src/note_memory_query.rs',
  'crates/agent-tools/src/note_memory_apply.rs',
  'crates/agent-tools/src/note_memory_batch.rs',
  'crates/agent-tools/src/note_stress_guard.rs',
  'crates/conex-note-runtime/tests/note_plan_parity.rs',
  'crates/agent-tools/src/tools/note_query_blocks.rs',
  'crates/agent-tools/src/tools/note_document_outline.rs',
  'crates/agent-tools/src/tools/note_document_get_md.rs',
  'crates/agent-tools/src/tools/note_document_apply_md.rs',
  'crates/agent-tools/src/tools/note_send_to_note.rs',
  'crates/agent-tools/src/tools/note_block_batch.rs',
  'crates/agent-tools/src/tools/note_block_insert.rs',
  'crates/agent-tools/src/tools/note_block_update.rs',
  'crates/agent-tools/src/tools/note_block_delete.rs',
  'crates/agent-tools/src/tools/note_block_move.rs',
  'crates/agent-tools/src/tools/note_block_set_attr.rs',
];

const PROD_INJECT_FILES = [
  'src/note_runtime.rs',
  'src/engine_build.rs',
  'src/core_run_commands.rs',
  'src/run/run_launch.rs',
  'src/main.rs',
  'src/note_commands.rs',
  'src/note_commands_apply.rs',
];

const errors = [];

function fail(msg) {
  errors.push(msg);
}

function readUtf8(path) {
  return readFileSync(path, 'utf8');
}

function collectRs(dir, out = []) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) collectRs(p, out);
    else if (name.name.endsWith('.rs')) out.push(p);
  }
  return out;
}

function isTestOnlyRs(path) {
  const name = path.replace(/\\/g, '/').split('/').pop();
  return (
    name.endsWith('_tests.rs') ||
    name.endsWith('_test.rs') ||
    name === 'tests.rs'
  );
}

function productionCode(src) {
  // 不按首个 #[cfg(test)] 截断：大文件中段也有测试辅助，截断会误删注入点。
  return src
    .split(/\r?\n/)
    .map((line) => {
      const i = line.indexOf('//');
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join('\n');
}

function containsIdent(src, ident) {
  return src.split(/[^A-Za-z0-9_]/).includes(ident);
}

function fileHeader(src) {
  const lines = src.split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    const t = line.trimStart();
    if (t.startsWith('//!') || t === '') kept.push(line);
    else break;
  }
  return kept.join('\n');
}

function headerPinsEl05(header) {
  return (
    header.includes('EL-05') &&
    (header.includes('≠') || header.includes('禁关') || header.includes('不得'))
  );
}

function checkProdZeroMemory() {
  const files = collectRs(workbenchSrc);
  if (files.length === 0) fail('workbench src 应有 .rs');
  let scanned = 0;
  const hits = [];
  for (const path of files) {
    if (isTestOnlyRs(path)) continue;
    scanned += 1;
    const code = productionCode(readUtf8(path));
    if (containsIdent(code, MEMORY_IDENT)) {
      hits.push(relative(root, path));
    }
  }
  if (scanned < 8) fail(`至少扫描装配入口，实际 ${scanned}`);
  if (hits.length) {
    fail(`生产装配源码禁止 ${MEMORY_IDENT}，命中: ${hits.join(', ')}`);
  }
  console.log(`ok  lr_t1_workbench_prod_src_zero_memory_note_backend  scanned=${scanned}`);
}

function checkInjectStoreOrUnwired() {
  const runtime = productionCode(readUtf8(join(workbenchRoot, 'src/note_runtime.rs')));
  if (!containsIdent(runtime, STORE_IDENT)) {
    fail(`note_runtime 生产码必须出现 ${STORE_IDENT}`);
  }
  if (!runtime.includes('StoreNoteBackend::open')) {
    fail('open_at 必须 StoreNoteBackend::open');
  }
  if (
    !(runtime.includes('fn try_backend()') && runtime.includes('Option<NoteBackendHandle>'))
  ) {
    fail('try_backend 必须 Option（允许 unwired）');
  }
  if (
    !(
      runtime.includes('fn try_store_backend()') &&
      runtime.includes('Option<Arc<StoreNoteBackend>>')
    )
  ) {
    fail('try_store_backend 必须 Option<Arc<StoreNoteBackend>>');
  }
  if (containsIdent(runtime, MEMORY_IDENT)) {
    fail(`note_runtime 生产码零 ${MEMORY_IDENT}`);
  }

  const engine = productionCode(readUtf8(join(workbenchRoot, 'src/engine_build.rs')));
  if (!engine.includes('note_runtime::try_backend()')) {
    fail('engine produce 必须注入 try_backend（Store 或 None）');
  }
  if (containsIdent(engine, MEMORY_IDENT)) fail(`engine_build 零 ${MEMORY_IDENT}`);

  const run = productionCode(readUtf8(join(workbenchRoot, 'src/run/run_launch.rs')));
  if (!run.includes('note_backend: crate::note_runtime::try_backend()')) {
    fail('core_run 必须同源 try_backend');
  }
  if (containsIdent(run, MEMORY_IDENT)) fail(`run_launch 零 ${MEMORY_IDENT}`);

  const main = productionCode(readUtf8(join(workbenchRoot, 'src/main.rs')));
  if (!main.includes('note_runtime::init_default()')) {
    fail('setup 必须 init_default（Store 打开；失败不阻断 = unwired）');
  }
  if (containsIdent(main, MEMORY_IDENT)) fail(`main 零 ${MEMORY_IDENT}`);

  for (const rel of PROD_INJECT_FILES) {
    const code = productionCode(readUtf8(join(workbenchRoot, rel)));
    if (containsIdent(code, MEMORY_IDENT)) {
      fail(`${rel} 生产码零 ${MEMORY_IDENT}`);
    }
  }
  console.log('ok  lr_t1_prod_inject_is_store_or_unwired');
}

function checkMemoryHeaders() {
  for (const rel of MEMORY_INTEGRATION_PINS) {
    const path = join(root, rel);
    if (!existsSync(path)) {
      fail(`Memory 集成测缺失（禁止删后端/测）: ${rel}`);
      continue;
    }
    const src = readUtf8(path);
    const header = fileHeader(src);
    if (!headerPinsEl05(header)) {
      fail(`${rel} 测头必须钉 Memory 测不得关 EL-05`);
    }
    if (rel.includes('note_memory.rs') && !src.includes('pub struct MemoryNoteBackend')) {
      fail(`禁止删除 Memory 测试后端（${rel}）`);
    }
  }
  console.log(
    `ok  lr_t1_memory_integration_headers_must_not_close_el05  n=${MEMORY_INTEGRATION_PINS.length}`,
  );
}

function checkSelfNotClosingEl05() {
  const here = readUtf8(fileURLToPath(import.meta.url));
  const top = here.slice(0, 800);
  if (!top.includes('EL-05') || !top.includes('≠ 关 EL-05')) {
    fail('本脚本头必须自钉 ≠ 关 EL-05');
  }
  console.log('ok  lr_t1_this_gate_does_not_close_el05');
}

checkProdZeroMemory();
checkInjectStoreOrUnwired();
checkMemoryHeaders();
checkSelfNotClosingEl05();

if (errors.length) {
  console.error('LR-T1 FAIL');
  for (const e of errors) console.error(`- ${e}`);
  process.exit(1);
}

console.log('LR-T1 PASS  (≠ 关 EL-05)');
