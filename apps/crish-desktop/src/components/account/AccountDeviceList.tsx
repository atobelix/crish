/**
 * 登录设备列表：本机置顶并带「本机」标签；在线显示品牌绿点 +「在线」，离线显示最近日期；
 * 行悬停显露「退出」，列表下方「退出其他设备」。
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
    <li className={styles.deviceRow}>
      <span className={styles.deviceIcon} aria-hidden="true">
        <AppIcon name={KIND_ICON[row.kind]} size={16} />
      </span>
      <span className={styles.deviceName}>
        <span className={styles.deviceNameText}>
          {row.name || t('settings.account.devices.unknown')}
        </span>
        {row.current ? (
          <span className={styles.deviceTag}>
            {t('settings.account.devices.current')}
          </span>
        ) : null}
      </span>
      <span className={styles.deviceMeta}>
        {row.online ? (
          <span className={styles.onlineDot} aria-hidden="true" />
        ) : null}
        {meta}
      </span>
      {row.current ? null : (
        <Button
          variant="unstyled"
          type="button"
          className={cn(controls.textButton, styles.deviceRevoke)}
          onClick={() => onRevoke(row.sessionId)}
        >
          {t('settings.account.devices.revoke')}
        </Button>
      )}
    </li>
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
      className={styles.section}
      aria-label={t('settings.account.devices.label')}
    >
      <h3 className={controls.label}>{t('settings.account.devices.label')}</h3>
      {rows.length > 0 ? (
        <ul className={styles.deviceList}>
          {rows.map((row) => (
            <DeviceRow key={row.sessionId} row={row} onRevoke={handleRevoke} />
          ))}
        </ul>
      ) : (
        <div className={styles.deviceHint} role="status">
          {sessionsLoading
            ? t('settings.account.devices.loading')
            : t('settings.account.devices.empty')}
        </div>
      )}
      {error ? (
        <div className={styles.afterList}>
          <p className={controls.errorText} role="alert">
            {error}
          </p>
        </div>
      ) : null}
      {hasOthers ? (
        <div className={styles.afterList}>
          <Button
            variant="unstyled"
            type="button"
            className={cn(controls.textButton, controls.textDanger)}
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
