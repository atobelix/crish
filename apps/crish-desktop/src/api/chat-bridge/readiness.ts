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
import { getLiveModel, resolveThinkingHandoff } from '../modelsCatalogLive';
import { getSessionThinkingTitle } from '../SessionRuntimeRegistry';

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

/**
 * 发送路径上下文窗口：只读 live `contextWindow`。
 * 缺省 / 非正数 / 未加载 → undefined。禁止 128_000 假上限，不读 settings / LS meta。
 */
export function resolveContextWindow(
  _sets?: Settings | null
): number | undefined {
  try {
    const profileId = getActiveProfileId();
    const model = getActiveModelId();
    if (!profileId || !model) return undefined;
    const window = getLiveModel(profileId, model)?.contextWindow;
    if (typeof window === 'number' && Number.isFinite(window) && window > 0) {
      return Math.floor(window);
    }
  } catch {
    /* swallow-ok: live 读取失败不发窗口 */
  }
  return undefined;
}

/**
 * 发送瞬间思考档位：会话 Title（yaml key）对 live 字典解析为 wire。
 * 不支持思考 → 空对象（省略，不伪造 Off）。settings.defaultThinkingLevel 不是规格。
 */
export function resolveSendThinkingFields(
  sessionId?: string | null,
  selectedTitleOverride?: string | null
): {
  thinkingTitle?: string;
  thinkingWire?: string;
} {
  try {
    const providerId = getActiveProfileId();
    const modelId = getActiveModelId();
    if (!providerId || !modelId) return {};
    const selectedTitle =
      typeof selectedTitleOverride === 'string' && selectedTitleOverride.trim()
        ? selectedTitleOverride.trim()
        : sessionId
          ? getSessionThinkingTitle(sessionId)
          : null;
    const handoff = resolveThinkingHandoff(providerId, modelId, selectedTitle);
    if (!handoff.supported) return {};
    return {
      thinkingTitle: handoff.selectedTitle,
      thinkingWire: handoff.selectedWire,
    };
  } catch {
    return {};
  }
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
