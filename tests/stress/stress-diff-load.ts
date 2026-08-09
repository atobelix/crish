<<<<<<< Updated upstream
import {
  runStressTest,
  SeededRandom,
  type StressScenario,
  type InvariantCheck,
} from './stress-runner';
=======
import { runStressTest, SeededRandom, type StressScenario, type InvariantCheck } from "./stress-runner";
>>>>>>> Stashed changes
// 真实生产模块（PS-02 T2.3 重写：原实现仅 Set 差集自嗨，零产品接触）
import {
  mergeSessionDiffFiles,
  assistantTurnLabel,
  isDiffSourceMode,
  type DiffSourceMode,
<<<<<<< Updated upstream
} from '../../apps/crish-desktop/src/api/diffPanelHelpers';
import type {
  DiffChange,
  FileDiff,
} from '../../apps/crish-desktop/src/store/types';
=======
} from "../../apps/crish-desktop/src/api/diffPanelHelpers";
import type { DiffChange, FileDiff } from "../../apps/crish-desktop/src/store/types";
>>>>>>> Stashed changes

// 边界说明（审计留痕）：applyFileDiff / reverseFileDiff 依赖 workspaceFsApi
// （readTextFile/writeTextFile → Tauri invoke），Node 下禁止直连（任务书边界）；
// 本场景驱动 diffPanelHelpers 纯计算面，diff 计数不变式覆盖
// "additions/deletions 计数与独立基线一致"（独立基线 = changes 逐项 type 计数）。

interface DiffRunState {
  rng: SeededRandom;
  totalOps: number;
  totalFiles: number;
  totalChanges: number;
  failures: number;
  failSamples: string[];
}

<<<<<<< Updated upstream
const CHANGE_TYPES: readonly DiffChange['type'][] = [
  'addition',
  'deletion',
  'normal',
];
=======
const CHANGE_TYPES: readonly DiffChange["type"][] = ["addition", "deletion", "normal"];
>>>>>>> Stashed changes

function makeChange(rng: SeededRandom, index: number): DiffChange {
  return {
    type: CHANGE_TYPES[rng.nextInt(CHANGE_TYPES.length)]!,
    lineNum: index + 1,
    content: `line ${index} ${rng.nextString(12)}`,
  };
}

<<<<<<< Updated upstream
function makeFileDiff(
  rng: SeededRandom,
  path: string,
  changeCount: number
): FileDiff {
=======
function makeFileDiff(rng: SeededRandom, path: string, changeCount: number): FileDiff {
>>>>>>> Stashed changes
  const changes: DiffChange[] = [];
  for (let i = 0; i < changeCount; i++) {
    changes.push(makeChange(rng, i));
  }
  return {
    filePath: path,
<<<<<<< Updated upstream
    additions: changes.filter((c) => c.type === 'addition').length,
    deletions: changes.filter((c) => c.type === 'deletion').length,
    changes,
    gitStatus: 'M',
=======
    additions: changes.filter((c) => c.type === "addition").length,
    deletions: changes.filter((c) => c.type === "deletion").length,
    changes,
    gitStatus: "M",
>>>>>>> Stashed changes
  };
}

interface TurnFixture {
  files: FileDiff[];
}

/**
<<<<<<< Updated upstream
 * 构造一轮 AI 改动回合：8 个文件，40-90 条变更；
 * 约 15% 路径与上一轮重复（触发 mergeSessionDiffFiles 的合并分支）。
 */
function makeTurn(
  rng: SeededRandom,
  turnIndex: number,
  prevPaths: Set<string>
): TurnFixture {
=======
 * 构造一轮 AI 改动回合：8 个文件，60-150 条变更；
 * 约 15% 路径与上一轮重复（触发 mergeSessionDiffFiles 的合并分支）。
 */
function makeTurn(rng: SeededRandom, turnIndex: number, prevPaths: Set<string>): TurnFixture {
>>>>>>> Stashed changes
  const files: FileDiff[] = [];
  const paths: string[] = [];
  for (let f = 0; f < 8; f++) {
    const shared = prevPaths.size > 0 && rng.nextInt(100) < 15;
    const path = shared
      ? rng.pick([...prevPaths])
      : `src/module-${rng.nextIntRange(0, 40)}/file-${rng.nextIntRange(0, 500)}.ts`;
    paths.push(path);
<<<<<<< Updated upstream
    files.push(makeFileDiff(rng, path, rng.nextIntRange(40, 90)));
=======
    files.push(makeFileDiff(rng, path, rng.nextIntRange(60, 150)));
>>>>>>> Stashed changes
  }
  void turnIndex;
  return { files };
}

/** 独立基线校验：合并输出的每条 FileDiff 与输入 turns 逐项对照 */
<<<<<<< Updated upstream
function verifyMerge(
  turns: ReadonlyArray<{ files: FileDiff[] }>,
  merged: FileDiff[]
): string[] {
=======
function verifyMerge(turns: ReadonlyArray<{ files: FileDiff[] }>, merged: FileDiff[]): string[] {
>>>>>>> Stashed changes
  const violations: string[] = [];

  // 输出路径唯一
  const seen = new Set<string>();
  for (const f of merged) {
    if (seen.has(f.filePath)) {
      violations.push(`合并输出路径重复: ${f.filePath}`);
    }
    seen.add(f.filePath);
  }

  // 输入侧按路径分组（独立基线）
  const byPath = new Map<string, FileDiff[]>();
  for (const t of turns) {
    for (const f of t.files) {
      const list = byPath.get(f.filePath) ?? [];
      list.push(f);
      byPath.set(f.filePath, list);
    }
  }

  for (const f of merged) {
    const originals = byPath.get(f.filePath) ?? [];
    if (originals.length === 0) {
      violations.push(`合并输出出现输入不存在的路径: ${f.filePath}`);
      continue;
    }
    // additions/deletions 计数与独立基线一致
    const expAdditions = originals.reduce((s, o) => s + o.additions, 0);
    const expDeletions = originals.reduce((s, o) => s + o.deletions, 0);
    if (f.additions !== expAdditions) {
<<<<<<< Updated upstream
      violations.push(
        `${f.filePath}: additions ${f.additions} != 基线 ${expAdditions}`
      );
    }
    if (f.deletions !== expDeletions) {
      violations.push(
        `${f.filePath}: deletions ${f.deletions} != 基线 ${expDeletions}`
      );
=======
      violations.push(`${f.filePath}: additions ${f.additions} != 基线 ${expAdditions}`);
    }
    if (f.deletions !== expDeletions) {
      violations.push(`${f.filePath}: deletions ${f.deletions} != 基线 ${expDeletions}`);
>>>>>>> Stashed changes
    }
    // 单轮文件应原样透传（字段等价）
    if (originals.length === 1) {
      const o = originals[0]!;
      if (f.changes.length !== o.changes.length) {
        violations.push(`${f.filePath}: 单轮文件 changes 长度被改动`);
      }
      for (let i = 0; i < Math.min(f.changes.length, o.changes.length); i++) {
        if (f.changes[i]!.type !== o.changes[i]!.type) {
          violations.push(`${f.filePath}: 单轮文件 changes[${i}] 类型被改动`);
          break;
        }
      }
    } else {
      // 多轮合并：changes 拼接 + 上限 400
      const sumLen = originals.reduce((s, o) => s + o.changes.length, 0);
      const expLen = Math.min(400, sumLen);
      if (f.changes.length !== expLen) {
<<<<<<< Updated upstream
        violations.push(
          `${f.filePath}: 合并 changes ${f.changes.length} != 期望 ${expLen}`
        );
=======
        violations.push(`${f.filePath}: 合并 changes ${f.changes.length} != 期望 ${expLen}`);
>>>>>>> Stashed changes
      }
    }
    // 逐项独立计数（不依赖 FileDiff.additions 字段本身）。
    // 注意契约：mergeSessionDiffFiles 的 changes 拼接后 .slice(0, 400)（显示截断），
    // 而 additions/deletions 字段为不截断的累计和（store/types.ts 注释
    // "与 changes 基本一致，以工具上报为准"）——故仅当未截断（<400）时二者必须一致；
    // 截断到 400 时字段 > 计数属预期设计，不断言。
<<<<<<< Updated upstream
    const addCount = f.changes.filter((c) => c.type === 'addition').length;
    const delCount = f.changes.filter((c) => c.type === 'deletion').length;
    if (
      f.changes.length < 400 &&
      (addCount !== f.additions || delCount !== f.deletions)
    ) {
      violations.push(
        `${f.filePath}: changes 逐项计数 ${addCount}/${delCount} != 字段 ${f.additions}/${f.deletions}（未截断时不得分叉）`
      );
=======
    const addCount = f.changes.filter((c) => c.type === "addition").length;
    const delCount = f.changes.filter((c) => c.type === "deletion").length;
    if (f.changes.length < 400 && (addCount !== f.additions || delCount !== f.deletions)) {
      violations.push(`${f.filePath}: changes 逐项计数 ${addCount}/${delCount} != 字段 ${f.additions}/${f.deletions}（未截断时不得分叉）`);
>>>>>>> Stashed changes
    }
  }
  return violations;
}

/** 回合标签与来源模式判定（diffPanelHelpers 其余导出） */
function verifyHelpers(rng: SeededRandom): string[] {
  const violations: string[] = [];
  for (let i = 0; i < 50; i++) {
    const fileCount = rng.nextIntRange(0, 20);
    const label = assistantTurnLabel(
      { timestamp: String(1_700_000_000_000 + rng.nextIntRange(0, 86400_000)) },
      i,
<<<<<<< Updated upstream
      fileCount
=======
      fileCount,
>>>>>>> Stashed changes
    );
    if (fileCount > 0 && !label.includes(`${fileCount} 个文件`)) {
      violations.push(`label 缺文件数: ${label}`);
    }
<<<<<<< Updated upstream
    if (fileCount === 0 && label.includes('个文件')) {
=======
    if (fileCount === 0 && label.includes("个文件")) {
>>>>>>> Stashed changes
      violations.push(`label 0 文件时误带文件数: ${label}`);
    }
    if (!/^回合 \d+ /.test(label)) {
      violations.push(`label 格式异常: ${label}`);
    }
  }
<<<<<<< Updated upstream
  for (const mode of ['session', 'git', 'list'] as const) {
    if (!isDiffSourceMode(mode))
      violations.push(`isDiffSourceMode 拒绝对值 ${mode}`);
  }
  for (const bad of ['Session', 'GIT', '', 'unknown', 42] as const) {
    if (isDiffSourceMode(bad as DiffSourceMode))
      violations.push(`isDiffSourceMode 误收 ${String(bad)}`);
=======
  for (const mode of ["session", "git", "list"] as const) {
    if (!isDiffSourceMode(mode)) violations.push(`isDiffSourceMode 拒绝对值 ${mode}`);
  }
  for (const bad of ["Session", "GIT", "", "unknown", 42] as const) {
    if (isDiffSourceMode(bad as DiffSourceMode)) violations.push(`isDiffSourceMode 误收 ${String(bad)}`);
>>>>>>> Stashed changes
  }
  return violations;
}

<<<<<<< Updated upstream
function* diffLoadScenario(
  state: DiffRunState
): Generator<() => Promise<unknown>> {
  const { rng } = state;
  while (true) {
    yield async () => {
      // 数百文件级大 diff fixture：30 回合 × 8 文件 × 40-90 changes（约 240 文件/op）
      const prevPaths = new Set<string>();
      const turns: TurnFixture[] = [];
      for (let t = 0; t < 30; t++) {
=======
function* diffLoadScenario(state: DiffRunState): Generator<() => Promise<unknown>> {
  const { rng } = state;
  while (true) {
    yield async () => {
      // 数百文件级大 diff fixture：40 回合 × 8 文件 × 60-150 changes
      const prevPaths = new Set<string>();
      const turns: TurnFixture[] = [];
      for (let t = 0; t < 40; t++) {
>>>>>>> Stashed changes
        const turn = makeTurn(rng, t, prevPaths);
        turns.push(turn);
        for (const f of turn.files) prevPaths.add(f.filePath);
      }

      const merged = mergeSessionDiffFiles(turns);
      const violations = [...verifyMerge(turns, merged), ...verifyHelpers(rng)];

      state.totalOps++;
      state.totalFiles += merged.length;
      for (const t of turns) {
        for (const f of t.files) state.totalChanges += f.changes.length;
      }
      for (const v of violations) {
        state.failures++;
        if (state.failSamples.length < 20) state.failSamples.push(v);
      }
    };
  }
}

function verifyDiffLoad(state: DiffRunState): InvariantCheck[] {
  const checks: InvariantCheck[] = [];
  if (state.totalOps === 0) {
<<<<<<< Updated upstream
    return [{ ok: false, message: '0 次合并被执行（空跑）' }];
=======
    return [{ ok: false, message: "0 次合并被执行（空跑）" }];
>>>>>>> Stashed changes
  }
  checks.push({
    ok: state.failures === 0,
    message: `全部合并不变式通过（${state.totalOps} ops / ${state.totalFiles} 文件 / ${state.totalChanges} 条 change, 失败 ${state.failures}）`,
  });
  for (const sample of state.failSamples) {
    checks.push({ ok: false, message: `失败样例: ${sample}` });
  }
  return checks;
}

function createDiffRunState(): DiffRunState {
  return {
    rng: new SeededRandom(7),
    totalOps: 0,
    totalFiles: 0,
    totalChanges: 0,
    failures: 0,
    failSamples: [],
  };
}

const diffRunState = createDiffRunState();

export const DIFF_LOAD_STRESS: StressScenario = {
<<<<<<< Updated upstream
  name: 'large.diff.merge.and.count',
  duration: 20_000,
  concurrency: 1,
  seed: 7,
  modules: [
    'api/diffPanelHelpers.mergeSessionDiffFiles',
    'api/diffPanelHelpers.assistantTurnLabel',
  ],
=======
  name: "large.diff.merge.and.count",
  duration: 20_000,
  concurrency: 1,
  seed: 7,
  modules: ["api/diffPanelHelpers.mergeSessionDiffFiles", "api/diffPanelHelpers.assistantTurnLabel"],
>>>>>>> Stashed changes
  scenario: () => diffLoadScenario(diffRunState),
  verify: () => verifyDiffLoad(diffRunState),
  expectedErrorRate: 0.01,
  expected: {
<<<<<<< Updated upstream
    // 阈值按实测基线设定并留 ≥30% 余量（F10-13 flaky 教训）：
    //   avg ops/sec 实测 97-132 → 10（余量 ≫30%，共享机器宽余量）
    //   内存最差观测 402MB（GC 滞后瞬时峰值）→ 500MB（余量 ≈24% 于最差观测，
    //   2 倍 fixture 缩减后典型 57-165MB；泄漏级增长仍必红）
    //   延迟实测 p95≈18ms p99≈25ms → 200/500ms（余量 ≫30%）
    ops: { min: 10 },
    memory: { maxHeap: 500 * 1024 * 1024 },
=======
    // 阈值按实测基线设定并留 ≥30% 余量，见 T2.3 报告
    ops: { min: 10 },
    memory: { maxHeap: 300 * 1024 * 1024 },
>>>>>>> Stashed changes
    latency: { p95: 200, p99: 500 },
  },
};

const isMain = process.argv[1]?.endsWith('stress-diff-load.ts');
if (isMain) {
  runStressTest(DIFF_LOAD_STRESS).then((result) =>
    process.exit(result.passed ? 0 : 1)
  );
}
