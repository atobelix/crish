import http from "node:http";

type MockPhase = {
  chunks: Array<{ event?: string; data: string }>;
  statusCode?: number;
  headers?: Record<string, string>;
  raw?: boolean;
};

type MockScenario = {
  chunks?: Array<{ event?: string; data: string }>;
  delay?: number;
  injectErrorAt?: number;
  abortAfter?: number;
  statusCode?: number;
  headers?: Record<string, string>;
  raw?: boolean;
  /** Sequential phases keyed by request count (0-based). Falls back to last phase when count exceeds length. */
  phases?: MockPhase[];
};

function sendErrorResponse(res: http.ServerResponse, statusCode: number, headers: Record<string, string>, chunks: Array<{ event?: string; data: string }>): void {
  const body = chunks[0]?.data ?? JSON.stringify({ error: { message: "Mock error", type: "mock_error" } });
  res.writeHead(statusCode, headers);
  res.end(body);
}

function sendStreamingResponse(res: http.ServerResponse, scenario: { chunks: Array<{ event?: string; data: string }>; delay?: number; raw?: boolean; abortAfter?: number }): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  let i = 0;
  const timer = setInterval(() => {
    if (i >= scenario.chunks.length) {
      clearInterval(timer);
      res.end();
      return;
    }
    if (scenario.abortAfter !== undefined && i === scenario.abortAfter) {
      clearInterval(timer);
      res.destroy();
      return;
    }
    const chunk = scenario.chunks[i]!;
    if (scenario.raw) {
      res.write(chunk.data + "\n");
    } else {
      if (chunk.event) res.write(`event: ${chunk.event}\n`);
      res.write(`data: ${chunk.data}\n\n`);
    }
    i++;
  }, scenario.delay ?? 1);
}

export class LlmApiMockServer {
  private server: http.Server;
  private scenarios = new Map<string, MockScenario>();
  private requestCountPerPath = new Map<string, number>();
  private requestLog: Array<{ method: string; url: string; body?: string; timestamp: number }> = [];
  private port!: number;

  constructor() {
    this.server = http.createServer((req, res) => {
      const path = req.url ?? "/";
      this.requestLog.push({ method: req.method ?? "GET", url: path, timestamp: Date.now() });
      this.requestCountPerPath.set(path, (this.requestCountPerPath.get(path) ?? 0) + 1);

      const scenario = this.matchScenario(path);
      if (!scenario) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      // Resolve the effective chunks/headers/statusCode from phases or legacy fields
      let effective: { chunks: Array<{ event?: string; data: string }>; headers: Record<string, string>; statusCode: number; raw: boolean };

      if (scenario.phases) {
        const count = this.getRequestCount(path);
        const phaseIndex = Math.min(count - 1, scenario.phases.length - 1);
        const phase = scenario.phases[phaseIndex >= 0 ? phaseIndex : 0]!;
        const phaseHeaders = {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          ...phase.headers,
        };
        effective = {
          chunks: phase.chunks,
          headers: phaseHeaders,
          statusCode: phase.statusCode ?? 200,
          raw: phase.raw ?? false,
        };
      } else {
        effective = {
          chunks: scenario.chunks ?? [],
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
            ...scenario.headers,
          },
          statusCode: scenario.statusCode ?? 200,
          raw: scenario.raw ?? false,
        };
      }

      if (effective.statusCode !== 200) {
        sendErrorResponse(res, effective.statusCode, effective.headers, effective.chunks);
        return;
      }

      sendStreamingResponse(res, {
        chunks: effective.chunks,
        ...(scenario.delay !== undefined ? { delay: scenario.delay } : {}),
        raw: effective.raw,
        ...(scenario.abortAfter !== undefined ? { abortAfter: scenario.abortAfter } : {}),
      });
    });
  }

  async start(port = 0): Promise<number> {
    return new Promise(resolve => {
      this.server.listen(port, () => {
        this.port = (this.server.address() as { port: number }).port;
        resolve(this.port);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise(resolve => this.server.close(() => resolve()));
  }

  on(path: string, scenario: MockScenario): void {
    this.scenarios.set(path, scenario);
  }

  getPort(): number { return this.port; }
  getBaseUrl(): string { return `http://localhost:${this.port}`; }
  getRequestLog() { return this.requestLog; }
  clearLog() { this.requestLog = []; }
  getRequestCount(path: string): number { return this.requestCountPerPath.get(path) ?? 0; }
  clearRequestCounts(): void { this.requestCountPerPath.clear(); }

  private matchScenario(url: string): MockScenario | undefined {
    if (this.scenarios.has(url)) return this.scenarios.get(url);
    for (const [path, scenario] of this.scenarios) {
      if (url.endsWith(path)) return scenario;
    }
    return undefined;
  }
}

export const Scenarios = {
  openaiChatText: (): MockScenario => ({
    chunks: [
      { data: '{"choices":[{"delta":{"role":"assistant","content":""},"index":0}]}' },
      { data: '{"choices":[{"delta":{"content":"Hello"},"index":0}]}' },
      { data: '{"choices":[{"delta":{"content":" world"},"index":0}]}' },
      { data: '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}' },
      { data: "[DONE]" },
    ],
  }),

  anthropicThinking: (): MockScenario => ({
    chunks: [
      { event: "message_start", data: '{"type":"message_start","message":{"usage":{"input_tokens":10}}}' },
      { event: "content_block_start", data: '{"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}' },
      { event: "content_block_delta", data: '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think about this..."}}' },
      { event: "content_block_stop", data: '{"type":"content_block_stop","index":0}' },
      { event: "content_block_start", data: '{"type":"content_block_start","index":1,"content_block":{"type":"text","text":"Here is my answer"}}' },
      { event: "message_stop", data: "{}" },
    ],
  }),

  anthropicMessages: (): MockScenario => ({
    chunks: [
      { event: "message_start", data: '{"type":"message_start","message":{"usage":{"input_tokens":12}}}' },
      { event: "content_block_start", data: '{"type":"content_block_start","index":0,"content_block":{"type":"text"}}' },
      { event: "content_block_delta", data: '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from Anthropic"}}' },
      { event: "content_block_stop", data: '{"type":"content_block_stop","index":0}' },
      { event: "message_delta", data: '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}' },
      { event: "message_stop", data: "{}" },
    ],
  }),

  ollamaChat: (): MockScenario => ({
    raw: true,
    chunks: [
      { data: '{"model":"llama3","created_at":"2023-01-01T00:00:00Z","message":{"role":"assistant","content":"Hello "},"done":false}' },
      { data: '{"model":"llama3","created_at":"2023-01-01T00:00:01Z","message":{"role":"assistant","content":"from Ollama"},"done":false}' },
      { data: '{"model":"llama3","created_at":"2023-01-01T00:00:02Z","message":{"role":"assistant","content":""},"done":true,"total_duration":1000000000,"prompt_eval_count":10,"eval_count":5,"eval_duration":500000000}' },
    ],
  }),

  error401: (): MockScenario => ({
    statusCode: 401,
    headers: { "content-type": "application/json" },
    chunks: [{ data: '{"error":{"message":"Invalid API key","type":"auth_error"}}' }],
  }),

  error429: (): MockScenario => ({
    statusCode: 429,
    headers: { "content-type": "application/json", "retry-after": "5" },
    chunks: [{ data: '{"error":{"message":"Rate limit exceeded","type":"rate_limit_error"}}' }],
  }),

  /**
   * Multi-phase scenario: first request returns 400 context_length_exceeded,
   * subsequent requests return a normal streaming success response.
   */
  repeated401: (failCount: number = 5): MockScenario => ({
    phases: [
      ...Array.from({ length: failCount }, () => ({
        statusCode: 401,
        headers: { "content-type": "application/json" },
        chunks: [{ data: '{"error":{"message":"Invalid API key","type":"auth_error"}}' }],
      })),
      {
        chunks: [
          { data: '{"choices":[{"delta":{"content":"Success"},"index":0}]}' },
          { data: '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}' },
          { data: "[DONE]" },
        ],
      },
    ],
  }),

  contextLengthFollowedBySuccess: (): MockScenario => ({
    phases: [
      // Phase 0 (first request): 400 context_length_exceeded
      {
        statusCode: 400,
        headers: { "content-type": "application/json" },
        chunks: [{ data: '{"error":{"message":"context_length_exceeded","type":"invalid_request_error"}}' }],
      },
      // Phase 1+ (retries): normal streaming success
      {
        chunks: [
          { data: '{"choices":[{"delta":{"role":"assistant","content":""},"index":0}]}' },
          { data: '{"choices":[{"delta":{"content":"Retry"},"index":0}]}' },
          { data: '{"choices":[{"delta":{"content":" succeeded"},"index":0}]}' },
          { data: '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}' },
          { data: "[DONE]" },
        ],
      },
    ],
  }),

  /**
   * 用于 Steering 注入 E2E 测试的多 step 场景。
   * 模拟 Agent 执行需要多步工具调用的复杂任务，
   * 每个 chunk 之间以 delayMs 延迟发送，创造注入时间窗口。
   */
  steeringInjectionScenario: (delayMs: number): MockScenario => ({
    delay: delayMs,
    chunks: [
      { data: '{"choices":[{"delta":{"content":"I will help you"},"index":0}]}' },
      { data: '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search","arguments":"{\\"q\\":\\"hello\\"}"}}]},"index":0}]}' },
      { data: '{"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}' },
      { data: "[DONE]" },
    ],
  }),
};

export type { MockScenario, MockPhase };
