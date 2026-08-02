import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  isParseErr,
  isParseOk,
  parseErr,
  parseOk,
  safeParseApprovalRequest,
  safeParseApprovalResolved,
  safeParseDaemonEvent,
  safeParseRunTerminal,
  safeParseToolCall,
  safeParseToolResult,
  type ParseResult,
} from './engineEventZod';

describe('engineEventZod', () => {
  describe('ParseResult narrowing', () => {
    it('isParseOk / isParseErr are exclusive type guards', () => {
      const ok = parseOk({ n: 1 });
      const err = parseErr('boom');
      expect(isParseOk(ok)).toBe(true);
      expect(isParseErr(ok)).toBe(false);
      expect(isParseOk(err)).toBe(false);
      expect(isParseErr(err)).toBe(true);
    });

    it('isParseOk narrows to data; isParseErr narrows to error', () => {
      const r: ParseResult<{ id: string }> = parseOk({ id: 'x' });
      if (isParseOk(r)) {
        expect(r.data.id).toBe('x');
        expectTypeOf(r.data).toEqualTypeOf<{ id: string }>();
        // ok branch has no error field
        expectTypeOf(r).not.toHaveProperty('error');
      } else {
        expect.fail('expected ok');
      }

      const e: ParseResult<number> = parseErr('  missing  ');
      if (isParseErr(e)) {
        expect(e.error).toBe('missing');
        expectTypeOf(e.error).toEqualTypeOf<string>();
        expectTypeOf(e).not.toHaveProperty('data');
      } else {
        expect.fail('expected err');
      }
    });

    it('parseErr never yields empty error string', () => {
      expect(parseErr('').error).toBe('parse failed');
      expect(parseErr('   ').error).toBe('parse failed');
      expect(parseErr(' real ').error).toBe('real');
    });

    it('safeParse failure path always exposes non-empty error via isParseErr', () => {
      const r = safeParseDaemonEvent(null);
      expect(isParseOk(r)).toBe(false);
      if (isParseErr(r)) {
        expect(r.error.length).toBeGreaterThan(0);
        expect(r.error).toMatch(/not an object|missing type/i);
      }
    });
  });

  describe('safeParseDaemonEvent', () => {
    it('requires an object with type', () => {
      expect(isParseOk(safeParseDaemonEvent(null))).toBe(false);
      expect(isParseOk(safeParseDaemonEvent([]))).toBe(false);
      expect(isParseOk(safeParseDaemonEvent({}))).toBe(false);
      expect(isParseOk(safeParseDaemonEvent({ type: '' }))).toBe(false);
      expect(isParseOk(safeParseDaemonEvent({ type: '   ' }))).toBe(false);
    });

    it('accepts type / event / kind aliases', () => {
      const a = safeParseDaemonEvent({ type: 'tool-start', call: {} });
      expect(isParseOk(a)).toBe(true);
      if (isParseOk(a)) {
        expect(a.data.type).toBe('tool-start');
        expect(a.data.raw.type).toBe('tool-start');
      }

      const b = safeParseDaemonEvent({ event: 'message-delta', text: 'hi' });
      expect(isParseOk(b)).toBe(true);
      if (isParseOk(b)) expect(b.data.type).toBe('message-delta');

      const c = safeParseDaemonEvent({ kind: 'run-terminal' });
      expect(isParseOk(c)).toBe(true);
      if (isParseOk(c)) expect(c.data.type).toBe('run-terminal');
    });

    it('trims type and surfaces concrete error for missing type', () => {
      const ok = safeParseDaemonEvent({ type: '  tool-end  ' });
      expect(isParseOk(ok)).toBe(true);
      if (isParseOk(ok)) expect(ok.data.type).toBe('tool-end');

      const miss = safeParseDaemonEvent({ foo: 1 });
      expect(isParseErr(miss)).toBe(true);
      if (isParseErr(miss)) expect(miss.error).toBe('engine event missing type');
    });
  });

  describe('safeParseToolCall', () => {
    it('requires id and name', () => {
      expect(isParseOk(safeParseToolCall(null))).toBe(false);
      expect(isParseOk(safeParseToolCall({ id: '1' }))).toBe(false);
      expect(isParseOk(safeParseToolCall({ name: 'shell' }))).toBe(false);
      expect(isParseOk(safeParseToolCall({ id: '  ', name: 'shell' }))).toBe(false);
    });

    it('returns concrete error messages on failure', () => {
      const noObj = safeParseToolCall(null);
      if (isParseErr(noObj)) expect(noObj.error).toMatch(/not an object/);
      const noId = safeParseToolCall({ name: 'x' });
      if (isParseErr(noId)) expect(noId.error).toBe('tool-call missing id');
      const noName = safeParseToolCall({ id: '1' });
      if (isParseErr(noName)) expect(noName.error).toBe('tool-call missing name');
    });

    it('normalizes string arguments', () => {
      const ok = safeParseToolCall({
        id: '1',
        name: 'shell',
        arguments: 'echo hi',
      });
      expect(isParseOk(ok)).toBe(true);
      if (isParseOk(ok)) {
        expect(ok.data.id).toBe('1');
        expect(ok.data.name).toBe('shell');
        expect(ok.data.args).toContain('echo');
      }
    });

    it('accepts id/name aliases and object input', () => {
      const ok = safeParseToolCall({
        toolCallId: 'tc-9',
        toolName: 'write_file',
        input: { path: 'a.ts', content: 'x' },
        description: 'write a file',
      });
      expect(isParseOk(ok)).toBe(true);
      if (isParseOk(ok)) {
        expect(ok.data.id).toBe('tc-9');
        expect(ok.data.name).toBe('write_file');
        expect(ok.data.args).toContain('a.ts');
        expect(ok.data.explanation).toBe('write a file');
      }
    });

    it('accepts snake_case tool_call_id / tool_name', () => {
      const ok = safeParseToolCall({
        tool_call_id: 'snake-1',
        tool_name: 'read_file',
        args: '{"path":"b.ts"}',
      });
      expect(isParseOk(ok)).toBe(true);
      if (isParseOk(ok)) {
        expect(ok.data.id).toBe('snake-1');
        expect(ok.data.name).toBe('read_file');
        expect(ok.data.args).toContain('b.ts');
      }
    });

    it('stringifies non-string arguments', () => {
      const ok = safeParseToolCall({
        id: '2',
        name: 'shell',
        arguments: { cmd: 'ls' },
      });
      expect(isParseOk(ok)).toBe(true);
      if (isParseOk(ok)) expect(ok.data.args).toContain('ls');
    });

    it('accepts parameters alias (runtime PermissionRequest shape)', () => {
      const ok = safeParseToolCall({
        id: 'tc-p',
        name: 'shell_command',
        parameters: { command: 'git push origin main' },
      });
      expect(isParseOk(ok)).toBe(true);
      if (isParseOk(ok)) {
        expect(ok.data.args).toContain('git push');
      }
    });

    it('accepts ToolBatchCall shape (toolName + summary + input)', () => {
      const ok = safeParseToolCall({
        id: 'batch-1',
        toolName: 'write_file',
        summary: 'write a.ts',
        input: { path: 'a.ts', content: 'x' },
        category: 'filesystem',
        concurrency: 'exclusive',
      });
      expect(isParseOk(ok)).toBe(true);
      if (isParseOk(ok)) {
        expect(ok.data.id).toBe('batch-1');
        expect(ok.data.name).toBe('write_file');
        expect(ok.data.explanation).toBe('write a.ts');
        expect(ok.data.args).toContain('a.ts');
      }
    });

    it('prefers string arguments over parameters bag', () => {
      const ok = safeParseToolCall({
        id: 'pref',
        name: 'shell',
        arguments: 'echo prefer',
        parameters: { command: 'should-not-win' },
      });
      expect(isParseOk(ok)).toBe(true);
      if (isParseOk(ok)) expect(ok.data.args).toBe('echo prefer');
    });
  });

  describe('safeParseToolResult', () => {
    it('parses basics with toolCallId and output string', () => {
      const ok = safeParseToolResult({
        toolCallId: 'tc-1',
        output: 'done',
      });
      expect(isParseOk(ok)).toBe(true);
      if (isParseOk(ok)) {
        expect(ok.data.id).toBe('tc-1');
        expect(ok.data.text).toBe('done');
        expect(ok.data.isError).toBe(false);
      }
    });

    it('reads output.text and isError', () => {
      const ok = safeParseToolResult({
        id: 'tc-2',
        isError: true,
        output: { text: 'boom' },
      });
      expect(isParseOk(ok)).toBe(true);
      if (isParseOk(ok)) {
        expect(ok.data.id).toBe('tc-2');
        expect(ok.data.text).toBe('boom');
        expect(ok.data.isError).toBe(true);
      }
    });

    it('extracts filePath from nested output and top-level aliases', () => {
      const nested = safeParseToolResult({
        toolCallId: 'tc-3',
        output: { text: 'wrote', path: 'src/a.ts' },
      });
      expect(isParseOk(nested)).toBe(true);
      if (isParseOk(nested)) {
        expect(nested.data.filePath).toBe('src/a.ts');
        expect(nested.data.text).toBe('wrote');
      }

      const top = safeParseToolResult({
        id: 'tc-4',
        filePath: '  top.ts  ',
        text: 'ok',
      });
      expect(isParseOk(top)).toBe(true);
      if (isParseOk(top)) {
        expect(top.data.filePath).toBe('top.ts');
        expect(top.data.text).toBe('ok');
      }

      const nestedFilePath = safeParseToolResult({
        toolCallId: 'tc-5',
        output: { filePath: 'nested/f.ts' },
      });
      expect(isParseOk(nestedFilePath)).toBe(true);
      if (isParseOk(nestedFilePath)) expect(nestedFilePath.data.filePath).toBe('nested/f.ts');
    });

    it('is lenient on non-objects (empty basics)', () => {
      const ok = safeParseToolResult(null);
      expect(isParseOk(ok)).toBe(true);
      if (isParseOk(ok)) {
        expect(ok.data.id).toBe('');
        expect(ok.data.text).toBe('');
        expect(ok.data.isError).toBe(false);
        expect(ok.data.filePath).toBeUndefined();
      }
    });

    it('treats truthy error field as isError and stringifies object error', () => {
      const ok = safeParseToolResult({
        tool_call_id: 'tc-err',
        error: { message: 'EFAIL' },
      });
      expect(isParseOk(ok)).toBe(true);
      if (isParseOk(ok)) {
        expect(ok.data.id).toBe('tc-err');
        expect(ok.data.isError).toBe(true);
        expect(ok.data.text).toContain('EFAIL');
      }
    });
  });

  describe('safeParseApprovalRequest', () => {
    it('requires toolCallId and toolName', () => {
      expect(isParseOk(safeParseApprovalRequest(null))).toBe(false);
      expect(isParseOk(safeParseApprovalRequest({ toolCallId: '1' }))).toBe(false);
      expect(isParseOk(safeParseApprovalRequest({ toolName: 'edit' }))).toBe(false);
    });

    it('parses nested request with parameters (runtime protocol)', () => {
      const ok = safeParseApprovalRequest({
        type: 'approval-requested',
        request: {
          toolCallId: 'tc-ap',
          toolName: 'shell_command',
          parameters: { command: 'git push' },
          summary: 'push branch',
        },
      });
      expect(isParseOk(ok)).toBe(true);
      if (isParseOk(ok)) {
        expect(ok.data.toolCallId).toBe('tc-ap');
        expect(ok.data.toolName).toBe('shell_command');
        expect(ok.data.explanation).toBe('push branch');
        expect(ok.data.parameters).toMatchObject({ command: 'git push' });
        // raw 归一：parameters 与 input 双可见，便于命令抽取
        expect(ok.data.raw.parameters).toMatchObject({ command: 'git push' });
        expect(ok.data.raw.input).toMatchObject({ command: 'git push' });
      }
    });

    it('parses flat daemon WS shape with input (ApprovalRequestedMessage)', () => {
      const ok = safeParseApprovalRequest({
        type: 'approval-requested',
        runId: 'run-1',
        toolCallId: 'tc-flat',
        toolName: 'shell_command',
        input: { command: 'rm -rf /tmp/x' },
        summary: 'delete temp',
        risk: 'high',
        riskReason: 'destructive path',
        requiresDoubleConfirm: true,
        metadata: { trustZone: 'T3' },
      });
      expect(isParseOk(ok)).toBe(true);
      if (isParseOk(ok)) {
        expect(ok.data.toolCallId).toBe('tc-flat');
        expect(ok.data.toolName).toBe('shell_command');
        expect(ok.data.explanation).toBe('delete temp');
        expect(ok.data.parameters).toMatchObject({ command: 'rm -rf /tmp/x' });
        expect(ok.data.raw.parameters).toMatchObject({ command: 'rm -rf /tmp/x' });
      }
    });

    it('accepts requestId / name aliases and falls back explanation to toolName', () => {
      const ok = safeParseApprovalRequest({
        requestId: 'req-alias',
        name: 'edit_file',
      });
      expect(isParseOk(ok)).toBe(true);
      if (isParseOk(ok)) {
        expect(ok.data.toolCallId).toBe('req-alias');
        expect(ok.data.toolName).toBe('edit_file');
        expect(ok.data.explanation).toBe('edit_file');
      }
    });
  });

  describe('safeParseApprovalResolved', () => {
    it('requires toolCallId / requestId', () => {
      expect(isParseOk(safeParseApprovalResolved(null))).toBe(false);
      expect(isParseOk(safeParseApprovalResolved({ decision: 'approved' }))).toBe(false);
      const miss = safeParseApprovalResolved({ decision: 'approved' });
      if (isParseErr(miss)) expect(miss.error).toBe('approval-resolved missing toolCallId');
    });

    it('maps daemon string decisions approved/denied/expired', () => {
      const a = safeParseApprovalResolved({
        type: 'approval-resolved',
        toolCallId: 't1',
        decision: 'approved',
      });
      expect(isParseOk(a)).toBe(true);
      if (isParseOk(a)) {
        expect(a.data.allowed).toBe(true);
        expect(a.data.denied).toBe(false);
        expect(a.data.decision).toBe('allow');
      }

      const d = safeParseApprovalResolved({
        toolCallId: 't2',
        decision: 'denied',
      });
      expect(isParseOk(d)).toBe(true);
      if (isParseOk(d)) {
        expect(d.data.denied).toBe(true);
        expect(d.data.decision).toBe('deny');
      }

      const e = safeParseApprovalResolved({
        toolCallId: 't3',
        decision: 'expired',
      });
      expect(isParseOk(e)).toBe(true);
      if (isParseOk(e)) expect(e.data.denied).toBe(true);
    });

    it('maps nested PermissionDecision.behavior allow/deny/ask', () => {
      const allow = safeParseApprovalResolved({
        type: 'approval-resolved',
        requestId: 'req-1',
        decision: { behavior: 'allow', reason: 'user' },
      });
      expect(isParseOk(allow)).toBe(true);
      if (isParseOk(allow)) {
        expect(allow.data.toolCallId).toBe('req-1');
        expect(allow.data.allowed).toBe(true);
        expect(allow.data.decision).toBe('allow');
      }

      const deny = safeParseApprovalResolved({
        requestId: 'req-2',
        decision: { behavior: 'deny' },
      });
      expect(isParseOk(deny)).toBe(true);
      if (isParseOk(deny)) {
        expect(deny.data.denied).toBe(true);
        expect(deny.data.decision).toBe('deny');
      }

      // ask is not allow — never forge allow
      const ask = safeParseApprovalResolved({
        toolCallId: 'req-ask',
        decision: { behavior: 'Ask' },
      });
      expect(isParseOk(ask)).toBe(true);
      if (isParseOk(ask)) {
        expect(ask.data.allowed).toBe(false);
        expect(ask.data.denied).toBe(true);
        expect(ask.data.decision).toBe('deny');
      }
    });

    it('unknown decision never forges allow', () => {
      const u = safeParseApprovalResolved({
        toolCallId: 't-unk',
        decision: 'maybe',
      });
      expect(isParseOk(u)).toBe(true);
      if (isParseOk(u)) {
        expect(u.data.allowed).toBe(false);
        expect(u.data.denied).toBe(true);
        expect(u.data.decision).toBe('deny');
      }

      const missing = safeParseApprovalResolved({ toolCallId: 't-miss' });
      expect(isParseOk(missing)).toBe(true);
      if (isParseOk(missing)) {
        expect(missing.data.allowed).toBe(false);
        expect(missing.data.denied).toBe(true);
      }
    });

    it('trims and case-folds string decisions', () => {
      const a = safeParseApprovalResolved({
        toolCallId: 't-case',
        decision: '  APPROVED  ',
      });
      expect(isParseOk(a)).toBe(true);
      if (isParseOk(a)) {
        expect(a.data.allowed).toBe(true);
        expect(a.data.decision).toBe('allow');
      }
    });
  });

  describe('safeParseRunTerminal', () => {
    it('marks failed terminals', () => {
      const a = safeParseRunTerminal({ type: 'run-terminal', terminal: 'failed', error: 'boom' });
      expect(isParseOk(a)).toBe(true);
      if (isParseOk(a)) {
        expect(a.data.failed).toBe(true);
        expect(a.data.error).toBe('boom');
      }
      const b = safeParseRunTerminal({ type: 'run-completed', terminal: 'completed' });
      expect(isParseOk(b)).toBe(true);
      if (isParseOk(b)) expect(b.data.failed).toBe(false);
      const c = safeParseRunTerminal({ type: 'run-failed', message: 'nope' });
      expect(isParseOk(c)).toBe(true);
      if (isParseOk(c)) {
        expect(c.data.failed).toBe(true);
        expect(c.data.error).toBe('nope');
      }
    });

    it('treats cancelled / canceled / error as failed; rejects non-objects', () => {
      for (const terminal of ['cancelled', 'canceled', 'error', 'FAILED']) {
        const r = safeParseRunTerminal({ type: 'run-terminal', terminal });
        expect(isParseOk(r)).toBe(true);
        if (isParseOk(r)) expect(r.data.failed).toBe(true);
      }
      expect(isParseOk(safeParseRunTerminal(null))).toBe(false);
      expect(isParseOk(safeParseRunTerminal([]))).toBe(false);
      const bad = safeParseRunTerminal('x');
      if (isParseErr(bad)) expect(bad.error).toMatch(/not an object/);
    });
  });
});
