export interface UseAppKeyboardOpts {
  showCheatsheet?: boolean;
  setShowCheatsheet: (v: boolean | ((prev: boolean) => boolean)) => void;
  showSettingsOverlay?: boolean;
  setShowSettingsOverlay: (v: boolean) => void;
  showFirstRun?: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  setShowTelemetry: (v: boolean) => void;
  handleShowToast?: (msg: string) => void;
}
