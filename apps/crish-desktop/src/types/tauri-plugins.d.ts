/**
 * Tauri 插件动态 import 类型声明（R2-4 P3-1 修复配套）：
 * skillsApi / importFsHost 从 Function('return import(...)') 改为
 * import(@vite-ignore) 后，TS 需模块声明才能通过类型检查。
 * 运行时插件本体由 Tauri 壳提供（webview 内存在），此处仅声明形状
 * 避免 TS2307；真实类型以 @tauri-apps/plugin-* 安装包为准。
 */
declare module '@tauri-apps/plugin-fs' {
  const value: unknown;
  export default value;
  export const readFile: unknown;
  export const writeFile: unknown;
  export const exists: unknown;
  export const readDir: unknown;
  export const mkdir: unknown;
  export const remove: unknown;
  export const rename: unknown;
  export const stat: unknown;
}

declare module '@tauri-apps/plugin-opener' {
  export const openPath: (p: string) => Promise<unknown>;
  export const revealItemInDir: (p: string) => Promise<unknown>;
}

declare module '@tauri-apps/plugin-shell' {
  export const open: (url: string) => Promise<unknown>;
}

declare module '@tauri-apps/api/path' {
  export const homeDir: () => Promise<string>;
  export const appDataDir: () => Promise<string>;
  export const join: (...parts: string[]) => Promise<string>;
}
