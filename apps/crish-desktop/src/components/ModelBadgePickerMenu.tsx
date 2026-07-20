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

export const ModelBadgePickerMenu: React.FC<Props> = ({ activeModel, onClose, open = true, triggerRef }) => {
  const [hoveredProfileId, setHoveredProfileId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const enterTimerRef = useRef<number>();
  const leaveTimerRef = useRef<number>();
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const handleRowEnter = useCallback((profileId: string) => {
    clearTimeout(leaveTimerRef.current);
    enterTimerRef.current = window.setTimeout(() => {
      setHoveredProfileId(profileId);
    }, 80);
  }, []);

  const handleRowLeave = useCallback(() => {
    clearTimeout(enterTimerRef.current);
    leaveTimerRef.current = window.setTimeout(() => {
      setHoveredProfileId(null);
    }, 150);
  }, []);

  const profiles = listPickerProfiles().filter((p) => p.enabled !== false);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => {
      const first = rootRef.current?.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      first?.focus();
    });
  }, [open]);

  const restoreFocus = useCallback(() => {
    const target = triggerRef?.current || restoreFocusRef.current;
    requestAnimationFrame(() => target?.focus());
  }, [triggerRef]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onClose();
        restoreFocus();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        restoreFocus();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose, restoreFocus]);

  const [pos, setPos] = useState<{ right: number; bottom: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const triggerEl = triggerRef?.current || document.activeElement;
    if (!triggerEl) return;
    const r = triggerEl.getBoundingClientRect();
    setPos({
      right: window.innerWidth - r.right,
      bottom: window.innerHeight - r.top + 6,
    });
  }, [open, triggerRef]);

  useEffect(() => {
    if (!open) return;
    const triggerEl = triggerRef?.current || document.activeElement;
    if (!triggerEl) return;
    const updatePos = () => {
      const rect = triggerEl.getBoundingClientRect();
      setPos({ right: window.innerWidth - rect.right, bottom: window.innerHeight - rect.top + 6 });
    };
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', updatePos, true);
    return () => {
      window.removeEventListener('resize', updatePos);
      window.removeEventListener('scroll', updatePos, true);
    };
  }, [open, triggerRef]);

  if (!pos) return null;

  return createPortal(
    <div
      ref={rootRef}
      className={styles.mbMenu}
      role="menu"
      aria-label="选择模型服务商"
      onClick={(e) => e.stopPropagation()}
      style={{ position: 'fixed', right: pos.right, bottom: pos.bottom }}
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
                          restoreFocus();
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
          restoreFocus();
        }}
      >
        <Lucide.SlidersHorizontal size={12} className={styles.mbManageIcon} />
        <span>模型管理...</span>
      </button>
    </div>,
    document.body,
  );
};
