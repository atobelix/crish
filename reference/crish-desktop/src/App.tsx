import { useState, useEffect, useRef, useCallback } from 'react';
import { useLayoutStore } from './store/layoutStore';
import { piClientApi } from './api/piClientApi';

if (typeof window !== 'undefined') {
  (window as any).useLayoutStore = useLayoutStore;
}
import { Sidebar } from './components/Sidebar';
import { Workspace } from './components/Workspace';
import * as Lucide from 'lucide-react';
import { SettingsPanel } from './components/SettingsPanel';

function App() {
  const {
    workspaces,
    activeWorkspaceIndex,
    tabModeEnabled,
    uiSize,
    sidebarCollapsed,
    panelsDropdownCoords,
    setUiSize,
    setSidebarCollapsed,
    setTabModeEnabled,
    setPanelsDropdownCoords,
    togglePanel,
    showSettingsOverlay,
    setShowSettingsOverlay,
    settingsActiveTab,
    setPiSettings,
    setProviders,
  } = useLayoutStore();

  const [toast, setToast] = useState<{ message: string; onUndo?: () => void } | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const activeWorkspace = workspaces[activeWorkspaceIndex];
  const [showCheatsheet, setShowCheatsheet] = useState(false);

  // Sidebar hover overlay state & handlers
  const [isHoveredExpanded, setIsHoveredExpanded] = useState(false);
  const hoverTimeoutRef = useRef<any>(null);

  const [autoFoldDelay, setAutoFoldDelay] = useState(() => {
    if (typeof window !== 'undefined') {
      const current = (window as any).AUTO_FOLD_DELAY;
      if (current !== undefined) return current;
      (window as any).AUTO_FOLD_DELAY = 5000;
      return 5000;
    }
    return 5000;
  });

  // Sync window.AUTO_FOLD_DELAY
  useEffect(() => {
    (window as any).AUTO_FOLD_DELAY = autoFoldDelay;
  }, [autoFoldDelay]);

  // Initial load theme & settings sync
  useEffect(() => {
    const initApp = async () => {
      try {
        const settings = await piClientApi.getSettings();
        if (settings) {
          setPiSettings(settings);
          if (settings.theme) {
            document.body.setAttribute('data-theme', settings.theme);
          }
        }
        const provs = await piClientApi.getProviders();
        if (provs) {
          setProviders(provs);
        }
      } catch (err) {
        console.error("Failed to load settings or providers on startup", err);
      }
    };
    initApp();
  }, []);

  // Resize Throttling (80ms) + Debounce (400ms) with elastic transition support
  const [resizeWidth, setResizeWidth] = useState<number | null>(null);
  useEffect(() => {
    let throttleTimer: any = null;
    let debounceTimer: any = null;
    let lastExecuted = 0;

    const handleResize = () => {
      document.body.classList.add('window-resizing');
      const now = Date.now();
      const currentWidth = window.innerWidth;

      if (now - lastExecuted >= 80) {
        setResizeWidth(currentWidth);
        lastExecuted = now;
      } else {
        if (throttleTimer) clearTimeout(throttleTimer);
        throttleTimer = setTimeout(() => {
          setResizeWidth(currentWidth);
          lastExecuted = Date.now();
        }, 80 - (now - lastExecuted));
      }

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        setResizeWidth(null);
        document.body.classList.remove('window-resizing');
      }, 400);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (throttleTimer) clearTimeout(throttleTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, []);

  const handleHoverTriggerEnter = () => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    setIsHoveredExpanded(true);
  };

  const handleSidebarHoverEnter = () => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
  };

  const handleSidebarHoverLeave = () => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = setTimeout(() => {
      setIsHoveredExpanded(false);
    }, 300);
  };

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

  // Sync UI size attribute on root HTML element
  useEffect(() => {
    document.documentElement.setAttribute('data-ui-size', uiSize);
  }, [uiSize]);

  // Bind Ctrl+, keyboard shortcut to toggle settings overlay
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        const show = useLayoutStore.getState().showSettingsOverlay;
        useLayoutStore.getState().setShowSettingsOverlay(!show);
        handleShowToast(!show ? '已打开系统设置' : '已关闭系统设置');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Double Escape keybinding to branch active session
  useEffect(() => {
    let lastEscTime = 0;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const now = Date.now();
        if (now - lastEscTime <= 300) {
          e.preventDefault();
          const activeSess = useLayoutStore.getState().sessions.find(
            s => s.id === useLayoutStore.getState().activeSessionId
          );
          if (activeSess) {
            useLayoutStore.getState().branchSession(activeSess.id, `${activeSess.title} - 双击ESC分叉`);
            handleShowToast(`已通过双击 Escape 快捷分叉会话: ${activeSess.title}`);
          }
        }
        lastEscTime = now;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Connect and subscribe to WebSocket Telemetry
  useEffect(() => {
    const unsubscribe = piClientApi.subscribeTelemetry((data) => {
      useLayoutStore.getState().syncTelemetryData(data);
    });
    return () => unsubscribe();
  }, []);

  // Watch session/workspace changes to update project trust state
  const checkFolderTrust = useLayoutStore((state) => state.checkFolderTrust);
  const activeSessionId = useLayoutStore((state) => state.activeSessionId);
  const sessions = useLayoutStore((state) => state.sessions);
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  
  useEffect(() => {
    if (activeSession) {
      const rawFolder = activeSession.folder;
      const cwd = (rawFolder.includes('/') || rawFolder.includes('\\')) 
        ? rawFolder 
        : `c:/Software/conex/${rawFolder}`;
      checkFolderTrust(cwd);
    }
  }, [activeSessionId, activeSession, checkFolderTrust]);

  // Click outside to close layout panels dropdown
  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        const clickedBtn = (e.target as HTMLElement).closest('.panel-menu-btn');
        if (!clickedBtn) {
          setPanelsDropdownCoords(null);
        }
      }
    };
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [setPanelsDropdownCoords]);



  const handleShowToast = useCallback((message: string, onUndo?: () => void) => {
    setToast({ message, onUndo });
    // Auto close toast after 5 seconds
    const timer = setTimeout(() => {
      setToast(null);
    }, 5000);
    return () => clearTimeout(timer);
  }, []);

  // Check if a card is currently visible/open in the active workspace
  const isPanelOpen = (key: string) => {
    if (!activeWorkspace) return false;
    return activeWorkspace.columns.some((col) =>
      col.groups.some((g) => g.cards.some((c) => c.id === key))
    );
  };

  const handleTogglePanel = (key: string) => {
    if (!activeWorkspace) return;
    const isCurrentlyOpen = isPanelOpen(key);
    togglePanel(activeWorkspace.id, key, !isCurrentlyOpen);
  };

  const renderCardIcon = (id: string) => {
    switch (id) {
      case 'chat': return <Lucide.MessageSquare size={13} />;
      case 'plan': return <Lucide.Scroll size={13} />;
      case 'preview': return <Lucide.Eye size={13} />;
      case 'diff': return <Lucide.GitBranch size={13} />;
      case 'tasks': return <Lucide.CheckSquare size={13} />;
      case 'terminal': return <Lucide.Terminal size={13} />;
      default: return <Lucide.Layout size={13} />;
    }
  };

  return (
    <div className="app-container">
      {/* Desktop App Titlebar Header */}
      <header className="app-header">
        <div className="app-header-left">
          <button className="header-btn" title="Menu">
            <Lucide.Menu size={16} />
          </button>
          <button
            className="header-btn"
            title="Sidebar Toggle"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            <Lucide.Sidebar size={16} />
          </button>
          
          <div className="navigation-arrows">
            <button className="header-btn" title="Back">
              <Lucide.ArrowLeft size={16} />
            </button>
            <button className="header-btn" title="Forward" disabled>
              <Lucide.ArrowRight size={16} />
            </button>
          </div>

          <div className="search-bar">
            <Lucide.Search className="search-icon" size={13} />
            <input type="text" placeholder="Search sessions, files, commands..." />
          </div>
        </div>

        <div className="app-header-right" style={{ display: 'flex', alignItems: 'center' }}>
          {/* Help button */}
          <button 
            className="header-btn" 
            onClick={() => setShowCheatsheet(true)} 
            title="快捷键与帮助"
            style={{ marginRight: '10px' }}
          >
            <Lucide.HelpCircle size={16} />
          </button>

          {/* Telemetry Panel Toggle Button */}
          <button 
            className={`header-btn ${isPanelOpen('pi-runtime') ? 'active' : ''}`}
            onClick={() => {
              if (!activeWorkspace) return;
              const isCurrentlyOpen = isPanelOpen('pi-runtime');
              if (!isCurrentlyOpen) {
                togglePanel(activeWorkspace.id, 'pi-runtime', true);
                handleShowToast('已打开遥测监控中心');
              } else {
                let groupId: string | null = null;
                activeWorkspace.columns.forEach((col) => {
                  col.groups.forEach((g) => {
                    if (g.cards.some((c) => c.id === 'pi-runtime')) {
                      groupId = g.id;
                    }
                  });
                });
                if (groupId) {
                  useLayoutStore.setState((state) => {
                    const targetWs = state.workspaces.find((w) => w.id === activeWorkspace.id);
                    if (targetWs) {
                      for (const col of targetWs.columns) {
                        const g = col.groups.find(gp => gp.id === groupId);
                        if (g) {
                          g.activeCardId = 'pi-runtime';
                          break;
                        }
                      }
                    }
                  });
                  handleShowToast('已切换至遥测监控中心');
                } else {
                  togglePanel(activeWorkspace.id, 'pi-runtime', true);
                  handleShowToast('已打开遥测监控中心');
                }
              }
            }}
            title="遥测看板"
            style={{ marginRight: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <Lucide.Gauge size={16} />
          </button>

          {/* Windows Minimize/Maximize native mimicking controls */}
          <div className="window-controls">
            <button className="win-btn" title="Minimize"><Lucide.Minus size={14} /></button>
            <button className="win-btn" title="Maximize"><Lucide.Square size={12} /></button>
            <button className="win-btn close" title="Close"><Lucide.X size={14} /></button>
          </div>
        </div>
      </header>

      {/* Floating Panels Selector Dropdown */}
      {panelsDropdownCoords && (
        <div
          ref={dropdownRef}
          className="panel-dropdown open"
          style={{
            position: 'fixed',
            left: `${panelsDropdownCoords.x}px`,
            top: `${panelsDropdownCoords.y}px`,
          }}
        >
          <div className="dropdown-header">
            <Lucide.LayoutGrid size={13} />
            <span>面板</span>
            <button
              type="button"
              className="dropdown-close-btn"
              onClick={() => setPanelsDropdownCoords(null)}
            >
              <Lucide.X size={12} />
            </button>
          </div>

          <div className="dropdown-group" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
            {(['preview', 'diff', 'terminal', 'tasks'] as const).map((key) => {
              const labels: Record<string, string> = {
                preview: '预览',
                diff: '差异',
                terminal: '终端',
                tasks: '任务',
              };
              const isOpen = isPanelOpen(key);
              return (
                <label
                  key={key}
                  className="dropdown-item"
                  onClick={() => handleTogglePanel(key)}
                >
                  <span className={`custom-chk ${isOpen ? 'checked' : ''}`} />
                  <span
                    className="dropdown-item-icon-wrap"
                    style={{ display: 'flex', alignItems: 'center', color: 'var(--text-tertiary)' }}
                  >
                    {renderCardIcon(key)}
                  </span>
                  <span>{labels[key]}</span>
                </label>
              );
            })}
          </div>

          <div className="dropdown-group">
            <label
              className="dropdown-item"
              onClick={() => setTabModeEnabled(!tabModeEnabled)}
            >
              <span className={`custom-chk ${tabModeEnabled ? 'checked' : ''}`} />
              <Lucide.Layers size={13} style={{ color: 'var(--text-tertiary)' }} />
              <span>优先合并为标签页</span>
            </label>
          </div>

          <div className="dropdown-group">
            <div className="dropdown-pref">
              <span className="dropdown-pref-label">自动折叠</span>
              <div className="ui-segment">
                {[0, 3000, 5000, 10000].map((delayVal) => (
                  <button
                    key={delayVal}
                    type="button"
                    className={`ui-segment-item ${autoFoldDelay === delayVal ? 'active' : ''}`}
                    onClick={() => {
                      setAutoFoldDelay(delayVal);
                      handleShowToast(
                        delayVal === 0
                          ? '已关闭工具自动折叠'
                          : `自动折叠延迟 ${delayVal / 1000}s`,
                      );
                    }}
                  >
                    {delayVal === 0 ? '关' : `${delayVal / 1000}s`}
                  </button>
                ))}
              </div>
            </div>

            <div className="dropdown-pref">
              <span className="dropdown-pref-label">界面大小</span>
              <div className="ui-segment">
                {(['small', 'medium', 'large'] as const).map((size) => (
                  <button
                    key={size}
                    type="button"
                    className={`ui-segment-item ${uiSize === size ? 'active' : ''}`}
                    onClick={() => setUiSize(size)}
                  >
                    {size === 'small' && '小'}
                    {size === 'medium' && '中'}
                    {size === 'large' && '大'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main content body with Sidebar and workspaces side by side */}
      <main
        className="main-layout"
        style={{
          position: 'relative',
          width: resizeWidth ? `${resizeWidth}px` : '100%',
          margin: '0 auto',
        }}
      >
        {sidebarCollapsed && (
          <div
            className="sidebar-hover-trigger"
            onMouseEnter={handleHoverTriggerEnter}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: '8px',
              zIndex: 9999,
              cursor: 'w-resize',
            }}
          />
        )}

        <div
          className={`sidebar-wrapper ${sidebarCollapsed ? 'collapsed' : ''}`}
          style={{
            width: sidebarCollapsed ? 0 : 'var(--sidebar-width)',
            height: '100%',
            flexShrink: 0,
            transition: 'width 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)',
            overflow: 'visible',
            position: 'relative',
          }}
        >
          <Sidebar
            onShowToast={handleShowToast}
            hoverExpanded={sidebarCollapsed && isHoveredExpanded}
            onHoverLeave={handleSidebarHoverLeave}
            onHoverEnter={handleSidebarHoverEnter}
          />
        </div>

        <div className="workspaces-container">
          {workspaces.map((ws) => (
            <Workspace key={ws.id} ws={ws} onShowToast={handleShowToast} />
          ))}
        </div>
      </main>

      {/* Floating Dark Toast Notification alerts */}
      {toast && (
        <div className="toast-alert">
          <span>{toast.message}</span>
          {toast.onUndo && (
            <button
              className="toast-undo-btn"
              onClick={() => {
                toast.onUndo?.();
                setToast(null);
              }}
            >
              撤销
            </button>
          )}
        </div>
      )}

      {/* Centered Lightweight Approval Dialog and Floating Plan Panel removed for clean UI */}
      
      {/* Centered Cheatsheet Modal Overlay */}
      {showCheatsheet && (
        <div className="cheatsheet-overlay" onClick={() => setShowCheatsheet(false)}>
          <div className="cheatsheet-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cheatsheet-header">
              <div className="cheatsheet-title-wrap">
                <Lucide.Keyboard size={16} style={{ color: 'var(--accent-color)' }} />
                <h3 className="cheatsheet-title">快捷键</h3>
              </div>
              <button onClick={() => setShowCheatsheet(false)} className="cheatsheet-close-btn">
                <Lucide.X size={16} />
              </button>
            </div>
            
            <div className="cheatsheet-body">
              <div className="cheatsheet-row">
                <span className="cheatsheet-label">打开系统设置</span>
                <kbd className="cheatsheet-key">Ctrl + ,</kbd>
              </div>
              <div className="cheatsheet-row">
                <span className="cheatsheet-label">分支分叉当前会话</span>
                <kbd className="cheatsheet-key">双击 Escape</kbd>
              </div>
              <div className="cheatsheet-row">
                <span className="cheatsheet-label">聊天命令行提示</span>
                <kbd className="cheatsheet-key">输入 /</kbd>
              </div>
              <div className="cheatsheet-row">
                <span className="cheatsheet-label">关闭当前选中卡片</span>
                <kbd className="cheatsheet-key">中键点击标签页</kbd>
              </div>
            </div>
            
            <div className="cheatsheet-footer-tip">
              <strong>布局提示：</strong>
              工作区卡片支持拖拽与合并。拖动标签页在其他卡片边缘悬停即可快速分屏，或在标签栏中拖拽重排。
            </div>
          </div>
        </div>
      )}

      {/* Full screen Settings overlay */}
      {showSettingsOverlay && (
        <div
          className="settings-overlay-backdrop"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 15, 18, 0.28)',
            backdropFilter: 'blur(6px)',
            zIndex: 10000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 40,
          }}
        >
          <div
            className="settings-overlay-window"
            style={{
              width: '100%',
              maxWidth: 900,
              height: '100%',
              maxHeight: 650,
              background: 'var(--bg-primary)',
              border: '1px solid var(--border-color)',
              borderRadius: 16,
              boxShadow: 'var(--shadow-2xl)',
              overflow: 'hidden',
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <SettingsPanel
              wsId={activeWorkspace?.id || 'ws-0'}
              onShowToast={handleShowToast}
              onClose={() => setShowSettingsOverlay(false)}
              initialTab={settingsActiveTab as any}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
