import { describe, expect, it } from 'vitest';
import {
  shellResultToLines,
  shouldExecuteTerminalInput,
  type TerminalShellResult,
} from './terminalShellApi';

function base(partial: Partial<TerminalShellResult> = {}): TerminalShellResult {
  return {
    ok: true,
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    shell: 'powershell.exe',
    cwd: 'C:/repo',
    durationMs: 12,
    truncated: false,
    ...partial,
  };
}

describe('shouldExecuteTerminalInput', () => {
  it('rejects empty and clear; accepts real commands', () => {
    expect(shouldExecuteTerminalInput('')).toBe(false);
    expect(shouldExecuteTerminalInput('  clear  ')).toBe(false);
    expect(shouldExecuteTerminalInput('Get-Location')).toBe(true);
    expect(shouldExecuteTerminalInput('echo hi')).toBe(true);
  });
});

describe('shellResultToLines', () => {
  it('splits stdout lines and omits empty noise', () => {
    const lines = shellResultToLines(
      base({ stdout: 'hello\nworld\n', stderr: '' }),
    );
    expect(lines).toEqual(['hello', 'world']);
  });

  it('marks non-zero exit and empty output', () => {
    expect(shellResultToLines(base({ exitCode: 1, stdout: '', stderr: '' }))).toEqual([
      '(无输出)',
      '(exit 1)',
    ]);
  });

  it('marks timeout', () => {
    const lines = shellResultToLines(
      base({ timedOut: true, ok: false, exitCode: null, stderr: 'x' }),
    );
    expect(lines).toContain('(命令超时)');
  });
});
