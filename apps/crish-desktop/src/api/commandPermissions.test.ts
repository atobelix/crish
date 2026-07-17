import { describe, expect, it } from 'vitest';
import {
  addCommandPermission,
  classifyShellRisk,
  COMMAND_PERMISSIONS_STORAGE_KEY,
  coerceCommandText,
  commandMatchVariants,
  commandMatchesWhitelist,
  dedupeWhitelist,
  extractCommandForMatch,
  isSafeReadCommand,
  isTokenBoundaryPrefix,
  loadCommandPermissions,
  matchesDenyPattern,
  matchesHardlinePattern,
  normalizeCommandLine,
  removeCommandPermission,
  sanitizeWhitelistEntry,
  saveCommandPermissions,
  shellRiskMessage,
  shouldAutoApproveCommand,
  splitCommandSegments,
  stripWindowsExecutableExtension,
  unwrapShellWrapper,
} from './commandPermissions';

function memStorage(seed?: Record<string, string>) {
  const mem = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, v);
    },
    mem,
  };
}

describe('commandPermissions', () => {
  it('normalizeCommandLine collapses whitespace', () => {
    expect(normalizeCommandLine('  $  git   status  ')).toBe('git status');
  });

  it('sanitizeWhitelistEntry matches normalize + empty', () => {
    expect(sanitizeWhitelistEntry('  npm   test  ')).toBe('npm test');
    expect(sanitizeWhitelistEntry('   ')).toBe('');
  });

  it('matches exact and token-boundary prefix only', () => {
    const wl = ['git status', 'npm test'];
    expect(commandMatchesWhitelist('git status', wl)).toBe(true);
    expect(commandMatchesWhitelist('git status --short', wl)).toBe(true);
    expect(commandMatchesWhitelist('npm test --watch', wl)).toBe(true);
    // bare prefix must not match longer tokens
    expect(commandMatchesWhitelist('gitignore', ['git'])).toBe(false);
    expect(commandMatchesWhitelist('npmrc', ['npm'])).toBe(false);
    expect(commandMatchesWhitelist('git push', wl)).toBe(false);
  });

  it('rejects glued identifiers and path-like continuations (token boundary)', () => {
    expect(isTokenBoundaryPrefix('gitignore', 'git')).toBe(false);
    expect(isTokenBoundaryPrefix('git-status', 'git')).toBe(false);
    expect(isTokenBoundaryPrefix('git_status', 'git')).toBe(false);
    expect(isTokenBoundaryPrefix('git.status', 'git')).toBe(false);
    expect(isTokenBoundaryPrefix('git/foo', 'git')).toBe(false);
    expect(isTokenBoundaryPrefix('git\\cmd', 'git')).toBe(false);
    expect(isTokenBoundaryPrefix('git.exe', 'git')).toBe(false);
    expect(isTokenBoundaryPrefix('nodejs', 'node')).toBe(false);
    // glued shell metacharacters — not a whitespace boundary
    expect(isTokenBoundaryPrefix('git;rm', 'git')).toBe(false);
    expect(isTokenBoundaryPrefix('git&&rm', 'git')).toBe(false);
    expect(isTokenBoundaryPrefix('git|cat', 'git')).toBe(false);
    expect(isTokenBoundaryPrefix('git=evil', 'git')).toBe(false);
    // "npm run" must not match "npm runtime"
    expect(commandMatchesWhitelist('npm runtime', ['npm run'])).toBe(false);
    expect(commandMatchesWhitelist('npm run test', ['npm run'])).toBe(true);
  });

  it('allows exact match and whitespace-separated args only', () => {
    expect(isTokenBoundaryPrefix('git', 'git')).toBe(true);
    expect(isTokenBoundaryPrefix('git status', 'git')).toBe(true);
    expect(isTokenBoundaryPrefix('GIT STATUS --short', 'git status')).toBe(true);
    // no reverse match: long whitelist does not auto-match shorter command
    expect(commandMatchesWhitelist('git', ['git status'])).toBe(false);
  });

  it('does not match empty command or empty whitelist entries', () => {
    expect(commandMatchesWhitelist('', ['git'])).toBe(false);
    expect(commandMatchesWhitelist('git status', [])).toBe(false);
    expect(commandMatchesWhitelist('git status', ['  ', ''])).toBe(false);
  });

  it('extractCommandForMatch digs into JSON args', () => {
    expect(extractCommandForMatch('shell_command', 'git status')).toBe('git status');
    expect(
      extractCommandForMatch('shell_command', JSON.stringify({ command: 'npm test' })),
    ).toBe('npm test');
    expect(
      extractCommandForMatch(
        'shell_command',
        JSON.stringify({ argv: ['git', 'status', '--short'] }),
      ),
    ).toBe('git status --short');
    expect(
      extractCommandForMatch('shell_command', JSON.stringify({ cmd: 'ls -la' })),
    ).toBe('ls -la');
  });

  it('whitelist match uses extract path for JSON tool args', () => {
    const line = extractCommandForMatch(
      'run_terminal_cmd',
      JSON.stringify({ command: 'git status --porcelain' }),
    );
    expect(commandMatchesWhitelist(line, ['git status'])).toBe(true);
    const evil = extractCommandForMatch(
      'run_terminal_cmd',
      JSON.stringify({ command: 'gitignore' }),
    );
    expect(commandMatchesWhitelist(evil, ['git'])).toBe(false);
  });

  it('dedupeWhitelist normalizes and case-folds keys', () => {
    expect(dedupeWhitelist(['git status', '  git   status  ', 'GIT STATUS', 'npm test', ''])).toEqual(
      ['git status', 'npm test'],
    );
  });

  it('load/saveCommandPermissions use storage key and seed', () => {
    const empty = memStorage();
    const seeded = loadCommandPermissions(empty);
    expect(seeded).toContain('git status');
    expect(seeded).toContain('npm test');

    saveCommandPermissions(['  git status  ', 'git status', 'npm run typecheck'], empty);
    expect(JSON.parse(empty.mem.get(COMMAND_PERMISSIONS_STORAGE_KEY)!)).toEqual([
      'git status',
      'npm run typecheck',
    ]);
    expect(loadCommandPermissions(empty)).toEqual(['git status', 'npm run typecheck']);
  });

  it('add/removeCommandPermission persist via sanitize + injected storage', () => {
    const s = memStorage({
      [COMMAND_PERMISSIONS_STORAGE_KEY]: JSON.stringify(['git status']),
    });
    let list = loadCommandPermissions(s);
    list = addCommandPermission(list, '  npm   test  ', s);
    list = addCommandPermission(list, 'NPM TEST', s); // case-insensitive dedupe
    expect(list).toEqual(['git status', 'npm test']);
    expect(loadCommandPermissions(s)).toEqual(['git status', 'npm test']);

    list = removeCommandPermission(list, 'Git Status', s);
    expect(list).toEqual(['npm test']);
    expect(loadCommandPermissions(s)).toEqual(['npm test']);

    // empty add is no-op
    expect(addCommandPermission(list, '   ', s)).toEqual(['npm test']);
  });

  // ── empty / null / non-string inputs ────────────────────────────────────

  it('null/undefined/non-string inputs are safe (no throw, empty match)', () => {
    expect(coerceCommandText(null)).toBe('');
    expect(coerceCommandText(undefined)).toBe('');
    expect(coerceCommandText({ x: 1 })).toBe('');
    expect(coerceCommandText(42)).toBe('42');
    expect(normalizeCommandLine(null)).toBe('');
    expect(normalizeCommandLine(undefined)).toBe('');
    expect(sanitizeWhitelistEntry(null)).toBe('');
    expect(isTokenBoundaryPrefix(null, 'git')).toBe(false);
    expect(isTokenBoundaryPrefix('git', null)).toBe(false);
    expect(commandMatchesWhitelist(null, ['git'])).toBe(false);
    expect(commandMatchesWhitelist('git status', null)).toBe(false);
    expect(commandMatchesWhitelist('git status', undefined)).toBe(false);
    expect(dedupeWhitelist(null)).toEqual([]);
    expect(dedupeWhitelist(undefined)).toEqual([]);
    expect(dedupeWhitelist('git' as unknown)).toEqual([]);
    expect(addCommandPermission(null, 'git status', memStorage())).toEqual(['git status']);
    expect(removeCommandPermission(null, 'git', memStorage())).toEqual([]);
    expect(extractCommandForMatch(null, null)).toBe('');
    expect(extractCommandForMatch(undefined, undefined)).toBe('');
    expect(extractCommandForMatch('shell', null)).toBe('shell');
    expect(classifyShellRisk(null).level).toBe('unknown');
    expect(classifyShellRisk('').level).toBe('unknown');
    expect(shouldAutoApproveCommand(null, ['git'])).toBe(false);
    expect(shouldAutoApproveCommand('git status', null)).toBe(false);
  });

  // ── Windows path / cmd edges ────────────────────────────────────────────

  it('stripWindowsExecutableExtension removes first-token .exe/.cmd/.ps1', () => {
    expect(stripWindowsExecutableExtension('git.exe status')).toBe('git status');
    expect(stripWindowsExecutableExtension('GIT.EXE')).toBe('GIT');
    expect(stripWindowsExecutableExtension('C:\\Tools\\git.exe status --short')).toBe(
      'C:\\Tools\\git status --short',
    );
    expect(stripWindowsExecutableExtension('npm.cmd test')).toBe('npm test');
    expect(stripWindowsExecutableExtension('script.ps1 -x')).toBe('script -x');
    // not first-token only mess: middle .exe stays if not first token pattern
    expect(stripWindowsExecutableExtension('echo file.exe')).toBe('echo file.exe');
  });

  it('unwrapShellWrapper peels cmd /c and powershell -Command', () => {
    expect(unwrapShellWrapper('cmd /c git status')).toBe('git status');
    expect(unwrapShellWrapper('cmd.exe /c git status --short')).toBe('git status --short');
    expect(unwrapShellWrapper('cmd /d /c "git status"')).toBe('git status');
    expect(unwrapShellWrapper('C:\\Windows\\System32\\cmd.exe /c git log')).toBe('git log');
    expect(unwrapShellWrapper('powershell -Command git status')).toBe('git status');
    expect(unwrapShellWrapper('powershell.exe -NoProfile -Command "git status"')).toBe(
      'git status',
    );
    expect(unwrapShellWrapper('pwsh -c "npm test"')).toBe('npm test');
    // plain command unchanged
    expect(unwrapShellWrapper('git status')).toBe('git status');
  });

  it('commandMatchesWhitelist accepts Windows wrappers and .exe via variants', () => {
    const wl = ['git status', 'npm test'];
    expect(commandMatchesWhitelist('git.exe status', wl)).toBe(true);
    expect(commandMatchesWhitelist('cmd /c git status', wl)).toBe(true);
    expect(commandMatchesWhitelist('cmd.exe /c "git status --short"', wl)).toBe(true);
    expect(commandMatchesWhitelist('powershell -Command git status', wl)).toBe(true);
    // still no bare prefix leak
    expect(commandMatchesWhitelist('cmd /c gitignore', ['git'])).toBe(false);
    expect(commandMatchesWhitelist('git.exe', ['git'])).toBe(true); // stripped to git exact
    expect(commandMatchVariants('cmd /c git.exe status').some((v) => /git status/i.test(v))).toBe(
      true,
    );
  });

  // ── risk classify / deny / allow ────────────────────────────────────────

  it('classifyShellRisk: safe reads, write, network, destructive, critical', () => {
    expect(classifyShellRisk('git status').level).toBe('safe');
    expect(classifyShellRisk('npm test').level).toBe('safe');
    expect(classifyShellRisk('ls -la').level).toBe('safe');
    expect(isSafeReadCommand('git log --oneline')).toBe(true);

    expect(classifyShellRisk('git commit -m x').level).toBe('medium');
    expect(classifyShellRisk('curl https://example.com').level).toBe('medium');
    expect(classifyShellRisk('npm install lodash').level).toBe('medium');

    expect(classifyShellRisk('rm -rf dist').level).toBe('high');
    expect(classifyShellRisk('git push origin main').level).toBe('high');
    expect(matchesDenyPattern('rm -rf dist')).toBe(true);
    expect(matchesDenyPattern('git push')).toBe(true);

    expect(classifyShellRisk('format C:').level).toBe('critical');
    expect(classifyShellRisk('shutdown /s').level).toBe('critical');
    expect(classifyShellRisk('powershell -EncodedCommand AABB').level).toBe('critical');
    expect(matchesHardlinePattern('format D:')).toBe(true);
    expect(matchesHardlinePattern('git status')).toBe(false);
  });

  it('classifyShellRisk compound takes stricter segment', () => {
    const c = classifyShellRisk('git status && rm -rf /tmp/x');
    expect(c.level).toBe('high');
    expect(c.hardDeny).toBe(true);
    expect(classifyShellRisk('ls && pwd').level).toBe('safe');
  });

  it('Chinese-safe shellRiskMessage for every level', () => {
    expect(shellRiskMessage('safe')).toMatch(/白名单|只读|低风险/);
    expect(shellRiskMessage('low')).toMatch(/放行|风险/);
    expect(shellRiskMessage('medium')).toMatch(/确认|风险/);
    expect(shellRiskMessage('high')).toMatch(/高风险|不建议/);
    expect(shellRiskMessage('critical')).toMatch(/极危|禁止/);
    expect(shellRiskMessage('unknown')).toMatch(/无法识别|确认/);
    expect(shellRiskMessage('not-a-level')).toMatch(/无法识别|确认/);
    // classify always pairs Chinese message
    expect(classifyShellRisk('format C:').message).toBe(shellRiskMessage('critical'));
    expect(classifyShellRisk('git status').message).toBe(shellRiskMessage('safe'));
  });

  it('shouldAutoApproveCommand requires whitelist and blocks deny even if listed', () => {
    const wl = ['git status', 'rm -rf', 'git push', 'format C:'];
    expect(shouldAutoApproveCommand('git status', wl)).toBe(true);
    expect(shouldAutoApproveCommand('git status --short', wl)).toBe(true);
    // whitelist contains destructive / hardline — still hard deny
    expect(shouldAutoApproveCommand('rm -rf dist', wl)).toBe(false);
    expect(shouldAutoApproveCommand('git push origin main', wl)).toBe(false);
    expect(shouldAutoApproveCommand('format C:', wl)).toBe(false);
    // not on whitelist
    expect(shouldAutoApproveCommand('git log', wl)).toBe(false);
    // Windows wrapper of safe command still auto
    expect(shouldAutoApproveCommand('cmd /c git status', wl)).toBe(true);
  });

  it('splitCommandSegments respects quotes and separators', () => {
    expect(splitCommandSegments('git status && npm test')).toEqual(['git status', 'npm test']);
    expect(splitCommandSegments('echo "a|b" | cat')).toEqual(['echo "a|b"', 'cat']);
    expect(splitCommandSegments('a; b')).toEqual(['a', 'b']);
    expect(splitCommandSegments('')).toEqual([]);
    expect(splitCommandSegments(null)).toEqual([]);
  });

  it('extractCommandForMatch nested parameters / argv / empty JSON', () => {
    expect(
      extractCommandForMatch(
        'run',
        JSON.stringify({ parameters: { command: 'git diff' } }),
      ),
    ).toBe('git diff');
    expect(
      extractCommandForMatch('run', JSON.stringify({ input: { script: 'npm test' } })),
    ).toBe('npm test');
    expect(extractCommandForMatch('fallback_tool', '{}')).toBe('{}');
    expect(extractCommandForMatch('t', JSON.stringify(['git', 'status']))).toBe('git status');
    // non-JSON object stringified args must not become [object Object] path when passed as object
    expect(extractCommandForMatch('shell', { command: 'x' } as unknown)).toBe('shell');
  });

  it('loadCommandPermissions recovers from corrupt JSON and non-array', () => {
    const bad = memStorage({ [COMMAND_PERMISSIONS_STORAGE_KEY]: '{not json' });
    expect(loadCommandPermissions(bad)).toContain('git status');
    const notArr = memStorage({ [COMMAND_PERMISSIONS_STORAGE_KEY]: JSON.stringify({ a: 1 }) });
    expect(loadCommandPermissions(notArr)).toContain('npm test');
    // null storage
    expect(loadCommandPermissions(null)).toContain('git status');
    // save null list → empty array persisted
    const s = memStorage();
    saveCommandPermissions(null, s);
    expect(JSON.parse(s.mem.get(COMMAND_PERMISSIONS_STORAGE_KEY)!)).toEqual([]);
  });
});
