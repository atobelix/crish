import React, { useEffect } from 'react';
import * as Lucide from 'lucide-react';
import { RuntimePanel } from './RuntimePanel';

interface RuntimeFloatPanelProps {
  open: boolean;
  onClose: () => void;
  onShowToast: (msg: string) => void;
}

/** Compact floating sheet — no dimming mask, does not steal chat layout. */
export const RuntimeFloatPanel: React.FC<RuntimeFloatPanelProps> = ({
  open,
  onClose,
  onShowToast,
}) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="runtime-float-root runtime-float-root--compact" role="dialog" aria-label="运行状态">
      <div className="runtime-float-sheet runtime-float-sheet--compact">
        <div className="runtime-float-header">
          <div className="runtime-float-title">
            <Lucide.Activity size={14} />
            <span>运行状态</span>
          </div>
          <button type="button" className="header-btn" title="关闭" onClick={onClose}>
            <Lucide.X size={15} />
          </button>
        </div>
        <div className="runtime-float-body">
          <RuntimePanel wsId="float" onShowToast={onShowToast} />
        </div>
      </div>
    </div>
  );
};
