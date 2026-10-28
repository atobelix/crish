import type { WsPhase } from '@/network/ReconnectingWsClient';
import {
  CONNECTION_PHASE_TEXT,
  mapWsPhase,
  selectConnectionPhaseText,
} from './selectors';

// 相位投影纯函数单测（D4 §6.2.5 映射表全量覆盖）
describe('mapWsPhase（D4 §6.2.5 映射表）', () => {
  it('网络在线时逐行覆盖映射表', () => {
    const table: Array<[WsPhase, string]> = [
      ['idle', 'disconnected'],
      ['connecting', 'connecting'],
      ['open', 'ready'],
      ['reconnecting', 'recovering'],
      ['dead', 'offline'],
    ];
    for (const [wsPhase, expected] of table) {
      expect(mapWsPhase(wsPhase, false)).toBe(expected);
    }
  });

  it('断网（offline）优先于一切内部相位', () => {
    const phases: WsPhase[] = [
      'idle',
      'connecting',
      'open',
      'reconnecting',
      'dead',
    ];
    for (const wsPhase of phases) {
      expect(mapWsPhase(wsPhase, true)).toBe('offline');
    }
  });
});

describe('连接相位中文文案', () => {
  it('五种相位均有映射', () => {
    expect(selectConnectionPhaseText('disconnected')).toBe('未连接');
    expect(selectConnectionPhaseText('connecting')).toBe('连接中…');
    expect(selectConnectionPhaseText('ready')).toBe('已连接');
    expect(selectConnectionPhaseText('recovering')).toBe('重连中…');
    expect(selectConnectionPhaseText('offline')).toBe('离线');
  });

  it('文案表与 ConnectionPhase 联合类型一一对应（防漏配）', () => {
    expect(Object.keys(CONNECTION_PHASE_TEXT).sort()).toEqual(
      ['connecting', 'disconnected', 'offline', 'ready', 'recovering'].sort()
    );
  });
});
