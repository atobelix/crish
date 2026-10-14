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
  it('把 Claude fixture 映射为中立消息草稿，且彻底不导入外部工具调用', () => {
    const content = readFileSync(
      join(__dirname, '__fixtures__/claude-code-sample.jsonl'),
      'utf8'
    );
    const parsed = parseClaudeCodeJsonl(content);
    const imported = mapToCrishSession(parsed, {
      sourcePath:
        'C:/fake/.claude/projects/x/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl',
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

    // 彻底排除外部工具调用
    expect(imported.messages[1]?.toolCalls).toBeUndefined();
    expect(
      imported.messages[1]?.blocks?.some((b) => b.type === 'tool_call')
    ).toBe(false);
    expect(
      imported.messages[1]?.blocks?.some(
        (b) => b.type === 'thought' || b.type === 'text'
      )
    ).toBe(true);
    expect(imported.warnings).toEqual([]);
  });

  it('映射 Codex fixture（纯粹只保留 reasoning 与回复正文）', () => {
    const content = readFileSync(
      join(__dirname, '__fixtures__/codex-rollout-sample.jsonl'),
      'utf8'
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
    expect(asst?.toolCalls).toBeUndefined();
    expect(asst?.text).toContain('unit test');
  });

  it('工具执行体 parseClaudeCodeTool 与管线一致（载荷中立）', () => {
    const content = readFileSync(
      join(__dirname, '__fixtures__/claude-code-sample.jsonl'),
      'utf8'
    );
    const payload: SessionImportPayload = parseClaudeCodeTool({
      content,
      sourceSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      sessionId: 's1',
      sourcePath: '/tmp/a.jsonl',
    });
    expect(payload.messages.length).toBeGreaterThan(0);
    expect(payload.sourceSessionId).toBe(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    );
    expect(payload.messages.every((m) => !('sender' in m) && 'role' in m)).toBe(
      true
    );
  });

  it('工具执行体 parseCodexRolloutTool 出参为中立载荷', () => {
    const content = readFileSync(
      join(__dirname, '__fixtures__/codex-rollout-sample.jsonl'),
      'utf8'
    );
    const payload = parseCodexRolloutTool({ content, sessionId: 'cx-1' });
    expect(payload.source).toBe('codex');
    expect(payload.messages.length).toBeGreaterThan(0);
  });

  it('folderFromCwd 与 pickTitle 辅助函数过滤系统提示词', () => {
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
        'hello world'
      )
    ).toBe('hello world');

    // 若传入系统提示词，自动过滤并回退
    expect(
      pickTitle(
        {
          source: 'codex',
          sourceSessionId: 'x',
          title: 'You are Codex, an agent based on GPT-6...',
          turns: [],
          warnings: [],
          lineCount: 0,
          skippedLineCount: 0,
        },
        undefined,
        'Real question from user'
      )
    ).toBe('Real question from user');
  });

  it('无消息时给出警告', () => {
    const imported = mapToCrishSession(
      {
        source: 'codex',
        sourceSessionId: 'x',
        turns: [],
        warnings: [],
        lineCount: 0,
        skippedLineCount: 0,
      },
      { sourcePath: '/tmp/empty.jsonl' }
    );
    expect(imported.warnings).toContain(
      'No importable messages found in transcript'
    );
  });
});
