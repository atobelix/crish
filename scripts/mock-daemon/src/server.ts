// =======================================================================
// mock daemon v0（R0-06）——MockDaemonServer（WS 服务端 + 场景驱动）
//
// 职责：
//   1. 启动/关闭 WebSocket 服务（ws 库），连接生命周期登记；
//   2. 事件发射中枢 emitEvent/emitPreview：分配 sequence → 写入会话存储 →
//      广播给已订阅该会话的连接（对齐桌面 FanOutEmitter 的扇出语义）；
//   3. 夹具场景驱动：首个客户端订阅场景会话时启动对应时间线（approval/
//      run/cache；idle 不自动发射），支持 --loop 循环播放；
//   4. 断线续接：设备重连（新连接同 deviceId）后，hello 携带 resume 游标
//      或 subscribe 携带 lastSequences 时，从会话存储按游标补推（resume）。
// =======================================================================

import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { JsonValue } from '../../../packages/shared-types/src/primitive-types';
import type { Manifest, PendingApproval } from '../../../packages/shared-types/src/generated/device/types';
import { MockState } from './state.js';
import type { ApprovalDecisionResult } from './state.js';
import { Connection } from './connection.js';
import { SCENARIOS } from './fixtures/index.js';
import type { ScenarioContext, ScenarioId } from './fixtures/index.js';
import { approvalRequested } from './fixtures/events.js';
import { sleep, debug, info, warn } from './util.js';
import { MOCK_DESKTOP_ID, MOCK_TLS_FINGERPRINT, MOCK_CHALLENGE, MOCK_DESKTOP_PUB } from './envelope.js';

/** server 构造参数（CLI 解析后传入） */
export interface ServerOptions {
  host?: string;
  port?: number;
  /** 配对模式开关（--pair / --no-pair） */
  pairMode: boolean;
  /** 配对码（CXN-XXXX-XXXX-XXXX；关闭配对模式时无效） */
  pairCode?: string;
  /** 自动启动的夹具场景（缺省 idle） */
  scenario?: ScenarioId;
  /** 场景循环播放（--loop；仅 loopable 场景生效） */
  loop?: boolean;
  /** 场景时间线速度倍率（≤1 加速，0 = 立即发射；测试用） */
  scenarioSpeed?: number;
}

/** 启动后实际监听信息 */
export interface ListenInfo {
  host: string;
  port: number;
}

export class MockDaemonServer {
  readonly state: MockState;
  readonly options: Required<Omit<ServerOptions, 'port'>> & { port?: number };
  private wss: WebSocketServer | null = null;
  private readonly connections = new Set<Connection>();
  /** 场景运行状态（sessionId → 正在运行） */
  private readonly runningScenarios = new Set<ScenarioId>();
  private scenarioAbort = false;
  /** 实际监听端口（listen 成功后填充；测试用 port 0 时读取） */
  listenInfo: ListenInfo | null = null;
  /** 断言 promise：等待 approve/deny 决策（测试用） */
  private readonly decisionWaiters = new Set<(d: ApprovalDecisionResult) => void>();

  constructor(options: ServerOptions) {
    const manifest: Manifest = {
      contractVersion: '1.0.0',
      commands: [
        { name: 'getStatus', family: 'core', surface: 'engine', registered: true },
        { name: 'getRunSnapshot', family: 'core', surface: 'engine', registered: true },
        { name: 'readSessionEvents', family: 'core', surface: 'engine', registered: true },
        { name: 'readRunEvents', family: 'core', surface: 'engine', registered: true },
        { name: 'listSessions', family: 'session', surface: 'engine', registered: true },
        { name: 'listCommands', family: 'core', surface: 'engine', registered: true },
        { name: 'getSearchIndex', family: 'core', surface: 'engine', registered: true },
        { name: 'approve', family: 'core', surface: 'engine', registered: true },
        { name: 'deny', family: 'core', surface: 'engine', registered: true },
        { name: 'listPendingApprovals', family: 'core', surface: 'engine', registered: true },
        { name: 'approvalHistory', family: 'core', surface: 'engine', registered: true },
        { name: 'checkCommand', family: 'core', surface: 'engine', registered: true },
        { name: 'runControl', family: 'session', surface: 'engine', registered: true },
        { name: 'cancelRun', family: 'session', surface: 'engine', registered: true },
        { name: 'getSettings', family: 'config', surface: 'engine', registered: true },
        { name: 'queryPresence', family: 'core', surface: 'engine', registered: true },
        { name: 'listDevices', family: 'core', surface: 'engine', registered: true },
        { name: 'getPairState', family: 'core', surface: 'engine', registered: true },
      ],
    };
    this.state = new MockState({
      desktopId: MOCK_DESKTOP_ID,
      pairCode: options.pairCode ?? 'CXN-7K4P-Q2MB-9XRT',
      pairMode: options.pairMode,
      manifest,
    });
    this.options = {
      host: options.host ?? '127.0.0.1',
      ...(options.port !== undefined ? { port: options.port } : {}),
      pairMode: options.pairMode,
      pairCode: options.pairCode ?? 'CXN-7K4P-Q2MB-9XRT',
      scenario: options.scenario ?? 'idle',
      loop: options.loop ?? false,
      scenarioSpeed: options.scenarioSpeed ?? 1,
    };
  }

  /** 配对挑战/桌面公钥（真实实现由配对密码学生成；mock 用固定占位） */
  get challenge(): string {
    return MOCK_CHALLENGE;
  }
  get desktopPub(): string {
    return MOCK_DESKTOP_PUB;
  }
  get tlsFingerprint(): string {
    return MOCK_TLS_FINGERPRINT;
  }

  /** 启动监听（port=0 时由系统分配，见 listenInfo） */
  async listen(): Promise<ListenInfo> {
    const wss = new WebSocketServer({ host: this.options.host, port: this.options.port ?? 0 });
    this.wss = wss;
    wss.on('connection', (ws: WebSocket) => {
      debug('新连接进入');
      this.connections.add(new Connection(this, ws));
    });
    wss.on('error', (e) => warn(`WebSocket 服务错误：${String(e)}`));
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const address = wss.address();
    if (typeof address === 'object' && address !== null) {
      this.listenInfo = { host: address.address, port: address.port };
    } else {
      throw new Error('WebSocket 服务启动失败：无法获取监听地址');
    }
    info(`监听中：ws://${this.options.host}:${this.listenInfo.port}（配对模式=${this.options.pairMode ? '开' : '关'}）`);
    return this.listenInfo;
  }

  /** 优雅关闭：停止场景、断开全部连接、关闭服务 */
  async close(): Promise<void> {
    this.scenarioAbort = true;
    this.runningScenarios.clear();
    for (const conn of this.connections) {
      if (!conn.isClosed()) conn.ws.close();
    }
    this.connections.clear();
    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
      this.wss = null;
    }
    info('服务已关闭');
  }

  // ── 事件发射中枢 ───────────────────────────────────────────────────────

  /**
   * 发射持久化事件：分配 sequence → 写入会话存储 → 广播给已订阅连接。
   * 返回分配的 sequence（preview 帧不占号）。
   */
  async emitEvent(sessionId: string, event: JsonValue, preview = false): Promise<number> {
    if (preview) {
      debug(`预览帧广播：${String((event as Record<string, unknown>)['type'])}（不推进游标）`);
      this.broadcast(sessionId, event, true);
      return 0;
    }
    const store = this.state.store(sessionId);
    const withSequence: JsonValue = { ...(event as Record<string, unknown>), sequence: store.maxSequence() + 1 } as unknown as JsonValue;
    const sequence = store.append(withSequence);
    this.broadcast(sessionId, withSequence, false);
    return sequence;
  }

  /** 广播给订阅了该会话的全部连接 */
  private broadcast(sessionId: string, event: JsonValue, preview: boolean): void {
    for (const conn of this.connections) {
      if (conn.isClosed()) continue;
      if (conn.isSubscribed(sessionId)) {
        try {
          conn.pushEvent(sessionId, event, preview);
        } catch (e) {
          warn(`广播失败（会话 ${sessionId}）：${String(e)}`);
        }
      }
    }
  }

  // ── 场景驱动 ───────────────────────────────────────────────────────────

  /** 客户端订阅会话后调用：触发对应场景时间线（idle 场景不自动触发） */
  onSessionSubscribed(_deviceId: string, sessions: string[]): void {
    for (const sessionId of sessions) {
      const scenario = (Object.values(SCENARIOS)).find((s) => s.sessionId === sessionId);
      if (scenario && scenario.id !== 'idle') {
        void this.runScenarioOnce(scenario.id);
      }
    }
  }

  /** 配对完成回调（预留：多端并发时按 deviceId 续接场景） */
  onDeviceReady(deviceId: string): void {
    debug(`设备就绪：${deviceId}`);
  }

  /** 会话建立回调（预留） */
  onSessionReady(deviceId: string): void {
    debug(`会话建立：${deviceId}`);
  }

  /** 握手携带 resume 游标（重连续接入口；v0 仅记录，续传走 subscribe+resume 路径） */
  async onResumeCursor(_deviceId: string, resume: JsonValue): Promise<void> {
    debug(`重连游标登记：${JSON.stringify(resume)}`);
  }

  onConnectionClosed(conn: Connection): void {
    this.connections.delete(conn);
  }

  /** 启动场景时间线（幂等：同一场景只跑一轮；approval 场景完成即止） */
  async runScenarioOnce(id: ScenarioId): Promise<void> {
    if (this.runningScenarios.has(id)) return;
    const scenario = SCENARIOS[id];
    if (!scenario) {
      warn(`未知场景：${id}`);
      return;
    }
    this.runningScenarios.add(id);
    info(`场景启动：${scenario.id}（${scenario.description}）`);
    const ctx = this.scenarioContext();
    try {
      do {
        await scenario.run(ctx);
        if (this.options.loop && scenario.loopable && !this.scenarioAbort) {
          info(`场景 ${scenario.id} 一轮完成，${'3 秒后循环播放'}`);
          await sleep(3000, this.options.scenarioSpeed);
        }
      } while (this.options.loop && scenario.loopable && !this.scenarioAbort);
    } catch (e) {
      warn(`场景 ${scenario.id} 运行异常：${String(e)}`);
    } finally {
      this.runningScenarios.delete(id);
    }
  }

  /** 构造场景上下文（注入到场景时间线） */
  private scenarioContext(): ScenarioContext {
    return {
      emit: (sessionId, event) => this.emitEvent(sessionId, event, false),
      emitPreview: async (sessionId, event): Promise<void> => {
        await this.emitEvent(sessionId, event, true);
      },
      requestApproval: async (request: PendingApproval): Promise<ApprovalDecisionResult> => {
        if (!request.sessionId || !request.runId) {
          throw new Error('requestApproval：夹具请求必须携带 sessionId/runId');
        }
        // 登记待审批（闸门由决策命令 resolve）+ 广播 approval-requested
        const gatePromise = new Promise<ApprovalDecisionResult>((resolve) => {
          this.state.registerPendingApproval(request, {
            toolCallId: request.toolCallId,
            resolve: (decision, reason) => {
              for (const w of this.decisionWaiters) w({ decision, reason });
              resolve({ decision, reason });
            },
          });
        });
        const event = approvalRequested(
          request.sessionId,
          request.runId,
          {
            id: request.requestId,
            sessionId: request.sessionId,
            cwd: request.cwd ?? '',
            toolCallId: request.toolCallId,
            toolName: request.toolName,
            parameters: { keys: request.paramKeys ?? [] },
            summary: request.summary ?? '',
            toolMetadata: { category: 'terminal', isReadOnly: false },
          },
        );
        await this.emitEvent(request.sessionId, event, false);
        return gatePromise;
      },
      sleep: (ms) => sleep(ms, this.options.scenarioSpeed),
    };
  }

  /**
   * 等待下一次审批决策（测试/冒烟用）：approve/deny 命令触发后返回决策结果。
   * 超时抛错（避免测试挂死）。
   */
  waitNextDecision(timeoutMs = 10_000): Promise<ApprovalDecisionResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.decisionWaiters.delete(waiter);
        reject(new Error('等待审批决策超时'));
      }, timeoutMs);
      const waiter = (d: ApprovalDecisionResult): void => {
        clearTimeout(timer);
        this.decisionWaiters.delete(waiter);
        resolve(d);
      };
      this.decisionWaiters.add(waiter);
    });
  }
}
