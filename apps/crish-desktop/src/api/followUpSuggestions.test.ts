import { describe, expect, it } from 'vitest';
import {
  buildFollowUpSuggestions,
  shouldShowFollowUpSuggestions,
} from './followUpSuggestions';
import type { MessageToolCall } from '../store/layoutStore';

function tc(
  partial: Partial<MessageToolCall> &
    Pick<MessageToolCall, 'id' | 'name' | 'status'>
): MessageToolCall {
  return {
    arguments: '',
    ...partial,
  };
}

describe('shouldShowFollowUpSuggestions', () => {
  const doneTools = [tc({ id: '1', name: 'run_command', status: 'success' })];

  it('shows only on last completed assistant with terminal tools', () => {
    expect(
      shouldShowFollowUpSuggestions({
        isLastAssistant: true,
        isThinkingMsg: false,
        status: 'completed',
        toolCalls: doneTools,
      })
    ).toBe(true);
  });

  it('hides while streaming / processing / not last', () => {
    expect(
      shouldShowFollowUpSuggestions({
        isLastAssistant: true,
        isThinkingMsg: true,
        status: 'processing',
        toolCalls: doneTools,
      })
    ).toBe(false);
    expect(
      shouldShowFollowUpSuggestions({
        isLastAssistant: true,
        isThinkingMsg: false,
        status: 'processing',
        toolCalls: doneTools,
      })
    ).toBe(false);
    expect(
      shouldShowFollowUpSuggestions({
        isLastAssistant: false,
        isThinkingMsg: false,
        status: 'completed',
        toolCalls: doneTools,
      })
    ).toBe(false);
  });

  it('hides when tools still open or no tools', () => {
    expect(
      shouldShowFollowUpSuggestions({
        isLastAssistant: true,
        isThinkingMsg: false,
        status: 'completed',
        toolCalls: [tc({ id: '1', name: 'shell', status: 'running' })],
      })
    ).toBe(false);
    expect(
      shouldShowFollowUpSuggestions({
        isLastAssistant: true,
        isThinkingMsg: false,
        status: 'completed',
        toolCalls: [
          tc({ id: '1', name: 'shell', status: 'success' }),
          tc({ id: '2', name: 'edit', status: 'pending_approval' }),
        ],
      })
    ).toBe(false);
    expect(
      shouldShowFollowUpSuggestions({
        isLastAssistant: true,
        isThinkingMsg: false,
        status: 'completed',
        toolCalls: [],
      })
    ).toBe(false);
  });

  it('respects dismissed flag', () => {
    expect(
      shouldShowFollowUpSuggestions({
        isLastAssistant: true,
        isThinkingMsg: false,
        status: 'completed',
        toolCalls: doneTools,
        dismissed: true,
      })
    ).toBe(false);
  });

  it('hides for subagent sessions (DEC-07 physical isolation)', () => {
    expect(
      shouldShowFollowUpSuggestions({
        isLastAssistant: true,
        isThinkingMsg: false,
        status: 'completed',
        toolCalls: doneTools,
        isSubagent: true,
      })
    ).toBe(false);
  });
});

describe('buildFollowUpSuggestions', () => {
  it('returns at most 3 items and never empty when tools succeeded', () => {
    const list = buildFollowUpSuggestions({
      toolCalls: [
        tc({ id: 'a', name: 'search_replace', status: 'success', diffs: [] }),
        tc({ id: 'b', name: 'run_command', status: 'success' }),
      ],
      text: 'done',
    });
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.length).toBeLessThanOrEqual(3);
    for (const s of list) {
      expect(s.label.trim().length).toBeGreaterThan(0);
      expect(s.prompt.trim().length).toBeGreaterThan(0);
      expect(s.id).toBeTruthy();
    }
  });

  it('prefers diagnose chips when tools errored', () => {
    const list = buildFollowUpSuggestions({
      toolCalls: [
        tc({ id: 'e', name: 'run_command', status: 'error', output: 'fail' }),
      ],
    });
    expect(list.some((s) => s.id === 'diagnose-error')).toBe(true);
  });

  it('returns empty without tools (no timeline pollution source)', () => {
    expect(buildFollowUpSuggestions({ toolCalls: [], text: 'hi' })).toEqual([]);
  });

  it('dedupes by id/prompt', () => {
    const list = buildFollowUpSuggestions({
      toolCalls: [
        tc({ id: '1', name: 'write_file', status: 'success' }),
        tc({ id: '2', name: 'apply_patch', status: 'success' }),
      ],
    });
    const ids = list.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
