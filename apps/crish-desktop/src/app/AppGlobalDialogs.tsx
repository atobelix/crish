import { lazy, Suspense } from 'react';
import { AppErrorBoundary } from '../components/AppErrorBoundary';
import { AccountCenterDialog } from '../components/account/AccountCenterDialog';
import { openSettings } from '../store/storeAccess';
import { emitUiEvent } from '../api/uiEvents';
import type { SettingsTabType } from '../store/types';
import type { WizardStep } from '../components/firstRunWizardLib';
import { ContentState, useAnimatedPresence } from '@/components/ui';
import { useI18n } from '../i18n';

/** 设置弹窗退场时长：与 Dialog 基座退场（--duration-exit 150ms）一致，动画播完才卸载 */
const SETTINGS_EXIT_MS = 150;

// Lazy loaded components
const TelemetryDialog = lazy(() =>
  import('../components/overlay/TelemetryDialog').then((m) => ({
    default: m.TelemetryDialog,
  }))
);
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

/**
 * 懒加载兜底（N10 方案 A）：原实现挂 `skel-shimmer` 类名，但全仓无任何
 * CSS 定义——分片未到时渲染的是透明空盒（设置面板/首运向导/侧栏/工作区
 * 四处消费点同病）。现改走正典 ContentState 加载指示（内含 Spinner
 * delayed 防闪门），签名与调用点不动。
 */
export function SkeletonFallback({
  height,
  width,
}: {
  height?: number | string;
  width?: number | string;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        height: height || '100%',
        width: width || '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <ContentState kind="loading" title={t('common.loading', '正在加载')} />
    </div>
  );
}

export interface AppGlobalDialogsProps {
  showFirstRun: boolean;
  setShowFirstRun: (show: boolean) => void;
  firstRunInitialStep?: WizardStep;
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
  firstRunInitialStep,
  showTelemetry,
  setShowTelemetry,
  showSettingsOverlay,
  setShowSettingsOverlay,
  activeWorkspaceId,
  settingsActiveTab,
}: AppGlobalDialogsProps) {
  const { t } = useI18n();
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
              {...(firstRunInitialStep !== undefined
                ? { initialStep: firstRunInitialStep }
                : {})}
              onDone={async () => {
                setShowFirstRun(false);
                const { getActiveModelRef } =
                  await import('../api/modelsCatalogStore');
                const ref = getActiveModelRef();
                if (ref) {
                  emitUiEvent('model-changed', {
                    profileId: ref.providerId,
                    model: ref.modelId,
                  });
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
        <Suspense fallback={null}>
          <TelemetryDialog onClose={() => setShowTelemetry(false)} />
        </Suspense>
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
              /* 与 SkeletonFallback 同病同治：原两处 settings-suspense-skel
                 占位块同样全仓无 CSS 定义，渲染为空白；改走正典指示。 */
              <ContentState
                kind="loading"
                title={t('settings.loading', '正在加载设置')}
              />
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

      {/* 登录弹窗：应用级单实例挂载——主界面账户入口（未登录直登）与
          设置「账户」分区共用同一弹窗（loginOpen store 驱动，关闭态零渲染） */}
      <AccountCenterDialog />
    </>
  );
}
