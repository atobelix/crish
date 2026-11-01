/**
 * 登录设备列表：本机置顶并带「本机」标签；在线显示品牌绿点 +「在线」，离线显示最近日期。
 * 呈现与设置页同构：SettingsCard 分组卡 + SettingsRow 标准行（图标位 / 标题 /
 * 状态副标题 / 右侧控件槽），不再自成一套块行体系；行内「退出」为常显的次级按钮
 * （危险语义红字），「退出其他设备」收在卡片下方右对齐的动作区（与二级页操作区
 * 同口径），不再悬停显形、也不是列表下方左侧的孤字。空态与加载态走共享
 * SettingsEmpty（卡内居中块，role=status 语义保留），与诊断、多端互通等页
 * 同一口径；说明文案已由 DevicesPane 的引言承担，空态不重复设副文案。
 * 页标题由 DevicesPane 的页骨架承担，此处不自带标题。数据与撤销逻辑
 * （sessions/devices 拉取与回调）不变。
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, AppIcon, cn, type IconName } from '../ui';
import { formatDate } from '../../i18n/SafeIntl';
import { useI18n } from '../../i18n';
import { useAuthField } from '../../store/storeAccess';
import {
  buildDeviceRows,
  type AccountDeviceKind,
  type AccountDeviceRow,
} from './accountDevices';
import { authErrorText } from './authErrorText';
import {
  SettingsCard,
  SettingsEmpty,
  SettingsRow,
} from '../settings/SettingsUI';
import controls from './accountControls.module.css';
import styles from './account.module.css';

const KIND_ICON: Record<AccountDeviceKind, IconName> = {
  desktop: 'monitor',
  laptop: 'laptop',
  phone: 'smartphone',
};

function DeviceRow({
  row,
  onRevoke,
}: {
  row: AccountDeviceRow;
  onRevoke: (id: string) => void;
}) {
  const { t, language } = useI18n();
  const meta = row.online
    ? t('settings.account.devices.online')
    : formatDate(
        row.lastActiveAt,
        { month: 'short', day: 'numeric' },
        language
      );
  return (
    <SettingsRow
      icon={<AppIcon name={KIND_ICON[row.kind]} size={16} />}
      title={
        <span className={styles.deviceTitle}>
          <span className={styles.deviceNameText}>
            {row.name || t('settings.account.devices.unknown')}
          </span>
          {row.current ? (
            <span className={styles.deviceTag}>
              {t('settings.account.devices.current')}
            </span>
          ) : null}
        </span>
      }
      desc={
        <span className={styles.deviceStatus}>
          {row.online ? (
            <span className={styles.onlineDot} aria-hidden="true" />
          ) : null}
          <span>{meta}</span>
        </span>
      }
      control={
        row.current ? undefined : (
          <Button
            variant="unstyled"
            type="button"
            className={cn(
              controls.button,
              controls.secondary,
              styles.deviceRevoke
            )}
            onClick={() => onRevoke(row.sessionId)}
          >
            {t('settings.account.devices.revoke')}
          </Button>
        )
      }
    />
  );
}

export function AccountDeviceList() {
  const { t } = useI18n();
  const sessions = useAuthField((state) => state.sessions);
  const devices = useAuthField((state) => state.devices);
  const sessionsLoading = useAuthField((state) => state.sessionsLoading);
  const loadSessions = useAuthField((state) => state.loadSessions);
  const loadDevices = useAuthField((state) => state.loadDevices);
  const revokeSession = useAuthField((state) => state.revokeSession);
  const revokeOtherSessions = useAuthField(
    (state) => state.revokeOtherSessions
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadSessions();
    void loadDevices();
  }, [loadSessions, loadDevices]);

  const rows = useMemo(
    () => buildDeviceRows(sessions, devices),
    [sessions, devices]
  );
  const hasOthers = rows.some((row) => !row.current);

  const handleRevoke = (sessionId: string) => {
    setError(null);
    void revokeSession(sessionId).then((ok) => {
      if (!ok) setError(t('settings.account.devices.revokeFailed'));
    });
  };

  const handleRevokeOthers = () => {
    setError(null);
    setBusy(true);
    revokeOtherSessions()
      .then((ok) => {
        if (!ok) setError(t('settings.account.devices.revokeFailed'));
      })
      .catch((err: unknown) => setError(authErrorText(err, t)))
      .finally(() => setBusy(false));
  };

  return (
    <section
      className={styles.deviceStack}
      aria-label={t('settings.account.devices.label')}
    >
      {rows.length > 0 ? (
        <SettingsCard>
          {rows.map((row) => (
            <DeviceRow key={row.sessionId} row={row} onRevoke={handleRevoke} />
          ))}
        </SettingsCard>
      ) : (
        <SettingsCard>
          <div role="status">
            <SettingsEmpty
              icon={<AppIcon name="monitor" size={24} aria-hidden />}
              title={
                sessionsLoading
                  ? t('settings.account.devices.loading')
                  : t('settings.account.devices.empty')
              }
            />
          </div>
        </SettingsCard>
      )}
      {error ? (
        <p className={controls.errorText} role="alert">
          {error}
        </p>
      ) : null}
      {hasOthers ? (
        <div className={styles.deviceActions}>
          <Button
            variant="unstyled"
            type="button"
            className={cn(
              controls.button,
              controls.secondary,
              styles.deviceRevokeAll
            )}
            disabled={busy}
            onClick={handleRevokeOthers}
          >
            {t('settings.account.devices.revokeOthers')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
