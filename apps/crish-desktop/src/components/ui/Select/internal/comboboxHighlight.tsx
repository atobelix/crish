import React from 'react';
import styles from '../Combobox.module.css';

/**
 * 纯函数无状态关键词高亮算法：
 * - 拆分使用带捕获括号的 gi 正则
 * - 段判定使用无 g 标志的纯净单一正则，彻底杜绝 lastIndex 变异
 * - 支持 non-string 及 React 元素安全容错
 */
export function highlightMatches(text: unknown, query: string): React.ReactNode {
  if (text == null) return '';
  if (typeof text !== 'string') {
    if (React.isValidElement(text)) return text;
    text = String(text);
  }

  const str = text as string;
  const trimmed = query ? query.trim() : '';
  if (!trimmed || !str) return str;

  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const splitRegex = new RegExp(`(${escaped})`, 'gi');
  const testRegex = new RegExp(`^${escaped}$`, 'i');

  const parts = str.split(splitRegex);
  if (parts.length <= 1) return str;

  return parts.map((part, i) =>
    testRegex.test(part) ? (
      <span key={i} className={styles.highlightText}>
        {part}
      </span>
    ) : (
      part
    )
  );
}
