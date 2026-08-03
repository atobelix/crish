// packages/plugin-sdk/src/fs/plugin-fs.ts
// 约束来源：ROUND-08-plugin-sdk.md plugin-api.ts 依赖注入原则（"依赖全注入"）
// I8-E2 loader fs 注入面（03 生态插件方案 §3.2 理由 4 + §3.4 决策）：
// plugin-sdk 的 node:fs 使用点（SkillLoader / PluginDiscoverer）经本接口
// 注入，宿主（webview 环境无 node:fs）提供 Tauri fs command 适配实现；
// Node 环境默认使用 [NodeFsAdapter]。

/**
 * 目录条目（readdir 产物；与 node:fs Dirent 最小面同构）。
 */
export interface PluginFsEntry {
  readonly name: string;
  readonly isDirectory: () => boolean;
  readonly isFile: () => boolean;
}

/** 文件状态（stat 产物；最小面：size + isFile） */
export interface PluginFsStat {
  readonly size: number;
  isFile(): boolean;
}

/**
 * PluginFs 注入接口（依赖全注入原则：插件加载器不直接 import node:fs）。
 *
 * 实现方：
 * - Node 环境：NodeFsAdapter（node:fs/promises 薄封装）；
 * - webview 宿主：Tauri fs command 适配实现（第一版官方插件内置打包，
 *   第三方动态加载 Phase 2——宿主经 PluginAPIDeps 注入）。
 */
export interface PluginFs {
  readFile(path: string, encoding: 'utf-8'): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  readdir(path: string, withFileTypes: boolean): Promise<PluginFsEntry[]>;
  stat(path: string): Promise<PluginFsStat>;
  access(path: string): Promise<void>;
}

/** Node 环境默认适配（node:fs/promises 薄封装；测试与 Node 宿主使用） */
export class NodeFsAdapter implements PluginFs {
  readFile(path: string, encoding: 'utf-8'): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  async readFile(
    path: string,
    encoding?: 'utf-8',
  ): Promise<string | Uint8Array> {
    if (encoding === 'utf-8') {
      return readTextFile(path);
    }
    return readBufferFile(path);
  }

  async readdir(path: string, withFileTypes: boolean): Promise<PluginFsEntry[]> {
    const entries = await readDirEntries(path);
    if (!withFileTypes) {
      return entries.map((e) => ({
        name: e.name,
        isDirectory: () => false,
        isFile: () => true,
      }));
    }
    return entries;
  }

  async stat(path: string): Promise<PluginFsStat> {
    return statFile(path);
  }

  async access(path: string): Promise<void> {
    await accessPath(path);
  }
}

// ─── node:fs 延迟加载（仅在 Node 环境调用时引入，webview 宿主不触达）───

async function readTextFile(path: string): Promise<string> {
  const fs = await loadNodeFs();
  return fs.readFile(path, 'utf-8');
}

async function readBufferFile(path: string): Promise<Uint8Array> {
  const fs = await loadNodeFs();
  return new Uint8Array(await fs.readFile(path));
}

async function readDirEntries(path: string): Promise<PluginFsEntry[]> {
  const fs = await loadNodeFs();
  const entries = await fs.readdir(path, { withFileTypes: true });
  return entries.map((entry) => ({
    name: entry.name,
    isDirectory: () => entry.isDirectory(),
    isFile: () => entry.isFile(),
  }));
}

async function statFile(path: string): Promise<PluginFsStat> {
  const fs = await loadNodeFs();
  const stats = await fs.stat(path);
  return {
    size: stats.size,
    isFile: () => stats.isFile(),
  };
}

async function accessPath(path: string): Promise<void> {
  const fs = await loadNodeFs();
  await fs.access(path);
}

/** node:fs/promises 动态加载（webview 无 node 模块时抛清晰错误） */
async function loadNodeFs(): Promise<typeof import('node:fs/promises')> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return await import('node:fs/promises');
  } catch (err) {
    throw new Error(
      `PluginFs 未注入且环境无 node:fs（webview 宿主须经 PluginAPIDeps/` +
        `PluginDiscoverer 注入 Tauri fs 适配）：${(err as Error).message}`,
    );
  }
}
