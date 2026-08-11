// 派生选择器与纯投影（M4 §2.2.3 pure/selectors.ts）：纯函数、可单测
import type { ConnectionPhase } from '../store/connectionStore';

// 连接相位 → 中文文案（ConnectionBanner 消费）
export const CONNECTION_PHASE_TEXT: Record<ConnectionPhase, string> = {
  disconnected: '未连接',
  connecting: '连接中…',
  ready: '已连接',
  recovering: '重连中…',
  offline: '离线',
};

// WS 内部相位 → UI 相位投影（D4 §6.2.5 映射表全量；netInfo 离线态优先级最高）
export function mapWsPhase(
  wsPhase: WsPhase,
  offline: boolean
): ConnectionPhase {
  if (offline) return 'offline';
  switch (wsPhase) {
    case 'idle':
      return 'disconnected';
    case 'connecting':
      return 'connecting';
    case 'open':
      return 'ready';
    case 'reconnecting':
      return 'recovering';
    case 'dead':
      return 'offline';
  }
}

export function selectConnectionPhaseText(phase: ConnectionPhase): string {
  return CONNECTION_PHASE_TEXT[phase];
}

// 内部相位类型（D4 §6.2.2 WsPhase）：与 ConnectionPhase 的映射关系见 mapWsPhase
export type WsPhase = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'dead';
