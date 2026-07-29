import React, { useCallback, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './ModelBadgePickerMenu.module.css';
import { activateProfileModel } from '../api/providerProfiles';
import { formatModelDisplayName, getModelMeta, listPickerProfiles } from '../api/modelCatalog';
import { openSettings } from '../api/storeAccess';
import * as Popover from '@radix-ui/react-popover';

type Props = {
  activeModel?: string | null;
  onClose: () => void;
  open?: boolean;
  triggerRef?: React.RefObject<HTMLElement | null>;
};

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

  if (!open) return null;

  return (
    <Popover.Portal>
      <Popover.Content
        className={`${styles.mbMenu} modelBadgePickerMenu no-drag`}
        side="top"
        align="end"
        sideOffset={6}
        avoidCollisions={true}
        collisionPadding={12}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        style={{ outline: 'none', pointerEvents: 'auto', zIndex: 'var(--z-settings-tooltip, 99999)' }}
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
      </Popover.Content>
    </Popover.Portal>
  );
};
