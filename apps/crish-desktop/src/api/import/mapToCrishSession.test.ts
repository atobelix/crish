import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { folderFromCwd, mapToCrishSession, pickTitle } from './mapToCrishSession';
import { parseClaudeCodeJsonl } from './parseClaudeCodeJsonl';
import { importClaudeCodeSession, importCodexSession } from './index';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('mapToCrishSession', () => {
  it('maps Claude fixture to SessionMessage shape', () => {
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
    expect(imported.messages[0]?.sender).toBe('user');
    expect(imported.messages[1]?.toolCalls?.[0]?.name).toBe('Bash');
    expect(imported.messages[1]?.blocks?.some((b) => b.type === 'tool_call')).toBe(true);
    expect(imported.messages.every((m) => m.status === 'completed')).toBe(true);
    expect(imported.warnings).toEqual([]);
  });

  it('maps Codex fixture with reasoning + tools', () => {
    const content = readFileSync(
      join(__dirname, '__fixtures__/codex-rollout-sample.jsonl'),
      'utf8',
    );
    const imported = importCodexSession(content, {
      sourcePath: '/Users/dev/.codex/sessions/2026/07/02/rollout-x.jsonl',
      sessionId: 'crish-codex-1',
    });
    expect(imported.source).toBe('codex');
    expect(imported.folder).toBe('demo-repo');
    expect(imported.messages[0]?.sender).toBe('user');
    const asst = imported.messages.find((m) => m.sender === 'assistant');
    expect(asst?.thinking).toBeTruthy();
    expect(asst?.toolCalls?.[0]?.output).toContain('joinPath');
  });

  it('importClaudeCodeSession convenience matches pipeline', () => {
    const content = readFileSync(
      join(__dirname, '__fixtures__/claude-code-sample.jsonl'),
      'utf8',
    );
    const a = importClaudeCodeSession(content, {
      sourcePath: '/tmp/a.jsonl',
      sessionId: 's1',
    });
    expect(a.messages.length).toBeGreaterThan(0);
    expect(a.sourceSessionId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('folderFromCwd and pickTitle helpers', () => {
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

  it('warns when no messages', () => {
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
