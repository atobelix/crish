/**
 * terminalStore 鈥?浼氳瘽杈撳嚭缂撳啿鍩燂紙鐙珛 zustand + immer 瀹炰緥锛夈€? *
 * ## Scope锛圱11 鎷嗗垎锛? *
 * Owns锛堜細璇濆伐浣滀骇鐗╃紦鍐诧級锛? * - **terminal lines**锛歚terminalBySession`锛堟寜浼氳瘽闅旂锛? `terminalLines`锛堟椿鍔ㄤ細璇濋暅鍍忥級
 * - **diff buffers**锛歚diffFiles` / `activeDiffSource`
 *
 * diff 褰掑叆鏈煙鐨勭紭鐢憋細`layout-helpers/diff-selectors.ts` 鏈氨鍚屾ā鍧楁壙杞? * `appendTerminalLine` / `upsertDiffFile`锛汿11 鍥涗釜鏂板煙锛坱erminal/worker/
 * permission/settings锛変腑娌℃湁鐙珛 diff 鍩燂紝"浼氳瘽杈撳嚭/宸ヤ綔缂撳啿"璇箟涓€骞惰惤姝ゃ€? *
 * ## 娲诲姩浼氳瘽闀滃儚
 *
 * session 鍩燂紙layoutStore 鍒囩墖锛夊垏鎹㈡椿鍔ㄤ細璇濇椂璋冪敤 `setActiveTerminalSession`锛? * 鏈?store 鍐呴儴鎶?`terminalBySession[active]` 闀滃儚鍒?`terminalLines`锛屼繚鎸佹棫
 * `terminalLines` 灞曠ず璇箟涓嶅彉銆? *
 * @see store/README.md 搂 鐘舵€佸綊灞? * @see docs/multi-agent-repair/reports/R3-T11-褰掔被琛?md
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { withDevtools } from './middleware/withDevtools';
import { withLogger } from './middleware/withLogger';
import { isDemoMode } from '../api/appMode';
import type { FileDiff } from './types';
import { appendTerminalLine, upsertDiffFile } from './layout-helpers/diff-selectors';

export interface TerminalStore {
  // 鈹€鈹€ terminal buffers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  /** 褰撳墠婵€娲讳細璇濈殑缁堢琛岄暅鍍忥紙= terminalBySession[activeTerminalSessionId]锛?*/
  terminalLines: string[];
  /** 鎸変細璇濋殧绂荤殑缁堢缂撳啿锛圚2锛?*/
  terminalBySession: Record<string, string[]>;
  /** 褰撳墠婵€娲讳細璇?id锛坰ession 鍩熷垏鎹細璇濇椂鍚屾锛夛紱addTerminalLine 鏈紶 sessionId 鏃剁殑鍥炶惤 */
  activeTerminalSessionId: string | null;
  /** 浼氳瘽鍒囨崲鍏ュ彛锛氬垏鎹㈡椿鍔ㄩ暅鍍忥紙缂撳啿淇濈暀锛屼粎闀滃儚鍒囨崲锛?*/
  setActiveTerminalSession: (id: string | null) => void;
  addTerminalLine: (line: string, sessionId?: string) => void;
  addTerminalLines: (lines: string[], sessionId?: string) => void;
  clearTerminalLines: (sessionId?: string) => void;
  /** 鍒犻櫎浼氳瘽缂撳啿锛坉eleteSession 鏃惰皟鐢紱娲诲姩浼氳瘽鍒欐竻绌洪暅鍍忥級 */
  removeTerminalSession: (sessionId: string) => void;
  /** 娓呯悊宸蹭笉瀛樺湪浼氳瘽鐨勭紦鍐诧紙hydrate / prune 鍚庤皟鐢級 */
  pruneTerminalSessions: (validIds: Iterable<string>) => void;

  // 鈹€鈹€ diff buffers锛堣法浼氳瘽宸ヤ綔浜х墿锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  activeDiffSource: FileDiff | null;
  diffFiles: FileDiff[];
  setActiveDiffSource: (diff: FileDiff | null) => void;
  setDiffFiles: (
    files: FileDiff[] | ((prev: FileDiff[]) => FileDiff[])
  ) => void;
  pushDiffFile: (diff: FileDiff) => void;
  /** 浠庡彉鏇村垪琛ㄧЩ闄わ紙鎷掔粷 / 宸插簲鐢ㄥ悗娓呯悊锛?*/
  removeDiffFile: (filePath: string) => void;
}

const initialTerminalLines: string[] = isDemoMode()
  ? [
      'user@Windows-PC MINGW64 /c/workspace/crish',
      '$ npm run dev',
      '> zennav-server@1.0.0 dev',
      '> node server.js',
      '',
      '[ready] Server started on http://localhost:3000',
      '[ready] Database connection established.',
    ]
  : [];

export const useTerminalStore = create<TerminalStore>()(
  withDevtools(
    withLogger(
      immer((set) => ({
        terminalLines: initialTerminalLines,
        terminalBySession: {},
        activeTerminalSessionId: null,
        activeDiffSource: null,
        diffFiles: [],

        setActiveTerminalSession: (id: string | null) =>
          set((state) => {
            state.activeTerminalSessionId = id;
            state.terminalLines =
              id && state.terminalBySession[id]
                ? state.terminalBySession[id]
                : [];
          }),

        addTerminalLine: (line: string, sessionId?: string) =>
          set((state) => {
            const text = typeof line === 'string' ? line : String(line ?? '');
            const sid = sessionId || state.activeTerminalSessionId || '_global';
            if (!state.terminalBySession[sid]) {
              state.terminalBySession[sid] = [];
            }
            appendTerminalLine(state.terminalBySession[sid], text);
            if (
              !sessionId ||
              sessionId === state.activeTerminalSessionId ||
              !state.activeTerminalSessionId
            ) {
              state.terminalLines = state.terminalBySession[sid];
            }
          }),

        addTerminalLines: (lines: string[], sessionId?: string) =>
          set((state) => {
            if (!Array.isArray(lines) || lines.length === 0) return;
            const sid = sessionId || state.activeTerminalSessionId || '_global';
            if (!state.terminalBySession[sid]) {
              state.terminalBySession[sid] = [];
            }
            const buf = state.terminalBySession[sid];
            for (const line of lines) {
              const text = typeof line === 'string' ? line : String(line ?? '');
              appendTerminalLine(buf, text);
            }
            if (
              !sessionId ||
              sessionId === state.activeTerminalSessionId ||
              !state.activeTerminalSessionId
            ) {
              state.terminalLines = buf;
            }
          }),

        clearTerminalLines: (sessionId?: string) =>
          set((state) => {
            const sid = sessionId || state.activeTerminalSessionId || '_global';
            state.terminalBySession[sid] = [];
            if (
              !sessionId ||
              sessionId === state.activeTerminalSessionId ||
              !state.activeTerminalSessionId
            ) {
              state.terminalLines = [];
            }
          }),

        removeTerminalSession: (sessionId: string) =>
          set((state) => {
            if (!sessionId) return;
            delete state.terminalBySession[sessionId];
            if (state.activeTerminalSessionId === sessionId) {
              state.terminalLines = [];
            }
          }),

        pruneTerminalSessions: (validIds: Iterable<string>) =>
          set((state) => {
            const valid = new Set(validIds);
            for (const tid of Object.keys(state.terminalBySession)) {
              if (!valid.has(tid)) {
                delete state.terminalBySession[tid];
              }
            }
          }),

        // 鈹€鈹€ diff 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
        setActiveDiffSource: (diff: FileDiff | null) =>
          set((state) => {
            state.activeDiffSource = diff;
            if (diff) {
              upsertDiffFile(state.diffFiles, diff);
            }
          }),

        setDiffFiles: (files: FileDiff[] | ((prev: FileDiff[]) => FileDiff[])) =>
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
