import React from 'react';
import { profileDisplayLabel, profileHasKey, type ProviderProfile } from '../../../api/providerProfiles';
import { Tooltip } from '../../Tooltip';
import styles from '../../ModelsSettingsTab.module.css';

interface ModelProviderListProps {
  profiles: ProviderProfile[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export const ModelProviderList: React.FC<ModelProviderListProps> = React.memo(({
  profiles, selectedId, onSelect,
}) => (
  <aside className={`${styles.modelsRail} models-rail`} aria-label="服务商列表">
    <div className={`${styles.mrlHeader} mrl-header`}>
      <h3 className="settings-ui-section-title">AI 服务商</h3>
    </div>
    <div className={`${styles.mrlList} mrl-list`} role="list">
      {profiles.length === 0 ? (
        <div className={`${styles.mrlEmpty} mrl-empty`}>还没有服务商</div>
      ) : profiles.map((p) => {
        const isActive = p.id === selectedId;
        const keyOk = profileHasKey(p);
        const enabled = p.enabled !== false;
        return (
          <button key={p.id} type="button" role="listitem"
            className={`${styles.mrlItem} mrl-item ${isActive ? styles.isActive + ' is-active' : ''}`}
            aria-current={isActive ? 'true' : undefined} onClick={() => onSelect(p.id)}>
            <div className={`${styles.mrlItemRowTop} mrl-item-row-top`}>
              <Tooltip content={profileDisplayLabel(p)}><span className={`${styles.mrlItemName} mrl-item-name`}>{profileDisplayLabel(p)}</span></Tooltip>
              <Tooltip content={!keyOk ? '缺少密钥' : !enabled ? '已停用' : '已配置并启用'}>
                <span className={`${styles.mrlItemDot} mrl-item-dot`}
                  style={{ background: !keyOk ? '#e6a817' : !enabled ? 'var(--text-tertiary)' : '#22c55e', opacity: !enabled ? 0.6 : 1 }} />
              </Tooltip>
            </div>
          </button>
        );
      })}
    </div>
  </aside>
));
