/**
 * 浏览器数据导入 invoke 桥（G-4 收尾 U6：书签/历史/登录态导入 UI 契约面）。
 *
 * 契约（Rust 侧 browser_commands.rs 模块头注释，定死）：
 *   invoke('browser_import_bookmarks', { json })   -> BookmarksImportPayload（camelCase）
 *   invoke('browser_import_history', { path })     -> HistoryImportPayload（camelCase）
 *   invoke('browser_list_bookmarks')               -> ImportedBookmarkRow[]（行字段 snake_case，
 *                                                     conex-db ImportedBookmarkRow 原样序列化）
 *   invoke('browser_list_history', { since?, limit? }) -> ImportedHistoryRow[]
 *   invoke('browser_export_storage_state', { authorized }) -> string（storage_state JSON，
 *                                                     内存传递不落盘；authorized=false 直接拒绝，
 *                                                     不执行实读）
 *   invoke('browser_import_storage_state', { json }) -> StorageImportPayload（脱敏统计，
 *                                                     不含 cookie value）
 *
 * 错误面：结构化错误码前缀 `tool.browser.not_ready:<原因>` / `tool.invalid_input:<原因>`
 * （经 invokeTyped 三态解析：missing / error{kind,message}）。storage 命令**不触发惰性启动**
 * ——辅助通道须先经 `browser_start` 显式启动，前端按 not_ready 提示。
 *
 * 书签/历史四命令与 storage 两命令均已登记（commandManifest.ts browser 段），
 * 此处不重复经 transport 清单校验，直接走 invokeTyped（missing 语义兜底未接线场景，
 * 对齐 browserSessionApi 约定）。
 */

import { invokeTyped } from './tauriInvoke';
import type { InvokeTypedResult } from './tauriInvoke';

export const BROWSER_IMPORT_BOOKMARKS_CMD = 'browser_import_bookmarks';
export const BROWSER_IMPORT_HISTORY_CMD = 'browser_import_history';
export const BROWSER_LIST_BOOKMARKS_CMD = 'browser_list_bookmarks';
export const BROWSER_LIST_HISTORY_CMD = 'browser_list_history';
export const BROWSER_EXPORT_STORAGE_STATE_CMD = 'browser_export_storage_state';
export const BROWSER_IMPORT_STORAGE_STATE_CMD = 'browser_import_storage_state';

/** 书签导入统计载荷（Rust BookmarksImportPayload，serde camelCase）。 */
export interface BookmarksImportPayload {
  /** 新增落库条数（INSERT OR IGNORE 影响行数）。 */
  inserted: number;
  /** 同 (url, name) 去重跳过条数（重复导入）。 */
  skippedDupes: number;
  /** 解析层扁平化条数（落库前）。 */
  parsedItems: number;
  /** 无效节点跳过数（缺 name/url、type 异常）。 */
  skippedInvalid: number;
  /** 深度超限跳过的子树数（> 48）。 */
  depthCutoff: number;
  /** 解析层 (url, name) 去重丢弃数。 */
  droppedDupes: number;
  /** 数量上限截断数（达 10 000 上限后未纳入节点数）。 */
  truncated: number;
}

/** 历史导入统计载荷（Rust HistoryImportPayload，serde camelCase）。 */
export interface HistoryImportPayload {
  /** 新增落库条数（INSERT OR IGNORE 影响行数）。 */
  inserted: number;
  /** 同 (url, visited_at) 去重跳过条数（重复导入）。 */
  skippedDupes: number;
  /** 来源库查询读取行数（含被 URL 过滤丢弃前的行）。 */
  readTotal: number;
  /** 无效 URL 丢弃数（非 http/https 或不可解析）。 */
  skippedInvalidUrl: number;
}

/** imported_bookmarks 行（conex-db ImportedBookmarkRow 原样序列化，snake_case 字段）。 */
export interface ImportedBookmarkRow {
  url: string;
  name: string;
  /** 顶层根（书签栏/其他书签/…）到父文件夹的路径链。 */
  folder_path: string[];
  /** 来源 guid（首版恒 null，列预留）。 */
  guid: string | null;
  source: string;
  /** 导入时刻（unix 秒）。 */
  imported_at: number;
}

/** imported_history 行（conex-db ImportedHistoryRow 原样序列化，snake_case 字段）。 */
export interface ImportedHistoryRow {
  url: string;
  /** 访问时刻（unix 秒）。 */
  visited_at: number;
  title: string | null;
  source: string;
  /** 导入时刻（unix 秒）。 */
  imported_at: number;
}

/** 登录态导入统计载荷（Rust StorageImportPayload，J1b 脱敏——不含任何 cookie value）。 */
export interface StorageImportPayload {
  /** 注入计划最终 cookie 数（同键去重 + 空名过滤后）。 */
  cookies: number;
  /** 含 localStorage 的 origin 数。 */
  origins: number;
  /** localStorage 条目总数（注入计划面）。 */
  localStorageItems: number;
  /** 已注册 origin 守卫恢复脚本数。 */
  injectedScripts: number;
  /** 已直写 localStorage 条目数。 */
  injectedItems: number;
  /** 同键去重丢弃数（最后一次出现者胜）。 */
  droppedDupes: number;
  /** 空 name 非法 cookie 跳过数。 */
  skippedEmptyName: number;
}

/**
 * 导入书签（G-4 U6）：Chrome Bookmarks JSON 内容 → 解析 + 落库。
 * @param json Chrome Bookmarks 文件内容（`{"roots": {...}}`）。
 */
export function importBookmarks(
  json: string
): Promise<InvokeTypedResult<BookmarksImportPayload>> {
  return invokeTyped<BookmarksImportPayload>(BROWSER_IMPORT_BOOKMARKS_CMD, {
    json,
  });
}

/**
 * 导入历史（G-4 U6）：Chrome History SQLite 库路径 → 只读读取 + 落库。
 * @param path Chrome History 库路径（来源浏览器须已关闭，锁检测由上层向导承担）。
 */
export function importHistory(
  path: string
): Promise<InvokeTypedResult<HistoryImportPayload>> {
  return invokeTyped<HistoryImportPayload>(BROWSER_IMPORT_HISTORY_CMD, {
    path,
  });
}

/** 书签列表（G-4 U6 查询面）：imported_bookmarks 全量行（导入时间倒序）。 */
export function listBookmarks(): Promise<
  InvokeTypedResult<ImportedBookmarkRow[]>
> {
  return invokeTyped<ImportedBookmarkRow[]>(BROWSER_LIST_BOOKMARKS_CMD);
}

/**
 * 历史列表（G-4 U6 查询面）：visited_at 倒序 + since（严格大于）过滤 + limit 截断。
 * @param since unix 秒起始（可选）
 * @param limit 截断条数（可选；缺省 = 全量）
 */
export function listHistory(
  since?: number,
  limit?: number
): Promise<InvokeTypedResult<ImportedHistoryRow[]>> {
  return invokeTyped<ImportedHistoryRow[]>(BROWSER_LIST_HISTORY_CMD, {
    ...(since !== undefined ? { since } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
}

/**
 * 导出登录态（J1b U6）：标准 storage_state JSON（Playwright 兼容 `{ cookies, origins }`）。
 * 入参 `authorized`：**导出需显式授权**——前端须先展示授权对话框（§5.2），确认后才传
 * `true`；`false` 命令直接拒绝（不执行实读，零副作用）。返回 JSON **内存传递不落盘**，
 * 写盘仅走前端显式「另存为」路径（§5.4 强制面）。
 */
export function exportStorageState(
  authorized: boolean
): Promise<InvokeTypedResult<string>> {
  return invokeTyped<string>(BROWSER_EXPORT_STORAGE_STATE_CMD, { authorized });
}

/**
 * 导入登录态（J1b U6）：标准 storage_state JSON → cookie/localStorage 注入。
 * 返回脱敏统计（不含任何 cookie value，§5.4）。
 * @param json 标准 storage_state JSON（≤10MB、cookie ≤5000）
 */
export function importStorageState(
  json: string
): Promise<InvokeTypedResult<StorageImportPayload>> {
  return invokeTyped<StorageImportPayload>(BROWSER_IMPORT_STORAGE_STATE_CMD, {
    json,
  });
}

/**
 * 按路径读取文本文件（书签「路径输入」面；Tauri 环境经 plugin-fs，非 Tauri 降级）。
 * 返回 null 表示读取不可用/失败（调用方提示改用文件选择或拖入）。
 *
 * 实现注记（R2-4 P3-1 模式）：plugin-fs 非前端依赖（Tauri 壳运行时注入），
 * 必须用非字面量 specifier 动态 import——字面量 + @vite-ignore 在 jsdom 环境
 * worker 的 transform 期仍会尝试解析（vitest 3.2.7 行为），非字面量则完全跳过
 * 静态解析：构建产物保留原生 import（壳提供模块），vitest 侧由 test-setup 的
 * vi.mock 拦截（mockPluginFsReadTextFile 可控）。
 */
const PLUGIN_FS_MODULE_ID = '@tauri-apps/plugin-fs';

export async function readTextFileAtPath(path: string): Promise<string | null> {
  try {
    const mod = (await import(PLUGIN_FS_MODULE_ID)) as unknown as {
      readTextFile?: (p: string) => Promise<string>;
    };
    if (typeof mod?.readTextFile !== 'function') return null;
    const text = await mod.readTextFile(path);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}
