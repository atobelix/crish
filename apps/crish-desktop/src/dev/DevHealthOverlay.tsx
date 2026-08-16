/**
 * D2-3 dev-overlay lite：角落健康条，展示 controlMetrics 快照。
 * 非完整 dashboard；不碰用户视图投影调试。
 *
 * Enable: DEV build + localStorage `crish_dev_health=1`
 *   （或 `crish_show_engine_settings=1`，复用 developer engine UI 旗标）
 *
 * @see docs/plans/2026-07-system-architecture-control-master-plan.md Round D2
 */
import React, { useCallback, useEffect, useState } from 'react';
import { getSnapshot } from '../api/controlMetrics';
import {
  DEV_HEALTH_LS_KEY,
  SHOW_ENGINE_SETTINGS_KEY,
} from '../utils/storageKeys';
import {
  formatControlMetricsLines,
  type ControlMetricsSnapshot,
} from './devHealthFormat';
import styles from './DevHealthOverlay.module.css';

const REFRESH_MS = 1500;

export {
  formatControlMetricsLines,
  formatControlMetricsStrip,
  type ControlMetricsSnapshot,
  type DevHealthMetricCell,
} from './devHealthFormat';

function isDevBuild(): boolean {
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env?.DEV) {
      return true;
    }
  } catch {
    /* ignore */
  }
  return (
    typeof process !== 'undefined' && process.env.NODE_ENV === 'development'
  );
}

/**
 * 门控：仅 DEV，且需显式旗标（避免浏览器 host 默认刷屏）。
 * - `crish_dev_health=1`（专用）
 * - 或 `crish_show_engine_settings=1`（复用 developer engine UI）
 */
export function isDevHealthOverlayEnabled(): boolean {
  if (!isDevBuild()) return false;
  try {
    if (localStorage.getItem(DEV_HEALTH_LS_KEY) === '1') return true;
    if (localStorage.getItem(SHOW_ENGINE_SETTINGS_KEY) === '1') return true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * 固定角标健康条。门控关闭时立即 null，不设 interval、不订 store。
 */
export const DevHealthOverlay: React.FC = () => {
  // 启动时读一次旗标；改 localStorage 后需刷新页面
  const [enabled] = useState(() => isDevHealthOverlayEnabled());
  const [snap, setSnap] = useState<ControlMetricsSnapshot | null>(null);

  const refresh = useCallback(() => {
    setSnap(getSnapshot());
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const id = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [enabled, refresh]);

  if (!enabled || !snap) return null;

  const cells = formatControlMetricsLines(snap);

  return (
    <div
      className={styles.root}
      role="status"
      aria-live="polite"
      aria-label="Dev control metrics"
      data-testid="dev-health-overlay"
    >
      <span className={styles.label} title="controlMetrics snapshot (D2 lite)">
        ctrl
      </span>
      <div className={styles.strip}>
        {cells.map((c) => (
          <span
            key={c.id}
            className={c.warn ? styles.cellWarn : styles.cell}
            title={c.title}
          >
            {c.text}
          </span>
        ))}
      </div>
      <button
        type="button"
        className={styles.refresh}
        onClick={refresh}
        title="Refresh metrics now"
        aria-label="Refresh control metrics"
      >
        ↻
      </button>
    </div>
  );
};
