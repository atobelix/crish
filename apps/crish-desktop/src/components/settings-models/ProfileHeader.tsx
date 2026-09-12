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
import styles from './ModelsSettingsTab.module.css';

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
    <div className={styles.mrdHead}>
      <div className={styles.mrdHeadLeft}>
        {editingName && selected.id.startsWith('custom-') ? (
          <Input
            className={styles.nameEditInput}
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
            
          />
        ) : selected.id.startsWith('custom-') ? (
          <Tooltip content="点击重命名服务商">
            <h3
              className={styles.mrdTitleClickable}
              onClick={() => {
                setEditingName(true);
                setNameDraft(selected.name);
              }}
            >
              {selectedLabel}
            </h3>
          </Tooltip>
        ) : (
          <h3 className={styles.mrdTitle}>{selectedLabel}</h3>
        )}
      </div>

      <div className={styles.mrdHeadRight}>
        {selected.id.startsWith('custom-') && (
          <div className={styles.mrdDeleteAnchor}>
            {confirmDeleteId === selected.id ? (
              <div className={styles.confirmDeleteBubble}>
                <span className={styles.confirmDeletePrompt}>确定删除？</span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className={styles.confirmDeleteBtn}
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
                  className={styles.confirmDeleteBtn}
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
                  className={styles.deleteTriggerBtn}
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
