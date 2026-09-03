/**
 * draft-routing — 新对话草稿路由调度与项目确定性绑定模块群。
 */

export {
  draftFolderRegistry,
  useDraftFolder,
} from './draftFolderRegistry';

export {
  resolveMostActiveProjectFolder,
} from './draftProjectResolver';

export {
  navigateToNewDraft,
  type NewDraftOptions,
} from './draftLifecycle';
