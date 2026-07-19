import { runStressTest, type StressScenario } from "./stress-runner";

async function* diffLoadScenario(): AsyncGenerator<() => Promise<unknown>> {
  const fileCount = 100;
  const linesPerFile = 5000;

  const files: string[][] = [];
  for (let f = 0; f < fileCount; f++) {
    const lines: string[] = [];
    for (let l = 0; l < linesPerFile; l++) {
      const type = l % 3 === 0 ? "+" : l % 3 === 1 ? "-" : " ";
      const content = `line-${l}-${Math.random().toString(36).slice(2, 8)}`;
      lines.push(`${type}${content}`);
    }
    files.push(lines);
  }

  let fileIndex = 0;

  while (true) {
    const currentFile = fileIndex % files.length;
    fileIndex++;

    yield async () => {
      const file = files[currentFile];
      const stats = {
        additions: 0,
        deletions: 0,
        context: 0,
        totalLines: file.length,
      };
      for (const line of file) {
        if (line.startsWith("+")) stats.additions++;
        else if (line.startsWith("-")) stats.deletions++;
        else stats.context++;
      }
      return stats;
    };

    yield async () => {
      const prevIndex = (currentFile - 1 + files.length) % files.length;
      const prevFile = files[prevIndex];
      const prevSet = new Set(prevFile);
      const additions = file.filter((l) => !prevSet.has(l)).length;
      const deletions = prevFile.filter((l) => !new Set(file).has(l)).length;
      return { additions, deletions };
    };
  }
}

export const DIFF_LOAD_STRESS: StressScenario = {
  name: "large.diff.loading",
  duration: 20_000,
  concurrency: 1,
  scenario: diffLoadScenario,
  expectedErrorRate: 0.02,
  expected: {
    fps: { min: 20 },
    memory: { maxHeap: 300 * 1024 * 1024 },
    latency: { p95: 200, p99: 500 },
  },
};

const isMain = process.argv[1]?.endsWith("stress-diff-load.ts");
if (isMain) {
  runStressTest(DIFF_LOAD_STRESS).then((result) => process.exit(result.passed ? 0 : 1));
}
