/**
 * 设置 · 多端互通（R1-08 桌面配对 UI + 设备管理页）。
 * 闭环：配对模式开关 → 二维码/CXN 码出现 → 设备列表/撤销/改名。
 * 状态经 3s 轮询（pairStatus + listDevices）保持与服务端一致；
 * 二维码数据仅本会话保留（Rust 不持久化配对码，重启后需重新开启）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import styles from './SettingsDevicesTab.module.css';
import { SettingsPage, SettingsSection, SettingsCard, SettingsRow } from './SettingsUI';
import { Button, ConfirmDialog, Input, Switch, Tooltip } from '../ui';
import {
  pairStart,
  pairStatus,
  pairCancel,
  listDevices,
  revokeDevice,
  renameDevice,
  type PairStartResult,
  type PairStatus,
  type DeviceInfo,
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

export const SettingsDevicesTab: React.FC<Props> = ({ onShowToast }) => {
  const [status, setStatus] = useState<PairStatus | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [pairResult, setPairResult] = useState<PairStartResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [revokeHash, setRevokeHash] = useState<string | null>(null);
  const [renamingHash, setRenamingHash] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    const [s, d] = await Promise.all([pairStatus(), listDevices()]);
    if (!mountedRef.current) return;
    if (s) setStatus(s);
    setDevices(d);
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
    [busy, load, onShowToast],
  );

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
    [renameDraft, load, onShowToast],
  );

  const enabled = Boolean(status?.pairing_enabled);
  // 二维码数据仅本会话保留：开启成功即显示（不等待轮询翻转）；
  // 服务端配对开启但本会话无码（如重启后）时给提示条，可重新生成。
  const showPairCard = pairResult !== null;

  return (
    <SettingsPage title="多端互通" meta={<Lucide.Smartphone size={16} aria-hidden />}>
      <SettingsSection title="配对模式">
        <SettingsCard>
          <SettingsRow
            icon={<Lucide.QrCode size={18} aria-hidden />}
            title="开启局域网配对"
            desc="开启后生成一次性配对码，手机扫码即可连接本机（仅同一局域网可直达；公网走中继/P2P 属后续阶段）"
            control={
              <Switch
                checked={enabled}
                onCheckedChange={(v) => void handleToggle(v)}
                aria-label="配对模式开关"
              />
            }
          />
          {enabled && !pairResult && (
            <div className={styles.firewallHint} data-testid="pair-code-missing">
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
                <span className={styles.pairMetaWarn}>验证失败次数：{status.failed_attempts}</span>
              )}
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      {showPairCard && (
        <SettingsSection title="扫码配对">
          <SettingsCard>
            <div className={styles.qrWrap} data-testid="pair-qr-card">
              <QRCodeSVG value={pairResult.qr} size={200} level="M" aria-label="配对二维码" />
              <div className={styles.qrCodeText} data-testid="pair-code">
                {pairResult.code}
              </div>
              <div className={styles.qrMeta}>
                <span>剩余有效时间：{formatRemaining(status?.code_remaining_ms ?? null)}</span>
                <span>验证失败次数：{status?.failed_attempts ?? 0}</span>
              </div>
              <div className={styles.qrActions}>
                <Button size="sm" variant="secondary" onClick={() => void handleCopyCode()}>
                  <Lucide.Copy size={14} aria-hidden /> 复制配对码
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void handleToggle(false)}
                  disabled={busy}
                >
                  <Lucide.X size={14} aria-hidden /> 关闭配对
                </Button>
              </div>
              {pairResult.firewall_hint && (
                <div className={styles.firewallHint} data-testid="firewall-hint">
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
                        <Button size="sm" variant="primary" onClick={() => void handleRename(device.id)}>
                          保存
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRenamingHash(null)}>
                          取消
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div className={styles.deviceTitle}>
                          <Tooltip content={device.label}>
                            <span className={styles.deviceLabel}>{device.label}</span>
                          </Tooltip>
                          {device.revoked && (
                            <span className={styles.revokedBadge}>已撤销</span>
                          )}
                        </div>
                        <div className={styles.deviceDesc}>
                          <span title={device.id}>{device.id.slice(0, 12)}…</span>
                          <span>
                            {new Date(device.issued_at_ms).toLocaleString()}
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                  <div className={styles.deviceActions}>
                    <Button size="sm" variant="ghost" onClick={() => startRename(device)}>
                      改名
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setRevokeHash(device.id)}>
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
    </SettingsPage>
  );
};
