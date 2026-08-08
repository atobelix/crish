import { describe, expect, it } from 'vitest';
import {
  blockText,
  mergeAssistantTextPiece,
  messageBelongsToRun,
  normalizeStreamSessionId,
  parseApprovalResolvedFields,
  resolveEventType,
  toolCallFields,
  toolCallFieldsFromEvent,
  toolResultFields,
} from './chatBridge';
import { isParseErr, isParseOk } from './engineEventSchema';

describe('normalizeStreamSessionId (empty session safety)', () => {
  it('keeps non-empty trimmed session ids', () => {
    expect(normalizeStreamSessionId('sess-abc')).toBe('sess-abc');
    expect(normalizeStreamSessionId('  real-id  ')).toBe('real-id');
  });

  it('synthesizes id for empty / whitespace / non-string', () => {
    const a = normalizeStreamSessionId('');
    const b = normalizeStreamSessionId('   ');
    const c = normalizeStreamSessionId(null);
    const d = normalizeStreamSessionId(undefined);
    const e = normalizeStreamSessionId(42);
    for (const id of [a, b, c, d, e]) {
      expect(id).toMatch(/^sess-[a-z0-9]+-[a-z0-9]+$/i);
      expect(id.trim().length).toBeGreaterThan(0);
    }
  });

  it('never returns blank after trim', () => {
    expect(normalizeStreamSessionId('\t\n').trim()).not.toBe('');
  });
});

describe('messageBelongsToRun (event guards)', () => {
  const local = 'run-local-1';

  it('accepts missing / null / blank runId as broadcast', () => {
    expect(messageBelongsToRun(undefined, local)).toBe(true);
    expect(messageBelongsToRun(null, local)).toBe(true);
    expect(messageBelongsToRun('', local)).toBe(true);
    expect(messageBelongsToRun('   ', local)).toBe(true);
  });

  it('accepts matching runId (trims)', () => {
    expect(messageBelongsToRun(local, local)).toBe(true);
    expect(messageBelongsToRun(`  ${local}  `, local)).toBe(true);
  });

  it('rejects foreign non-empty runId', () => {
    expect(messageBelongsToRun('run-other', local)).toBe(false);
    expect(messageBelongsToRun(123, local)).toBe(false);
  });
});

describe('resolveEventType (event guards)', () => {
  it('rejects null / array / non-object / empty type', () => {
    expect(resolveEventType(null)).toBeNull();
    expect(resolveEventType(undefined)).toBeNull();
    expect(resolveEventType([])).toBeNull();
    expect(resolveEventType('tool-start')).toBeNull();
    expect(resolveEventType({})).toBeNull();
    expect(resolveEventType({ type: '' })).toBeNull();
    expect(resolveEventType({ type: '   ' })).toBeNull();
  });

  it('resolves type / event / kind aliases', () => {
    expect(resolveEventType({ type: 'tool-start' })?.type).toBe('tool-start');
    expect(resolveEventType({ event: 'message-delta', text: 'x' })?.type).toBe('message-delta');
    expect(resolveEventType({ kind: 'run-terminal' })?.type).toBe('run-terminal');
  });

  it('returns raw payload for field access', () => {
    const raw = { type: 'text-delta', text: 'hi' };
    const env = resolveEventType(raw);
    expect(env).not.toBeNull();
    expect(env!.raw.text).toBe('hi');
  });
});

describe('parseApprovalResolvedFields (ok === false narrow)', () => {
  it('fails with non-empty error when payload invalid (ok === false)', () => {
    const miss = parseApprovalResolvedFields(null);
    expect(isParseOk(miss)).toBe(false);
    expect(isParseErr(miss)).toBe(true);
    if (miss.ok === false) {
      expect(miss.error.length).toBeGreaterThan(0);
    }

    const noId = parseApprovalResolvedFields({ decision: 'approved' });
    expect(noId.ok === false).toBe(true);
    if (noId.ok === false) {
      expect(noId.error).toMatch(/toolCallId|not an object|parse/i);
    }
  });

  it('maps approved/allow string decisions', () => {
    const a = parseApprovalResolvedFields({
      type: 'approval-resolved',
      toolCallId: 't1',
      decision: 'approved',
    });
    expect(a.ok === true).toBe(true);
    if (a.ok === true) {
      expect(a.data.toolCallId).toBe('t1');
      expect(a.data.denied).toBe(false);
      expect(a.data.decision).toBe('allow');
    }

    const allow = parseApprovalResolvedFields({
      toolCallId: 't2',
      decision: 'allow',
    });
    expect(allow.ok === true).toBe(true);
    if (allow.ok === true) expect(allow.data.decision).toBe('allow');
  });

  it('maps denied/expired/unknown to deny (never forge allow)', () => {
    for (const decision of ['denied', 'expired', 'deny', 'weird', '']) {
      const r = parseApprovalResolvedFields({ toolCallId: 'x', decision });
      expect(r.ok === true).toBe(true);
      if (r.ok === true) {
        expect(r.data.denied).toBe(true);
        expect(r.data.decision).toBe('deny');
      }
    }

    const missingDecision = parseApprovalResolvedFields({ toolCallId: 'y' });
    expect(missingDecision.ok === true).toBe(true);
    if (missingDecision.ok === true) {
      expect(missingDecision.data.decision).toBe('deny');
    }
  });

  it('maps nested PermissionDecision.behavior and requestId alias', () => {
    const allow = parseApprovalResolvedFields({
      requestId: 'req-1',
      decision: { behavior: 'allow' },
    });
    expect(allow.ok === true).toBe(true);
    if (allow.ok === true) {
      expect(allow.data.toolCallId).toBe('req-1');
      expect(allow.data.decision).toBe('allow');
    }

    const deny = parseApprovalResolvedFields({
      toolCallId: 'req-2',
      decision: { behavior: 'deny' },
    });
    expect(deny.ok === true).toBe(true);
    if (deny.ok === true) expect(deny.data.denied).toBe(true);

    // ask is not allow
    const ask = parseApprovalResolvedFields({
      toolCallId: 'req-ask',
      decision: { behavior: 'ask' },
    });
    expect(ask.ok === true).toBe(true);
    if (ask.ok === true) expect(ask.data.decision).toBe('deny');
  });

  it('trims toolCallId and rejects whitespace-only id', () => {
    const ok = parseApprovalResolvedFields({
      toolCallId: '  tc-1  ',
      decision: 'approved',
    });
    expect(ok.ok === true).toBe(true);
    if (ok.ok === true) expect(ok.data.toolCallId).toBe('tc-1');

    const blank = parseApprovalResolvedFields({
      toolCallId: '   ',
      decision: 'approved',
    });
    expect(blank.ok === false).toBe(true);
  });
});

describe('blockText', () => {
  it('reads text / content; rejects non-objects', () => {
    expect(blockText({ text: 'a' })).toBe('a');
    expect(blockText({ content: 'b' })).toBe('b');
    expect(blockText({ text: 'a', content: 'b' })).toBe('a');
    expect(blockText(null)).toBe('');
    expect(blockText([])).toBe('');
    expect(blockText('x')).toBe('');
  });
});

describe('toolCallFields / toolCallFieldsFromEvent', () => {
  it('parses id + name aliases', () => {
    const f = toolCallFields({ id: 'c1', name: 'bash', arguments: 'ls' });
    expect(f.id).toBe('c1');
    expect(f.name).toBe('bash');
    expect(f.args).toBe('ls');
  });

  it('uses toolName / toolCallId aliases', () => {
    const f = toolCallFields({ toolCallId: 'tc', toolName: 'edit_file', input: { path: 'a' } });
    expect(f.id).toBe('tc');
    expect(f.name).toBe('edit_file');
    expect(f.args).toContain('path');
  });

  it('prefers nested call on tool-start event; falls back to top-level', () => {
    const fromNested = toolCallFieldsFromEvent({
      type: 'tool-start',
      call: { id: 'n1', name: 'read', args: '{}' },
    });
    expect(fromNested.id).toBe('n1');
    expect(fromNested.name).toBe('read');

    const flat = toolCallFieldsFromEvent({
      type: 'tool-start',
      id: 'flat-1',
      name: 'write',
    });
    expect(flat.id).toBe('flat-1');
    expect(flat.name).toBe('write');
  });

  it('falls back when nested call is incomplete', () => {
    const f = toolCallFieldsFromEvent({
      call: { id: 'only-id' },
      id: 'top-id',
      name: 'top-tool',
    });
    // incomplete nested → top wins when top has real name
    expect(f.id).toBe('top-id');
    expect(f.name).toBe('top-tool');
  });
});

describe('toolResultFields', () => {
  it('reads id / text / isError / structured diffs', () => {
    const r = toolResultFields({
      id: 'r1',
      output: 'ok',
      isError: false,
      diffs: [{ filePath: 'a.ts', additions: 1, deletions: 0, changes: [] }],
    });
    expect(r.id).toBe('r1');
    expect(r.text).toBe('ok');
    expect(r.isError).toBe(false);
    expect(r.diffs?.length).toBe(1);
  });

  it('marks error and prefers toolCallId', () => {
    const r = toolResultFields({
      toolCallId: 'tc-err',
      isError: true,
      output: 'boom',
    });
    expect(r.id).toBe('tc-err');
    expect(r.isError).toBe(true);
    expect(r.text).toBe('boom');
  });

  it('does not invent diffs without git headers', () => {
    const r = toolResultFields({ id: 'x', output: 'plain text', path: 'a.ts' });
    expect(r.diffs).toBeUndefined();
    expect(r.filePath).toBe('a.ts');
  });

  it('parses unified diff text when not error', () => {
    const text = 'diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n';
    const r = toolResultFields({ id: 'd1', output: text, isError: false });
    expect(r.diffs && r.diffs.length > 0).toBe(true);
  });

  it('handles non-object result safely', () => {
    const r = toolResultFields(null);
    expect(r.id).toBe('');
    expect(r.isError).toBe(false);
  });
});

describe('mergeAssistantTextPiece', () => {
  it('keeps prior on empty piece; uses piece when prior empty', () => {
    expect(mergeAssistantTextPiece('hello', '')).toBe('hello');
    expect(mergeAssistantTextPiece('hello', '   ')).toBe('hello');
    expect(mergeAssistantTextPiece('', 'world')).toBe('world');
  });

  it('prefers longer overlapping full text', () => {
    expect(mergeAssistantTextPiece('ab', 'abc')).toBe('abc');
    expect(mergeAssistantTextPiece('abc', 'bc')).toBe('abc');
    expect(mergeAssistantTextPiece('same', 'same')).toBe('same');
  });

  it('distinct non-overlapping pieces: final-text authoritative (no blank-line join, G3)', () => {
    // 终态权威语义（04 §5.1-2）：增量累积与终稿不一致时以终稿 p 为准，
    // 不再 `\n\n` 拼接（消灭 R1「增量版+终稿版」两段共存）；
    // 多轮（跨 turn）分段由 onMessageEnd 按 turnIndex 段数组 join 负责
    expect(mergeAssistantTextPiece('first turn', 'second turn')).toBe(
      'second turn',
    );
  });
});
