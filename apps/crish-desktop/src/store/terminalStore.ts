/**
 * terminalStore — PTY 会话元数据与跨会话 Diff 产物缓冲区（独立 zustand + immer 实例）。
 *
 * 核心职责（DIM-07）：
 * 1. PTY 会话元数据（ptySessions：sessionKey → PtySessionMeta）；
 * 2. Diff 产物缓冲区（diffFiles / activeDiffSource）；
 * 3. 彻底清除伪行缓冲（terminalLines / terminalBySession 已剥离，AI 日志走只读检查器）。
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { withDevtools } from './middleware/withDevtools';
import { withLogger } from './middleware/withLogger';
import type { FileDiff } from './types';
import { upsertDiffFile } from './layout-helpers/diff-selectors';

export interface PtySessionMeta {
  ptyId: string;
  sessionKey: string;
  createdAt: number;
  status: 'active' | 'detached' | 'dead';
}

export interface TerminalStore {
  // ── PTY 会话注册表 ──
  ptySessions: Record<string, PtySessionMeta>;
  registerPtySession: (sessionKey: string, meta: PtySessionMeta) => void;
  removePtySession: (sessionKey: string) => void;
  pruneTerminalSessions: (validIds: Iterable<string>) => void;

  // ── diff buffers（跨会话工作产物）──
  activeDiffSource: FileDiff | null;
  diffFiles: FileDiff[];
  setActiveDiffSource: (diff: FileDiff | null) => void;
  setDiffFiles: (
    files: FileDiff[] | ((prev: FileDiff[]) => FileDiff[])
  ) => void;
  pushDiffFile: (diff: FileDiff) => void;
  removeDiffFile: (filePath: string) => void;
}

export const useTerminalStore = create<TerminalStore>()(
  withDevtools(
    withLogger(
      immer((set) => ({
        ptySessions: {},
        activeDiffSource: null,
        diffFiles: [],

        registerPtySession: (sessionKey: string, meta: PtySessionMeta) =>
          set((state) => {
            state.ptySessions[sessionKey] = meta;
          }),

        removePtySession: (sessionKey: string) =>
          set((state) => {
            delete state.ptySessions[sessionKey];
          }),

        pruneTerminalSessions: (validIds: Iterable<string>) =>
          set((state) => {
            const valid = new Set(validIds);
            for (const key of Object.keys(state.ptySessions)) {
              if (!valid.has(key)) {
                delete state.ptySessions[key];
              }
            }
          }),

        // ── diff 缓冲区 ──
        setActiveDiffSource: (diff: FileDiff | null) =>
          set((state) => {
            state.activeDiffSource = diff;
            if (diff) {
              upsertDiffFile(state.diffFiles, diff);
            }
          }),

        setDiffFiles: (
          files: FileDiff[] | ((prev: FileDiff[]) => FileDiff[])
        ) =>
          set((state) => {
            const next =
              typeof files === 'function'
                ? (files as (prev: FileDiff[]) => FileDiff[])(state.diffFiles)
                : files;
            state.diffFiles = Array.isArray(next) ? next : [];
            state.activeDiffSource = state.diffFiles[0] || null;
          }),

        pushDiffFile: (diff: FileDiff) =>
          set((state) => {
            upsertDiffFile(state.diffFiles, diff);
            state.activeDiffSource = diff;
          }),

        removeDiffFile: (filePath: string) =>
          set((state) => {
            const path = filePath || '';
            state.diffFiles = state.diffFiles.filter(
              (f: FileDiff) => f.filePath !== path
            );
            if (state.activeDiffSource?.filePath === path) {
              state.activeDiffSource = state.diffFiles[0] || null;
            }
          }),
      }))
    ),
    'TerminalStore'
  )
);
