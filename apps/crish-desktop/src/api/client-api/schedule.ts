export interface CronJob {
  id: string;
  cronExpression: string;
  prompt: string;
  targetSession: 'current-session' | 'new-session';
  status: 'active' | 'paused';
  nextRun: string;
}

function isCronJob(obj: unknown): obj is CronJob {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.cronExpression === 'string' &&
    typeof o.prompt === 'string'
  );
}

export const scheduleApi = {
  getScheduledTasks: async (): Promise<CronJob[]> => {
    try {
      const { getDesktopDaemonClient } = await import('../daemonClient');
      const client = getDesktopDaemonClient();
      const res = (await client.request(
        { type: 'cron.list_tasks' },
        [
          'cron.list_tasks_response',
          'cron.list_tasks',
          'cron.tasks_listed',
          'cron.tasks',
        ],
        10_000
      )) as { tasks?: unknown[]; jobs?: unknown[] };
      const rawList = res.tasks || res.jobs || [];
      return Array.isArray(rawList) ? rawList.filter(isCronJob) : [];
    } catch (e) {
      console.error('getScheduledTasks daemon RPC error:', e);
      return [];
    }
  },

  saveScheduledTask: async (task: CronJob): Promise<CronJob[]> => {
    try {
      const { getDesktopDaemonClient } = await import('../daemonClient');
      const client = getDesktopDaemonClient();
      await client.request(
        { type: 'cron.upsert_task', task },
        ['cron.upsert_task_response', 'cron.upsert_task', 'cron.task_upserted'],
        10_000
      );
      return scheduleApi.getScheduledTasks();
    } catch (e) {
      console.error('saveScheduledTask daemon RPC error:', e);
      return [];
    }
  },

  deleteScheduledTask: async (id: string): Promise<CronJob[]> => {
    try {
      const { getDesktopDaemonClient } = await import('../daemonClient');
      const client = getDesktopDaemonClient();
      await client.request(
        { type: 'cron.delete_task', id },
        ['cron.delete_task_response', 'cron.delete_task', 'cron.task_deleted'],
        10_000
      );
      return scheduleApi.getScheduledTasks();
    } catch (e) {
      console.error('deleteScheduledTask daemon RPC error:', e);
      return [];
    }
  },
};
