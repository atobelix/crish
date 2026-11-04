// 派生选择器与纯投影（M4 §2.2.3 pure/selectors.ts）：纯函数、可单测
// - WsPhase 类型所有权 = network/ReconnectingWsClient（R4 批次6 归位；本层只消费类型）；
// - ConnectionPhase = 本仓 UI 相位（connectionStore），映射表 mapWsPhase 为单一真源。
import type { WsPhase } from '@/network/ReconnectingWsClient';
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

// 远端数据面陈旧标注（CON-3）：断线保留/快照恢复的会话列表呈现的是
// 上次同步的存量而非实时数据，必须明示，不得冒充实时列表。
export const SNAPSHOT_STALE_LABEL = '未连接 · 显示上次同步内容';

// ── 有效对话模式（CON-2 中央派生，单一真源）────────────────────────────────
// 产品裁决：本地对话与普通对话同级；没有设备连接时默认使用本地能力。
// 模式判定只许消费本派生：phase === 'ready' → 'remote'，其余一律 'local'
// （连接中 / 重连中 / 离线时远程管线都不可用，落本地不留死输入框）。
// 各屏幕 / VM 禁止再自写 phase === 'ready' 做模式判定；远程专属数据面
// （项目 / 模型 / 技能等桌面真源）的可用性门禁同样经本派生反推
// （selectEffectiveChatMode(phase) === 'remote'），全仓只留一个
// 「相位 → 模式 / 可用性」出口，改口径只改此处。
export type EffectiveChatMode = 'remote' | 'local';

export function selectEffectiveChatMode(
  phase: ConnectionPhase
): EffectiveChatMode {
  return phase === 'ready' ? 'remote' : 'local';
}
