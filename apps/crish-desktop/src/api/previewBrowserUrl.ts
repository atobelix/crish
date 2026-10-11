/** 预览浏览器地址的共享清洗与空白页判断。 */
export function sanitizeBrowseInput(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(
      // eslint-disable-next-line no-control-regex -- 有意剥离控制符与不可见字符
      /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\uFEFF]/g,
      '',
    )
    .trim();
}

/** 是否为空白预览页（大小写不敏感，已 sanitize） */
export function isAboutBlank(url: string): boolean {
  return sanitizeBrowseInput(url).toLowerCase() === 'about:blank';
}
