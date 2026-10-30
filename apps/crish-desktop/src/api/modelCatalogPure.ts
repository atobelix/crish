/**
 * 模型探测面纯辅助：id 规范化与上下文长度展示。
 * 无 LS 读写、无网络副作用，可独立单测。
 */

/**
 * Unicode 安全 trim（中文/全角空格）：NFC 后去首尾空白（含 \u3000）。
 * 用于 model id / profileId 规范化；不发明 id。
 */
export function normalizeModelIdText(raw: unknown): string {
  if (raw == null) return '';
  if (
    typeof raw !== 'string' &&
    typeof raw !== 'number' &&
    typeof raw !== 'boolean'
  ) {
    return '';
  }
  let s = String(raw);
  try {
    s = s.normalize('NFC');
  } catch {
    /* ignore environments without normalize */
  }
  return s.replace(/^[\s\u3000]+|[\s\u3000]+$/g, '');
}

/**
 * 上下文长度展示（纯）：空/非法 → 中文破折号「—」。
 * 百万级用 M，千级用 k（与设置页 / Picker 一致）。
 */
export function formatContextLabel(n?: number | null): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}
