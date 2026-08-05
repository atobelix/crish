import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileDiff } from '../store/types';

const readTextFile = vi.fn();
const writeTextFile = vi.fn();

vi.mock('./workspaceFsApi', () => ({
  readTextFile: (...args: unknown[]) => readTextFile(...args),
  writeTextFile: (...args: unknown[]) => writeTextFile(...args),
}));

import {
  analyzeSearchReplace,
  applyFileDiffToDisk,
  applySearchReplaceToContent,
  classifyFileDiff,
  countOccurrences,
  formatApplyFailureToast,
  hasEffectiveDiffChanges,
  isSafeApplyPath,
  normalizeApplyPath,
  normalizeEol,
  preferEolStyle,
  reconstructFullContent,
  reconstructSearchReplace,
} from './applyFileDiff';

describe('normalizeApplyPath', () => {
  it('trims, strips quotes, unifies separators, drops ./ and trailing slash', () => {
    expect(normalizeApplyPath('  src\\a\\b.ts  ')).toBe('src/a/b.ts');
    expect(normalizeApplyPath('"src/a.ts"')).toBe('src/a.ts');
    expect(normalizeApplyPath("'apps/x'")).toBe('apps/x');
    expect(normalizeApplyPath('./src/./a.ts')).toBe('src/./a.ts');
    expect(normalizeApplyPath('./foo/')).toBe('foo');
    expect(normalizeApplyPath('foo//bar///baz')).toBe('foo/bar/baz');
  });

  it('preserves drive letter form', () => {
    expect(normalizeApplyPath('C:\\proj\\a.ts')).toBe('C:/proj/a.ts');
    expect(normalizeApplyPath('d:/x/y')).toBe('d:/x/y');
  });

  it('returns empty for blank / nullish', () => {
    expect(normalizeApplyPath('')).toBe('');
    expect(normalizeApplyPath('   ')).toBe('');
    expect(normalizeApplyPath(null)).toBe('');
    expect(normalizeApplyPath(undefined)).toBe('');
  });
});

describe('isSafeApplyPath', () => {
  it('rejects empty, null-byte, traversal, and placeholders', () => {
    expect(isSafeApplyPath('').ok).toBe(false);
    expect(isSafeApplyPath('a\0b').ok).toBe(false);
    expect(isSafeApplyPath('../etc/passwd').ok).toBe(false);
    expect(isSafeApplyPath('src/../../secret').ok).toBe(false);
    expect(isSafeApplyPath('变更').ok).toBe(false);
    expect(isSafeApplyPath('文件').ok).toBe(false);
  });

  it('accepts normal workspace-relative paths (normalized)', () => {
    expect(isSafeApplyPath('src/a.ts')).toEqual({ ok: true, path: 'src/a.ts' });
    expect(isSafeApplyPath('apps\\x\\y.ts')).toEqual({
      ok: true,
      path: 'apps/x/y.ts',
    });
  });

  it('rejects Windows reserved device names', () => {
    expect(isSafeApplyPath('CON').ok).toBe(false);
    expect(isSafeApplyPath('src/nul.txt').ok).toBe(false);
    expect(isSafeApplyPath('com1')).toMatchObject({ ok: false });
    expect(isSafeApplyPath('aux.log').ok).toBe(false);
    const reserved = isSafeApplyPath('LPT9');
    if (reserved.ok === false) {
      expect(reserved.reason).toMatch(/保留名/);
    }
  });

  it('rejects invalid Windows path characters and trailing dot/space segments', () => {
    expect(isSafeApplyPath('src/foo*.ts').ok).toBe(false);
    expect(isSafeApplyPath('src/foo?.ts').ok).toBe(false);
    expect(isSafeApplyPath('src/foo|bar.ts').ok).toBe(false);
    expect(isSafeApplyPath('src/foo.').ok).toBe(false);
    // 段尾空格（非整路径 trim 可消掉的尾空白）
    expect(isSafeApplyPath('src/foo /bar.ts').ok).toBe(false);
    // ADS / extra colon
    expect(isSafeApplyPath('C:/foo:stream').ok).toBe(false);
    expect(isSafeApplyPath('foo:bar.ts').ok).toBe(false);
  });

  it('rejects placeholder basenames nested under dirs', () => {
    expect(isSafeApplyPath('src/unknown').ok).toBe(false);
    expect(isSafeApplyPath('dir/untitled').ok).toBe(false);
  });

  it('rejects paths that collapse to nothing', () => {
    expect(isSafeApplyPath('.').ok).toBe(false);
    expect(isSafeApplyPath('./').ok).toBe(false);
  });

  it('allows drive-absolute paths without traversal', () => {
    expect(isSafeApplyPath('C:\\Users\\me\\a.ts')).toEqual({
      ok: true,
      path: 'C:/Users/me/a.ts',
    });
  });
});

describe('classifyFileDiff', () => {
  it('accepts pure addition as full_write', () => {
    const d: FileDiff = {
      filePath: 'a.ts',
      additions: 2,
      deletions: 0,
      changes: [
        { type: 'addition', content: 'line1' },
        { type: 'addition', content: 'line2' },
      ],
    };
    expect(classifyFileDiff(d)).toEqual({ ok: true, mode: 'full_write' });
    expect(reconstructFullContent(d)).toBe('line1\nline2');
  });

  it('accepts del+add as search_replace', () => {
    const d: FileDiff = {
      filePath: 'b.ts',
      additions: 1,
      deletions: 1,
      changes: [
        { type: 'deletion', content: 'const a = 1' },
        { type: 'addition', content: 'const a = 2' },
      ],
    };
    expect(classifyFileDiff(d)).toEqual({ ok: true, mode: 'search_replace' });
    expect(reconstructSearchReplace(d)).toEqual({
      oldStr: 'const a = 1',
      newStr: 'const a = 2',
    });
  });

  it('rejects mixed context hunks', () => {
    const d: FileDiff = {
      filePath: 'c.ts',
      additions: 1,
      deletions: 1,
      changes: [
        { type: 'normal', content: '@@ -1,3 +1,3 @@' },
        { type: 'normal', content: 'keep' },
        { type: 'deletion', content: 'old' },
        { type: 'addition', content: 'new' },
      ],
    };
    const r = classifyFileDiff(d);
    expect(r.ok).toBe(false);
  });

  it('rejects truncated full write', () => {
    const d: FileDiff = {
      filePath: 'd.ts',
      additions: 50,
      deletions: 0,
      changes: [{ type: 'addition', content: 'only-one' }],
    };
    const r = classifyFileDiff(d);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toMatch(/截断/);
  });

  it('ignores placeholder normal-only diffs (hunkless)', () => {
    const d: FileDiff = {
      filePath: 'e.ts',
      additions: 0,
      deletions: 0,
      changes: [{ type: 'normal', content: '文件已更新' }],
    };
    const r = classifyFileDiff(d);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toMatch(/无有效行级变更/);
  });

  it('rejects empty changes and nullish diffs', () => {
    expect(classifyFileDiff(null).ok).toBe(false);
    expect(classifyFileDiff(undefined).ok).toBe(false);
    expect(
      classifyFileDiff({
        filePath: 'x.ts',
        additions: 0,
        deletions: 0,
        changes: [],
      }).ok,
    ).toBe(false);
  });

  it('rejects pure hunk headers without +/- (empty/hunkless)', () => {
    const d: FileDiff = {
      filePath: 'hunk.ts',
      additions: 0,
      deletions: 0,
      changes: [
        { type: 'normal', content: '@@ -1,2 +1,2 @@' },
        { type: 'normal', content: '' },
      ],
    };
    const r = classifyFileDiff(d);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toMatch(/无有效/);
    expect(hasEffectiveDiffChanges(d)).toBe(false);
  });

  it('rejects path traversal even with valid changes', () => {
    const d: FileDiff = {
      filePath: '../outside.ts',
      additions: 1,
      deletions: 0,
      changes: [{ type: 'addition', content: 'x' }],
    };
    const r = classifyFileDiff(d);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toMatch(/越界/);
  });

  it('accepts pure deletion as search_replace', () => {
    const d: FileDiff = {
      filePath: 'del-only.ts',
      additions: 0,
      deletions: 1,
      changes: [{ type: 'deletion', content: 'remove-me' }],
    };
    expect(classifyFileDiff(d)).toEqual({ ok: true, mode: 'search_replace' });
    expect(reconstructSearchReplace(d)).toEqual({
      oldStr: 'remove-me',
      newStr: '',
    });
  });

  it('rejects empty old+new search_replace payload', () => {
    const d: FileDiff = {
      filePath: 'empty-sr.ts',
      additions: 0,
      deletions: 1,
      changes: [{ type: 'deletion', content: '' }],
    };
    const r = classifyFileDiff(d);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toMatch(/为空/);
  });
});

describe('normalizeEol / preferEolStyle', () => {
  it('normalizes CR and CRLF to LF', () => {
    expect(normalizeEol('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('restores CRLF when body prefers it', () => {
    expect(preferEolStyle('x\r\ny', 'a\nb')).toBe('a\r\nb');
    expect(preferEolStyle('x\ny', 'a\nb')).toBe('a\nb');
  });
});

describe('analyzeSearchReplace / applySearchReplaceToContent', () => {
  it('applies unique replacement and preserves CRLF', () => {
    const body = 'const a = 1\r\nkeep\r\n';
    const a = analyzeSearchReplace(body, 'const a = 1', 'const a = 2');
    expect(a.status).toBe('apply');
    if (a.status === 'apply') {
      expect(a.content).toBe('const a = 2\r\nkeep\r\n');
    }
    const r = applySearchReplaceToContent(body, 'const a = 1', 'const a = 2');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe('const a = 2\r\nkeep\r\n');
  });

  it('detects ambiguous multi-match conflict', () => {
    const a = analyzeSearchReplace('xx\nxx\n', 'xx', 'yy');
    expect(a).toEqual({ status: 'ambiguous', hits: 2 });
    const r = applySearchReplaceToContent('xx\nxx\n', 'xx', 'yy');
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.code).toBe('ambiguous');
      expect(r.message).toMatch(/2 次/);
    }
  });

  it('detects both-present conflict for distinctive new blocks', () => {
    const oldBlock = 'function oldName() {\n  return 1;\n}';
    const newBlock = 'function newName() {\n  return 2;\n}';
    const body = `${oldBlock}\n\n${newBlock}\n`;
    const a = analyzeSearchReplace(body, oldBlock, newBlock);
    expect(a.status).toBe('conflict');
    if (a.status === 'conflict') {
      expect(a.reason).toMatch(/同时存在/);
    }
    const r = applySearchReplaceToContent(body, oldBlock, newBlock);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.code).toBe('conflict');
  });

  it('does not false-positive conflict on short tokens already in file', () => {
    // short new token often already exists; still unique-replace old
    const body = 'let a = 1;\nlet b = 2;\n';
    const a = analyzeSearchReplace(body, 'let a = 1', 'let a = 2');
    expect(a.status).toBe('apply');
  });

  it('marks alreadyApplied when new present and old gone', () => {
    const a = analyzeSearchReplace('const a = 2\n', 'const a = 1', 'const a = 2');
    expect(a.status).toBe('already_applied');
    const r = applySearchReplaceToContent(
      'const a = 2\n',
      'const a = 1',
      'const a = 2',
    );
    expect(r).toEqual({
      ok: true,
      content: 'const a = 2\n',
      alreadyApplied: true,
    });
  });

  it('marks pure-delete alreadyApplied when old gone', () => {
    expect(analyzeSearchReplace('kept\n', 'gone', '')).toEqual({
      status: 'already_applied',
    });
  });

  it('reports missing_old when neither side matches', () => {
    expect(analyzeSearchReplace('other\n', 'old', 'new')).toEqual({
      status: 'missing_old',
    });
    const r = applySearchReplaceToContent('other\n', 'old', 'new');
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.code).toBe('missing');
  });

  it('appends when old is empty', () => {
    const a = analyzeSearchReplace('head', '', 'tail');
    expect(a.status).toBe('append');
    if (a.status === 'append') expect(a.content).toBe('head\ntail');
  });

  it('treats old===new as alreadyApplied when present', () => {
    expect(analyzeSearchReplace('same\n', 'same', 'same')).toEqual({
      status: 'already_applied',
    });
  });

  it('rejects empty old+new', () => {
    expect(analyzeSearchReplace('body', '', '')).toEqual({ status: 'empty' });
    const r = applySearchReplaceToContent('body', '', '');
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.code).toBe('empty');
  });
});

describe('formatApplyFailureToast', () => {
  it('returns empty on zero failures (success silent)', () => {
    expect(formatApplyFailureToast(0, [])).toBe('');
  });

  it('names single failed file', () => {
    const msg = formatApplyFailureToast(1, [
      {
        filePath: 'src/foo.ts',
        result: { ok: false, message: '磁盘内容与 diff 的删除片段不匹配，请在编辑器确认' },
      },
    ]);
    expect(msg).toContain('foo.ts');
    expect(msg).toMatch(/应用失败/);
  });

  it('summarizes multi failures', () => {
    const msg = formatApplyFailureToast(2, [
      { filePath: 'a.ts', result: { ok: false, message: 'x' } },
      { filePath: 'b.ts', result: { ok: false, message: 'y' } },
    ]);
    expect(msg).toMatch(/部分失败 2/);
    expect(msg).toContain('a.ts');
  });
});

describe('countOccurrences', () => {
  it('counts non-overlapping hits', () => {
    expect(countOccurrences('aaa', 'aa')).toBe(1);
    expect(countOccurrences('ababab', 'ab')).toBe(3);
    expect(countOccurrences('x', '')).toBe(0);
  });

  it('handles multi-line needles', () => {
    expect(countOccurrences('a\nb\na\nb\n', 'a\nb')).toBe(2);
  });
});

describe('hasEffectiveDiffChanges', () => {
  it('is false for noise-only and empty', () => {
    expect(hasEffectiveDiffChanges(null)).toBe(false);
    expect(
      hasEffectiveDiffChanges({
        filePath: 'x',
        additions: 0,
        deletions: 0,
        changes: [{ type: 'normal', content: '@@ -0,0 +0,0 @@' }],
      }),
    ).toBe(false);
  });

  it('is true when +/- present', () => {
    expect(
      hasEffectiveDiffChanges({
        filePath: 'x',
        additions: 1,
        deletions: 0,
        changes: [{ type: 'addition', content: 'y' }],
      }),
    ).toBe(true);
  });
});

describe('applyFileDiffToDisk', () => {
  beforeEach(() => {
    readTextFile.mockReset();
    writeTextFile.mockReset();
    writeTextFile.mockResolvedValue(undefined);
  });

  it('full_write creates file when missing', async () => {
    readTextFile.mockRejectedValue(new Error('ENOENT'));
    const d: FileDiff = {
      filePath: 'new.ts',
      additions: 1,
      deletions: 0,
      changes: [{ type: 'addition', content: 'hello' }],
    };
    const r = await applyFileDiffToDisk(d);
    expect(r).toEqual({ ok: true, mode: 'full_write' });
    expect(writeTextFile).toHaveBeenCalledWith('new.ts', 'hello', true);
  });

  it('rejects search_replace when old appears multiple times', async () => {
    readTextFile.mockResolvedValue({
      content: 'const a = 1\nconst a = 1\n',
      lineCount: 2,
      truncated: false,
      path: 'dup.ts',
    });
    const d: FileDiff = {
      filePath: 'dup.ts',
      additions: 1,
      deletions: 1,
      changes: [
        { type: 'deletion', content: 'const a = 1' },
        { type: 'addition', content: 'const a = 2' },
      ],
    };
    const r = await applyFileDiffToDisk(d);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.message).toMatch(/出现 2 次/);
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('rejects search_replace when read is truncated', async () => {
    readTextFile.mockResolvedValue({
      content: 'partial',
      lineCount: 1,
      truncated: true,
      path: 'big.ts',
    });
    const d: FileDiff = {
      filePath: 'big.ts',
      additions: 1,
      deletions: 1,
      changes: [
        { type: 'deletion', content: 'partial' },
        { type: 'addition', content: 'full' },
      ],
    };
    const r = await applyFileDiffToDisk(d);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.message).toMatch(/截断/);
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('applies unique search_replace', async () => {
    readTextFile.mockResolvedValue({
      content: 'const a = 1\n',
      lineCount: 1,
      truncated: false,
      path: 'ok.ts',
    });
    const d: FileDiff = {
      filePath: 'ok.ts',
      additions: 1,
      deletions: 1,
      changes: [
        { type: 'deletion', content: 'const a = 1' },
        { type: 'addition', content: 'const a = 2' },
      ],
    };
    const r = await applyFileDiffToDisk(d);
    expect(r).toEqual({ ok: true, mode: 'search_replace' });
    expect(writeTextFile).toHaveBeenCalledWith('ok.ts', 'const a = 2\n', true);
  });

  it('rejects unsafe path without writing', async () => {
    const d: FileDiff = {
      filePath: '../../etc/passwd',
      additions: 1,
      deletions: 0,
      changes: [{ type: 'addition', content: 'x' }],
    };
    const r = await applyFileDiffToDisk(d);
    expect(r.ok).toBe(false);
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('treats pure-delete as alreadyApplied when old is gone', async () => {
    readTextFile.mockResolvedValue({
      content: 'kept\n',
      lineCount: 1,
      truncated: false,
      path: 'del.ts',
    });
    const d: FileDiff = {
      filePath: 'del.ts',
      additions: 0,
      deletions: 1,
      changes: [{ type: 'deletion', content: 'gone' }],
    };
    const r = await applyFileDiffToDisk(d);
    expect(r).toEqual({
      ok: true,
      mode: 'search_replace',
      alreadyApplied: true,
    });
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('full_write skips write when content already matches (success silent path)', async () => {
    readTextFile.mockResolvedValue({
      content: 'same',
      lineCount: 1,
      truncated: false,
      path: 'same.ts',
    });
    const d: FileDiff = {
      filePath: 'same.ts',
      additions: 1,
      deletions: 0,
      changes: [{ type: 'addition', content: 'same' }],
    };
    const r = await applyFileDiffToDisk(d);
    expect(r).toEqual({ ok: true, mode: 'full_write', alreadyApplied: true });
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('normalizes Windows separators before write', async () => {
    readTextFile.mockRejectedValue(new Error('ENOENT'));
    const d: FileDiff = {
      filePath: 'src\\nested\\file.ts',
      additions: 1,
      deletions: 0,
      changes: [{ type: 'addition', content: 'x' }],
    };
    const r = await applyFileDiffToDisk(d);
    expect(r.ok).toBe(true);
    expect(writeTextFile).toHaveBeenCalledWith('src/nested/file.ts', 'x', true);
  });

  it('rejects both-present conflict without writing', async () => {
    const oldBlock = 'export function legacyApi() {\n  return 0;\n}';
    const newBlock = 'export function modernApi() {\n  return 1;\n}';
    readTextFile.mockResolvedValue({
      content: `${oldBlock}\n\n${newBlock}\n`,
      lineCount: 8,
      truncated: false,
      path: 'conflict.ts',
    });
    const d: FileDiff = {
      filePath: 'conflict.ts',
      additions: 3,
      deletions: 3,
      changes: [
        { type: 'deletion', content: 'export function legacyApi() {' },
        { type: 'deletion', content: '  return 0;' },
        { type: 'deletion', content: '}' },
        { type: 'addition', content: 'export function modernApi() {' },
        { type: 'addition', content: '  return 1;' },
        { type: 'addition', content: '}' },
      ],
    };
    const r = await applyFileDiffToDisk(d);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.message).toMatch(/冲突/);
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it('appends when search_replace old is empty string line deleted as empty', async () => {
    // deletion of empty content + addition → classify may reject empty old+new only when both empty
    // del non-empty empty? use pure del empty content with add
    readTextFile.mockResolvedValue({
      content: 'base',
      lineCount: 1,
      truncated: false,
      path: 'append.ts',
    });
    // Actually: dels with real content empty string means oldStr '' if single empty del
    // We need old empty append via reconstruct: only dels that join to '' with adds
    // classify rejects both empty; for empty old + non-empty new need dels.length > 0 with empty join
    // join of [{content:''}] is '' — with adds = [{content:'tail'}] → search_replace
    const d: FileDiff = {
      filePath: 'append.ts',
      additions: 1,
      deletions: 1,
      changes: [
        { type: 'deletion', content: '' },
        { type: 'addition', content: 'tail' },
      ],
    };
    const r = await applyFileDiffToDisk(d);
    expect(r).toEqual({ ok: true, mode: 'search_replace' });
    expect(writeTextFile).toHaveBeenCalledWith('append.ts', 'base\ntail', true);
  });

  it('rejects Windows reserved path without IO', async () => {
    const d: FileDiff = {
      filePath: 'nul',
      additions: 1,
      deletions: 0,
      changes: [{ type: 'addition', content: 'x' }],
    };
    const r = await applyFileDiffToDisk(d);
    expect(r.ok).toBe(false);
    expect(readTextFile).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
  });
});
