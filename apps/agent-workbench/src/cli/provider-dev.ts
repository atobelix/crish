import { createInterface } from "node:readline";
import { OpenAICompatibleProvider } from "@crish/agent-runtime";
import type { AgentProvider, AgentProviderRequest, ProviderStreamEvent } from "@crish/agent-runtime";
import { loadProviderConfig } from "./provider-utils";
import type { ProviderDefinition } from "./provider-types";

async function createProviderFromConfig(config: ProviderDefinition, modelOverride?: string): Promise<AgentProvider> {
  const model = modelOverride ?? config.defaultModel;
  const baseUrl = `${config.baseUrl}${config.pathPrefix ?? "/v1"}`;

  let apiKey: string;
  let apiKeyEnv: string | undefined;

  if (config.auth.apiKey) {
    apiKey = config.auth.apiKey;
  } else if (config.auth.apiKeyEnv) {
    apiKeyEnv = config.auth.apiKeyEnv;
    apiKey = process.env[config.auth.apiKeyEnv] ?? "";
  } else {
    apiKey = "";
  }

  const providerBase = (endpoint: NonNullable<ProviderDefinition['endpoint']>) => ({
    ...(config.id !== undefined ? { id: config.id } : {}),
    baseUrl,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
    model,
    endpoint,
    stream: config.stream !== false,
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(config.topP !== undefined ? { topP: config.topP } : {}),
    ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
    requestTimeoutMs: config.timeout ?? 120_000,
    ...(config.headers !== undefined ? { headers: config.headers } : {}),
    fetch: globalThis.fetch,
  });

  switch (config.engine) {
    case "openai-compatible":
      return new OpenAICompatibleProvider(providerBase(config.endpoint ?? "auto"));

    default:
      // 对 anthropic/gemini 引擎也 fallback 到 openai-compatible（多数兼容）
      console.warn(`注意: engine="${config.engine}" 的 native 实现开发中, 使用 openai-compatible fallback`);
      return new OpenAICompatibleProvider(providerBase(config.endpoint ?? "chat-completions"));
  }
}

function formatStreamEvent(event: ProviderStreamEvent): string | null {
  switch (event.type) {
    case "text-delta":
      return event.text;
    case "thought-delta":
      return `[思考: ${event.text}]`;
    case "tool-call":
      return `\n[工具调用: ${event.toolName}(${JSON.stringify(event.input)})]`;
    case "provider-diagnostic":
      return `[诊断: ${event.diagnostic?.phase ?? ""}${event.diagnostic?.reason ? ` - ${event.diagnostic.reason}` : ""}]`;
    case "stop":
      if (event.reason === "error") return `\n[错误: ${event.error}]`;
      if (event.reason === "length") return "\n[达到长度限制]";
      return null;
    default:
      return null;
  }
}

async function runSingleQuery(provider: AgentProvider, prompt: string): Promise<void> {
  const request: AgentProviderRequest = {
    sessionId: "dev-session",
    cwd: process.cwd(),
    messages: [{ role: "user", id: "dev-user-msg", createdAt: new Date().toISOString(), blocks: [{ type: "text" as const, text: prompt }] }],
    tools: [],
    signal: AbortSignal.timeout(120000),
  };

  process.stdout.write("\n");

  for await (const event of provider.stream(request)) {
    const text = formatStreamEvent(event);
    if (text) process.stdout.write(text);
  }

  process.stdout.write("\n");
}

async function runRepl(provider: AgentProvider): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  console.log("\nConex 开发者模式 — 输入 prompt 测试, Ctrl+C 退出\n");

  rl.prompt();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      continue;
    }

    try {
      await runSingleQuery(provider, trimmed);
    } catch (error) {
      console.error(`\n[错误] ${error instanceof Error ? error.message : String(error)}`);
    }

    rl.prompt();
  }
}

export async function devModeCommand(
  providerRef: string,
  modelOverride?: string,
  singlePrompt?: string,
  cwd = process.cwd(),
): Promise<void> {
  console.log(`\n╭─ Conex 开发者模式 ─────────────────────────────────────╮`);

  try {
    const config = await loadProviderConfig(providerRef);
    console.log(`│  Provider: ${config.name} (${config.id})`);
    console.log(`│  引擎: ${config.engine}`);
    console.log(`│  baseUrl: ${config.baseUrl}${config.pathPrefix ?? "/v1"}`);
    console.log(`│  模型: ${modelOverride ?? config.defaultModel}`);
    console.log(`╰──────────────────────────────────────────────────────────╯`);

    const provider = await createProviderFromConfig(config, modelOverride);

    if (singlePrompt) {
      await runSingleQuery(provider, singlePrompt);
    } else {
      await runRepl(provider);
    }
  } catch (error) {
    console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
