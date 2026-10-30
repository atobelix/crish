import { useCallback } from 'react';
import { toast } from '../../services/toast/ToastContext';
import { getCompositionRoot } from '../../app/compositionRoot';
import { useI18n } from '../../i18n';

export function useChatExportMarkdown(activeSessionId: string | null) {
  const { t } = useI18n();
  return useCallback(() => {
    const byId = getCompositionRoot().session.getState().sessionsById;
    const session = byId[activeSessionId ?? ''];
    if (!session) return;
    void (async () => {
      try {
        const { tryDownloadSessionMarkdown } =
          await import('../../api/sessionExport');
        const result = tryDownloadSessionMarkdown(session, new Date(), {
          sessionsById: byId,
        });
        if (result.ok === false) {
          toast.show(result.error || t('history.exportFailed'));
        }
      } catch {
        toast.show(t('history.exportFailed'));
      }
    })();
  }, [activeSessionId, t]);
}
