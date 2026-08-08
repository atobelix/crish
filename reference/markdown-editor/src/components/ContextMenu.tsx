import React, { useEffect, useState } from 'react';
import { useTableStore } from '../core/TableStore';
import { useEditorStore } from '../core/EditorStore';

interface ContextMenuState {
  x: number;
  y: number;
  isEditing: boolean;
  tableId: string;
}

export const ContextMenu: React.FC = () => {
  const [menuState, setMenuState] = useState<ContextMenuState | null>(null);

  useEffect(() => {
    const handleContextMenu = (e: Event) => {
      const customEvent = e as CustomEvent<ContextMenuState>;
      setMenuState(customEvent.detail);
    };

    const closeMenu = () => {
      setMenuState(null);
    };

    window.addEventListener('open-table-context-menu', handleContextMenu as EventListener);
    window.addEventListener('click', closeMenu);
    window.addEventListener('scroll', closeMenu, { capture: true });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });

    return () => {
      window.removeEventListener('open-table-context-menu', handleContextMenu as EventListener);
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('scroll', closeMenu, { capture: true });
    };
  }, []);

  if (!menuState) return null;

  const { isEditing } = menuState;

  const handleAction = (action: string) => {
    setMenuState(null);
    // In this basic version, we just log or focus. 
    // Real implementation would call TableOperations mutating functions here.
    const input = document.querySelector('.hidden-input') as HTMLTextAreaElement;
    if (input) input.focus();
  };

  return (
    <div
      className="context-menu"
      style={{
        position: 'fixed',
        top: `${menuState.y}px`,
        left: `${menuState.x}px`,
        zIndex: 9999,
        backgroundColor: 'var(--white)',
        border: '1px solid var(--border-medium)',
        boxShadow: '0 4px 12px hsl(0 0% 0% / 0.1)',
        borderRadius: '6px',
        padding: '4px 0',
        minWidth: '160px',
        fontSize: '13.5px',
        color: 'var(--text-primary)'
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <style>{`
        .context-menu-item {
          padding: 6px 12px;
          cursor: pointer;
        }
        .context-menu-item:hover {
          background-color: var(--border-subtle);
        }
      `}</style>
      {isEditing ? (
        // Edit Mode Actions
        <>
          <div className="context-menu-item" onClick={() => handleAction('copy')}>复制文字 <span style={{ float: 'right', color: 'var(--text-muted)' }}>Ctrl+C</span></div>
          <div className="context-menu-item" onClick={() => handleAction('paste')}>粘贴文字 <span style={{ float: 'right', color: 'var(--text-muted)' }}>Ctrl+V</span></div>
          <div className="context-menu-divider" style={{ borderBottom: '1px solid var(--border-subtle)', margin: '4px 0' }} />
          <div className="context-menu-item" onClick={() => handleAction('bold')}>加粗 <span style={{ float: 'right', color: 'var(--text-muted)' }}>Ctrl+B</span></div>
          <div className="context-menu-item" onClick={() => handleAction('italic')}>斜体 <span style={{ float: 'right', color: 'var(--text-muted)' }}>Ctrl+I</span></div>
        </>
      ) : (
        // Cell Mode Actions
        <>
          <div className="context-menu-item" onClick={() => handleAction('edit-cell')}>编辑单元格 <span style={{ float: 'right', color: 'var(--text-muted)' }}>F2</span></div>
          <div className="context-menu-divider" style={{ borderBottom: '1px solid var(--border-subtle)', margin: '4px 0' }} />
          <div className="context-menu-item" onClick={() => handleAction('insert-row-above')}>向上插入行</div>
          <div className="context-menu-item" onClick={() => handleAction('insert-row-below')}>向下插入行</div>
          <div className="context-menu-divider" style={{ borderBottom: '1px solid var(--border-subtle)', margin: '4px 0' }} />
          <div className="context-menu-item" onClick={() => handleAction('insert-col-left')}>向左插入列</div>
          <div className="context-menu-item" onClick={() => handleAction('insert-col-right')}>向右插入列</div>
          <div className="context-menu-divider" style={{ borderBottom: '1px solid var(--border-subtle)', margin: '4px 0' }} />
          <div className="context-menu-item" onClick={() => handleAction('clear-cell')} style={{ color: 'var(--danger-color)' }}>清空内容 <span style={{ float: 'right', color: 'var(--danger-color)', opacity: 0.7 }}>Backspace</span></div>
          <div className="context-menu-item" onClick={() => handleAction('delete-row')} style={{ color: 'var(--danger-color)' }}>删除选中行</div>
          <div className="context-menu-item" onClick={() => handleAction('delete-col')} style={{ color: 'var(--danger-color)' }}>删除选中列</div>
        </>
      )}
    </div>
  );
};
