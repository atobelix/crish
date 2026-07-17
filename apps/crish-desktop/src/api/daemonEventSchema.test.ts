import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  extractApprovalCommandArgs,
  isParseErr,
  isParseOk,
  parseDaemonEnvelope,
  parseErr,
  parseOk,
  parseToolCallFields,
  type ParseResult,
} from './daemonEventSchema';

describe('daemonEventSchema', () => {
  describe('ParseResult helpers', () => {
    it('isParseOk narrows data; isParseErr narrows error', () => {
      const ok: ParseResult<string> = parseOk('hi');
      if (isParseOk(ok)) {
        expect(ok.data).toBe('hi');
        expectTypeOf(ok.data).toEqualTypeOf<string>();
      } else {
        expect.fail('expected ok');
      }
      const err: ParseResult<string> = parseErr('');
      if (isParseErr(err)) {
        expect(err.error).toBe('parse failed');
        expectTypeOf(err.error).toEqualTypeOf<string>();
      } else {
        expect.fail('expected err');
      }
    });
  });

  it('parseToolCallFields requires id and name', () => {
    expect(isParseOk(parseToolCallFields(null))).toBe(false);
    expect(isParseOk(parseToolCallFields({ id: '1' }))).toBe(false);
    const ok = parseToolCallFields({ id: '1', name: 'shell', arguments: 'echo hi' });
    expect(isParseOk(ok)).toBe(true);
    if (isParseOk(ok)) {
      expect(ok.data.id).toBe('1');
      expect(ok.data.name).toBe('shell');
      expect(ok.data.args).toContain('echo');
    }
  });

  it('parseToolCallFields accepts ToolBatchCall toolName+input and parameters', () => {
    const batch = parseToolCallFields({
      id: 'tc-b',
      toolName: 'read_file',
      summary: 'read a',
      input: { path: 'a.ts' },
    });
    expect(isParseOk(batch)).toBe(true);
    if (isParseOk(batch)) {
      expect(batch.data.name).toBe('read_file');
      expect(batch.data.explanation).toBe('read a');
      expect(batch.data.args).toContain('a.ts');
    }

    const perm = parseToolCallFields({
      toolCallId: 'tc-p',
      toolName: 'shell_command',
      parameters: { command: 'echo ok' },
    });
    expect(isParseOk(perm)).toBe(true);
    if (isParseOk(perm)) expect(perm.data.args).toContain('echo ok');
  });

  it('parseDaemonEnvelope requires type', () => {
    expect(isParseOk(parseDaemonEnvelope({}))).toBe(false);
    const e = parseDaemonEnvelope({ type: 'tool-start', call: {} });
    expect(isParseOk(e)).toBe(true);
    if (isParseOk(e)) expect(e.data.type).toBe('tool-start');
  });

  it('parseDaemonEnvelope accepts event/kind aliases', () => {
    const e = parseDaemonEnvelope({ event: 'message-delta', text: 'x' });
    expect(isParseOk(e)).toBe(true);
    if (isParseOk(e)) expect(e.data.type).toBe('message-delta');
    const k = parseDaemonEnvelope({ kind: 'run-terminal', terminal: 'completed' });
    expect(isParseOk(k)).toBe(true);
    if (isParseOk(k)) expect(k.data.type).toBe('run-terminal');
  });

  it('parseDaemonEnvelope rejects arrays and surfaces non-empty error', () => {
    const r = parseDaemonEnvelope([]);
    expect(isParseErr(r)).toBe(true);
    if (isParseErr(r)) {
      expect(r.error.length).toBeGreaterThan(0);
      expect(r.error).toMatch(/not an object/);
    }
  });

  it('extractApprovalCommandArgs tries known keys', () => {
    expect(extractApprovalCommandArgs({ command: 'ls' })).toBe('ls');
    expect(extractApprovalCommandArgs({ args: { x: 1 } })).toContain('x');
  });

  it('extractApprovalCommandArgs prefers protocol parameters.command', () => {
    expect(
      extractApprovalCommandArgs({
        toolCallId: 'tc-1',
        toolName: 'shell_command',
        parameters: { command: 'git push origin main' },
        summary: 'push',
      }),
    ).toBe('git push origin main');
  });

  it('extractApprovalCommandArgs digs command from daemon WS input bag', () => {
    expect(
      extractApprovalCommandArgs({
        toolCallId: 'tc-ws',
        toolName: 'shell_command',
        input: { command: 'git status', cwd: '.' },
        summary: 'status',
      }),
    ).toBe('git status');
  });

  it('extractApprovalCommandArgs digs command out of nested args object', () => {
    expect(
      extractApprovalCommandArgs({
        args: { command: 'npm test', cwd: '.' },
      }),
    ).toBe('npm test');
  });
});
