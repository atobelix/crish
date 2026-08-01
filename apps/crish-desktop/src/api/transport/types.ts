/**
 * Transport 抽象层 —— Tauri IPC 单一实现的接口定义（C3.1：WS 链路已整删）。
 *
 * 对应 03-frontend-contract.md §3.3 的 daemonClient 职责替换表（10 行），
 * 每行职责在接口上的落点如下：
 *
 * | # | 旧职责（daemonClient）            | IPC 处置                     | Transport 接口落点              |
 * |---|----------------------------------|------------------------------|---------------------------------|
 * | 1 | WS URL 解析（product/browser）    | 删（核心进程内，无 URL）      | （无 —— 实现内部细节）           |
 * | 2 | 连接状态机 DaemonConnState        | 「核心已初始化」布尔          | onStatus / getStatus / isReady  |
 * | 3 | 心跳 ping/pong                    | 删（进程内无断连）            | （无）                           |
 * | 4 | 重连（指数退避 + sidecar 重启）    | 删                           | （无）                           |
 * | 5 | request/response 配对             | invoke                       | request<T>                      |
 * | 6 | fire-and-forget send              | invoke 命令                  | send                            |
 * | 7 | 广播 dispatch（listeners 集合）    | listen('workbench-run-event')| onMessage                       |
 * | 8 | waitUntilConnected                | core_get_status 轮询          | waitUntilConnected              |
 * | 9 | onHeartbeat metrics 镜像         | 删                           | （无）                           |
 *
 * 设计约束：
 * - 上层（EventRouter / ConnectionLifecycle 等）只依赖本接口。
 * - `request` 的 type 即命令名：Tauri 路径直接对应 core_* 命令
 *   （WS 消息 type 经 commandMap 翻译，03 §3.2）。
 * - 事件载荷不做二次归一：IPC 为顶层平铺
 *   `{ type, runId, sessionId, ...事件字段 }`（03 §3.1、§5.1），
 *   EventRouter.onMsg 逐字透传。
 */

/** 连接状态（Tauri 路径为「核心已初始化」投影） */
export type TransportStatus = 'disconnected' | 'connecting' | 'connected' | 'failed';

/** 广播事件载荷（与 listen('workbench-run-event') payload 同形状） */
export type TransportMessage = Record<string, unknown>;

/** 唯一 invoke 通道的返回（对齐 tauriInvoke 三态，见 InvokeTypedResult） */
export type TransportCallResult<T> = import('../tauriInvoke').InvokeTypedResult<T>;

/** request 选项 */
export interface TransportRequestOptions {
  /** 超时（ms）。缺省由实现决定（Tauri 30s）。 */
  timeoutMs?: number;
}

export type TransportStatusListener = (status: TransportStatus, err?: Error) => void;

export type TransportMessageListener = (msg: TransportMessage) => void;

export interface Transport {
  /**
   * 唯一 invoke 通道（PE-03 T03.2）：命令级调用，返回结构化三态。
   * - 命令不在 manifest registered 面内 → `{ status: 'missing' }`（显式 missing，不 invoke）；
   * - 暂态失败自动重试一次（与 request 行为合并）。
   * 页面代码一律经此通道直调命令（取代旧宽松包装的裸直连）。
   */
  call<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<TransportCallResult<T>>;

  /** 请求-响应配对（03 §3.3 职责 5）：invoke 天然配对。 */
  request<T = unknown>(
    type: string,
    payload?: Record<string, unknown>,
    opts?: TransportRequestOptions
  ): Promise<T>;

  /** fire-and-forget 发送（职责 6）：invoke 命令。 */
  send(type: string, payload?: Record<string, unknown>): Promise<void>;

  /** 广播订阅（职责 7）：listen('workbench-run-event')。返回退订函数。 */
  onMessage(listener: TransportMessageListener): () => void;

  /** 连接状态订阅（职责 2）。返回退订函数。 */
  onStatus(listener: TransportStatusListener): () => void;

  /** 等待就绪（职责 8）：core_get_status 轮询。 */
  waitUntilConnected(timeoutMs?: number): Promise<boolean>;

  /** 停止并释放资源（Tauri：退订事件通道）。幂等。 */
  stop(): void;

  /** 当前状态快照。 */
  getStatus(): TransportStatus;

  /** 是否已就绪（核心已初始化）。 */
  isReady(): boolean;
}
