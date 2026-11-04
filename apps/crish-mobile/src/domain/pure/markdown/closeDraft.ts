// 流式草稿处理（MD1)：「只显最终形态」的移动端落法（审计 §C.3)。
// 解析前先按块边界把全文切成「封口区 + 尾块」：
// - 封口区（除最后一块外的全部块）走正常解析，永远是最终形态；
// - 尾块（生长中）按类型分治：
//   · 行内型（段落 / 标题 / 列表 / 引用）：保守补闭合后解析——悬空的行内标记
//     不产生符号闪烁，闭合帧自动成型（补闭合只影响呈现，不改数据）；
//   · 代码块：围栏未闭合期间直接以代码块形态承载原文——代码的最终形态本就
//     是等宽原文，定型容器成型即最终形态，不构成半成品；
//   · 表格：结构完整（被后续内容终止）前整表暂缓，已到达的行按纯文本行呈现
//     （合法中间态），禁止逐行长成半成品表格。
// message-end 后调用方改走 parseMarkdown 全量终态解析，与静态渲染字节一致。
import { parseMarkdown } from './parseMarkdown';
import type { MdBlock, MdSpan } from './types';

export type MdTailKind = 'none' | 'flow' | 'code' | 'table';

export interface PreparedMarkdown {
  /** 封口块（最终形态，流式期间按内容 memo 不重渲） */
  sealed: MdBlock[];
  /** 尾块（生长中，已按分治口径处理） */
  tail: MdBlock[];
  tailKind: MdTailKind;
}

const FENCE_PATTERN = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;

interface FenceOpen {
  char: string;
  len: number;
  lineIndex: number;
  lang: string | null;
}

/** 扫描行序列中的围栏开闭；返回收尾时仍未闭合的围栏（无则 null) */
function unclosedFence(lines: readonly string[]): FenceOpen | null {
  let open: FenceOpen | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const match = FENCE_PATTERN.exec(lines[i]!);
    if (!match) continue;
    const marker = match[2]!;
    if (!open) {
      open = {
        char: marker[0]!,
        len: marker.length,
        lineIndex: i,
        lang: match[3]!.trim().split(/\s+/)[0] || null,
      };
    } else if (
      marker[0] === open.char &&
      marker.length >= open.len &&
      match[3]!.trim() === ''
    ) {
      open = null;
    }
  }
  return open;
}

/** 按块边界切分：围栏内部不切；最后一块为尾块，其余为封口区 */
function splitTail(text: string): { sealedText: string; tailText: string } {
  const lines = text.split('\n');
  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }
  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let lastBlockStart = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const match = FENCE_PATTERN.exec(line);
    if (inFence) {
      if (
        match &&
        match[2]![0] === fenceChar &&
        match[2]!.length >= fenceLen &&
        match[3]!.trim() === ''
      ) {
        inFence = false;
      }
      continue;
    }
    if (match) {
      inFence = true;
      fenceChar = match[2]![0]!;
      fenceLen = match[2]!.length;
      continue;
    }
    if (line.trim() === '') {
      // 空行之后的首个非空行开启新块（暂记，尾部全空时在下方归并封口区）
      if (i + 1 < lines.length) lastBlockStart = i + 1;
    }
  }
  const tailLines = lines.slice(lastBlockStart);
  if (tailLines.every((line) => line.trim() === '')) {
    return { sealedText: text, tailText: '' };
  }
  const cut = lineOffsets[lastBlockStart]!;
  return { sealedText: text.slice(0, cut), tailText: text.slice(cut) };
}

const TABLE_DELIMITER = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

/**
 * 尾块行序列是否为「进行中的表格」：首行为含 | 的表头行、次行为分隔行，
 * 且表格行一直延续到尾块末尾（未被后续内容终止）。返回表格占用行数，非表格返回 0。
 */
function pendingTableLines(lines: readonly string[]): number {
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === '') start += 1;
  const core = lines.slice(start);
  if (core.length < 2) return 0;
  if (!core[0]!.includes('|')) return 0;
  if (!TABLE_DELIMITER.test(core[1]!)) return 0;
  let extent = 2;
  while (extent < core.length && core[extent]!.includes('|')) extent += 1;
  const rest = core.slice(extent);
  if (rest.some((line) => line.trim() !== '')) return 0; // 已被后续内容终止
  return extent;
}

/** 表格暂缓期的呈现：整表按纯文本行（原文逐行 + 断行） */
function rawLinesParagraph(lines: readonly string[]): MdBlock {
  const spans: MdSpan[] = [];
  lines.forEach((line, index) => {
    if (index > 0) spans.push({ type: 'break' });
    spans.push({ type: 'text', text: line });
  });
  return { type: 'paragraph', spans };
}

const DANGLING_LINK_TAIL = /!?\[[^\]\n]*\]\([^)\n]*$/;
const COUNT = (text: string, pattern: RegExp): number =>
  (text.match(pattern) ?? []).length;

/**
 * 单个标记的悬空处理（masked 为等长掩码文本，计数与定位都在其上进行）：
 * 奇数个 = 有未闭合的开标记——开标记之后已有内容则补闭合（内容按最终样式
 * 先行成型）；开标记之后无内容（标记刚敲下、内容未到）则暂隐该标记本身，
 * 避免把 `**` 这类半成品符号直显给用户（下一帧内容到达后自然成型）。
 */
function closeMarker(
  out: string,
  masked: string,
  marker: string,
  pattern: RegExp
): string {
  if (COUNT(masked, pattern) % 2 === 0) return out;
  const idx = masked.lastIndexOf(marker);
  if (idx < 0) return out;
  const after = out.slice(idx + marker.length);
  return after.trim() === '' ? out.slice(0, idx) + after : out + marker;
}

/**
 * 行内型尾块的保守补闭合（只影响呈现，不改数据）：
 * - 未闭合的链接构造 `[..](..` 整段暂隐（截掉未成形部分，前文保留）；
 * - 悬空的行内代码 / 强调标记按 closeMarker 口径处理（有内容补闭合、
 *   无内容暂隐），闭合帧到达后与静态解析一致，不出现符号闪烁与样式回退；
 * - 已闭合行内代码段先等长掩码，其内部符号不参与强调判定；
 * - 裸 `[` 不处理：与正文方括号无法可靠区分，宁可短暂直显也不误伤正文。
 */
export function closeInlineDangling(text: string): string {
  let out = text.replace(DANGLING_LINK_TAIL, '');
  if (COUNT(out, /`/g) % 2 === 1) {
    // 行内代码悬空优先处理：补闭合后其后内容都属代码范围，不再判强调；
    // 尾部孤反引号（无内容）则暂隐
    const idx = out.lastIndexOf('`');
    const after = out.slice(idx + 1);
    return after.trim() === '' ? out.slice(0, idx) + after : `${out}\``;
  }
  // 掩码须逐步按当前文本重算：前一步的补闭合会改变后续标记的计数与定位
  // （典型帧 `**重点*`：** 步补出闭合符后，半截闭合符的首个 * 若仍按旧掩码
  // 计数，会被误判为新的悬空单星而二次补符号，终态残留字面 `**`）。
  const maskCode = (value: string): string =>
    value.replace(/`[^`]*`/g, (match) => ' '.repeat(match.length));
  out = closeMarker(out, maskCode(out), '~~', /~~/g);
  out = closeMarker(out, maskCode(out), '**', /\*\*/g);
  // 单星斜体：在当前文本的 ** 已等长掩码上计数与定位
  const singleMasked = maskCode(out).replace(/\*\*/g, '  ');
  out = closeMarker(out, singleMasked, '*', /\*/g);
  out = closeMarker(out, maskCode(out), '__', /__/g);
  return out;
}

/** 流式全文 → 封口块 + 分治尾块（呈现层流式期唯一入口） */
export function prepareStreamingMarkdown(text: string): PreparedMarkdown {
  if (text === '') return { sealed: [], tail: [], tailKind: 'none' };
  const { sealedText, tailText } = splitTail(text);
  const sealed =
    sealedText.trim() === '' ? [] : parseMarkdown(sealedText.trimEnd());
  if (tailText.trim() === '') {
    return { sealed, tail: [], tailKind: 'none' };
  }

  const lines = tailText.split('\n');

  // 代码：尾块内存在未闭合围栏 → 围栏前部分走行内型口径，围栏起以代码块承载
  const fence = unclosedFence(lines);
  if (fence) {
    const head = lines.slice(0, fence.lineIndex).join('\n');
    const headBlocks =
      head.trim() === '' ? [] : parseMarkdown(closeInlineDangling(head));
    return {
      sealed,
      tail: [
        ...headBlocks,
        {
          type: 'code',
          lang: fence.lang,
          text: lines.slice(fence.lineIndex + 1).join('\n'),
        },
      ],
      tailKind: 'code',
    };
  }

  // 表格：未被终止的进行中表格 → 整表暂缓为纯文本行
  const tableLines = pendingTableLines(lines);
  if (tableLines > 0) {
    let start = 0;
    while (start < lines.length && lines[start]!.trim() === '') start += 1;
    return {
      sealed,
      tail: [rawLinesParagraph(lines.slice(start, start + tableLines))],
      tailKind: 'table',
    };
  }

  // 行内型：保守补闭合后解析
  return {
    sealed,
    tail: parseMarkdown(closeInlineDangling(tailText)),
    tailKind: 'flow',
  };
}
