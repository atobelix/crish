/**
 * Bridge 工具函数
 * Tauri bridge 与后端交互的公共类型守卫和辅助函数
 */

import type { BackendDiagnosticResult } from './tauri-command-registry';

/**
 * 检查 Tauri bridge 返回值是否为后端诊断错误。
 * 同时处理普通对象和带 diagnostic 的数组结果。
 *
 * 统一了 App.tsx、Sidebar.tsx、SessionBrowserPanel.tsx、app-state.ts
 * 中各自定义的重复版本。
 */
export function isBridgeDiagnostic(value: unknown): value is BackendDiagnosticResult {
  // 处理 BackendDiagnosticArrayResult<T>（数组 + diagnostic 交集）
  if (Array.isArray(value)) {
    return (
      (value as { ok?: unknown }).ok === false &&
      !!(value as { diagnostic?: unknown }).diagnostic
    );
  }
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { ok?: unknown }).ok === false &&
    !!(value as { diagnostic?: unknown }).diagnostic
  );
}

/**
 * 从后端诊断结果中提取可展示的错误消息。
 */
export function bridgeErrorMessage(value: unknown, fallback = '后端通信异常'): string {
  if (isBridgeDiagnostic(value)) {
    return value.diagnostic.message || fallback;
  }
  return fallback;
}