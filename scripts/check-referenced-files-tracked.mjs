#!/usr/bin/env node
/**
 * 引用即入库门禁（A11）：CI workflow / 本地 composite action / husky 钩子 / package.json
 * scripts 中**引用到的仓库内文件**，必须被 git 跟踪。
 *
 * 背景：.gitignore 采用「全局忽略 + 白名单放行」模式，新增配置/脚本很容易被某条
 * 忽略规则吞掉——本地有文件一切正常，CI checkout 后文件不存在才挂（2026-10 实测：
 * .dependency-cruiser.cjs 被 .gitignore 第 247 行忽略、从未入库，CI 的
 * `npx depcruise --config .dependency-cruiser.cjs` 必挂）。本门禁把「引用了但没入库」
 * 在提交前/CI 中直接拦下。
 *
 * 判定口径：
 * - 抽取：workflow / action 的 `run:` 与 `uses: ./…`、husky 钩子正文、各 workspace
 *   package.json 的 scripts 中形如「相对路径 + 已知扩展名」的 token（含 --config 参数）。
 * - 解析基准：workflow/action/husky 相对仓库根（step 带 working-directory 时以其为基准）；
 *   package.json scripts 相对该 package.json 所在目录。
 * - 判定：解析后路径必须出现在 `git ls-files` 中（或为被跟踪文件的父目录，如 uses: ./dir）。
 * - 构建/运行产物（coverage/、dist/、perf-report/、*.log 等）不是「引用的输入文件」，
 *   列在 GENERATED_PREFIXES / GENERATED_EXT 中排除——只能加真正由命令自身产出的路径。
 *
 * 用法：node scripts/check-referenced-files-tracked.mjs [--list] [--guide]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv.includes('--guide')) {
  const guide = [
    '违反项：workflow / composite action / husky / package.json scripts 引用的文件未被 git 跟踪。',
    '定位：输出 <来源文件>:<行号> → <被引用路径>（解析后相对仓库根）。',
    '阈值：0（任何一条即 exit 1，无基线）。',
    '正确做法：确认文件应入库后 git add；若被 .gitignore 吞掉，修 .gitignore（删除误伤规则或加精确 ! 放行），',
    '  禁止把引用从 workflow 删掉或把路径加进本脚本排除表来“通过”；排除表只收命令自身产出的构建产物。',
    '复核：node scripts/check-referenced-files-tracked.mjs  # 期望 exit 0',
  ];
  console.log('[check-referenced-files-tracked] 正确做法 · 五元规约\n');
  for (const l of guide) console.log('  ' + l);
  process.exit(0);
}
const LIST = process.argv.includes('--list');

// 由命令自身产出（或运行期生成）的路径前缀：不是“引用的输入文件”
const GENERATED_PREFIXES = [
  'coverage/',
  'perf-report/',
  'test-results/',
  'playwright-report/',
  'node_modules/',
  'target/',
];
// 任意层级的 dist/ 目录均为构建产物（各 workspace 的 tsc / vite 输出，.gitignore: dist/）
const GENERATED_SEGMENT_RE = /(^|\/)dist\//;
const GENERATED_EXT = ['.log', '.sarif'];

const EXT = '(?:mjs|cjs|js|ts|tsx|mts|cts|json|jsonc|toml|ya?ml|sh|ps1|py|md)';
// 相对路径 token：可带 ./ 前缀；不含 shell 元字符、glob、表达式
const TOKEN_RE = new RegExp(
  `(?<![\\w$/.{-])((?:\\.{1,2}/)?[\\w.@-]+(?:/[\\w.@-]+)*\\.${EXT})(?![\\w/*])`,
  'g'
);

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

const tracked = new Set(git(['ls-files', '-z']).split('\0').filter(Boolean));
const trackedDirs = new Set();
for (const f of tracked) {
  let d = posix.dirname(f);
  while (d && d !== '.' && !trackedDirs.has(d)) {
    trackedDirs.add(d);
    d = posix.dirname(d);
  }
}

const refs = []; // { source, line, baseDir, token }

function addTokens(source, lineNo, text, baseDir) {
  if (/^\s*#/.test(text)) return; // 注释行
  const cleaned = text
    .replace(/\$\{\{[^}]*\}\}/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
  for (const m of cleaned.matchAll(TOKEN_RE)) {
    const token = m[1];
    if (/^[\w.-]+@\d/.test(token)) continue; // npm@11.6.2 之类的包规格
    if (
      !token.includes('/') &&
      !/^\.[\w-]/.test(token) &&
      !/\.(config|setup|globalSetup)\./.test(token)
    ) {
      // 无目录的裸文件名：只收点文件（.dependency-cruiser.cjs）与 *.config.* 配置；
      // 其余裸名（package.json 之类）多为工具隐式读取或文档字样，不作引用判定
      continue;
    }
    refs.push({ source, line: lineNo, baseDir, token });
  }
}

// ── workflow / composite action ───────────────────────────────────────────
function walkYaml(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkYaml(p));
    else if (/\.ya?ml$/.test(e.name)) out.push(p);
  }
  return out;
}
const yamlFiles = [
  ...walkYaml(join(ROOT, '.github', 'workflows')),
  ...walkYaml(join(ROOT, '.github', 'actions')),
];
for (const abs of yamlFiles) {
  const rel = relative(ROOT, abs).replace(/\\/g, '/');
  const lines = readFileSync(abs, 'utf8').split('\n');
  let inRun = false;
  let runIndent = 0;
  let workDir = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.length - line.trimStart().length;
    const t = line.trim();
    if (/^-\s/.test(t) || /^-$/.test(t)) workDir = ''; // 新 step
    const wd = t.match(
      /^(?:-\s+)?working-directory:\s*['"]?([^'"#]+?)['"]?\s*$/
    );
    if (wd) workDir = wd[1].trim();
    const uses = t.match(/^(?:-\s+)?uses:\s*(\.\/[^\s#]+)/);
    if (uses) {
      refs.push({
        source: rel,
        line: i + 1,
        baseDir: '',
        token: uses[1],
        isAction: true,
      });
      continue;
    }
    if (inRun) {
      if (t === '' || indent > runIndent) {
        addTokens(rel, i + 1, line, workDir);
        continue;
      }
      inRun = false;
    }
    const run = t.match(/^(?:-\s+)?run:\s*(.*)$/);
    if (run) {
      if (/^[|>][+-]?\s*$/.test(run[1])) {
        inRun = true;
        runIndent = indent + (t.startsWith('- ') ? 2 : 0);
      } else {
        addTokens(rel, i + 1, run[1], workDir);
      }
    }
  }
}

// ── husky 钩子 ─────────────────────────────────────────────────────────────
const huskyDir = join(ROOT, '.husky');
if (existsSync(huskyDir)) {
  for (const e of readdirSync(huskyDir, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const rel = `.husky/${e.name}`;
    readFileSync(join(huskyDir, e.name), 'utf8')
      .split('\n')
      .forEach((l, i) => addTokens(rel, i + 1, l, ''));
  }
}

// ── package.json scripts（根 + workspaces） ─────────────────────────────────
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const pkgDirs = ['', ...(rootPkg.workspaces || [])];
for (const d of pkgDirs) {
  const pj = join(ROOT, d, 'package.json');
  if (!existsSync(pj)) continue;
  const rel = (d ? `${d}/` : '') + 'package.json';
  const src = readFileSync(pj, 'utf8');
  const scripts = JSON.parse(src).scripts || {};
  const srcLines = src.split('\n');
  for (const [k, cmd] of Object.entries(scripts)) {
    const lineNo = srcLines.findIndex((l) => l.includes(`"${k}":`)) + 1;
    addTokens(rel, lineNo, String(cmd), d);
  }
}

// ── 判定 ───────────────────────────────────────────────────────────────────
const missing = [];
let checked = 0;
for (const r of refs) {
  const joined = posix.normalize(
    posix.join(r.baseDir.replace(/\\/g, '/'), r.token)
  );
  if (joined.startsWith('..')) continue; // 仓库外路径
  const p = joined.replace(/^\.\//, '');
  if (
    GENERATED_PREFIXES.some((g) => p.startsWith(g)) ||
    GENERATED_SEGMENT_RE.test(p) ||
    GENERATED_EXT.some((e) => p.endsWith(e))
  )
    continue;
  checked++;
  const ok = r.isAction
    ? tracked.has(`${p}/action.yml`) || tracked.has(`${p}/action.yaml`)
    : tracked.has(p) || trackedDirs.has(p);
  if (!ok) missing.push({ ...r, resolved: r.isAction ? `${p}/action.yml` : p });
}

if (LIST) {
  for (const r of refs) console.log(`${r.source}:${r.line}  ${r.token}`);
}
console.log(
  `[check-referenced-files-tracked] 引用 ${refs.length} 处，判定 ${checked} 处（来源：${yamlFiles.length} 个 workflow/action、.husky、${pkgDirs.length} 个 package.json）`
);
if (missing.length) {
  console.error(
    `[check-referenced-files-tracked] FAIL: ${missing.length} 处引用的文件未被 git 跟踪：`
  );
  for (const m of missing) {
    let why = '';
    try {
      why = git(['check-ignore', '-v', '--no-index', '--', m.resolved]).trim();
    } catch {
      why = existsSync(join(ROOT, m.resolved))
        ? '（未忽略但未 git add）'
        : '（文件不存在）';
    }
    console.error(`  ${m.source}:${m.line} → ${m.resolved}  ${why}`);
  }
  console.error(
    '[check-referenced-files-tracked] 处置：入库该文件或修正 .gitignore；详见 --guide'
  );
  process.exit(1);
}
console.log('[check-referenced-files-tracked] OK: 所有被引用文件均已入库');
