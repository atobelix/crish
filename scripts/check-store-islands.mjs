#!/usr/bin/env node
/**
 * scripts/check-store-islands.mjs
 * 会话持久化岛门禁（U-PERSIST-A · D4 票 A · OVL-24 · FM-1）
 *
 * 断言（默认 fail，无 warn 过渡——与 92 §6「门禁假路径」禁止项一致）：
 *   1. sessionStore.ts partialize 结果不得含 sessions / sessionsById 键（AST/结构探针）
 *   2. 生产 src/ 不得 setItem('crish_session_store', …) 且 payload 含 sessions
 *   3. 生产 src/ 不得 getItem('crish_session_store') 后访问 .sessions（兼容读）
 *   4. 本维新增 TODO/FIXME = 0（票 A 收口文件）
 *
 * Run: node scripts/check-store-islands.mjs
 *      npm run check:store-islands
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, normalize, sep, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP_SRC = join(REPO_ROOT, 'apps', 'crish-desktop', 'src');
const SESSION_STORE = join(DESKTOP_SRC, 'store', 'sessionStore.ts');
const SESSION_STORE_KEY = 'crish_session_store';

/** 票 A 收口文件：TODO/FIXME 必须为 0 */
const TICKET_A_FILES = [
  SESSION_STORE,
  join(DESKTOP_SRC, 'api', 'beforeunloadFlush.ts'),
  join(DESKTOP_SRC, 'api', 'session-persistence', 'sessionRustDbHydrate.ts'),
  join(DESKTOP_SRC, 'api', 'session-persistence', 'sessionShellKeyMigration.ts'),
  join(DESKTOP_SRC, 'store', 'sessionCrudActions.ts'),
  join(REPO_ROOT, 'scripts', 'check-store-islands.mjs'),
];

function toPosix(p) {
  return normalize(p).split(sep).join('/');
}

function rel(abs) {
  return toPosix(relative(REPO_ROOT, abs));
}

function collectFiles(dir, out = []) {
  if (!existsSafe(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git')
        continue;
      collectFiles(full, out);
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function existsSafe(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function isTestFile(p) {
  return (
    p.includes('__tests__') || /\.test\.[tj]sx?$/.test(p) || /\.spec\.[tj]sx?$/.test(p)
  );
}

/** 提取 partialize 对象字面量中出现的顶层键名 */
function extractPartializeKeys(source) {
  // 定位 partialize: (s) => ({ … }) 或 partialize: (…) => ({ … })
  const re = /partialize\s*:\s*(?:\([^)]*\)|\w+)\s*=>\s*\(/g;
  let m;
  const keys = new Set();
  while ((m = re.exec(source)) !== null) {
    // 从箭头后第一个 { 开始做括号配对
    let i = m.index + m[0].length;
    // 可能是 ({…}) 或直接 {
    while (i < source.length && /\s/.test(source[i])) i++;
    if (source[i] !== '{') {
      // 形如 partialize: (s) => s.xxx 无对象字面量 → 无法静态枚举，跳过
      continue;
    }
    let depth = 0;
    const start = i;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = source.slice(start, i + 1);
    // 顶层键：行首 / 逗号后 空白 identifier :
    const keyRe = /(?:^|[{,]\s*)([A-Za-z_$][\w$]*)\s*:/g;
    let km;
    let d = 0;
    // 简化：在 body 上扫所有 `ident:`，排除嵌套对象内键由人工 review；
    // 对本文件 partialize 为单层对象字面量，足够。
    while ((km = keyRe.exec(body)) !== null) {
      keys.add(km[1]);
    }
  }
  return keys;
}

const violations = [];

// ── 1. sessionStore partialize 探针 ─────────────────────────────────────────
{
  if (!existsSafe(SESSION_STORE)) {
    violations.push({
      rule: 'partialize_missing_file',
      file: rel(SESSION_STORE),
      detail: 'sessionStore.ts 不存在——partialize 无处检查',
    });
  } else {
    const src = readFileSync(SESSION_STORE, 'utf8');
    const keys = extractPartializeKeys(src);
    if (keys.size === 0) {
      violations.push({
        rule: 'partialize_not_found',
        file: rel(SESSION_STORE),
        detail:
          '未找到 partialize 对象字面量——票 A 契约要求显式 partialize 且无 sessions',
      });
    }
    for (const banned of ['sessions', 'sessionsById']) {
      if (keys.has(banned)) {
        violations.push({
          rule: 'partialize_has_sessions',
          file: rel(SESSION_STORE),
          detail: `partialize 返回对象含禁止键 "${banned}"（DEL-5 物理切除）`,
        });
      }
    }
    // 期望白名单三元组（允许未来扩展非会话 meta，但 sessions 必须缺席）
    // 额外校验：merge 不得回灌 sessions（静态探针：merge 体内出现 sessions 赋值）
    const mergeIdx = src.indexOf('merge:');
    if (mergeIdx >= 0) {
      // 取 merge 到下一个顶层选项/结束的粗粒度切片
      const slice = src.slice(mergeIdx, mergeIdx + 800);
      // 禁止模式：把 persisted.sessions 赋给 state.sessions
      if (/sessions\s*[:=]\s*[^/\n]*\.sessions\b/.test(slice) &&
          !/sessions\s*[:=]\s*current\.sessions/.test(slice) &&
          !/sessionsById\s*[:=]\s*current\.sessionsById/.test(slice)) {
        // 更精确：禁止 p.sessions / persisted.sessions 出现在赋值右侧
        if (/\bp\.sessions\b|\bpersisted\.sessions\b/.test(slice)) {
          violations.push({
            rule: 'merge_rehydrates_sessions',
            file: rel(SESSION_STORE),
            detail: 'merge 将 persisted.sessions 并回内存——违反零兼容读（A-2）',
          });
        }
      }
    }
  }
}

// ── 2/3. 全 src 生产代码：setItem sessions / getItem .sessions ──────────────
{
  const files = collectFiles(DESKTOP_SRC);
  for (const abs of files) {
    if (isTestFile(abs)) continue;
    // 迁移器本身允许读 raw 键做一次性剥离（不读 .sessions 回灌）
    const relPath = rel(abs);
    const isMigrator =
      relPath.endsWith('sessionShellKeyMigration.ts');
    const src = readFileSync(abs, 'utf8');
    const lines = src.split(/\r?\n/);

    for (let n = 0; n < lines.length; n++) {
      const line = lines[n];

      // 规则 2：setItem('crish_session_store' …) 且 payload 含 sessions
      if (
        line.includes('setItem') &&
        line.includes(SESSION_STORE_KEY) &&
        /\bsessions\s*:/.test(line)
      ) {
        violations.push({
          rule: 'write_sessions_to_shell_key',
          file: relPath,
          line: n + 1,
          detail: `setItem(${SESSION_STORE_KEY}) payload 含 sessions——LS 岛双写`,
        });
      }

      // 规则 3：getItem 后访问 .sessions（兼容读）——迁移器豁免
      if (!isMigrator && line.includes('getItem') && line.includes(SESSION_STORE_KEY)) {
        // 同行或紧随窗口内访问 .sessions
        const window = lines.slice(n, n + 3).join('\n');
        if (/\.sessions\b/.test(window) && !/sessionsById/.test(window.replace(/sessionsById/g, ''))) {
          // 更严：任何 .sessions 字段访问（非 sessionsById）都算兼容读
          if (/(?<!sessionsBy)\.sessions\b/.test(window)) {
            violations.push({
              rule: 'read_sessions_from_shell_key',
              file: relPath,
              line: n + 1,
              detail: `getItem(${SESSION_STORE_KEY}) 后访问 .sessions——兼容读禁止（A-2）`,
            });
          }
        }
      }

      // 通用：生产代码不得用 crish_session_store 键读 sessions 字段
      if (!isMigrator && new RegExp(`['"\`]${SESSION_STORE_KEY}['"\`]`).test(line)) {
        // 允许 name: 'crish_session_store' 声明与注释
        if (/name\s*:/.test(line) || /^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        const window = lines.slice(n, Math.min(n + 5, lines.length)).join('\n');
        if (/(?<!sessionsBy)\.sessions\b/.test(window) && !/sessionsById/.test(window)) {
          if (!violations.some((v) => v.rule === 'read_sessions_from_shell_key' && v.file === relPath && v.line === n + 1)) {
            violations.push({
              rule: 'read_sessions_from_shell_key',
              file: relPath,
              line: n + 1,
              detail: `引用 ${SESSION_STORE_KEY} 且窗口内访问 .sessions`,
            });
          }
        }
      }
    }
  }
}

// ── 4. 票 A 收口文件 TODO/FIXME = 0 ─────────────────────────────────────────
{
  for (const abs of TICKET_A_FILES) {
    if (!existsSafe(abs)) continue;
    if (abs.endsWith('check-store-islands.mjs')) continue; // 本脚本头注释可含说明词
    const src = readFileSync(abs, 'utf8');
    const lines = src.split(/\r?\n/);
    for (let n = 0; n < lines.length; n++) {
      if (/\b(TODO|FIXME)\b/.test(lines[n])) {
        violations.push({
          rule: 'ticket_a_todo',
          file: rel(abs),
          line: n + 1,
          detail: '票 A 收口文件不得残留 TODO/FIXME（本维负向断言）',
        });
      }
    }
  }
}

// ── 报告 ────────────────────────────────────────────────────────────────────
if (violations.length === 0) {
  console.log('[check-store-islands] OK — partialize 无 sessions；LS 岛 0 兼容读写；票 A TODO=0');
  process.exit(0);
}

console.error('[check-store-islands] FAIL — %d violation(s)\n', violations.length);
for (const v of violations) {
  const loc = v.line ? `${v.file}:${v.line}` : v.file;
  console.error(`  · ${v.rule} · ${loc} · ${v.detail}`);
}
console.error(
  '\n修复指引：\n' +
    '  1. partialize 仅保留 activeSessionId / folderOrder / composerDrafts；\n' +
    '  2. 删除对 crish_session_store 的 sessions 读写（正文走 SQLite hydrate）；\n' +
    '  3. beforeunload 只写 meta 壳，不镜像 messages；\n' +
    '  4. 清除本票收口文件中的 TODO/FIXME。'
);
process.exit(1);
