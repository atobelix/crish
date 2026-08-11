// WsGateway 骨架（M5 §4.1）：命令/事件分发 + 请求-响应匹配 + 订阅管理
// R2-02 落地；本骨架仅声明接口面（invoke 超时重发一次 / on 事件订阅，D3 §8.5 幂等）
import type { DeviceEnvelope } from './WsEnvelope';

export class WsGateway {
  /** R2-02 实现：构建信封 → ReconnectingWsClient 发送 → result.* 匹配 → 归一化错误 */
  invoke<T>(_kind: string, _body: unknown, _timeoutMs = 30_000): Promise<T> {
    throw new Error('WsGateway.invoke 未实现（R2-02 落地）');
  }

  /** R2-02 实现：事件订阅注册（events.push 解析后广播），返回退订函数 */
  on(_cb: (env: DeviceEnvelope) => void): () => void {
    return () => {};
  }
}
