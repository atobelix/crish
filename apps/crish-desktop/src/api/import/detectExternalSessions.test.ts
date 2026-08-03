import { afterEach, describe, expect, it } from 'vitest';
import {
  detectExternalSessions,
  estimateLineCount,
  extractClaudeTitlePreview,
  extractCodexTitlePreview,
  extractJsonStringField,
  joinImportPath,
  mungeProjectPath,
  resolveDefaultImportRoots,
  truncatePreview,
} from '@crish/plugin-import-claude-codex';
import { createMemoryImportFs } from './importFsHost';
import {
  getPersistedImportRoots,
  hasCustomImportRoot,
  mergeImportPathEnv,
  setPersistedClaudeImportRoot,
  setPersistedCodexImportRoot,
} from './importRootSettings';
import {
  IMPORT_CLAUDE_ROOT_KEY,
  IMPORT_CODEX_ROOT_KEY,
} from '../../utils/storageKeys';

describe('resolveDefaultImportRoots', () => {
  it('builds Windows-style roots from home', () => {
    const roots = resolveDefaultImportRoots({
      home: 'C:\\Users\\dev',
      platform: 'win32',
      sep: '\\',
    });
    expect(roots.claudeConfig).toBe('C:\\Users\\dev\\.claude');
    expect(roots.claudeProjects).toBe('C:\\Users\\dev\\.claude\\projects');
    expect(roots.codexSessions).toBe('C:\\Users\\dev\\.codex\\sessions');
  });

  it('honors CLAUDE_CONFIG_DIR / CODEX_HOME overrides via env arg', () => {
    const roots = resolveDefaultImportRoots({
      home: '/home/u',
      platform: 'linux',
      sep: '/',
      claudeConfigDir: '/custom/claude',
      codexHome: '/custom/codex',
    });
    expect(roots.claudeProjects).toBe('/custom/claude/projects');
    expect(roots.codexSessions).toBe('/custom/codex/sessions');
  });

  it('empty override fields fall back to default home roots', () => {
    const roots = resolveDefaultImportRoots({
      home: '/home/u',
      platform: 'linux',
      sep: '/',
      claudeConfigDir: '   ',
      codexHome: '',
    });
    expect(roots.claudeConfig).toBe('/home/u/.claude');
    expect(roots.codexHome).toBe('/home/u/.codex');
  });

  it('mungeProjectPath matches Claude non-alnum rule', () => {
    expect(mungeProjectPath('C:\\Software\\conex')).toBe('C--Software-conex');
    expect(mungeProjectPath('/Users/foo/my-project')).toBe('-Users-foo-my-project');
  });
});

describe('mergeImportPathEnv / persisted roots', () => {
  afterEach(() => {
    try {
      localStorage.removeItem(IMPORT_CLAUDE_ROOT_KEY);
      localStorage.removeItem(IMPORT_CODEX_ROOT_KEY);
    } catch {
      /* ignore */
    }
  });

  it('mergeImportPathEnv prefers explicit base over persisted', () => {
    const merged = mergeImportPathEnv(
      { home: '/h', claudeConfigDir: '/explicit/claude' },
      { claudeConfigDir: '/persisted/claude', codexHome: '/persisted/codex' },
    );
    expect(merged.claudeConfigDir).toBe('/explicit/claude');
    expect(merged.codexHome).toBe('/persisted/codex');
  });

  it('empty override falls back to default via resolveDefaultImportRoots', () => {
    const merged = mergeImportPathEnv({ home: '/home/u', platform: 'linux', sep: '/' }, {});
    const roots = resolveDefaultImportRoots(merged);
    expect(roots.claudeConfig).toBe('/home/u/.claude');
    expect(roots.codexSessions).toBe('/home/u/.codex/sessions');
  });

  // OPT-H7: hasCustomImportRoot SoT used by ExternalSessionImport badge/reset UX
  it('hasCustomImportRoot tracks set/clear per source', () => {
    expect(hasCustomImportRoot('claude')).toBe(false);
    expect(hasCustomImportRoot('codex')).toBe(false);
    setPersistedClaudeImportRoot('/opt/claude-cfg');
    expect(hasCustomImportRoot('claude')).toBe(true);
    expect(hasCustomImportRoot('codex')).toBe(false);
    setPersistedCodexImportRoot('/opt/codex-home');
    expect(hasCustomImportRoot('codex')).toBe(true);
    setPersistedClaudeImportRoot(null);
    setPersistedCodexImportRoot('');
    expect(hasCustomImportRoot('claude')).toBe(false);
    expect(hasCustomImportRoot('codex')).toBe(false);
  });

  // OPT-H7: trailing slash normalize so custom-root paths match scan roots
  it('persisted roots strip trailing separators and ignore whitespace-only', () => {
    setPersistedClaudeImportRoot('/opt/claude/');
    setPersistedCodexImportRoot('C:\\Users\\dev\\.codex\\');
    expect(getPersistedImportRoots()).toEqual({
      claudeConfigDir: '/opt/claude',
      codexHome: 'C:\\Users\\dev\\.codex',
    });
    setPersistedClaudeImportRoot('   ');
    expect(getPersistedImportRoots().claudeConfigDir).toBeUndefined();
    expect(hasCustomImportRoot('claude')).toBe(false);
  });

  it('persisted roots change detect list roots', async () => {
    setPersistedClaudeImportRoot('/opt/my-claude');
    setPersistedCodexImportRoot('/opt/my-codex');
    expect(getPersistedImportRoots()).toEqual({
      claudeConfigDir: '/opt/my-claude',
      codexHome: '/opt/my-codex',
    });

    const env = mergeImportPathEnv({
      home: '/home/u',
      platform: 'linux',
      sep: '/',
    });
    const sessionUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const claudeFile =
      '{"type":"user","timestamp":"2026-07-01T10:00:00.000Z","message":{"role":"user","content":"Hi"}}\n';
    const files: Record<string, string> = {
      [`/opt/my-claude/projects/proj/${sessionUuid}.jsonl`]: claudeFile,
    };
    const fs = createMemoryImportFs(files);
    const result = await detectExternalSessions({
      fs,
      env,
      sources: ['claude-code'],
    });
    expect(result.roots.claudeConfig).toBe('/opt/my-claude');
    expect(result.roots.claudeProjects).toBe('/opt/my-claude/projects');
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.sourceSessionId).toBe(sessionUuid);

    // Default home path should NOT be scanned when override is set
    setPersistedClaudeImportRoot(null);
    setPersistedCodexImportRoot(null);
    const cleared = mergeImportPathEnv({
      home: '/home/u',
      platform: 'linux',
      sep: '/',
    });
    const roots = resolveDefaultImportRoots(cleared);
    expect(roots.claudeConfig).toBe('/home/u/.claude');
  });
});

describe('lite extractors', () => {
  it('extractJsonStringField / title previews', () => {
    const head =
      '{"type":"user","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":"Hello path join"}}\n';
    const tail = '{"type":"custom-title","customTitle":"My Title"}\n';
    expect(extractJsonStringField(head, 'timestamp')).toBe('2026-01-01T00:00:00.000Z');
    expect(extractClaudeTitlePreview(head, tail)).toBe('My Title');
    expect(extractCodexTitlePreview('{"payload":{"content":[{"type":"input_text","text":"Do X"}]}}')).toBe(
      'Do X',
    );
    expect(truncatePreview('a'.repeat(300)).endsWith('…')).toBe(true);
    expect(estimateLineCount('a\nb\nc\n', false)).toBe(3);
  });
});

describe('detectExternalSessions', () => {
  it('lists Claude + Codex sessions from memory FS', async () => {
    const claudeFile =
      '{"type":"user","timestamp":"2026-07-01T10:00:00.000Z","cwd":"/proj","message":{"role":"user","content":"Refactor auth module"}}\n' +
      '{"type":"custom-title","customTitle":"Auth refactor"}\n';
    const codexFile =
      '{"timestamp":"2026-07-02T12:00:00.000Z","type":"session_meta","payload":{"meta":{"id":"ffffffff-1111-2222-3333-444444444444","cwd":"/repo"}}}\n' +
      '{"timestamp":"2026-07-02T12:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Fix tests"}]}}\n';

    const sessionUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const files: Record<string, string> = {
      [`/home/u/.claude/projects/C--proj/${sessionUuid}.jsonl`]: claudeFile,
      [`/home/u/.codex/sessions/2026/07/02/rollout-2026-07-02T12-00-00-${'ffffffff-1111-2222-3333-444444444444'}.jsonl`]:
        codexFile,
    };
    const fs = createMemoryImportFs(files);

    const result = await detectExternalSessions({
      fs,
      env: { home: '/home/u', platform: 'linux', sep: '/' },
    });

    expect(result.roots.claudeProjects).toBe('/home/u/.claude/projects');
    expect(result.sessions.length).toBe(2);

    const claude = result.sessions.find((s) => s.source === 'claude-code');
    const codex = result.sessions.find((s) => s.source === 'codex');
    expect(claude?.sourceSessionId).toBe(sessionUuid);
    expect(claude?.titlePreview).toBe('Auth refactor');
    expect(claude?.messageCountEstimate).toBeGreaterThan(0);
    expect(codex?.sourceSessionId).toBe('ffffffff-1111-2222-3333-444444444444');
    expect(codex?.titlePreview).toContain('Fix tests');
  });

  it('returns warnings when roots missing', async () => {
    const fs = createMemoryImportFs({});
    const result = await detectExternalSessions({
      fs,
      env: { home: '/empty', platform: 'linux', sep: '/' },
      sources: ['claude-code'],
    });
    expect(result.sessions).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('joinImportPath is sep-aware', () => {
    expect(joinImportPath('\\', 'C:\\Users\\a', '.claude', 'projects')).toBe(
      'C:\\Users\\a\\.claude\\projects',
    );
    expect(joinImportPath('/', '/home/a', '.codex', 'sessions')).toBe(
      '/home/a/.codex/sessions',
    );
  });
});
