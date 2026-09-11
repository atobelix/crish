import { useToast } from '../../services/toast/ToastContext';
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
 *
 * 状态分组（3 个 useReducer + 2 个提取 hook）：
 * - 配对 reducer（status/pairResult/busy/confirmClosePairing/serviceEnabled）→ useDevicePairing
 * - 设备列表 reducer（devices/revokeHash）→ 本组件
 * - 网络环境 reducer（netEnv）→ 本组件
 * - 改名 reducer（renamingHash/renameDraft）→ useDeviceRename
 * 展示子组件：网络环境卡片 → SettingsDevicesNetworkEnv；
 *           已配对设备列表 → SettingsDevicesList。
 */
import React, { useCallback, useEffect, useReducer, useRef } from 'react';

import { QRCodeSVG } from 'qrcode.react';
import styles from './SettingsDevicesTab.module.css';
import {
  SettingsPage,
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from './SettingsUI';
import { Button, ConfirmDialog, Switch } from '../ui';
import {
  pairStatus,
  listDevices,
  revokeDevice,
  networkEnvInfo,
  type DeviceInfo,
  type NetworkEnvInfo,
} from '../../api/multiDevice';
import { useDevicePairing } from './useDevicePairing';
import { useDeviceRename } from './useDeviceRename';
import { SettingsDevicesNetworkEnv } from './SettingsDevicesNetworkEnv';
import { SettingsDevicesList } from './SettingsDevicesList';
import { AppIcon } from '../ui/icons/index';

type Props = {
  _onBlockingOverlayChange?: (open: boolean) => void;
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

// ── 设备列表 reducer（devices / revokeHash）──────────────────────────────

interface DeviceListState {
  devices: DeviceInfo[];
  revokeHash: string | null;
}

type DeviceListAction =
  | { type: 'setDevices'; devices: DeviceInfo[] }
  | { type: 'setRevokeHash'; hash: string | null };

function deviceListReducer(
  state: DeviceListState,
  action: DeviceListAction
): DeviceListState {
  switch (action.type) {
    case 'setDevices':
      return { ...state, devices: action.devices };
    case 'setRevokeHash':
      return { ...state, revokeHash: action.hash };
    default:
      return state;
  }
}

const INITIAL_DEVICE_LIST: DeviceListState = { devices: [], revokeHash: null };

// ── 网络环境 reducer（netEnv）─────────────────────────────────────────────

type NetworkEnvAction = {
  type: 'setNetEnv';
  netEnv: NetworkEnvInfo | null;
};

function networkEnvReducer(
  state: NetworkEnvInfo | null,
  action: NetworkEnvAction
): NetworkEnvInfo | null {
  switch (action.type) {
    case 'setNetEnv':
      return action.netEnv;
    default:
      return state;
  }
}

export const SettingsDevicesTab: React.FC<Props> = ({ _onBlockingOverlayChange }) => {
  const { showToast } = useToast();
  const [deviceList, dispatchDeviceList] = useReducer(
    deviceListReducer,
    INITIAL_DEVICE_LIST
  );
  const [netEnv, dispatchNetEnv] = useReducer(networkEnvReducer, null);
  const mountedRef = useRef(true);

  // 稳定 load 引用：钩子与轮询共用。钩子内 load 通过 ref 取最新实现，
  // 避免与钩子的 dispatch 产生 TDZ（钩子需 load，load 又需钩子的 dispatch）。
  const loadRef = useRef<() => Promise<void>>(async () => {});
  const load = useCallback(async () => {
    await loadRef.current();
  }, []);

  const {
    pairing,
    dispatchPairing,
    handleToggle,
    handleEnableService,
    handleDisableService,
    handleCopyCode,
  } = useDevicePairing({ mountedRef, load, showToast });

  const { rename, dispatchRename, startRename, handleRename } = useDeviceRename({
    mountedRef,
    load,
    showToast,
  });

  const inFlightRef = useRef(false);
  const netEnvFetchedRef = useRef(false);

  // load 实现延后赋值（此时所有 dispatch 已就绪），避免 TDZ
  loadRef.current = async (fetchNet = false) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const needNet = fetchNet || !netEnvFetchedRef.current;
      const [s, d, n] = await Promise.all([
        pairStatus(),
        listDevices(),
        needNet ? networkEnvInfo() : Promise.resolve(null),
      ]);
      if (!mountedRef.current) return;
      if (s) {
        dispatchPairing({ type: 'setStatus', status: s });
      }
      dispatchDeviceList({ type: 'setDevices', devices: d });
      if (n) {
        netEnvFetchedRef.current = true;
        dispatchNetEnv({ type: 'setNetEnv', netEnv: n });
      }
    } finally {
      inFlightRef.current = false;
    }
  };

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

  const handleRevoke = useCallback(async () => {
    if (!deviceList.revokeHash) return;
    const ok = await revokeDevice(deviceList.revokeHash);
    if (!mountedRef.current) return;
    dispatchDeviceList({ type: 'setRevokeHash', hash: null });
    if (ok) {
      showToast('设备已撤销（令牌失效并已断开）');
    } else {
      showToast('撤销失败：设备不存在或已撤销');
    }
    await load();
  }, [deviceList.revokeHash, load, showToast]);

  const handleRevokeRequest = useCallback(
    (deviceId: string) => {
      dispatchDeviceList({ type: 'setRevokeHash', hash: deviceId });
    },
    []
  );

  // 配对态生效条件：服务开启 + 服务端配对态翻转（服务关闭时即使轮询
  // 残留 pairing_enabled 也不展示配对面——服务关闭即零监听）。
  const enabled = Boolean(pairing.status?.pairing_enabled) && pairing.serviceEnabled;
  // 二维码数据仅本会话保留：开启成功即显示（不等待轮询翻转）；
  // 服务端配对开启但本会话无码（如重启后）时给提示条，可重新生成。
  const showPairCard = pairing.pairResult !== null && pairing.serviceEnabled;

  return (
    <SettingsPage
      title="多端互通"
      meta={<AppIcon name="smartphone" size={16} aria-hidden />}
    >
      <SettingsSection title="配对模式">
        <SettingsCard>
          {pairing.serviceEnabled ? (
            <>
              <SettingsRow
                icon={<AppIcon name="radio" size={18} aria-hidden />}
                title="多端互通服务"
                desc={
                  <span
                    className={styles.serviceDesc}
                    data-testid="service-disable-hint"
                  >
                    服务运行中 · 关闭服务将断开所有已配对设备
                  </span>
                }
                control={
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void handleDisableService()}
                    disabled={pairing.busy}
                  >
                    <AppIcon name="power" size={14} aria-hidden /> 关闭服务
                  </Button>
                }
              />
              <SettingsRow
                icon={<AppIcon name="qr-code" size={18} aria-hidden />}
                title="开启局域网配对"
                desc="生成一次性配对码，移动端扫码即可连接本机"
                control={
                  <Switch
                    checked={enabled}
                    onCheckedChange={(v) => {
                      if (v) {
                        void handleToggle(true);
                      } else {
                        // 关闭配对 = 撤销全部设备：先弹确认（G-4 语义）
                        dispatchPairing({
                          type: 'setConfirmClosePairing',
                          open: true,
                        });
                      }
                    }}
                    aria-label="配对模式开关"
                  />
                }
              />
              {enabled && !pairing.pairResult && (
                <div
                  className={styles.firewallHint}
                  data-testid="pair-code-missing"
                >
                  <AppIcon name="info" size={14} aria-hidden />
                  配对已开启但配对码已过期。点击上方开关重新开启即可生成新码。
                </div>
              )}
            </>
          ) : (
            <div data-testid="service-off">
              <SettingsRow
                icon={<AppIcon name="radio" size={18} aria-hidden />}
                title="多端互通服务未开启"
                desc="开启后本机可被局域网内的移动设备发现并连接"
                control={
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void handleEnableService()}
                    disabled={pairing.busy}
                  >
                    <AppIcon name="power" size={14} aria-hidden /> 开启服务
                  </Button>
                }
              />
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      {showPairCard && (
        <SettingsSection title="扫码配对">
          <SettingsCard>
            <div className={styles.qrWrap} data-testid="pair-qr-card">
              <div className={styles.qrBox}>
                <QRCodeSVG
                  value={pairing.pairResult!.qr}
                  size={180}
                  level="M"
                  aria-label="配对二维码"
                />
              </div>
              <div className={styles.codeContainer}>
                <span className={styles.qrCodeText} data-testid="pair-code">
                  {pairing.pairResult!.code}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void handleCopyCode()}
                  title="复制配对码"
                >
                  <AppIcon name="copy" size={13} aria-hidden /> 复制配对码
                </Button>
              </div>
              <div className={styles.qrMeta}>
                <AppIcon name="clock" size={13} aria-hidden />
                <span>
                  剩余有效时间：
                  {formatRemaining(pairing.status?.code_remaining_ms ?? null)}
                </span>
              </div>
              <div className={styles.qrCardFooter}>
                {pairing.pairResult!.firewall_hint ? (
                  <div
                    className={styles.firewallHint}
                    data-testid="firewall-hint"
                  >
                    <AppIcon name="shield-alert" size={14} aria-hidden />
                    <span>{pairing.pairResult!.firewall_hint}</span>
                  </div>
                ) : (
                  <div />
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    dispatchPairing({
                      type: 'setConfirmClosePairing',
                      open: true,
                    })
                  }
                  disabled={pairing.busy}
                  className={styles.closePairBtn}
                >
                  <AppIcon name="x" size={14} aria-hidden /> 关闭配对
                </Button>
              </div>
            </div>
          </SettingsCard>
        </SettingsSection>
      )}

      {enabled && netEnv && <SettingsDevicesNetworkEnv netEnv={netEnv} />}

      <SettingsDevicesList
        devices={deviceList.devices}
        rename={rename}
        dispatchRename={dispatchRename}
        startRename={startRename}
        onRevoke={handleRevokeRequest}
        onRenameSubmit={(id) => void handleRename(id)}
      />

      <ConfirmDialog
        open={deviceList.revokeHash !== null}
        danger
        title="撤销设备"
        description="撤销后该设备将立即断开，令牌失效，需重新扫码配对才能连接。确定撤销？"
        confirmLabel="撤销"
        onConfirm={() => void handleRevoke()}
        onCancel={() =>
          dispatchDeviceList({ type: 'setRevokeHash', hash: null })
        }
      />

      <ConfirmDialog
        open={pairing.confirmClosePairing}
        danger
        title="关闭配对"
        description="关闭配对将撤销全部已配对设备并断开连接（令牌全部失效，已连接设备立即断开，需重新扫码配对才能连接）。确定关闭配对？"
        confirmLabel="关闭配对"
        onConfirm={() => {
          dispatchPairing({ type: 'setConfirmClosePairing', open: false });
          void handleToggle(false);
        }}
        onCancel={() =>
          dispatchPairing({ type: 'setConfirmClosePairing', open: false })
        }
      />
    </SettingsPage>
  );
};
