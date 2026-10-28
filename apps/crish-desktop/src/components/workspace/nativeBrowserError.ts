/**
 * apps/crish-desktop/src/components/workspace/nativeBrowserError.ts
 *
 * 原生浏览器生命周期与导航错误归一化工具。
 *
 * 保证：
 * 1. 静默过滤生命周期切换与卸载过程中的内部 abort / lease release 信号，杜绝向用户误报红框；
 * 2. 将底层原始英文错误码与网络协议错误映射为清晰友好的中文文案，彻底消除中英混合显示；
 * 3. 严格无破坏性，纯函数实现，便于单测全覆盖。
 */

import { t as translateGlobal } from '../../i18n';

/**
 * 判断是否为生命周期内部释放/取消（正常卸载、切换 Tab 或重试时的自然终止）
 */
export function isLifecycleAbortReason(reason?: string | null): boolean {
  if (!reason) return false;
  const lower = reason.toLowerCase();
  return (
    lower.includes('lease released') ||
    lower.includes('no active owner') ||
    lower.includes('navigation cancelled') ||
    lower.includes('abort')
  );
}

/**
 * 将底层原始英文错误映射为用户可理解的中文说明
 */
export function formatFriendlyBrowserError(
  reason: string,
  t?: (
    key: string,
    fallback?: string,
    params?: Record<string, unknown>
  ) => string
): string {
  const translate = t ?? translateGlobal;
  if (!reason) {
    return translate('workspace.browser.errorUnknown');
  }
  const lower = reason.toLowerCase();

  if (
    lower.includes('failed to fetch') ||
    lower.includes('err_name_not_resolved') ||
    lower.includes('err_connection') ||
    lower.includes('network')
  ) {
    return translate('workspace.browser.errorNetwork');
  }

  if (lower.includes('timeout') || lower.includes('timed out')) {
    return translate('workspace.browser.errorTimeout');
  }

  if (
    lower.includes('scheme') ||
    lower.includes('invalid') ||
    lower.includes('disallowed') ||
    lower.includes('unsupported')
  ) {
    return translate('workspace.browser.errorInvalidUrl');
  }

  if (
    lower.includes('tauri command is unavailable') ||
    lower.includes('unavailable')
  ) {
    return translate('workspace.browser.errorEngineUnavailable');
  }

  if (lower.includes('closed') || lower.includes('closing')) {
    return translate('workspace.browser.errorTabClosed');
  }

  // 若传入本身已包含中文且不含内部技术细节，直接返回；否则给出友好通用提示
  if (
    /[\u4e00-\u9fa5]/.test(reason) &&
    !lower.includes('lease') &&
    !lower.includes('tab preview')
  ) {
    return reason;
  }

  return translate('workspace.browser.errorGeneric');
}
