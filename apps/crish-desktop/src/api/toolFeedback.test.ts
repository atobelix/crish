import { describe, expect, it } from 'vitest';
import {
  fileDiffFromEditArgs,
  isEditToolName,
  isShellToolName,
  parseUnifiedDiffs,
  resolveToolDiffs,
} from './toolFeedback';
import { collectMessageDiffs } from '../components/ChangeOverviewCard';
import type { SessionMessage } from '../store/types';

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

describe('collectMessageDiffs (change overview path)', () => {
  it('aggregates edit-tool args into overview files', () => {
    const msg: SessionMessage = {
      id: 'a1',
      sender: 'assistant',
      text: 'done',
      timestamp: Date.now(),
      status: 'completed',
      toolCalls: [
        {
          id: 't1',
          name: 'search_replace',
          arguments: JSON.stringify({
            path: 'src/app.ts',
            old_string: 'foo',
            new_string: 'bar',
          }),
          status: 'success',
          output: 'OK',
        },
      ],
    };
    const files = collectMessageDiffs(msg);
    expect(files.length).toBe(1);
    expect(files[0].filePath).toBe('src/app.ts');
    expect(files[0].additions).toBeGreaterThan(0);
  });

  it('does not open overview from shell directory listing', () => {
    const listing = [
      'Mode                 LastWriteTime         Length Name',
      '----                 -------------         ------ ----',
      'd-----        2026/7/16     10:00                apps',
    ].join('\n');
    const msg: SessionMessage = {
      id: 'a2',
      sender: 'assistant',
      text: '',
      timestamp: Date.now(),
      status: 'completed',
      toolCalls: [
        {
          id: 't2',
          name: 'run_terminal_command',
          arguments: JSON.stringify({ command: 'Get-ChildItem' }),
          status: 'success',
          output: listing,
        },
      ],
    };
    expect(collectMessageDiffs(msg)).toEqual([]);
  });

  it('prefers structured tc.diffs over re-parsing edit args', () => {
    // 引擎已写入结构化 diffs 时，不应再用 arguments 二次合成（数值以 structured 为准）
    const structured = {
      filePath: 'src/prefer.ts',
      additions: 3,
      deletions: 1,
      changes: [
        { type: 'deletion' as const, content: 'old' },
        { type: 'addition' as const, content: 'a' },
        { type: 'addition' as const, content: 'b' },
        { type: 'addition' as const, content: 'c' },
      ],
    };
    const msg: SessionMessage = {
      id: 'a3',
      sender: 'assistant',
      text: '',
      timestamp: Date.now(),
      status: 'completed',
      toolCalls: [
        {
          id: 't3',
          name: 'search_replace',
          arguments: JSON.stringify({
            path: 'src/prefer.ts',
            old_string: 'x',
            new_string: 'y',
          }),
          status: 'success',
          output: 'OK',
          diffs: [structured],
        },
      ],
    };
    const files = collectMessageDiffs(msg);
    expect(files.length).toBe(1);
    expect(files[0].filePath).toBe('src/prefer.ts');
    expect(files[0].additions).toBe(3);
    expect(files[0].deletions).toBe(1);
    expect(files[0].changes).toEqual(structured.changes);
  });

  it('merges same path across toolCalls and keeps distinct files', () => {
    const msg: SessionMessage = {
      id: 'a4',
      sender: 'assistant',
      text: '',
      timestamp: Date.now(),
      status: 'completed',
      toolCalls: [
        {
          id: 't4a',
          name: 'search_replace',
          arguments: JSON.stringify({
            path: 'src/shared.ts',
            old_string: 'one',
            new_string: 'two',
          }),
          status: 'success',
          output: 'OK',
        },
        {
          id: 't4b',
          name: 'search_replace',
          arguments: JSON.stringify({
            path: 'src/shared.ts',
            old_string: 'alpha',
            new_string: 'beta\ngamma',
          }),
          status: 'success',
          output: 'OK',
        },
        {
          id: 't4c',
          name: 'write_file',
          arguments: JSON.stringify({
            path: 'src/other.ts',
            content: 'line1\nline2',
          }),
          status: 'success',
          output: '写入成功',
        },
      ],
    };
    const files = collectMessageDiffs(msg);
    const byPath = Object.fromEntries(files.map((f) => [f.filePath, f]));
    expect(Object.keys(byPath).sort()).toEqual(['src/other.ts', 'src/shared.ts']);
    // 同路径两次 edit：additions/deletions 累加
    expect(byPath['src/shared.ts'].additions).toBe(1 + 2);
    expect(byPath['src/shared.ts'].deletions).toBe(1 + 1);
    expect(byPath['src/shared.ts'].changes.length).toBeGreaterThanOrEqual(2);
    expect(byPath['src/other.ts'].additions).toBe(2);
    expect(byPath['src/other.ts'].deletions).toBe(0);
  });
});
