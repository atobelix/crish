import React from 'react';
import { Globe, FolderTree } from 'lucide-react';
import styles from './LeafToolTabStrip.module.css';

export interface SidePanelLauncherHubProps {
  onOpenPanel: (panelId: string) => void;
}

export const SidePanelLauncherHub: React.FC<SidePanelLauncherHubProps> = ({ onOpenPanel }) => {
  return (
    <div
      className={`${styles.launcherHubWrapper} side-panel-launcher-hub-wrapper`}
      data-testid="side-panel-launcher-hub-wrapper"
    >
      <div
        className={`${styles.launcherHub} side-panel-launcher-hub`}
        data-testid="side-panel-launcher-hub"
      >
        <div className={`${styles.launcherCardsGroup} launcher-cards-group`}>
          <button
            type="button"
            className={`${styles.launcherCard} side-panel-launcher-card`}
            onClick={() => onOpenPanel('preview')}
            data-testid="launcher-card-preview"
          >
            <div className={`${styles.launcherCardIconBox} launcher-card-icon-box`}>
              <Globe size={16} strokeWidth={1.8} />
            </div>
            <div className={styles.launcherCardText}>
              <span className={`${styles.launcherCardTitle} launcher-card-title`}>
                应用预览
              </span>
              <span className={styles.launcherCardDesc}>
                在右侧实时预览当前 Web / 桌面应用
              </span>
            </div>
          </button>
          <button
            type="button"
            className={`${styles.launcherCard} side-panel-launcher-card`}
            onClick={() => onOpenPanel('files')}
            data-testid="launcher-card-files"
          >
            <div className={`${styles.launcherCardIconBox} launcher-card-icon-box`}>
              <FolderTree size={16} strokeWidth={1.8} />
            </div>
            <div className={styles.launcherCardText}>
              <span className={`${styles.launcherCardTitle} launcher-card-title`}>
                文件
              </span>
              <span className={styles.launcherCardDesc}>
                浏览项目工作区目录树、编辑与代码预览
              </span>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
};
