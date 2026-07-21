import { readdir, readFile, access } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  entry: string;
  hooks?: string[];
  permissions?: string[];
}

export interface PluginAPI {
  onSessionStart?(sessionId: string): void | Promise<void>;
  onSessionEnd?(sessionId: string): void | Promise<void>;
  onToolCall?(toolCall: any): void | Promise<void>;
  onMessage?(message: any): void | Promise<void>;
}

export class PluginRegistry {
  private plugins = new Map<string, { manifest: PluginManifest; api: PluginAPI }>();

  async discover(dirs?: string[]): Promise<void> {
    const searchDirs = dirs ?? [
      join(homedir(), '.crish', 'plugins'),
      join(process.cwd(), '.crish', 'plugins'),
    ];

    for (const dir of searchDirs) {
      try {
        await access(dir);
        const entries = await readdir(dir);
        for (const entry of entries) {
          const pluginDir = join(dir, entry);
          try {
            await access(join(pluginDir, 'plugin.json'));
            await this.load(pluginDir);
          } catch { /* skip non-plugin dirs */ }
        }
      } catch { /* dir doesn't exist */ }
    }
  }

  async load(pluginDir: string): Promise<void> {
    const manifestPath = join(pluginDir, 'plugin.json');
    const manifest: PluginManifest = JSON.parse(
      await readFile(manifestPath, 'utf-8')
    );

    const entryPath = isAbsolute(manifest.entry)
      ? manifest.entry
      : join(pluginDir, manifest.entry);

    const mod = await import(entryPath);
    const api: PluginAPI = {
      onSessionStart: mod.onSessionStart,
      onSessionEnd: mod.onSessionEnd,
      onToolCall: mod.onToolCall,
      onMessage: mod.onMessage,
    };

    this.plugins.set(manifest.name, { manifest, api });
    console.info(`[PluginRegistry] loaded: ${manifest.name}@${manifest.version}`);
  }

  get(name: string): PluginAPI | undefined {
    return this.plugins.get(name)?.api;
  }

  list(): PluginManifest[] {
    return [...this.plugins.values()].map(p => p.manifest);
  }

  unload(name: string): void {
    this.plugins.delete(name);
    console.info(`[PluginRegistry] unloaded: ${name}`);
  }
}

export const pluginRegistry = new PluginRegistry();
