/**
 * 快捷键平台适配层。
 *
 * 负责将 KeyboardEvent 转为标准化字符串，以及绑定格式的平台自适应显示。
 * 无外部依赖，可独立使用。
 */

/** 当前是否为 macOS 平台 */
export const IS_MAC: boolean =
  typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');

/** 将存储的绑定字符串转为当前平台显示格式 */
export function formatForDisplay(binding: string): string {
  if (!IS_MAC) return binding;

  // 序列键（如 "Escape Escape"）原样返回
  if (!binding.includes(' + ') && binding.includes(' ')) {
    return binding;
  }

  return binding
    .split(' + ')
    .map(p => {
      const t = p.trim();
      if (t === 'Ctrl' || t === 'Meta') return '\u2318';
      if (t === 'Shift') return '\u21E7';
      if (t === 'Alt') return '\u2325';
      return t;
    })
    .join('');
}
