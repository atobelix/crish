import { appendTerminalLine } from '../layoutHelpers';

export interface TerminalSlice {
  terminalLines: string[];
  terminalBySession: Record<string, string[]>;
  addTerminalLine: (line: string, sessionId?: string) => void;
  addTerminalLines: (lines: string[], sessionId?: string) => void;
  clearTerminalLines: (sessionId?: string) => void;
}

export type TerminalImmerSet<T extends TerminalSlice & { activeSessionId?: string } = TerminalSlice & { activeSessionId?: string }> = (
  recipe: (state: T) => void,
) => void;
export type TerminalGet<T extends TerminalSlice & { activeSessionId?: string } = TerminalSlice & { activeSessionId?: string }> = () => T;

export function createInitialTerminalState(): Pick<TerminalSlice, 'terminalLines' | 'terminalBySession'> {
  return { terminalLines: [], terminalBySession: {} };
}

export function createTerminalActions<T extends TerminalSlice & { activeSessionId?: string }>(
  set: TerminalImmerSet<T>,
  get: TerminalGet<T>,
): Pick<TerminalSlice, 'addTerminalLine' | 'addTerminalLines' | 'clearTerminalLines'> {
  return {
    addTerminalLine: (line, sessionId) =>
      set((state) => {
        const text = typeof line === 'string' ? line : String(line ?? '');
        const sid = sessionId || state.activeSessionId || '_global';
        if (!state.terminalBySession[sid]) state.terminalBySession[sid] = [];
        appendTerminalLine(state.terminalBySession[sid], text);
        if (!sessionId || sessionId === state.activeSessionId || !state.activeSessionId) {
          state.terminalLines = state.terminalBySession[sid];
        }
      }),

    addTerminalLines: (lines, sessionId) =>
      set((state) => {
        if (!Array.isArray(lines) || lines.length === 0) return;
        const sid = sessionId || state.activeSessionId || '_global';
        if (!state.terminalBySession[sid]) state.terminalBySession[sid] = [];
        const buf = state.terminalBySession[sid];
        for (const line of lines) {
          const text = typeof line === 'string' ? line : String(line ?? '');
          appendTerminalLine(buf, text);
        }
        if (!sessionId || sessionId === state.activeSessionId || !state.activeSessionId) {
          state.terminalLines = state.terminalBySession[sid];
        }
      }),

    clearTerminalLines: (sessionId) =>
      set((state) => {
        const sid = sessionId || state.activeSessionId || '_global';
        state.terminalBySession[sid] = [];
        if (!sessionId || sessionId === state.activeSessionId || !state.activeSessionId) {
          state.terminalLines = [];
        }
      }),
  };
}
