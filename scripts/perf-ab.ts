/**
 * 同机交错 A/B 基准运行器。
 *
 * 在「同一台机器」上把 base（对比基准提交）与 head（当前工作区代码）的
 * packages/shared-utils/src/bench/run-benchmarks.ts 各跑 N 轮，每轮一个独立
 * Node 进程，按 ABBA 交错顺序执行以抵消机器漂移（温度、邻居负载、频率调节）。
 * 每轮每项基准取样本中位数作为一次观测，写入 perf-report/ab-result.json，
 * 由 scripts/compare-benchmarks.ts 做统计判定。
 *
 * 用法：
 *   npx tsx scripts/perf-ab.ts [--base-ref <git-ref>] [--rounds 10] [--out perf-report/ab-result.json]
 *   --base-ref 默认 HEAD（即「工作区未提交改动 vs 最近一次提交」）。CI 中传入
 *   push 前的提交或 PR 的 base 提交。base 代码通过临时 git worktree 检出到
 *   perf-report/.ab-base（perf-report/ 已被 .gitignore 忽略），结束后自动移除。
 *   base 与 head 共用 head 的 node_modules（被测模块只依赖 Node 内置模块与本包源码）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const BENCH_SCRIPT = join(
  'packages',
  'shared-utils',
  'src',
  'bench',
  'run-benchmarks.ts'
);

interface Args {
  baseRef: string;
  rounds: number;
  out: string;
}

interface SuiteFile {
  benchmarks: Array<{
    name: string;
    samples?: Array<{ elapsedMs: number }>;
    error?: string;
  }>;
}

export interface AbRoundRecord {
  side: 'base' | 'head';
  round: number;
  exitCode: number | null;
  /** 每项基准本轮样本中位数（ms）；基准报错或无样本时为 null */
  medians: Record<string, number | null>;
  errors: string[];
}

export interface AbResultFile {
  timestamp: string;
  method: 'same-machine-interleaved-ab';
  baseRef: string;
  baseSha: string;
  headSha: string;
  headDirty: boolean;
  rounds: number;
  environment: {
    os: string;
    cpu: string;
    cpuCount: number;
    memory: string;
    nodeVersion: string;
  };
  runs: AbRoundRecord[];
  /** 汇总：name -> 每轮中位数（按轮次顺序；null 表示该轮失败） */
  benchmarks: Array<{
    name: string;
    base: Array<number | null>;
    head: Array<number | null>;
  }>;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    baseRef: 'HEAD',
    rounds: 10,
    out: join('perf-report', 'ab-result.json'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--base-ref' && next) {
      args.baseRef = next;
      i++;
    } else if (a === '--rounds' && next) {
      args.rounds = Number.parseInt(next, 10);
      i++;
    } else if (a === '--out' && next) {
      args.out = next;
      i++;
    } else if (a === '--help') {
      console.log(
        '用法: npx tsx scripts/perf-ab.ts [--base-ref <git-ref>] [--rounds 10] [--out perf-report/ab-result.json]'
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${a}`);
    }
  }
  if (!Number.isInteger(args.rounds) || args.rounds < 3) {
    throw new Error(`--rounds 必须是 >= 3 的整数，收到 ${args.rounds}`);
  }
  return args;
}

function git(args: string[], cwd = process.cwd()): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function runOnce(
  side: 'base' | 'head',
  round: number,
  script: string,
  tsxCli: string,
  scratchRoot: string
): AbRoundRecord {
  // 每轮独立 cwd：run-benchmarks.ts 把结果写到 <cwd>/perf-report/benchmark-result.json。
  // scratch 目录位于仓库内，使 tsx 与依赖沿目录向上解析到仓库根 node_modules。
  const cwd = join(scratchRoot, `${side}-${String(round).padStart(2, '0')}`);
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  const proc = spawnSync(process.execPath, [tsxCli, script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production' },
    maxBuffer: 64 * 1024 * 1024,
  });
  const record: AbRoundRecord = {
    side,
    round,
    exitCode: proc.status,
    medians: {},
    errors: [],
  };
  if (proc.error) {
    record.errors.push(`进程启动失败: ${proc.error.message}`);
    return record;
  }
  const resultPath = join(cwd, 'perf-report', 'benchmark-result.json');
  if (!existsSync(resultPath)) {
    record.errors.push(`未生成结果文件 (exit=${proc.status})\n${proc.stderr}`);
    return record;
  }
  const suite = JSON.parse(readFileSync(resultPath, 'utf8')) as SuiteFile;
  for (const b of suite.benchmarks) {
    const samples = (b.samples ?? [])
      .map((s) => s.elapsedMs)
      .filter((v) => Number.isFinite(v));
    if (b.error || samples.length === 0) {
      record.medians[b.name] = null;
      record.errors.push(`${b.name}: ${b.error ?? '无样本'}`);
    } else {
      record.medians[b.name] = medianOf(samples);
    }
  }
  return record;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = git(['rev-parse', '--show-toplevel']);
  process.chdir(repoRoot);

  const tsxCli = resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!existsSync(tsxCli)) {
    throw new Error(`找不到 tsx CLI: ${tsxCli}（先执行 npm ci）`);
  }

  const baseSha = git(['rev-parse', '--verify', `${args.baseRef}^{commit}`]);
  const headSha = git(['rev-parse', 'HEAD']);
  const headDirty =
    git(['status', '--porcelain', '--untracked-files=no']).length > 0;

  const reportDir = resolve(repoRoot, 'perf-report');
  const baseDir = join(reportDir, '.ab-base');
  const scratchRoot = join(reportDir, 'ab-runs');
  rmSync(scratchRoot, { recursive: true, force: true });

  if (existsSync(baseDir)) {
    git(['worktree', 'remove', '--force', baseDir]);
  }
  git(['worktree', 'add', '--detach', baseDir, baseSha]);

  try {
    const baseScript = join(baseDir, BENCH_SCRIPT);
    const headScript = join(repoRoot, BENCH_SCRIPT);
    if (!existsSync(baseScript)) {
      throw new Error(
        `base 提交 ${baseSha} 中不存在 ${BENCH_SCRIPT}，无法做 A/B 对比`
      );
    }

    console.log('='.repeat(60));
    console.log('同机交错 A/B 基准');
    console.log('='.repeat(60));
    console.log(`base: ${args.baseRef} (${baseSha})`);
    console.log(`head: ${headSha}${headDirty ? '（含未提交改动）' : ''}`);
    console.log(`轮数: ${args.rounds}（每侧每轮一个独立进程，ABBA 交错）`);

    const runs: AbRoundRecord[] = [];
    for (let r = 0; r < args.rounds; r++) {
      const order: Array<'base' | 'head'> =
        r % 2 === 0 ? ['base', 'head'] : ['head', 'base'];
      for (const side of order) {
        const rec = runOnce(
          side,
          r,
          side === 'base' ? baseScript : headScript,
          tsxCli,
          scratchRoot
        );
        runs.push(rec);
        const ok = Object.values(rec.medians).filter((v) => v !== null).length;
        console.log(
          `  round ${r + 1}/${args.rounds} ${side}: ${ok} 项有效${rec.errors.length ? `，${rec.errors.length} 个错误` : ''}`
        );
        for (const e of rec.errors) console.log(`    ! ${e}`);
      }
    }

    const names = new Set<string>();
    for (const rec of runs)
      for (const n of Object.keys(rec.medians)) names.add(n);
    // 每侧每轮一个值；该轮进程失败或该项报错记为 null（判定时视为无效观测）。
    // base 所有轮次都没有该项 → 视为新增基准，base 记为空数组。
    const collect = (side: 'base' | 'head', name: string) =>
      runs
        .filter((rec) => rec.side === side)
        .map((rec) => rec.medians[name] ?? null);
    const benchmarks = [...names].map((name) => {
      const baseHasName = runs.some(
        (rec) => rec.side === 'base' && name in rec.medians
      );
      return {
        name,
        base: baseHasName ? collect('base', name) : [],
        head: collect('head', name),
      };
    });

    // 进程级失败（没有任何结果）也要体现为该侧缺观测
    const failedProcesses = runs.filter(
      (rec) => Object.keys(rec.medians).length === 0
    );

    const cpuList = cpus();
    const result: AbResultFile = {
      timestamp: new Date().toISOString(),
      method: 'same-machine-interleaved-ab',
      baseRef: args.baseRef,
      baseSha,
      headSha,
      headDirty,
      rounds: args.rounds,
      environment: {
        os: `${process.platform} ${process.arch}`,
        cpu: cpuList[0]?.model?.trim() || 'unknown',
        cpuCount: cpuList.length,
        memory: `${Math.round(totalmem() / (1024 * 1024))}MB`,
        nodeVersion: process.version,
      },
      runs,
      benchmarks,
    };

    const outPath = resolve(repoRoot, args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
    console.log(`\nA/B 原始数据已保存到 ${args.out}`);
    if (failedProcesses.length > 0) {
      console.error(
        `${failedProcesses.length} 个基准进程未产出结果（见上方错误）`
      );
      process.exitCode = 1;
    }
  } finally {
    git(['worktree', 'remove', '--force', baseDir]);
  }
}

main();
