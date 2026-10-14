/**
 * settingsStore 单测：setters 守卫 / syncTelemetryData 清洗 + 跨域 worker 落盘 /
 * 持久化分片（crish-settings-v1 仅 scheduledTasks）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from './settingsStore';
import { useWorkerStore } from './workerStore';
import type { CronJob } from '../api/clientApi';

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

describe('settingsStore — app settings', () => {
  it('setAppSettings stores the payload', () => {
    const settings = { model: 'gpt-x', theme: 'dark' };
    useSettingsStore.getState().setAppSettings(settings);
    expect(useSettingsStore.getState().appSettings).toBe(settings);
    useSettingsStore.getState().setAppSettings(null);
    expect(useSettingsStore.getState().appSettings).toBeNull();
  });

  it('projects mcpServers only when the settings payload includes the array', () => {
    useSettingsStore.getState().setMcpServers([
      {
        id: 'keep',
        name: 'keep',
        type: 'stdio',
        status: 'connected',
        tools: [],
      },
    ]);
    useSettingsStore.getState().setAppSettings({ theme: 'dark' });
    expect(useSettingsStore.getState().mcpServers).toHaveLength(1);
    useSettingsStore.getState().setAppSettings(null);
    expect(useSettingsStore.getState().mcpServers).toHaveLength(1);
    useSettingsStore.getState().setAppSettings({
      theme: 'dark',
      mcpServers: [
        {
          id: 'chrome',
          name: 'chrome-devtools',
          type: 'stdio',
          status: 'connected',
          tools: ['tabs'],
        },
      ],
    });
    expect(
      useSettingsStore.getState().mcpServers.map((server) => server.name)
    ).toEqual(['chrome-devtools']);
    useSettingsStore.getState().setAppSettings({ mcpServers: [] });
    expect(useSettingsStore.getState().mcpServers).toEqual([]);
  });

  it('setProviders / setScheduledTasks / setMcpServers reject non-arrays safely', () => {
    const s = useSettingsStore.getState();
    s.setProviders([]);
    s.setProviders(null as unknown as never[]);
    expect(useSettingsStore.getState().providers).toEqual([]);
    s.setScheduledTasks(undefined as unknown as CronJob[]);
    expect(Array.isArray(useSettingsStore.getState().scheduledTasks)).toBe(
      true
    );
    s.setMcpServers('nope' as unknown as never[]);
    expect(useSettingsStore.getState().mcpServers).toEqual([]);
  });
});

describe('settingsStore — syncTelemetryData', () => {
  it('sanitizes tokenUsage and merges mcp / cron payloads', () => {
    const s = useSettingsStore.getState();
    s.syncTelemetryData({
      tokenUsage: { input: -1, cost: NaN, output: 5 },
      mcpServers: [{ id: 'm1', name: 'files', enabled: true }] as never,
      cronJobs: [
        {
          id: 'c1',
          cronExpression: '0 * * * *',
          prompt: 'daily',
          targetSession: 'current-session',
          status: 'active',
          nextRun: '2026-08-03T00:00:00Z',
        },
      ],
    });
    const st = useSettingsStore.getState();
    expect(st.tokenUsage.input).toBe(0);
    expect(st.tokenUsage.output).toBe(5);
    expect(Number.isFinite(st.tokenUsage.cost)).toBe(true);
    expect(st.mcpServers).toHaveLength(1);
    expect(st.scheduledTasks.map((t) => t.id)).toEqual(['c1']);
  });

  it('lands activeWorkers into workerStore via applyTelemetryWorkers (cross-store)', () => {
    const s = useSettingsStore.getState();
    s.syncTelemetryData({
      activeWorkers: [
        { id: 'live', taskName: 't', elapsedSeconds: 1 },
        { id: 'dead', taskName: 'd', elapsedSeconds: 2 },
      ],
    });
    let st = useWorkerStore.getState();
    expect(st.activeWorkers.some((w) => w.id === 'live')).toBe(true);

    // kill 后遥测再同步：dead 被过滤
    st.killWorker('dead', 'd');
    s.syncTelemetryData({
      activeWorkers: [
        { id: 'live', taskName: 't', elapsedSeconds: 3 },
        { id: 'dead', taskName: 'd', elapsedSeconds: 9 },
      ],
    });
    st = useWorkerStore.getState();
    expect(st.activeWorkers.some((w) => w.id === 'dead')).toBe(false);
    expect(st.killedWorkerIds).toContain('dead');
  });

  it('ignores missing payload sections', () => {
    const s = useSettingsStore.getState();
    s.syncTelemetryData({});
    const st = useSettingsStore.getState();
    expect(st.tokenUsage.input).toBe(0);
    expect(useWorkerStore.getState().activeWorkers).toEqual([]);
  });
});

describe('settingsStore — persistence (crish-settings-v1)', () => {
  it('persists only scheduledTasks', () => {
    useSettingsStore.getState().setScheduledTasks([
      {
        id: 'c1',
        cronExpression: '0 * * * *',
        prompt: 'daily',
        targetSession: 'current-session',
        status: 'active',
        nextRun: '2026-08-03T00:00:00Z',
      },
    ]);
    const raw = localStorage.getItem('crish-settings-v1');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { state: { scheduledTasks: CronJob[] } };
    expect(parsed.state.scheduledTasks.map((t) => t.id)).toEqual(['c1']);
  });

  it('rehydrates scheduledTasks on a fresh module import', async () => {
    useSettingsStore.getState().setScheduledTasks([
      {
        id: 'c2',
        cronExpression: '*/5 * * * *',
        prompt: 'tick',
        targetSession: 'new-session',
        status: 'active',
        nextRun: '2026-08-03T00:00:00Z',
      },
    ]);
    vi.resetModules();
    const { useSettingsStore: freshSettings } = await import('./settingsStore');
    expect(freshSettings.getState().scheduledTasks.map((t) => t.id)).toEqual([
      'c2',
    ]);
    // 未持久化字段回落默认
    expect(freshSettings.getState().appSettings).toBeNull();
    expect(freshSettings.getState().providers).toEqual([]);
  });

  it('persists and rehydrates autoShowExternalSessionOnStartup', async () => {
    expect(useSettingsStore.getState().autoShowExternalSessionOnStartup).toBe(
      true
    );
    useSettingsStore.getState().setAutoShowExternalSessionOnStartup(false);
    expect(useSettingsStore.getState().autoShowExternalSessionOnStartup).toBe(
      false
    );

    const raw = localStorage.getItem('crish-settings-v1');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as {
      state: { autoShowExternalSessionOnStartup: boolean };
    };
    expect(parsed.state.autoShowExternalSessionOnStartup).toBe(false);

    vi.resetModules();
    const { useSettingsStore: freshSettings } = await import('./settingsStore');
    expect(freshSettings.getState().autoShowExternalSessionOnStartup).toBe(
      false
    );
  });
});
