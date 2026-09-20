import React from 'react';

import { Tooltip, Button } from '../ui';
import styles from './LeafToolTabStrip.module.css';
import { AppIcon } from '../ui/icons/index';

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
          <Button
            type="button"
            variant="ghost"
            className={`${styles.toolbarBtn} side-panel-btn`}
            aria-label="后退"
            aria-disabled="true"
          >
            <AppIcon name="arrow-left" size={14} />
          </Button>
        </Tooltip>
        <Tooltip content="前进" side="bottom">
          <Button
            type="button"
            variant="ghost"
            className={`${styles.toolbarBtn} side-panel-btn`}
            aria-label="前进"
            aria-disabled="true"
          >
            <AppIcon name="arrow-right" size={14} />
          </Button>
        </Tooltip>
        <Tooltip content="刷新" side="bottom">
          <Button
            type="button"
            variant="ghost"
            className={`${styles.toolbarBtn} side-panel-btn`}
            aria-label="刷新"
            onClick={onRefresh}
          >
            <AppIcon name="rotate-cw" size={14} />
          </Button>
        </Tooltip>
      </div>
      <div className={`${styles.toolbarActions} side-panel-toolbar-actions`}>
        <Tooltip content="在浏览器中打开" side="bottom">
          <Button
            type="button"
            variant="ghost"
            className={`${styles.toolbarBtn} side-panel-btn`}
            aria-label="在浏览器中打开"
            onClick={onOpenExternal}
          >
            <AppIcon name="external-link" size={14} />
          </Button>
        </Tooltip>
      </div>
    </div>
  );
};
