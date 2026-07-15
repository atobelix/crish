/**
 * 输入区「+」菜单：附件等轻量动作。
 * 协作 agent 由主 AI 自动拉起（run_subagent），不在此手动配置。
 */
import React, { useEffect, useRef } from 'react';
import * as Lucide from 'lucide-react';

type Props = {
  open: boolean;
  onClose: () => void;
  onAddFiles: () => void;
};

export const ComposePlusMenu: React.FC<Props> = ({ open, onClose, onAddFiles }) => {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div ref={rootRef} className="cplus-root cplus-root--slim" role="menu" aria-label="添加">
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
            <span className="cplus-item-desc">附带到本条消息</span>
          </span>
        </button>
        <button
          type="button"
          className="cplus-item"
          role="menuitem"
          onClick={() => {
            onClose();
            window.dispatchEvent(
              new CustomEvent('crish-open-agent-panel', { detail: {} }),
            );
          }}
        >
          <span className="cplus-item-icon">
            <Lucide.Bot size={16} strokeWidth={1.75} />
          </span>
          <span className="cplus-item-text">
            <span className="cplus-item-title">智能体面板</span>
            <span className="cplus-item-desc">查看自动协作，或临时追问</span>
          </span>
        </button>
      </div>
    </div>
  );
};
