/**
 * 转义动态参数中的 Markdown 结构标记与控制符，防止破坏外部格式隔离。
 * 纯函数、零依赖、零正则回溯风险（仅按行扫描）。
 */

/** 相邻三个及以上连续分隔符的独立行 → 包入代码段，阻断 Markdown 横向分隔线注入 */
const HARD_RULE_LINE_RE = /^\s*([-_=*]{3,})\s*$/;

/**
 * 单行动态值 Markdown 结构净化。
 * @returns 传入空值返回 ''；否则归一化换行、对整段命中硬分隔线规则的行加代码段包裹、trim 首尾空白
 */
export function escapePromptValue(val: string): string {
  if (!val) return '';
  const cleaned = val.replace(/\r\n/g, '\n');
  const escaped = cleaned
    .split('\n')
    .map((line) => {
      const m = HARD_RULE_LINE_RE.exec(line);
      return m ? `\`${m[1]}\`` : line;
    })
    .join('\n');
  return escaped.trim();
}
