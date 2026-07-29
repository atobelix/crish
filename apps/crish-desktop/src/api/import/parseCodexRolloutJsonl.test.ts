import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCodexRolloutJsonl } from './parseCodexRolloutJsonl';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(
  join(__dirname, '__fixtures__/codex-rollout-sample.jsonl'),
  'utf8',
);

describe('parseCodexRolloutJsonl', () => {
  it('parses session_meta, user/assistant, reasoning, and function_call pair', () => {
    const parsed = parseCodexRolloutJsonl(fixture);

    expect(parsed.source).toBe('codex');
    expect(parsed.sourceSessionId).toBe('ffffffff-1111-2222-3333-444444444444');
    expect(parsed.cwd).toBe('/Users/dev/demo-repo');
    expect(parsed.title).toContain('unit test');
    expect(parsed.createdAtMs).toBe(Date.parse('2026-07-02T12:00:00.000Z'));

    // user + one merged assistant (reasoning + tool + final text)
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

  it('skips malformed lines without throwing', () => {
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
