/**
 * 行内格式化：code 占位保护、粗体/斜体、CJK wbr。
 *
 * 从 markdownPlugins.ts 拆出（T4-11 SR-06-R3）：仅处理标签外文本的
 * 行内格式，不处理 HTML 标签；由 applyInline 按标签外文本切分调用。
 */

import { wrapCjkTextSegment } from './markdownSanitizer';

/** 列表缩进视觉宽度：Tab → 对齐到 4 列，避免 \t 嵌套错位 */
export function visualIndent(ws: string): number {
  let n = 0;
  for (let i = 0; i < ws.length; i++) {
    if (ws[i] === '\t') n += 4 - (n % 4);
    else n += 1;
  }
  return n;
}

/** GFM Emoji 字典单一真相源（与 Rust lookup_gfm_emoji 100% 保持镜像同步） */
export const GFM_EMOJI_MAP: Readonly<Record<string, string>> = Object.freeze({
  // 状态与检查（工程高频）
  white_check_mark: '✅',
  heavy_check_mark: '✔️',
  check: '✓',
  x: '❌',
  negative_squared_cross_mark: '❎',
  ballot_box_with_check: '☑️',
  warning: '⚠️',
  rotating_light: '🚨',
  stop_sign: '🛑',
  exclamation: '❗',
  question: '❓',
  bulb: '💡',
  bug: '🐛',
  wrench: '🔧',
  gear: '⚙️',
  package: '📦',
  rocket: '🚀',
  tada: '🎉',
  sparkles: '✨',
  fire: '🔥',
  zap: '⚡',
  memo: '📝',
  pencil: '📝',
  pencil2: '✏️',
  bookmark: '🔖',
  link: '🔗',
  lock: '🔒',
  unlock: '🔓',
  info: 'ℹ️',

  // 反馈与评审
  '+1': '👍',
  thumbsup: '👍',
  '-1': '👎',
  thumbsdown: '👎',
  heart: '❤️',
  star: '⭐',
  star2: '🌟',
  '100': '💯',
  eyes: '👀',
  speech_balloon: '💬',

  // 状态圆圈指示器
  white_circle: '⚪',
  black_circle: '⚫',
  red_circle: '🔴',
  blue_circle: '🔵',
  large_blue_circle: '🔵',
  green_circle: '🟢',
  yellow_circle: '🟡',

  // 箭头与方向
  arrow_right: '➡️',
  arrow_left: '⬅️',
  arrow_up: '⬆️',
  arrow_down: '⬇️',
  soon: '🔜',
  top: '🔝',

  // 设备与环境
  computer: '💻',
  hourglass: '⌛',
  hourglass_flowing_sand: '⏳',
  apple: '🍎',
  penguin: '🐧',
});

const GFM_EMOJI_RE = /:([a-z0-9_+-]{1,32}):/g;

/**
 * AGENTS §21 / SCOUT §7.3：GFM emoji 短码翻译默认关闭（与 Rust `GFM_EMOJI_SHORTCODES_DEFAULT` 对齐）。
 * 若产品日后坚持短码，Rust IPC 与 JS fallback 须共读同一默认；禁止仅一端开启。
 */
export const GFM_EMOJI_SHORTCODES_DEFAULT = false as const;

/** 将文本中的 GFM Emoji 短代码转义为 Unicode 字符（默认关闭） */
export function translateGfmEmoji(
  text: string,
  enabled: boolean = GFM_EMOJI_SHORTCODES_DEFAULT,
): string {
  if (!enabled || !text || !text.includes(':')) return text;
  return text.replace(GFM_EMOJI_RE, (match, key: string) => GFM_EMOJI_MAP[key] ?? match);
}

/**
 * 纯文本段行内格式：code 占位保护后再 GFM Emoji、bold/italic，最后 CJK wbr。
 * 不处理 HTML 标签；由 applyInline 按标签外文本切分调用。
 */
function formatMarkdownTextSegment(text: string): string {
  if (!text) return '';
  const codes: string[] = [];
  // 1. 保护行内代码（确保 `code` 内的文本不被误转义）
  let s = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
    const i = codes.length;
    codes.push(`<code class="md-inline-code">${code}</code>`);
    return `%%CODE${i}%%`;
  });

  // 2. GFM Emoji 短代码转义（行内代码已保护为 %%CODE%%）
  s = translateGfmEmoji(s);

  // 3. 粗体先于斜体；斜体仅同行、非空，避免未闭合 * 吞掉整段
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // 斜体：开口 * 后不能是空白（否则与「* 列表项」冲突，会吞掉列表标记并留下残片）
  s = s.replace(
    /(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g,
    (full, inner: string) => {
      const t = inner.trim();
      // 过长或像整句未闭合时不套 em（防止 * 与远处 * 配对）
      if (!t || t.length > 80) return full;
      if (/\s{2,}/.test(inner)) return full;
      return `<em>${inner}</em>`;
    }
  );

  // 4. 还原行内代码
  s = s.replace(/%%CODE(\d+)%%/g, (_, i) => codes[Number(i)] || '');

  // 5. CJK 智能断字
  return wrapCjkTextSegment(s);
}

/**
 * 行内格式：仅处理标签外文本，避免
 * - 破坏已还原的 <a href> / <img src> 属性（* 被当成斜体）
 * - 把 code 内的 * 再套 <em>
 */
export function applyInline(html: string): string {
  if (!html) return '';
  // 无标签时仍走 CJK 快路径（format 内也会 wbr）
  return html.replace(
    /(^|>)([^<]*)/g,
    (_full, prefix: string, text: string) => {
      return prefix + formatMarkdownTextSegment(text);
    }
  );
}
