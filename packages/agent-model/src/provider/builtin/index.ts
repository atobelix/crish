import { type ProviderRegistryV2 } from '../registry-v2';
import { join } from 'node:path';
import * as fs from 'node:fs';

export function registerBuiltinProviders(registry: ProviderRegistryV2): void {
  const providersDir = join(__dirname, 'providers');

  if (fs.existsSync(providersDir)) {
    const files = fs
      .readdirSync(providersDir)
      .filter((f: string) => f.endsWith('.json'));
    for (const file of files) {
      try {
        registry.registerDeclarativeFromFile(join(providersDir, file));
      } catch (err) {
        console.error(`[Builtin] Failed to register ${file}:`, err);
      }
    }
  }
}

export type { ProviderConfig } from './types';
export { AnthropicProviderClass } from './anthropic-provider-class';
export { GeminiProviderClass } from './gemini-provider-class';
