import { describe, expect, it } from 'vitest';
import {
  authHeaderObject,
  compactObject,
  maxTokensObject,
  normalizeContentParts,
  normalizeReasoningEffort,
  reasoningEffortObject,
  stripInlineDataUrls,
  stringifyToolOutput,
  systemPromptAsUserPrefix,
  toChatToolChoice,
  toOpenAITool,
  toResponsesTool,
  toResponsesToolChoice,
} from './openai-request-build';
import { defineTextTool } from '@crish/agent-tools';

describe('openai-request-build', () => {
  it('compactObject drops undefined', () => {
    expect(compactObject({ a: 1, b: undefined, c: null })).toEqual({
      a: 1,
      c: null,
    });
  });

  it('systemPromptAsUserPrefix prefixes trimmed text', () => {
    expect(systemPromptAsUserPrefix('  be concise  ')).toContain('be concise');
    expect(systemPromptAsUserPrefix('x')).toMatch(/^System instructions/);
  });

  it('stringifyToolOutput prefers text then json then artifacts', () => {
    expect(stringifyToolOutput({ text: 'ok' })).toBe('ok');
    expect(stringifyToolOutput({ json: { a: 1 } })).toContain('1');
    expect(
      stringifyToolOutput({ artifacts: [{ kind: 'file', path: 'a' } as never] })
    ).toContain('a');
    expect(stringifyToolOutput({})).toBe('');
  });

  it('auth and maxTokens helpers', () => {
    expect(authHeaderObject('none', 'k')).toEqual({});
    expect(authHeaderObject('authorization', 'k')).toEqual({
      authorization: 'Bearer k',
    });
    expect(authHeaderObject('api-key', 'k')).toEqual({ 'api-key': 'k' });
    expect(authHeaderObject('x-api-key', 'k')).toEqual({ 'x-api-key': 'k' });
    expect(maxTokensObject('max_tokens', 10)).toEqual({ max_tokens: 10 });
    expect(maxTokensObject('max_tokens', undefined)).toEqual({});
  });

  it('reasoning effort normalization and wire shapes', () => {
    expect(normalizeReasoningEffort('auto')).toBeUndefined();
    expect(normalizeReasoningEffort('xhigh')).toBe('high');
    expect(normalizeReasoningEffort('medium')).toBe('medium');
    expect(reasoningEffortObject('responses', 'm', 'high', 'auto')).toEqual({
      reasoning: { effort: 'high' },
    });
    expect(
      reasoningEffortObject('chat-completions', 'm', 'low', 'auto')
    ).toEqual({
      reasoning_effort: 'low',
    });
    expect(
      reasoningEffortObject('chat-completions', 'm', 'low', 'none')
    ).toEqual({});
  });

  it('tool choice and tool schemas', () => {
    expect(toChatToolChoice('auto')).toBe('auto');
    expect(toChatToolChoice({ type: 'function', name: 'read' })).toEqual({
      type: 'function',
      function: { name: 'read' },
    });
    expect(toResponsesToolChoice({ type: 'function', name: 'read' })).toEqual({
      type: 'function',
      name: 'read',
    });
    const tool = defineTextTool({
      name: 'read',
      description: 'Read a file',
      category: 'filesystem',
      readOnly: true,
      execute: () => 'ok',
    });
    expect(toOpenAITool(tool)).toMatchObject({
      type: 'function',
      function: { name: 'read', description: 'Read a file' },
    });
    expect(toResponsesTool(tool)).toMatchObject({
      type: 'function',
      name: 'read',
      strict: false,
    });
  });

  it('stripInlineDataUrls and normalizeContentParts', () => {
    expect(stripInlineDataUrls('see data:image/png;base64,AAA=')).toContain(
      '[image]'
    );
    expect(
      normalizeContentParts([
        { type: 'text', text: 'hi' },
        {
          type: 'image_url',
          image_url: { url: 'https://x/y.png', detail: 'low' },
        },
        { type: 'image_url', url: 'https://x/z.png' },
        { type: 'noise' },
      ])
    ).toEqual([
      { type: 'text', text: 'hi' },
      {
        type: 'image_url',
        image_url: { url: 'https://x/y.png', detail: 'low' },
      },
      { type: 'image_url', image_url: { url: 'https://x/z.png' } },
    ]);
  });
});
