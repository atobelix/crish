/**
 * 防 raw JSON 终极清洗锁与标签安全截断（拦截 {, }, [, ] 逃逸）。
 */

/**
 * 最终摘要安全清洗器（绝对禁止裸 JSON 字符逃逸到 UI）
 */
export function sanitizeHumanLabel(
  label: string,
  fallbackToolName = '工具'
): string {
  if (!label || !label.trim()) return `调用 ${fallbackToolName || '工具'}`;
  let clean = label.trim();

  // 1. 强力拦截裸 JSON 对象/数组/字段穿透
  if (
    /^(\{|\[|"(action|taskId|task_id|path|command|CommandLine|Query|TargetFile)":)/i.test(
      clean
    ) ||
    clean === '{}' ||
    clean === '[]'
  ) {
    return `调用 ${fallbackToolName || '工具'}`;
  }

  // 2. 替换不友好的点号路径与空占位（处理无 ASCII 词边界的中文场景）
  clean = clean
    .replace(/处理 \.\/?(?=$|\s)/g, '处理当前目录')
    .replace(/浏览 \{\}/g, '浏览当前目录')
    .replace(/浏览 \.\/?(?=$|\s)/g, '浏览当前目录')
    .replace(/列出目录 \.\/?(?=$|\s)/g, '列出当前目录')
    .replace(/列出目录 \{\}/g, '列出当前目录')
    .replace(/\s+\.\/?$/g, ' 当前目录');

  // 3. 剥离残留的 JSON 符号
  clean = clean
    .replace(/[{}[\]"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return clean.length <= 80 ? clean : `${clean.slice(0, 79)}…`;
}

/** 摘要行展示截断 */
export function clipToolLabel(text: string, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}
