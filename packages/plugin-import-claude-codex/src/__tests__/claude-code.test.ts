import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseClaudeCodeJsonl } from '../parse/claude-code';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(
  join(__dirname, '__fixtures__/claude-code-sample.jsonl'),
  'utf8'
);

describe('parseClaudeCodeJsonl', () => {
  it('解析 user/assistant 轮、自定义标题，并彻底排除外部工具调用以保持纯净', () => {
    const parsed = parseClaudeCodeJsonl(fixture, {
      sourceSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });

    expect(parsed.source).toBe('claude-code');
    expect(parsed.sourceSessionId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(parsed.title).toBe('Demo layout walkthrough');
    expect(parsed.cwd).toBe('C:\\Software\\demo-project');
    expect(parsed.createdAtMs).toBe(Date.parse('2026-07-01T10:00:00.000Z'));

    // 纯粹只保留用户提问与 AI 思考/正文，彻底不导入外部工具调用
    expect(parsed.turns.length).toBeGreaterThanOrEqual(2);
    expect(parsed.turns[0]).toMatchObject({
      role: 'user',
      text: 'Please explain the folder layout briefly.',
    });

    const asstTurn = parsed.turns[1];
    expect(asstTurn?.role).toBe('assistant');
    expect(asstTurn?.thinking).toContain('layout overview');
    expect(asstTurn?.text).toContain('list the top-level');
    // 验证彻底不挂载外部工具
    expect(asstTurn?.toolCalls).toBeUndefined();
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

  it('彻底忽略外部工具调用与 tool_result，只保留用户提问与 AI 正文', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        uuid: 'u-1',
        timestamp: '2026-07-01T10:00:00.000Z',
        message: { role: 'user', content: 'Search and inspect files' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a-1',
        timestamp: '2026-07-01T10:00:01.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool_glob_1',
              name: 'GlobTool',
              input: { pattern: '**/*.ts' },
            },
            {
              type: 'tool_use',
              id: 'tool_edit_1',
              name: 'FileEdit',
              input: { path: 'src/main.ts', old_str: 'foo', new_str: 'bar' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'u-tool-results',
        timestamp: '2026-07-01T10:00:02.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_glob_1',
              content: '["src/main.ts", "src/util.ts"]',
            },
            {
              type: 'tool_result',
              tool_use_id: 'tool_edit_1',
              content: 'File not found on disk',
              is_error: true,
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a-2',
        timestamp: '2026-07-01T10:00:03.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'I found the files but main.ts edit failed.',
            },
          ],
        },
      }),
    ].join('\n');

    const parsed = parseClaudeCodeJsonl(lines);
    // 纯粹提取有效对话：用户提问 -> AI 回复正文（无实质内容的中间 tool_use 轮被过滤，不留空白气泡）
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0]).toMatchObject({
      role: 'user',
      text: 'Search and inspect files',
    });
    expect(parsed.turns[1]).toMatchObject({
      role: 'assistant',
      text: 'I found the files but main.ts edit failed.',
    });
    expect(parsed.turns[1]?.toolCalls).toBeUndefined();
  });

  it('过滤孤立单字噪点与 environment_context 样板文本', () => {
    const lines = [
      // 孤立噪点
      JSON.stringify({
        type: 'user',
        uuid: 'u-noise',
        timestamp: '2026-07-01T10:00:00.000Z',
        message: { role: 'user', content: '的' },
      }),
      // 包含 <environment_context> 的真实提问
      JSON.stringify({
        type: 'user',
        uuid: 'u-valid',
        timestamp: '2026-07-01T10:00:01.000Z',
        message: {
          role: 'user',
          content:
            '<environment_context cwd="/home">\nUser session\n</environment_context>\n\nWrite a greeting function',
        },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a-valid',
        timestamp: '2026-07-01T10:00:02.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'export function hello() { return "hello"; }',
            },
          ],
        },
      }),
    ].join('\n');

    const parsed = parseClaudeCodeJsonl(lines);
    // 噪点过滤后，仅剩 1 条 user + 1 条 assistant
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0]?.text).toBe('Write a greeting function');
    expect(parsed.title).toBe('Write a greeting function');
  });

  it('彻底过滤本地命令样板（<local-command-...>）、ANSI 控制字符及 /model 等内部命令，不留空白气泡', () => {
    const lines = [
      // 本地命令 subtype
      JSON.stringify({
        type: 'system',
        subtype: 'local_command',
        content:
          '<local-command-caveat>Caveat text</local-command-caveat><command-name>/model</command-name><command-message>Switching model</command-message>',
      }),
      // 用户输入内部 /model 指令与 ANSI 字符
      JSON.stringify({
        type: 'user',
        uuid: 'u-local-cmd',
        timestamp: '2026-07-01T10:00:01.000Z',
        message: {
          role: 'user',
          content:
            '[2m/model claude-3-5-sonnet[22m\n<command-message>Done</command-message>',
        },
      }),
      // 真实对话
      JSON.stringify({
        type: 'user',
        uuid: 'u-real',
        timestamp: '2026-07-01T10:00:02.000Z',
        message: {
          role: 'user',
          content:
            '<local-command-caveat>warning</local-command-caveat>[2mExplain quicksort algorithm[22m',
        },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a-real',
        timestamp: '2026-07-01T10:00:03.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '[2mQuicksort is a divide-and-conquer algorithm.[22m',
            },
          ],
        },
      }),
    ].join('\n');

    const parsed = parseClaudeCodeJsonl(lines);
    // 前面只有纯本地命令的行被彻底丢弃，只保留真实对话
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0]?.text).toBe('Explain quicksort algorithm');
    expect(parsed.turns[1]?.text).toBe(
      'Quicksort is a divide-and-conquer algorithm.'
    );
    expect(parsed.title).toBe('Explain quicksort algorithm');
  });

  it('会话标题与消息严格排除系统提示词与 Agent 设定', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        uuid: 'u-sys-prompt',
        timestamp: '2026-07-01T10:00:00.000Z',
        message: {
          role: 'user',
          content:
            "You are Claude Code, Anthropic's official CLI for agentic coding. You have tools...",
        },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'u-first-human',
        timestamp: '2026-07-01T10:00:01.000Z',
        message: {
          role: 'user',
          content:
            '# CLAUDE.md instructions\n<instructions>Follow conventions</instructions>\n\nCreate a login page',
        },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a-1',
        timestamp: '2026-07-01T10:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Here is the login page code.' }],
        },
      }),
    ].join('\n');

    const parsed = parseClaudeCodeJsonl(lines);
    // 第一条纯系统提示词被丢弃，标题正确取自第一条人类真实提问
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0]?.text).toBe('Create a login page');
    expect(parsed.title).toBe('Create a login page');
    expect(parsed.title).not.toContain('You are Claude');
    expect(parsed.title).not.toContain('CLAUDE.md');
  });
});
