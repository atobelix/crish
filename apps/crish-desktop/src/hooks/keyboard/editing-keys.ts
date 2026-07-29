import { useEffect } from 'react';
import { ShortcutService } from '../../services/ShortcutService';
import { branchSession } from '../../api/storeAccess';
import { getActiveProjectId } from '../../api/projectStore';
import { emitUiEvent } from '../../api/uiEvents';
import { getSessionById } from '../../store/sessionStore';
import { getCompositionRoot } from '../../app/compositionRoot';
import { formatBranchUndoToast } from '../useToastQueue';
import type { UseAppKeyboardOpts } from './keyboard-types';

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
          getCompositionRoot().shell.openNewDraftTab(
            getActiveProjectId() || undefined
          );
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
          const session = getCompositionRoot().session;
          const oldSessionId = session.getActiveSessionId();
          const activeSess = getSessionById(oldSessionId);
          if (activeSess) {
            const forkTitle = `${activeSess.title} - 双击ESC分叉`;
            branchSession(activeSess.id, forkTitle);
            handleShowToast?.(formatBranchUndoToast(activeSess.title));
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
