import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../daemonClient', () => {
  const mockClient = {
    request: vi.fn(),
  };
  return {
    getDesktopDaemonClient: () => mockClient,
    __mockClient: mockClient,
  };
});

vi.mock('../appMode', () => ({
  isDemoMode: vi.fn(() => false),
}));

import { scheduleApi, type CronJob } from './schedule';
import { getDesktopDaemonClient } from '../daemonClient';
import { isDemoMode } from '../appMode';

describe('scheduleApi', () => {
  const daemonClient = getDesktopDaemonClient() as any;

  beforeEach(() => {
    vi.clearAllMocks();
    (isDemoMode as any).mockReturnValue(false);
  });

  describe('getScheduledTasks', () => {
    it('fetches scheduled cron tasks from daemon RPC and filters invalid items', async () => {
      daemonClient.request.mockResolvedValueOnce({
        tasks: [
          {
            id: 'cron-1',
            cronExpression: '0 9 * * *',
            prompt: 'Daily Morning Briefing',
            targetSession: 'new-session',
            status: 'active',
            nextRun: '2026-07-27T09:00:00Z',
          },
          { invalid: 'item' },
        ],
      });

      const tasks = await scheduleApi.getScheduledTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('cron-1');
      expect(tasks[0].prompt).toBe('Daily Morning Briefing');
    });

    it('returns empty array when daemon RPC throws error', async () => {
      daemonClient.request.mockRejectedValueOnce(new Error('RPC Timeout'));

      const tasks = await scheduleApi.getScheduledTasks();
      expect(tasks).toEqual([]);
    });
  });

  describe('saveScheduledTask', () => {
    it('sends upsert task request to daemon and returns updated list', async () => {
      daemonClient.request
        .mockResolvedValueOnce({ ok: true }) // upsert response
        .mockResolvedValueOnce({ // refreshed list response
          tasks: [
            {
              id: 'cron-2',
              cronExpression: '*/30 * * * *',
              prompt: 'Health Check Probe',
              targetSession: 'current-session',
              status: 'active',
              nextRun: '2026-07-26T04:00:00Z',
            },
          ],
        });

      const newTask: CronJob = {
        id: 'cron-2',
        cronExpression: '*/30 * * * *',
        prompt: 'Health Check Probe',
        targetSession: 'current-session',
        status: 'active',
        nextRun: '2026-07-26T04:00:00Z',
      };

      const updated = await scheduleApi.saveScheduledTask(newTask);
      expect(daemonClient.request).toHaveBeenNthCalledWith(
        1,
        { type: 'cron.upsert_task', task: newTask },
        ['cron.upsert_task_response', 'cron.upsert_task', 'cron.task_upserted'],
        10_000
      );
      expect(updated).toHaveLength(1);
      expect(updated[0].id).toBe('cron-2');
    });
  });

  describe('deleteScheduledTask', () => {
    it('sends delete task request to daemon', async () => {
      daemonClient.request
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ tasks: [] });

      const result = await scheduleApi.deleteScheduledTask('cron-del-1');
      expect(daemonClient.request).toHaveBeenNthCalledWith(
        1,
        { type: 'cron.delete_task', id: 'cron-del-1' },
        ['cron.delete_task_response', 'cron.delete_task', 'cron.task_deleted'],
        10_000
      );
      expect(result).toEqual([]);
    });
  });
});
