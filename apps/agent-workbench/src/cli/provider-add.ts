import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type {
  ProviderDefinition,
  ProviderEngine,
  AuthMethod,
  ConnectionTestResults,
} from "./provider-types";

const PROVIDERS_DIR = resolve(import.meta.dirname ?? process.cwd(), "../../../providers");

const ENGINE_CHOICES = [
  { value: "openai-compatible" as const, label: "OpenAI-Compatible (覆盖 90%+ 第三方 API)" },
  { value: "anthropic" as const, label: "Anthropic Messages API" },
  { value: "gemini" as const, label: "Google Gemini API" },
];

const AUTH_METHOD_CHOICES = [
  { value: "bearer" as const, label: "Bearer Token (Authorization: Bearer <key>)" },
  { value: "api-key" as const, label: "API Key Header (x-api-key: <key>)" },
  { value: "basic" as const, label: "Basic Auth (Authorization: Basic <base64>)" },
  { value: "aws-sig-v4" as const, label: "AWS Signature V4" },
  { value: "azure-api-key" as const, label: "Azure API Key" },
  { value: "oauth2" as const, label: "OAuth2" },
  { value: "none" as const, label: "No Auth (本地服务)" },
];

const ENDPOINT_CHOICES = [
  { value: "auto" as const, label: "auto - 先试 responses API, 回退 chat-completions" },
  { value: "chat-completions" as const, label: "chat-completions - 仅 Chat Completions API" },
  { value: "responses" as const, label: "responses - 仅 Responses API" },
];

function prompt(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(`\n? ${question}`);
    if (defaultValue) process.stdout.write(` (${defaultValue})`);
    process.stdout.write("\n  ▸ ");

    let buffer = "";
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();

    const onData = (chunk: Buffer) => {
      const char = chunk.toString();
      if (char === "\r" || char === "\n") {
        stdin.removeListener("data", onData);
        stdin.setRawMode?.(false);
        stdin.pause();
        process.stdout.write("\n");
        resolve(buffer.trim() || defaultValue || "");
      } else if (char === "\x7f" || char === "\b") {
        buffer = buffer.slice(0, -1);
        process.stdout.write("\b \b");
      } else {
        buffer += char;
        process.stdout.write(char);
      }
    };
    stdin.on("data", onData);
  });
}

async function promptSelect<T extends string>(
  question: string,
  choices: { value: T; label: string }[],
): Promise<T> {
  let selectedIndex = 0;
  const renderOptions = () => {
    process.stdout.write(`\n? ${question}\n`);
    for (let i = 0; i < choices.length; i++) {
      const cursor = i === selectedIndex ? "▸" : " ";
      process.stdout.write(`  ${cursor} ${(choices[i] as (typeof choices)[number]).label}\n`);
    }
  };

  return new Promise<T>((resolve) => {
    renderOptions();

    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();

    const onData = (chunk: Buffer) => {
      const key = chunk.toString();
      if (key === "\r" || key === "\n") {
        stdin.removeListener("data", onData);
        stdin.setRawMode?.(false);
        stdin.pause();
        process.stdout.write(`  已选择: ${(choices[selectedIndex] as (typeof choices)[number]).label}\n`);
        resolve((choices[selectedIndex] as (typeof choices)[number]).value);
      } else if (key === "\u001b[A" && selectedIndex > 0) {
        selectedIndex--;
        renderOptions();
      } else if (key === "\u001b[B" && selectedIndex < choices.length - 1) {
        selectedIndex++;
        renderOptions();
      }
    };
    stdin.on("data", onData);
  });
}

async function testConnection(config: Partial<ProviderDefinition>): Promise<ConnectionTestResults> {
  const results: ConnectionTestResults = {
    baseUrlReachable: false,
    baseUrlStatus: 0,
    baseUrlLatencyMs: 0,
    authSuccess: false,
    authStatusCode: 0,
    modelsCount: 0,
    modelsList: [],
    streamTestSuccess: false,
    streamTestLatencyMs: 0,
    toolCallSupported: false,
    warnings: [],
    errors: [],
  };

  const baseUrl = `${config.baseUrl}${config.pathPrefix ?? "/v1"}`;

  try {
    const start = Date.now();
    const authHeader = buildAuthHeader(config.auth);
    const response = await fetch(`${baseUrl}/models`, {
      headers: {
        accept: "application/json",
        ...authHeader,
        ...config.headers,
      },
      signal: AbortSignal.timeout(config.timeout ?? 10000),
    });
    results.baseUrlLatencyMs = Date.now() - start;
    results.baseUrlReachable = true;
    results.baseUrlStatus = response.status;

    if (response.ok) {
      results.authSuccess = true;
      results.authStatusCode = response.status;

      const body = (await response.json()) as { data?: unknown[] };
      if (Array.isArray(body.data)) {
        results.modelsCount = body.data.length;
        results.modelsList = body.data
          .map((m: unknown) => (m as { id?: string }).id ?? "")
          .filter(Boolean)
          .slice(0, 20);
      }
    } else if (response.status === 401 || response.status === 403) {
      results.authStatusCode = response.status;
      results.errors.push(`认证失败: HTTP ${response.status}`);
    } else {
      results.authStatusCode = response.status;
      results.warnings.push(`模型列表返回 ${response.status}，可能不支持自动发现`);
    }
  } catch (error) {
    results.errors.push(`网络错误: ${error instanceof Error ? error.message : String(error)}`);
  }

  return results;
}

function buildAuthHeader(auth?: ProviderDefinition["auth"]): Record<string, string> {
  if (!auth || auth.method === "none") return {};

  let key = auth.apiKey;
  if (auth.apiKeyEnv && !key) {
    key = process.env[auth.apiKeyEnv];
  }

  switch (auth.method) {
    case "bearer": {
      const prefix = auth.bearerPrefix ?? "Bearer ";
      return { authorization: `${prefix}${key ?? ""}` };
    }
    case "api-key": {
      const header = auth.keyHeader ?? "x-api-key";
      return { [header]: key ?? "" };
    }
    case "azure-api-key": {
      const header = auth.azureHeader ?? "api-key";
      return { [header]: key ?? "" };
    }
    case "basic": {
      const username = auth.username ?? "";
      const encoded = Buffer.from(`${username}:${key ?? ""}`).toString("base64");
      return { authorization: `Basic ${encoded}` };
    }
    default:
      return {};
  }
}

function generateProviderJson(state: ProviderAddFlowState, testResults: ConnectionTestResults): ProviderDefinition {
  const def: ProviderDefinition = {
    id: state.id,
    name: state.name,
    version: "1.0",
    engine: state.engine,
    description: `${state.name} API`,
    ...(state.tags.length > 0 ? { tags: state.tags } : {}),
    baseUrl: state.baseUrl.replace(/\/+$/, ""),
    pathPrefix: state.pathPrefix || "/v1",
    auth: {
      method: state.authMethod,
      ...(state.authMethod === "none" ? {} : {
        ...(state.apiKeyEnv ? { apiKeyEnv: state.apiKeyEnv } : {}),
        ...(state.apiKey && !state.apiKeyEnv ? { apiKey: state.apiKey } : {}),
      }),
      ...(state.authMethod === "api-key" ? { keyHeader: "x-api-key" } : {}),
    },
    defaultModel: state.defaultModel,
    endpoint: state.endpoint,
    stream: state.stream,
    timeout: state.timeout,
    features: {},
  };

  if (state.headers && Object.keys(state.headers).length > 0) {
    def.headers = state.headers;
  }

  if (testResults.modelsCount > 0) {
    def.models = testResults.modelsList.map((id) => ({ id }));
  }

  return def;
}

interface ProviderAddFlowState {
  name: string;
  id: string;
  engine: ProviderEngine;
  baseUrl: string;
  pathPrefix: string;
  authMethod: AuthMethod;
  apiKeySource: "env" | "direct" | "file";
  apiKeyEnv: string | undefined;
  apiKey: string | undefined;
  defaultModel: string;
  endpoint: "auto" | "chat-completions" | "responses";
  stream: boolean;
  timeout: number;
  headers: Record<string, string> | undefined;
  tags: string[];
}

export async function providerAddCommand(): Promise<void> {
  console.log(`
╭──────────────────────────────────────────────╮
│  Conex Provider 添加向导                      │
│  30 分钟上手 — 仅需填写基本信息                │
╰──────────────────────────────────────────────╯
`);

  const name = await prompt("Provider 名称 (用于显示, 如 \"Groq Cloud\")");
  const id = await prompt("Provider ID (用于引用)", name.toLowerCase().replace(/[^a-z0-9-]/g, "-"));
  const engine = await promptSelect("引擎类型 (决定请求/响应格式)", ENGINE_CHOICES);
  const baseUrl = await prompt("基础 URL (API 入口)");
  const pathPrefix = engine === "openai-compatible" ? await prompt("API 路径前缀", "/v1") : undefined;
  const authMethod = await promptSelect("认证方式", AUTH_METHOD_CHOICES);

  let apiKeyEnv: string | undefined;
  let apiKey: string | undefined;

  if (authMethod !== "none") {
    const source = await promptSelect("API Key 来源", [
      { value: "env" as const, label: "环境变量 (推荐)" },
      { value: "direct" as const, label: "直接输入 (不推荐)" },
      { value: "file" as const, label: "文件路径" },
    ]);

    if (source === "env") {
      apiKeyEnv = await prompt("环境变量名", `${id.toUpperCase().replace(/-/g, "_")}_API_KEY`);
    } else if (source === "direct") {
      apiKey = await prompt("API Key");
    }
  }

  const defaultModel = await prompt("默认模型 ID");
  const endpoint = engine === "openai-compatible"
    ? await promptSelect("Endpoint 类型", ENDPOINT_CHOICES)
    : undefined;

  const streamInput = await prompt("流式支持? (Y/n)", "Y");
  const stream = streamInput.toLowerCase() !== "n";

  const timeout = Number(await prompt("最大请求超时 (毫秒)", "120000"));
  const headersStr = await prompt("自定义请求头 (JSON, 可选)", "");
  const headers = headersStr ? JSON.parse(headersStr) as Record<string, string> : undefined;
  const tagsStr = await prompt("标签 (逗号分隔, 可选)", "");
  const tags = tagsStr ? tagsStr.split(",").map((t) => t.trim()).filter(Boolean) : [];

  const state: ProviderAddFlowState = {
    name, id, engine,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    pathPrefix: pathPrefix ?? "/v1",
    authMethod, apiKeySource: apiKeyEnv ? "env" : apiKey ? "direct" : "env",
    apiKeyEnv, apiKey, defaultModel,
    endpoint: endpoint ?? "auto",
    stream, timeout, headers, tags,
  };

  console.log("\n╭─ 正在测试连接... ─────────────────────────────────────────────╮");
  const testResults = await testConnection(state as Partial<ProviderDefinition>);
  printTestResults(testResults, baseUrl);
  console.log("╰──────────────────────────────────────────────────────────────╯");

  const accepted = await prompt("以上测试结果是否接受? (Y/n)", "Y");
  if (accepted.toLowerCase() === "n") {
    console.log("已取消。重新运行 npx crish add-provider 重试。");
    return;
  }

  const providerJson = generateProviderJson(state, testResults);
  const filePath = resolve(PROVIDERS_DIR, `${id}.json`);

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(providerJson, null, 2) + "\n", "utf8");

  console.log(`\n✔ Provider 配置已生成: ${filePath}`);
  console.log(`\n  ${JSON.stringify(providerJson, null, 2)}`);

  const register = await prompt("\n是否立即注册到全局配置? (Y/n)", "Y");
  if (register.toLowerCase() !== "n") {
    await registerProviderGlobally(id, filePath);
  }

  console.log(`\n✔ Provider "${id}" 已就绪! 现在可以使用:`);
  console.log(`  npx crish dev --provider ${id}       # 快速测试`);
  console.log(`  npx crish provider test ${id}        # 运行测试套件`);
}

function printTestResults(results: ConnectionTestResults, baseUrl: string): void {
  const ok = "✓";
  const warn = "⚠";
  const fail = "✗";

  console.log(`  ${results.baseUrlReachable ? ok : fail} baseUrl 可达: ${baseUrl} (${results.baseUrlLatencyMs}ms)`);
  console.log(`  ${results.authSuccess ? ok : fail} 认证: ${results.authSuccess ? "成功" : `失败 (${results.authStatusCode})`}`);
  if (results.modelsCount > 0) {
    console.log(`  ${ok} 模型列表: ${results.modelsCount} 个可用模型`);
  } else {
    console.log(`  ${warn} 模型列表: 无返回`);
  }

  for (const warning of results.warnings) {
    console.log(`  ${warn} ${warning}`);
  }
  for (const error of results.errors) {
    console.log(`  ${fail} ${error}`);
  }
}

async function registerProviderGlobally(id: string, filePath: string): Promise<void> {
  const configDir = resolve(process.env.HOME ?? process.env.USERPROFILE ?? "~", ".config", "crish");
  const registryPath = resolve(configDir, "provider-registry.json");

  await mkdir(configDir, { recursive: true });

  let registry: { providers: Record<string, string> } = { providers: {} };
  try {
    const existing = await readFile(registryPath, "utf8");
    registry = JSON.parse(existing) as typeof registry;
  } catch {
    // 文件不存在, 使用默认
  }

  registry.providers[id] = filePath;
  await writeFile(registryPath, JSON.stringify(registry, null, 2) + "\n", "utf8");
}
