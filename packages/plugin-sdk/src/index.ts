export interface Plugin {
  name: string;
  version: string;
  description?: string;
  hooks?: {
    onSessionStart?(id: string): void | Promise<void>;
    onSessionEnd?(id: string): void | Promise<void>;
    onToolCall?(call: unknown): void | Promise<void>;
    onMessage?(msg: unknown): void | Promise<void>;
  };
  permissions?: string[];
}

export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}
