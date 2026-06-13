import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { appState } from '../core/app-state';
import { tauriBridge } from '../core/tauri-bridge';
import {
  IconX,
  IconMinus,
  IconMaximize,
  IconPanelLeft,
  IconUser,
  IconSettings,
  IconSun,
  IconMoon,
  IconChevronDown,
} from './icons';

export default function TitleBar({ onToggleRightSidebar: _onToggleRightSidebar, onToggleLeftSidebar }: { onToggleRightSidebar: () => void; onToggleLeftSidebar?: () => void }) {
  const [currentSession, setCurrentSession] = useState(appState.getState().currentSession);
  const [leftSidebarVisible, setLeftSidebarVisible] = useState(appState.getState().leftSidebarVisible);
  const [theme, setTheme] = useState(appState.getState().theme);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  // ===== Connection Status Indicator =====
  type ConnectionSnapshot = { connected: boolean; state: string; disconnectCount: number; reconnectRetryCount: number; lastReconnectError: string | null; checkedAt: number };
  const [connection, setConnection] = useState<ConnectionSnapshot>({ connected: false, state: 'stopped', disconnectCount: 0, reconnectRetryCount: 0, lastReconnectError: null, checkedAt: 0 });
  const [connTooltipOpen, setConnTooltipOpen] = useState(false);

  const refreshConnectionStatus = useCallback(async () => {
    try {
      const status = await tauriBridge.getConnectionStatus();
      setConnection(status);
    } catch {
      // 静默失败 - 连接状态轮询失败不影响 UI
    }
  }, []);

  useEffect(() => {
    refreshConnectionStatus();
    const interval = setInterval(refreshConnectionStatus, 5000);

    // 页面不可见时暂停轮询，可见时立即刷新
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        refreshConnectionStatus();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [refreshConnectionStatus]);

  useEffect(() => {
    const u1 = appState.subscribe('currentSession', setCurrentSession);
    const u2 = appState.subscribe('leftSidebarVisible', setLeftSidebarVisible);
    const u3 = appState.subscribe('theme', setTheme);
    return () => { u1(); u2(); u3(); };
  }, []);

  useEffect(() => {
    if (!userMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) setUserMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [userMenuOpen]);

  const handleMinimize = () => getCurrentWindow().minimize();
  const handleMaximize = () => getCurrentWindow().toggleMaximize();
  const handleClose = () => getCurrentWindow().close();
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    appState.setState('theme', next);
    document.documentElement.setAttribute('data-theme', next);
  };
  const titleText = currentSession?.title || 'Crish Agent Workbench';

  return (
    <div class="repl-titlebar" data-tauri-drag-region>
      {/* LEFT: Sidebar Toggle + Logo + 用户 + 设置 */}
      <div class="repl-titlebar-left" data-tauri-drag-region="false">
        <button
          class={`repl-titlebar-btn ${leftSidebarVisible ? 'active' : ''}`}
          onClick={onToggleLeftSidebar}
          title="切换左侧边栏"
        >
          <IconPanelLeft />
        </button>
        <span class="repl-titlebar-logo" data-tauri-drag-region="false">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          Crish
        </span>

        <div class="repl-titlebar-user-wrap" ref={userMenuRef}>
          <button
            class={`repl-titlebar-btn repl-titlebar-user-btn ${userMenuOpen ? 'active' : ''}`}
            onClick={() => setUserMenuOpen(v => !v)}
            title="用户"
          >
            <IconUser />
            <IconChevronDown />
          </button>
          {userMenuOpen && (
            <div class="repl-titlebar-user-menu">
              <div class="repl-titlebar-user-head">用户 · 免费版</div>
              <button class="repl-titlebar-user-item" onClick={toggleTheme}>
                {theme === 'dark' ? <IconSun /> : <IconMoon />}
                <span>{theme === 'dark' ? '浅色主题' : '深色主题'}</span>
              </button>
              <div class="repl-titlebar-user-item static">
                <span>积分</span><span class="repl-titlebar-user-meta">—</span>
              </div>
              <div class="repl-titlebar-user-item static">
                <span>会员</span><span class="repl-titlebar-user-meta">免费版</span>
              </div>
              <div class="repl-titlebar-user-divider" />
              <button class="repl-titlebar-user-item" onClick={() => { setUserMenuOpen(false); appState.openRightTab('settings'); }}>
                <IconSettings />
                <span>设置</span>
              </button>
            </div>
          )}
        </div>

        <button
          class="repl-titlebar-btn"
          onClick={() => appState.openRightTab('settings')}
          title="设置"
        >
          <IconSettings />
        </button>
      </div>

      {/* CENTER: Session Title (Draggable Area) + Connection Indicator */}
      <div class="repl-titlebar-center" data-tauri-drag-region>
        {titleText}
        <span
          class="repl-titlebar-conn-indicator"
          onMouseEnter={() => setConnTooltipOpen(true)}
          onMouseLeave={() => setConnTooltipOpen(false)}
        >
          <svg class={`repl-titlebar-conn-dot ${connection.connected ? 'connected' : connection.state === 'starting' ? 'connecting' : 'disconnected'}`} width="8" height="8" viewBox="0 0 8 8">
            <circle cx="4" cy="4" r="3.5" fill="currentColor" />
          </svg>
          {connTooltipOpen && (
            <div class="repl-titlebar-conn-tooltip" data-tauri-drag-region="false">
              <div class="repl-titlebar-conn-tooltip-row">
                <span>状态</span>
                <span class={connection.connected ? 'conn-status-ok' : 'conn-status-warn'}>
                  {connection.connected ? '已连接' : connection.state === 'starting' ? '连接中...' : '未连接'}
                </span>
              </div>
              {connection.disconnectCount > 0 && (
                <div class="repl-titlebar-conn-tooltip-row">
                  <span>断开次数</span><span>{connection.disconnectCount}</span>
                </div>
              )}
              {connection.reconnectRetryCount > 0 && (
                <div class="repl-titlebar-conn-tooltip-row">
                  <span>当前重试</span><span>第 {connection.reconnectRetryCount} 次</span>
                </div>
              )}
              {connection.lastReconnectError && (
                <div class="repl-titlebar-conn-tooltip-row">
                  <span>最近错误</span><span class="conn-status-err">{connection.lastReconnectError.slice(0, 60)}</span>
                </div>
              )}
              <div class="repl-titlebar-conn-tooltip-row">
                <span>检查时间</span><span>{new Date(connection.checkedAt).toLocaleTimeString()}</span>
              </div>
            </div>
          )}
        </span>
      </div>

      {/* RIGHT: Window Controls */}
      <div class="repl-titlebar-right" data-tauri-drag-region="false">
        <div class="repl-titlebar-win-controls">
          <button class="repl-win-btn" onClick={handleMinimize} title="最小化">
            <IconMinus />
          </button>
          <button class="repl-win-btn" onClick={handleMaximize} title="最大化">
            <IconMaximize />
          </button>
          <button class="repl-win-btn close" onClick={handleClose} title="关闭">
            <IconX />
          </button>
        </div>
      </div>
    </div>
  );
}
