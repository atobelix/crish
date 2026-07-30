import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type DeclarativeProviderEntry,
  type ProviderRegistryV2,
} from './registry-v2';
import {
  DeclarativeProviderDef,
  normalizeDeclarativeDef,
} from './declarative-schema';

export class DeclarativeLoader {
  ready = false;
  private watcher: fs.FSWatcher | undefined;

  constructor(
    private registry: ProviderRegistryV2,
    private directory: string
  ) {}

  start(): void {
    if (fs.existsSync(this.directory)) {
      const files = fs
        .readdirSync(this.directory)
        .filter((f) => f.endsWith('.json'));
      for (const file of files) {
        this.loadFile(path.join(this.directory, file));
      }
    }
    this.ready = true;

    try {
      this.watcher = fs.watch(this.directory, (eventType, filename) => {
        if (!filename || !filename.endsWith('.json')) return;
        const filePath = path.join(this.directory, filename);
        if (eventType === 'rename' && !fs.existsSync(filePath)) {
          const providerId = filename.replace(/\.json$/, '');
          this.registry.unregisterDeclarative(providerId);
          return;
        }
        const providerId = filename.replace(/\.json$/, '');
        this.registry.unregisterDeclarative(providerId);
        this.loadFile(filePath);
      });
    } catch {
      // fs.watch 在某些环境下不可用，静默回退
    }
  }

  stop(): void {
    if (this.watcher !== undefined) {
      this.watcher.close();
      this.watcher = undefined;
    }
  }

  private loadFile(filePath: string): void {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const raw = JSON.parse(content) as DeclarativeProviderDef;
      const normalized = normalizeDeclarativeDef(raw);

      this.registry.registerDeclarative(
        {
          providerId: normalized.providerId,
          engine: normalized.engine,
          metadata: {
            name: raw.name,
            ...(raw.description !== undefined
              ? { description: raw.description }
              : {}),
            models: normalized.models.map((m) => m.id),
            capabilities: [],
            defaultBaseUrl: normalized.baseUrl,
            ...(raw.website !== undefined ? { website: raw.website } : {}),
            ...(raw.docsUrl !== undefined ? { docsUrl: raw.docsUrl } : {}),
            apiKeyEnv: normalized.auth.defaultEnvVar,
            endpointType: raw.endpointType ?? 'auto',
            streamingSupport: raw.streamingSupport ?? 'streaming',
          } satisfies DeclarativeProviderEntry['metadata'],
          declarative: normalized,
        },
        filePath
      );
    } catch (err) {
      console.error(`[DeclarativeLoader] Failed to load ${filePath}:`, err);
    }
  }
}
