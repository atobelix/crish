import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCodexRolloutJsonl } from '../parse/codex';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(
  join(__dirname, '__fixtures__/codex-rollout-sample.jsonl'),
  'utf8'
);

describe('parseCodexRolloutJsonl', () => {
  it('解析 session_meta、user/assistant、reasoning 并彻底排除外部工具调用以保持纯净', () => {
    const parsed = parseCodexRolloutJsonl(fixture);

    expect(parsed.source).toBe('codex');
    expect(parsed.sourceSessionId).toBe('ffffffff-1111-2222-3333-444444444444');
    expect(parsed.cwd).toBe('/Users/dev/demo-repo');
    expect(parsed.title).toContain('unit test');
    expect(parsed.createdAtMs).toBe(Date.parse('2026-07-02T12:00:00.000Z'));

    // user + 一条合并的 assistant（reasoning + 收尾文本，彻底不挂载外部工具）
    expect(parsed.turns.length).toBeGreaterThanOrEqual(2);
    expect(parsed.turns[0]).toMatchObject({
      role: 'user',
      text: 'Add a unit test for path join.',
    });

    const assistant = parsed.turns.find((t) => t.role === 'assistant');
    expect(assistant).toBeTruthy();
    expect(assistant?.thinking).toContain('join helper');
    expect(assistant?.toolCalls).toBeUndefined();
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

  it('面对包含 system/developer 消息和 <environment_context> 样板的 rollout 时，不混入 system/developer，只包含真实对话', () => {
    const lines = [
      JSON.stringify({
        timestamp: '2026-07-02T12:00:00.000Z',
        type: 'session_meta',
        payload: {
          meta: {
            id: 'meta-session-1',
            base_instructions: 'You are Codex, an agent based on GPT-6...',
          },
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-02T12:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'system',
          content: [
            { type: 'output_text', text: 'System prompt instructions' },
          ],
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-02T12:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'Developer prompt rules' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-02T12:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '<environment_context>\nCWD: /repo\n</environment_context>',
            },
          ],
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-02T12:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '<environment_context>OS: Linux</environment_context>\n\nImplement feature X',
            },
          ],
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-02T12:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Feature X is implemented.' }],
        },
      }),
    ].join('\n');

    const parsed = parseCodexRolloutJsonl(lines);

    // 严禁包含 system / developer 为 assistant 的轮次
    expect(parsed.title).toBe('Implement feature X');
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0]).toMatchObject({
      role: 'user',
      text: 'Implement feature X',
    });
    expect(parsed.turns[1]).toMatchObject({
      role: 'assistant',
      text: 'Feature X is implemented.',
    });
    for (const turn of parsed.turns) {
      expect(turn.text).not.toContain('You are Codex');
      expect(turn.text).not.toContain('System prompt instructions');
      expect(turn.text).not.toContain('Developer prompt rules');
    }
  });

  it('支持从 event_msg item_completed 中提取 UserMessage，且与 response_item 去重', () => {
    const lines = [
      JSON.stringify({
        timestamp: '2026-07-02T12:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'UserMessage',
            message: 'Hello from event_msg',
          },
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-02T12:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Hello from event_msg' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-02T12:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hi!' }],
        },
      }),
    ].join('\n');

    const parsed = parseCodexRolloutJsonl(lines);
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0]).toMatchObject({
      role: 'user',
      text: 'Hello from event_msg',
    });
    expect(parsed.turns[1]).toMatchObject({
      role: 'assistant',
      text: 'Hi!',
    });
  });

  it('彻底剥离外部 function_call 与 custom_tool_call，避免污染内部 Agent 上下文', () => {
    const lines = [
      JSON.stringify({
        timestamp: '2026-07-02T12:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Run build and test' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-02T12:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'shell_command',
          call_id: 'call_1',
          arguments: '{"command":"npm test"}',
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-02T12:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'PASS src/index.test.ts',
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-02T12:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'output_text', text: 'All 3 tests passed successfully.' },
          ],
        },
      }),
    ].join('\n');

    const parsed = parseCodexRolloutJsonl(lines);
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0]?.text).toBe('Run build and test');
    expect(parsed.turns[1]?.text).toBe('All 3 tests passed successfully.');
    expect(parsed.turns[1]?.toolCalls).toBeUndefined();
  });

  it('彻底剥离 local_shell_call, web_search_call, image_generation_call 工具调用，只保留真实正文', () => {
    const lines = [
      JSON.stringify({
        timestamp: '2026-07-02T12:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Generate image and search web' },
          ],
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-02T12:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'local_shell_call',
          call_id: 'call_shell',
          action: {
            exec: {
              command: ['cargo', 'check'],
            },
          },
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-02T12:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'local_shell_call_output',
          call_id: 'call_shell',
          output: 'Finished dev profile in 0.5s',
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-02T12:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'Checked cargo workspace and completed search.',
            },
          ],
        },
      }),
    ].join('\n');

    const parsed = parseCodexRolloutJsonl(lines);
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0]?.text).toBe('Generate image and search web');
    expect(parsed.turns[1]?.text).toBe(
      'Checked cargo workspace and completed search.'
    );
    expect(parsed.turns[1]?.toolCalls).toBeUndefined();
  });

  it('完整捕获深度推理链（包含 summary_text 与 raw_content），并过滤孤立单字噪点', () => {
    const lines = [
      // 孤立单字噪点（如打字中断的 "的"），应被剔除
      JSON.stringify({
        timestamp: '2026-07-02T12:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '的' }],
        },
      }),
      // 真实用户提问
      JSON.stringify({
        timestamp: '2026-07-02T12:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Refactor the tokenizer' }],
        },
      }),
      // event_msg 携带 summary_text 与 raw_content 的深入思考
      JSON.stringify({
        timestamp: '2026-07-02T12:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'Reasoning',
            summary_text: ['Thinking about character boundaries'],
            raw_content: 'We need to handle UTF-8 multibyte characters safely.',
          },
        },
      }),
      // response_item 携带的 reasoning 内容
      JSON.stringify({
        timestamp: '2026-07-02T12:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'reasoning',
          summary: [{ text: 'Checking regex patterns' }],
          content: [{ text: 'Verify edge cases with emoji sequences' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-02T12:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Tokenizer refactored.' }],
        },
      }),
    ].join('\n');

    const parsed = parseCodexRolloutJsonl(lines);
    // 孤立的 "的" 被过滤，仅保留 1 条用户回合 + 1 条助手回合
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0]?.text).toBe('Refactor the tokenizer');
    expect(parsed.title).toBe('Refactor the tokenizer');

    const asst = parsed.turns[1];
    expect(asst?.role).toBe('assistant');
    // 思考内容完整合并，且按顺序呈现
    expect(asst?.thinking).toContain('Thinking about character boundaries');
    expect(asst?.thinking).toContain(
      'We need to handle UTF-8 multibyte characters safely.'
    );
    expect(asst?.thinking).toContain('Checking regex patterns');
    expect(asst?.thinking).toContain('Verify edge cases with emoji sequences');
  });

  it('彻底过滤 "You are Codex, an agent based on GPT-6" 系统提示词，提取第一条人类真实提问作为标题', () => {
    const lines = [
      JSON.stringify({
        timestamp: '2026-07-02T12:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'You are Codex, an agent based on GPT-6. You and the user share one workspace. You have access to bash commands and tools. Always follow instructions...',
            },
          ],
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-02T12:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '# AGENTS.md instructions\n<instructions>Follow conventions</instructions>\n\nBuild a responsive navbar',
            },
          ],
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-02T12:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'Here is the responsive navbar code.',
            },
          ],
        },
      }),
    ].join('\n');

    const parsed = parseCodexRolloutJsonl(lines);
    // 第一条纯系统提示词被彻底丢弃，标题正确取自第一条人类真实提问
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0]?.text).toBe('Build a responsive navbar');
    expect(parsed.title).toBe('Build a responsive navbar');
    expect(parsed.title).not.toContain('You are Codex');
    expect(parsed.title).not.toContain('AGENTS.md');
  });

  it('彻底过滤本地命令回显与 ANSI 控制字符（[2m, [22m 等）', () => {
    const lines = [
      JSON.stringify({
        timestamp: '2026-07-02T12:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '<local-command-caveat>local only</local-command-caveat>[2m/model gpt-5[22m',
            },
          ],
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-02T12:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '[2mExplain binary search[22m',
            },
          ],
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-02T12:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: '[2mBinary search works on sorted arrays.[22m',
            },
          ],
        },
      }),
    ].join('\n');

    const parsed = parseCodexRolloutJsonl(lines);
    // 纯本地控制指令被丢弃，真实对话中的 ANSI 控制符被清除
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0]?.text).toBe('Explain binary search');
    expect(parsed.turns[1]?.text).toBe('Binary search works on sorted arrays.');
    expect(parsed.title).toBe('Explain binary search');
  });
});
