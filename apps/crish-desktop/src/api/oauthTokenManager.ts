/**
 * OAuth Token Dynamic Refresh & Lifecycle Manager
 *
 * 职责：
 * - 自动化管理 OAuth 2.0 (Qwen Portal, GitHub Copilot, 订阅网关) 访问令牌
 * - 提前 5 分钟 (REFRESH_BUFFER_MS) 自动发起静默刷新
 * - 支持单飞互斥锁 (Single-Flight Mutex)，防止并发请求重复刷 Token
 * - 自动与引擎 Daemon 及本地 Profile 注册表同步
 */

import {
  loadProfiles,
  saveProfiles,
  type OAuthTokenData,
} from './providerProfiles';
import { logger } from '../services/LoggerService';
import { errorStore } from '../services/ErrorStore';

/** 提前刷新缓冲时间（5 分钟） */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
/** 未返回 expires_in 时的默认过期假设（1 小时） */
const DEFAULT_EXPIRY_MS = 60 * 60 * 1000;
/** setTimeout 可接受的最大延迟（2^31 - 1 ms） */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** 单飞互斥锁 Map：防止同一个 Profile 同时触发多次刷新请求 */
const refreshPromises = new Map<string, Promise<OAuthTokenData | null>>();

/** 动态定时器 Handle 映射表 */
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** 连续刷新失败计数（按 profileId）—— 达 3 次后 severity 升级为 error */
const refreshFailureCounts = new Map<string, number>();

/** 检查 Token 是否已过期或即将在 5 分钟内过期 */
function isTokenExpiringSoon(token?: OAuthTokenData): boolean {
  if (!token || !token.accessToken) return true;
  const now = Date.now();
  return token.expiresAt - now <= REFRESH_BUFFER_MS;
}

/** 执行 OAuth Refresh Token 刷新（带单飞锁与引擎同步） */
async function refreshOAuthToken(
  profileId: string
): Promise<OAuthTokenData | null> {
  // 单飞锁检查：若当前已有针对该 Profile 的刷新在进行中，直接复用 Promise
  if (refreshPromises.has(profileId)) {
    return refreshPromises.get(profileId)!;
  }

  const promise = (async () => {
    try {
      const profiles = loadProfiles();
      const profile = profiles.find((p) => p.id === profileId);
      if (
        !profile ||
        profile.authType !== 'oauth2' ||
        !profile.oauthConfig ||
        !profile.oauthToken
      ) {
        return null;
      }

      const { oauthConfig, oauthToken } = profile;
      if (!oauthToken.refreshToken) {
        // 修复 3：配置问题——仅 logger.warn，不推入 errorStore（非运行时故障）
        logger.warn(
          `[OAuthTokenManager] 缺少 refreshToken，无法自动刷新: ${profileId}`,
          {
            module: 'oauthTokenManager',
          }
        );
        return null;
      }

      const refreshEndpoint = oauthConfig.refreshUrl || oauthConfig.tokenUrl;
      const bodyParams = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: oauthToken.refreshToken,
        client_id: oauthConfig.clientId,
        ...(oauthConfig.clientSecret
          ? { client_secret: oauthConfig.clientSecret }
          : {}),
        ...(oauthConfig.scopes?.length
          ? { scope: oauthConfig.scopes.join(' ') }
          : {}),
      });

      const response = await fetch(refreshEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: bodyParams.toString(),
      });

      if (!response.ok) {
        throw new Error(`OAuth 刷新请求失败 HTTP ${response.status}`);
      }

      const data = (await response.json()) as Record<string, unknown>;
      const expiresIn =
        typeof data.expires_in === 'number'
          ? data.expires_in * 1000
          : DEFAULT_EXPIRY_MS;
      const now = Date.now();

      const scopeVal =
        typeof data.scope === 'string' ? data.scope : oauthToken.scope;
      const updatedToken: OAuthTokenData = {
        accessToken: String(data.access_token || ''),
        refreshToken: String(data.refresh_token || oauthToken.refreshToken),
        expiresAt:
          typeof data.expires_at === 'number'
            ? data.expires_at * 1000
            : now + expiresIn,
        tokenType: String(data.token_type || 'Bearer'),
        issuedAt: now,
        ...(scopeVal !== undefined && { scope: scopeVal }),
      };

      if (!updatedToken.accessToken) {
        throw new Error('刷新接口未返回有效 access_token');
      }

      // 更新持久化 Profile
      profile.oauthToken = updatedToken;
      profile.hasKey = true;
      saveProfiles(profiles);

      // 刷新成功 → 重置连续失败计数
      refreshFailureCounts.delete(profileId);

      // 自动安排下一次定时静默刷新
      scheduleTokenRefresh(profileId, updatedToken);

      return updatedToken;
    } catch (err) {
      // 修复 3：刷新失败 → logger.error + errorStore.push
      // 连续失败 ≥ 3 次后 severity 升级为 'error'
      const failures = (refreshFailureCounts.get(profileId) ?? 0) + 1;
      refreshFailureCounts.set(profileId, failures);
      const severity = failures >= 3 ? 'error' : 'warning';
      logger.error(
        `[OAuthTokenManager] 刷新服务商 ${profileId} Token 失败（连续 ${failures} 次）:`,
        {
          module: 'oauthTokenManager',
          err:
            err instanceof Error
              ? { message: err.message, stack: err.stack, name: err.name }
              : { message: String(err) },
        }
      );
      try {
        errorStore.push({
          code: 'OAUTH_TOKEN_REFRESH_FAILED',
          module: 'oauthTokenManager',
          severity,
          message: `OAuth Token 刷新失败（服务商 ${profileId}，连续 ${failures} 次）`,
          autoResolve: false,
          ...(err instanceof Error
            ? { technical: err.message }
            : { technical: String(err) }),
        });
      } catch {
        /* errorStore.push 失败不阻断降级主流程 */
      }
      return null;
    } finally {
      refreshPromises.delete(profileId);
    }
  })();

  refreshPromises.set(profileId, promise);
  return promise;
}

/** 调度动态刷新定时器 */
function scheduleTokenRefresh(profileId: string, token: OAuthTokenData): void {
  if (refreshTimers.has(profileId)) {
    clearTimeout(refreshTimers.get(profileId)!);
    refreshTimers.delete(profileId);
  }

  const now = Date.now();
  const refreshTime = token.expiresAt - REFRESH_BUFFER_MS;
  const delay = Math.max(0, refreshTime - now);

  // setTimeout 的延迟上限为 2^31-1 ms（约 24.8 天），超过会被当作 0 立即触发，
  // 导致长效 token（如 30 天）刷新后立刻再次刷新、形成请求风暴。
  // 超限时先等待上限时长，再按同一 token 重新调度（分段等待）。
  const exceedsTimerLimit = delay > MAX_TIMER_DELAY_MS;
  const timer = setTimeout(
    () => {
      if (exceedsTimerLimit) {
        scheduleTokenRefresh(profileId, token);
      } else {
        void refreshOAuthToken(profileId);
      }
    },
    exceedsTimerLimit ? MAX_TIMER_DELAY_MS : delay
  );

  refreshTimers.set(profileId, timer);
}

/** 启动应用时初始化所有启用服务商的 OAuth Token 定时调度 */
export function initOAuthTokenScheduler(): void {
  try {
    const profiles = loadProfiles();
    for (const p of profiles) {
      if (p.enabled !== false && p.authType === 'oauth2' && p.oauthToken) {
        if (isTokenExpiringSoon(p.oauthToken)) {
          void refreshOAuthToken(p.id);
        } else {
          scheduleTokenRefresh(p.id, p.oauthToken);
        }
      }
    }
  } catch (err) {
    // 修复 3：调度器初始化失败 → logger.warn + errorStore.push（severity=info，可自动解决）
    logger.warn('[OAuthTokenManager] 初始化 OAuth 调度器失败:', {
      module: 'oauthTokenManager',
      err:
        err instanceof Error
          ? { message: err.message, stack: err.stack, name: err.name }
          : { message: String(err) },
    });
    try {
      errorStore.push({
        code: 'OAUTH_SCHEDULER_INIT_FAILED',
        module: 'oauthTokenManager',
        severity: 'info',
        message: 'OAuth 调度器初始化失败',
        autoResolve: true,
        ...(err instanceof Error
          ? { technical: err.message }
          : { technical: String(err) }),
      });
    } catch {
      /* errorStore.push 失败不阻断主流程 */
    }
  }
}
