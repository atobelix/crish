import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@crish/shared-types';
import { includeRequiredToolCallMessages } from './compression-utils';

describe('compression-utils', () => {
  it('should keep tool_call + tool_result pairs atomic', () => {
    const messages: AgentMessage[] = [
      { id: 'm0', role: 'user', createdAt: '2026-01-01T00:00:00Z', blocks: [{ type: 'text', text: 'Request' }] },
      {
        id: 'm1',
        role: 'assistant',
        createdAt: '2026-01-01T00:00:00Z',
        blocks: [
          { type: 'tool-call', id: 'tc-1', toolName: 'read_file', input: {} },
        ],
      },
      {
        id: 'm2',
        role: 'user',
        createdAt: '2026-01-01T00:00:00Z',
        blocks: [
          { type: 'tool-result', toolCallId: 'tc-1', toolName: 'read_file', isError: false, output: { text: 'content' } },
        ],
      },
      { id: 'm3', role: 'assistant', createdAt: '2026-01-01T00:00:00Z', blocks: [{ type: 'text', text: 'Done' }] },
    ];

    // Starting at kept index 2 (tool-result) pulls kept index back to 1 (tool-call)
    const resultIndex = includeRequiredToolCallMessages(messages, 2);
    expect(resultIndex).toBe(1);
  });

  it('should prevent orphan tool_result', () => {
    const messages: AgentMessage[] = [
      { id: 'm0', role: 'user', createdAt: '2026-01-01T00:00:00Z', blocks: [{ type: 'text', text: 'Init' }] },
      {
        id: 'm1',
        role: 'user',
        createdAt: '2026-01-01T00:00:00Z',
        blocks: [
          { type: 'tool-result', toolCallId: 'non-existent-call-id', toolName: 'unknown', isError: false, output: { text: 'orphan' } },
        ],
      },
      { id: 'm2', role: 'assistant', createdAt: '2026-01-01T00:00:00Z', blocks: [{ type: 'text', text: 'Response' }] },
    ];

    // Missing tool-call causes fallback to 0 to prevent orphan tool_result
    const resultIndex = includeRequiredToolCallMessages(messages, 1);
    expect(resultIndex).toBe(0);
  });
});
