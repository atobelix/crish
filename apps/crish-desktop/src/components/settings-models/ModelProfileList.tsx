/**
 * apps/crish-desktop/src/components/settings-models/ModelProfileList.tsx
 *
 * ModelProfileList: 左侧 AI 服务商导航轨栏，平滑展示启用/停用与密钥状态。
 * 名单只来自统一树 providers 面（listLiveProviders），启用状态读 provider.enabled，
 * 密钥状态读快照 credentialStates[providerId].hasKey；不读旧档案存储。
 * （全局默认模型级联选择器见 ModelsCascadeSelect.tsx。）
 */

import React, { useMemo } from 'react';
import { listLiveProviders, providerHasKey } from '../../api/modelsCatalogLive';
import { useModelsCatalogVersion } from '../../hooks/useModelsCatalogVersion';
import styles from './ModelsSettingsTab.module.css';
import { Button, Tooltip } from '../ui';
import { useI18n } from '../../i18n';

export { ModelsCascadeSelect } from './ModelsCascadeSelect';

interface ModelProfileListProps {
  selectedId: string | null;
  onSelectProfile: (id: string) => void;
}

export const ModelProfileList: React.FC<ModelProfileListProps> = ({
  selectedId,
  onSelectProfile,
}) => {
  const { t } = useI18n();
  const catalogVersion = useModelsCatalogVersion();
  const providers = useMemo(() => listLiveProviders(), [catalogVersion]);

  return (
    <aside
      className={`${styles.modelsRail} models-rail`}
      aria-label={t('settings.models.profileList.ariaList')}
    >
      <div className={`${styles.mrlList} mrl-list`} role="list">
        {providers.length === 0 ? (
          <div className={`${styles.mrlEmpty} mrl-empty`}>
            {t('settings.models.profileList.empty')}
          </div>
        ) : (
          providers.map(({ providerId, provider }) => {
            const isActive = providerId === selectedId;
            const label = provider.displayName?.trim() || providerId;
            const keyOk = providerHasKey(providerId);
            const enabled = provider.enabled !== false;

            return (
              <Button
                bare
                key={providerId}
                type="button"
                role="listitem"
                className={`${styles.mrlItem} mrl-item ${isActive ? styles.isActive + ' is-active' : ''}`}
                aria-current={isActive ? 'true' : undefined}
                onClick={() => onSelectProfile(providerId)}
              >
                <div className={`${styles.mrlItemRowTop} mrl-item-row-top`}>
                  <Tooltip content={label}>
                    <span className={`${styles.mrlItemName} mrl-item-name`}>
                      {label}
                    </span>
                  </Tooltip>
                  <Tooltip
                    content={
                      !keyOk
                        ? t('settings.models.profileList.missingKey')
                        : !enabled
                          ? t('settings.models.profileList.disabled')
                          : t('settings.models.profileList.ready')
                    }
                  >
                    <span
                      className={`${styles.mrlItemDot} mrl-item-dot ${
                        !keyOk
                          ? styles.mrlItemDotNoKey
                          : !enabled
                            ? styles.mrlItemDotDisabled
                            : styles.mrlItemDotOn
                      }`}
                    />
                  </Tooltip>
                </div>
              </Button>
            );
          })
        )}
      </div>
    </aside>
  );
};
