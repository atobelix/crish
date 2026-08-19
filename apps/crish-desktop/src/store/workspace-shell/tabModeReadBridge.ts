/**
 * tabMode 读桥：adapterShape 投影读 layoutStore.tabModeEnabled，
 * 不直引 layoutStore（避免 store 环把 isPrimaryPanel 注入打乱）。
 * 未注册时默认 true（合并标签，与 layout 初始值一致）。
 */
let reader: () => boolean = () => true;

export function registerTabModeReader(fn: () => boolean): void {
  reader = fn;
}

export function readTabModeEnabled(): boolean {
  return Boolean(reader());
}
