import { useEffect } from 'react';
import { ShortcutService } from '../../services/ShortcutService';
import {
  archiveSession,
  branchSession,
  enterDraftMode,
  getSessionStoreState,
  setActiveSessionId,
} from '../../api/storeAccess';
import { emitUiEvent } from '../../api/uiEvents';
import { getSessionById } from '../../store/sessionIndex';
import { formatBranchUndoToast } from '../useToastQueue';
import type { UseAppKeyboardOpts } from '../useAppKeyboard';

export function useKeyboardEditing(opts: UseAppKeyboardOpts): void {
  const { handleShowToast } = opts;

  useEffect(() => {
    const svc = ShortcutService.getInstance();

    const unsub = svc.onMatch(({ actionId, originalEvent: e }) => {
      const target = e.target as HTMLElement | null;
      const inEditable =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);

      if (inEditable) {
        return;
      }

      switch (actionId) {
        case 'new_session':
          e.preventDefault();
          enterDraftMode();
          return;
        case 'focus_composer':
          e.preventDefault();
          emitUiEvent('focus-composer');
          return;
        case 'stop_generation':
          e.preventDefault();
          emitUiEvent('stop-generation');
          return;
        case 'branch_session': {
          e.preventDefault();
          const oldSessionId = getSessionStoreState().activeSessionId;
          const activeSess = getSessionById(
            getSessionStoreState(),
            oldSessionId,
          );
          if (activeSess) {
            const forkTitle = `${activeSess.title} - 双击ESC分叉`;
            branchSession(activeSess.id, forkTitle);
            const newBranchId = getSessionStoreState().activeSessionId;
            handleShowToast(formatBranchUndoToast(activeSess.title), () => {
              if (newBranchId && newBranchId !== oldSessionId) {
                archiveSession(newBranchId);
              }
              if (oldSessionId) {
                setActiveSessionId(oldSessionId);
              }
            });
          }
          return;
        }
        default:
          break;
      }
    });

    return () => {
      unsub();
    };
  }, [handleShowToast]);
}
