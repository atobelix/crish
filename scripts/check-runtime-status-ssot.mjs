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
 * 3. domain-message-as-thought：禁止 onThought?.(DOMAIN_MESSAGES.*)（FINAL-PLAN §2.1）。
 * 4. busy-branch-followup：SESSION_BUSY / S7 分支内禁止 runControl.followUp（P1-d 方案 B）。
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
  console.log('ephemeral-chat-store\ncontinuity-retry-notice\nrun-notice-channel\ndirect-store-write\nbanned-legacy-nodes\nerror-detail-write\nreport-without-ssot-import\ndomain-message-as-thought\nbusy-branch-followup');
  process.exit(0);
}

const ALLOWED_WRITERS = new Set([
  'apps/crish-desktop/src/store/sessionRuntimeStatusStore.ts',
]);

const ALLOWED_ERROR_DETAIL_WRITERS = new Set([
  'apps/crish-desktop/src/hooks/chat-stream/staleSessionHealer.ts',
  'apps/crish-desktop/src/store/sessionMessageActionsTools.ts',
]);

/** 旧通道回流黑名单（标识符级） */
const BANNED_PATTERNS = [
  { id: 'ephemeral-chat-store', re: /useEphemeralChatStore|ephemeralChatStore/ },
  { id: 'continuity-retry-notice', re: /applyRetryNotice|retryNotices|useContinuityUiStore/ },
  { id: 'run-notice-channel', re: /\bpushRunNotice\b|\bcreateRunNoticeController\b|\bRunNoticeBar\b|\btype RunNotice\b/ },
  { id: 'direct-store-write', re: /useSessionRuntimeStatusStore\s*\.\s*setState\b|\.getState\(\)\s*\.\s*report\(/ },
  { id: 'banned-legacy-nodes', re: /\bRetrySlotNotice\b|\bTurnErrorNode\b|\bModelRetryNode\b/ },
  { id: 'error-detail-write', re: /\bsetSessionMessageStatus\([^)]*\berrorDetail\s*:|\.errorDetail\s*=/ },
  // FINAL-PLAN §2.1：用户可见域文案（DOMAIN_MESSAGES.*）禁止当作思考流写入（会被渲染成「已思考」行）
  { id: 'domain-message-as-thought', re: /\bonThought\s*\??\.?\s*\(\s*DOMAIN_MESSAGES\./ },
];

/**
 * busy-branch-followup（FINAL-PLAN §2.1 / P1-d 方案 B）：
 * 串行守卫（SESSION_BUSY / S7）分支内禁止调用 runControl.followUp——
 * runId 为空的 followUp 到不了后端 follow_up 环，属静默空调用；重发只走前端 drain。
 * 识别：`if (isSessionBusy…) {…}` / `if (…SESSION_BUSY…) {…}` / `if (…=== 'S7'…) {…}` 的块体。
 */
const BUSY_BRANCH_RE = /if\s*\(([^)]*(?:isSessionBusy|SESSION_BUSY|===\s*'S7')[^)]*)\)\s*\{/g;
function busyBranchBodies(src) {
  const bodies = [];
  BUSY_BRANCH_RE.lastIndex = 0;
  let m;
  while ((m = BUSY_BRANCH_RE.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    bodies.push(src.slice(start, i));
  }
  return bodies;
}

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
    if (id === 'error-detail-write' && (ALLOWED_ERROR_DETAIL_WRITERS.has(r) || /\.(test|spec)\.(ts|tsx)$/.test(r))) continue;
    if (re.test(src)) {
      violations.push(`[${id}] ${r}`);
    }
  }
  if (!/\.(test|spec)\.(ts|tsx)$/.test(r)) {
    for (const body of busyBranchBodies(src)) {
      if (/\bfollowUp\s*\(/.test(body)) {
        violations.push(`[busy-branch-followup] ${r}`);
        break;
      }
    }
  }
  // reportRuntimeStatus 只能经 SSOT 模块定义或 facade 导出（import 方式消费）
  if (
    /\breportRuntimeStatus\b/.test(src) &&
    !isSsot &&
    !/from\s+'[^']*(?:sessionRuntimeStatusStore|storeAccess)'/.test(src)
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
