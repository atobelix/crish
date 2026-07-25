import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LlmApiMockServer, Scenarios } from "./mock-server";

describe("E2E: StreamParser + Transport", () => {
  const server = new LlmApiMockServer();

  beforeAll(async () => {
    server.on("/v1/chat/completions", Scenarios.openaiChatText());
    server.on("/v1/messages", Scenarios.anthropicThinking());
    await server.start(0);
  });

  afterAll(async () => {
    await server.stop();
  });

  it("successfully streams OpenAI Chat text completion", async () => {
    const response = await fetch(`${server.getBaseUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-key" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Hello" }], stream: true }),
    });
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toContain("Hello");
    expect(text).toContain("world");
    expect(text).toContain("[DONE]");
  });

  it("successfully streams Anthropic Messages text completion", async () => {
    server.on("/v1/messages", Scenarios.anthropicMessages());
    const response = await fetch(`${server.getBaseUrl()}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "test-key", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-3-5-sonnet-20241022", messages: [{ role: "user", content: "Hi" }], stream: true }),
    });
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toContain("Hello from Anthropic");
  });

  it("successfully streams Ollama chat completion", async () => {
    server.on("/api/chat", Scenarios.ollamaChat());
    const response = await fetch(`${server.getBaseUrl()}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "llama3", messages: [{ role: "user", content: "Hi" }], stream: true }),
    });
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toContain("Hello");
    expect(text).toContain("from Ollama");
    // Done flag should be present in the last chunk
    expect(text).toContain('"done":true');
  });

  it("returns 401 error for invalid API key", async () => {
    server.on("/v1/test-401", Scenarios.error401());
    const response = await fetch(`${server.getBaseUrl()}/v1/test-401`);
    expect(response.status).toBe(401);
  });

  it("returns 429 for rate limit", async () => {
    server.on("/v1/test-429", Scenarios.error429());
    const response = await fetch(`${server.getBaseUrl()}/v1/test-429`);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("5");
  });
});
