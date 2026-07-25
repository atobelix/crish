import { describe, it, expect } from 'vitest';
import { canonicalizeTools, computeToolsSchemaHash } from '../canonical-schema';
import type { AgentTool } from '../types';

function makeTool(name: string, overrides?: Partial<AgentTool>): AgentTool {
  return {
    name,
    label: name,
    description: `Tool ${name}`,
    category: 'internal' as const,
    inputSchema: { type: 'object', properties: {} },
    concurrency: 'parallel' as const,
    isReadOnly: () => false,
    summarize: () => name,
    execute: async () => ({ text: '' }),
    ...overrides,
  };
}

describe('canonicalizeTools', () => {
  it('produces identical output regardless of input order', () => {
    const a = makeTool('bravo');
    const b = makeTool('alpha');
    const c = makeTool('charlie');
    const r1 = canonicalizeTools([c, a, b]);
    const r2 = canonicalizeTools([b, a, c]);
    expect(r1.map(t => t.name)).toEqual(['alpha', 'bravo', 'charlie']);
    expect(r1.map(t => t.name)).toEqual(r2.map(t => t.name));
  });

  it('returns same hash for identical tool sets across multiple calls', () => {
    const tools = [makeTool('foo'), makeTool('bar')];
    const h1 = computeToolsSchemaHash(canonicalizeTools(tools));
    const h2 = computeToolsSchemaHash(canonicalizeTools(tools));
    expect(h1).toBe(h2);
  });

  it('preserves relative order of native tools when MCP tools are added', () => {
    const nativeTools = [
      makeTool('read_file'),
      makeTool('write_file'),
      makeTool('execute_command'),
    ];
    const mcpTools = [
      makeTool('mcp__github'),
      makeTool('mcp__slack'),
    ];
    const all = canonicalizeTools([...nativeTools, ...mcpTools]);
    const nativeNames = all.filter(t => !t.name.startsWith('mcp__')).map(t => t.name);
    const mcpNames = all.filter(t => t.name.startsWith('mcp__')).map(t => t.name);
    expect(nativeNames).toEqual(['execute_command', 'read_file', 'write_file']);
    expect(mcpNames).toEqual(['mcp__github', 'mcp__slack']);
    const sortedByName = [...all].sort((a, b) => a.name.localeCompare(b.name));
    expect(all.map(t => t.name)).toEqual(sortedByName.map(t => t.name));
  });

  it('returns empty array for empty input', () => {
    const result = canonicalizeTools([]);
    expect(result).toEqual([]);
  });

  it('returns a single tool unchanged in structure', () => {
    const tool = makeTool('singleton');
    const result = canonicalizeTools([tool]);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('singleton');
    expect(result[0]!.description).toBe('Tool singleton');
  });

  it('produces different hash when description differs', () => {
    const t1 = makeTool('greeter', { description: 'Greets the user' });
    const t2 = makeTool('greeter', { description: 'Different description' });
    const h1 = computeToolsSchemaHash(canonicalizeTools([t1]));
    const h2 = computeToolsSchemaHash(canonicalizeTools([t2]));
    expect(h1).not.toBe(h2);
  });

  it('sorting stability: same tools in any input order yield same output order', () => {
    const tools = [
      makeTool('z'),
      makeTool('y', { label: 'y-label' }),
      makeTool('x', { description: 'custom desc' }),
      makeTool('w'),
    ];
    const orderings = [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [1, 3, 0, 2],
      [2, 0, 3, 1],
    ];
    const results = orderings.map(order => canonicalizeTools(order.map(i => tools[i]!)));
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.map(t => t!.name)).toEqual(results[0]!.map(t => t!.name));
    }
  });
});
