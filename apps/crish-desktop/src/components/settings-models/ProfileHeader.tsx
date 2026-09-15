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
import { prepareCatalogWrite } from './catalogWriteGate';
import styles from './ModelsSettingsTab.module.css';

/**
 * 详情头部：重命名标题 / 启用状态按钮 / 自定义服务商删除确认组。
 * 启用与删除以统一树为准（updateProvider / removeProvider），同时把旧档案
 * 存储的同名字段一并更新——它仍是扫描与连通性 IPC 的凭据载体。
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
  notify = () => {},
  setSelectedId: _setSelectedId,
}) => {
  const applyEnabled = async (enabled: boolean) => {
    const ready = await prepareCatalogWrite();
    if (!ready.ok) {
      notify(false, ready.error);
      return;
    }
    setProfileEnabled(selected.id, enabled);
    const res = await modelsCatalogStore.updateProvider(selected.id, {
      enabled,
    });
    if (!res.ok) notify(false, res.error || '服务商启用状态保存失败');
    refresh();
  };

  const applyRemove = async () => {
    const ready = await prepareCatalogWrite();
    if (!ready.ok) {
      notify(false, ready.error);
      return;
    }
    removeProfile(selected.id);
    const res = await modelsCatalogStore.removeProvider(selected.id);
    if (!res.ok) notify(false, res.error || '删除服务商失败');
    setConfirmDeleteId(null);
    refresh();
  };

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
                    void applyRemove();
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
              void applyEnabled(checked);
            }}
          />
        </Tooltip>
      </div>
    </div>
  );
};
