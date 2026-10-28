// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand } from '../test-setup';
import { ptyCreate } from './ptySessionApi';
import { invokeTyped } from './tauriInvoke';
import {
  __resetWorkspaceAccessGateForTests,
  withWorkspaceAccess,
  withWorkspaceAccessStartupLock,
  withWorkspaceAccessTransition,
} from './workspaceAccessGate';

beforeEach(() => {
  __resetWorkspaceAccessGateForTests();
});

afterEach(() => {
  __resetWorkspaceAccessGateForTests();
});

describe('workspace access shared lock', () => {
  it('holds lazy workspace IPC arguments behind a lock shared by windows', async () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'locks'
    );
    let previous: Promise<unknown> = Promise.resolve();
    const request = vi.fn(
      (
        name: string,
        options: LockOptions,
        callback: (lock: Lock | null) => Promise<unknown> | unknown
      ) => {
        const scheduled = previous
          .catch(() => undefined)
          .then(() =>
            callback({ name, mode: options.mode ?? 'exclusive' } as Lock)
          );
        previous = scheduled.then(
          () => undefined,
          () => undefined
        );
        return scheduled;
      }
    );
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request } as unknown as LockManager,
    });

    try {
      let releaseAuthorization!: () => void;
      let enteredAuthorization!: () => void;
      const authorizationEntered = new Promise<void>((resolve) => {
        enteredAuthorization = resolve;
      });
      const authorizationHold = new Promise<void>((resolve) => {
        releaseAuthorization = resolve;
      });
      const firstWindowAuthorization = withWorkspaceAccessStartupLock(
        async () => {
          enteredAuthorization();
          await authorizationHold;
        }
      );
      await authorizationEntered;

      let argsBuilt = false;
      let fileCommandCalled = false;
      mockTauriCommand('workbench_write_file_content', () => {
        fileCommandCalled = true;
        return null;
      });
      const secondWindowFileRequest = invokeTyped(
        'workbench_write_file_content',
        () => {
          argsBuilt = true;
          return { path: 'e:/current/notes.md', content: 'text' };
        }
      );
      const protectedCommands = [
        'trash_list',
        'trash_restore',
        'trash_purge',
        'core_search_files',
        'core_rebuild_search_index',
      ];
      const dispatchedProtectedCommands: string[] = [];
      const protectedRequests = protectedCommands.map((command) => {
        mockTauriCommand(command, () => {
          dispatchedProtectedCommands.push(command);
          return null;
        });
        return invokeTyped(command, {});
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(request).toHaveBeenCalledTimes(2 + protectedCommands.length);
      expect(argsBuilt).toBe(false);
      expect(fileCommandCalled).toBe(false);
      expect(dispatchedProtectedCommands).toEqual([]);

      releaseAuthorization();
      await firstWindowAuthorization;
      await expect(secondWindowFileRequest).resolves.toMatchObject({
        status: 'ok',
      });
      await expect(Promise.all(protectedRequests)).resolves.toEqual(
        protectedCommands.map(() => expect.objectContaining({ status: 'ok' }))
      );
      expect(argsBuilt).toBe(true);
      expect(fileCommandCalled).toBe(true);
      expect(dispatchedProtectedCommands.sort()).toEqual(
        [...protectedCommands].sort()
      );
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(navigator, 'locks', originalDescriptor);
      } else {
        delete (navigator as Navigator & { locks?: LockManager }).locks;
      }
    }
  });

  it('creates a PTY at the authorized active root after a shared lock releases', async () => {
    const previousWorkspacePath = localStorage.getItem('crish_workspace');
    localStorage.setItem('crish_workspace', 'D:/previous-project');

    let releaseAuthorization!: () => void;
    let enteredAuthorization!: () => void;
    const authorizationEntered = new Promise<void>((resolve) => {
      enteredAuthorization = resolve;
    });
    const authorizationHold = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    const firstWindowAuthorization = withWorkspaceAccessStartupLock(
      async () => {
        enteredAuthorization();
        await authorizationHold;
      }
    );

    let dispatchedArgs: unknown;
    mockTauriCommand('workbench_pty_create', (args) => {
      dispatchedArgs = args;
      return { ptyId: 'pty-after-switch' };
    });

    try {
      await authorizationEntered;
      const createRequest = ptyCreate({
        sessionKey: 'session-after-switch',
        cols: 80,
        rows: 24,
        cwd: 'D:/old-terminal-tab-root',
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(dispatchedArgs).toBeUndefined();

      // The other WebView completed authorization and updated shared active state.
      localStorage.setItem('crish_workspace', 'D:/authorized-project');
      releaseAuthorization();
      await firstWindowAuthorization;

      await expect(createRequest).resolves.toMatchObject({ status: 'ok' });
      expect(dispatchedArgs).toMatchObject({
        sessionKey: 'session-after-switch',
        cwd: 'D:/authorized-project',
      });
    } finally {
      releaseAuthorization();
      if (previousWorkspacePath === null) {
        localStorage.removeItem('crish_workspace');
      } else {
        localStorage.setItem('crish_workspace', previousWorkspacePath);
      }
    }
  });

  it('does not send workspace IPC from a Tauri window without Web Locks', async () => {
    const originalLockDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'locks'
    );
    const originalTauriDescriptor = Object.getOwnPropertyDescriptor(
      window,
      '__TAURI_INTERNALS__'
    );
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: undefined,
    });
    window.__TAURI_INTERNALS__ = {};

    try {
      let argsBuilt = false;
      let commandCalled = false;
      mockTauriCommand('workbench_write_file_content', () => {
        commandCalled = true;
        return null;
      });

      await expect(
        invokeTyped('workbench_write_file_content', () => {
          argsBuilt = true;
          return { path: 'e:/current/notes.md', content: 'text' };
        })
      ).resolves.toMatchObject({
        status: 'error',
        kind: 'WorkspaceAccess',
      });
      expect(argsBuilt).toBe(false);
      expect(commandCalled).toBe(false);
    } finally {
      if (originalLockDescriptor) {
        Object.defineProperty(navigator, 'locks', originalLockDescriptor);
      } else {
        delete (navigator as Navigator & { locks?: LockManager }).locks;
      }
      if (originalTauriDescriptor) {
        Object.defineProperty(
          window,
          '__TAURI_INTERNALS__',
          originalTauriDescriptor
        );
      } else {
        delete window.__TAURI_INTERNALS__;
      }
    }
  });

  it('keeps rapid session switches blocked when the last authorization fails', async () => {
    let releaseFirst!: () => void;
    const firstAuthorizationHold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstAuthorization = withWorkspaceAccessTransition(
      async () => {
        await firstAuthorizationHold;
        return 'first';
      },
      () => true,
      { failClosedOnError: true }
    );
    const lastAuthorization = withWorkspaceAccessTransition(
      async () => {
        throw new Error('last session workspace authorization failed');
      },
      () => true,
      { failClosedOnError: true }
    );

    let workspaceOperationCalled = false;
    const workspaceOperation = withWorkspaceAccess(() => {
      workspaceOperationCalled = true;
    });

    releaseFirst();
    await expect(firstAuthorization).resolves.toBe('first');
    await expect(lastAuthorization).rejects.toThrow(
      'last session workspace authorization failed'
    );
    await expect(workspaceOperation).rejects.toThrow(
      'last session workspace authorization failed'
    );
    expect(workspaceOperationCalled).toBe(false);
  });

  it('lets a later successful session switch clear an earlier authorization failure', async () => {
    const failedAuthorization = withWorkspaceAccessTransition(
      async () => {
        throw new Error('superseded session authorization failed');
      },
      () => true,
      { failClosedOnError: true }
    );
    const successfulAuthorization = withWorkspaceAccessTransition(
      async () => 'current session',
      () => true,
      { failClosedOnError: true }
    );

    await expect(failedAuthorization).rejects.toThrow(
      'superseded session authorization failed'
    );
    await expect(successfulAuthorization).resolves.toBe('current session');
    await expect(
      withWorkspaceAccess(() => 'workspace available')
    ).resolves.toBe('workspace available');
  });
});
