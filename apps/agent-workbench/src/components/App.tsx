import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { appState } from '../core/app-state';
import { tauriBridge } from '../core/tauri-bridge';
import { eventBus, Events } from '../core/event-bus';
import TitleBar from './TitleBar';
import Sidebar from './Sidebar';
import RightSidebar from './RightSidebar';
import SettingsPanel from './SettingsModal';
import { CommandPalette } from './CommandPalette';
import { ToastContainer } from './ToastContainer';

export default function App() {
  const [leftSidebarVisible, setLeftSidebarVisible] = useState(
    appState.getState().leftSidebarVisible
  );
  const [rightSidebarVisible, setRightSidebarVisible] = useState(
    appState.getState().rightSidebarVisible
  );
  const [settingsOpen, setSettingsOpen] = useState(appState.getState().settingsOpen);

  // Left sidebar overlay state (when collapsed, hover reveals as overlay)
  const [leftOverlay, setLeftOverlay] = useState(false);
  const hoverEnterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const u1 = appState.subscribe('rightSidebarVisible', setRightSidebarVisible);
    const u2 = appState.subscribe('settingsOpen', setSettingsOpen);
    const u3 = appState.subscribe('leftSidebarVisible', setLeftSidebarVisible);
    return () => { u1(); u2(); u3(); };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadDaemonSessions() {
      try {
        if (cancelled) return;
        await appState.refreshDaemonSessionsAfterAction();
      } catch (error) {
        if (!cancelled) {
          appState.patchDaemonBrowser({ error: error instanceof Error ? error.message : String(error) });
        }
      }
    }

    void loadDaemonSessions();
    return () => { cancelled = true; };
  }, []);

  const toggleRightSidebar = useCallback(() => {
    appState.setState('rightSidebarVisible', !appState.getState().rightSidebarVisible);
  }, []);

  const toggleLeftSidebar = useCallback(() => {
    const next = !appState.getState().leftSidebarVisible;
    appState.setState('leftSidebarVisible', next);
    if (next) setLeftOverlay(false);
  }, []);

  // Panel resizing via drag
  useEffect(() => {
    const handleLeftResize = (e: MouseEvent) => {
      const w = Math.max(180, Math.min(400, e.clientX));
      document.documentElement.style.setProperty('--sidebar-width', `${w}px`);
    };
    const handleRightResize = (e: MouseEvent) => {
      const w = Math.max(200, Math.min(600, window.innerWidth - e.clientX));
      document.documentElement.style.setProperty('--right-sidebar-width', `${w}px`);
    };
    const stopResize = () => {
      document.removeEventListener('mousemove', handleLeftResize);
      document.removeEventListener('mousemove', handleRightResize);
      document.removeEventListener('mouseup', stopResize);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    const startLeftResize = (e: MouseEvent) => {
      e.preventDefault();
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', handleLeftResize);
      document.addEventListener('mouseup', stopResize);
    };
    const startRightResize = (e: MouseEvent) => {
      e.preventDefault();
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', handleRightResize);
      document.addEventListener('mouseup', stopResize);
    };
    const leftResizer = document.getElementById('resizer-left');
    const rightResizer = document.getElementById('resizer-right');
    leftResizer?.addEventListener('mousedown', startLeftResize as any);
    rightResizer?.addEventListener('mousedown', startRightResize as any);
    return () => {
      leftResizer?.removeEventListener('mousedown', startLeftResize as any);
      rightResizer?.removeEventListener('mousedown', startRightResize as any);
    };
  }, []);

  // Left sidebar hover reveal (state-driven, no DOM manipulation)
  const HOVER_INTENT_DELAY = 350;
  const EXIT_DELAY = 400;

  const onEdgeTriggerEnter = useCallback(() => {
    if (leftSidebarVisible) return;
    clearTimeout(hoverLeaveTimer.current!);
    clearTimeout(hoverEnterTimer.current!);
    hoverEnterTimer.current = setTimeout(() => {
      setLeftOverlay(true);
    }, HOVER_INTENT_DELAY);
  }, [leftSidebarVisible]);

  const onEdgeTriggerLeave = useCallback(() => {
    clearTimeout(hoverEnterTimer.current!);
  }, []);

  const onSidebarEnter = useCallback(() => {
    clearTimeout(hoverLeaveTimer.current!);
    clearTimeout(hoverEnterTimer.current!);
  }, []);

  const onSidebarLeave = useCallback(() => {
    clearTimeout(hoverLeaveTimer.current!);
    hoverLeaveTimer.current = setTimeout(() => {
      setLeftOverlay(false);
    }, EXIT_DELAY);
  }, []);

  const onMainPanelClick = useCallback(() => {
    if (leftOverlay) setLeftOverlay(false);
  }, [leftOverlay]);

  // Create a local default session only after daemon history has had a chance to load.
  useEffect(() => {
    const maybeCreateDefaultSession = () => {
      const state = appState.getState();
      if (state.currentSession) return;
      if (state.daemonBrowser.loadingSessions) return;
      if (state.daemonBrowser.sessions.length > 0) return;
      if (state.sessions.length > 0) return;
      appState.createSession('新对话');
    };

    const u1 = appState.subscribe('daemonBrowser', maybeCreateDefaultSession);
    const u2 = appState.subscribe('currentSession', maybeCreateDefaultSession);
    const timer = window.setTimeout(maybeCreateDefaultSession, 0);

    // Global keyboard shortcuts
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'n') {
        e.preventDefault();
        appState.createSession();
        eventBus.emit(Events.SESSION_CREATED);
      }
      if (e.ctrlKey && e.key === 'o') {
        e.preventDefault();
        tauriBridge.selectFolder().then(folder => {
          if (folder) {
            appState.addOpenedFolder(folder);
            appState.setState('workingDirectory', folder);
            // workMode 由 currentSession.projectId 决定，创建项目会话切换到 agent 模式
            const projectSessions = appState.getProjectSessions(folder);
            if (projectSessions.length > 0) {
              appState.switchSession(projectSessions[0].id);
            } else {
              appState.createSession('新对话', folder);
            }
          }
        });
      }
      if (e.ctrlKey && e.key === 'b') {
        e.preventDefault();
        appState.setState('rightSidebarVisible', !appState.getState().rightSidebarVisible);
      }
      if (e.ctrlKey && e.key === ',') {
        e.preventDefault();
        appState.setState('settingsOpen', true);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(timer);
      u1();
      u2();
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const sidebarClass = [
    'repl-sidebar',
    !leftSidebarVisible && !leftOverlay ? 'hide-sidebar' : '',
    leftOverlay && !leftSidebarVisible ? 'overlay-reveal' : '',
  ].filter(Boolean).join(' ');

  return (
    <div class="repl-window-root">
      <CommandPalette />
      <ToastContainer />
      <TitleBar onToggleRightSidebar={toggleRightSidebar} onToggleLeftSidebar={toggleLeftSidebar} />
      <main class="repl-workspace-container">
        <div class={sidebarClass}
          onMouseEnter={onSidebarEnter}
          onMouseLeave={onSidebarLeave}
        >
          <Sidebar />
        </div>
        <div class="repl-resizer repl-resizer-left" id="resizer-left"></div>
        <div id="main-workspace" onClick={onMainPanelClick}>
          <RightSidebar />
        </div>
      </main>
      {/* 设置：全屏覆盖（全局，不再嵌在主消息流里） */}
      {settingsOpen && <SettingsPanel />}
      {/* Left edge hover trigger - only visible when sidebar is collapsed */}
      {!leftSidebarVisible && !leftOverlay && (
        <div
          class="repl-edge-trigger"
          onMouseEnter={onEdgeTriggerEnter}
          onMouseLeave={onEdgeTriggerLeave}
        />
      )}
      {leftOverlay && !leftSidebarVisible && (
        <div class="repl-edge-glow active" />
      )}
    </div>
  );
}
