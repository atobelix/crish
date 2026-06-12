import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOpenAICompatibleProviderFromConfig,
  createTextMessage,
  defineTextTool,
  listOpenAICompatibleModels,
  loadOpenAICompatibleProviderConfig,
  OpenAICompatibleProvider
} from ".";

let tempRoot = "";

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "agent-runtime-provider-"));
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for test condition");
}

describe("OpenAICompatibleProvider", () => {
  it("parses non-streaming text and tool calls", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "I will inspect.",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "shell_command", arguments: JSON.stringify({ command: "pwd" }) }
                  }
                ]
              },
              finish_reason: "tool_calls"
            }
          ]
        }),
        { headers: { "content-type": "application/json" } }
      );

    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me",
      apiKey: "test-key",
      model: "mimo-test",
      endpoint: "chat-completions",
      stream: false,
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("user", "inspect")],
        tools: [
          defineTextTool({
            name: "shell_command",
            description: "Run command",
            execute: () => "ok"
          })
        ],
        signal: new AbortController().signal
      })
    );

    expect(events).toEqual([
      { type: "text-delta", text: "I will inspect." },
      { type: "tool-call", id: "call_1", toolName: "shell_command", input: { command: "pwd" } },
      { type: "stop", reason: "tool-call" }
    ]);
  });

  it("normalizes cached prompt tokens from OpenAI-compatible usage details", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: "ok" },
              finish_reason: "stop"
            }
          ],
          usage: {
            prompt_tokens: 128,
            completion_tokens: 16,
            total_tokens: 144,
            prompt_tokens_details: {
              cached_tokens: 96
            }
          }
        }),
        { headers: { "content-type": "application/json" } }
      );

    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me",
      apiKey: "test-key",
      model: "mimo-test",
      endpoint: "chat-completions",
      stream: false,
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("user", "hello")],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect(events.at(-1)).toEqual({
      type: "stop",
      reason: "stop",
      usage: {
        promptTokens: 128,
        completionTokens: 16,
        totalTokens: 144,
        cacheReadTokens: 96
      }
    });
  });

  it("parses streaming content and fragmented tool arguments", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Run "}}]}\n\n'));
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"shell_command","arguments":"{\\"command\\":"}}]}}]}\n\n'
          )
        );
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"pwd\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'
          )
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    const fetchMock: typeof fetch = async () => new Response(body, { headers: { "content-type": "text/event-stream" } });
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me/v1",
      apiKey: "test-key",
      model: "mimo-test",
      endpoint: "chat-completions",
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("user", "inspect")],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect(events).toEqual([
      { type: "text-delta", text: "Run " },
      { type: "tool-call", id: "call_1", toolName: "shell_command", input: { command: "pwd" } },
      { type: "stop", reason: "tool-call" }
    ]);
  });

  it("cancels the SSE body when the provider stream consumer stops early", async () => {
    const encoder = new TextEncoder();
    let cancelReason: unknown;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
      },
      cancel(reason) {
        cancelReason = reason;
      }
    });
    const fetchMock: typeof fetch = async () => new Response(body, { headers: { "content-type": "text/event-stream" } });
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me/v1",
      apiKey: "test-key",
      model: "mimo-test",
      endpoint: "chat-completions",
      fetch: fetchMock
    });

    const iterator = provider
      .stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("user", "hello")],
        tools: [],
        signal: new AbortController().signal
      })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "text-delta", text: "hello" }
    });
    await iterator.return?.(undefined);

    expect(cancelReason).toBeInstanceOf(Error);
    expect((cancelReason as Error).message).toBe("stream consumer cancelled");
  });

  it("aborts pending SSE reads without retrying the request", async () => {
    const abortController = new AbortController();
    let fetchCalls = 0;
    let cancelReason: unknown;
    const body = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelReason = reason;
      }
    });
    const fetchMock: typeof fetch = async () => {
      fetchCalls += 1;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me/v1",
      apiKey: "test-key",
      model: "mimo-test",
      endpoint: "chat-completions",
      diagnostics: true,
      retry: { maxAttempts: 2, initialDelayMs: 1 },
      fetch: fetchMock
    });
    const events: unknown[] = [];
    const task = (async () => {
      for await (const event of provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("user", "wait")],
        tools: [],
        signal: abortController.signal
      })) {
        events.push(event);
      }
    })();

    await waitFor(() =>
      events.some(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          (event as { type?: unknown }).type === "provider-diagnostic" &&
          ((event as { diagnostic?: { phase?: unknown } }).diagnostic?.phase === "response-start")
      )
    );
    abortController.abort(new Error("user cancelled stream"));

    await expect(task).rejects.toThrow("user cancelled stream");
    expect(fetchCalls).toBe(1);
    expect(cancelReason).toBeInstanceOf(Error);
    expect((cancelReason as Error).message).toBe("user cancelled stream");
  });

  it("can emit provider diagnostics for streaming requests without mixing them into assistant content", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    const fetchMock: typeof fetch = async () =>
      new Response(body, {
        headers: {
          "content-type": "text/event-stream",
          "cf-ray": "abc123"
        }
      });
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me/v1",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "chat-completions",
      diagnostics: true,
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("user", "问候")],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect(events.map((event) => event.type)).toEqual([
      "provider-diagnostic",
      "provider-diagnostic",
      "provider-diagnostic",
      "text-delta",
      "provider-diagnostic",
      "stop"
    ]);
    expect(events[0]).toMatchObject({
      type: "provider-diagnostic",
      diagnostic: {
        phase: "request-start",
        endpoint: "chat-completions"
      }
    });
    expect(events[1]).toMatchObject({
      type: "provider-diagnostic",
      diagnostic: {
        phase: "response-start",
        status: 200,
        headers: {
          "cf-ray": "abc123"
        }
      }
    });
    expect(events[2]).toMatchObject({
      type: "provider-diagnostic",
      diagnostic: {
        phase: "sse-first-byte",
        chunks: 1
      }
    });
    expect(events[4]).toMatchObject({
      type: "provider-diagnostic",
      diagnostic: {
        phase: "stream-end"
      }
    });
  });

  it("posts to the Responses API endpoint and parses streaming text plus function calls", async () => {
    const encoder = new TextEncoder();
    let requestUrl = "";
    let requestBody: Record<string, unknown> = {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"Run "}\n\n'));
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"shell_command","arguments":""}}\n\n'
          )
        );
        controller.enqueue(encoder.encode('data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"command\\":"}\n\n'));
        controller.enqueue(
          encoder.encode('data: {"type":"response.function_call_arguments.done","item_id":"fc_1","arguments":"{\\"command\\":\\"pwd\\"}"}\n\n')
        );
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":12,"output_tokens":5,"total_tokens":17}}}\n\n'
          )
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    const fetchMock: typeof fetch = async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me/",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "responses",
      maxTokens: 512,
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        systemPrompt: "You are concise.",
        messages: [createTextMessage("user", "inspect")],
        tools: [
          defineTextTool({
            name: "shell_command",
            description: "Run command",
            execute: () => "ok"
          })
        ],
        signal: new AbortController().signal
      })
    );

    expect(requestUrl).toBe("https://api.flowbit.me/v1/responses");
    expect(requestBody).toMatchObject({
      model: "mimo-v2.5",
      stream: true,
      max_output_tokens: 512,
      tool_choice: "auto"
    });
    expect(requestBody.input).toEqual([
      { type: "message", role: "system", content: "You are concise." },
      { type: "message", role: "user", content: "inspect" }
    ]);
    expect(requestBody.tools).toEqual([
      expect.objectContaining({
        type: "function",
        name: "shell_command",
        strict: false
      })
    ]);
    expect(events).toEqual([
      { type: "text-delta", text: "Run " },
      { type: "tool-call", id: "call_1", toolName: "shell_command", input: { command: "pwd" } },
      { type: "stop", reason: "tool-call", usage: { promptTokens: 12, completionTokens: 5, totalTokens: 17 } }
    ]);
  });

  it("auto endpoint prefers Responses and falls back to chat-completions when Responses is unavailable", async () => {
    const urls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      urls.push(String(input));
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (urls.length === 1) {
        return new Response(JSON.stringify({ error: { message: "Responses endpoint not found" } }), {
          status: 404,
          statusText: "Not Found",
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
        headers: { "content-type": "application/json" }
      });
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me/",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "auto",
      stream: false,
      diagnostics: true,
      retry: { maxAttempts: 1 },
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("user", "hello")],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect(urls).toEqual(["https://api.flowbit.me/v1/responses", "https://api.flowbit.me/v1/chat/completions"]);
    expect(bodies[0]).toMatchObject({ input: [{ type: "message", role: "user", content: "hello" }] });
    expect(bodies[1]).toMatchObject({ messages: [{ role: "user", content: "hello" }] });
    expect(events).toEqual([
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "request-start", endpoint: "responses" }) }),
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "response-start", endpoint: "responses", status: 404 }) }),
      expect.objectContaining({
        type: "provider-diagnostic",
        diagnostic: expect.objectContaining({ phase: "endpoint-fallback", endpoint: "responses", status: 404, errorKind: "endpoint-unavailable" })
      }),
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "request-start", endpoint: "chat-completions" }) }),
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "response-start", endpoint: "chat-completions", status: 200 }) }),
      { type: "text-delta", text: "ok" },
      { type: "stop", reason: "stop" }
    ]);
  });

  it("keeps Responses streaming path and retries with a user-prefix when a provider rejects system messages", async () => {
    const urls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      urls.push(String(input));
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (urls.length === 1) {
        return new Response(JSON.stringify({ error: { message: "System messages are not allowed" } }), {
          status: 400,
          statusText: "Bad Request",
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(
        JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }),
        { headers: { "content-type": "application/json" } }
      );
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me/",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "auto",
      stream: false,
      diagnostics: true,
      retry: { maxAttempts: 1 },
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        systemPrompt: "Keep the stable project rules.",
        messages: [createTextMessage("user", "hello")],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect(urls).toEqual(["https://api.flowbit.me/v1/responses", "https://api.flowbit.me/v1/responses"]);
    expect(bodies[0].input).toEqual([
      { type: "message", role: "system", content: "Keep the stable project rules." },
      { type: "message", role: "user", content: "hello" }
    ]);
    expect(bodies[1].input).toEqual([
      {
        type: "message",
        role: "user",
        content: "System instructions for this run:\n\nKeep the stable project rules."
      },
      { type: "message", role: "user", content: "hello" }
    ]);
    expect(events).toEqual([
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "request-start", endpoint: "responses" }) }),
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "response-start", endpoint: "responses", status: 400 }) }),
      expect.objectContaining({
        type: "provider-diagnostic",
        diagnostic: expect.objectContaining({ phase: "request-error", endpoint: "responses", status: 400, retryable: true, errorKind: "schema" })
      }),
      expect.objectContaining({
        type: "provider-diagnostic",
        diagnostic: expect.objectContaining({ phase: "request-start", endpoint: "responses", reason: "system-prompt-user-prefix" })
      }),
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "response-start", endpoint: "responses", status: 200 }) }),
      { type: "text-delta", text: "ok" },
      { type: "stop", reason: "stop" }
    ]);
  });

  it("retries provider-wrapper 4xx system-role rejections with a user-prefix", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return new Response(JSON.stringify({ error: { message: "System messages are not allowed" } }), {
          status: 403,
          statusText: "Forbidden",
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(
        JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }),
        { headers: { "content-type": "application/json" } }
      );
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me/",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "responses",
      stream: false,
      diagnostics: true,
      retry: { maxAttempts: 1 },
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        systemPrompt: "Keep stable rules.",
        messages: [createTextMessage("user", "hello")],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect(bodies[0].input).toEqual([
      { type: "message", role: "system", content: "Keep stable rules." },
      { type: "message", role: "user", content: "hello" }
    ]);
    expect(bodies[1].input).toEqual([
      { type: "message", role: "user", content: "System instructions for this run:\n\nKeep stable rules." },
      { type: "message", role: "user", content: "hello" }
    ]);
    expect(events).toEqual([
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "request-start", endpoint: "responses" }) }),
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "response-start", endpoint: "responses", status: 403 }) }),
      expect.objectContaining({
        type: "provider-diagnostic",
        diagnostic: expect.objectContaining({ phase: "request-error", endpoint: "responses", status: 403, retryable: true })
      }),
      expect.objectContaining({
        type: "provider-diagnostic",
        diagnostic: expect.objectContaining({ phase: "request-start", endpoint: "responses", reason: "system-prompt-user-prefix" })
      }),
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "response-start", endpoint: "responses", status: 200 }) }),
      { type: "text-delta", text: "ok" },
      { type: "stop", reason: "stop" }
    ]);
  });

  it("also rewrites prior system-role history when a provider rejects system messages", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return new Response(JSON.stringify({ error: { message: "System messages are not allowed" } }), {
          status: 400,
          statusText: "Bad Request",
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "continued" }, finish_reason: "stop" }] }), {
        headers: { "content-type": "application/json" }
      });
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me/",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "chat-completions",
      stream: false,
      diagnostics: true,
      retry: { maxAttempts: 1 },
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("system", "Task finished."), createTextMessage("user", "continue")],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect(bodies[0].messages).toEqual([
      { role: "system", content: "Task finished." },
      { role: "user", content: "continue" }
    ]);
    expect(bodies[1].messages).toEqual([
      { role: "user", content: "System instructions for this run:\n\nTask finished." },
      { role: "user", content: "continue" }
    ]);
    expect(events.at(-2)).toEqual({ type: "text-delta", text: "continued" });
    expect(events.at(-1)).toEqual({ type: "stop", reason: "stop" });
  });

  it("retries streaming Responses error frames with a user-prefix when a provider rejects system messages", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return new Response('data: {"type":"error","message":"System messages are not allowed"}\n\n', {
          headers: { "content-type": "text/event-stream" }
        });
      }
      return new Response(
        [
          'data: {"type":"response.output_text.delta","delta":"ok"}',
          'data: {"type":"response.completed","response":{"status":"completed"}}',
          ""
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } }
      );
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me/",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "responses",
      diagnostics: true,
      retry: { maxAttempts: 1 },
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        systemPrompt: "Keep the stable project rules.",
        messages: [createTextMessage("user", "hello")],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect(bodies[0].input).toEqual([
      { type: "message", role: "system", content: "Keep the stable project rules." },
      { type: "message", role: "user", content: "hello" }
    ]);
    expect(bodies[1].input).toEqual([
      {
        type: "message",
        role: "user",
        content: "System instructions for this run:\n\nKeep the stable project rules."
      },
      { type: "message", role: "user", content: "hello" }
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "provider-diagnostic",
          diagnostic: expect.objectContaining({
            phase: "request-start",
            endpoint: "responses",
            streamRequested: true,
            systemPromptWireMode: "native-system-role",
            hasSystemRole: true,
            systemMessageCount: 1,
            rewrittenSystemMessageCount: 0,
            messageRoleCounts: { system: 0, user: 1, assistant: 0, tool: 0 }
          })
        }),
        expect.objectContaining({
          type: "provider-diagnostic",
          diagnostic: expect.objectContaining({
            phase: "request-error",
            endpoint: "responses",
            retryable: true,
            errorKind: "schema",
            systemPromptWireMode: "native-system-role"
          })
        }),
        expect.objectContaining({
          type: "provider-diagnostic",
          diagnostic: expect.objectContaining({
            phase: "request-start",
            endpoint: "responses",
            reason: "system-prompt-user-prefix",
            systemPromptWireMode: "user-prefix",
            rewrittenSystemMessageCount: 1
          })
        }),
        { type: "text-delta", text: "ok" },
        { type: "stop", reason: "stop" }
      ])
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "stop", reason: "error" })
    );
  });

  it("retries 200 JSON error bodies with a user-prefix when a provider rejects system messages", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return new Response(JSON.stringify({ error: { message: "System messages are not allowed" } }), {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(
        JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }),
        { headers: { "content-type": "application/json" } }
      );
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me/",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "responses",
      stream: false,
      diagnostics: true,
      retry: { maxAttempts: 1 },
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        systemPrompt: "Keep stable rules.",
        messages: [createTextMessage("user", "hello")],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect(bodies[0].input).toEqual([
      { type: "message", role: "system", content: "Keep stable rules." },
      { type: "message", role: "user", content: "hello" }
    ]);
    expect(bodies[1].input).toEqual([
      { type: "message", role: "user", content: "System instructions for this run:\n\nKeep stable rules." },
      { type: "message", role: "user", content: "hello" }
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "provider-diagnostic",
          diagnostic: expect.objectContaining({
            phase: "request-error",
            endpoint: "responses",
            status: 200,
            retryable: true,
            errorKind: "schema"
          })
        }),
        { type: "text-delta", text: "ok" },
        { type: "stop", reason: "stop" }
      ])
    );
  });

  it("retries Chat Completions SSE error frames with a user-prefix when a provider rejects system messages", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return new Response('data: {"error":{"message":"System messages are not allowed"}}\n\n', {
          headers: { "content-type": "text/event-stream" }
        });
      }
      return new Response(
        [
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
          "data: [DONE]",
          ""
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } }
      );
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me/",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "chat-completions",
      diagnostics: true,
      retry: { maxAttempts: 1 },
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("system", "Task finished."), createTextMessage("user", "continue")],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect(bodies[0].messages).toEqual([
      { role: "system", content: "Task finished." },
      { role: "user", content: "continue" }
    ]);
    expect(bodies[1].messages).toEqual([
      { role: "user", content: "System instructions for this run:\n\nTask finished." },
      { role: "user", content: "continue" }
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "provider-diagnostic",
          diagnostic: expect.objectContaining({
            phase: "request-error",
            endpoint: "chat-completions",
            retryable: true,
            errorKind: "schema"
          })
        }),
        { type: "text-delta", text: "ok" },
        { type: "stop", reason: "stop" }
      ])
    );
  });

  it("does not retry or endpoint-fallback a Cloudflare managed challenge", async () => {
    const urls: string[] = [];
    const fetchMock: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response("<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>", {
        status: 403,
        statusText: "Forbidden",
        headers: { "content-type": "text/html", "cf-mitigated": "challenge", server: "cloudflare" }
      });
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me/",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "auto",
      stream: false,
      diagnostics: true,
      retry: { maxAttempts: 2, initialDelayMs: 1 },
      fetch: fetchMock
    });

    const events: unknown[] = [];
    await expect(
      (async () => {
        for await (const event of provider.stream({
          sessionId: "s",
          cwd: "C:/repo",
          messages: [createTextMessage("user", "hello")],
          tools: [],
          signal: new AbortController().signal
        })) {
          events.push(event);
        }
      })()
    ).rejects.toThrow(/gateway-challenge/);

    expect(urls).toEqual(["https://api.flowbit.me/v1/responses"]);
    expect(events).toEqual([
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "request-start", endpoint: "responses" }) }),
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "response-start", endpoint: "responses", status: 403 }) }),
      expect.objectContaining({
        type: "provider-diagnostic",
        diagnostic: expect.objectContaining({ phase: "request-error", endpoint: "responses", status: 403, retryable: false, errorKind: "gateway-challenge" })
      })
    ]);
  });

  it("auto transport falls back to rust-reqwest after a gateway challenge", async () => {
    const fetchUrls: string[] = [];
    const rustUrls: string[] = [];
    const fetchMock: typeof fetch = async (input) => {
      fetchUrls.push(String(input));
      return new Response("<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>", {
        status: 403,
        statusText: "Forbidden",
        headers: { "content-type": "text/html", "cf-mitigated": "challenge", server: "cloudflare" }
      });
    };
    const rustReqwestFetch: typeof fetch = async (input) => {
      rustUrls.push(String(input));
      return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }), {
        headers: { "content-type": "application/json" }
      });
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me/",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "responses",
      stream: false,
      diagnostics: true,
      transport: "auto",
      retry: { maxAttempts: 1 },
      fetch: fetchMock,
      rustReqwestFetch
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("user", "hello")],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect(fetchUrls).toEqual(["https://api.flowbit.me/v1/responses"]);
    expect(rustUrls).toEqual(["https://api.flowbit.me/v1/responses"]);
    expect(events).toEqual([
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "request-start", endpoint: "responses" }) }),
      expect.objectContaining({
        type: "provider-diagnostic",
        diagnostic: expect.objectContaining({ phase: "transport-fallback", endpoint: "responses", status: 403, errorKind: "gateway-challenge" })
      }),
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "response-start", endpoint: "responses", status: 200 }) }),
      { type: "text-delta", text: "ok" },
      { type: "stop", reason: "stop" }
    ]);
  });

  it("includes rust-reqwest stdout error JSON when the helper exits before a response header", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me/",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "responses",
      stream: false,
      transport: "rust-reqwest",
      retry: { maxAttempts: 1 },
      rustReqwestCommand: process.execPath,
      rustReqwestArgs: ["-e", "process.stdout.write(JSON.stringify({error:'TLS handshake failed'})); process.exit(1);"]
    });

    await expect(
      collect(
        provider.stream({
          sessionId: "s",
          cwd: "C:/repo",
          messages: [createTextMessage("user", "hello")],
          tools: [],
          signal: new AbortController().signal
        })
      )
    ).rejects.toThrow(/TLS handshake failed/);
  });

  it("waits for Responses function arguments before emitting a streaming tool call", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"write_file","arguments":""}}\n\n'
          )
        );
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"write_file","arguments":""}}\n\n'
          )
        );
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.function_call_arguments.done","item_id":"fc_1","arguments":"{\\"path\\":\\"index.html\\",\\"content\\":\\"ok\\"}"}\n\n'
          )
        );
        controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{"status":"completed"}}\n\n'));
        controller.close();
      }
    });
    const fetchMock: typeof fetch = async () => new Response(body, { headers: { "content-type": "text/event-stream" } });
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me/",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "responses",
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("user", "write")],
        tools: [
          defineTextTool({
            name: "write_file",
            description: "Write file",
            execute: () => "ok"
          })
        ],
        signal: new AbortController().signal
      })
    );

    expect(events).toEqual([
      { type: "tool-call", id: "call_1", toolName: "write_file", input: { path: "index.html", content: "ok" } },
      { type: "stop", reason: "tool-call" }
    ]);
  });

  it("surfaces Responses API streaming error frames as terminal provider errors", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"type":"error","code":"rate_limit_exceeded","message":"Too many requests","usage":{"input_tokens":3,"output_tokens":0,"total_tokens":3}}\n\n'
          )
        );
        controller.close();
      }
    });
    const fetchMock: typeof fetch = async () => new Response(body, { headers: { "content-type": "text/event-stream" } });
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me/",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "responses",
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("user", "inspect")],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect(events).toEqual([
      {
        type: "stop",
        reason: "error",
        error: "Too many requests",
        usage: { promptTokens: 3, completionTokens: 0, totalTokens: 3 }
      }
    ]);
  });

  it("marks empty Responses API streams without terminal events as provider errors", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      }
    });
    const fetchMock: typeof fetch = async () => new Response(body, { headers: { "content-type": "text/event-stream" } });
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me/",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "responses",
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("user", "inspect")],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect(events).toEqual([
      {
        type: "stop",
        reason: "error",
        error: "[invalid-stream] Responses stream ended without a terminal response event"
      }
    ]);
  });

  it("marks partial Responses API text as interrupted when a stream closes before the terminal event", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
        controller.close();
      }
    });
    const fetchMock: typeof fetch = async () => new Response(body, { headers: { "content-type": "text/event-stream" } });
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me/",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "responses",
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("user", "inspect")],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect(events).toEqual([
      { type: "text-delta", text: "partial" },
      { type: "stop", reason: "error", error: "[invalid-stream] Responses stream ended without a terminal response event" }
    ]);
  });

  it("surfaces stream idle timeouts after partial output without dropping the partial text", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
      },
      cancel() {
        return undefined;
      }
    });
    const fetchMock: typeof fetch = async () => new Response(body, { headers: { "content-type": "text/event-stream" } });
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "chat-completions",
      streamIdleTimeoutMs: 5,
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("user", "hello")],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect(events).toEqual([
      { type: "text-delta", text: "partial" },
      { type: "stop", reason: "error", error: "[timeout] stream idle timed out after 5ms" }
    ]);
  });

  it("reports streaming fallback when a stream=true request returns JSON", async () => {
    let requestBody: Record<string, unknown> = {};
    const fetchMock: typeof fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "json-ok" }] }] }), {
        headers: { "content-type": "application/json" }
      });
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "responses",
      diagnostics: true,
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("user", "hello")],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect(requestBody).toMatchObject({ stream: true });
    expect(events).toEqual([
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "request-start", endpoint: "responses" }) }),
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "response-start", endpoint: "responses", status: 200 }) }),
      expect.objectContaining({
        type: "provider-diagnostic",
        diagnostic: expect.objectContaining({
          phase: "transport-fallback",
          endpoint: "responses",
          errorKind: "invalid-stream",
          retryable: false
        })
      }),
      { type: "text-delta", text: "json-ok" },
      { type: "stop", reason: "stop" }
    ]);
  });

  it("surfaces malformed SSE frames as typed invalid-stream errors after partial output", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
        controller.enqueue(encoder.encode("data: {bad json}\n\n"));
        controller.close();
      }
    });
    const fetchMock: typeof fetch = async () => new Response(body, { headers: { "content-type": "text/event-stream" } });
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "chat-completions",
      diagnostics: true,
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("user", "hello")],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect(events).toEqual([
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "request-start", endpoint: "chat-completions" }) }),
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "response-start", endpoint: "chat-completions", status: 200 }) }),
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "sse-first-byte" }) }),
      { type: "text-delta", text: "partial" },
      expect.objectContaining({
        type: "provider-diagnostic",
        diagnostic: expect.objectContaining({ phase: "request-error", errorKind: "invalid-stream", retryable: false })
      }),
      { type: "stop", reason: "error", error: expect.stringMatching(/^\[invalid-stream\]/) }
    ]);
  });

  it("preserves malformed tool arguments as structured diagnostics instead of crashing the stream", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "call_bad",
                    type: "function",
                    function: { name: "shell_command", arguments: "{bad json" }
                  }
                ]
              },
              finish_reason: "tool_calls"
            }
          ]
        }),
        { headers: { "content-type": "application/json" } }
      );

    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me",
      apiKey: "test-key",
      model: "mimo-test",
      endpoint: "chat-completions",
      stream: false,
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("user", "inspect")],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect(events[0]).toMatchObject({
      type: "tool-call",
      id: "call_bad",
      toolName: "shell_command",
      input: {
        __rawArguments: "{bad json"
      }
    });
    expect(JSON.stringify(events[0])).toContain("__parseError");
  });

  it("lists OpenAI-compatible models", async () => {
    let requestUrl = "";
    let requestHeaders = new Headers();
    const fetchMock: typeof fetch = async (input, init) => {
      requestUrl = String(input);
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ data: [{ id: "mimo-a", object: "model", owned_by: "flowbit" }] }), {
        headers: { "content-type": "application/json" }
      });
    };

    await expect(
      listOpenAICompatibleModels({
        baseUrl: "https://api.flowbit.me",
        modelsUrl: "https://api.flowbit.me/api/user/models",
        authHeader: "api-key",
        apiKey: "test-key",
        fetch: fetchMock
      })
    ).resolves.toEqual([{ id: "mimo-a", object: "model", ownedBy: "flowbit" }]);
    expect(requestUrl).toBe("https://api.flowbit.me/api/user/models");
    expect(requestHeaders.get("api-key")).toBe("test-key");
    expect(requestHeaders.has("authorization")).toBe(false);
  });

  it("falls back to rust-reqwest transport when model listing hits a gateway challenge", async () => {
    const fetchUrls: string[] = [];
    const rustUrls: string[] = [];
    const fetchMock: typeof fetch = async (input) => {
      fetchUrls.push(String(input));
      return new Response("<html><title>Just a moment...</title></html>", {
        status: 403,
        statusText: "Forbidden",
        headers: { "content-type": "text/html", "cf-mitigated": "challenge", server: "cloudflare" }
      });
    };
    const rustReqwestFetch: typeof fetch = async (input) => {
      rustUrls.push(String(input));
      return new Response(JSON.stringify({ data: [{ id: "mimo-v2.5", object: "model", owned_by: "flowbit" }] }), {
        headers: { "content-type": "application/json" }
      });
    };

    await expect(
      listOpenAICompatibleModels({
        baseUrl: "https://api.flowbit.me",
        authHeader: "authorization",
        apiKey: "test-key",
        transport: "auto",
        fetch: fetchMock,
        rustReqwestFetch
      })
    ).resolves.toEqual([{ id: "mimo-v2.5", object: "model", ownedBy: "flowbit" }]);

    expect(fetchUrls).toEqual(["https://api.flowbit.me/v1/models"]);
    expect(rustUrls).toEqual(["https://api.flowbit.me/v1/models"]);
  });

  it("sends reasoning effort in the Responses API shape only when explicitly configured", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ status: "completed", output: [] }), {
        headers: { "content-type": "application/json" }
      });
    };

    for (const effort of ["high", "off", "auto"] as const) {
      const provider = new OpenAICompatibleProvider({
        baseUrl: "https://api.flowbit.me",
        apiKey: "test-key",
        model: "mimo-v2.5",
        endpoint: "responses",
        stream: false,
        reasoningEffort: effort,
        reasoningEffortFormat: "auto",
        fetch: fetchMock
      });
      await collect(
        provider.stream({
          sessionId: "s",
          cwd: "C:/repo",
          messages: [createTextMessage("user", "hello")],
          tools: [],
          signal: new AbortController().signal
        })
      );
    }

    expect(bodies[0]).toMatchObject({ reasoning: { effort: "high" } });
    expect(bodies[0]).not.toHaveProperty("reasoning_effort");
    expect(bodies[1]).not.toHaveProperty("reasoning");
    expect(bodies[2]).not.toHaveProperty("reasoning");
  });

  it("sends reasoning effort in the chat-completions shape for chat-compatible providers", async () => {
    let requestBody: Record<string, unknown> = {};
    const fetchMock: typeof fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
        headers: { "content-type": "application/json" }
      });
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "chat-completions",
      stream: false,
      reasoningEffort: "xhigh",
      reasoningEffortFormat: "auto",
      fetch: fetchMock
    });

    await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("user", "hello")],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect(requestBody).toMatchObject({ reasoning_effort: "high" });
    expect(requestBody).not.toHaveProperty("reasoning");
  });

  it("reports non-streaming model mismatches without changing the configured request model", async () => {
    let requestBody: Record<string, unknown> = {};
    const fetchMock: typeof fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          model: "different-upstream-model",
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }]
        }),
        { headers: { "content-type": "application/json" } }
      );
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "chat-completions",
      stream: false,
      diagnostics: true,
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("user", "hello")],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect(requestBody.model).toBe("mimo-v2.5");
    expect(events).toEqual([
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "request-start", configuredModel: "mimo-v2.5" }) }),
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "response-start", status: 200 }) }),
      expect.objectContaining({
        type: "provider-diagnostic",
        diagnostic: expect.objectContaining({
          phase: "model-mismatch",
          configuredModel: "mimo-v2.5",
          actualModel: "different-upstream-model",
          modelMismatch: true
        })
      }),
      { type: "text-delta", text: "ok" },
      { type: "stop", reason: "stop" }
    ]);
  });

  it("reports streaming model mismatches from Responses events without mutating the selected model", async () => {
    const encoder = new TextEncoder();
    let requestBody: Record<string, unknown> = {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.created","response":{"model":"different-upstream-model"}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"ok"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{"status":"completed"}}\n\n'));
        controller.close();
      }
    });
    const fetchMock: typeof fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "responses",
      diagnostics: true,
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("user", "hello")],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect(requestBody.model).toBe("mimo-v2.5");
    expect(events).toEqual([
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "request-start", configuredModel: "mimo-v2.5" }) }),
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "response-start", status: 200 }) }),
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "sse-first-byte" }) }),
      expect.objectContaining({
        type: "provider-diagnostic",
        diagnostic: expect.objectContaining({
          phase: "model-mismatch",
          configuredModel: "mimo-v2.5",
          actualModel: "different-upstream-model",
          modelMismatch: true
        })
      }),
      { type: "text-delta", text: "ok" },
      expect.objectContaining({ type: "provider-diagnostic", diagnostic: expect.objectContaining({ phase: "stream-end" }) }),
      { type: "stop", reason: "stop" }
    ]);
  });

  it("retries transient provider failures before yielding the final response", async () => {
    let attempts = 0;
    const fetchMock: typeof fetch = async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ error: { message: "busy" } }), {
          status: 503,
          statusText: "Service Unavailable",
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
        headers: { "content-type": "application/json" }
      });
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "chat-completions",
      stream: false,
      retry: { maxAttempts: 2, initialDelayMs: 1 },
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("user", "hello")],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect(attempts).toBe(2);
    expect(events).toEqual([{ type: "text-delta", text: "ok" }, { type: "stop", reason: "stop" }]);
  });

  it("retries Cloudflare 520 gateway failures", async () => {
    let attempts = 0;
    const fetchMock: typeof fetch = async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("<html>cloudflare 520</html>", {
          status: 520,
          headers: { "content-type": "text/html" }
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
        headers: { "content-type": "application/json" }
      });
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.flowbit.me",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "chat-completions",
      stream: false,
      retry: { maxAttempts: 2, initialDelayMs: 1 },
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("user", "hello")],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect(attempts).toBe(2);
    expect(events).toEqual([{ type: "text-delta", text: "ok" }, { type: "stop", reason: "stop" }]);
  });

  it("uses MiMo chat-completions dialect fields and reasoning replay padding", async () => {
    let requestBody: Record<string, unknown> = {};
    let requestHeaders = new Headers();
    const fetchMock: typeof fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ choices: [{ message: { reasoning_content: "think", content: "ok" }, finish_reason: "stop" }] }), {
        headers: { "content-type": "application/json" }
      });
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://api.xiaomimimo.com/v1",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "chat-completions",
      authHeader: "api-key",
      maxTokens: 2048,
      topP: 0.95,
      reasoningContent: "require",
      toolChoice: { type: "function", name: "shell_command" },
      stream: false,
      fetch: fetchMock
    });

    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [
          createTextMessage("user", "inspect"),
          {
            id: "assistant_1",
            role: "assistant",
            createdAt: "2026-01-01T00:00:00.000Z",
            blocks: [
              {
                type: "tool-call",
                id: "call_1",
                toolName: "shell_command",
                input: { command: "pwd" }
              }
            ]
          }
        ],
        tools: [
          defineTextTool({
            name: "shell_command",
            description: "Run command",
            execute: () => "ok"
          })
        ],
        signal: new AbortController().signal
      })
    );

    expect(requestHeaders.get("api-key")).toBe("test-key");
    expect(requestHeaders.has("authorization")).toBe(false);
    expect(requestBody).toMatchObject({
      model: "mimo-v2.5",
      max_completion_tokens: 2048,
      top_p: 0.95,
      tool_choice: {
        type: "function",
        function: {
          name: "shell_command"
        }
      }
    });
    expect(requestBody).not.toHaveProperty("max_tokens");
    expect((requestBody.messages as Array<Record<string, unknown>>)[1]).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [
        expect.objectContaining({
          id: "call_1",
          function: expect.objectContaining({ name: "shell_command" })
        })
      ]
    });
    expect((requestBody.messages as Array<Record<string, unknown>>)[1]).not.toHaveProperty("reasoning_content");
    expect(events).toEqual([
      { type: "thought-delta", text: "think" },
      { type: "text-delta", text: "ok" },
      { type: "stop", reason: "stop" }
    ]);
  });

  it("drops empty assistant history messages for MiMo chat-completions compatibility", async () => {
    let requestBody: Record<string, unknown> = {};
    const fetchMock: typeof fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
        headers: { "content-type": "application/json" }
      });
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://token-plan-cn.xiaomimimo.com",
      apiKey: "test-key",
      model: "mimo-v2.5",
      endpoint: "chat-completions",
      authHeader: "api-key",
      reasoningContent: "require",
      stream: false,
      fetch: fetchMock
    });

    await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [
          createTextMessage("user", "inspect"),
          {
            id: "assistant_empty",
            role: "assistant",
            createdAt: "2026-01-01T00:00:00.000Z",
            blocks: []
          },
          createTextMessage("user", "continue")
        ],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect((requestBody.messages as Array<Record<string, unknown>>).map((message) => message.role)).toEqual(["user", "user"]);
  });

  it("loads strict provider config files and creates providers with test overrides", async () => {
    const configPath = join(tempRoot, "provider.json");
    await writeFile(
      configPath,
      JSON.stringify({
        provider: {
          id: "flowbit",
          baseUrl: "https://api.flowbit.me/",
          apiKey: "test-key",
          model: "mimo-test",
          endpoint: "responses",
          authHeader: "authorization",
          maxTokensField: "max_completion_tokens",
          reasoningContent: "require",
          reasoningEffort: "high",
          reasoningEffortFormat: "responses",
          toolChoice: {
            type: "function",
            name: "write_file"
          },
          stream: false,
          temperature: 0.1,
          topP: 0.95,
          maxTokens: 1024,
          requestTimeoutMs: 120000,
          firstByteTimeoutMs: 45000,
          streamIdleTimeoutMs: 30000,
          diagnostics: {
            enabled: true,
            headers: ["cf-ray", "x-request-id"]
          },
          retry: {
            maxAttempts: 3,
            initialDelayMs: 100,
            maxDelayMs: 1000,
            totalBudgetMs: 5000,
            jitterRatio: 0.2
          },
          headers: {
            "x-test": "yes"
          },
          transport: "auto",
          rustReqwestCommand: "agent-provider-http",
          rustReqwestArgs: ["--stdio"],
          rustReqwestCwd: tempRoot
        }
      }),
      "utf8"
    );

    await expect(loadOpenAICompatibleProviderConfig(configPath)).resolves.toMatchObject({
      id: "flowbit",
      baseUrl: "https://api.flowbit.me/",
      apiKey: "test-key",
      model: "mimo-test",
      endpoint: "responses",
      authHeader: "authorization",
      maxTokensField: "max_completion_tokens",
      reasoningContent: "require",
      reasoningEffort: "high",
      reasoningEffortFormat: "responses",
      toolChoice: {
        type: "function",
        name: "write_file"
      },
      stream: false,
      temperature: 0.1,
      topP: 0.95,
      maxTokens: 1024,
      requestTimeoutMs: 120000,
      firstByteTimeoutMs: 45000,
      streamIdleTimeoutMs: 30000,
      diagnostics: {
        enabled: true,
        headers: ["cf-ray", "x-request-id"]
      },
      retry: {
        maxAttempts: 3,
        initialDelayMs: 100,
        maxDelayMs: 1000,
        totalBudgetMs: 5000,
        jitterRatio: 0.2
      },
      headers: {
        "x-test": "yes"
      },
      transport: "auto",
      rustReqwestCommand: "agent-provider-http",
      rustReqwestArgs: ["--stdio"],
      rustReqwestCwd: tempRoot
    });

    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }), {
        headers: { "content-type": "application/json" }
      });
    const provider = await createOpenAICompatibleProviderFromConfig(configPath, { fetch: fetchMock });
    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("user", "hello")],
        tools: [],
        signal: new AbortController().signal
      })
    );
    expect(events.map((event) => event.type)).toEqual(["provider-diagnostic", "provider-diagnostic", "text-delta", "stop"]);
    expect(events.at(-2)).toEqual({ type: "text-delta", text: "ok" });
    expect(events.at(-1)).toEqual({ type: "stop", reason: "stop" });
  });

  it("loads provider API keys from environment variables without requiring inline secrets", async () => {
    const configPath = join(tempRoot, "provider-env.json");
    await writeFile(
      configPath,
      JSON.stringify({
        provider: {
          baseUrl: "https://api.flowbit.me/",
          apiKeyEnv: "FLOWBIT_TEST_KEY",
          model: "mimo-test"
        }
      }),
      "utf8"
    );

    await expect(loadOpenAICompatibleProviderConfig(configPath, { env: { FLOWBIT_TEST_KEY: "env-key" } })).resolves.toMatchObject({
      baseUrl: "https://api.flowbit.me/",
      apiKeyEnv: "FLOWBIT_TEST_KEY",
      apiKey: "env-key",
      model: "mimo-test"
    });

    await expect(loadOpenAICompatibleProviderConfig(configPath, { resolveApiKey: false })).resolves.toMatchObject({
      apiKeyEnv: "FLOWBIT_TEST_KEY"
    });
  });

  it("loads provider API keys from config-relative secret files", async () => {
    const configPath = join(tempRoot, "provider-file.json");
    const secretPath = join(tempRoot, "provider.key");
    await writeFile(secretPath, "file-key\n", "utf8");
    await writeFile(
      configPath,
      JSON.stringify({
        provider: {
          baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
          apiKeyFile: "provider.key",
          model: "mimo-v2.5",
          endpoint: "chat-completions",
          authHeader: "api-key",
          stream: false
        }
      }),
      "utf8"
    );

    let requestHeaders = new Headers();
    const fetchMock: typeof fetch = async (_input, init) => {
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
        headers: { "content-type": "application/json" }
      });
    };

    const provider = await createOpenAICompatibleProviderFromConfig(configPath, { fetch: fetchMock });
    const events = await collect(
      provider.stream({
        sessionId: "s",
        cwd: "C:/repo",
        messages: [createTextMessage("user", "hello")],
        tools: [],
        signal: new AbortController().signal
      })
    );

    expect(requestHeaders.get("api-key")).toBe("file-key");
    expect(requestHeaders.has("authorization")).toBe(false);
    expect(events).toEqual([{ type: "text-delta", text: "ok" }, { type: "stop", reason: "stop" }]);
  });

  it("rejects malformed provider config files early", async () => {
    const configPath = join(tempRoot, "bad-provider.json");
    await writeFile(configPath, JSON.stringify({ provider: { baseUrl: "", model: "mimo-test" } }), "utf8");
    await expect(loadOpenAICompatibleProviderConfig(configPath)).rejects.toThrow(/provider\.baseUrl/);
  });
});
