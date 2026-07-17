import { describe, expect, it } from 'vitest';
import {
  extractToolCommand,
  formatToolDiffStat,
  humanizeAgentSummary,
  humanizeShellCommand,
  isPlaceholderToolOutput,
  isToolRowDefaultOpen,
  isTrivialToolOutput,
  normalizeToolDiffStat,
  parseGitShortstat,
  resolveToolRowOpen,
  toolCommandPreview,
  toolDiffLineStats,
  toolHasDiffStat,
  toolHasExpandableBody,
  toolHumanLabel,
  toolResultPreview,
  toolRowTone,
  fullToolOutput,
} from './toolPresentation';
import type { MessageToolCall } from '../store/layoutStore';

function tc(partial: Partial<MessageToolCall> & Pick<MessageToolCall, 'name'>): MessageToolCall {
  return {
    id: partial.id || 't1',
    name: partial.name,
    arguments: partial.arguments || '',
    explanation: partial.explanation,
    status: partial.status || 'success',
    output: partial.output,
    diffs: partial.diffs,
  };
}

describe('toolHumanLabel（标签）', () => {
  it('prefers AI explanation (intent) over 查看/运行动作模板', () => {
    const label = toolHumanLabel(
      tc({
        name: 'grep',
        arguments: JSON.stringify({ pattern: 'foo' }),
        explanation: '在工作区搜索冲突的行内按钮标签 data-flowbit-inline',
      }),
    );
    expect(label).toContain('冲突');
    expect(label).not.toMatch(/^搜索/);
  });

  it('uses intent explanation even when args would say 查看文件', () => {
    const label = toolHumanLabel(
      tc({
        name: 'read_file',
        arguments: JSON.stringify({ path: 'src/hooks/useFoo.ts' }),
        explanation: '读取 useFoo 里的按钮挂载逻辑，确认是否重复注入',
      }),
    );
    expect(label).toContain('挂载');
    expect(label).not.toBe('查看 useFoo.ts');
  });

  it('strips generic 正在查看 spam and uses path from args', () => {
    const label = toolHumanLabel(
      tc({
        name: 'read_file',
        arguments: JSON.stringify({ path: 'src/hooks/useFoo.ts' }),
        explanation: '正在查看 useFoo.ts',
      }),
    );
    expect(label).toBe('查看 useFoo.ts');
    expect(label).not.toMatch(/^正在/);
  });

  it('strips bare 创建目录 explanation in favor of shell humanize with path', () => {
    const label = toolHumanLabel(
      tc({
        name: 'run_terminal_cmd',
        arguments: JSON.stringify({ command: 'mkdir apps/new-feature' }),
        explanation: '创建目录',
      }),
    );
    expect(label).toBe('创建目录 new-feature');
  });

  it('humanizes edit tools without 正在 prefix', () => {
    const label = toolHumanLabel(
      tc({
        name: 'edit_file',
        arguments: JSON.stringify({ path: 'packages/a/b.ts' }),
      }),
    );
    expect(label).toBe('修改 b.ts');
  });

  it('labels write_file as 写入 (not 修改)', () => {
    const label = toolHumanLabel(
      tc({
        name: 'write_file',
        arguments: JSON.stringify({ file_path: 'apps/new/README.md' }),
      }),
    );
    expect(label).toBe('写入 README.md');
  });

  it('extracts file_path / targetFile keys for labels', () => {
    expect(
      toolHumanLabel(
        tc({
          name: 'read_file',
          arguments: JSON.stringify({ file_path: 'src/a/b/c.ts' }),
        }),
      ),
    ).toBe('查看 c.ts');
    expect(
      toolHumanLabel(
        tc({
          name: 'search_replace',
          arguments: JSON.stringify({ targetFile: 'pkg/x.ts' }),
        }),
      ),
    ).toBe('修改 x.ts');
  });

  it('humanizes web fetch with hostname', () => {
    const label = toolHumanLabel(
      tc({
        name: 'web_fetch',
        arguments: JSON.stringify({ url: 'https://example.com/docs' }),
      }),
    );
    expect(label).toBe('访问 example.com');
  });

  it('strips 正在修改文件 template spam', () => {
    const label = toolHumanLabel(
      tc({
        name: 'edit_file',
        arguments: JSON.stringify({ path: 'src/App.tsx' }),
        explanation: '正在修改文件',
      }),
    );
    expect(label).toBe('修改 App.tsx');
  });
});

describe('extractToolCommand / toolCommandPreview', () => {
  it('reads file_path key', () => {
    expect(extractToolCommand(JSON.stringify({ file_path: 'a/b.ts' }))).toBe('a/b.ts');
  });

  it('hides tech preview when human already embeds full command path', () => {
    const call = tc({
      name: 'read_file',
      arguments: JSON.stringify({ path: 'useFoo.ts' }),
      explanation: '查看 useFoo.ts',
    });
    // human === 查看 useFoo.ts and path is useFoo.ts → preview shows path unless equal
    // basename path equals argument; human includes basename but not always full equal
    const preview = toolCommandPreview(call, 72);
    // path is short basename; human is 查看 useFoo.ts — path still useful as secondary
    // but when human.includes(one) and one is useFoo.ts, suppress
    expect(preview).toBe('');
  });
});

describe('humanizeShellCommand', () => {
  it('includes mkdir target', () => {
    expect(humanizeShellCommand('mkdir foo/bar')).toBe('创建目录 bar');
  });

  it('humanizes npm run build', () => {
    expect(humanizeShellCommand('npm run build')).toBe('构建项目');
  });

  it('strips leading cd before primary action', () => {
    expect(humanizeShellCommand('cd apps/crish-desktop && npm run test')).toBe('运行测试');
  });
});

describe('toolDiffLineStats', () => {
  it('sums structured diffs', () => {
    const stats = toolDiffLineStats(
      tc({
        name: 'edit_file',
        diffs: [
          { filePath: 'a.ts', additions: 3, deletions: 1, changes: [] },
          { filePath: 'b.ts', additions: 2, deletions: 4, changes: [] },
        ],
      }),
    );
    expect(stats).toEqual({ add: 5, del: 5 });
  });

  it('parses unified diff output when diffs missing', () => {
    const stats = toolDiffLineStats(
      tc({
        name: 'apply_patch',
        output: [
          'diff --git a/x.ts b/x.ts',
          '--- a/x.ts',
          '+++ b/x.ts',
          '@@ -1,2 +1,3 @@',
          ' line',
          '-old',
          '+new1',
          '+new2',
        ].join('\n'),
      }),
    );
    expect(stats).toEqual({ add: 2, del: 1 });
  });

  it('returns null when no line changes', () => {
    expect(toolDiffLineStats(tc({ name: 'read_file', output: 'hello' }))).toBeNull();
  });

  it('falls back to change row types when additions/deletions missing', () => {
    const stats = toolDiffLineStats(
      tc({
        name: 'edit_file',
        diffs: [
          {
            filePath: 'a.ts',
            additions: 0,
            deletions: 0,
            changes: [
              { type: 'addition', content: 'a' },
              { type: 'addition', content: 'b' },
              { type: 'deletion', content: 'c' },
              { type: 'normal', content: 'd' },
            ],
          },
        ],
      }),
    );
    expect(stats).toEqual({ add: 2, del: 1 });
  });

  it('per-file fallback: zero-count file with changes is not masked by sibling stats', () => {
    const stats = toolDiffLineStats(
      tc({
        name: 'edit_file',
        diffs: [
          { filePath: 'a.ts', additions: 2, deletions: 0, changes: [] },
          {
            filePath: 'b.ts',
            additions: 0,
            deletions: 0,
            changes: [
              { type: 'addition', content: 'x' },
              { type: 'deletion', content: 'y' },
              { type: 'deletion', content: 'z' },
            ],
          },
        ],
      }),
    );
    expect(stats).toEqual({ add: 3, del: 2 });
  });

  it('fills missing deletion side from changes while additions count already set', () => {
    const stats = toolDiffLineStats(
      tc({
        name: 'edit_file',
        diffs: [
          {
            filePath: 'a.ts',
            additions: 2,
            deletions: 0,
            changes: [
              { type: 'addition', content: 'a' },
              { type: 'addition', content: 'b' },
              { type: 'deletion', content: 'c' },
            ],
          },
        ],
      }),
    );
    // additions 已有 2；deletions 缺侧由 changes 补 1
    expect(stats).toEqual({ add: 2, del: 1 });
  });

  it('estimates ± from @@ hunk headers when body missing', () => {
    const stats = toolDiffLineStats(
      tc({
        name: 'apply_patch',
        output: ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -1,2 +1,5 @@'].join(
          '\n',
        ),
      }),
    );
    expect(stats).toEqual({ add: 3, del: 0 });
  });

  it('ignores directory listing output (no false ±)', () => {
    const listing = [
      'Mode                 LastWriteTime         Length Name',
      '----                 -------------         ------ ----',
      'd-----         7/16/2026   8:00 AM                src',
      '-a----         7/16/2026   8:01 AM            120 app.ts',
    ].join('\n');
    expect(toolDiffLineStats(tc({ name: 'shell', output: listing }))).toBeNull();
  });

  it('formatToolDiffStat / normalize always shows both sides paired', () => {
    expect(normalizeToolDiffStat({ add: 3.9, del: -1 })).toEqual({ add: 3, del: 0 });
    expect(formatToolDiffStat({ add: 3, del: 1 })).toBe('+3 −1');
    expect(formatToolDiffStat({ add: 0, del: 2 })).toBe('+0 −2');
    expect(formatToolDiffStat({ add: 5, del: 0 })).toBe('+5 −0');
  });

  it('normalize clamps NaN / Infinity / non-finite', () => {
    expect(normalizeToolDiffStat({ add: Number.NaN, del: Number.POSITIVE_INFINITY })).toEqual({
      add: 0,
      del: 0,
    });
    expect(normalizeToolDiffStat({ add: Number.NEGATIVE_INFINITY, del: 2.8 })).toEqual({
      add: 0,
      del: 2,
    });
    expect(formatToolDiffStat({ add: Number.NaN, del: 1 })).toBe('+0 −1');
  });

  it('parses git shortstat when no unified body', () => {
    expect(parseGitShortstat('1 file changed, 3 insertions(+), 1 deletion(-)')).toEqual({
      add: 3,
      del: 1,
    });
    expect(parseGitShortstat('2 files changed, 10 insertions(+)')).toEqual({ add: 10, del: 0 });
    expect(parseGitShortstat('1 file changed, 4 deletions(-)')).toEqual({ add: 0, del: 4 });
    expect(parseGitShortstat('nothing useful')).toBeNull();

    const fromOutput = toolDiffLineStats(
      tc({
        name: 'shell',
        output: 'rewrite a.ts\n1 file changed, 3 insertions(+), 1 deletion(-)\n',
      }),
    );
    expect(fromOutput).toEqual({ add: 3, del: 1 });
    expect(
      toolHasDiffStat(
        tc({
          name: 'shell',
          output: '1 file changed, 2 insertions(+), 0 deletions(-)',
        }),
      ),
    ).toBe(true);
  });

  it('counts apply_patch style +/- without git headers', () => {
    const stats = toolDiffLineStats(
      tc({
        name: 'apply_patch',
        output: [
          '*** Begin Patch',
          '*** Update File: src/a.ts',
          '-old line',
          '-gone',
          '+new line',
          '+also',
          '+third',
          '*** End Patch',
        ].join('\n'),
      }),
    );
    expect(stats).toEqual({ add: 3, del: 2 });
  });

  it('handles CRLF + BOM unified diff', () => {
    const body = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1 +1,2 @@',
      ' keep',
      '-old',
      '+new1',
      '+new2',
    ].join('\r\n');
    const stats = toolDiffLineStats(
      tc({
        name: 'apply_patch',
        output: `\uFEFF${body}`,
      }),
    );
    expect(stats).toEqual({ add: 2, del: 1 });
  });

  it('structured NaN additions fall back to changes / do not poison', () => {
    const stats = toolDiffLineStats(
      tc({
        name: 'edit_file',
        diffs: [
          {
            filePath: 'a.ts',
            additions: Number.NaN as unknown as number,
            deletions: Number.NaN as unknown as number,
            changes: [
              { type: 'addition', content: 'a' },
              { type: 'deletion', content: 'b' },
            ],
          },
        ],
      }),
    );
    expect(stats).toEqual({ add: 1, del: 1 });
  });

  it('toolHasDiffStat false when no line changes', () => {
    expect(toolHasDiffStat(tc({ name: 'read_file', output: 'hello' }))).toBe(false);
    expect(toolHasDiffStat(tc({ name: 'shell', output: '1 file changed' }))).toBe(false);
  });

  it('prefers last shortstat when multiple summaries present', () => {
    const stats = toolDiffLineStats(
      tc({
        name: 'shell',
        output: [
          '1 file changed, 1 insertion(+)',
          'done step 1',
          '2 files changed, 5 insertions(+), 3 deletions(-)',
        ].join('\n'),
      }),
    );
    expect(stats).toEqual({ add: 5, del: 3 });
  });
});

describe('isToolRowDefaultOpen / resolveToolRowOpen (默认折叠)', () => {
  it('never auto-opens success / error / short output / diffs / running', () => {
    expect(isToolRowDefaultOpen(tc({ name: 'read', status: 'success', output: 'ok' }))).toBe(
      false,
    );
    expect(
      isToolRowDefaultOpen(
        tc({ name: 'shell', status: 'error', output: 'fail: not found' }),
      ),
    ).toBe(false);
    expect(
      isToolRowDefaultOpen(
        tc({
          name: 'edit',
          status: 'success',
          diffs: [{ filePath: 'a.ts', additions: 1, deletions: 0, changes: [] }],
        }),
      ),
    ).toBe(false);
    expect(isToolRowDefaultOpen(tc({ name: 'shell', status: 'running' }))).toBe(false);
    expect(isToolRowDefaultOpen(tc({ name: 'read', status: 'pending_approval' }))).toBe(false);
    expect(isToolRowDefaultOpen(null)).toBe(false);
    expect(isToolRowDefaultOpen(undefined)).toBe(false);
  });

  it('expandable body does not imply default open (click to open)', () => {
    const call = tc({
      name: 'shell',
      status: 'success',
      output: 'line1\nline2\nline3\nfile listed',
    });
    expect(toolHasExpandableBody(call)).toBe(true);
    expect(isToolRowDefaultOpen(call)).toBe(false);
  });

  it('resolveToolRowOpen: missing key → collapsed; explicit true/false respected', () => {
    const call = tc({
      name: 'edit_file',
      status: 'success',
      diffs: [{ filePath: 'a.ts', additions: 2, deletions: 1, changes: [] }],
      output: 'done body',
    });
    expect(resolveToolRowOpen(undefined, call.id, call)).toBe(false);
    expect(resolveToolRowOpen({}, call.id, call)).toBe(false);
    expect(resolveToolRowOpen({ [call.id]: true }, call.id, call)).toBe(true);
    expect(resolveToolRowOpen({ [call.id]: false }, call.id, call)).toBe(false);
    // 其它 id 的展开不影响本行
    expect(resolveToolRowOpen({ other: true }, call.id, call)).toBe(false);
  });

  it('default collapsed even with ± badge + long error output', () => {
    const call = tc({
      name: 'edit_file',
      status: 'error',
      diffs: [{ filePath: 'a.ts', additions: 9, deletions: 4, changes: [] }],
      output: 'ERROR:\n' + 'x\n'.repeat(40),
    });
    expect(toolHasDiffStat(call)).toBe(true);
    expect(toolHasExpandableBody(call)).toBe(true);
    expect(isToolRowDefaultOpen(call)).toBe(false);
    expect(resolveToolRowOpen(null, call.id, call)).toBe(false);
  });
});

describe('tool row tone & expand noise', () => {
  it('maps status to stable tone classes', () => {
    expect(toolRowTone('running')).toBe('running');
    expect(toolRowTone('success')).toBe('success');
    expect(toolRowTone('error')).toBe('error');
    expect(toolRowTone('pending_approval')).toBe('pending');
  });

  it('treats 完成 / 执行中 as trivial/placeholder (no expand body)', () => {
    expect(isPlaceholderToolOutput('执行中…')).toBe(true);
    expect(isTrivialToolOutput('完成')).toBe(true);
    expect(isTrivialToolOutput('已拒绝')).toBe(true);
    expect(fullToolOutput('完成')).toBe('');
    expect(fullToolOutput('执行中…')).toBe('');
  });

  it('does not expand success with only 完成 output', () => {
    expect(
      toolHasExpandableBody(
        tc({ name: 'read_file', status: 'success', output: '完成' }),
      ),
    ).toBe(false);
    expect(toolResultPreview(tc({ name: 'read_file', status: 'success', output: '完成' }))).toBe(
      '',
    );
  });

  it('expands when real output exists', () => {
    expect(
      toolHasExpandableBody(
        tc({ name: 'shell', status: 'success', output: 'ok\nfile listed' }),
      ),
    ).toBe(true);
  });

  it('expands when diffs present even if output trivial', () => {
    expect(
      toolHasExpandableBody(
        tc({
          name: 'edit_file',
          status: 'success',
          output: '完成',
          diffs: [{ filePath: 'a.ts', additions: 1, deletions: 0, changes: [] }],
        }),
      ),
    ).toBe(true);
  });
});

describe('humanizeAgentSummary / shell labels', () => {
  it('strips mode=/turns= technical lines from agent summary', () => {
    const raw = [
      '极限测试-子任务2 completed.',
      'mode=research; turns=1; tools=3; events=9.',
      '已核对目录结构，无阻塞问题。',
    ].join('\n');
    const h = humanizeAgentSummary(raw, 'completed');
    expect(h).toContain('已核对');
    expect(h).not.toMatch(/mode=/);
    expect(h).not.toMatch(/turns=/);
    expect(h).not.toMatch(/completed\./i);
  });

  it('humanizes Get-ComputerInfo powershell wrapper', () => {
    const label = humanizeShellCommand(
      'powershell -Command "Get-ComputerInfo | Select-Object CsName"',
    );
    expect(label).toBe('查询系统信息');
  });

  it('does not use raw powershell as human label when explanation is the command', () => {
    const label = toolHumanLabel(
      tc({
        name: 'run_command',
        arguments: JSON.stringify({
          command: 'powershell -Command "Get-ComputerInfo"',
        }),
        explanation: 'powershell -Command "Get-ComputerInfo"',
      }),
    );
    expect(label).not.toMatch(/^powershell/i);
    expect(label).toBe('查询系统信息');
  });
});
