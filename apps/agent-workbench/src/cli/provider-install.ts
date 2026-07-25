import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, isAbsolute, dirname } from "node:path";
import { normalizeDeclarativeDef, type DeclarativeProviderDef } from "@crish/agent-runtime";
import type { ProviderDefinition } from "./provider-types";

const USER_CONFIG_DIR = resolve(
  process.env.XDG_CONFIG_HOME ?? process.env.HOME ?? process.env.USERPROFILE ?? "~",
  ".config",
  "conex"
);
const USER_PROVIDERS_DIR = resolve(USER_CONFIG_DIR, "providers");
const REGISTRY_PATH = resolve(USER_CONFIG_DIR, "provider-registry.json");
const MARKET_API_BASE = "https://providers.conex.dev/api/v1/providers";

function isUrl(str: string): boolean {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

function isMarketId(str: string): boolean {
  return /^[a-z][a-z0-9_-]*$/i.test(str);
}

interface ProviderRegistry {
  providers: Record<string, string>;
}

async function loadRegistry(): Promise<ProviderRegistry> {
  try {
    const raw = await readFile(REGISTRY_PATH, "utf8");
    return JSON.parse(raw) as ProviderRegistry;
  } catch {
    return { providers: {} };
  }
}

async function saveRegistry(registry: ProviderRegistry): Promise<void> {
  await mkdir(dirname(REGISTRY_PATH), { recursive: true });
  await writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n", "utf8");
}

export async function installProvider(
  providerRef: string,
  options?: { source?: string; force?: boolean }
): Promise<void> {
  let rawData: string;
  let sourceLabel: string;

  if (isUrl(providerRef)) {
    const resp = await fetch(providerRef, {
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      throw new Error(`获取失败 (HTTP ${resp.status}): ${providerRef}`);
    }
    rawData = await resp.text();
    sourceLabel = `URL ${providerRef}`;
  } else if (providerRef.endsWith(".json") && (existsSync(providerRef) || isAbsolute(providerRef))) {
    const resolved = isAbsolute(providerRef) ? providerRef : resolve(process.cwd(), providerRef);
    rawData = await readFile(resolved, "utf8");
    sourceLabel = resolved;
  } else if (isMarketId(providerRef)) {
    const url = options?.source ?? `${MARKET_API_BASE}/${encodeURIComponent(providerRef)}`;
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      throw new Error(`市场查询失败 (HTTP ${resp.status}): "${providerRef}"`);
    }
    rawData = await resp.text();
    sourceLabel = `市场 ${providerRef}`;
  } else {
    throw new Error(
      `无法识别的 provider 引用: "${providerRef}"\n` +
      `  用法: conex provider install <provider-id>          # 从市场安装\n` +
      `        conex provider install ./path/to/file.json    # 本地文件安装\n` +
      `        conex provider install https://example.com/p.json  # 远程 URL`
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawData) as Record<string, unknown>;
  } catch {
    throw new Error("无效的 JSON 格式");
  }

  let providerId: string;
  let providerName: string;
  let fileName: string;

  if (typeof parsed.providerId === "string" && parsed.providerId.length > 0) {
    const def = parsed as unknown as DeclarativeProviderDef;
    if (!def.engine) throw new Error("缺少必填字段: engine");
    if (!def.baseUrl) throw new Error("缺少必填字段: baseUrl");
    normalizeDeclarativeDef(def);
    providerId = def.providerId;
    providerName = def.name;
    fileName = `${def.providerId}.json`;
  } else if (typeof parsed.id === "string" && parsed.id.length > 0) {
    const def = parsed as unknown as ProviderDefinition;
    if (!def.engine) throw new Error("缺少必填字段: engine");
    if (!def.baseUrl) throw new Error("缺少必填字段: baseUrl");
    providerId = def.id;
    providerName = def.name || def.id;
    fileName = `${def.id}.json`;
  } else {
    throw new Error("缺少 provider 标识符: JSON 中需要 'providerId' (declarative 格式) 或 'id' (CLI 格式) 字段");
  }

  await mkdir(USER_PROVIDERS_DIR, { recursive: true });

  const targetPath = resolve(USER_PROVIDERS_DIR, fileName);

  if (existsSync(targetPath) && !options?.force) {
    throw new Error(
      `Provider "${fileName}" 已存在於 ${USER_PROVIDERS_DIR}\n` +
      `  使用 --force 覆盖安装`
    );
  }

  await writeFile(targetPath, rawData, "utf8");

  const registry = await loadRegistry();
  registry.providers[providerId] = targetPath;
  await saveRegistry(registry);

  console.log(`\n✔ Provider "${providerName}" 已安装`);
  console.log(`  文件: ${targetPath}`);
  console.log(`  来源: ${sourceLabel}`);
  console.log(`\n  使用: conex dev --provider ${providerId}`);
  console.log(`        conex provider test ${providerId}`);
}
