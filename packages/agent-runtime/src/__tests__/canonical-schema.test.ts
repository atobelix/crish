import { describe, it, expect } from 'vitest';
import { canonicalizeJsonSchema, canonicalizeTools } from '../canonical-schema';
import type { AgentTool } from '../types';

describe('canonicalizeJsonSchema', () => {
  it('sorts nested object properties recursively', () => {
    const input = {
      type: 'object',
      properties: {
        z: { type: 'string' },
        a: {
          type: 'object',
          properties: {
            n: { type: 'number' },
            b: { type: 'boolean' },
          },
        },
      },
    };
    const result = canonicalizeJsonSchema(input);
    const keys = Object.keys(result.properties!);
    expect(keys).toEqual(['a', 'z']);
    const innerKeys = Object.keys((result.properties! as any).a.properties);
    expect(innerKeys).toEqual(['b', 'n']);
  });

  it('deduplicates and sorts required array', () => {
    const input = {
      type: 'object',
      required: ['c', 'a', 'b', 'a', 'c'],
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
        c: { type: 'string' },
      },
    };
    const result = canonicalizeJsonSchema(input);
    expect(result.required).toEqual(['a', 'b', 'c']);
  });

  it('sorts enum array with String.localeCompare', () => {
    const input = {
      type: 'string',
      enum: ['z', 'a', 'm'],
    };
    const result = canonicalizeJsonSchema(input);
    expect(result.enum).toEqual(['a', 'm', 'z']);
  });

  it('strips non-standard fields like $schema, title, markdownDescription', () => {
    const input = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: 'My Schema',
      markdownDescription: 'desc in md',
      description: 'plain desc',
      default: 42,
      examples: [1, 2],
      type: 'object',
      properties: {
        foo: { type: 'string' },
      },
    };
    const result = canonicalizeJsonSchema(input);
    expect(result).not.toHaveProperty('$schema');
    expect(result).not.toHaveProperty('title');
    expect(result).not.toHaveProperty('markdownDescription');
    expect(result).not.toHaveProperty('description');
    expect(result).not.toHaveProperty('default');
    expect(result).not.toHaveProperty('examples');
    expect(result).toHaveProperty('type');
    expect(result).toHaveProperty('properties');
  });

  it('adds "object" type when type is missing', () => {
    const input = { properties: { x: { type: 'string' } } };
    const result = canonicalizeJsonSchema(input);
    expect(result.type).toBe('object');
  });

  it('handles null/undefined input gracefully', () => {
    const nullResult = canonicalizeJsonSchema(null as any);
    expect(nullResult.type).toBe('object');
    expect(nullResult.properties).toEqual({});

    const undefinedResult = canonicalizeJsonSchema(undefined as any);
    expect(undefinedResult.type).toBe('object');
    expect(undefinedResult.properties).toEqual({});
  });

  it('produces identical output for semantically identical input', () => {
    const input1 = {
      type: 'object',
      required: ['b', 'a'],
      properties: {
        b: { type: 'number' },
        a: { type: 'string' },
      },
    };
    const input2 = {
      required: ['a', 'b', 'a'],
      properties: {
        a: { type: 'string' },
        b: { type: 'number' },
      },
    };
    expect(canonicalizeJsonSchema(input1)).toEqual(canonicalizeJsonSchema(input2));
  });

  it('recursively processes allOf/oneOf/anyOf items', () => {
    const input = {
      type: 'object',
      allOf: [
        {
          type: 'object',
          properties: { y: { type: 'string', title: 'Y' } },
        },
        {
          type: 'object',
          properties: { x: { type: 'number' }, z: { type: 'boolean' } },
        },
      ],
      oneOf: [
        {
          type: 'object',
          properties: { inner: { type: 'string' } },
        },
      ],
    };
    const result = canonicalizeJsonSchema(input);
    expect(result.allOf).toBeDefined();
    expect(result.oneOf).toBeDefined();
    expect(Array.isArray(result.allOf)).toBe(true);
    expect(Array.isArray(result.oneOf)).toBe(true);

    for (const sub of (result.allOf! as any[])) {
      expect(sub).not.toHaveProperty('title');
      expect(sub.type).toBe('object');
    }
    for (const sub of (result.oneOf! as any[])) {
      expect(sub.type).toBe('object');
    }
  });

  it('recursively processes items when it is an object', () => {
    const input = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          value: { type: 'number', title: 'Value' },
          name: { type: 'string' },
        },
        required: ['name', 'value'],
      },
    };
    const result = canonicalizeJsonSchema(input);
    expect(result.items).toBeDefined();
    expect(result.items).not.toHaveProperty('title');
    expect((result.items as any).type).toBe('object');
    expect((result.items as any).required).toEqual(['name', 'value']);
    expect(Object.keys((result.items as any).properties)).toEqual(['name', 'value']);
  });
});

describe('canonicalizeTools', () => {
  const makeTool = (name: string, description: string, inputSchema?: any): AgentTool => ({
    name,
    label: name,
    description,
    category: 'custom' as any,
    inputSchema: inputSchema ?? { type: 'object', properties: {} },
    concurrency: 'parallel' as const,
    isReadOnly: () => false,
    summarize: () => name,
    execute: async () => ({ text: '' }),
  });

  it('sorts tools by name', () => {
    const tools = [
      makeTool('z-tool', 'Z tool'),
      makeTool('a-tool', 'A tool'),
      makeTool('m-tool', 'M tool'),
    ];
    const result = canonicalizeTools(tools);
    expect(result.map((t) => t.name)).toEqual(['a-tool', 'm-tool', 'z-tool']);
  });

  it('produces the same hash for the same tools on multiple calls', () => {
    const tools = [
      makeTool('tool-a', 'desc A', { type: 'object', properties: { x: { type: 'string' } } }),
      makeTool('tool-b', 'desc B', { type: 'object', properties: { y: { type: 'number' } } }),
    ];
    const r1 = canonicalizeTools(tools);
    const r2 = canonicalizeTools(tools);
    expect(r1).toEqual(r2);
  });

  it('produces different hashes when descriptions differ', () => {
    const tools1 = canonicalizeTools([makeTool('tool', 'original desc')]);
    const tools2 = canonicalizeTools([makeTool('tool', 'different desc')]);
    expect(tools1).not.toEqual(tools2);
  });
});
