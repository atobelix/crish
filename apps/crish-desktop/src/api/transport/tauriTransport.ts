/**
 * Tauri IPC Transport —— 03 §3.3 职责表的 IPC 模式实现。
 *
 * 职责映射（对照 types.ts 的职责表）：
 * - request（职责 5）→ invokeTyped(cmd, payload)，cmd 即命令名（T18 后无 WS type 映射）
 * - send（职责 6）→ invokeTyped(cmd, payload)（fire-and-forget 语义，错误仍上抛）
 * - onMessage（职责 7）→ 懒订阅 `listen('workbench-run-event', e => listener(e.payload))`
 *   （03 §3.1 前端替换点；订阅模式对齐 ptySessionApi.ts:201-234 的懒加载 fanout）
 * - waitUntilConnected（职责 8）→ Stage 5a 响应式握手（ACT-501）：
 *   先挂 `workbench-run-event` 监听（engine-ready Native Push 0ms 命中），
 *   再 Fast-Probe `core_get_status` 兜底（事件丢失窗口防护），未就绪时
 *   短指数退避自愈（10ms → 50ms 封顶）——废除旧 250ms 固定盲等轮询；
 * - onStatus（职责 2）→ 「核心已初始化」布尔投影（connecting/connected/failed）
 * - stop → 退订事件通道 + 复位状态
 *
 * 事件载荷形状：Rust B6.3 emit 完整事件 JSON，顶层平铺
 * `{ type, runId, sessionId, sequence, ...事件字段 }`（03 §3.1:190-191），
 * 逐字透传，不做归一化（EventRouter.onMsg 直进 handleAgentEvent）。
 * 引擎就绪广播（Stage 5a）：`{ type: 'engine-ready', engineReady: true, ... }`
 * 在透传给订阅者的同时，由 Transport 内部识别并标记 connected。
 *
 * 不依赖 WebSocket：无心跳、无重连（进程内核心，断连即应用退出）。
 */

import {
  invokeTyped,
  type InvokeArgs,
  type InvokeTypedResult,
} from '../tauriInvoke';
import { initCommandManifest } from './commandManifest';
import {
  fromInvokeTyped,
  isCoreReady,
  isTransientInvokeResult,
  safeParseEventPayload,
} from './tauriTransportHelpers';
import {
  checkCommandMapConsistency,
  resolveTauriCommand,
  shapeTauriPayload,
} from './commandMap';
import { logger, toErrMeta } from '../../services/LoggerService';

/** workbench-run-event：Rust 事件 emit 通道（03 §3.1，对齐旧 lifecycle.rs:287-303 模式） */
export const RUN_EVENT_CHANNEL = 'workbench-run-event';

/** core_get_status：核心初始化状态查询（03 §3.2 B；Stage 5a Fast-Probe 载体） */
export const CORE_GET_STATUS = 'core_get_status';

/** engine-ready Native Push 事件 type（Stage 5a ACT-501，Rust setup 末尾广播） */
export const ENGINE_READY_EVENT_TYPE = 'engine-ready';

const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * 握手探测退避（Stage 5a ACT-501）：废除旧 250ms 固定盲等——
 * 初始 10ms、按 1.5× 增长、50ms 封顶；`pollIntervalMs` 仍可注入加速测试。
 */
const INITIAL_PROBE_BACKOFF_MS = 10;
const MAX_PROBE_BACKOFF_MS = 50;

export interface TauriTransportOptions {
  /**
   * 探测初始退避间隔（测试可注入小值加速）。默认 10ms。
   * Stage 5a：主路径优先 engine-ready 事件 + 短退避 probe，不再固定 250ms 轮询。
   */
  pollIntervalMs?: number;
  /** request 默认超时 / 握手总超时。默认 30s。 */
  timeoutMs?: number;
}

/** 惰性加载并缓存 Tauri listen（非 Tauri 环境返回 null，与 tauriInvoke.getTauriInvoke 同策略） */
let cachedListen:
  | ((
      event: string,
      handler: (e: { payload?: unknown }) => void
    ) => Promise<() => void>)
  | null
  | undefined;
let listenChecked = false;

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

export class TauriTransport {
  private status: 'disconnected' | 'connecting' | 'connected' | 'failed' =
    'disconnected';
  private ready = false;
  private stopped = false;

  private messageListeners = new Set<(msg: Record<string, unknown>) => void>();
  private statusListeners = new Set<
    (
      s: 'disconnected' | 'connecting' | 'connected' | 'failed',
      err?: Error
    ) => void
  >();

  private unlistenEvents: (() => void) | null = null;
  private listenStarting: Promise<void> | null = null;
  /** 握手探测退避定时器（Stage 5a：短退避自愈，stop 时清除） */
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  /** waitUntilConnected 挂起解析器（engine-ready 事件 / probe 任一命中即结算） */
  private readyResolvers: Array<(ok: boolean) => void> = [];

  private readonly initialProbeBackoffMs: number;
  private readonly timeoutMs: number;

  constructor(opts: TauriTransportOptions = {}) {
    this.initialProbeBackoffMs =
      opts.pollIntervalMs ?? INITIAL_PROBE_BACKOFF_MS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // 命令清单拉取推迟到握手成立之后（ACT-05-10）：消除冷启动初期冗余
    // IPC；内置快照兜底已可支撑 call/request 校验（resolveTauriCommand）。
    // 成功后对照 commandMap——不一致仅 logger.warn，不崩（幽灵回归门禁）。
  }

  // ── Transport 接口 ──────────────────────────────────────────

  /**
   * 唯一 invoke 通道（PE-03 T03.2）—— 页面代码直调命令的统一入口：
   * 清单校验（resolveTauriCommand）→ invoke（invokeTyped）→ 错误提取 → 暂态重试一次。
   *
   * - 命令不在 manifest registered 面内 → `{ status: 'missing' }`（显式 missing，
   *   不 invoke；登记先行命令 registered=false 亦在此列，调用方显式降级）；
   *   引导探针白名单（BOOTSTRAP_PROBE_ALLOWLIST）无条件放行（CON-07 加固面）；
   * - 仅 `restore in progress`（run 装配前的恢复门禁）自动重试一次；
   *   其它结构化错误不重放，避免权限/参数错误或部分成功后的副作用重复执行；
   * - 调用方按三态处理（不再依赖旧宽松包装吞 null 的语义）。
   */
  async call<T = unknown>(
    cmd: string,
    args?: InvokeArgs
  ): Promise<InvokeTypedResult<T>> {
    const resolved = resolveTauriCommand(cmd);
    if (!resolved) return { status: 'missing' };
    const first = await invokeTyped<T>(resolved, args);
    if (!isTransientInvokeResult(first)) return first;
    return invokeTyped<T>(resolved, args);
  }

  /**
   * 请求-响应配对：invoke 天然配对（03 §3.3 职责 5）。
   * type 即命令名，经 resolveTauriCommand 直接校验清单（T18：已无
   * WS 消息 type → 命令名映射层），校验结果必须落在 core_list_commands
   * 清单 registered 内（PE-03 T03.1）；
   * 未注册 / 清单外 → null → 抛「Tauri command not available」（显式 missing，
   * 无静默降级；幽灵调用点裁决归 T03.7）。
   *
   * C3.3 等价能力（断流恢复 → invoke 重试）：内部经 [TauriTransport.call]，
   * 恢复门禁拒绝时自动重试一次；其它错误与超时/命令缺失不重试
   * （命令可能已部分产生副作用，或错误本身不可重试）。
   * IPC 进程内不中断，不做事件重放。
   */
  async request<T = unknown>(
    type: string,
    payload?: InvokeArgs,
    opts?: { timeoutMs?: number }
  ): Promise<T> {
    const cmd = resolveTauriCommand(type);
    if (!cmd) {
      throw new Error(`Tauri command not available: ${type}`);
    }
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    const shaped =
      typeof payload === 'function'
        ? () => shapeTauriPayload(type, payload()) ?? {}
        : shapeTauriPayload(type, payload);
    const res = await this.callWithTimeout<T>(cmd, shaped, timeoutMs);
    return fromInvokeTyped<T>(res, cmd);
  }

  /** fire-and-forget 发送：invoke 命令（职责 6）；失败上抛（与旧 WS send 抛「未连接」一致） */
  async send(type: string, payload?: InvokeArgs): Promise<void> {
    const res = await this.call<unknown>(
      type,
      typeof payload === 'function'
        ? () => shapeTauriPayload(type, payload()) ?? {}
        : shapeTauriPayload(type, payload)
    );
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
  onStatus(
    listener: (
      s: 'disconnected' | 'connecting' | 'connected' | 'failed',
      err?: Error
    ) => void
  ): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /**
   * 等待核心就绪（职责 8 · Stage 5a ACT-501 响应式握手）：
   * 1. 先挂 `workbench-run-event` 监听（消除 Rust engine-ready emit 早于
   *    前端 listen 的事件丢失窗口）；
   * 2. listen 完成后 0ms Fast-Probe `core_get_status`（probe 兜底：事件
   *    已丢但核心就绪时立即命中）；
   * 3. 未就绪 → 短指数退避自愈（10ms → 50ms 封顶，严禁 250ms 盲等）；
   * 4. engine-ready 事件 / probe 任一命中 → 'connected' + true；
   *    超时 → 'failed' + false。
   */
  async waitUntilConnected(timeoutMs?: number): Promise<boolean> {
    if (this.stopped) return false;
    if (this.ready) return true;

    const effectiveTimeout = Math.max(0, timeoutMs ?? this.timeoutMs);
    const deadline = Date.now() + effectiveTimeout;
    this.setStatus('connecting');

    // ① 必须先挂 Native Push 监听（消除事件丢失窗口；幂等，与 onMessage 共享订阅）
    await this.ensureEventSubscription();
    if (this.stopped) return false;
    if (this.ready) return true;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let currentBackoff = Math.min(
        this.initialProbeBackoffMs,
        MAX_PROBE_BACKOFF_MS
      );
      const settle = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        this.readyResolvers = this.readyResolvers.filter((r) => r !== settle);
        resolve(ok);
      };
      this.readyResolvers.push(settle);

      const scheduleProbe = (): void => {
        if (settled || this.stopped) return;
        this.probeTimer = setTimeout(runProbe, currentBackoff);
      };

      const runProbe = async (): Promise<void> => {
        if (settled || this.stopped) {
          if (!settled && this.stopped) settle(false);
          return;
        }
        if (this.ready) {
          settle(true);
          return;
        }
        if (Date.now() >= deadline) {
          this.setStatus(
            'failed',
            new Error(`核心未就绪（${effectiveTimeout}ms 超时）`)
          );
          settle(false);
          return;
        }
        try {
          const ok = await this.probeOnce(deadline, effectiveTimeout);
          if (ok) {
            settle(true);
            return;
          }
        } catch {
          /* probeOnce 已吞错；继续退避循环 */
        }
        if (settled || this.stopped) {
          if (!settled && this.stopped) settle(false);
          return;
        }
        if (this.ready) {
          settle(true);
          return;
        }
        if (Date.now() >= deadline) {
          this.setStatus(
            'failed',
            new Error(`核心未就绪（${effectiveTimeout}ms 超时）`)
          );
          settle(false);
          return;
        }
        // 短退避自愈：1.5× 增长、50ms 封顶（ACT-501，废除 250ms 盲等）
        currentBackoff = Math.min(currentBackoff * 1.5, MAX_PROBE_BACKOFF_MS);
        scheduleProbe();
      };

      // ② 0ms Fast-Probe（listen 已挂，即使 engine-ready 丢失也能命中）
      void runProbe();
    });
  }

  /** 停止：退订事件通道 + 清探测定时器 + 复位状态（幂等） */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    const resolvers = this.readyResolvers;
    this.readyResolvers = [];
    for (const r of resolvers) {
      try {
        r(false);
      } catch {
        /* ignore */
      }
    }
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
   * 0ms Fast-Probe：调用 `core_get_status` 读取微内核当前状态机。
   * 就绪 → markConnected + true；未就绪 / 报错 → false（不抛，由调用方退避重试）。
   * 引导探针经 BOOTSTRAP_PROBE_ALLOWLIST 无条件放行（CON-07 加固面）。
   */
  private async probeOnce(
    _deadline: number,
    _effectiveTimeout: number
  ): Promise<boolean> {
    if (this.stopped || this.ready) return this.ready;
    try {
      const res = await this.call<unknown>(CORE_GET_STATUS, {});
      if (res.status === 'ok' && isCoreReady(res.data)) {
        this.markConnected();
        return true;
      }
    } catch {
      /* 暂态失败：由退避循环自愈 */
    }
    return this.ready;
  }

  /**
   * 握手成立（Stage 5a）：engine-ready Native Push / Fast-Probe 任一命中。
   * 标记 connected + 结算全部挂起 waitUntilConnected + 延迟拉取命令清单
   * （ACT-05-10：消除冷启动初期冗余 IPC）。
   */
  private markConnected(): void {
    if (this.ready || this.stopped) return;
    this.ready = true;
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    this.setStatus('connected');
    const resolvers = this.readyResolvers;
    this.readyResolvers = [];
    for (const r of resolvers) {
      try {
        r(true);
      } catch {
        /* ignore */
      }
    }
    // 延迟拉取清单 + 幽灵回归对照（失败回退内置快照，不崩）
    void initCommandManifest().then(() => {
      checkCommandMapConsistency();
    });
  }

  /**
   * 带超时的 call 包装（request 专用）：超时抛「Tauri request timeout」。
   * call 内部的暂态重试可能晚于超时完成——超时即整体拒绝，不等待重试结果。
   */
  private callWithTimeout<T>(
    cmd: string,
    payload: InvokeArgs | undefined,
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
    if (this.unlistenEvents || this.listenStarting)
      return this.listenStarting ?? Promise.resolve();

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
          // Stage 5a ACT-501：engine-ready Native Push 0ms 命中握手
          //（同时仍透传给业务订阅者——事件载荷逐字透传不变）
          if (parsed.type === ENGINE_READY_EVENT_TYPE || isCoreReady(parsed)) {
            this.markConnected();
          }
          for (const cb of this.messageListeners) {
            try {
              cb(parsed);
            } catch (err) {
              logger.warn('[TauriTransport] event listener error', {
                module: 'transport',
                err: toErrMeta(err),
              });
            }
          }
        });
      } catch (err) {
        // 浏览器 dev / 事件模块不可用：订阅保持 no-op
        logger.warn('[TauriTransport] listen failed', {
          module: 'transport',
          err: toErrMeta(err),
        });
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

  private setStatus(
    status: 'disconnected' | 'connecting' | 'connected' | 'failed',
    err?: Error
  ): void {
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
