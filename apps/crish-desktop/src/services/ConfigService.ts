import { z } from 'zod';
import { InvariantViolation } from './InvariantViolation';

const CONFIG_PREFIX = 'crish_config_v2';
type StorageBackend = 'localStorage' | 'sessionStorage' | 'memory';

interface ConfigSchemaEntry<T> {
  schema: z.ZodType<T>;
  default: T;
  storage: StorageBackend;
}

export class ConfigService {
  private schemas = new Map<string, ConfigSchemaEntry<unknown>>();
  private listeners = new Map<string, Set<(value: unknown) => void>>();
  private memoryStore = new Map<string, unknown>();

  async init(): Promise<void> {
    // no-op for now
  }

  define<T>(key: string, schema: z.ZodType<T>, defaultValue: T, storage: StorageBackend = 'localStorage'): void {
    this.schemas.set(key, { schema, default: defaultValue, storage });
  }

  get<T>(key: string): T {
    const entry = this.schemas.get(key);
    if (!entry) throw new InvariantViolation(`Config key "${key}" not defined`);

    const raw = this.readFromStorage(key, entry.storage);
    if (raw === null || raw === undefined) return entry.default as T;

    try {
      return entry.schema.parse(raw) as T;
    } catch {
      return entry.default as T;
    }
  }

  set<T>(key: string, value: T): void {
    const entry = this.schemas.get(key);
    if (!entry) throw new InvariantViolation(`Config key "${key}" not defined`);

    const validated = entry.schema.parse(value);
    this.writeToStorage(key, validated, entry.storage);
    this.notify(key, validated);
  }

  watch<T>(key: string, cb: (value: T) => void): () => void {
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key)!.add(cb as (value: unknown) => void);
    return () => this.listeners.get(key)?.delete(cb as (value: unknown) => void);
  }

  reset(key?: string): void {
    if (key) {
      const entry = this.schemas.get(key);
      if (entry) {
        this.writeToStorage(key, entry.default, entry.storage);
        this.notify(key, entry.default);
      }
    }
  }

  private readFromStorage(key: string, storage: StorageBackend): unknown {
    if (storage === 'memory') return this.memoryStore.get(key);
    try {
      const raw = window[storage].getItem(`${CONFIG_PREFIX}:${key}`);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  private writeToStorage(key: string, value: unknown, storage: StorageBackend): void {
    if (storage === 'memory') { this.memoryStore.set(key, value); return; }
    try {
      window[storage].setItem(`${CONFIG_PREFIX}:${key}`, JSON.stringify(value));
    } catch { /* quota exceeded */ }
  }

  private notify(key: string, value: unknown): void {
    this.listeners.get(key)?.forEach(cb => { try { cb(value); } catch { /* */ } });
  }
}

export const configService = new ConfigService();
