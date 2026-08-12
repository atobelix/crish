/**
 * CONN-E3 · 产品 opt-in detect→report React 钩子
 *
 * 封装 `createMirrorDetectScheduler`：
 * - `enabled=false`（默认）→ 无 detect、无 timer
 * - `enabled=true` + `ipc` → start → detect → report 状态可达
 *
 * ## 诚实边界
 * - **≠ EL-03**；**≠ inotify 满关**；**≠** 默认双开 poll+OS
 * - 失败不写假 report；父级显式 `mirrorDriftReport` 可覆盖本 hook 产出
 *
 * 测：`conn_e3_*`（EmptyState）+ `mirrorDetectSchedule` 单测
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createMirrorDetectScheduler,
  type MirrorDetectScheduleConfig,
  type MirrorDetectScheduler,
} from '../../api/mirrorDetectSchedule';
import type { NoteMirrorIpc } from '../../api/noteMirrorIpc';
import type { MirrorDriftReportView } from './mirrorDriftUi';

export type UseMirrorDetectProductOptions = {
  /** 显式 opt-in；默认应传 false */
  enabled: boolean;
  docId: string;
  ipc?: NoteMirrorIpc | null;
  authorityRev?: number;
  /**
   * 轮询间隔；省略 / ≤0 → 仅 enable 时 detect 一次。
   * 产品路径默认一次即可，避免空态噪声。
   */
  intervalMs?: number;
};

export type UseMirrorDetectProductResult = {
  /** detect 成功报告；失败 / 未调度为 null */
  report: MirrorDriftReportView | null;
  lastError: { code: string; reason: string } | null;
  detecting: boolean;
  /** enabled && ipc（与 DOM data-mirror-detect-schedule 对齐语义） */
  scheduleActive: boolean;
  /** 手动再 detect 一次（仍受 enabled 门闩） */
  runDetect: () => Promise<void>;
};

/**
 * 产品 detect 调度 hook。默认 enabled=false 时零副作用。
 * 兼容 React StrictMode 双挂载：dispose 后可重建 scheduler。
 */
export function useMirrorDetectProduct(
  options: UseMirrorDetectProductOptions
): UseMirrorDetectProductResult {
  const { enabled, docId, ipc = null, authorityRev, intervalMs } = options;

  const scheduleActive = enabled === true && ipc != null;

  const [report, setReport] = useState<MirrorDriftReportView | null>(null);
  const [lastError, setLastError] = useState<{
    code: string;
    reason: string;
  } | null>(null);
  const [detecting, setDetecting] = useState(false);

  // 最新 config 供 scheduler 闭包读取（避免 start 后陈旧 docId）
  const configRef = useRef<MirrorDetectScheduleConfig>({
    enabled: false,
    docId: '',
    ipc: null,
  });
  configRef.current = {
    enabled,
    docId,
    ipc,
    authorityRev,
    intervalMs,
    onReport: (r) => {
      setReport(r);
      setLastError(null);
    },
    onError: (err) => {
      setLastError(err);
    },
  };

  const schedulerRef = useRef<MirrorDetectScheduler | null>(null);

  const ensureScheduler = useCallback((): MirrorDetectScheduler => {
    if (!schedulerRef.current) {
      schedulerRef.current = createMirrorDetectScheduler(
        () => configRef.current
      );
    }
    return schedulerRef.current;
  }, []);

  // 卸载 dispose；StrictMode 重挂时 ensureScheduler 会新建
  useEffect(() => {
    return () => {
      schedulerRef.current?.dispose();
      schedulerRef.current = null;
    };
  }, []);

  // enabled / ipc / docId / interval 变化 → 重启或停
  useEffect(() => {
    const s = ensureScheduler();
    if (!scheduleActive) {
      s.stop();
      return;
    }
    setDetecting(true);
    const first = s.start();
    if (first) {
      void first.finally(() => {
        setDetecting(false);
      });
    } else {
      setDetecting(false);
    }
    return () => {
      s.stop();
    };
  }, [scheduleActive, docId, ipc, authorityRev, intervalMs, ensureScheduler]);

  const runDetect = useCallback(async () => {
    if (!scheduleActive) return;
    setDetecting(true);
    try {
      await ensureScheduler().runOnce();
    } finally {
      setDetecting(false);
    }
  }, [scheduleActive, ensureScheduler]);

  return {
    report,
    lastError,
    detecting,
    scheduleActive,
    runDetect,
  };
}
