import { type ProviderRegistryV2 } from "../registry-v2";

export interface TestResult {
  providerId: string;
  baseUrl: string;
  model: string;
  success: boolean;
  duration: number;
  error?: string;
  details?: {
    modelListAvailable: boolean;
    streamingWorks: boolean;
    toolCallWorks: boolean;
  };
}

function authHeaders(apiKey: string, decl: { auth: { type: string; keyHeader: string } }): Record<string, string> {
  if (!apiKey) return { "Content-Type": "application/json" };

  const headerKey = decl.auth.type === "bearer" ? "Authorization" : decl.auth.keyHeader;
  const value = decl.auth.type === "bearer" ? `Bearer ${apiKey}` : apiKey;

  return { [headerKey]: value, "Content-Type": "application/json" };
}

async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs: number }): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function testProviderConnection(
  registry: ProviderRegistryV2,
  providerId: string,
  apiKey: string,
): Promise<TestResult> {
  const start = Date.now();

  const entry = registry.getDeclarativeEntry(providerId);
  if (!entry) {
    return { providerId, baseUrl: "", model: "", success: false, duration: Date.now() - start, error: `Unknown provider: ${providerId}` };
  }

  const decl = entry.declarative;
  const baseUrl = decl.baseUrl;
  const model = decl.models[0]?.id ?? "";
  const headers = authHeaders(apiKey, decl);
  const details: TestResult["details"] = {
    modelListAvailable: false,
    streamingWorks: false,
    toolCallWorks: false,
  };

  try {
    // 1. Test model list endpoint
    try {
      const modelsUrl = `${baseUrl}${decl.paths.models}`;
      const modelRes = await fetchWithTimeout(modelsUrl, { headers, method: "GET", timeoutMs: 10_000 });
      details.modelListAvailable = modelRes.ok;
    } catch {
      details.modelListAvailable = false;
    }

    // 2. Test streaming
    try {
      const chatUrl = `${baseUrl}${decl.paths.chatCompletions}`;
      const streamRes = await fetchWithTimeout(chatUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Hi" }], stream: true, max_tokens: 10 }),
        timeoutMs: 15_000,
      });
      const ct = streamRes.headers.get("content-type") ?? "";
      details.streamingWorks = streamRes.ok && ct.includes("text/event-stream");
    } catch {
      details.streamingWorks = false;
    }

    // 3. Test tool call format
    try {
      const chatUrl = `${baseUrl}${decl.paths.chatCompletions}`;
      const toolRes = await fetchWithTimeout(chatUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "What is the weather?" }],
          tools: [{
            type: "function",
            function: {
              name: "get_weather",
              description: "Get current weather",
              parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] },
            },
          }],
          tool_choice: "auto",
          max_tokens: 50,
        }),
        timeoutMs: 15_000,
      });
      if (toolRes.ok) {
        const body = await toolRes.json() as { choices?: Array<{ message?: { tool_calls?: unknown[] } }> };
        details.toolCallWorks = (body.choices?.[0]?.message?.tool_calls?.length ?? 0) > 0;
      }
    } catch {
      details.toolCallWorks = false;
    }

    const success = details.modelListAvailable || details.streamingWorks;
    return { providerId, baseUrl, model, success, duration: Date.now() - start, details };
  } catch (err) {
    return { providerId, baseUrl, model, success: false, duration: Date.now() - start, error: (err as Error).message, details };
  }
}
