/**
 * 快捷键平台适配层。
 *
 * 负责将 KeyboardEvent 转为标准化字符串，以及绑定格式的平台自适应显示。
 * 无外部依赖，可独立使用。
 */

/** 当前是否为 macOS 平台 */
export const IS_MAC: boolean =
  typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');

/** Shift 按下时实际字符到无 Shift 字符的映射 */
const SHIFTED_TO_UNSHIFTED: Record<string, string> = {
  '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5',
  '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
  '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\',
  ':': ';', '"': "'", '<': ',', '>': '.', '?': '/',
};

/** 将键盘事件转为平台感知的标准化字符串 */
export function eventToShortcutLabel(e: KeyboardEvent): string {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return '';

  let keyName = e.key;
  // Shift 被按下时显示无 Shift 的字符（避免显示 "?" 而非 "/"）
  if (e.shiftKey && keyName.length === 1) {
    keyName = SHIFTED_TO_UNSHIFTED[keyName] || keyName;
  }

  if (IS_MAC) {
    let label = '';
    if (e.metaKey) label += '\u2318'; // ⌘
    if (e.shiftKey) label += '\u21E7'; // ⇧
    if (e.altKey) label += '\u2325'; // ⌥
    if (e.ctrlKey) label += '\u2303'; // ⌃
    return label + normalizeKey(keyName);
  }

  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  if (e.metaKey) parts.push('Win');
  parts.push(normalizeKey(keyName));
  return parts.join(' + ');
}

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

function normalizeKey(key: string): string {
  if (key === ' ') return 'Space';
  // 方向键
  if (key === 'ArrowUp') return '\u2191';
  if (key === 'ArrowDown') return '\u2193';
  if (key === 'ArrowLeft') return '\u2190';
  if (key === 'ArrowRight') return '\u2192';
  if (key.length === 1) return key.toUpperCase();
  return key;
}
