/**
 * InFlowStatusLine 文案纯函数（与组件分文件，保持 react-refresh 组件文件纯净）。
 */
import type { RuntimeRetryInfo } from '../../store/sessionRuntimeStatusStore';

/** 有上限显示 n/m，无上限显示「第 n 次」——不臆造引擎未下发的分母。 */
export function formatRetryStatusText(retry: RuntimeRetryInfo): string {
  const attempt = Math.max(1, Math.floor(retry.attempt));
  return retry.maxAttempts
    ? `正在重试 ${attempt}/${retry.maxAttempts}`
    : `正在重试 · 第 ${attempt} 次`;
}
