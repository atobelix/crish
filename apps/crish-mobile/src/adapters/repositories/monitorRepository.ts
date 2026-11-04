// 监控域仓库：会话索引 / 会话事件 / run 事件的唯一发送与解析入口。
// 网关来源构造注入（GatewaySource）：实例 = 同代直注（observationWiring 为
// FeedBridge 装配时传当代 gateway）；解析函数 = sessionOps 命令域单例传
// resolveCommandGateway、每次 invoke 现取当代（H1 陈旧捕获根治，见
// gatewayCommand 文件头口径）。
import type {
  EventPageParams,
  EventPageResult,
  ListSessionsParams,
  ListSessionsResult,
  RunEventsParams,
} from '@crish/shared-types';
import {
  buildListSessionsRequest,
  buildReadRunEventsRequest,
  buildReadSessionEventsRequest,
  parseMonitorCommandResult,
  type MonitorCommandName,
  type MonitorCommandResultMap,
} from '@/domain/repositories/monitorCommands';
import {
  invokeCommand,
  type GatewaySource,
} from '@/adapters/wiring/gatewayCommand';

export class MonitorCommandError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'MonitorCommandError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface MonitorRepository {
  listSessions(params?: ListSessionsParams): Promise<ListSessionsResult>;
  readSessionEvents(params: EventPageParams): Promise<EventPageResult>;
  readRunEvents(params: RunEventsParams): Promise<EventPageResult>;
}

export const DEFAULT_MONITOR_TIMEOUT_MS = 5000;

export class GatewayMonitorRepository implements MonitorRepository {
  constructor(
    private readonly gatewaySource: GatewaySource,
    private readonly timeoutMs: number = DEFAULT_MONITOR_TIMEOUT_MS
  ) {}

  listSessions(params?: ListSessionsParams): Promise<ListSessionsResult> {
    return this.invoke('listSessions', buildListSessionsRequest(params));
  }

  readSessionEvents(params: EventPageParams): Promise<EventPageResult> {
    return this.invoke(
      'readSessionEvents',
      buildReadSessionEventsRequest(params)
    );
  }

  readRunEvents(params: RunEventsParams): Promise<EventPageResult> {
    return this.invoke('readRunEvents', buildReadRunEventsRequest(params));
  }

  private invoke<T extends MonitorCommandName>(
    command: T,
    req: { kind: string; body: unknown }
  ): Promise<MonitorCommandResultMap[T]> {
    return invokeCommand(
      this.gatewaySource,
      req,
      command,
      (raw) => parseMonitorCommandResult(command, raw),
      (code, message, retryable) =>
        new MonitorCommandError(code, message, retryable),
      this.timeoutMs
    );
  }
}

export const PAGE_SIZE = 200;
export const MAX_EVENTS_PER_REQUEST = 500;
