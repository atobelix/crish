import { describe, expect, it } from 'vitest';
import {
  parseToolArgsDeltaEvent,
  TOOL_ARGS_PREVIEW_MAX,
  truncateToolArgsPreview,
} from './partialToolArgs';

describe('truncateToolArgsPreview', () => {
  it('returns empty for nullish / empty', () => {
    expect(truncateToolArgsPreview(null)).toBe('');
    expect(truncateToolArgsPreview(undefined)).toBe('');
    expect(truncateToolArgsPreview('')).toBe('');
  });

  it('passes through short strings unchanged', () => {
    expect(truncateToolArgsPreview('{"a":1}')).toBe('{"a":1}');
    expect(truncateToolArgsPreview('x'.repeat(TOOL_ARGS_PREVIEW_MAX))).toBe(
      'x'.repeat(TOOL_ARGS_PREVIEW_MAX),
    );
  });

  it('truncates at default 500 code points with ellipsis', () => {
    const long = 'a'.repeat(600);
    const out = truncateToolArgsPreview(long);
    expect(out.endsWith('…')).toBe(true);
    expect([...out].length).toBe(TOOL_ARGS_PREVIEW_MAX + 1); // 500 + ellipsis
    expect(out.slice(0, TOOL_ARGS_PREVIEW_MAX)).toBe('a'.repeat(TOOL_ARGS_PREVIEW_MAX));
  });

  it('respects custom max', () => {
    expect(truncateToolArgsPreview('abcdefghij', 4)).toBe('abcd…');
  });

  it('is code-point safe for CJK / emoji (no mid-surrogate cut)', () => {
    const s = '你'.repeat(10) + '😀'.repeat(5);
    const out = truncateToolArgsPreview(s, 12);
    expect(out.endsWith('…')).toBe(true);
    // 10 CJK + 2 emoji = 12 code points before ellipsis
    expect([...out.slice(0, -1)].length).toBe(12);
    expect(out).not.toMatch(/\uD800|\uDFFF/); // no lone surrogates as content expectation via roundtrip
    expect([...out.slice(0, -1)].join('')).toBe('你'.repeat(10) + '😀'.repeat(2));
  });
});

describe('parseToolArgsDeltaEvent', () => {
  it('parses dedicated tool-args-delta', () => {
    const r = parseToolArgsDeltaEvent({
      type: 'tool-args-delta',
      toolCallId: 'tc-1',
      name: 'edit',
      argumentsText: '{"path":"a.ts"',
    });
    expect(r).toEqual({
      toolId: 'tc-1',
      name: 'edit',
      partialArgs: '{"path":"a.ts"',
    });
  });

  it('parses tool-call phase=delta nested toolCall', () => {
    const r = parseToolArgsDeltaEvent({
      type: 'tool-call',
      phase: 'delta',
      toolCall: {
        id: 'c2',
        toolName: 'shell_command',
        argumentsText: '{"command":"ls',
      },
    });
    expect(r).toEqual({
      toolId: 'c2',
      name: 'shell_command',
      partialArgs: '{"command":"ls',
    });
  });

  it('accepts partialArgs / args aliases', () => {
    expect(
      parseToolArgsDeltaEvent({
        type: 'tool-args-delta',
        id: 'x',
        partialArgs: 'p',
      })?.partialArgs,
    ).toBe('p');
    expect(
      parseToolArgsDeltaEvent({
        type: 'tool_args_delta',
        tool_call_id: 'y',
        args: 'q',
      })?.partialArgs,
    ).toBe('q');
  });

  it('returns null without tool id', () => {
    expect(
      parseToolArgsDeltaEvent({
        type: 'tool-args-delta',
        argumentsText: '{}',
      }),
    ).toBeNull();
    expect(parseToolArgsDeltaEvent(null)).toBeNull();
    expect(parseToolArgsDeltaEvent('x')).toBeNull();
  });

  it('ignores ordinary progress tool-update (no args-delta kind)', () => {
    expect(
      parseToolArgsDeltaEvent({
        type: 'tool-update',
        toolCallId: 't1',
        update: { text: 'progress' },
      }),
    ).toBeNull();
  });

  it('parses session-loop production tool-update + metadata.kind tool-args-delta', () => {
    // Exact shape from packages/agent-runtime/src/agent-session-loop.ts
    const r = parseToolArgsDeltaEvent({
      type: 'tool-update',
      sessionId: 'sess-1',
      batchId: 'streaming',
      toolCallId: 'tc-prod',
      update: {
        text: '{"path":"a.ts","old',
        metadata: {
          kind: 'tool-args-delta',
          toolName: 'edit_file',
          argumentsText: '{"path":"a.ts","old',
        },
      },
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    expect(r).toEqual({
      toolId: 'tc-prod',
      name: 'edit_file',
      partialArgs: '{"path":"a.ts","old',
    });
  });

  it('falls back to update.text when metadata.argumentsText missing on args-delta', () => {
    const r = parseToolArgsDeltaEvent({
      type: 'tool-update',
      toolCallId: 'tc-text',
      update: {
        text: '{"cmd":',
        metadata: { kind: 'tool-args-delta', toolName: 'shell' },
      },
    });
    expect(r).toEqual({
      toolId: 'tc-text',
      name: 'shell',
      partialArgs: '{"cmd":',
    });
  });

  it('returns null for tool-update args-delta without toolCallId', () => {
    expect(
      parseToolArgsDeltaEvent({
        type: 'tool-update',
        update: {
          text: '{}',
          metadata: { kind: 'tool-args-delta', argumentsText: '{}' },
        },
      }),
    ).toBeNull();
  });

  it('allows empty partialArgs when id present on dedicated type', () => {
    const r = parseToolArgsDeltaEvent({
      type: 'tool-args-delta',
      toolCallId: 'tc-empty',
      name: 'write',
      argumentsText: '',
    });
    expect(r).toEqual({
      toolId: 'tc-empty',
      name: 'write',
      partialArgs: '',
    });
  });
});
