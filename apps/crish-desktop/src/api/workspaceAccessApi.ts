/**
 * 工作区授权 IPC。
 *
 * 新根只能由 Rust 侧原生目录选择器登记；此处不把目录选择结果回传给授权命令。
 * localStorage 中的旧路径只允许通过 RecentList 复授权。
 */

import { invokeTyped, isTauriRuntimeAvailable } from './tauriInvoke';
import {
  __resetWorkspaceAccessGateForTests,
  completeWorkspaceAccessStartup,
  withWorkspaceAccessStartupLock,
  withWorkspaceAccessTransition,
} from './workspaceAccessGate';
import {
  addProjectFromPath,
  addProjectFromPaths,
  getActiveProjectId,
  listProjects,
  openProject,
  removeProject,
  setNoProject,
  updateProject,
  type ProjectEntry,
} from './projectStore';
import {
  activateDefaultWorkspaceWithinTransition,
  authorizeProjectWorkspacePathsWithinTransition,
  authorizeRecentWorkspacePathWithinTransition,
  authorizeRecentWorkspacePathsWithinTransition,
  unwrapWorkspaceAccessResult,
  WorkspaceAccessError,
  type WorkspaceAccessErrorCode,
} from './workspaceAccessContract';

export { WorkspaceAccessError };
export type { WorkspaceAccessErrorCode };

function activateDefaultWorkspaceInternal(): Promise<void> {
  return activateDefaultWorkspaceWithinTransition(
    invokeTyped,
    isTauriRuntimeAvailable,
    setNoProject
  );
}

/** Rust 侧打开原生单目录选择器并在回调内登记；IPC 不接收路径。 */
export async function selectWorkspaceFolder(): Promise<string | null> {
  return withWorkspaceAccessTransition(
    async () => {
      const path = unwrapWorkspaceAccessResult(
        await invokeTyped<string | null>('workbench_pick_workspace_folder'),
        '本地文件夹选择器不可用。' /* i18n-allow */
      );
      return typeof path === 'string' && path.length > 0 ? path : null;
    },
    (path) => path !== null
  );
}

/** Rust 侧打开原生多目录选择器；所有路径在 Rust 内一次性校验并登记。 */
export async function selectWorkspaceFolders(
  activateFirst: boolean
): Promise<string[] | null> {
  return withWorkspaceAccessTransition(
    async () => {
      const paths = unwrapWorkspaceAccessResult(
        await invokeTyped<string[] | null>('workbench_pick_workspace_folders', {
          activateFirst,
        }),
        '本地文件夹选择器不可用。' /* i18n-allow */
      );
      return Array.isArray(paths) ? paths : null;
    },
    (paths) => Boolean(paths?.length)
  );
}

/**
 * 对 localStorage 中的路径执行 RecentList/DefaultAppRoot 复授权。
 * 这条命令不能创建新授权，路径不在可信 recent/default 集合时会被 Rust 拒绝。
 */
export async function authorizeRecentWorkspacePath(
  path: string
): Promise<string> {
  return withWorkspaceAccessTransition(() =>
    authorizeRecentWorkspacePathWithinTransition(invokeTyped, path)
  );
}

/**
 * 多目录项目的 RecentList 批量复授权。Rust 全量验证后一次写入注册表，并将
 * primaryPath 设为活动根；任一路径非法时不会留下半切换状态。
 */
export async function authorizeRecentWorkspacePaths(
  paths: string[],
  primaryPath: string,
  activatePrimary = true
): Promise<string> {
  return withWorkspaceAccessTransition(() =>
    authorizeRecentWorkspacePathsWithinTransition(
      invokeTyped,
      paths,
      primaryPath,
      activatePrimary
    )
  );
}

/** 恢复项目全部根，并将 project.path 保持为当前活动工作区根。 */
export async function authorizeProjectWorkspacePaths(
  project: ProjectEntry,
  activatePrimary = true
): Promise<string> {
  return withWorkspaceAccessTransition(() =>
    authorizeProjectWorkspacePathsWithinTransition(
      invokeTyped,
      project,
      activatePrimary
    )
  );
}

/** 已有项目的活动切换先通过 RecentList 校验，再写入本地显示状态。 */
export async function openAuthorizedProject(
  projectId: string
): Promise<ProjectEntry | null> {
  return withWorkspaceAccessTransition(
    async () => {
      const project = listProjects().find((item) => item.id === projectId);
      if (!project) return null;
      await authorizeProjectWorkspacePathsWithinTransition(
        invokeTyped,
        project
      );
      return openProject(projectId);
    },
    (project) => project !== null
  );
}

/** 手动输入或旧缓存路径只能走 RecentList 复授权，成功后才写入项目列表。 */
export async function addProjectFromRecentPath(
  path: string,
  name?: string
): Promise<ProjectEntry> {
  return withWorkspaceAccessTransition(async () => {
    const canonicalPath = await authorizeRecentWorkspacePathWithinTransition(
      invokeTyped,
      path
    );
    return addProjectFromPath(canonicalPath, name);
  });
}

/** 将选择器返回值保存为项目；授权已由 Rust picker 在同一次调用内完成。 */
export async function pickAndAddWorkspaceProject(): Promise<ProjectEntry | null> {
  return withWorkspaceAccessTransition(
    async () => {
      const path = unwrapWorkspaceAccessResult(
        await invokeTyped<string | null>('workbench_pick_workspace_folder'),
        '本地文件夹选择器不可用。' /* i18n-allow */
      );
      return path ? addProjectFromPath(path) : null;
    },
    (project) => project !== null
  );
}

/** 新建多目录项目：复授权和本地项目写入作为一个工作区切换事务完成。 */
export async function addProjectFromRecentPaths(
  paths: string[],
  name?: string
): Promise<ProjectEntry> {
  return withWorkspaceAccessTransition(async () => {
    const primaryPath = paths[0];
    if (!primaryPath) {
      throw new WorkspaceAccessError(
        'workspace-not-granted',
        '项目至少需要一个工作区目录。' /* i18n-allow */
      );
    }
    await authorizeRecentWorkspacePathsWithinTransition(
      invokeTyped,
      paths,
      primaryPath,
      true
    );
    return addProjectFromPaths(paths, name);
  });
}

/** 编辑项目时，将授权和本地元数据更新保持在同一工作区事务内。 */
export async function updateAuthorizedProjectPaths(
  projectId: string,
  paths: string[],
  name: string
): Promise<ProjectEntry | null> {
  return withWorkspaceAccessTransition(
    async () => {
      const primaryPath = paths[0];
      if (!primaryPath) {
        throw new WorkspaceAccessError(
          'workspace-not-granted',
          '项目至少需要一个工作区目录。' /* i18n-allow */
        );
      }
      await authorizeRecentWorkspacePathsWithinTransition(
        invokeTyped,
        paths,
        primaryPath,
        getActiveProjectId() === projectId
      );
      return updateProject(projectId, {
        name,
        path: primaryPath,
        paths,
      });
    },
    (project) => project !== null
  );
}

/** 切回通用项目时先让 Rust 恢复默认根，再提交前端无项目状态。 */
export async function activateDefaultWorkspace(): Promise<void> {
  return withWorkspaceAccessTransition(async () => {
    await activateDefaultWorkspaceInternal();
  });
}

/** 删除项目时，活动项目先把 Rust 根切回默认根；失败则保留前端项目状态。 */
export async function removeAuthorizedProject(
  projectId: string
): Promise<void> {
  await withWorkspaceAccessTransition(async () => {
    if (getActiveProjectId() === projectId) {
      await activateDefaultWorkspaceInternal();
    }
    removeProject(projectId);
  });
}

/** 锁内读取当前项目，避免等待跨窗口授权锁期间拿着旧 active id。 */
async function reauthorizeActiveProjectInternal(): Promise<void> {
  const activeId = getActiveProjectId();
  if (!activeId) return;
  const project = listProjects().find((item) => item.id === activeId);
  if (!project) return;
  await authorizeProjectWorkspacePathsWithinTransition(invokeTyped, project);
}

/** 启动时恢复当前项目的 recent 授权；无当前项目时不操作。 */
export async function reauthorizeActiveProject(): Promise<void> {
  return withWorkspaceAccessStartupLock(reauthorizeActiveProjectInternal);
}

let startupRestorePromise: Promise<void> | null = null;

/** 共享 StrictMode / 重复挂载下的单次启动复授权及门闩收尾。 */
export function restoreActiveWorkspaceAtStartup(): Promise<void> {
  if (!startupRestorePromise) {
    startupRestorePromise = withWorkspaceAccessStartupLock(
      reauthorizeActiveProjectInternal
    ).then(
      () => {
        completeWorkspaceAccessStartup();
      },
      (error: unknown) => {
        completeWorkspaceAccessStartup(
          error instanceof WorkspaceAccessError &&
            error.code === 'command-unavailable' &&
            !isTauriRuntimeAvailable()
            ? undefined
            : error
        );
        throw error;
      }
    );
  }
  return startupRestorePromise;
}

/** 在工作区授权 API 单测中清理共享启动状态。 */
export function __resetWorkspaceAccessApiForTests(): void {
  startupRestorePromise = null;
  __resetWorkspaceAccessGateForTests();
}

/** 查询 Rust 注册表中的授权根，用于启动状态同步。 */
export async function listAuthorizedWorkspacePaths(): Promise<string[]> {
  const roots = unwrapWorkspaceAccessResult(
    await invokeTyped<string[]>('workbench_list_workspaces'),
    '工作区状态命令不可用。' /* i18n-allow */
  );
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== 'string')) {
    throw new WorkspaceAccessError(
      'command-failed',
      '工作区状态命令返回了无效结果。' /* i18n-allow */
    );
  }
  return roots;
}
