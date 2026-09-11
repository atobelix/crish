import React from 'react';

import {
  removeProfile,
  setProfileEnabled,
  upsertProfile,
  type ProviderProfile,
} from '../../api/providerProfiles';
import { modelsCatalogStore } from '../../api/modelsCatalogStore';
import { Button, Input, Switch, Tooltip } from '../ui';
import { AppIcon } from '../ui/icons/index';

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
  setSelectedId: _setSelectedId,
}) => {
  return (
    <div
      className="mrd-head"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        gap: '12px',
        paddingBottom: '4px',
      }}
    >
      <div
        className="mrd-head-left"
        style={{ display: 'inline-flex', alignItems: 'center', gap: '10px' }}
      >
        {editingName && selected.id.startsWith('custom-') ? (
          <Input
            className="mrd-title"
            size="sm"
            value={nameDraft}
            autoFocus
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={async () => {
              const trimmed = nameDraft.trim();
              if (trimmed && trimmed !== selected.name) {
                upsertProfile({ ...selected, name: trimmed });
                await modelsCatalogStore.updateProvider(selected.id, {
                  displayName: trimmed,
                });
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
              borderBottom: '1px solid var(--border-color)',
              background: 'transparent',
              padding: '0',
              margin: '0',
              outline: 'none',
              fontSize: '16px',
              fontWeight: 600,
              letterSpacing: '-0.015em',
              color: 'var(--text-primary)',
              fontFamily: 'inherit',
              height: '28px',
              lineHeight: '28px',
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
                margin: 0,
                fontSize: '16px',
                fontWeight: 600,
                color: 'var(--text-primary)',
              }}
            >
              {selectedLabel}
            </h3>
          </Tooltip>
        ) : (
          <h3
            className="mrd-title"
            style={{
              margin: 0,
              fontSize: '16px',
              fontWeight: 600,
              color: 'var(--text-primary)',
            }}
          >
            {selectedLabel}
          </h3>
        )}
      </div>

      <div
        className="mrd-head-right"
        style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}
      >
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
                  icon={<AppIcon name="trash" size={14} />}
                />
              </Tooltip>
            )}
          </div>
        )}

        <Tooltip
          content={
            selected.enabled !== false
              ? '已启用（点击停用服务商）'
              : '已停用（点击启用服务商）'
          }
        >
          <Switch
            size="sm"
            checked={selected.enabled !== false}
            aria-label={selected.enabled !== false ? '停用服务商' : '启用服务商'}
            onCheckedChange={(checked) => {
              setProfileEnabled(selected.id, checked);
              refresh();
            }}
          />
        </Tooltip>
      </div>
    </div>
  );
};
