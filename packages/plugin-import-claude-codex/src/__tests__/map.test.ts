import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { folderFromCwd, mapToCrishSession, pickTitle } from '../map';
import { parseClaudeCodeJsonl } from '../parse/claude-code';
import { parseCodexRolloutJsonl } from '../parse/codex';
import { parseClaudeCodeTool, parseCodexRolloutTool } from '../tools';
import type { SessionImportPayload } from '../types';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('mapToCrishSession', () => {
  it('把 Claude fixture 映射为中立消息草稿', () => {
    const content = readFileSync(
      join(__dirname, '__fixtures__/claude-code-sample.jsonl'),
      'utf8',
    );
    const parsed = parseClaudeCodeJsonl(content);
    const imported = mapToCrishSession(parsed, {
      sourcePath: 'C:/fake/.claude/projects/x/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl',
      sessionId: 'crish-sess-1',
      nowMs: Date.parse('2026-07-15T00:00:00.000Z'),
      idFactory: () => 'gen-id',
    });

    expect(imported.sessionId).toBe('crish-sess-1');
    expect(imported.source).toBe('claude-code');
    expect(imported.title).toBe('Demo layout walkthrough');
    expect(imported.folder).toBe('demo-project');
    expect(imported.messages).toHaveLength(3);
    expect(imported.messages[0]?.role).toBe('user');
    expect(imported.messages[1]?.toolCalls?.[0]?.name).toBe('Bash');
    expect(imported.messages[1]?.blocks?.some((b) => b.type === 'tool_call')).toBe(true);
    expect(imported.warnings).toEqual([]);
  });

  it('映射 Codex fixture（reasoning + 工具）', () => {
    const content = readFileSync(
      join(__dirname, '__fixtures__/codex-rollout-sample.jsonl'),
      'utf8',
    );
    const imported = mapToCrishSession(parseCodexRolloutJsonl(content), {
      sourcePath: '/Users/dev/.codex/sessions/2026/07/02/rollout-x.jsonl',
      sessionId: 'crish-codex-1',
    });
    expect(imported.source).toBe('codex');
    expect(imported.folder).toBe('demo-repo');
    expect(imported.messages[0]?.role).toBe('user');
    const asst = imported.messages.find((m) => m.role === 'assistant');
    expect(asst?.thinking).toBeTruthy();
    expect(asst?.toolCalls?.[0]?.output).toContain('joinPath');
  });

  it('工具执行体 parseClaudeCodeTool 与管线一致（载荷中立）', () => {
    const content = readFileSync(
      join(__dirname, '__fixtures__/claude-code-sample.jsonl'),
      'utf8',
    );
    const payload: SessionImportPayload = parseClaudeCodeTool({
      content,
      sourceSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      sessionId: 's1',
      sourcePath: '/tmp/a.jsonl',
    });
    expect(payload.messages.length).toBeGreaterThan(0);
    expect(payload.sourceSessionId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(payload.messages.every((m) => !('sender' in m) && 'role' in m)).toBe(true);
  });

  it('工具执行体 parseCodexRolloutTool 出参为中立载荷', () => {
    const content = readFileSync(
      join(__dirname, '__fixtures__/codex-rollout-sample.jsonl'),
      'utf8',
    );
    const payload = parseCodexRolloutTool({ content, sessionId: 'cx-1' });
    expect(payload.source).toBe('codex');
    expect(payload.messages.length).toBeGreaterThan(0);
  });

  it('folderFromCwd 与 pickTitle 辅助函数', () => {
    expect(folderFromCwd('/a/b/c')).toBe('c');
    expect(folderFromCwd(undefined, 'X')).toBe('X');
    expect(
      pickTitle(
        {
          source: 'claude-code',
          sourceSessionId: 'x',
          turns: [],
          warnings: [],
          lineCount: 0,
          skippedLineCount: 0,
        },
        undefined,
        'hello world',
      ),
    ).toBe('hello world');
  });

  it('无消息时给出警告', () => {
    const imported = mapToCrishSession(
      {
        source: 'codex',
        sourceSessionId: 'empty',
        turns: [],
        warnings: [],
        lineCount: 0,
        skippedLineCount: 0,
      },
      { sourcePath: '/tmp/empty.jsonl', sessionId: 'e1' },
    );
    expect(imported.messages).toHaveLength(0);
    expect(imported.warnings.some((w) => /No importable/i.test(w))).toBe(true);
  });
});
