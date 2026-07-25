import * as readline from "node:readline";
import { ProviderRegistryV2Impl } from "../registry-v2";
import { registerBuiltinProviders } from "../builtin";
import { resolveAuthHeaders } from "./provider-utils";

export interface DevCliArgs {
  provider?: string;
  model?: string;
  prompt?: string;
  stream: boolean;
}

export function parseDevArgs(argv: string[]): DevCliArgs {
  const result: Record<string, string | boolean> = { stream: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
      result[key] = argv[i + 1]!;
      i++;
    } else {
      result[key] = true;
    }
  }

  return {
    ...(result.provider !== undefined ? { provider: result.provider as string } : {}),
    ...(result.model !== undefined ? { model: result.model as string } : {}),
    ...(result.prompt !== undefined ? { prompt: result.prompt as string } : {}),
    stream: result.stream === true,
  } as DevCliArgs;
}

function getApiKey(envVar: string): string | null {
  return process.env[envVar] ?? null;
}

async function parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onChunk: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) continue;
      if (trimmed === "data: [DONE]") return;

      if (trimmed.startsWith("data: ")) {
        const json = trimmed.slice(6);
        try {
          const parsed = JSON.parse(json) as Record<string, unknown>;
          const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
          if (!choices) continue;
          const delta = choices[0]?.delta as Record<string, string> | undefined;
          if (delta?.content) onChunk(delta.content);
        } catch {
          continue;
        }
      }
    }
  }
}

async function sendPrompt(
  url: string,
  headers: Record<string, string>,
  model: string,
  text: string,
  stream: boolean,
): Promise<void> {
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: text }],
    stream,
    max_tokens: 4096,
  });

  const response = await fetch(url, { method: "POST", headers, body });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`HTTP ${response.status}: ${errText}`);
    return;
  }

  if (stream) {
    const reader = response.body!.getReader();
    await parseSSEStream(reader, chunk => process.stdout.write(chunk));
    process.stdout.write("\n");
  } else {
    const data = (await response.json()) as Record<string, unknown>;
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    const content = choices?.[0]?.message as Record<string, string> | undefined;
    console.log(content?.content ?? JSON.stringify(data, null, 2));
  }
}

export async function runDev(args: DevCliArgs): Promise<void> {
  const providerId = args.provider ?? process.env.CONEX_DEV_PROVIDER ?? "deepseek";

  const registry = new ProviderRegistryV2Impl();
  registerBuiltinProviders(registry);

  const entry = registry.getDeclarativeEntry(providerId);
  if (!entry) {
    console.error(`Provider "${providerId}" not found`);
    const available = registry.listDeclarativeEntries().map(e => e.providerId).join(", ");
    console.error(`Available: ${available}`);
    process.exit(1);
  }

  const decl = entry.declarative;
  const model = args.model ?? decl.models[0]?.id;
  if (!model) {
    console.error("No model specified and provider has no models");
    process.exit(1);
  }

  const apiKey = getApiKey(decl.auth.defaultEnvVar);
  if (!apiKey) {
    console.error(`API key not found. Set ${decl.auth.defaultEnvVar} environment variable`);
    process.exit(1);
  }

  const headers = resolveAuthHeaders(
    { type: decl.auth.type, placement: decl.auth.placement, keyHeader: decl.auth.keyHeader },
    apiKey,
  );

  const url = `${decl.baseUrl}${decl.paths.chatCompletions}`;

  if (args.prompt) {
    await sendPrompt(url, headers, model, args.prompt, args.stream);
    return;
  }

  console.log(`\n${entry.metadata.name} REPL  (${model})`);
  console.log("Type prompts or :quit to exit\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.on("line", async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed === ":quit" || trimmed === ":q") {
      rl.close();
      return;
    }
    await sendPrompt(url, headers, model, trimmed, args.stream);
    rl.prompt();
  });

  rl.prompt();
}

async function main(): Promise<void> {
  const args = parseDevArgs(process.argv.slice(2));
  await runDev(args);
}

if (require.main === module) {
  main().catch(err => {
    console.error("Fatal:", (err as Error).message);
    process.exit(1);
  });
}
