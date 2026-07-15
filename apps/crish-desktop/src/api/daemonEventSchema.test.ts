import { describe, expect, it } from 'vitest';
import {
  extractApprovalCommandArgs,
  parseDaemonEnvelope,
  parseToolCallFields,
} from './daemonEventSchema';

describe('daemonEventSchema', () => {
  it('parseToolCallFields requires id and name', () => {
    expect(parseToolCallFields(null).ok).toBe(false);
    expect(parseToolCallFields({ id: '1' }).ok).toBe(false);
    const ok = parseToolCallFields({ id: '1', name: 'shell', arguments: 'echo hi' });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.data.id).toBe('1');
      expect(ok.data.name).toBe('shell');
      expect(ok.data.args).toContain('echo');
    }
  });

  it('parseDaemonEnvelope requires type', () => {
    expect(parseDaemonEnvelope({}).ok).toBe(false);
    const e = parseDaemonEnvelope({ type: 'tool-start', call: {} });
    expect(e.ok).toBe(true);
    if (e.ok) expect(e.data.type).toBe('tool-start');
  });

  it('extractApprovalCommandArgs tries known keys', () => {
    expect(extractApprovalCommandArgs({ command: 'ls' })).toBe('ls');
    expect(extractApprovalCommandArgs({ args: { x: 1 } })).toContain('x');
  });
});
