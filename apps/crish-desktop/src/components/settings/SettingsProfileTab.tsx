import { useToast } from '../../services/toast/ToastContext';
/**
 * 设置 · 账户：本机环境、数据备份；成功静默，仅错误提示。
 *
 * Stream D 改造后：磁盘镜像已删除，存储位置统一显示「本机 SQLite 数据库」。
 */
import React, { useId, useRef, useState } from 'react';

import { clientApi } from '../../api/clientApi';
import { ensureEngineConnected } from '../../api/chatBridge';
import { getTransport } from '../../api/transport';
import { isDeveloperEngineUiEnabled } from '../../api/productMode';
import { getWorkspacePath } from '../../api/projectStore';
import { networkUserMessage } from '../../api/userFacingErrors';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './SettingsUI';
import { Button, Input, Tooltip } from '../ui';
import { AccountAuthCard } from './AccountAuthCard';
import styles from './SettingsProfileTab.module.css';
import { AppIcon } from '../ui/icons/index';
import { useI18n } from '../../i18n';

type Props = {
  _onBlockingOverlayChange?: (open: boolean) => void;
};

/** 路径短名 */
function pathLeaf(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

export const SettingsProfileTab: React.FC<Props> = ({
  _onBlockingOverlayChange,
}) => {
  void _onBlockingOverlayChange;
  const { t } = useI18n();

  const { showToast } = useToast();
  const cwd = getWorkspacePath() || '__global__';
  const headMetaId = useId();
  const engineStatusId = useId();

  const [engineConnHint, setDaemonConnHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const importFileInputRef = useRef<HTMLInputElement>(null);

  const hasWorkspace = cwd !== '__global__' && Boolean(cwd);
  // Stream D 改造后：存储统一为 SQLite（本机数据库），不再有磁盘镜像 / localStorage 分支
  const dataLocation = t('settings.profile.dataLocation');

  const handleExportSettings = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const settings = await clientApi.getSettings();
      const blob = new Blob([JSON.stringify(settings ?? {}, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      a.href = url;
      a.download = `crish-settings-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      // 成功静默（用户裁决：导出/导入成功提示不必每次说）
    } catch (err) {
      showToast(t('settings.profile.exportFailed', { error: String(err) }));
    } finally {
      setExporting(false);
    }
  };

  /** 选择 JSON 后合并写入本机设置；成功静默，失败 toast */
  const handleImportSettings = () => {
    if (importing) return;
    importFileInputRef.current?.click();
  };

  const handleImportFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    void (async () => {
      setImporting(true);
      try {
        const text = await file.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          showToast(t('settings.profile.invalidJson'));
          return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          showToast(t('settings.profile.rootMustBeObject'));
          return;
        }
        await clientApi.saveSettingsEx(
          cwd === '__global__' ? '__global__' : cwd,
          'global',
          parsed as Parameters<typeof clientApi.saveSettingsEx>[2]
        );
        // 成功静默（用户裁决：导出/导入成功提示不必每次说）
      } catch (err) {
        showToast(t('settings.profile.importFailed', { error: String(err) }));
      } finally {
        setImporting(false);
      }
    })();
  };

  const handleTestDaemon = () => {
    if (busy) return;
    setBusy(true);
    setDaemonConnHint(t('settings.profile.connecting'));
    void ensureEngineConnected()
      .then((r) => {
        setDaemonConnHint(
          r.ok
            ? t('settings.profile.connected')
            : networkUserMessage(r.error) || t('settings.profile.notConnected')
        );
        // 失败结果行内展示；成功也行内，均不 toast
      })
      .catch((err) => {
        const msg =
          networkUserMessage(err) || t('settings.profile.notConnected');
        setDaemonConnHint(msg);
        showToast(t('settings.profile.connectionFailed', { error: msg }));
      })
      .finally(() => setBusy(false));
  };

  const workspaceDisplay = hasWorkspace
    ? pathLeaf(cwd)
    : t('workspace.noWorkspace');
  const workspaceTitle = hasWorkspace ? cwd : t('workspace.noWorkspaceHint');
  /** 短显示：路径叶名 / 本机；长说明进 title */
  const storageDisplay = 'SQLite';
  const storageIsPath = false;

  const engineOnline = getTransport().isReady();
  const defaultEngineStatus = engineOnline
    ? t('common.online')
    : t('common.offline');
  const engineStatus = engineConnHint || defaultEngineStatus;
  const showDeveloper = isDeveloperEngineUiEnabled();
  const engineMeta =
    showDeveloper && !engineOnline
      ? t('settings.profile.serviceDisconnected')
      : showDeveloper && engineConnHint
        ? engineConnHint
        : null;

  return (
    <SettingsPage
      title={t('settings.profile.title')}
      meta={
        engineMeta ? (
          <Tooltip content={t('settings.profile.connAbnormal')} delayShow={300}>
            <span
              id={headMetaId}
              className={`${styles.settingsHeadMeta} ${styles.settingsHeadMetaError}`}
              role="status"
              aria-live="polite"
            >
              {engineMeta}
            </span>
          </Tooltip>
        ) : null
      }
    >
      <SettingsSection title={t('settings.profile.flowbitSection')}>
        <AccountAuthCard />
      </SettingsSection>

      <SettingsSection title={t('settings.profile.currentEnvSection')}>
        <SettingsCard>
          <SettingsRow
            icon={<AppIcon name="user" size={18} />}
            title={t('settings.profile.currentProject')}
            desc={
              hasWorkspace
                ? t('settings.profile.localWorkspace')
                : t('settings.profile.noProjectOpen')
            }
            control={
              hasWorkspace ? (
                <Tooltip content={cwd} delayShow={300}>
                  <span className={styles.settingsPathEllipsis}>
                    {workspaceDisplay}
                  </span>
                </Tooltip>
              ) : (
                <Tooltip content={workspaceTitle} delayShow={300}>
                  <span className={styles.settingsListEmpty} role="status">
                    {workspaceDisplay}
                  </span>
                </Tooltip>
              )
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t('settings.profile.dataSection')}>
        <SettingsCard>
          <SettingsRow
            title={t('settings.profile.sessionData')}
            desc={t('settings.profile.savedLocallyOnly')}
            control={
              <Tooltip
                content={t('settings.profile.noCloudUpload')}
                delayShow={300}
              >
                <span className={styles.settingsListMeta}>
                  {t('settings.profile.localDevice')}
                </span>
              </Tooltip>
            }
          />
          <SettingsRow
            title={t('settings.profile.storageLocation')}
            desc={t('settings.profile.appDataDir')}
            control={
              <Tooltip content={dataLocation} delayShow={300}>
                <span
                  className={
                    storageIsPath
                      ? styles.settingsPathEllipsis
                      : styles.settingsListMeta
                  }
                >
                  {storageDisplay}
                </span>
              </Tooltip>
            }
          />
          <SettingsRow
            title={t('settings.profile.settingsBackup')}
            desc={t('settings.profile.exportImportConfig')}
            control={
              <>
                <Tooltip
                  content={
                    exporting
                      ? t('settings.profile.exporting')
                      : t('settings.profile.exportBackup')
                  }
                  delayShow={300}
                >
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={exporting}
                    onClick={() => handleExportSettings()}
                  >
                    {exporting
                      ? t('settings.profile.exportingShort')
                      : t('settings.profile.exportBtn')}
                  </Button>
                </Tooltip>
                <Tooltip
                  content={
                    importing
                      ? t('settings.profile.importing')
                      : t('settings.profile.importBackup')
                  }
                  delayShow={300}
                >
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={importing}
                    onClick={handleImportSettings}
                  >
                    {importing
                      ? t('settings.profile.importingShort')
                      : t('settings.profile.importBtn')}
                  </Button>
                </Tooltip>
                <Input
                  bare
                  ref={importFileInputRef}
                  type="file"
                  accept="application/json,.json"
                  style={{ display: 'none' }}
                  onChange={handleImportFileChange}
                />
              </>
            }
          />
        </SettingsCard>
      </SettingsSection>

      {showDeveloper ? (
        <SettingsSection title={t('settings.profile.advancedSection')}>
          <SettingsCard>
            <SettingsRow
              title={
                <label htmlFor={engineStatusId}>
                  {t('settings.profile.coreConn')}
                </label>
              }
              desc={t('settings.profile.coreConnDesc')}
              control={
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={handleTestDaemon}
                  >
                    {busy
                      ? t('settings.profile.testing')
                      : t('settings.profile.testBtn')}
                  </Button>
                  <span
                    id={engineStatusId}
                    className={styles.settingsListMeta}
                    role="status"
                    aria-live="polite"
                  >
                    {engineStatus}
                  </span>
                </>
              }
            />
          </SettingsCard>
        </SettingsSection>
      ) : null}
    </SettingsPage>
  );
};
