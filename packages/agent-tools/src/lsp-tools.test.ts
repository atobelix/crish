import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLspDefinitionTool,
  createLspDiagnosticsTool,
  createLspReferencesTool,
  createLspRenameTool,
  type LanguageServerClient,
  type LspClientRequestContext,
  type LspDocumentRequest,
  type LspPositionRequest,
  type LspReferencesRequest,
  type LspRenameRequest,
} from './lsp-tools';
import type { ToolExecutionContext } from '@crish/shared-types';

let workspaceRoot = '';

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-runtime-lsp-'));
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function context(signal = new AbortController().signal): ToolExecutionContext {
  return {
    toolCallId: 'call',
    sessionId: 'session',
    cwd: workspaceRoot,
    signal,
    emit: () => undefined,
  };
}

function range(
  startLine: number,
  startCharacter: number,
  endLine = startLine,
  endCharacter = startCharacter + 1
) {
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

function client(
  overrides: Partial<LanguageServerClient>
): LanguageServerClient {
  return {
    getDiagnostics: () => ({ diagnostics: [] }),
    getDefinition: () => ({ definitions: [] }),
    getReferences: () => ({ references: [] }),
    rename: () => ({ workspaceEdit: { changes: [] } }),
    ...overrides,
  };
}

describe('LSP tools', () => {
  it('returns typed diagnostics for a workspace file', async () => {
    let seenRequest: LspDocumentRequest | undefined;
    let seenContext: LspClientRequestContext | undefined;
    const tool = createLspDiagnosticsTool({
      workspaceRoot,
      client: client({
        getDiagnostics(request, lspContext) {
          seenRequest = request;
          seenContext = lspContext;
          return {
            diagnostics: [
              {
                path: 'src/main.ts',
                range: range(1, 2, 1, 8),
                severity: 'error',
                message: 'Unknown symbol',
                source: 'ts',
                code: 2304,
                tags: ['deprecated'],
              },
            ],
            metadata: { server: 'fake-ts' },
          };
        },
      }),
      defaultTimeoutMs: 500,
    });

    const output = await tool.execute({ path: 'src/main.ts' }, context());

    expect(seenRequest).toMatchObject({
      path: join('src', 'main.ts'),
    });
    expect(seenRequest?.absolutePath).toBe(
      join(workspaceRoot, 'src', 'main.ts')
    );
    expect(seenRequest?.uri).toMatch(/^file:/);
    expect(seenContext).toMatchObject({ workspaceRoot, timeoutMs: 500 });
    expect(seenContext?.signal.aborted).toBe(false);
    expect(output.text).toContain(
      `${join('src', 'main.ts')}:2:3: error ts 2304: Unknown symbol`
    );
    expect(output.json).toMatchObject({
      path: join('src', 'main.ts'),
      count: 1,
      metadata: { server: 'fake-ts' },
      diagnostics: [
        {
          path: join('src', 'main.ts'),
          range: range(1, 2, 1, 8),
          severity: 'error',
          message: 'Unknown symbol',
          source: 'ts',
          code: 2304,
          tags: ['deprecated'],
        },
      ],
    });
  });

  it('rejects workspace paths that escape the root', async () => {
    const tool = createLspDefinitionTool({ workspaceRoot, client: client({}) });

    await expect(
      tool.execute(
        { path: '../outside.ts', position: { line: 0, character: 0 } },
        context()
      )
    ).rejects.toThrow(/Path escapes workspace/);
  });

  it('passes positions, timeout, and abort signal to definition requests', async () => {
    let seenRequest: LspPositionRequest | undefined;
    let seenContext: LspClientRequestContext | undefined;
    const tool = createLspDefinitionTool({
      workspaceRoot,
      client: client({
        getDefinition(request, lspContext) {
          seenRequest = request;
          seenContext = lspContext;
          return {
            definitions: [
              {
                path: 'src/target.ts',
                range: range(3, 4, 3, 12),
                selectionRange: range(3, 4, 3, 10),
              },
            ],
          };
        },
      }),
    });

    const output = await tool.execute(
      {
        path: 'src/main.ts',
        position: { line: 2, character: 5 },
        timeoutMs: 123,
      },
      context()
    );

    expect(seenRequest).toMatchObject({
      path: join('src', 'main.ts'),
      position: { line: 2, character: 5 },
    });
    expect(seenContext?.timeoutMs).toBe(123);
    expect(seenContext?.signal).toBeInstanceOf(AbortSignal);
    expect(output.text).toBe(`${join('src', 'target.ts')}:4:5-4:13`);
    expect(output.json).toMatchObject({
      path: join('src', 'main.ts'),
      position: { line: 2, character: 5 },
      count: 1,
      definitions: [
        {
          path: join('src', 'target.ts'),
          range: range(3, 4, 3, 12),
          selectionRange: range(3, 4, 3, 10),
        },
      ],
    });
  });

  it('aborts requests that exceed the configured timeout', async () => {
    let seenSignal: AbortSignal | undefined;
    const tool = createLspDefinitionTool({
      workspaceRoot,
      client: client({
        getDefinition(_request, lspContext) {
          seenSignal = lspContext.signal;
          return new Promise(() => undefined);
        },
      }),
    });

    await expect(
      tool.execute(
        {
          path: 'src/main.ts',
          position: { line: 0, character: 0 },
          timeoutMs: 5,
        },
        context()
      )
    ).rejects.toThrow(/timed out after 5ms/);
    expect(seenSignal?.aborted).toBe(true);
  });

  it('returns references with includeDeclaration preserved', async () => {
    let seenRequest: LspReferencesRequest | undefined;
    const tool = createLspReferencesTool({
      workspaceRoot,
      client: client({
        getReferences(request) {
          seenRequest = request;
          return {
            references: [
              { path: 'src/main.ts', range: range(0, 1) },
              { path: 'src/other.ts', range: range(4, 2, 4, 9) },
            ],
          };
        },
      }),
    });

    const output = await tool.execute(
      {
        path: 'src/main.ts',
        position: { line: 0, character: 1 },
        includeDeclaration: true,
      },
      context()
    );

    expect(seenRequest).toMatchObject({ includeDeclaration: true });
    expect(output.text).toContain(`${join('src', 'main.ts')}:1:2-1:3`);
    expect(output.text).toContain(`${join('src', 'other.ts')}:5:3-5:10`);
    expect(output.json).toMatchObject({
      count: 2,
      includeDeclaration: true,
      references: [
        { path: join('src', 'main.ts'), range: range(0, 1) },
        { path: join('src', 'other.ts'), range: range(4, 2, 4, 9) },
      ],
    });
  });

  it('returns rename workspace edits without applying them', async () => {
    let seenRequest: LspRenameRequest | undefined;
    const tool = createLspRenameTool({
      workspaceRoot,
      client: client({
        rename(request) {
          seenRequest = request;
          return {
            workspaceEdit: {
              changes: [
                {
                  path: 'src/main.ts',
                  edits: [
                    { range: range(0, 7, 0, 10), newText: 'nextName' },
                    { range: range(2, 1, 2, 4), newText: 'nextName' },
                  ],
                },
                {
                  path: 'src/other.ts',
                  edits: [{ range: range(1, 0, 1, 3), newText: 'nextName' }],
                },
              ],
            },
          };
        },
      }),
    });

    const output = await tool.execute(
      {
        path: 'src/main.ts',
        position: { line: 0, character: 8 },
        newName: 'nextName',
      },
      context()
    );

    expect(tool.isReadOnly({})).toBe(true);
    expect(seenRequest).toMatchObject({
      path: join('src', 'main.ts'),
      position: { line: 0, character: 8 },
      newName: 'nextName',
    });
    expect(output.text).toContain(`${join('src', 'main.ts')}: 2 edits`);
    expect(output.text).toContain(`${join('src', 'other.ts')}: 1 edit`);
    expect(output.json).toMatchObject({
      fileCount: 2,
      editCount: 3,
      workspaceEdit: {
        changes: [
          {
            path: join('src', 'main.ts'),
            edits: [
              { range: range(0, 7, 0, 10), newText: 'nextName' },
              { range: range(2, 1, 2, 4), newText: 'nextName' },
            ],
          },
          {
            path: join('src', 'other.ts'),
            edits: [{ range: range(1, 0, 1, 3), newText: 'nextName' }],
          },
        ],
      },
    });
  });

  it('rejects rename edits outside the workspace', async () => {
    const tool = createLspRenameTool({
      workspaceRoot,
      client: client({
        rename() {
          return {
            workspaceEdit: {
              changes: [
                {
                  path: '../outside.ts',
                  edits: [{ range: range(0, 0), newText: 'x' }],
                },
              ],
            },
          };
        },
      }),
    });

    await expect(
      tool.execute(
        {
          path: 'src/main.ts',
          position: { line: 0, character: 0 },
          newName: 'x',
        },
        context()
      )
    ).rejects.toThrow(/Path escapes workspace/);
  });
});
