/**
 * 零依赖 CJK 拼音首字母 + 全拼 + 别名模糊匹配引擎与安全净化中枢
 */

import { CJK_FONT_PINYIN_MAP } from './fontPinyinMap';

export interface FontSelectOption {
  value: string;
  label: string;
  group?: string | undefined;
  previewFamily?: string | undefined;
  hint?: string | undefined;
}

export interface IndexedFontOption extends FontSelectOption {
  labelLower: string;
  valueLower: string;
  acronym: string;
  fullPinyin: string;
  aliasesLower: string[];
}

/** 常见中文字体中英文双向别名索引表 */
export const FONT_ALIASES: Record<string, string[]> = {
  'microsoft yahei': ['微软雅黑', 'yahei', 'wryh'],
  'microsoft yahei ui': ['微软雅黑 ui', 'yahei ui', 'wryhui'],
  'pingfang sc': ['苹方', '苹方-简', 'pingfang', 'pf'],
  'hiragino sans gb': ['冬青黑体', 'dongqing', 'dqht'],
  'noto sans sc': ['思源黑体', 'siyuan', 'syht'],
  'source han sans sc': ['思源黑体', 'siyuanheiti', 'syht'],
  'source han sans': ['思源黑体', 'siyuan', 'syht'],
  'harmonyos sans sc': ['鸿蒙黑体', 'hongmeng', 'hmht'],
  'harmonyos sans': ['鸿蒙黑体', 'hongmeng', 'hmht'],
  'simsun': ['宋体', 'songti', 'st'],
  'simhei': ['黑体', 'heiti', 'ht'],
  'kaiti': ['楷体', 'kaiti', 'kt'],
  'fangsong': ['仿宋', 'fangsong', 'fs'],
  'jetbrains mono': ['jb', 'jetbrains', 'jetbrainsmono'],
  'cascadia code': ['cascadia', 'cc', 'cascadiacode'],
  'cascadia mono': ['cascadia', 'cm', 'cascadiamono'],
  'fira code': ['fira', 'firacode', 'fc'],
  'maple mono': ['maple', 'maplemono', 'mm'],
  'source code pro': ['sourcecode', 'scp'],
};

/** 全局单例 ICU Collator，避免在排序中重复实例化 */
const zhCollator = new Intl.Collator('zh-Hans-CN', { sensitivity: 'accent', numeric: true });

/** 将汉字转换为首字母缩写字符串与全拼字符串 */
export function extractPinyin(text: string): { acronym: string; full: string } {
  let acronym = '';
  let full = '';

  for (const char of text) {
    const info = CJK_FONT_PINYIN_MAP[char];
    if (info) {
      acronym += info.initial;
      full += info.full;
    } else {
      // 英文、数字或未录入符号保持小写原样
      const lower = char.toLowerCase();
      acronym += lower;
      full += lower;
    }
  }

  return { acronym, full };
}

/** 为字体选项构建预计算索引，避免高频按键重复计算拼音 */
export function indexFontOptions(options: FontSelectOption[]): IndexedFontOption[] {
  return options.map((opt) => {
    const { acronym, full } = extractPinyin(opt.label);
    const aliases = (FONT_ALIASES[opt.label.toLowerCase()] || []).map((a) => a.toLowerCase());
    return {
      ...opt,
      labelLower: opt.label.toLowerCase(),
      valueLower: opt.value.toLowerCase(),
      acronym,
      fullPinyin: full,
      aliasesLower: aliases,
    };
  });
}

/** 计算预索引条目的加权匹配分值 */
export function calculateIndexedScore(item: IndexedFontOption, query: string): number {
  if (!query) return 100;

  // 1. 完全相等 (Exact Match: 100)
  if (item.labelLower === query || item.valueLower === query) {
    return 100;
  }

  // 2. 前缀匹配 (Prefix Match: 85)
  if (item.labelLower.startsWith(query)) {
    return 85;
  }

  // 3. 连续子串匹配 (Substring Match: 70)
  if (item.labelLower.includes(query) || item.valueLower.includes(query)) {
    return 70;
  }

  // 4. 别名匹配 (Alias Match: 65)
  if (item.aliasesLower.some((a) => a.includes(query))) {
    return 65;
  }

  // 5. 拼音首字母缩写匹配 (Acronym Match: 60)
  if (item.acronym.includes(query)) {
    return 60;
  }

  // 6. 拼音全拼连续匹配 (Pinyin Full Match: 50)
  if (item.fullPinyin.includes(query)) {
    return 50;
  }

  return 0;
}

/** 批量过滤与排序已索引的字体列表 */
export function filterAndSortIndexedOptions(
  indexedList: IndexedFontOption[],
  rawQuery: string,
  maxResults = 100
): IndexedFontOption[] {
  const q = rawQuery.trim().toLowerCase();
  if (!q) {
    return indexedList;
  }

  const scored: Array<{ item: IndexedFontOption; score: number }> = [];

  for (let i = 0; i < indexedList.length; i++) {
    const item = indexedList[i];
    if (!item) continue;
    const score = calculateIndexedScore(item, q);
    if (score > 0) {
      scored.push({ item, score });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return zhCollator.compare(a.item.label, b.item.label);
  });

  return scored.slice(0, maxResults).map((s) => s.item);
}

/** 传统未索引选项过滤函数（封装 index + filter） */
export function filterAndSortFontOptions(
  options: FontSelectOption[],
  query: string,
  maxResults = 100
): FontSelectOption[] {
  const indexed = indexFontOptions(options);
  return filterAndSortIndexedOptions(indexed, query, maxResults);
}

/** 严苛字体名称合法性字符集（仅允许中英文、数字、空格、连字符、下划线与圆点） */
const SAFE_FONT_NAME_REGEX = /^[\p{L}\p{N}\s\-_.]+$/u;
const FONT_NAME_MAX = 48;

/** 安全清洗字体族名（CSS 安全净化） */
export function sanitizeFontFamily(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[;{}<>"'()\\]/g, '')
    .trim();
}

/** 严苛自定义字体名称校验 */
export function sanitizeFontFamilyNameStrict(
  raw: string
): { ok: true; name: string } | { ok: false; reason: string } {
  if (!raw) return { ok: false, reason: '请输入字体名称' };

  const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  if (!clean) return { ok: false, reason: '请输入字体名称' };

  if (clean.length > FONT_NAME_MAX) {
    return { ok: false, reason: `字体名称不得超过 ${FONT_NAME_MAX} 个字符` };
  }

  if (!SAFE_FONT_NAME_REGEX.test(clean)) {
    return { ok: false, reason: '字体名称仅支持中英文字母、数字、空格、连字符与下划线' };
  }

  return { ok: true, name: clean };
}
