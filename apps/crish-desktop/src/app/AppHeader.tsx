import { Suspense, lazy, memo } from 'react';
import { Tooltip } from '../components/Tooltip';
import { AppErrorBoundary } from '../components/AppErrorBoundary';

const WorkspaceChromeBars = lazy(() => import('../components/WorkspaceChromeBars').then((m) => ({ default: m.WorkspaceChromeBars })));
const IconSidebarLeft = lazy(() => import('../components/SidebarToggleIcons').then((m) => ({ default: m.IconSidebarLeft })));
const IconSidebarRight = lazy(() => import('../components/SidebarToggleIcons').then((m) => ({ default: m.IconSidebarRight })));
const LucideHelpCircle = lazy(() => import('../components/WindowIcons').then((m) => ({ default: m.HelpCircle })));
const LucideMinus = lazy(() => import('../components/WindowIcons').then((m) => ({ default: m.Minus })));
const LucideSquare = lazy(() => import('../components/WindowIcons').then((m) => ({ default: m.Square })));
const LucideX = lazy(() => import('../components/WindowIcons').then((m) => ({ default: m.X })));

function Sf({ h, w }: { h?: number | string; w?: number | string }) {
  return <div className="skel-shimmer" style={{ height: h || '100%', width: w || '100%', borderRadius: 6 }} aria-hidden="true" />;
}

interface AppHeaderProps {
  shellChromeMode: string;
  sidebarCollapsed: boolean;
  isRightSidebarCollapsed: boolean;
  showCheatsheet: boolean;
  onToggleSidebar: () => void;
  onToggleRightSidebar: () => void;
  onOpenHelp: () => void;
  onWinCtl: (action: 'minimize' | 'toggleMaximize' | 'close') => void;
  onAddProject: () => void;
  onDblClickTitlebar?: () => void;
}

export const AppHeader = memo(function AppHeader(props: AppHeaderProps) {
  const { shellChromeMode, sidebarCollapsed, isRightSidebarCollapsed, onToggleSidebar, onToggleRightSidebar, onOpenHelp, onWinCtl, onAddProject, onDblClickTitlebar } = props;
  const sbLabel = sidebarCollapsed ? '展开侧栏' : '收起侧栏';
  const sidebarBtn = (
    <Tooltip content={sbLabel}>
      <button type="button" className="header-btn no-drag" data-tauri-drag-region="false" aria-label={sbLabel} aria-expanded={!sidebarCollapsed} aria-controls="crish-sidebar" onClick={onToggleSidebar} onPointerDown={(e) => e.stopPropagation()}>
        <Suspense fallback={<Sf h={15} w={15} />}><IconSidebarLeft size={15} aria-hidden="true" /></Suspense>
      </button>
    </Tooltip>
  );

  if (shellChromeMode !== 'inset') {
    return (
      <header className="app-header" role="banner" aria-label="应用顶栏" data-tauri-drag-region onDoubleClick={onDblClickTitlebar}>
        <div className="app-header-left" data-tauri-drag-region>{sidebarBtn}</div>
        <div className="app-header-right no-drag" data-tauri-drag-region="false" role="toolbar" aria-label="顶栏操作" onPointerDown={(e) => e.stopPropagation()}>
          <Tooltip content={isRightSidebarCollapsed ? '展开右面板' : '收起右面板'}>
            <button type="button" className={`header-btn no-drag ${!isRightSidebarCollapsed ? 'active' : ''}`} data-tauri-drag-region="false" aria-label={isRightSidebarCollapsed ? '展开右面板' : '收起右面板'} aria-pressed={!isRightSidebarCollapsed} onClick={onToggleRightSidebar} onPointerDown={(e) => e.stopPropagation()}>
              <Suspense fallback={<Sf h={15} w={15} />}><IconSidebarRight size={15} aria-hidden="true" /></Suspense>
            </button>
          </Tooltip>
          <Tooltip content="快捷键与帮助">
            <button type="button" className="header-btn" onClick={onOpenHelp} aria-label="快捷键与帮助" aria-haspopup="dialog">
              <Suspense fallback={<Sf h={16} w={16} />}><LucideHelpCircle size={16} aria-hidden="true" /></Suspense>
            </button>
          </Tooltip>
          <div className="window-controls no-drag" role="group" aria-label="窗口控制" data-tauri-drag-region="false" onPointerDown={(e) => e.stopPropagation()}>
            {([['minimize', LucideMinus, 16, '最小化'], ['toggleMaximize', LucideSquare, 14, '最大化'], ['close', LucideX, 16, '关闭']] as const).map(([a, Icon, s, tip]) => (
              <Tooltip content={tip} key={a}>
                <button type="button" className={`win-btn no-drag${a === 'close' ? ' close' : ''}`} aria-label={tip} data-tauri-drag-region="false" onClick={() => void onWinCtl(a)} onPointerDown={(e) => e.stopPropagation()}>
                  <Suspense fallback={<Sf h={s} w={s} />}><Icon size={s} aria-hidden="true" /></Suspense>
                </button>
              </Tooltip>
            ))}
          </div>
        </div>
      </header>
    );
  }

  return (
    <div className={`ws-titlebar-host${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}`} role="banner" aria-label="项目顶栏" data-tauri-drag-region onDoubleClick={onDblClickTitlebar}>
      <div className="ws-titlebar-rail" data-tauri-drag-region>{sidebarBtn}</div>
      <div className="ws-titlebar-main" data-tauri-drag-region>
        <AppErrorBoundary compact title="工作区标签出错">
          <Suspense fallback={<Sf h={32} />}>
            <WorkspaceChromeBars variant="workspace" className="ws-chrome-row--titlebar" onAddProject={onAddProject} onOpenHelp={onOpenHelp} onWinMinimize={() => void onWinCtl('minimize')} onWinMaximize={() => void onWinCtl('toggleMaximize')} onWinClose={() => void onWinCtl('close')} />
          </Suspense>
        </AppErrorBoundary>
      </div>
    </div>
  );
});
