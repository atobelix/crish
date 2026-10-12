import { lazy, Suspense } from 'react';
import { AppErrorBoundary } from '../components/AppErrorBoundary';
import { TelemetryDialog } from '../components/overlay/TelemetryDialog';
import { openSettings } from '../api/storeAccess';
import { emitUiEvent } from '../api/uiEvents';
import { getActiveModelId, getActiveProfileId } from '../api/providerProfiles';
import type { SettingsTabType } from '../store/types';
import { useAnimatedPresence } from '../components/ui/Dialog/useAnimatedPresence';

/** 设置弹窗退场时长：与 Dialog 基座退场（--duration-exit 150ms）一致，动画播完才卸载 */
const SETTINGS_EXIT_MS = 150;

// Lazy loaded components
const FirstRunWizard = lazy(() =>
  import('../components/overlay/FirstRunWizard').then((m) => ({
    default: m.FirstRunWizard,
  }))
);
const SettingsPanel = lazy(() =>
  import('../components/settings/SettingsPanel')
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
        borderRadius: 'var(--radius-m)',
      }}
      aria-hidden="true"
    />
  );
}

export interface AppGlobalDialogsProps {
  showFirstRun: boolean;
  setShowFirstRun: (show: boolean) => void;
  showTelemetry: boolean;
  setShowTelemetry: (show: boolean) => void;
  showSettingsOverlay: boolean;
  setShowSettingsOverlay: (show: boolean) => void;
  activeWorkspaceId: string;
  settingsActiveTab?: SettingsTabType;
}

export function AppGlobalDialogs({
  showFirstRun,
  setShowFirstRun,
  showTelemetry,
  setShowTelemetry,
  showSettingsOverlay,
  setShowSettingsOverlay,
  activeWorkspaceId,
  settingsActiveTab,
}: AppGlobalDialogsProps) {
  // 设置弹窗挂载跟随动画状态而非开关本身：关闭时先以 isOpen=false 驱动 Dialog 退场，
  // 退场结束后再卸载（条件渲染直接卸载会让退场动画来不及播，只能硬切）
  const { isMounted: settingsMounted } = useAnimatedPresence({
    visible: showSettingsOverlay,
    exitDurationMs: SETTINGS_EXIT_MS,
  });
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

      {showTelemetry && (
        <TelemetryDialog onClose={() => setShowTelemetry(false)} />
      )}

      {/* 设置弹窗：role/aria-modal/层级/遮罩由 SettingsPanel 内的 ui/Dialog 基座提供 */}
      {settingsMounted && (
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
              isOpen={showSettingsOverlay}
              wsId={activeWorkspaceId}
              onClose={() => setShowSettingsOverlay(false)}
              initialTab={settingsActiveTab || 'profile'}
            />
          </Suspense>
        </AppErrorBoundary>
      )}
    </>
  );
}
