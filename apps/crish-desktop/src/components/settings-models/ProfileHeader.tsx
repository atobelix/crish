import React from 'react';
import * as Lucide from 'lucide-react';
import {
  removeProfile,
  setProfileEnabled,
  upsertProfile,
  type ProviderProfile,
} from '../../api/providerProfiles';
import { Button, Tooltip } from '../ui';

/**
 * 详情头部：重命名标题 / 启用状态按钮 / 自定义服务商删除确认组。
 */
export const ProfileHeader: React.FC<{
  selected: ProviderProfile;
  selectedLabel: string;
  editingName: boolean;
  nameDraft: string;
  setNameDraft: (val: string) => void;
  setEditingName: (val: boolean) => void;
  confirmDeleteId: string | null;
  setConfirmDeleteId: (id: string | null) => void;
  refresh: () => void;
  notify?: (ok: boolean, text: string) => void;
  setProfiles?: (profiles: ProviderProfile[]) => void;
  setSelectedId?: (id: string | null) => void;
}> = ({
  selected,
  selectedLabel,
  editingName,
  nameDraft,
  setNameDraft,
  setEditingName,
  confirmDeleteId,
  setConfirmDeleteId,
  refresh,
  notify: _notify,
  setProfiles,
  setSelectedId,
}) => {
  return (
    <div className="mrd-head">
      <div
        className="mrd-head-left"
        style={{ display: 'inline-flex', alignItems: 'center' }}
      >
        {editingName && selected.id.startsWith('custom-') ? (
          <input
            className="mrd-title"
            value={nameDraft}
            autoFocus
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => {
              if (nameDraft.trim() && nameDraft.trim() !== selected.name) {
                upsertProfile({ ...selected, name: nameDraft.trim() });
                refresh();
              }
              setEditingName(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === 'Escape') {
                setEditingName(false);
              }
            }}
            style={{
              border: 'none',
              borderBottom: '1px dashed var(--accent-primary)',
              background: 'transparent',
              padding: '0',
              margin: '0',
              outline: 'none',
              fontSize: '15px',
              fontWeight: 600,
              letterSpacing: '-0.015em',
              color: 'var(--text-primary)',
              fontFamily: 'inherit',
              height: '27px',
              lineHeight: '27px',
            }}
          />
        ) : selected.id.startsWith('custom-') ? (
          <Tooltip content="点击重命名服务商">
            <h3
              className="mrd-title"
              onClick={() => {
                setEditingName(true);
                setNameDraft(selected.name);
              }}
              style={{
                cursor: 'pointer',
                borderBottom: '1px dashed var(--border-subtle)',
                transition: 'border-color 0.15s ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--text-secondary)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-subtle)';
              }}
            >
              {selectedLabel}
            </h3>
          </Tooltip>
        ) : (
          <h3 className="mrd-title">{selectedLabel}</h3>
        )}
      </div>
      <div
        className="mrd-head-right"
        style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
      >
        <Button
          type="button"
          size="sm"
          style={{
            height: '26px',
            padding: '0 10px',
            fontSize: '12px',
            fontWeight: 500,
            borderRadius: '6px',
            border:
              selected.enabled !== false
                ? '1px solid color-mix(in srgb, var(--color-active) 30%, transparent)'
                : '1px solid var(--border-subtle)',
            background:
              selected.enabled !== false
                ? 'color-mix(in srgb, var(--color-active) 12%, transparent)'
                : 'var(--tint-hover)',
            color:
              selected.enabled !== false
                ? 'var(--color-active)'
                : 'var(--text-tertiary)',
            cursor: 'pointer',
            transition: 'all 0.15s ease',
          }}
          onClick={() => {
            setProfileEnabled(selected.id, selected.enabled === false);
            refresh();
          }}
        >
          {selected.enabled !== false ? '已启用' : '已停用'}
        </Button>

        {selected.id.startsWith('custom-') && (
          <div style={{ position: 'relative' }}>
            {confirmDeleteId === selected.id ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: '8px',
                  padding: '4px 8px',
                  whiteSpace: 'nowrap',
                  zIndex: 'var(--z-card-footer)',
                }}
              >
                <span
                  style={{
                    fontSize: '12px',
                    color: 'var(--text-secondary)',
                  }}
                >
                  确定删除？
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  style={{
                    height: '24px',
                    padding: '0 8px',
                    fontSize: '11px',
                    borderRadius: '5px',
                  }}
                  onClick={() => {
                    const next = removeProfile(selected.id);
                    setProfiles?.(next);
                    setSelectedId?.(next[0]?.id || null);
                    setConfirmDeleteId(null);
                  }}
                >
                  确认
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  style={{
                    height: '24px',
                    padding: '0 8px',
                    fontSize: '11px',
                    borderRadius: '5px',
                  }}
                  onClick={() => setConfirmDeleteId(null)}
                >
                  取消
                </Button>
              </div>
            ) : (
              <Tooltip content={`删除「${selectedLabel}」`}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  style={{
                    padding: '0 6px',
                    height: '28px',
                    color: 'var(--text-tertiary)',
                  }}
                  onClick={() => setConfirmDeleteId(selected.id)}
                  icon={<Lucide.Trash2 size={14} />}
                />
              </Tooltip>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
