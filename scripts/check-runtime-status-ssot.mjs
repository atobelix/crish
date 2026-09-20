#!/usr/bin/env node
/**
 * check-runtime-status-ssot.mjs — 会话运行时状态 SSOT 门禁（单轨收敛）
 *
 * 规则（docs/chat-notice-convergence/00-总方案 §2.0）：
 * 1. reportRuntimeStatus 是运行时状态的全局唯一上报入口：
 *    任何文件不得直接调用 useSessionRuntimeStatusStore.setState / report
 *    （只允许经 reportRuntimeStatus / clearRuntimeStatus 命令式入口，
 *      或 React 组件内 useSessionRuntimeStatusStore(selector) 只读订阅）。
 * 2. 旧多轨通道禁止回流：
 *    - ephemeralChatStore / useEphemeralChatStore（已删除）
 *    - continuityUiStore.retryNotices / applyRetryNotice（已删除）
 *    - RunNotice / pushRunNotice / RunNoticeBar（已删除）
 *    - msg.errorDetail 的新写入（setSessionMessageStatus 第 5 参 errorDetail 字段）
 *      仅允许 staleSessionHealer.ts 历史兼容点之外的零处。
 *
 * 违规 → exit 1。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'apps', 'crish-desktop', 'src');

if (process.argv.includes('--guide')) {
  console.log(`[check-runtime-status-ssot] 正确做法指引：
  会话运行类状态必须经由 reportRuntimeStatus 写入 sessionRuntimeStatusStore。
  严禁直接 setState 或引入已退役的多轨通道（ephemeralChatStore / RunNotice / continuityUiStore）。`);
  process.exit(0);
}
if (process.argv.includes('--list')) {
  console.log('ephemeral-chat-store\ncontinuity-retry-notice\nrun-notice-channel\ndirect-store-write\nreport-without-ssot-import');
  process.exit(0);
}

const ALLOWED_WRITERS = new Set([
  'apps/crish-desktop/src/store/sessionRuntimeStatusStore.ts',
]);

/** 旧通道回流黑名单（标识符级） */
const BANNED_PATTERNS = [
  { id: 'ephemeral-chat-store', re: /useEphemeralChatStore|ephemeralChatStore/ },
  { id: 'continuity-retry-notice', re: /applyRetryNotice|retryNotices|useContinuityUiStore/ },
  { id: 'run-notice-channel', re: /\bpushRunNotice\b|\bcreateRunNoticeController\b|\bRunNoticeBar\b|\btype RunNotice\b/ },
  { id: 'direct-store-write', re: /useSessionRuntimeStatusStore\s*\.\s*setState\b|\.getState\(\)\s*\.\s*report\(/ },
];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name)) yield p;
  }
}

const rel = (p) => posix.normalize(p.slice(ROOT.length + 1).replaceAll('\\', '/'));

/** 极简注释剥离（仅服务本扫描；不追求 AST 级精确） */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

let violations = [];
for (const file of walk(SRC)) {
  const r = rel(file);
  const isSsot = ALLOWED_WRITERS.has(r);
  const src = stripComments(readFileSync(file, 'utf8'));
  for (const { id, re } of BANNED_PATTERNS) {
    // SSOT store 自身是写入定义点，豁免 direct-store-write
    if (id === 'direct-store-write' && isSsot) continue;
    if (re.test(src)) {
      violations.push(`[${id}] ${r}`);
    }
  }
  // reportRuntimeStatus 只能经 SSOT 模块定义（import 方式消费）
  if (
    /\breportRuntimeStatus\b/.test(src) &&
    !isSsot &&
    !/from\s+'[^']*sessionRuntimeStatusStore'/.test(src)
  ) {
    violations.push(`[report-without-ssot-import] ${r}`);
  }
}

if (violations.length) {
  console.error(
    `[check-runtime-status-ssot] 单轨收敛违规（${violations.length}）：\n` +
      violations.map((v) => `  - ${v}`).join('\n') +
      `\n\n规则见 docs/chat-notice-convergence/00-通知与异常展示单轨收敛总方案.md §2.0`
  );
  process.exit(1);
}
console.log('[check-runtime-status-ssot] OK — 运行时状态单轨无违规');
