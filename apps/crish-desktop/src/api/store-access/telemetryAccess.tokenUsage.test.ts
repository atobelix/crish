/**
 * tokenUsage 并发增量不丢失（F5 性能 P2：message-end / stop 路径的
 * 并发读-改-写竞态——useStreamCallbacks 三处完成路径各自
 * 「读 getSettingsState().tokenUsage → 计算 next → syncTelemetryData 整体替换」，
 * 两个完成窗口并发时后写者覆盖先写者，增量丢失）。
 *
 * 红测试：复现 hook 的并发模式（两个异步间隙夹住读取），断言并发增量最终
 * 全部累计——当前实现下最终 = 20 而非 30（10 的增量被 20 的写回覆盖）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '../../store/settingsStore';
import { useWorkerStore } from '../../store/workerStore';

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

describe('tokenUsage 并发增量不丢失（红：读-改-写竞态复现）', () => {
  it('两个完成窗口同时累计——增量不得互相覆盖（当前后写者胜 → 丢失）', async () => {
    // 复现 useStreamCallbacks 的并发模式：每个完成路径先经过异步间隙
    //（await import pricingStore / setTimeout(400) / fetchRunSnapshotUsage），
    // 读取 tokenUsage，再经过第二个间隙后写回自算的 next——两个任务在
    // 各自的读取间隙内看到同一个陈旧快照，后写者整体覆盖先写者。
    const raceAppend = async (delta: number): Promise<void> => {
      await Promise.resolve(); // 间隙 1（读前：模拟 await import / fetch）
      const cur = useSettingsStore.getState().tokenUsage;
      await Promise.resolve(); // 间隙 2（读后：模拟成本估算计算窗口）
      useSettingsStore.getState().syncTelemetryData({
        tokenUsage: { ...cur, input: cur.input + delta, cost: cur.cost },
      });
    };

    await Promise.all([raceAppend(10), raceAppend(20)]);
    expect(useSettingsStore.getState().tokenUsage.input).toBe(30);
  });
});
