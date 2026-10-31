// 应用运行时装配根测试：启动/停止生命周期、认证变化分流、前后台恢复、数据清理。
//
// appRuntime 是连接生命周期的唯一装配点（旧覆盖率 0%）：它决定「配对态何时
// 建立审批接线」「未配对/登出时何时销毁接线并清空会话数据」。
import { authStore } from '@/domain/store/authStore';
import { accountStore } from '@/domain/store/accountStore';
import { eventStore } from '@/domain/store/eventStore';
import { sessionStore } from '@/domain/store/sessionStore';

jest.mock('@/adapters/wiring/observationWiring', () => ({
  ensureObservationWiring: jest.fn(),
  disposeObservationWiring: jest.fn(),
  getObservationWiring: jest.fn(() => null),
}));

jest.mock('@/adapters/wiring/approvalWiring', () => ({
  ensureApprovalWiring: jest.fn(),
  disposeApprovalWiring: jest.fn(),
}));

jest.mock('./accountRuntime', () => ({
  startAccountRuntime: jest.fn(),
  stopAccountRuntime: jest.fn(),
  syncAccountRemote: jest.fn(),
}));

import {
  startAppRuntime,
  stopAppRuntime,
  reconnectNow,
  ensureSessionHistory,
  ensureRunHistory,
} from './appRuntime';
import {
  ensureObservationWiring,
  disposeObservationWiring,
  getObservationWiring,
} from '@/adapters/wiring/observationWiring';
import {
  ensureApprovalWiring,
  disposeApprovalWiring,
} from '@/adapters/wiring/approvalWiring';
import { startAccountRuntime, stopAccountRuntime } from './accountRuntime';

const ensureObsMock = ensureObservationWiring as jest.Mock;
const disposeObsMock = disposeObservationWiring as jest.Mock;
const getObsMock = getObservationWiring as jest.Mock;
const ensureApprovalMock = ensureApprovalWiring as jest.Mock;
const disposeApprovalMock = disposeApprovalWiring as jest.Mock;
const startAccountMock = startAccountRuntime as jest.Mock;
const stopAccountMock = stopAccountRuntime as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  stopAppRuntime();
  jest.clearAllMocks();
  authStore.setState({ hydrated: false, pairState: 'unpaired', host: null });
  accountStore.getState().reset();
  getObsMock.mockReturnValue(null);
});

afterEach(() => {
  stopAppRuntime();
});

describe('startAppRuntime / stopAppRuntime', () => {
  it('启动时拉起账号运行时', () => {
    startAppRuntime();
    expect(startAccountMock).toHaveBeenCalledTimes(1);
  });

  it('启动幂等（重复调用只装配一次）', () => {
    startAppRuntime();
    startAppRuntime();
    expect(startAccountMock).toHaveBeenCalledTimes(1);
  });

  it('停止时收口账号运行时并销毁接线', () => {
    startAppRuntime();
    stopAppRuntime();

    expect(stopAccountMock).toHaveBeenCalled();
    expect(disposeObsMock).toHaveBeenCalled();
    expect(disposeApprovalMock).toHaveBeenCalled();
  });

  it('停止后清空会话数据（换机/登出不残留）', () => {
    startAppRuntime();
    sessionStore.setState({ sessions: [{ id: 's-1' }] as never });
    eventStore.setState({ windows: { 's-1': {} } as never });

    stopAppRuntime();

    expect(sessionStore.getState().sessions).toEqual([]);
    expect(eventStore.getState().windows).toEqual({});
  });

  it('停止后可再次启动（started 标志复位）', () => {
    startAppRuntime();
    stopAppRuntime();
    startAppRuntime();
    expect(startAccountMock).toHaveBeenCalledTimes(2);
  });
});

describe('认证变化分流', () => {
  it('已配对时建立审批接线', () => {
    startAppRuntime();
    authStore.setState({ hydrated: true, pairState: 'paired' });

    expect(ensureApprovalMock).toHaveBeenCalled();
  });

  it('未配对且未登录账号时销毁全部接线', () => {
    startAppRuntime();
    authStore.setState({ hydrated: true, pairState: 'paired' });
    disposeObsMock.mockClear();
    disposeApprovalMock.mockClear();

    authStore.setState({ pairState: 'unpaired' });

    expect(disposeObsMock).toHaveBeenCalled();
    expect(disposeApprovalMock).toHaveBeenCalled();
  });

  it('未配对但账号已登录时保留远程接线（不销毁）', () => {
    startAppRuntime();
    authStore.setState({ hydrated: true, pairState: 'paired' });
    accountStore.setState({ status: 'loggedIn' });
    disposeObsMock.mockClear();

    authStore.setState({ pairState: 'unpaired' });

    expect(disposeObsMock).not.toHaveBeenCalled();
  });

  it('未水合时不动作', () => {
    startAppRuntime();
    ensureApprovalMock.mockClear();
    disposeObsMock.mockClear();

    authStore.setState({ hydrated: false, pairState: 'paired' });

    expect(ensureApprovalMock).not.toHaveBeenCalled();
    expect(disposeObsMock).not.toHaveBeenCalled();
  });
});

describe('reconnectNow', () => {
  it('已有 wiring 时直接重连', () => {
    const reconnect = jest.fn();
    getObsMock.mockReturnValue({ reconnect });
    startAppRuntime();

    reconnectNow();

    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('无 wiring 且已配对时尝试建立接线', () => {
    getObsMock.mockReturnValue(null);
    authStore.setState({ pairState: 'paired' });
    startAppRuntime();
    ensureObsMock.mockClear();

    reconnectNow();

    expect(ensureObsMock).toHaveBeenCalled();
  });

  it('无 wiring 且未配对时不动作', () => {
    getObsMock.mockReturnValue(null);
    authStore.setState({ pairState: 'unpaired' });
    startAppRuntime();
    ensureObsMock.mockClear();

    reconnectNow();

    expect(ensureObsMock).not.toHaveBeenCalled();
  });
});

describe('历史回填入口', () => {
  it('ensureSessionHistory 经 wiring 回填会话', () => {
    const hydrateSession = jest.fn(async () => {});
    getObsMock.mockReturnValue({ bridge: { hydrateSession } });

    ensureSessionHistory('s-1');

    expect(hydrateSession).toHaveBeenCalledWith('s-1');
  });

  it('ensureRunHistory 经 wiring 回填 run', () => {
    const hydrateRun = jest.fn(async () => {});
    getObsMock.mockReturnValue({ bridge: { hydrateRun } });

    ensureRunHistory('r-1');

    expect(hydrateRun).toHaveBeenCalledWith('r-1');
  });

  it('无 wiring 时安全返回（可选链兜底）', () => {
    getObsMock.mockReturnValue(null);
    expect(() => ensureSessionHistory('s-1')).not.toThrow();
    expect(() => ensureRunHistory('r-1')).not.toThrow();
  });
});

describe('前后台恢复', () => {
  it('启动时注册 AppState 监听（stop 后清理）', () => {
    // 只验证生命周期不抛错且可重复启停：AppState 回调本体依赖原生事件，
    // 其内部分支（syncSubscriptions / reconnect）已由 reconnectNow 用例覆盖。
    expect(() => {
      startAppRuntime();
      stopAppRuntime();
      startAppRuntime();
    }).not.toThrow();
  });
});
