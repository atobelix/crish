/**
 * 模型配置文件 (models.yaml) 组合 Split Button（从 ModelsSettingsTab 拆出）：
 * 主按钮打开内置轻量 YAML 编辑器；下拉菜单提供外部编辑器（VS Code/Cursor/Zed/记事本等）、
 * 系统默认程序、资源管理器定位与复制绝对路径。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { getModelsCatalogPath } from '../../api/modelsCatalogStore';
import { useModelsCatalogVersion } from '../../hooks/useModelsCatalogVersion';
import {
  listHostOpeners,
  openPathDefault,
  openWithHostOpener,
  type HostOpener,
} from '../../api/hostOpenersApi';
import styles from './ModelsSettingsTab.module.css';
import yamlStyles from './YamlConfigEditorModal.module.css';
import { Button, Menu } from '../ui';
import type { SelectOptionItem } from '../ui';
import { getOpenerIcon } from '../files/FileActions';
import { AppIcon } from '../ui/icons/index';
import { useI18n } from '../../i18n';

type Props = {
  /** 打开内置 YAML 编辑器弹窗（弹窗本身由设置页持有）。 */
  onOpenBuiltinEditor: () => void;
  notify: (ok: boolean, msg: string) => void;
};

export const ModelsYamlConfigMenu: React.FC<Props> = ({
  onOpenBuiltinEditor,
  notify,
}) => {
  const { t } = useI18n();
  const [yamlMenuOpen, setYamlMenuOpen] = useState(false);
  const [availableOpeners, setAvailableOpeners] = useState<HostOpener[]>([]);
  const [systemFileManagerOpener, setSystemFileManagerOpener] =
    useState<HostOpener | null>(null);
  // 真源路径唯一定点 = 字典镜像（Rust workbench_read_models_yaml 返回）；
  // 订阅镜像版本号保证镜像重载后路径与回调同步更新
  useModelsCatalogVersion();
  const configFilePath = getModelsCatalogPath();

  // 扫描外部可用编辑器
  useEffect(() => {
    let active = true;
    listHostOpeners()
      .then((openers) => {
        if (!active) return;
        const fileManager =
          openers.find((o) => o.id === 'system-file-manager') ?? null;
        setSystemFileManagerOpener(fileManager);
        const filtered = openers.filter(
          (o) =>
            o.available &&
            (o.kind === 'editor' ||
              ['vscode', 'cursor', 'zed', 'windsurf', 'trae'].includes(o.id) ||
              o.id.includes('notepad'))
        );
        setAvailableOpeners(filtered);
      })
      .catch(() => {
        /* swallow-ok */
      });
    return () => {
      active = false;
    };
  }, []);

  // 调起指定外部编辑器
  const handleOpenExternal = useCallback(
    async (openerId: string) => {
      setYamlMenuOpen(false);
      try {
        await openWithHostOpener(openerId, configFilePath);
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? err.message
            : t('settings.models.yaml.openFailed');
        notify(false, msg);
      }
    },
    [configFilePath, notify, t]
  );

  // 调起系统默认程序
  const handleOpenDefault = useCallback(async () => {
    setYamlMenuOpen(false);
    try {
      await openPathDefault(configFilePath);
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : t('settings.models.yaml.openFailed');
      notify(false, msg);
    }
  }, [configFilePath, notify, t]);

  // 资源管理器定位
  const handleReveal = useCallback(async () => {
    setYamlMenuOpen(false);
    try {
      await openWithHostOpener('system-file-manager', configFilePath);
    } catch {
      try {
        await openPathDefault(configFilePath);
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? err.message
            : t('settings.models.yaml.revealFailed');
        notify(false, msg);
      }
    }
  }, [configFilePath, notify, t]);

  // 复制路径
  const handleCopyPath = useCallback(() => {
    setYamlMenuOpen(false);
    try {
      void navigator.clipboard.writeText(configFilePath);
      notify(true, t('settings.models.yaml.pathCopied'));
    } catch {
      notify(false, t('common.copyFailed'));
    }
  }, [configFilePath, notify, t]);

  // 外部菜单键盘选项定义
  const yamlMenuOptions: SelectOptionItem[] = [
    {
      id: 'builtin',
      label: t('settings.models.yaml.openBuiltin'),
      onClick: () => {
        setYamlMenuOpen(false);
        onOpenBuiltinEditor();
      },
    },
    ...availableOpeners.map((op) => ({
      id: op.id,
      label: op.displayName || op.label || op.id,
      onClick: () => void handleOpenExternal(op.id),
    })),
    {
      id: 'default',
      label: t('settings.models.yaml.openDefault'),
      onClick: () => void handleOpenDefault(),
    },
    {
      id: 'reveal',
      label: t('settings.models.yaml.reveal'),
      onClick: () => void handleReveal(),
    },
    {
      id: 'copy-path',
      label: t('settings.models.yaml.copyPath'),
      onClick: handleCopyPath,
    },
  ];

  return (
    <div className={yamlStyles.configButtonCombo}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        icon={
          <AppIcon
            name="file-code"
            size={13}
            className={styles.yamlConfigIcon}
            aria-hidden
          />
        }
        onClick={onOpenBuiltinEditor}
        aria-label={t('settings.models.yaml.editAria')}
      >
        {t('settings.models.yaml.configFile')}
      </Button>
      <Menu
        openState={{ open: yamlMenuOpen, onOpenChange: setYamlMenuOpen }}
        position={{ align: 'end', side: 'bottom', sideOffset: 4 }}
        options={yamlMenuOptions}
        panel={{ contentClassName: yamlStyles.yamlDropdownMenu }}
        trigger={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className={yamlStyles.configMenuTrigger}
            aria-label={t('settings.models.yaml.moreAria')}
            icon={<AppIcon name="chevron-down" size={13} aria-hidden />}
          />
        }
      >
        <div role="menu" aria-label={t('settings.models.yaml.menuAria')}>
          <div className={yamlStyles.menuSectionTitle}>
            {t('settings.models.yaml.configFile')}
          </div>
          <Button
            bare
            type="button"
            role="menuitem"
            className={yamlStyles.menuItemBtn}
            onClick={() => {
              setYamlMenuOpen(false);
              onOpenBuiltinEditor();
            }}
          >
            <AppIcon name="code" size={13} aria-hidden />
            <span>{t('settings.models.yaml.openBuiltin')}</span>
          </Button>

          <div className={yamlStyles.menuDivider} />
          <div className={yamlStyles.menuSectionTitle}>
            {t('settings.models.yaml.externalEditors')}
          </div>

          {availableOpeners.map((op) => (
            <Button
              bare
              key={op.id}
              type="button"
              role="menuitem"
              className={yamlStyles.menuItemBtn}
              onClick={() => void handleOpenExternal(op.id)}
            >
              {getOpenerIcon(op, 14)}
              <span className={yamlStyles.openerName}>
                {op.displayName || op.label || op.id}
              </span>
            </Button>
          ))}

          <Button
            bare
            type="button"
            role="menuitem"
            className={yamlStyles.menuItemBtn}
            onClick={() => void handleOpenDefault()}
          >
            <AppIcon name="app-window" size={13} aria-hidden />
            <span>{t('settings.models.yaml.openDefault')}</span>
          </Button>

          <div className={yamlStyles.menuDivider} />
          <div className={yamlStyles.menuSectionTitle}>
            {t('settings.models.yaml.fileActions')}
          </div>

          <Button
            bare
            type="button"
            role="menuitem"
            className={yamlStyles.menuItemBtn}
            onClick={() => void handleReveal()}
          >
            {systemFileManagerOpener?.iconDataUrl ? (
              <img
                src={systemFileManagerOpener.iconDataUrl}
                width={14}
                height={14}
                alt=""
                className={styles.openerIcon}
              />
            ) : (
              <AppIcon name="folder-open" size={13} aria-hidden />
            )}
            <span>{t('settings.models.yaml.reveal')}</span>
          </Button>

          <Button
            bare
            type="button"
            role="menuitem"
            className={yamlStyles.menuItemBtn}
            onClick={handleCopyPath}
          >
            <AppIcon name="copy" size={13} aria-hidden />
            <span>{t('settings.models.yaml.copyPath')}</span>
          </Button>
        </div>
      </Menu>
    </div>
  );
};
