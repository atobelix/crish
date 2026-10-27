import { describe, expect, it } from 'vitest';
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
} from '../detect';
import { createMemoryImportFs } from './memory-fs';

describe('resolveDefaultImportRoots', () => {
  it('从 home 构建 Windows 风格根目录', () => {
    const roots = resolveDefaultImportRoots({
      home: 'C:\\Users\\dev',
      platform: 'win32',
      sep: '\\',
    });
    expect(roots.claudeConfig).toBe('C:\\Users\\dev\\.claude');
    expect(roots.claudeProjects).toBe('C:\\Users\\dev\\.claude\\projects');
    expect(roots.codexSessions).toBe('C:\\Users\\dev\\.codex\\sessions');
  });

  it('通过 env 参数接受 CLAUDE_CONFIG_DIR / CODEX_HOME 覆盖', () => {
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

  it('空覆盖字段回落到默认 home 根目录', () => {
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

  it('mungeProjectPath 符合 Claude 非字母数字规则', () => {
    expect(mungeProjectPath('C:\\Software\\conex')).toBe('C--Software-conex');
    expect(mungeProjectPath('/Users/foo/my-project')).toBe(
      '-Users-foo-my-project'
    );
  });
});

describe('轻量提取器', () => {
  it('extractJsonStringField / 标题预览', () => {
    const head =
      '{"type":"user","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":"Hello path join"}}\n';
    const tail = '{"type":"custom-title","customTitle":"My Title"}\n';
    expect(extractJsonStringField(head, 'timestamp')).toBe(
      '2026-01-01T00:00:00.000Z'
    );
    expect(extractClaudeTitlePreview(head, tail)).toBe('My Title');
    expect(
      extractCodexTitlePreview(
        '{"payload":{"content":[{"type":"input_text","text":"Do X"}]}}'
      )
    ).toBe('Do X');
    expect(truncatePreview('a'.repeat(300)).endsWith('…')).toBe(true);
    expect(estimateLineCount('a\nb\nc\n', false)).toBe(3);
  });

  it('extractCodexTitlePreview 跳过 session_meta 中的 base_instructions（避免 You are Codex 污染）', () => {
    const rolloutWithSystem = [
      '{"timestamp":"2026-07-02T12:00:00.000Z","type":"session_meta","payload":{"meta":{"id":"123","base_instructions":"You are Codex, an agent based on GPT-6 by OpenAI."}}}',
      '{"timestamp":"2026-07-02T12:00:01.000Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"Developer system prompt"}]}}',
      '{"timestamp":"2026-07-02T12:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Write a unit test for parser"}]}}',
    ].join('\n');
    expect(extractCodexTitlePreview(rolloutWithSystem)).toBe(
      'Write a unit test for parser'
    );
  });

  it('extractCodexTitlePreview 首个用户消息为 environment_context 时继续寻找真实提问', () => {
    const rolloutWithEnvContext = [
      '{"timestamp":"2026-07-02T12:00:00.000Z","type":"session_meta","payload":{"meta":{"id":"123"}}}',
      '{"timestamp":"2026-07-02T12:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\\nCWD: /app\\nOS: windows\\n</environment_context>"}]}}',
      '{"timestamp":"2026-07-02T12:00:02.000Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","message":"Optimize database queries"}}}',
    ].join('\n');
    expect(extractCodexTitlePreview(rolloutWithEnvContext)).toBe(
      'Optimize database queries'
    );
  });

  it('extractCodexTitlePreview 剥离消息中的 AGENTS.md 样板保留末尾真实用户提问', () => {
    const rolloutWithBoilerplate = [
      '{"timestamp":"2026-07-02T12:00:00.000Z","type":"session_meta","payload":{"meta":{"id":"123"}}}',
      '{"timestamp":"2026-07-02T12:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /repo\\n<INSTRUCTIONS>\\nDo not break CI\\n</INSTRUCTIONS>\\n\\nRefactor the auth middleware"}]}}',
    ].join('\n');
    expect(extractCodexTitlePreview(rolloutWithBoilerplate)).toBe(
      'Refactor the auth middleware'
    );
  });

  it('extractCodexTitlePreview 纯样板会话回退到 Codex session', () => {
    const rolloutOnlyBoilerplate = [
      '{"timestamp":"2026-07-02T12:00:00.000Z","type":"session_meta","payload":{"meta":{"id":"123","base_instructions":"You are Codex, an agent based on GPT-6."}}}',
      '{"timestamp":"2026-07-02T12:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>OS: windows</environment_context>"}]}}',
    ].join('\n');
    expect(extractCodexTitlePreview(rolloutOnlyBoilerplate)).toBe(
      'Codex session'
    );
  });
});

describe('detectExternalSessions', () => {
  it('从内存 FS 列出 Claude + Codex 会话', async () => {
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

  it('Claude 根目录不可读时返回错误', async () => {
    const fs = createMemoryImportFs({});
    const result = await detectExternalSessions({
      fs,
      env: { home: '/empty', platform: 'linux', sep: '/' },
      sources: ['claude-code'],
    });
    expect(result.sessions).toHaveLength(0);
    expect(result.errors).toEqual([
      'Claude projects dir not readable: /empty/.claude/projects',
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('Claude 与 Codex 根目录都不可读时分别返回来源错误', async () => {
    const fs = createMemoryImportFs({});
    const result = await detectExternalSessions({
      fs,
      env: { home: '/empty', platform: 'linux', sep: '/' },
    });

    expect(result.sessions).toEqual([]);
    expect(result.errors).toEqual([
      'Claude projects dir not readable: /empty/.claude/projects',
      'Codex sessions dir not readable: /empty/.codex/sessions',
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('Codex 日期子目录部分不可读时保留可读会话并返回警告', async () => {
    const uuid = 'ffffffff-1111-2222-3333-444444444444';
    const fs = createMemoryImportFs({
      [`/home/u/.codex/sessions/2026/07/02/rollout-2026-07-02T12-00-00-${uuid}.jsonl`]:
        '{"timestamp":"2026-07-02T12:00:00.000Z","type":"session_meta","payload":{"meta":{"cwd":"/repo"}}}\n',
      '/home/u/.codex/sessions/2026/08/01/placeholder.jsonl': '',
    });
    const listDir = fs.listDir.bind(fs);
    fs.listDir = async (dirPath, allowRoot) => {
      if (dirPath === '/home/u/.codex/sessions/2026/08') {
        throw new Error('permission denied');
      }
      return listDir(dirPath, allowRoot);
    };

    const result = await detectExternalSessions({
      fs,
      env: { home: '/home/u', platform: 'linux', sep: '/' },
      sources: ['codex'],
    });

    expect(result.sessions.map((session) => session.sourceSessionId)).toEqual([
      uuid,
    ]);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toContain(
      'Skip unreadable Codex month directory: /home/u/.codex/sessions/2026/08'
    );
  });

  it('joinImportPath 感知分隔符', () => {
    expect(joinImportPath('\\', 'C:\\Users\\a', '.claude', 'projects')).toBe(
      'C:\\Users\\a\\.claude\\projects'
    );
    expect(joinImportPath('/', '/home/a', '.codex', 'sessions')).toBe(
      '/home/a/.codex/sessions'
    );
  });
});
