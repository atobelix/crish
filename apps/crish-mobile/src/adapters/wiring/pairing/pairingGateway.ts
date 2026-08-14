// 配对期网关（发送就绪信号感知网关 / pairingWiring 子模块）

import { WsGateway, type SendFrame } from '@/network/WsGateway';

/**
 * attachSend 感知网关：ReconnectingWsClient.handleOpen 的时序为 setPhase('open')
 * （触发 onPhaseChange 回调）→ gateway.attachSend——相位回调内发送会因 sendFn
 * 未接线被 WsGateway.send 静默丢弃。本网关把「发送管线就绪」（attachSend 完成）
 * 作为一等信号 onSendReady 上抛，配对 hello 据此发送（O(1) 无时序假设）。
 */
export class PairingGateway extends WsGateway {
  private sendReadyHooks: Array<() => void> = [];

  attachSend(send: SendFrame): void {
    super.attachSend(send);
    for (const hook of [...this.sendReadyHooks]) {
      hook();
    }
  }

  /** 发送就绪订阅（每次 open 触发一次；返回退订函数） */
  onSendReady(hook: () => void): () => void {
    this.sendReadyHooks.push(hook);
    return () => {
      this.sendReadyHooks = this.sendReadyHooks.filter((h) => h !== hook);
    };
  }
}
