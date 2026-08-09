/** 用量格式化工具（SettingsUsageTab 族共享） */

export function formatTokenCount(n: number): string {
  const v = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  return v.toLocaleString('zh-CN');
}

export function formatUsd(n: number, digits = 4): string {
  const v = Number.isFinite(n) ? n : 0;
  return `$${v.toFixed(digits)}`;
}
