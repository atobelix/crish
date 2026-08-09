import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as Lucide from 'lucide-react';
import {
  profileDisplayLabel,
  profileHasKey,
  type ProviderProfile,
} from '../../api/providerProfiles';
import { formatModelDisplayName } from '../../api/modelCatalog';
import styles from './ModelsSettingsTab.module.css';
import { Tooltip } from '../ui';

interface ModelsCascadeSelectProps {
  profiles: ProviderProfile[];
  activeProfileId: string;
  activeModelId: string;
  onChange: (profileId: string, modelId: string) => void;
}

export const ModelsCascadeSelect: React.FC<ModelsCascadeSelectProps> = ({
  profiles,
  activeProfileId,
  activeModelId,
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const [flyProfileId, setFlyProfileId] = useState<string | null>(null);
  const [pos, setPos] = useState<{ top: number; right: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const place = () => {
    if (!triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    setPos({
      top: r.bottom + 4,
      right: window.innerWidth - r.right,
      width: Math.max(r.width, 220),
    });
  };

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
      setFlyProfileId(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setFlyProfileId(null);
      }
    };
    const onReposition = (e?: Event) => {
      if (e?.target && menuRef.current?.contains(e.target as Node)) {
        return;
      }
      if (!triggerRef.current) return;
      const r = triggerRef.current.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) {
        setOpen(false);
        setFlyProfileId(null);
      } else {
        place();
      }
    };

    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [open, pos]);

  const enabledProfiles = useMemo(() => {
    return profiles.filter((p) => p.enabled !== false && p.models.length > 0);
  }, [profiles]);

  const activeProfile = enabledProfiles.find((p) => p.id === activeProfileId);
  const activeLabel =
    activeProfile && activeModelId
      ? `${profileDisplayLabel(activeProfile).replace(/\s*\/\s*默认$/, '')} · ${formatModelDisplayName(
          activeProfile.id,
          activeModelId
        )}`
      : '请选择默认模型...';

  const flyProfile = enabledProfiles.find((p) => p.id === flyProfileId);

  return (
    <div className={`settings-select ${open ? 'is-open' : ''}`} style={{ display: 'inline-block' }}>
      <button
        ref={triggerRef}
        type="button"
        className="settings-select-trigger"
        onClick={() => setOpen((prev) => !prev)}
        style={{ minWidth: '220px', justifyContent: 'space-between' }}
      >
        <span
          className="settings-select-value"
          style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}
        >
          {activeLabel}
        </span>
        <Lucide.ChevronDown size={14} style={{ opacity: 0.6, flexShrink: 0 }} />
      </button>

      {open && pos && createPortal(
        <div
          ref={menuRef}
          className="sort-filter-menu open"
          style={{
            position: 'fixed',
            top: pos.top,
            right: pos.right,
            width: pos.width,
            overflow: 'visible',
            zIndex: 'var(--z-model-flyout)',
          }}
          onMouseLeave={() => setFlyProfileId(null)}
          onWheel={(e) => e.stopPropagation()}
        >
          <div className="sort-filter-menu-title">选择服务商与模型</div>
          {enabledProfiles.length === 0 ? (
            <div className="sort-filter-option" style={{ color: 'var(--text-tertiary)', cursor: 'default' }}>
              暂无已启用的可用模型
            </div>
          ) : (
            enabledProfiles.map((p) => {
              const isFly = flyProfileId === p.id;
              const isCurrentActive = p.id === activeProfileId;
              const cleanLabel = profileDisplayLabel(p).replace(/\s*\/\s*默认$/, '');

              return (
                <div
                  key={p.id}
                  className={`sort-filter-row ${isFly ? 'is-open' : ''}`}
                  onMouseEnter={() => setFlyProfileId(p.id)}
                  style={{ position: 'relative', cursor: 'pointer' }}
                >
                  <span
                    className="sort-filter-row-label"
                    style={{ fontWeight: isCurrentActive ? '500' : 'normal' }}
                  >
                    {cleanLabel}
                  </span>
                  <Lucide.ChevronRight size={14} className="sort-filter-chev" />

                  {isFly && flyProfile && flyProfile.id === p.id && (
                    <div
                      className="sort-filter-flyout"
                      style={{
                        position: 'absolute',
                        right: 'calc(100% + 6px)',
                        top: 0,
                        minWidth: '180px',
                        maxHeight: '280px',
                        overflowY: 'auto',
                        overscrollBehavior: 'contain',
                        zIndex: 'var(--z-model-flyout)',
                      }}
                      onWheel={(e) => e.stopPropagation()}
                    >
                      {flyProfile.models.map((m) => {
                        const selected =
                          p.id === activeProfileId && m === activeModelId;
                        return (
                          <button
                            key={m}
                            type="button"
                            className={`sort-filter-option ${selected ? 'is-on' : ''}`}
                            onClick={() => {
                              onChange(p.id, m);
                              setOpen(false);
                              setFlyProfileId(null);
                            }}
                          >
                            <span
                              style={{
                                textOverflow: 'ellipsis',
                                overflow: 'hidden',
                                whiteSpace: 'nowrap',
                                flex: 1,
                              }}
                            >
                              {formatModelDisplayName(p.id, m)}
                            </span>
                            {selected && (
                              <Lucide.Check size={14} className="sort-filter-check" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>,
        document.body
      )}
    </div>
  );
};

interface ModelProfileListProps {
  profiles: ProviderProfile[];
  selectedId: string | null;
  onSelectProfile: (id: string) => void;
}

export const ModelProfileList: React.FC<ModelProfileListProps> = ({
  profiles,
  selectedId,
  onSelectProfile,
}) => {
  return (
    <aside className={`${styles.modelsRail} models-rail`} aria-label="服务商列表">
      <div className={`${styles.mrlHeader} mrl-header`}>
        <h3 className="settings-ui-section-title">AI 服务商</h3>
      </div>

      <div className={`${styles.mrlList} mrl-list`} role="list">
        {profiles.length === 0 ? (
          <div className={`${styles.mrlEmpty} mrl-empty`}>还没有服务商</div>
        ) : (
          profiles.map((p) => {
            const isActive = p.id === selectedId;
            const label = profileDisplayLabel(p);
            const keyOk = profileHasKey(p);
            const enabled = p.enabled !== false;

            return (
              <button
                key={p.id}
                type="button"
                role="listitem"
                className={`${styles.mrlItem} mrl-item ${isActive ? styles.isActive + ' is-active' : ''}`}
                aria-current={isActive ? 'true' : undefined}
                onClick={() => onSelectProfile(p.id)}
              >
                <div className={`${styles.mrlItemRowTop} mrl-item-row-top`}>
                  <Tooltip content={label}>
                    <span className={`${styles.mrlItemName} mrl-item-name`}>
                      {label}
                    </span>
                  </Tooltip>
                  <Tooltip content={!keyOk ? '缺少密钥' : !enabled ? '已停用' : '已配置并启用'}>
                    <span
                      className={`${styles.mrlItemDot} mrl-item-dot`}
                      style={{
                        background: !keyOk ? 'var(--color-warning)' : !enabled ? 'var(--text-tertiary)' : 'var(--color-active)',
                        opacity: !enabled ? 0.6 : 1,
                      }}
                    />
                  </Tooltip>
                </div>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
};
