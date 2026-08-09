/**
 * Bidi 骨架：RTL 文本的方向感知水平移动支持。
 *
 * 轻量实现（不做完整 UAX#9 重排）：仅做"弱类型扫描 + RTL 段标注"，
 * 供方向键水平移动在 RTL 段内反转视觉方向（ArrowLeft 在 RTL 段 = 逻辑右移）。
 * LTR 行快速路径返回 null（零开销）。
 * 参考：CodeMirror 6 bidi.ts 的 charType + span 思路（本实现仅为子集）。
 */

export type BidiCharType = 'L' | 'R' | 'EN' | 'AN' | 'AL' | 'NSM' | 'ON';

export interface BidiSpan {
  from: number;
  to: number;
  level: 1; // 仅支持 level-1（RTL）段
}

export interface LineBidiInfo {
  spans: BidiSpan[];
  rtl: boolean;
}

// 近似 Unicode 区间分类（希伯来文/阿拉伯文强 RTL + 组合标记 + 数字）
const RTL_RANGES: Array<[number, number]> = [
  [0x0590, 0x08ff], // Hebrew + Arabic + Syriac + Thaana + NKo 等
  [0xfb1d, 0xfdff], // Hebrew/Arabic presentation forms
  [0xfe70, 0xfeff], // Arabic presentation forms-B
];
const NSM_RANGES: Array<[number, number]> = [
  [0x0300, 0x036f], // Combining Diacritical Marks
  [0x0591, 0x05bd], // Hebrew points
  [0x05bf, 0x05c7], // Hebrew points cont.
];

function inRanges(code: number, ranges: Array<[number, number]>): boolean {
  for (const [lo, hi] of ranges) {
    if (code >= lo && code <= hi) return true;
  }
  return false;
}

/** 字符双向类型（近似） */
export function charType(ch: string): BidiCharType {
  const code = ch.charCodeAt(0);
  if (code < 0x80) {
    // ASCII：字母/数字 L 或 EN，其余 ON
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) return 'L';
    if (code >= 0x30 && code <= 0x39) return 'EN';
    return 'ON';
  }
  if (inRanges(code, NSM_RANGES)) return 'NSM';
  if (inRanges(code, RTL_RANGES)) {
    // 数字类（阿拉伯-印度数字）归 AN，其余强 R
    if (code >= 0x0660 && code <= 0x0669) return 'AN';
    if (code >= 0x06f0 && code <= 0x06f9) return 'AN';
    return 'R';
  }
  return 'L';
}

/**
 * 行级 bidi 信息：弱类型扫描聚合 RTL 段。
 * 快速路径：无任何 RTL/AN 字符 → 返回 null（LTR 行零开销）。
 */
export function lineBidiInfo(text: string): LineBidiInfo | null {
  const n = text.length;
  let sawRtl = false;
  for (let i = 0; i < n; i++) {
    const t = charType(text[i]);
    if (t === 'R' || t === 'AL' || t === 'AN') {
      sawRtl = true;
      break;
    }
  }
  if (!sawRtl) return null;

  const spans: BidiSpan[] = [];
  let i = 0;
  while (i < n) {
    const t = charType(text[i]);
    if (t === 'R' || t === 'AL' || t === 'AN') {
      // 聚合 RTL 段：连续 RTL 类 + 相邻 NSM
      let j = i + 1;
      while (j < n) {
        const tj = charType(text[j]);
        if (tj === 'R' || tj === 'AL' || tj === 'AN' || tj === 'NSM') j++;
        else break;
      }
      spans.push({ from: i, to: j, level: 1 });
      i = j;
    } else {
      i++;
    }
  }
  return { spans, rtl: spans.length > 0 };
}

/** 行级 RTL 便捷检测（渲染层设 dir="rtl" 用） */
export function isRtlLine(text: string): boolean {
  return lineBidiInfo(text) !== null;
}
