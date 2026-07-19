import React, { useEffect, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './ModelBadgePickerMenu.module.css';
import { activateProfileModel } from '../api/providerProfiles';
import { formatModelDisplayName, getModelMeta, listPickerProfiles } from '../api/modelCatalog';
import { openSettings } from '../api/storeAccess';

type Props = {
  activeModel?: string | null;
  onClose: () => void;
};

export const ModelBadgePickerMenu: React.FC<Props> = ({ activeModel, onClose }) => {
  const [hoveredProfileId, setHoveredProfileId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const profiles = listPickerProfiles().filter((p) => p.enabled !== false);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      className={styles.mbMenu}
      role="menu"
      aria-label="选择模型服务商"
      onClick={(e) => e.stopPropagation()}
    >
      {profiles.length === 0 ? (
        <div className={styles.mbEmpty}>暂无可用服务商</div>
      ) : (
        profiles.map((p) => {
          const models = (p.models || []).filter((m) => {
            const meta = getModelMeta(p.id, m);
            return meta.enabled !== false;
          });
          const hasModels = models.length > 0;
          const isHovered = hoveredProfileId === p.id;

          return (
            <div
              key={p.id}
              className={styles.mbRowContainer}
              onMouseEnter={() => setHoveredProfileId(p.id)}
              onMouseLeave={() => setHoveredProfileId(null)}
            >
              <button
                type="button"
                className={`${styles.mbRow}${isHovered ? ` ${styles.isHovered}` : ''}`}
                aria-haspopup="true"
                aria-expanded={isHovered}
              >
                <span className={styles.mbRowText}>{p.name}</span>
                {hasModels && <Lucide.ChevronLeft size={14} className={styles.mbChevron} />}
              </button>

              {isHovered && hasModels && (
                <div
                  className={styles.mbSubMenu}
                  role="menu"
                  aria-label={`${p.name} 模型列表`}
                >
                  {models.map((m) => {
                    const isSelected = m === activeModel;
                    return (
                      <button
                        key={m}
                        type="button"
                        className={`${styles.mbSubRow}${isSelected ? ` ${styles.isSelected}` : ''}`}
                        onClick={async () => {
                          await activateProfileModel(p.id, m);
                          onClose();
                        }}
                      >
                        <span className={styles.mbSubRowText}>{formatModelDisplayName(p.id, m)}</span>
                        {isSelected && <Lucide.Check size={14} className={styles.mbCheck} />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })
      )}
      <div className={styles.mbDivider} />
      <button
        type="button"
        className={styles.mbManageBtn}
        onClick={() => {
          openSettings('models');
          onClose();
        }}
      >
        <Lucide.SlidersHorizontal size={12} className={styles.mbManageIcon} />
        <span>模型管理...</span>
      </button>
    </div>
  );
};
