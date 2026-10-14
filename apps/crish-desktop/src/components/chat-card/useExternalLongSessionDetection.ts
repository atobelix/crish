import { useState, useEffect, useRef, useCallback } from 'react';
import {
  detectLatestExternalLongSession,
  type DetectedLongSessionResult,
} from '../../api/import/autoSyncExternalSessions';
import { importDetectedSessions } from '../../api/import/importSessions';
import {
  useSessionStore,
  useWorkspaceShellStore,
} from '../../store/storeAccess';
import { useToast } from '../../services/toast/ToastContext';

export interface UseExternalLongSessionDetectionOptions {
  emptyKind: string | null;
  activeSessionId: string | null;
}

export function useExternalLongSessionDetection({
  emptyKind,
  activeSessionId,
}: UseExternalLongSessionDetectionOptions) {
  const { showToast } = useToast();
  const [previewExternalSession, setPreviewExternalSession] =
    useState<DetectedLongSessionResult | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isDetecting, setIsDetecting] = useState(false);
  const hasCheckedRef = useRef(false);

  const isLandingOrEmpty =
    emptyKind === 'session-empty' || emptyKind === 'no-session';

  // 启动 / 处于空态时执行长对话智能探测
  useEffect(() => {
    if (!isLandingOrEmpty) {
      hasCheckedRef.current = false;
      return;
    }

    if (hasCheckedRef.current) return;
    hasCheckedRef.current = true;

    let cancelled = false;
    setIsDetecting(true);

    void detectLatestExternalLongSession()
      .then((result) => {
        if (!cancelled && result) {
          setPreviewExternalSession(result);
        }
      })
      .catch(() => {
        // 静默容错，不阻断主流程
      })
      .finally(() => {
        if (!cancelled) {
          setIsDetecting(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isLandingOrEmpty]);

  // 会话切换到非空新会话时自动清除预览
  useEffect(() => {
    if (activeSessionId && !isLandingOrEmpty) {
      setPreviewExternalSession(null);
    }
  }, [activeSessionId, isLandingOrEmpty]);

  // 一键导入并接续对话
  const handleImportAndContinue = useCallback(async () => {
    if (!previewExternalSession || isImporting) return;
    setIsImporting(true);

    try {
      const res = await importDetectedSessions([
        previewExternalSession.detected,
      ]);
      let targetId = res.sessionIds?.[0];
      if (!targetId) {
        const cleanSource =
          previewExternalSession.detected.source === 'claude-code'
            ? 'claude'
            : 'codex';
        const cleanId = (previewExternalSession.detected.id || '')
          .replace(/[^a-zA-Z0-9_-]/g, '')
          .slice(0, 32);
        const expectedId = `sess-import-${cleanSource}-${cleanId}`;
        if (useSessionStore.getState().sessionsById[expectedId]) {
          targetId = expectedId;
        }
      }

      if (targetId) {
        useWorkspaceShellStore.getState().openSession(targetId, {
          title: previewExternalSession.mapped.title,
          workspaceKey: previewExternalSession.mapped.folder || '对话',
        });
        setPreviewExternalSession(null);

        // 解锁并聚焦 Composer 输入框
        requestAnimationFrame(() => {
          const el = document.querySelector<HTMLElement>(
            'textarea.composer-textarea, textarea, [contenteditable="true"]'
          );
          el?.focus();
        });

        showToast('已成功导入并接续该对话，您可以直接在此继续提问！');
      } else {
        showToast('导入失败，请尝试在扩展面板手动导入');
      }
    } catch (err) {
      showToast('导入出错: ' + String(err));
    } finally {
      setIsImporting(false);
    }
  }, [previewExternalSession, isImporting, showToast]);

  const handleDismissPreview = useCallback(() => {
    setPreviewExternalSession(null);
  }, []);

  return {
    previewExternalSession,
    isImporting,
    isDetecting,
    handleImportAndContinue,
    handleDismissPreview,
  };
}
