// 终端面接线（R2-14 部分 3）：设备帧 → terminalStore（活动 run 实时镜像）
// - mapTerminalFrame（纯）：events.push 信封 → tool-update/task-output 文本 + runId →
//   terminal-ingest；run-terminal → terminal-run-end（run 收口释放）；复用 R2-05c
//   collectRunTerminalChunks 语义（单帧版提取见 domain/pure/terminalChunks.ts）；
// - dispatchTerminalActions（执行点，M5 §1.3 映射面与执行面分离）：terminalStore 动作
//   （ingestLines / resetRun）；
// - TerminalWiring（网关订阅 + 生命周期）：与 FeedBridge 同构——attach 订阅 events.push
//   + authStore 配对状态（离开 paired = unpair/revoke/令牌过期 → clearAll 全清），
//   detach 退订；装配于 observationWiring（观测面接线启动即挂终端镜像）；
// - 数据面注记：terminalStore 只收 live 帧（events.push）。重连 resume 页**不重放**——
//   terminalStore 无 seq 去重（重放会与 live 帧重复行），历史完整面由 eventStore 窗口
//   承载，terminalScreen 无镜像时回落事件流重建（R2-05c 现状保持）。
import { WsGateway } from '@/network/WsGateway';
import type { InboundEnvelope } from '@/network/WsEnvelope';
import { terminalStore } from '@/domain/store/terminalStore';
import { authStore } from '@/domain/store/authStore';
import {
  extractEnvelope,
  type DeviceFrameInput,
} from '@/domain/store/eventMappers';
import { readRecord, readString } from '@/domain/store/eventReducers';
import { terminalChunkOfFrame } from '@/domain/pure/terminalChunks';

// ── 终端入站动作（映射面产物；执行面 = dispatchTerminalActions） ──

export type TerminalIngestAction =
  | { kind: 'terminal-ingest'; runId: string; text: string }
  | { kind: 'terminal-run-end'; runId: string };

/**
 * 设备帧 → 终端动作（events.push 内 tool-update/task-output 文本 → terminal-ingest；
 * run-terminal → terminal-run-end 收口释放；其余帧/缺 runId/非终端事件 → 空列表宽容跳过）。
 */
export function mapTerminalFrame(
  input: DeviceFrameInput
): TerminalIngestAction[] {
  if (input.kind !== 'events.push') return [];
  const body = readRecord(input.body);
  const frame = extractEnvelope(body?.['event'], readString(body, 'sessionId'));
  if (!frame) return [];
  const runId = readString(frame, 'runId');
  if (!runId) return [];
  if (frame.type === 'run-terminal') {
    return [{ kind: 'terminal-run-end', runId }];
  }
  const text = terminalChunkOfFrame(frame);
  return text !== undefined ? [{ kind: 'terminal-ingest', runId, text }] : [];
}

/** 执行终端动作列表（逐条路由，顺序执行不吞错）：ingest → ingestLines / run-end → resetRun */
export function dispatchTerminalActions(
  actions: readonly TerminalIngestAction[]
): void {
  const store = terminalStore.getState();
  for (const action of actions) {
    switch (action.kind) {
      case 'terminal-ingest':
        store.ingestLines(action.runId, action.text);
        break;
      case 'terminal-run-end':
        store.resetRun(action.runId);
        break;
    }
  }
}

export interface TerminalWiringOptions {
  /** 网关实例（生产 = ReconnectingWsClient.gateway；测试注入 mock） */
  gateway: WsGateway;
}

/**
 * 终端面接线订阅管理器（R2-14 部分 3）：attach 后消费 events.push 帧 →
 * terminalStore 实时镜像；authStore 离开 paired（unpair / 移除本机 / 令牌过期，
 * 即「工作区切换」语义）→ clearAll 全清。detach 退订（与 FeedBridge 同构）。
 */
export class TerminalWiring {
  private readonly gateway: WsGateway;
  private unsubscribers: Array<() => void> = [];

  constructor(opts: TerminalWiringOptions) {
    this.gateway = opts.gateway;
  }

  /** 订阅终端入站帧 + 配对生命周期（幂等：重复 attach 先 detach） */
  attach(): void {
    this.detach();
    const onFrame = (frame: InboundEnvelope): void => {
      dispatchTerminalActions(
        mapTerminalFrame({ kind: frame.kind, body: frame.body })
      );
    };
    const unsubPush = this.gateway.on('events.push', onFrame);
    // 配对状态离开 paired（unpair/clearPairing/revokeLocal/markTokenExpired 均落此面）
    // → 全清终端缓冲（内存镜像不跨桌面/会话存活）
    const unsubAuth = authStore.subscribe((state, prev) => {
      if (prev.pairState === 'paired' && state.pairState !== 'paired') {
        terminalStore.getState().clearAll();
      }
    });
    this.unsubscribers = [unsubPush, unsubAuth];
  }

  /** 退订全部（页面/应用卸载或测试隔离时调用） */
  detach(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
  }
}
