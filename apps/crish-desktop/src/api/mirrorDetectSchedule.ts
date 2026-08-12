/**
 * CONN-E3 · 产品 detect→report 调度（opt-in）
 *
 * ## 职责
 * - 在 **显式 enable** 后调用 `NoteMirrorIpc.detectMirrorDrift`
 * - 成功 → `detectSuccessToReportView` 产出可喂 StatusBar 的 report
 * - 默认 **不** 启动任何 detect / 定时器（E2 默认关会计可维持）
 *
 * ## 调用序（可点名）
 * ```
 * enableMirrorDetectSchedule + mirrorIpc
 *   → createMirrorDetectScheduler.start / runMirrorDetectOnce
 *   → ipc.detectMirrorDrift({ docId })  // wire: note_detect_mirror_drift
 *   → detectSuccessToReportView
 *   → 注入 mirrorDriftReport → MirrorDriftStatusBar
 * ```
 *
 * ## 诚实边界
 * - **≠ EL-03**；**≠ inotify 产品满关**
 * - **≠** 默认 poll+OS 双开 debounce（本调度仅产品 opt-in poll/一次 detect）
 * - 无 enable / 无 ipc → 零 detect 调用、零 timer
 * - 失败不造假 report
 */

import {
  detectSuccessToReportView,
  type NoteDetectMirrorOutcome,
  type NoteDetectMirrorRequest,
  type NoteMirrorIpc,
} from './noteMirrorIpc';
import type { MirrorDriftReportView } from '../components/note-paper/mirrorDriftUi';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type MirrorDetectRunResult = {
  outcome: NoteDetectMirrorOutcome;
  /** 仅 outcome.ok 时有值；失败为 null（不造假） */
  report: MirrorDriftReportView | null;
};

export type MirrorDetectScheduleConfig = {
  /** 显式 opt-in；false → 不 detect、不启 timer */
  enabled: boolean;
  docId: string;
  ipc: NoteMirrorIpc | null | undefined;
  authorityRev?: number;
  /**
   * 轮询间隔 ms。
   * - 省略 / ≤0：enable 时 **仅 detect 一次**（无 setInterval）
   * - >0：立即一次 + interval
   * 产品默认应省略（避免噪声）；本字段仅宿主显式轮询时用。
   */
  intervalMs?: number;
  onReport?: (report: MirrorDriftReportView) => void;
  onError?: (err: { code: string; reason: string }) => void;
};

export type MirrorDetectScheduler = {
  /** enabled && 有 ipc 且未 dispose */
  isActive: () => boolean;
  /** 当前是否挂着 interval timer（一次-only 为 false） */
  hasIntervalTimer: () => boolean;
  runOnce: () => Promise<MirrorDetectRunResult>;
  /**
   * 按 config 启停：enabled 则立即 detect 一次；
   * intervalMs>0 时装 timer。返回首次 detect 的 Promise（未 enable 则 null）。
   */
  start: () => Promise<MirrorDetectRunResult> | null;
  stop: () => void;
  dispose: () => void;
};

// ---------------------------------------------------------------------------
// 单次 detect
// ---------------------------------------------------------------------------

/**
 * 调用 detect IPC 并映射 report。
 * 不检查 enable——调用方（scheduler / 测）负责 opt-in 门闩。
 */
export async function runMirrorDetectOnce(
  ipc: NoteMirrorIpc,
  req: NoteDetectMirrorRequest
): Promise<MirrorDetectRunResult> {
  const outcome = await ipc.detectMirrorDrift(req);
  if (outcome.ok) {
    return {
      outcome,
      report: detectSuccessToReportView(outcome),
    };
  }
  return { outcome, report: null };
}

// ---------------------------------------------------------------------------
// Scheduler（可测 timer 生命周期）
// ---------------------------------------------------------------------------

/**
 * 创建 detect 调度器。`getConfig` 每次 start/run 时读取，便于宿主改 docId/ipc。
 *
 * **默认不 start**——须宿主在 opt-in 后显式 `start()`。
 */
export function createMirrorDetectScheduler(
  getConfig: () => MirrorDetectScheduleConfig
): MirrorDetectScheduler {
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  /** 防止重叠 detect */
  let inFlight: Promise<MirrorDetectRunResult> | null = null;

  const stop = () => {
    if (timer != null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const isActive = () => {
    if (disposed) return false;
    const cfg = getConfig();
    return cfg.enabled === true && cfg.ipc != null;
  };

  const runOnce = async (): Promise<MirrorDetectRunResult> => {
    if (disposed) {
      return {
        outcome: {
          ok: false,
          code: 'note.schedule_disposed',
          reason: 'detect 调度器已 dispose',
        },
        report: null,
      };
    }
    const cfg = getConfig();
    if (cfg.enabled !== true || !cfg.ipc) {
      return {
        outcome: {
          ok: false,
          code: 'note.schedule_inactive',
          reason: 'detect 调度未 enable 或无 mirrorIpc',
        },
        report: null,
      };
    }
    const docId = cfg.docId?.trim() ?? '';
    if (!docId) {
      const err = {
        ok: false as const,
        code: 'note.invalid',
        reason: 'doc_id must be non-empty',
      };
      cfg.onError?.(err);
      return { outcome: err, report: null };
    }

    if (inFlight) return inFlight;

    const ipc = cfg.ipc;
    const req: NoteDetectMirrorRequest = {
      docId,
      ...(cfg.authorityRev !== undefined
        ? { authorityRev: cfg.authorityRev }
        : {}),
    };

    inFlight = (async () => {
      try {
        const result = await runMirrorDetectOnce(ipc, req);
        if (result.report) {
          cfg.onReport?.(result.report);
        } else if (!result.outcome.ok) {
          cfg.onError?.({
            code: result.outcome.code,
            reason: result.outcome.reason,
          });
        }
        return result;
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  };

  const start = (): Promise<MirrorDetectRunResult> | null => {
    stop();
    if (disposed) return null;
    const cfg = getConfig();
    if (cfg.enabled !== true || !cfg.ipc) return null;

    const first = runOnce();

    const ms = cfg.intervalMs ?? 0;
    if (typeof ms === 'number' && ms > 0) {
      timer = setInterval(() => {
        void runOnce();
      }, ms);
    }

    return first;
  };

  return {
    isActive,
    hasIntervalTimer: () => timer != null,
    runOnce,
    start,
    stop,
    dispose: () => {
      disposed = true;
      stop();
    },
  };
}
