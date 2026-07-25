import { describe, it, expect } from "vitest";
import { OllamaEngine } from "./ollama-engine";
import { createSecret } from "../auth/types";
import type { AgentProviderRequest, ProviderStreamEvent } from "../../types";
import type { EngineOptions } from "../types";

describe("OllamaEngine", () => {
  const engine = new OllamaEngine();

  const defaultRequest: AgentProviderRequest = {
    sessionId: "s_test",
    cwd: "/test",
    messages: [{ id: "m1", role: "user", createdAt: new Date().toISOString(), blocks: [{ type: "text", text: "Hi" }] }],
    tools: [],
    signal: new AbortController().signal,
  };

  const defaultOptions: EngineOptions = {
    model: "llama3",
    apiKey: createSecret(""),
    baseUrl: "http://localhost:11434",
    stream: true,
    extra: { baseUrl: "http://localhost:11434", model: "llama3" },
  };

  describe("buildRequest", () => {
    it("builds a basic request with user message", () => {
      const result = engine.buildRequest(defaultRequest, defaultOptions);
      expect(result.url).toBe("http://localhost:11434/api/chat");
      expect(result.init.method).toBe("POST");
      expect((result.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
      const body = JSON.parse(result.init.body as string);
      expect(body.model).toBe("llama3");
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe("system");
      expect(body.messages[1].content).toContain("Hi");
    });

    it("strips trailing slash from baseUrl", () => {
      const result = engine.buildRequest(defaultRequest, {
        ...defaultOptions,
        extra: { ...defaultOptions.extra, baseUrl: "http://localhost:11434/" },
      });
      expect(result.url).toBe("http://localhost:11434/api/chat");
    });

    it("includes system prompt when provided", () => {
      const request = { ...defaultRequest, systemPrompt: "You are helpful." };
      const result = engine.buildRequest(request, defaultOptions);
      const body = JSON.parse(result.init.body as string);
      expect(body.messages[0].role).toBe("system");
      expect(body.messages[0].content).toBe("You are helpful.");
    });

    it("includes tools when provided", () => {
      const request = {
        ...defaultRequest,
        tools: [{ name: "get_weather", description: "Get weather", inputSchema: { type: "object", properties: {} } }],
      } as unknown as AgentProviderRequest;
      const result = engine.buildRequest(request, defaultOptions);
      const body = JSON.parse(result.init.body as string);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].function.name).toBe("get_weather");
    });

    it("includes tool results for tool role messages", () => {
      const request: AgentProviderRequest = {
        ...defaultRequest,
        messages: [{
          id: "m2", role: "tool", createdAt: new Date().toISOString(),
          blocks: [{ type: "tool-result", toolCallId: "call_1", toolName: "get_weather", output: { temp: 25 } as any, isError: false }],
        }],
      };
      const result = engine.buildRequest(request, defaultOptions);
      const body = JSON.parse(result.init.body as string);
      expect(body.messages[1].role).toBe("tool");
      expect(body.messages[1].content).toContain("temp");
    });

    it("defaults baseUrl to http://localhost:11434 when not provided", () => {
      const result = engine.buildRequest(defaultRequest, {
        ...defaultOptions,
        extra: { model: "llama3" },
      });
      expect(result.url).toBe("http://localhost:11434/api/chat");
    });

    it("converts assistant messages with tool calls", () => {
      const request: AgentProviderRequest = {
        ...defaultRequest,
        messages: [{
          id: "m3", role: "assistant", createdAt: new Date().toISOString(),
          blocks: [
            { type: "text", text: "Let me check..." },
            { type: "tool-call", id: "call_1", toolName: "get_weather", input: { city: "NYC" } },
          ],
        }],
      };
      const result = engine.buildRequest(request, defaultOptions);
      const body = JSON.parse(result.init.body as string);
      const msg = body.messages[1];
      expect(msg.role).toBe("assistant");
      expect(msg.tool_calls).toHaveLength(1);
      expect(msg.tool_calls[0].function.name).toBe("get_weather");
    });
  });

  describe("parseStream", () => {
    it("parses text delta chunks", async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"model":"llama3","message":{"role":"assistant","content":"Hello"},"done":false}\n'));
          controller.enqueue(new TextEncoder().encode('{"model":"llama3","message":{"role":"assistant","content":" world"},"done":true,"prompt_eval_count":5,"eval_count":3}\n'));
          controller.close();
        },
      });
      const response = new Response(body, { headers: { "content-type": "application/x-ndjson" } });
      const events: ProviderStreamEvent[] = [];
      for await (const event of engine.parseStream(response)) {
        events.push(event as ProviderStreamEvent);
      }
      expect(events).toHaveLength(3);
      expect(events[0]).toMatchObject({ type: "text-delta", text: "Hello" });
      expect(events[1]).toMatchObject({ type: "text-delta", text: " world" });
      expect(events[2]).toMatchObject({ type: "stop", reason: "stop", usage: { promptTokens: 5, completionTokens: 3 } });
    });

    it("handles empty response body", async () => {
      const body = new ReadableStream({ start(controller) { controller.close(); } });
      const response = new Response(body);
      const events: ProviderStreamEvent[] = [];
      for await (const event of engine.parseStream(response)) {
        events.push(event as ProviderStreamEvent);
      }
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "stop", reason: "stop" });
    });

    it("handles aborted signal", async () => {
      const controller = new AbortController();
      controller.abort();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"model":"llama3","message":{"role":"assistant","content":"data"},"done":false}\n'));
        },
      });
      const response = new Response(body);
      const events: ProviderStreamEvent[] = [];
      for await (const event of engine.parseStream(response, controller.signal)) {
        events.push(event as ProviderStreamEvent);
      }
      expect(events.some(e => e.type === "stop")).toBe(true);
    });
  });

  describe("parseResponse", () => {
    it("parses a complete response with text content", async () => {
      const body = { model: "llama3", message: { role: "assistant", content: "Complete response" }, done: true, prompt_eval_count: 10, eval_count: 5 };
      const events: ProviderStreamEvent[] = [];
      for await (const event of engine.parseResponse(body)) {
        events.push(event as ProviderStreamEvent);
      }
      expect(events[0]).toMatchObject({ type: "text-delta", text: "Complete response" });
      expect(events[1]).toMatchObject({ type: "stop", reason: "stop", usage: { promptTokens: 10, completionTokens: 5 } });
    });

    it("parses response with tool calls", async () => {
      const body = { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "search", arguments: { q: "test" } } }] }, done: true };
      const events: ProviderStreamEvent[] = [];
      for await (const event of engine.parseResponse(body)) {
        events.push(event as ProviderStreamEvent);
      }
      expect(events[0]).toMatchObject({ type: "tool-call", toolName: "search" });
    });

    it("returns undefined usage when no counts present", async () => {
      const body = { message: { role: "assistant", content: "ok" }, done: true };
      const events: ProviderStreamEvent[] = [];
      for await (const event of engine.parseResponse(body)) {
        events.push(event as ProviderStreamEvent);
      }
      expect(events[1]).toMatchObject({ type: "stop" });
      expect((events[1] as any).usage).toBeUndefined();
    });
  });

  describe("classifyError", () => {
    it("returns unknown for generic error", () => {
      const result = engine.classifyError(new Error("something broke"));
      expect(result.kind).toBe("unknown");
    });
  });
});
