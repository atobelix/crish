import { lazy, Suspense } from 'react';
import { AppErrorBoundary } from '../components/AppErrorBoundary';
import { TelemetryDialog } from '../components/TelemetryDialog';
import { openSettings } from '../api/storeAccess';
import { emitUiEvent } from '../api/uiEvents';
import { getActiveModelId, getActiveProfileId } from '../api/providerProfiles';
import type { AppToast as Toast } from '../services/ToastBus';
import type { SettingsTabType } from '../store/types';

// Lazy loaded components
const ToastStack = lazy(() =>
  import('../components/ToastStack').then((m) => ({ default: m.ToastStack }))
);
const CheatsheetModal = lazy(() =>
  import('../components/CheatsheetModal').then((m) => ({
    default: m.CheatsheetModal,
  }))
);
const FirstRunWizard = lazy(() =>
  import('../components/FirstRunWizard').then((m) => ({
    default: m.FirstRunWizard,
  }))
);
const SettingsPanel = lazy(() =>
  import('../components/SettingsPanel')
    .then((m) => ({ default: m.SettingsPanel }))
    .catch((err) => {
      console.error('[crish] SettingsPanel lazy load failed', err);
      throw err;
    })
);

export function SkeletonFallback({
  height,
  width,
}: {
  height?: number | string;
  width?: number | string;
}) {
  return (
    <div
      className="skel-shimmer"
      style={{
        height: height || '100%',
        width: width || '100%',
        borderRadius: 6,
      }}
      aria-hidden="true"
    />
  );
}

export interface AppGlobalDialogsProps {
  showFirstRun: boolean;
  setShowFirstRun: (show: boolean) => void;
  toasts: Toast[];
  dismissToast: (id: string) => void;
  showTelemetry: boolean;
  setShowTelemetry: (show: boolean) => void;
  showCheatsheet: boolean;
  setShowCheatsheet: (show: boolean) => void;
  showSettingsOverlay: boolean;
  setShowSettingsOverlay: (show: boolean) => void;
  activeWorkspaceId: string;
  settingsActiveTab?: SettingsTabType;
  handleShowToast: (msg: string, undoAction?: () => void) => void;
}

export function AppGlobalDialogs({
  showFirstRun,
  setShowFirstRun,
  toasts,
  dismissToast,
  showTelemetry,
  setShowTelemetry,
  showCheatsheet,
  setShowCheatsheet,
  showSettingsOverlay,
  setShowSettingsOverlay,
  activeWorkspaceId,
  settingsActiveTab,
  handleShowToast,
}: AppGlobalDialogsProps) {
  return (
    <>
      {showFirstRun && (
        <AppErrorBoundary compact title="首次运行向导出错">
          <Suspense fallback={<SkeletonFallback height={400} />}>
            <FirstRunWizard
              onDone={() => {
                setShowFirstRun(false);
                const model = getActiveModelId();
                const profileId = getActiveProfileId();
                if (model && profileId) {
                  emitUiEvent('model-changed', { profileId, model });
                }
              }}
              onOpenSettings={() => {
                setShowFirstRun(false);
                openSettings('models');
              }}
            />
          </Suspense>
        </AppErrorBoundary>
      )}

      <div role="region" aria-label="通知" aria-live="polite">
        <AppErrorBoundary variant="minimal" title="通知出错">
          <Suspense fallback={null}>
            <ToastStack toasts={toasts} onDismiss={dismissToast} />
          </Suspense>
        </AppErrorBoundary>
      </div>

      {showTelemetry && (
        <TelemetryDialog onClose={() => setShowTelemetry(false)} />
      )}

      {showCheatsheet && (
        <AppErrorBoundary compact title="快捷键帮助出错">
          <Suspense fallback={<SkeletonFallback height={300} />}>
            <CheatsheetModal onClose={() => setShowCheatsheet(false)} />
          </Suspense>
        </AppErrorBoundary>
      )}

      {showSettingsOverlay && (
        <div
          className="settings-cover"
          role="dialog"
          aria-modal="true"
          aria-label="设置"
          style={{ zIndex: 'var(--z-settings-panel)' }}
        >
          <AppErrorBoundary
            title="设置加载失败"
            onReset={() => {
              setShowSettingsOverlay(false);
              window.requestAnimationFrame(() => {
                window.requestAnimationFrame(() => {
                  setShowSettingsOverlay(true);
                });
              });
            }}
          >
            <Suspense
              fallback={
                <div
                  className="settings-suspense-fallback"
                  aria-busy="true"
                  aria-label="正在加载设置"
                  role="status"
                >
                  <div
                    className="settings-suspense-skel settings-suspense-skel--nav"
                    aria-hidden="true"
                  />
                  <div
                    className="settings-suspense-skel settings-suspense-skel--main"
                    aria-hidden="true"
                  />
                </div>
              }
            >
              <SettingsPanel
                wsId={activeWorkspaceId}
                onShowToast={handleShowToast}
                onClose={() => setShowSettingsOverlay(false)}
                initialTab={settingsActiveTab || 'profile'}
              />
            </Suspense>
          </AppErrorBoundary>
        </div>
      )}
    </>
  );
}
