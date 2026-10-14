import { describe, expect, it } from 'vitest';
import {
  cleanAnsiAndCommandNoise,
  unwrapToolOutput,
} from '../parse/toolOutput';

describe('unwrapToolOutput', () => {
  it('处理 null/undefined', () => {
    expect(unwrapToolOutput(null)).toEqual({ text: '' });
    expect(unwrapToolOutput(undefined)).toEqual({ text: '' });
  });

  it('原样保留普通纯文本', () => {
    expect(unwrapToolOutput('simple stdout string')).toEqual({
      text: 'simple stdout string',
    });
  });

  it('解包带有 output 字段的 JSON 字符串', () => {
    const raw = JSON.stringify({
      output: 'Build successful: 42 files compiled',
      metadata: { exit_code: 0 },
    });
    expect(unwrapToolOutput(raw)).toEqual({
      text: 'Build successful: 42 files compiled',
      isError: undefined,
    });
  });

  it('解包并检测非 0 exit_code 产生 isError: true', () => {
    const raw = JSON.stringify({
      output: 'SyntaxError: unexpected token',
      metadata: { exit_code: 1 },
    });
    expect(unwrapToolOutput(raw)).toEqual({
      text: 'SyntaxError: unexpected token',
      isError: true,
    });
  });

  it('解包扁平 exit_code: 127', () => {
    const raw = JSON.stringify({
      stdout: '',
      stderr: 'command not found: rg',
      exit_code: 127,
    });
    expect(unwrapToolOutput(raw)).toEqual({
      text: 'command not found: rg',
      isError: true,
    });
  });

  it('解包合并 stdout 与 stderr', () => {
    const raw = {
      stdout: 'some info log',
      stderr: 'warning: deprecated flag',
    };
    expect(unwrapToolOutput(raw)).toEqual({
      text: 'some info log\nwarning: deprecated flag',
      isError: true,
    });
  });

  it('解包深层双重嵌套转义 JSON', () => {
    const inner = JSON.stringify({ output: 'deep real text' });
    const outer = JSON.stringify({ output: inner });
    expect(unwrapToolOutput(outer)).toEqual({
      text: 'deep real text',
    });
  });

  it('普通 JSON 数组或非封套对象保持原格式不被误解包', () => {
    const arrayStr = '["src/a.ts", "src/b.ts"]';
    expect(unwrapToolOutput(arrayStr)).toEqual({
      text: '["src/a.ts", "src/b.ts"]',
    });

    const nonEnvelope = '{"name":"project","version":"1.0.0"}';
    expect(unwrapToolOutput(nonEnvelope)).toEqual({
      text: '{"name":"project","version":"1.0.0"}',
    });
  });

  it('剥离 ANSI 控制字符与本地命令标签噪声', () => {
    const ansiText =
      '[2m> Running tests...[22m\n\u001b[32mPASS\u001b[0m test/app.test.ts';
    expect(cleanAnsiAndCommandNoise(ansiText)).toBe(
      '> Running tests...\nPASS test/app.test.ts'
    );

    const commandNoise =
      '<local-command-caveat>Caveat</local-command-caveat>' +
      '<command-name>/model</command-name>' +
      '<command-args>gpt-5</command-args>' +
      '<local-command-stdout>Switched to model gpt-5</local-command-stdout>';
    expect(cleanAnsiAndCommandNoise(commandNoise)).toBe('');

    const wrapped = unwrapToolOutput(
      JSON.stringify({
        output:
          '<local-command-caveat>internal</local-command-caveat>[2mSuccess output[22m',
      })
    );
    expect(wrapped.text).toBe('Success output');
  });
});
