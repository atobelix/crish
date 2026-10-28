// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  GENERAL_FOLDER,
  addProjectFromPath,
  canonicalSessionFolder,
  getActiveProjectId,
  getWorkspacePath,
  installProjectStoreStorageBridge,
  listProjects,
  openProject,
  rebindSessionFoldersToProjects,
  rememberProjectFolderAlias,
  resolveFolderToProjectId,
  stableProjectIdFromPath,
} from './projectStore';

function belongs(folder: string, workspace: string): boolean {
  return canonicalSessionFolder(folder) === canonicalSessionFolder(workspace);
}

beforeEach(() => {
  localStorage.clear();
});

describe('stableProjectIdFromPath', () => {
  it('same path → same id (case/slash normalized)', () => {
    const a = stableProjectIdFromPath('C:\\workspace\\crish');
    const b = stableProjectIdFromPath('C:/workspace/crish/');
    const c = stableProjectIdFromPath('c:/workspace/crish');
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a.startsWith('proj-')).toBe(true);
  });

  it('different paths → different ids', () => {
    expect(stableProjectIdFromPath('/a/b')).not.toBe(
      stableProjectIdFromPath('/a/c')
    );
  });
});

describe('orphan proj-* recovery', () => {
  it('rebinds single-project orphan folders like proj-mrlldzn', () => {
    const p = addProjectFromPath('C:/workspace/crish', 'crish');
    const sessions = [
      { id: '1', folder: 'proj-mrlldzn' },
      { id: '2', folder: GENERAL_FOLDER },
      { id: '3', folder: p.id },
    ];
    const n = rebindSessionFoldersToProjects(sessions, listProjects());
    expect(n).toBeGreaterThanOrEqual(1);
    expect(sessions[0]!.folder).toBe(p.id);
    expect(sessions[1]!.folder).toBe(GENERAL_FOLDER);
    expect(sessions[2]!.folder).toBe(p.id);
  });

  it('alias map remaps historical id to current project', () => {
    const p = addProjectFromPath('D:/work/demo', 'demo');
    rememberProjectFolderAlias('proj-olddead', p.path);
    expect(resolveFolderToProjectId('proj-olddead')).toBe(p.id);
    expect(canonicalSessionFolder('proj-olddead')).toBe(p.id);
    expect(belongs('proj-olddead', p.id)).toBe(true);
  });

  it('re-adding same path yields same stable id', () => {
    const a = addProjectFromPath('E:/repo/foo', 'foo');
    localStorage.removeItem('crish_projects_v1');
    localStorage.removeItem('crish_active_project_id');
    const b = addProjectFromPath('E:/repo/foo', 'foo');
    expect(b.id).toBe(a.id);
  });
});

describe('cross-window project storage bridge', () => {
  it('notifies both WebViews when either one changes project state', async () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const secondWindow = frame.contentWindow;
    if (!secondWindow)
      throw new Error('second WebView test window unavailable');
    const removeSecondBridge = installProjectStoreStorageBridge(secondWindow);

    const waitForProjectChange = (target: Window) =>
      new Promise<void>((resolve) => {
        target.addEventListener('crish-project-changed', () => resolve(), {
          once: true,
        });
      });

    try {
      const project = addProjectFromPath('D:/workspace/first', 'first');
      const localChange = waitForProjectChange(window);
      const remoteChange = waitForProjectChange(secondWindow);
      openProject(project.id);
      await Promise.all([localChange, remoteChange]);

      expect(secondWindow.localStorage.getItem('crish_active_project_id')).toBe(
        project.id
      );
      expect(secondWindow.localStorage.getItem('crish_workspace')).toBe(
        project.path
      );

      for (const [key, value] of [
        ['crish_projects_v1', '[]'],
        ['crish_active_project_id', 'remote-project'],
        ['crish_workspace', 'E:/workspace/remote'],
      ]) {
        const peerChange = waitForProjectChange(window);
        secondWindow.localStorage.setItem(key, value);
        await peerChange;
      }

      expect(getActiveProjectId()).toBe('remote-project');
      expect(getWorkspacePath()).toBe('E:/workspace/remote');
    } finally {
      removeSecondBridge();
      frame.remove();
    }
  });
});
