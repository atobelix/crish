/**
 * DEV-only MCP app bridge helpers.
 * 让 tauri-plugin-mcp 的 app_bridge 直接驱动 shell/session，不依赖合成 click 路径。
 *
 * Imperative store access goes through getCompositionRoot() (B3 / OPT-H5).
 * Safe: compositionRoot does not import dev/* — no cycle.
 */
import { getCompositionRoot } from '../app/compositionRoot';
import { currentWorkspaceFolderKey } from '../api/workspaceChromeTabs';
import { getActiveProjectId } from '../api/projectStore';
import { selectActiveTabSessionId } from '../store/workspace-shell';

type McpBridge = {
  register: (
    name: string,
    fn: (...args: unknown[]) => unknown,
    description?: string
  ) => void;
};

function getBridge(): McpBridge | null {
  if (typeof window === 'undefined') return null;
  const w = window as Window & { __MCP_BRIDGE__?: McpBridge };
  return w.__MCP_BRIDGE__ ?? null;
}

export function registerCrishMcpBridge(): void {
  if (!import.meta.env.DEV) return;

  const tryRegister = () => {
    const bridge = getBridge();
    if (!bridge?.register) return false;

    bridge.register(
      'open_session',
      (sessionId: unknown, title?: unknown) => {
        const id = String(sessionId ?? '').trim();
        if (!id) return { ok: false, error: 'sessionId required' };
        const root = getCompositionRoot();
        const target = root.session.getState().sessionsById[id];
        root.session.openOrFocusSession(id, {
          title:
            typeof title === 'string' && title.trim()
              ? title.trim()
              : target?.title,
          workspaceKey:
            target?.folder ||
            currentWorkspaceFolderKey(getActiveProjectId()),
        });
        return {
          ok: true,
          sessionId: id,
          activeTabSessionId: selectActiveTabSessionId(root.shell.getState()),
        };
      },
      'Open or focus a session by id in the workspace shell (sidebar click equivalent).'
    );

    bridge.register(
      'open_new_draft',
      () => {
        const root = getCompositionRoot();
        root.shell.openNewDraftTab(getActiveProjectId() || undefined);
        return {
          ok: true,
          activeTabSessionId: selectActiveTabSessionId(root.shell.getState()),
        };
      },
      'Open or focus a new draft conversation tab.'
    );

    bridge.register(
      'shell_snapshot',
      () => {
        const root = getCompositionRoot();
        const shell = root.shell.getState();
        const sessions = root.session.getState();
        return {
          shellReady: shell.shellReady,
          activeTabId: shell.activeTabId,
          activeTabSessionId: selectActiveTabSessionId(shell),
          openTabs: shell.openTabs.map((t) => ({
            tabId: t.tabId,
            sessionId: t.sessionId,
            title: t.title,
            workspaceKey: t.workspaceKey,
          })),
          globalActiveSessionId: sessions.activeSessionId,
          sessionCount: sessions.sessions?.length ?? 0,
        };
      },
      'Snapshot workspace shell tabs + active session ids.'
    );

    console.info('[crish] MCP app_bridge helpers registered');
    return true;
  };

  if (tryRegister()) return;

  // guest listeners may load after us — retry briefly
  let n = 0;
  const timer = window.setInterval(() => {
    n += 1;
    if (tryRegister() || n >= 20) window.clearInterval(timer);
  }, 250);
}
