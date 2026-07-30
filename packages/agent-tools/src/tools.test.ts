import { describe, expect, it } from 'vitest';
import {
  askForMutatingToolsPolicy,
  defineTextTool,
  repairToolInput,
  ToolRegistry,
  validateToolInput,
} from './tools';

describe('tool helpers', () => {
  it('registers tools and rejects duplicate names', async () => {
    const registry = new ToolRegistry();
    const tool = defineTextTool({
      name: 'echo',
      description: 'Echo text',
      execute: (input) => String(input.text ?? ''),
    });
    registry.register(tool);

    expect(await registry.listTools()).toHaveLength(1);
    expect(() => registry.register(tool)).toThrow(/Duplicate tool/);
  });

  it('allows read-only tools and asks for mutating tools', () => {
    const read = defineTextTool({
      name: 'read',
      description: 'Read',
      readOnly: true,
      execute: () => 'ok',
    });
    const write = defineTextTool({
      name: 'write',
      description: 'Write',
      readOnly: false,
      execute: () => 'ok',
    });
    const policy = askForMutatingToolsPolicy();

    expect(
      policy.decide({
        id: 'r',
        sessionId: 's',
        cwd: '.',
        tool: read,
        input: {},
        summary: 'read',
      })
    ).toMatchObject({
      behavior: 'allow',
    });
    expect(
      policy.decide({
        id: 'w',
        sessionId: 's',
        cwd: '.',
        tool: write,
        input: {},
        summary: 'write',
      })
    ).toMatchObject({
      behavior: 'ask',
    });
  });

  it('validates required fields, primitive types, enum values, and malformed JSON diagnostics', () => {
    const tool = defineTextTool({
      name: 'shell',
      description: 'Run a shell command',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeoutMs: { type: 'integer' },
          mode: { type: 'string', enum: ['read', 'write'] },
        },
        required: ['command'],
      },
      execute: () => 'ok',
    });

    expect(
      validateToolInput(tool, { command: 'pwd', timeoutMs: 10, mode: 'read' })
    ).toEqual([]);
    expect(
      validateToolInput(tool, {
        timeoutMs: 10,
        mode: 'delete',
        __parseError: 'Unexpected token',
      })
    ).toEqual([
      'arguments JSON parse failed: Unexpected token',
      'missing required field: command',
      'mode must be one of: "read", "write"',
    ]);
    expect(validateToolInput(tool, { command: 123, timeoutMs: 1.2 })).toEqual([
      'command must be string',
      'timeoutMs must be integer',
    ]);
  });

  it('repairs common tool input aliases before validation', () => {
    const tool = defineTextTool({
      name: 'write_file',
      description: 'Write a file',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          encoding: { type: 'string' },
        },
        required: ['path', 'content'],
      },
      execute: () => 'ok',
    });

    const repaired = repairToolInput(tool, {
      file_path: 'demo.html',
      text: '<main>ok</main>',
    });

    expect(repaired.repaired).toBe(true);
    expect(repaired.input).toMatchObject({
      path: 'demo.html',
      content: '<main>ok</main>',
    });
    expect(validateToolInput(tool, repaired.input)).toEqual([]);
  });

  it('extracts the first complete JSON object from raw tool arguments', () => {
    const tool = defineTextTool({
      name: 'write_file',
      description: 'Write a file',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
      execute: () => 'ok',
    });

    const repaired = repairToolInput(tool, {
      __rawArguments:
        '{"path":"index.html","content":"<section>{ok}</section>"} trailing note',
      __parseError: 'Unexpected non-whitespace character after JSON',
    });

    expect(repaired.repaired).toBe(true);
    expect(repaired.input).toEqual({
      path: 'index.html',
      content: '<section>{ok}</section>',
    });
    expect(validateToolInput(tool, repaired.input)).toEqual([]);
  });

  it('keeps unrecoverable malformed arguments visible to validation', () => {
    const tool = defineTextTool({
      name: 'write_file',
      description: 'Write a file',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
      execute: () => 'ok',
    });

    const repaired = repairToolInput(tool, {
      __rawArguments: '{"path": "index.html"',
      __parseError: 'Unexpected end of JSON input',
    });

    expect(repaired.repaired).toBe(false);
    expect(validateToolInput(tool, repaired.input)).toContain(
      'arguments JSON parse failed: Unexpected end of JSON input'
    );
  });
});
