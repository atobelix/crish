/**
 * 输入区「+」菜单
 * 布局借鉴：主列条目 + 可选右侧展开面板（与项目选择列表同气质，非抄袭）
 * - 主列：图标 + 标题 + 副文案 + 箭头
 * - 展开：权限模式列表 / 协作者表单
 */
import React, { useEffect, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import {
  PERMISSION_MODES,
  permissionModeMeta,
  type PermissionMode,
} from '../api/permissionModes';
import {
  COLLABORATOR_MODES,
  type CollaboratorMode,
} from '../api/subagentApi';

export type ComposePlusPanel = 'root' | 'permission' | 'collaborator';

type Props = {
  open: boolean;
  onClose: () => void;
  /** 打开时默认展开的侧栏 */
  initialPanel?: ComposePlusPanel;
  permissionMode: PermissionMode;
  onPermissionMode: (m: PermissionMode) => void;
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
  permissionMode,
  onPermissionMode,
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

  useEffect(() => {
    if (!open) return;
    setPanel(initialPanel || 'root');
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

  if (!open) return null;

  const permMeta = permissionModeMeta(permissionMode);

  return (
    <div ref={rootRef} className="cplus-root" role="menu" aria-label="添加与工具">
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
            <Lucide.Paperclip size={15} strokeWidth={1.75} />
          </span>
          <span className="cplus-item-text">
            <span className="cplus-item-title">添加文件</span>
            <span className="cplus-item-desc">附件到当前消息</span>
          </span>
        </button>

        <button
          type="button"
          className={`cplus-item ${panel === 'collaborator' ? 'is-active' : ''}`}
          role="menuitem"
          onClick={() => setPanel(panel === 'collaborator' ? 'root' : 'collaborator')}
        >
          <span className="cplus-item-icon">
            <Lucide.Users size={15} strokeWidth={1.75} />
          </span>
          <span className="cplus-item-text">
            <span className="cplus-item-title">协作者</span>
            <span className="cplus-item-desc">并行子代理</span>
          </span>
          <Lucide.ChevronRight size={14} className="cplus-item-chev" />
        </button>

        <button
          type="button"
          className={`cplus-item ${panel === 'permission' ? 'is-active' : ''}`}
          role="menuitem"
          onClick={() => setPanel(panel === 'permission' ? 'root' : 'permission')}
        >
          <span className="cplus-item-icon">
            <Lucide.Shield size={15} strokeWidth={1.75} />
          </span>
          <span className="cplus-item-text">
            <span className="cplus-item-title">权限模式</span>
            <span className="cplus-item-desc">{permMeta.shortLabel}</span>
          </span>
          <Lucide.ChevronRight size={14} className="cplus-item-chev" />
        </button>
      </div>

      {panel === 'permission' ? (
        <div className="cplus-flyout" role="menu" aria-label="权限模式">
          <div className="cplus-flyout-head">
            <span>权限模式</span>
          </div>
          <div className="cplus-flyout-scroll">
            {PERMISSION_MODES.map((m) => {
              const active = permissionMode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  className={`cplus-fly-row ${active ? 'is-selected' : ''}`}
                  onClick={() => {
                    onPermissionMode(m.id);
                    onClose();
                  }}
                >
                  <span className="cplus-fly-icon">
                    <Lucide.CircleDot size={14} strokeWidth={1.75} />
                  </span>
                  <span className="cplus-fly-text">
                    <span className="cplus-fly-title">{m.label}</span>
                    <span className="cplus-fly-desc">{m.description}</span>
                  </span>
                  {active ? <Lucide.Check size={14} className="cplus-fly-check" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {panel === 'collaborator' ? (
        <div className="cplus-flyout cplus-flyout--wide" role="dialog" aria-label="协作者">
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
                      <Lucide.Search size={14} strokeWidth={1.75} />
                    ) : m.id === 'implement' ? (
                      <Lucide.Code2 size={14} strokeWidth={1.75} />
                    ) : (
                      <Lucide.CheckCircle2 size={14} strokeWidth={1.75} />
                    )}
                  </span>
                  <span className="cplus-fly-text">
                    <span className="cplus-fly-title">{m.label}</span>
                    <span className="cplus-fly-desc">{m.hint}</span>
                  </span>
                  {active ? <Lucide.Check size={14} className="cplus-fly-check" /> : null}
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
                  rows={3}
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
                  onClick={() => {
                    onSpawnCollaborator();
                  }}
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
