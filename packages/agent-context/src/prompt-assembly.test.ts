import { describe, expect, it } from 'vitest';
import {
  assemblePromptForProvider,
  selectPromptCacheStrategy,
} from './prompt-assembly';
import { createTextMessage } from './session';
// TODO: Round 5 will resolve this cross-layer import
// tools 在 Round 4 才迁出（agent-tools 包），当前作为跨层引用暂存
// @ts-expect-error - agent-tools 包尚未创建，Round 5 接线后修复
import { defineTextTool } from './tools';
import type { JsonObject } from '@crish/shared-types';

function shellTool(
  inputSchema: JsonObject = commandSchema()
): ReturnType<typeof defineTextTool> {
  return defineTextTool({
    name: 'shell_command',
    description: 'Run a shell command',
    inputSchema,
    execute: () => 'ok',
  });
}

function commandSchema(extra: JsonObject = {}): JsonObject {
  return {
    type: 'object',
    properties: {
      command: { type: 'string' },
      ...extra,
    },
    required: ['command'],
  };
}

describe('PromptAssembly', () => {
  it('keeps the stable prefix hash stable for the same system prompt and tools', () => {
    const first = assemblePromptForProvider({
      systemPrompt: 'You are concise.',
      messages: [createTextMessage('user', 'Inspect the repo.')],
      tools: [shellTool()],
    });
    const second = assemblePromptForProvider({
      systemPrompt: 'You are concise.',
      messages: [createTextMessage('user', 'Inspect a different file.')],
      tools: [shellTool()],
    });

    expect(first.metadata.stablePrefixHash).toBe(
      second.metadata.stablePrefixHash
    );
    expect(first.metadata.toolSchemaHash).toBe(second.metadata.toolSchemaHash);
    expect(
      first.metadata.cacheBlocks.map((block) => [block.kind, block.stability])
    ).toEqual([
      ['system-prompt', 'stable'],
      ['tool-schemas', 'stable'],
      ['current-user-turn', 'volatile'],
    ]);
    expect(first.metadata.boundary).toMatchObject({
      stableBlockIds: ['system-prompt', 'tool-schemas'],
      volatileBlockKinds: ['current-user-turn'],
      stablePrefixHash: first.metadata.stablePrefixHash,
      cacheKey: first.metadata.cacheKey,
    });
  });

  it('does not change the stable prefix hash when only the current user turn changes', () => {
    const base = {
      systemPrompt: 'Use the tools when needed.',
      tools: [shellTool()],
    };
    const first = assemblePromptForProvider({
      ...base,
      messages: [createTextMessage('user', 'Run pwd.')],
    });
    const second = assemblePromptForProvider({
      ...base,
      messages: [createTextMessage('user', 'Run git status.')],
    });

    expect(first.metadata.stablePrefixHash).toBe(
      second.metadata.stablePrefixHash
    );
  });

  it('changes the stable prefix hash when a tool schema changes', () => {
    const first = assemblePromptForProvider({
      systemPrompt: 'Use the tools when needed.',
      messages: [createTextMessage('user', 'Run pwd.')],
      tools: [shellTool(commandSchema())],
    });
    const second = assemblePromptForProvider({
      systemPrompt: 'Use the tools when needed.',
      messages: [createTextMessage('user', 'Run pwd.')],
      tools: [shellTool(commandSchema({ timeoutMs: { type: 'number' } }))],
    });

    expect(first.metadata.toolSchemaHash).not.toBe(
      second.metadata.toolSchemaHash
    );
    expect(first.metadata.stablePrefixHash).not.toBe(
      second.metadata.stablePrefixHash
    );
  });

  it('keeps tool schema cache keys stable when callers register the same tools in a different order', () => {
    const readTool = defineTextTool({
      name: 'read_file',
      description: 'Read a file',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
      execute: () => 'ok',
    });
    const shell = shellTool();

    const first = assemblePromptForProvider({
      systemPrompt: 'Use tools.',
      messages: [createTextMessage('user', 'Inspect files.')],
      tools: [shell, readTool],
    });
    const second = assemblePromptForProvider({
      systemPrompt: 'Use tools.',
      messages: [createTextMessage('user', 'Inspect files.')],
      tools: [readTool, shell],
    });

    expect(first.payload.tools.map((tool) => tool.name)).toEqual([
      'read_file',
      'shell_command',
    ]);
    expect(second.payload.tools.map((tool) => tool.name)).toEqual([
      'read_file',
      'shell_command',
    ]);
    expect(first.metadata.toolSchemaHash).toBe(second.metadata.toolSchemaHash);
    expect(first.metadata.stablePrefixHash).toBe(
      second.metadata.stablePrefixHash
    );
  });

  it('selects cache strategy metadata by model family without changing stable layout for unknown models', () => {
    expect(selectPromptCacheStrategy({ model: 'gpt5.4' })).toMatchObject({
      providerFamily: 'openai',
      modelFamily: 'gpt-5.x',
      cacheStrategy: 'automatic-stable-prefix',
    });
    expect(selectPromptCacheStrategy({ model: 'Claude 4.6' })).toMatchObject({
      providerFamily: 'anthropic',
      modelFamily: 'claude-4.6-plus',
      cacheStrategy: 'explicit-cache-breakpoint',
    });
    expect(selectPromptCacheStrategy({ model: 'deepseek-v4' })).toMatchObject({
      providerFamily: 'openai-compatible',
      modelFamily: 'deepseek-v4-plus',
      cacheStrategy: 'conservative-stable-prefix',
    });
    expect(selectPromptCacheStrategy({ model: 'Kimi 2.5' })).toMatchObject({
      providerFamily: 'openai-compatible',
      modelFamily: 'kimi-2.5-plus',
      cacheStrategy: 'conservative-stable-prefix',
    });
    expect(selectPromptCacheStrategy({ model: 'GLM 5.0' })).toMatchObject({
      providerFamily: 'openai-compatible',
      modelFamily: 'glm-5-plus',
      cacheStrategy: 'conservative-stable-prefix',
    });

    const assembled = assemblePromptForProvider({
      model: 'unknown-frontier-model',
      systemPrompt: 'Keep the prefix stable.',
      messages: [createTextMessage('user', 'Do the work.')],
      tools: [],
    });

    expect(assembled.metadata).toMatchObject({
      providerFamily: 'unknown',
      modelFamily: 'unknown',
      cacheStrategy: 'conservative-stable-prefix',
    });
    expect(assembled.metadata.cacheBlocks[0]).toMatchObject({
      kind: 'system-prompt',
      stability: 'stable',
      order: 0,
    });
    expect(assembled.metadata.cacheCandidates[0]).toMatchObject({
      strategy: 'conservative-stable-prefix',
      blockIds: ['system-prompt'],
    });
  });

  it('materializes stable and volatile context without making volatile blocks part of the stable prefix', () => {
    const first = assemblePromptForProvider({
      systemPrompt: 'You are Conex.',
      stableContext: [
        {
          id: 'scoped-context:rules',
          kind: 'custom-stable',
          label: 'Scoped Rules',
          content: { rules: [{ id: 'project', text: 'Use the daemon path.' }] },
        },
      ],
      volatileContext: [
        {
          id: 'project-progress:recent-tasks',
          kind: 'custom-volatile',
          content: { lines: ['Task[in_progress]: worker-a'] },
        },
      ],
      messages: [createTextMessage('user', 'Task A')],
      tools: [],
    });
    const second = assemblePromptForProvider({
      systemPrompt: 'You are Conex.',
      stableContext: [
        {
          id: 'scoped-context:rules',
          kind: 'custom-stable',
          label: 'Scoped Rules',
          content: { rules: [{ id: 'project', text: 'Use the daemon path.' }] },
        },
      ],
      volatileContext: [
        {
          id: 'project-progress:recent-tasks',
          kind: 'custom-volatile',
          content: { lines: ['Task[in_progress]: worker-b'] },
        },
      ],
      messages: [createTextMessage('user', 'Task B')],
      tools: [],
    });

    expect(first.payload.systemPrompt).toContain(
      '<prompt_context stability="stable"'
    );
    expect(first.payload.systemPrompt).toContain('Use the daemon path.');
    expect(first.payload.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
    ]);
    expect(first.payload.messages[0]?.metadata).toMatchObject({
      kind: 'prompt-context',
      stability: 'volatile',
    });
    expect(JSON.stringify(first.payload.messages[0])).toContain('worker-a');
    expect(first.metadata.stablePrefixHash).toBe(
      second.metadata.stablePrefixHash
    );
    expect(
      first.metadata.cacheBlocks.map((block) => [
        block.id,
        block.kind,
        block.stability,
      ])
    ).toEqual([
      ['system-prompt', 'system-prompt', 'stable'],
      ['scoped-context:rules', 'custom-stable', 'stable'],
      ['project-progress:recent-tasks', 'custom-volatile', 'volatile'],
      [expect.stringMatching(/^message:/), 'current-user-turn', 'volatile'],
    ]);
    expect(first.metadata.boundary.stableBlockIds).toEqual([
      'system-prompt',
      'scoped-context:rules',
    ]);
    expect(first.metadata.boundary.volatileBlockIds).toEqual([
      'project-progress:recent-tasks',
      expect.stringMatching(/^message:/),
    ]);
    expect(first.metadata.boundary.stableBlockKinds).not.toContain(
      'custom-volatile'
    );
  });
});
