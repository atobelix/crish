import { describe, it, expect } from 'vitest';
import { sliceContextAtValidBoundary, type LLMMessage } from '../context-slicer';

function msg(role: 'user' | 'assistant' | 'tool' | 'system', text: string, blocks?: any[]): LLMMessage {
  return { role, blocks: blocks ?? [{ type: 'text', text }] };
}
function tc(id: string) {
  return { type: 'tool-call' as const, id, toolName: 'test', input: {} };
}
function tr(toolCallId: string) {
  return { type: 'tool-result' as const, toolCallId, toolName: 'test', output: {}, isError: false };
}

describe('sliceContextAtValidBoundary', () => {
  it('R1: retreats cut to previous complete turn when orphaned tool_result exists at tail', () => {
    // The natural cut at user(q2) would leave tool(tr1) orphaned (no tool-call for id1 in kept suffix).
    // Must retreat to user(q1) — the previous complete turn's user boundary.
    const r = sliceContextAtValidBoundary(
      [
        msg('user', 'q1'),
        msg('assistant', 'a1', [tc('id1')]),
        msg('user', 'q2'),
        msg('tool', 'tr1', [tr('id1')]),
      ],
      15,
      () => 10,
    );
    expect(r.messages).toHaveLength(4);
    expect(r.messages[0]!.role).toBe('user');
    expect(r.messages[1]!.role).toBe('assistant');
    expect(r.foldedCount).toBe(0);
    expect(r.foldedTokens).toBe(0);
  });

  it('R2: returns all messages without truncation when total tokens are within limit', () => {
    const r = sliceContextAtValidBoundary(
      [msg('user', 'q1'), msg('assistant', 'a1')],
      100,
      () => 10,
    );
    expect(r.messages).toHaveLength(2);
    expect(r.foldedCount).toBe(0);
    expect(r.foldedTokens).toBe(0);
  });

  it('R3: always retains system prompt as the first message in the result', () => {
    const r = sliceContextAtValidBoundary(
      [
        msg('system', 'sys'),
        msg('user', 'q1'),
        msg('assistant', 'a1'),
        msg('assistant', 'a2'),
        msg('user', 'q2'),
        msg('assistant', 'a3'),
      ],
      15,
      () => 10,
    );
    expect(r.messages[0]!.role).toBe('system');
    expect(r.messages[1]!.role).toBe('user');
    expect(r.messages[1]!.blocks[0]).toEqual({ type: 'text', text: 'q2' });
    expect(r.messages[2]!.role).toBe('assistant');
    expect(r.foldedCount).toBe(3);
  });

  it('R4: safely returns empty result when input message array is empty', () => {
    const r = sliceContextAtValidBoundary([], 100, () => 10);
    expect(r.messages).toEqual([]);
    expect(r.foldedCount).toBe(0);
    expect(r.foldedTokens).toBe(0);
    expect(r.foldedSummary).toBeUndefined();
  });

  it('R5: correctly truncates nested assistant→tool→assistant→tool chains at user boundary', () => {
    // Long tool chain: q1 → a1(tc1) → tr1 → a2(tc2) → tr2 → q2 → a3(tc3) → tr3 → q3 → a4
    // Must cut at user(q3), folding the entire chain before it
    const r = sliceContextAtValidBoundary(
      [
        msg('user', 'q1'),
        msg('assistant', 'a1', [tc('id1')]),
        msg('tool', 'tr1', [tr('id1')]),
        msg('assistant', 'a2', [tc('id2')]),
        msg('tool', 'tr2', [tr('id2')]),
        msg('user', 'q2'),
        msg('assistant', 'a3', [tc('id3')]),
        msg('tool', 'tr3', [tr('id3')]),
        msg('user', 'q3'),
        msg('assistant', 'a4'),
      ],
      15,
      () => 10,
    );
    // kept = [q3, a4]; folded = [q1, a1, tr1, a2, tr2, q2, a3, tr3]
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0]!.role).toBe('user');
    expect(r.messages[0]!.blocks[0]).toEqual({ type: 'text', text: 'q3' });
    expect(r.foldedCount).toBe(8);
    // All tool-call/tool-result pairs within kept portion are intact
    expect(r.messages[1]!.role).toBe('assistant');
  });

  it('R6: gracefully degrades when tokenEstimator throws an error', () => {
    // tokenEstimator throws → must return all messages unchanged
    const msgs = [msg('user', 'q1'), msg('assistant', 'a1'), msg('user', 'q2')];
    const r = sliceContextAtValidBoundary(msgs, 10, () => {
      throw new Error('token estimation failed');
    });
    expect(r.messages).toHaveLength(3);
    expect(r.foldedCount).toBe(0);
    expect(r.foldedTokens).toBe(0);
  });

  it('R7: correctly processes redundant consecutive assistant messages', () => {
    // Multiple assistant messages without user between them must not cause issues
    const r = sliceContextAtValidBoundary(
      [
        msg('user', 'q1'),
        msg('assistant', 'a1'),
        msg('assistant', 'a2'),
        msg('assistant', 'a3'),
        msg('user', 'q2'),
        msg('assistant', 'a4'),
      ],
      15,
      () => 10,
    );
    // Cut at user(q2); [q1, a1, a2, a3] folded, [q2, a4] kept
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0]!.role).toBe('user');
    expect(r.messages[0]!.blocks[0]).toEqual({ type: 'text', text: 'q2' });
    expect(r.foldedCount).toBe(4);
    expect(r.foldedTokens).toBe(40);
  });

  it('R8: returns foldedSummary when L3 compression activates (no user boundary found)', () => {
    // No user message → degradedSlice → L1/L2 fail → L3 compression
    const r = sliceContextAtValidBoundary(
      [
        msg('assistant', 'first msg'),
        msg('assistant', 'second msg'),
        msg('assistant', 'third msg'),
      ],
      10,
      () => 10,
    );
    expect(r.foldedSummary).toBeDefined();
    expect(typeof r.foldedSummary).toBe('string');
    expect(r.foldedSummary!.length).toBeGreaterThan(0);
    expect(r.foldedSummary).toContain('[assistant]');
    expect(r.foldedCount).toBe(1);
    // The third message is kept alongside the summary
    expect(r.messages[0]!.role).toBe('user');
    expect((r.messages[0]!.blocks[0] as { text: string }).text).toContain('[context slice summary:');
  });
});
