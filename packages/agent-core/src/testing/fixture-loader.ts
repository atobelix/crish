import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_BASE = resolve(
  __dirname,
  "../../../../tests/fixtures/provider-responses"
);

const cache = new Map<string, unknown>();

export function loadFixture<T = unknown>(name: string): T {
  const cached = cache.get(name);
  if (cached !== undefined) return cached as T;

  const filePath = resolve(FIXTURES_BASE, name.endsWith(".json") ? name : `${name}.json`);
  const content = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(content) as T;
  cache.set(name, parsed);
  return parsed;
}

export function clearFixtureCache(): void {
  cache.clear();
}
