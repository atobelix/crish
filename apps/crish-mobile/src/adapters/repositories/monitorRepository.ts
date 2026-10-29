// 监控域仓库：会话索引 / 会话事件 / run 事件的唯一发送与解析入口。
import type { WsGateway } from '@/network/WsGateway';
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
import { invokeCommand } from '@/adapters/wiring/gatewayCommand';

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

export class GatewayMonitorRepository implements MonitorRepository {
  constructor(private readonly gateway: WsGateway) {}

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
      this.gateway,
      req,
      command,
      (raw) => parseMonitorCommandResult(command, raw),
      (code, message, retryable) =>
        new MonitorCommandError(code, message, retryable)
    );
  }
}

export const PAGE_SIZE = 200;
export const MAX_EVENTS_PER_REQUEST = 500;
