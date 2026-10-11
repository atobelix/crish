import React, { useEffect, useState } from 'react';
import { useAuthField } from '../../store/storeAccess';
import { SettingsCard } from './SettingsUI';
import { Button, Tooltip, Input } from '../ui';
import styles from './AccountAuthCard.module.css';
import { AppIcon } from '../ui/icons/index';

export const AccountAuthCard: React.FC = () => {
  const {
    isLoggedIn,
    user,
    devices,
    loading,
    error,
    initialized,
    initSession,
    login,
    logout,
    loadDevices,
    revokeDevice,
    clearError,
  } = useAuthField((state) => state);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null);

  useEffect(() => {
    if (!initialized) {
      void initSession();
    }
  }, [initialized, initSession]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password || loading) return;
    try {
      await login(email, password);
      setPassword('');
    } catch {
      // 错误已写入 store.error
    }
  };

  const handleRevoke = async (id: string) => {
    setBusyDeviceId(id);
    try {
      await revokeDevice(id);
    } finally {
      setBusyDeviceId(null);
    }
  };

  const formatLastSeen = (ms: number) => {
    if (!ms) return '刚刚';
    const diffSec = Math.floor((Date.now() - ms) / 1000);
    if (diffSec < 60) return '刚刚在线';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
    return `${Math.floor(diffSec / 86400)} 天前`;
  };

  return (
    <SettingsCard>
      <div className={styles.cardContent}>
        {!isLoggedIn ? (
          <form className={styles.loginForm} onSubmit={handleLogin}>
            <div className={styles.formRow}>
              <label className={styles.formLabel} htmlFor="auth-email-input">
                账号邮箱
              </label>
              <Input
                id="auth-email-input"
                type="email"
                size="sm"
                placeholder="name@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (error) clearError();
                }}
                autoComplete="email"
                required
              />
            </div>
            <div className={styles.formRow}>
              <label className={styles.formLabel} htmlFor="auth-password-input">
                密码
              </label>
              <Input
                id="auth-password-input"
                type="password"
                size="sm"
                placeholder="输入登录密码"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (error) clearError();
                }}
                autoComplete="current-password"
                required
              />
            </div>

            {error ? <div className={styles.errorText}>{error}</div> : null}

            <div className={styles.formActions}>
              <span className={styles.loginHint}>
                登录后手机端开箱即见本机并可一键免扫码直连；未登录时可使用本地配对。
              </span>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={loading || !email || !password}
              >
                {loading ? '登录中…' : '登录'}
              </Button>
            </div>
          </form>
        ) : (
          <>
            <div className={styles.userCardHeader}>
              <div className={styles.userInfo}>
                <div className={styles.userAvatar}>
                  <AppIcon name="user" size={18} />
                </div>
                <div className={styles.userMeta}>
                  <div className={styles.userName}>
                    {user?.name || user?.email?.split('@')[0] || 'Flowbit 用户'}
                  </div>
                  <div className={styles.userEmail}>{user?.email}</div>
                </div>
              </div>
              <div className={styles.userCardActions}>
                <span className={styles.statusPill}>
                  <span className={styles.statusDot} />
                  云端协同就绪
                </span>
                <Tooltip content="退出当前账号">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={loading}
                    onClick={() => void logout()}
                    icon={<AppIcon name="logout" size={14} />}
                  >
                    退出
                  </Button>
                </Tooltip>
              </div>
            </div>

            <div className={styles.deviceListSection}>
              <div className={styles.deviceListHeader}>
                <span className={styles.deviceListTitle}>
                  已关联在线设备 ({devices.length})
                </span>
                <Tooltip content="刷新设备列表">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void loadDevices()}
                    icon={<AppIcon name="refresh" size={13} />}
                  >
                    刷新
                  </Button>
                </Tooltip>
              </div>

              {devices.length === 0 ? (
                <div className={styles.emptyDevices}>
                  暂无其他关联设备。在手机端登录同一账号，即可自动在此同步并在手机一键远程直连！
                </div>
              ) : (
                devices.map((d) => {
                  const isMobile =
                    d.platform?.toLowerCase().includes('ios') ||
                    d.platform?.toLowerCase().includes('android') ||
                    d.platform?.toLowerCase().includes('mobile');
                  return (
                    <div key={d.id} className={styles.deviceItem}>
                      <div className={styles.deviceLeft}>
                        <div className={styles.deviceIcon}>
                          {isMobile ? (
                            <AppIcon name="smartphone" size={16} />
                          ) : (
                            <AppIcon name="laptop" size={16} />
                          )}
                        </div>
                        <div>
                          <div className={styles.deviceName}>{d.name || d.id}</div>
                          <div className={styles.deviceMeta}>
                            {d.platform} · {formatLastSeen(d.lastSeenAt)}
                          </div>
                        </div>
                      </div>
                      <Tooltip content="撤销此设备对本机的远程协同权限">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busyDeviceId === d.id}
                          onClick={() => void handleRevoke(d.id)}
                          icon={<AppIcon name="trash" size={13} />}
                        >
                          解除
                        </Button>
                      </Tooltip>
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>
    </SettingsCard>
  );
};
