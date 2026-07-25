import { readFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import type { ProviderDefinition } from "./provider-types";

const PROVIDERS_DIR = resolve(import.meta.dirname ?? process.cwd(), "../../../providers");
const BUILT_IN_PROVIDERS = [
  "openai", "anthropic", "gemini", "groq", "deepseek",
  "openrouter", "mistral", "together", "fireworks", "perplexity",
  "xai", "azure-openai", "github-models", "ollama",
];

export function getBuiltInProviderIds(): string[] {
  return BUILT_IN_PROVIDERS;
}

export async function loadProviderConfig(providerRef: string): Promise<ProviderDefinition> {
  // 如果是文件路径
  if (providerRef.endsWith(".json") && (existsSync(providerRef) || isAbsolute(providerRef))) {
    const raw = await readFile(providerRef, "utf8");
    return JSON.parse(raw) as ProviderDefinition;
  }

  // 尝试内置 providers/
  const builtInPath = resolve(PROVIDERS_DIR, `${providerRef}.json`);
  if (existsSync(builtInPath)) {
    const raw = await readFile(builtInPath, "utf8");
    return JSON.parse(raw) as ProviderDefinition;
  }

  // 尝试社区 providers/
  const communityPath = resolve(PROVIDERS_DIR, "community", `${providerRef}.json`);
  if (existsSync(communityPath)) {
    const raw = await readFile(communityPath, "utf8");
    return JSON.parse(raw) as ProviderDefinition;
  }

  // 尝试全局注册
  const configDir = resolve(process.env.HOME ?? process.env.USERPROFILE ?? "~", ".config", "crish");
  const registryPath = resolve(configDir, "provider-registry.json");
  try {
    const regRaw = await readFile(registryPath, "utf8");
    const registry = JSON.parse(regRaw) as { providers: Record<string, string> };
    const regPath = registry.providers[providerRef];
    if (regPath && existsSync(regPath)) {
      const raw = await readFile(regPath, "utf8");
      return JSON.parse(raw) as ProviderDefinition;
    }
  } catch {
    // registry 不存在
  }

  throw new Error(`Provider "${providerRef}" 未找到。尝试:\n` +
    `  1. npx crish add-provider 创建新的\n` +
    `  2. 直接指定 JSON 文件路径`);
}

export function buildAuthHeader(auth: ProviderDefinition["auth"]): Record<string, string> {
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
      const username = auth.username ?? process.env[auth.usernameEnv ?? ""] ?? "";
      const encoded = Buffer.from(`${username}:${key ?? ""}`).toString("base64");
      return { authorization: `Basic ${encoded}` };
    }
    default:
      return {};
  }
}

export { PROVIDERS_DIR, BUILT_IN_PROVIDERS };
