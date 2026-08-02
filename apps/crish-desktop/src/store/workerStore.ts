/**
 * workerStore — worker 域（独立 zustand + immer 实例）。
 *
 * ## Scope（T11 拆分）
 *
 * Owns：
 * - `activeWorkers`（引擎遥测同步的活动 worker）
 * - `manuallyTriggeredWorkers`（triggerCronJobNow 手动触发）
 * - `killedWorkerIds`（已 kill 记录，遥测合并时过滤）
 *
 * 跨域：
 * - `settingsStore.syncTelemetryData` 经本 store 的 `applyTelemetryWorkers`
 *   单向落盘 worker 侧状态（settings → worker，无环）。
 * - `killWorker` 不再扣减 `tokenUsage`（该记账归 settings 域遥测权威值；
 *   拆分前为 demo 记账，见 R3-T11 归类表 §4）。
 *
 * @see docs/multi-agent-repair/reports/R3-T11-归类表.md
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { withDevtools } from './middleware/withDevtools';
import { withLogger } from './middleware/withLogger';
import { withPersist } from './middleware/withPersist';
import { MAX_DIFF_FILES, MAX_TERMINAL_SESSIONS } from '@crish/shared-utils/browser';
import { finiteNumber, sanitizeActiveWorkers } from './layout-helpers/store-initializers';
import type { ActiveWorkerState } from './layout-helpers/store-types';

export interface WorkerStore {
  activeWorkers: ActiveWorkerState[];
  killedWorkerIds: string[];
  manuallyTriggeredWorkers: ActiveWorkerState[];
  killWorker: (id: string, taskName?: string) => void;
  triggerCronJobNow: (prompt: string) => void;
  /** settingsStore.syncTelemetryData 跨域落盘入口：elapsed 递增 + 活 worker 合并（过滤 killed） */
  applyTelemetryWorkers: (data: { activeWorkers?: ActiveWorkerState[] }) => void;
}

export const useWorkerStore = create<WorkerStore>()(
  withDevtools(
    withLogger(
      withPersist(
        immer((set) => ({
          activeWorkers: [],
          killedWorkerIds: [],
          manuallyTriggeredWorkers: [],

          killWorker: (id: string, _taskName?: string) =>
            set((state) => {
              void _taskName;
              if (!id) return;
              state.manuallyTriggeredWorkers = state.manuallyTriggeredWorkers.filter(
                (w: ActiveWorkerState) => w.id !== id
              );
              state.activeWorkers = state.activeWorkers.filter(
                (w: ActiveWorkerState) => w.id !== id
              );
              if (
                !state.killedWorkerIds.includes(id) &&
                state.killedWorkerIds.length < MAX_TERMINAL_SESSIONS * 4
              ) {
                state.killedWorkerIds.push(id);
              }
            }),

          triggerCronJobNow: (prompt: string) =>
            set((state) => {
              const label =
                typeof prompt === 'string' && prompt.trim()
                  ? prompt.trim()
                  : 'task';
              const newWorker: ActiveWorkerState = {
                id: `worker-manual-${Date.now()}`,
                taskName: `Cron: ${label}`,
                elapsedSeconds: 0,
              };
              if (state.manuallyTriggeredWorkers.length < MAX_TERMINAL_SESSIONS)
                state.manuallyTriggeredWorkers.push(newWorker);
              if (state.activeWorkers.length < MAX_DIFF_FILES * 2)
                state.activeWorkers.push(newWorker);
            }),

          applyTelemetryWorkers: (data: { activeWorkers?: ActiveWorkerState[] }) =>
            set((state) => {
              state.manuallyTriggeredWorkers = state.manuallyTriggeredWorkers.map(
                (w: ActiveWorkerState) => ({
                  id: w.id,
                  taskName: w.taskName,
                  elapsedSeconds: Math.max(
                    0,
                    finiteNumber(w.elapsedSeconds, 0) + 2
                  ),
                })
              );
              if (data.activeWorkers) {
                const live = sanitizeActiveWorkers(data.activeWorkers).filter(
                  (w: ActiveWorkerState) =>
                    !state.killedWorkerIds.includes(w.id)
                );
                state.activeWorkers = [
                  ...live,
                  ...state.manuallyTriggeredWorkers,
                ];
              }
            }),
        })),
        {
          name: 'crish-workers-v1',
          partialize: (s) => ({
            killedWorkerIds: s.killedWorkerIds,
          }),
        }
      )
    ),
    'WorkerStore'
  )
);
