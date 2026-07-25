import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { ProviderDefinition } from "./provider-types";

const PROVIDERS_DIR = resolve(import.meta.dirname ?? process.cwd(), "../../../providers");

interface ProviderListItem {
  id: string;
  name: string;
  engine: string;
  defaultModel: string;
  tags: string[];
  source: "built-in" | "community" | "user";
}

export async function listProvidersCommand(filter?: string): Promise<void> {
  const providers: ProviderListItem[] = [];

  // 内置 providers
  try {
    const files = await readdir(PROVIDERS_DIR);
    for (const file of files) {
      if (!file.endsWith(".json") || file === "COMMUNITY.md") continue;
      const def = await loadProviderFile(resolve(PROVIDERS_DIR, file));
      if (def) providers.push({ ...def, source: "built-in" });
    }
  } catch {
    // 目录不存在
  }

  // 社区 providers
  const communityDir = resolve(PROVIDERS_DIR, "community");
  if (existsSync(communityDir)) {
    try {
      const files = await readdir(communityDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const def = await loadProviderFile(resolve(communityDir, file));
        if (def) providers.push({ ...def, source: "community" });
      }
    } catch {
      // ignore
    }
  }

  // 用户注册 providers
  const configDir = resolve(process.env.HOME ?? process.env.USERPROFILE ?? "~", ".config", "crish");
  const registryPath = resolve(configDir, "provider-registry.json");
  if (existsSync(registryPath)) {
    try {
      const raw = await readFile(registryPath, "utf8");
      const registry = JSON.parse(raw) as { providers: Record<string, string> };
      for (const [id, filePath] of Object.entries(registry.providers)) {
        if (!providers.some((p) => p.id === id)) {
          const def = await loadProviderFile(filePath);
          if (def) providers.push({ ...def, source: "user" });
        }
      }
    } catch {
      // ignore
    }
  }

  // 过滤
  const filtered = filter
    ? providers.filter((p) => p.id.includes(filter) || p.name.includes(filter) || p.tags.some((t) => t.includes(filter)))
    : providers;

  if (filtered.length === 0) {
    console.log(`\n没有匹配的 Provider${filter ? ` (过滤条件: "${filter}")` : ""}。`);
    console.log("运行 npx crish add-provider 创建新的 Provider。");
    return;
  }

  console.log(`\n可用 Provider (${filtered.length}):\n`);

  const bySource = (source: ProviderListItem["source"]) => filtered.filter((p) => p.source === source);

  for (const group of [
    { label: "内置", items: bySource("built-in") },
    { label: "社区", items: bySource("community") },
    { label: "用户", items: bySource("user") },
  ]) {
    if (group.items.length === 0) continue;
    console.log(`  ${group.label}:`);
    for (const p of group.items) {
      const tags = p.tags.length > 0 ? ` [${p.tags.join(", ")}]` : "";
      console.log(`    ${p.id.padEnd(20)} ${p.engine.padEnd(20)} ${p.defaultModel}${tags}`);
    }
    console.log();
  }

  console.log("运行 crish provider test <id> 测试, crish provider validate <file> 验证。");
}

async function loadProviderFile(filePath: string): Promise<Omit<ProviderListItem, "source"> | undefined> {
  try {
    const raw = await readFile(filePath, "utf8");
    const def = JSON.parse(raw) as ProviderDefinition;
    if (!def.id || !def.name) return undefined;
    return {
      id: def.id,
      name: def.name,
      engine: def.engine,
      defaultModel: def.defaultModel,
      tags: def.tags ?? [],
    };
  } catch {
    return undefined;
  }
}
