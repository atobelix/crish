import React, { useCallback, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import styles from './ModelBadgePickerMenu.module.css';
import { activateProfileModel } from '../../api/providerProfiles';
import { formatModelDisplayName, getModelMeta, listPickerProfiles } from '../../api/modelCatalog';
import { openSettings } from '../../api/storeAccess';
import { Menu } from '../ui/Menu';

type Props = {
  activeModel?: string | null;
  onClose: () => void;
  open?: boolean;
  /** 真实触发器（模型徽标），用于锚定基座浮层（T05.3.2 由父级 Popover.Root 迁移） */
  children: React.ReactNode;
};

/**
 * 模型徽标下拉（T05.3.2 迁移到 ui/Menu 基座）：
 * - 自管 Popover.Root/Portal/Content 改为基座受控双模（open/onOpenChange）；
 * - 触发器由父级通过 children 传入，基座 cloneElement 注入防冒泡与开关；
 * - 保留 hover 级联（80ms/150ms 定时器）与 side/align 定位语义。
 */
export const ModelBadgePickerMenu: React.FC<Props> = ({
  activeModel,
  onClose,
  open = true,
  children,
}) => {
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
    <Menu
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      trigger={children}
      side="top"
      align="end"
      sideOffset={6}
      contentClassName={styles.mbMenu}
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
    </Menu>
  );
};
