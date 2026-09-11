#!/usr/bin/env node
/**
 * SYSTEMATIC-FIX-PLAN §6 门禁（本路：flush 排空 + 块 ID 生产熵）
 *
 * 1) flushPendingDraft：禁止固定两轮伪排空；必须循环至空或显式失败。
 * 2) noteBlockId：生产路径强制 crypto；Math.random 不得出现在 newNoteBlockId 可达生产路径。
 *
 * Run: node scripts/check-sec6-note-drain-entropy.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const errors = [];

function fail(msg) {
  errors.push(msg);
}

function read(rel) {
  return readFileSync(resolve(root, rel), 'utf8');
}

function checkFlushDrain() {
  const rel =
    'apps/crish-desktop/src/components/note-paper/useNoteTextPersistence.ts';
  const src = read(rel);
  const start = src.indexOf('const flushPendingDraft = useCallback');
  if (start < 0) {
    fail(`${rel}: 缺少 flushPendingDraft`);
    return;
  }
  const body = src.slice(
    start,
    src.indexOf('flushPendingDraftRef', start) >= 0
      ? src.indexOf('flushPendingDraftRef', start)
      : start + 2500,
  );

  if (/pass\s*<\s*2/.test(body) || /for\s*\(\s*let\s+pass\s*=\s*0/.test(body)) {
    fail(`${rel}: 禁止固定两轮 pass 伪排空`);
  }
  if (!/MAX_DRAIN_ROUNDS/.test(body)) {
    fail(`${rel}: flushPendingDraft 须有 MAX_DRAIN_ROUNDS 安全上界`);
  }
  if (!/throw new Error/.test(body)) {
    fail(`${rel}: 排空停滞/触顶必须 throw（失败可见）`);
  }
  if (!/candidateIds\.size === 0\) return/.test(body)) {
    fail(`${rel}: 须在队列空时 return（形式化排空）`);
  }
  for (const ref of ['pendingFlushRef', 'blockQueueRef', 'inFlightBlocksRef']) {
    if (!body.includes(ref)) {
      fail(`${rel}: flushPendingDraft 须覆盖 ${ref}`);
    }
  }
  console.log('ok  sec6_flushPendingDraft_drain_until_empty_or_throw');
}

function checkBlockIdEntropy() {
  const rel = 'apps/crish-desktop/src/components/note-paper/noteBlockId.ts';
  const src = read(rel);

  if (!src.includes('import.meta.env.PROD')) {
    fail(`${rel}: 生产构建须以 import.meta.env.PROD 强制 crypto 熵`);
  }
  if (!/crypto entropy required in production/.test(src)) {
    fail(`${rel}: 生产缺熵须硬失败文案`);
  }

  const fnStart = src.indexOf('export function newNoteBlockId');
  if (fnStart < 0) {
    fail(`${rel}: 缺少 newNoteBlockId`);
    return;
  }
  const fnBody = src.slice(fnStart).replace(/\/\/.*$/gm, '');
  if (/Math\.random/.test(fnBody)) {
    fail(`${rel}: newNoteBlockId 函数体内不得直接出现 Math.random`);
  }
  if (!/function fillWeakEntropyForDevOnly/.test(src)) {
    fail(`${rel}: 弱熵须隔离在 fillWeakEntropyForDevOnly`);
  }
  if (!/fillWeakEntropyForDevOnly[\s\S]*Math\.random/.test(src)) {
    fail(`${rel}: Math.random 仅允许在 fillWeakEntropyForDevOnly 内`);
  }
  if (
    !/if \(import\.meta\.env\.DEV \|\| import\.meta\.env\.MODE === 'test'\)\s*\{\s*fillWeakEntropyForDevOnly/.test(
      src,
    )
  ) {
    fail(`${rel}: fillWeakEntropyForDevOnly 仅允许在 DEV/test 分支调用`);
  }
  if (!/randomUUID/.test(src) || !/getRandomValues/.test(src)) {
    fail(`${rel}: 须优先 crypto.randomUUID / getRandomValues`);
  }
  console.log('ok  sec6_noteBlockId_prod_crypto_no_weak_math_random');
}

checkFlushDrain();
checkBlockIdEntropy();

if (errors.length) {
  console.error('SEC6 FAIL');
  for (const e of errors) console.error(`- ${e}`);
  process.exit(1);
}

console.log('SEC6 PASS  (flush drain + block id entropy)');
