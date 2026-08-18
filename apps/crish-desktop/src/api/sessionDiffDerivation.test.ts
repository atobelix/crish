import { describe, expect, it } from 'vitest';
import { selectSessionDiffFiles } from './sessionDiffDerivation';
import type { SessionMessage } from '../store/types';

describe('selectSessionDiffFiles 纯函数派生', () => {
  it('空消息列表或未定义时返回空数组', () => {
    expect(selectSessionDiffFiles(undefined)).toEqual([]);
    expect(selectSessionDiffFiles([])).toEqual([]);
  });

  it('无文件工具调用的消息返回空数组', () => {
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        sender: 'user',
        text: 'hello',
        timestamp: 1000,
      },
      {
        id: 'msg-2',
        sender: 'assistant',
        text: 'hi',
        timestamp: 1001,
        toolCalls: [
          {
            id: 'tc-1',
            name: 'search_web',
            status: 'success',
            arguments: JSON.stringify({ query: 'conex' }),
          },
        ],
      },
    ];
    expect(selectSessionDiffFiles(messages)).toEqual([]);
  });

  it('正确派生 write_file 与 replace_file_content 变更产物', () => {
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        sender: 'assistant',
        text: 'writing file',
        timestamp: 1000,
        toolCalls: [
          {
            id: 'tc-1',
            name: 'write_file',
            status: 'success',
            arguments: JSON.stringify({
              TargetFile: 'src/index.ts',
              additions: 10,
            }),
          },
          {
            id: 'tc-2',
            name: 'replace_file_content',
            status: 'success',
            arguments: JSON.stringify({
              TargetFile: 'README.md',
              additions: 5,
              deletions: 2,
            }),
          },
        ],
      },
    ];

    const diffs = selectSessionDiffFiles(messages);
    expect(diffs).toHaveLength(2);
    expect(diffs[0]).toEqual({
      filePath: 'src/index.ts',
      gitStatus: 'A',
      additions: 10,
      deletions: 0,
      changes: [],
    });
    expect(diffs[1]).toEqual({
      filePath: 'README.md',
      gitStatus: 'M',
      additions: 5,
      deletions: 2,
      changes: [],
    });
  });

  it('多轮对话中累加同一文件的修改统计', () => {
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        sender: 'assistant',
        text: 'first edit',
        timestamp: 1000,
        toolCalls: [
          {
            id: 'tc-1',
            name: 'write_file',
            status: 'success',
            arguments: JSON.stringify({
              target_file: 'docs/test.md',
              additions: 20,
            }),
          },
        ],
      },
      {
        id: 'msg-2',
        sender: 'assistant',
        text: 'second edit',
        timestamp: 1001,
        toolCalls: [
          {
            id: 'tc-2',
            name: 'replace_file_content',
            status: 'success',
            arguments: JSON.stringify({
              target_file: 'docs/test.md',
              additions: 10,
              deletions: 5,
            }),
          },
        ],
      },
    ];

    const diffs = selectSessionDiffFiles(messages);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.filePath).toBe('docs/test.md');
    expect(diffs[0]?.gitStatus).toBe('A');
    expect(diffs[0]?.additions).toBe(30);
    expect(diffs[0]?.deletions).toBe(5);
  });

  it('Windows 反斜杠路径全量 Posix 归一化，避免重复分裂', () => {
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        sender: 'assistant',
        text: 'edit windows path',
        timestamp: 1000,
        toolCalls: [
          {
            id: 'tc-1',
            name: 'write_file',
            status: 'success',
            arguments: JSON.stringify({
              target_file: 'src\\components\\App.tsx',
              additions: 15,
            }),
          },
          {
            id: 'tc-2',
            name: 'replace_file_content',
            status: 'success',
            arguments: JSON.stringify({
              target_file: 'src/components/App.tsx',
              additions: 5,
              deletions: 3,
            }),
          },
        ],
      },
    ];

    const diffs = selectSessionDiffFiles(messages);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.filePath).toBe('src/components/App.tsx');
    expect(diffs[0]?.additions).toBe(20);
    expect(diffs[0]?.deletions).toBe(3);
  });

  it('严格守卫：拦截 status 为 error, cancelled, rejected, aborted 或包含 error 的脏 ToolCall', () => {
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        sender: 'assistant',
        text: 'failed write',
        timestamp: 1000,
        toolCalls: [
          {
            id: 'tc-1',
            name: 'write_file',
            status: 'error',
            error: 'Permission denied',
            arguments: JSON.stringify({
              target_file: 'forbidden.txt',
              additions: 100,
            }),
          },
          {
            id: 'tc-2',
            name: 'edit_file',
            status: 'cancelled',
            arguments: JSON.stringify({
              target_file: 'cancelled.txt',
              additions: 50,
            }),
          },
          {
            id: 'tc-3',
            name: 'write_file',
            status: 'rejected',
            arguments: JSON.stringify({
              target_file: 'rejected.txt',
              additions: 20,
            }),
          },
          {
            id: 'tc-4',
            name: 'replace_file_content',
            status: 'aborted',
            arguments: JSON.stringify({
              target_file: 'aborted.txt',
              additions: 10,
            }),
          },
        ],
      },
    ];

    const diffs = selectSessionDiffFiles(messages);
    expect(diffs).toHaveLength(0);
  });

  it('切除前导斜杠并成功剥离 Windows 工作区前缀 (/C:/repo/src/App.tsx -> src/App.tsx)', () => {
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        sender: 'assistant',
        text: 'write unix style windows path',
        timestamp: 1000,
        toolCalls: [
          {
            id: 'tc-1',
            name: 'write_file',
            status: 'success',
            arguments: JSON.stringify({
              target_file: '/C:/Software/conex/src/App.tsx',
              code_content: 'import React from "react";\nexport const App = () => null;',
            }),
          },
        ],
      },
    ];

    const diffs = selectSessionDiffFiles(messages, 'C:/Software/conex');
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.filePath).toBe('src/App.tsx');
    expect(diffs[0]?.additions).toBe(2);
  });

  it('支持 write_to_file 与 tc.function?.name 兼容结构', () => {
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        sender: 'assistant',
        text: 'function call',
        timestamp: 1000,
        toolCalls: [
          {
            id: 'tc-1',
            function: {
              name: 'write_to_file',
            },
            status: 'success',
            arguments: JSON.stringify({
              TargetFile: 'new-file.ts',
              additions: 8,
            }),
          } as any,
        ],
      },
    ];

    const diffs = selectSessionDiffFiles(messages);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.filePath).toBe('new-file.ts');
    expect(diffs[0]?.gitStatus).toBe('A');
    expect(diffs[0]?.additions).toBe(8);
  });

  it('支持 OpenAI 格式 function.arguments 与 Windows 盘符小写归一化及工作区前缀剥离', () => {
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        sender: 'assistant',
        text: 'openai style',
        timestamp: 1000,
        toolCalls: [
          {
            id: 'tc-1',
            type: 'function',
            function: {
              name: 'write_to_file',
              arguments: JSON.stringify({
                TargetFile: 'C:\\Software\\conex\\src\\main.ts',
                CodeContent: 'line1\nline2\nline3',
              }),
            },
            status: 'success',
          } as any,
          {
            id: 'tc-2',
            name: 'replace_file_content',
            status: 'success',
            arguments: JSON.stringify({
              TargetFile: 'C:/Software/conex/src/main.ts',
              TargetContent: 'old1\nold2',
              ReplacementContent: 'new1\nnew2\nnew3\nnew4',
            }),
          },
        ],
      },
    ];

    const diffs = selectSessionDiffFiles(messages, 'c:/Software/conex');
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.filePath).toBe('src/main.ts');
    expect(diffs[0]?.gitStatus).toBe('A');
    expect(diffs[0]?.additions).toBe(7); // 3 from write + 4 from replace
    expect(diffs[0]?.deletions).toBe(2); // 2 from replace
  });

  it('支持 multi_replace_file_content ReplacementChunks 行数累加', () => {
    const messages: SessionMessage[] = [
      {
        id: 'msg-1',
        sender: 'assistant',
        text: 'multi replace',
        timestamp: 1000,
        toolCalls: [
          {
            id: 'tc-1',
            name: 'multi_replace_file_content',
            status: 'success',
            arguments: JSON.stringify({
              TargetFile: 'src/utils.ts',
              ReplacementChunks: [
                { TargetContent: 'a\nb', ReplacementContent: 'x\ny\nz' },
                { TargetContent: 'c', ReplacementContent: 'w' },
              ],
            }),
          },
        ],
      },
    ];

    const diffs = selectSessionDiffFiles(messages);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.filePath).toBe('src/utils.ts');
    expect(diffs[0]?.additions).toBe(4); // 3 + 1
    expect(diffs[0]?.deletions).toBe(3); // 2 + 1
  });
});
