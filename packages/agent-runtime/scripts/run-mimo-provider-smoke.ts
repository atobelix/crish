import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTextMessage,
  loadOpenAICompatibleProviderConfig,
  OpenAICompatibleProvider,
  type ProviderDiagnostic,
  type ProviderUsage
} from "../src/index";

if (hasArg("--help") || hasArg("-h")) {
  printHelp();
  process.exit(0);
}

const providerConfigPath = readStringArg("--config") ?? process.env.FLOWBIT_PROVIDER_CONFIG ?? ".tmp/agent-runtime-flowbit-provider-mimo-v25-stream.json";
const outputRoot =
  readStringArg("--output") ?? process.env.MIMO_PROVIDER_SMOKE_OUTPUT ?? join(".tmp", `mimo-provider-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const prompt =
  readStringArg("--prompt") ??
  process.env.MIMO_PROVIDER_SMOKE_PROMPT ??
  "\u8bf7\u7528\u4e00\u53e5\u4e2d\u6587\u56de\u590d\uff1a\u6d41\u5f0f\u8fde\u63a5\u6b63\u5e38\u3002";

mkdirSync(outputRoot, { recursive: true });

const providerConfig = await loadOpenAICompatibleProviderConfig(providerConfigPath);
const provider = new OpenAICompatibleProvider({
  ...providerConfig,
  maxTokens: readPositiveIntegerEnv("MIMO_PROVIDER_SMOKE_MAX_TOKENS", providerConfig.maxTokens ?? 256),
  stream: readBooleanEnv("MIMO_PROVIDER_SMOKE_STREAM", providerConfig.stream ?? true),
  diagnostics: true,
  requestTimeoutMs: readPositiveIntegerEnv("MIMO_PROVIDER_SMOKE_TIMEOUT_MS", providerConfig.requestTimeoutMs ?? 120_000),
  firstByteTimeoutMs: readPositiveIntegerEnv("MIMO_PROVIDER_SMOKE_FIRST_BYTE_MS", providerConfig.firstByteTimeoutMs ?? 60_000),
  streamIdleTimeoutMs: readPositiveIntegerEnv("MIMO_PROVIDER_SMOKE_IDLE_MS", providerConfig.streamIdleTimeoutMs ?? 60_000),
  retry: providerConfig.retry ?? {
    maxAttempts: 2,
    initialDelayMs: 800,
    maxDelayMs: 5_000,
    totalBudgetMs: 120_000,
    jitterRatio: 0.2
  }
});

const startedAt = Date.now();
let text = "";
let stopReason = "";
let stopError: string | undefined;
let usage: ProviderUsage | undefined;
const diagnostics: ProviderDiagnostic[] = [];
const firstEventMs: Record<string, number> = {};
const eventCounts: Record<string, number> = {};

try {
  for await (const event of provider.stream({
    sessionId: `provider-smoke-${Date.now()}`,
    cwd: process.cwd(),
    systemPrompt:
      "\u4f60\u662f MiMo \u8fde\u63a5\u63a2\u9488\u3002\u53ea\u7528\u4e2d\u6587\u7b80\u77ed\u56de\u590d\uff0c\u4e0d\u8981\u8c03\u7528\u5de5\u5177\u3002",
    messages: [createTextMessage("user", prompt)],
    tools: [],
    signal: new AbortController().signal
  })) {
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
    firstEventMs[event.type] ??= Date.now() - startedAt;

    if (event.type === "provider-diagnostic") {
      diagnostics.push(event.diagnostic);
      continue;
    }
    if (event.type === "text-delta") {
      text += event.text;
      continue;
    }
    if (event.type === "thought-delta") {
      continue;
    }
    if (event.type === "stop") {
      stopReason = event.reason;
      stopError = event.error;
      usage = event.usage;
    }
  }
} catch (cause) {
  stopReason = "throw";
  stopError = cause instanceof Error ? cause.message : String(cause);
}

const responseStartDiagnostic = diagnostics.find((diagnostic) => diagnostic.phase === "response-start");
const firstByteDiagnostic = diagnostics.find((diagnostic) => diagnostic.phase === "sse-first-byte");
const streamEndDiagnostic = diagnostics.find((diagnostic) => diagnostic.phase === "stream-end");
const responseStartMs = responseStartDiagnostic?.elapsedMs;
const firstSseByteReaderMs = firstByteDiagnostic?.elapsedMs;
const streamReaderEndMs = streamEndDiagnostic?.elapsedMs;

const report = {
  ok: Boolean(text.trim()) && (!stopReason || stopReason === "stop"),
  provider: {
    id: providerConfig.id,
    baseUrl: providerConfig.baseUrl,
    model: providerConfig.model,
    endpoint: providerConfig.endpoint ?? "chat-completions",
    authHeader: providerConfig.authHeader ?? "authorization",
    stream: providerConfig.stream ?? true,
    hasApiKey: Boolean(providerConfig.apiKey)
  },
  timings: {
    totalMs: Date.now() - startedAt,
    firstTextDeltaMs: firstEventMs["text-delta"],
    firstProviderDiagnosticMs: firstEventMs["provider-diagnostic"],
    responseStartMs,
    firstSseByteReaderMs,
    firstSseByteFromRequestMs:
      responseStartMs !== undefined && firstSseByteReaderMs !== undefined ? responseStartMs + firstSseByteReaderMs : undefined,
    streamReaderEndMs,
    streamEndFromRequestMs: responseStartMs !== undefined && streamReaderEndMs !== undefined ? responseStartMs + streamReaderEndMs : undefined
  },
  stop: {
    reason: stopReason || "none",
    error: stopError
  },
  eventCounts,
  usage,
  textPreview: text.trim().slice(0, 500),
  diagnostics
};

const reportPath = join(outputRoot, "provider-smoke-report.json");
writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
console.log(
  JSON.stringify(
    {
      reportPath,
      ok: report.ok,
      provider: report.provider,
      timings: report.timings,
      stop: report.stop,
      eventCounts: report.eventCounts,
      usage: report.usage,
      textPreview: report.textPreview
    },
    null,
    2
  )
);

if (!report.ok) {
  process.exitCode = 1;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return fallback;
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function readStringArg(name: string): string | undefined {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) {
    const value = inline.slice(name.length + 1).trim();
    return value || undefined;
  }
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1]?.trim();
  return value && !value.startsWith("--") ? value : undefined;
}

function printHelp(): void {
  console.log(
    [
      "Usage: npm run smoke:mimo-provider -- [options]",
      "",
      "Options:",
      "  --config <path>   Provider config JSON path. Defaults to FLOWBIT_PROVIDER_CONFIG or .tmp/agent-runtime-flowbit-provider-mimo-v25-stream.json.",
      "  --output <path>   Output directory for provider-smoke-report.json.",
      "  --prompt <text>   Prompt for the short streaming smoke request.",
      "  --help, -h        Print this help without calling the provider.",
      "",
      "Provider config may use provider.apiKey, provider.apiKeyEnv, or provider.apiKeyFile. Do not commit real API keys."
    ].join("\n")
  );
}
