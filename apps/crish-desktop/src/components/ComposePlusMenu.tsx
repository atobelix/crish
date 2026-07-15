/**
 * 输入区「+」菜单：仅附件与协作；权限在独立控件。
 * 带箭头项 hover 即展开级联子面板。
 */
import React, { useEffect, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import {
  COLLABORATOR_MODES,
  type CollaboratorMode,
} from '../api/subagentApi';

export type ComposePlusPanel = 'root' | 'collaborator';

type Props = {
  open: boolean;
  onClose: () => void;
  initialPanel?: ComposePlusPanel;
  onAddFiles: () => void;
  collabMode: CollaboratorMode;
  onCollabMode: (m: CollaboratorMode) => void;
  collabDesc: string;
  onCollabDesc: (v: string) => void;
  collabTask: string;
  onCollabTask: (v: string) => void;
  collabBusy: boolean;
  onSpawnCollaborator: () => void;
};

export const ComposePlusMenu: React.FC<Props> = ({
  open,
  onClose,
  initialPanel = 'root',
  onAddFiles,
  collabMode,
  onCollabMode,
  collabDesc,
  onCollabDesc,
  collabTask,
  onCollabTask,
  collabBusy,
  onSpawnCollaborator,
}) => {
  const [panel, setPanel] = useState<ComposePlusPanel>('root');
  const rootRef = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    setPanel(initialPanel === 'collaborator' ? 'collaborator' : 'root');
  }, [open, initialPanel]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (panel !== 'root') setPanel('root');
        else onClose();
      }
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, panel]);

  const clearLeave = () => {
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  };

  const scheduleRoot = () => {
    clearLeave();
    leaveTimer.current = setTimeout(() => setPanel('root'), 140);
  };

  if (!open) return null;

  return (
    <div
      ref={rootRef}
      className="cplus-root cplus-root--slim"
      role="menu"
      aria-label="添加"
      onMouseLeave={scheduleRoot}
      onMouseEnter={clearLeave}
    >
      <div className="cplus-main">
        <button
          type="button"
          className="cplus-item"
          role="menuitem"
          onClick={() => {
            onAddFiles();
            onClose();
          }}
        >
          <span className="cplus-item-icon">
            <Lucide.Paperclip size={16} strokeWidth={1.75} />
          </span>
          <span className="cplus-item-text">
            <span className="cplus-item-title">添加文件</span>
          </span>
        </button>

        <button
          type="button"
          className={`cplus-item ${panel === 'collaborator' ? 'is-active' : ''}`}
          role="menuitem"
          onMouseEnter={() => {
            clearLeave();
            setPanel('collaborator');
          }}
          onClick={() => setPanel('collaborator')}
        >
          <span className="cplus-item-icon">
            <Lucide.Users size={16} strokeWidth={1.75} />
          </span>
          <span className="cplus-item-text">
            <span className="cplus-item-title">协作者</span>
          </span>
          <Lucide.ChevronRight size={14} className="cplus-item-chev" />
        </button>
      </div>

      {panel === 'collaborator' ? (
        <div
          className="cplus-flyout cplus-flyout--wide"
          role="dialog"
          aria-label="协作者"
          onMouseEnter={clearLeave}
        >
          <div className="cplus-flyout-head">
            <span>协作者</span>
          </div>
          <div className="cplus-flyout-scroll">
            <div className="cplus-section-label">模式</div>
            {COLLABORATOR_MODES.map((m) => {
              const active = collabMode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  className={`cplus-fly-row ${active ? 'is-selected' : ''}`}
                  onClick={() => onCollabMode(m.id)}
                >
                  <span className="cplus-fly-icon">
                    {m.id === 'research' ? (
                      <Lucide.Search size={16} strokeWidth={1.75} />
                    ) : m.id === 'implement' ? (
                      <Lucide.Code2 size={16} strokeWidth={1.75} />
                    ) : (
                      <Lucide.CheckCircle2 size={16} strokeWidth={1.75} />
                    )}
                  </span>
                  <span className="cplus-fly-text">
                    <span className="cplus-fly-title">{m.label}</span>
                    <span className="cplus-fly-desc">{m.hint}</span>
                  </span>
                  {active ? <Lucide.Check size={16} className="cplus-fly-check" /> : null}
                </button>
              );
            })}

            <div className="cplus-form">
              <label className="cplus-field">
                <span>名称（可选）</span>
                <input
                  value={collabDesc}
                  onChange={(e) => onCollabDesc(e.target.value)}
                  placeholder="简短名称"
                />
              </label>
              <label className="cplus-field">
                <span>任务</span>
                <textarea
                  rows={2}
                  value={collabTask}
                  onChange={(e) => onCollabTask(e.target.value)}
                  placeholder="要协作完成的事"
                />
              </label>
              <div className="cplus-form-actions">
                <button type="button" className="cplus-btn ghost" onClick={onClose}>
                  取消
                </button>
                <button
                  type="button"
                  className="cplus-btn primary"
                  disabled={collabBusy || !collabTask.trim()}
                  onClick={() => onSpawnCollaborator()}
                >
                  {collabBusy ? '启动中…' : '启动'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};
