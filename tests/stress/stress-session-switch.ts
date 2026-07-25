import { runStressTest, SeededRandom, type StressScenario } from "./stress-runner";

function sessionSwitchScenario(rng: SeededRandom): AsyncGenerator<() => Promise<unknown>> {
  const sessionCount = 50;
  const messagesPerSession = 100;

  const sessions: Array<Array<Record<string, unknown>>> = [];
  for (let s = 0; s < sessionCount; s++) {
    const messages: Array<Record<string, unknown>> = [];
    for (let m = 0; m < messagesPerSession; m++) {
      messages.push({
        id: `msg-${s}-${m}`,
        role: m % 2 === 0 ? "user" : "assistant",
        content: `Message ${m} content with some random data ${rng.nextString(8)}`,
        timestamp: Date.now() + m,
      });
    }
    sessions.push(messages);
  }

  let sessionIndex = 0;

  while (true) {
    const currentSession = sessionIndex % sessions.length;
    sessionIndex++;

    yield async () => {
      const session = sessions[currentSession];
      const serialized: string[] = [];
      for (const msg of session) {
        serialized.push(JSON.stringify(msg));
      }
      const combined = serialized.join("\n");
      const parsed = combined.split("\n").map((l) => JSON.parse(l));
      return parsed.length;
    };

    yield async () => {
      const session = sessions[currentSession];
      const last10 = session.slice(-10);
      const summary = {
        sessionId: currentSession,
        totalMessages: session.length,
        lastMessages: last10.length,
        roles: {
          user: session.filter((m) => m.role === "user").length,
          assistant: session.filter((m) => m.role === "assistant").length,
        },
      };
      return summary;
    };
  }
}

function createSessionSwitchScenario(): () => AsyncGenerator<() => Promise<unknown>> {
  const seed = SESSION_SWITCH_STRESS.seed ?? 42;
  const rng = new SeededRandom(seed);
  return () => sessionSwitchScenario(rng);
}

export const SESSION_SWITCH_STRESS: StressScenario = {
  name: "rapid.session.switching",
  duration: 15_000,
  concurrency: 4,
  seed: 42,
  scenario: createSessionSwitchScenario(),
  expectedErrorRate: 0.01,
  expected: {
    fps: { min: 30 },
    memory: { maxHeap: 250 * 1024 * 1024 },
    latency: { p95: 150, p99: 300 },
  },
};

const isMain = process.argv[1]?.endsWith("stress-session-switch.ts");
if (isMain) {
  runStressTest(SESSION_SWITCH_STRESS).then((result) => process.exit(result.passed ? 0 : 1));
}
