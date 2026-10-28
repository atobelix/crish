/**
 * 外部会话导入：scan → map（parse*）→ write 接线（memory FS / inject）
 * 含 soft-dedup：同一 source+sourceSessionId 再导入跳过。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildImportMeta,
  collectExistingImportKeys,
  importDetectedSessions,
  writeMappedSession,
} from './importSessions';
import {
  allowRootFor,
  draftToSessionMessage,
  mapExternalRoleToSender,
  mapExternalSession,
} from './map';
import { scanClaudeCodeSessions, scanCodexSessions } from './scan';
import {
  allowRootFromSessionPath,
  createMemoryImportFs,
  resolveHostImportEnv,
} from './importFsHost';
import {
  makeExternalImportKey,
  type DetectedExternalSession,
  type MappedImportSession,
} from './types';

describe('import scan (real detect path + inject)', () => {
  it('returns empty when inject is empty', async () => {
    await expect(scanClaudeCodeSessions({ inject: [] })).resolves.toEqual({
      source: 'claude-code',
      sessions: [],
      issues: [],
    });
    await expect(scanCodexSessions({ inject: [] })).resolves.toEqual({
      source: 'codex',
      sessions: [],
      issues: [],
    });
  });

  it('respects inject filter by source', async () => {
    const inject: DetectedExternalSession[] = [
      {
        id: 'c1',
        source: 'claude-code',
        title: 'A',
        messageCount: 2,
      },
      {
        id: 'x1',
        source: 'codex',
        title: 'B',
        messageCount: 1,
      },
    ];
    const claude = await scanClaudeCodeSessions({ inject });
    const codex = await scanCodexSessions({ inject });
    expect(claude.sessions).toHaveLength(1);
    expect(claude.sessions[0]!.id).toBe('c1');
    expect(codex.sessions).toHaveLength(1);
    expect(codex.sessions[0]!.id).toBe('x1');
  });

  it('keeps successful sessions and reports unreadable projects as a partial scan', async () => {
    const sessionUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const path = `/home/u/.claude/projects/ok/${sessionUuid}.jsonl`;
    const fs = createMemoryImportFs({
      [path]: '{"type":"user","cwd":"/ok"}\n',
      '/home/u/.claude/projects/unreadable/ignored/placeholder.jsonl': '',
    });
    const listDir = fs.listDir.bind(fs);
    fs.listDir = async (dirPath, allowRoot) => {
      if (dirPath === '/home/u/.claude/projects/unreadable') {
        throw new Error('permission denied');
      }
      return listDir(dirPath, allowRoot);
    };

    const result = await scanClaudeCodeSessions({
      fs,
      env: { home: '/home/u', platform: 'linux', sep: '/' },
    });

    expect(result.sessions.map((session) => session.id)).toContain(sessionUuid);
    expect(result.issues).toEqual([
      {
        source: 'claude-code',
        kind: 'warning',
        message: 'Skip unreadable project: unreadable',
      },
    ]);
  });

  it('reports an unreadable root as a source error instead of a successful empty scan', async () => {
    const fs = createMemoryImportFs({});
    fs.listDir = async (dirPath) => {
      if (dirPath === '/home/u/.claude/projects') {
        throw new Error('permission denied');
      }
      return [];
    };

    const result = await scanClaudeCodeSessions({
      fs,
      env: { home: '/home/u', platform: 'linux', sep: '/' },
    });

    expect(result.sessions).toEqual([]);
    expect(result.issues).toEqual([
      {
        source: 'claude-code',
        kind: 'error',
        message: 'Claude projects dir not readable: /home/u/.claude/projects',
      },
    ]);
  });

  it('turns scan setup exceptions into source-specific errors', async () => {
    const env = Object.defineProperty({}, 'home', {
      get() {
        throw new Error('host path resolution failed');
      },
    });

    const result = await scanCodexSessions({ env: env as never });

    expect(result.sessions).toEqual([]);
    expect(result.issues).toEqual([
      {
        source: 'codex',
        kind: 'error',
        message: 'host path resolution failed',
      },
    ]);
  });

  it('scanClaudeCodeSessions uses detect + memory FS (OPT-1 path)', async () => {
    const sessionUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const content =
      '{"type":"user","timestamp":"2026-07-01T10:00:00.000Z","cwd":"/proj","message":{"role":"user","content":"Hello scan"}}\n' +
      '{"type":"custom-title","customTitle":"Scan title"}\n';
    const path = `/home/u/.claude/projects/C--proj/${sessionUuid}.jsonl`;
    const fs = createMemoryImportFs({ [path]: content });
    const list = await scanClaudeCodeSessions({
      fs,
      env: { home: '/home/u', platform: 'linux', sep: '/' },
    });
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0]!.id).toBe(sessionUuid);
    expect(list.sessions[0]!.title).toBe('Scan title');
    expect(list.sessions[0]!.path).toBe(path);
    expect(list.sessions[0]!.source).toBe('claude-code');
  });
});

describe('host path env + allowRoot', () => {
  it('resolveHostImportEnv keeps explicit home', async () => {
    const env = await resolveHostImportEnv({
      home: 'C:\\Users\\dev',
      platform: 'win32',
      sep: '\\',
    });
    expect(env.home).toBe('C:\\Users\\dev');
    expect(env.platform).toBe('win32');
  });

  it('allowRootFromSessionPath extracts .claude / .codex roots', () => {
    expect(
      allowRootFromSessionPath(
        'C:\\Users\\dev\\.claude\\projects\\x\\a.jsonl',
        'claude-code'
      )
    ).toBe('C:\\Users\\dev\\.claude');
    expect(
      allowRootFromSessionPath(
        '/home/u/.codex/sessions/2026/07/02/rollout-x.jsonl',
        'codex'
      )
    ).toBe('/home/u/.codex');
  });

  it('allowRootFor prefers path-derived root', () => {
    const root = allowRootFor(
      {
        id: '1',
        source: 'claude-code',
        title: 't',
        messageCount: 1,
        path: '/home/u/.claude/projects/p/s.jsonl',
      },
      { home: '/other' }
    );
    expect(root).toBe('/home/u/.claude');
  });
});

describe('mapExternalRoleToSender', () => {
  it('maps user roles', () => {
    expect(mapExternalRoleToSender('user')).toBe('user');
    expect(mapExternalRoleToSender('Human')).toBe('user');
  });

  it('maps other roles to assistant', () => {
    expect(mapExternalRoleToSender('assistant')).toBe('assistant');
    expect(mapExternalRoleToSender('system')).toBe('assistant');
    expect(mapExternalRoleToSender(undefined)).toBe('assistant');
  });
});

describe('draftToSessionMessage（E3 宿主适配回归：插件中立载荷 → store 消息）', () => {
  it('文本草稿 → SessionMessage（role→sender、status、timestamp）', () => {
    const msg = draftToSessionMessage({
      id: 'm1',
      role: 'user',
      text: 'hi',
      timestampMs: 1000,
    });
    expect(msg.sender).toBe('user');
    expect(msg.text).toBe('hi');
    expect(msg.timestamp).toBe(1000);
    expect(msg.status).toBe('completed');
  });

  it('工具调用草稿 → MessageToolCall（running 无输出强制 success + blocks 透传）', () => {
    const msg = draftToSessionMessage({
      id: 'm2',
      role: 'assistant',
      timestampMs: 2,
      toolCalls: [{ id: 't1', name: 'Bash', status: 'running', output: 'out' }],
      blocks: [
        { type: 'text', content: 'x' },
        { type: 'tool_call', id: 't1' },
      ],
    });
    expect(msg.sender).toBe('assistant');
    expect(msg.toolCalls?.[0]).toMatchObject({
      id: 't1',
      name: 'Bash',
      status: 'success',
    });
    expect(msg.toolCalls?.[0]?.output).toBe('out');
    expect(msg.blocks).toHaveLength(2);
  });

  it('isError 工具调用 → status error', () => {
    const msg = draftToSessionMessage({
      id: 'm3',
      role: 'assistant',
      timestampMs: 3,
      toolCalls: [{ id: 't2', name: 'Bash', isError: true }],
    });
    expect(msg.toolCalls?.[0]?.status).toBe('error');
  });
});

describe('map + write', () => {
  it('mapExternalSession builds shell with title/folder when no path', async () => {
    const mapped = await mapExternalSession({
      id: 'ext-1',
      source: 'codex',
      title: '调试网络',
      project: 'my-app',
      messageCount: 0,
    });
    expect(mapped.title).toBe('调试网络');
    expect(mapped.folder).toBe('my-app');
    expect(mapped.messages).toEqual([]);
    expect(mapped.sourceId).toBe('ext-1');
  });

  it('mapExternalSession parses fixture path via inject fs', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { createMemoryImportFs } = await import('./importFsHost');
    const dir = dirname(fileURLToPath(import.meta.url));
    const content = readFileSync(
      join(dir, '__fixtures__/claude-code-sample.jsonl'),
      'utf8'
    );
    const path =
      '/home/u/.claude/projects/x/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl';
    const fs = createMemoryImportFs({ [path]: content });
    const mapped = await mapExternalSession(
      {
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        source: 'claude-code',
        title: 'Demo layout walkthrough',
        project: 'demo-project',
        messageCount: 4,
        path,
      },
      { fs }
    );
    expect(mapped.messages.length).toBeGreaterThan(0);
    expect(mapped.messages[0]?.sender).toBe('user');
    expect(mapped.folder).toBe('demo-project');
  });

  it('writeMappedSession creates session and adds messages via deps', () => {
    const createSession = vi.fn(() => 'sess-new');
    const addMessage = vi.fn();
    const mapped: MappedImportSession = {
      source: 'claude-code',
      sourceId: 'c1',
      title: '导入标题',
      folder: 'proj',
      path: '/home/u/.claude/projects/x/c1.jsonl',
      messages: [
        {
          id: 'm1',
          sender: 'user',
          text: 'hi',
          timestamp: 1,
        },
      ],
    };
    const id = writeMappedSession(mapped, {
      createSession,
      addMessage,
      wsId: 'ws',
      nowIso: () => '2026-07-29T00:00:00.000Z',
    });
    expect(id).toBe('sess-new');
    expect(createSession).toHaveBeenCalledWith({
      id: 'sess-import-claude-c1',
      title: '导入标题',
      folder: 'proj',
      activate: false,
      importMeta: {
        source: 'claude-code',
        sourceSessionId: 'c1',
        sourcePath: '/home/u/.claude/projects/x/c1.jsonl',
        importedAt: '2026-07-29T00:00:00.000Z',
      },
    });
    expect(addMessage).toHaveBeenCalledWith(
      'ws',
      'sess-new',
      mapped.messages[0]
    );
  });

  it('importDetectedSessions maps then writes', async () => {
    const createSession = vi.fn(() => 'sess-i');
    const addMessage = vi.fn();
    const selected: DetectedExternalSession[] = [
      {
        id: 'd1',
        source: 'claude-code',
        title: 'T1',
        messageCount: 0,
      },
    ];
    const result = await importDetectedSessions(selected, {
      createSession,
      addMessage,
      listSessions: () => [],
    });
    expect(result.imported).toBe(1);
    expect(result.skippedDuplicates).toBe(0);
    expect(result.sessionIds).toEqual(['sess-i']);
    expect(createSession).toHaveBeenCalledOnce();
    expect(createSession.mock.calls[0]?.[0]?.importMeta).toMatchObject({
      source: 'claude-code',
      sourceSessionId: 'd1',
    });
  });

  it('importDetectedSessions empty selection is no-op', async () => {
    const result = await importDetectedSessions([]);
    expect(result).toEqual({
      imported: 0,
      skipped: 0,
      skippedDuplicates: 0,
      errors: [],
      sessionIds: [],
    });
  });

  it('importDetectedSessions end-to-end: scan → import with memory FS + fixture', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = dirname(fileURLToPath(import.meta.url));
    const content = readFileSync(
      join(dir, '__fixtures__/claude-code-sample.jsonl'),
      'utf8'
    );
    const sessionUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const path = `/home/u/.claude/projects/demo/${sessionUuid}.jsonl`;
    const fs = createMemoryImportFs({ [path]: content });
    const env = {
      home: '/home/u',
      platform: 'linux' as const,
      sep: '/' as const,
    };

    const detected = await scanClaudeCodeSessions({ fs, env });
    expect(detected.sessions.length).toBeGreaterThan(0);

    const createSession = vi.fn(() => 'sess-e2e');
    const addMessage = vi.fn();
    const result = await importDetectedSessions(detected.sessions, {
      createSession,
      addMessage,
      fs,
      env,
      listSessions: () => [],
    });
    expect(result.imported).toBe(1);
    expect(result.errors).toEqual([]);
    expect(addMessage.mock.calls.length).toBeGreaterThan(0);
    expect(addMessage.mock.calls[0]?.[2]?.sender).toBe('user');
  });
});

describe('soft-dedup (source + sourceSessionId)', () => {
  it('makeExternalImportKey / collectExistingImportKeys / buildImportMeta', () => {
    expect(makeExternalImportKey('claude-code', 'abc')).toBe(
      'claude-code::abc'
    );
    expect(makeExternalImportKey('codex', 'x')).toBe('codex::x');

    const keys = collectExistingImportKeys([
      { importMeta: { source: 'claude-code', sourceSessionId: 'a1' } },
      { importMeta: undefined },
      { importMeta: { source: 'codex', sourceSessionId: 'c1' } },
      {},
    ]);
    expect(keys.has('claude-code::a1')).toBe(true);
    expect(keys.has('codex::c1')).toBe(true);
    expect(keys.size).toBe(2);

    const meta = buildImportMeta(
      {
        source: 'codex',
        sourceId: 'roll-1',
        title: 't',
        messages: [],
        path: '/p/roll.jsonl',
      },
      '2026-01-01T00:00:00.000Z'
    );
    expect(meta).toEqual({
      source: 'codex',
      sourceSessionId: 'roll-1',
      sourcePath: '/p/roll.jsonl',
      importedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('skips re-import when existing session has matching importMeta', async () => {
    const createSession = vi.fn(() => 'sess-new');
    const addMessage = vi.fn();
    const selected: DetectedExternalSession[] = [
      {
        id: 'already-there',
        source: 'claude-code',
        title: '已导入过',
        messageCount: 2,
      },
      {
        id: 'fresh-one',
        source: 'claude-code',
        title: '新会话',
        messageCount: 1,
      },
    ];
    const result = await importDetectedSessions(selected, {
      createSession,
      addMessage,
      listSessions: () => [
        {
          id: 'sess-old',
          importMeta: {
            source: 'claude-code',
            sourceSessionId: 'already-there',
          },
        },
      ],
    });
    expect(result.imported).toBe(1);
    expect(result.skippedDuplicates).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.sessionIds).toEqual(['sess-new']);
    expect(createSession).toHaveBeenCalledOnce();
    expect(createSession.mock.calls[0]?.[0]?.importMeta?.sourceSessionId).toBe(
      'fresh-one'
    );
  });

  it('skips all when every selected is already imported', async () => {
    const createSession = vi.fn(() => 'x');
    const result = await importDetectedSessions(
      [
        {
          id: 'dup-1',
          source: 'codex',
          title: 'D1',
          messageCount: 0,
        },
      ],
      {
        createSession,
        addMessage: vi.fn(),
        listSessions: () => [
          {
            id: 's1',
            importMeta: { source: 'codex', sourceSessionId: 'dup-1' },
          },
        ],
      }
    );
    expect(result.imported).toBe(0);
    expect(result.skippedDuplicates).toBe(1);
    expect(result.skipped).toBe(1);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('dedupes within the same batch (duplicate selection keys)', async () => {
    const createSession = vi.fn(() => 'sess-once');
    const selected: DetectedExternalSession[] = [
      { id: 'same', source: 'claude-code', title: 'A', messageCount: 0 },
      { id: 'same', source: 'claude-code', title: 'A-again', messageCount: 0 },
    ];
    const result = await importDetectedSessions(selected, {
      createSession,
      addMessage: vi.fn(),
      listSessions: () => [],
    });
    expect(result.imported).toBe(1);
    expect(result.skippedDuplicates).toBe(1);
    expect(createSession).toHaveBeenCalledOnce();
  });

  it('duplicatePolicy reimport allows writing again', async () => {
    let n = 0;
    const createSession = vi.fn(() => `sess-${++n}`);
    const selected: DetectedExternalSession[] = [
      {
        id: 're-1',
        source: 'claude-code',
        title: '再导',
        messageCount: 0,
      },
    ];
    const result = await importDetectedSessions(selected, {
      createSession,
      addMessage: vi.fn(),
      duplicatePolicy: 'reimport',
      listSessions: () => [
        {
          id: 'old',
          importMeta: { source: 'claude-code', sourceSessionId: 're-1' },
        },
      ],
    });
    expect(result.imported).toBe(1);
    expect(result.skippedDuplicates).toBe(0);
    expect(createSession).toHaveBeenCalledOnce();
  });

  it('different sources with same sourceId do not collide', async () => {
    const createSession = vi.fn(() => 'sess-x');
    const result = await importDetectedSessions(
      [
        {
          id: 'shared-id',
          source: 'codex',
          title: 'Codex copy',
          messageCount: 0,
        },
      ],
      {
        createSession,
        addMessage: vi.fn(),
        listSessions: () => [
          {
            id: 's-claude',
            importMeta: {
              source: 'claude-code',
              sourceSessionId: 'shared-id',
            },
          },
        ],
      }
    );
    expect(result.imported).toBe(1);
    expect(result.skippedDuplicates).toBe(0);
  });
});
