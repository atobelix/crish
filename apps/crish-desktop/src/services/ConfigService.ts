import { InvariantViolation } from './InvariantViolation';

const CONFIG_PREFIX = 'crish_config_v2';
type StorageBackend = 'localStorage' | 'sessionStorage' | 'memory';

interface ConfigSchemaEntry<T> {
  schema: ConfigValueParser<T>;
  default: T;
  storage: StorageBackend;
}

interface ConfigValueParser<T> {
  parse(value: unknown): T;
}

class ConfigService {
  private schemas = new Map<string, ConfigSchemaEntry<unknown>>();
  private listeners = new Map<string, Set<(value: unknown) => void>>();
  private memoryStore = new Map<string, unknown>();

  async init(): Promise<void> {
    // no-op for now
  }

  define<T>(
    key: string,
    schema: ConfigValueParser<T>,
    defaultValue: T,
    storage: StorageBackend = 'localStorage'
  ): void {
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
    return () =>
      this.listeners.get(key)?.delete(cb as (value: unknown) => void);
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
    } catch {
      return null;
    }
  }

  private writeToStorage(
    key: string,
    value: unknown,
    storage: StorageBackend
  ): void {
    if (storage === 'memory') {
      this.memoryStore.set(key, value);
      return;
    }
    try {
      window[storage].setItem(`${CONFIG_PREFIX}:${key}`, JSON.stringify(value));
    } catch {
      /* quota exceeded */
    }
  }

  private notify(key: string, value: unknown): void {
    this.listeners.get(key)?.forEach((cb) => {
      try {
        cb(value);
      } catch {
        /* */
      }
    });
  }
}

export const configService = new ConfigService();

function parseShortcutOverrides(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Shortcut overrides must be a string record');
  }

  const entries = Object.entries(value);
  if (entries.some(([, entry]) => typeof entry !== 'string')) {
    throw new TypeError('Shortcut override values must be strings');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

interface WorkspaceLayoutConfig {
  sidebarWidth?: number;
  [key: string]: unknown;
}

function parseWorkspaceLayout(value: unknown): WorkspaceLayoutConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Workspace layout must be an object');
  }

  const layout = value as Record<string, unknown>;
  const sidebarWidth = Object.hasOwn(layout, 'sidebarWidth')
    ? layout.sidebarWidth
    : undefined;
  if (
    sidebarWidth !== undefined &&
    (typeof sidebarWidth !== 'number' || Number.isNaN(sidebarWidth))
  ) {
    throw new TypeError('Workspace sidebarWidth must be a number');
  }

  return { ...layout } as WorkspaceLayoutConfig;
}

// 内置配置键注册（随模块加载即生效，消费方无需关心初始化顺序）。
// 根因：d00fbaaf1 删除了 registerConfigSchemas()，但 SettingsShortcutsTab /
// ShortcutService / useSidebarResize 仍在 get/set 这两个键，未注册键一律抛
// InvariantViolation → 快捷键改键永远「保存失败」、自定义键位与侧栏宽度从不恢复。
configService.define(
  'shortcuts.overrides',
  { parse: parseShortcutOverrides },
  {},
  'localStorage'
);
// 侧栏宽度合法区间由 useSidebarResize（SIDEBAR_WIDTH_MIN/MAX）校验，这里只约束形状。
configService.define(
  'workspace.layout',
  { parse: parseWorkspaceLayout },
  {},
  'localStorage'
);
