#!/usr/bin/env node
/**
 * scripts/check-repo-integrity.mjs
 * 仓库完整性门禁（2026-09-11 事故驱动新增）
 *
 * 事故背景：`.git` 的 HEAD / config / index / packed-refs 曾被删除，
 * 目录仍在但仓库不被识别 → 所有 git 命令报 `fatal: not a git repository`。
 * 更危险的是**静默劣化**：仓库不可用时 `git diff <pathA> <pathB>` 会退化为
 * `--no-index` 模式，把两个不同文件互相 diff，产出看似合理的**虚构统计**
 * （例：「1 file changed, 1429 insertions」并显示成 `{A => B}` 重命名）。
 * 该假象一度误导子 Agent 做出错误归因。
 *
 * 本门禁只做一件事：**在任何人相信 git 的产出之前，先证明 git 说的是真话。**
 *
 * 契约标记：@zero-tolerance（不读基线；目标恒为 OK）
 *
 * Run: node scripts/check-repo-integrity.mjs [--quiet]
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ── --guide（T-DEBT-08：正确做法指引 · 五元规约） ─────────────────────────────
// 用法：node scripts/check-repo-integrity.mjs --guide → 打印违反项/定位/阈值/正确做法。
// 仅在直接运行且带 --guide 时早退；不带 flag 时既有行为零变化。
const __debt08GuideFlag = process.argv.includes('--guide');
if (__debt08GuideFlag) {
  const __debt08Guide = [
    "违反项：.git 关键资产（HEAD / config / index / packed-refs）缺失，或 git 命令不可用。",
    "文件:行号 / 当前值：FAIL 输出缺失资产清单。",
    "阈值：全部资产存在且 git rev-parse 可用。",
    "正确做法：从远端重新 clone 或按备份复原 .git；仓库不可用期间产出的 diff 统计一律视为虚构，不得引用。",
    "复核：node scripts/check-repo-integrity.mjs  # 期望 OK",
  ];
  console.log('[check-repo-integrity] 正确做法 · 五元规约\n');
  for (const l of __debt08Guide) console.log('  ' + l);
  process.exit(0);
}

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const GIT_DIR = join(REPO_ROOT, '.git');
const QUIET = process.argv.includes('--quiet');

const problems = [];
const notes = [];

function git(args) {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || String(e.message || e) };
  }
}

// ── 1. `.git` 必须存在且形态正确 ────────────────────────────────────────────
if (!existsSync(GIT_DIR)) {
  problems.push('.git 不存在（仓库元数据缺失或被移除）');
} else {
  const st = statSync(GIT_DIR);
  if (!st.isDirectory()) {
    // 合法形态：linked worktree / submodule 的 `.git` 是文件（内容 `gitdir: <path>`）
    const content = readFileSync(GIT_DIR, 'utf8').trim();
    if (!content.startsWith('gitdir:')) {
      problems.push(`.git 是文件但不是合法 gitdir 指针（内容应形如 "gitdir: <path>"）`);
    } else {
      const target = resolve(REPO_ROOT, content.slice('gitdir:'.length).trim());
      if (!existsSync(target)) problems.push(`.git 指向的 gitdir 不存在：${target}`);
      else notes.push(`linked worktree / submodule 形态：.git → ${target}`);
    }
  } else {
    // 主仓库形态：以下四项核心元数据缺一不可
    const REQUIRED = [
      ['HEAD', 'HEAD 缺失 → 仓库无法被识别（git 会报 not a git repository）'],
      ['config', 'config 缺失 → repositoryformatversion 不可知，仓库无法被识别'],
      ['objects', 'objects 缺失 → 全部历史对象丢失'],
      ['refs', 'refs 缺失 → 全部分支/标签引用丢失'],
    ];
    for (const [name, why] of REQUIRED) {
      if (!existsSync(join(GIT_DIR, name))) problems.push(why);
    }
    // index 可重建（仅缓存），缺失只提示不失败
    if (!existsSync(join(GIT_DIR, 'index'))) {
      notes.push('index 缺失（仅是暂存缓存，可由 `git reset --mixed` 重建，不影响历史）');
    }
    if (!existsSync(join(GIT_DIR, 'packed-refs'))) {
      notes.push('packed-refs 缺失（若分支仅以松散 ref 存在则无碍；常见后果是 tags 引用丢失，objects 仍在但无 ref 指向）');
    }
    // HEAD 内容合法性
    if (existsSync(join(GIT_DIR, 'HEAD'))) {
      const head = readFileSync(join(GIT_DIR, 'HEAD'), 'utf8').trim();
      const validRef = /^ref:\s+refs\//.test(head);
      const validSha = /^[0-9a-f]{40}$/.test(head);
      if (!validRef && !validSha) problems.push(`HEAD 内容非法（应为 "ref: refs/..." 或 40 位 SHA）：${JSON.stringify(head)}`);
      else if (validRef) {
        const refPath = join(GIT_DIR, head.slice('ref:'.length).trim());
        if (!existsSync(refPath)) {
          // 可能由 packed-refs 承载
          notes.push(`HEAD 指向 ${head.slice('ref:'.length).trim()}，该松散 ref 文件不存在（若 packed-refs 正常则无碍）`);
        }
      }
    }
    // config 必须含 [core]
    if (existsSync(join(GIT_DIR, 'config'))) {
      const cfg = readFileSync(join(GIT_DIR, 'config'), 'utf8');
      if (!/^\s*\[core\]/m.test(cfg)) problems.push('config 缺少 [core] 段（仓库格式版本不可知）');
    }
  }
}

// ── 2. 端到端探针：git 必须真的认得这个仓库 ─────────────────────────────────
const top = git(['rev-parse', '--show-toplevel']);
const isRepo = top.ok && top.out && !top.out.includes('not a git repository');
if (!isRepo) {
  problems.push(`git rev-parse --show-toplevel 失败：${top.out.split('\n')[0]}`);
}

// ── 3. 防「静默劣化」联检：仓库不可用时 diff 会伪装成功 ─────────────────────
// 若上一步已判定不是仓库，那么任何 `git diff <a> <b>` 的输出都不可信 —— 明确指出，
// 防止使用者继续基于假 diff 做判断（这正是事故中误导子 Agent 的机制）。
if (!isRepo) {
  const probe = git(['diff', '--numstat', '--', 'package.json', 'README.md']);
  if (probe.ok && probe.out) {
    problems.push(
      '检测到 git 已不可用，但 `git diff <a> <b>` 仍返回了输出 —— ' +
        '这是 `--no-index` 回退产生的**虚构 diff**（把两个不同文件互相比较），严禁据此判断改动。'
    );
  }
}

// ── 4. 报告 ────────────────────────────────────────────────────────────────
const RECOVERY = [
  '恢复指引（本门禁不自动修复，避免二次破坏）：',
  '  · .git/HEAD 缺失 → 由 `.git/logs/HEAD` 末行与 `.git/logs/refs/heads/*` 的体积/末行反推原分支，重建 `ref: refs/heads/<branch>`；',
  '  · .git/config 缺失 → 重建 [core]（repositoryformatversion=0 / filemode=false / bare=false / logallrefupdates=true）；',
  '    若 .git/worktrees/*/config.worktree 存在，还需 [extensions] worktreeConfig=true；',
  '    **不要写 core.autocrlf**，让它继承 system 设定（Windows 通常 true），否则 index 会与 CRLF 工作区不一致；',
  '  · 丢失的分支 ref → 由 .git/worktrees/<name>/logs/HEAD 末行反推 SHA 后重建松散 ref；',
  '  · .git/index 缺失 → `git reset --mixed`（不动工作区）；',
  '  · 重建后用 `git status --porcelain` 核对：删除项（D）应为 0；若出现大量 D 说明 autocrlf 与 index 不一致；',
  '  · packed-refs 缺失导致的 tags 丢失通常不可恢复（objects 仍在但无 ref 指向）。',
];

if (problems.length === 0) {
  if (!QUIET) {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    console.log('[check-repo-integrity] OK: 仓库元数据完整且 git 可识别');
    if (branch.ok) console.log(`  HEAD = ${branch.out}`);
    for (const n of notes) console.log(`  提示：${n}`);
  }
  process.exit(0);
}

console.error('[check-repo-integrity] FAIL: 仓库完整性受损\n');
for (const p of problems) console.error(`  ▶ ${p}`);
if (notes.length) {
  console.error('\n  附带观察：');
  for (const n of notes) console.error(`    · ${n}`);
}
console.error('');
for (const l of RECOVERY) console.error(`  ${l}`);
console.error('');
console.error('  契约：本门禁 @zero-tolerance —— 不读基线，目标恒为 OK。');
process.exit(1);
