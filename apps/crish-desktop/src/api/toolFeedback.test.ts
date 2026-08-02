import { describe, expect, it } from 'vitest';
import {
  buildToolDiffHint,
  buildToolFeedback,
  buildToolUndoHint,
  classifyToolOutcome,
  fileDiffFromEditArgs,
  filterPublishableFileDiffs,
  formatToolFeedbackMessage,
  isCancelledToolSignal,
  isEditToolName,
  isEmptyToolStream,
  isShellToolName,
  looksLikeDirectoryListing,
  parseExitCodeFromToolOutput,
  parseUnifiedDiffs,
  pathFromToolArgs,
  resolveToolDiffs,
  safeTruncateChars,
  sanitizeToolDisplayOutput,
  truncateToolFeedbackOutput,
} from './toolFeedback';
import { collectMessageDiffs } from '../components/diff/ChangeOverviewCard';
import type { SessionMessage } from '../store/types';

describe('looksLikeDirectoryListing', () => {
  it('detects PowerShell / cmd / Unix ls listings', () => {
    expect(
      looksLikeDirectoryListing(
        [
          'Mode                 LastWriteTime         Length Name',
          '----                 -------------         ------ ----',
          'd-----        2026/7/16     10:00                apps',
        ].join('\n'),
      ),
    ).toBe(true);
    expect(
      looksLikeDirectoryListing(
        [' Directory of C:\\foo', '01/01/2026  10:00 AM    <DIR>          apps'].join('\n'),
      ),
    ).toBe(true);
    expect(
      looksLikeDirectoryListing(
        ['total 12', 'drwxr-xr-x  2 user user 4096 Jul 16 10:00 apps'].join('\n'),
      ),
    ).toBe(true);
    expect(looksLikeDirectoryListing('hello\nworld')).toBe(false);
  });

  it('detects headerless PowerShell mode rows and multi <DIR>', () => {
    expect(
      looksLikeDirectoryListing(
        [
          'd-----        2026/7/16     10:00                apps',
          'd-----        2026/7/16     10:00                packages',
          '-a----        2026/7/16     10:00           1234 package.json',
        ].join('\n'),
      ),
    ).toBe(true);
    expect(
      looksLikeDirectoryListing(
        [
          '07/16/2026  10:00 AM    <DIR>          apps',
          '07/16/2026  10:00 AM    <DIR>          packages',
          '07/16/2026  10:00 AM             1234 package.json',
        ].join('\n'),
      ),
    ).toBe(true);
    // 真· unified diff 不应被误判
    expect(
      looksLikeDirectoryListing(
        [
          'diff --git a/foo.ts b/foo.ts',
          '--- a/foo.ts',
          '+++ b/foo.ts',
          '@@ -1 +1 @@',
          '-old',
          '+new',
        ].join('\n'),
      ),
    ).toBe(false);
  });
});

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

  it('does not treat cmd dir or Unix ls -la as diff', () => {
    const cmdDir = [
      ' Directory of C:\\Software\\conex',
      '',
      '07/16/2026  10:00 AM    <DIR>          apps',
      '07/16/2026  10:00 AM             1234 package.json',
    ].join('\n');
    expect(
      resolveToolDiffs({
        name: 'shell',
        args: JSON.stringify({ command: 'dir' }),
        output: cmdDir,
      }),
    ).toEqual([]);

    const lsLa = [
      'total 48',
      'drwxr-xr-x  8 user user  4096 Jul 16 10:00 apps',
      '-rw-r--r--  1 user user  1234 Jul 16 10:00 package.json',
    ].join('\n');
    expect(
      resolveToolDiffs({
        name: 'bash',
        args: JSON.stringify({ command: 'ls -la' }),
        output: lsLa,
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
    expect(files![0]!.filePath).toContain('foo.ts');
    expect(files![0]!.additions).toBeGreaterThan(0);
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
    expect(files![0]!.filePath).toBe('src/b.ts');
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

  it('parseUnifiedDiffs rejects directory listings even with dash lines', () => {
    const listing = [
      'Mode                 LastWriteTime         Length Name',
      '----                 -------------         ------ ----',
      'd-----        2026/7/16     10:00                apps',
      '-a----        2026/7/16     10:00           1234 package.json',
    ].join('\n');
    expect(parseUnifiedDiffs(listing)).toEqual([]);
  });

  it('filterPublishableFileDiffs drops traversal and placeholders', () => {
    expect(
      filterPublishableFileDiffs([
        {
          filePath: 'src/ok.ts',
          additions: 1,
          deletions: 0,
          changes: [{ type: 'addition', content: 'x' }],
        },
        {
          filePath: '变更',
          additions: 1,
          deletions: 0,
          changes: [{ type: 'addition', content: 'x' }],
        },
        {
          filePath: '../escape.ts',
          additions: 1,
          deletions: 0,
          changes: [{ type: 'addition', content: 'x' }],
        },
      ]).map((f) => f.filePath),
    ).toEqual(['src/ok.ts']);
  });

  it('resolveToolDiffs drops edit tools without a path', () => {
    expect(
      resolveToolDiffs({
        name: 'write_file',
        args: JSON.stringify({ content: 'hello' }),
        output: 'OK',
      }),
    ).toEqual([]);
  });

  it('resolveToolDiffs filters unsafe structured diffs', () => {
    expect(
      resolveToolDiffs({
        name: 'mystery',
        structuredDiffs: [
          {
            filePath: '../bad.ts',
            additions: 1,
            deletions: 0,
            changes: [{ type: 'addition', content: 'x' }],
          },
          {
            filePath: 'good.ts',
            additions: 1,
            deletions: 0,
            changes: [{ type: 'addition', content: 'y' }],
          },
        ],
      }).map((f) => f.filePath),
    ).toEqual(['good.ts']);
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
    expect(files![0]!.filePath).toBe('src/app.ts');
    expect(files![0]!.additions).toBeGreaterThan(0);
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
    expect(files![0]!.filePath).toBe('src/prefer.ts');
    expect(files![0]!.additions).toBe(3);
    expect(files![0]!.deletions).toBe(1);
    expect(files![0]!.changes).toEqual(structured.changes);
  });

  it('drops unpublishable structured diffs from overview', () => {
    const msg: SessionMessage = {
      id: 'a-junk',
      sender: 'assistant',
      text: '',
      timestamp: Date.now(),
      status: 'completed',
      toolCalls: [
        {
          id: 'tj',
          name: 'search_replace',
          arguments: '{}',
          status: 'success',
          output: 'OK',
          diffs: [
            {
              filePath: '变更',
              additions: 1,
              deletions: 0,
              changes: [{ type: 'addition', content: 'x' }],
            },
            {
              filePath: 'src/real.ts',
              additions: 1,
              deletions: 0,
              changes: [{ type: 'addition', content: 'y' }],
            },
          ],
        },
      ],
    };
    const files = collectMessageDiffs(msg);
    expect(files.map((f) => f.filePath)).toEqual(['src/real.ts']);
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
    expect(byPath['src/shared.ts']!.additions).toBe(1 + 2);
    expect(byPath['src/shared.ts']!.deletions).toBe(1 + 1);
    expect(byPath['src/shared.ts']!.changes.length).toBeGreaterThanOrEqual(2);
    expect(byPath['src/other.ts']!.additions).toBe(2);
    expect(byPath['src/other.ts']!.deletions).toBe(0);
  });
});

describe('classifyToolOutcome paths', () => {
  it('classifies success when status ok and empty stderr', () => {
    expect(
      classifyToolOutcome({
        status: 'success',
        output: 'OK',
        stderr: '',
        exitCode: 0,
      }),
    ).toBe('success');
    // 空白 stderr 不得升为 partial
    expect(
      classifyToolOutcome({
        status: 'success',
        output: 'done',
        stderr: '  \n\t  ',
      }),
    ).toBe('success');
  });

  it('classifies error from status or non-zero exit', () => {
    expect(classifyToolOutcome({ status: 'error', output: 'boom' })).toBe('error');
    expect(classifyToolOutcome({ status: 'success', exitCode: 1, output: 'fail' })).toBe(
      'error',
    );
    expect(
      classifyToolOutcome({
        status: 'success',
        output: 'Exit code: 2\nSomething broke',
      }),
    ).toBe('error');
  });

  it('classifies partial from stderr warnings, truncated, or partial copy', () => {
    expect(
      classifyToolOutcome({
        status: 'success',
        output: 'wrote file',
        stderr: 'warning: deprecated API',
      }),
    ).toBe('partial');
    expect(
      classifyToolOutcome({
        status: 'success',
        output: '…',
        truncated: true,
      }),
    ).toBe('partial');
    expect(
      classifyToolOutcome({
        status: 'success',
        output: '部分完成：3/5 文件',
      }),
    ).toBe('partial');
  });

  it('classifies cancelled from flag or cancel text (overrides error)', () => {
    expect(classifyToolOutcome({ cancelled: true, status: 'error' })).toBe('cancelled');
    expect(
      classifyToolOutcome({
        status: 'error',
        output: 'cancelled by user',
      }),
    ).toBe('cancelled');
    expect(
      classifyToolOutcome({
        status: 'error',
        output: '用户取消了操作',
      }),
    ).toBe('cancelled');
    expect(isCancelledToolSignal({ cancelled: true })).toBe(true);
    expect(isCancelledToolSignal({ output: '上次会话中断' })).toBe(true);
  });

  it('classifies running and pending', () => {
    expect(classifyToolOutcome({ status: 'running' })).toBe('running');
    expect(classifyToolOutcome({ status: 'pending_approval' })).toBe('pending');
  });

  it('empty stderr helper and exit parser edge cases', () => {
    expect(isEmptyToolStream(null)).toBe(true);
    expect(isEmptyToolStream('')).toBe(true);
    expect(isEmptyToolStream('  \n')).toBe(true);
    expect(isEmptyToolStream('x')).toBe(false);
    expect(parseExitCodeFromToolOutput('Exit code: 0\nhello')).toBe(0);
    expect(parseExitCodeFromToolOutput('no exit here')).toBe(null);
    expect(parseExitCodeFromToolOutput(null)).toBe(null);
  });
});

describe('formatToolFeedbackMessage + truncate', () => {
  it('emits Chinese-safe short messages per kind', () => {
    expect(formatToolFeedbackMessage('running')).toBe('执行中…');
    expect(formatToolFeedbackMessage('pending')).toBe('待确认');
    expect(formatToolFeedbackMessage('cancelled')).toBe('已取消');
    expect(formatToolFeedbackMessage('success', { name: 'run_terminal_command' })).toBe(
      '命令已完成',
    );
    expect(
      formatToolFeedbackMessage('success', {
        name: 'search_replace',
        diffs: [
          {
            filePath: 'a.ts',
            additions: 1,
            deletions: 0,
            changes: [{ type: 'addition', content: 'x' }],
          },
        ],
      }),
    ).toBe('文件已更新');
    expect(formatToolFeedbackMessage('partial', { stderr: 'warn' })).toBe(
      '完成，但有警告输出',
    );
    expect(formatToolFeedbackMessage('partial', { truncated: true })).toBe(
      '结果已截断（部分输出）',
    );
    expect(formatToolFeedbackMessage('error', { exitCode: 7, output: '' })).toBe(
      '执行失败（退出码 7）',
    );
  });

  it('truncates large output with Chinese ellipsis; preserves short CJK', () => {
    const many = Array.from({ length: 50 }, (_, i) => `行${i} 内容`).join('\n');
    const r = truncateToolFeedbackOutput(many, { maxLines: 5, maxChars: 5000 });
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('已截断');
    expect(r.text).toContain('共 50 行');

    const wide = '中'.repeat(100);
    const r2 = truncateToolFeedbackOutput(wide, { maxChars: 20, maxLines: 100 });
    expect(r2.truncated).toBe(true);
    expect(r2.text.endsWith('…（已截断）')).toBe(true);
    // 不切断代理对：emoji 整码点
    expect(safeTruncateChars('你好🎉世界', 3)).toBe('你好🎉');
  });

  it('sanitize strips metadata including empty Stderr header', () => {
    const cleaned = sanitizeToolDisplayOutput(
      ['hello', 'Exit code: 0', 'Wall time: 1ms', 'Stderr:', '', 'world'].join('\n'),
    );
    expect(cleaned).not.toMatch(/Exit code/);
    expect(cleaned).not.toMatch(/Wall time/);
    expect(cleaned).toContain('hello');
    expect(cleaned).toContain('world');
  });

  it('sanitize strips checkpoint and system banners', () => {
    const cleaned = sanitizeToolDisplayOutput(
      [
        'Pre-mutation Git checkpoint: abc',
        'Workspace checkpoint: xyz',
        '系统提示：内部状态',
        '[system] skip me',
        'real output line',
        'Working directory: C:\\tmp',
      ].join('\n'),
    );
    expect(cleaned).toBe('real output line');
    expect(cleaned).not.toMatch(/checkpoint/i);
    expect(cleaned).not.toMatch(/系统提示/);
    expect(cleaned).not.toMatch(/Working directory/);
  });
});

describe('diff / undo hints + buildToolFeedback', () => {
  const oneDiff = {
    filePath: 'src/app.ts',
    additions: 2,
    deletions: 1,
    changes: [
      { type: 'deletion' as const, content: 'a' },
      { type: 'addition' as const, content: 'b' },
      { type: 'addition' as const, content: 'c' },
    ],
  };

  it('buildToolDiffHint summarizes ± and path', () => {
    expect(buildToolDiffHint([oneDiff])).toBe('+2 −1 · app.ts');
    expect(buildToolDiffHint([])).toBe(null);
    expect(
      buildToolDiffHint([
        oneDiff,
        {
          filePath: 'src/b.ts',
          additions: 1,
          deletions: 0,
          changes: [{ type: 'addition', content: 'z' }],
        },
      ]),
    ).toBe('+3 −1 · 2 个文件');
  });

  it('undo hint only for edit-like success/partial with publishable diffs', () => {
    expect(
      buildToolUndoHint({ kind: 'success', name: 'search_replace', diffs: [oneDiff] }),
    ).toMatch(/撤销/);
    expect(
      buildToolUndoHint({
        kind: 'success',
        name: 'run_terminal_command',
        diffs: [oneDiff],
      }),
    ).toBe(null);
    expect(
      buildToolUndoHint({ kind: 'error', name: 'search_replace', diffs: [oneDiff] }),
    ).toBe(null);
    expect(buildToolUndoHint({ kind: 'success', name: 'search_replace', diffs: [] })).toBe(
      null,
    );
  });

  it('buildToolFeedback: success never toastable; wires message/detail/hints', () => {
    const fb = buildToolFeedback({
      name: 'search_replace',
      status: 'success',
      output: 'OK',
      stderr: '',
      exitCode: 0,
      diffs: [oneDiff],
    });
    expect(fb.kind).toBe('success');
    expect(fb.toastable).toBe(false);
    expect(fb.message).toBe('文件已更新');
    expect(fb.diffHint).toContain('+2');
    expect(fb.undoHint).toMatch(/变更面板/);
  });

  it('buildToolFeedback: empty stderr stays success; non-empty stderr → partial', () => {
    const emptyErr = buildToolFeedback({
      status: 'success',
      output: 'done',
      stderr: '\n  ',
    });
    expect(emptyErr.kind).toBe('success');
    expect(emptyErr.toastable).toBe(false);

    const warn = buildToolFeedback({
      status: 'success',
      output: 'done',
      stderr: 'npm WARN deprecated',
    });
    expect(warn.kind).toBe('partial');
    expect(warn.toastable).toBe(false);
    expect(warn.message).toBe('完成，但有警告输出');
    expect(warn.detail).toContain('npm WARN');
  });

  it('buildToolFeedback: cancelled and error edges', () => {
    const cancel = buildToolFeedback({
      status: 'error',
      output: 'cancelled by user',
    });
    expect(cancel.kind).toBe('cancelled');
    expect(cancel.message).toBe('已取消');
    expect(cancel.toastable).toBe(false);

    const err = buildToolFeedback({
      status: 'error',
      output: 'ENOENT: no such file',
      exitCode: 1,
    });
    expect(err.kind).toBe('error');
    expect(err.toastable).toBe(true);
    expect(err.message).toContain('ENOENT');
  });

  it('buildToolFeedback: large output truncation flips success → partial', () => {
    const big = Array.from({ length: 80 }, (_, i) => `L${i}`).join('\n');
    const fb = buildToolFeedback({
      status: 'success',
      output: big,
      maxDetailLines: 3,
      maxDetailChars: 10_000,
    });
    expect(fb.kind).toBe('partial');
    expect(fb.truncated).toBe(true);
    expect(fb.message).toBe('结果已截断（部分输出）');
    expect(fb.toastable).toBe(false);
  });

  it('pathFromToolArgs reads file_path / targetFile', () => {
    expect(pathFromToolArgs(JSON.stringify({ file_path: 'src/x.ts' }))).toBe('src/x.ts');
    expect(pathFromToolArgs(JSON.stringify({ targetFile: 'a/b.md' }))).toBe('a/b.md');
  });
});
