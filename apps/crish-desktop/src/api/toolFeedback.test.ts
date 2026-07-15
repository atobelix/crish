import { describe, expect, it } from 'vitest';
import {
  fileDiffFromEditArgs,
  isEditToolName,
  isShellToolName,
  parseUnifiedDiffs,
  resolveToolDiffs,
} from './toolFeedback';

describe('resolveToolDiffs shell safety', () => {
  it('does not treat PowerShell directory listing as diff', () => {
    const out = [
      '    Directory: C:\\Software\\conex',
      '',
      'Mode                 LastWriteTime         Length Name',
      '----                 -------------         ------ ----',
      'd-----        2026/7/16     10:00                apps',
      'd-----        2026/7/16     10:00                packages',
      '-a----        2026/7/16     10:00           1234 package.json',
    ].join('\n');
    expect(
      resolveToolDiffs({
        name: 'run_terminal_command',
        args: JSON.stringify({ command: 'Get-ChildItem' }),
        output: out,
      }),
    ).toEqual([]);
  });

  it('parses real unified git diff from shell output', () => {
    const out = [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,2 +1,3 @@',
      ' line1',
      '-old',
      '+new',
      '+extra',
    ].join('\n');
    const files = resolveToolDiffs({
      name: 'run_terminal_command',
      args: JSON.stringify({ command: 'git diff' }),
      output: out,
    });
    expect(files.length).toBe(1);
    expect(files[0].filePath).toContain('foo.ts');
    expect(files[0].additions).toBeGreaterThan(0);
  });

  it('keeps structured diffs even when tool name is not edit-like', () => {
    const structured = [
      {
        filePath: 'src/a.ts',
        additions: 1,
        deletions: 0,
        changes: [{ type: 'addition' as const, content: 'x' }],
      },
    ];
    const files = resolveToolDiffs({
      name: 'mystery_tool',
      output: 'ok',
      structuredDiffs: structured,
    });
    expect(files).toEqual(structured);
  });
});

describe('fileDiffFromEditArgs', () => {
  it('builds diff from old_string/new_string', () => {
    const d = fileDiffFromEditArgs(
      JSON.stringify({
        path: 'apps/x/src/a.ts',
        old_string: 'const a = 1',
        new_string: 'const a = 2',
      }),
    );
    expect(d?.filePath).toBe('apps/x/src/a.ts');
    expect(d?.deletions).toBe(1);
    expect(d?.additions).toBe(1);
  });

  it('builds diff from write content', () => {
    const d = fileDiffFromEditArgs(
      JSON.stringify({
        target_file: 'README.md',
        content: 'hello\nworld',
      }),
    );
    expect(d?.filePath).toBe('README.md');
    expect(d?.additions).toBe(2);
  });

  it('resolveToolDiffs uses edit args when output is short success', () => {
    const files = resolveToolDiffs({
      name: 'search_replace',
      args: JSON.stringify({
        filePath: 'src/b.ts',
        old_string: 'a',
        new_string: 'b',
      }),
      output: 'OK',
    });
    expect(files.length).toBe(1);
    expect(files[0].filePath).toBe('src/b.ts');
  });
});

describe('tool name helpers', () => {
  it('classifies shell and edit names', () => {
    expect(isShellToolName('run_terminal_command')).toBe(true);
    expect(isEditToolName('search_replace')).toBe(true);
    expect(isEditToolName('run_terminal_command')).toBe(false);
  });

  it('parseUnifiedDiffs returns empty without git markers', () => {
    expect(parseUnifiedDiffs('hello\nworld\n----\nfiles')).toEqual([]);
  });
});
