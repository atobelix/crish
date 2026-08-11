// ReconnectingWsClient 骨架（D4 §6.2 / M5 §4.3）：连接生命周期 + 指数退避
// R2-02 落地完整实现（心跳/重连/背压/AppState 联动/游标追平）；
// 本骨架只提供接口面与可单测的纯逻辑（退避算法）
import type { WsPhase } from '@/domain/pure/selectors';

export interface ReconnectingWsClientOptions {
  url: string;
  heartbeatMs?: number;
  maxRetryMs?: number;
}

/**
 * 指数退避 + 抖动（D4 §6.2.4）：
 * 失败序列 1s → 2s → 4s → 8s → 16s → 30s(封顶)，附加 0~1s 随机抖动
 */
export function nextRetryDelayMs(retryCount: number): number {
  const base = Math.min(1000 * 2 ** Math.min(retryCount, 5), 30_000);
  return base + Math.floor(Math.random() * 1000);
}

// 骨架：仅声明接口；R2-02 实现 connect/disconnect/heartbeat 与相位回调
export class ReconnectingWsClient {
  constructor(private readonly opts: ReconnectingWsClientOptions) {}

  get url(): string {
    return this.opts.url;
  }

  /** R2-02 实现：建立连接（含版本协商与鉴权首帧） */
  connect(): void {
    // 占位
  }

  /** R2-02 实现：主动断开（iOS 后台挂起等场景） */
  disconnect(): void {
    // 占位
  }

  /** R2-02 实现：内部相位读取（供 mapWsPhase 投影） */
  get phase(): WsPhase {
    return 'idle';
  }
}
