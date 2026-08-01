/**
 * Tauri IPC Transport —— 03 §3.3 职责表的 IPC 模式实现。
 *
 * 职责映射（对照 types.ts 的职责表）：
 * - request（职责 5）→ invokeTyped(cmd, payload)，cmd 即 core_* 命令名
 * - send（职责 6）→ invokeTyped(cmd, payload)（fire-and-forget 语义，错误仍上抛）
 * - onMessage（职责 7）→ 懒订阅 `listen('workbench-run-event', e => listener(e.payload))`
 *   （03 §3.1 前端替换点；订阅模式对齐 ptySessionApi.ts:201-234 的懒加载 fanout）
 * - waitUntilConnected（职责 8）→ core_get_status 轮询（engineReady/dbReady 判定）
 * - onStatus（职责 2）→ 「核心已初始化」布尔投影（connecting/connected/failed）
 * - stop → 退订事件通道 + 复位状态
 *
 * 事件载荷形状：Rust B6.3 emit 完整事件 JSON，顶层平铺
 * `{ type, runId, sessionId, sequence, ...事件字段 }`（03 §3.1:190-191），
 * 逐字透传，不做归一化（EventRouter.onMsg 直进 handleAgentEvent）。
 *
 * 不依赖 WebSocket：无心跳、无重连（进程内核心，断连即应用退出）。
 */

import { invokeTyped, type InvokeTypedResult } from '../tauriInvoke';
import { initCommandManifest } from './commandManifest';
import {
  checkCommandMapConsistency,
  resolveTauriCommand,
  shapeTauriPayload,
} from './commandMap';
import { logger, toErrMeta } from '../../services/LoggerService';

/** workbench-run-event：Rust 事件 emit 通道（03 §3.1，对齐旧 lifecycle.rs:287-303 模式） */
export const RUN_EVENT_CHANNEL = 'workbench-run-event';

/** core_get_status：核心初始化状态查询（03 §3.2 B） */
export const CORE_GET_STATUS = 'core_get_status';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

export interface TauriTransportOptions {
  /** 轮询间隔（测试可注入小值加速）。默认 250ms。 */
  pollIntervalMs?: number;
  /** request 默认超时。默认 30s。 */
  timeoutMs?: number;
}

/**
 * 核心初始化判定：engineReady / dbReady（B6.2「核心已初始化」布尔），
 * 兼容现有壳的 searchIndexReady 别名；任一为 true 即视为就绪。
 */
function isCoreReady(status: unknown): boolean {
  if (typeof status !== 'object' || status === null) return false;
  const s = status as Record<string, unknown>;
  for (const key of [
    'engineReady',
    'engine_ready',
    'dbReady',
    'db_ready',
    'searchIndexReady',
    'search_index_ready',
  ] as const) {
    if (typeof s[key] === 'boolean') {
      if (s[key] === true) return true;
    }
  }
  return false;
}

/** 惰性加载并缓存 Tauri listen（非 Tauri 环境返回 null，与 tauriInvoke.getTauriInvoke 同策略） */
let cachedListen: ((event: string, handler: (e: { payload?: unknown }) => void) => Promise<() => void>) | null | undefined;
let listenChecked = false;

/**
 * 解析事件 payload 为对象（Rust emit 字符串 JSON；解析失败返回 null，
 * 由调用方静默丢弃——防御 Tauri 内部异常载荷）。
 */
function safeParseEventPayload(payload: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(payload);
    if (typeof value === 'object' && value !== null) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

async function getTauriListen(): Promise<typeof cachedListen> {
  if (listenChecked) return cachedListen;
  listenChecked = true;
  try {
    const mod = await import('@tauri-apps/api/event');
    const listen = mod?.listen;
    cachedListen = typeof listen === 'function' ? listen : null;
  } catch {
    cachedListen = null;
  }
  return cachedListen;
}

/** 把 invokeTyped 三态结果转成 Promise<T>（missing / error 抛错，文案对齐 invokeCmdStrict） */
function fromInvokeTyped<T>(res: InvokeTypedResult<T>, cmd: string): T {
  if (res.status === 'ok') return res.data;
  if (res.status === 'missing') {
    throw new Error(`Tauri command not available: ${cmd}`);
  }
  // PE-04 T04.4-1：invoke 失败统一落 LoggerService（关键路径接线）
  logger.error('invoke failed', {
    module: 'transport',
    cmd,
    err: { message: `${res.kind}: ${res.message}`, code: res.kind },
  });
  throw new Error(`${res.kind}: ${res.message}`);
}

/**
 * 暂态失败判定（三态结果版，供 [TauriTransport.call] 内部使用）：
 * missing 已在清单校验层拦截；error 一律视为暂态，重试一次
 * （对齐 [TauriTransport.request] 对 CoreError 的重试语义）。
 */
function isTransientInvokeResult(res: InvokeTypedResult<unknown>): boolean {
  return res.status === 'error';
}

export class TauriTransport {
  private status: 'disconnected' | 'connecting' | 'connected' | 'failed' = 'disconnected';
  private ready = false;
  private stopped = false;

  private messageListeners = new Set<(msg: Record<string, unknown>) => void>();
  private statusListeners = new Set<(s: 'disconnected' | 'connecting' | 'connected' | 'failed', err?: Error) => void>();

  private unlistenEvents: (() => void) | null = null;
  private listenStarting: Promise<void> | null = null;

  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;

  constructor(opts: TauriTransportOptions = {}) {
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // PE-03 T03.1：启动即拉取命令清单（core_list_commands，失败回退内置快照），
    // 成功后对照 commandMap——不一致仅 logger.warn，不崩（幽灵回归门禁）。
    void initCommandManifest().then(() => {
      checkCommandMapConsistency();
    });
  }

  // ── Transport 接口 ──────────────────────────────────────────

  /**
   * 唯一 invoke 通道（PE-03 T03.2）—— 页面代码直调命令的统一入口：
   * 清单校验（resolveTauriCommand）→ invoke（invokeTyped）→ 错误提取 → 暂态重试一次。
   *
   * - 命令不在 manifest registered 面内 → `{ status: 'missing' }`（显式 missing，
   *   不 invoke；登记先行命令 registered=false 亦在此列，调用方显式降级）；
   * - error 为暂态失败（核心启动竞态等）时自动重试一次后返回最终结果；
   * - 调用方按三态处理（不再依赖旧宽松包装吞 null 的语义）。
   */
  async call<T = unknown>(
    cmd: string,
    args?: Record<string, unknown>,
  ): Promise<InvokeTypedResult<T>> {
    const resolved = resolveTauriCommand(cmd);
    if (!resolved) return { status: 'missing' };
    const first = await invokeTyped<T>(resolved, args);
    if (!isTransientInvokeResult(first)) return first;
    return invokeTyped<T>(resolved, args);
  }

  /**
   * 请求-响应配对：invoke 天然配对（03 §3.3 职责 5）。
   * type 经 commandMap 解析（C1.5：WS 消息 type → 命令名；命令名直放行），
   * 解析结果必须落在 core_list_commands 清单 registered 内（PE-03 T03.1）；
   * 未注册 / 清单外 → null → 抛「Tauri command not available」（显式 missing，
   * 无静默降级；幽灵调用点裁决归 T03.7）。
   *
   * C3.3 等价能力（断流恢复 → invoke 重试）：内部经 [TauriTransport.call]，
   * 暂态失败自动重试一次；超时/命令缺失不重试（可能重复副作用或永不可用）。
   * IPC 进程内不中断，不做事件重放。
   */
  async request<T = unknown>(
    type: string,
    payload?: Record<string, unknown>,
    opts?: { timeoutMs?: number }
  ): Promise<T> {
    const cmd = resolveTauriCommand(type);
    if (!cmd) {
      throw new Error(`Tauri command not available: ${type}`);
    }
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    const shaped = shapeTauriPayload(type, payload);
    const res = await this.callWithTimeout<T>(cmd, shaped, timeoutMs);
    return fromInvokeTyped<T>(res, cmd);
  }

  /** fire-and-forget 发送：invoke 命令（职责 6）；失败上抛（与旧 WS send 抛「未连接」一致） */
  async send(type: string, payload?: Record<string, unknown>): Promise<void> {
    const res = await this.call<unknown>(type, shapeTauriPayload(type, payload));
    if (res.status === 'ok') return;
    fromInvokeTyped(res, type);
  }

  /** 广播订阅：懒订阅 listen('workbench-run-event')（职责 7）；返回退订函数 */
  onMessage(listener: (msg: Record<string, unknown>) => void): () => void {
    this.messageListeners.add(listener);
    void this.ensureEventSubscription();
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  /** 连接状态订阅（职责 2） */
  onStatus(listener: (s: 'disconnected' | 'connecting' | 'connected' | 'failed', err?: Error) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /**
   * 等待核心就绪：core_get_status 轮询（职责 8）。
   * engineReady/dbReady 任一为 true → 'connected' + true；超时 → 'failed' + false。
   */
  async waitUntilConnected(timeoutMs?: number): Promise<boolean> {
    if (this.stopped) return false;
    if (this.ready) return true;

    const deadline = Date.now() + Math.max(0, timeoutMs ?? this.timeoutMs);
    this.setStatus('connecting');

    let lastErr: Error | undefined;
    while (Date.now() < deadline) {
      if (this.stopped) return false;
      try {
        // PE-03 T03.2：④ 类内部直调消除——waitUntilConnected 复用唯一通道 call
        // （清单校验 → invoke → 暂态重试），不再裸调 invokeTyped。
        const res = await this.call<unknown>(CORE_GET_STATUS, {});
        if (res.status === 'ok' && isCoreReady(res.data)) {
          this.ready = true;
          this.setStatus('connected');
          return true;
        }
        if (res.status !== 'ok' && res.status !== 'missing') {
          lastErr = new Error(`${res.kind}: ${res.message}`);
        }
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
      }
      if (this.stopped) return false;
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }

    const timeoutErr = lastErr ?? new Error(`核心未就绪（${Math.max(0, timeoutMs ?? this.timeoutMs)}ms 超时）`);
    this.setStatus('failed', timeoutErr);
    return false;
  }

  /** 停止：退订事件通道 + 复位状态（幂等） */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    this.teardownEventSubscription();
    this.setStatus('disconnected');
  }

  getStatus(): 'disconnected' | 'connecting' | 'connected' | 'failed' {
    return this.status;
  }

  isReady(): boolean {
    return this.ready;
  }

  // ── 内部实现 ────────────────────────────────────────────────

  /**
   * 带超时的 call 包装（request 专用）：超时抛「Tauri request timeout」。
   * call 内部的暂态重试可能晚于超时完成——超时即整体拒绝，不等待重试结果。
   */
  private callWithTimeout<T>(
    cmd: string,
    payload: Record<string, unknown> | undefined,
    timeoutMs: number
  ): Promise<InvokeTypedResult<T>> {
    return new Promise<InvokeTypedResult<T>>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              reject(new Error(`Tauri request timeout: ${cmd}`));
            }, timeoutMs)
          : null;
      this.call<T>(cmd, payload)
        .then((res) => {
          if (timer) clearTimeout(timer);
          resolve(res);
        })
        .catch((e) => {
          if (timer) clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        });
    });
  }

  /** 懒订阅 workbench-run-event（首个订阅者出现时启动；幂等；非 Tauri 环境静默降级） */
  private ensureEventSubscription(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.unlistenEvents || this.listenStarting) return this.listenStarting ?? Promise.resolve();

    this.listenStarting = (async () => {
      try {
        const listen = await getTauriListen();
        if (!listen) return;
        this.unlistenEvents = await listen(RUN_EVENT_CHANNEL, (e) => {
          const payload = e?.payload;
          // Rust B6.3 emit 完整事件 JSON 字符串（03 §3.1:190-191），
          // payload 为 string 时先 JSON.parse 归一为对象；对象直传兼容。
          const parsed =
            typeof payload === 'string'
              ? safeParseEventPayload(payload)
              : typeof payload === 'object' && payload !== null
                ? (payload as Record<string, unknown>)
                : null;
          if (!parsed) return;
          for (const cb of this.messageListeners) {
            try {
              cb(parsed);
            } catch (err) {
              logger.warn('[TauriTransport] event listener error', { module: 'transport', err: toErrMeta(err) });
            }
          }
        });
      } catch (err) {
        // 浏览器 dev / 事件模块不可用：订阅保持 no-op
        logger.warn('[TauriTransport] listen failed', { module: 'transport', err: toErrMeta(err) });
      } finally {
        this.listenStarting = null;
      }
    })();
    return this.listenStarting;
  }

  private teardownEventSubscription(): void {
    const unlisten = this.unlistenEvents;
    this.unlistenEvents = null;
    try {
      unlisten?.();
    } catch {
      /* ignore */
    }
  }

  private setStatus(status: 'disconnected' | 'connecting' | 'connected' | 'failed', err?: Error): void {
    if (this.status === status) return;
    this.status = status;
    for (const cb of this.statusListeners) {
      try {
        cb(status, err);
      } catch {
        /* ignore */
      }
    }
  }
}
