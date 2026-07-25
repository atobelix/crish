import { getSessionById } from '../sessionIndex';
import type { SessionActions, SessionImmerSet } from './types';

export function createSessionPatchActions(
  set: SessionImmerSet,
): Pick<SessionActions, 'setComposerDraft' | 'patchSession'> {
  return {

    setComposerDraft: (sessionId, draft) =>
      set((state) => {
        if (!sessionId) return;
        if (!state.composerDrafts) state.composerDrafts = {};
        if (state.composerDrafts[sessionId] === draft) return;
        if (!draft) delete state.composerDrafts[sessionId];
        else state.composerDrafts[sessionId] = draft;
      }),

    patchSession: (sessionId, patch) =>
      set((state) => {
        const sess = getSessionById(state, sessionId);
        if (!sess) return;
        if ('goalMode' in patch) {
          if (patch.goalMode === null || patch.goalMode === undefined) delete sess.goalMode;
          else sess.goalMode = patch.goalMode;
        }
      }),
  };
}
