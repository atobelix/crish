import { runStressTest, SeededRandom, type StressScenario } from "./stress-runner";

async function* aiStreamScenario(rng: SeededRandom): AsyncGenerator<() => Promise<unknown>> {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \n.,!?;:-()[]{}";
  let chunkIndex = 0;

  while (true) {
    yield async () => {
      const chunkSize = rng.nextIntRange(10, 60);
      let chunk = "";
      for (let i = 0; i < chunkSize; i++) {
        chunk += chars[rng.nextInt(chars.length)];
      }
      const buffer = new TextEncoder().encode(chunk);
      const decoded = new TextDecoder().decode(buffer);
      chunkIndex++;
      return decoded;
    };

    if (chunkIndex % 10 === 0) {
      yield async () => {
        const paragraphCount = rng.nextIntRange(1, 6);
        let totalLength = 0;
        for (let i = 0; i < paragraphCount; i++) {
          totalLength += rng.nextIntRange(50, 250);
        }
        return totalLength;
      };
    }
  }
}

function createAiStreamScenario(): () => AsyncGenerator<() => Promise<unknown>> {
  const seed = AI_STREAM_STRESS.seed ?? 42;
  const rng = new SeededRandom(seed);
  return () => aiStreamScenario(rng);
}

export const AI_STREAM_STRESS: StressScenario = {
  name: "ai.streaming.with.rapid.scroll",
  duration: 30_000,
  concurrency: 3,
  seed: 42,
  scenario: createAiStreamScenario(),
  expectedErrorRate: 0.01,
  expected: {
    fps: { min: 30 },
    memory: { maxHeap: 200 * 1024 * 1024 },
    latency: { p95: 100, p99: 200 },
  },
};

async function main() {
  const result = await runStressTest(AI_STREAM_STRESS);
  process.exit(result.passed ? 0 : 1);
}

const isMain = process.argv[1]?.endsWith("stress-ai-stream.ts");
if (isMain) main();
