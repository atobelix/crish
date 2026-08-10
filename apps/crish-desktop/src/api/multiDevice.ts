/**
 * 多端互通 API 桥接层（R1-07 配对四件套 + R1-08 撤销/改名）。
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

// ── 命令封装（三态返回，missing/error 均不抛，调用方诚实呈现）────────

/** 开启配对：生成 CXN 码 + 局域网监听重绑，返回码/二维码/防火墙提示 */
export async function pairStart(): Promise<PairStartResult | null> {
  const res = await invokeTyped<PairStartResult>('multi_device_pair_start', {});
  if (res.status === 'ok') return res.data;
  logInternalError('pairStart', `multi_device_pair_start ${res.status === 'missing' ? 'missing' : res.message}`);
  return null;
}

/** 配对状态快照（轮询消费） */
export async function pairStatus(): Promise<PairStatus | null> {
  const res = await invokeTyped<PairStatus>('multi_device_pair_status', {});
  if (res.status === 'ok') return res.data;
  logInternalError('pairStatus', `multi_device_pair_status ${res.status === 'missing' ? 'missing' : res.message}`);
  return null;
}

/** 取消配对：状态机重置 + 回环监听恢复 */
export async function pairCancel(): Promise<boolean> {
  const res = await invokeTyped<void>('multi_device_pair_cancel', {});
  if (res.status === 'ok') return true;
  logInternalError('pairCancel', `multi_device_pair_cancel ${res.status === 'missing' ? 'missing' : res.message}`);
  return false;
}

/** 已配对设备列表 */
export async function listDevices(): Promise<DeviceInfo[]> {
  const res = await invokeTyped<DeviceInfo[]>('multi_device_list_devices', {});
  if (res.status === 'ok') return res.data;
  logInternalError('listDevices', `multi_device_list_devices ${res.status === 'missing' ? 'missing' : res.message}`);
  return [];
}

/** 撤销指定设备（令牌失效 + 落盘 + WS 踢出；返回是否命中） */
export async function revokeDevice(hash: string): Promise<boolean> {
  const res = await invokeTyped<boolean>('multi_device_revoke_device', { hash });
  if (res.status === 'ok') return res.data;
  logInternalError('revokeDevice', `multi_device_revoke_device ${res.status === 'missing' ? 'missing' : res.message}`);
  return false;
}

/** 重命名设备标签（返回是否命中） */
export async function renameDevice(hash: string, newLabel: string): Promise<boolean> {
  const res = await invokeTyped<boolean>('multi_device_rename_device', {
    hash,
    newLabel,
  });
  if (res.status === 'ok') return res.data;
  logInternalError('renameDevice', `multi_device_rename_device ${res.status === 'missing' ? 'missing' : res.message}`);
  return false;
}
