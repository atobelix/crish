// ============================================================
// 代码文件行数门禁（战役 table-systemic-remediation · T0 附带加固）
//
// 目标：遏制「单文件无限膨胀」，让「该拆就拆」成为可自动判定的契约。
//
// 三档判定（针对不同类型的代码文件使用不同策略）：
//   ① 合规   lines <= limit
//   ② 警告   limit < lines <= ceil(limit × WARN_RATIO)   —— 只提示，不失败
//            （用户口径：超限 30% 以内不强制改动）
//   ③ 违规   lines >  ceil(limit × WARN_RATIO)           —— exit 1
//            处理方式二选一：**拆分文件**，或**显式登记进 PROTECTED 例外名单**
//
// 例外名单（PROTECTED）：
//   - 名单**手写在源码里**（不是外部 JSON）——新增例外必须是一次可 review 的代码改动，
//     杜绝「静默把膨胀文件加进白名单」；
//   - 每个例外记录 `ceiling`（冻结天花板）+ `reason`（理由）；
//   - **棘轮**：ceiling 只允许收紧（文件变小后可 `--freeze` 下调），不得上调。
//     → 例外文件同样**不许继续长大**。
//
// 用法：
//   node scripts/check-file-length.mjs                 # 门禁校验（CI）
//   node scripts/check-file-length.mjs --report        # 只打印
//   node scripts/check-file-length.mjs --freeze        # 按当前实际行数下调 PROTECTED 的 ceiling（只降不升）
// ============================================================
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** 超限容忍比例：超限 30% 以内只警告，不失败（用户口径） */
export const WARN_RATIO = 1.3;

/**
 * 类型策略表（顺序即优先级，首个命中生效）。
 * `limit` 是**目标行数**；判定阈值 = ceil(limit × WARN_RATIO)。
 */
export const POLICIES = [
  { id: 'src-worker', match: /^src\/worker\/.*\.ts$/, limit: 400, desc: 'Worker：单一职责的解析/计算单元' },
  { id: 'src-core-logic', match: /^src\/core\/.*\.ts$/, limit: 600, desc: '核心纯逻辑：应可单测、可独立拆分' },
  { id: 'src-core-ui', match: /^src\/core\/.*\.tsx$/, limit: 400, desc: '核心层 UI：不应承载视图' },
  { id: 'src-component', match: /^src\/components\/.*\.tsx$/, limit: 600, desc: 'React 组件：单一职责，超出即拆子组件' },
  { id: 'src-component-logic', match: /^src\/components\/.*\.ts$/, limit: 400, desc: '组件层非 UI 逻辑：应下沉到 core' },
  { id: 'src-shell', match: /^src\/[^/]+\.(ts|tsx)$/, limit: 600, desc: '应用壳层：聚合入口，避免堆积业务' },
  { id: 'src-style', match: /^src\/.*\.css$/, limit: 800, desc: '样式：应按域拆分为多文件' },
  {
    id: 'script-verify-harness',
    match: /^scripts\/verify-.*\.mjs$/,
    limit: 1200,
    desc: '验收 harness：按场景独立累积，应继续按场景组拆分（当前在警告带内，非阻断）',
  },
  { id: 'script', match: /^scripts\/.*\.mjs$/, limit: 450, desc: '门禁/工具脚本：单一检查职责' },
  { id: 'test-unit', match: /^tests\/unit\/.*\.ts$/, limit: 700, desc: '单元测试：按被测单元拆文件' },
  { id: 'test-gate', match: /^tests\/gate\/.*\.ts$/, limit: 500, desc: '契约测试：按契约域拆文件' },
  { id: 'test-e2e', match: /^tests\/e2e\/.*\.ts$/, limit: 700, desc: 'e2e：按交互域拆 spec' },
  {
    id: 'test-perf',
    match: /^tests\/perf\/.*\.mjs$/,
    limit: 1000,
    desc: '性能套件：按场景累积，应继续按场景组拆分（当前在警告带内，非阻断）',
  },
  { id: 'test-other', match: /^tests\/.*\.(ts|mjs|js)$/, limit: 700, desc: '其余测试资产' },
];

/**
 * 行数保护例外名单（**手写，改动可见**）。
 * 冻结于 2026-09-14（T0）。ceiling 只允许收紧。
 * 新增条目必须：① 有明确 reason；② 在 docs/table-systemic-remediation 或对应战役文档中留痕。
 */
export const PROTECTED = {
  'src/core/parser.ts': {
    ceiling: 3677,
    reason: 'CommonMark 全量语法解析单文件；拆分需先完成投影器/增量状态机解耦，另立战役',
  },
  'src/core/EditorStore.ts': {
    ceiling: 3060,
    reason: '文档状态机 + 编辑操作总入口；拆分需先冻结 op 契约，另立战役',
  },
  'src/components/HiddenInput.tsx': {
    ceiling: 2838,
    reason: '键盘/选区/输入法单一宿主；拆分需先抽出键位表与事务派发，另立战役',
  },
  'src/components/MarkdownEngine.tsx': {
    ceiling: 2672,
    reason: '虚拟化 + 批量测量 + 行渲染编排；本战役 T4 只允许改测量区段，拆分另立战役',
  },
  'src/index.css': {
    ceiling: 2050,
    reason: '全局样式单文件；本战役 T3/T6 新增岛样式后应下调 ceiling，禁止继续增长',
  },
  'src/components/BlockRenderer.tsx': {
    ceiling: 1801,
    reason: '块级渲染器总表；本战役 T1/T3 改造表格块后应下调 ceiling',
  },
  'src/core/measure.ts': {
    ceiling: 1573,
    reason: '字符索引↔屏幕坐标测量；拆分需先固化测量协议，另立战役',
  },
  'src/components/InlineRenderer.tsx': {
    ceiling: 1062,
    reason: '行内 token 渲染；本战役 T3（列宽段）/T5（选区段）删除后应下调 ceiling',
  },
  'src/core/renderToHtml.ts': {
    ceiling: 937,
    reason: '导出投影器；本战役 T7 改造表格投影后应下调 ceiling',
  },
  'src/core/TableOperations.ts': {
    ceiling: 832,
    reason: '表格结构操作库；T6 若要新增行列重排/表头开关/排序，**必须先拆分模块**（本门禁不允许其增长）',
  },
  'src/App.tsx': {
    ceiling: 812,
    reason: '应用壳层 + 顶部工具栏编排；拆分需先抽离工具栏，另立战役',
  },
};

// ── 工具 ─────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-ssr', '.git', 'test-results', 'playwright-report']);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else yield p;
  }
}

function countLines(file) {
  const text = readFileSync(file, 'utf-8');
  if (text.length === 0) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

function policyFor(relPath) {
  return POLICIES.find((p) => p.match.test(relPath)) ?? null;
}

export function collect() {
  const rows = [];
  for (const dir of ['src', 'scripts', 'tests']) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const file of walk(abs)) {
      const rel = posix.join(dir, relative(abs, file).replaceAll('\\', '/'));
      const policy = policyFor(rel);
      if (!policy) continue;
      const lines = countLines(file);
      const threshold = Math.ceil(policy.limit * WARN_RATIO);
      const protectedEntry = PROTECTED[rel] ?? null;
      let status;
      if (protectedEntry) {
        status = lines > protectedEntry.ceiling ? 'violation' : 'protected';
      } else if (lines > threshold) {
        status = 'violation';
      } else if (lines > policy.limit) {
        status = 'warn';
      } else {
        status = 'ok';
      }
      rows.push({ rel, lines, policy, threshold, status, protectedEntry });
    }
  }
  return rows.sort((a, b) => b.lines - a.lines);
}

// ── 主流程 ───────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const reportOnly = args.includes('--report');
  const freeze = args.includes('--freeze');

  const rows = collect();
  const violations = rows.filter((r) => r.status === 'violation');
  const warns = rows.filter((r) => r.status === 'warn');
  const protectedRows = rows.filter((r) => r.status === 'protected');

  console.log('代码文件行数门禁（按类型分策略 · 超限 30% 内仅警告）');
  console.log(`  策略表 ${POLICIES.length} 类；例外名单 ${Object.keys(PROTECTED).length} 个（棘轮：只降不升）`);
  console.log('');

  if (reportOnly) {
    console.log('  ── 违规（> limit×1.3 且不在例外名单）──');
    if (violations.length === 0) console.log('    （无）');
    for (const r of violations) {
      console.log(`    ✗ ${r.rel.padEnd(42)} ${String(r.lines).padStart(5)} 行  [${r.policy.id}] limit=${r.policy.limit} 阈值=${r.threshold}`);
    }
    console.log('  ── 警告（limit 与 limit×1.3 之间）──');
    if (warns.length === 0) console.log('    （无）');
    for (const r of warns) {
      console.log(`    ! ${r.rel.padEnd(42)} ${String(r.lines).padStart(5)} 行  [${r.policy.id}] limit=${r.policy.limit}`);
    }
    console.log('  ── 例外名单（冻结天花板）──');
    for (const r of protectedRows) {
      const slack = r.protectedEntry.ceiling - r.lines;
      console.log(
        `    · ${r.rel.padEnd(42)} ${String(r.lines).padStart(5)} / ${String(r.protectedEntry.ceiling).padStart(5)} 行` +
          (slack > 0 ? `  （可收紧 ${slack}）` : '')
      );
    }
    console.log('');
    console.log(`  合规 ${rows.length - violations.length - warns.length - protectedRows.length} / 警告 ${warns.length} / 例外 ${protectedRows.length} / 违规 ${violations.length}`);
    process.exit(0);
  }

  if (freeze) {
    // 只允许**下调** ceiling（棘轮），且不允许新增例外条目
    let changed = 0;
    const unknown = [];
    const lines = readFileSync(new URL(import.meta.url), 'utf-8').split('\n');
    for (const r of protectedRows) {
      const entry = r.protectedEntry;
      if (r.lines < entry.ceiling) {
        const re = new RegExp(`('${r.rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':\\s*\\{\\s*\\n\\s*ceiling:\\s*)\\d+`);
        const next = lines.join('\n').replace(re, `$1${r.lines}`);
        if (next !== lines.join('\n')) {
          writeFileSync(new URL(import.meta.url), next, 'utf-8');
          console.log(`  ↓ ${r.rel}  ceiling ${entry.ceiling} → ${r.lines}`);
          changed++;
        }
      }
    }
    for (const r of violations) {
      if (!PROTECTED[r.rel]) unknown.push(r);
    }
    if (unknown.length > 0) {
      console.error('\n✗ --freeze 拒绝新增例外条目。请手工编辑 PROTECTED 并写明 reason：');
      for (const r of unknown) console.error(`    ${r.rel}  ${r.lines} 行`);
      process.exit(1);
    }
    console.log(`\n✓ 已收紧 ${changed} 个例外天花板（棘轮只降不升）`);
    process.exit(0);
  }

  if (violations.length > 0) {
    console.error(`✗ check-file-length：${violations.length} 个文件违规（超 limit×${WARN_RATIO} 且不在例外名单）`);
    for (const r of violations) {
      console.error(
        `    ${r.rel}  ${r.lines} 行 > 阈值 ${r.threshold}（limit=${r.policy.limit}，策略 ${r.policy.id}）`
      );
      console.error(`      处置：拆分为多个文件；或（确有必要时）手工加入 PROTECTED 并写明 reason`);
    }
    process.exit(1);
  }

  const slackTotal = protectedRows.reduce((n, r) => n + (r.protectedEntry.ceiling - r.lines), 0);
  console.log(
    `✓ check-file-length：0 违规（合规 ${rows.length - warns.length - protectedRows.length} / 警告 ${warns.length} / 例外 ${protectedRows.length}）` +
      (slackTotal > 0 ? `；例外名单可收紧 ${slackTotal} 行，建议随本战役收敛后 --freeze` : '')
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
