/**
 * 集中化 localStorage 访问
 *
 * 所有 localStorage 的读写操作必须通过此模块，
 * 确保 key 命名一致、序列化/反序列化统一、异常安全。
 */

// ==================== Storage Keys ====================

const KEYS = {
  THEME: 'conex:theme',
  SYSTEM_PROMPT: 'conex:systemPrompt',
  INPUT_DRAFT_PREFIX: 'conex:input-draft:',
  EVENT_CURSORS: 'conex-event-cursors',
  LEFT_LAYOUT: 'conex:left-layout',
  LEFT_TAB: 'conex:left-tab',
  LEFT_SPLIT_RATIO: 'conex:left-split-ratio',
  PROJECT_ORDER: 'conex:project-order',
  SESSION_ORDER: 'conex:session-order',
  PINNED_PROJECTS: 'conex:pinned-projects',
  WORKSPACES: 'conex:workspaces',
  RIGHT_LAYOUT: 'conex:right-layout',
  PROVIDER_MODE: 'conex:provider-mode',
} as const;

// ==================== Helpers ====================

function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage 不可用时静默失败
  }
}

function safeRemoveItem(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // noop
  }
}

function safeParseJSON<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ==================== Public API ====================

export const storage = {
  // --- Theme ---
  getTheme(): string | null {
    return safeGetItem(KEYS.THEME);
  },
  setTheme(theme: string): void {
    safeSetItem(KEYS.THEME, theme);
  },

  // --- System Prompt ---
  getSystemPrompt(): string {
    return safeGetItem(KEYS.SYSTEM_PROMPT) ?? '';
  },
  setSystemPrompt(prompt: string): void {
    if (prompt) safeSetItem(KEYS.SYSTEM_PROMPT, prompt);
    else safeRemoveItem(KEYS.SYSTEM_PROMPT);
  },

  // --- Input Draft ---
  getInputDraft(sessionId?: string): string {
    if (!sessionId) return '';
    return safeGetItem(KEYS.INPUT_DRAFT_PREFIX + sessionId) ?? '';
  },
  setInputDraft(sessionId: string | undefined, value: string): void {
    if (!sessionId) return;
    const key = KEYS.INPUT_DRAFT_PREFIX + sessionId;
    if (value) safeSetItem(key, value);
    else safeRemoveItem(key);
  },

  // --- Event Cursors ---
  getEventCursors<T>(fallback: T): T {
    return safeParseJSON<T>(safeGetItem(KEYS.EVENT_CURSORS), fallback);
  },
  setEventCursors<T>(cursors: T): void {
    safeSetItem(KEYS.EVENT_CURSORS, JSON.stringify(cursors));
  },
  removeEventCursors(): void {
    safeRemoveItem(KEYS.EVENT_CURSORS);
  },

  // --- Left Layout ---
  getLeftLayout(): string {
    return safeGetItem(KEYS.LEFT_LAYOUT) ?? 'split';
  },
  setLeftLayout(layout: string): void {
    safeSetItem(KEYS.LEFT_LAYOUT, layout);
  },

  getLeftTab(): string {
    return safeGetItem(KEYS.LEFT_TAB) ?? 'chat';
  },
  setLeftTab(tab: string): void {
    safeSetItem(KEYS.LEFT_TAB, tab);
  },

  getLeftSplitRatio(): number {
    const n = Number(safeGetItem(KEYS.LEFT_SPLIT_RATIO));
    return Number.isFinite(n) && n > 0 ? n : 50;
  },
  setLeftSplitRatio(ratio: number): void {
    safeSetItem(KEYS.LEFT_SPLIT_RATIO, String(Math.round(ratio)));
  },

  // --- Project Order (drag-sort) ---
  getProjectOrder(): string[] {
    return safeParseJSON<string[]>(safeGetItem(KEYS.PROJECT_ORDER), []);
  },
  setProjectOrder(order: string[]): void {
    safeSetItem(KEYS.PROJECT_ORDER, JSON.stringify(order));
  },

  // --- Session Order ---
  getSessionOrder(): Record<string, number> {
    return safeParseJSON<Record<string, number>>(safeGetItem(KEYS.SESSION_ORDER), {});
  },
  setSessionOrder(order: Record<string, number>): void {
    safeSetItem(KEYS.SESSION_ORDER, JSON.stringify(order));
  },

  // --- Pinned Projects ---
  getPinnedProjects(): string[] {
    return safeParseJSON<string[]>(safeGetItem(KEYS.PINNED_PROJECTS), []);
  },
  setPinnedProjects(projects: string[]): void {
    safeSetItem(KEYS.PINNED_PROJECTS, JSON.stringify(projects));
  },

  // --- Workspaces ---
  getWorkspaces<T>(fallback: T): T {
    return safeParseJSON<T>(safeGetItem(KEYS.WORKSPACES), fallback);
  },
  setWorkspaces<T>(workspaces: T): void {
    safeSetItem(KEYS.WORKSPACES, JSON.stringify(workspaces));
  },

  // --- Right Layout ---
  getRightLayout<T>(fallback: T): T {
    return safeParseJSON<T>(safeGetItem(KEYS.RIGHT_LAYOUT), fallback);
  },
  setRightLayout<T>(layout: T): void {
    safeSetItem(KEYS.RIGHT_LAYOUT, JSON.stringify(layout));
  },

  // --- Provider Mode ---
  getProviderMode(): string | null {
    return safeGetItem(KEYS.PROVIDER_MODE);
  },
  setProviderMode(mode: string): void {
    safeSetItem(KEYS.PROVIDER_MODE, mode);
  },

  // --- Clear All ---
  clear(): void {
    try {
      localStorage.clear();
    } catch {
      // noop
    }
  },
};