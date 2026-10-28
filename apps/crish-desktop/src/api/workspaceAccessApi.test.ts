// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mockTauriCommand,
  mockTauriError,
  mockTauriMissing,
} from '../test-setup';
import {
  activateWorkspaceForSessionFolder,
  addProjectFromPath,
  addProjectFromPaths,
  getActiveProjectId,
  getWorkspacePath,
  installProjectStoreStorageBridge,
  listProjects,
  openProject,
} from './projectStore';
import { toast } from '../services/toast';
import { writeTextFile } from './workspaceFsApi';
import { invokeTyped } from './tauriInvoke';
import {
  completeWorkspaceAccessStartup,
  reserveWorkspaceAccessStartup,
} from './workspaceAccessGate';
import {
  __resetWorkspaceAccessApiForTests,
  activateDefaultWorkspace,
  addProjectFromRecentPath,
  authorizeRecentWorkspacePaths,
  openAuthorizedProject,
  pickAndAddWorkspaceProject,
  removeAuthorizedProject,
  reauthorizeActiveProject,
  restoreActiveWorkspaceAtStartup,
  selectWorkspaceFolders,
  updateAuthorizedProjectPaths,
  WorkspaceAccessError,
} from './workspaceAccessApi';

beforeEach(() => {
  localStorage.clear();
  delete window.__TAURI_INTERNALS__;
  __resetWorkspaceAccessApiForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete window.__TAURI_INTERNALS__;
});

function markTauriRuntime(): void {
  window.__TAURI_INTERNALS__ = {};
}

describe('workspace authorization boundary', () => {
  it('picker cancellation does not persist a project or send any path to Rust', async () => {
    mockTauriCommand('workbench_pick_workspace_folder', (args) => {
      expect(args).toBeUndefined();
      return null;
    });

    await expect(pickAndAddWorkspaceProject()).resolves.toBeNull();
    expect(listProjects()).toEqual([]);
    expect(localStorage.getItem('crish_workspace')).toBeNull();
  });

  it('stores the Rust-registered native selection without round-tripping its path', async () => {
    const selectedPath = 'D:/external/native-selected-project';
    mockTauriCommand('workbench_pick_workspace_folder', (args) => {
      expect(args).toBeUndefined();
      return selectedPath;
    });

    const project = await pickAndAddWorkspaceProject();

    expect(project?.path).toBe(selectedPath);
    expect(getActiveProjectId()).toBe(project?.id);
    expect(listProjects()).toHaveLength(1);
  });

  it('multi-picker accepts activation intent but does not send selected paths back', async () => {
    const selectedPaths = ['D:/external/one', 'E:/external/two'];
    mockTauriCommand('workbench_pick_workspace_folders', (args) => {
      expect(args).toEqual({ activateFirst: false });
      return selectedPaths;
    });

    await expect(selectWorkspaceFolders(false)).resolves.toEqual(selectedPaths);
  });

  it('rejects arbitrary typed paths before changing the local project store', async () => {
    mockTauriError(
      'workbench_open_workspace',
      new Error('workspace_not_granted: path not in recent list')
    );

    await expect(
      addProjectFromRecentPath('C:/arbitrary/untrusted')
    ).rejects.toMatchObject({
      code: 'workspace-not-granted',
    } satisfies Partial<WorkspaceAccessError>);
    expect(listProjects()).toEqual([]);
    expect(getActiveProjectId()).toBeNull();
  });

  it('rejects a cached project switch before changing the active project', async () => {
    const current = addProjectFromPath('D:/recent/current');
    const target = addProjectFromPath('E:/cached/untrusted');
    mockTauriError(
      'workbench_open_workspaces',
      new Error('workspace_not_granted: path not in recent list')
    );

    await expect(openAuthorizedProject(current.id)).rejects.toBeInstanceOf(
      WorkspaceAccessError
    );
    expect(getActiveProjectId()).toBe(target.id);
  });

  it('opens a cached project only after RecentList authorization succeeds', async () => {
    const current = addProjectFromPath('D:/current');
    const target = addProjectFromPath('E:/recent/target');
    let received: unknown;
    mockTauriCommand('workbench_open_workspaces', (args) => {
      received = args;
      return { path: target.path };
    });

    await expect(openAuthorizedProject(current.id)).resolves.toMatchObject({
      id: current.id,
    });
    expect(received).toEqual({
      paths: [current.path],
      primaryPath: current.path,
      activatePrimary: true,
    });
    expect(getActiveProjectId()).toBe(current.id);
  });

  it('syncs another WebView after authorization so its workspace matches Rust active root', async () => {
    markTauriRuntime();
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const secondWindow = frame.contentWindow;
    if (!secondWindow)
      throw new Error('second WebView test window unavailable');
    const removeSecondBridge = installProjectStoreStorageBridge(secondWindow);

    try {
      const current = addProjectFromPath('D:/recent/current', 'current');
      const target = addProjectFromPath('E:/recent/target', 'target');
      openProject(current.id);
      let rustActiveRoot = current.path;
      mockTauriCommand('workbench_open_workspaces', (args) => {
        rustActiveRoot = (args as { primaryPath: string }).primaryPath;
        return { path: rustActiveRoot };
      });

      const peerSynced = new Promise<void>((resolve) => {
        const onProjectChanged = () => {
          if (
            secondWindow.localStorage.getItem('crish_active_project_id') ===
              target.id &&
            secondWindow.localStorage.getItem('crish_workspace') ===
              rustActiveRoot
          ) {
            secondWindow.removeEventListener(
              'crish-project-changed',
              onProjectChanged
            );
            resolve();
          }
        };
        secondWindow.addEventListener(
          'crish-project-changed',
          onProjectChanged
        );
        onProjectChanged();
      });

      await openAuthorizedProject(target.id);
      await peerSynced;

      expect(rustActiveRoot).toBe(target.path);
      expect(secondWindow.localStorage.getItem('crish_active_project_id')).toBe(
        target.id
      );
      expect(secondWindow.localStorage.getItem('crish_workspace')).toBe(
        rustActiveRoot
      );
    } finally {
      removeSecondBridge();
      frame.remove();
    }
  });

  it('re-authorizes every cached project root atomically with an explicit primary', async () => {
    const project = addProjectFromPaths(
      ['D:/recent/primary', 'E:/recent/secondary'],
      'multi-root'
    );
    let received: unknown;
    mockTauriCommand('workbench_open_workspaces', (args) => {
      received = args;
      return { path: project.path };
    });

    await expect(openAuthorizedProject(project.id)).resolves.toMatchObject({
      id: project.id,
    });
    expect(received).toEqual({
      paths: project.paths,
      primaryPath: project.path,
      activatePrimary: true,
    });
    expect(getActiveProjectId()).toBe(project.id);
  });

  it('startup restoration re-authorizes all roots of the active multi-directory project', async () => {
    const project = addProjectFromPaths(
      ['D:/recent/primary', 'E:/recent/secondary'],
      'multi-root'
    );
    let received: unknown;
    mockTauriCommand('workbench_open_workspaces', (args) => {
      received = args;
      return { path: project.path };
    });

    await expect(reauthorizeActiveProject()).resolves.toBeUndefined();
    expect(received).toEqual({
      paths: project.paths,
      primaryPath: project.path,
      activatePrimary: true,
    });
  });

  it('delayed startup restore cannot replace a project chosen during recovery or release file IPC early', async () => {
    const startupProject = addProjectFromPaths(
      ['D:/recent/startup-primary', 'E:/recent/startup-secondary'],
      'startup'
    );
    const chosenProject = addProjectFromPath('F:/recent/chosen', 'chosen');
    openProject(startupProject.id);

    let resolveStartupAuthorization!: (value: { path: string }) => void;
    const delayedStartupAuthorization = new Promise<{ path: string }>(
      (resolve) => {
        resolveStartupAuthorization = resolve;
      }
    );
    const authorizedPrimaries: string[] = [];
    let rustActiveRoot = '';
    let fileCommandRoot = '';
    mockTauriCommand('workbench_open_workspaces', (args) => {
      const primaryPath = (args as { primaryPath: string }).primaryPath;
      authorizedPrimaries.push(primaryPath);
      if (primaryPath === startupProject.path) {
        return delayedStartupAuthorization.then((result) => {
          rustActiveRoot = primaryPath;
          return result;
        });
      }
      rustActiveRoot = primaryPath;
      return { path: primaryPath };
    });
    mockTauriCommand('workbench_read_file_content', () => {
      fileCommandRoot = rustActiveRoot;
      return { content: 'ok' };
    });

    reserveWorkspaceAccessStartup();
    const startupRestore = restoreActiveWorkspaceAtStartup();
    const projectSwitch = openAuthorizedProject(chosenProject.id);
    const fileRequest = invokeTyped<{ content: string }>(
      'workbench_read_file_content',
      { path: 'relative.txt' }
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authorizedPrimaries).toEqual([startupProject.path]);
    expect(fileCommandRoot).toBe('');
    expect(getActiveProjectId()).toBe(startupProject.id);

    resolveStartupAuthorization({ path: startupProject.path });
    await startupRestore;
    await expect(projectSwitch).resolves.toMatchObject({
      id: chosenProject.id,
    });
    await expect(fileRequest).resolves.toMatchObject({
      status: 'ok',
      data: { content: 'ok' },
    });

    expect(authorizedPrimaries).toEqual([
      startupProject.path,
      chosenProject.path,
    ]);
    expect(getActiveProjectId()).toBe(chosenProject.id);
    expect(rustActiveRoot).toBe(chosenProject.path);
    expect(fileCommandRoot).toBe(chosenProject.path);
  });

  it('keeps workspace IPC blocked after failed startup restore until a project is reauthorized', async () => {
    const project = addProjectFromPath('D:/cached/untrusted', 'cached');
    openProject(project.id);
    reserveWorkspaceAccessStartup();
    mockTauriError(
      'workbench_open_workspaces',
      new Error('workspace_not_granted: path not in recent list')
    );

    await expect(restoreActiveWorkspaceAtStartup()).rejects.toBeInstanceOf(
      WorkspaceAccessError
    );

    let fileCommandCalled = false;
    mockTauriCommand('workbench_read_file_content', () => {
      fileCommandCalled = true;
      return { content: 'should not run before recovery' };
    });
    await expect(
      invokeTyped('workbench_read_file_content', { path: 'relative.txt' })
    ).resolves.toMatchObject({ status: 'error' });
    expect(fileCommandCalled).toBe(false);

    mockTauriCommand('workbench_open_workspaces', (args) => ({
      path: (args as { primaryPath: string }).primaryPath,
    }));
    await expect(openAuthorizedProject(project.id)).resolves.toMatchObject({
      id: project.id,
    });
    await expect(
      invokeTyped('workbench_read_file_content', { path: 'relative.txt' })
    ).resolves.toMatchObject({ status: 'ok' });
    expect(fileCommandCalled).toBe(true);
  });

  it('batch reauthorization can validate an inactive project without switching the active root', async () => {
    let received: unknown;
    mockTauriCommand('workbench_open_workspaces', (args) => {
      received = args;
      return { path: 'D:/recent/primary' };
    });

    await expect(
      authorizeRecentWorkspacePaths(
        ['D:/recent/primary', 'E:/recent/secondary'],
        'D:/recent/primary',
        false
      )
    ).resolves.toBe('D:/recent/primary');
    expect(received).toEqual({
      paths: ['D:/recent/primary', 'E:/recent/secondary'],
      primaryPath: 'D:/recent/primary',
      activatePrimary: false,
    });
  });

  it('resolves a relative file write after a queued project switch', async () => {
    const first = addProjectFromPath('D:/recent/first', 'first');
    const next = addProjectFromPath('E:/recent/next', 'next');
    openProject(first.id);

    let resolveAuthorization!: (value: { path: string }) => void;
    const authorization = new Promise<{ path: string }>((resolve) => {
      resolveAuthorization = resolve;
    });
    let rustActiveRoot = first.path;
    let fileArgs: unknown;
    mockTauriCommand('workbench_open_workspaces', (args) => {
      const primaryPath = (args as { primaryPath: string }).primaryPath;
      return authorization.then((result) => {
        rustActiveRoot = primaryPath;
        return result;
      });
    });
    mockTauriCommand('workbench_write_file_content', (args) => {
      fileArgs = args;
      expect(rustActiveRoot).toBe(next.path);
      return null;
    });

    const projectSwitch = openAuthorizedProject(next.id);
    const write = writeTextFile('notes.md', 'new project content');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fileArgs).toBeUndefined();

    resolveAuthorization({ path: next.path });
    await expect(projectSwitch).resolves.toMatchObject({ id: next.id });
    await expect(write).resolves.toBeUndefined();

    expect(fileArgs).toEqual({
      path: `${next.path}/notes.md`,
      content: 'new project content',
      overwrite: false,
    });
    expect(getWorkspacePath()).toBe(next.path);
  });

  it('reserves a session-folder transition before same-turn workspace IPC', async () => {
    markTauriRuntime();
    const current = addProjectFromPath('D:/recent/current', 'current');
    const target = addProjectFromPath('E:/recent/session-target', 'target');
    openProject(current.id);

    let resolveAuthorization!: (value: { path: string }) => void;
    const authorization = new Promise<{ path: string }>((resolve) => {
      resolveAuthorization = resolve;
    });
    let authorizationStarted = false;
    let rustActiveRoot = current.path;
    let fileCommandCalled = false;
    mockTauriCommand('workbench_open_workspaces', (args) => {
      authorizationStarted = true;
      const primaryPath = (args as { primaryPath: string }).primaryPath;
      return authorization.then((result) => {
        rustActiveRoot = primaryPath;
        return result;
      });
    });
    mockTauriCommand('workbench_read_file_content', () => {
      fileCommandCalled = true;
      expect(rustActiveRoot).toBe(target.path);
      return { content: 'ok' };
    });

    const sessionSwitch = activateWorkspaceForSessionFolder(target.id);
    const workspaceRequest = invokeTyped('workbench_read_file_content', {
      path: 'relative.txt',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authorizationStarted).toBe(true);
    expect(fileCommandCalled).toBe(false);

    resolveAuthorization({ path: target.path });
    await expect(sessionSwitch).resolves.toBeUndefined();
    await expect(workspaceRequest).resolves.toMatchObject({ status: 'ok' });
    expect(getActiveProjectId()).toBe(target.id);
    expect(rustActiveRoot).toBe(target.path);
    expect(fileCommandCalled).toBe(true);
  });

  it('serializes rapid session-folder switches and keeps IPC blocked after the latest authorization fails', async () => {
    markTauriRuntime();
    const current = addProjectFromPath('D:/recent/current', 'current');
    const first = addProjectFromPath('E:/recent/first-session', 'first');
    const last = addProjectFromPath('F:/recent/last-session', 'last');
    openProject(current.id);

    let resolveFirstAuthorization!: (value: { path: string }) => void;
    const firstAuthorization = new Promise<{ path: string }>((resolve) => {
      resolveFirstAuthorization = resolve;
    });
    const authorizedPaths: string[] = [];
    let rustActiveRoot = current.path;
    let fileCommandCalled = false;
    mockTauriCommand('workbench_open_workspaces', (args) => {
      const primaryPath = (args as { primaryPath: string }).primaryPath;
      authorizedPaths.push(primaryPath);
      if (primaryPath === first.path) {
        return firstAuthorization.then((result) => {
          rustActiveRoot = primaryPath;
          return result;
        });
      }
      if (primaryPath === last.path) {
        throw new Error('workspace_not_granted: last session root');
      }
      rustActiveRoot = primaryPath;
      return { path: primaryPath };
    });
    mockTauriCommand('workbench_read_file_content', () => {
      fileCommandCalled = true;
      return { content: 'must remain blocked' };
    });
    const toastError = vi.spyOn(toast, 'error');

    const firstSwitch = activateWorkspaceForSessionFolder(first.id);
    const lastSwitch = activateWorkspaceForSessionFolder(last.id);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authorizedPaths).toEqual([first.path]);
    expect(fileCommandCalled).toBe(false);

    resolveFirstAuthorization({ path: first.path });
    await Promise.all([firstSwitch, lastSwitch]);
    expect(authorizedPaths).toEqual([first.path, last.path]);
    expect(rustActiveRoot).toBe(first.path);
    expect(toastError).toHaveBeenCalledWith(
      '该项目目录尚未授权，请重新选择项目文件夹。'
    );

    await expect(
      invokeTyped('workbench_read_file_content', { path: 'relative.txt' })
    ).resolves.toMatchObject({ status: 'error', kind: 'WorkspaceAccess' });
    expect(fileCommandCalled).toBe(false);
  });

  it('fails closed when a session references a project that no longer exists', async () => {
    markTauriRuntime();
    const active = addProjectFromPath('D:/recent/active', 'active');
    openProject(active.id);
    const toastError = vi.spyOn(toast, 'error');
    let fileCommandCalled = false;
    mockTauriCommand('workbench_read_file_content', () => {
      fileCommandCalled = true;
      return { content: 'must remain blocked' };
    });

    await activateWorkspaceForSessionFolder('proj-deleted-unmapped');
    await expect(
      invokeTyped('workbench_read_file_content', { path: 'relative.txt' })
    ).resolves.toMatchObject({ status: 'error', kind: 'WorkspaceAccess' });

    expect(getActiveProjectId()).toBe(active.id);
    expect(getWorkspacePath()).toBe(active.path);
    expect(toastError).toHaveBeenCalledWith(
      '会话所属项目已不存在，请重新授权工作区。'
    );
    expect(fileCommandCalled).toBe(false);
  });

  it('re-reads active project inside a queued project edit transaction', async () => {
    const active = addProjectFromPath('D:/recent/active', 'active');
    const target = addProjectFromPath('E:/recent/target', 'target');
    openProject(active.id);

    reserveWorkspaceAccessStartup();
    let received: unknown;
    mockTauriCommand('workbench_open_workspaces', (args) => {
      received = args;
      return { path: (args as { primaryPath: string }).primaryPath };
    });
    const edit = updateAuthorizedProjectPaths(
      target.id,
      ['F:/recent/updated'],
      'updated'
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toBeUndefined();

    openProject(target.id);
    completeWorkspaceAccessStartup();
    await expect(edit).resolves.toMatchObject({
      id: target.id,
      path: 'F:/recent/updated',
    });
    expect(received).toEqual({
      paths: ['F:/recent/updated'],
      primaryPath: 'F:/recent/updated',
      activatePrimary: true,
    });
    expect(getActiveProjectId()).toBe(target.id);
  });

  it('resets Rust to the default root before clearing an active project', async () => {
    markTauriRuntime();
    const active = addProjectFromPath('D:/recent/active', 'active');
    openProject(active.id);
    let rustActiveRoot = active.path;
    const defaultRoot = 'C:/Users/test/Documents/Crish';
    mockTauriCommand('workbench_activate_default_workspace', () => {
      rustActiveRoot = defaultRoot;
      return { path: defaultRoot };
    });

    await removeAuthorizedProject(active.id);

    expect(rustActiveRoot).toBe(defaultRoot);
    expect(getActiveProjectId()).toBeNull();
    expect(getWorkspacePath()).toBe('');
    expect(listProjects()).toEqual([]);
  });

  it('keeps the active project when Rust cannot reset the default root', async () => {
    markTauriRuntime();
    const active = addProjectFromPath('D:/recent/active', 'active');
    openProject(active.id);
    mockTauriMissing('workbench_activate_default_workspace');

    await expect(removeAuthorizedProject(active.id)).rejects.toMatchObject({
      code: 'command-unavailable',
    });

    expect(getActiveProjectId()).toBe(active.id);
    expect(getWorkspacePath()).toBe(active.path);
    expect(listProjects().some((project) => project.id === active.id)).toBe(
      true
    );
  });

  it('fails closed when a Tauri startup authorization command is missing', async () => {
    markTauriRuntime();
    const active = addProjectFromPath('D:/cached/project', 'cached');
    openProject(active.id);
    reserveWorkspaceAccessStartup();

    await expect(restoreActiveWorkspaceAtStartup()).rejects.toMatchObject({
      code: 'command-unavailable',
    });

    let fileCommandCalled = false;
    mockTauriCommand('workbench_read_file_content', () => {
      fileCommandCalled = true;
      return { content: 'must stay blocked' };
    });
    await expect(
      invokeTyped('workbench_read_file_content', { path: 'notes.md' })
    ).resolves.toMatchObject({ status: 'error' });
    expect(fileCommandCalled).toBe(false);
    expect(getActiveProjectId()).toBe(active.id);
  });
});
