import { runStressTest, type StressScenario } from "./stress-runner";

async function* aiStreamScenario(): AsyncGenerator<() => Promise<unknown>> {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \n.,!?;:-()[]{}";
  let chunkIndex = 0;

  while (true) {
    yield async () => {
      const chunkSize = Math.floor(Math.random() * 50) + 10;
      let chunk = "";
      for (let i = 0; i < chunkSize; i++) {
        chunk += chars[Math.floor(Math.random() * chars.length)];
      }
      const buffer = new TextEncoder().encode(chunk);
      const decoded = new TextDecoder().decode(buffer);
      chunkIndex++;
      return decoded;
    };

    if (chunkIndex % 10 === 0) {
      yield async () => {
        return simulateRender();
      };
    }
  }
}

function simulateRender(): number {
  const paragraphCount = Math.floor(Math.random() * 5) + 1;
  let totalLength = 0;
  for (let i = 0; i < paragraphCount; i++) {
    const paragraphLength = Math.floor(Math.random() * 200) + 50;
    totalLength += paragraphLength;
  }
  return totalLength;
}

export const AI_STREAM_STRESS: StressScenario = {
  name: "ai.streaming.with.rapid.scroll",
  duration: 30_000,
  concurrency: 3,
  scenario: aiStreamScenario,
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
