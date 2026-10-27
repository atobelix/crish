import type { WorkspaceTranslations } from '../../types';

export const workspace: WorkspaceTranslations = {
  switchWorkspace: 'Switch Workspace',
  currentWorkspace: 'Current Workspace',
  guestUser: 'Guest User',
  settingsNav: 'Settings Navigation',
  selectWorkspace: 'Select Workspace',
  openFolder: 'Open Folder',
  noWorkspace: 'No Workspace Open',
  noWorkspaceHint: 'Please open a folder to start working',
  readOnlyWorkspace: 'Read-only Workspace',
  fileWatcherStatus: 'File Watcher Status',
  fileWatcherActive: 'File Watcher Active',
  fileWatcherStopped: 'File Watcher Stopped',
  workspacePath: 'Workspace Path',
  reloadWorkspace: 'Reload Workspace',
  closeWorkspace: 'Close Workspace',
  recentWorkspaces: 'Recent Workspaces',
  clearRecentWorkspaces: 'Clear Recent Workspaces',
  documentTitle: 'Crish · AI Workbench',
  startupAuthorizationFailed:
    'Workspace authorization failed at startup. Please select the project folder again.',
  projectChangedDuringGit:
    'The active project changed. The Git operation for the previous workspace was canceled.',
  projectNotAuthorized:
    'This project folder is not authorized. Please select the project folder again.',
  projectNotYetAuthorized:
    'This project folder has not been authorized. Please select the project folder again.',
  projectOperationFailed: 'Workspace operation failed. Please try again.',
  projectAuthorizationUnavailable:
    'The workspace authorization command is unavailable.',
  projectAuthorizationInvalidPath:
    'The workspace authorization command returned an invalid path.',
  projectMultiAuthorizationUnavailable:
    'The multi-folder workspace authorization command is unavailable.',
  projectMultiAuthorizationInvalidPath:
    'The multi-folder workspace authorization command returned an invalid path.',
  projectDefaultAuthorizationUnavailable:
    'The default workspace authorization command is unavailable.',
  projectDefaultAuthorizationInvalidPath:
    'The default workspace authorization command returned an invalid path.',
  projectMissingForSession:
    'The project for this session no longer exists. Please authorize the workspace again.',
  projectActivationFailed:
    'The project could not be activated after authorization. Please try again.',
  switchToDefaultFailed: 'Could not switch to the default workspace.',
  'project.pickerUnavailable': 'Could not open the local folder picker.',
  'project.saveFailed': 'Could not save the project. Please try again.',
  'project.notAuthorized':
    'This project folder is not authorized. Please select the project folder again.',
  'project.removeFailed': 'Could not remove the project. Please try again.',
  'project.create': 'New Project',
  'project.saveChanges': 'Save Changes',
  'project.manage': 'Project Management',
  'project.folder': 'Project Folders',
  'project.chooseFolder': 'Choose a project folder',
  'project.removeFolder': 'Remove this folder',
  'project.addMoreFolders': 'Add More Folders',
  'project.name': 'Project Name',
  'project.createConversation': 'New Conversation in This Project',
  'project.setCurrentWorkspace': 'Set as Current Workspace',
  'project.pathCopied': 'Path Copied',
  'project.copyFolderPath': 'Copy Folder Path',
  'project.removeFromList': 'Remove Project from List',
  'project.removeTitle': 'Remove Project',
  'project.confirmRemoveDescription': 'Remove project "{name}" from the list?',
  'project.general': 'General Project',
  'project.add': 'Add Project',
  'project.openLocal': 'Open Local Project...',
  'project.createBlank': 'Create Blank Project...',
  'project.search': 'Search Projects',
  'project.removeAria': 'Remove project {name} from the list',
  'project.removeFolderAria': 'Remove folder {path}',
  'trash.readFailed': 'Could not read the Recycle Bin',
  'trash.readFailedDetail': 'Could not read the Recycle Bin: {message}',
  'trash.refreshFailed': 'Recycle Bin refresh failed: {message}',
  'trash.unknownError': 'Unknown error',
  'trash.restoreFailed': 'Restore failed',
  'trash.purgeFailed': 'Permanent deletion failed',
  'trash.commandUnavailable':
    'Recycle Bin command is unavailable ({command} is not registered)',
  'trash.itemNotFound': 'Item not found: {message}',
  'trash.operationFailed': '{fallback}: {message}',
  'trash.title': 'Recycle Bin',
  'trash.loading': 'Loading…',
  'trash.empty': 'Recycle Bin is empty',
  'trash.entriesAria': 'Recycle Bin entries',
  'trash.operationsAria': 'Recycle Bin actions for {path}',
  'trash.directory': 'Folder',
  'trash.file': 'File',
  'trash.hasChecksum': 'Checksum available',
  'trash.restoreToOriginal': 'Restore to original path',
  'trash.restoreToOriginalWithChecksum':
    'Restore to original path (checksum validation)',
  'trash.restoreAria': 'Restore {path}',
  'trash.restore': 'Restore',
  'trash.permanentlyDelete': 'Delete permanently (cannot be undone)',
  'trash.purgeAria': 'Permanently delete {path}',
  'trash.purge': 'Delete',
  'trash.count': '{count} items',
  'trash.recoverableCount': '{count} restorable items',
  'preview.quickAccess': 'Quick Access',
  'preview.runningService': 'Running local service: localhost:{port}',
  'preview.recentPages': 'Recent Pages',
  'preview.openRecent': 'Open recent page {host}',
};

export default workspace;
