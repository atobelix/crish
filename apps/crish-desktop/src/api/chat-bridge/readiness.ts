/**
 * 就绪状态机 + contextWindow 解析（从 ConnectionLifecycle 拆出，纯结构性）。
 *
 * ## Transport SoT
 * - 唯一通道：getTransport()（TauriTransport，进程内核心直连，03 §3.1）。
 * - 核心未就绪（waitUntilConnected 超时）→ 拒绝启动（C3.4：无 directFetch 降级）。
 */
import { getTransport } from '../transport';
import { classifyErrorDomain, domainUserMessage, logInternalError, networkUserMessage } from '../userFacingErrors';
import type { ErrorDomain } from '../userFacingErrors';
import type { Settings } from '../clientApi';
import { getActiveModelId, getActiveProfileId } from '../providerProfiles';
import { getModelMeta } from '../modelCatalog';

export type ReadinessState = 'ok' | 'blocked_with_action' | 'retryable_wait';

export interface ReadinessGuidance {
  action: 'open-settings' | 'wait' | 'none';
  targetTab?: string;
  message: string;
}

export interface ReadinessCheckResult {
  ok: boolean;
  state: ReadinessState;
  domain: ErrorDomain | null;
  guidance?: ReadinessGuidance;
}

/** 动态重置就绪状态机（当收到配置变更或后端事件时调用） */
export function resetReadiness(): void {
  const transport = getTransport();
  if (
    typeof (transport as unknown as { resetReadiness?: () => void })
      .resetReadiness === 'function'
  ) {
    (transport as unknown as { resetReadiness: () => void }).resetReadiness();
  }
}

/** 响应式就绪监听器：收到 engine-status-changed 或 config-reloaded 事件时自愈同步 */
let readinessListenerSubscribed = false;

export function ensureReadinessSync(): void {
  if (readinessListenerSubscribed) return;
  readinessListenerSubscribed = true;
  try {
    const transport = getTransport();
    transport.onMessage((event) => {
      if (
        event?.type === 'engine-status-changed' ||
        event?.type === 'config-reloaded'
      ) {
        const isReady =
          event.engineReady === true ||
          event.engine_ready === true ||
          event.ready === true;
        if (!isReady) resetReadiness();
      }
    });
  } catch {
    /* swallow-ok */
  }
}

export function resolveContextWindow(
  sets?: Settings | null
): number | undefined {
  const explicit = (sets as { contextWindow?: unknown } | null)?.contextWindow;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0)
    return Math.floor(explicit);
  try {
    const profileId = getActiveProfileId(),
      model = getActiveModelId();
    if (profileId && model) {
      const meta = getModelMeta(profileId, model);
      if (typeof meta.contextLength === 'number' && meta.contextLength > 0)
        return meta.contextLength;
    }
  } catch {
    /* swallow-ok: 目录读取失败不发窗口 */
  }
  return undefined;
}

/**
 * 发送前真实就绪检查（03 §⑤ R7）：实时 core_get_status 查询，三态结构化返回值。
 */
export async function checkEngineReadyRealtime(
  timeoutMs = 3_000
): Promise<ReadinessCheckResult> {
  ensureReadinessSync();
  const transport = getTransport();
  let status: unknown;
  try {
    status = await transport.request<unknown>(
      'core_get_status',
      {},
      { timeoutMs }
    );
  } catch {
    /* swallow-ok: 查询失败放行，避免双重报错 */
    return {
      ok: true,
      state: 'ok',
      domain: null,
      guidance: { action: 'none', message: '' },
    };
  }
  const domain = classifyErrorDomain(status);
  if (domain === 'S2') {
    return {
      ok: false,
      state: 'blocked_with_action',
      domain: 'S2',
      guidance: {
        action: 'open-settings',
        targetTab: 'models',
        message: domainUserMessage('S2'),
      },
    };
  }
  if (domain) {
    return {
      ok: false,
      state: 'retryable_wait',
      domain,
      guidance: { action: 'wait', message: domainUserMessage(domain) },
    };
  }
  return {
    ok: true,
    state: 'ok',
    domain: null,
    guidance: { action: 'none', message: '' },
  };
}

export async function ensureEngineConnected(): Promise<{
  ok: boolean;
  error?: string;
}> {
  ensureReadinessSync();
  const transport = getTransport();
  try {
    const ready = await transport.waitUntilConnected(20_000);
    if (!ready) {
      return {
        ok: false,
        error: networkUserMessage(new Error('核心未就绪（等待连接超时）')),
      };
    }
    return { ok: true };
  } catch (e) {
    logInternalError('ensureEngineConnected', e);
    return { ok: false, error: networkUserMessage(e) };
  }
}
