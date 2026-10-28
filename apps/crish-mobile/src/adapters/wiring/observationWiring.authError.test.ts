// 观测面接线认证错误帧投影测试（R4 批次5）：
// error 帧 auth.* 码 → authStore.markTokenExpired（过期/吊销/未知设备/陈旧）；
// 非 auth 错误码与普通帧不触发；dispose 退订后不再响应。
import { startObservationWiring } from './observationWiring';
import { resetObservationWiringForTest } from './observationWiring';
import { authStore } from '@/domain/store/authStore';
import { WsGateway } from '@/network/WsGateway';
import type { InboundEnvelope } from '@/network/WsEnvelope';

function makeErrorFrame(code: string): InboundEnvelope {
  return {
    v: 1,
    kind: 'error',
    msgId: 'srv-e-1',
    ts: 1000,
    from: 'desktop',
    to: 'mobile',
    body: { code, message: 'x', retryable: false },
  };
}

function seedPaired(): void {
  authStore.setState({
    pairState: 'paired',
    hydrated: true,
    deviceId: 'dev-1',
    desktopId: 'hub-1',
    host: '192.168.1.5',
    hasKeyMaterial: true,
  });
}

function dispatchError(gateway: WsGateway, code: string): void {
  gateway.dispatchFrame(makeErrorFrame(code));
}

beforeEach(() => {
  resetObservationWiringForTest();
  authStore.getState().clearPairing();
});

afterEach(() => {
  resetObservationWiringForTest();
});

describe('error 帧 → authStore 令牌过期投影（R4 批次5）', () => {
  it('auth.expired / auth.device_revoked / auth.unknown_device / auth.stale → token_expired（paired 态）', () => {
    for (const code of [
      'auth.expired',
      'auth.device_revoked',
      'auth.unknown_device',
      'auth.stale',
    ]) {
      seedPaired();
      const wiring = startObservationWiring({
        url: 'wss://host:8765/v1/events',
        factory: () => {
          throw new Error('no socket in test');
        },
      });
      // 工厂抛错只影响 connect；error 帧投影经 gateway 订阅独立生效
      void wiring;
      dispatchError(wiring.client.gateway, code);
      expect(authStore.getState().pairState).toBe('token_expired');
      resetObservationWiringForTest();
    }
  });

  it('非 auth 错误码（cmd.* 等）不触发', () => {
    seedPaired();
    const wiring = startObservationWiring({
      url: 'wss://host:8765/v1/events',
      factory: () => {
        throw new Error('no socket in test');
      },
    });
    dispatchError(wiring.client.gateway, 'cmd.invalid');
    expect(authStore.getState().pairState).toBe('paired');
  });

  it('dispose 退订后 error 帧不再触发（装配生命周期收口）', () => {
    seedPaired();
    const wiring = startObservationWiring({
      url: 'wss://host:8765/v1/events',
      factory: () => {
        throw new Error('no socket in test');
      },
    });
    wiring.dispose();
    dispatchError(wiring.client.gateway, 'auth.expired');
    expect(authStore.getState().pairState).toBe('paired');
  });
});
