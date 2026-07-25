import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Lucide from 'lucide-react';
import styles from './ModelBadgePickerMenu.module.css';
import { activateProfileModel } from '../api/providerProfiles';
import { formatModelDisplayName, getModelMeta, listPickerProfiles } from '../api/modelCatalog';
import { openSettings } from '../api/storeAccess';

type Props = {
  activeModel?: string | null;
  onClose: () => void;
  open?: boolean;
  triggerRef?: React.RefObject<HTMLElement | null>;
};

import * as Popover from '@radix-ui/react-popover';

export const ModelBadgePickerMenu: React.FC<Props> = ({ activeModel, onClose, open = true }) => {
  const [hoveredProfileId, setHoveredProfileId] = useState<string | null>(null);
  const enterTimerRef = useRef<number | undefined>(undefined);
  const leaveTimerRef = useRef<number | undefined>(undefined);

  const handleRowEnter = useCallback((profileId: string) => {
    if (leaveTimerRef.current != null) clearTimeout(leaveTimerRef.current);
    enterTimerRef.current = window.setTimeout(() => {
      setHoveredProfileId(profileId);
    }, 80);
  }, []);

  const handleRowLeave = useCallback(() => {
    if (enterTimerRef.current != null) clearTimeout(enterTimerRef.current);
    leaveTimerRef.current = window.setTimeout(() => {
      setHoveredProfileId(null);
    }, 150);
  }, []);

  const profiles = listPickerProfiles().filter((p) => p.enabled !== false);

  return (
    <Popover.Portal>
      <Popover.Content
        asChild
        side="top"
        align="end"
        sideOffset={6}
        onEscapeKeyDown={onClose}
        onPointerDownOutside={onClose}
      >
        <div
          className={`${styles.mbMenu} modelBadgePickerMenu`}
          data-testid="model-picker-menu"
          role="menu"
          aria-label="选择模型服务商"
          style={{ zIndex: 99999 }}
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
                  onMouseEnter={() => handleRowEnter(p.id)}
                  onMouseLeave={handleRowLeave}
                >
                  <button
                    type="button"
                    className={`${styles.mbRow}${isHovered ? ` ${styles.isHovered}` : ''}`}
                    data-testid={`profile-item-${p.id}`}
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
                            data-testid={`model-option-${m}`}
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
      </Popover.Content>
    </Popover.Portal>
  );
};
