/**
 * 设置 · 多端互通（R1-08 桌面配对 UI + 设备管理页；R1-09 网络环境引导；
 * R1-11 多端服务开关——服务默认关闭（红线 1 零监听），先开启服务才显示
 * 配对模式开关）。
 * 闭环：服务开关 → 配对模式开关 → 二维码/CXN 码出现 → 设备列表/撤销/改名；
 * 配对开启时展示网络环境卡片（网络配置文件类别 + 可直连 IP +
 * 公用网络切换提示 / AP 隔离手动输 IP 引导，R1-09 G-4）。
 * 状态经 3s 轮询（pairStatus + listDevices + networkEnvInfo）保持与服务端一致；
 * 服务开关无独立查询命令（Rust pair_status 不含 enabled 字段），由本地状态
 * 跟踪（初始与服务默认关闭语义一致），以 setMultiDeviceEnabled 结果为准；
 * 二维码数据仅本会话保留（Rust 不持久化配对码，重启后需重新开启）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import styles from './SettingsDevicesTab.module.css';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './SettingsUI';
import { Button, ConfirmDialog, Input, Switch, Tooltip } from '../ui';
import {
  pairStart,
  pairStatus,
  pairCancel,
  listDevices,
  revokeDevice,
  renameDevice,
  networkEnvInfo,
  setMultiDeviceEnabled,
  type PairStartResult,
  type PairStatus,
  type DeviceInfo,
  type NetworkEnvInfo,
} from '../../api/multiDevice';

type Props = {
  onShowToast: (msg: string) => void;
};

const POLL_INTERVAL_MS = 3000;

/** 剩余时间格式化（mm:ss；null 显示占位） */
function formatRemaining(ms: number | null): string {
  if (ms === null) return '--:--';
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 网络配置文件类别 → 展示名（Rust multi_device_network_info 四态） */
const PROFILE_LABELS: Record<NetworkEnvInfo['profile'], string> = {
  public: '公用网络',
  private: '专用网络',
  domain: '域网络',
  unknown: '未知',
};

export const SettingsDevicesTab: React.FC<Props> = ({ onShowToast }) => {
  const [status, setStatus] = useState<PairStatus | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [pairResult, setPairResult] = useState<PairStartResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [revokeHash, setRevokeHash] = useState<string | null>(null);
  // 关闭配对确认（R1-11 G-4 语义变更）：关闭配对 = 撤销全部设备（D2 §5.4
  // 关闭动作，令牌全部失效 + 已连接设备立即断开）——执行前弹确认弹窗，
  // 避免误触开关导致全部配对关系被清除。
  const [confirmClosePairing, setConfirmClosePairing] = useState(false);
  const [renamingHash, setRenamingHash] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [netEnv, setNetEnv] = useState<NetworkEnvInfo | null>(null);
  // 多端服务总开关（R1-11）：Rust 侧无独立查询命令（pair_status 不含
  // enabled 字段），本地跟踪；初始 false 与服务默认关闭语义一致
  // （config.rs multi_device_enabled=false，应用启动即关闭态）。
  const [serviceEnabled, setServiceEnabled] = useState(false);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    const [s, d, n] = await Promise.all([
      pairStatus(),
      listDevices(),
      networkEnvInfo(),
    ]);
    if (!mountedRef.current) return;
    if (s) setStatus(s);
    setDevices(d);
    if (n) setNetEnv(n);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const timer = setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [load]);

  const handleToggle = useCallback(
    async (on: boolean) => {
      if (busy) return;
      setBusy(true);
      try {
        if (on) {
          const result = await pairStart();
          if (!mountedRef.current) return;
          if (result) {
            setPairResult(result);
            onShowToast('配对已开启：可用手机扫码');
          } else {
            onShowToast('开启配对失败（命令不可用或引擎未就绪）');
          }
        } else {
          await pairCancel();
          if (!mountedRef.current) return;
          setPairResult(null);
          onShowToast('配对已关闭');
        }
        await load();
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [busy, load, onShowToast]
  );

  // 服务开关（R1-11）：开启 → 本机开始监听，随后才显示配对模式开关；
  // 关闭 → 停服（零监听），已配对设备立即断开（令牌保留，重新开启服务后
  // 可直接重连，无需重新配对）。
  const handleEnableService = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await setMultiDeviceEnabled(true);
      if (!mountedRef.current) return;
      if (ok) {
        setServiceEnabled(true);
        onShowToast('多端服务已开启：本机可被手机连接');
      } else {
        onShowToast('开启服务失败（命令不可用或引擎未就绪）');
      }
      await load();
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, load, onShowToast]);

  const handleDisableService = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await setMultiDeviceEnabled(false);
      if (!mountedRef.current) return;
      if (ok) {
        setServiceEnabled(false);
        setPairResult(null);
        onShowToast('服务已关闭：已断开所有已配对设备');
      } else {
        onShowToast('关闭服务失败（命令不可用或引擎未就绪）');
      }
      await load();
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, load, onShowToast]);

  const handleCopyCode = useCallback(async () => {
    if (!pairResult) return;
    try {
      await navigator.clipboard.writeText(pairResult.code);
      onShowToast('配对码已复制');
    } catch {
      onShowToast('复制失败');
    }
  }, [pairResult, onShowToast]);

  const handleRevoke = useCallback(async () => {
    if (!revokeHash) return;
    const ok = await revokeDevice(revokeHash);
    if (!mountedRef.current) return;
    setRevokeHash(null);
    if (ok) {
      onShowToast('设备已撤销（令牌失效并已断开）');
    } else {
      onShowToast('撤销失败：设备不存在或已撤销');
    }
    await load();
  }, [revokeHash, load, onShowToast]);

  const startRename = useCallback((device: DeviceInfo) => {
    setRenamingHash(device.id);
    setRenameDraft(device.label);
  }, []);

  const handleRename = useCallback(
    async (hash: string) => {
      const label = renameDraft.trim();
      if (!label) {
        onShowToast('标签不能为空');
        return;
      }
      const ok = await renameDevice(hash, label);
      if (!mountedRef.current) return;
      setRenamingHash(null);
      if (ok) {
        onShowToast('设备已改名');
      } else {
        onShowToast('改名失败：设备不存在或已撤销');
      }
      await load();
    },
    [renameDraft, load, onShowToast]
  );

  // 配对态生效条件：服务开启 + 服务端配对态翻转（服务关闭时即使轮询
  // 残留 pairing_enabled 也不展示配对面——服务关闭即零监听）。
  const enabled = Boolean(status?.pairing_enabled) && serviceEnabled;
  // 二维码数据仅本会话保留：开启成功即显示（不等待轮询翻转）；
  // 服务端配对开启但本会话无码（如重启后）时给提示条，可重新生成。
  const showPairCard = pairResult !== null && serviceEnabled;

  return (
    <SettingsPage
      title="多端互通"
      meta={<Lucide.Smartphone size={16} aria-hidden />}
    >
      <SettingsSection title="配对模式">
        <SettingsCard>
          {serviceEnabled ? (
            <>
              <SettingsRow
                icon={<Lucide.QrCode size={18} aria-hidden />}
                title="开启局域网配对"
                desc="开启后生成一次性配对码，手机扫码即可连接本机（仅同一局域网可直达；公网走中继/P2P 属后续阶段）"
                control={
                  <Switch
                    checked={enabled}
                    onCheckedChange={(v) => {
                      if (v) {
                        void handleToggle(true);
                      } else {
                        // 关闭配对 = 撤销全部设备：先弹确认（G-4 语义）
                        setConfirmClosePairing(true);
                      }
                    }}
                    aria-label="配对模式开关"
                  />
                }
              />
              {enabled && !pairResult && (
                <div
                  className={styles.firewallHint}
                  data-testid="pair-code-missing"
                >
                  <Lucide.Info size={14} aria-hidden />
                  配对已开启但配对码已过期（重启后不保留）。点击上方开关关闭后重新开启即可生成新码。
                </div>
              )}
              {status && (
                <div className={styles.pairMeta} data-testid="pair-meta">
                  <span>状态：{status.state}</span>
                  <span>绑定：{status.bind_mode}</span>
                  <span>已配对设备：{status.token_count}</span>
                  {status.failed_attempts > 0 && (
                    <span className={styles.pairMetaWarn}>
                      验证失败次数：{status.failed_attempts}
                    </span>
                  )}
                </div>
              )}
              <div className={styles.serviceControl}>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => void handleDisableService()}
                  disabled={busy}
                >
                  <Lucide.Power size={14} aria-hidden /> 关闭服务
                </Button>
                <span
                  className={styles.serviceDisableHint}
                  data-testid="service-disable-hint"
                >
                  关闭服务将断开所有已配对设备（令牌保留，重新开启服务后可直接重连）
                </span>
              </div>
            </>
          ) : (
            <div className={styles.serviceOff} data-testid="service-off">
              <div className={styles.serviceOffTitle}>
                <Lucide.PowerOff size={16} aria-hidden />
                <span>多端互通服务未开启</span>
              </div>
              <p className={styles.serviceOffDesc}>
                服务默认关闭（不监听任何端口，本机不可被手机连接）。开启服务后本机开始监听，
                即可进入配对模式生成一次性配对码。
              </p>
              <Button
                size="sm"
                variant="primary"
                onClick={() => void handleEnableService()}
                disabled={busy}
              >
                <Lucide.Power size={14} aria-hidden /> 开启服务
              </Button>
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      {enabled && netEnv && (
        <SettingsSection title="网络环境">
          <SettingsCard>
            <div className={styles.networkEnv} data-testid="network-env">
              <div className={styles.networkProfile}>
                <Lucide.Wifi size={16} aria-hidden />
                <span>
                  当前网络：{PROFILE_LABELS[netEnv.profile] ?? netEnv.profile}
                </span>
                {netEnv.profile === 'public' && (
                  <span className={styles.networkPublicBadge}>公用网络</span>
                )}
              </div>
              {netEnv.profile === 'public' && (
                <div
                  className={styles.firewallHint}
                  data-testid="network-public-hint"
                >
                  <Lucide.ShieldAlert size={14} aria-hidden />
                  请切换到专用网络，否则 Windows 防火墙会阻止手机访问本机服务。
                </div>
              )}
              <div className={styles.ipList}>
                <span className={styles.ipListTitle}>
                  手机可直连地址（AP 隔离时手动输入）：
                </span>
                {(() => {
                  const ips = netEnv.usable_ips.filter(
                    (ip) => ip !== '0.0.0.0'
                  );
                  return ips.length > 0 ? (
                    <ul>
                      {ips.map((ip) => (
                        <li key={ip}>
                          <code>{ip}</code>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className={styles.ipListEmpty}>
                      未检测到可直连地址，请检查网络连接。
                    </span>
                  );
                })()}
              </div>
              {netEnv.hint && (
                <div
                  className={styles.apIsolationHint}
                  data-testid="network-hint"
                >
                  <Lucide.Router size={14} aria-hidden />
                  {netEnv.hint}
                </div>
              )}
            </div>
          </SettingsCard>
        </SettingsSection>
      )}

      {showPairCard && (
        <SettingsSection title="扫码配对">
          <SettingsCard>
            <div className={styles.qrWrap} data-testid="pair-qr-card">
              <QRCodeSVG
                value={pairResult.qr}
                size={200}
                level="M"
                aria-label="配对二维码"
              />
              <div className={styles.qrCodeText} data-testid="pair-code">
                {pairResult.code}
              </div>
              <div className={styles.qrMeta}>
                <span>
                  剩余有效时间：
                  {formatRemaining(status?.code_remaining_ms ?? null)}
                </span>
                <span>验证失败次数：{status?.failed_attempts ?? 0}</span>
              </div>
              <div className={styles.qrActions}>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void handleCopyCode()}
                >
                  <Lucide.Copy size={14} aria-hidden /> 复制配对码
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setConfirmClosePairing(true)}
                  disabled={busy}
                >
                  <Lucide.X size={14} aria-hidden /> 关闭配对
                </Button>
              </div>
              {pairResult.firewall_hint && (
                <div
                  className={styles.firewallHint}
                  data-testid="firewall-hint"
                >
                  <Lucide.ShieldAlert size={14} aria-hidden />
                  {pairResult.firewall_hint}
                </div>
              )}
            </div>
          </SettingsCard>
        </SettingsSection>
      )}

      <SettingsSection title="已配对设备">
        <SettingsCard>
          {devices.length === 0 ? (
            <div className={styles.emptyState} data-testid="devices-empty">
              <Lucide.TabletSmartphone size={28} aria-hidden />
              <p>暂无已配对设备。开启配对模式后，手机端扫码即可加入。</p>
            </div>
          ) : (
            <ul className={styles.deviceList} data-testid="device-list">
              {devices.map((device) => (
                <li key={device.id} className={styles.deviceRow}>
                  <div className={styles.deviceIcon}>
                    <Lucide.Smartphone size={18} aria-hidden />
                  </div>
                  <div className={styles.deviceBody}>
                    {renamingHash === device.id ? (
                      <div className={styles.renameRow}>
                        <Input
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          aria-label="设备新名称"
                          autoFocus
                        />
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => void handleRename(device.id)}
                        >
                          保存
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setRenamingHash(null)}
                        >
                          取消
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div className={styles.deviceTitle}>
                          <Tooltip content={device.label}>
                            <span className={styles.deviceLabel}>
                              {device.label}
                            </span>
                          </Tooltip>
                          {device.revoked && (
                            <span className={styles.revokedBadge}>已撤销</span>
                          )}
                        </div>
                        <div className={styles.deviceDesc}>
                          <span title={device.id}>
                            {device.id.slice(0, 12)}…
                          </span>
                          <span>
                            {new Date(device.issued_at_ms).toLocaleString()}
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                  <div className={styles.deviceActions}>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => startRename(device)}
                    >
                      改名
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => setRevokeHash(device.id)}
                    >
                      撤销
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SettingsCard>
      </SettingsSection>

      <ConfirmDialog
        open={revokeHash !== null}
        danger
        title="撤销设备"
        description="撤销后该设备将立即断开，令牌失效，需重新扫码配对才能连接。确定撤销？"
        confirmLabel="撤销"
        onConfirm={() => void handleRevoke()}
        onCancel={() => setRevokeHash(null)}
      />

      <ConfirmDialog
        open={confirmClosePairing}
        danger
        title="关闭配对"
        description="关闭配对将撤销全部已配对设备并断开连接（令牌全部失效，已连接设备立即断开，需重新扫码配对才能连接）。确定关闭配对？"
        confirmLabel="关闭配对"
        onConfirm={() => {
          setConfirmClosePairing(false);
          void handleToggle(false);
        }}
        onCancel={() => setConfirmClosePairing(false)}
      />
    </SettingsPage>
  );
};
