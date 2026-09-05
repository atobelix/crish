/**
 * 多端互通 API 桥接层（R1-07 配对四件套 + R1-08 撤销/改名 + R1-09 网络检测）。
 * 所有调用经 Tauri invoke 转发到 Rust 侧 multi_device_* 命令面；
 * 失败按 invokeTyped 三态路由，错误经 logInternalError 登记。
 */
import { invokeTyped } from './tauriInvoke';
import { logInternalError } from './userFacingErrors';

// ── 契约类型（镜像 Rust pairing.rs 序列化结构，serde camelCase）────────

/** 配对开启结果：CXN 码 / 二维码编码串 / 防火墙提示 */
export interface PairStartResult {
  code: string;
  qr: string;
  firewall_hint: string;
}

/** 配对状态快照（状态机/剩余时间/失败次数/令牌数） */
export interface PairStatus {
  state: string;
  pairing_enabled: boolean;
  bind_mode: string;
  code_remaining_ms: number | null;
  failed_attempts: number;
  token_count: number;
}

/** 已配对设备条目（哈希仅截断展示，不泄露原文） */
export interface DeviceInfo {
  id: string;
  label: string;
  issued_at_ms: number;
  revoked: boolean;
}

export interface NetworkEnvInfo {
  /** 网络配置文件类别：public / private / domain / unknown */
  profile: 'public' | 'private' | 'domain' | 'unknown';
  /** 可直连 IP 列表（serde camelCase 真实输出） */
  usableIps?: string[];
  /** 兼容既有蛇形测试用例（usable_ips） */
  usable_ips?: string[];
  /** 引导文案（公用网络切换 / AP 隔离兜底，UI 直接渲染） */
  hint: string;
}

// ── 命令封装（三态返回，missing/error 均不抛，调用方诚实呈现）────────

/** 开启配对：生成 CXN 码 + 局域网监听重绑，返回码/二维码/防火墙提示 */
export async function pairStart(): Promise<PairStartResult | null> {
  const res = await invokeTyped<PairStartResult>('multi_device_pair_start', {});
  if (res.status === 'ok') return res.data;
  logInternalError(
    'pairStart',
    `multi_device_pair_start ${res.status === 'missing' ? 'missing' : res.message}`
  );
  return null;
}

/** 配对状态快照（轮询消费） */
export async function pairStatus(): Promise<PairStatus | null> {
  const res = await invokeTyped<PairStatus>('multi_device_pair_status', {});
  if (res.status === 'ok') return res.data;
  logInternalError(
    'pairStatus',
    `multi_device_pair_status ${res.status === 'missing' ? 'missing' : res.message}`
  );
  return null;
}

/** 关闭配对（D2 §5.4 关闭动作 / R1-11 G-4）：撤销全部设备——令牌全部
 *  失效 + WS 全部踢出 + 状态机重置 + 回 Loopback 重绑。 */
export async function pairCancel(): Promise<boolean> {
  const res = await invokeTyped<void>('multi_device_pair_cancel', {});
  if (res.status === 'ok') return true;
  logInternalError(
    'pairCancel',
    `multi_device_pair_cancel ${res.status === 'missing' ? 'missing' : res.message}`
  );
  return false;
}

/** 已配对设备列表 */
export async function listDevices(): Promise<DeviceInfo[]> {
  const res = await invokeTyped<DeviceInfo[]>('multi_device_list_devices', {});
  if (res.status === 'ok') return res.data;
  logInternalError(
    'listDevices',
    `multi_device_list_devices ${res.status === 'missing' ? 'missing' : res.message}`
  );
  return [];
}

/** 撤销指定设备（令牌失效 + 落盘 + WS 踢出；返回是否命中） */
export async function revokeDevice(hash: string): Promise<boolean> {
  const res = await invokeTyped<boolean>('multi_device_revoke_device', {
    hash,
  });
  if (res.status === 'ok') return res.data;
  logInternalError(
    'revokeDevice',
    `multi_device_revoke_device ${res.status === 'missing' ? 'missing' : res.message}`
  );
  return false;
}

/** 重命名设备标签（返回是否命中） */
export async function renameDevice(
  hash: string,
  newLabel: string
): Promise<boolean> {
  const res = await invokeTyped<boolean>('multi_device_rename_device', {
    hash,
    newLabel,
  });
  if (res.status === 'ok') return res.data;
  logInternalError(
    'renameDevice',
    `multi_device_rename_device ${res.status === 'missing' ? 'missing' : res.message}`
  );
  return false;
}

export async function networkEnvInfo(): Promise<NetworkEnvInfo | null> {
  const res = await invokeTyped<NetworkEnvInfo>(
    'multi_device_network_info',
    {}
  );
  if (res.status === 'ok') {
    const raw = res.data;
    const ips = raw.usableIps ?? raw.usable_ips ?? [];
    return {
      profile: raw.profile,
      usableIps: ips,
      usable_ips: ips,
      hint: raw.hint,
    };
  }
  logInternalError(
    'networkEnvInfo',
    `multi_device_network_info ${res.status === 'missing' ? 'missing' : res.message}`
  );
  return null;
}

/**
 * 多端服务总开关（R1-11 G-1）：true = 服务开启（按当前配对态绑定监听）；
 * false = 停服（不 bind 任何端口，红线 1 零监听）。
 * 服务关闭时 multi_device_pair_start 会被守卫拒绝——配对页必须先开启服务。
 */
export async function setMultiDeviceEnabled(
  enabled: boolean
): Promise<boolean> {
  const res = await invokeTyped<void>('multi_device_set_enabled', { enabled });
  if (res.status === 'ok') return true;
  logInternalError(
    'setMultiDeviceEnabled',
    `multi_device_set_enabled ${res.status === 'missing' ? 'missing' : res.message}`
  );
  return false;
}
