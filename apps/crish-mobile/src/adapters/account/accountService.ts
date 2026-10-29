// 账号编排：SecureStore 凭据 + 账号中心 HTTP + 中继在线设备发现。
// 领域 store 只保存状态；本文件负责副效应，UI/runtime 只调用这里。

import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { generateDeviceId } from '@/pairing/pairProtocol';
import {
  clearAccountSession,
  expoSecureStoreDriver,
  loadAccountSession,
  saveAccountSession,
  type AccountSession,
  type SecureStoreDriver,
} from '@/db/secureStore';
import { accountStore } from '@/domain/store/accountStore';
import type {
  AccountDevice,
  AccountProfile,
  AccountSessionInfo,
  AccountUser,
  EmailCodeScene,
} from '@/domain/types/account';
import {
  AccountApiError,
  changeAccountPassword,
  confirmEmailContinue,
  continueEmail,
  deleteAccountRemote,
  fetchAccountMe,
  fetchAccountProfile,
  fetchAccountSessions,
  fetchClientTicket,
  fetchRelayDevices,
  loginAccount,
  logoutAccountSession,
  refreshAccount,
  requestEmailCode,
  requestPasswordChangeCode,
  revokeAccountSession,
  setAccountPassword,
  updateAccountProfile,
  uploadAccountAvatar,
  verifyEmailCode,
  type AccountTokenPair,
  type ClientTicket,
  type ContinueEmailTicket,
  type EmailCodeTicket,
  type EmailContinueOutcome,
} from './accountApi';

const driver: SecureStoreDriver = expoSecureStoreDriver();
let cachedDeviceId: string | null = null;

function deviceName(): string {
  const fromConstants =
    typeof Constants.deviceName === 'string' ? Constants.deviceName.trim() : '';
  if (fromConstants) return fromConstants;
  return Platform.OS === 'ios' ? 'iPhone' : 'Android';
}

async function accountDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  const existing = await driver.getItem('account.device_id');
  if (existing && existing.trim()) {
    cachedDeviceId = existing.trim();
    return cachedDeviceId;
  }
  const generated = generateDeviceId();
  cachedDeviceId = generated;
  await driver.setItem('account.device_id', generated);
  return generated;
}

function currentAccessToken(): string | null {
  return accountStore.getState().accessToken;
}

async function persist(session: AccountSession): Promise<void> {
  await saveAccountSession(driver, session);
}

async function clearAll(): Promise<void> {
  await clearAccountSession(driver);
  accountStore.getState().reset();
}

async function refreshAccessToken(): Promise<string | null> {
  const session = await loadAccountSession(driver);
  if (!session) {
    await clearAll();
    return null;
  }
  try {
    const pair = await refreshAccount(session.refreshToken);
    const next: AccountSession = {
      ...session,
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      userId: pair.user?.id ?? session.userId,
      email: pair.user?.email ?? session.email,
    };
    await persist(next);
    accountStore.getState().setAccessToken(pair.accessToken);
    if (pair.user) accountStore.getState().setUser(pair.user);
    return pair.accessToken;
  } catch (error) {
    if (error instanceof AccountApiError && error.status === 401) {
      await clearAll();
      return null;
    }
    throw error;
  }
}

async function withAccessToken<T>(
  operation: (token: string) => Promise<T>
): Promise<T> {
  const token = currentAccessToken();
  if (!token) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      throw new AccountApiError(401, 'unauthorized', '登录已失效');
    }
    return operation(refreshed);
  }
  try {
    return await operation(token);
  } catch (error) {
    if (error instanceof AccountApiError && error.status === 401) {
      const refreshed = await refreshAccessToken();
      if (!refreshed) {
        throw new AccountApiError(401, 'unauthorized', '登录已失效');
      }
      return operation(refreshed);
    }
    throw error;
  }
}

async function loadDevices(token: string): Promise<AccountDevice[]> {
  return fetchRelayDevices(token);
}

/** 在线设备发现失败不阻断登录；远程 runtime 会在下一轮 discovery 重试。 */
async function loadDevicesBestEffort(token: string): Promise<AccountDevice[]> {
  try {
    return await loadDevices(token);
  } catch (error) {
    console.warn(
      `[account] 在线设备发现失败（将在后续重试）：${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return [];
  }
}

/** 冷启动恢复账号；无凭据 → loggedOut，不抛错。 */
export async function hydrateAccount(): Promise<void> {
  const state = accountStore.getState();
  if (state.hydrated) return;
  const session = await loadAccountSession(driver);
  if (!session) {
    accountStore.getState().setHydrated(true);
    accountStore.getState().setStatus('loggedOut');
    return;
  }
  const deviceId = session.deviceId || (await accountDeviceId());
  accountStore.getState().setAccessToken(session.accessToken);
  try {
    let user: AccountUser | null = session.accessToken
      ? await fetchAccountMe(session.accessToken).catch(async (error) => {
          if (error instanceof AccountApiError && error.status === 401) {
            const refreshed = await refreshAccessToken();
            if (!refreshed) return null;
            return fetchAccountMe(refreshed);
          }
          throw error;
        })
      : null;
    if (!user) {
      const refreshed = await refreshAccessToken();
      if (!refreshed) return;
      user = await fetchAccountMe(refreshed);
    }
    const token = currentAccessToken();
    if (!token) return;
    const [devices, profile] = await Promise.all([
      loadDevicesBestEffort(token),
      fetchAccountProfile(token).catch(() => null),
    ]);
    accountStore.getState().setUser(user);
    if (profile) accountStore.getState().setProfile(profile);
    accountStore.getState().setDevices(devices);
    accountStore.getState().setStatus('loggedIn');
    accountStore.getState().setError(null);
    await persist({
      accessToken: token,
      refreshToken: session.refreshToken,
      deviceId,
      userId: user.id,
      email: user.email,
    });
  } catch (error) {
    accountStore.getState().setStatus('error');
    accountStore
      .getState()
      .setError(error instanceof Error ? error.message : '账号恢复失败');
  } finally {
    accountStore.getState().setHydrated(true);
  }
}

/** 建立会话：持久化 refresh token + 内存态 + 资料 + 在线设备。 */
async function applyTokenPair(
  pair: AccountTokenPair,
  deviceId: string
): Promise<void> {
  const user = pair.user ?? (await fetchAccountMe(pair.accessToken));
  await persist({
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    deviceId,
    userId: user.id,
    email: user.email,
  });
  const store = accountStore.getState();
  store.setAccessToken(pair.accessToken);
  store.setUser(user);
  const [devices, profile] = await Promise.all([
    loadDevicesBestEffort(pair.accessToken),
    fetchAccountProfile(pair.accessToken).catch(() => null),
  ]);
  if (profile) accountStore.getState().setProfile(profile);
  accountStore.getState().setDevices(devices);
  accountStore.getState().setStatus('loggedIn');
  accountStore.getState().setHydrated(true);
}

async function runLoginFlow(operation: () => Promise<void>): Promise<boolean> {
  const store = accountStore.getState();
  store.setStatus('loggingIn');
  store.setError(null);
  try {
    await operation();
    return true;
  } catch (error) {
    accountStore.getState().setStatus('error');
    accountStore
      .getState()
      .setError(error instanceof Error ? error.message : '登录失败');
    return false;
  }
}

/** 邮箱密码登录；成功后拉取资料与在线桌面设备。 */
export function loginAccountWithPassword(
  email: string,
  password: string
): Promise<boolean> {
  return runLoginFlow(async () => {
    const deviceId = await accountDeviceId();
    const pair = await loginAccount(email, password, deviceId, deviceName());
    await applyTokenPair(pair, deviceId);
  });
}

/** 统一邮箱入口：已注册发登录码，未注册发注册码。 */
export async function continueAccountEmail(
  email: string
): Promise<ContinueEmailTicket> {
  return continueEmail(email);
}

/**
 * 统一邮箱入口 · 确认验证码：
 * 已有账号直接建立会话；新账号返回 setupToken（由设置密码页完成注册）。
 */
export async function confirmAccountEmailContinue(
  email: string,
  code: string
): Promise<EmailContinueOutcome> {
  const deviceId = await accountDeviceId();
  const outcome = await confirmEmailContinue(
    email,
    code,
    deviceId,
    deviceName()
  );
  if (outcome.kind === 'signed_in') {
    await applyTokenPair(outcome.session, deviceId);
  }
  return outcome;
}

/** 重置密码 · 校验验证码换取 setupToken（不建立会话）。 */
export async function verifyAccountResetCode(
  email: string,
  code: string
): Promise<string> {
  return verifyEmailCode(email, code, 'reset_password');
}

/** 注册 / 重置 · 凭 setupToken 设置密码并建立会话。 */
export function setAccountPasswordWithToken(
  setupToken: string,
  password: string
): Promise<boolean> {
  return runLoginFlow(async () => {
    const deviceId = await accountDeviceId();
    const pair = await setAccountPassword(
      setupToken,
      password,
      deviceId,
      deviceName()
    );
    await applyTokenPair(pair, deviceId);
  });
}

/** 已登录修改密码 · 发送验证码。 */
export async function requestAccountPasswordChangeCode(): Promise<EmailCodeTicket> {
  return withAccessToken(requestPasswordChangeCode);
}

/** 已登录修改密码 · 凭验证码提交新密码。 */
export async function confirmAccountPasswordChange(
  code: string,
  newPassword: string
): Promise<void> {
  await withAccessToken((token) =>
    changeAccountPassword(token, code, newPassword)
  );
}

/** 注销账号：服务端校验确认邮箱后匿名化；成功后清空本地会话。 */
export async function deleteAccountByConfirmEmail(
  confirmEmail: string
): Promise<void> {
  await withAccessToken((token) => deleteAccountRemote(token, confirmEmail));
  await clearAll();
  accountStore.getState().setHydrated(true);
  accountStore.getState().setStatus('loggedOut');
}

/** 请求邮件验证码（登录 / 注册 / 重置密码；注册与重置需同时提交密码）。 */
export async function requestAccountEmailCode(
  scene: EmailCodeScene,
  email: string,
  password?: string
): Promise<EmailCodeTicket> {
  return requestEmailCode(scene, email, password);
}

/** 退出账号：尽力吊销服务端会话，再清 SecureStore 与内存态。 */
export async function logoutAccount(): Promise<void> {
  const session = await loadAccountSession(driver);
  if (session) {
    try {
      await logoutAccountSession(session.refreshToken);
    } catch {
      // 网络失败仍允许本地退出
    }
  }
  await clearAll();
  accountStore.getState().setHydrated(true);
  accountStore.getState().setStatus('loggedOut');
}

/** 刷新在线桌面设备；401 会静默续期。 */
export async function refreshAccountDevices(): Promise<void> {
  try {
    const devices = await withAccessToken(loadDevices);
    accountStore.getState().setDevices(devices);
    accountStore.getState().setError(null);
  } catch (error) {
    accountStore
      .getState()
      .setError(error instanceof Error ? error.message : '设备列表刷新失败');
  }
}

/** 刷新账号资料；失败静默（资料页可手动重试）。 */
export async function refreshAccountProfile(): Promise<void> {
  try {
    const profile = await withAccessToken(fetchAccountProfile);
    accountStore.getState().setProfile(profile);
  } catch {
    // 静默失败：资料读取不阻塞主流程
  }
}

/** 保存昵称 / 简介；错误上抛给资料页展示。 */
export async function saveAccountProfile(input: {
  displayName?: string;
  bio?: string;
}): Promise<AccountProfile> {
  const profile = await withAccessToken((token) =>
    updateAccountProfile(token, input)
  );
  accountStore.getState().setProfile(profile);
  const current = accountStore.getState().user;
  accountStore.getState().setUser({
    id: profile.accountId,
    email: profile.email ?? current?.email ?? '',
    name: profile.displayName,
  });
  return profile;
}

/** 上传头像（data URL；账号中心限制 3 MiB）。 */
export async function uploadAccountAvatarImage(
  dataUrl: string,
  fileName?: string
): Promise<AccountProfile> {
  const profile = await withAccessToken((token) =>
    uploadAccountAvatar(token, dataUrl, fileName)
  );
  accountStore.getState().setProfile(profile);
  return profile;
}

/** 当前账号的登录会话列表。 */
export async function listAccountSessions(): Promise<AccountSessionInfo[]> {
  return withAccessToken(fetchAccountSessions);
}

/** 撤销指定登录会话。 */
export async function revokeAccountSessionById(
  sessionId: string
): Promise<void> {
  await withAccessToken((token) => revokeAccountSession(token, sessionId));
}

/** 选择/切换目标桌面（UI 调用）。 */
export function selectAccountTarget(deviceId: string | null): void {
  accountStore.getState().selectTarget(deviceId);
}

/** 为当前目标桌面申请 client 票据（每次重连都重新申请）。 */
export async function requestClientTicket(
  targetDeviceId: string
): Promise<ClientTicket> {
  const deviceId = await accountDeviceId();
  return withAccessToken((token) =>
    fetchClientTicket(token, deviceId, deviceName(), targetDeviceId)
  );
}

export async function getAccountDeviceId(): Promise<string> {
  return accountDeviceId();
}

/** 当前账号用户（供 UI 只读）。 */
export function getAccountUser(): AccountUser | null {
  return accountStore.getState().user;
}
