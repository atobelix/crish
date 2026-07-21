export interface Plugin {
  name: string;
  version: string;
  description?: string;
  hooks?: {
    onSessionStart?(id: string): void | Promise<void>;
    onSessionEnd?(id: string): void | Promise<void>;
    onToolCall?(call: any): void | Promise<void>;
    onMessage?(msg: any): void | Promise<void>;
  };
  permissions?: string[];
}

export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}
