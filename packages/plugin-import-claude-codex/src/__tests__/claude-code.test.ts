import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseClaudeCodeJsonl } from '../parse/claude-code';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(
  join(__dirname, '__fixtures__/claude-code-sample.jsonl'),
  'utf8',
);

describe('parseClaudeCodeJsonl', () => {
  it('解析 user/assistant 轮、工具调用与自定义标题', () => {
    const parsed = parseClaudeCodeJsonl(fixture, {
      sourceSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });

    expect(parsed.source).toBe('claude-code');
    expect(parsed.sourceSessionId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(parsed.title).toBe('Demo layout walkthrough');
    expect(parsed.cwd).toBe('C:\\Software\\demo-project');
    expect(parsed.createdAtMs).toBe(Date.parse('2026-07-01T10:00:00.000Z'));

    // user + assistant(带工具) + assistant 收尾 —— tool_result 不构成轮
    expect(parsed.turns).toHaveLength(3);
    expect(parsed.turns[0]).toMatchObject({
      role: 'user',
      text: 'Please explain the folder layout briefly.',
    });
    expect(parsed.turns[1]?.role).toBe('assistant');
    expect(parsed.turns[1]?.thinking).toContain('layout overview');
    expect(parsed.turns[1]?.text).toContain('list the top-level');
    expect(parsed.turns[1]?.toolCalls).toHaveLength(1);
    expect(parsed.turns[1]?.toolCalls?.[0]).toMatchObject({
      id: 'toolu_01abc',
      name: 'Bash',
      status: 'success',
    });
    expect(parsed.turns[1]?.toolCalls?.[0]?.output).toContain('src');
    expect(parsed.turns[2]?.text).toContain('Top level has');
  });

  it('跳过 sidechain 与畸形行', () => {
    const content = [
      '{"type":"user","uuid":"a","isSidechain":true,"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":"hidden"}}',
      'not-json',
      '{"type":"user","uuid":"b","isSidechain":false,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"visible"}}',
    ].join('\n');
    const parsed = parseClaudeCodeJsonl(content);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0]?.text).toBe('visible');
    expect(parsed.skippedLineCount).toBeGreaterThanOrEqual(2);
  });

  it('遵守 maxLines', () => {
    const parsed = parseClaudeCodeJsonl(fixture, { maxLines: 1 });
    expect(parsed.turns.length).toBeLessThanOrEqual(1);
    expect(parsed.warnings.some((w) => w.includes('maxLines'))).toBe(true);
  });
});
