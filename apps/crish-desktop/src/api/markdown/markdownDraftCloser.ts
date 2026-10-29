/**
 * 流式草稿结构闭合：未闭合围栏、奇数 `$$`、表格候选。
 *
 * 只做结构补全，绝不猜测行内强调；闭合后的文本交给 Rust 渲染，
 * 保证活跃块与封口后的最终块结构一致。
 */
import {
  codeFenceClosePattern,
  codeFenceOpenPattern,
} from './markdownLexPatterns';
import {
  completeTableSeparator,
  countTableColumns,
  isCompleteTableSeparator,
} from './markdownTableLexer';

export function closeMarkdownDraftForRender(draft: string): string {
  if (!draft || draft.trim().length === 0) return draft;
  const normalized = draft.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  const fence = findUnclosedFence(lines);
  if (fence) {
    const closing = fence.char.repeat(fence.len);
    return normalized.endsWith('\n')
      ? `${normalized}${closing}`
      : `${normalized}\n${closing}`;
  }

  if (countDoubleDollarsOutsideCode(normalized) % 2 === 1) {
    if (normalized.endsWith('\n')) return `${normalized}$$`;
    if (normalized.endsWith('$') && !normalized.endsWith('$$')) {
      return `${normalized}$`;
    }
    return `${normalized}\n$$`;
  }

  return closeTableCandidate(normalized);
}

function findUnclosedFence(
  lines: string[]
): { char: string; len: number } | null {
  let inFence = false;
  let char = '`';
  let len = 3;
  for (const line of lines) {
    if (!inFence) {
      const match = line.match(codeFenceOpenPattern);
      if (match && match[2]) {
        inFence = true;
        char = match[2][0] ?? '`';
        len = match[2].length;
      }
    } else {
      const match = line.match(codeFenceClosePattern);
      if (match && match[2] && match[2][0] === char && match[2].length >= len) {
        inFence = false;
      }
    }
  }
  return inFence ? { char, len } : null;
}

function countDoubleDollarsOutsideCode(text: string): number {
  let count = 0;
  let inFence = false;
  let fenceChar = '`';
  let fenceLen = 3;
  for (const line of text.split('\n')) {
    if (!inFence) {
      const open = line.match(codeFenceOpenPattern);
      if (open && open[2]) {
        inFence = true;
        fenceChar = open[2][0] ?? '`';
        fenceLen = open[2].length;
        continue;
      }
    } else {
      const close = line.match(codeFenceClosePattern);
      if (
        close &&
        close[2] &&
        close[2][0] === fenceChar &&
        close[2].length >= fenceLen
      ) {
        inFence = false;
      }
      continue;
    }

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
  }
  return count;
}

function closeTableCandidate(text: string): string {
  const endsWithNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (endsWithNewline) lines.pop();
  if (lines.length < 2) return text;

  let blockStart = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if ((lines[i] ?? '').trim().length === 0) {
      blockStart = i + 1;
      break;
    }
  }
  const block = lines.slice(blockStart);
  if (block.length < 2) return text;
  const header = block[0] ?? '';
  if (!header.includes('|')) return text;
  const columns = countTableColumns(header);
  if (columns < 2) return text;

  const separator = block[1] ?? '';
  const separatorLooksPartial =
    /^[\s|:-]*$/.test(separator) && /[-|]/.test(separator);
  if (!separatorLooksPartial) return text;

  if (!isCompleteTableSeparator(separator, columns)) {
    block[1] = completeTableSeparator(separator, columns);
  }

  if (block.length > 2) {
    const lastIndex = block.length - 1;
    const last = block[lastIndex] ?? '';
    const trimmed = last.trim();
    if (
      trimmed.startsWith('|') &&
      !trimmed.endsWith('|') &&
      trimmed.length > 1
    ) {
      block[lastIndex] = `${last} |`;
    }
  }

  const rebuilt = [...lines.slice(0, blockStart), ...block].join('\n');
  return endsWithNewline ? `${rebuilt}\n` : rebuilt;
}
