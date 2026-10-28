/**
 * 设置 · 安全：权限模式卡片组配置
 *
 * 架构铁律：
 * 1. 严格收敛为三选项：ask (每次询问) | smart (智能放行) | full (完全允许)；
 * 2. 彻底移除已失效的白名单编辑、命令增删与工作区路径展示；
 * 3. 采用现代化单选卡片组（Radio Cards），直观展示安全模式与核心语义。
 */

import React, { useMemo } from 'react';
import styles from './SettingsSecurityTab.module.css';
import { SettingsPage, SettingsSection } from './SettingsUI';
import { usePermissionStore } from '../../store/storeAccess';
import {
  PERMISSION_MODES,
  coercePermissionMode,
} from '../../api/permissionModes';
import { Button } from '@/components/ui/Button';
import { AppIcon } from '@/components/ui/icons';
import { useI18n } from '../../i18n';

export const SettingsSecurityTab: React.FC = () => {
  const { t } = useI18n();
  const permissionModeRaw = usePermissionStore((s) => s.permissionMode);
  const setPermissionMode = usePermissionStore((s) => s.setPermissionMode);

  const permissionMode = useMemo(() => {
    return coercePermissionMode(permissionModeRaw);
  }, [permissionModeRaw]);

  return (
    <SettingsPage title={t('nav.security', '安全')}>
      <SettingsSection
        title={t('settings.security.permissionSection', '权限模式')}
      >
        <p className={styles.sectionDesc}>
          {t(
            'settings.security.permissionSectionDesc',
            '配置 AI 执行文件读写、修改及终端命令时的安全拦截策略'
          )}
        </p>
        <div
          className={styles.modeCardGroup}
          role="radiogroup"
          aria-label={t('settings.security.permissionModeAria', '执行权限模式')}
        >
          {PERMISSION_MODES.map((meta) => {
            const isSelected = meta.id === permissionMode;
            return (
              <Button
                variant="unstyled"
                key={meta.id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                className={`${styles.modeCard} ${isSelected ? styles.isSelected : ''}`}
                onClick={() => setPermissionMode(meta.id)}
              >
                <div className={styles.cardHeader}>
                  <div
                    className={styles.iconBox}
                    style={{ color: meta.accent }}
                  >
                    <AppIcon name={meta.iconName} size={18} />
                  </div>
                  <div className={styles.cardTitleRow}>
                    <span className={styles.cardTitle}>{meta.label}</span>
                    {meta.isRecommended && (
                      <span className={styles.recommendTag}>
                        {t('common.recommended', '推荐')}
                      </span>
                    )}
                  </div>
                  <div className={styles.radioCircle}>
                    {isSelected && <div className={styles.radioDot} />}
                  </div>
                </div>
                <p className={styles.cardDesc}>{meta.description}</p>
              </Button>
            );
          })}
        </div>
      </SettingsSection>
    </SettingsPage>
  );
};
