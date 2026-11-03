import { describe, expect, it } from 'vitest';
import {
  splitDraftForPresentation,
  type DraftPresentationSplit,
} from './markdownCompletionGate';
import { MarkdownBlockScanner } from './markdownBlockScanner';
import {
  codeFenceClosePattern,
  codeFenceOpenPattern,
} from './markdownLexPatterns';
import {
  countTableColumns,
  isCompleteTableSeparator,
} from './markdownTableLexer';

const presentableOf = (draft: string): string =>
  splitDraftForPresentation(draft).presentable;

describe('splitDraftForPresentation · pass-through growth', () => {
  it('presents plain prose as it grows', () => {
    expect(presentableOf('hello wor')).toBe('hello wor');
    expect(presentableOf('line one\nline tw')).toBe('line one\nline tw');
  });

  it('presents lists, quotes and headings as they grow', () => {
    expect(presentableOf('- a\n- b')).toBe('- a\n- b');
    expect(presentableOf('> quo\n> te')).toBe('> quo\n> te');
    expect(presentableOf('# Tit')).toBe('# Tit');
  });

  it('returns empty split for empty draft', () => {
    expect(splitDraftForPresentation('')).toEqual({
      presentable: '',
      held: '',
    });
  });
});

describe('splitDraftForPresentation · fences', () => {
  it('holds an unclosed fence entirely (zero footprint)', () => {
    expect(splitDraftForPresentation('```ts\nconst x = 1;')).toEqual({
      presentable: '',
      held: '```ts\nconst x = 1;',
    });
  });

  it('presents prose before an unclosed fence, holds from the opener', () => {
    const split = splitDraftForPresentation('before\n\n```ts\ncode');
    // 空行属于可呈现前缀（逐字前缀契约），渲染与 'before' 等价。
    expect(split.presentable).toBe('before\n');
    expect(split.held).toBe('```ts\ncode');
  });

  it('presents a fence closed within the draft', () => {
    const draft = '```ts\nconst x = 1;\n```\n';
    expect(presentableOf(draft)).toBe(draft);
  });

  it('holds the closing fence line while it is still the live line', () => {
    // 闭合行仍是活行（可能继续生长成非闭合行）→ 整段仍扣留，
    // 与扫描器「闭合行是活行不封口」同口径。
    expect(presentableOf('```ts\nconst x = 1;\n```')).toBe('');
  });
});

describe('splitDraftForPresentation · display math', () => {
  it('holds an unclosed $$ block', () => {
    expect(presentableOf('$$\nx^2')).toBe('');
    expect(presentableOf('text\n$$\nx^2')).toBe('text');
  });

  it('presents a $$ block closed within the draft, islands included', () => {
    const draft = 'text\n$$\nx^2\n$$\nafter';
    expect(presentableOf(draft)).toBe(draft);
  });

  it('ignores $$ inside inline code spans', () => {
    const draft = 'use `$$` to delimit math';
    expect(presentableOf(draft)).toBe(draft);
  });
});

describe('splitDraftForPresentation · HTML blocks', () => {
  it('holds an unbalanced HTML block', () => {
    expect(presentableOf('<div>\n<p>hi</p>')).toBe('');
  });

  it('presents an HTML block once tags balance', () => {
    const draft = '<div>\n<p>hi</p>\n</div>\ntail';
    expect(presentableOf(draft)).toBe(draft);
  });

  it('does not treat a balanced inline tag line as a block', () => {
    const draft = 'a <span>x</span> b';
    expect(presentableOf(draft)).toBe(draft);
  });
});

describe('splitDraftForPresentation · tables', () => {
  it('stage A: never presents a would-be header as a paragraph', () => {
    // 表头还在活行上
    expect(presentableOf('| A | B |')).toBe('');
    // 表头已写完、下一行尚未定性
    expect(presentableOf('| A | B |\n')).toBe('');
    // 分隔行已写完一行但尚不完整
    expect(presentableOf('| A | B |\n|\n')).toBe('');
    expect(presentableOf('| A | B |\n| --- |\n')).toBe('');
  });

  it('stage B: holds while the separator is still growing', () => {
    expect(presentableOf('| A | B |\n| --')).toBe('');
    expect(presentableOf('| A | B |\n| --- | -')).toBe('');
  });

  it('presents header + separator once the separator is complete in source', () => {
    expect(presentableOf('| A | B |\n| --- | --- |\n')).toBe(
      '| A | B |\n| --- | --- |'
    );
  });

  it('holds a half-written row, presents it once the line completes', () => {
    const base = '| A | B |\n| --- | --- |';
    expect(presentableOf(`${base}\n| 1`)).toBe(base);
    expect(presentableOf(`${base}\n| 1 | 2 |\n| 3`)).toBe(`${base}\n| 1 | 2 |`);
  });

  it('releases a pipe line as prose once the next line is plain text', () => {
    const draft = 'a | b is prose\nnext line';
    expect(presentableOf(draft)).toBe(draft);
  });

  it('holds a table-shaped live line until it is disambiguated', () => {
    expect(presentableOf('intro\nthe a | b | c grows')).toBe('intro');
    expect(presentableOf('intro\nthe a | b | c grows\nplain')).toBe(
      'intro\nthe a | b | c grows\nplain'
    );
  });

  it('presents a single-pipe prose line as it grows (prose-shaped, not a table)', () => {
    const draft = 'intro\nthe a | b grows';
    expect(presentableOf(draft)).toBe(draft);
  });

  it('does not mistake pipe rows inside a closed fence for a table', () => {
    const draft = '```\n| A | B |\n| --- | --- |\n```\nprose';
    expect(presentableOf(draft)).toBe(draft);
  });
});

/**
 * 中间态检查器：对一帧的 (presentable, held) 做独立复核——
 * presentable 里不许存在任何「未完成结构块的渲染形态」：
 * 未闭合围栏、未闭合 `$$`、未配平 HTML、以及处于表头位置却还没
 * 被后续行定性的含 `|` 行。
 */
const separatorCharset = /^[\s|:-]*$/;

function expectNoIntermediateForms(split: DraftPresentationSplit): void {
  const { presentable, held } = split;
  if (!presentable) return;
  const lines = presentable.split('\n');

  let inFence = false;
  let fenceChar = '`';
  let fenceLen = 3;
  let mathOpen = false;
  for (const line of lines) {
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
    let dollars = 0;
    for (let i = 0; i < line.length - 1; i += 1) {
      if (line[i] === '$' && line[i + 1] === '$') {
        dollars += 1;
        i += 1;
      }
    }
    if (dollars % 2 === 1) mathOpen = !mathOpen;
  }
  expect(inFence, `unclosed fence in presentable: ${presentable}`).toBe(false);
  expect(mathOpen, `unclosed $$ in presentable: ${presentable}`).toBe(false);

  // 表头位置检查：presentable 的最后一行是「表格形」（以 `|` 起头或
  // 含 ≥2 个 `|`）且未被已成形表格覆盖时，它只能是已被 held 首行
  // 定性的普通文本（held 首行非分隔样、非空）。只含单个 `|` 的行是
  // 散文形，按设计照常呈现，不在此列。
  const lastLine = lines[lines.length - 1] ?? '';
  const pipeCount = (lastLine.match(/\|/g) ?? []).length;
  const tableShaped = lastLine.trimStart().startsWith('|') || pipeCount >= 2;
  if (lastLine.includes('|') && tableShaped) {
    let coveredByFormedTable = false;
    for (let k = 0; k + 1 < lines.length; k += 1) {
      const header = lines[k] ?? '';
      if (
        header.includes('|') &&
        isCompleteTableSeparator(lines[k + 1] ?? '', countTableColumns(header))
      ) {
        coveredByFormedTable = true;
        break;
      }
    }
    if (!coveredByFormedTable) {
      const heldFirstLine = held.split('\n')[0] ?? '';
      expect(
        held.length > 0 && !separatorCharset.test(heldFirstLine),
        `undisambiguated pipe tail line presented: ${lastLine}`
      ).toBe(true);
    }
  }
}

const FIXTURES: Record<string, string> = {
  table:
    'Here is the data:\n\n| Name | Value |\n| --- | --- |\n| alpha | 1 |\n| beta | 22 |\n\nDone.',
  fence: 'Code:\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nAfter text.',
  math: 'Formula:\n\n$$\nx^2 + y^2 = z^2\n$$\n\nEnd.',
  html: 'Intro\n\n<div class="card">\n<p>Hello</p>\n</div>\n\nTail.',
  pipeProse: 'Use a | b to mean either.\n\nNext para.',
  mixed:
    'First para with **bold**.\n\n| K | V |\n| --- | --- |\n| a | 1 |\n\n```py\nprint("hi")\n```\n\nClosing words here.',
};

describe('frame replay · gate over growing draft (property)', () => {
  for (const [name, fullText] of Object.entries(FIXTURES)) {
    it(`${name}: no frame shows an intermediate form; presentable grows monotonically`, () => {
      let prevPresentable = '';
      for (let end = 1; end <= fullText.length; end += 1) {
        const draft = fullText.slice(0, end);
        const split = splitDraftForPresentation(draft);
        // 切分契约：presentable 是草稿的逐字行前缀；切分点之后恰好
        // 是 '\n' + held（held 为空字符串表示只扣留了空活行）。
        if (!split.presentable) {
          expect(split.held).toBe(draft);
        } else {
          expect(draft.startsWith(split.presentable)).toBe(true);
          const rest = draft.slice(split.presentable.length);
          expect(rest === '' || rest === `\n${split.held}`).toBe(true);
        }
        expectNoIntermediateForms(split);
        // 单调性按内容判定：尾部换行数在「整段呈现 ↔ 扣留活行」之间
        // 切换时增减，渲染等价，不算回退。
        const stripTail = (s: string): string => s.replace(/\n+$/, '');
        expect(
          stripTail(split.presentable).startsWith(stripTail(prevPresentable)),
          `presentable retreated at frame ${end}: ${JSON.stringify(prevPresentable)} -> ${JSON.stringify(split.presentable)}`
        ).toBe(true);
        prevPresentable = split.presentable;
      }
      // 全文到达后（补一个换行模拟收口帧）：除活行口径外应全部可呈现。
      const settled = splitDraftForPresentation(`${fullText}\n`);
      expect(settled.presentable.replace(/\n+$/, '')).toBe(
        fullText.replace(/\n+$/, '')
      );
      expect(settled.held).toBe('');
    });
  }
});

describe('frame replay · scanner + gate composed (property)', () => {
  for (const [name, fullText] of Object.entries(FIXTURES)) {
    it(`${name}: sealed blocks only append; shown text never retreats or deforms`, () => {
      const scanner = new MarkdownBlockScanner();
      let prevShown = '';
      let fed = 0;
      const shownOf = (): string => {
        const sealed = scanner.getSealedBlocks();
        const draft = scanner.getPendingDraft();
        const split = splitDraftForPresentation(draft);
        expectNoIntermediateForms(split);
        return [...sealed, split.presentable]
          .filter((block) => block.length > 0)
          .join('\n')
          .replace(/\n+$/, '');
      };
      for (let end = 1; end <= fullText.length; end += 1) {
        scanner.appendChunk(fullText.slice(fed, end));
        fed = end;
        const shown = shownOf();
        expect(
          shown === prevShown || shown.startsWith(prevShown),
          `shown text retreated: ${JSON.stringify(prevShown)} -> ${JSON.stringify(shown)}`
        ).toBe(true);
        prevShown = shown;
      }
      // 收口：flush 后静态切分与全文一致（逐块拼回，空行除外）。
      const blocks = scanner.flush();
      expect(blocks.join('\n\n').replace(/\n{3,}/g, '\n\n')).toBe(
        fullText.replace(/\n{3,}/g, '\n\n')
      );
    });
  }
});
