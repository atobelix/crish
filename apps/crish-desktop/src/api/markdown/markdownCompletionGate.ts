/**
 * 流式呈现完成门（R13）：活跃尾块在呈现层的最后一道词法关卡。
 *
 * 输入 = MarkdownBlockScanner 给出的活跃草稿（一条消息尾部未封口的区域）；
 * 输出 = 可呈现前缀 + 扣留尾。扣留尾在呈现层零足迹（不占位、不占高），
 * 等其结构完成（或整条消息收口、走静态全量切分）时才出现。
 *
 * 逐类完成判据（词法口径与扫描器分支同源）：
 * - 代码围栏：闭合围栏行已在完整行中出现；未闭合 → 从开围栏行起整段扣留；
 * - `$$` 数学块：闭合 `$$` 已在完整行中出现；未闭合 → 从起始行起扣留；
 * - HTML 块：块边界处的同名标签计数配平；未配平 → 从起始行起扣留；
 * - 表格：表头 + 完整分隔行已在源码中成对出现才算成形；成形后按完整行
 *   逐行呈现，正在生长的活行（半行单元格）扣留；分隔行尚在生长时，从
 *   表头行起整段扣留——表头绝不以普通段落形态先行露面；
 * - 段落 / 列表 / 引用 / 标题：未完成形态即最终形态，照常实时生长；
 *   唯一例外是「表格形」的尾部行（候选表头：以 `|` 起头或含 ≥2 个
 *   `|`）：在下一行定性（成分隔行还是普通文本）之前扣留，防止表头
 *   先以段落形态露面、随后翻转为表格。只含单个 `|` 的行是散文形，
 *   不扣留——否则带竖线的普通句子会在打字中途整行消失。
 *
 * 不变量（单调性）：在同一草稿内，可呈现前缀只按行追加、永不回退；
 * 已呈现内容永不撤回、永不变形；完成门只推迟首次出现。本模块只管
 * 「何时可呈现」，不管显现节律（R11/AN4 的域）。纯函数，无副作用。
 */
import {
  codeFenceClosePattern,
  codeFenceOpenPattern,
} from './markdownLexPatterns';
import {
  countTableColumns,
  isCompleteTableSeparator,
} from './markdownTableLexer';

export interface DraftPresentationSplit {
  /** 可呈现前缀（草稿的逐字前缀） */
  presentable: string;
  /** 扣留尾（呈现层零足迹） */
  held: string;
}

const openingTagPattern = /<([A-Za-z][\w:-]*)[\s>/]/;
/** 分隔行生长中的字符集：只含空白、竖线、连字符、冒号。 */
const separatorCharsetPattern = /^[\s|:-]*$/;

const voidElements = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

function getOpenTagPattern(tagName: string): RegExp {
  return new RegExp(`<${tagName.toLowerCase()}(?=[\\s>/])[^>]*>`, 'gi');
}

function getCloseTagPattern(tagName: string): RegExp {
  return new RegExp(`</${tagName.toLowerCase()}(?=[\\s>])[^>]*>`, 'gi');
}

function countNonSelfClosingOpenTags(block: string, tagName: string): number {
  if (voidElements.has(tagName.toLowerCase())) return 0;
  const matches = block.match(getOpenTagPattern(tagName));
  if (!matches) return 0;
  let count = 0;
  for (const match of matches) {
    if (!match.trimEnd().endsWith('/>')) count += 1;
  }
  return count;
}

function countClosingTags(block: string, tagName: string): number {
  const matches = block.match(getCloseTagPattern(tagName));
  return matches ? matches.length : 0;
}

/**
 * 统计一行内、行内代码之外的非重叠 `$$` 出现次数（与草稿闭合器的
 * 行内口径一致：反引号跨度内的 `$$` 不是数学定界符）。
 */
function countDoubleDollarsInLine(line: string): number {
  let count = 0;
  let codeTicks = 0;
  let i = 0;
  while (i < line.length - 1) {
    if (line[i] === '`') {
      let run = 0;
      while (line[i + run] === '`') run += 1;
      if (codeTicks === 0) codeTicks = run;
      else if (run === codeTicks) codeTicks = 0;
      i += run;
      continue;
    }
    if (codeTicks === 0 && line[i] === '$' && line[i + 1] === '$') {
      count += 1;
      i += 2;
      continue;
    }
    i += 1;
  }
  return count;
}

interface StructuralScan {
  /** 扣留起始行下标；无结构扣留为 -1 */
  heldFrom: number;
  /** 已被闭合结构块（围栏 / 数学 / HTML）整段消费的行，下标置 true */
  consumed: boolean[];
}

/**
 * 结构扣留扫描（只看完整行）：围栏 / `$$` / HTML 块自起始行起若未在
 * 完整行内闭合，返回其起始行下标。同时标出已被闭合结构消费的行，
 * 供尾部扫描跳过（结构内部的 `|` 行不是表格、空行不是段界）。
 */
function scanStructuralHolds(
  lines: string[],
  completeCount: number
): StructuralScan {
  const consumed = new Array<boolean>(lines.length).fill(false);
  let i = 0;
  while (i < completeCount) {
    const line = lines[i] ?? '';

    const fenceMatch = line.match(codeFenceOpenPattern);
    if (fenceMatch && fenceMatch[2]) {
      const fenceChar = fenceMatch[2][0] ?? '`';
      const fenceLen = fenceMatch[2].length;
      let closedAt = -1;
      for (let j = i + 1; j < completeCount; j += 1) {
        const match = (lines[j] ?? '').match(codeFenceClosePattern);
        if (
          match &&
          match[2] &&
          match[2][0] === fenceChar &&
          match[2].length >= fenceLen
        ) {
          closedAt = j;
          break;
        }
      }
      if (closedAt === -1) return { heldFrom: i, consumed };
      for (let j = i; j <= closedAt; j += 1) consumed[j] = true;
      i = closedAt + 1;
      continue;
    }

    if (countDoubleDollarsInLine(line) % 2 === 1) {
      let closedAt = -1;
      for (let j = i + 1; j < completeCount; j += 1) {
        if (countDoubleDollarsInLine(lines[j] ?? '') % 2 === 1) {
          closedAt = j;
          break;
        }
      }
      if (closedAt === -1) return { heldFrom: i, consumed };
      for (let j = i; j <= closedAt; j += 1) consumed[j] = true;
      i = closedAt + 1;
      continue;
    }

    const atBlockBoundary = i === 0 || (lines[i - 1] ?? '').trim().length === 0;
    if (atBlockBoundary) {
      const tagMatch = line.match(openingTagPattern);
      if (tagMatch && tagMatch[1]) {
        const tagName = tagMatch[1];
        let balance =
          countNonSelfClosingOpenTags(line, tagName) -
          countClosingTags(line, tagName);
        if (balance > 0) {
          let closedAt = -1;
          for (let j = i + 1; j < completeCount; j += 1) {
            balance += countNonSelfClosingOpenTags(lines[j] ?? '', tagName);
            balance -= countClosingTags(lines[j] ?? '', tagName);
            if (balance <= 0) {
              closedAt = j;
              break;
            }
          }
          if (closedAt === -1) return { heldFrom: i, consumed };
          for (let j = i; j <= closedAt; j += 1) consumed[j] = true;
          i = closedAt + 1;
          continue;
        }
      }
    }

    i += 1;
  }
  return { heldFrom: -1, consumed };
}

/**
 * 尾部扣留扫描：末段的表格成形判定与候选表头扣留 + 活行自身的结构
 * 起点扣留。返回扣留起始行下标；无扣留返回 -1。已被闭合结构消费的
 * 行不参与判定。
 */
function scanTailHolds(
  lines: string[],
  completeCount: number,
  liveIndex: number,
  consumed: boolean[]
): number {
  const live = lines[liveIndex] ?? '';

  // 末段起点：最后一个「段界空行」之后（结构内部的空行不算段界）。
  let segStart = 0;
  for (let i = completeCount - 1; i >= 0; i -= 1) {
    if (!consumed[i] && (lines[i] ?? '').trim().length === 0) {
      segStart = i + 1;
      break;
    }
  }

  // 已成形表格：表头 + 完整分隔行成对出现 → 完整行全数呈现，
  // 活行（半行单元格）扣留，待其写完再整行出现。
  for (let k = segStart; k + 1 < completeCount; k += 1) {
    if (consumed[k] || consumed[k + 1]) continue;
    const header = lines[k] ?? '';
    if (!header.includes('|')) continue;
    const columns = countTableColumns(header);
    if (columns >= 2 && isCompleteTableSeparator(lines[k + 1] ?? '', columns)) {
      return liveIndex;
    }
  }

  // 候选表头：末段尾部正在长成一张表——尾部完整行是表头行，或已有
  // 一至多行尚不完整的分隔行（回溯越过它们找表头），且活行仍可能继续
  // 长成分隔行（字符集未定性，含活行为空）→ 从表头行起扣留，待活行
  // 定性（成分隔行 → 表格成形；成普通文本 → 整段按段落呈现）。
  // 证据门槛：表头须「表格形」——以 `|` 起头或含 ≥2 个 `|`；仅当活行
  // 已带连字符（分隔行实据）时，含 1 个 `|` 也算。单个 `|` 的普通文本
  // 行是散文形，不扣留（否则每句带竖线的散文都会打字中途整行消失）。
  if (separatorCharsetPattern.test(live)) {
    const strongSeparatorEvidence =
      live.includes('-') && live.trim().length >= 2;
    let cursor = completeCount - 1;
    while (
      cursor >= segStart &&
      !consumed[cursor] &&
      separatorCharsetPattern.test(lines[cursor] ?? '') &&
      /[-|]/.test(lines[cursor] ?? '')
    ) {
      cursor -= 1;
    }
    if (cursor >= segStart && !consumed[cursor]) {
      // 回溯停在表头候选行 → 达证据门槛时从它起扣留；
      // 停在段首之前说明整段都是分隔样行 → 从段首起扣留。
      if (isTableHeaderShaped(lines[cursor] ?? '', strongSeparatorEvidence)) {
        return cursor;
      }
      if (cursor < completeCount - 1) return cursor + 1;
    } else if (cursor < segStart && completeCount > segStart) {
      return segStart;
    }
  }

  // 活行自身：表格形候选表头、围栏 / `$$` / HTML 块的起始行（含只写
  // 了一半的起始标记），在定性（写完并被下一行确认）之前不露面。
  if (live.length > 0) {
    if (isTableHeaderShaped(live, false)) return liveIndex;
    if (codeFenceOpenPattern.test(live)) return liveIndex;
    // 围栏标记只写了一两个字符（还没到能匹配开围栏模式的长度）
    if (/^ {0,3}(`{1,2}|~{1,2})$/.test(live)) return liveIndex;
    if (countDoubleDollarsInLine(live) % 2 === 1) return liveIndex;
    // `$$` 只写出一个 `$`
    if (/^\s*\$\s*$/.test(live)) return liveIndex;
    if (liveIndex === segStart && isUnfinishedHtmlStart(live)) {
      return liveIndex;
    }
  }
  return -1;
}

/** 一行是否「表格形」表头候选：以 `|` 起头，或含 ≥2 个 `|`；
 * 有分隔行实据时放宽到含 1 个 `|`。 */
function isTableHeaderShaped(line: string, strongEvidence: boolean): boolean {
  if (!line.includes('|')) return false;
  if (line.trimStart().startsWith('|')) return true;
  let pipes = 0;
  for (const ch of line) {
    if (ch === '|') pipes += 1;
  }
  return pipes >= 2 || strongEvidence;
}

/**
 * 活行是否是尚未写完的 HTML 块起始：标签名还没写完（行内只有 `<` +
 * 标签名），或开标签已成形但同名闭标签未出现（属性可能还在生长，
 * 无法按 `>` 计数判定配平）。
 */
function isUnfinishedHtmlStart(live: string): boolean {
  if (/^ {0,3}<[A-Za-z]?[\w:-]*$/.test(live)) return true;
  const tagMatch = live.match(openingTagPattern);
  if (!tagMatch || !tagMatch[1]) return false;
  if (live.trimEnd().endsWith('/>')) return false;
  return countClosingTags(live, tagMatch[1]) === 0;
}

/**
 * 把活跃草稿切成可呈现前缀 + 扣留尾。最后一行恒视为活行（可能仍在
 * 生长），其余为完整行——与扫描器「最后一行永不封口」同口径。
 */
export function splitDraftForPresentation(
  draft: string
): DraftPresentationSplit {
  if (!draft) return { presentable: '', held: '' };
  const normalized = draft.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const liveIndex = lines.length - 1;
  const completeCount = liveIndex;

  const structural = scanStructuralHolds(lines, completeCount);
  let heldFrom = structural.heldFrom;
  if (heldFrom === -1) {
    heldFrom = scanTailHolds(
      lines,
      completeCount,
      liveIndex,
      structural.consumed
    );
  }
  if (heldFrom === -1) return { presentable: normalized, held: '' };
  return {
    presentable: lines.slice(0, heldFrom).join('\n'),
    held: lines.slice(heldFrom).join('\n'),
  };
}
