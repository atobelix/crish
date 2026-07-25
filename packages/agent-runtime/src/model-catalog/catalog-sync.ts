import { ModelCatalog } from "./types";
import * as path from "node:path";
import * as os from "node:os";

// LiteLLM JSON 同步管理器
export interface CatalogSyncConfig {
  sourceUrl: string;      // LiteLLM JSON URL
  cachePath: string;      // 本地缓存路径
  cacheTTL: number;       // 缓存 TTL（ms）
  syncInterval: number;   // 同步间隔（ms）
}

const DEFAULT_SYNC_CONFIG: CatalogSyncConfig = {
  sourceUrl:
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  cachePath: path.join(os.homedir(), ".crish", "model-catalog.json"),
  cacheTTL: 2 * 60 * 60 * 1000, // 2h
  syncInterval: 6 * 60 * 60 * 1000, // 6h
};

export class CatalogSyncManager {
  private config: CatalogSyncConfig;
  private catalog: ModelCatalog;
  private timer?: ReturnType<typeof setInterval>;
  private lastSyncAt = 0;

  constructor(catalog: ModelCatalog, config?: Partial<CatalogSyncConfig>) {
    this.catalog = catalog;
    this.config = { ...DEFAULT_SYNC_CONFIG, ...config };
  }

  async initialize(): Promise<void> {
    await this.loadFromCache();
    if (Date.now() - this.lastSyncAt > this.config.cacheTTL) {
      await this.syncFromRemote().catch(() => {});
    }
    this.timer = setInterval(() => this.syncFromRemote(), this.config.syncInterval);
    this.timer.unref?.();
  }

  async syncFromRemote(): Promise<void> {
    try {
      const response = await fetch(this.config.sourceUrl);
      const json = await response.json();
      this.catalog.loadFromLiteLLM(json);
      this.lastSyncAt = Date.now();
      await this.saveToCache(json);
      console.log(`[Catalog] Synced ${this.catalog.size} models from ${this.config.sourceUrl}`);
    } catch (err) {
      console.warn("[Catalog] Sync failed, using cached data:", (err as Error).message);
    }
  }

  private async loadFromCache(): Promise<void> {
    try {
      const fs = await import("node:fs");
      if (fs.existsSync(this.config.cachePath)) {
        const data = JSON.parse(fs.readFileSync(this.config.cachePath, "utf-8"));
        this.catalog.loadFromLiteLLM(data);
        this.lastSyncAt = Date.now();
      }
    } catch { /* no cache, continue */ }
  }

  private async saveToCache(data: unknown): Promise<void> {
    try {
      const fs = await import("node:fs");
      const dir = require("path").dirname(this.config.cachePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.config.cachePath, JSON.stringify(data), "utf-8");
    } catch { /* cache write failure is non-fatal */ }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
