import React from 'react';
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink } from 'lucide-react';
import { Tooltip } from '../ui';
import styles from './LeafToolTabStrip.module.css';

export interface SidePanelNavToolbarProps {
  onRefresh?: () => void;
  onOpenExternal?: () => void;
}

export const SidePanelNavToolbar: React.FC<SidePanelNavToolbarProps> = ({
  onRefresh,
  onOpenExternal,
}) => {
  return (
    <div
      className={`${styles.toolbar} side-panel-toolbar`}
      role="toolbar"
      aria-label="视图导航"
      data-testid="side-panel-toolbar"
    >
      <div className={`${styles.toolbarNav} side-panel-toolbar-nav`}>
        <Tooltip content="后退" side="bottom">
          <button
            type="button"
            className={`${styles.toolbarBtn} side-panel-btn`}
            aria-label="后退"
            disabled
          >
            <ArrowLeft size={14} strokeWidth={1.8} />
          </button>
        </Tooltip>
        <Tooltip content="前进" side="bottom">
          <button
            type="button"
            className={`${styles.toolbarBtn} side-panel-btn`}
            aria-label="前进"
            disabled
          >
            <ArrowRight size={14} strokeWidth={1.8} />
          </button>
        </Tooltip>
        <Tooltip content="刷新" side="bottom">
          <button
            type="button"
            className={`${styles.toolbarBtn} side-panel-btn`}
            aria-label="刷新"
            onClick={onRefresh}
          >
            <RotateCw size={14} strokeWidth={2} />
          </button>
        </Tooltip>
      </div>
      <div className={`${styles.toolbarActions} side-panel-toolbar-actions`}>
        <Tooltip content="在浏览器中打开" side="bottom">
          <button
            type="button"
            className={`${styles.toolbarBtn} side-panel-btn`}
            aria-label="在浏览器中打开"
            onClick={onOpenExternal}
          >
            <ExternalLink size={14} strokeWidth={2} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
};
