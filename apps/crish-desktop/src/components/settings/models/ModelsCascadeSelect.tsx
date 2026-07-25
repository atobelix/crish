import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { profileDisplayLabel, formatModelDisplayName, type ProviderProfile } from '../../../api/providerProfiles';

interface ModelsCascadeSelectProps {
  profiles: ProviderProfile[];
  activeProfileId: string;
  activeModelId: string;
  onChange: (profileId: string, modelId: string) => void;
}

export const ModelsCascadeSelect: React.FC<ModelsCascadeSelectProps> = React.memo(({
  profiles, activeProfileId, activeModelId, onChange,
}) => {
  const [open, setOpen] = useState(false);
  const [flyProfileId, setFlyProfileId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const enabledProfiles = useMemo(() => profiles.filter((p) => p.enabled !== false && p.models.length > 0), [profiles]);
  const activeProfile = enabledProfiles.find((p) => p.id === activeProfileId);
  const activeLabel = activeProfile && activeModelId
    ? `${profileDisplayLabel(activeProfile).replace(/\s*\/\s*默认$/, '')} · ${formatModelDisplayName(activeProfile.id, activeModelId)}`
    : '请选择默认模型...';

  useLayoutEffect(() => { if (!open) setFlyProfileId(null); }, [open]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false); setFlyProfileId(null);
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setFlyProfileId(null); } };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => { document.removeEventListener('mousedown', onMouseDown); document.removeEventListener('keydown', onKeyDown, true); };
  }, [open]);

  return (
    <div className={`settings-select ${open ? 'is-open' : ''}`} style={{ display: 'inline-block' }}>
      <button ref={triggerRef} type="button" className="settings-select-trigger"
        onClick={() => setOpen((prev) => !prev)} style={{ minWidth: '220px', justifyContent: 'space-between' }}>
        <span className="settings-select-value" style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>{activeLabel}</span>
        <ChevronDown size={14} style={{ opacity: 0.6, flexShrink: 0 }} />
      </button>
      {open && createPortal(
        <div ref={menuRef} className="sort-filter-menu open" style={{ position: 'fixed', top: (triggerRef.current?.getBoundingClientRect().bottom ?? 0) + 4, left: triggerRef.current?.getBoundingClientRect().left, minWidth: '220px', zIndex: 'var(--z-model-flyout)' }} onMouseLeave={() => setFlyProfileId(null)}>
          <div className="sort-filter-menu-title">选择服务商与模型</div>
          {enabledProfiles.length === 0 ? (
            <div className="sort-filter-option" style={{ color: 'var(--text-tertiary)', cursor: 'default' }}>暂无已启用的可用模型</div>
          ) : enabledProfiles.map((p) => {
            const isFly = flyProfileId === p.id;
            const isCurrentActive = p.id === activeProfileId;
            const cleanLabel = profileDisplayLabel(p).replace(/\s*\/\s*默认$/, '');
            return (
              <div key={p.id} className={`sort-filter-row ${isFly ? 'is-open' : ''}`}
                onMouseEnter={() => setFlyProfileId(p.id)} style={{ position: 'relative', cursor: 'pointer' }}>
                <span className="sort-filter-row-label" style={{ fontWeight: isCurrentActive ? '500' : 'normal' }}>{cleanLabel}</span>
                <ChevronRight size={14} className="sort-filter-chev" />
                {isFly && (
                  <div className="sort-filter-flyout" style={{ position: 'absolute', left: '100%', top: 0, minWidth: '180px', maxHeight: '280px', overflowY: 'auto', zIndex: 'var(--z-model-flyout)' }}>
                    {p.models.map((m) => {
                      const selected = p.id === activeProfileId && m === activeModelId;
                      return (
                        <button key={m} type="button" className={`sort-filter-option ${selected ? 'is-on' : ''}`}
                          onClick={() => { onChange(p.id, m); setOpen(false); setFlyProfileId(null); }}>
                          <span style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', flex: 1 }}>{formatModelDisplayName(p.id, m)}</span>
                          {selected && <Check size={14} className="sort-filter-check" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>, document.body
      )}
    </div>
  );
});
