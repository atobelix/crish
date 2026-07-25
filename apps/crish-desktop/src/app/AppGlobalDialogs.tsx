import { Suspense, lazy, useState } from 'react';
import { AppErrorBoundary } from '../components/AppErrorBoundary';
import { TelemetryDialog } from '../components/TelemetryDialog';
import { telemetry } from '../services/TelemetryService';
import { getActiveModelId, getActiveProfileId } from '../api/providerProfiles';
import { emitUiEvent } from '../api/uiEvents';
import { openSettings } from '../api/storeAccess';
import type { SettingsTabType } from '../store/types';

const CheatsheetModal = lazy(() => import('../components/CheatsheetModal').then((m) => ({ default: m.CheatsheetModal })));
const FirstRunWizard = lazy(() => import('../components/FirstRunWizard').then((m) => ({ default: m.FirstRunWizard })));
const SettingsPanel = lazy(() => import('../components/SettingsPanel').then((m) => ({ default: m.SettingsPanel })).catch((err) => { console.error('[crish] SettingsPanel lazy load failed', err); throw err; }));

/**
 * 默认设置 tab：与 SettingsPanel 内部回落值保持一致。
 * 抽到常量避免散落硬编码字符串导致漂移。
 */
const DEFAULT_SETTINGS_TAB: SettingsTabType = 'profile';

/**
 * SettingsPanel 重挂载计数器：用于「重置出错状态」时强制卸载/重新挂载子树，
 * 取代过去 `setShowSettingsOverlay(false) → rAF×2 → setShowSettingsOverlay(true)` 的 hack。
 * - 出错时 AppErrorBoundary 调用 onReset → 计数器 +1 → SettingsPanel `key` 变化 → React 卸载旧实例并重新挂载
 * - 正常切换不会触发，避免无谓卸载
 */
type SettingsPanelRemountKey = number;

function SkeletonFallback({ height, width }: { height?: number | string; width?: number | string }) {
  return <div className="skel-shimmer" style={{ height: height || '100%', width: width || '100%', borderRadius: 6 }} aria-hidden="true" />;
}

interface AppGlobalDialogsProps {
  showFirstRun: boolean;
  showCrashPrompt: boolean;
  showTelemetry: boolean;
  showCheatsheet: boolean;
  showSettingsOverlay: boolean;
  engineReady: boolean;
  activeWorkspaceId: string;
  settingsActiveTab?: SettingsTabType;
  /**
   * 通知父级展示 toast。onUndo 可选：父级不提供撤销能力时省略即可。
   * 与 SettingsPanel.onShowToast 签名对齐，避免本组件被迫 `?? (() => {})` 兜底。
   */
  handleShowToast: (msg: string, onUndo?: () => void) => void;
  setShowFirstRun: (v: boolean) => void;
  setShowCrashPrompt: (v: boolean) => void;
  setShowTelemetry: (v: boolean | ((prev: boolean) => boolean)) => void;
  setShowCheatsheet: (v: boolean) => void;
  setShowSettingsOverlay: (v: boolean) => void;
}

export function AppGlobalDialogs({
  showFirstRun,
  showCrashPrompt,
  showTelemetry,
  showCheatsheet,
  showSettingsOverlay,
  engineReady,
  activeWorkspaceId,
  settingsActiveTab,
  handleShowToast,
  setShowFirstRun,
  setShowCrashPrompt,
  setShowTelemetry,
  setShowCheatsheet,
  setShowSettingsOverlay,
}: AppGlobalDialogsProps) {
  /**
   * SettingsPanel 重挂载 key：仅当 AppErrorBoundary 触发 onReset 时自增，
   * React 检测到 key 变化会卸载旧子树并重新挂载，替代双 rAF 切换 overlay 的 hack。
   */
  const [settingsRemountKey, setSettingsRemountKey] = useState<SettingsPanelRemountKey>(0);

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
              onOpenSettings={() => { setShowFirstRun(false); openSettings('models'); }}
            />
          </Suspense>
        </AppErrorBoundary>
      )}

      {showCrashPrompt && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.4)' }} role="presentation" onClick={() => setShowCrashPrompt(false)}>
          <div style={{ background: 'var(--bg-surface, #1e1e2e)', borderRadius: 12, padding: 24, maxWidth: 420, boxShadow: '0 8px 32px rgba(0,0,0,0.4)', color: 'var(--fg-default, #e0e0e0)', fontFamily: 'system-ui, sans-serif' }} role="alertdialog" aria-label="异常退出检测" onClick={(e) => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 12px 0', fontSize: 18, fontWeight: 600 }}>检测到上次异常退出</h3>
            <p style={{ margin: '0 0 20px 0', fontSize: 14, lineHeight: 1.5, color: 'var(--fg-muted, #999)' }}>是否导出诊断日志以帮助排查问题？</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" style={{ padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 14, background: 'var(--bg-muted, rgba(255,255,255,0.08))', color: 'var(--fg-default, #e0e0e0)' }} onClick={() => { setShowCrashPrompt(false); telemetry.clear(); }}>忽略</button>
              <button type="button" style={{ padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 500, background: 'var(--accent-color, #4a9eff)', color: '#fff' }} onClick={() => { telemetry.downloadLog(); setShowCrashPrompt(false); }}>导出诊断日志</button>
            </div>
          </div>
        </div>
      )}

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
        <div className="settings-cover" role="dialog" aria-modal="true" aria-label="设置" style={{ zIndex: 'var(--z-settings-panel)' }}>
          <AppErrorBoundary
            title="设置加载失败"
            onReset={() => {
              // 触发 SettingsPanel 真正卸载并重新挂载，取代过去双 rAF 切 overlay 的 hack。
              // key 变化后 React 会丢弃旧子树（包括其内部 state / lazy 已加载模块缓存），
              // 配合 Suspense 重新展示 fallback，行为上等价于「关闭后立即再开」。
              setSettingsRemountKey((k) => k + 1);
            }}
          >
            <Suspense fallback={<div className="settings-suspense-fallback" aria-busy="true" aria-label="正在加载设置" role="status"><div className="settings-suspense-skel settings-suspense-skel--nav" aria-hidden="true" /><div className="settings-suspense-skel settings-suspense-skel--main" aria-hidden="true" /></div>}>
              <SettingsPanel
                key={settingsRemountKey}
                wsId={activeWorkspaceId}
                onShowToast={handleShowToast}
                onClose={() => setShowSettingsOverlay(false)}
                initialTab={settingsActiveTab ?? DEFAULT_SETTINGS_TAB}
              />
            </Suspense>
          </AppErrorBoundary>
        </div>
      )}
    </>
  );
}
