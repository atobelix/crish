import { describe, it, expect } from "vitest";
import { OpenAICompatibleEngine } from "./openai-compatible-engine";
import { createSecret } from "../auth/types";
import type { AgentProviderRequest, ProviderStreamEvent } from "../../types";
import type { EngineOptions } from "../types";

describe("OpenAICompatibleEngine", () => {
  const engine = new OpenAICompatibleEngine();

  const defaultRequest: AgentProviderRequest = {
    sessionId: "s_test",
    cwd: "/test",
    messages: [{ id: "m1", role: "user", createdAt: new Date().toISOString(), blocks: [{ type: "text", text: "Hello" }] }],
    tools: [],
    signal: new AbortController().signal,
  };

  const defaultOptions: EngineOptions = {
    model: "gpt-4o",
    apiKey: createSecret("sk-test"),
    baseUrl: "https://api.openai.com/v1",
    stream: true,
    extra: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o" },
  };

  describe("buildRequest", () => {
    it("builds a chat completions request by default", async () => {
      const result = await engine.buildRequest(defaultRequest, defaultOptions);
      expect(result.url).toBe("https://api.openai.com/v1/chat/completions");
      expect(result.init.method).toBe("POST");
      expect((result.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
      expect((result.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test");
      const body = JSON.parse(result.init.body as string);
      expect(body.model).toBe("gpt-4o");
      expect(body.stream).toBe(true);
    });

    it("builds responses endpoint request when endpointType is responses", async () => {
      const options = { ...defaultOptions, extra: { ...defaultOptions.extra, endpointType: "responses" } };
      const result = await engine.buildRequest(defaultRequest, options);
      expect(result.url).toBe("https://api.openai.com/v1/responses");
    });

    it("uses chat-completions when endpointType explicitly set", async () => {
      const options = { ...defaultOptions, extra: { ...defaultOptions.extra, endpointType: "chat-completions" } };
      const result = await engine.buildRequest(defaultRequest, options);
      expect(result.url).toBe("https://api.openai.com/v1/chat/completions");
    });

    it("sets Authorization header from apiKey by default", async () => {
      const result = await engine.buildRequest(defaultRequest, defaultOptions);
      expect((result.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sk-test");
    });

    it("sets custom auth header from authHeader extra", async () => {
      const options = { ...defaultOptions, extra: { ...defaultOptions.extra, authHeader: "x-api-key" } };
      const result = await engine.buildRequest(defaultRequest, options);
      expect((result.init.headers as Record<string, string>)["x-api-key"]).toBe("sk-test");
    });

    it("omits auth headers when authHeader is none", async () => {
      const options = { ...defaultOptions, extra: { ...defaultOptions.extra, authHeader: "none" } };
      const result = await engine.buildRequest(defaultRequest, options);
      expect((result.init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
    });
  });

  describe("parseResponse", () => {
    it("parses chat completions JSON response", async () => {
      const body = {
        choices: [{ message: { content: "Hello from chat" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
      const events: ProviderStreamEvent[] = [];
      for await (const event of engine.parseResponse(body)) {
        events.push(event as ProviderStreamEvent);
      }
      expect(events.some(e => e.type === "text-delta")).toBe(true);
    });

    it("parses responses format JSON response", async () => {
      const body = {
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello from responses" }] }],
      };
      const events: ProviderStreamEvent[] = [];
      for await (const event of engine.parseResponse(body)) {
        events.push(event as ProviderStreamEvent);
      }
      expect(events.some(e => e.type === "text-delta")).toBe(true);
    });

    it("returns error for unrecognized format", async () => {
      const body = { unexpected: true };
      const events: ProviderStreamEvent[] = [];
      for await (const event of engine.parseResponse(body)) {
        events.push(event as ProviderStreamEvent);
      }
      expect(events[0]!.type).toBe("stop");
      if (events[0]!.type === "stop") {
        expect((events[0] as { reason?: string }).reason).toBe("error");
      }
    });
  });

  describe("classifyError", () => {
    it("classifies 401 as auth error", () => {
      const result = engine.classifyError(new Error("Unauthorized"), 401);
      expect(result.kind).toBe("auth");
    });
  });
});
