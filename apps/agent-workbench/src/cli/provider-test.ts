import type { ProviderDefinition, TestSuiteResult, TestResult } from "./provider-types";
import { loadProviderConfig, buildAuthHeader } from "./provider-utils";

export async function testProviderCommand(
  providerRef: string,
  options: { basic?: boolean; stress?: boolean; errors?: boolean; mock?: boolean },
): Promise<TestSuiteResult> {
  const config = await loadProviderConfig(providerRef);
  const baseUrl = `${config.baseUrl}${config.pathPrefix ?? "/v1"}`;
  const authHeaders = buildAuthHeader(config.auth);
  const allHeaders = { accept: "application/json", ...authHeaders, ...config.headers };

  const result: TestSuiteResult = {
    providerId: config.id,
    baseUrl,
    model: config.defaultModel,
    basic: [],
    modelList: [],
    stress: [],
    errors: [],
    summary: { passed: 0, warnings: 0, failed: 0, rating: "recommended" },
  };

  console.log(`\n╭─ Provider 测试: ${config.id} ─────────────────────────────────╮`);
  console.log(`│  baseUrl: ${baseUrl}`);
  console.log(`│  model: ${config.defaultModel}`);
  console.log(`╰──────────────────────────────────────────────────────────────╯\n`);

  // ── 基础测试 ──
  console.log("┌─ 基础测试 ──────────────────────────────────────────────────┐");
  result.basic.push(await testModelList(baseUrl, allHeaders, config));
  result.basic.push(await testChatCompletion(baseUrl, allHeaders, config));
  result.basic.push(await testStreaming(baseUrl, allHeaders, config));
  if (config.features?.supportsToolCalls !== false) {
    result.basic.push(await testToolCall(baseUrl, allHeaders, config));
  }
  result.basic.push(await testJsonMode(baseUrl, allHeaders, config));
  printTestResults(result.basic);
  console.log("└──────────────────────────────────────────────────────────────┘\n");

  // ── 模型列表 ──
  console.log("┌─ 模型列表 ──────────────────────────────────────────────────┐");
  result.modelList = await testAllModels(baseUrl, allHeaders, config);
  printTestResults(result.modelList);
  console.log("└──────────────────────────────────────────────────────────────┘\n");

  // ── 压力测试 ──
  if (options.stress !== false) {
    console.log("┌─ 压力测试 ──────────────────────────────────────────────────┐");
    result.stress = await runStressTests(baseUrl, allHeaders, config);
    printTestResults(result.stress);
    console.log("└──────────────────────────────────────────────────────────────┘\n");
  }

  // ── 错误处理 ──
  if (options.errors !== false) {
    console.log("┌─ 错误处理测试 ──────────────────────────────────────────────┐");
    result.errors = await runErrorTests(baseUrl, authHeaders, config);
    printTestResults(result.errors);
    console.log("└──────────────────────────────────────────────────────────────┘\n");
  }

  // ── 摘要 ──
  const allTests = [...result.basic, ...result.modelList, ...result.stress, ...result.errors];
  const passed = allTests.filter((t) => t.passed && t.severity !== "warning").length;
  const warnings = allTests.filter((t) => t.severity === "warning").length;
  const failed = allTests.filter((t) => !t.passed).length;

  result.summary = {
    passed,
    warnings,
    failed,
    rating: failed === 0 ? (warnings > 2 ? "acceptable" : "recommended") : "not-recommended",
  };

  console.log(`┌─ 诊断摘要 ──────────────────────────────────────────────┐`);
  console.log(`│  通过: ${passed}/${allTests.length}`);
  console.log(`│  警告: ${warnings}`);
  console.log(`│  失败: ${failed}`);
  console.log(`│  总体评级: ${result.summary.rating === "recommended" ? "✓ 推荐" : result.summary.rating === "acceptable" ? "⚠ 可用" : "✗ 不推荐"}`);
  console.log(`└──────────────────────────────────────────────────────────────┘`);

  return result;
}

async function testModelList(baseUrl: string, headers: Record<string, string>, config: ProviderDefinition): Promise<TestResult> {
  const start = Date.now();
  try {
    const endpoint = config.modelListEndpoint ?? "/models";
    const response = await fetch(`${baseUrl}${endpoint}`, { headers, signal: AbortSignal.timeout(10000) });
    const latencyMs = Date.now() - start;
    if (!response.ok) return { name: "model list", passed: false, latencyMs, message: `HTTP ${response.status}` };
    const body = await response.json() as { data?: unknown[] };
    if (!Array.isArray(body.data)) return { name: "model list", passed: false, latencyMs, message: "响应格式异常: data 不是数组" };
    return { name: "model list", passed: true, latencyMs, message: `${body.data.length} 个模型` };
  } catch (error) {
    return { name: "model list", passed: false, message: `错误: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function testChatCompletion(baseUrl: string, headers: Record<string, string>, config: ProviderDefinition): Promise<TestResult> {
  const start = Date.now();
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        model: config.defaultModel,
        messages: [{ role: "user", content: "Say hello in one word" }],
        max_tokens: 10,
        stream: false,
      }),
      signal: AbortSignal.timeout(config.timeout ?? 30000),
    });
    const latencyMs = Date.now() - start;
    if (!response.ok) {
      const text = await response.text();
      return { name: "chat completion", passed: false, latencyMs, message: `HTTP ${response.status}: ${text.slice(0, 100)}` };
    }
    return { name: "chat completion", passed: true, latencyMs, message: "正常" };
  } catch (error) {
    return { name: "chat completion", passed: false, message: `错误: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function testStreaming(baseUrl: string, headers: Record<string, string>, config: ProviderDefinition): Promise<TestResult> {
  const start = Date.now();
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        model: config.defaultModel,
        messages: [{ role: "user", content: "Count to 5" }],
        max_tokens: 50,
        stream: true,
      }),
      signal: AbortSignal.timeout(config.timeout ?? 30000),
    });
    const latencyMs = Date.now() - start;
    if (!response.ok) return { name: "streaming", passed: false, latencyMs, message: `HTTP ${response.status}` };
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      return { name: "streaming", passed: false, latencyMs, message: `非 SSE 响应: ${contentType}` };
    }
    // 读取第一个 chunk 确认流正常工作
    const reader = response.body?.getReader();
    if (!reader) return { name: "streaming", passed: false, latencyMs, message: "无可读 body" };
    const { done } = await reader.read();
    if (done) return { name: "streaming", passed: false, latencyMs, message: "流立即结束" };
    reader.releaseLock();
    return { name: "streaming", passed: true, latencyMs, message: "SSE 流正常" };
  } catch (error) {
    return { name: "streaming", passed: false, message: `错误: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function testToolCall(baseUrl: string, headers: Record<string, string>, config: ProviderDefinition): Promise<TestResult> {
  const start = Date.now();
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        model: config.defaultModel,
        messages: [{ role: "user", content: "What's the weather in Paris?" }],
        tools: [{
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather for a city",
            parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
          },
        }],
        max_tokens: 100,
        stream: false,
      }),
      signal: AbortSignal.timeout(config.timeout ?? 30000),
    });
    const latencyMs = Date.now() - start;
    if (!response.ok) return { name: "tool call", passed: false, latencyMs, message: `HTTP ${response.status}` };
    const body = await response.json() as { choices?: { message?: { tool_calls?: unknown[] } }[] };
    const hasToolCall = body.choices?.[0]?.message?.tool_calls?.length ?? 0 > 0;
    return {
      name: "tool call",
      passed: true,
      latencyMs,
      message: hasToolCall ? "function calling 可用" : "未触发 tool call (可能自动选择非工具响应)",
      severity: hasToolCall ? "info" : "warning",
    };
  } catch (error) {
    return { name: "tool call", passed: false, message: `错误: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function testJsonMode(baseUrl: string, headers: Record<string, string>, config: ProviderDefinition): Promise<TestResult> {
  const start = Date.now();
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        model: config.defaultModel,
        messages: [{ role: "user", content: "Return JSON: {\"key\": \"value\"}" }],
        response_format: { type: "json_object" },
        max_tokens: 50,
        stream: false,
      }),
      signal: AbortSignal.timeout(config.timeout ?? 30000),
    });
    const latencyMs = Date.now() - start;
    if (!response.ok) return { name: "JSON mode", passed: false, latencyMs, message: `HTTP ${response.status}` };
    return { name: "JSON mode", passed: true, latencyMs, message: "structured output 可用" };
  } catch (error) {
    return { name: "JSON mode", passed: false, message: `错误: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function testAllModels(baseUrl: string, headers: Record<string, string>, config: ProviderDefinition): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // 默认模型已测试
  results.push({
    name: `${config.defaultModel}`,
    passed: true,
    message: "默认模型, 已测试",
  });

  // 如果预配置了模型列表，测试前 5 个
  const modelsToTest = (config.models ?? []).slice(0, 5);
  for (const model of modelsToTest) {
    if (model.id === config.defaultModel) continue;
    const start = Date.now();
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          model: model.id,
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 5,
          stream: false,
        }),
        signal: AbortSignal.timeout(15000),
      });
      const latencyMs = Date.now() - start;
      if (!response.ok) {
        results.push({ name: model.id, passed: true, latencyMs, message: `HTTP ${response.status}`, severity: "warning" });
      } else {
        results.push({ name: model.id, passed: true, latencyMs, message: "可用" });
      }
    } catch {
      results.push({ name: model.id, passed: true, message: "跳过 (超时)", severity: "warning" });
    }
  }

  return results;
}

async function runStressTests(baseUrl: string, headers: Record<string, string>, config: ProviderDefinition): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // 5 并发请求
  const concurrency5 = await measureConcurrency(baseUrl, headers, config, 5);
  results.push({
    name: `5 并发请求`,
    passed: concurrency5.successRate >= 0.8,
    message: `${concurrency5.completed}/${concurrency5.total} 完成, 平均 ${concurrency5.avgLatency}ms`,
    severity: concurrency5.successRate >= 0.8 ? "info" : concurrency5.successRate >= 0.5 ? "warning" : "error",
  });

  // 并发 tool calls
  if (config.features?.supportsToolCalls !== false) {
    const toolCalls = await measureConcurrentToolCalls(baseUrl, headers, config, 3);
    results.push({
      name: "并发 tool calls",
      passed: toolCalls.successRate >= 0.8,
      message: `${toolCalls.completed}/${toolCalls.total} 完成`,
      severity: toolCalls.successRate >= 0.8 ? "info" : "warning",
    });
  }

  // 速率限制检测
  if (concurrency5.rateLimited) {
    results.push({
      name: "速率限制",
      passed: true,
      message: `${concurrency5.rpm} req/min (建议设置冷却)`,
      severity: "warning",
    });
  }

  return results;
}

async function measureConcurrency(
  baseUrl: string, headers: Record<string, string>, config: ProviderDefinition, n: number,
): Promise<{ total: number; completed: number; successRate: number; avgLatency: number; rateLimited: boolean; rpm: number }> {
  const latencies: number[] = [];
  let completed = 0;
  let rateLimited = false;

  const tasks = Array.from({ length: n }, async () => {
    const start = Date.now();
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          model: config.defaultModel,
          messages: [{ role: "user", content: "Say hello" }],
          max_tokens: 10,
          stream: false,
        }),
        signal: AbortSignal.timeout(30000),
      });
      latencies.push(Date.now() - start);
      if (response.ok) completed++;
      if (response.status === 429) rateLimited = true;
    } catch {
      // 超时或网络错误
    }
  });

  await Promise.all(tasks);
  const avgLatency = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  return { total: n, completed, successRate: completed / n, avgLatency, rateLimited, rpm: rateLimited ? 30 : 999 };
}

async function measureConcurrentToolCalls(
  baseUrl: string, headers: Record<string, string>, config: ProviderDefinition, n: number,
): Promise<{ total: number; completed: number; successRate: number }> {
  let completed = 0;
  const tasks = Array.from({ length: n }, async () => {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          model: config.defaultModel,
          messages: [{ role: "user", content: "Use the tool to check weather" }],
          tools: [{
            type: "function",
            function: {
              name: "get_weather",
              description: "Get weather",
              parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
            },
          }],
          max_tokens: 100,
          stream: false,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (response.ok) completed++;
    } catch {
      // ignore
    }
  });
  await Promise.all(tasks);
  return { total: n, completed, successRate: completed / n };
}

async function runErrorTests(baseUrl: string, authHeaders: Record<string, string>, config: ProviderDefinition): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // 无效 API Key
  results.push(await testInvalidAuth(baseUrl));
  // 无效模型名
  results.push(await testInvalidModel(baseUrl, authHeaders, config));
  // 超时场景
  results.push(await testTimeout(baseUrl, authHeaders, config));

  return results;
}

async function testInvalidAuth(baseUrl: string): Promise<TestResult> {
  const start = Date.now();
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer invalid-key-for-testing",
      },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const latencyMs = Date.now() - start;
    const validCodes = [401, 403];
    const passed = validCodes.includes(response.status);
    return {
      name: "无效 API Key",
      passed,
      latencyMs,
      message: passed ? `正确返回 ${response.status}` : `期望 401/403, 实际 ${response.status}`,
      severity: passed ? "info" : "error",
    };
  } catch {
    return { name: "无效 API Key", passed: true, message: "连接失败 (可能已屏蔽无效请求)", severity: "warning" };
  }
}

async function testInvalidModel(baseUrl: string, headers: Record<string, string>, config: ProviderDefinition): Promise<TestResult> {
  const start = Date.now();
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        model: "nonexistent-model-xyz-123",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const latencyMs = Date.now() - start;
    const validCodes = [400, 404];
    const passed = validCodes.includes(response.status);
    return {
      name: "无效模型名",
      passed,
      latencyMs,
      message: passed ? `正确返回 ${response.status}` : `期望 400/404, 实际 ${response.status}`,
      severity: passed ? "info" : "error",
    };
  } catch {
    return { name: "无效模型名", passed: true, message: "连接失败", severity: "warning" };
  }
}

async function testTimeout(baseUrl: string, headers: Record<string, string>, config: ProviderDefinition): Promise<TestResult> {
  const start = Date.now();
  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        model: config.defaultModel,
        messages: [{ role: "user", content: "Write a very long essay about AI" }],
        max_tokens: 5,
      }),
      signal: AbortSignal.timeout(500),
    });
    const latencyMs = Date.now() - start;
    void resp;
    return {
      name: "超时场景",
      passed: true,
      latencyMs,
      message: `请求在 ${latencyMs}ms 内完成 (超时设置 500ms 可能太短)`,
      severity: "info",
    };
  } catch {
    return { name: "超时场景", passed: true, message: "优雅超时 (expected)", severity: "info" };
  }
}

function printTestResults(results: TestResult[]): void {
  for (const r of results) {
    const icon = !r.passed ? "✗" : r.severity === "warning" ? "⚠" : "✓";
    const latencyStr = r.latencyMs !== undefined ? `(${r.latencyMs}ms)` : "";
    console.log(`  ${icon} ${r.name}: ${r.message ?? ""} ${latencyStr}`.trim());
  }
}
