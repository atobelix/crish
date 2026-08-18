/**
 * 会话标题不可见字符工具（从 sessionTitle.ts 拆出，纯结构性重构）。
 *
 * 基于 Unicode 属性的系统性不可见字符剥离方案，而非字符范围黑名单。
 *
 * 设计动机：旧实现用枚举字符范围（\u200B-\u200F 等），遗漏了大量 Unicode Cf 类字符：
 *   - Unicode 6.3 Bidi Isolate（U+2066–U+2069）— 可让标题视觉反转
 *   - Language Tag 块（U+E0000–U+E007F）— 隐藏元数据注入（Cf 类，\p{Cf} 已覆盖）
 *   - Mongolian Vowel Separator（U+180E）— Cf 类但不在旧范围
 *   - Deprecated Bidi controls（U+206A–U+206F）
 * 此外还遗漏了非 Cf 但视觉不可见的字符：
 *   - Variation Selectors（U+FE00–U+FE0F）— category Mn，非 Cf，必须显式追加
 *     用途：构造「看似空但非空」标题绕过空壳检测；附加到 emoji 后改变字形呈现。
 *   - Combining Grapheme Joiner（U+034F，category Mn）
 *   - Hangul Filler（U+3164 / U+115F，category Lo）
 *
 * 方案：用 \p{Cf} 覆盖所有 Unicode 格式字符 + 显式追加非 Cf 但不可见的字符。
 * 保留 ZWJ（U+200D）以不破坏 emoji 序列（如 👨‍👩‍👧‍👦）— 但首尾 ZWJ 仍需剥离（见 sanitize）。
 *
 * ALL_INVISIBLE_CHARS：剥离所有 Cf（含 ZWJ），用于「可见性判定 / 默认标题识别」
 *   — 这些场景不需要保留 emoji 序列内部 ZWJ，全剥更准确。
 * TITLE_INVISIBLE_CHARS：剥离 Cf 但保留 ZWJ，用于 sanitize（标题原料清洗）
 *   — 用户输入的 emoji 序列应原样保留；首尾 ZWJ 由 sanitize 额外清理。
 */

/**
 * 剥离所有 Cf（含 ZWJ），用于「可见性判定 / 默认标题识别」。
 */
export const ALL_INVISIBLE_CHARS =
  // eslint-disable-next-line no-control-regex, no-misleading-character-class -- 有意剥离不可见/控制字符（含组合类）
  /[\p{Cf}\u034F\u3164\u115F\uFE00-\uFE0F\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

/**
 * 剥离 Cf 但保留 ZWJ，用于 sanitize（标题原料清洗）。
 */
export const TITLE_INVISIBLE_CHARS =
  // eslint-disable-next-line no-control-regex, no-misleading-character-class -- 有意剥离不可见/控制字符（保留 ZWJ）
  /(?![\u200D])[\p{Cf}\u034F\u3164\u115F\uFE00-\uFE0F\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

/**
 * 首尾 ZWJ（U+200D）剥离。
 * ZWJ 在 emoji 序列内部（如 👨‍👩‍👧‍👦）须保留，但出现在首尾时无意义且构成
 * 「看似空但非空」标题。sanitize 在剥完其他不可见字符后额外清理首尾 ZWJ。
 */
export const BOUNDARY_ZWJ = /^\u200D+|\u200D+$/g;

/**
 * 孤立代理对（lone surrogate）清洗。
 * 高代理（\uD800-\uDBFF）后无低代理，或低代理（\uDC00-\uDFFF）前无高代理。
 * 落库 PostgreSQL/SQLite 会拒绝含 lone surrogate 的字符串，必须在 sanitize 阶段清洗。
 */
export const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * 可见字符判定：Unicode 类别 L（字母）/ N（数字）/ P（标点）/ S（符号，含 emoji）。
 * 用于「文本是否有可见正文」判定 — 取代旧的「strip 后非空」逻辑。
 * 旧逻辑漏判纯组合标记（\u0301 等 Mn 类），它们 trim 后非空但视觉不可见。
 */
const VISIBLE_CHAR = /[\p{L}\p{N}\p{P}\p{S}]/u;

/** 文本是否有可见正文（剥离不可见字符后是否含 L/N/P/S 类字符） */
export function hasVisibleContent(text: string | null | undefined): boolean {
  if (!text) return false;
  const stripped = text
    .replace(ALL_INVISIBLE_CHARS, '')
    .replace(LONE_SURROGATE, '');
  return VISIBLE_CHAR.test(stripped);
}
