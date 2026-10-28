import type { InvokeArgs, InvokeTypedResult } from './tauriInvoke';
import { t } from '../i18n';

export type WorkspaceAccessErrorCode =
  'command-unavailable' | 'workspace-not-granted' | 'command-failed';

export class WorkspaceAccessError extends Error {
  readonly code: WorkspaceAccessErrorCode;

  constructor(code: WorkspaceAccessErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'WorkspaceAccessError';
  }
}

export function isWorkspaceCommandUnavailableOutsideTauri(
  error: unknown,
  tauriRuntimeAvailable: boolean
): boolean {
  return (
    !tauriRuntimeAvailable &&
    error instanceof Error &&
    'code' in error &&
    error.code === 'command-unavailable'
  );
}

export function sessionWorkspaceErrorMessage(
  error: unknown,
  folder: string,
  generalFolder: string
): string {
  if (error instanceof Error && error.message) return error.message;
  return folder === generalFolder ||
    folder === '会话' /* i18n-allow: persisted folder identifier */ ||
    folder === '常规会话' /* i18n-allow: persisted folder identifier */ ||
    folder === 'general'
    ? t('workspace.switchToDefaultFailed')
    : t('workspace.projectNotAuthorized');
}

export type WorkspaceAccessTransition = (
  operation: () => Promise<void>,
  succeeded: (value: void) => boolean,
  options: { failClosedOnError: boolean }
) => Promise<void>;

export function runSessionWorkspaceActivation(
  folder: string,
  generalFolder: string,
  transition: WorkspaceAccessTransition,
  activate: () => Promise<void>,
  tauriRuntimeAvailable: () => boolean,
  notifyError: (message: string) => void | Promise<void>
): Promise<void> {
  const result = transition(
    async () => {
      try {
        await activate();
      } catch (error) {
        if (
          isWorkspaceCommandUnavailableOutsideTauri(
            error,
            tauriRuntimeAvailable()
          )
        ) {
          return;
        }
        throw error;
      }
    },
    () => true,
    { failClosedOnError: true }
  );

  return result.then(
    () => undefined,
    async (error: unknown) => {
      try {
        await notifyError(
          sessionWorkspaceErrorMessage(error, folder, generalFolder)
        );
      } catch {
        // 通知失败时，工作区授权门闩仍保持阻断。
      }
    }
  );
}

export function unwrapWorkspaceAccessResult<T>(
  result: InvokeTypedResult<T>,
  unavailableMessage: string
): T {
  if (result.status === 'ok') return result.data;
  if (result.status === 'missing') {
    throw new WorkspaceAccessError('command-unavailable', unavailableMessage);
  }
  if (result.message.includes('workspace_not_granted')) {
    throw new WorkspaceAccessError(
      'workspace-not-granted',
      t('workspace.projectNotYetAuthorized')
    );
  }
  throw new WorkspaceAccessError(
    'command-failed',
    t('workspace.projectOperationFailed')
  );
}

export type WorkspaceAccessInvoke = <T = unknown>(
  command: string,
  args?: InvokeArgs
) => Promise<InvokeTypedResult<T>>;

export async function authorizeRecentWorkspacePathWithinTransition(
  invoke: WorkspaceAccessInvoke,
  path: string
): Promise<string> {
  const result = unwrapWorkspaceAccessResult(
    await invoke<{ path?: unknown }>('workbench_open_workspace', { path }),
    t('workspace.projectAuthorizationUnavailable')
  );
  if (typeof result.path !== 'string' || result.path.length === 0) {
    throw new WorkspaceAccessError(
      'command-failed',
      t('workspace.projectAuthorizationInvalidPath')
    );
  }
  return result.path;
}

export async function authorizeRecentWorkspacePathsWithinTransition(
  invoke: WorkspaceAccessInvoke,
  paths: string[],
  primaryPath: string,
  activatePrimary: boolean
): Promise<string> {
  const result = unwrapWorkspaceAccessResult(
    await invoke<{ path?: unknown }>('workbench_open_workspaces', {
      paths,
      primaryPath,
      activatePrimary,
    }),
    t('workspace.projectMultiAuthorizationUnavailable')
  );
  if (typeof result.path !== 'string' || result.path.length === 0) {
    throw new WorkspaceAccessError(
      'command-failed',
      t('workspace.projectMultiAuthorizationInvalidPath')
    );
  }
  return result.path;
}

export interface WorkspaceProject {
  id: string;
  path: string;
  paths?: string[];
}

function projectWorkspacePaths(project: WorkspaceProject): string[] {
  const paths = project.paths?.filter((path) => path.trim().length > 0) ?? [];
  if (!paths.includes(project.path)) paths.push(project.path);
  return [...new Set(paths)];
}

export function authorizeProjectWorkspacePathsWithinTransition(
  invoke: WorkspaceAccessInvoke,
  project: WorkspaceProject,
  activatePrimary = true
): Promise<string> {
  return authorizeRecentWorkspacePathsWithinTransition(
    invoke,
    projectWorkspacePaths(project),
    project.path,
    activatePrimary
  );
}

export async function activateDefaultWorkspaceWithinTransition(
  invoke: WorkspaceAccessInvoke,
  isTauriRuntimeAvailable: () => boolean,
  setNoProject: () => void
): Promise<void> {
  if (!isTauriRuntimeAvailable()) {
    setNoProject();
    return;
  }
  const result = unwrapWorkspaceAccessResult(
    await invoke<{ path?: unknown }>('workbench_activate_default_workspace'),
    t('workspace.projectDefaultAuthorizationUnavailable')
  );
  if (typeof result.path !== 'string' || result.path.length === 0) {
    throw new WorkspaceAccessError(
      'command-failed',
      t('workspace.projectDefaultAuthorizationInvalidPath')
    );
  }
  setNoProject();
}

export interface SessionWorkspaceAccessDependencies {
  generalFolder: string;
  resolveFolderToProjectId: (folder: string) => string | null;
  findProject: (projectId: string) => WorkspaceProject | null | undefined;
  authorizeProject: (project: WorkspaceProject) => Promise<string>;
  activateDefaultWorkspace: () => Promise<void>;
  openProject: (projectId: string) => unknown | null;
}

export async function activateWorkspaceForSessionFolderWithinTransition(
  folder: string,
  dependencies: SessionWorkspaceAccessDependencies
): Promise<void> {
  if (
    !folder ||
    folder === dependencies.generalFolder ||
    folder === '会话' /* i18n-allow: persisted folder identifier */ ||
    folder === '常规会话' /* i18n-allow: persisted folder identifier */ ||
    folder === 'general'
  ) {
    await dependencies.activateDefaultWorkspace();
    return;
  }

  const projectId = dependencies.resolveFolderToProjectId(folder);
  if (!projectId) {
    throw new WorkspaceAccessError(
      'workspace-not-granted',
      t('workspace.projectMissingForSession')
    );
  }
  const project = dependencies.findProject(projectId);
  if (!project) {
    throw new WorkspaceAccessError(
      'workspace-not-granted',
      t('workspace.projectMissingForSession')
    );
  }

  await dependencies.authorizeProject(project);
  if (!dependencies.openProject(projectId)) {
    throw new WorkspaceAccessError(
      'command-failed',
      t('workspace.projectActivationFailed')
    );
  }
}
