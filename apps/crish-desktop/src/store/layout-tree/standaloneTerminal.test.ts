import { describe, it, expect, vi } from 'vitest';
import {
  createTerminalTabForStore,
  type StandaloneTerminalTab,
} from './layoutTreeTerminalOps';
import { DEFAULT_WORKSPACE_KEY } from './sessionTabModel';
import {
  normalizePtyCreateOptions,
  createPtyCreateArgs,
  type PtyCreateOptions,
} from '../../api/ptyCreateArgs';

describe('Standalone Terminal & PTY Argument Passthrough (Task 4)', () => {
  describe('createTerminalTabForStore factory invariants', () => {
    it('creates pure standalone terminal tab with default parameters', () => {
      const tab: StandaloneTerminalTab = createTerminalTabForStore();

      expect(tab.kind).toBe('terminal');
      expect(tab.isStandalone).toBe(true);
      expect(tab.dock).toBeUndefined();
      expect(tab.sessionId).toBeUndefined();
      expect(tab.title).toBe('Terminal');
      expect(tab.workspaceKey).toBe(DEFAULT_WORKSPACE_KEY);
      expect(tab.cwd).toBe('');
      expect(typeof tab.tabId).toBe('string');
      expect(tab.tabId.length).toBeGreaterThan(0);
      expect(tab.terminalKey).toBe(`standalone:term_${tab.tabId}`);
    });

    it('respects custom tabId, terminalKey, title, workspaceKey, and cwd', () => {
      const tab = createTerminalTabForStore({
        tabId: 'custom_tab_123',
        terminalKey: 'standalone:term_custom_123',
        title: 'My Custom Shell',
        workspaceKey: '项目A',
        cwd: 'C:/Users/orange/custom',
      });

      expect(tab.kind).toBe('terminal');
      expect(tab.isStandalone).toBe(true);
      expect(tab.tabId).toBe('custom_tab_123');
      expect(tab.terminalKey).toBe('standalone:term_custom_123');
      expect(tab.title).toBe('My Custom Shell');
      expect(tab.workspaceKey).toBe('项目A');
      expect(tab.cwd).toBe('C:/Users/orange/custom');
      expect(tab.dock).toBeUndefined();
      expect(tab.sessionId).toBeUndefined();
    });

    it('trims whitespace and falls back cleanly', () => {
      const tab = createTerminalTabForStore({
        tabId: '   ',
        terminalKey: '   ',
        title: '   ',
        workspaceKey: '   ',
        cwd: '   ',
      });

      expect(tab.kind).toBe('terminal');
      expect(tab.isStandalone).toBe(true);
      expect(tab.title).toBe('Terminal');
      expect(tab.workspaceKey).toBe(DEFAULT_WORKSPACE_KEY);
      expect(tab.cwd).toBe('');
      expect(tab.tabId).toMatch(/^tab_/);
      expect(tab.terminalKey).toBe(`standalone:term_${tab.tabId}`);
    });
  });

  describe('normalizePtyCreateOptions', () => {
    it('returns null for empty or whitespace sessionKey', () => {
      expect(
        normalizePtyCreateOptions({
          sessionKey: '',
          cols: 80,
          rows: 24,
        })
      ).toBeNull();

      expect(
        normalizePtyCreateOptions({
          sessionKey: '   ',
          cols: 80,
          rows: 24,
        })
      ).toBeNull();
    });

    it('normalizes cols, rows, and trimmed cwd', () => {
      const normalized = normalizePtyCreateOptions({
        sessionKey: 'term_1',
        cols: -10,
        rows: -5,
        cwd: '  C:/foo  ',
      });

      expect(normalized).not.toBeNull();
      expect(normalized?.sessionKey).toBe('term_1');
      expect(normalized?.cols).toBe(1);
      expect(normalized?.rows).toBe(1);
      expect(normalized?.cwd).toBe('C:/foo');
      expect(normalized?.isStandalone).toBe(false);

      const defaulted = normalizePtyCreateOptions({
        sessionKey: 'term_2',
        cols: 0,
        rows: 0,
      });
      expect(defaulted?.cols).toBe(80);
      expect(defaulted?.rows).toBe(24);
    });

    it('recognizes standalone terminals by explicit flag or prefix', () => {
      const explicit = normalizePtyCreateOptions({
        sessionKey: 'custom_shell',
        cols: 80,
        rows: 24,
        isStandalone: true,
      });
      expect(explicit?.isStandalone).toBe(true);

      const prefixed = normalizePtyCreateOptions({
        sessionKey: 'standalone:term_abc',
        cols: 80,
        rows: 24,
      });
      expect(prefixed?.isStandalone).toBe(true);

      const standard = normalizePtyCreateOptions({
        sessionKey: 'session_123:terminal',
        cols: 80,
        rows: 24,
      });
      expect(standard?.isStandalone).toBe(false);
    });

    it('converts empty or whitespace cwd to undefined', () => {
      const normalized = normalizePtyCreateOptions({
        sessionKey: 'standalone:term_xyz',
        cols: 80,
        rows: 24,
        cwd: '   ',
      });
      expect(normalized?.cwd).toBeUndefined();
    });
  });

  describe('createPtyCreateArgs isolation & passthrough', () => {
    it('never reads workspace path for sessionKey prefixed with standalone:', () => {
      const readWorkspace = vi.fn(() => 'C:/MyProject');

      const options = normalizePtyCreateOptions({
        sessionKey: 'standalone:term_123',
        cols: 120,
        rows: 40,
      })!;

      const args = createPtyCreateArgs(options, readWorkspace);

      expect(readWorkspace).toHaveBeenCalledTimes(0);
      expect(args.cwd).toBeUndefined();
      expect(args.cwd).not.toBe('C:/MyProject');
      expect(args.sessionKey).toBe('standalone:term_123');
      expect(args.cols).toBe(120);
      expect(args.rows).toBe(40);
    });

    it('never reads workspace path when isStandalone is true', () => {
      const readWorkspace = vi.fn(() => 'C:/Workspaces/Repo');

      const options = normalizePtyCreateOptions({
        sessionKey: 'isolated_term_999',
        cols: 80,
        rows: 24,
        isStandalone: true,
      })!;

      const args = createPtyCreateArgs(options, readWorkspace);

      expect(readWorkspace).toHaveBeenCalledTimes(0);
      expect(args.cwd).toBeUndefined();
      expect(args.cwd).not.toBe('C:/Workspaces/Repo');
    });

    it('passes through explicit cwd for standalone terminal without touching workspace', () => {
      const readWorkspace = vi.fn(() => 'C:/MyProject');

      const options = normalizePtyCreateOptions({
        sessionKey: 'standalone:term_home',
        cols: 100,
        rows: 30,
        cwd: 'C:/Users/orange',
      })!;

      const args = createPtyCreateArgs(options, readWorkspace);

      expect(readWorkspace).toHaveBeenCalledTimes(0);
      expect(args.cwd).toBe('C:/Users/orange');
      expect(args.cwd).not.toBe('C:/MyProject');
    });

    it('reads workspace path for regular workspace terminal when cwd is omitted', () => {
      const readWorkspace = vi.fn(() => 'C:/Projects/ActiveProject');

      const options = normalizePtyCreateOptions({
        sessionKey: 'session_abc:dock_term_1',
        cols: 80,
        rows: 24,
      })!;

      const args = createPtyCreateArgs(options, readWorkspace);

      expect(readWorkspace).toHaveBeenCalledTimes(1);
      expect(args.cwd).toBe('C:/Projects/ActiveProject');
    });

    it('prefers explicit cwd over workspace path for regular terminal', () => {
      const readWorkspace = vi.fn(() => 'C:/Projects/ActiveProject');

      const options = normalizePtyCreateOptions({
        sessionKey: 'session_abc:dock_term_1',
        cols: 80,
        rows: 24,
        cwd: 'C:/Projects/ActiveProject/packages/core',
      })!;

      const args = createPtyCreateArgs(options, readWorkspace);

      expect(readWorkspace).toHaveBeenCalledTimes(1);
      expect(args.cwd).toBe('C:/Projects/ActiveProject/packages/core');
    });

    it('handles empty workspace path gracefully for regular terminal', () => {
      const readWorkspace = vi.fn(() => '   ');

      const options = normalizePtyCreateOptions({
        sessionKey: 'session_abc:dock_term_1',
        cols: 80,
        rows: 24,
      })!;

      const args = createPtyCreateArgs(options, readWorkspace);

      expect(readWorkspace).toHaveBeenCalledTimes(1);
      expect(args.cwd).toBeUndefined();
    });
  });
});
