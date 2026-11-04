// modelsStore 单测（M2 模型面共享 store）：拉取四态 / 切换落面 / 数据龄与
// 超龄判定 / 默认可选性派生（M3 注脚判据）/ 复位。
import type { ActiveModelInfo, ModelEntry } from '@crish/shared-types';
import { modelsStore } from './modelsStore';
import {
  isActiveModelSelectable,
  isModelsStale,
  MODELS_STALE_MS,
} from './modelsReducers';

const MODEL_A: ModelEntry = {
  providerId: 'anthropic',
  modelId: 'claude-sonnet',
  displayName: 'Claude Sonnet',
  providerDisplayName: 'Anthropic',
  active: true,
};
const MODEL_B: ModelEntry = {
  providerId: 'openai',
  modelId: 'gpt-x',
  displayName: 'GPT X',
  active: false,
};
const ACTIVE_A: ActiveModelInfo = {
  providerId: 'anthropic',
  modelId: 'claude-sonnet',
  displayName: 'Claude Sonnet',
};
const ACTIVE_B: ActiveModelInfo = {
  providerId: 'openai',
  modelId: 'gpt-x',
  displayName: 'GPT X',
};
const ACTIVE_GONE: ActiveModelInfo = {
  providerId: 'gone',
  modelId: 'retired',
  displayName: '已停用模型',
};

beforeEach(() => {
  modelsStore.getState().reset();
});

describe('modelsStore 拉取面', () => {
  it('初始：未拉取（models=null / status=idle / 无默认 / 无错误）', () => {
    const s = modelsStore.getState();
    expect(s.models).toBeNull();
    expect(s.status).toBe('idle');
    expect(s.activeModel).toBeNull();
    expect(s.error).toBeNull();
    expect(s.loadedAtMs).toBeNull();
  });

  it('无列表拉取：started → loading；loaded → 列表/默认/数据龄整体落面', () => {
    modelsStore.getState().markLoadStarted();
    expect(modelsStore.getState().status).toBe('loading');
    modelsStore.getState().markLoaded([MODEL_A, MODEL_B], ACTIVE_A, 1_000);
    const s = modelsStore.getState();
    expect(s.status).toBe('loaded');
    expect(s.models).toHaveLength(2);
    expect(s.activeModel).toEqual(ACTIVE_A);
    expect(s.loadedAtMs).toBe(1_000);
    expect(s.error).toBeNull();
  });

  it('无列表拉取失败 → error 态 + 错误码（Sheet 失败面数据面）', () => {
    modelsStore.getState().markLoadStarted();
    modelsStore.getState().markLoadFailed('cmd.timeout');
    const s = modelsStore.getState();
    expect(s.status).toBe('error');
    expect(s.error).toBe('cmd.timeout');
    expect(s.models).toBeNull();
  });

  it('有列表时重拉：started 不回退 loading（静默）；失败静默保留（不写 error、数据龄不动）', () => {
    modelsStore.getState().markLoaded([MODEL_A, MODEL_B], ACTIVE_A, 1_000);
    modelsStore.getState().markLoadStarted();
    expect(modelsStore.getState().status).toBe('loaded');
    modelsStore.getState().markLoadFailed('cmd.timeout');
    const s = modelsStore.getState();
    expect(s.status).toBe('loaded');
    expect(s.error).toBeNull();
    expect(s.loadedAtMs).toBe(1_000);
    expect(s.models).toHaveLength(2);
  });
});

describe('modelsStore 切换面', () => {
  it('markSwitched：默认替换 + 列表对号翻转 + 数据龄刷新 + 清错误', () => {
    modelsStore.getState().markLoaded([MODEL_A, MODEL_B], ACTIVE_A, 1_000);
    modelsStore.getState().markSwitchFailed('cmd.invalid');
    modelsStore.getState().markSwitchStarted();
    expect(modelsStore.getState().switching).toBe(true);
    modelsStore.getState().markSwitched(ACTIVE_B, 2_000);
    modelsStore.getState().markSwitchEnded();
    const s = modelsStore.getState();
    expect(s.switching).toBe(false);
    expect(s.activeModel).toEqual(ACTIVE_B);
    expect(s.models?.find((m) => m.modelId === 'gpt-x')?.active).toBe(true);
    expect(s.models?.find((m) => m.modelId === 'claude-sonnet')?.active).toBe(
      false
    );
    expect(s.error).toBeNull();
    expect(s.loadedAtMs).toBe(2_000);
  });

  it('markSwitchFailed：现状不漂移（默认与对号不动），仅落错误码', () => {
    modelsStore.getState().markLoaded([MODEL_A, MODEL_B], ACTIVE_A, 1_000);
    modelsStore.getState().markSwitchStarted();
    modelsStore.getState().markSwitchFailed('cmd.invalid');
    modelsStore.getState().markSwitchEnded();
    const s = modelsStore.getState();
    expect(s.activeModel).toEqual(ACTIVE_A);
    expect(s.models?.find((m) => m.modelId === 'claude-sonnet')?.active).toBe(
      true
    );
    expect(s.error).toBe('cmd.invalid');
    expect(s.switching).toBe(false);
  });
});

describe('modelsReducers 派生（超龄 / 可选性）', () => {
  it('从未拉取 → 恒超龄；保鲜期内不超龄；越过 MODELS_STALE_MS → 超龄', () => {
    const empty = modelsStore.getState();
    expect(isModelsStale(empty, 10_000)).toBe(true);
    modelsStore.getState().markLoaded([MODEL_A], ACTIVE_A, 1_000);
    const s = modelsStore.getState();
    expect(isModelsStale(s, 1_000 + MODELS_STALE_MS)).toBe(false);
    expect(isModelsStale(s, 1_000 + MODELS_STALE_MS + 1)).toBe(true);
  });

  it('可选性：默认在列表内 → true；默认已停用不在列表 → false；未设默认 → false', () => {
    modelsStore.getState().markLoaded([MODEL_A, MODEL_B], ACTIVE_A, 1_000);
    expect(isActiveModelSelectable(modelsStore.getState())).toBe(true);
    modelsStore.getState().markLoaded([MODEL_A, MODEL_B], ACTIVE_GONE, 2_000);
    expect(isActiveModelSelectable(modelsStore.getState())).toBe(false);
    modelsStore.getState().markLoaded([MODEL_A, MODEL_B], null, 3_000);
    expect(isActiveModelSelectable(modelsStore.getState())).toBe(false);
  });
});

describe('modelsStore reset', () => {
  it('整面复位回初始（断开/换机不残留旧连接投影）', () => {
    modelsStore.getState().markLoaded([MODEL_A], ACTIVE_A, 1_000);
    modelsStore.getState().markSwitchFailed('x');
    modelsStore.getState().reset();
    const s = modelsStore.getState();
    expect(s.models).toBeNull();
    expect(s.status).toBe('idle');
    expect(s.activeModel).toBeNull();
    expect(s.error).toBeNull();
    expect(s.loadedAtMs).toBeNull();
  });
});
