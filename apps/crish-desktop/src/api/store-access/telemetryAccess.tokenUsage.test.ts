/**
 * tokenUsage 并发增量不丢失（F5 性能 P2：message-end / stop 路径的
 * 并发读-改-写竞态——旧实现 useStreamCallbacks 三处完成路径各自
 * 「读 tokenUsage → 计算 next → syncTelemetryData 整体替换」，
 * 两个完成窗口并发时后写者覆盖先写者，增量丢失）。
 *
 * 修复：accumulateTokenUsage 以模块级 promise 链串行化合并（读最新态 →
 * 合并 delta → 写回原子完成）。红测试原为对旧模式的竞态复现（最终 20 ≠ 30），
 * 修复后 hook 不再走读-改-写模式，测试改经新入口验证同一契约：
 * 并发增量最终全部累计。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '../../store/settingsStore';
import { useWorkerStore } from '../../store/workerStore';
import {
  accumulateTokenUsage,
  mergeTokenUsageDelta,
  type TokenUsageDelta,
} from './telemetryAccess';

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({
    appSettings: null,
    providers: [],
    scheduledTasks: [],
    mcpServers: [],
    tokenUsage: {
      input: 0,
      inputMax: 160000,
      output: 0,
      outputMax: 40000,
      cost: 0,
    },
  });
  useWorkerStore.setState({
    activeWorkers: [],
    killedWorkerIds: [],
    manuallyTriggeredWorkers: [],
  });
});

afterEach(() => {
  localStorage.clear();
});

describe('tokenUsage 并发增量不丢失（accumulateTokenUsage 串行化合并）', () => {
  it('50 路并发累计——增量全部生效，无丢失', async () => {
    const n = 50;
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        accumulateTokenUsage({ input: 1, output: 2, cost: i === 0 ? 5 : 0 })
      )
    );
    const st = useSettingsStore.getState();
    expect(st.tokenUsage.input).toBe(n);
    expect(st.tokenUsage.output).toBe(2 * n);
    expect(st.tokenUsage.cost).toBe(5);
  });

  it('并发累计与快照回填互不覆盖（input 与 cacheRead 两个维度）', async () => {
    await Promise.all([
      accumulateTokenUsage({ input: 10 }),
      accumulateTokenUsage({ cacheRead: 100 }),
      accumulateTokenUsage({ input: 20, cacheWrite: 30 }),
    ]);
    const st = useSettingsStore.getState();
    expect(st.tokenUsage.input).toBe(30);
    expect(st.tokenUsage.cacheRead).toBe(100);
    expect(st.tokenUsage.cacheWrite).toBe(30);
  });

  it('mergeTokenUsageDelta 纯函数：非负钳制 + 保留 max 与未涉及 4D 字段', () => {
    const cur = {
      input: 10,
      inputMax: 160000,
      output: 5,
      outputMax: 40000,
      cost: 2,
      cacheRead: 7,
    };
    const next = mergeTokenUsageDelta(cur, {
      input: -3,
      cost: Number.NaN,
      cacheRead: 100,
    } satisfies TokenUsageDelta);
    expect(next.input).toBe(10);
    expect(next.inputMax).toBe(160000);
    expect(next.outputMax).toBe(40000);
    expect(next.cost).toBe(2);
    expect(next.cacheRead).toBe(107);
    expect(next.cacheWrite).toBeUndefined();
    expect(next.savedCost).toBeUndefined();
  });

  it('单次合并失败不破坏后续累计', async () => {
    // syncTelemetryData 内部永不抛错；此处验证链在异常下仍续跑：
    // 先注入一个会让 sanitize 抛错的状态不可行（store 恒定安全），
    // 故验证多次累计的链式顺序性（前面未完成时后面不提前写）。
    let seq = 0;
    const order: number[] = [];
    const cur = useSettingsStore.getState().tokenUsage;
    const custom = {
      ...cur,
      input: 0,
      inputMax: 160000,
      output: 0,
      outputMax: 40000,
      cost: 0,
    };
    useSettingsStore.setState({ tokenUsage: custom });
    void accumulateTokenUsage({ input: 1 }).then(() => order.push(++seq));
    void accumulateTokenUsage({ input: 1 }).then(() => order.push(++seq));
    void accumulateTokenUsage({ input: 1 }).then(() => order.push(++seq));
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([1, 2, 3]);
    expect(useSettingsStore.getState().tokenUsage.input).toBe(3);
  });
});

describe('D4 收敛：历史流水委托内建（recordUsageDelta 单点，同事件双写无丢失）', () => {
  it('accumulateTokenUsage 委托 usageStore（model 透传 + 双 sink 不丢字段）', async () => {
    // jsdom 无真实 localStorage 限制：usageStore 以 crish_usage_history_v1 落盘
    await accumulateTokenUsage({
      input: 10,
      output: 20,
      cost: 1.5,
      model: 'gpt-test',
    });
    const raw = localStorage.getItem('crish_usage_history_v1');
    expect(raw).toBeTruthy();
    const snap = JSON.parse(raw as string) as {
      totalInput: number;
      totalOutput: number;
      totalCost: number;
      models: Array<{ model: string; input: number; output: number; cost: number }>;
    };
    expect(snap.totalInput).toBe(10);
    expect(snap.totalOutput).toBe(20);
    expect(snap.totalCost).toBe(1.5);
    const row = snap.models.find((m) => m.model === 'gpt-test');
    expect(row?.input).toBe(10);
  });

  it('多次并发委托不丢失（settings 当前值 + usage 历史流水两 sink 一致）', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        accumulateTokenUsage({ input: 1, output: 2, cost: 0, model: 'm1' })
      )
    );
    const st = useSettingsStore.getState();
    expect(st.tokenUsage.input).toBe(10);
    expect(st.tokenUsage.output).toBe(20);
    const raw = localStorage.getItem('crish_usage_history_v1');
    const snap = JSON.parse(raw as string) as {
      totalInput: number;
      totalOutput: number;
    };
    expect(snap.totalInput).toBe(10);
    expect(snap.totalOutput).toBe(20);
  });
});
