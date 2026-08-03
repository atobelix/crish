import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCodexRolloutJsonl } from '../parse/codex';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(
  join(__dirname, '__fixtures__/codex-rollout-sample.jsonl'),
  'utf8',
);

describe('parseCodexRolloutJsonl', () => {
  it('解析 session_meta、user/assistant、reasoning 与 function_call 配对', () => {
    const parsed = parseCodexRolloutJsonl(fixture);

    expect(parsed.source).toBe('codex');
    expect(parsed.sourceSessionId).toBe('ffffffff-1111-2222-3333-444444444444');
    expect(parsed.cwd).toBe('/Users/dev/demo-repo');
    expect(parsed.title).toContain('unit test');
    expect(parsed.createdAtMs).toBe(Date.parse('2026-07-02T12:00:00.000Z'));

    // user + 一条合并的 assistant（reasoning + 工具 + 收尾文本）
    expect(parsed.turns.length).toBeGreaterThanOrEqual(2);
    expect(parsed.turns[0]).toMatchObject({
      role: 'user',
      text: 'Add a unit test for path join.',
    });

    const assistant = parsed.turns.find((t) => t.role === 'assistant');
    expect(assistant).toBeTruthy();
    expect(assistant?.thinking).toContain('join helper');
    expect(assistant?.toolCalls?.[0]).toMatchObject({
      id: 'call_shell_1',
      name: 'shell_command',
      status: 'success',
    });
    expect(assistant?.toolCalls?.[0]?.output).toContain('joinPath');
    expect(assistant?.text).toContain('unit test');
  });

  it('跳过畸形行且不抛错', () => {
    const content = [
      '{bad',
      JSON.stringify({
        timestamp: '2026-07-02T12:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'ok' }],
        },
      }),
    ].join('\n');
    const parsed = parseCodexRolloutJsonl(content);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0]?.text).toBe('ok');
  });
});
