import type { SessionActions, SessionStoreSlice, SessionImmerSet, SessionStoreGet } from './types';
import { createSessionCrudActions } from './session-crud';
import { createMessageActions } from './message-actions';
import { createToolActions } from './tool-actions';
import { createAgentActions } from './agent-actions';
import { createSessionOrderingActions } from './session-ordering';
import { createSessionPatchActions } from './session-patch';

export type { SessionActions, SessionStoreSlice };

export function createSessionActions<T extends SessionStoreSlice>(
  set: SessionImmerSet<T>,
  get: SessionStoreGet<T>,
): SessionActions {
  return {
    ...createSessionCrudActions(set, get),
    ...createMessageActions(set),
    ...createToolActions(set),
    ...createAgentActions(set),
    ...createSessionOrderingActions(set),
    ...createSessionPatchActions(set),
  };
}
