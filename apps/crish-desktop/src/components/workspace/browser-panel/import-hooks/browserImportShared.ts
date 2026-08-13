/**
 * 浏览器导入拆分共享面（D-01 G-03b 拆分产物）。
 *
 * 仅放「跨 hook 共享、与组件无关」的最小面：
 * - `BusyKind`：四 hook + 主体共用的忙碌编排类型；
 * - `readFileAsText`：FileReader DOM 面读取（书签/登录态文件通道共用）；
 * - `resultMessage`：invokeTyped 三态 → 展示消息（缺省前缀空串，
 *   由各 hook 的错误出口拼「区域前缀 + 消息」）。
 */

/** 忙碌编排类型（主体 useState<BusyKind>，各 hook 读写同一 busy）。 */
export type BusyKind =
  | 'bookmarks'
  | 'bookmarksPath'
  | 'history'
  | 'storageExport'
  | 'storageImport'
  | 'list'
  | null;

/** invokeTyped 三态结果的展示面投影（只消费 status/message，泛型数据不关心）。 */
export type ImportInvokeResult =
  | { status: 'ok' }
  | { status: 'missing' }
  | { status: 'error'; message: string };

/** FileReader 文本读取（DOM 面；jsdom 原生支持）。 */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsText(file);
  });
}

/**
 * invokeTyped 三态 → 展示消息：ok = 空串；missing = 引擎未接线；
 * error = prefix + message（调用方再拼区域前缀）。
 */
export function resultMessage(res: ImportInvokeResult, prefix: string): string {
  if (res.status === 'ok') return '';
  if (res.status === 'missing') return `${prefix}引擎未接线（命令不可用）`;
  return `${prefix}${res.message}`;
}
