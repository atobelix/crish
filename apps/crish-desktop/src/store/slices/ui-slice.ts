import { collapseToolColumnToTabs } from '../layoutHelpers';
import { DEFAULT_SHELL_CHROME, parseShellChromeMode, SHELL_CHROME_STORAGE_KEY, type ShellChromeMode } from '../../api/shellChrome';
import type { SettingsTabType } from '../types';

export type UiSize = 'small' | 'medium' | 'large';
export const UI_SIZE_IDS = ['small', 'medium', 'large'] as const satisfies readonly UiSize[];
export const DEFAULT_UI_SIZE: UiSize = 'medium';
export const UI_SIZE_STORAGE_KEY = 'crish_ui_size';
export const TAB_MODE_STORAGE_KEY = 'crish_tab_mode';

export const SETTINGS_TAB_IDS = [
  'profile', 'appearance', 'personalize', 'models', 'usage',
  'schedule', 'rules', 'shortcuts', 'skills', 'mcp', 'plugins', 'security',
] as const satisfies readonly SettingsTabType[];

export const DEFAULT_SETTINGS_TAB: SettingsTabType = 'profile';

export type { ShellChromeMode } from '../../api/shellChrome';
export { DEFAULT_SHELL_CHROME, SHELL_CHROME_IDS, SHELL_CHROME_STORAGE_KEY, parseShellChromeMode } from '../../api/shellChrome';

export interface UISlice {
  uiSize: UiSize;
  shellChromeMode: ShellChromeMode;
  chatMainSurface: 'chat' | 'scheduled';
  sidebarCollapsed: boolean;
  tabModeEnabled: boolean;
  showSettingsOverlay: boolean;
  settingsActiveTab: SettingsTabType;
  workspaces: WorkspaceState[];
  activeWorkspaceIndex: number;
  setUiSize: (size: UiSize) => void;
  setShellChromeMode: (mode: ShellChromeMode) => void;
  setChatMainSurface: (surface: 'chat' | 'scheduled') => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setTabModeEnabled: (enabled: boolean) => void;
  setShowSettingsOverlay: (show: boolean) => void;
  setSettingsActiveTab: (tab: SettingsTabType) => void;
  openSettings: (tab?: SettingsTabType) => void;
}

import type { WorkspaceState } from '../types';

function readStoredShellChromeMode(): ShellChromeMode {
  try { return parseShellChromeMode(localStorage.getItem(SHELL_CHROME_STORAGE_KEY)); } catch { return DEFAULT_SHELL_CHROME; }
}

export function parseUiSize(raw: unknown): UiSize {
  if (raw === 'small' || raw === 'medium' || raw === 'large') return raw;
  return DEFAULT_UI_SIZE;
}

const SETTINGS_TAB_SET: ReadonlySet<string> = new Set(SETTINGS_TAB_IDS);

export function isSettingsTabType(v: unknown): v is SettingsTabType {
  return typeof v === 'string' && SETTINGS_TAB_SET.has(v);
}

export function parseSettingsTab(raw: unknown, fallback: SettingsTabType = DEFAULT_SETTINGS_TAB): SettingsTabType {
  return isSettingsTabType(raw) ? raw : fallback;
}

function readStoredUiSize(): UiSize {
  try { return parseUiSize(localStorage.getItem(UI_SIZE_STORAGE_KEY)); } catch { return DEFAULT_UI_SIZE; }
}

function readStoredTabModeEnabled(): boolean {
  try {
    const raw = localStorage.getItem(TAB_MODE_STORAGE_KEY);
    if (raw == null || raw === '') return true;
    if (raw === '0' || raw === 'false') return false;
    if (raw === '1' || raw === 'true') return true;
    return true;
  } catch { return true; }
}

export type UiImmerSet = (recipe: (state: UISlice) => void) => void;
export type UiGet = () => UISlice;

export function createInitialUiState(initialWorkspaces: WorkspaceState[]): Pick<UISlice, 'uiSize' | 'shellChromeMode' | 'chatMainSurface' | 'sidebarCollapsed' | 'tabModeEnabled' | 'showSettingsOverlay' | 'settingsActiveTab' | 'workspaces' | 'activeWorkspaceIndex'> {
  return {
    workspaces: initialWorkspaces,
    activeWorkspaceIndex: clampActiveWorkspaceIndex(initialWorkspaces, 0),
    tabModeEnabled: readStoredTabModeEnabled(),
    uiSize: readStoredUiSize(),
    shellChromeMode: readStoredShellChromeMode(),
    chatMainSurface: 'chat',
    sidebarCollapsed: false,
    showSettingsOverlay: false,
    settingsActiveTab: DEFAULT_SETTINGS_TAB,
  };
}

export function clampActiveWorkspaceIndex(workspaces: readonly WorkspaceState[], index: number): number {
  if (workspaces.length === 0) return 0;
  const i = finiteNumber(index, 0);
  return Math.min(Math.max(0, Math.trunc(i)), workspaces.length - 1);
}

export function finiteNumber(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

export function createUiActions(set: UiImmerSet, get: UiGet): Pick<UISlice, 'setUiSize' | 'setShellChromeMode' | 'setChatMainSurface' | 'setSidebarCollapsed' | 'setTabModeEnabled' | 'setShowSettingsOverlay' | 'setSettingsActiveTab' | 'openSettings'> {
  return {
    setUiSize: (size) => {
      const next = parseUiSize(size);
      set((state) => { state.uiSize = next; });
      try { localStorage.setItem(UI_SIZE_STORAGE_KEY, next); } catch { /* ignore */ }
    },
    setShellChromeMode: (mode) => {
      const next = parseShellChromeMode(mode);
      set((state) => { state.shellChromeMode = next; });
      try { localStorage.setItem(SHELL_CHROME_STORAGE_KEY, next); } catch { /* ignore */ }
    },
    setChatMainSurface: (surface) => set((state) => { state.chatMainSurface = surface === 'scheduled' ? 'scheduled' : 'chat'; }),
    setSidebarCollapsed: (collapsed) => set((state) => { state.sidebarCollapsed = !!collapsed; }),
    setTabModeEnabled: (enabled) => {
      const on = !!enabled;
      set((state) => {
        state.tabModeEnabled = on;
        if (on) { for (const ws of state.workspaces) collapseToolColumnToTabs(ws); }
      });
      try { localStorage.setItem(TAB_MODE_STORAGE_KEY, on ? '1' : '0'); } catch { /* ignore */ }
    },
    setShowSettingsOverlay: (show) => set((state) => { state.showSettingsOverlay = !!show; }),
    setSettingsActiveTab: (tab) => set((state) => { if (isSettingsTabType(tab)) state.settingsActiveTab = tab; }),
    openSettings: (tab) => set((state) => {
      if (tab !== undefined) state.settingsActiveTab = parseSettingsTab(tab, state.settingsActiveTab);
      state.showSettingsOverlay = true;
    }),
  };
}
