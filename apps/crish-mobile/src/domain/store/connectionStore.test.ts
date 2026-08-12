// connectionStore 单测（M5 §3.1.1 connectionStore 动作面 + D4 §6.2.5 相位投影）：
// 相位投影映射表全量（M5 §4.3.1：mapWsPhase + CONNECTION_PHASE_TEXT 标签表）/
// 端点选择 / 重连尝试计数 / 错误记录 / 复位
import {
  connectionStore,
  mapWsPhase,
  CONNECTION_PHASE_TEXT,
  selectConnectionPhaseText,
} from './connectionStore';
import type { ConnectionPhase, ConnectionEndpoint } from './connectionStore';
import type { WsPhase } from './connectionStore';

const ENDPOINT: ConnectionEndpoint = {
  host: '192.168.1.100',
  port: 8765,
  url: 'wss://192.168.1.100:8765',
};

function resetStore(): void {
  connectionStore.setState({
    phase: 'disconnected',
    selectedEndpoint: null,
    attemptCount: 0,
    retryCount: 0,
    lastError: null,
    lastSyncAt: null,
  });
}

beforeEach(() => {
  resetStore();
});

describe('相位投影映射表全量（M5 §4.3.1）', () => {
  // 表行对齐：idle→未连接 / connecting→连接中 / open→已连接 / reconnecting→重连中 /
  // 重试超封顶（dead）或无网络 → 离线
  const CASES: Array<[WsPhase, boolean, ConnectionPhase]> = [
    ['idle', false, 'disconnected'],
    ['connecting', false, 'connecting'],
    ['open', false, 'ready'],
    ['reconnecting', false, 'recovering'],
    ['dead', false, 'offline'], // 重连失败超 maxRetries → dead 终态（D4 §6.2.5 offline 语义）
    ['idle', true, 'offline'],
    ['connecting', true, 'offline'],
    ['open', true, 'offline'],
    ['reconnecting', true, 'offline'],
    ['dead', true, 'offline'],
  ];

  it('mapWsPhase 全表投影（netInfo 离线优先级最高，M5 §4.3.1）', () => {
    for (const [wsPhase, offline, expected] of CASES) {
      expect(mapWsPhase(wsPhase, offline)).toBe(expected);
    }
  });

  it('连接状态标签表全量（UI 横幅文案，M5 §4.3.1 映射表列）', () => {
    expect(CONNECTION_PHASE_TEXT).toEqual({
      disconnected: '未连接',
      connecting: '连接中…',
      ready: '已连接',
      recovering: '重连中…',
      offline: '离线',
    });
  });

  it('selectConnectionPhaseText 单值选择器（「重连中…第 N 次」由 UI 拼接 attemptCount）', () => {
    expect(selectConnectionPhaseText('recovering')).toBe('重连中…');
    expect(selectConnectionPhaseText('offline')).toBe('离线');
  });
});

describe('setPhase（归一相位写入，接线层经 mapWsPhase 投影后调用）', () => {
  it('相位更新；ready 打点 lastSyncAt（stale 灰字数据面，R2UX-05-10）', () => {
    const before = Date.now();
    connectionStore.getState().setPhase('connecting');
    expect(connectionStore.getState().phase).toBe('connecting');
    expect(connectionStore.getState().lastSyncAt).toBeNull();
    connectionStore.getState().setPhase('ready');
    const s = connectionStore.getState();
    expect(s.phase).toBe('ready');
    expect(s.lastSyncAt).not.toBeNull();
    expect(s.lastSyncAt!).toBeGreaterThanOrEqual(before);
  });

  it('ready 清重连尝试计数（M5 §4.3.2「重连成功重置 retryCount」对齐）', () => {
    connectionStore.getState().onReconnectAttempt();
    connectionStore.getState().onReconnectAttempt();
    expect(connectionStore.getState().attemptCount).toBe(2);
    connectionStore.getState().setPhase('ready');
    expect(connectionStore.getState().attemptCount).toBe(0);
  });

  it('非 ready 相位不重置尝试计数（recovering 期间计数保留）', () => {
    connectionStore.getState().onReconnectAttempt();
    connectionStore.getState().setPhase('recovering');
    expect(connectionStore.getState().attemptCount).toBe(1);
  });
});

describe('setEndpoint（已选端点）', () => {
  it('设置端点（host/port/url 全量记录）', () => {
    connectionStore.getState().setEndpoint(ENDPOINT);
    expect(connectionStore.getState().selectedEndpoint).toEqual(ENDPOINT);
  });

  it('null 清除端点（未配对/用户清除配置）', () => {
    connectionStore.getState().setEndpoint(ENDPOINT);
    connectionStore.getState().setEndpoint(null);
    expect(connectionStore.getState().selectedEndpoint).toBeNull();
  });
});

describe('onReconnectAttempt / onError（重连与错误数据面）', () => {
  it('onReconnectAttempt 累计尝试次数', () => {
    connectionStore.getState().onReconnectAttempt();
    connectionStore.getState().onReconnectAttempt();
    connectionStore.getState().onReconnectAttempt();
    expect(connectionStore.getState().attemptCount).toBe(3);
  });

  it('retryCount 兼容别名与 attemptCount 同步（M5 §3.1.1 原字段名；并行域 setState 种子兼容）', () => {
    connectionStore.getState().onReconnectAttempt();
    const s = connectionStore.getState();
    expect(s.retryCount).toBe(s.attemptCount);
    expect(s.retryCount).toBe(1);
    connectionStore.getState().setPhase('ready');
    expect(connectionStore.getState().retryCount).toBe(0);
  });

  it('onError 记录最近错误（可读文案），不改相位', () => {
    connectionStore.getState().setPhase('recovering');
    connectionStore.getState().onError('连接被对端关闭');
    const s = connectionStore.getState();
    expect(s.lastError).toBe('连接被对端关闭');
    expect(s.phase).toBe('recovering');
  });
});

describe('reset（断开/注销全量复位）', () => {
  it('清相位/计数/错误/同步点；保留端点配置（用户选择不随连接生命周期复位）', () => {
    connectionStore.getState().setEndpoint(ENDPOINT);
    connectionStore.getState().setPhase('ready');
    connectionStore.getState().onReconnectAttempt();
    connectionStore.getState().onError('连接被对端关闭');
    connectionStore.getState().reset();
    const s = connectionStore.getState();
    expect(s.phase).toBe('disconnected');
    expect(s.attemptCount).toBe(0);
    expect(s.lastError).toBeNull();
    expect(s.lastSyncAt).toBeNull();
    expect(s.selectedEndpoint).toEqual(ENDPOINT);
  });

  it('幂等：未连接态复位不抛错', () => {
    expect(() => connectionStore.getState().reset()).not.toThrow();
  });
});
