import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessage, SessionState } from '../store/types';
import {
  EXPORT_MESSAGE_TEXT_MAX,
  EXPORT_TOOL_OUTPUT_MAX,
  SESSION_EXPORT_JSON_FORMAT,
  SESSION_EXPORT_JSON_VERSION,
  downloadTextFile,
  exportSessionToJson,
  exportSessionToJsonObject,
  exportSessionToMarkdown,
  formatExportFailure,
  formatToolCollapsible,
  redactHeavyPayloads,
  sanitizeExportFilename,
  sanitizeToolCallForExport,
  tryDownloadSessionJson,
  tryDownloadSessionMarkdown,
  type DownloadTextFileDeps,
} from './sessionExport';

function baseSession(over: Partial<SessionState> = {}): SessionState {
  return {
    id: 'sess-1',
    title: '演示会话',
    folder: 'demo-project',
    isPinned: false,
    isArchived: false,
    timestamp: '2026-07-01T12:00:00.000Z',
    messages: [],
    ...over,
  };
}

function msg(
  over: Partial<SessionMessage> & Pick<SessionMessage, 'id' | 'sender'>,
): SessionMessage {
  return {
    timestamp: Date.UTC(2026, 6, 1, 12, 0, 0),
    ...over,
  };
}

/** erasableSyntaxOnly 安全：显式字段，无 parameter properties */
function makeDownloadCapture(): {
  deps: DownloadTextFileDeps;
  clicks: Array<{ filename: string; url: string; mime?: string; content?: string }>;
} {
  const clicks: Array<{ filename: string; url: string; mime?: string; content?: string }> = [];
  const deps: DownloadTextFileDeps = {
    createBlob: (content: string, mimeType: string) => {
      const blob = { content, mimeType } as unknown as Blob;
      return blob;
    },
    createObjectURL: (blob: Blob) => {
      const b = blob as unknown as { content: string; mimeType: string };
      return `blob:mock:${b.mimeType}:${b.content.length}`;
    },
    revokeObjectURL: () => undefined,
    clickDownload: (filename: string, url: string) => {
      clicks.push({ filename, url });
    },
  };
  return { deps, clicks };
}

describe('sessionExport', () => {
  it('sanitizeExportFilename strips illegal chars and appends date', () => {
    const d = new Date(2026, 6, 16); // 2026-07-16
    expect(sanitizeExportFilename('a/b:c*会话', d)).toBe('abc会话-2026-07-16.md');
    expect(sanitizeExportFilename('', d)).toBe('会话-2026-07-16.md');
    expect(sanitizeExportFilename('   ', d)).toBe('会话-2026-07-16.md');
  });

  it('sanitizeExportFilename keeps Chinese titles and supports json extension', () => {
    const d = new Date(2026, 0, 2);
    expect(sanitizeExportFilename('中文标题·重构', d)).toBe('中文标题·重构-2026-01-02.md');
    expect(sanitizeExportFilename('导出 JSON', d, 'json')).toBe('导出 JSON-2026-01-02.json');
    expect(sanitizeExportFilename('安全', d, '.json')).toBe('安全-2026-01-02.json');
  });

  it('sanitizeExportFilename: trailing dots/spaces and reserved Windows names', () => {
    const d = new Date(2026, 6, 16);
    expect(sanitizeExportFilename('report...  ', d)).toBe('report-2026-07-16.md');
    expect(sanitizeExportFilename('CON', d)).toBe('会话_CON-2026-07-16.md');
    expect(sanitizeExportFilename('nul', d, 'json')).toBe('会话_nul-2026-07-16.json');
    expect(sanitizeExportFilename('ok\u0000bad', d)).toBe('okbad-2026-07-16.md');
  });

  it('exportSessionToMarkdown formats user/assistant messages', () => {
    const md = exportSessionToMarkdown(
      baseSession({
        messages: [
          msg({ id: 'u1', sender: 'user', text: '你好' }),
          msg({ id: 'a1', sender: 'assistant', text: '收到' }),
        ],
      }),
      { nowMs: Date.UTC(2026, 6, 16, 8, 30, 0) },
    );
    expect(md).toContain('# 演示会话');
    expect(md).toContain('- 项目：demo-project');
    expect(md).toContain('## User');
    expect(md).toContain('你好');
    expect(md).toContain('## Assistant');
    expect(md).toContain('收到');
    expect(md).toMatch(/导出时间：/);
  });

  it('empty session exports metadata shell with 无消息 marker (md + json)', () => {
    const empty = baseSession({ title: '空壳', messages: [] });
    const md = exportSessionToMarkdown(empty, { nowMs: Date.UTC(2026, 6, 16, 0, 0, 0) });
    expect(md).toContain('# 空壳');
    expect(md).toContain('会话 ID：`sess-1`');
    expect(md).toContain('*（无消息）*');
    expect(md).not.toContain('## User');

    const obj = exportSessionToJsonObject(empty, { nowMs: 1_000 });
    expect(obj.format).toBe(SESSION_EXPORT_JSON_FORMAT);
    expect(obj.version).toBe(SESSION_EXPORT_JSON_VERSION);
    expect(obj.session.empty).toBe(true);
    expect(obj.session.messages).toEqual([]);
    expect(obj.session.agents).toEqual([]);
    expect(obj.exportedAtMs).toBe(1_000);
  });

  it('export includes collapsible tool summaries (not raw spam status only)', () => {
    const md = exportSessionToMarkdown(
      baseSession({
        messages: [
          msg({
            id: 'a1',
            sender: 'assistant',
            text: '已查',
            toolCalls: [
              {
                id: 't1',
                name: 'run_terminal_command',
                arguments: JSON.stringify({ command: 'git status' }),
                status: 'success',
                output: 'On branch main\nnothing to commit',
              },
            ],
          }),
        ],
      }),
    );
    expect(md).toContain('<details>');
    expect(md).toContain('<summary>');
    expect(md).toContain('run_terminal_command');
    expect(md).toContain('成功');
    expect(md).toContain('git status');
    expect(md).toContain('On branch main');
  });

  it('sanitizeToolCallForExport redacts and caps tool fields', () => {
    const huge = `${'B'.repeat(2000)}+${'C'.repeat(2000)}==`;
    const longOut = Array.from(
      { length: Math.ceil((EXPORT_TOOL_OUTPUT_MAX + 800) / 20) },
      (_, i) => `line ${i} payload here`,
    ).join('\n');
    const s = sanitizeToolCallForExport({
      id: 't1',
      name: 'run_terminal_command',
      arguments: JSON.stringify({ command: `echo ${huge}` }),
      status: 'success',
      output: `Exit code: 0\n${longOut}`,
      diffs: [
        {
          filePath: 'a.ts',
          additions: 1,
          deletions: 0,
          changes: [{ type: 'addition', content: 'x' }],
        },
      ],
    });
    expect(s).not.toBeNull();
    expect(s!.command).toMatch(/已省略/);
    expect(s!.command).not.toContain(huge);
    expect(s!.output).toMatch(/截断|已截断/);
    expect(s!.output).not.toMatch(/^Exit code:/m);
    expect(s!.diffs?.[0]!.filePath).toBe('a.ts');
    expect(sanitizeToolCallForExport({ id: '', name: '', arguments: '', status: 'success' })).toBeNull();
  });

  it('redactHeavyPayloads strips data URLs and long base64', () => {
    const b64 = `${'A'.repeat(100)}+${'B'.repeat(100)}==`;
    const dataUrl = `data:image/png;base64,${b64}`;
    const redacted = redactHeavyPayloads(`img=${dataUrl}\nraw=${b64}`);
    expect(redacted).not.toContain(b64);
    expect(redacted).toMatch(/已省略 data:image\/png;base64/);
    expect(redacted).toMatch(/已省略 base64/);
    expect(redactHeavyPayloads('short-token-ok')).toBe('short-token-ok');
    // 纯英文长文不误伤
    const prose = 'word '.repeat(80);
    expect(redactHeavyPayloads(prose)).toBe(prose);
  });

  it('export does not dump huge base64 from message or tool output', () => {
    const huge = `${'B'.repeat(2000)}+${'C'.repeat(2000)}==`;
    const md = exportSessionToMarkdown(
      baseSession({
        messages: [
          msg({
            id: 'u1',
            sender: 'user',
            text: `截图 data:image/jpeg;base64,${huge}`,
          }),
          msg({
            id: 'a1',
            sender: 'assistant',
            text: '读到了',
            toolCalls: [
              {
                id: 't1',
                name: 'read_file',
                arguments: JSON.stringify({ target_file: 'a.png' }),
                status: 'success',
                output: `content: ${huge}`,
              },
            ],
          }),
        ],
      }),
    );
    expect(md).not.toContain(huge);
    expect(md).toMatch(/已省略/);
    expect(md.length).toBeLessThan(huge.length);
  });

  it('exportSessionToJson shape: metadata, sanitized tools, agents', () => {
    const huge = `${'X'.repeat(300)}+${'Y'.repeat(300)}==`;
    const parent = baseSession({ id: 'sess-parent', title: '主线' });
    const obj = exportSessionToJsonObject(
      baseSession({
        id: 'sess-j',
        title: 'JSON 会话',
        branchParentId: 'sess-parent',
        messages: [
          msg({ id: 'empty', sender: 'assistant', text: '  ' }),
          msg({
            id: 'a1',
            sender: 'assistant',
            text: 'done',
            toolCalls: [
              {
                id: 't1',
                name: 'shell',
                arguments: JSON.stringify({ command: 'ls' }),
                status: 'success',
                output: `blob ${huge}`,
              },
            ],
          }),
        ],
        agents: [
          {
            id: 'ag1',
            subagentRunId: 'r1',
            parentSessionId: 'sess-j',
            parentRunId: 'run-1',
            description: '探查',
            mode: 'explore',
            status: 'completed',
            summary: 'ok',
            messages: [msg({ id: 'am', sender: 'assistant', text: 'agent 行' })],
            startedAt: 1,
            depth: 0,
            subagentPath: ['ag1'],
          },
        ],
      }),
      {
        nowMs: Date.UTC(2026, 6, 16, 8, 0, 0),
        sessionsById: { 'sess-parent': parent },
      },
    );

    expect(obj.format).toBe('crish-session-export');
    expect(obj.version).toBe(1);
    expect(obj.session.empty).toBe(false);
    expect(obj.session.messages).toHaveLength(1);
    expect(obj!.session.messages[0]!.toolCalls?.[0]!.output).toMatch(/已省略/);
    expect(obj!.session.messages[0]!.toolCalls?.[0]!.output).not.toContain(huge);
    expect(obj.session.branchParentId).toBe('sess-parent');
    expect(obj.session.branchParentLabel).toContain('主线');
    expect(obj.session.agents).toHaveLength(1);
    expect(obj!.session.agents[0]!.messages[0]!.text).toBe('agent 行');

    const text = exportSessionToJson(
      baseSession({ messages: [msg({ id: 'u', sender: 'user', text: 'hi' })] }),
      { nowMs: 42 },
    );
    expect(text.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(text) as { exportedAtMs: number };
    expect(parsed.exportedAtMs).toBe(42);
  });

  it('branch and archived sessions get metadata export paths', () => {
    const parent = baseSession({ id: 'sess-parent', title: '主线会话' });
    const branched = baseSession({
      id: 'sess-branch-1',
      title: '主线会话 - 分支',
      branchParentId: 'sess-parent',
      messages: [msg({ id: 'u1', sender: 'user', text: '分叉后继续' })],
    });
    const archived = baseSession({
      id: 'sess-old',
      title: '旧会话',
      isArchived: true,
      messages: [msg({ id: 'u1', sender: 'user', text: '归档内容' })],
    });

    const branchMd = exportSessionToMarkdown(branched, {
      sessionsById: { 'sess-parent': parent },
    });
    expect(branchMd).toContain('分支自：主线会话');
    expect(branchMd).toContain('sess-parent');
    expect(branchMd).toContain('分叉后继续');

    const archMd = exportSessionToMarkdown(archived);
    expect(archMd).toContain('状态：已归档');
    expect(archMd).toContain('归档内容');
    expect(archMd).not.toContain('分支自');
  });

  it('formatToolCollapsible caps long tool output', () => {
    // 混入空格/换行，避免被当作 base64 整段省略
    const longOut = Array.from(
      { length: Math.ceil((EXPORT_TOOL_OUTPUT_MAX + 800) / 20) },
      (_, i) => `line ${i} payload here`,
    ).join('\n');
    const block = formatToolCollapsible({
      id: 't',
      name: 'shell',
      arguments: '{"command":"echo hi"}',
      status: 'success',
      output: longOut,
    });
    expect(block).toMatch(/截断/);
    expect(block.length).toBeLessThan(longOut.length);
  });

  it('skips empty messages and includes agent appendix', () => {
    const md = exportSessionToMarkdown(
      baseSession({
        messages: [
          msg({ id: 'empty', sender: 'assistant', text: '   ' }),
          msg({ id: 'u1', sender: 'user', text: '有内容' }),
        ],
        agents: [
          {
            id: 'ag1',
            subagentRunId: 'r1',
            parentSessionId: 'sess-1',
            parentRunId: 'run-1',
            description: '查日志',
            mode: 'explore',
            status: 'completed',
            summary: '完成',
            messages: [msg({ id: 'am1', sender: 'assistant', text: 'agent 正文' })],
            startedAt: 1,
            depth: 0,
            subagentPath: ['ag1'],
          },
        ],
      }),
    );
    expect(md).toContain('有内容');
    expect(md).not.toMatch(/## Assistant\n\n---/);
    expect(md).toContain('# Agent · 查日志');
    expect(md).toContain('agent 正文');
    expect(md).toContain('摘要：完成');
  });

  it('tryDownloadSessionMarkdown: missing session fails', () => {
    expect(tryDownloadSessionMarkdown(null)).toEqual({
      ok: false,
      error: '没有可导出的会话',
    });
    expect(tryDownloadSessionMarkdown(undefined)).toEqual({
      ok: false,
      error: '没有可导出的会话',
    });
  });

  it('export markdown includes session id and filename contract', () => {
    const sess = baseSession({
      title: '下载测试',
      messages: [msg({ id: 'u', sender: 'user', text: 'hi' })],
    });
    expect(sanitizeExportFilename(sess.title, new Date(2026, 0, 2))).toBe(
      '下载测试-2026-01-02.md',
    );
    const md = exportSessionToMarkdown(sess);
    expect(md).toContain('hi');
    expect(md).toContain('会话 ID：`sess-1`');
  });

  it('formatExportFailure normalizes unknown throws for toast', () => {
    expect(formatExportFailure(new Error('磁盘已满'))).toBe('磁盘已满');
    expect(formatExportFailure(new Error('  '))).toBe('导出失败');
    expect(formatExportFailure('权限不足')).toBe('权限不足');
    expect(formatExportFailure(null)).toBe('导出失败');
    expect(formatExportFailure(42)).toBe('导出失败');
  });

  it('downloadTextFile / tryDownload: injectable deps path (no global FakeBlob)', () => {
    const { deps, clicks } = makeDownloadCapture();
    const blobs: Array<{ content: string; mime: string }> = [];
    const revokes: string[] = [];
    deps.createBlob = (content, mimeType) => {
      blobs.push({ content, mime: mimeType });
      return { content, mimeType } as unknown as Blob;
    };
    deps.revokeObjectURL = (url) => {
      revokes.push(url);
    };

    downloadTextFile('t.md', '# hi', { mimeType: 'text/markdown;charset=utf-8', deps });
    expect(clicks).toHaveLength(1);
    expect(clicks![0]!.filename).toBe('t.md');
    expect(blobs![0]!.mime).toContain('markdown');
    expect(revokes).toHaveLength(1);

    const mdResult = tryDownloadSessionMarkdown(
      baseSession({
        title: '静默成功',
        messages: [msg({ id: 'u', sender: 'user', text: 'ok' })],
      }),
      new Date(2026, 6, 16),
      { downloadDeps: deps },
    );
    expect(mdResult).toEqual({ ok: true, filename: '静默成功-2026-07-16.md' });

    const jsonResult = tryDownloadSessionJson(
      baseSession({
        title: '中文 JSON',
        messages: [msg({ id: 'u', sender: 'user', text: '数据' })],
      }),
      new Date(2026, 6, 16),
      { downloadDeps: deps },
    );
    expect(jsonResult).toEqual({ ok: true, filename: '中文 JSON-2026-07-16.json' });
    expect(blobs.some((b) => b.mime.includes('json'))).toBe(true);
    expect(blobs.some((b) => b.content.includes('"format"'))).toBe(true);
  });

  it('JSON pretty-print 读 codeBlockIndent（4 空格 / Tab）', () => {
    const sess = baseSession({
      messages: [msg({ id: 'u', sender: 'user', text: 'hi' })],
    });
    const four = exportSessionToJson(sess, { nowMs: 1, jsonIndent: '    ' });
    expect(four).toContain('\n    "format"');
    const tabbed = exportSessionToJson(sess, { nowMs: 1, jsonIndent: '\t' });
    expect(tabbed).toContain('\n\t"format"');
    const two = exportSessionToJson(sess, { nowMs: 1, jsonIndent: '  ' });
    expect(two).toContain('\n  "format"');
  });

  it('tryDownloadSessionMarkdown: download throw → ok:false for toast', () => {
    const result = tryDownloadSessionMarkdown(
      baseSession({ messages: [msg({ id: 'u', sender: 'user', text: 'x' })] }),
      new Date(),
      {
        downloadDeps: {
          createBlob: () => {
            throw new Error('DOM 不可用');
          },
        },
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toMatch(/DOM 不可用/);
    }
  });

  it('tryDownloadSessionJson: missing session fails', () => {
    expect(tryDownloadSessionJson(null)).toEqual({
      ok: false,
      error: '没有可导出的会话',
    });
  });

  it('caps huge message text and redacts bare long base64 without +/=', () => {
    // 含空格：不会被 base64 规则吞掉，只走 capText（EXPORT_MESSAGE_TEXT_MAX = 50_000）
    const longText = `prefix ${'word '.repeat(Math.ceil(EXPORT_MESSAGE_TEXT_MAX / 5) + 400)}`;
    expect(longText.length).toBeGreaterThan(EXPORT_MESSAGE_TEXT_MAX);
    const md = exportSessionToMarkdown(
      baseSession({
        messages: [msg({ id: 'u', sender: 'user', text: longText })],
      }),
    );
    expect(md).toMatch(/截断|已截断/);
    expect(md.length).toBeLessThan(longText.length + 500);

    // ≥500 无空格字母数字：按裸 base64 dump 脱敏
    const bare = 'Aa0'.repeat(200); // 600 chars, no +/=
    const red = redactHeavyPayloads(`blob=${bare}`);
    expect(red).not.toContain(bare);
    expect(red).toMatch(/已省略 base64/);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
