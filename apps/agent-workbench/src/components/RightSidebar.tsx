/**
 * RightSidebar - 右侧功能面板（主工作区布局）
 * 包含 TabBar、Panel 树渲染、分屏拖拽、添加菜单等基础设施。
 * Tab 组件定义已拆分至 tabs/ 目录。
 */

import { useState, useEffect, useRef } from 'preact/hooks';
import { Fragment } from 'preact';
import type { JSX } from 'preact';
import { appState, type RightSidebarTab, type RightSidebarTabType, type PanelNode, type TabPanel, type PanelGroup } from '../core/app-state';
import ChatPanel from './ChatPanel';
import PlanDocumentsPanel from './PlanDocumentsPanel';
import SessionBrowserPanel from './SessionBrowserPanel';
import PerformancePanel from './PerformancePanel';
import TaskSnapshotPanel from './TaskSnapshotPanel';
import {
  ProjectTab, ApprovalsTab, ArtifactsTab, ToolsTab, SettingsTab,
} from './tabs';
import { TAB_ICONS } from './tabs/shared';
import {
  IconPlus, IconX, IconLayout,
} from './icons';


// ==================== Tab Content Renderer ====================

function TabContent({ tab }: { tab: RightSidebarTab }) {
  switch (tab.type) {
    case 'chat': return <ChatPanel sessionId={tab.sessionId} />;
    case 'project': return <ProjectTab />;
    case 'runs': return <TaskSnapshotPanel />;
    case 'sessions': return <SessionBrowserPanel />;
    case 'approvals': return <ApprovalsTab />;
    case 'artifacts': return <ArtifactsTab />;
    case 'tools': return <ToolsTab />;
    case 'diagnostics': return <PerformancePanel />;
    case 'plan': return <PlanDocumentsPanel />;
    case 'settings': return <SettingsTab />;
    default: return <ProjectTab />;
  }
}

// ==================== Add Menu ====================

const ADD_MENU_ITEMS: { type: RightSidebarTabType; label: string; desc: string }[] = [
  { type: 'chat', label: '对话', desc: '消息流' },
  { type: 'project', label: '项目', desc: '文件树 / 变更' },
  { type: 'approvals', label: '审批', desc: '待审批操作' },
  { type: 'tools', label: '工具', desc: 'MCP / 子智能体' },
  { type: 'settings', label: '设置', desc: '配置' },
];

// ==================== 标签拖拽分屏 ====================

let suppressTabClick = false;

function beginTabDrag(e: MouseEvent, tabId: string, sourcePanelId: string, label: string, sourceTabCount: number) {
  if (e.button !== 0) return;
  const sourcePanelEl = (e.currentTarget as HTMLElement | null)?.closest('.repl-rs-tab-panel') as HTMLElement | null;
  const startX = e.clientX;
  const startY = e.clientY;
  const newPanelId = `panel-drag-${Date.now()}`;
  const newGroupId = `group-drag-${Date.now()}`;
  let dragging = false;
  let ghost: HTMLDivElement | null = null;
  let snapLine: HTMLDivElement | null = null;
  let rects: Array<{ id: string; r: DOMRect; el: HTMLElement }> = [];
  let lastKey = '';

  const clearSnap = () => {
    if (snapLine) { snapLine.remove(); snapLine = null; }
  };

  const showSnap = (r: DOMRect, zone: 'top' | 'bottom' | 'left' | 'right') => {
    clearSnap();
    snapLine = document.createElement('div');
    snapLine.className = 'repl-rs-snap-line';
    if (zone === 'left' || zone === 'right') {
      snapLine.classList.add('vertical');
      snapLine.style.left = `${zone === 'left' ? r.left : r.right}px`;
      snapLine.style.top = `${r.top}px`;
      snapLine.style.height = `${r.height}px`;
    } else {
      snapLine.classList.add('horizontal');
      snapLine.style.left = `${r.left}px`;
      snapLine.style.top = `${zone === 'top' ? r.top : r.bottom}px`;
      snapLine.style.width = `${r.width}px`;
    }
    document.body.appendChild(snapLine);
  };

  const onMove = (ev: MouseEvent) => {
    if (!dragging) {
      if (Math.abs(ev.clientX - startX) < 5 && Math.abs(ev.clientY - startY) < 5) return;
      dragging = true;
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
      rects = (Array.from(document.querySelectorAll('.repl-rs-tab-panel[data-panel-id]')) as HTMLElement[])
        .map(el => ({ id: el.dataset.panelId as string, r: el.getBoundingClientRect(), el }));
      ghost = (sourcePanelEl ? sourcePanelEl.cloneNode(true) : document.createElement('div')) as HTMLDivElement;
      ghost.classList.add('repl-rs-window-ghost');
      if (sourcePanelEl) {
        ghost.style.width = `${sourcePanelEl.offsetWidth}px`;
        ghost.style.height = `${Math.min(sourcePanelEl.offsetHeight, 320)}px`;
      } else {
        ghost.textContent = label;
      }
      document.body.appendChild(ghost);
    }
    if (ghost) {
      ghost.style.left = `${ev.clientX + 14}px`;
      ghost.style.top = `${ev.clientY + 14}px`;
    }
    const hit = rects.find(({ r }) => ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom);
    if (!hit) { if (lastKey) { lastKey = ''; appState.clearDragPreview(); clearSnap(); } return; }
    const r = hit.r;
    const fx = (ev.clientX - r.left) / r.width;
    const fy = (ev.clientY - r.top) / r.height;
    let zone: 'top' | 'bottom' | 'left' | 'right' | 'center';
    if (fx > 0.3 && fx < 0.7 && fy > 0.3 && fy < 0.7) {
      zone = 'center';
    } else {
      const dist = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
      zone = (Object.keys(dist) as Array<'left' | 'right' | 'top' | 'bottom'>)
        .reduce((a, b) => (dist[b] < dist[a] ? b : a), 'left');
    }
    if (hit.id === sourcePanelId && (sourceTabCount <= 1 || zone === 'center')) {
      if (lastKey) { lastKey = ''; appState.clearDragPreview(); clearSnap(); }
      return;
    }
    const key = `${hit.id}:${zone}`;
    if (key !== lastKey) {
      lastKey = key;
      appState.setDragPreview(sourcePanelId, tabId, hit.id, zone, newPanelId, newGroupId);
      if (zone !== 'center') showSnap(r, zone);
      else clearSnap();
    }
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (ghost) ghost.remove();
    clearSnap();
    if (dragging && lastKey) {
      suppressTabClick = true;
      setTimeout(() => { suppressTabClick = false; }, 0);
      appState.commitDragPreview();
    } else {
      appState.clearDragPreview();
    }
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ==================== Tab Bar ====================

function TabBar({
  panel,
  tabs,
  onTabClick,
  onTabClose,
  onAddTab,
}: {
  panel: TabPanel;
  tabs: RightSidebarTab[];
  onTabClick: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onAddTab: (type: RightSidebarTabType) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const panelTabs = panel.tabIds
    .map(id => tabs.find(t => t.id === id))
    .filter(Boolean) as RightSidebarTab[];

  const currentTypes = new Set(panelTabs.map(t => t.type));

  useEffect(() => {
    if (!menuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  function handleAddClick() {
    if (!menuOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setMenuOpen(prev => !prev);
  }

  function handleMenuItem(type: RightSidebarTabType) {
    setMenuOpen(false);
    onAddTab(type);
  }

  return (
    <div
      class="repl-rs-tab-bar"
      onWheel={(e: WheelEvent) => {
        if (e.deltaY !== 0) {
          (e.currentTarget as HTMLElement).scrollLeft += e.deltaY;
          e.preventDefault();
        }
      }}
    >
      {panelTabs.map(tab => {
        const isActive = panel.activeTabId === tab.id;
        return (
          <div
            key={tab.id}
            class={`repl-rs-tab ${isActive ? 'active' : ''}`}
            title="拖动可分屏 / 移动到其他面板"
            onClick={() => { if (suppressTabClick) return; onTabClick(tab.id); }}
            onMouseDown={(e: MouseEvent) => {
              if (e.button === 1 && tab.closable) {
                e.preventDefault();
                onTabClose(tab.id);
                return;
              }
              if (e.button === 0) {
                beginTabDrag(e, tab.id, panel.id, tab.label, panel.tabIds.length);
              }
            }}
          >
            <span class="repl-rs-tab-label">{tab.label}</span>
            {tab.closable && (
              <span
                class="repl-rs-tab-close"
                onClick={(e) => { e.stopPropagation(); onTabClose(tab.id); }}
              >
                <IconX />
              </span>
            )}
          </div>
        );
      })}
      <button class="repl-rs-tab-add" onClick={() => appState.autoArrangeWorkspace()} title="自动排布窗口">
        <IconLayout />
      </button>
      <div class="repl-rs-tab-add-menu-wrap" ref={menuRef}>
        <button class="repl-rs-tab-add" ref={buttonRef} onClick={handleAddClick} title="添加标签页">
          <IconPlus />
        </button>
        {menuOpen && menuPos && (
          <div
            class="repl-rs-tab-add-menu"
            style={{ position: 'fixed', top: menuPos.top, right: menuPos.right }}
          >
            {ADD_MENU_ITEMS.map(item => {
              const IconComp = TAB_ICONS[item.type];
              const disabled = currentTypes.has(item.type);
              return (
                <button
                  key={item.type}
                  class={`repl-rs-tab-add-menu-item${disabled ? ' disabled' : ''}`}
                  onClick={() => !disabled && handleMenuItem(item.type)}
                  disabled={disabled}
                >
                  {IconComp && <IconComp />}
                  <span>{item.label}</span>
                  <span>{item.desc}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ==================== Panel Resizer ====================

function PanelResizer({
  direction,
  onResize,
  onCommit,
}: {
  direction: 'vertical' | 'horizontal';
  onResize: (delta: number) => void;
  onCommit?: () => void;
}) {
  const dragging = useRef(false);
  const startPos = useRef(0);
  const [isDragging, setIsDragging] = useState(false);

  function handleMouseDown(e: MouseEvent) {
    dragging.current = true;
    setIsDragging(true);
    startPos.current = direction === 'horizontal' ? e.clientX : e.clientY;
    e.preventDefault();
    document.body.style.userSelect = 'none';
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const currentPos = direction === 'horizontal' ? e.clientX : e.clientY;
      const delta = currentPos - startPos.current;
      startPos.current = currentPos;
      onResize(delta);
    };

    const handleMouseUp = () => {
      dragging.current = false;
      setIsDragging(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      onCommit?.();
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }

  return (
    <div
      class={`repl-rs-resizer ${direction}${isDragging ? ' dragging' : ''}`}
      onMouseDown={handleMouseDown}
    />
  );
}

// ==================== Recursive Panel Renderer ====================

function PanelRenderer({ node, tabs, ghostPanelId }: { node: PanelNode; tabs: RightSidebarTab[]; ghostPanelId?: string | null }) {
  if (node.kind === 'panel') {
    return <TabPanelRenderer panel={node} tabs={tabs} ghostPanelId={ghostPanelId} />;
  }
  return <PanelGroupRenderer group={node} tabs={tabs} ghostPanelId={ghostPanelId} />;
}

function TabPanelRenderer({ panel, tabs, ghostPanelId }: { panel: TabPanel; tabs: RightSidebarTab[]; ghostPanelId?: string | null }) {
  const activeTab = tabs.find(t => t.id === panel.activeTabId) ?? tabs.find(t => t.id === panel.tabIds[0]);
  const [closedUndo, setClosedUndo] = useState<{ tabType: RightSidebarTabType; label: string; timer: number } | null>(null);

  function handleTabClick(tabId: string) {
    appState.switchRightTab(tabId);
  }

  function handleTabClose(tabId: string) {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    appState.closeRightTab(tabId);
    if (closedUndo) window.clearTimeout(closedUndo.timer);
    const timer = window.setTimeout(() => setClosedUndo(null), 5000);
    setClosedUndo({ tabType: tab.type, label: tab.label, timer });
  }

  function handleUndoClose() {
    if (!closedUndo) return;
    window.clearTimeout(closedUndo.timer);
    appState.openRightTab(closedUndo.tabType, closedUndo.label, panel.id);
    setClosedUndo(null);
  }

  function handleAddTab(type: RightSidebarTabType) {
    appState.openRightTab(type, undefined, panel.id);
  }

  if (ghostPanelId && panel.id === ghostPanelId) {
    return (
      <div class="repl-rs-tab-panel repl-rs-ghost-slot" data-panel-id={panel.id}>
        <div class="repl-rs-ghost-slot-inner" />
      </div>
    );
  }

  return (
    <div class="repl-rs-tab-panel" data-panel-id={panel.id}>
      <TabBar
        panel={panel}
        tabs={tabs}
        onTabClick={handleTabClick}
        onTabClose={handleTabClose}
        onAddTab={handleAddTab}
      />
      {closedUndo && (
        <div class="repl-rs-tab-undo">
          <span>已关闭 "{closedUndo.label}"</span>
          <button class="repl-rs-tab-undo-btn" onClick={handleUndoClose}>撤销</button>
        </div>
      )}
      <div class="repl-rs-tab-content">
        {activeTab ? (
          <TabContent tab={activeTab} />
        ) : (
          <div class="repl-rs-empty-add">
            <span class="repl-rs-item-icon"><IconPlus /></span>
            <span class="repl-rs-item-meta">添加面板</span>
          </div>
        )}
      </div>
    </div>
  );
}

function PanelGroupRenderer({ group, tabs, ghostPanelId }: { group: PanelGroup; tabs: RightSidebarTab[]; ghostPanelId?: string | null }) {
  const groupRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState(group.sizes);
  const sizesRef = useRef(group.sizes);

  useEffect(() => {
    setSizes(group.sizes);
    sizesRef.current = group.sizes;
  }, [group.id, group.children.length]);

  function handleResize(index: number, deltaPx: number) {
    const el = groupRef.current;
    if (!el) return;
    const totalPx = group.direction === 'horizontal' ? el.clientWidth : el.clientHeight;
    if (totalPx <= 0) return;
    const deltaPercent = (deltaPx / totalPx) * 100;
    setSizes(prev => {
      const next = [...prev];
      if (next[index] + deltaPercent > 10 && next[index + 1] - deltaPercent > 10) {
        next[index] += deltaPercent;
        next[index + 1] -= deltaPercent;
      }
      sizesRef.current = next;
      return next;
    });
  }

  function commitSizes() {
    appState.updatePanelSizes(group.id, sizesRef.current);
  }

  return (
    <div class={`repl-rs-panel-group ${group.direction}`} ref={groupRef}>
      {group.children.map((child, i) => (
        <Fragment key={child.id}>
          <div class="repl-rs-panel-slot" style={{ flexBasis: `${sizes[i] ?? (100 / group.children.length)}%` }}>
            <PanelRenderer node={child} tabs={tabs} ghostPanelId={ghostPanelId} />
          </div>
          {i < group.children.length - 1 && (
            <PanelResizer direction={group.direction} onResize={(delta) => handleResize(i, delta)} onCommit={commitSizes} />
          )}
        </Fragment>
      ))}
    </div>
  );
}

// ==================== Main RightSidebar Component ====================

export default function RightSidebar() {
  const [panelLayout, setPanelLayout] = useState(appState.getState().panelLayout);
  const [tabs, setTabs] = useState(appState.getState().rightSidebarTabs);
  const [preview, setPreview] = useState(appState.getState().panelLayoutPreview);
  const [ghostPanelId, setGhostPanelId] = useState(appState.getState().previewGhostPanelId);

  useEffect(() => {
    const u1 = appState.subscribe('panelLayout', setPanelLayout);
    const u2 = appState.subscribe('rightSidebarTabs', setTabs);
    const u3 = appState.subscribe('panelLayoutPreview', setPreview);
    const u4 = appState.subscribe('previewGhostPanelId', setGhostPanelId);
    return () => { u1(); u2(); u3(); u4(); };
  }, []);

  const renderLayout = preview ?? panelLayout;

  return (
    <div class="repl-workspace">
      <div class="repl-rs-container">
        <PanelRenderer node={renderLayout} tabs={tabs} ghostPanelId={preview ? ghostPanelId : null} />
      </div>
    </div>
  );
}