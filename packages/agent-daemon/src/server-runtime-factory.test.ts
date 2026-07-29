import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ApprovalQueue } from './approval-queue';
import {
  DaemonCheckpointManifestAdapter,
  type DaemonProductAdapters,
} from './daemon-product-adapters';
import type { ScopedContextStore, ScopedContextListFilter } from './scoped-context-store';
import type { ScopedContextRecord, DaemonConfig } from './types';
import {
  DaemonRuntimeFactory,
  DaemonUnsupportedCapabilityError,
  type DaemonMcpLifecycleManagerFactory,
  type DaemonToolFactoryInput,
} from './server-runtime-factory';
import type { DaemonRuntimeFactoryOptions } from './server-runtime-factory/types';
import type { JsonObject } from '@crish/shared-types';
import type {
  AgentProvider,
  AgentProviderRequest,
  AgentTool,
  McpServerDefinition,
  ProviderStreamEvent,
} from '@crish/agent-runtime';
import {
  CheckpointManifestService,
  McpLifecycleManager,
} from '@crish/agent-runtime';
import type {
  CreateRunEngineInput,
} from '@crish/agent-orchestrator';

describe('DaemonRuntimeFactory W5-5 health pack wire', () => {
  it('exposes observe-only getHealthSnapshot from registerBuiltinHealthHooks', () => {
    const factory = createFactory();
    const snap = factory.getHealthSnapshot();
    expect(snap).toMatchObject({
      turnStartCount: 0,
      turnEndCount: 0,
      toolPreCount: 0,
      toolPostCount: 0,
      toolErrorCount: 0,
    });
  });
});

describe('DaemonRuntimeFactory workspace mutation coordinators', () => {
  it('reuses one coordinator for the same cwd', () => {
    const factory = createFactory();
    const cwd = join(tmpdir(), 'conex-daemon-shared-cwd');

    expect(factory.getWorkspaceMutationCoordinator(cwd)).toBe(
      factory.getWorkspaceMutationCoordinator(cwd)
    );
  });

  it('isolates coordinators for different cwd values', () => {
    const factory = createFactory();

    expect(
      factory.getWorkspaceMutationCoordinator(
        join(tmpdir(), 'conex-daemon-cwd-a')
      )
    ).not.toBe(
      factory.getWorkspaceMutationCoordinator(
        join(tmpdir(), 'conex-daemon-cwd-b')
      )
    );
  });

  it('passes the cwd coordinator to runtime options and local tool factories', async () => {
    const factory = createFactory();
    const toolFactoryInputs: DaemonToolFactoryInput[] = [];
    const cwd = join(tmpdir(), 'conex-daemon-runtime-cwd');

    factory.setProviderFactory(() => new EmptyProvider());
    factory.setToolFactory((input) => {
      toolFactoryInputs.push(input);
      return [];
    });

    const runtimeOptions = await factory.createRuntimeOptions(
      createRunEngineInput({ cwd })
    );
    const expectedCoordinator = factory.getWorkspaceMutationCoordinator(cwd);

    expect(runtimeOptions.workspaceMutationCoordinator).toBe(
      expectedCoordinator
    );
    expect(toolFactoryInputs).toHaveLength(1);
    expect(toolFactoryInputs[0]).toMatchObject({ cwd });
    expect(toolFactoryInputs[0]?.mutationCoordinator).toBe(expectedCoordinator);
  });

  it('adds persistent session resume, compression, tool budget, and recovery defaults', async () => {
    const sessionStoreDir = join(
      tmpdir(),
      'conex-daemon-runtime-session-defaults'
    );
    const cwd = join(tmpdir(), 'conex-daemon-runtime-options-cwd');
    const factory = createFactory({ sessionStoreDir });
    factory.setProviderFactory(() => new EmptyProvider());

    const runtimeOptions = await factory.createRuntimeOptions(
      createRunEngineInput({
        cwd,
        sessionId: 'session_defaults',
        metadata: {
          contextWindowTokens: 400_000,
          autoCompactAtTokens: 144_000,
          preferredWorkingTokens: 160_000,
        },
      })
    );

    expect(runtimeOptions.sessionId).toBe('session_defaults');
    expect(runtimeOptions.sessionStore).toBeDefined();
    expect(runtimeOptions.resumeSession).toBe(true);
    expect(sessionStoreFilePath(runtimeOptions)).toContain(sessionStoreDir);
    expect(runtimeOptions.contextCompression).toMatchObject({
      enabled: true,
      contextWindowTokens: 400_000,
      thresholdTokens: 144_000,
      targetRecentTokens: 56_000,
      minRecentMessages: 8,
      maxSummaryTokens: 8_000,
    });
    expect(runtimeOptions.contextCompression?.contextState).toBeDefined();
    expect(runtimeOptions.contextCompression?.toolOutputBudget).toBe(
      runtimeOptions.toolOutputBudget
    );
    expect(runtimeOptions.toolOutputBudget).toMatchObject({
      inlineChars: 8_000,
      headRatio: 0.55,
      artifactChars: 200_000,
    });
    expect(runtimeOptions.recovery).toMatchObject({
      enabled: true,
      maxConsecutiveToolErrors: 2,
      maxRepeatedToolCalls: 3,
      maxSteeringMessages: 1,
    });
    expect(runtimeOptions.permissionPolicy).toBeDefined();
    expect(runtimeOptions.approvalHandler).toBeDefined();
    expect(runtimeOptions.workspaceMutationCoordinator).toBe(
      factory.getWorkspaceMutationCoordinator(cwd)
    );
  });

  it('isolates persistent runtime sessions by session id and cwd', async () => {
    const sessionStoreDir = join(
      tmpdir(),
      'conex-daemon-runtime-session-isolation'
    );
    const factory = createFactory({ sessionStoreDir });
    factory.setProviderFactory(() => new EmptyProvider());

    const first = await factory.createRuntimeOptions(
      createRunEngineInput({
        cwd: join(tmpdir(), 'conex-daemon-runtime-session-cwd-a'),
        sessionId: 'session_shared',
      })
    );
    const same = await factory.createRuntimeOptions(
      createRunEngineInput({
        cwd: join(tmpdir(), 'conex-daemon-runtime-session-cwd-a'),
        sessionId: 'session_shared',
      })
    );
    const differentSession = await factory.createRuntimeOptions(
      createRunEngineInput({
        cwd: join(tmpdir(), 'conex-daemon-runtime-session-cwd-a'),
        sessionId: 'session_other',
      })
    );
    const differentCwd = await factory.createRuntimeOptions(
      createRunEngineInput({
        cwd: join(tmpdir(), 'conex-daemon-runtime-session-cwd-b'),
        sessionId: 'session_shared',
      })
    );

    expect(sessionStoreFilePath(first)).toBe(sessionStoreFilePath(same));
    expect(sessionStoreFilePath(first)).not.toBe(
      sessionStoreFilePath(differentSession)
    );
    expect(sessionStoreFilePath(first)).not.toBe(
      sessionStoreFilePath(differentCwd)
    );
  });

  it('exposes daemon-owned provider status from provider factories', () => {
    const factory = createFactory();
    const providerFactory = (() => new EmptyProvider()) as ReturnType<
      typeof createStatusProviderFactory
    >;
    providerFactory.getProviderStatusSnapshot = createStatusSnapshot;

    factory.setProviderFactory(providerFactory);

    expect(factory.getProviderStatusSnapshot()).toMatchObject({
      credentialMode: 'direct',
      readiness: 'ready',
      model: 'mimo-v2.5',
    });
  });

  it('starts configured MCP servers before creating runtime options and adds their tools', async () => {
    const tool = createTestTool('mcp_echo');
    const input = createRunEngineInput({
      cwd: join(tmpdir(), 'conex-daemon-mcp-ready'),
    });
    const factory = createFactory({
      mcpServers: [
        {
          name: 'ready-tools',
          adapter: {
            connect: () => ({
              listTools: () => [tool],
            }),
          },
        },
      ],
    });
    factory.setProviderFactory(createStatusProviderFactory());

    const runtimeOptions = await factory.createRuntimeOptions(input);

    expect(
      runtimeOptions.tools?.some((candidate) => candidate.name === 'mcp_echo')
    ).toBe(true);
    expect(input.run.metadata?.mcp).toMatchObject({
      configured: true,
      readiness: 'ready',
      readyServers: ['ready-tools'],
      toolCount: 1,
    });
    expect(factory.getMcpStatusSnapshot()).toMatchObject({
      configured: true,
      readiness: 'ready',
      serverCount: 1,
    });
  });

  it('lists configured MCP servers while idle without a prior run', () => {
    const factory = createFactory({
      mcpServers: [
        {
          name: 'docs',
          adapter: {
            connect: () => ({
              listTools: () => [],
            }),
          },
        },
        {
          name: 'search',
          adapter: {
            connect: () => ({
              listTools: () => [],
            }),
          },
        },
      ],
    });

    expect(factory.getMcpStatusSnapshot()).toMatchObject({
      configured: true,
      serverCount: 2,
    });
    expect(factory.listMcpServers()).toMatchObject([
      { id: 'docs', name: 'docs', state: 'configured', transport: 'stdio' },
      { id: 'search', name: 'search', state: 'configured', transport: 'stdio' },
    ]);
  });

  it('start/stop MCP servers via shared manager after initialising runtime', async () => {
    let connectCount = 0;
    let closed = 0;
    const factory = createFactory({
      mcpServers: [
        {
          name: 'docs',
          adapter: {
            connect: () => {
              connectCount += 1;
              return {
                listTools: () => [createTestTool('mcp_docs')],
                close: () => {
                  closed += 1;
                },
              };
            },
          },
        },
      ],
    });
    factory.setProviderFactory(() => new EmptyProvider());
    await factory.createRuntimeOptions(
      createRunEngineInput({
        cwd: join(tmpdir(), 'conex-daemon-mcp-start-stop'),
      })
    );

    expect(factory.startMcpServer('docs')).toEqual({
      state: 'starting',
    });
    expect(connectCount).toBe(1);
    expect(factory.listMcpServers()[0]).toMatchObject({
      id: 'docs',
      name: 'docs',
      state: 'ready',
    });

    expect(factory.stopMcpServer('docs')).toEqual({
      state: 'stopped',
    });
    expect(closed).toBe(1);

    expect(factory.startMcpServer('missing')).toEqual({
      state: 'starting',
    });
  });

  it('returns empty list and unsupported start when MCP is not configured', async () => {
    const factory = createFactory();
    expect(factory.listMcpServers()).toEqual([]);
    expect(factory.getMcpStatusSnapshot().configured).toBe(false);
    expect(factory.startMcpServer('x')).toEqual({ state: 'unknown' });
  });

  it('keeps the run alive when one MCP server degrades and reports diagnostics', async () => {
    const input = createRunEngineInput({
      cwd: join(tmpdir(), 'conex-daemon-mcp-degraded'),
    });
    const factory = createFactory({
      mcpServers: [
        {
          name: 'broken-tools',
          cachedTools: [
            {
              name: 'mcp_cached',
              description: 'Cached metadata for a degraded MCP tool.',
              readOnly: true,
            },
          ],
          adapter: {
            connect: () => {
              throw new Error('server unavailable');
            },
          },
        },
      ],
    });
    factory.setProviderFactory(createStatusProviderFactory());

    const runtimeOptions = await factory.createRuntimeOptions(input);
    const providerStatus = factory.getProviderStatusSnapshot();

    expect(
      runtimeOptions.tools?.some((candidate) => candidate.name === 'mcp_cached')
    ).toBe(true);
    expect(input.run.metadata?.mcp).toMatchObject({
      configured: true,
      readiness: 'degraded',
      degradedServers: [
        {
          server: 'broken-tools',
          diagnostic: {
            code: 'MCP_CONNECT_FAILED',
            message: 'server unavailable',
          },
        },
      ],
    });
    expect(providerStatus.lastDiagnostic).toMatchObject({
      code: 'mcp_degraded',
      kind: 'mcp',
      metadata: {
        mcp: {
          readiness: 'degraded',
          diagnostics: [
            {
              code: 'MCP_CONNECT_FAILED',
              message: 'server unavailable',
            },
          ],
        },
      },
    });
  });

  it('tracks manager factories and tears MCP managers down from the runtime factory close path', async () => {
    let closeCount = 0;
    const managerFactory: DaemonMcpLifecycleManagerFactory = () =>
      new McpLifecycleManager({
        servers: [
          {
            name: 'closable-tools',
            adapter: {
              connect: () => ({
                listTools: () => [createTestTool('mcp_close_probe')],
                close: () => {
                  closeCount += 1;
                },
              }),
            },
          },
        ],
      });
    const factory = createFactory({
      mcpLifecycleManagerFactory: managerFactory,
    });
    factory.setProviderFactory(() => new EmptyProvider());

    await factory.createRuntimeOptions(
      createRunEngineInput({
        cwd: join(tmpdir(), 'conex-daemon-mcp-close'),
      })
    );

    await factory.close();

    expect(closeCount).toBe(1);
    expect(factory.getMcpStatusSnapshot()).toMatchObject({
      configured: true,
      readiness: 'stopped',
    });
  });

  it('injects enabled scoped rules and skills into native stable prompt context', async () => {
    const factory = createFactory({
      scopedContextStore: new MemoryScopedContextStore([
        scopedRecord({
          id: 'workspace-rule',
          scope: 'workspace',
          kind: 'rule',
          activation: 'enabled',
          content: 'Use daemon scoped context in every product run.',
          order: 10,
        }),
        scopedRecord({
          id: 'global-skill',
          scope: 'global',
          kind: 'skill',
          activation: 'enabled',
          title: 'global skill',
          content: 'Read stable context before task-specific state.',
          order: 20,
        }),
      ]),
    });
    factory.setProviderFactory(() => new EmptyProvider());

    const input = createRunEngineInput({
      cwd: join(tmpdir(), 'conex-scoped-runtime'),
      metadata: {
        systemPrompt: 'Base system prompt.',
        workspaceRoot: tmpdir(),
      },
    });
    const runtimeOptions = await factory.createRuntimeOptions(input);
    const stableContext = runtimeOptions.promptContext?.stableContext ?? [];

    expect(runtimeOptions.systemPrompt).toBe('Base system prompt.');
    expect(stableContext.map((block) => block.id)).toEqual([
      'scoped-context:rules',
      'scoped-context:skills',
    ]);
    expect(JSON.stringify(stableContext)).toContain(
      'Use daemon scoped context in every product run.'
    );
    expect(JSON.stringify(stableContext)).toContain(
      'Read stable context before task-specific state.'
    );
    expect(input.run.metadata?.scopedContext).toMatchObject({
      status: 'ok',
      candidateCount: 0,
      composer: {
        stableBlockIds: ['scoped-context:rules', 'scoped-context:skills'],
        volatileBlockIds: [],
      },
    });
  });

  it('keeps recommended scoped items out of the stable prompt and exposes them as candidates', async () => {
    const factory = createFactory({
      scopedContextStore: new MemoryScopedContextStore([
        scopedRecord({
          id: 'enabled-rule',
          activation: 'enabled',
          content: 'Only enabled content reaches the model.',
        }),
        scopedRecord({
          id: 'recommended-skill',
          kind: 'skill',
          activation: 'recommended',
          title: 'recommended skill',
          content: 'Candidate content must not be injected yet.',
          order: 1,
        }),
      ]),
    });
    factory.setProviderFactory(() => new EmptyProvider());

    const input = createRunEngineInput({
      cwd: join(tmpdir(), 'conex-scoped-recommended'),
      metadata: { projectRoot: tmpdir() },
    });
    const runtimeOptions = await factory.createRuntimeOptions(input);

    expect(
      JSON.stringify(runtimeOptions.promptContext?.stableContext)
    ).toContain('Only enabled content reaches the model.');
    expect(
      JSON.stringify(runtimeOptions.promptContext?.stableContext)
    ).not.toContain('Candidate content must not be injected yet.');
    expect(input.run.metadata?.scopedContext).toMatchObject({
      candidateCount: 1,
      candidates: [
        expect.objectContaining({ id: 'recommended-skill', kind: 'skill' }),
      ],
    });
  });

  it('auto-discovers project rules and keeps project skills recommended until enabled', async () => {
    const projectRoot = join(
      tmpdir(),
      `conex-scoped-runtime-project-${Date.now()}`
    );
    await mkdir(join(projectRoot, '.conex', 'skills', 'reviewer'), {
      recursive: true,
    });
    await writeFile(
      join(projectRoot, 'AGENTS.md'),
      [
        '---',
        'id: project-auto-rule',
        'title: Project Auto Rule',
        '---',
        'Use the single daemon product path.',
      ].join('\n'),
      'utf8'
    );
    await writeFile(
      join(projectRoot, '.conex', 'skills', 'reviewer', 'SKILL.md'),
      [
        '---',
        'name: reviewer',
        'description: Review daemon architecture',
        '---',
        '# Reviewer',
        'Review architecture carefully.',
      ].join('\n'),
      'utf8'
    );

    const factory = createFactory({
      scopedContextStore: new MemoryScopedContextStore([]),
    });
    factory.setProviderFactory(() => new EmptyProvider());

    const recommendedInput = createRunEngineInput({
      cwd: projectRoot,
      metadata: { projectRoot },
    });
    const recommendedOptions =
      await factory.createRuntimeOptions(recommendedInput);
    const recommendedMetadata = recommendedInput.run.metadata
      ?.scopedContext as {
      candidates: Array<{ id: string }>;
      resourceRecordCount: number;
      storeRecordCount: number;
      candidateCount: number;
      resourceDiagnostics: unknown[];
    };
    const skillId = recommendedMetadata.candidates[0]!.id;

    expect(
      JSON.stringify(recommendedOptions.promptContext?.stableContext)
    ).toContain('Use the single daemon product path.');
    expect(
      JSON.stringify(recommendedOptions.promptContext?.stableContext)
    ).not.toContain('Review architecture carefully.');
    expect(recommendedMetadata).toMatchObject({
      resourceRecordCount: 2,
      storeRecordCount: 0,
      candidateCount: 1,
      resourceDiagnostics: [],
    });

    const enabledInput = createRunEngineInput({
      cwd: projectRoot,
      metadata: {
        projectRoot,
        scopedContextConfig: {
          userEnabledIds: [skillId],
        },
      },
    });
    const enabledOptions = await factory.createRuntimeOptions(enabledInput);

    expect(
      JSON.stringify(enabledOptions.promptContext?.stableContext)
    ).toContain('Use the single daemon product path.');
    expect(
      JSON.stringify(enabledOptions.promptContext?.stableContext)
    ).toContain('Review architecture carefully.');
    expect(enabledInput.run.metadata?.scopedContext).toMatchObject({
      resourceRecordCount: 2,
      candidateCount: 0,
    });
  });

  it('orders enabled scoped context by project, workspace, then global scope', async () => {
    const factory = createFactory({
      scopedContextStore: new MemoryScopedContextStore([
        scopedRecord({
          id: 'global-rule',
          scope: 'global',
          activation: 'enabled',
          content: 'Global rule.',
          order: 0,
        }),
        scopedRecord({
          id: 'project-rule',
          scope: 'project',
          activation: 'enabled',
          content: 'Project rule.',
          order: 100,
        }),
        scopedRecord({
          id: 'workspace-rule',
          scope: 'workspace',
          activation: 'enabled',
          content: 'Workspace rule.',
          order: 50,
        }),
      ]),
    });
    factory.setProviderFactory(() => new EmptyProvider());

    const input = createRunEngineInput({
      cwd: join(tmpdir(), 'conex-scoped-priority'),
      metadata: {
        projectRoot: tmpdir(),
        workspaceRoot: tmpdir(),
      },
    });
    await factory.createRuntimeOptions(input);

    const scopedContext = input.run.metadata?.scopedContext as {
      stableContext: Array<{
        id: string;
        content: { rules: Array<{ id: string }> };
      }>;
    };
    const rulesBlock = scopedContext.stableContext.find(
      (block) => block.id === 'scoped-context:rules'
    );
    expect(rulesBlock).toBeDefined();
    const rules = rulesBlock!.content.rules;
    expect(rules.map((rule) => rule.id)).toEqual([
      'project-rule',
      'workspace-rule',
      'global-rule',
    ]);
  });

  it('reports typed degraded diagnostics when no scoped context store is configured', async () => {
    const factory = createFactory();
    factory.setProviderFactory(() => new EmptyProvider());

    const input = createRunEngineInput({
      cwd: join(tmpdir(), 'conex-scoped-missing-store'),
    });
    const runtimeOptions = await factory.createRuntimeOptions(input);

    expect(runtimeOptions.systemPrompt).toBeUndefined();
    expect(runtimeOptions.promptContext?.stableContext).toEqual([]);
    expect(input.run.metadata?.scopedContext).toMatchObject({
      status: 'degraded',
      diagnosticCount: 1,
      storeDiagnostic: {
        code: 'SCOPED_CONTEXT_STORE_UNAVAILABLE',
      },
    });
  });

  it('throws typed unsupported errors for unwired artifact, memory, and checkpoint APIs', async () => {
    const factory = createFactory();

    await expect(factory.listArtifacts()).rejects.toThrow(
      DaemonUnsupportedCapabilityError
    );
    await expect(factory.listMemories()).rejects.toThrow(
      DaemonUnsupportedCapabilityError
    );
    await expect(factory.listCheckpoints()).rejects.toThrow(
      DaemonUnsupportedCapabilityError
    );
    await expect(
      factory.getArtifactContent('artifact://missing')
    ).rejects.toThrow(DaemonUnsupportedCapabilityError);
    await expect(factory.deleteMemory('memory_missing')).rejects.toThrow(
      DaemonUnsupportedCapabilityError
    );
    await expect(
      factory.restoreCheckpoint('checkpoint_missing')
    ).rejects.toThrow(DaemonUnsupportedCapabilityError);
    await expect(
      factory.getCheckpointDiff('checkpoint_missing')
    ).rejects.toThrow(DaemonUnsupportedCapabilityError);
    expect(factory.getProductAdapterStatusSnapshot()).toMatchObject({
      artifacts: { state: 'unsupported' },
      memory: { state: 'unsupported' },
      checkpoints: { state: 'unsupported' },
    });
  });

  it('lists checkpoint manifest records through an explicit checkpoint adapter', async () => {
    const manifestPath = join(
      tmpdir(),
      `conex-daemon-checkpoints-${Date.now()}.jsonl`
    );
    const workspaceRoot = join(tmpdir(), 'conex-daemon-checkpoint-workspace');
    const manifest = new CheckpointManifestService({ manifestPath });
    await manifest.append({
      sessionId: 'session_checkpoint',
      runId: 'run_checkpoint',
      userMessageId: 'user_checkpoint',
      checkpointId: 'checkpoint_1',
      checkpointRef: 'checkpoint://runtime/1',
      workspaceRoot,
      changedPaths: ['src/a.ts', 'src/b.ts'],
      source: 'runtime',
      createdAt: '2026-06-08T00:00:00.000Z',
      metadata: { label: 'before multi-file edit' },
    });
    await manifest.append({
      sessionId: 'session_other',
      runId: 'run_other',
      userMessageId: 'user_other',
      checkpointId: 'checkpoint_other',
      checkpointRef: 'checkpoint://runtime/other',
      workspaceRoot,
      changedPaths: ['other.ts'],
      source: 'runtime',
      createdAt: '2026-06-08T00:01:00.000Z',
    });

    const factory = createFactory({
      productAdapters: {
        checkpoint: new DaemonCheckpointManifestAdapter({ manifestPath }),
      },
    });

    await expect(
      factory.listCheckpoints(undefined, 'session_checkpoint')
    ).resolves.toEqual([
      {
        id: 'checkpoint_1',
        runId: 'run_checkpoint',
        sessionId: 'session_checkpoint',
        label: 'before multi-file edit',
        createdAt: '2026-06-08T00:00:00.000Z',
        messageCount: 2,
      },
    ]);
    await expect(factory.getCheckpointDiff('checkpoint_1')).resolves.toEqual([
      { path: 'src/a.ts', status: 'changed' },
      { path: 'src/b.ts', status: 'changed' },
    ]);
    await expect(
      factory.restoreCheckpoint('checkpoint_1')
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      capability: 'checkpoints',
    });
    expect(
      factory.getProductAdapterStatusSnapshot(
        new Date('2026-06-08T00:00:00.000Z')
      )
    ).toMatchObject({
      checkpoints: {
        state: 'experimental',
        operations: ['list', 'diff'],
        diagnostics: [
          expect.objectContaining({
            code: 'CHECKPOINT_MANIFEST_ADAPTER_READY',
          }),
        ],
      },
      artifacts: { state: 'unsupported' },
      memory: { state: 'unsupported' },
    });
  });
});

function createFactory(
  options: {
    sessionStoreDir?: string;
    scopedContextStore?: ScopedContextStore;
    productAdapters?: DaemonProductAdapters;
    mcpServers?: McpServerDefinition[];
    mcpLifecycleManagerFactory?: DaemonMcpLifecycleManagerFactory;
  } = {}
): DaemonRuntimeFactory {
  return new DaemonRuntimeFactory({
    config: {
      port: 0,
      maxConcurrentRuns: 5,
      runtimeIdleTimeoutMs: 300_000,
      approvalTimeoutMs: 300_000,
      defaultCwd: '/tmp/test',
      noProjectCwd: '/tmp/test-no-project',
      sessionEventLogDir: '/tmp/test-events',
      workflowStorePath: '/tmp/test-workflows.json',
      planDocumentStorePath: '/tmp/test-plan-docs.json',
      scopedContextStorePath: '/tmp/test-scoped-context.json',
      memoryStorePath: '/tmp/test-memories.jsonl',
      workflowSchedulerIntervalMs: 30_000,
      secretToken: undefined,
      apiKeyLast4Exposure: undefined,
      healthPort: 0,
      metricsPort: 0,
      eventLogMaxSizeBytes: 100 * 1024 * 1024,
      eventLogMaxArchives: 10,
      mcpServers: undefined,
    } as DaemonConfig,
    approvalQueue: new ApprovalQueue(),
    ...(options.sessionStoreDir !== undefined ? { sessionStoreDir: options.sessionStoreDir } : {}),
    ...(options.scopedContextStore !== undefined ? { scopedContextStore: options.scopedContextStore } : {}),
    ...(options.productAdapters !== undefined ? { productAdapters: options.productAdapters } : {}),
    ...(options.mcpServers !== undefined ? { mcpServers: options.mcpServers } : {}),
    ...(options.mcpLifecycleManagerFactory !== undefined ? { mcpLifecycleManagerFactory: options.mcpLifecycleManagerFactory } : {}),
    startRun: async () => {
      throw new Error('Subagent startRun should not be called in this test');
    },
    cancelRun: (runId: string, reason?: string) => false,
  } as DaemonRuntimeFactoryOptions);
}

function createTestTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `${name} test tool`,
    inputSchema: { type: 'object', properties: {} },
    category: 'mcp',
    concurrency: 'parallel',
    isReadOnly: () => true,
    summarize: () => name,
    execute: async () => ({ text: `${name} ok` }),
  };
}

function createRunEngineInput(input: {
  cwd: string;
  sessionId?: string;
  metadata?: JsonObject;
}): CreateRunEngineInput {
  const sessionId = input.sessionId ?? 'session_test';
  return {
    runId: 'run_test',
    session: {
      id: sessionId,
      cwd: input.cwd,
      createdAt: '2026-06-07T00:00:00.000Z',
      updatedAt: '2026-06-07T00:00:00.000Z',
      status: 'open',
    },
    run: {
      id: 'run_test',
      sessionId,
      cwd: input.cwd,
      status: 'queued',
      createdAt: '2026-06-07T00:00:00.000Z',
      updatedAt: '2026-06-07T00:00:00.000Z',
      metadata: input.metadata ?? {},
    },
  };
}

function scopedRecord(
  overrides: Partial<ScopedContextRecord> = {}
): ScopedContextRecord {
  return {
    id: 'record',
    kind: 'rule',
    title: 'Scoped record',
    content: 'Scoped context content.',
    description: undefined,
    scope: 'project',
    activation: 'enabled',
    appliesTo: [],
    tags: [],
    source: { type: 'user', label: 'test' },
    sourceMetadata: { origin: 'runtime-factory-test' },
    order: 0,
    updatedAt: '2026-06-08T00:00:00.000Z',
    ...overrides,
  };
}

class MemoryScopedContextStore implements ScopedContextStore {
  constructor(private readonly records: ScopedContextRecord[]) {}

  async list(
    filter: ScopedContextListFilter = {}
  ) {
    return {
      status: 'ok' as const,
      records: this.records.filter(
        (record) =>
          (filter.scope === undefined || record.scope === filter.scope) &&
          (filter.kind === undefined || record.kind === filter.kind)
      ),
      diagnostic: undefined,
    };
  }

  async upsert(record: ScopedContextRecord) {
    return {
      status: 'ok' as const,
      persisted: true,
      record,
    };
  }

  async delete(recordId: string) {
    return {
      status: 'ok' as const,
      persisted: true,
      recordId,
      deleted: false,
    };
  }
}

function sessionStoreFilePath(
  runtimeOptions: Awaited<
    ReturnType<DaemonRuntimeFactory['createRuntimeOptions']>
  >
): string {
  return (runtimeOptions.sessionStore as unknown as { filePath: string })
    .filePath;
}

class EmptyProvider implements AgentProvider {
  readonly id = 'empty-provider';

  async *stream(
    request: AgentProviderRequest
  ): AsyncIterable<ProviderStreamEvent> {
    void request;
    yield { type: 'stop', reason: 'stop' };
  }
}

function createStatusProviderFactory(): (() => EmptyProvider) & {
  getProviderStatusSnapshot(): ReturnType<typeof createStatusSnapshot>;
} {
  const factory = () => new EmptyProvider();
  factory.getProviderStatusSnapshot = createStatusSnapshot;
  return factory;
}

function createStatusSnapshot() {
  return {
    credentialMode: 'direct' as const,
    readiness: 'ready' as const,
    providerId: 'crish',
    routeId: 'default:crish:mimo-v2.5',
    baseUrl: 'https://gateway.example/v1',
    model: 'mimo-v2.5',
    upstreamModel: 'mimo-v2.5',
    endpoint: 'auto',
    stream: true,
    apiKey: {
      hasApiKey: true,
      source: 'env' as const,
    },
    hasDirectApiKey: true,
    apiKeySource: 'env' as const,
    gateway: {
      ready: true,
      credentialConfigured: true,
      routeDecision: [
        'capability_required_endpoint:responses',
        'capability_required_streaming:streaming',
        'model_route_rejection:endpoint:unsupported:responses:1',
        'selected_route',
      ],
      selectedEndpointSupport: 'responses' as const,
      selectedStreamingSupport: 'streaming' as const,
    },
    updatedAt: '2026-06-08T00:00:00.000Z',
  };
}
