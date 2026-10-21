/**
 * 顿号是中文输入法下的斜杠键，也是正文标点。
 * 行首或空白后的顿号与半角斜杠共用同一套命令匹配，字符留在正文里。
 * 句中顿号不匹配，面板不出现。
 */

import {
  findSuggestionMatch,
  type SuggestionMatch,
  type Trigger,
} from '@tiptap/suggestion';

const ENUMERATION_COMMA = '、';

/**
 * 先按半角斜杠匹配，没有命中再按顿号匹配。
 * 顿号额外允许全角空格作前缀，句中汉字前的顿号不命中。
 */
export function findSlashOrEnumerationMatch(config: Trigger): SuggestionMatch {
  const slash = findSuggestionMatch(config);
  if (slash) return slash;
  if (config.char !== '/') return null;
  const prefixes = config.allowedPrefixes ?? [' '];
  const allowedPrefixes = prefixes.includes('\u3000')
    ? prefixes
    : [...prefixes, '\u3000'];
  return findSuggestionMatch({
    ...config,
    char: ENUMERATION_COMMA,
    allowedPrefixes,
  });
}
